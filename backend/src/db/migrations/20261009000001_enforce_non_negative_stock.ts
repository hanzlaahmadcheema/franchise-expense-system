import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Enforce non-negative stock quantity on period_stock_product_seeds
  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS chk_period_stock_product_seeds_status;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS period_stock_product_seeds_opening_quantity_check;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD CONSTRAINT chk_period_stock_product_seeds_status CHECK (
      (status = 'active' AND opening_quantity IS NOT NULL AND opening_quantity >= 0) OR
      (status = 'skipped' AND opening_quantity IS NULL)
    );
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD CONSTRAINT period_stock_product_seeds_opening_quantity_check CHECK (
      opening_quantity >= 0 OR opening_quantity IS NULL
    );
  `.execute(db);

  // 2. Ensure stock_product_day_projections does not have blocking check constraints
  // (intraday negative stock is tracked non-blockingly via INV_STOCK_QTY_NEGATIVE invariant warnings)
  await sql`
    ALTER TABLE stock_product_day_projections
    DROP CONSTRAINT IF EXISTS chk_stock_product_day_projections_opening_qty,
    DROP CONSTRAINT IF EXISTS chk_stock_product_day_projections_closing_qty,
    DROP CONSTRAINT IF EXISTS chk_stock_product_day_projections_stock_in_qty,
    DROP CONSTRAINT IF EXISTS chk_stock_product_day_projections_stock_out_qty;
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS period_stock_product_seeds_opening_quantity_check;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS chk_period_stock_product_seeds_status;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD CONSTRAINT chk_period_stock_product_seeds_status CHECK (
      (status = 'active' AND opening_quantity IS NOT NULL) OR
      (status = 'skipped' AND opening_quantity IS NULL)
    );
  `.execute(db);
}
