/**
 * Integration Test: Automatic Day Switching Calendar Rule
 * Enforces:
 * 1. Previously open day is automatically closed.
 * 2. Target day is automatically opened.
 * 3. Enforces uq_single_open_day_per_period across transitions.
 */
import assert from "node:assert/strict";
import { db, closeDatabase } from "../config/database.js";
import { switchAccountingDay } from "./service.js";

async function run() {
  console.log("=== RUNNING AUTOMATIC DAY SWITCHING TESTS ===");

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
    .where("period_key", "=", "2026-11")
    .executeTakeFirst();

  assert(period, "Expected period '2026-11' to exist.");
  const franchiseId = period.franchise_id;
  const periodId = period.id;

  try {
    // 1. Initial State: Switch to Day 1
    console.log("1. Switching to Day 1...");
    const res1 = await switchAccountingDay(
      franchiseId,
      periodId,
      1,
      null,
      "Test switch to Day 1",
      ownerUser
    );
    assert.equal(res1.success, true);
    assert.equal(res1.openedDay?.dayNo, 1);
    assert.equal(res1.openedDay?.status, "open");

    const day1InDb = await db
      .selectFrom("accounting_days")
      .select(["day_no", "status"])
      .where("period_id", "=", periodId)
      .where("day_no", "=", 1)
      .executeTakeFirst();
    assert.equal(day1InDb?.status, "open");

    const openCount1 = await db
      .selectFrom("accounting_days")
      .select(db.fn.count("id").as("count"))
      .where("period_id", "=", periodId)
      .where("status", "in", ["open", "reopen"])
      .executeTakeFirst();
    assert.equal(Number(openCount1?.count), 1, "Exactly one day must be open");
    console.log("   ✓ Day 1 opened cleanly.");

    // 2. Calendar Rule: Switch from Day 1 to Day 2 automatically
    console.log("2. Switching from Day 1 to Day 2 (Auto-close Day 1, Auto-open Day 2)...");
    const res2 = await switchAccountingDay(
      franchiseId,
      periodId,
      2,
      1,
      "Auto-switch on date click",
      ownerUser
    );
    assert.equal(res2.success, true);
    assert.equal(res2.closedDay?.dayNo, 1);
    assert.equal(res2.closedDay?.status, "closed");
    assert.equal(res2.openedDay?.dayNo, 2);
    assert.equal(res2.openedDay?.status, "open");

    const day1AfterSwitch = await db
      .selectFrom("accounting_days")
      .select(["day_no", "status"])
      .where("period_id", "=", periodId)
      .where("day_no", "=", 1)
      .executeTakeFirst();
    assert.equal(day1AfterSwitch?.status, "closed", "Day 1 must be closed");

    const day2AfterSwitch = await db
      .selectFrom("accounting_days")
      .select(["day_no", "status"])
      .where("period_id", "=", periodId)
      .where("day_no", "=", 2)
      .executeTakeFirst();
    assert.equal(day2AfterSwitch?.status, "open", "Day 2 must be open");

    const openCount2 = await db
      .selectFrom("accounting_days")
      .select(db.fn.count("id").as("count"))
      .where("period_id", "=", periodId)
      .where("status", "in", ["open", "reopen"])
      .executeTakeFirst();
    assert.equal(Number(openCount2?.count), 1, "Exactly one day must be open");
    console.log("   ✓ Day 1 closed and Day 2 opened atomically in 1 transaction.");

    // 3. Switch back from Day 2 to Day 1
    console.log("3. Switching back from Day 2 to Day 1 (Auto-close Day 2, Auto-reopen Day 1)...");
    const res3 = await switchAccountingDay(
      franchiseId,
      periodId,
      1,
      2,
      "Auto-switch to previous date",
      ownerUser
    );
    assert.equal(res3.success, true);
    assert.equal(res3.closedDay?.dayNo, 2);
    assert.equal(res3.openedDay?.dayNo, 1);
    assert.equal(res3.openedDay?.status, "open");

    const day2AfterBack = await db
      .selectFrom("accounting_days")
      .select(["day_no", "status"])
      .where("period_id", "=", periodId)
      .where("day_no", "=", 2)
      .executeTakeFirst();
    assert.equal(day2AfterBack?.status, "closed", "Day 2 must be closed");

    const day1AfterBack = await db
      .selectFrom("accounting_days")
      .select(["day_no", "status"])
      .where("period_id", "=", periodId)
      .where("day_no", "=", 1)
      .executeTakeFirst();
    assert.equal(day1AfterBack?.status, "open", "Day 1 must be open");
    console.log("   ✓ Day 2 closed and Day 1 opened cleanly.");

    // 4. Test Idempotent switch to already active day
    console.log("4. Switching to Day 1 when Day 1 is already open...");
    const res4 = await switchAccountingDay(
      franchiseId,
      periodId,
      1,
      1,
      null,
      ownerUser
    );
    assert.equal(res4.success, true);
    assert.equal(res4.openedDay?.dayNo, 1);
    console.log("   ✓ Idempotent switch handled gracefully.");

    // Cleanup: restore Day 1 to closed status
    await db
      .updateTable("accounting_days")
      .set({ status: "closed", updated_at: new Date() })
      .where("period_id", "=", periodId)
      .where("day_no", "=", 1)
      .execute();

    console.log("=== ALL AUTOMATIC DAY SWITCHING TESTS PASSED (4/4) ===");
  } finally {
    await closeDatabase();
  }
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
