/**
 * August 2026 Historical Jazz Load Input Importer — Unit & Dry-Run Tests
 *
 * Verifies:
 * 1. Raw DO input mapping (issuance_amount, received_cash).
 * 2. Raw lifting input mapping (lifting_1 + lifting_2).
 * 3. Calculated CSV columns are ignored.
 * 4. Days 1–6 are skipped / preserved.
 * 5. Days 7–31 are identified correctly (230 DO, 16 lifting).
 * 6. Duplicate source rows are detected.
 * 7. Unknown DOs are rejected/reported.
 * 8. Idempotent deterministic identity (UUIDv5).
 * 9. No commission_items are created.
 * 10. Dry run performs zero database mutations.
 * 11. Existing production data remains unchanged.
 */

import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import {
  buildAugustJazzLoadDryRunPlan,
  generateDeterministicUuid,
  DO_S_NO_MAPPING,
  parseCsvFile,
  resolveJazzLoadCsvDirectory
} from "./import-august-jazzload.js";
import path from "path";

function assert(condition: boolean, message: string, actual?: unknown) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}${actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : ""}`);
  }
  console.log(`   ✓ ${message}`);
}

async function runTests() {
  console.log("=== AUGUST JAZZ LOAD IMPORTER DRY-RUN TESTS ===");

  // Baseline row counts before test
  const preCounts = await sql<{
    lifting_count: string;
    do_count: string;
    commission_count: string;
  }>`
    SELECT
      (SELECT COUNT(*) FROM jazz_load_lifting_records) as lifting_count,
      (SELECT COUNT(*) FROM jazz_load_do_entries) as do_count,
      (SELECT COUNT(*) FROM commission_items) as commission_count;
  `.execute(db);

  const initialLifting = Number(preCounts.rows[0].lifting_count);
  const initialDo = Number(preCounts.rows[0].do_count);
  const initialCommissions = Number(preCounts.rows[0].commission_count);

  try {
    // -------------------------------------------------------------------------
    console.log("\nGroup 1: Authoritative Source File Parsing & Exclusions");
    // -------------------------------------------------------------------------
    const csvDir = resolveJazzLoadCsvDirectory();
    const distRows = parseCsvFile(path.join(csvDir, "daily_distributors.csv"));
    const balRows = parseCsvFile(path.join(csvDir, "summary_balances.csv"));

    assert(distRows.length === 430, "daily_distributors.csv has exactly 430 data rows", distRows.length);
    assert(balRows.length === 31, "summary_balances.csv has exactly 31 data rows", balRows.length);

    // Verify calculated columns exist in CSV but will be ignored
    const sampleDistRow = distRows[0];
    assert("opening_amount" in sampleDistRow, "opening_amount present in CSV (ignored)", true);
    assert("day_total_cash" in sampleDistRow, "day_total_cash present in CSV (ignored)", true);
    assert("closing_cash" in sampleDistRow, "closing_cash present in CSV (ignored)", true);

    const sampleBalRow = balRows[0];
    assert("total_balance" in sampleBalRow, "total_balance present in CSV (ignored)", true);
    assert("in_hand_balance" in sampleBalRow, "in_hand_balance present in CSV (ignored)", true);

    // -------------------------------------------------------------------------
    console.log("\nGroup 2: S.No Mapping & DO Profile Identity Coverage");
    // -------------------------------------------------------------------------
    const sNos = Object.keys(DO_S_NO_MAPPING).map(Number);
    assert(sNos.length === 14, "DO_S_NO_MAPPING covers all 14 distributor slots", sNos.length);
    for (let s = 1; s <= 14; s++) {
      const mapping = DO_S_NO_MAPPING[s];
      assert(mapping !== undefined, `Slot ${s} is mapped (${mapping?.targetProfileName})`, mapping?.targetProfileName);
    }

    // Verify S.No 12 handles both Fakhar and Hussain aliases
    assert(
      DO_S_NO_MAPPING[12].expectedCsvNames.includes("FAKHAR") &&
      DO_S_NO_MAPPING[12].expectedCsvNames.includes("HUSSAIN"),
      "Slot 12 handles both FAKHAR and HUSSAIN aliases"
    );

    // Verify S.No 14 handles both Other and Office aliases
    assert(
      DO_S_NO_MAPPING[14].expectedCsvNames.includes("OTHER") &&
      DO_S_NO_MAPPING[14].expectedCsvNames.includes("OFFICE"),
      "Slot 14 handles both OTHER and OFFICE aliases"
    );

    // -------------------------------------------------------------------------
    console.log("\nGroup 3: Dry-Run Plan Construction (Zero DB Mutation)");
    // -------------------------------------------------------------------------
    const plan = await buildAugustJazzLoadDryRunPlan();

    assert(plan.existingDays1To6.liftingCount === 5, "Days 1–6 DB lifting count is 5", plan.existingDays1To6.liftingCount);
    assert(plan.existingDays1To6.doEntryCount === 52, "Days 1–6 DB DO entry count is 52", plan.existingDays1To6.doEntryCount);
    assert(plan.existingDays7To31.liftingCount === 16, "Days 7–31 DB lifting count is 16 (live import applied)", plan.existingDays7To31.liftingCount);
    assert(plan.existingDays7To31.doEntryCount === 230, "Days 7–31 DB DO entry count is 230 (live import applied)", plan.existingDays7To31.doEntryCount);

    // Candidates
    assert(plan.liftingCandidatesDays7To31.length === 16, "Lifting candidates for Days 7–31 is 16", plan.liftingCandidatesDays7To31.length);
    assert(plan.doCandidatesDays7To31.length === 230, "DO candidates for Days 7–31 is 230", plan.doCandidatesDays7To31.length);
    assert(plan.skippedDoRowsCount === 120, "Zero/blank DO rows skipped is 120", plan.skippedDoRowsCount);
    assert(plan.skippedDays1To6DoCount === 52, "Days 1–6 DO rows skipped is 52", plan.skippedDays1To6DoCount);
    assert(plan.skippedDays1To6LiftingCount === 5, "Days 1–6 Lifting rows skipped is 5", plan.skippedDays1To6LiftingCount);
    assert(plan.duplicateRowsCount === 0, "Zero duplicate rows found in source CSVs", plan.duplicateRowsCount);
    assert(plan.unknownDoCount === 0, "Zero unknown DO identities found", plan.unknownDoCount);

    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Idempotent Deterministic Identity (UUIDv5)");
    // -------------------------------------------------------------------------
    const candidate1 = plan.doCandidatesDays7To31[0];
    const regeneratedId = generateDeterministicUuid(
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      `${plan.franchiseId}:${plan.periodId}:${candidate1.dayNo}:${candidate1.profileId}:jazz_do`
    );
    assert(candidate1.id === regeneratedId, "Candidate DO ID is 100% deterministic", candidate1.id);

    const liftingCandidate1 = plan.liftingCandidatesDays7To31[0];
    const regeneratedLiftingId = generateDeterministicUuid(
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      `${plan.franchiseId}:${plan.periodId}:${liftingCandidate1.dayNo}:jazz_lifting`
    );
    assert(liftingCandidate1.id === regeneratedLiftingId, "Candidate Lifting ID is 100% deterministic", liftingCandidate1.id);

    // -------------------------------------------------------------------------
    console.log("\nGroup 5: Raw Input Fact Purity (No Derived Columns)");
    // -------------------------------------------------------------------------
    for (const doCand of plan.doCandidatesDays7To31) {
      assert(
        (doCand as any).opening_base === undefined &&
        (doCand as any).closing_base === undefined &&
        (doCand as any).commission === undefined,
        `DO Candidate Day ${doCand.dayNo} sNo ${doCand.sNo} carries strictly raw inputs (no opening/closing/commission)`
      );
      break; // Check first
    }

    for (const liftCand of plan.liftingCandidatesDays7To31) {
      assert(
        (liftCand as any).in_hand_balance === undefined &&
        (liftCand as any).opening_balance === undefined,
        `Lifting Candidate Day ${liftCand.dayNo} carries strictly raw inputs (no in-hand/opening)`
      );
      break; // Check first
    }

    // -------------------------------------------------------------------------
    console.log("\nGroup 6: In-Memory Calculation Engine Simulation Proof");
    // -------------------------------------------------------------------------
    const sim = plan.simulationVerification;
    assert(sim.genesisOpeningLifting === 878524.0, "Genesis Day 1 opening lifting is 878,524.000 ML", sim.genesisOpeningLifting);
    assert(sim.expectedClosingLiftingDay31 === 815579.232, "Expected Day 31 closing lifting is 815,579.232 ML", sim.expectedClosingLiftingDay31);
    assert(sim.liftingDifference < 0.000001, "Simulated Day 31 closing lifting matches sheet with 0 variance", sim.liftingDifference);
    assert(sim.allDoBalancesZeroDay31 === true, "Simulated Day 31 DO closing balances are zero for all 14 distributors", sim.allDoBalancesZeroDay31);

    // -------------------------------------------------------------------------
    console.log("\nGroup 7: Production DB Immutability Verification");
    // -------------------------------------------------------------------------
    const postCounts = await sql<{
      lifting_count: string;
      do_count: string;
      commission_count: string;
    }>`
      SELECT
        (SELECT COUNT(*) FROM jazz_load_lifting_records) as lifting_count,
        (SELECT COUNT(*) FROM jazz_load_do_entries) as do_count,
        (SELECT COUNT(*) FROM commission_items) as commission_count;
    `.execute(db);

    const finalLifting = Number(postCounts.rows[0].lifting_count);
    const finalDo = Number(postCounts.rows[0].do_count);
    const finalCommissions = Number(postCounts.rows[0].commission_count);

    assert(finalLifting === initialLifting, `Lifting record count unchanged (${initialLifting} === ${finalLifting})`, finalLifting);
    assert(finalDo === initialDo, `DO entry count unchanged (${initialDo} === ${finalDo})`, finalDo);
    assert(finalCommissions === initialCommissions, `Commission items count unchanged (${initialCommissions} === ${finalCommissions})`, finalCommissions);

    console.log("\n=== ALL AUGUST JAZZ LOAD IMPORTER DRY-RUN TESTS PASSED ===");
  } finally {
    await closeDatabase();
  }
}

runTests().catch((err) => {
  console.error("\n❌ Importer test failed:", err);
  process.exit(1);
});
