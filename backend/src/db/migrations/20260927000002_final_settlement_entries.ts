import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Create final_settlement_entries table
  await sql`
    CREATE TABLE IF NOT EXISTS final_settlement_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        source_period_key VARCHAR(7) NOT NULL,
        settlement_date DATE NOT NULL,
        balance_domain VARCHAR(50) NOT NULL,
        settlement_type VARCHAR(50) NOT NULL,
        target_entity_id UUID,
        target_entity_name VARCHAR(255),
        amount NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
        source_reference VARCHAR(255),
        notes TEXT,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        target_day_id UUID REFERENCES accounting_days(id) ON DELETE SET NULL,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );

    CREATE INDEX IF NOT EXISTS idx_final_settlement_entries_period
    ON final_settlement_entries (franchise_id, period_id);

    CREATE INDEX IF NOT EXISTS idx_final_settlement_entries_source_period
    ON final_settlement_entries (franchise_id, source_period_key);

    CREATE INDEX IF NOT EXISTS idx_final_settlement_entries_domain
    ON final_settlement_entries (franchise_id, balance_domain);

    CREATE INDEX IF NOT EXISTS idx_final_settlement_entries_target_entity
    ON final_settlement_entries (franchise_id, target_entity_id);

    -- 2. Link commission_settlement_receipts to final_settlement_entries
    ALTER TABLE commission_settlement_receipts
    ADD COLUMN IF NOT EXISTS final_settlement_entry_id UUID REFERENCES final_settlement_entries(id) ON DELETE SET NULL;

    -- 3. Immutability trigger on UPDATE and DELETE
    CREATE OR REPLACE FUNCTION trg_enforce_final_settlement_immutability()
    RETURNS TRIGGER AS $$
    DECLARE
        p_status VARCHAR(20);
        p_final_status VARCHAR(30);
        p_key VARCHAR(7);
    BEGIN
        SELECT status, final_settlement_status, period_key
        INTO p_status, p_final_status, p_key
        FROM accounting_periods
        WHERE id = OLD.period_id;

        IF p_status = 'closed' OR p_final_status IN ('VERIFIED', 'CLOSED') THEN
            -- Allow downstream target_day_id pointer assignment during rollover if all financial accounting fields are untouched
            IF TG_OP = 'UPDATE' AND
               OLD.franchise_id = NEW.franchise_id AND
               OLD.period_id = NEW.period_id AND
               OLD.source_period_key = NEW.source_period_key AND
               OLD.settlement_date = NEW.settlement_date AND
               OLD.balance_domain = NEW.balance_domain AND
               OLD.settlement_type = NEW.settlement_type AND
               OLD.amount = NEW.amount AND
               (OLD.target_entity_id IS NOT DISTINCT FROM NEW.target_entity_id) AND
               (OLD.target_entity_name IS NOT DISTINCT FROM NEW.target_entity_name) AND
               (OLD.source_reference IS NOT DISTINCT FROM NEW.source_reference) AND
               (OLD.notes IS NOT DISTINCT FROM NEW.notes) AND
               (OLD.status = NEW.status) AND
               (OLD.target_day_id IS NULL AND NEW.target_day_id IS NOT NULL) THEN
                RETURN NEW;
            END IF;

            RAISE EXCEPTION 'Month-End Settlement Violation: Cannot % settlement record on a VERIFIED or CLOSED period (period: %, status: %, final_status: %). Period/FINAL must be reopened by an authorized Owner.',
                TG_OP, p_key, p_status, p_final_status
            USING ERRCODE = '55000';
        END IF;

        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        ELSE
            RETURN NEW;
        END IF;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_final_settlement_entries_immutability
    BEFORE UPDATE OR DELETE ON final_settlement_entries
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_final_settlement_immutability();

    -- 4. Guard against INSERT onto VERIFIED or CLOSED period
    CREATE OR REPLACE FUNCTION trg_enforce_final_settlement_insert()
    RETURNS TRIGGER AS $$
    DECLARE
        p_status VARCHAR(20);
        p_final_status VARCHAR(30);
        p_key VARCHAR(7);
    BEGIN
        SELECT status, final_settlement_status, period_key
        INTO p_status, p_final_status, p_key
        FROM accounting_periods
        WHERE id = NEW.period_id;

        IF p_status = 'closed' OR p_final_status IN ('VERIFIED', 'CLOSED') THEN
            RAISE EXCEPTION 'Month-End Settlement Violation: Cannot add settlement record to a VERIFIED or CLOSED period (period: %, status: %, final_status: %). Period/FINAL must be reopened by an authorized Owner.',
                p_key, p_status, p_final_status
            USING ERRCODE = '55000';
        END IF;

        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    CREATE TRIGGER trg_final_settlement_entries_insert
    BEFORE INSERT ON final_settlement_entries
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_final_settlement_insert();

    -- 5. Updated_at trigger
    CREATE TRIGGER trg_final_settlement_entries_updated_at
    BEFORE UPDATE ON final_settlement_entries
    FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TRIGGER IF EXISTS trg_final_settlement_entries_updated_at ON final_settlement_entries;
    DROP TRIGGER IF EXISTS trg_final_settlement_entries_insert ON final_settlement_entries;
    DROP FUNCTION IF EXISTS trg_enforce_final_settlement_insert();
    DROP TRIGGER IF EXISTS trg_final_settlement_entries_immutability ON final_settlement_entries;
    DROP FUNCTION IF EXISTS trg_enforce_final_settlement_immutability();
    ALTER TABLE commission_settlement_receipts DROP COLUMN IF EXISTS final_settlement_entry_id;
    DROP TABLE IF EXISTS final_settlement_entries CASCADE;
  `.execute(db);
}
