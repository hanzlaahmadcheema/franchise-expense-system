/**
 * Phase 8B: Expense Transaction Synchronization Service
 *
 * Synchronizes DailyLedgerInput state with PostgreSQL REST transaction APIs:
 * - Expenses (`/api/v1/transactions/expenses`)
 * - Commissions (`/api/v1/transactions/commissions`)
 * - Credits (`/api/v1/transactions/credits`)
 * - Owner Transactions (`/api/v1/transactions/owner`)
 *
 * Fetches updated server-authoritative projections upon completion.
 * NEVER writes to Firestore.
 */

import type { DailyLedgerInput, ExpenseItem, CommissionItem, CreditRow, OwnerBalanceRow } from "../../types/ledger";
import {
  ledgerApiClient,
  type DayProjectionsResponse
} from "./ledgerApiClient";
import { resolveAccountingDayId, getAccountingPeriodWithDays } from "./periodDayService";

export interface SaveExpenseDayResult {
  success: boolean;
  dayId: string;
  projections: DayProjectionsResponse["projections"] | null;
  rehydratedDay?: DailyLedgerInput | null;
  message: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidCategoryUuid(val?: string | null): boolean {
  return typeof val === "string" && UUID_REGEX.test(val);
}

function getDefaultSettlementDate(periodKey: string): string {
  const [yearStr, monthStr] = periodKey.split("-");
  let y = parseInt(yearStr || "2026", 10);
  let m = parseInt(monthStr || "8", 10) + 1;
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

export async function saveExpenseDayPostgres(
  periodKey: string,
  input: DailyLedgerInput
): Promise<SaveExpenseDayResult> {
  if (input.dayNo === 32) {
    const periodData = await getAccountingPeriodWithDays(periodKey);
    if (!periodData) {
      throw new Error(`Accounting period not found for ${periodKey}.`);
    }
    const periodId = periodData.period.id;
    const finalRes = await ledgerApiClient.calculations.getPeriodFinalProjections(periodId);
    const finalData = (finalRes as any)?.data ?? finalRes;
    if (
      periodData.period.status === "closed" ||
      finalData?.period?.finalSettlementStatus === "VERIFIED" ||
      finalData?.period?.finalSettlementStatus === "CLOSED"
    ) {
      throw new Error("FINAL month-end settlement is immutable and closed.");
    }

    const existingSettlementsRes = await ledgerApiClient.periods.listFinalSettlements(periodId);
    const rawList = (existingSettlementsRes as any)?.data;
    const existingSettlements: any[] = Array.isArray(rawList?.entries)
      ? rawList.entries
      : Array.isArray(rawList)
      ? rawList
      : [];
    const retainedSettlementIds = new Set<string>();
    const defaultSettlementDate = getDefaultSettlementDate(periodKey);

    // 1. Commissions -> COMMISSION
    for (const comm of input.commissions) {
      const amt = Number(comm.amount || 0);
      if (amt <= 0) continue;
      const targetEntityId = comm.categoryId && isValidCategoryUuid(comm.categoryId) ? comm.categoryId : undefined;
      const existing = comm.id
        ? existingSettlements.find(
            (s) =>
              s.id === comm.id &&
              ((s.balanceDomain ?? s.balance_domain) === "COMMISSION" ||
                (s.balanceDomain ?? s.balance_domain) === "COMMISSION_RECEIVABLE")
          )
        : undefined;

      if (existing) {
        retainedSettlementIds.add(existing.id);
        const existingName = existing.targetEntityName ?? existing.target_entity_name;
        if (Number(existing.amount) !== amt || existingName !== comm.category) {
          await ledgerApiClient.periods.updateFinalSettlement(periodId, existing.id, {
            amount: amt,
            targetEntityName: comm.category,
            targetEntityId,
            notes: comm.category
          });
        }
      } else {
        const createRes = await ledgerApiClient.periods.createFinalSettlement(periodId, {
          settlementDate: defaultSettlementDate,
          balanceDomain: "COMMISSION",
          settlementType: "COMMISSION",
          targetEntityId,
          targetEntityName: comm.category,
          sourceReference: comm.category,
          amount: amt,
          notes: comm.category
        });
        if (createRes?.data?.id) {
          retainedSettlementIds.add(createRes.data.id);
        }
      }
    }

    // 2. Expenses -> EXPENSE
    for (const exp of input.expenses) {
      const amt = Number(exp.amount || 0);
      if (amt <= 0) continue;
      const targetEntityId = exp.categoryId && isValidCategoryUuid(exp.categoryId) ? exp.categoryId : undefined;
      const categoryName = exp.category || "General";
      const existing = exp.id
        ? existingSettlements.find(
            (s) =>
              s.id === exp.id &&
              ((s.balanceDomain ?? s.balance_domain) === "EXPENSE" ||
                (s.balanceDomain ?? s.balance_domain) === "CASH_SETTLEMENT" ||
                (s.balanceDomain ?? s.balance_domain) === "OTHER")
          )
        : undefined;

      if (existing) {
        retainedSettlementIds.add(existing.id);
        const existingRef = existing.sourceReference ?? existing.source_reference;
        const existingNotes = existing.notes;
        const existingCat = existing.targetEntityName ?? existing.target_entity_name;
        if (
          Number(existing.amount) !== amt ||
          existingRef !== (exp.name || null) ||
          existingNotes !== (exp.description || null) ||
          existingCat !== categoryName
        ) {
          await ledgerApiClient.periods.updateFinalSettlement(periodId, existing.id, {
            amount: amt,
            targetEntityName: categoryName,
            targetEntityId,
            sourceReference: exp.name || null,
            notes: exp.description || null
          });
        }
      } else {
        const createRes = await ledgerApiClient.periods.createFinalSettlement(periodId, {
          settlementDate: defaultSettlementDate,
          balanceDomain: "EXPENSE",
          settlementType: "EXPENSE",
          targetEntityId,
          targetEntityName: categoryName,
          sourceReference: exp.name || null,
          notes: exp.description || null,
          amount: amt
        });
        if (createRes?.data?.id) {
          retainedSettlementIds.add(createRes.data.id);
        }
      }
    }

    // 3. Franchise Owner -> OWNER_BALANCE (OWNER_DRAWING vs OWNER_INJECTION)
    for (const owner of input.ownerBalances) {
      let signedAmt = Number(owner.amount ?? 0);
      if (signedAmt === 0) {
        if (Number(owner.expense ?? 0) > 0) signedAmt = Number(owner.expense);
        else if (Number(owner.received ?? 0) > 0) signedAmt = -Number(owner.received);
      }
      if (signedAmt === 0 || !owner.description?.trim()) continue;
      const desc = owner.description.trim();
      const settlementType = signedAmt > 0 ? "OWNER_DRAWING" : "OWNER_INJECTION";
      const absAmt = Math.abs(signedAmt);

      const existing = owner.id
        ? existingSettlements.find(
            (s) =>
              s.id === owner.id &&
              ((s.balanceDomain ?? s.balance_domain) === "OWNER_BALANCE")
          )
        : undefined;

      if (existing) {
        retainedSettlementIds.add(existing.id);
        if (
          Number(existing.amount) !== absAmt ||
          existing.notes !== desc ||
          (existing.settlementType ?? existing.settlement_type) !== settlementType
        ) {
          await ledgerApiClient.periods.updateFinalSettlement(periodId, existing.id, {
            amount: absAmt,
            settlementType,
            sourceReference: desc,
            notes: desc
          });
        }
      } else {
        const createRes = await ledgerApiClient.periods.createFinalSettlement(periodId, {
          settlementDate: defaultSettlementDate,
          balanceDomain: "OWNER_BALANCE",
          settlementType,
          sourceReference: desc,
          notes: desc,
          amount: absAmt
        });
        if (createRes?.data?.id) {
          retainedSettlementIds.add(createRes.data.id);
        }
      }
    }

    // 4. Credits -> CREDIT_PARTY_BALANCE (CREDIT_LOAN vs CREDIT_RECEIVE)
    for (const credit of input.credits) {
      if (!credit.partyId) continue;
      const loanAmt = Number(credit.loan ?? credit.today ?? 0);
      const receiveAmt = Number(credit.receive ?? 0);

      // 4a. CREDIT_LOAN
      if (loanAmt > 0) {
        const existingLoan = existingSettlements.find(
          (s) =>
            ((s.balanceDomain ?? s.balance_domain) === "CREDIT_PARTY_BALANCE") &&
            ((s.targetEntityId ?? s.target_entity_id) === credit.partyId) &&
            ((s.settlementType ?? s.settlement_type) === "CREDIT_LOAN")
        );

        if (existingLoan) {
          retainedSettlementIds.add(existingLoan.id);
          if (
            Number(existingLoan.amount) !== loanAmt ||
            existingLoan.notes !== (credit.loanDescription || null)
          ) {
            await ledgerApiClient.periods.updateFinalSettlement(periodId, existingLoan.id, {
              amount: loanAmt,
              targetEntityName: credit.partyName,
              sourceReference: credit.loanDescription || null,
              notes: credit.loanDescription || null
            });
          }
        } else {
          const createRes = await ledgerApiClient.periods.createFinalSettlement(periodId, {
            settlementDate: defaultSettlementDate,
            balanceDomain: "CREDIT_PARTY_BALANCE",
            settlementType: "CREDIT_LOAN",
            targetEntityId: credit.partyId,
            targetEntityName: credit.partyName,
            amount: loanAmt,
            sourceReference: credit.loanDescription || null,
            notes: credit.loanDescription || null
          });
          if (createRes?.data?.id) {
            retainedSettlementIds.add(createRes.data.id);
          }
        }
      }

      // 4b. CREDIT_RECEIVE
      if (receiveAmt > 0) {
        const existingReceive = existingSettlements.find(
          (s) =>
            ((s.balanceDomain ?? s.balance_domain) === "CREDIT_PARTY_BALANCE") &&
            ((s.targetEntityId ?? s.target_entity_id) === credit.partyId) &&
            ((s.settlementType ?? s.settlement_type) === "CREDIT_RECEIVE" ||
              (s.settlementType ?? s.settlement_type) === "CREDIT_RECOVERY")
        );

        if (existingReceive) {
          retainedSettlementIds.add(existingReceive.id);
          if (
            Number(existingReceive.amount) !== receiveAmt ||
            existingReceive.notes !== (credit.receiveDescription || null)
          ) {
            await ledgerApiClient.periods.updateFinalSettlement(periodId, existingReceive.id, {
              amount: receiveAmt,
              targetEntityName: credit.partyName,
              sourceReference: credit.receiveDescription || null,
              notes: credit.receiveDescription || null
            });
          }
        } else {
          const createRes = await ledgerApiClient.periods.createFinalSettlement(periodId, {
            settlementDate: defaultSettlementDate,
            balanceDomain: "CREDIT_PARTY_BALANCE",
            settlementType: "CREDIT_RECEIVE",
            targetEntityId: credit.partyId,
            targetEntityName: credit.partyName,
            amount: receiveAmt,
            sourceReference: credit.receiveDescription || null,
            notes: credit.receiveDescription || null
          });
          if (createRes?.data?.id) {
            retainedSettlementIds.add(createRes.data.id);
          }
        }
      }
    }

    // Delete settlements that were removed in the UI
    for (const existing of existingSettlements) {
      if (!retainedSettlementIds.has(existing.id)) {
        await ledgerApiClient.periods.deleteFinalSettlement(periodId, existing.id);
      }
    }

    const rehydratedDay = await loadExpenseDayPostgres(periodKey, 32);

    return {
      success: true,
      dayId: "final",
      projections: null,
      rehydratedDay,
      message: "FINAL settlement entries saved to PostgreSQL successfully."
    };
  }

  const dayId = await resolveAccountingDayId(periodKey, input.dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${input.dayNo} not found for period ${periodKey}.`);
  }

  // 1. Sync Expenses
  const existingExpensesRes = await ledgerApiClient.expenses.list(dayId);
  const existingExpenses = existingExpensesRes.data || [];
  const existingExpMap = new Map<string, any>(existingExpenses.map((item: any) => [item.id, item]));

  const retainedExistingIds = new Set<string>();
  for (const exp of input.expenses) {
    const amount = Number(exp.amount || 0);
    if (amount <= 0) continue;

    if (exp.categoryId && !isValidCategoryUuid(exp.categoryId)) {
      throw new Error(`Invalid category ID "${exp.categoryId}". Expense category IDs must be valid PostgreSQL UUIDs.`);
    }
    const categoryId = exp.categoryId ?? null;
    const itemName = (exp.name ?? "").trim();
    const description = exp.description?.trim() || null;
    const categoryNameSnapshot = exp.category?.trim() || "General";

    const existing = exp.id ? existingExpMap.get(exp.id) : undefined;

    if (existing && !retainedExistingIds.has(existing.id)) {
      retainedExistingIds.add(existing.id);
      const changed =
        Number(existing.amount) !== amount ||
        (existing.category_id ?? null) !== categoryId ||
        (existing.item_name ?? "") !== itemName ||
        (existing.description ?? null) !== description;

      if (changed) {
        await ledgerApiClient.expenses.update(existing.id, {
          baseRevision: existing.revision ?? 1,
          category_id: categoryId,
          amount,
          item_name: itemName,
          description
        });
      }
    } else {
      await ledgerApiClient.expenses.create({
        day_id: dayId,
        category_id: categoryId,
        category_name_snapshot: categoryNameSnapshot,
        item_name: itemName,
        description,
        amount
      });
    }
  }

  // Delete removed expenses
  for (const existing of existingExpenses) {
    if (!retainedExistingIds.has(existing.id)) {
      await ledgerApiClient.expenses.delete(existing.id);
    }
  }

  // 2. Sync Commissions
  const existingCommissionsRes = await ledgerApiClient.commissions.list(dayId);
  const existingCommissions = existingCommissionsRes.data || [];
  const existingCommMap = new Map(existingCommissions.map((item: any) => [item.category_name_snapshot || item.id, item]));

  const retainedCommIds = new Set<string>();
  for (const comm of input.commissions) {
    if (Number(comm.amount) <= 0) continue;
    if (comm.categoryId && !isValidCategoryUuid(comm.categoryId)) {
      throw new Error(`Invalid category ID "${comm.categoryId}". Commission category IDs must be valid PostgreSQL UUIDs.`);
    }
    const categoryId = comm.categoryId ?? null;
    const key = comm.category;
    const existing = existingCommMap.get(key);

    if (existing) {
      retainedCommIds.add(existing.id);
      if (Number(existing.amount) !== Number(comm.amount) || existing.category_id !== categoryId) {
        await ledgerApiClient.commissions.update(existing.id, {
          baseRevision: existing.revision ?? 1,
          category_id: categoryId,
          amount: Number(comm.amount)
        });
      }
    } else {
      const createRes = await ledgerApiClient.commissions.create({
        day_id: dayId,
        category_id: categoryId,
        category_name_snapshot: comm.category,
        amount: Number(comm.amount)
      });
      if ((createRes as any)?.data?.id) {
        retainedCommIds.add((createRes as any).data.id);
      }
    }
  }

  // Delete removed or duplicate commissions
  for (const existing of existingCommissions) {
    if (!retainedCommIds.has(existing.id)) {
      await ledgerApiClient.commissions.delete(existing.id);
    }
  }

  // 3. Sync Credits
  const existingCreditsRes = await ledgerApiClient.credits.list(dayId);
  const existingCredits = existingCreditsRes.data || [];
  const existingCreditMap = new Map(existingCredits.map((item: any) => [item.party_id, item]));

  const currentCreditPartyIds = new Set<string>();
  for (const row of input.credits) {
    const loanAmount = Number(row.loan ?? row.today ?? 0);
    const receiptAmount = Number(row.receive ?? 0);
    const hasActivity = loanAmount > 0 || receiptAmount > 0;
    if (!hasActivity || !row.partyId) continue;

    currentCreditPartyIds.add(row.partyId);
    const existing = existingCreditMap.get(row.partyId);

    if (existing) {
      const changed =
        Number(existing.loan_amount) !== loanAmount ||
        Number(existing.receipt_amount) !== receiptAmount ||
        existing.loan_description !== (row.loanDescription ?? null) ||
        existing.receive_description !== (row.receiveDescription ?? null);

      if (changed) {
        await ledgerApiClient.credits.update(existing.id, {
          baseRevision: existing.revision ?? 1,
          party_id: row.partyId,
          loan_amount: loanAmount,
          receipt_amount: receiptAmount,
          loan_description: row.loanDescription || null,
          receive_description: row.receiveDescription || null
        });
      }
    } else {
      await ledgerApiClient.credits.create({
        day_id: dayId,
        party_id: row.partyId,
        loan_amount: loanAmount,
        receipt_amount: receiptAmount,
        loan_description: row.loanDescription || null,
        receive_description: row.receiveDescription || null
      });
    }
  }

  // Delete removed credits
  for (const existing of existingCredits) {
    if (!currentCreditPartyIds.has(existing.party_id)) {
      await ledgerApiClient.credits.delete(existing.id);
    }
  }

  // 4. Sync Owner Transactions
  const existingOwnerRes = await ledgerApiClient.owner.list(dayId);
  const existingOwner = existingOwnerRes.data || [];
  const existingOwnerMap = new Map(existingOwner.map((item: any) => [item.description, item]));

  const currentOwnerDescriptions = new Set<string>();
  for (const row of input.ownerBalances) {
    const amount = Number(row.amount ?? 0);
    if (amount === 0 || !row.description?.trim()) continue;

    const desc = row.description.trim();
    currentOwnerDescriptions.add(desc);
    const existing = existingOwnerMap.get(desc);

    if (existing) {
      if (Number(existing.amount) !== amount) {
        await ledgerApiClient.owner.update(existing.id, {
          baseRevision: existing.revision ?? 1,
          amount,
          description: desc
        });
      }
    } else {
      await ledgerApiClient.owner.create({
        day_id: dayId,
        description: desc,
        amount
      });
    }
  }

  // Delete removed owner transactions
  for (const existing of existingOwner) {
    if (!currentOwnerDescriptions.has(existing.description)) {
      await ledgerApiClient.owner.delete(existing.id);
    }
  }

  // 5. Fetch authoritative projections from PostgreSQL server
  let projections: DayProjectionsResponse["projections"] | null = null;
  try {
    const projResponse = await ledgerApiClient.calculations.getDayProjections(dayId);
    projections = (projResponse as any)?.data?.projections ?? projResponse?.projections ?? null;
  } catch (err) {
    console.warn(`[expenseTransactionService] Could not fetch latest day projections for ${dayId}:`, err);
  }

  // 6. Rehydrate day from PostgreSQL authoritative state
  let rehydratedDay: DailyLedgerInput | null = null;
  try {
    rehydratedDay = await loadExpenseDayPostgres(periodKey, input.dayNo);
  } catch (err) {
    console.warn(`[expenseTransactionService] Could not rehydrate day ${input.dayNo}:`, err);
  }

  return {
    success: true,
    dayId,
    projections,
    rehydratedDay,
    message: `Day ${input.dayNo} operational transactions saved to PostgreSQL successfully.`
  };
}

export async function loadExpenseDayPostgres(
  periodKey: string,
  dayNo: number
): Promise<DailyLedgerInput | null> {
  const periodData = await getAccountingPeriodWithDays(periodKey);
  if (!periodData) return null;

  if (dayNo === 32) {
    try {
      const finalRes = await ledgerApiClient.calculations.getPeriodFinalProjections(periodData.period.id);
      const finalData = (finalRes as any)?.data ?? finalRes;
      if (!finalData || !finalData.closingBalances) return null;

      // Authoritative Day 31 operational closing balances serve as Day 32 opening balances
      const opFin = finalData.operationalBalances?.financial ?? finalData.closingBalances.financial;
      const openingCash = opFin?.closingCash !== undefined ? Number(opFin.closingCash) : 0;
      const ownerOpeningBalance = opFin?.closingOwnerBalance !== undefined ? Number(opFin.closingOwnerBalance) : 0;

      const settlementEntries: any[] = finalData.finalSettlements?.entries ?? [];
      const isVerifiedOrClosed =
        finalData.period?.finalSettlementStatus === "VERIFIED" ||
        finalData.period?.finalSettlementStatus === "CLOSED" ||
        periodData.period.status === "closed";

      const commissions: CommissionItem[] = settlementEntries
        .filter(
          (e) =>
            (((e.balanceDomain ?? e.balance_domain) === "COMMISSION") ||
              ((e.balanceDomain ?? e.balance_domain) === "COMMISSION_RECEIVABLE")) &&
            ((e.status ?? "ACTIVE") === "ACTIVE")
        )
        .map((e) => ({
          id: e.id,
          categoryId: e.targetEntityId ?? e.target_entity_id ?? undefined,
          category: (e.targetEntityName ?? e.target_entity_name) || "Commission",
          amount: Number(e.amount)
        }));

      const expenses: ExpenseItem[] = settlementEntries
        .filter(
          (e) =>
            (((e.balanceDomain ?? e.balance_domain) === "EXPENSE") ||
              ((e.balanceDomain ?? e.balance_domain) === "CASH_SETTLEMENT") ||
              ((e.balanceDomain ?? e.balance_domain) === "OTHER")) &&
            ((e.status ?? "ACTIVE") === "ACTIVE")
        )
        .map((e) => ({
          id: e.id,
          categoryId: e.targetEntityId ?? e.target_entity_id ?? undefined,
          category: (e.targetEntityName ?? e.target_entity_name) || "General",
          name: (e.sourceReference ?? e.source_reference) || "Expense Item",
          description: e.notes || "",
          amount: Number(e.amount)
        }));

      const ownerBalances: OwnerBalanceRow[] = settlementEntries
        .filter(
          (e) =>
            ((e.balanceDomain ?? e.balance_domain) === "OWNER_BALANCE") &&
            ((e.status ?? "ACTIVE") === "ACTIVE")
        )
        .map((e) => {
          const rawAmt = Number(e.amount);
          const sType = e.settlementType ?? e.settlement_type;
          const isInjection = sType === "OWNER_INJECTION";
          const signedAmt = isInjection ? -rawAmt : rawAmt;
          return {
            id: e.id,
            description: (e.sourceReference ?? e.source_reference ?? e.notes) || "Owner Transaction",
            amount: signedAmt,
            expense: isInjection ? 0 : rawAmt,
            received: isInjection ? rawAmt : 0
          };
        });

      // Operational credit party closings provide authoritative Day 32 opening credit balances
      const opCreditParties: any[] =
        finalData.operationalBalances?.creditParties ?? finalData.closingBalances.creditParties ?? [];

      const credits: CreditRow[] = opCreditParties.map((cp: any) => {
        const partyId = cp.partyId ?? cp.party_id;
        const matchingLoan = settlementEntries.find(
          (e) =>
            ((e.balanceDomain ?? e.balance_domain) === "CREDIT_PARTY_BALANCE") &&
            ((e.targetEntityId ?? e.target_entity_id) === partyId) &&
            ((e.settlementType ?? e.settlement_type) === "CREDIT_LOAN") &&
            ((e.status ?? "ACTIVE") === "ACTIVE")
        );
        const matchingReceive = settlementEntries.find(
          (e) =>
            ((e.balanceDomain ?? e.balance_domain) === "CREDIT_PARTY_BALANCE") &&
            ((e.targetEntityId ?? e.target_entity_id) === partyId) &&
            (((e.settlementType ?? e.settlement_type) === "CREDIT_RECEIVE") ||
              ((e.settlementType ?? e.settlement_type) === "CREDIT_RECOVERY")) &&
            ((e.status ?? "ACTIVE") === "ACTIVE")
        );

        const loan = matchingLoan ? Number(matchingLoan.amount) : 0;
        const loanDesc = matchingLoan ? (matchingLoan.sourceReference ?? matchingLoan.notes ?? undefined) : undefined;
        const receive = matchingReceive ? Number(matchingReceive.amount) : 0;
        const receiveDesc = matchingReceive ? (matchingReceive.sourceReference ?? matchingReceive.notes ?? undefined) : undefined;

        return {
          id: `final-credit-${partyId}`,
          partyId,
          partyName: cp.partyName ?? cp.party_name,
          opening: Number(cp.closingBalance ?? cp.closing_balance ?? 0),
          loan,
          loanDescription: loanDesc,
          receive,
          receiveDescription: receiveDesc
        };
      });

      return {
        dayNo: 32,
        date: `${periodKey}-FINAL`,
        status: isVerifiedOrClosed ? "closed" : "open",
        label: "FINAL",
        notes: "Authoritative month-end FINAL closing state",
        lockedAt: isVerifiedOrClosed
          ? (periodData.period.updated_at ? new Date(periodData.period.updated_at).getTime() : Date.now())
          : undefined,
        openingCash,
        ownerOpeningBalance,
        expenses,
        commissions,
        credits,
        ownerBalances,
        updatedAt: Date.now()
      };
    } catch {
      return null;
    }
  }

  const dayRecord = periodData.days.get(dayNo);
  if (!dayRecord) return null;

  const [expRes, commRes, credRes, ownerRes, projRes, catalogRes] = await Promise.all([
    ledgerApiClient.expenses.list(dayRecord.id).catch(() => ({ data: [] })),
    ledgerApiClient.commissions.list(dayRecord.id).catch(() => ({ data: [] })),
    ledgerApiClient.credits.list(dayRecord.id).catch(() => ({ data: [] })),
    ledgerApiClient.owner.list(dayRecord.id).catch(() => ({ data: [] })),
    ledgerApiClient.calculations.getDayProjections(dayRecord.id).catch(() => ({ projections: null })),
    ledgerApiClient.catalogs.getCreditParties().catch(() => ({ data: [] }))
  ]);

  const expenses: ExpenseItem[] = (expRes.data || []).map((e: any) => ({
    id: e.id,
    categoryId: e.category_id ?? undefined,
    category: e.category_name_snapshot || "",
    name: e.item_name,
    description: e.description || "",
    amount: Number(e.amount)
  }));

  const commissions: CommissionItem[] = (commRes.data || []).map((c: any) => ({
    id: c.id,
    categoryId: c.category_id ?? undefined,
    category: c.category_name_snapshot || "",
    amount: Number(c.amount)
  }));

  const partyNameMap = new Map<string, string>();
  for (const cp of (catalogRes.data || [])) {
    partyNameMap.set(cp.id, cp.name);
  }

  const dayProjections = (projRes as any)?.data?.projections ?? (projRes as any)?.projections ?? null;
  const finProj = dayProjections?.financial;
  const openingCash = finProj?.opening_cash !== undefined && finProj?.opening_cash !== null
    ? Number(finProj.opening_cash)
    : undefined;
  const ownerOpeningBalance = finProj?.owner_opening_balance !== undefined && finProj?.owner_opening_balance !== null
    ? Number(finProj.owner_opening_balance)
    : undefined;

  const credits: CreditRow[] = [];
  const processedParties = new Set<string>();

  for (const cr of (credRes.data || [])) {
    processedParties.add(cr.party_id);
    const proj = dayProjections?.creditParties?.find((p: any) => p.party_id === cr.party_id);
    credits.push({
      id: cr.id,
      partyId: cr.party_id ?? undefined,
      partyName: cr.party_name_snapshot || partyNameMap.get(cr.party_id) || "",
      loanDescription: cr.loan_description || undefined,
      receiveDescription: cr.receive_description || undefined,
      opening: proj ? Number(proj.opening_balance ?? 0) : 0,
      loan: Number(cr.loan_amount || 0),
      receive: Number(cr.receipt_amount ?? cr.receive_amount ?? 0)
    });
  }

  for (const proj of (dayProjections?.creditParties || [])) {
    if (!processedParties.has(proj.party_id)) {
      processedParties.add(proj.party_id);
      credits.push({
        id: `${dayNo}-credit-${proj.party_id}`,
        partyId: proj.party_id,
        partyName: partyNameMap.get(proj.party_id) || "",
        description: "",
        opening: Number(proj.opening_balance ?? 0),
        loan: Number((proj as any).total_loans ?? (proj as any).loan_amount ?? 0),
        receive: Number((proj as any).total_receipts ?? (proj as any).receipt_amount ?? 0)
      });
    }
  }

  const ownerBalances: OwnerBalanceRow[] = (ownerRes.data || []).map((o: any) => {
    const amt = Number(o.amount);
    return {
      id: o.id,
      description: o.description || "",
      amount: amt,
      expense: Math.max(amt, 0),
      received: Math.max(-amt, 0)
    };
  });

  let latestUpdated = (dayRecord as any).updated_at
    ? new Date((dayRecord as any).updated_at).getTime()
    : (dayRecord.closed_at ? new Date(dayRecord.closed_at).getTime() : Date.now());

  const allTxTimestamps = [
    ...(expRes.data || []),
    ...(commRes.data || []),
    ...(credRes.data || []),
    ...(ownerRes.data || [])
  ]
    .map((t: any) => (t.updated_at ? new Date(t.updated_at).getTime() : 0))
    .filter((ts) => ts > 0);

  if (allTxTimestamps.length > 0) {
    latestUpdated = Math.max(latestUpdated, ...allTxTimestamps);
  }

  return {
    dayNo,
    date: `${periodKey}-${String(dayNo).padStart(2, "0")}`,
    status: dayRecord.status,
    notes: dayRecord.notes || undefined,
    lockedAt: dayRecord.status === "closed" ? (dayRecord.closed_at ? new Date(dayRecord.closed_at).getTime() : Date.now()) : undefined,
    closedAt: dayRecord.status === "closed" && dayRecord.closed_at ? new Date(dayRecord.closed_at).getTime() : undefined,
    reopenedAt: dayRecord.reopened_at ? new Date(dayRecord.reopened_at).getTime() : undefined,
    updatedAt: latestUpdated,
    openingCash,
    ownerOpeningBalance,
    expenses,
    commissions,
    credits,
    ownerBalances
  };
}

