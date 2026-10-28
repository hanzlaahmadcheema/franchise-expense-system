/**
 * Phase 6B: Calculation Service Interface
 *
 * Provides transactional service operations and projection query methods.
 */

import type { Kysely, Transaction } from "kysely";
import { sql } from "kysely";
import { db } from "../config/database.js";
import type { Database } from "../db/types.js";
import {
  calculateDayInternal,
  recalculateFromDayInternal,
  rebuildPeriodInternal
} from "./engine.js";
import { round2 } from "./evaluators.js";
import type {
  CalculationRunOptions,
  CalculationRunResult,
  DayCalculationResult,
  PeriodFinalClosingProjection,
  PeriodFinalCommissionSettlement,
  PeriodFinalCreditPartyClosing,
  PeriodFinalFinancialClosing,
  PeriodFinalJazzDoClosing,
  PeriodFinalJazzLiftingClosing,
  PeriodFinalStockAccountClosing,
  PeriodFinalStockProductClosing,
  FinalSettlementBalanceDomain,
  FinalSettlementDomainSummary,
  PeriodFinalSettlementsLayer
} from "./types.js";
import type { SeedBundleInput } from "../periods/schemas.js";

function formatSettlementDate(val: unknown): string {
  if (typeof val === "string") {
    return val.slice(0, 10);
  }
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(val ?? "");
}

