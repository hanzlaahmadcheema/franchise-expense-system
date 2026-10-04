import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Drop old >= 0 checks on opening_quantity
  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS period_stock_product_seeds_opening_quantity_check;
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    DROP CONSTRAINT IF EXISTS chk_period_stock_product_seeds_status;
  `.execute(db);

  // 2. Allow legitimate negative stock seeds (warning at application layer, not blocked in DB)
  // Active seeds must have non-null quantity; skipped seeds must have null quantity
  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD CONSTRAINT chk_period_stock_product_seeds_status CHECK (
      (status = 'active' AND opening_quantity IS NOT NULL) OR
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
    ADD CONSTRAINT chk_period_stock_product_seeds_status CHECK (
      (status = 'active' AND opening_quantity IS NOT NULL AND opening_quantity >= 0) OR
      (status = 'skipped' AND opening_quantity IS NULL)
    );
  `.execute(db);

  await sql`
    ALTER TABLE period_stock_product_seeds 
    ADD CONSTRAINT period_stock_product_seeds_opening_quantity_check CHECK (
      opening_quantity >= 0
    );
  `.execute(db);
}
