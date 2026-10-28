import { db, closeDatabase } from "../config/database.js";

async function main() {
  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();

  console.log(`Franchise: ${franchise.name} (${franchise.id})`);

  const accounts = await db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .orderBy("sort_order", "asc")
    .execute();

  console.log("\n--- STOCK ACCOUNTS in franchise_prod_db (" + accounts.length + ") ---");
  for (const acc of accounts) {
    console.log(`ID: ${acc.id} | Slug: ${acc.slug} | Name: "${acc.name}" | Type: ${acc.type} | Active: ${acc.is_active}`);
  }

  const products = await db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .orderBy("sort_order", "asc")
    .execute();

  console.log("\n--- STOCK PRODUCTS in franchise_prod_db (" + products.length + ") ---");
  for (const prod of products) {
    console.log(`ID: ${prod.id} | Slug: ${prod.slug} | Name: "${prod.name}" | Rate: ${prod.rate} | Active: ${prod.is_active}`);
  }

  await closeDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