export async function recalculateFromDay(
  franchiseId: string,
  startDayId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<CalculationRunResult> {
  return db.transaction().execute(async (trx) => {
    return recalculateFromDayInternal(trx, franchiseId, startDayId, options);
  });
}

export async function rebuildPeriod(
  franchiseId: string,
  periodId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<CalculationRunResult> {
  return db.transaction().execute(async (trx) => {
    return rebuildPeriodInternal(trx, franchiseId, periodId, options);
  });
}

export async function rebuildDay(
  franchiseId: string,
  dayId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<DayCalculationResult> {
  return db.transaction().execute(async (trx) => {
    return calculateDayInternal(trx, franchiseId, dayId, null, options);
  });
}

/**
 * Fetch all calculated projections for a specific day.
 */
export async function getDayProjections(franchiseId: string, dayId: string) {
  const day = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", dayId)
    .executeTakeFirst();

  if (!day) {
    return null;
  }

  const financial = await db
    .selectFrom("day_financial_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .executeTakeFirst();

  const creditParties = await db
    .selectFrom("credit_party_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  const stockProducts = await db
    .selectFrom("stock_product_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  const stockAccounts = await db
    .selectFrom("stock_account_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  const jazzLifting = await db
    .selectFrom("jazz_lifting_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .executeTakeFirst();

  const jazzDo = await db
    .selectFrom("jazz_load_do_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  return {
    day: {
      id: day.id,
      dayNo: day.day_no,
      periodId: day.period_id,
      status: day.status,
      calendarDate: day.calendar_date
    },
    projections: {
      financial: financial ?? null,
      creditParties,
      stockProducts,
      stockAccounts,
      jazzLifting: jazzLifting ?? null,
      jazzDo
    }
  };
}

/**
 * List invariant violations for a period.
 */
export async function getPeriodInvariants(franchiseId: string, periodId: string) {
  return db
    .selectFrom("invariant_violations")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .orderBy("created_at", "desc")
    .execute();
}

/**
 * List calculation runs for audit.
 */
export async function listCalculationRuns(
  franchiseId: string,
  limit = 50,
  offset = 0
) {
  return db
    .selectFrom("calculation_runs")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}

/**
 * Transactional internal query for authoritative month-end FINAL closing state of a period.
 * Derived strictly from the final operational day projections without independent rolling math.
 */
export async function getPeriodFinalProjectionsInternal(
  trx: Transaction<Database> | Kysely<Database>,
  franchiseId: string,
  periodId: string
): Promise<PeriodFinalClosingProjection | null> {
  const period = await trx
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    return null;
  }

  // Find the final operational calendar day of the period
  const finalDay = await trx
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .orderBy("day_no", "desc")
    .executeTakeFirst();

  if (!finalDay) {
    return null;
  }

  // Check if projections exist on finalDay
  let sourceDayForProjections = finalDay;
  let fin = await trx
    .selectFrom("day_financial_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", finalDay.id)
    .executeTakeFirst();

  if (!fin) {
    // If final calendar day has not been calculated yet, fall back to the latest day with projections
    const latestDayWithProj = await trx
      .selectFrom("day_financial_projections")
      .innerJoin("accounting_days", "accounting_days.id", "day_financial_projections.day_id")
      .selectAll("day_financial_projections")
      .select([
        "accounting_days.day_no as source_day_no",
        "accounting_days.id as source_day_id",
        "accounting_days.calendar_date as source_cal_date",
        "accounting_days.status as source_status"
      ])
      .where("day_financial_projections.franchise_id", "=", franchiseId)
      .where("accounting_days.period_id", "=", period.id)
      .orderBy("accounting_days.day_no", "desc")
      .executeTakeFirst();

    if (latestDayWithProj) {
      fin = latestDayWithProj;
      sourceDayForProjections = {
        ...finalDay,
        id: (latestDayWithProj as any).source_day_id,
        day_no: (latestDayWithProj as any).source_day_no,
        calendar_date: (latestDayWithProj as any).source_cal_date,
        status: (latestDayWithProj as any).source_status
      };
    }
  }

  if (!fin) {
    return null;
  }

  // Fetch all projections for sourceDayForProjections across all domains
  const [
    creditParties,
    stockProducts,
    stockAccounts,
    jazzLifting,
    jazzDos,
    catalogParties,
    catalogProducts,
    catalogAccounts,
    catalogDos,
    periodProductSeeds
  ] = await Promise.all([
    trx
      .selectFrom("credit_party_day_projections")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", sourceDayForProjections.id)
      .execute(),
    trx
      .selectFrom("stock_product_day_projections")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", sourceDayForProjections.id)
      .execute(),
    trx
      .selectFrom("stock_account_day_projections")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", sourceDayForProjections.id)
      .execute(),
    trx
      .selectFrom("jazz_lifting_day_projections")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", sourceDayForProjections.id)
      .executeTakeFirst(),
    trx
      .selectFrom("jazz_load_do_day_projections")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", sourceDayForProjections.id)
      .execute(),
    trx
      .selectFrom("credit_parties")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .execute(),
    trx
      .selectFrom("stock_products")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("is_active", "=", true)
      .execute(),
    trx
      .selectFrom("stock_accounts")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("is_active", "=", true)
      .execute(),
    trx
      .selectFrom("jazz_load_do_profiles")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("is_active", "=", true)
      .execute(),
    trx
      .selectFrom("period_stock_product_seeds")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", period.id)
      .execute()
  ]);

  const partyMap = new Map(catalogParties.map((p) => [p.id, p]));
  const productMap = new Map(catalogProducts.map((p) => [p.id, p]));
  const accountMap = new Map(catalogAccounts.map((a) => [a.id, a]));
  const doMap = new Map(catalogDos.map((d) => [d.id, d]));
  const prevProdSeedMap = new Map(periodProductSeeds.map((s) => [s.product_id, s]));

  const operationalCreditParties: PeriodFinalCreditPartyClosing[] = creditParties.map((c) => ({
    partyId: c.party_id,
    partyName: partyMap.get(c.party_id)?.name ?? "Unknown Party",
    closingBalance: String(c.closing_balance),
    openingBalance: String(c.opening_balance),
    totalLoans: String(c.total_loans),
    totalReceipts: String(c.total_receipts),
    manualAdjustments: String(c.manual_adjustments)
  }));

  const creditPartyClosings: PeriodFinalCreditPartyClosing[] = operationalCreditParties.map((c) => ({ ...c }));

  const stockProductClosingMap = new Map<string, number>();
  for (const sp of stockProducts) {
    stockProductClosingMap.set(sp.product_id, Number(sp.closing_qty));
  }

  const stockProductClosings: PeriodFinalStockProductClosing[] = catalogProducts.map((p) => {
    const closingQty = stockProductClosingMap.get(p.id);
    const prevSeed = prevProdSeedMap.get(p.id);
    const isSkipped = closingQty === undefined && prevSeed?.status === "skipped";
    return {
      productId: p.id,
      productName: p.name,
      openingQty: Number(prevSeed?.opening_quantity ?? 0),
      stockInQty: 0,
      stockOutQty: 0,
      closingQty: closingQty ?? 0,
      status: isSkipped ? "skipped" : "active"
    };
  });

  const stockAccountClosingMap = new Map<string, string>();
  for (const sa of stockAccounts) {
    stockAccountClosingMap.set(sa.account_id, String(sa.closing_due));
  }

  const stockAccountClosings: PeriodFinalStockAccountClosing[] = catalogAccounts.map((a) => {
    const proj = stockAccounts.find((sa) => sa.account_id === a.id);
    return {
      accountId: a.id,
      accountName: a.name,
      openingDue: proj ? String(proj.opening_due) : "0.00",
      stockTakenAmount: proj ? String(proj.stock_taken_amount) : "0.00",
      paymentReceivedAmount: proj ? String(proj.payment_received_amount) : "0.00",
      closingDue: stockAccountClosingMap.get(a.id) ?? "0.00"
    };
  });

  const jazzDoClosingMap = new Map<string, { base: string; ml: string }>();
  for (const jd of jazzDos) {
    jazzDoClosingMap.set(jd.do_profile_id, {
      base: String(jd.closing_base),
      ml: String(jd.closing_ml)
    });
  }

  const jazzDoClosings: PeriodFinalJazzDoClosing[] = catalogDos.map((d) => {
    const proj = jazzDos.find((jd) => jd.do_profile_id === d.id);
    const closing = jazzDoClosingMap.get(d.id);
    return {
      doProfileId: d.id,
      doName: d.do_name,
      doLine: d.do_line,
      openingBase: proj ? String(proj.opening_base) : "0.00",
      issuanceBase: proj ? String(proj.issuance_base) : "0.00",
      paymentBase: proj ? String(proj.payment_base) : "0.00",
      closingBase: closing?.base ?? "0.00",
      openingMl: proj ? String(proj.opening_ml) : "0.00",
      closingMl: closing?.ml ?? "0.00",
      appliedMlRatePercentage: proj ? String(proj.applied_ml_rate_percentage) : "0.00"
    };
  });

  const [commEarnedAgg, commSettledInPeriodAgg, commSettledAllTimeAgg, finalSettlementsRows] = await Promise.all([
    sql<{ total: string }>`
      SELECT COALESCE(SUM(ci.amount), 0) as total
      FROM commission_items ci
      JOIN accounting_days ad ON ad.id = ci.day_id
      WHERE ci.franchise_id = ${franchiseId}
        AND ad.period_id = ${period.id};
    `.execute(trx),
    sql<{ total: string }>`
      SELECT COALESCE(SUM(csr.amount), 0) as total
      FROM commission_settlement_receipts csr
      JOIN accounting_days ad ON ad.id = csr.day_id
      WHERE csr.franchise_id = ${franchiseId}
        AND ad.period_id = ${period.id}
        AND csr.source_period_key = ${period.period_key};
    `.execute(trx),
    sql<{ total: string }>`
      SELECT COALESCE(SUM(csr.amount), 0) as total
      FROM commission_settlement_receipts csr
      WHERE csr.franchise_id = ${franchiseId}
        AND csr.source_period_key = ${period.period_key};
    `.execute(trx),
    trx
      .selectFrom("final_settlement_entries")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", period.id)
      .where("status", "=", "ACTIVE")
      .orderBy("created_at", "asc")
      .execute()
  ]);

  // Unlinked commission settlements in final_settlement_entries (not yet tied to a receipt in commission_settlement_receipts)
  const unlinkedCommSettlements = await sql<{ total: string }>`
    SELECT COALESCE(SUM(fse.amount), 0) as total
    FROM final_settlement_entries fse
    WHERE fse.franchise_id = ${franchiseId}
      AND fse.period_id = ${period.id}
      AND fse.balance_domain = 'COMMISSION_RECEIVABLE'
      AND fse.status = 'ACTIVE'
      AND NOT EXISTS (
        SELECT 1 FROM commission_settlement_receipts csr
        WHERE csr.final_settlement_entry_id = fse.id
      );
  `.execute(trx);

  const totalCommissionEarned = Number(commEarnedAgg.rows[0]?.total ?? 0);
  const commissionSettledDuringPeriod = Number(commSettledInPeriodAgg.rows[0]?.total ?? 0);
  const totalCommissionSettledAllTime = round2(
    Number(commSettledAllTimeAgg.rows[0]?.total ?? 0) + Number(unlinkedCommSettlements.rows[0]?.total ?? 0)
  );
  // Authoritative operational commission receivable from Day 31 projection (not operational earned commission)
  const operationalCommissionReceivable = round2(Number((fin as any).closing_commission_receivable ?? 0));
  const finalCommSettlementEntries = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "COMMISSION_RECEIVABLE")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const outstandingCommissionReceivable = round2(
    Math.max(0, operationalCommissionReceivable - totalCommissionSettledAllTime)
  );

  // Update creditPartyClosings with FINAL transactions (loans increase debt, receives decrease debt)
  for (const cp of creditPartyClosings) {
    const cpEntries = finalSettlementsRows.filter(
      (e) => e.balance_domain === "CREDIT_PARTY_BALANCE" && e.target_entity_id === cp.partyId
    );
    const cpLoans = round2(
      cpEntries
        .filter((e) => e.settlement_type === "CREDIT_LOAN")
        .reduce((sum, e) => sum + Number(e.amount), 0)
    );
    const cpReceipts = round2(
      cpEntries
        .filter((e) => e.settlement_type === "CREDIT_RECEIVE" || e.settlement_type === "CREDIT_RECOVERY")
        .reduce((sum, e) => sum + Number(e.amount), 0)
    );
    if (cpLoans > 0 || cpReceipts > 0) {
      const postFinalClosing = round2(Number(cp.closingBalance) + cpLoans - cpReceipts);
      cp.closingBalance = postFinalClosing.toFixed(2);
      cp.totalLoans = round2(Number(cp.totalLoans) + cpLoans).toFixed(2);
      cp.totalReceipts = round2(Number(cp.totalReceipts) + cpReceipts).toFixed(2);
    }
  }

  for (const e of finalSettlementsRows) {
    if (e.balance_domain === "CREDIT_PARTY_BALANCE" && e.target_entity_id) {
      if (!creditPartyClosings.some((c) => c.partyId === e.target_entity_id)) {
        const party = partyMap.get(e.target_entity_id);
        const cpLoans = e.settlement_type === "CREDIT_LOAN" ? Number(e.amount) : 0;
        const cpReceipts =
          e.settlement_type === "CREDIT_RECEIVE" || e.settlement_type === "CREDIT_RECOVERY" ? Number(e.amount) : 0;
        creditPartyClosings.push({
          partyId: e.target_entity_id,
          partyName: party?.name ?? e.target_entity_name ?? "Unknown Party",
          closingBalance: String(round2(cpLoans - cpReceipts)),
          openingBalance: "0.00",
          totalLoans: String(round2(cpLoans)),
          totalReceipts: String(round2(cpReceipts)),
          manualAdjustments: "0.00"
        });
      }
    }
  }

  // Construct Domain Summaries
  const domainSummaries: FinalSettlementDomainSummary[] = [];

  // 1. Commission Receivable
  // Actual receivable comes from authoritative Day 31 projection, NOT operational earned commission
  domainSummaries.push({
    balanceDomain: "COMMISSION_RECEIVABLE",
    label: `${period.label} Commission Receivable`,
    targetEntityId: null,
    targetEntityName: null,
    operationalClosingBalance: String(operationalCommissionReceivable),
    settledAmount: String(totalCommissionSettledAllTime),
    remainingOutstanding: String(outstandingCommissionReceivable),
    isResolved: outstandingCommissionReceivable === 0,
    status: outstandingCommissionReceivable === 0
      ? "SETTLED"
      : totalCommissionSettledAllTime > 0
      ? "PARTIALLY_SETTLED"
      : "UNSETTLED"
  });

  // 2. Credit Parties (summarizes settlement against operational Day 31 debt)
  // Customer closing debts roll forward into next period's seeds and do not represent unresolved obligations
  for (const cp of operationalCreditParties) {
    const cpEntries = finalSettlementsRows.filter(
      (e) => e.balance_domain === "CREDIT_PARTY_BALANCE" && e.target_entity_id === cp.partyId
    );
    const cpReceipts = round2(
      cpEntries
        .filter((e) => e.settlement_type === "CREDIT_RECEIVE" || e.settlement_type === "CREDIT_RECOVERY")
        .reduce((sum, e) => sum + Number(e.amount), 0)
    );
    const cpOperational = Number(cp.closingBalance);
    const cpRemaining = round2(Math.max(0, cpOperational - cpReceipts));

    if (cpOperational !== 0 || cpReceipts > 0) {
      domainSummaries.push({
        balanceDomain: "CREDIT_PARTY_BALANCE",
        label: `Credit Party: ${cp.partyName}`,
        targetEntityId: cp.partyId,
        targetEntityName: cp.partyName,
        operationalClosingBalance: String(cpOperational),
        settledAmount: String(cpReceipts),
        remainingOutstanding: String(cpRemaining),
        isResolved: cpReceipts <= Math.max(0, cpOperational),
        status: cpRemaining === 0 ? "SETTLED" : cpReceipts > 0 ? "PARTIALLY_SETTLED" : "SETTLED"
      });
    }
  }

  // 3. Cash Settlement
  // Negative closing cash rolls forward into next period's opening cash seed and is not an unresolved obligation
  const cashEntries = finalSettlementsRows.filter((e) => e.balance_domain === "CASH_SETTLEMENT");
  const cashSettled = round2(cashEntries.reduce((sum, e) => sum + Number(e.amount), 0));
  const closingCashNum = Number(fin.closing_cash);
  if (closingCashNum < 0 || cashSettled > 0) {
    const remainingCash = round2(closingCashNum + cashSettled);
    domainSummaries.push({
      balanceDomain: "CASH_SETTLEMENT",
      label: "Closing Cash Settlement / Adjustment",
      targetEntityId: null,
      targetEntityName: null,
      operationalClosingBalance: String(closingCashNum),
      settledAmount: String(cashSettled),
      remainingOutstanding: "0.00",
      isResolved: true,
      status: "SETTLED"
    });
  }

  // 4. Owner Balance Settlement
  const ownerEntries = finalSettlementsRows.filter((e) => e.balance_domain === "OWNER_BALANCE");
  for (const o of ownerEntries) {
    if (o.settlement_type === "OWNER_DRAWING" || o.settlement_type === "OWNER_INJECTION") {
      domainSummaries.push({
        balanceDomain: "OWNER_BALANCE",
        label: `Owner: ${o.source_reference || o.notes || o.settlement_type}`,
        targetEntityId: o.target_entity_id,
        targetEntityName: o.target_entity_name,
        operationalClosingBalance: String(o.amount),
        settledAmount: String(o.amount),
        remainingOutstanding: "0.00",
        isResolved: true,
        status: "SETTLED"
      });
    }
  }
  const legacyOwnerEntries = ownerEntries.filter(
    (e) => e.settlement_type !== "OWNER_DRAWING" && e.settlement_type !== "OWNER_INJECTION"
  );
  if (legacyOwnerEntries.length > 0) {
    const ownerSettled = round2(legacyOwnerEntries.reduce((sum, e) => sum + Number(e.amount), 0));
    const closingOwnerNum = Number(fin.owner_closing_balance);
    const remainingOwner = round2(closingOwnerNum - ownerSettled);
    domainSummaries.push({
      balanceDomain: "OWNER_BALANCE",
      label: "Owner Balance Settlement",
      targetEntityId: null,
      targetEntityName: null,
      operationalClosingBalance: String(closingOwnerNum),
      settledAmount: String(ownerSettled),
      remainingOutstanding: String(remainingOwner),
      isResolved: remainingOwner === 0,
      status: remainingOwner === 0 ? "SETTLED" : "PARTIALLY_SETTLED"
    });
  }

  // 5. Expense Entries
  const expenseEntries = finalSettlementsRows.filter(
    (e) => e.balance_domain === "EXPENSE" || e.settlement_type === "EXPENSE"
  );
  for (const exp of expenseEntries) {
    domainSummaries.push({
      balanceDomain: "EXPENSE",
      label: `Expense: ${exp.target_entity_name || exp.source_reference || "Expense"}`,
      targetEntityId: exp.target_entity_id,
      targetEntityName: exp.target_entity_name,
      operationalClosingBalance: String(exp.amount),
      settledAmount: String(exp.amount),
      remainingOutstanding: "0.00",
      isResolved: true,
      status: "SETTLED"
    });
  }

  // 6. Commission Entries
  const commEntries = finalSettlementsRows.filter(
    (e) => e.balance_domain === "COMMISSION" || e.settlement_type === "COMMISSION"
  );
  for (const c of commEntries) {
    domainSummaries.push({
      balanceDomain: "COMMISSION",
      label: `Commission: ${c.target_entity_name || c.source_reference || "Commission"}`,
      targetEntityId: c.target_entity_id,
      targetEntityName: c.target_entity_name,
      operationalClosingBalance: String(c.amount),
      settledAmount: String(c.amount),
      remainingOutstanding: "0.00",
      isResolved: true,
      status: "SETTLED"
    });
  }

  // 7. Other
  const otherEntries = finalSettlementsRows.filter((e) => e.balance_domain === "OTHER");
  for (const o of otherEntries) {
    domainSummaries.push({
      balanceDomain: "OTHER",
      label: o.target_entity_name || o.settlement_type,
      targetEntityId: o.target_entity_id,
      targetEntityName: o.target_entity_name,
      operationalClosingBalance: String(o.amount),
      settledAmount: String(o.amount),
      remainingOutstanding: "0.00",
      isResolved: true,
      status: "SETTLED"
    });
  }

  const allResolved = domainSummaries.every((d) => d.isResolved);
  const totalOutstanding = round2(
    domainSummaries.reduce((sum, d) => sum + (d.isResolved ? 0 : Math.max(0, Number(d.remainingOutstanding))), 0)
  );

  let settlementStatus: "PENDING_SETTLEMENT" | "SETTLED" | "VERIFIED" | "CLOSED" =
    ((period as any).final_settlement_status as any) ?? "PENDING_SETTLEMENT";

  if (period.status === "closed") {
    settlementStatus = "CLOSED";
  } else if (settlementStatus === "VERIFIED") {
    settlementStatus = "VERIFIED";
  } else if (allResolved) {
    settlementStatus = "SETTLED";
  } else {
    settlementStatus = "PENDING_SETTLEMENT";
  }

  const finalSettlements: PeriodFinalSettlementsLayer = {
    entries: finalSettlementsRows.map((e) => ({
      id: e.id,
      franchiseId: e.franchise_id,
      periodId: e.period_id,
      sourcePeriodKey: e.source_period_key,
      settlementDate: formatSettlementDate(e.settlement_date),
      balanceDomain: e.balance_domain as FinalSettlementBalanceDomain,
      settlementType: e.settlement_type,
      targetEntityId: e.target_entity_id,
      targetEntityName: e.target_entity_name,
      amount: String(e.amount),
      sourceReference: e.source_reference,
      notes: e.notes,
      status: e.status as "ACTIVE" | "REVERSED",
      targetDayId: e.target_day_id,
      revision: e.revision,
      createdByUserId: e.created_by_user_id,
      createdAt: new Date(e.created_at as unknown as string).toISOString(),
      updatedAt: new Date(e.updated_at as unknown as string).toISOString()
    })),
    domainSummaries,
    totalOutstanding: String(totalOutstanding),
    allResolved
  };

  const commissionSettlement: PeriodFinalCommissionSettlement = {
    totalCommissionEarned: String(totalCommissionEarned),
    commissionSettledDuringPeriod: String(commissionSettledDuringPeriod),
    totalCommissionSettledAllTime: String(totalCommissionSettledAllTime),
    outstandingCommissionReceivable: String(outstandingCommissionReceivable),
    settlementStatus,
    verifiedAt: (period as any).final_verified_at
      ? new Date((period as any).final_verified_at).toISOString()
      : null,
    verifiedByUserId: (period as any).final_verified_by_user_id ?? null
  };

  // Compute operational balances (pre-FINAL Day 31 closing snapshot)
  const operationalFinancial: PeriodFinalFinancialClosing = {
    closingCash: String(fin.closing_cash),
    closingOwnerBalance: String(fin.owner_closing_balance),
    closingJazzPayable: String(fin.closing_jazz_payable ?? "0.00"),
    operatingProfit: String(fin.operating_profit),
    totalIssues: String(fin.total_issues),
    totalExpenses: String(fin.total_expenses),
    commissionSettlementReceipts: String((fin as any).commission_settlement_receipts ?? "0.00"),
    openingCommissionReceivable: String((fin as any).opening_commission_receivable ?? "0.00"),
    closingCommissionReceivable: String(outstandingCommissionReceivable)
  };

  // Compute post-FINAL closing balances (Day 31 closing + active FINAL transactions)
  const finalExpenses = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "EXPENSE" || e.settlement_type === "EXPENSE")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const finalCommissions = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "COMMISSION" || e.settlement_type === "COMMISSION")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const commReceivableSettled = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "COMMISSION_RECEIVABLE")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const creditLoans = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "CREDIT_PARTY_BALANCE" && e.settlement_type === "CREDIT_LOAN")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const creditReceives = round2(
    finalSettlementsRows
      .filter(
        (e) =>
          e.balance_domain === "CREDIT_PARTY_BALANCE" &&
          (e.settlement_type === "CREDIT_RECEIVE" || e.settlement_type === "CREDIT_RECOVERY")
      )
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const ownerDrawings = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "OWNER_BALANCE" && e.settlement_type === "OWNER_DRAWING")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const ownerInjections = round2(
    finalSettlementsRows
      .filter(
        (e) =>
          e.balance_domain === "OWNER_BALANCE" &&
          (e.settlement_type === "OWNER_INJECTION" || e.settlement_type === "OWNER_SETTLEMENT")
      )
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );
  const cashSettlements = round2(
    finalSettlementsRows
      .filter((e) => e.balance_domain === "CASH_SETTLEMENT")
      .reduce((sum, e) => sum + Number(e.amount), 0)
  );

  const postFinalCash = round2(
    Number(fin.closing_cash) -
      finalExpenses +
      finalCommissions +
      cashSettlements
  );
  const postFinalOwner = round2(Number(fin.owner_closing_balance) + ownerDrawings - ownerInjections);
  const postFinalTotalExpenses = round2(Number(fin.total_expenses) + finalExpenses);
  const postFinalTotalIssues = round2(Number(fin.total_issues) + finalCommissions);
  const postFinalOperatingProfit = round2(Number(fin.operating_profit) + finalCommissions - finalExpenses);

  const financialClosing: PeriodFinalFinancialClosing = {
    closingCash: finalSettlementsRows.length === 0 ? String(fin.closing_cash) : postFinalCash.toFixed(2),
    closingOwnerBalance: finalSettlementsRows.length === 0 ? String(fin.owner_closing_balance) : postFinalOwner.toFixed(2),
    closingJazzPayable: String(fin.closing_jazz_payable ?? "0.00"),
    operatingProfit: finalSettlementsRows.length === 0 ? String(fin.operating_profit) : postFinalOperatingProfit.toFixed(2),
    totalIssues: finalSettlementsRows.length === 0 ? String(fin.total_issues) : postFinalTotalIssues.toFixed(2),
    totalExpenses: finalSettlementsRows.length === 0 ? String(fin.total_expenses) : postFinalTotalExpenses.toFixed(2),
    commissionSettlementReceipts: String(
      round2(Number((fin as any).commission_settlement_receipts ?? 0) + commReceivableSettled)
    ),
    openingCommissionReceivable: String((fin as any).opening_commission_receivable ?? "0.00"),
    closingCommissionReceivable: String(outstandingCommissionReceivable)
  };

  const jazzLiftingClosing: PeriodFinalJazzLiftingClosing | null = jazzLifting
    ? {
        openingLifting: String(jazzLifting.opening_lifting),
        mlLiftingPurchased: String(jazzLifting.ml_lifting_purchased),
        todayMlIssuance: String(jazzLifting.today_ml_issuance),
        closingLiftingInHand: String(jazzLifting.closing_lifting_in_hand)
      }
    : null;

  const seedBundle: SeedBundleInput = {
    financial: {
      openingCash: financialClosing.closingCash,
      openingOwnerBalance: financialClosing.closingOwnerBalance,
      openingJazzLifting: jazzLiftingClosing ? jazzLiftingClosing.closingLiftingInHand : "0.00",
      openingJazzPayable: financialClosing.closingJazzPayable,
      openingCommissionReceivable: String(outstandingCommissionReceivable),
      sourcePeriodKey: period.period_key,
      sourceDayNo: finalDay.day_no,
      notes: `ROLLED_FORWARD_FROM_${period.period_key}_FINAL`
    },
    creditParties: creditPartyClosings
      .map((c) => ({
        partyId: c.partyId,
        openingBalance: c.closingBalance,
        sourcePeriodKey: period.period_key,
        sourceDayNo: finalDay.day_no
      }))
      .filter((c) => Number(c.openingBalance) !== 0),
    stockProducts: stockProductClosings.map((p) => {
      if (p.status === "skipped") {
        return {
          productId: p.productId,
          openingQuantity: null,
          status: "skipped" as const,
          notes: `ROLLED_FORWARD_SKIPPED_FROM_${period.period_key}`,
          sourcePeriodKey: period.period_key,
          sourceDayNo: finalDay.day_no
        };
      }
      return {
        productId: p.productId,
        openingQuantity: p.closingQty,
        status: "active" as const,
        notes: null,
        sourcePeriodKey: period.period_key,
        sourceDayNo: finalDay.day_no
      };
    }),
    stockAccounts: stockAccountClosings.map((a) => ({
      accountId: a.accountId,
      openingReceivable: a.closingDue,
      sourcePeriodKey: period.period_key,
      sourceDayNo: finalDay.day_no
    })),
    jazzDoProfiles: jazzDoClosings.map((d) => ({
      doProfileId: d.doProfileId,
      openingBaseBalance: d.closingBase,
      sourcePeriodKey: period.period_key,
      sourceDayNo: finalDay.day_no
    }))
  };

  return {
    period: {
      id: period.id,
      periodKey: period.period_key,
      yearNum: period.year_num,
      monthNum: period.month_num,
      label: period.label,
      status: period.status,
      finalSettlementStatus: settlementStatus
    },
    boundary: "FINAL",
    finalDay: {
      id: finalDay.id,
      dayNo: finalDay.day_no,
      calendarDate: finalDay.calendar_date,
      status: finalDay.status
    },
    operationalBalances: {
      financial: operationalFinancial,
      creditParties: operationalCreditParties
    },
    closingBalances: {
      financial: financialClosing,
      jazzLifting: jazzLiftingClosing,
      creditParties: creditPartyClosings,
      stockProducts: stockProductClosings,
      stockAccounts: stockAccountClosings,
      jazzDoProfiles: jazzDoClosings,
      commissionSettlement
    },
    commissionSettlement,
    finalSettlements,
    seedBundle
  };
}

/**
 * Fetch authoritative month-end FINAL closing state of a period.
 */
export async function getPeriodFinalProjections(
  franchiseId: string,
  periodId: string
): Promise<PeriodFinalClosingProjection | null> {
  return getPeriodFinalProjectionsInternal(db, franchiseId, periodId);
}

/**
 * Fetch report distinguishing:
 * - Commission earned in period
 * - Commission settled during period
 * - Prior period settlements received in this period
 * - Outstanding commission receivable
 * - Total cash received
 */
export async function getPeriodCommissionSummary(
  franchiseId: string,
  periodId: string
) {
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) return null;

  const [earnedAgg, settledInPeriodAgg, priorSettledReceivedAgg, cashAgg] = await Promise.all([
    sql<{ total: string }>`
      SELECT COALESCE(SUM(ci.amount), 0) as total
      FROM commission_items ci
      JOIN accounting_days ad ON ad.id = ci.day_id
      WHERE ci.franchise_id = ${franchiseId} AND ad.period_id = ${period.id};
    `.execute(db),
    sql<{ total: string }>`
      SELECT COALESCE(SUM(csr.amount), 0) as total
      FROM commission_settlement_receipts csr
      JOIN accounting_days ad ON ad.id = csr.day_id
      WHERE csr.franchise_id = ${franchiseId}
        AND ad.period_id = ${period.id}
        AND csr.source_period_key = ${period.period_key};
    `.execute(db),
    sql<{ total: string }>`
      SELECT COALESCE(SUM(csr.amount), 0) as total
      FROM commission_settlement_receipts csr
      JOIN accounting_days ad ON ad.id = csr.day_id
      WHERE csr.franchise_id = ${franchiseId}
        AND ad.period_id = ${period.id}
        AND csr.source_period_key != ${period.period_key};
    `.execute(db),
    sql<{ total_in: string; total_settlements: string }>`
      SELECT
        COALESCE(SUM(dfp.total_issues), 0) as total_in,
        COALESCE(SUM(dfp.commission_settlement_receipts), 0) as total_settlements
      FROM day_financial_projections dfp
      JOIN accounting_days ad ON ad.id = dfp.day_id
      WHERE dfp.franchise_id = ${franchiseId} AND ad.period_id = ${period.id};
    `.execute(db)
  ]);

  const [settledAllTimeAgg, unlinkedCommSettlements] = await Promise.all([
    sql<{ total: string }>`
      SELECT COALESCE(SUM(csr.amount), 0) as total
      FROM commission_settlement_receipts csr
      WHERE csr.franchise_id = ${franchiseId} AND csr.source_period_key = ${period.period_key};
    `.execute(db),
    sql<{ total: string }>`
      SELECT COALESCE(SUM(fse.amount), 0) as total
      FROM final_settlement_entries fse
      WHERE fse.franchise_id = ${franchiseId}
        AND fse.period_id = ${period.id}
        AND fse.balance_domain = 'COMMISSION_RECEIVABLE'
        AND fse.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM commission_settlement_receipts csr
          WHERE csr.final_settlement_entry_id = fse.id
        );
    `.execute(db)
  ]);

  const commissionEarned = Number(earnedAgg.rows[0]?.total ?? 0);
  const commissionSettledDuringPeriod = Number(settledInPeriodAgg.rows[0]?.total ?? 0);
  const priorPeriodSettlementReceived = Number(priorSettledReceivedAgg.rows[0]?.total ?? 0);
  const totalSettledAllTime = round2(
    Number(settledAllTimeAgg.rows[0]?.total ?? 0) + Number(unlinkedCommSettlements.rows[0]?.total ?? 0)
  );
  const outstandingCommissionReceivable = round2(
    Math.max(0, commissionEarned - totalSettledAllTime)
  );
  const totalCashReceived = round2(
    Number(cashAgg.rows[0]?.total_in ?? 0) + Number(cashAgg.rows[0]?.total_settlements ?? 0)
  );

  let settlementStatus: "PENDING_SETTLEMENT" | "SETTLED" | "VERIFIED" | "CLOSED" =
    ((period as any).final_settlement_status as any) ?? "PENDING_SETTLEMENT";

  if (period.status === "closed") {
    settlementStatus = "CLOSED";
  } else if (settlementStatus === "VERIFIED") {
    settlementStatus = "VERIFIED";
  } else if (outstandingCommissionReceivable === 0) {
    settlementStatus = "SETTLED";
  } else {
    settlementStatus = "PENDING_SETTLEMENT";
  }

  return {
    periodId: period.id,
    periodKey: period.period_key,
    label: period.label,
    commissionEarned: String(commissionEarned),
    commissionSettledDuringPeriod: String(commissionSettledDuringPeriod),
    priorPeriodSettlementReceived: String(priorPeriodSettlementReceived),
    outstandingCommissionReceivable: String(outstandingCommissionReceivable),
    totalCashReceived: String(totalCashReceived),
    settlementStatus,
    finalSettlementStatus: settlementStatus,
    verifiedAt: (period as any).final_verified_at
      ? new Date((period as any).final_verified_at).toISOString()
      : null,
    verifiedByUserId: (period as any).final_verified_by_user_id ?? null
  };
}
