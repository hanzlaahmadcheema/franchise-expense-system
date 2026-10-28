import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create stock_balance_transfers table
  await sql`
    CREATE TABLE stock_balance_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
      day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
      source_account_id UUID NOT NULL REFERENCES stock_accounts(id) ON DELETE RESTRICT,
      destination_account_id UUID NOT NULL REFERENCES stock_accounts(id) ON DELETE RESTRICT,
      amount NUMERIC(15, 2) NOT NULL,
      transfer_type VARCHAR(20) NOT NULL DEFAULT 'credit',
      reason TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'completed',
      reversal_of_id UUID NULL REFERENCES stock_balance_transfers(id) ON DELETE RESTRICT,
      reversed_at TIMESTAMPTZ NULL,
      reversed_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
      created_by_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
      idempotency_key VARCHAR(128) NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      CONSTRAINT chk_stock_transfers_amount CHECK (amount > 0),
      CONSTRAINT chk_stock_transfers_type CHECK (transfer_type IN ('credit', 'debt')),
      CONSTRAINT chk_stock_transfers_status CHECK (status IN ('completed', 'reversed')),
      CONSTRAINT chk_stock_transfers_distinct_accounts CHECK (source_account_id != destination_account_id)
    );
  `.execute(db);

  await sql`CREATE UNIQUE INDEX uq_stock_transfers_idempotency ON stock_balance_transfers (franchise_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`.execute(db);
  await sql`CREATE INDEX idx_stock_transfers_day ON stock_balance_transfers(franchise_id, day_id);`.execute(db);
  await sql`CREATE INDEX idx_stock_transfers_source ON stock_balance_transfers(franchise_id, source_account_id);`.execute(db);
  await sql`CREATE INDEX idx_stock_transfers_dest ON stock_balance_transfers(franchise_id, destination_account_id);`.execute(db);

  // 2. Add transfers_out_amount and transfers_in_amount columns to stock_account_day_projections
  await sql`
    ALTER TABLE stock_account_day_projections
    ADD COLUMN IF NOT EXISTS transfers_out_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00,
    ADD COLUMN IF NOT EXISTS transfers_in_amount NUMERIC(15, 2) NOT NULL DEFAULT 0.00;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE stock_account_day_projections
    DROP COLUMN IF EXISTS transfers_in_amount,
    DROP COLUMN IF EXISTS transfers_out_amount;
  `.execute(db);

  await sql`DROP TABLE IF EXISTS stock_balance_transfers;`.execute(db);
}
