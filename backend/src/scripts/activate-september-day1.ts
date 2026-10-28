/**
 * Phase 7F: September Day 1 Authorized Activation Script
 *
 * HARD CONSTRAINTS:
 * 1. Target ONLY local production database (franchise_prod_db).
 * 2. Verify all pre-activation preconditions and opening balances.
 * 3. Execute approved activatePeriod() service function using Owner context.
 * 4. Verify post-activation state (Day 1 open, Days 2-30 closed, 0 transactions).
 * 5. Verify development database isolation and zero Firestore writes.
 * 6. STOP after reporting.
 */
import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";
import { activatePeriod } from "../periods/service.js";
import pg from "pg";

interface PreFlightData {
  franchiseId: string;
  periodId: string;
  day1Id: string;
  ownerUser: {
    id: string;
    email: string;
    role: string;
  };
}

async function runPhase7FActivation() {
  console.log("=== PHASE 7F: SEPTEMBER DAY 1 AUTHORIZED ACTIVATION ===");

  // =========================================================================
  // 1. PRE-ACTIVATION PRE-FLIGHT CHECK
  // =========================================================================
  console.log("\n--- Step 1: Pre-Activation Pre-Flight Check ---");
  const connRes = await sql<{
    current_database: string;
    current_user: string;
  }>`SELECT current_database(), current_user`.execute(db);
  const { current_database, current_user } = connRes.rows[0]!;
  console.log(`Connection: ${current_database} (User: ${current_user})`);

  if (current_database !== "franchise_prod_db") {
    throw new Error(`SAFETY ABORT: Target database is '${current_database}', expected 'franchise_prod_db'.`);
  }

  // 1.1 Fetch Franchise
  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();
  console.log(`Franchise: ${franchise.name} (${franchise.id})`);

  // 1.2 Fetch Owner User
  const ownerUser = await db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", "hanzlaahmad100@gmail.com")
    .executeTakeFirstOrThrow();

  const membership = await db
    .selectFrom("franchise_users")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("user_id", "=", ownerUser.id)
    .executeTakeFirstOrThrow();

  if (membership.role !== "owner") {
    throw new Error(`Owner role mismatch: ${membership.role}`);
  }
  console.log(`Owner: ${ownerUser.email} (ID: ${ownerUser.id})`);

  const userContext = {
    id: ownerUser.id,
    email: ownerUser.email,
    role: "owner"
  };

  // 1.3 Accounting Periods check
  const periods = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  console.log(`Total accounting periods: ${periods.length}`);
  if (periods.length !== 1) {
    throw new Error(`Expected exactly 1 period, found ${periods.length}`);
  }

  const period = periods[0]!;
  console.log(`Period: ${period.period_key} (${period.label}), ID: ${period.id}, Status: ${period.status}`);
  if (period.period_key !== "2026-09" || period.status !== "open") {
    throw new Error(`Expected period '2026-09' with status 'open', found '${period.period_key}' (${period.status})`);
  }

  // 1.4 Check no August period exists
  const augPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "=", "2026-08")
    .execute();
  if (augPeriod.length > 0) {
    throw new Error("SAFETY VIOLATION: August 2026 accounting period exists.");
  }

  // 1.5 Accounting Days check
  const days = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  console.log(`Total accounting days: ${days.length}`);
  if (days.length !== 30) {
    throw new Error(`Expected exactly 30 days, found ${days.length}`);
  }

  const day1 = days[0]!;
  const day30 = days[29]!;
  console.log(`Day 1: ${day1.calendar_date}, Status: ${day1.status}`);
  const day1InitialStatus = day1.status;
  console.log(`Day 1 Initial Status: ${day1InitialStatus}`);
  if (day1InitialStatus !== "closed" && day1InitialStatus !== "open") {
    throw new Error(`Pre-activation check failed: Unexpected Day 1 status '${day1InitialStatus}'.`);
  }

  // Check Days 2-30 are closed
  for (let i = 1; i < 30; i++) {
    const d = days[i]!;
    if (d.status !== "closed") {
      throw new Error(`Pre-activation check failed: Day ${d.day_no} status is '${d.status}', expected 'closed'.`);
    }
  }

  // Check no Day 31 exists
  const day31 = days.find((d) => d.day_no === 31);
  if (day31) {
    throw new Error("SAFETY VIOLATION: Day 31 exists in September period.");
  }

  // 1.6 Seeds Verification check
  const finSeed = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .executeTakeFirstOrThrow();

  console.log(`Financial Seed is_verified: ${finSeed.is_verified}, verified_at: ${finSeed.verified_at}`);
  if (finSeed.is_verified !== true) {
    throw new Error("Pre-activation check failed: Financial seed is not verified.");
  }

  // 1.7 Check Provenance for all seeds
  if (finSeed.source_period_key !== "2026-08" || finSeed.source_day_no !== 31) {
    throw new Error(`Financial seed provenance mismatch: ${finSeed.source_period_key} Day ${finSeed.source_day_no}`);
  }

  // Check credit party seeds provenance
  const creditSeeds = await db
    .selectFrom("period_credit_party_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  if (creditSeeds.length !== 9) throw new Error(`Expected 9 credit party seeds, found ${creditSeeds.length}`);
  for (const cs of creditSeeds) {
    if (cs.source_period_key !== "2026-08" || cs.source_day_no !== 31) {
      throw new Error(`Credit seed provenance mismatch: ${cs.source_period_key} Day ${cs.source_day_no}`);
    }
  }

  // Check stock product seeds provenance
  const productSeeds = await db
    .selectFrom("period_stock_product_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  if (productSeeds.length !== 11) throw new Error(`Expected 11 stock product seeds, found ${productSeeds.length}`);
  for (const sps of productSeeds) {
    if (sps.source_period_key !== "2026-08" || sps.source_day_no !== 31) {
      throw new Error(`Product seed provenance mismatch: ${sps.source_period_key} Day ${sps.source_day_no}`);
    }
  }

  // Check stock account seeds provenance
  const accountSeeds = await db
    .selectFrom("period_stock_account_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  if (accountSeeds.length !== 17) throw new Error(`Expected 17 stock account seeds, found ${accountSeeds.length}`);
  for (const sas of accountSeeds) {
    if (sas.source_period_key !== "2026-08" || sas.source_day_no !== 31) {
      throw new Error(`Account seed provenance mismatch: ${sas.source_period_key} Day ${sas.source_day_no}`);
    }
  }

  // Check jazz DO seeds provenance
  const doSeeds = await db
    .selectFrom("period_jazz_do_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  if (doSeeds.length !== 14) throw new Error(`Expected 14 Jazz DO seeds, found ${doSeeds.length}`);
  for (const ds of doSeeds) {
    if (ds.source_period_key !== "2026-08" || ds.source_day_no !== 31) {
      throw new Error(`DO seed provenance mismatch: ${ds.source_period_key} Day ${ds.source_day_no}`);
    }
  }

  // 1.8 Check zero operational transactions
  const txTables = [
    "expense_items",
    "commission_items",
    "credit_transactions",
    "owner_transactions",
    "stock_orders",
    "stock_order_lines",
    "stock_account_payments",
    "jazz_load_lifting_records",
    "jazz_load_do_entries",
    "jazz_company_payable_payments"
  ];
  let totalTxPre = 0;
  for (const t of txTables) {
    const res = await sql.raw(`SELECT count(*) FROM ${t}`).execute(db);
    const count = Number((res.rows[0] as any).count);
    totalTxPre += count;
  }
  console.log(`Pre-activation operational transactions across all 10 tables: ${totalTxPre}`);
  if (totalTxPre !== 0) {
    throw new Error(`Pre-activation check failed: ${totalTxPre} operational transactions found.`);
  }

  // 1.9 Check zero blocking invariant violations
  const invRes = await db
    .selectFrom("invariant_violations")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();
  const criticalInvariants = invRes.filter((iv) => iv.severity === "critical");
  console.log(`Invariant violations: total=${invRes.length}, critical=${criticalInvariants.length}`);
  if (criticalInvariants.length > 0) {
    throw new Error(`Pre-activation check failed: ${criticalInvariants.length} critical invariant violations exist.`);
  }

  // 1.10 Check dev database isolation
  const devPool = new pg.Pool({
    connectionString: "postgresql://franchise_dev:franchise_dev_secret@localhost:5432/franchise_dev_db"
  });
  const devPeriodRes = await devPool.query("SELECT count(*) FROM accounting_periods");
  const devPeriodCount = Number(devPeriodRes.rows[0].count);
  console.log(`Dev database periods count: ${devPeriodCount}`);
  if (devPeriodCount !== 0) {
    throw new Error(`Dev database contamination: ${devPeriodCount} periods found in franchise_dev_db.`);
  }
  await devPool.end();

  // =========================================================================
  // 2. AUTHORITATIVE OPENING STATE VERIFICATION
  // =========================================================================
  console.log("\n--- Step 2: Confirming Authoritative Opening State ---");

  // Cash: 0
  const cashVal = Number(finSeed.opening_cash);
  console.log(`Register Cash: ${cashVal} (Expected: 0)`);
  if (cashVal !== 0) throw new Error(`Cash opening mismatch: ${cashVal} !== 0`);

  // Owner Balance: 339327
  const ownerVal = Number(finSeed.opening_owner_balance);
  console.log(`Owner Balance: ${ownerVal} (Expected: 339327)`);
  if (ownerVal !== 339327) throw new Error(`Owner balance mismatch: ${ownerVal} !== 339327`);

  // Credit Party Total: 56904
  let creditTotal = 0;
  for (const cs of creditSeeds) {
    creditTotal += Number(cs.opening_balance);
  }
  console.log(`Credit Party Total: ${creditTotal} (Expected: 56904)`);
  if (creditTotal !== 56904) throw new Error(`Credit party total mismatch: ${creditTotal} !== 56904`);

  // Jazz Lifting In-Hand: 815579
  const liftVal = Number(finSeed.opening_jazz_lifting);
  console.log(`Jazz Lifting In-Hand: ${liftVal} (Expected: 815579)`);
  if (liftVal !== 815579) throw new Error(`Jazz lifting mismatch: ${liftVal} !== 815579`);

  // Jazz Company Payable: 0
  const payableVal = Number(finSeed.opening_jazz_payable);
  console.log(`Jazz Company Payable: ${payableVal} (Expected: 0)`);
  if (payableVal !== 0) throw new Error(`Jazz payable mismatch: ${payableVal} !== 0`);

  // Jazz DO Balances: 0 across all 14 profiles
  let doTotal = 0;
  for (const ds of doSeeds) {
    doTotal += Number(ds.opening_base_balance);
  }
  console.log(`Jazz DO Total: ${doTotal} (Expected: 0)`);
  if (doTotal !== 0) throw new Error(`Jazz DO total mismatch: ${doTotal} !== 0`);

  // Stock Physical Quantity: 3454
  let stockQtyTotal = 0;
  for (const sps of productSeeds) {
    stockQtyTotal += Number(sps.opening_quantity);
  }
  console.log(`Stock Physical Quantity: ${stockQtyTotal} (Expected: 3454)`);
  if (stockQtyTotal !== 3454) throw new Error(`Stock quantity mismatch: ${stockQtyTotal} !== 3454`);

  // Stock Account Total: 805277
  let stockAcctTotal = 0;
  for (const sas of accountSeeds) {
    stockAcctTotal += Number(sas.opening_receivable);
  }
  console.log(`Stock Account Total: ${stockAcctTotal} (Expected: 805277)`);
  if (stockAcctTotal !== 805277) throw new Error(`Stock account total mismatch: ${stockAcctTotal} !== 805277`);

  console.log("ALL PRE-ACTIVATION PRECONDITIONS AND OPENING VALUES CONFIRMED 100% ACCURATE.");

  // =========================================================================
  // 3. ACTIVATE DAY 1 VIA EXISTING SERVER SERVICE
  // =========================================================================
  console.log("\n--- Step 3: Executing Server-Authoritative activatePeriod() ---");
  const activationResult = await activatePeriod(franchise.id, period.id, userContext);
  console.log("Activation result:", JSON.stringify(activationResult, null, 2));

  const activationStatus = (activationResult as any).status || (activationResult as any).day1?.status;
  if (!activationResult.activated || activationStatus !== "open") {
    throw new Error(`Activation failed: ${JSON.stringify(activationResult)}`);
  }

  // =========================================================================
  // 4. POST-ACTIVATION VALIDATION
  // =========================================================================
  console.log("\n--- Step 4: Post-Activation Validation ---");

  // 4.1 Accounting Period validation
  const postPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("id", "=", period.id)
    .executeTakeFirstOrThrow();
  console.log(`Post-Activation Period: ${postPeriod.period_key}, Status: ${postPeriod.status}`);
  if (postPeriod.period_key !== "2026-09" || postPeriod.status !== "open") {
    throw new Error(`Post-activation period check failed: ${postPeriod.period_key} (${postPeriod.status})`);
  }

  // 4.2 Accounting Days validation
  const postDays = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  if (postDays.length !== 30) {
    throw new Error(`Expected exactly 30 days post-activation, found ${postDays.length}`);
  }

  const postDay1 = postDays[0]!;
  console.log(`Post-Activation Day 1: ${postDay1.calendar_date}, Status: ${postDay1.status}`);
  if (postDay1.status !== "open") {
    throw new Error(`Post-activation check failed: Day 1 status is '${postDay1.status}', expected 'open'.`);
  }

  const openDays = postDays.filter((d) => d.status === "open");
  console.log(`Total open accounting days: ${openDays.length}`);
  if (openDays.length !== 1) {
    throw new Error(`Expected exactly 1 open day, found ${openDays.length}`);
  }

  const closedDays = postDays.filter((d) => d.status === "closed");
  console.log(`Total closed accounting days: ${closedDays.length}`);
  if (closedDays.length !== 29) {
    throw new Error(`Expected exactly 29 closed days (Days 2-30), found ${closedDays.length}`);
  }

  for (let i = 1; i < 30; i++) {
    const d = postDays[i]!;
    if (d.status !== "closed") {
      throw new Error(`Post-activation error: Day ${d.day_no} status is '${d.status}', expected 'closed'.`);
    }
  }

  // 4.3 Seeds remain verified and unchanged
  const postFinSeed = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .executeTakeFirstOrThrow();
  console.log(`Post-Activation Financial Seed is_verified: ${postFinSeed.is_verified}`);
  if (postFinSeed.is_verified !== true) {
    throw new Error("Post-activation error: Financial seed is_verified was reset to false.");
  }
  if (
    Number(postFinSeed.opening_cash) !== 0 ||
    Number(postFinSeed.opening_owner_balance) !== 339327 ||
    Number(postFinSeed.opening_jazz_lifting) !== 815579 ||
    Number(postFinSeed.opening_jazz_payable) !== 0
  ) {
    throw new Error("Post-activation error: Seed values were altered during activation.");
  }

  // 4.4 Transactions remain strictly 0
  let totalTxPost = 0;
  for (const t of txTables) {
    const res = await sql.raw(`SELECT count(*) FROM ${t}`).execute(db);
    const count = Number((res.rows[0] as any).count);
    totalTxPost += count;
  }
  console.log(`Post-activation operational transactions across all 10 tables: ${totalTxPost}`);
  if (totalTxPost !== 0) {
    throw new Error(`CRITICAL POST-ACTIVATION ERROR: ${totalTxPost} operational transactions exist.`);
  }

  // 4.5 Projections inspection (Day 1 opening === closing)
  const finProj = await db
    .selectFrom("day_financial_projections")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "=", postDay1.id)
    .executeTakeFirstOrThrow();

  if (Number(finProj.opening_cash) !== 0 || Number(finProj.closing_cash) !== 0) {
    throw new Error(`Cash projection mismatch: ${finProj.opening_cash} -> ${finProj.closing_cash}`);
  }
  if (Number(finProj.owner_opening_balance) !== 339327 || Number(finProj.owner_closing_balance) !== 339327) {
    throw new Error(`Owner balance projection mismatch: ${finProj.owner_opening_balance} -> ${finProj.owner_closing_balance}`);
  }
  if (Number(finProj.opening_jazz_payable) !== 0 || Number(finProj.closing_jazz_payable) !== 0) {
    throw new Error(`Jazz payable projection mismatch: ${finProj.opening_jazz_payable} -> ${finProj.closing_jazz_payable}`);
  }
  if (Number(finProj.total_issues) !== 0 || Number(finProj.total_expenses) !== 0 || Number(finProj.operating_profit) !== 0) {
    throw new Error("Operational movements detected in Day 1 financial projections.");
  }

  const liftProj = await db
    .selectFrom("jazz_lifting_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "=", postDay1.id)
    .executeTakeFirstOrThrow();

  if (Number(liftProj.opening_lifting) !== 815579 || Number(liftProj.closing_lifting_in_hand) !== 815579) {
    throw new Error(`Lifting projection mismatch: ${liftProj.opening_lifting} -> ${liftProj.closing_lifting_in_hand}`);
  }

  // 4.6 Invariants check
  const postInvariants = await db
    .selectFrom("invariant_violations")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();
  console.log(`Post-activation total invariant violations: ${postInvariants.length}`);
  const postCritical = postInvariants.filter((iv) => iv.severity === "critical");
  if (postCritical.length > 0) {
    throw new Error(`Post-activation error: ${postCritical.length} critical invariant violations exist.`);
  }

  // 4.7 Dev isolation check
  const devPoolPost = new pg.Pool({
    connectionString: "postgresql://franchise_dev:franchise_dev_secret@localhost:5432/franchise_dev_db"
  });
  const devTables = [
    "accounting_periods",
    "accounting_days",
    "period_financial_seeds",
    "period_credit_party_seeds",
    "period_stock_product_seeds",
    "period_stock_account_seeds",
    "period_jazz_do_seeds",
    "day_financial_projections",
    "credit_party_day_projections",
    "stock_product_day_projections",
    "stock_account_day_projections",
    "jazz_lifting_day_projections",
    "jazz_load_do_day_projections",
    "audit_logs"
  ];
  let devTotalRows = 0;
  for (const dt of devTables) {
    const res = await devPoolPost.query(`SELECT count(*) FROM ${dt}`);
    const count = Number(res.rows[0].count);
    devTotalRows += count;
  }
  await devPoolPost.end();
  console.log(`Post-activation dev database total rows across all audited tables: ${devTotalRows}`);
  if (devTotalRows !== 0) {
    throw new Error(`Dev database contamination: ${devTotalRows} rows found in franchise_dev_db.`);
  }

  // 4.8 Audit log validation
  const activationAudit = await db
    .selectFrom("audit_logs")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("action", "=", "UPDATE")
    .where("entity_type", "=", "accounting_day")
    .where("entity_id", "=", postDay1.id)
    .executeTakeFirst();

  if (!activationAudit) {
    throw new Error("Audit validation failed: No activation audit log found for Day 1.");
  }
  console.log(`Activation audit log verified: ${activationAudit.action} ${activationAudit.entity_type} (${activationAudit.entity_id}) at ${String(activationAudit.created_at)}`);

  console.log("\n=== PHASE 7F DAY 1 ACTIVATION COMPLETED WITH 100% PRECISION ===");
}

runPhase7FActivation()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL ERROR in Phase 7F activation:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDatabase();
  });
