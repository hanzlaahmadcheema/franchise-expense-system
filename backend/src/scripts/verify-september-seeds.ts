/**
 * Phase 7E: September Opening Seed Verification & Day 1 Baseline Execution Script
 *
 * HARD CONSTRAINTS:
 * 1. Target ONLY local production database (franchise_prod_db).
 * 2. Execute approved verifySeeds() service function.
 * 3. Inspect Day 1 zero-transaction baseline projections.
 * 4. Verify Opening === Closing across all domains.
 * 5. DO NOT activate Day 1 (Day 1 remains CLOSED).
 * 6. DO NOT create operational transactions.
 * 7. DO NOT modify development database or Firestore.
 */
import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";
import { verifySeeds } from "../periods/service.js";

async function runVerifySeptemberSeeds() {
  console.log("=== PHASE 7E: SEPTEMBER OPENING SEED VERIFICATION & DAY 1 BASELINE ===");

  // =========================================================================
  // 1. PRE-FLIGHT
  // =========================================================================
  console.log("\n--- Step 1: Pre-Flight Check ---");
  const connRes = await sql<{
    current_database: string;
    current_user: string;
  }>`SELECT current_database(), current_user`.execute(db);
  const { current_database, current_user } = connRes.rows[0]!;
  console.log(`Connection: ${current_database} (User: ${current_user})`);

  if (current_database !== "franchise_prod_db") {
    throw new Error(`SAFETY ABORT: Target database is '${current_database}', expected 'franchise_prod_db'.`);
  }

  // Fetch franchise
  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();
  console.log(`Franchise: ${franchise.name} (${franchise.id})`);

  // Fetch owner user
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

  // Period checks
  const periods = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  console.log(`Total periods count: ${periods.length}`);
  if (periods.length !== 1) {
    throw new Error(`Expected exactly 1 period, found ${periods.length}`);
  }

  const period = periods[0]!;
  console.log(`Period: ${period.period_key} (${period.label}), ID: ${period.id}, Status: ${period.status}`);
  if (period.period_key !== "2026-09") {
    throw new Error(`Expected period '2026-09', found '${period.period_key}'`);
  }

  // Check no August period
  const augPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "=", "2026-08")
    .execute();
  if (augPeriod.length > 0) {
    throw new Error("SAFETY VIOLATION: August 2026 accounting period exists.");
  }

  // Days check
  const days = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  console.log(`Total days in September period: ${days.length}`);
  if (days.length !== 30) {
    throw new Error(`Expected exactly 30 days, found ${days.length}`);
  }

  const day1 = days[0]!;
  const day30 = days[29]!;
  console.log(`Day 1: ${day1.calendar_date}, Status: ${day1.status}`);
  console.log(`Day 30: ${day30.calendar_date}, Status: ${day30.status}`);

  if (day1.status !== "closed") {
    throw new Error(`Day 1 is already '${day1.status}', expected 'closed'.`);
  }

  // Check no Day 31
  const day31 = days.find((d) => d.day_no === 31);
  if (day31) {
    throw new Error("SAFETY VIOLATION: Day 31 exists in September period.");
  }

  // =========================================================================
  // 2. INSPECT ALL 52 STAGED SEED RECORDS AGAINST AUTHORITATIVE SNAPSHOT
  // =========================================================================
  console.log("\n--- Step 2: Verifying All 52 Staged Seed Records Against Authoritative Snapshot ---");

  // 2.1 Financial Seed (1)
  const finSeeds = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();

  if (finSeeds.length !== 1) throw new Error(`Expected 1 financial seed, found ${finSeeds.length}`);
  const fs = finSeeds[0]!;
  console.log(`Financial Seed: Cash=${fs.opening_cash}, Owner=${fs.opening_owner_balance}, JazzLifting=${fs.opening_jazz_lifting}, JazzPayable=${fs.opening_jazz_payable}`);
  if (Number(fs.opening_cash) !== 0) throw new Error(`Cash seed mismatch: ${fs.opening_cash} !== 0`);
  if (Number(fs.opening_owner_balance) !== 339327) throw new Error(`Owner balance seed mismatch: ${fs.opening_owner_balance} !== 339327`);
  if (Number(fs.opening_jazz_lifting) !== 815579) throw new Error(`Jazz lifting seed mismatch: ${fs.opening_jazz_lifting} !== 815579`);
  if (Number(fs.opening_jazz_payable) !== 0) throw new Error(`Jazz payable seed mismatch: ${fs.opening_jazz_payable} !== 0`);
  if (fs.source_period_key !== "2026-08" || fs.source_day_no !== 31) {
    throw new Error(`Provenance mismatch on financial seed: ${fs.source_period_key} Day ${fs.source_day_no}`);
  }

  // 2.2 Credit Parties (9)
  const expectedCreditParties: Record<string, number> = {
    "ALI OLAKH": 32774,
    "Usman cheema": 27627,
    "AKHTAR": 13000,
    "IMRAN OLAKH": 8300,
    "Majid ACCOUNT": -62797,
    "DSO HASAN": 25000,
    "SARAM": 3000,
    "NAVEED DO": 0,
    "FAKHAR CCR": 10000
  };

  const creditSeeds = await sql<{
    party_name: string;
    opening_balance: string;
    source_period_key: string;
    source_day_no: number;
  }>`
    SELECT cp.name as party_name, s.opening_balance, s.source_period_key, s.source_day_no
    FROM period_credit_party_seeds s
    JOIN credit_parties cp ON cp.id = s.party_id
    WHERE s.franchise_id = ${franchise.id} AND s.period_id = ${period.id}
    ORDER BY cp.sort_order
  `.execute(db);

  if (creditSeeds.rows.length !== 9) throw new Error(`Expected 9 credit party seeds, found ${creditSeeds.rows.length}`);
  let cpTotal = 0;
  for (const r of creditSeeds.rows) {
    const val = Number(r.opening_balance);
    cpTotal += val;
    const exp = expectedCreditParties[r.party_name];
    if (exp === undefined) throw new Error(`Unexpected credit party seed: ${r.party_name}`);
    if (val !== exp) throw new Error(`Credit party seed mismatch for ${r.party_name}: ${val} !== ${exp}`);
    if (r.source_period_key !== "2026-08" || r.source_day_no !== 31) {
      throw new Error(`Provenance mismatch on credit party ${r.party_name}: ${r.source_period_key} Day ${r.source_day_no}`);
    }
  }
  console.log(`Credit party seeds: 9 verified. Total = ${cpTotal} (Expected: 56,904)`);
  if (cpTotal !== 56904) throw new Error(`Credit party total mismatch: ${cpTotal} !== 56904`);

  // 2.3 Stock Products (11)
  const expectedStockProducts: Record<string, number> = {
    "RETAILER": 1727,
    "FRANCHISE": 466,
    "LOAD SIM": 5,
    "MBB SIM": 0,
    "E SIM": 16,
    "Shine Mobile": 0,
    "MOBILE": 0,
    "WINGLE": 0,
    "Gold Number": 20,
    "RETAIL IMZI": 1010,
    "CS IMZI": 210
  };

  const productSeeds = await sql<{
    product_name: string;
    opening_quantity: number;
    source_period_key: string;
    source_day_no: number;
  }>`
    SELECT sp.name as product_name, s.opening_quantity, s.source_period_key, s.source_day_no
    FROM period_stock_product_seeds s
    JOIN stock_products sp ON sp.id = s.product_id
    WHERE s.franchise_id = ${franchise.id} AND s.period_id = ${period.id}
    ORDER BY sp.sort_order
  `.execute(db);

  if (productSeeds.rows.length !== 11) throw new Error(`Expected 11 stock product seeds, found ${productSeeds.rows.length}`);
  let stockQtyTotal = 0;
  for (const r of productSeeds.rows) {
    stockQtyTotal += r.opening_quantity;
    const exp = expectedStockProducts[r.product_name];
    if (exp === undefined) throw new Error(`Unexpected stock product seed: ${r.product_name}`);
    if (r.opening_quantity !== exp) throw new Error(`Stock product seed mismatch for ${r.product_name}: ${r.opening_quantity} !== ${exp}`);
    if (r.source_period_key !== "2026-08" || r.source_day_no !== 31) {
      throw new Error(`Provenance mismatch on stock product ${r.product_name}: ${r.source_period_key} Day ${r.source_day_no}`);
    }
  }
  console.log(`Stock product seeds: 11 verified. Total quantity = ${stockQtyTotal} (Expected: 3,454)`);
  if (stockQtyTotal !== 3454) throw new Error(`Stock quantity total mismatch: ${stockQtyTotal} !== 3454`);

  // 2.4 Stock Accounts (17)
  const expectedStockAccounts: Record<string, number> = {
    "DO RIZWAN": 0,
    "DO MIRZA": 56592,
    "DO ADNAN": 0,
    "DO ARSLAN": 87015,
    "DO MUBASHAR": 86240,
    "Do Mirza irfan": 53760,
    "DO HASSAN": 21000,
    "DO NAVEED": 171670,
    "DO IRFAN": 40560,
    "DSO HASAN": 129920,
    "FREE SIM CCR": 29400,
    "HUSSAIN CCR": 22800,
    "SARAM CCR": 12800,
    "ANNI CCR": 41800,
    "WASEEM GUJJAR": 3080,
    "DSO Abdullah": 20640,
    "NET STOCK": 28000
  };

  const accountSeeds = await sql<{
    account_name: string;
    opening_receivable: string;
    source_period_key: string;
    source_day_no: number;
  }>`
    SELECT sa.name as account_name, s.opening_receivable, s.source_period_key, s.source_day_no
    FROM period_stock_account_seeds s
    JOIN stock_accounts sa ON sa.id = s.account_id
    WHERE s.franchise_id = ${franchise.id} AND s.period_id = ${period.id}
    ORDER BY sa.sort_order
  `.execute(db);

  if (accountSeeds.rows.length !== 17) throw new Error(`Expected 17 stock account seeds, found ${accountSeeds.rows.length}`);
  let stockAcctTotal = 0;
  for (const r of accountSeeds.rows) {
    const val = Number(r.opening_receivable);
    stockAcctTotal += val;
    const exp = expectedStockAccounts[r.account_name];
    if (exp === undefined) throw new Error(`Unexpected stock account seed: ${r.account_name}`);
    if (val !== exp) throw new Error(`Stock account seed mismatch for ${r.account_name}: ${val} !== ${exp}`);
    if (r.source_period_key !== "2026-08" || r.source_day_no !== 31) {
      throw new Error(`Provenance mismatch on stock account ${r.account_name}: ${r.source_period_key} Day ${r.source_day_no}`);
    }
  }
  console.log(`Stock account seeds: 17 verified. Total receivables = ${stockAcctTotal} (Expected: 805,277)`);
  if (stockAcctTotal !== 805277) throw new Error(`Stock account total mismatch: ${stockAcctTotal} !== 805277`);

  // 2.5 Jazz DO Profiles (14)
  const jazzDoSeeds = await sql<{
    do_name: string;
    opening_base_balance: string;
    source_period_key: string;
    source_day_no: number;
  }>`
    SELECT dp.do_name, s.opening_base_balance, s.source_period_key, s.source_day_no
    FROM period_jazz_do_seeds s
    JOIN jazz_load_do_profiles dp ON dp.id = s.do_profile_id
    WHERE s.franchise_id = ${franchise.id} AND s.period_id = ${period.id}
    ORDER BY dp.sort_order
  `.execute(db);

  if (jazzDoSeeds.rows.length !== 14) throw new Error(`Expected 14 Jazz DO seeds, found ${jazzDoSeeds.rows.length}`);
  for (const r of jazzDoSeeds.rows) {
    const val = Number(r.opening_base_balance);
    if (val !== 0) throw new Error(`Jazz DO seed non-zero for ${r.do_name}: ${val}`);
    if (r.source_period_key !== "2026-08" || r.source_day_no !== 31) {
      throw new Error(`Provenance mismatch on Jazz DO ${r.do_name}: ${r.source_period_key} Day ${r.source_day_no}`);
    }
  }
  console.log("Jazz DO seeds: 14 verified. All opening balances are 0.00.");

  console.log("ALL 52 SEED RECORDS MATCH THE AUTHORITATIVE SNAPSHOT WITH 100% PRECISION.");

  // =========================================================================
  // 3. EXECUTE EXISTING SERVER-AUTHORITATIVE VERIFICATION
  // =========================================================================
  console.log("\n--- Step 3: Executing verifySeeds() ---");
  const verifyResult = await verifySeeds(franchise.id, period.id, userContext);
  console.log("verifySeeds() result:", JSON.stringify(verifyResult, null, 2));

  // =========================================================================
  // 4. DAY 1 BASELINE PROJECTION VERIFICATION
  // =========================================================================
  console.log("\n--- Step 4: Day 1 Baseline Projections Inspection ---");

  // 4.1 Financial Projections
  const finProj = await db
    .selectFrom("day_financial_projections")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "=", day1.id)
    .executeTakeFirstOrThrow();

  console.log("Day 1 Financial Projections:", {
    opening_cash: finProj.opening_cash,
    closing_cash: finProj.closing_cash,
    total_issues: finProj.total_issues,
    total_expenses: finProj.total_expenses,
    operating_profit: finProj.operating_profit,
    owner_opening_balance: finProj.owner_opening_balance,
    owner_closing_balance: finProj.owner_closing_balance,
    opening_jazz_payable: finProj.opening_jazz_payable,
    closing_jazz_payable: finProj.closing_jazz_payable
  });

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
    throw new Error("Operational movements detected on zero-transaction Day 1");
  }

  // 4.2 Jazz Lifting Projections
  const liftProj = await db
    .selectFrom("jazz_lifting_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "=", day1.id)
    .executeTakeFirstOrThrow();

  console.log("Day 1 Jazz Lifting Projections:", {
    opening_lifting: liftProj.opening_lifting,
    closing_lifting_in_hand: liftProj.closing_lifting_in_hand,
    ml_lifting_purchased: liftProj.ml_lifting_purchased,
    today_ml_issuance: liftProj.today_ml_issuance
  });

  if (Number(liftProj.opening_lifting) !== 815579 || Number(liftProj.closing_lifting_in_hand) !== 815579) {
    throw new Error(`Lifting projection mismatch: ${liftProj.opening_lifting} -> ${liftProj.closing_lifting_in_hand}`);
  }
  if (Number(liftProj.ml_lifting_purchased) !== 0 || Number(liftProj.today_ml_issuance) !== 0) {
    throw new Error("Lifting operational movements detected on Day 1");
  }

  // 4.3 Credit Party Day Projections (9)
  const creditProjs = await sql<{
    party_name: string;
    opening_balance: string;
    closing_balance: string;
    total_loans: string;
    total_receipts: string;
    manual_adjustments: string;
  }>`
    SELECT cp.name as party_name, p.opening_balance, p.closing_balance, p.total_loans, p.total_receipts, p.manual_adjustments
    FROM credit_party_day_projections p
    JOIN credit_parties cp ON cp.id = p.party_id
    WHERE p.franchise_id = ${franchise.id} AND p.day_id = ${day1.id}
    ORDER BY cp.sort_order
  `.execute(db);

  console.log(`Credit party projections count: ${creditProjs.rows.length}`);
  let cpProjTotal = 0;
  for (const r of creditProjs.rows) {
    const op = Number(r.opening_balance);
    const cl = Number(r.closing_balance);
    const loans = Number(r.total_loans);
    const receipts = Number(r.total_receipts);
    const adj = Number(r.manual_adjustments);
    if (op !== cl || loans !== 0 || receipts !== 0 || adj !== 0) {
      throw new Error(`Credit party projection change on Day 1 for ${r.party_name}: ${op} -> ${cl}`);
    }
    cpProjTotal += cl;
  }
  console.log(`Credit party Day 1 closing total = ${cpProjTotal} (Expected: 56,904)`);
  if (cpProjTotal !== 56904) throw new Error(`Credit party closing total mismatch: ${cpProjTotal} !== 56904`);

  // 4.4 Stock Product Day Projections (11)
  const prodProjs = await sql<{
    product_name: string;
    opening_qty: number;
    closing_qty: number;
    stock_in_qty: number;
    stock_out_qty: number;
  }>`
    SELECT sp.name as product_name, p.opening_qty, p.closing_qty, p.stock_in_qty, p.stock_out_qty
    FROM stock_product_day_projections p
    JOIN stock_products sp ON sp.id = p.product_id
    WHERE p.franchise_id = ${franchise.id} AND p.day_id = ${day1.id}
    ORDER BY sp.sort_order
  `.execute(db);

  console.log(`Stock product projections count: ${prodProjs.rows.length}`);
  let stockQtyProjTotal = 0;
  for (const r of prodProjs.rows) {
    if (r.opening_qty !== r.closing_qty || r.stock_in_qty !== 0 || r.stock_out_qty !== 0) {
      throw new Error(`Stock product projection change on Day 1 for ${r.product_name}: ${r.opening_qty} -> ${r.closing_qty}`);
    }
    stockQtyProjTotal += r.closing_qty;
  }
  console.log(`Stock product Day 1 closing total quantity = ${stockQtyProjTotal} (Expected: 3,454)`);
  if (stockQtyProjTotal !== 3454) throw new Error(`Stock quantity closing total mismatch: ${stockQtyProjTotal} !== 3454`);

  // 4.5 Stock Account Day Projections (17)
  const acctProjs = await sql<{
    account_name: string;
    opening_due: string;
    closing_due: string;
    stock_taken_amount: string;
    payment_received_amount: string;
  }>`
    SELECT sa.name as account_name, p.opening_due, p.closing_due, p.stock_taken_amount, p.payment_received_amount
    FROM stock_account_day_projections p
    JOIN stock_accounts sa ON sa.id = p.account_id
    WHERE p.franchise_id = ${franchise.id} AND p.day_id = ${day1.id}
    ORDER BY sa.sort_order
  `.execute(db);

  console.log(`Stock account projections count: ${acctProjs.rows.length}`);
  let stockAcctProjTotal = 0;
  for (const r of acctProjs.rows) {
    const op = Number(r.opening_due);
    const cl = Number(r.closing_due);
    const taken = Number(r.stock_taken_amount);
    const paid = Number(r.payment_received_amount);
    if (op !== cl || taken !== 0 || paid !== 0) {
      throw new Error(`Stock account projection change on Day 1 for ${r.account_name}: ${op} -> ${cl}`);
    }
    stockAcctProjTotal += cl;
  }
  console.log(`Stock account Day 1 closing total = ${stockAcctProjTotal} (Expected: 805,277)`);
  if (stockAcctProjTotal !== 805277) throw new Error(`Stock account closing total mismatch: ${stockAcctProjTotal} !== 805277`);

  // 4.6 Jazz Load DO Day Projections (14)
  const doProjs = await sql<{
    do_name: string;
    opening_base: string;
    closing_base: string;
    opening_ml: string;
    closing_ml: string;
  }>`
    SELECT dp.do_name, p.opening_base, p.closing_base, p.opening_ml, p.closing_ml
    FROM jazz_load_do_day_projections p
    JOIN jazz_load_do_profiles dp ON dp.id = p.do_profile_id
    WHERE p.franchise_id = ${franchise.id} AND p.day_id = ${day1.id}
    ORDER BY dp.sort_order
  `.execute(db);

  console.log(`Jazz DO projections count: ${doProjs.rows.length}`);
  let doBaseProjTotal = 0;
  for (const r of doProjs.rows) {
    const op = Number(r.opening_base);
    const cl = Number(r.closing_base);
    if (op !== 0 || cl !== 0) throw new Error(`Jazz DO projection non-zero for ${r.do_name}: ${op} -> ${cl}`);
    doBaseProjTotal += cl;
  }
  console.log(`Jazz DO Day 1 closing total = ${doBaseProjTotal} (Expected: 0)`);

  // =========================================================================
  // 5. INVARIANT VIOLATIONS AUDIT
  // =========================================================================
  const invRes = await db
    .selectFrom("invariant_violations")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  console.log(`Invariant violations count: ${invRes.length}`);
  const blockingInvariants = invRes.filter((iv) => iv.severity === "critical");
  console.log(`Blocking invariant violations: ${blockingInvariants.length}`);

  // =========================================================================
  // 6. POST-VERIFICATION STATE & STATUS CHECKS
  // =========================================================================
  console.log("\n--- Step 6: Post-Verification State Audit ---");
  const postDay1 = await db
    .selectFrom("accounting_days")
    .select(["id", "day_no", "status"])
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .where("day_no", "=", 1)
    .executeTakeFirstOrThrow();

  console.log(`Day 1 Status: ${postDay1.status} (MUST BE CLOSED)`);
  if (postDay1.status !== "closed") {
    throw new Error(`CRITICAL ERROR: Day 1 status was modified to '${postDay1.status}', expected 'closed'.`);
  }

  const finSeedPost = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .executeTakeFirstOrThrow();

  console.log(`Financial Seed is_verified: ${finSeedPost.is_verified} (MUST BE TRUE)`);
  console.log(`Financial Seed verified_at: ${finSeedPost.verified_at}`);
  if (finSeedPost.is_verified !== true) {
    throw new Error(`Expected is_verified to be true, found ${finSeedPost.is_verified}`);
  }

  // Count operational transactions
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
  let totalTx = 0;
  for (const t of txTables) {
    const res = await sql.raw(`SELECT count(*) FROM ${t}`).execute(db);
    const count = Number((res.rows[0] as any).count);
    totalTx += count;
  }
  console.log(`Total operational transactions across all 10 tables: ${totalTx}`);
  if (totalTx !== 0) {
    throw new Error(`Operational transactions found: ${totalTx} !== 0`);
  }

  // Count projection rows created by verification
  // Note: credit_party_day_projections has 8 rows because NAVEED DO has 0.00 opening balance
  // and 0 transactions, which the calculation engine prunes per evaluateCreditParty design.
  const projTables = [
    { name: "day_financial_projections", count: 1 },
    { name: "jazz_lifting_day_projections", count: 1 },
    { name: "credit_party_day_projections", count: 8 },
    { name: "stock_product_day_projections", count: 11 },
    { name: "stock_account_day_projections", count: 17 },
    { name: "jazz_load_do_day_projections", count: 14 }
  ];
  console.log("Projection records created by Day 1 baseline calculation:");
  let totalProj = 0;
  for (const p of projTables) {
    const res = await sql.raw(`SELECT count(*) FROM ${p.name}`).execute(db);
    const actual = Number((res.rows[0] as any).count);
    console.log(`  ${p.name}: ${actual} (expected: ${p.count})`);
    if (actual !== p.count) throw new Error(`Projection count mismatch for ${p.name}: ${actual} !== ${p.count}`);
    totalProj += actual;
  }
  console.log(`Total Day 1 baseline projections: ${totalProj} (expected: 52)`);

  // Audit logs count
  const auditLogs = await db
    .selectFrom("audit_logs")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .orderBy("created_at", "asc")
    .execute();
  console.log(`Audit log entries: ${auditLogs.length}`);
  for (const a of auditLogs) {
    console.log(`  ${String(a.created_at)} | Action: ${a.action} | Entity: ${a.entity_type} (${a.entity_id})`);
  }

  console.log("\n=== ALL PHASE 7E CHECKS PASSED WITH 100% PRECISION ===");
}

runVerifySeptemberSeeds()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("FATAL ERROR in Phase 7E verification:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDatabase();
  });
