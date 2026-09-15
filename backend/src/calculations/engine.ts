/**
 * Phase 6B: Calculation & Projection Engine
 *
 * Server-authoritative engine that computes daily derived projections from raw PostgreSQL transaction facts.
 * Enforces:
 * - Row-level locking with ascending deadlock prevention
 * - Full transactional atomicity (rollback on invariant failure)
 * - Deterministic forward cascading across accounting periods
 * - Logging of calculation runs and invariant warnings
 */

import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import {
  evaluateFinancialState,
  evaluateCreditParty,
  evaluateStockProduct,
  evaluateStockAccount,
  evaluateJazzLifting,
  evaluateJazzDo,
  round2,
  round4
} from "./evaluators.js";
import {
  validateFinancialInvariants,
  validateCreditPartyInvariants,
  validateStockProductInvariants,
  validateStockAccountInvariants,
  validateJazzLiftingInvariants,
  validateJazzDoInvariants,
  InvariantViolationError
} from "./invariants.js";
import type {
  DayCalculationResult,
  CalculationRunOptions,
  CalculationRunResult,
  InvariantViolationItem,
  CreditPartyProjectionData,
  StockProductProjectionData,
  StockAccountProjectionData,
  JazzDoProjectionData
} from "./types.js";

interface DayRow {
  id: string;
  franchise_id: string;
  period_id: string;
  day_no: number;
  status: "open" | "closed" | "reopen";
  calendar_date: string;
}

/**
 * Calculates projections for a single day within a database transaction.
 */
