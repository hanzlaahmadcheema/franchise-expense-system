import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Data cleanup: clear residual closed_at and closed_by_user_id for any open or reopened day
  await sql`
    UPDATE accounting_days
    SET closed_at = NULL, closed_by_user_id = NULL
    WHERE status IN ('open', 'reopen');
  `.execute(db);

  // 2. Add consistency CHECK constraint:
  // Open and reopened days must not have closed_at or closed_by_user_id populated
  await sql`
    ALTER TABLE accounting_days
    ADD CONSTRAINT chk_accounting_days_open_closed_at_null
    CHECK (status = 'closed' OR (closed_at IS NULL AND closed_by_user_id IS NULL));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE accounting_days
    DROP CONSTRAINT IF EXISTS chk_accounting_days_open_closed_at_null;
  `.execute(db);
}
