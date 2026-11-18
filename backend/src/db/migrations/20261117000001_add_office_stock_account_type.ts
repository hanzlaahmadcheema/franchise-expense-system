import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE stock_accounts
    DROP CONSTRAINT IF EXISTS stock_accounts_type_check;
  `.execute(db);

  await sql`
    ALTER TABLE stock_accounts
    ADD CONSTRAINT stock_accounts_type_check
    CHECK (type IN ('DO', 'CCR', 'DSO', 'STOCK', 'OFFICE', 'OTHER'));
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE stock_accounts
    DROP CONSTRAINT IF EXISTS stock_accounts_type_check;
  `.execute(db);

  await sql`
    ALTER TABLE stock_accounts
    ADD CONSTRAINT stock_accounts_type_check
    CHECK (type IN ('DO', 'CCR', 'DSO', 'STOCK', 'OTHER'));
  `.execute(db);
}
