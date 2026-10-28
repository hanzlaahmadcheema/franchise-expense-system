import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";
import { stageSeeds, validateSeeds, getSeeds } from "../periods/service.js";
import { createStockAccount, createStockProduct } from "../catalogs/service.js";

async function main() {
  console.log("=== PHASE 13 STEP 4: AUGUST 2026 GENESIS SEED STAGING (FINAL CATALOG) ===");

  // 1. Verify Target Environment
  const connRes = await sql<{
    current_database: string;
    current_user: string;
  }>`SELECT current_database(), current_user`.execute(db);
  const { current_database, current_user } = connRes.rows[0]!;
  console.log(`Target Database: ${current_database} (User: ${current_user})`);

  if (current_database !== "franchise_prod_db") {
    throw new Error(`SAFETY ABORT: Target database is '${current_database}', expected 'franchise_prod_db'.`);
  }

  // 2. Fetch Franchise 7301
  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();
  console.log(`✓ Franchise verified: ${franchise.name} (${franchise.id})`);

  // 3. Fetch Owner User
  const ownerUser = await db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", "hanzlaahmad100@gmail.com")
    .executeTakeFirstOrThrow();

  const userContext = {
    id: ownerUser.id,
    email: ownerUser.email,
    role: "owner"
  };
  console.log(`✓ Owner verified: ${ownerUser.email} (${ownerUser.id})`);

  // 4. Verify Period 2026-08 and 31 closed days
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "=", "2026-08")
    .executeTakeFirstOrThrow();

  console.log(`✓ Period verified: ${period.period_key} (${period.id}), status: ${period.status}`);
  if (period.status !== "open") {
    throw new Error(`Period status is '${period.status}', expected 'open'.`);
  }

  const days = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  if (days.length !== 31) {
    throw new Error(`Expected 31 calendar days, found ${days.length}`);
  }
  const openDays = days.filter((d) => d.status !== "closed");
  if (openDays.length > 0) {
    throw new Error(`SAFETY VIOLATION: Found ${openDays.length} unclosed days.`);
  }
  console.log(`✓ 31 calendar days verified (Day 1: ${days[0]!.calendar_date} to Day 31: ${days[30]!.calendar_date}), all 100% closed.`);

  // 5. Ensure "Tetas CCR" exists in stock_accounts
  console.log("\n--- Catalog Verification: Stock Accounts ---");
  let tetasAccount = await db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("slug", "=", "tetas-ccr")
    .executeTakeFirst();

  if (!tetasAccount) {
    console.log("Creating missing canonical stock account 'Tetas CCR'...");
    tetasAccount = await createStockAccount(franchise.id, {
      name: "Tetas CCR",
      slug: "tetas-ccr",
      type: "CCR",
      sort_order: 18,
      is_active: true,
      notes: "Canonical stock account for Tetas / Tetas CCR"
    });
    console.log(`✓ Created 'Tetas CCR': ID=${tetasAccount.id}`);
  } else {
    console.log(`✓ Existing 'Tetas CCR' found: ID=${tetasAccount.id}`);
  }

  const allAccounts = await db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .orderBy("sort_order", "asc")
    .execute();
  console.log(`Total active stock accounts in catalog: ${allAccounts.length}`);
  if (allAccounts.length !== 18) {
    throw new Error(`Expected exactly 18 active stock accounts, found ${allAccounts.length}`);
  }

  // 6. Ensure "Dongle" exists in stock_products
  console.log("\n--- Catalog Verification: Stock Products ---");
  let dongleProduct = await db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("slug", "=", "dongle")
    .executeTakeFirst();

  if (!dongleProduct) {
    console.log("Creating missing stock product 'Dongle' (rate: 8000, category: DEVICES)...");
    dongleProduct = await createStockProduct(franchise.id, {
      name: "Dongle",
      slug: "dongle",
      rate: "8000.00",
      category: "DEVICES",
      payment_tracking_enabled: false,
      sort_order: 12,
      is_active: true,
      notes: "Device product (Dongle) with authoritative rate 8000"
    });
    console.log(`✓ Created 'Dongle': ID=${dongleProduct.id}`);
  } else {
    console.log(`✓ Existing 'Dongle' found: ID=${dongleProduct.id}`);
  }

  const allProducts = await db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .orderBy("sort_order", "asc")
    .execute();
  console.log(`Total active stock products in catalog: ${allProducts.length}`);
  if (allProducts.length !== 12) {
    throw new Error(`Expected exactly 12 active stock products, found ${allProducts.length}`);
  }

  // 7. Assemble Opening Seed Bundle
  console.log("\n--- Assembling Seed Bundle ---");

  // A. Financial Genesis Seed
  const financialSeed = {
    openingCash: "0.00",
    openingOwnerBalance: "129962.00",
    openingJazzLifting: "878524.00",
    openingJazzPayable: "0.00",
    sourcePeriodKey: null,
    sourceDayNo: null,
    notes: "MANUAL_INITIAL_GENESIS_SEED"
  };

  // B. Credit Parties (8 rows)
  const creditPartySeeds = [
    { partyId: "b7a366c8-8a80-4855-bb76-236449bff582", openingBalance: "39948.00", sourcePeriodKey: null, sourceDayNo: null }, // ALI OLAKH
    { partyId: "66a484f7-90e5-46ce-8b49-7159f55814a6", openingBalance: "17703.00", sourcePeriodKey: null, sourceDayNo: null }, // Usman cheema
    { partyId: "151ac471-6c9c-4a7e-8e9f-70f65c72896b", openingBalance: "9000.00", sourcePeriodKey: null, sourceDayNo: null },  // AKHTAR
    { partyId: "b56a06a2-9be0-42bb-b666-dd8d38be1f66", openingBalance: "8300.00", sourcePeriodKey: null, sourceDayNo: null },  // IMRAN OLAKH
    { partyId: "e547af19-1b39-4832-8db4-c9d5bbaf8c64", openingBalance: "-47047.00", sourcePeriodKey: null, sourceDayNo: null }, // Masjid Account
    { partyId: "1c99b0d3-843f-473b-8140-d888db378483", openingBalance: "30000.00", sourcePeriodKey: null, sourceDayNo: null }, // DSO HASAN
    { partyId: "2daf0877-b9f7-4109-a2db-13739d81d30b", openingBalance: "5000.00", sourcePeriodKey: null, sourceDayNo: null },  // SARAM
    { partyId: "35cfa8a0-0c5b-4fba-ada0-2cedd38c56b9", openingBalance: "30000.00", sourcePeriodKey: null, sourceDayNo: null }  // NAVEED DO
  ];

  // C. Jazz Load DO Profiles (14 active profiles at 0.00)
  const jazzDos = await db
    .selectFrom("jazz_load_do_profiles")
    .select(["id", "do_name"])
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .execute();

  const jazzDoSeeds = jazzDos.map((jd) => ({
    doProfileId: jd.id,
    openingBaseBalance: "0.00",
    sourcePeriodKey: null,
    sourceDayNo: null
  }));

  // D. Stock Products (12 rows: 8 active + 4 skipped)
  const stockProductMap = new Map(allProducts.map((p) => [p.slug, p.id]));

  const stockProductSeeds = [
    // 8 Active Products with quantities
    { productId: stockProductMap.get("retailer")!, openingQuantity: 1497, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("franchise")!, openingQuantity: 407, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("load-sim")!, openingQuantity: 1, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("mbb-sim")!, openingQuantity: 0, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null }, // Data SIM = 0 (participates)
    { productId: stockProductMap.get("e-sim")!, openingQuantity: 9, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("gold-number")!, openingQuantity: 64, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("retail-imzi")!, openingQuantity: 1156, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("cs-imzi")!, openingQuantity: 303, status: "active" as const, sourcePeriodKey: null, sourceDayNo: null },

    // 4 Skipped Products (NULL opening_quantity, status = 'skipped', intentional exclusion)
    { productId: stockProductMap.get("mobile")!, openingQuantity: null, status: "skipped" as const, notes: "INTENTIONAL_GENESIS_EXCLUSION", sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("shine-mobile")!, openingQuantity: null, status: "skipped" as const, notes: "INTENTIONAL_GENESIS_EXCLUSION", sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("wingle")!, openingQuantity: null, status: "skipped" as const, notes: "INTENTIONAL_GENESIS_EXCLUSION", sourcePeriodKey: null, sourceDayNo: null },
    { productId: stockProductMap.get("dongle")!, openingQuantity: null, status: "skipped" as const, notes: "INTENTIONAL_GENESIS_EXCLUSION", sourcePeriodKey: null, sourceDayNo: null }
  ];

  // E. Stock Accounts (18 rows: 14 non-zero + 4 zero)
  const stockAccountMap = new Map(allAccounts.map((a) => [a.slug, a.id]));

  const stockAccountSeeds = [
    // 14 non-zero accounts
    { accountId: stockAccountMap.get("do-mirza")!, openingReceivable: "63592.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-arslan")!, openingReceivable: "53695.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-mubashar")!, openingReceivable: "56000.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-mirza-irfan")!, openingReceivable: "47880.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-hassan")!, openingReceivable: "24080.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-naveed")!, openingReceivable: "141990.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-irfan")!, openingReceivable: "20120.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("dso-hasan")!, openingReceivable: "100800.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("free-sim-ccr")!, openingReceivable: "121800.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("tetas-ccr")!, openingReceivable: "22800.00", sourcePeriodKey: null, sourceDayNo: null }, // Tetas CCR = 22,800
    { accountId: stockAccountMap.get("saram-ccr")!, openingReceivable: "12800.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("anni-ccr")!, openingReceivable: "41800.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("waseem-gujjar")!, openingReceivable: "3080.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("dso-abdullah")!, openingReceivable: "42200.00", sourcePeriodKey: null, sourceDayNo: null },

    // 4 zero accounts
    { accountId: stockAccountMap.get("do-adnan")!, openingReceivable: "0.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("do-rizwan")!, openingReceivable: "0.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("hussain-ccr")!, openingReceivable: "0.00", sourcePeriodKey: null, sourceDayNo: null },
    { accountId: stockAccountMap.get("net-stock")!, openingReceivable: "0.00", sourcePeriodKey: null, sourceDayNo: null }
  ];

  const bundle = {
    financial: financialSeed,
    creditParties: creditPartySeeds,
    stockProducts: stockProductSeeds,
    stockAccounts: stockAccountSeeds,
    jazzDoProfiles: jazzDoSeeds
  };

  // 8. Execute stageSeeds
  console.log("\n--- Staging Seeds via stageSeeds() ---");
  const stageResult = await stageSeeds(franchise.id, period.id, bundle as any, userContext);
  console.log(`✓ Staging result: success=${stageResult.success}, message="${stageResult.message}"`);
  console.log(`  isVerified=${stageResult.isVerified} (MUST BE FALSE)`);

  // 9. Execute validateSeeds
  console.log("\n--- Validating Seeds via validateSeeds() ---");
  const valResult = await validateSeeds(franchise.id, period.id);
  console.log(`✓ Validation run: isValid=${valResult.isValid}`);
  if (valResult.errors.length > 0) {
    console.error("  Validation Errors:");
    for (const err of valResult.errors) {
      console.error(`    - ${err}`);
    }
  } else {
    console.log("  Errors: 0 (PASSED!)");
  }
  if (valResult.warnings.length > 0) {
    console.log("  Validation Warnings:");
    for (const warn of valResult.warnings) {
      console.log(`    - ${warn}`);
    }
  }

  // 10. Invariant & Safety Verification
  console.log("\n--- Safety & Governance Verification ---");

  // A. Operational transactions in all 10 mutation tables must be 0
  const mutationTables = [
    "commission_items",
    "expense_items",
    "owner_transactions",
    "credit_transactions",
    "stock_orders",
    "stock_order_lines",
    "stock_account_payments",
    "jazz_load_lifting_records",
    "jazz_load_do_entries",
    "jazz_company_payable_payments"
  ] as const;

  for (const table of mutationTables) {
    const res = await sql<{ count: string }>`SELECT count(*)::text as count FROM ${sql.table(table)}`.execute(db);
    const count = parseInt(res.rows[0]?.count ?? "0", 10);
    console.log(`  Mutation table '${table}': ${count} rows`);
    if (count !== 0) {
      throw new Error(`SAFETY VIOLATION: Found ${count} rows in '${table}', expected 0!`);
    }
  }

  // B. Day 1 and all 31 days must remain closed
  const postDays = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .execute();
  const openCount = postDays.filter((d) => d.status !== "closed").length;
  console.log(`  Closed days: ${postDays.length - openCount}/${postDays.length}`);
  if (openCount > 0) {
    throw new Error(`SAFETY VIOLATION: ${openCount} days are open!`);
  }

  // C. Financial seed must remain unverified
  const stagedData = await getSeeds(franchise.id, period.id);
  console.log(`  Financial seed isVerified: ${stagedData.isVerified}`);
  if (stagedData.isVerified !== false) {
    throw new Error("SAFETY VIOLATION: Staged seeds marked verified!");
  }

  // D. Count of staged records per domain
  console.log(`  Staged Financial seeds: 1`);
  console.log(`  Staged Credit Parties: ${stagedData.seeds.creditParties.length}`);
  console.log(`  Staged Jazz DO Profiles: ${stagedData.seeds.jazzDoProfiles.length}`);
  console.log(`  Staged Stock Products: ${stagedData.seeds.stockProducts.length}`);
  console.log(`  Staged Stock Accounts: ${stagedData.seeds.stockAccounts.length}`);

  // E. Verify SKIPPED stock products in DB
  const skippedInDb = stagedData.seeds.stockProducts.filter((p: any) => p.status === "skipped");
  console.log(`  Skipped stock products in DB: ${skippedInDb.length}`);
  for (const sp of skippedInDb) {
    console.log(`    - Product ${sp.product_id}: status=${sp.status}, opening_quantity=${sp.opening_quantity}, notes="${sp.notes}"`);
  }

  // F. Verify Tetas CCR in DB
  const tetasInDb = stagedData.seeds.stockAccounts.find((a: any) => a.account_id === tetasAccount!.id);
  console.log(`  Tetas CCR opening receivable in DB: ${tetasInDb?.opening_receivable}`);

  await closeDatabase();
  console.log("\n=== EXECUTION COMPLETE ===");
}

main().catch((err) => {
  console.error("FATAL ERROR:", err);
  process.exit(1);
});
