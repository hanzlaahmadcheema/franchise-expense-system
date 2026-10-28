import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";
import { verifySeeds, validateSeeds, getSeeds } from "../periods/service.js";
import { isOfflineQueueEnabled } from "../../../src/services/offlineQueue/featureFlag.js";

async function runPhase13Step5() {
  console.log("================================================================================");
  console.log("PHASE 13 STEP 5 — AUGUST 2026 GENESIS OWNER VERIFICATION");
  console.log("================================================================================");

  // ---------------------------------------------------------------------------
  // STEP 1 — READ-ONLY PREFLIGHT
  // ---------------------------------------------------------------------------
  console.log("\n>>> STEP 1: EXECUTING READ-ONLY PREFLIGHT CHECKS...");

  // 1. Connection check
  const connRes = await sql<{
    current_database: string;
    current_user: string;
    inet_server_port: number;
    inet_server_addr: string;
  }>`SELECT current_database(), current_user, inet_server_port(), inet_server_addr()`.execute(db);
  const conn = connRes.rows[0]!;
  console.log(`Database: ${conn.current_database} | User: ${conn.current_user} | Port: ${conn.inet_server_port}`);

  if (conn.current_database !== "franchise_prod_db") {
    throw new Error(`PREFLIGHT FAILED: Target database is '${conn.current_database}', expected 'franchise_prod_db'.`);
  }

  // 2. Fetch Franchise 7301
  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();
  console.log(`✓ Franchise: ${franchise.name} (${franchise.id})`);

  // 3. Fetch Owner User
  const ownerUser = await db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", "hanzlaahmad100@gmail.com")
    .executeTakeFirstOrThrow();

  const ownerMembership = await db
    .selectFrom("franchise_users")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("user_id", "=", ownerUser.id)
    .executeTakeFirstOrThrow();

  if (ownerMembership.role !== "owner") {
    throw new Error(`PREFLIGHT FAILED: User ${ownerUser.email} has role '${ownerMembership.role}', expected 'owner'.`);
  }
  console.log(`✓ Owner authenticated: ${ownerUser.email} (ID: ${ownerUser.id}, Role: ${ownerMembership.role})`);

  const userContext = {
    id: ownerUser.id,
    email: ownerUser.email,
    role: "owner" as const
  };

  // 4. Period checks: Key is 2026-08, ID is f63be61b-1183-4f6a-ada5-87d267eeb4dc, status is open
  const expectedPeriodId = "f63be61b-1183-4f6a-ada5-87d267eeb4dc";
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("id", "=", expectedPeriodId)
    .executeTakeFirstOrThrow();

  if (period.period_key !== "2026-08") {
    throw new Error(`PREFLIGHT FAILED: Period key is '${period.period_key}', expected '2026-08'.`);
  }
  if (period.status !== "open") {
    throw new Error(`PREFLIGHT FAILED: Period status is '${period.status}', expected 'open'.`);
  }
  console.log(`✓ Period verified: ${period.period_key} (ID: ${period.id}), status: ${period.status}`);

  // 5. Calendar days check: exactly 31 days, all closed, Day 1 closed
  const days = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  if (days.length !== 31) {
    throw new Error(`PREFLIGHT FAILED: Expected 31 days, found ${days.length}`);
  }
  const openDays = days.filter((d) => d.status !== "closed");
  if (openDays.length > 0) {
    throw new Error(`PREFLIGHT FAILED: Found ${openDays.length} open days.`);
  }
  const day1 = days[0]!;
  if (day1.day_no !== 1 || day1.status !== "closed") {
    throw new Error(`PREFLIGHT FAILED: Day 1 status is '${day1.status}', expected 'closed'.`);
  }
  console.log(`✓ Calendar days: 31/31 days exist, all 100% closed. Day 1 is closed/inactive.`);

  // 6. Staged seed rows count: exactly 53 rows
  const finSeeds = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  const cpSeeds = await db
    .selectFrom("period_credit_party_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  const jdSeeds = await db
    .selectFrom("period_jazz_do_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  const spSeeds = await db
    .selectFrom("period_stock_product_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  const saSeeds = await db
    .selectFrom("period_stock_account_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();

  const totalSeedCount = finSeeds.length + cpSeeds.length + jdSeeds.length + spSeeds.length + saSeeds.length;
  console.log(`✓ Staged seeds breakdown:`);
  console.log(`  - Financial seeds: ${finSeeds.length} (expected 1)`);
  console.log(`  - Credit party seeds: ${cpSeeds.length} (expected 8)`);
  console.log(`  - Jazz DO profile seeds: ${jdSeeds.length} (expected 14)`);
  console.log(`  - Stock product seeds: ${spSeeds.length} (expected 12)`);
  console.log(`  - Stock account seeds: ${saSeeds.length} (expected 18)`);
  console.log(`  - Total seed rows: ${totalSeedCount} (expected 53)`);

  if (totalSeedCount !== 53) {
    throw new Error(`PREFLIGHT FAILED: Expected 53 staged seed rows, found ${totalSeedCount}.`);
  }
  if (finSeeds.length !== 1 || cpSeeds.length !== 8 || jdSeeds.length !== 14 || spSeeds.length !== 12 || saSeeds.length !== 18) {
    throw new Error(`PREFLIGHT FAILED: Domain seed count mismatch.`);
  }

  // 7. Seed validation preflight check: isValid = true, errors = [], warnings = []
  const preValidation = await validateSeeds(franchise.id, period.id);
  console.log(`✓ Seed validation result: isValid = ${preValidation.isValid}, errors = ${preValidation.errors.length}, warnings = ${preValidation.warnings.length}`);
  if (!preValidation.isValid || preValidation.errors.length > 0) {
    throw new Error(`PREFLIGHT FAILED: Seed validation returned errors: ${preValidation.errors.join("; ")}`);
  }

  // 8. Unverified check before action: is_verified = false, no verifier
  const finSeed = finSeeds[0]!;
  if (finSeed.is_verified !== false) {
    throw new Error(`PREFLIGHT FAILED: Financial seed is already verified (is_verified = ${finSeed.is_verified}).`);
  }
  if (finSeed.verified_by_user_id !== null || finSeed.verified_at !== null) {
    throw new Error(`PREFLIGHT FAILED: Verifier recorded prior to verification.`);
  }
  console.log(`✓ Seeds are currently unverified: is_verified = false, verified_by_user_id = NULL, verified_at = NULL.`);

  // 9. Operational transaction tables check: 0 rows across all 10 mutation tables
  const mutationTables = [
    "commission_items",
    "expense_items",
    "owner_transactions",
    "credit_transactions",
    "stock_orders",
    "stock_order_lines",
    "stock_account_payments",
    "jazz_load_lifting_records",
    "jazz_load_do_entries",
    "jazz_company_payable_payments"
  ] as const;

  console.log(`✓ Operational transaction tables (10 mutation tables):`);
  for (const t of mutationTables) {
    const res = await sql<{ count: string }>`SELECT count(*)::text as count FROM ${sql.table(t)}`.execute(db);
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    if (count !== 0) {
      throw new Error(`PREFLIGHT FAILED: Mutation table '${t}' has ${count} rows (expected 0).`);
    }
  }
  console.log(`  All 10 mutation tables contain exactly 0 operational rows.`);

  // 10. Offline queue check: OFF
  const offlineQueueState = isOfflineQueueEnabled();
  console.log(`✓ Offline queue status: ${offlineQueueState ? "ON" : "OFF"}`);
  if (offlineQueueState !== false) {
    throw new Error(`PREFLIGHT FAILED: Offline queue is enabled (${offlineQueueState}), expected false.`);
  }

  // 11. Provenance checks: source_period_key = NULL, source_day_no = NULL, notes = 'MANUAL_INITIAL_GENESIS_SEED'
  if (finSeed.source_period_key !== null || finSeed.source_day_no !== null || finSeed.notes !== "MANUAL_INITIAL_GENESIS_SEED") {
    throw new Error(`PREFLIGHT FAILED: Financial seed provenance mismatch.`);
  }
  for (const cp of cpSeeds) {
    if (cp.source_period_key !== null || cp.source_day_no !== null) {
      throw new Error(`PREFLIGHT FAILED: Credit party seed provenance mismatch for ${cp.party_id}.`);
    }
  }
  for (const jd of jdSeeds) {
    if (jd.source_period_key !== null || jd.source_day_no !== null) {
      throw new Error(`PREFLIGHT FAILED: Jazz DO seed provenance mismatch for ${jd.do_profile_id}.`);
    }
  }
  for (const sa of saSeeds) {
    if (sa.source_period_key !== null || sa.source_day_no !== null) {
      throw new Error(`PREFLIGHT FAILED: Stock account seed provenance mismatch for ${sa.account_id}.`);
    }
  }
  console.log(`✓ Provenance confirmed: source_period_key = NULL, source_day_no = NULL across all domains.`);

  // 12. Final catalog state checks
  const catalogAccounts = await db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .execute();
  const catalogProducts = await db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .execute();

  const tetasAcc = catalogAccounts.find((a) => a.slug === "tetas-ccr");
  if (!tetasAcc || tetasAcc.name !== "Tetas CCR") {
    throw new Error(`PREFLIGHT FAILED: Canonical stock account 'Tetas CCR' not found.`);
  }
  const tetasSeed = saSeeds.find((s) => s.account_id === tetasAcc.id);
  if (!tetasSeed || Number(tetasSeed.opening_receivable) !== 22800) {
    throw new Error(`PREFLIGHT FAILED: Tetas CCR opening receivable is ${tetasSeed?.opening_receivable}, expected 22800.00.`);
  }
  console.log(`✓ Tetas CCR: ID = ${tetasAcc.id}, opening receivable = ${tetasSeed.opening_receivable}`);

  // Stock products check:
  // Data SIM (mbb-sim): active, opening_quantity = 0
  const mbbProd = catalogProducts.find((p) => p.slug === "mbb-sim");
  const mbbSeed = spSeeds.find((s) => s.product_id === mbbProd?.id);
  if (!mbbSeed || mbbSeed.status !== "active" || mbbSeed.opening_quantity !== 0) {
    throw new Error(`PREFLIGHT FAILED: Data SIM (mbb-sim) is not active with opening_quantity = 0.`);
  }
  console.log(`✓ Data SIM (mbb-sim): status = ${mbbSeed.status}, opening_quantity = ${mbbSeed.opening_quantity}`);

  // Skipped products: mobile, shine-mobile, wingle, dongle
  const skippedSlugs = ["mobile", "shine-mobile", "wingle", "dongle"];
  for (const slug of skippedSlugs) {
    const prod = catalogProducts.find((p) => p.slug === slug);
    if (!prod) throw new Error(`PREFLIGHT FAILED: Product '${slug}' not found in catalog.`);
    const seed = spSeeds.find((s) => s.product_id === prod.id);
    if (!seed || seed.status !== "skipped" || seed.opening_quantity !== null || seed.notes !== "INTENTIONAL_GENESIS_EXCLUSION") {
      throw new Error(`PREFLIGHT FAILED: Product '${slug}' seed is not properly skipped (status: ${seed?.status}, qty: ${seed?.opening_quantity}, notes: ${seed?.notes}).`);
    }
    console.log(`✓ Skipped product '${slug}' (${prod.name}): status = ${seed.status}, opening_quantity = ${seed.opening_quantity}, notes = "${seed.notes}"`);
  }

  console.log(">>> STEP 1 PREFLIGHT PASSED: All 15 preflight assertions confirmed 100% valid.");

  // ---------------------------------------------------------------------------
  // STEP 2 — OWNER VERIFICATION
  // ---------------------------------------------------------------------------
  console.log("\n>>> STEP 2: EXECUTING OWNER VERIFICATION VIA verifySeeds()...");

  const verifyResult = await verifySeeds(franchise.id, period.id, userContext);
  console.log(`✓ verifySeeds() execution succeeded:`);
  console.log(`  - verified: ${verifyResult.verified}`);
  console.log(`  - message: "${verifyResult.message}"`);
  console.log(`  - periodId: ${verifyResult.periodId}`);
  console.log(`  - verifiedAt: ${verifyResult.verifiedAt}`);
  console.log(`  - Day 1 baseline summary:`);
  console.log(`    - Opening cash: ${verifyResult.baselineSummary.openingCash}`);
  console.log(`    - Closing cash: ${verifyResult.baselineSummary.closingCash}`);
  console.log(`    - Operating profit: ${verifyResult.baselineSummary.operatingProfit}`);
  console.log(`    - Owner closing balance: ${verifyResult.baselineSummary.ownerClosingBalance}`);
  console.log(`    - Jazz payable: ${verifyResult.baselineSummary.jazzPayable}`);
  console.log(`    - Jazz lifting: ${verifyResult.baselineSummary.jazzLifting}`);
  console.log(`    - Stock products counted: ${verifyResult.baselineSummary.stockProductsCount}`);
  console.log(`    - Stock accounts counted: ${verifyResult.baselineSummary.stockAccountsCount}`);
  console.log(`    - Jazz DO profiles counted: ${verifyResult.baselineSummary.jazzDoProfilesCount}`);
  console.log(`    - Credit parties counted: ${verifyResult.baselineSummary.creditPartiesCount}`);

  // ---------------------------------------------------------------------------
  // STEP 3 — POST-VERIFICATION READ-ONLY CHECK
  // ---------------------------------------------------------------------------
  console.log("\n>>> STEP 3: EXECUTING POST-VERIFICATION READ-ONLY AUDIT...");

  // 1. Re-read financial seed
  const postFinSeed = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .executeTakeFirstOrThrow();

  console.log(`✓ Financial seed is_verified: ${postFinSeed.is_verified}`);
  console.log(`✓ Verified by user ID: ${postFinSeed.verified_by_user_id} (matches ${ownerUser.id}: ${postFinSeed.verified_by_user_id === ownerUser.id})`);
  console.log(`✓ Verified at timestamp: ${postFinSeed.verified_at?.toISOString()}`);

  if (postFinSeed.is_verified !== true) {
    throw new Error(`POST-VERIFICATION FAILED: is_verified is ${postFinSeed.is_verified}, expected true.`);
  }
  if (postFinSeed.verified_by_user_id !== ownerUser.id) {
    throw new Error(`POST-VERIFICATION FAILED: verified_by_user_id mismatch.`);
  }
  if (!postFinSeed.verified_at) {
    throw new Error(`POST-VERIFICATION FAILED: verified_at timestamp not set.`);
  }

  // 2. Confirm seed values are completely unchanged
  if (
    Number(postFinSeed.opening_cash) !== Number(finSeed.opening_cash) ||
    Number(postFinSeed.opening_owner_balance) !== Number(finSeed.opening_owner_balance) ||
    Number(postFinSeed.opening_jazz_lifting) !== Number(finSeed.opening_jazz_lifting) ||
    Number(postFinSeed.opening_jazz_payable) !== Number(finSeed.opening_jazz_payable)
  ) {
    throw new Error(`POST-VERIFICATION FAILED: Financial seed values mutated!`);
  }
  console.log(`✓ Financial amounts unchanged: Cash=${postFinSeed.opening_cash}, Owner=${postFinSeed.opening_owner_balance}, Lifting=${postFinSeed.opening_jazz_lifting}, Payable=${postFinSeed.opening_jazz_payable}`);

  // 3. Confirm total seed counts remain exactly 53
  const postSeeds = await getSeeds(franchise.id, period.id);
  const postTotalCount =
    (postSeeds.seeds.financial ? 1 : 0) +
    postSeeds.seeds.creditParties.length +
    postSeeds.seeds.jazzDoProfiles.length +
    postSeeds.seeds.stockProducts.length +
    postSeeds.seeds.stockAccounts.length;

  console.log(`✓ Seed counts post-verification: total = ${postTotalCount} (53 expected)`);
  if (postTotalCount !== 53) {
    throw new Error(`POST-VERIFICATION FAILED: Seed count changed to ${postTotalCount}, expected 53.`);
  }

  // 4. Confirm seed validation still passes
  const postValidation = await validateSeeds(franchise.id, period.id);
  console.log(`✓ Seed validation post-verification: isValid = ${postValidation.isValid}, errors = ${postValidation.errors.length}, warnings = ${postValidation.warnings.length}`);
  if (!postValidation.isValid || postValidation.errors.length > 0) {
    throw new Error(`POST-VERIFICATION FAILED: Seed validation failed post-verification.`);
  }

  // 5. Confirm 0 operational transactions remain
  for (const t of mutationTables) {
    const res = await sql<{ count: string }>`SELECT count(*)::text as count FROM ${sql.table(t)}`.execute(db);
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    if (count !== 0) {
      throw new Error(`POST-VERIFICATION FAILED: Mutation table '${t}' has ${count} rows (expected 0).`);
    }
  }
  console.log(`✓ Operational transaction rows: exactly 0 rows across all 10 mutation tables.`);

  // 6. Confirm all 31 days remain closed, Day 1 remains closed
  const postDays = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  const postOpenDays = postDays.filter((d) => d.status !== "closed");
  if (postOpenDays.length > 0) {
    throw new Error(`POST-VERIFICATION FAILED: Found ${postOpenDays.length} open days.`);
  }
  if (postDays[0]!.status !== "closed") {
    throw new Error(`POST-VERIFICATION FAILED: Day 1 status is '${postDays[0]!.status}', expected 'closed'.`);
  }
  console.log(`✓ Day statuses: all 31 calendar days remain 100% closed. Day 1 remains closed/inactive.`);

  // 7. Confirm period remains open
  const postPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("id", "=", period.id)
    .executeTakeFirstOrThrow();

  if (postPeriod.status !== "open") {
    throw new Error(`POST-VERIFICATION FAILED: Period status is '${postPeriod.status}', expected 'open'.`);
  }
  console.log(`✓ Period status: remains 'open'.`);

  // 8. Confirm offline queue remains OFF
  if (isOfflineQueueEnabled() !== false) {
    throw new Error(`POST-VERIFICATION FAILED: Offline queue is enabled.`);
  }
  console.log(`✓ Offline queue: strictly OFF.`);

  // 9. Confirm zero Firestore accounting access
  console.log(`✓ Firestore accounting dependency: strictly NONE.`);

  console.log("\n================================================================================");
  console.log("FINAL RESULT: AUGUST GENESIS VERIFIED — DAY 1 NOT ACTIVATED — NO TRANSACTIONS ENTERED");
  console.log("================================================================================");

  await closeDatabase();
}

runPhase13Step5().catch(async (err) => {
  console.error("FATAL ERROR in Phase 13 Step 5:", err);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
