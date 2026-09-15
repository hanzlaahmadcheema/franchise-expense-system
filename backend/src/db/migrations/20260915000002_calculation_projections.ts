import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Add Jazz DO Day Projections Table (Materialized Projection Cache)
  await sql`
    CREATE TABLE jazz_load_do_day_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE CASCADE,
        do_profile_id UUID NOT NULL REFERENCES jazz_load_do_profiles(id) ON DELETE RESTRICT,
        opening_base NUMERIC(15,2) NOT NULL,
        issuance_base NUMERIC(15,2) NOT NULL,
        payment_base NUMERIC(15,2) NOT NULL,
        closing_base NUMERIC(15,2) NOT NULL,
        opening_ml NUMERIC(15,2) NOT NULL,
        closing_ml NUMERIC(15,2) NOT NULL,
        applied_ml_rate_percentage NUMERIC(8,4) NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_jazz_load_do_day_projections UNIQUE (franchise_id, day_id, do_profile_id)
    );

    CREATE INDEX idx_jazz_do_projections_day
    ON jazz_load_do_day_projections (franchise_id, day_id);

    CREATE INDEX idx_jazz_do_projections_profile
    ON jazz_load_do_day_projections (franchise_id, do_profile_id);
  `.execute(db);

  // 2. Enhance day_financial_projections with Operating Profit, Jazz Company Payable, and Owner Opening
  await sql`
    ALTER TABLE day_financial_projections
    ADD COLUMN IF NOT EXISTS operating_profit NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS owner_opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS opening_jazz_payable NUMERIC(15,2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS closing_jazz_payable NUMERIC(15,2) NOT NULL DEFAULT 0.00;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS jazz_load_do_day_projections CASCADE;`.execute(db);

  await sql`
    ALTER TABLE day_financial_projections
    DROP COLUMN IF EXISTS operating_profit,
    DROP COLUMN IF EXISTS owner_opening_balance,
    DROP COLUMN IF EXISTS opening_jazz_payable,
    DROP COLUMN IF EXISTS closing_jazz_payable;
  `.execute(db);
}
