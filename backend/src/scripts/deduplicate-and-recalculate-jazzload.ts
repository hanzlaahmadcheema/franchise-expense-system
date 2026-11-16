import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import { recalculateFromDayInternal } from "../calculations/engine.js";

async function main() {
  console.log("================================================================================");
  console.log(" JAZZ LOAD DEDUPLICATION & RECALCULATION SCRIPT");
  console.log("================================================================================");

  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();

  const octPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "=", "2026-10")
    .executeTakeFirstOrThrow();

  const novPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "=", "2026-11")
    .executeTakeFirstOrThrow();

  const octDays = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", octPeriod.id)
    .orderBy("day_no", "asc")
    .execute();

  const octDayMap = new Map(octDays.map((d) => [d.day_no, d]));

  const novDays = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", novPeriod.id)
    .orderBy("day_no", "asc")
    .execute();

  const novDayMap = new Map(novDays.map((d) => [d.day_no, d]));

  // 1. Identify Duplicates
  console.log("\n[1/5] Identifying duplicate rows in jazz_load_do_entries...");
  const duplicatesRes = await sql<{
    id: string;
    period_key: string;
    day_no: number;
    do_name_snapshot: string;
    issuance_base: string;
    payment_base: string;
    created_at: string;
  }>`
    WITH ranked AS (
      SELECT 
        e.id,
        p.period_key,
        d.day_no,
        e.do_name_snapshot,
        e.issuance_base,
        e.payment_base,
        e.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY e.franchise_id, e.day_id, e.do_profile_id 
          ORDER BY e.created_at ASC, e.id ASC
        ) as rn
      FROM jazz_load_do_entries e
      JOIN accounting_days d ON d.id = e.day_id
      JOIN accounting_periods p ON p.id = d.period_id
      WHERE (p.period_key = '2026-10' AND d.day_no IN (29, 30, 31))
         OR (p.period_key = '2026-11' AND d.day_no = 1)
    )
    SELECT period_key, day_no, do_name_snapshot, issuance_base, payment_base, id, created_at
    FROM ranked
    WHERE rn > 1
    ORDER BY period_key, day_no, do_name_snapshot;
  `.execute(db);

  const duplicateRows = duplicatesRes.rows;
  console.log(`Found ${duplicateRows.length} duplicate entries to delete:`);
  for (const r of duplicateRows) {
    console.log(`  - [${r.period_key} Day ${r.day_no}] DO: ${r.do_name_snapshot.padEnd(14)} Issuance: ${r.issuance_base.padStart(10)} Payment: ${r.payment_base.padStart(10)} ID: ${r.id}`);
  }

  if (duplicateRows.length === 0) {
    console.log("No duplicate rows found to delete. Proceeding to constraint verification & recalculation...");
  } else {
    const idsToDelete = duplicateRows.map((r) => r.id);

    // 2. Safely Remove Duplicates
    console.log("\n[2/5] Deleting duplicate rows while managing ledger immutability trigger...");
    await sql`ALTER TABLE jazz_load_do_entries DISABLE TRIGGER trg_jazz_load_do_entries_immutability;`.execute(db);

    try {
      const deleteRes = await db
        .deleteFrom("jazz_load_do_entries")
        .where("id", "in", idsToDelete)
        .executeTakeFirst();
      console.log(`✓ Deleted ${Number(deleteRes.numDeletedRows)} duplicate rows.`);
    } finally {
      await sql`ALTER TABLE jazz_load_do_entries ENABLE TRIGGER trg_jazz_load_do_entries_immutability;`.execute(db);
      console.log("✓ Re-enabled trg_jazz_load_do_entries_immutability trigger.");
    }
  }

  // 3. Create Unique Constraint to Permanently Prevent Duplicates
  console.log("\n[3/5] Applying permanent UNIQUE INDEX on (franchise_id, day_id, do_profile_id)...");
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_jazz_do_entries_day_profile 
    ON jazz_load_do_entries (franchise_id, day_id, do_profile_id);
  `.execute(db);
  console.log("✓ UNIQUE index uq_jazz_do_entries_day_profile active.");

  // 4. Recalculate October from Day 29 onward
  console.log("\n[4/5] Recalculating October 2026 day projections from Day 29 to 31...");
  const octDay29 = octDayMap.get(29)!;

  await db.transaction().execute(async (trx) => {
    await recalculateFromDayInternal(trx, franchise.id, octDay29.id, {
      triggerSource: "rebuild",
      allowClosedDays: true
    });
  });
  console.log("✓ October 2026 recalculation complete.");

  // Query new October 31 Closing
  const oct31Day = octDayMap.get(31)!;
  const oct31Lifting = await db
    .selectFrom("jazz_lifting_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "=", oct31Day.id)
    .executeTakeFirstOrThrow();

  console.log(`✓ New October 31 In-Hand Closing: ${oct31Lifting.closing_lifting_in_hand}`);

  // 5. Update November Opening Seed & Recalculate November from Day 1
  console.log("\n[5/5] Updating November 2026 opening seed & recalculating November period...");
  await db
    .updateTable("period_financial_seeds")
    .set({
      opening_jazz_lifting: oct31Lifting.closing_lifting_in_hand,
      updated_at: sql`clock_timestamp()`
    })
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", novPeriod.id)
    .execute();

  const novDay1 = novDayMap.get(1)!;
  await db.transaction().execute(async (trx) => {
    await recalculateFromDayInternal(trx, franchise.id, novDay1.id, {
      triggerSource: "rebuild",
      allowClosedDays: true
    });
  });
  console.log("✓ November 2026 recalculation complete.");

  // 6. Verification Queries
  console.log("\n================================================================================");
  console.log(" VERIFICATION & COMPARISON");
  console.log("================================================================================");

  const octLiftingProjections = await sql<{
    day_no: number;
    opening_lifting: string;
    ml_lifting_purchased: string;
    today_ml_issuance: string;
    closing_lifting_in_hand: string;
  }>`
    SELECT 
      d.day_no,
      l.opening_lifting,
      l.ml_lifting_purchased,
      l.today_ml_issuance,
      l.closing_lifting_in_hand
    FROM jazz_lifting_day_projections l
    JOIN accounting_days d ON d.id = l.day_id
    WHERE d.period_id = ${octPeriod.id} AND d.day_no BETWEEN 28 AND 31
    ORDER BY d.day_no;
  `.execute(db);

  console.log("\n--- October 2026 Lifting Projections (Days 28-31) ---");
  console.table(octLiftingProjections.rows);

  const novLiftingProjections = await sql<{
    day_no: number;
    opening_lifting: string;
    ml_lifting_purchased: string;
    today_ml_issuance: string;
    closing_lifting_in_hand: string;
  }>`
    SELECT 
      d.day_no,
      l.opening_lifting,
      l.ml_lifting_purchased,
      l.today_ml_issuance,
      l.closing_lifting_in_hand
    FROM jazz_lifting_day_projections l
    JOIN accounting_days d ON d.id = l.day_id
    WHERE d.period_id = ${novPeriod.id} AND d.day_no BETWEEN 1 AND 5
    ORDER BY d.day_no;
  `.execute(db);

  console.log("\n--- November 2026 Lifting Projections (Days 1-5) ---");
  console.table(novLiftingProjections.rows);

  await closeDatabase();
  console.log("\n✓ Deduplication and recalculation script finished successfully.");
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
