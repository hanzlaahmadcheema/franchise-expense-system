import { db, closeDatabase } from "../config/database.js";
import { getSeeds, validateSeeds } from "../periods/service.js";

async function main() {
  const franchise = await db.selectFrom("franchises").selectAll().where("code", "=", "7301").executeTakeFirstOrThrow();
  const period = await db.selectFrom("accounting_periods").selectAll().where("franchise_id", "=", franchise.id).where("period_key", "=", "2026-08").executeTakeFirstOrThrow();
  
  const seeds = await getSeeds(franchise.id, period.id);
  const validation = await validateSeeds(franchise.id, period.id);
  
  const stockAccounts = await db.selectFrom("stock_accounts").selectAll().where("franchise_id", "=", franchise.id).execute();
  const stockProducts = await db.selectFrom("stock_products").selectAll().where("franchise_id", "=", franchise.id).execute();

  console.log(JSON.stringify({
    periodId: period.id,
    periodKey: period.period_key,
    periodStatus: period.status,
    isVerified: seeds.isVerified,
    validationResult: validation,
    seedCounts: {
      financial: seeds.seeds.financial ? 1 : 0,
      creditParties: seeds.seeds.creditParties.length,
      jazzDoProfiles: seeds.seeds.jazzDoProfiles.length,
      stockProducts: seeds.seeds.stockProducts.length,
      stockAccounts: seeds.seeds.stockAccounts.length
    },
    totalActiveStockAccounts: stockAccounts.length,
    totalActiveStockProducts: stockProducts.length,
    stockProductsSeeds: seeds.seeds.stockProducts.map(p => {
      const prod = stockProducts.find(x => x.id === p.product_id);
      return { id: p.product_id, name: prod?.name, slug: prod?.slug, status: p.status, qty: p.opening_quantity, notes: p.notes };
    }),
    tetasCCRSeed: seeds.seeds.stockAccounts.find(a => {
      const acc = stockAccounts.find(x => x.id === a.account_id);
      return acc?.slug === "tetas-ccr";
    })
  }, null, 2));

  await closeDatabase();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
