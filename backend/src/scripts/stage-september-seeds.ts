/**
 * Phase 7D: September 2026 Opening Snapshot Staging & Validation Script
 *
 * HARD CONSTRAINTS:
 * 1. Target ONLY local production database (franchise_prod_db).
 * 2. Stage period 2026-09 with exactly 30 closed calendar days.
 * 3. Stage 5-domain opening seeds with provenance 2026-08 Day 31.
 * 4. Run Phase 7B seed validation.
 * 5. DO NOT verify seeds (is_verified remains FALSE).
 * 6. DO NOT activate period / Day 1 (Day 1 remains CLOSED).
 * 7. DO NOT create operational transactions or calculation projections.
 * 8. DO NOT modify development database or Firestore.
 */
import { db, closeDatabase } from "../config/database.js";
import { sql } from "kysely";
import { initializePeriod, stageSeeds, validateSeeds } from "../periods/service.js";
import type { SeedBundleInput } from "../periods/schemas.js";

async function runStageSeptemberSeeds() {
  console.log("=== PHASE 7D: SEPTEMBER 2026 OPENING SNAPSHOT STAGING ===");

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
    .executeTakeFirst();

  if (!franchise) {
    throw new Error("Franchise 7301 not found in production database.");
  }
  console.log(`Franchise found: ${franchise.name} (${franchise.id})`);

  // 3. Fetch Owner User & Membership
  const ownerUser = await db
    .selectFrom("users")
    .selectAll()
    .where("email", "=", "hanzlaahmad100@gmail.com")
    .executeTakeFirst();

  if (!ownerUser) {
    throw new Error("Owner user not found in production database.");
  }

  const membership = await db
    .selectFrom("franchise_users")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("user_id", "=", ownerUser.id)
    .executeTakeFirst();

  if (!membership || membership.role !== "owner") {
    throw new Error("Owner membership not found for Franchise 7301.");
  }
  console.log(`Owner verified: ${ownerUser.email} (Membership: ${membership.id}, Role: ${membership.role})`);

  const userContext = {
    id: ownerUser.id,
    email: ownerUser.email,
    role: "owner"
  };

  // 4. Initialize Period 2026-09
  console.log("Initializing Period '2026-09'...");
  const initResult = await initializePeriod(franchise.id, "2026-09", userContext);
  console.log(`Period initialization: created=${initResult.created}, daysCount=${initResult.daysCount}`);

  const periodId = initResult.period.id;

  // Verify 30 closed days
  const daysInPeriod = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", periodId)
    .orderBy("day_no", "asc")
    .execute();

  if (daysInPeriod.length !== 30) {
    throw new Error(`Expected exactly 30 days, found ${daysInPeriod.length}.`);
  }

  const openDays = daysInPeriod.filter((d) => d.status !== "closed");
  if (openDays.length > 0) {
    throw new Error(`SAFETY VIOLATION: Found ${openDays.length} open days. All days must be closed.`);
  }
  console.log(`Verified 30 calendar days (Day 1: ${daysInPeriod[0]!.calendar_date} to Day 30: ${daysInPeriod[29]!.calendar_date}), all initially CLOSED.`);

  // 5. Map Catalog Entities
  // 5.1 Credit Parties (9)
  const creditParties = await db
    .selectFrom("credit_parties")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  const creditPartyMap = new Map<string, string>();
  for (const cp of creditParties) {
    creditPartyMap.set(cp.name, cp.id);
  }

  // 5.2 Stock Products (11)
  const stockProducts = await db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  const stockProductMap = new Map<string, string>();
  for (const sp of stockProducts) {
    stockProductMap.set(sp.name, sp.id);
  }

  // 5.3 Stock Accounts (17)
  const stockAccounts = await db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  const stockAccountMap = new Map<string, string>();
  for (const sa of stockAccounts) {
    stockAccountMap.set(sa.name, sa.id);
  }

  // 5.4 Jazz Load DO Profiles (14)
  const jazzDoProfiles = await db
    .selectFrom("jazz_load_do_profiles")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  const jazzDoProfileMap = new Map<string, string>();
  for (const dp of jazzDoProfiles) {
    jazzDoProfileMap.set(dp.do_name, dp.id);
  }

  // 6. Construct Confirmed Opening Snapshot Bundle
  console.log("Constructing Confirmed August 31 / September 1 Opening Snapshot Bundle...");

  // Section 3: Financial & Expense Opening State
  const financialSeed = {
    openingCash: "0.00",
    openingOwnerBalance: "339327.00",
    openingJazzLifting: "815579.00",
    openingJazzPayable: "0.00",
    sourcePeriodKey: "2026-08",
    sourceDayNo: 31,
    notes: "Authoritative August 31 closing snapshot for September 1 opening state"
  };

  // Section 3: Credit Parties (9)
  const confirmedCreditParties: Array<{ name: string; balance: string }> = [
    { name: "ALI OLAKH", balance: "32774.00" },
    { name: "Usman cheema", balance: "27627.00" },
    { name: "AKHTAR", balance: "13000.00" },
    { name: "IMRAN OLAKH", balance: "8300.00" },
    { name: "Majid ACCOUNT", balance: "-62797.00" }, // Must remain negative
    { name: "DSO HASAN", balance: "25000.00" },
    { name: "SARAM", balance: "3000.00" }, // Expense credit party
    { name: "NAVEED DO", balance: "0.00" }, // Explicit zero
    { name: "FAKHAR CCR", balance: "10000.00" }
  ];

  const creditPartySeeds = confirmedCreditParties.map((item) => {
    const partyId = creditPartyMap.get(item.name);
    if (!partyId) throw new Error(`Missing Credit Party in catalog: '${item.name}'`);
    return {
      partyId,
      openingBalance: item.balance,
      sourcePeriodKey: "2026-08",
      sourceDayNo: 31
    };
  });

  // Section 5: Stock Product Opening Quantities (11)
  const confirmedStockProducts: Array<{ name: string; quantity: number }> = [
    { name: "RETAILER", quantity: 1727 },
    { name: "FRANCHISE", quantity: 466 },
    { name: "LOAD SIM", quantity: 5 },
    { name: "MBB SIM", quantity: 0 },
    { name: "E SIM", quantity: 16 },
    { name: "Shine Mobile", quantity: 0 },
    { name: "MOBILE", quantity: 0 },
    { name: "WINGLE", quantity: 0 },
    { name: "Gold Number", quantity: 20 },
    { name: "RETAIL IMZI", quantity: 1010 },
    { name: "CS IMZI", quantity: 210 }
  ];

  const stockProductSeeds = confirmedStockProducts.map((item) => {
    const productId = stockProductMap.get(item.name);
    if (!productId) throw new Error(`Missing Stock Product in catalog: '${item.name}'`);
    return {
      productId,
      openingQuantity: item.quantity,
      sourcePeriodKey: "2026-08",
      sourceDayNo: 31
    };
  });

  // Section 6: Stock Account Opening Balances (17)
  const confirmedStockAccounts: Array<{ name: string; balance: string }> = [
    { name: "DO RIZWAN", balance: "0.00" },
    { name: "DO MIRZA", balance: "56592.00" },
    { name: "DO ADNAN", balance: "0.00" },
    { name: "DO ARSLAN", balance: "87015.00" },
    { name: "DO MUBASHAR", balance: "86240.00" },
    { name: "Do Mirza irfan", balance: "53760.00" },
    { name: "DO HASSAN", balance: "21000.00" },
    { name: "DO NAVEED", balance: "171670.00" },
    { name: "DO IRFAN", balance: "40560.00" },
    { name: "DSO HASAN", balance: "129920.00" },
    { name: "FREE SIM CCR", balance: "29400.00" },
    { name: "HUSSAIN CCR", balance: "22800.00" },
    { name: "SARAM CCR", balance: "12800.00" },
    { name: "ANNI CCR", balance: "41800.00" },
    { name: "WASEEM GUJJAR", balance: "3080.00" },
    { name: "DSO Abdullah", balance: "20640.00" },
    { name: "NET STOCK", balance: "28000.00" }
  ];

  const stockAccountSeeds = confirmedStockAccounts.map((item) => {
    const accountId = stockAccountMap.get(item.name);
    if (!accountId) throw new Error(`Missing Stock Account in catalog: '${item.name}'`);
    return {
      accountId,
      openingReceivable: item.balance,
      sourcePeriodKey: "2026-08",
      sourceDayNo: 31
    };
  });

  // Section 4: Jazz Load DO Profiles Opening Balances (14) - All Explicit Zero
  const confirmedJazzDos: Array<{ name: string }> = [
    { name: "Mirza" },
    { name: "Adnan" },
    { name: "Arslan" },
    { name: "Mubashir" },
    { name: "Irfan Mirza" },
    { name: "Hassan" },
    { name: "Naveed" },
    { name: "Irfan" },
    { name: "Naveed Bangla" },
    { name: "Fix Line" },
    { name: "Anni" },
    { name: "Fakhar" },
    { name: "Saram" },
    { name: "Other" }
  ];

  const jazzDoSeeds = confirmedJazzDos.map((item) => {
    const doProfileId = jazzDoProfileMap.get(item.name);
    if (!doProfileId) throw new Error(`Missing Jazz DO profile in catalog: '${item.name}'`);
    return {
      doProfileId,
      openingBaseBalance: "0.00",
      sourcePeriodKey: "2026-08",
      sourceDayNo: 31
    };
  });

  const bundleInput: SeedBundleInput = {
    financial: financialSeed,
    creditParties: creditPartySeeds,
    stockProducts: stockProductSeeds,
    stockAccounts: stockAccountSeeds,
    jazzDoProfiles: jazzDoSeeds
  };

  // 7. Stage Seeds via Approved Phase 7B Service Function
  console.log("Staging opening seeds into production database via stageSeeds()...");
  const stageResult = await stageSeeds(franchise.id, periodId, bundleInput, userContext);
  console.log("Stage result:", stageResult);

  // 8. Validate Staged Seeds via Approved Phase 7B Validation Function
  console.log("Validating staged seeds via validateSeeds()...");
  const validationResult = await validateSeeds(franchise.id, periodId);
  console.log("Validation result:", JSON.stringify(validationResult, null, 2));

  if (!validationResult.isValid) {
    throw new Error(`SEED VALIDATION FAILED: ${validationResult.errors.join("; ")}`);
  }

  // 9. Calculate and Print Expected Seed Totals
  const stockQtyTotal = confirmedStockProducts.reduce((sum, p) => sum + p.quantity, 0);
  const creditBalanceTotal = confirmedCreditParties.reduce((sum, c) => sum + Number(c.balance), 0);
  const stockAccountTotal = confirmedStockAccounts.reduce((sum, a) => sum + Number(a.balance), 0);

  console.log("=== CALCULATED TOTALS ===");
  console.log(`Stock Physical Quantity Total: ${stockQtyTotal.toLocaleString()} (Expected: 3,454)`);
  console.log(`Credit Party Balances Total: ${creditBalanceTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  console.log(`Stock Account Balances Total: ${stockAccountTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

  // 10. Post-Staging Table Counts Verification
  const tables = [
    { name: "accounting_periods", expected: 1 },
    { name: "accounting_days", expected: 30 },
    { name: "period_financial_seeds", expected: 1 },
    { name: "period_credit_party_seeds", expected: 9 },
    { name: "period_stock_product_seeds", expected: 11 },
    { name: "period_stock_account_seeds", expected: 17 },
    { name: "period_jazz_do_seeds", expected: 14 },
    // Must remain 0:
    { name: "expense_items", expected: 0 },
    { name: "commission_items", expected: 0 },
    { name: "credit_transactions", expected: 0 },
    { name: "owner_transactions", expected: 0 },
    { name: "stock_orders", expected: 0 },
    { name: "stock_order_lines", expected: 0 },
    { name: "stock_account_payments", expected: 0 },
    { name: "jazz_load_lifting_records", expected: 0 },
    { name: "jazz_load_do_entries", expected: 0 },
    { name: "jazz_company_payable_payments", expected: 0 },
    { name: "day_financial_projections", expected: 0 },
    { name: "credit_party_day_projections", expected: 0 },
    { name: "stock_product_day_projections", expected: 0 },
    { name: "stock_account_day_projections", expected: 0 },
    { name: "jazz_lifting_day_projections", expected: 0 },
    { name: "jazz_load_do_day_projections", expected: 0 },
    { name: "calculation_runs", expected: 0 },
    { name: "invariant_violations", expected: 0 }
  ];

  console.log("=== POST-STAGING TABLE COUNT AUDIT ===");
  for (const t of tables) {
    const res = await sql.raw(`SELECT count(*) FROM ${t.name}`).execute(db);
    const count = Number((res.rows[0] as any).count);
    console.log(`  ${t.name}: ${count} (expected: ${t.expected})`);
    if (count !== t.expected) {
      throw new Error(`Count mismatch for ${t.name}: found ${count}, expected ${t.expected}`);
    }
  }

  // Check that Day 1 is still closed
  const day1 = await db
    .selectFrom("accounting_days")
    .select(["id", "day_no", "status"])
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", periodId)
    .where("day_no", "=", 1)
    .executeTakeFirstOrThrow();

  console.log(`Day 1 status: ${day1.status} (MUST be 'closed')`);
  if (day1.status !== "closed") {
    throw new Error(`CRITICAL ERROR: Day 1 status is '${day1.status}', expected 'closed'.`);
  }

  // Check is_verified in financial seed
  const finSeedInDb = await db
    .selectFrom("period_financial_seeds")
    .select(["id", "is_verified", "verified_at"])
    .where("period_id", "=", periodId)
    .executeTakeFirstOrThrow();

  console.log(`Financial seed is_verified: ${finSeedInDb.is_verified} (MUST be false)`);
  if (finSeedInDb.is_verified !== false) {
    throw new Error(`CRITICAL ERROR: is_verified is ${finSeedInDb.is_verified}, expected false.`);
  }

  console.log("=== PHASE 7D STAGING AND VALIDATION COMPLETE ===");
}

runStageSeptemberSeeds()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("FATAL ERROR during Phase 7D staging:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDatabase();
  });
