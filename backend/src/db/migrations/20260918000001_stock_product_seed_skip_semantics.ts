import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Allow opening_quantity to be NULL for explicitly SKIPPED stock products
  await sql`
    ALTER TABLE period_stock_product_seeds 
    ALTER COLUMN opening_quantity DROP NOT NULL;
  `.execute(db);

  // 2. Add status column ('active' vs 'skipped')
  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'active';
  `.execute(db);

  // 3. Add notes column for audit and reason tracking
  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD COLUMN IF NOT EXISTS notes TEXT NULL;
  `.execute(db);

  // 4. Enforce mathematical integrity:
  //    - active seeds MUST have non-negative quantity
  //    - skipped seeds MUST have NULL quantity (not zero)
  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS chk_period_stock_product_seeds_status;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD CONSTRAINT chk_period_stock_product_seeds_status CHECK (
      (status = 'active' AND opening_quantity IS NOT NULL AND opening_quantity >= 0) OR
      (status = 'skipped' AND opening_quantity IS NULL)
    );
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS chk_period_stock_product_seeds_status;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP COLUMN IF EXISTS notes;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP COLUMN IF EXISTS status;
  `.execute(db);

  await sql`
    UPDATE period_stock_product_seeds 
    SET opening_quantity = 0 
    WHERE opening_quantity IS NULL;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    ALTER COLUMN opening_quantity SET NOT NULL;
  `.execute(db);
}
