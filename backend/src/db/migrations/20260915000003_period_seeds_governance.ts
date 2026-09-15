import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Ensure period_financial_seeds defaults is_verified to FALSE (explicit governance verification required)
  await sql`
    ALTER TABLE period_financial_seeds
    ALTER COLUMN is_verified SET DEFAULT FALSE;
  `.execute(db);

  // 2. Add verified_at timestamp to track the exact moment of governance verification
  await sql`
    ALTER TABLE period_financial_seeds
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE period_financial_seeds
    DROP COLUMN IF EXISTS verified_at;
  `.execute(db);

  await sql`
    ALTER TABLE period_financial_seeds
    ALTER COLUMN is_verified SET DEFAULT TRUE;
  `.execute(db);
}
