import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Enforce at most ONE open/reopen accounting day per period across a franchise
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_single_open_day_per_period 
    ON accounting_days (franchise_id, period_id) 
    WHERE status IN ('open', 'reopen');
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS uq_single_open_day_per_period;
  `.execute(db);
}
