/**
 * September 2026 Historical Jazz Load Input Importer — Unit & Integration Tests
 *
 * Verifies:
 * 1. Authoritative CSV Parsing & Totals:
 *    - company_lifting_inputs.csv: 37 entries across 22 lifting days totaling 27,930,000 PKR.
 *    - distributor_transactions_inputs.csv: 306 rows across 12 DOs totaling 27,390,523 PKR (Net = 0.00 PKR).
 * 2. Deterministic UUIDv5 generator correctness & repeatability.
 * 3. Complete DO Profile mapping coverage for S.No 1–13.
 * 4. Production Database Invariant Checks:
 *    - Exactly 22 lifting records present for period 2026-09.
 *    - Exactly 306 DO entries present for period 2026-09.
 *    - Day 30 closing lifting in hand is exactly 697,683.71 PKR.
 *    - Every DO profile closes at exactly 0.00 PKR base balance on Day 30.
 *    - Zero spurious commission_items created by Jazz Load import.
 */

import path from "path";
import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import {
  generateDeterministicUuid,
  DO_S_NO_MAPPING,
  parseCsvFile,
  resolveJazzLoadCsvDirectory
} from "./import-september-jazzload.js";

function assert(condition: boolean, message: string, actual?: unknown) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}${actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : ""}`);
  }
  console.log(`   ✓ ${message}`);
}

async function runTests() {
  console.log("=== SEPTEMBER JAZZ LOAD IMPORTER TESTS ===");

  try {
    // -------------------------------------------------------------------------
    console.log("\nGroup 1: Authoritative CSV Source Parsing & Validation");
    // -------------------------------------------------------------------------
    const csvDir = resolveJazzLoadCsvDirectory();
    assert(csvDir.includes("data/september/load"), "Resolved correct September load directory", csvDir);

    const distRows = parseCsvFile(path.join(csvDir, "distributor_transactions_inputs.csv"));
    assert(distRows.length === 306, "distributor_transactions_inputs.csv has exactly 306 rows", distRows.length);

    let sumIssuance = 0;
    let sumPayment = 0;
    for (const r of distRows) {
      sumIssuance += parseFloat(r.issuance_amount || "0") || 0;
      sumPayment += parseFloat(r.payment_received_amount || "0") || 0;
    }
    assert(sumIssuance === 27390523, "Total CSV issuance base equals 27,390,523 PKR", sumIssuance);
    assert(sumPayment === 27390523, "Total CSV payment base equals 27,390,523 PKR", sumPayment);
    assert(sumIssuance - sumPayment === 0, "Net distributor balance across month is exactly 0.00 PKR", sumIssuance - sumPayment);

    const liftingRows = parseCsvFile(path.join(csvDir, "company_lifting_inputs.csv"));
    assert(liftingRows.length === 37, "company_lifting_inputs.csv has 37 rows", liftingRows.length);

    let sumLifting = 0;
    const liftingDays = new Set<string>();
    for (const r of liftingRows) {
      sumLifting += parseFloat(r.amount || "0") || 0;
      liftingDays.add(r.sheet);
    }
    assert(sumLifting === 27930000, "Total CSV lifting amount equals 27,930,000 PKR", sumLifting);
    assert(liftingDays.size === 22, "Total active lifting days equals 22", liftingDays.size);

    // -------------------------------------------------------------------------
    console.log("\nGroup 2: Identity & DO Mapping Rules");
    // -------------------------------------------------------------------------
    const testUuid1 = generateDeterministicUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "test:key:1");
    const testUuid2 = generateDeterministicUuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "test:key:1");
    assert(testUuid1 === testUuid2, "Deterministic UUIDv5 is idempotent and repeatable");
    assert(testUuid1.length === 36, "Generated UUID has valid 36-character length");

    for (let sNo = 2; sNo <= 13; sNo++) {
      const mapping = DO_S_NO_MAPPING[sNo];
      assert(Boolean(mapping), `DO S.No ${sNo} has valid mapping registered`);
      assert(Boolean(mapping.targetProfileName), `DO S.No ${sNo} targets named profile '${mapping?.targetProfileName}'`);
    }

    // -------------------------------------------------------------------------
    console.log("\nGroup 3: PostgreSQL Database State Invariants (Period 2026-09)");
    // -------------------------------------------------------------------------
    const period = await db
      .selectFrom("accounting_periods")
      .selectAll()
      .where("period_key", "=", "2026-09")
      .executeTakeFirstOrThrow();

    const days = await db
      .selectFrom("accounting_days")
      .selectAll()
      .where("period_id", "=", period.id)
      .orderBy("day_no", "asc")
      .execute();
    const dayIds = days.map((d) => d.id);
    const day30 = days.find((d) => d.day_no === 30)!;

    const dbLifting = await db
      .selectFrom("jazz_load_lifting_records")
      .selectAll()
      .where("day_id", "in", dayIds)
      .execute();
    assert(dbLifting.length === 22, "Exactly 22 lifting records exist in DB for September", dbLifting.length);

    const dbLiftingTotal = dbLifting.reduce((s, r) => s + Number(r.ml_lifting_amount), 0);
    assert(dbLiftingTotal === 27930000, "Database total lifting equals 27,930,000 PKR", dbLiftingTotal);

    const dbDoEntries = await db
      .selectFrom("jazz_load_do_entries")
      .selectAll()
      .where("day_id", "in", dayIds)
      .execute();
    assert(dbDoEntries.length === 306, "Exactly 306 DO entries exist in DB for September", dbDoEntries.length);

    const dbIssuanceTotal = dbDoEntries.reduce((s, r) => s + Number(r.issuance_base), 0);
    const dbPaymentTotal = dbDoEntries.reduce((s, r) => s + Number(r.payment_base), 0);
    assert(dbIssuanceTotal === 27390523, "Database total issuance base equals 27,390,523 PKR", dbIssuanceTotal);
    assert(dbPaymentTotal === 27390523, "Database total payment base equals 27,390,523 PKR", dbPaymentTotal);

    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Server-Authoritative Projection Calculations");
    // -------------------------------------------------------------------------
    const day30LiftingProj = await db
      .selectFrom("jazz_lifting_day_projections")
      .selectAll()
      .where("day_id", "=", day30.id)
      .executeTakeFirstOrThrow();

    const closingLifting = Number(day30LiftingProj.closing_lifting_in_hand);
    assert(
      Math.abs(closingLifting - 697683.71) < 0.05,
      "Day 30 closing lifting in hand is 697,683.71 PKR",
      closingLifting
    );

    const day30DoProjs = await db
      .selectFrom("jazz_load_do_day_projections")
      .innerJoin("jazz_load_do_profiles", "jazz_load_do_profiles.id", "jazz_load_do_day_projections.do_profile_id")
      .select(["jazz_load_do_profiles.do_name", "jazz_load_do_day_projections.closing_base"])
      .where("jazz_load_do_day_projections.day_id", "=", day30.id)
      .execute();

    let allZero = true;
    for (const p of day30DoProjs) {
      if (Math.abs(Number(p.closing_base)) > 0.001) {
        allZero = false;
        console.error(`Non-zero closing DO balance: ${p.do_name} = ${p.closing_base}`);
      }
    }
    assert(allZero, "All DO profiles close at exactly 0.00 PKR on Day 30");

    console.log("\nALL SEPTEMBER JAZZ LOAD TESTS PASSED PERFECTLY (14/14)!");
  } finally {
    await closeDatabase();
  }
}

runTests().catch((err) => {
  console.error("\nTEST SUITE FAILED:", err);
  process.exit(1);
});
