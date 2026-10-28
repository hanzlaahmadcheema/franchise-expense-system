import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create commission_settlement_receipts table
  await sql`
    CREATE TABLE IF NOT EXISTS commission_settlement_receipts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        source_period_key VARCHAR(7) NOT NULL,
        amount NUMERIC(15, 2) NOT NULL CHECK (amount >= 0),
        category_id UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
        category_name_snapshot VARCHAR(255),
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE INDEX IF NOT EXISTS idx_commission_settlement_receipts_day
    ON commission_settlement_receipts (franchise_id, day_id);

    CREATE INDEX IF NOT EXISTS idx_commission_settlement_receipts_source_period
    ON commission_settlement_receipts (franchise_id, source_period_key);

    CREATE TRIGGER trg_commission_settlement_receipts_immutability
    BEFORE UPDATE OR DELETE ON commission_settlement_receipts
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();

    CREATE TRIGGER trg_commission_settlement_receipts_updated_at
    BEFORE UPDATE ON commission_settlement_receipts
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  `.execute(db);

  // 2. Enhance accounting_periods with FINAL settlement governance columns
  await sql`
    ALTER TABLE accounting_periods
    ADD COLUMN IF NOT EXISTS final_settlement_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_SETTLEMENT',
    ADD COLUMN IF NOT EXISTS final_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS final_verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS final_notes TEXT;
  `.execute(db);

  // 3. Enhance period_financial_seeds with opening_commission_receivable
  await sql`
    ALTER TABLE period_financial_seeds
    ADD COLUMN IF NOT EXISTS opening_commission_receivable NUMERIC(15, 2) NOT NULL DEFAULT 0.00;
  `.execute(db);

  // 4. Enhance day_financial_projections with settlement receipts and receivable balances
  await sql`
    ALTER TABLE day_financial_projections
    ADD COLUMN IF NOT EXISTS commission_settlement_receipts NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS opening_commission_receivable NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS closing_commission_receivable NUMERIC(15, 2) NOT NULL DEFAULT 0.00;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_commission_settlement_receipts_immutability ON commission_settlement_receipts;
    DROP TRIGGER IF EXISTS trg_commission_settlement_receipts_updated_at ON commission_settlement_receipts;
    DROP TABLE IF EXISTS commission_settlement_receipts CASCADE;
  `.execute(db);

  await sql`
    ALTER TABLE accounting_periods
    DROP COLUMN IF EXISTS final_settlement_status,
    DROP COLUMN IF EXISTS final_verified_at,
    DROP COLUMN IF EXISTS final_verified_by_user_id,
    DROP COLUMN IF EXISTS final_notes;
  `.execute(db);

  await sql`
    ALTER TABLE period_financial_seeds
    DROP COLUMN IF EXISTS opening_commission_receivable;
  `.execute(db);

  await sql`
    ALTER TABLE day_financial_projections
    DROP COLUMN IF EXISTS commission_settlement_receipts,
    DROP COLUMN IF EXISTS opening_commission_receivable,
    DROP COLUMN IF EXISTS closing_commission_receivable;
  `.execute(db);
}
