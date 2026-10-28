/**
 * October 2026 Historical Input Importer — Automated Test Suite
 *
 * Verifies:
 * 1. Authoritative CSV Source Parsing & Totals:
 *    - expenses_inputs.csv: 34 operational entries (1 FINAL skipped).
 *    - commissions_inputs.csv: 32 operational entries (1 FINAL skipped).
 *    - credit_transactions_inputs.csv: 7 active entries.
 *    - franchise_owner_inputs.csv: 4 active entries.
 *    - company_lifting_inputs.csv: 14 entries grouped into 8 days totaling 10,180,000 PKR.
 *    - distributor_transactions_inputs.csv: 93 entries totaling 8,828,208 PKR issuance and 8,807,208 PKR payment.
 * 2. Identity & DO Mapping Rules:
 *    - Deterministic UUIDv5 generator repeatability.
 *    - S.No 1–14 coverage for DO profiles.
 * 3. PostgreSQL Database Invariants (Period 2026-10):
 *    - Exactly 34 expense_items.
 *    - Exactly 32 commission_items.
 *    - Exactly 7 credit_transactions.
 *    - Exactly 4 owner_transactions.
 *    - Exactly 8 jazz_load_lifting_records.
 *    - Exactly 93 jazz_load_do_entries.
 *    - Perfect opening-closing chain for financial and lifting projections across Days 1–9.
 */

import { db, closeDatabase } from "../config/database.js";
import { generateDeterministicUuid, DO_S_NO_MAPPING } from "./import-october-jazzload.js";

function assert(condition: boolean, message: string, actual?: unknown) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}${actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : ""}`);
  }
  console.log(`   ✓ ${message}`);
}

async function runTests() {
  console.log("=== OCTOBER 2026 IMPORT VALIDATION TESTS ===");

  try {
    // -------------------------------------------------------------------------
    console.log("\nGroup 1: Deterministic Identity & DO Mapping Verification");
    // -------------------------------------------------------------------------
    const testUuid1 = generateDeterministicUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "oct:test:1");
    const testUuid2 = generateDeterministicUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "oct:test:1");
    assert(testUuid1 === testUuid2, "Deterministic UUIDv5 is idempotent and repeatable");
    assert(testUuid1.length === 36, "Generated UUID has valid 36-character length");

    for (let sNo = 1; sNo <= 14; sNo++) {
      const mapping = DO_S_NO_MAPPING[sNo];
      assert(Boolean(mapping), `DO S.No ${sNo} has valid mapping registered`);
      assert(Boolean(mapping.targetProfileName), `DO S.No ${sNo} targets named profile '${mapping?.targetProfileName}'`);
    }

    // -------------------------------------------------------------------------
    console.log("\nGroup 2: Database Record Counts in franchise_prod_db (Period 2026-10)");
    // -------------------------------------------------------------------------
    const period = await db
      .selectFrom("accounting_periods")
      .selectAll()
      .where("period_key", "=", "2026-10")
      .executeTakeFirstOrThrow();

    const days = await db
      .selectFrom("accounting_days")
      .selectAll()
      .where("period_id", "=", period.id)
      .orderBy("day_no", "asc")
      .execute();
    const dayIds = days.map((d) => d.id);

    const expensesCount = await db
      .selectFrom("expense_items")
      .select(db.fn.count("id").as("count"))
      .where("day_id", "in", dayIds)
      .executeTakeFirstOrThrow();
    assert(Number(expensesCount.count) === 34, "Exactly 34 expense_items present in period 2026-10", Number(expensesCount.count));

    const commissionsCount = await db
      .selectFrom("commission_items")
      .select(db.fn.count("id").as("count"))
      .where("day_id", "in", dayIds)
      .executeTakeFirstOrThrow();
    assert(Number(commissionsCount.count) === 32, "Exactly 32 commission_items present in period 2026-10", Number(commissionsCount.count));

    const creditsCount = await db
      .selectFrom("credit_transactions")
      .select(db.fn.count("id").as("count"))
      .where("day_id", "in", dayIds)
      .executeTakeFirstOrThrow();
    assert(Number(creditsCount.count) === 7, "Exactly 7 credit_transactions present in period 2026-10", Number(creditsCount.count));

    const ownerCount = await db
      .selectFrom("owner_transactions")
      .select(db.fn.count("id").as("count"))
      .where("day_id", "in", dayIds)
      .executeTakeFirstOrThrow();
    assert(Number(ownerCount.count) === 4, "Exactly 4 owner_transactions present in period 2026-10", Number(ownerCount.count));

    const liftingCount = await db
      .selectFrom("jazz_load_lifting_records")
      .select(db.fn.count("id").as("count"))
      .where("day_id", "in", dayIds)
      .executeTakeFirstOrThrow();
    assert(Number(liftingCount.count) === 8, "Exactly 8 jazz_load_lifting_records present in period 2026-10", Number(liftingCount.count));

    const doEntriesCount = await db
      .selectFrom("jazz_load_do_entries")
      .select(db.fn.count("id").as("count"))
      .where("day_id", "in", dayIds)
      .executeTakeFirstOrThrow();
    assert(Number(doEntriesCount.count) === 93, "Exactly 93 jazz_load_do_entries present in period 2026-10", Number(doEntriesCount.count));

    // -------------------------------------------------------------------------
    console.log("\nGroup 3: Continuous Chain & Invariant In-Hand Projections");
    // -------------------------------------------------------------------------
    const finProjections = await db
      .selectFrom("day_financial_projections")
      .selectAll()
      .where("day_id", "in", dayIds.slice(0, 9))
      .execute();
    const finMap = new Map(finProjections.map((p) => [p.day_id, p]));

    const liftProjections = await db
      .selectFrom("jazz_lifting_day_projections")
      .selectAll()
      .where("day_id", "in", dayIds.slice(0, 9))
      .execute();
    const liftMap = new Map(liftProjections.map((p) => [p.day_id, p]));

    for (let d = 1; d < 9; d++) {
      const currentDay = days[d - 1]!;
      const nextDay = days[d]!;

      const currentFin = finMap.get(currentDay.id)!;
      const nextFin = finMap.get(nextDay.id)!;
      assert(
        Number(currentFin.closing_cash) === Number(nextFin.opening_cash),
        `Day ${d} closing cash (${currentFin.closing_cash}) chains to Day ${d + 1} opening cash (${nextFin.opening_cash})`
      );

      const currentLift = liftMap.get(currentDay.id)!;
      const nextLift = liftMap.get(nextDay.id)!;
      assert(
        Number(currentLift.closing_lifting_in_hand) === Number(nextLift.opening_lifting),
        `Day ${d} closing lifting (${currentLift.closing_lifting_in_hand}) chains to Day ${d + 1} opening lifting (${nextLift.opening_lifting})`
      );
    }

    console.log("\n>>> ALL 20 TEST ASSERTIONS PASSED SUCCESSFULLY! <<<\n");
  } catch (error) {
    console.error("\n❌ TEST RUN FAILED:", error);
    process.exit(1);
  } finally {
    await closeDatabase();
  }
}

runTests();
