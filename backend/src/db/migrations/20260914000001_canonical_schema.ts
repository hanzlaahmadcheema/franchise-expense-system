import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // =========================================================================
  // 1. SUPPORTING FUNCTIONS & EXTENSIONS
  // =========================================================================
  await sql`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`.execute(db);

  // Trigger function: Closed-Day Financial Immutability
  await sql`
    CREATE OR REPLACE FUNCTION trg_enforce_ledger_immutability()
    RETURNS TRIGGER AS $$
    DECLARE
        target_day_id UUID;
        target_day_status VARCHAR(16);
        day_no_val INT;
    BEGIN
        -- Resolve day_id for child records
        IF TG_TABLE_NAME = 'stock_order_lines' THEN
            SELECT day_id INTO target_day_id FROM stock_orders WHERE id = OLD.stock_order_id;
        ELSE
            target_day_id := OLD.day_id;
        END IF;

        IF target_day_id IS NOT NULL THEN
            SELECT status, day_no INTO target_day_status, day_no_val 
            FROM accounting_days 
            WHERE id = target_day_id;

            IF target_day_status = 'closed' THEN
                RAISE EXCEPTION 'Financial Ledger Violation: Cannot % record on a closed accounting day (day_no: %, day_id: %). Day must be reopened by an authorized Owner.', 
                    TG_OP, day_no_val, target_day_id
                USING ERRCODE = '55000';
            END IF;
        END IF;

        IF TG_OP = 'DELETE' THEN
            RETURN OLD;
        ELSE
            RETURN NEW;
        END IF;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // Trigger function: Automatically manage updated_at timestamps
  await sql`
    CREATE OR REPLACE FUNCTION trg_set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
        NEW.updated_at = clock_timestamp();
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `.execute(db);

  // =========================================================================
  // 2. GROUP 1: TENANCY, ACCESS & IDENTITY (4 tables)
  // =========================================================================

  // 1. franchises
  await sql`
    CREATE TABLE franchises (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        code VARCHAR(32) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        brand_name VARCHAR(255) NOT NULL DEFAULT 'Jazz Franchise - 7301',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // 2. users
  await sql`
    CREATE TABLE users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        firebase_uid VARCHAR(128) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        display_name VARCHAR(255),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // 3. franchise_users
  await sql`
    CREATE TABLE franchise_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role VARCHAR(32) NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_franchise_users UNIQUE (franchise_id, user_id)
    );
  `.execute(db);

  // 4. authorized_emails
  await sql`
    CREATE TABLE authorized_emails (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        email VARCHAR(255) NOT NULL,
        role VARCHAR(32) NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_authorized_emails UNIQUE (franchise_id, email)
    );
  `.execute(db);

  // =========================================================================
  // 3. GROUP 2: ACCOUNTING CALENDAR & BOUNDARY CONTROL (2 tables)
  // =========================================================================

  // 5. accounting_periods
  await sql`
    CREATE TABLE accounting_periods (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_key VARCHAR(7) NOT NULL,
        year_num INT NOT NULL CHECK (year_num >= 2020),
        month_num INT NOT NULL CHECK (month_num BETWEEN 1 AND 12),
        label VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
        closed_at TIMESTAMPTZ,
        closed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reopened_at TIMESTAMPTZ,
        reopened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_accounting_periods UNIQUE (franchise_id, period_key)
    );
  `.execute(db);

  // 6. accounting_days
  await sql`
    CREATE TABLE accounting_days (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        day_no INT NOT NULL CHECK (day_no BETWEEN 1 AND 32),
        day_type VARCHAR(16) NOT NULL DEFAULT 'calendar' CHECK (day_type IN ('calendar', 'settlement')),
        calendar_date DATE NOT NULL,
        label VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'reopen')),
        closed_at TIMESTAMPTZ,
        closed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reopened_at TIMESTAMPTZ,
        reopened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        reopened_until_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_accounting_days_period_no UNIQUE (franchise_id, period_id, day_no)
    );

    CREATE UNIQUE INDEX uq_calendar_date ON accounting_days (franchise_id, calendar_date) 
    WHERE day_type = 'calendar';
  `.execute(db);

  // =========================================================================
  // 4. GROUP 3: MASTER CATALOGS & RATE CONFIGURATIONS (7 tables)
  // =========================================================================

  // 7. expense_categories
  await sql`
    CREATE TABLE expense_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_expense_categories UNIQUE (franchise_id, slug)
    );
  `.execute(db);

  // 8. commission_categories
  await sql`
    CREATE TABLE commission_categories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_commission_categories UNIQUE (franchise_id, slug)
    );
  `.execute(db);

  // 9. credit_parties
  await sql`
    CREATE TABLE credit_parties (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(32) NOT NULL DEFAULT 'dealer' CHECK (type IN ('dealer', 'dso', 'staff', 'external', 'other')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INT NOT NULL DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_credit_parties UNIQUE (franchise_id, slug)
    );
  `.execute(db);

  // 10. jazz_load_rates
  await sql`
    CREATE TABLE jazz_load_rates (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        name VARCHAR(100) NOT NULL DEFAULT 'Standard Rates',
        ml_rate NUMERIC(8,4) NOT NULL DEFAULT 2.6000 CHECK (ml_rate >= 0),
        comm1_rate NUMERIC(8,4) NOT NULL DEFAULT 1.2500 CHECK (comm1_rate >= 0),
        comm2_rate NUMERIC(8,4) NOT NULL DEFAULT 0.0000 CHECK (comm2_rate >= 0),
        effective_from DATE NOT NULL DEFAULT '2026-01-01',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // 11. jazz_load_do_profiles
  await sql`
    CREATE TABLE jazz_load_do_profiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        do_name VARCHAR(100) NOT NULL,
        do_line VARCHAR(32),
        sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_jazz_load_do_profiles UNIQUE (franchise_id, do_name, do_line)
    );
  `.execute(db);

  // 12. stock_products
  await sql`
    CREATE TABLE stock_products (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        rate NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (rate >= 0),
        payment_tracking_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        category VARCHAR(64),
        sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_stock_products UNIQUE (franchise_id, slug)
    );
  `.execute(db);

  // 13. stock_accounts
  await sql`
    CREATE TABLE stock_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        slug VARCHAR(64) NOT NULL,
        name VARCHAR(100) NOT NULL,
        type VARCHAR(32) NOT NULL DEFAULT 'CCR' CHECK (type IN ('DO', 'CCR', 'DSO', 'STOCK', 'OTHER')),
        sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_stock_accounts UNIQUE (franchise_id, slug)
    );
  `.execute(db);

  // =========================================================================
  // 5. GROUP 4: STRONGLY-TYPED OPENING SEEDS (5 tables)
  // =========================================================================

  // 14. period_financial_seeds
  await sql`
    CREATE TABLE period_financial_seeds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        opening_cash NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        opening_owner_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        opening_jazz_lifting NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        opening_jazz_payable NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        source_period_key VARCHAR(7),
        source_day_no INT,
        verified_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        is_verified BOOLEAN NOT NULL DEFAULT TRUE,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_period_financial_seeds UNIQUE (franchise_id, period_id)
    );
  `.execute(db);

  // 15. period_credit_party_seeds
  await sql`
    CREATE TABLE period_credit_party_seeds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        party_id UUID NOT NULL REFERENCES credit_parties(id) ON DELETE RESTRICT,
        opening_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        source_period_key VARCHAR(7),
        source_day_no INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_period_credit_party_seeds UNIQUE (franchise_id, period_id, party_id)
    );
  `.execute(db);

  // 16. period_stock_product_seeds
  await sql`
    CREATE TABLE period_stock_product_seeds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        product_id UUID NOT NULL REFERENCES stock_products(id) ON DELETE RESTRICT,
        opening_quantity INT NOT NULL DEFAULT 0 CHECK (opening_quantity >= 0),
        source_period_key VARCHAR(7),
        source_day_no INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_period_stock_product_seeds UNIQUE (franchise_id, period_id, product_id)
    );
  `.execute(db);

  // 17. period_stock_account_seeds
  await sql`
    CREATE TABLE period_stock_account_seeds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        account_id UUID NOT NULL REFERENCES stock_accounts(id) ON DELETE RESTRICT,
        opening_receivable NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        source_period_key VARCHAR(7),
        source_day_no INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_period_stock_account_seeds UNIQUE (franchise_id, period_id, account_id)
    );
  `.execute(db);

  // 18. period_jazz_do_seeds
  await sql`
    CREATE TABLE period_jazz_do_seeds (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE RESTRICT,
        do_profile_id UUID NOT NULL REFERENCES jazz_load_do_profiles(id) ON DELETE RESTRICT,
        opening_base_balance NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        source_period_key VARCHAR(7),
        source_day_no INT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_period_jazz_do_seeds UNIQUE (franchise_id, period_id, do_profile_id)
    );
  `.execute(db);

  // =========================================================================
  // 6. GROUP 5: IMMUTABLE RAW TRANSACTION FACT LEDGERS (10 tables)
  // =========================================================================

  // 19. expense_items
  await sql`
    CREATE TABLE expense_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        category_id UUID REFERENCES expense_categories(id) ON DELETE SET NULL,
        category_name_snapshot VARCHAR(100) NOT NULL,
        item_name VARCHAR(150) NOT NULL,
        description TEXT,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_expense_items_immutability
    BEFORE UPDATE OR DELETE ON expense_items
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 20. commission_items
  await sql`
    CREATE TABLE commission_items (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        category_id UUID REFERENCES commission_categories(id) ON DELETE SET NULL,
        category_name_snapshot VARCHAR(100) NOT NULL,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_commission_items_immutability
    BEFORE UPDATE OR DELETE ON commission_items
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 21. credit_transactions
  await sql`
    CREATE TABLE credit_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        party_id UUID NOT NULL REFERENCES credit_parties(id) ON DELETE RESTRICT,
        party_name_snapshot VARCHAR(100) NOT NULL,
        loan_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (loan_amount >= 0),
        receipt_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (receipt_amount >= 0),
        manual_adjustment NUMERIC(15,2) NOT NULL DEFAULT 0.00,
        loan_description TEXT,
        receive_description TEXT,
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT chk_credit_activity CHECK (loan_amount > 0 OR receipt_amount > 0 OR manual_adjustment <> 0)
    );
    CREATE TRIGGER trg_credit_transactions_immutability
    BEFORE UPDATE OR DELETE ON credit_transactions
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 22. owner_transactions
  await sql`
    CREATE TABLE owner_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        description TEXT NOT NULL,
        amount NUMERIC(15,2) NOT NULL CHECK (amount <> 0),
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_owner_transactions_immutability
    BEFORE UPDATE OR DELETE ON owner_transactions
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 23. jazz_load_lifting_records
  await sql`
    CREATE TABLE jazz_load_lifting_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        ml_lifting_amount NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (ml_lifting_amount >= 0),
        notes TEXT,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_jazz_lifting_day UNIQUE (franchise_id, day_id)
    );
    CREATE TRIGGER trg_jazz_load_lifting_immutability
    BEFORE UPDATE OR DELETE ON jazz_load_lifting_records
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 24. jazz_load_do_entries
  await sql`
    CREATE TABLE jazz_load_do_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        do_profile_id UUID NOT NULL REFERENCES jazz_load_do_profiles(id) ON DELETE RESTRICT,
        do_name_snapshot VARCHAR(100) NOT NULL,
        do_line_snapshot VARCHAR(32),
        issuance_base NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (issuance_base >= 0),
        payment_base NUMERIC(15,2) NOT NULL DEFAULT 0.00 CHECK (payment_base >= 0),
        applied_ml_rate_percentage NUMERIC(8,4) NOT NULL DEFAULT 2.6000,
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT chk_jazz_do_activity CHECK (issuance_base > 0 OR payment_base > 0)
    );
    CREATE TRIGGER trg_jazz_load_do_entries_immutability
    BEFORE UPDATE OR DELETE ON jazz_load_do_entries
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 25. stock_orders
  await sql`
    CREATE TABLE stock_orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        direction VARCHAR(16) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        account_id UUID REFERENCES stock_accounts(id) ON DELETE RESTRICT,
        account_name_snapshot VARCHAR(100),
        supplier_name VARCHAR(100) DEFAULT 'Jazz Company',
        invoice_reference VARCHAR(64),
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_stock_orders_immutability
    BEFORE UPDATE OR DELETE ON stock_orders
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 26. stock_order_lines
  await sql`
    CREATE TABLE stock_order_lines (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        stock_order_id UUID NOT NULL REFERENCES stock_orders(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES stock_products(id) ON DELETE RESTRICT,
        product_name_snapshot VARCHAR(100) NOT NULL,
        unit_rate NUMERIC(15,2) NOT NULL CHECK (unit_rate >= 0),
        quantity INT NOT NULL CHECK (quantity > 0),
        line_amount NUMERIC(15,2) GENERATED ALWAYS AS (quantity * unit_rate) STORED,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_stock_order_lines_immutability
    BEFORE UPDATE OR DELETE ON stock_order_lines
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 27. stock_account_payments
  await sql`
    CREATE TABLE stock_account_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        account_id UUID NOT NULL REFERENCES stock_accounts(id) ON DELETE RESTRICT,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        payment_method VARCHAR(32) NOT NULL DEFAULT 'cash',
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_stock_account_payments_immutability
    BEFORE UPDATE OR DELETE ON stock_account_payments
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // 28. jazz_company_payable_payments
  await sql`
    CREATE TABLE jazz_company_payable_payments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE RESTRICT,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE RESTRICT,
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        payment_reference VARCHAR(128),
        notes TEXT,
        revision INT NOT NULL DEFAULT 1,
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TRIGGER trg_jazz_payable_payments_immutability
    BEFORE UPDATE OR DELETE ON jazz_company_payable_payments
    FOR EACH ROW EXECUTE FUNCTION trg_enforce_ledger_immutability();
  `.execute(db);

  // =========================================================================
  // 7. GROUP 6: MATERIALIZED PROJECTION CACHES (5 tables)
  // =========================================================================

  // 29. day_financial_projections
  await sql`
    CREATE TABLE day_financial_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE CASCADE,
        opening_cash NUMERIC(15,2) NOT NULL,
        total_issues NUMERIC(15,2) NOT NULL,
        total_expenses NUMERIC(15,2) NOT NULL,
        closing_cash NUMERIC(15,2) NOT NULL,
        owner_closing_balance NUMERIC(15,2) NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        calculation_version INT NOT NULL DEFAULT 2,
        calc_run_id UUID,
        CONSTRAINT uq_day_financial_projections UNIQUE (franchise_id, day_id)
    );
  `.execute(db);

  // 30. credit_party_day_projections
  await sql`
    CREATE TABLE credit_party_day_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE CASCADE,
        party_id UUID NOT NULL REFERENCES credit_parties(id) ON DELETE CASCADE,
        opening_balance NUMERIC(15,2) NOT NULL,
        total_loans NUMERIC(15,2) NOT NULL,
        total_receipts NUMERIC(15,2) NOT NULL,
        manual_adjustments NUMERIC(15,2) NOT NULL,
        closing_balance NUMERIC(15,2) NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_credit_party_day_projections UNIQUE (franchise_id, day_id, party_id)
    );
  `.execute(db);

  // 31. stock_product_day_projections
  await sql`
    CREATE TABLE stock_product_day_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES stock_products(id) ON DELETE CASCADE,
        opening_qty INT NOT NULL,
        stock_in_qty INT NOT NULL,
        stock_out_qty INT NOT NULL,
        closing_qty INT NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_stock_product_day_projections UNIQUE (franchise_id, day_id, product_id)
    );
  `.execute(db);

  // 32. stock_account_day_projections
  await sql`
    CREATE TABLE stock_account_day_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE CASCADE,
        account_id UUID NOT NULL REFERENCES stock_accounts(id) ON DELETE CASCADE,
        opening_due NUMERIC(15,2) NOT NULL,
        stock_taken_amount NUMERIC(15,2) NOT NULL,
        payment_received_amount NUMERIC(15,2) NOT NULL,
        closing_due NUMERIC(15,2) NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_stock_account_day_projections UNIQUE (franchise_id, day_id, account_id)
    );
  `.execute(db);

  // 33. jazz_lifting_day_projections
  await sql`
    CREATE TABLE jazz_lifting_day_projections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        day_id UUID NOT NULL REFERENCES accounting_days(id) ON DELETE CASCADE,
        opening_lifting NUMERIC(15,2) NOT NULL,
        ml_lifting_purchased NUMERIC(15,2) NOT NULL,
        today_ml_issuance NUMERIC(15,2) NOT NULL,
        closing_lifting_in_hand NUMERIC(15,2) NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_jazz_lifting_day_projections UNIQUE (franchise_id, day_id)
    );
  `.execute(db);

  // =========================================================================
  // 8. GROUP 7: GOVERNANCE, AUDITING & INTEGRITY (3 tables)
  // =========================================================================

  // 34. audit_logs
  await sql`
    CREATE TABLE audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        user_email VARCHAR(255),
        action VARCHAR(64) NOT NULL,
        entity_type VARCHAR(64) NOT NULL,
        entity_id VARCHAR(128),
        before_state JSONB,
        after_state JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // 35. calculation_runs
  await sql`
    CREATE TABLE calculation_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
        trigger_source VARCHAR(64) NOT NULL,
        from_day_no INT NOT NULL,
        to_day_no INT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'completed' CHECK (status IN ('started', 'completed', 'failed')),
        duration_ms NUMERIC(10,2),
        error_message TEXT,
        executed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // 36. invariant_violations
  await sql`
    CREATE TABLE invariant_violations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        period_id UUID NOT NULL REFERENCES accounting_periods(id) ON DELETE CASCADE,
        day_id UUID REFERENCES accounting_days(id) ON DELETE SET NULL,
        invariant_code VARCHAR(64) NOT NULL,
        severity VARCHAR(16) NOT NULL CHECK (severity IN ('critical', 'error', 'warning')),
        message TEXT NOT NULL,
        details JSONB,
        resolved_at TIMESTAMPTZ,
        resolved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // =========================================================================
  // 9. GROUP 8: HISTORICAL ARCHIVE PROVENANCE (1 table)
  // =========================================================================

  // 37. migration_idempotency_map
  await sql`
    CREATE TABLE migration_idempotency_map (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        firestore_collection VARCHAR(64) NOT NULL,
        firestore_doc_id VARCHAR(128) NOT NULL,
        source_type VARCHAR(32) NOT NULL CHECK (source_type IN ('embedded_array', 'parent_doc_field', 'master_catalog')),
        firestore_row_id VARCHAR(128) NOT NULL,
        pg_table VARCHAR(64) NOT NULL,
        pg_record_id UUID NOT NULL,
        migrated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        migrated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT uq_migration_provenance UNIQUE (franchise_id, firestore_collection, firestore_doc_id, firestore_row_id)
    );
  `.execute(db);

  // =========================================================================
  // 10. PRIMARY OPERATIONAL INDEXES
  // =========================================================================
  await sql`
    CREATE INDEX idx_accounting_days_lookup ON accounting_days (franchise_id, period_id, day_no);
    CREATE INDEX idx_expense_items_day ON expense_items (franchise_id, day_id);
    CREATE INDEX idx_commission_items_day ON commission_items (franchise_id, day_id);
    CREATE INDEX idx_credit_tx_day_party ON credit_transactions (franchise_id, day_id, party_id);
    CREATE INDEX idx_owner_tx_day ON owner_transactions (franchise_id, day_id);
    CREATE INDEX idx_jazz_do_entries_day_profile ON jazz_load_do_entries (franchise_id, day_id, do_profile_id);
    CREATE INDEX idx_stock_orders_day ON stock_orders (franchise_id, day_id, account_id);
    CREATE INDEX idx_stock_order_lines_order ON stock_order_lines (stock_order_id, product_id);
    CREATE INDEX idx_stock_account_payments_day ON stock_account_payments (franchise_id, day_id, account_id);
    CREATE INDEX idx_jazz_payable_payments_day ON jazz_company_payable_payments (franchise_id, day_id);
    CREATE INDEX idx_audit_logs_filter ON audit_logs (franchise_id, entity_type, created_at DESC);
    CREATE INDEX idx_invariant_unresolved ON invariant_violations (franchise_id, resolved_at) WHERE resolved_at IS NULL;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Drop triggers
  await sql`DROP TRIGGER IF EXISTS trg_jazz_payable_payments_immutability ON jazz_company_payable_payments;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stock_account_payments_immutability ON stock_account_payments;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stock_order_lines_immutability ON stock_order_lines;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_stock_orders_immutability ON stock_orders;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_jazz_load_do_entries_immutability ON jazz_load_do_entries;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_jazz_load_lifting_immutability ON jazz_load_lifting_records;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_owner_transactions_immutability ON owner_transactions;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_credit_transactions_immutability ON credit_transactions;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_commission_items_immutability ON commission_items;`.execute(db);
  await sql`DROP TRIGGER IF EXISTS trg_expense_items_immutability ON expense_items;`.execute(db);

  // Drop functions
  await sql`DROP FUNCTION IF EXISTS trg_enforce_ledger_immutability();`.execute(db);
  await sql`DROP FUNCTION IF EXISTS trg_set_updated_at();`.execute(db);

  // Drop all 37 tables in reverse dependency order
  await sql`
    DROP TABLE IF EXISTS migration_idempotency_map CASCADE;
    DROP TABLE IF EXISTS invariant_violations CASCADE;
    DROP TABLE IF EXISTS calculation_runs CASCADE;
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS jazz_lifting_day_projections CASCADE;
    DROP TABLE IF EXISTS stock_account_day_projections CASCADE;
    DROP TABLE IF EXISTS stock_product_day_projections CASCADE;
    DROP TABLE IF EXISTS credit_party_day_projections CASCADE;
    DROP TABLE IF EXISTS day_financial_projections CASCADE;
    DROP TABLE IF EXISTS jazz_company_payable_payments CASCADE;
    DROP TABLE IF EXISTS stock_account_payments CASCADE;
    DROP TABLE IF EXISTS stock_order_lines CASCADE;
    DROP TABLE IF EXISTS stock_orders CASCADE;
    DROP TABLE IF EXISTS jazz_load_do_entries CASCADE;
    DROP TABLE IF EXISTS jazz_load_lifting_records CASCADE;
    DROP TABLE IF EXISTS owner_transactions CASCADE;
    DROP TABLE IF EXISTS credit_transactions CASCADE;
    DROP TABLE IF EXISTS commission_items CASCADE;
    DROP TABLE IF EXISTS expense_items CASCADE;
    DROP TABLE IF EXISTS period_jazz_do_seeds CASCADE;
    DROP TABLE IF EXISTS period_stock_account_seeds CASCADE;
    DROP TABLE IF EXISTS period_stock_product_seeds CASCADE;
    DROP TABLE IF EXISTS period_credit_party_seeds CASCADE;
    DROP TABLE IF EXISTS period_financial_seeds CASCADE;
    DROP TABLE IF EXISTS stock_accounts CASCADE;
    DROP TABLE IF EXISTS stock_products CASCADE;
    DROP TABLE IF EXISTS jazz_load_do_profiles CASCADE;
    DROP TABLE IF EXISTS jazz_load_rates CASCADE;
    DROP TABLE IF EXISTS credit_parties CASCADE;
    DROP TABLE IF EXISTS commission_categories CASCADE;
    DROP TABLE IF EXISTS expense_categories CASCADE;
    DROP TABLE IF EXISTS accounting_days CASCADE;
    DROP TABLE IF EXISTS accounting_periods CASCADE;
    DROP TABLE IF EXISTS authorized_emails CASCADE;
    DROP TABLE IF EXISTS franchise_users CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS franchises CASCADE;
  `.execute(db);
}
