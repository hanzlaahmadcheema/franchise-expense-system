import { db, closeDatabase } from "/home/hanzlaahmad/PersonalProjects/Franchise/backend/src/config/database.js";

async function main() {
  try {
    const period = await db.selectFrom("accounting_periods").selectAll().where("period_key", "=", "2026-09").executeTakeFirst();
    const day1 = await db.selectFrom("accounting_days").selectAll().where("period_id", "=", period!.id).where("day_no", "=", 1).executeTakeFirst();
    const liftingProj = await db.selectFrom("jazz_lifting_day_projections").selectAll().where("day_id", "=", day1!.id).executeTakeFirst();
    console.log("Day 1 Lifting Projection in DB:", liftingProj);

    const doProjs = await db.selectFrom("jazz_load_do_day_projections as jp")
      .innerJoin("jazz_load_do_profiles as pr", "pr.id", "jp.do_profile_id")
      .select([
        "pr.do_name",
        "jp.opening_base",
        "jp.issuance_base",
        "jp.payment_base",
        "jp.closing_base"
      ])
      .where("jp.day_id", "=", day1!.id)
      .execute();
    console.log("Day 1 DO Projections in DB:", doProjs);
  } finally {
    await closeDatabase();
  }
}

main().catch(console.error);