export async function calculateDayInternal(
  trx: Transaction<Database>,
  franchiseId: string,
  dayId: string,
  calcRunId: string | null = null,
  options: CalculationRunOptions = { triggerSource: "mutation" }
): Promise<DayCalculationResult> {
  // 1. Lock and fetch current accounting day
  const dayResult = await sql<DayRow>`
    SELECT id, franchise_id, period_id, day_no, status, calendar_date
    FROM accounting_days
    WHERE id = ${dayId} AND franchise_id = ${franchiseId}
    FOR UPDATE;
  `.execute(trx);

  if (dayResult.rows.length === 0) {
    throw new InvariantViolationError(
      "INV_TENANT_ISOLATION",
      `Accounting day ${dayId} not found or does not belong to franchise ${franchiseId}`
    );
  }

  const day = dayResult.rows[0];

  if (day.status === "closed" && !options.allowClosedDays) {
    throw new InvariantViolationError(
      "INV_CLOSED_DAY_MUTATION",
      `Cannot calculate projections for CLOSED accounting day ${day.day_no} (${day.calendar_date})`
    );
  }

  const warnings: InvariantViolationItem[] = [];

  // 2. Fetch Opening Balances (from previous day closing or period seeds)
  let openingCash = 0;
  let ownerOpeningBalance = 0;
  let openingJazzLifting = 0;
  let openingJazzPayable = 0;
  const creditPartyOpenings = new Map<string, number>();
  const stockProductOpenings = new Map<string, number>();
  const stockAccountOpenings = new Map<string, number>();
  const jazzDoOpenings = new Map<string, number>();

  if (day.day_no === 1) {
    // Read from Period Seeds
    const finSeed = await trx
      .selectFrom("period_financial_seeds")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", day.period_id)
      .executeTakeFirst();

    if (!finSeed) {
      throw new InvariantViolationError(
        "INV_MISSING_FINANCIAL_SEEDS",
        `Missing required period_financial_seeds for period ${day.period_id} on Day 1. Opening values cannot be inferred.`,
        { dayId: day.id, periodId: day.period_id }
      );
    }

    openingCash = Number(finSeed.opening_cash);
    ownerOpeningBalance = Number(finSeed.opening_owner_balance);
    openingJazzLifting = Number(finSeed.opening_jazz_lifting);
    openingJazzPayable = Number(finSeed.opening_jazz_payable);

    const creditSeeds = await trx
      .selectFrom("period_credit_party_seeds")
      .select(["party_id", "opening_balance"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", day.period_id)
      .execute();
    for (const cs of creditSeeds) {
      creditPartyOpenings.set(cs.party_id, Number(cs.opening_balance));
    }

    const stockProdSeeds = await trx
      .selectFrom("period_stock_product_seeds")
      .select(["product_id", "opening_quantity"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", day.period_id)
      .execute();
    for (const sps of stockProdSeeds) {
      stockProductOpenings.set(sps.product_id, Number(sps.opening_quantity));
    }

    const stockAccSeeds = await trx
      .selectFrom("period_stock_account_seeds")
      .select(["account_id", "opening_receivable"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", day.period_id)
      .execute();
    for (const sas of stockAccSeeds) {
      stockAccountOpenings.set(sas.account_id, Number(sas.opening_receivable));
    }

    const jazzDoSeeds = await trx
      .selectFrom("period_jazz_do_seeds")
      .select(["do_profile_id", "opening_base_balance"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", day.period_id)
      .execute();
    for (const jds of jazzDoSeeds) {
      jazzDoOpenings.set(jds.do_profile_id, Number(jds.opening_base_balance));
    }
  } else {
    // Read from Day D-1 Projections
    const prevDay = await trx
      .selectFrom("accounting_days")
      .select(["id", "day_no"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", day.period_id)
      .where("day_no", "=", day.day_no - 1)
      .executeTakeFirst();

    if (prevDay) {
      const prevFin = await trx
        .selectFrom("day_financial_projections")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("day_id", "=", prevDay.id)
        .executeTakeFirst();

      if (prevFin) {
        openingCash = Number(prevFin.closing_cash);
        ownerOpeningBalance = Number(prevFin.owner_closing_balance);
        openingJazzPayable = Number(prevFin.closing_jazz_payable ?? 0);
      }

      const prevLifting = await trx
        .selectFrom("jazz_lifting_day_projections")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("day_id", "=", prevDay.id)
        .executeTakeFirst();

      if (prevLifting) {
        openingJazzLifting = Number(prevLifting.closing_lifting_in_hand);
      }

      const prevCredit = await trx
        .selectFrom("credit_party_day_projections")
        .select(["party_id", "closing_balance"])
        .where("franchise_id", "=", franchiseId)
        .where("day_id", "=", prevDay.id)
        .execute();
      for (const pc of prevCredit) {
        creditPartyOpenings.set(pc.party_id, Number(pc.closing_balance));
      }

      const prevStockProds = await trx
        .selectFrom("stock_product_day_projections")
        .select(["product_id", "closing_qty"])
        .where("franchise_id", "=", franchiseId)
        .where("day_id", "=", prevDay.id)
        .execute();
      for (const psp of prevStockProds) {
        stockProductOpenings.set(psp.product_id, Number(psp.closing_qty));
      }

      const prevStockAccs = await trx
        .selectFrom("stock_account_day_projections")
        .select(["account_id", "closing_due"])
        .where("franchise_id", "=", franchiseId)
        .where("day_id", "=", prevDay.id)
        .execute();
      for (const psa of prevStockAccs) {
        stockAccountOpenings.set(psa.account_id, Number(psa.closing_due));
      }

      const prevJazzDos = await trx
        .selectFrom("jazz_load_do_day_projections")
        .select(["do_profile_id", "closing_base"])
        .where("franchise_id", "=", franchiseId)
        .where("day_id", "=", prevDay.id)
        .execute();
      for (const pjd of prevJazzDos) {
        jazzDoOpenings.set(pjd.do_profile_id, Number(pjd.closing_base));
      }
    }
  }

  // 3. Fetch Raw Facts for Current Day
  // 3.1 Expenses & Commissions
  const expensesAgg = await sql<{ total: string }>`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM expense_items
    WHERE franchise_id = ${franchiseId} AND day_id = ${day.id};
  `.execute(trx);
  const totalExpenses = Number(expensesAgg.rows[0]?.total ?? 0);

  const commissionsAgg = await sql<{ total: string }>`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM commission_items
    WHERE franchise_id = ${franchiseId} AND day_id = ${day.id};
  `.execute(trx);
  const totalIssues = Number(commissionsAgg.rows[0]?.total ?? 0);

  // 3.2 Owner Transactions
  const ownerAgg = await sql<{ total: string }>`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM owner_transactions
    WHERE franchise_id = ${franchiseId} AND day_id = ${day.id};
  `.execute(trx);
  const ownerNetMovement = Number(ownerAgg.rows[0]?.total ?? 0);

  // 3.3 Jazz Payable Facts (Inbound Stock Purchases + Payable Payments)
  const inboundStockAgg = await sql<{ total: string }>`
    SELECT COALESCE(SUM(sol.line_amount), 0) as total
    FROM stock_order_lines sol
    JOIN stock_orders so ON so.id = sol.stock_order_id
    WHERE so.franchise_id = ${franchiseId}
      AND so.day_id = ${day.id}
      AND so.direction = 'inbound';
  `.execute(trx);
  const inboundStockAmount = Number(inboundStockAgg.rows[0]?.total ?? 0);

  const payablePaymentsAgg = await sql<{ total: string }>`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM jazz_company_payable_payments
    WHERE franchise_id = ${franchiseId} AND day_id = ${day.id};
  `.execute(trx);
  const jazzPayablePayments = Number(payablePaymentsAgg.rows[0]?.total ?? 0);

  // 3.4 Jazz Lifting & DO entries
  const liftingRecord = await trx
    .selectFrom("jazz_load_lifting_records")
    .select(["ml_lifting_amount"])
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", day.id)
    .executeTakeFirst();
  const mlLiftingPurchased = Number(liftingRecord?.ml_lifting_amount ?? 0);

  const doEntries = await trx
    .selectFrom("jazz_load_do_entries")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", day.id)
    .execute();

  // 3.5 Credit Transactions
  const creditTxRows = await sql<{
    party_id: string;
    total_loans: string;
    total_receipts: string;
    total_adjustments: string;
  }>`
    SELECT party_id,
           COALESCE(SUM(loan_amount), 0) as total_loans,
           COALESCE(SUM(receipt_amount), 0) as total_receipts,
           COALESCE(SUM(manual_adjustment), 0) as total_adjustments
    FROM credit_transactions
    WHERE franchise_id = ${franchiseId} AND day_id = ${day.id}
    GROUP BY party_id;
  `.execute(trx);

  // 3.6 Stock Orders & Payments
  const stockOrderLines = await sql<{
    product_id: string;
    direction: "inbound" | "outbound";
    account_id: string | null;
    quantity: number;
    line_amount: string;
  }>`
    SELECT sol.product_id, so.direction, so.account_id, sol.quantity, sol.line_amount
    FROM stock_order_lines sol
    JOIN stock_orders so ON so.id = sol.stock_order_id
    WHERE so.franchise_id = ${franchiseId} AND so.day_id = ${day.id};
  `.execute(trx);

  const stockPayments = await sql<{
    account_id: string;
    total_amount: string;
  }>`
    SELECT account_id, COALESCE(SUM(amount), 0) as total_amount
    FROM stock_account_payments
    WHERE franchise_id = ${franchiseId} AND day_id = ${day.id}
    GROUP BY account_id;
  `.execute(trx);

  // 4. Compute Domain Projections & Invariants
  // 4.1 Financial Projections (Cash, Profit, Owner, Jazz Payable)
  const financial = evaluateFinancialState({
    openingCash,
    totalIssues,
    totalExpenses,
    ownerOpeningBalance,
    ownerNetMovement,
    openingJazzPayable,
    inboundStockAmount,
    jazzPayablePayments
  });
  warnings.push(...validateFinancialInvariants(day.id, day.period_id, financial));

  // 4.2 Credit Party Projections
  const creditPartiesMap = new Map<
    string,
    { loans: number; receipts: number; adjustments: number }
  >();
  for (const r of creditTxRows.rows) {
    creditPartiesMap.set(r.party_id, {
      loans: Number(r.total_loans),
      receipts: Number(r.total_receipts),
      adjustments: Number(r.total_adjustments)
    });
  }

  // Union of all active credit parties, parties with opening balance, and parties with transactions
  const allPartyIds = new Set<string>([
    ...creditPartyOpenings.keys(),
    ...creditPartiesMap.keys()
  ]);

  const activeParties = await trx
    .selectFrom("credit_parties")
    .select(["id"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();
  for (const p of activeParties) {
    allPartyIds.add(p.id);
  }

  const creditPartyProjections: CreditPartyProjectionData[] = [];
  for (const partyId of allPartyIds) {
    const opening = creditPartyOpenings.get(partyId) ?? 0;
    const tx = creditPartiesMap.get(partyId) ?? { loans: 0, receipts: 0, adjustments: 0 };
    const evalResult = evaluateCreditParty({
      partyId,
      openingBalance: opening,
      totalLoans: tx.loans,
      totalReceipts: tx.receipts,
      manualAdjustments: tx.adjustments
    });
    if (evalResult !== null) {
      warnings.push(...validateCreditPartyInvariants(day.id, day.period_id, evalResult));
      creditPartyProjections.push(evalResult);
    }
  }

  // 4.3 Stock Product Projections
  const productMovements = new Map<string, { inQty: number; outQty: number }>();
  for (const sol of stockOrderLines.rows) {
    const m = productMovements.get(sol.product_id) ?? { inQty: 0, outQty: 0 };
    if (sol.direction === "inbound") {
      m.inQty += sol.quantity;
    } else {
      m.outQty += sol.quantity;
    }
    productMovements.set(sol.product_id, m);
  }

  const allProductIds = new Set<string>([
    ...stockProductOpenings.keys(),
    ...productMovements.keys()
  ]);

  const activeProducts = await trx
    .selectFrom("stock_products")
    .select(["id"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();
  for (const p of activeProducts) {
    allProductIds.add(p.id);
  }

  const stockProductProjections: StockProductProjectionData[] = [];
  for (const productId of allProductIds) {
    const opening = stockProductOpenings.get(productId) ?? 0;
    const m = productMovements.get(productId) ?? { inQty: 0, outQty: 0 };
    const evalResult = evaluateStockProduct({
      productId,
      openingQty: opening,
      stockInQty: m.inQty,
      stockOutQty: m.outQty
    });
    warnings.push(...validateStockProductInvariants(day.id, day.period_id, evalResult));
    stockProductProjections.push(evalResult);
  }

  // 4.4 Stock Account Projections
  const accountMovements = new Map<string, { stockTaken: number; paymentReceived: number }>();
  for (const sol of stockOrderLines.rows) {
    if (sol.direction === "outbound" && sol.account_id) {
      const m = accountMovements.get(sol.account_id) ?? { stockTaken: 0, paymentReceived: 0 };
      m.stockTaken += Number(sol.line_amount);
      accountMovements.set(sol.account_id, m);
    }
  }
  for (const p of stockPayments.rows) {
    const m = accountMovements.get(p.account_id) ?? { stockTaken: 0, paymentReceived: 0 };
    m.paymentReceived += Number(p.total_amount);
    accountMovements.set(p.account_id, m);
  }

  const allAccountIds = new Set<string>([
    ...stockAccountOpenings.keys(),
    ...accountMovements.keys()
  ]);

  const activeAccounts = await trx
    .selectFrom("stock_accounts")
    .select(["id"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();
  for (const a of activeAccounts) {
    allAccountIds.add(a.id);
  }

  const stockAccountProjections: StockAccountProjectionData[] = [];
  for (const accountId of allAccountIds) {
    const opening = stockAccountOpenings.get(accountId) ?? 0;
    const m = accountMovements.get(accountId) ?? { stockTaken: 0, paymentReceived: 0 };
    const evalResult = evaluateStockAccount({
      accountId,
      openingDue: opening,
      stockTakenAmount: m.stockTaken,
      paymentReceivedAmount: m.paymentReceived
    });
    warnings.push(...validateStockAccountInvariants(day.id, day.period_id, evalResult));
    stockAccountProjections.push(evalResult);
  }

  // 4.5 Jazz DO Profiles & Lifting Projections
  const doEntriesMap = new Map<
    string,
    { issuanceBase: number; paymentBase: number; appliedRate: number }
  >();
  let totalMlIssuance = 0;

  for (const entry of doEntries) {
    const issBase = Number(entry.issuance_base);
    const payBase = Number(entry.payment_base);
    const rate = Number(entry.applied_ml_rate_percentage);

    totalMlIssuance += issBase * (1 + rate / 100);

    const existing = doEntriesMap.get(entry.do_profile_id) ?? {
      issuanceBase: 0,
      paymentBase: 0,
      appliedRate: rate
    };
    existing.issuanceBase += issBase;
    existing.paymentBase += payBase;
    existing.appliedRate = rate;
    doEntriesMap.set(entry.do_profile_id, existing);
  }

  const allDoProfileIds = new Set<string>([
    ...jazzDoOpenings.keys(),
    ...doEntriesMap.keys()
  ]);

  const activeDoProfiles = await trx
    .selectFrom("jazz_load_do_profiles")
    .select(["id"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();
  for (const dp of activeDoProfiles) {
    allDoProfileIds.add(dp.id);
  }

  // Get active rates for DO profiles without entries today
  const activeRateRecord = await trx
    .selectFrom("jazz_load_rates")
    .select(["ml_rate"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .orderBy("effective_from", "desc")
    .executeTakeFirst();
  const defaultRate = Number(activeRateRecord?.ml_rate ?? 0);

  const jazzDoProjections: JazzDoProjectionData[] = [];
  for (const doProfileId of allDoProfileIds) {
    const opening = jazzDoOpenings.get(doProfileId) ?? 0;
    const m = doEntriesMap.get(doProfileId) ?? {
      issuanceBase: 0,
      paymentBase: 0,
      appliedRate: defaultRate
    };
    const evalResult = evaluateJazzDo({
      doProfileId,
      openingBase: opening,
      issuanceBase: m.issuanceBase,
      paymentBase: m.paymentBase,
      appliedMlRatePercentage: m.appliedRate
    });
    warnings.push(...validateJazzDoInvariants(day.id, day.period_id, evalResult));
    jazzDoProjections.push(evalResult);
  }

  // Jazz Lifting Projection
  const jazzLifting = evaluateJazzLifting({
    openingLifting: openingJazzLifting,
    mlLiftingPurchased,
    todayMlIssuance: totalMlIssuance
  });
  warnings.push(...validateJazzLiftingInvariants(day.id, day.period_id, jazzLifting));

  // 5. Atomic Materialization / Persistence
  // 5.1 Day Financial Projection
  await sql`
    INSERT INTO day_financial_projections (
        franchise_id,
        day_id,
        opening_cash,
        total_issues,
        total_expenses,
        closing_cash,
        operating_profit,
        owner_opening_balance,
        owner_closing_balance,
        opening_jazz_payable,
        closing_jazz_payable,
        calc_run_id,
        calculated_at
    ) VALUES (
        ${franchiseId},
        ${day.id},
        ${financial.openingCash},
        ${financial.totalIssues},
        ${financial.totalExpenses},
        ${financial.closingCash},
        ${financial.operatingProfit},
        ${financial.ownerOpeningBalance},
        ${financial.ownerClosingBalance},
        ${financial.openingJazzPayable},
        ${financial.closingJazzPayable},
        ${calcRunId},
        clock_timestamp()
    )
    ON CONFLICT (franchise_id, day_id) DO UPDATE SET
        opening_cash = EXCLUDED.opening_cash,
        total_issues = EXCLUDED.total_issues,
        total_expenses = EXCLUDED.total_expenses,
        closing_cash = EXCLUDED.closing_cash,
        operating_profit = EXCLUDED.operating_profit,
        owner_opening_balance = EXCLUDED.owner_opening_balance,
        owner_closing_balance = EXCLUDED.owner_closing_balance,
        opening_jazz_payable = EXCLUDED.opening_jazz_payable,
        closing_jazz_payable = EXCLUDED.closing_jazz_payable,
        calc_run_id = EXCLUDED.calc_run_id,
        calculated_at = clock_timestamp();
  `.execute(trx);

  // 5.2 Credit Party Projections
  // First, remove any party projection for this day that is no longer active / pruned
  if (creditPartyProjections.length > 0) {
    const includedPartyIds = creditPartyProjections.map((p) => p.partyId);
    await trx
      .deleteFrom("credit_party_day_projections")
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", day.id)
      .where("party_id", "not in", includedPartyIds)
      .execute();

    for (const cp of creditPartyProjections) {
      await sql`
        INSERT INTO credit_party_day_projections (
            franchise_id, day_id, party_id, opening_balance,
            total_loans, total_receipts, manual_adjustments, closing_balance, calculated_at
        ) VALUES (
            ${franchiseId}, ${day.id}, ${cp.partyId}, ${cp.openingBalance},
            ${cp.totalLoans}, ${cp.totalReceipts}, ${cp.manualAdjustments}, ${cp.closingBalance}, clock_timestamp()
        )
        ON CONFLICT (franchise_id, day_id, party_id) DO UPDATE SET
            opening_balance = EXCLUDED.opening_balance,
            total_loans = EXCLUDED.total_loans,
            total_receipts = EXCLUDED.total_receipts,
            manual_adjustments = EXCLUDED.manual_adjustments,
            closing_balance = EXCLUDED.closing_balance,
            calculated_at = clock_timestamp();
      `.execute(trx);
    }
  } else {
    await trx
      .deleteFrom("credit_party_day_projections")
      .where("franchise_id", "=", franchiseId)
      .where("day_id", "=", day.id)
      .execute();
  }

  // 5.3 Stock Product Projections
  for (const sp of stockProductProjections) {
    await sql`
      INSERT INTO stock_product_day_projections (
          franchise_id, day_id, product_id, opening_qty,
          stock_in_qty, stock_out_qty, closing_qty, calculated_at
      ) VALUES (
          ${franchiseId}, ${day.id}, ${sp.productId}, ${sp.openingQty},
          ${sp.stockInQty}, ${sp.stockOutQty}, ${sp.closingQty}, clock_timestamp()
      )
      ON CONFLICT (franchise_id, day_id, product_id) DO UPDATE SET
          opening_qty = EXCLUDED.opening_qty,
          stock_in_qty = EXCLUDED.stock_in_qty,
          stock_out_qty = EXCLUDED.stock_out_qty,
          closing_qty = EXCLUDED.closing_qty,
          calculated_at = clock_timestamp();
    `.execute(trx);
  }

  // 5.4 Stock Account Projections
  for (const sa of stockAccountProjections) {
    await sql`
      INSERT INTO stock_account_day_projections (
          franchise_id, day_id, account_id, opening_due,
          stock_taken_amount, payment_received_amount, closing_due, calculated_at
      ) VALUES (
          ${franchiseId}, ${day.id}, ${sa.accountId}, ${sa.openingDue},
          ${sa.stockTakenAmount}, ${sa.paymentReceivedAmount}, ${sa.closingDue}, clock_timestamp()
      )
      ON CONFLICT (franchise_id, day_id, account_id) DO UPDATE SET
          opening_due = EXCLUDED.opening_due,
          stock_taken_amount = EXCLUDED.stock_taken_amount,
          payment_received_amount = EXCLUDED.payment_received_amount,
          closing_due = EXCLUDED.closing_due,
          calculated_at = clock_timestamp();
    `.execute(trx);
  }

  // 5.5 Jazz Lifting Projections
  await sql`
    INSERT INTO jazz_lifting_day_projections (
        franchise_id, day_id, opening_lifting, ml_lifting_purchased,
        today_ml_issuance, closing_lifting_in_hand, calculated_at
    ) VALUES (
        ${franchiseId}, ${day.id}, ${jazzLifting.openingLifting}, ${jazzLifting.mlLiftingPurchased},
        ${jazzLifting.todayMlIssuance}, ${jazzLifting.closingLiftingInHand}, clock_timestamp()
    )
    ON CONFLICT (franchise_id, day_id) DO UPDATE SET
        opening_lifting = EXCLUDED.opening_lifting,
        ml_lifting_purchased = EXCLUDED.ml_lifting_purchased,
        today_ml_issuance = EXCLUDED.today_ml_issuance,
        closing_lifting_in_hand = EXCLUDED.closing_lifting_in_hand,
        calculated_at = clock_timestamp();
  `.execute(trx);

  // 5.6 Jazz DO Profile Projections
  for (const jd of jazzDoProjections) {
    await sql`
      INSERT INTO jazz_load_do_day_projections (
          franchise_id, day_id, do_profile_id, opening_base,
          issuance_base, payment_base, closing_base, opening_ml, closing_ml,
          applied_ml_rate_percentage, calculated_at
      ) VALUES (
          ${franchiseId}, ${day.id}, ${jd.doProfileId}, ${jd.openingBase},
          ${jd.issuanceBase}, ${jd.paymentBase}, ${jd.closingBase}, ${jd.openingMl}, ${jd.closingMl},
          ${jd.appliedMlRatePercentage}, clock_timestamp()
      )
      ON CONFLICT (franchise_id, day_id, do_profile_id) DO UPDATE SET
          opening_base = EXCLUDED.opening_base,
          issuance_base = EXCLUDED.issuance_base,
          payment_base = EXCLUDED.payment_base,
          closing_base = EXCLUDED.closing_base,
          opening_ml = EXCLUDED.opening_ml,
          closing_ml = EXCLUDED.closing_ml,
          applied_ml_rate_percentage = EXCLUDED.applied_ml_rate_percentage,
          calculated_at = clock_timestamp();
    `.execute(trx);
  }

  // 6. Record Invariant Warnings
  for (const w of warnings) {
    await trx
      .insertInto("invariant_violations")
      .values({
        franchise_id: franchiseId,
        period_id: day.period_id,
        day_id: day.id,
        invariant_code: w.invariantCode,
        severity: w.severity,
        message: w.message,
        details: w.details ?? null
      })
      .execute();
  }

  return {
    dayId: day.id,
    dayNo: day.day_no,
    periodId: day.period_id,
    financial,
    creditParties: creditPartyProjections,
    stockProducts: stockProductProjections,
    stockAccounts: stockAccountProjections,
    jazzLifting,
    jazzDo: jazzDoProjections,
    violations: warnings
  };
}

/**
 * Recalculates from a specific day forward to the end of the accounting period.
 * Locks all affected days in strict ascending order (ORDER BY day_no ASC) to prevent deadlocks.
 */
export async function recalculateFromDayInternal(
  trx: Transaction<Database>,
  franchiseId: string,
  startDayId: string,
  options: CalculationRunOptions = { triggerSource: "mutation" }
): Promise<CalculationRunResult> {
  const startTime = Date.now();

  // 1. Resolve start day to get period_id and day_no
  const startDay = await trx
    .selectFrom("accounting_days")
    .select(["id", "period_id", "day_no", "status"])
    .where("id", "=", startDayId)
    .where("franchise_id", "=", franchiseId)
    .executeTakeFirst();

  if (!startDay) {
    throw new InvariantViolationError(
      "INV_TENANT_ISOLATION",
      `Start accounting day ${startDayId} not found or does not belong to franchise ${franchiseId}`
    );
  }

  if (startDay.status === "closed" && !options.allowClosedDays) {
    throw new InvariantViolationError(
      "INV_CLOSED_DAY_MUTATION",
      `Cannot recalculate from CLOSED accounting day ${startDay.day_no}`
    );
  }

  // 2. Lock all days from startDay.day_no to period end in ascending order
  const lockedDaysResult = await sql<DayRow>`
    SELECT id, franchise_id, period_id, day_no, status, calendar_date
    FROM accounting_days
    WHERE franchise_id = ${franchiseId}
      AND period_id = ${startDay.period_id}
      AND day_no >= ${startDay.day_no}
    ORDER BY day_no ASC
    FOR UPDATE;
  `.execute(trx);

  const daysToCalculate = lockedDaysResult.rows;
  if (daysToCalculate.length === 0) {
    throw new InvariantViolationError(
      "INV_TENANT_ISOLATION",
      `No accounting days found for period ${startDay.period_id} starting at day ${startDay.day_no}`
    );
  }

  const fromDayNo = daysToCalculate[0].day_no;
  const toDayNo = daysToCalculate[daysToCalculate.length - 1].day_no;

  // 3. Create calculation_runs record (status: 'started')
  const runRecord = await trx
    .insertInto("calculation_runs")
    .values({
      franchise_id: franchiseId,
      period_id: startDay.period_id,
      trigger_source: options.triggerSource,
      from_day_no: fromDayNo,
      to_day_no: toDayNo,
      status: "started",
      executed_by_user_id: options.userId ?? null
    })
    .returning(["id"])
    .executeTakeFirstOrThrow();

  const allViolations: InvariantViolationItem[] = [];

  try {
    // 4. Cascade sequentially through each day
    for (const d of daysToCalculate) {
      const res = await calculateDayInternal(
        trx,
        franchiseId,
        d.id,
        runRecord.id,
        { ...options, allowClosedDays: true }
      );
      allViolations.push(...res.violations);
    }

    // 5. Update calculation_runs to completed
    const durationMs = Date.now() - startTime;
    await trx
      .updateTable("calculation_runs")
      .set({
        status: "completed",
        duration_ms: durationMs.toString()
      })
      .where("id", "=", runRecord.id)
      .execute();

    return {
      calcRunId: runRecord.id,
      periodId: startDay.period_id,
      fromDayNo,
      toDayNo,
      daysCalculated: daysToCalculate.length,
      durationMs,
      violationsCount: allViolations.length,
      violations: allViolations
    };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    await trx
      .updateTable("calculation_runs")
      .set({
        status: "failed",
        duration_ms: durationMs.toString(),
        error_message: errorMessage
      })
      .where("id", "=", runRecord.id)
      .execute();
    throw error;
  }
}

/**
 * Rebuilds all days of an entire accounting period from Day 1.
 */
export async function rebuildPeriodInternal(
  trx: Transaction<Database>,
  franchiseId: string,
  periodId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<CalculationRunResult> {
  // Find Day 1 for this period
  const day1 = await trx
    .selectFrom("accounting_days")
    .select(["id", "day_no"])
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .where("day_no", "=", 1)
    .executeTakeFirst();

  if (!day1) {
    throw new InvariantViolationError(
      "INV_DAY_OPENING_CHAIN",
      `Cannot rebuild period ${periodId}: Day 1 does not exist.`
    );
  }

  return recalculateFromDayInternal(trx, franchiseId, day1.id, options);
}
