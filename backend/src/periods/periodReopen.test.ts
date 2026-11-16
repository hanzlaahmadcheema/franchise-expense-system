/**
 * Standalone Integration Test: Governed Accounting Period Reopening & Safe Re-Rollover
 */
import assert from "node:assert/strict";
import { db, closeDatabase } from "../config/database.js";
import { reopenAccountingPeriod, closeAccountingPeriod } from "./service.js";

async function run() {
  console.log("=== RUNNING GOVERNED PERIOD REOPEN & RE-ROLLOVER TESTS ===");

  const user = await db
    .selectFrom("users")
    .select(["id", "email"])
    .where("email", "=", "owner@jazz.com")
    .executeTakeFirst();

  assert(user, "Expected owner user 'owner@jazz.com' to exist.");
  const ownerUser = {
    id: user.id,
    email: user.email,
    role: "owner" as const
  };

  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("period_key", "=", "2026-10")
    .executeTakeFirst();

  assert(period, "Expected period '2026-10' to exist.");
  const franchiseId = period.franchise_id;
  const periodId = period.id;

  console.log("1. Testing reopen of closed period 2026-10...");
  const reopenRes = await reopenAccountingPeriod(
    franchiseId,
    periodId,
    "Governed audit test for period reopening",
    ownerUser
  );

  assert.equal(reopenRes.reopened, true, "Expected period to be reopened.");
  assert.equal(reopenRes.status, "open", "Expected status to be open.");

  const periodAfterReopen = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("id", "=", periodId)
    .executeTakeFirst();

  assert.equal(periodAfterReopen?.status, "open", "DB status must be open.");
  assert(periodAfterReopen?.reopened_at, "DB reopened_at must be set.");
  assert.equal(periodAfterReopen?.reopened_by_user_id, ownerUser.id, "DB reopened_by must be owner user ID.");
  console.log("   ✓ Period reopened successfully with audit timestamps.");

  console.log("2. Testing idempotent reopen of already open period...");
  const idempotentRes = await reopenAccountingPeriod(
    franchiseId,
    periodId,
    "Repeated reopen attempt",
    ownerUser
  );

  assert.equal(idempotentRes.reopened, true, "Expected idempotent return.");
  assert.equal(idempotentRes.alreadyOpen, true, "Expected alreadyOpen flag.");
  console.log("   ✓ Repeated reopen is safely idempotent.");

  console.log("3. Testing re-close of period 2026-10 with automatic re-rollover into 2026-11...");
  const closeRes = await closeAccountingPeriod(
    franchiseId,
    periodId,
    "Re-closed after governed corrections",
    ownerUser
  );

  assert.equal(closeRes.closed, true, "Expected period to be closed.");
  assert.equal(closeRes.status, "closed", "Expected status to be closed.");

  const periodAfterClose = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("id", "=", periodId)
    .executeTakeFirst();

  assert.equal(periodAfterClose?.status, "closed", "DB status must be closed.");

  // Verify November seeds were synchronized
  const novPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_key", "=", "2026-11")
    .executeTakeFirst();

  assert(novPeriod, "Expected November period to exist.");
  const novSeeds = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("period_id", "=", novPeriod.id)
    .executeTakeFirst();

  assert(novSeeds, "Expected November financial seeds to exist.");
  assert.equal(novSeeds.is_verified, true, "November seeds must be verified.");
  console.log("   ✓ Re-close completed successfully with automatic cascading rollover into 2026-11.");

  console.log("4. Verifying future month (December 2026) is NOT auto-created or opened prematurely...");
  const decPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_key", "=", "2026-12")
    .executeTakeFirst();

  assert(!decPeriod, "Future period 2026-12 must NOT exist in database before December 1st.");
  console.log("   ✓ Future period 2026-12 was correctly not opened.");

  console.log("=== ALL GOVERNED PERIOD REOPEN & RE-ROLLOVER TESTS PASSED ===");
  await closeDatabase();
}

run().catch(async (err) => {
  console.error("Test failed:", err);
  await closeDatabase();
  process.exit(1);
});
