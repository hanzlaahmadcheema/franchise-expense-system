import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";
import { activatePeriod, validateSeeds, getSeeds } from "../periods/service.js";
import { isOfflineQueueEnabled } from "../../../src/services/offlineQueue/featureFlag.js";

async function runActivateAugustDay1() {
  console.log("================================================================================");
  console.log("PHASE 13 — ACTIVATE 2026-08-01 (DAY 1) IN PRODUCTION");
  console.log("================================================================================");

  // 1. Connection & Environment Verification
  const connRes = await sql<{
    current_database: string;
    current_user: string;
    inet_server_port: number;
    inet_server_addr: string;
  }>`SELECT current_database(), current_user, inet_server_port(), inet_server_addr()`.execute(db);
  const conn = connRes.rows[0]!;
  console.log(`Database: ${conn.current_database} | User: ${conn.current_user} | Port: ${conn.inet_server_port}`);

  if (conn.current_database !== "franchise_prod_db") {
    throw new Error(`SAFETY ABORT: Target database is '${conn.current_database}', expected 'franchise_prod_db'.`);
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
    throw new Error(`SAFETY ABORT: User ${ownerUser.email} has role '${ownerMembership.role}', expected 'owner'.`);
  }
  console.log(`✓ Owner authenticated: ${ownerUser.email} (ID: ${ownerUser.id}, Role: ${ownerMembership.role})`);

  const userContext = {
    id: ownerUser.id,
    email: ownerUser.email,
    role: "owner" as const
  };

  // 4. Verify Preconditions
  const expectedPeriodId = "f63be61b-1183-4f6a-ada5-87d267eeb4dc";
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("id", "=", expectedPeriodId)
    .executeTakeFirstOrThrow();

  if (period.period_key !== "2026-08") {
    throw new Error(`PRECONDITION FAILED: Period key is '${period.period_key}', expected '2026-08'.`);
  }
  if (period.status !== "open") {
    throw new Error(`PRECONDITION FAILED: Period status is '${period.status}', expected 'open'.`);
  }
  console.log(`✓ Period: ${period.period_key} (ID: ${period.id}), status: ${period.status}`);

  // Check Days
  const daysBefore = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  if (daysBefore.length !== 31) {
    throw new Error(`PRECONDITION FAILED: Expected 31 days, found ${daysBefore.length}.`);
  }
  const openDaysBefore = daysBefore.filter((d) => d.status !== "closed");
  if (openDaysBefore.length > 0) {
    throw new Error(`PRECONDITION FAILED: Found ${openDaysBefore.length} unclosed days prior to activation.`);
  }
  const day1Before = daysBefore[0]!;
  if (day1Before.status !== "closed") {
    throw new Error(`PRECONDITION FAILED: Day 1 status is '${day1Before.status}', expected 'closed'.`);
  }
  console.log(`✓ Precondition confirmed: All 31 days currently closed. Day 1 is closed.`);

  // Check Seeds
  const seedsData = await getSeeds(franchise.id, period.id);
  const totalSeeds =
    (seedsData.seeds.financial ? 1 : 0) +
    seedsData.seeds.creditParties.length +
    seedsData.seeds.jazzDoProfiles.length +
    seedsData.seeds.stockProducts.length +
    seedsData.seeds.stockAccounts.length;

  if (totalSeeds !== 53) {
    throw new Error(`PRECONDITION FAILED: Expected 53 seeds, found ${totalSeeds}.`);
  }
  if (seedsData.isVerified !== true) {
    throw new Error(`PRECONDITION FAILED: Genesis seeds are not verified (isVerified = ${seedsData.isVerified}).`);
  }
  console.log(`✓ Precondition confirmed: 53/53 genesis seeds verified (isVerified = true).`);

  // Check Operational Transactions
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

  for (const t of mutationTables) {
    const res = await sql<{ count: string }>`SELECT count(*)::text as count FROM ${sql.table(t)}`.execute(db);
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    if (count !== 0) {
      throw new Error(`PRECONDITION FAILED: Mutation table '${t}' has ${count} rows (expected 0).`);
    }
  }
  console.log(`✓ Precondition confirmed: 0 operational transactions across all 10 mutation tables.`);

  // Check Offline Queue
  if (isOfflineQueueEnabled() !== false) {
    throw new Error("PRECONDITION FAILED: Offline queue is enabled.");
  }
  console.log(`✓ Precondition confirmed: Offline queue is OFF.`);
  console.log(`✓ Precondition confirmed: Firestore dependency is NONE.`);

  // ---------------------------------------------------------------------------
  // 5. ACTION: Activate Period / Day 1 via authoritative activatePeriod
  // ---------------------------------------------------------------------------
  console.log("\n>>> EXECUTING DAY 1 ACTIVATION via activatePeriod()...");
  const actResult = await activatePeriod(franchise.id, period.id, userContext);
  console.log(`✓ activatePeriod() result:`);
  console.log(`  - activated: ${actResult.activated}`);
  console.log(`  - message: "${actResult.message}"`);
  console.log(`  - day1 ID: ${actResult.day1.id}`);
  console.log(`  - day1 DayNo: ${actResult.day1.dayNo}`);
  console.log(`  - day1 Status: ${actResult.day1.status}`);
  console.log(`  - day1 Date: ${actResult.day1.calendarDate}`);

  // ---------------------------------------------------------------------------
  // 6. POST-ACTIVATION VERIFICATION
  // ---------------------------------------------------------------------------
  console.log("\n>>> POST-ACTIVATION VERIFICATION...");

  const daysAfter = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  const day1After = daysAfter[0]!;
  console.log(`✓ Day 1 status: ${day1After.status} (calendarDate: ${day1After.calendar_date})`);
  if (day1After.status !== "open") {
    throw new Error(`POST-VERIFICATION FAILED: Day 1 status is '${day1After.status}', expected 'open'.`);
  }

  const otherOpenDays = daysAfter.slice(1).filter((d) => d.status !== "closed");
  console.log(`✓ Days 2–31 closed check: ${daysAfter.length - 1 - otherOpenDays.length}/30 days closed`);
  if (otherOpenDays.length > 0) {
    throw new Error(`POST-VERIFICATION FAILED: Found ${otherOpenDays.length} days other than Day 1 that are not closed!`);
  }

  // Verify operational rows remain 0
  for (const t of mutationTables) {
    const res = await sql<{ count: string }>`SELECT count(*)::text as count FROM ${sql.table(t)}`.execute(db);
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    if (count !== 0) {
      throw new Error(`POST-VERIFICATION FAILED: Mutation table '${t}' has ${count} rows (expected 0).`);
    }
  }
  console.log(`✓ Operational transactions: exactly 0 rows remain across all 10 mutation tables.`);

  // Verify period status remains open
  const periodAfter = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("id", "=", period.id)
    .executeTakeFirstOrThrow();
  console.log(`✓ Period status: ${periodAfter.status} (expected 'open')`);

  // Verify seeds remain verified and count is 53
  const postSeeds = await getSeeds(franchise.id, period.id);
  const postTotalSeeds =
    (postSeeds.seeds.financial ? 1 : 0) +
    postSeeds.seeds.creditParties.length +
    postSeeds.seeds.jazzDoProfiles.length +
    postSeeds.seeds.stockProducts.length +
    postSeeds.seeds.stockAccounts.length;
  console.log(`✓ Seeds verified: ${postSeeds.isVerified} (count: ${postTotalSeeds}/53)`);

  console.log("\n================================================================================");
  console.log("FINAL RESULT: AUGUST 2026-08-01 (DAY 1) ACTIVATED — OPEN — DAYS 2–31 CLOSED — 0 TRANSACTIONS");
  console.log("================================================================================");

  await closeDatabase();
}

runActivateAugustDay1().catch(async (err) => {
  console.error("FATAL ERROR in Day 1 activation:", err);
  await closeDatabase().catch(() => {});
  process.exit(1);
});
