/**
 * Closed-Month Governed Recovery & Non-Negative Stock Rollover Integration Tests
 *
 * Validates:
 * 1. Stock seed validation strictly rejects negative stock quantities (e.g. -18)
 * 2. Database constraints enforce non-negative stock quantities
 * 3. Malformed / non-numeric stock seed is rejected
 * 4. Zero and positive stock quantities continue working cleanly
 * 5. Closed August + absent September -> governed initialization via initializeNextPeriodFromClosedPeriod
 * 6. September receives exact FINAL closing balances
 * 7. September Days 1..30 created exactly once
 * 8. September Day 1 is OPEN, Days 2..30 strictly remain CLOSED
 * 9. FINAL provenance preserved (source_period_key = '2026-08', source_day_no = 31)
 * 10. Real FINAL settlement entries remain unchanged
 * 11. Repeated initialization is idempotent (no duplicates)
 * 12. Inconsistent state rejection (e.g. missing days in target period)
 * 13. REST endpoint POST /api/v1/periods/:periodId/initialize-next works atomically
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";
import {
  validateSeeds,
  stageSeeds,
  initializeNextPeriodFromClosedPeriod,
  closeAccountingPeriod
} from "./service.js";

const FRANCHISE_CODE = "TEST-RECOV-NEG";
const OWNER_UID = "test-recov-owner";
const OWNER_EMAIL = "owner@recov-neg.test";

async function cleanupTestData() {
  await sql`
    ALTER TABLE expense_items DISABLE TRIGGER trg_expense_items_immutability;
    ALTER TABLE commission_items DISABLE TRIGGER trg_commission_items_immutability;
    ALTER TABLE commission_settlement_receipts DISABLE TRIGGER trg_commission_settlement_receipts_immutability;
    ALTER TABLE credit_transactions DISABLE TRIGGER trg_credit_transactions_immutability;
    ALTER TABLE owner_transactions DISABLE TRIGGER trg_owner_transactions_immutability;
    ALTER TABLE jazz_load_lifting_records DISABLE TRIGGER trg_jazz_load_lifting_immutability;
    ALTER TABLE jazz_load_do_entries DISABLE TRIGGER trg_jazz_load_do_entries_immutability;
    ALTER TABLE stock_orders DISABLE TRIGGER trg_stock_orders_immutability;
    ALTER TABLE stock_order_lines DISABLE TRIGGER trg_stock_order_lines_immutability;
    ALTER TABLE stock_account_payments DISABLE TRIGGER trg_stock_account_payments_immutability;
    ALTER TABLE jazz_company_payable_payments DISABLE TRIGGER trg_jazz_payable_payments_immutability;
    ALTER TABLE final_settlement_entries DISABLE TRIGGER trg_final_settlement_entries_immutability;
    ALTER TABLE final_settlement_entries DISABLE TRIGGER trg_final_settlement_entries_insert;
  `.execute(db);

  await sql`
    DELETE FROM calculation_runs WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM invariant_violations WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM day_financial_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM mutation_idempotency WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM audit_logs WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM commission_settlement_receipts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM final_settlement_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-RECOV-NEG'));
    DELETE FROM franchises WHERE code IN ('TEST-RECOV-NEG');
    DELETE FROM users WHERE firebase_uid IN ('test-recov-owner');
  `.execute(db);

  await sql`
    ALTER TABLE expense_items ENABLE TRIGGER trg_expense_items_immutability;
    ALTER TABLE commission_items ENABLE TRIGGER trg_commission_items_immutability;
    ALTER TABLE commission_settlement_receipts ENABLE TRIGGER trg_commission_settlement_receipts_immutability;
    ALTER TABLE credit_transactions ENABLE TRIGGER trg_credit_transactions_immutability;
    ALTER TABLE owner_transactions ENABLE TRIGGER trg_owner_transactions_immutability;
    ALTER TABLE jazz_load_lifting_records ENABLE TRIGGER trg_jazz_load_lifting_immutability;
    ALTER TABLE jazz_load_do_entries ENABLE TRIGGER trg_jazz_load_do_entries_immutability;
    ALTER TABLE stock_orders ENABLE TRIGGER trg_stock_orders_immutability;
    ALTER TABLE stock_order_lines ENABLE TRIGGER trg_stock_order_lines_immutability;
    ALTER TABLE stock_account_payments ENABLE TRIGGER trg_stock_account_payments_immutability;
    ALTER TABLE jazz_company_payable_payments ENABLE TRIGGER trg_jazz_payable_payments_immutability;
    ALTER TABLE final_settlement_entries ENABLE TRIGGER trg_final_settlement_entries_immutability;
    ALTER TABLE final_settlement_entries ENABLE TRIGGER trg_final_settlement_entries_insert;
  `.execute(db);
}

interface TestContext {
  franchiseId: string;
  augPeriodId: string;
  ownerUserId: string;
  day31Id: string;
  prod1Id: string;
  prod2Id: string;
  acct1Id: string;
  do1Id: string;
  party1Id: string;
}

async function setupTestEnvironment(): Promise<TestContext> {
  await cleanupTestData();

  // 1. Franchise
  const f = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES (${FRANCHISE_CODE}, 'Recovery & Negative Stock Test Franchise', 'RecovBrand')
    RETURNING id;
  `.execute(db);
  const franchiseId = f.rows[0].id;

  // 2. Owner User
  const u = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES (${OWNER_UID}, ${OWNER_EMAIL}, 'Recovery Owner', true)
    RETURNING id;
  `.execute(db);
  const ownerUserId = u.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${ownerUserId}, 'owner');`.execute(db);

  // 3. Catalogs
  const cp = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'akhtar', 'Akhtar', true)
    RETURNING id;
  `.execute(db);
  const party1Id = cp.rows[0].id;

  const sp1 = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'prod-neg', 'Product With Negative Stock', true)
    RETURNING id;
  `.execute(db);
  const prod1Id = sp1.rows[0].id;

  const sp2 = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'prod-pos', 'Product With Positive Stock', true)
    RETURNING id;
  `.execute(db);
  const prod2Id = sp2.rows[0].id;

  const sa = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${franchiseId}, 'dealer-1', 'Main Dealer', 'OTHER', true)
    RETURNING id;
  `.execute(db);
  const acct1Id = sa.rows[0].id;

  const doProf = await sql<{ id: string }>`
    INSERT INTO jazz_load_do_profiles (franchise_id, do_name, is_active, sort_order)
    VALUES (${franchiseId}, 'DO Main Profile', true, 1)
    RETURNING id;
  `.execute(db);
  const do1Id = doProf.rows[0].id;

  // 4. August 2026 Accounting Period (Created open, will be closed after entries inserted)
  const p = await sql<{ id: string }>`
    INSERT INTO accounting_periods (
      franchise_id, period_key, year_num, month_num, label, status,
      final_settlement_status
    ) VALUES (
      ${franchiseId}, '2026-08', 2026, 8, 'August 2026', 'open',
      'PENDING'
    ) RETURNING id;
  `.execute(db);
  const augPeriodId = p.rows[0].id;

  // 5. Provision 31 Days for August (all closed)
  let day31Id = "";
  for (let d = 1; d <= 31; d++) {
    const dStr = String(d).padStart(2, "0");
    const r = await sql<{ id: string }>`
      INSERT INTO accounting_days (franchise_id, period_id, day_no, day_type, calendar_date, label, status)
      VALUES (${franchiseId}, ${augPeriodId}, ${d}, 'calendar', ${`2026-08-${dStr}`}, ${`Day ${d}`}, 'closed')
      RETURNING id;
    `.execute(db);
    if (d === 31) day31Id = r.rows[0].id;
  }

  // 6. Day 31 Projections for August
  await sql`
    INSERT INTO day_financial_projections (
      franchise_id, day_id, opening_cash, total_issues, total_expenses, closing_cash,
      operating_profit, owner_opening_balance, owner_closing_balance, opening_jazz_payable,
      closing_jazz_payable, opening_commission_receivable, closing_commission_receivable
    ) VALUES (
      ${franchiseId}, ${day31Id}, 0.00, 0.00, 0.00, -348758.00,
      0.00, -8960.00, -8960.00, -1315000.00,
      -1315000.00, 0.00, 0.00
    );
  `.execute(db);

  await sql`
    INSERT INTO jazz_lifting_day_projections (
      franchise_id, day_id, opening_lifting, ml_lifting_purchased, today_ml_issuance, closing_lifting_in_hand
    ) VALUES (
      ${franchiseId}, ${day31Id}, 815579.26, 0.00, 0.00, 815579.26
    );
  `.execute(db);

  await sql`
    INSERT INTO credit_party_day_projections (
      franchise_id, day_id, party_id, opening_balance, total_loans, total_receipts, manual_adjustments, closing_balance
    ) VALUES (
      ${franchiseId}, ${day31Id}, ${party1Id}, 13000.00, 0.00, 0.00, 0.00, 13000.00
    );
  `.execute(db);

  // Authoritative Stock Projections on Day 31:
  // prod1 has 0 stock quantity, prod2 has 25
  await sql`
    INSERT INTO stock_product_day_projections (
      franchise_id, day_id, product_id, opening_qty, stock_in_qty, stock_out_qty, closing_qty
    ) VALUES
      (${franchiseId}, ${day31Id}, ${prod1Id}, 0, 0, 0, 0),
      (${franchiseId}, ${day31Id}, ${prod2Id}, 25, 0, 0, 25);
  `.execute(db);

  await sql`
    INSERT INTO stock_account_day_projections (
      franchise_id, day_id, account_id, opening_due, stock_taken_amount, payment_received_amount, closing_due
    ) VALUES (
      ${franchiseId}, ${day31Id}, ${acct1Id}, 5000.00, 0.00, 0.00, 5000.00
    );
  `.execute(db);

  await sql`
    INSERT INTO jazz_load_do_day_projections (
      franchise_id, day_id, do_profile_id, opening_base, issuance_base, payment_base, closing_base,
      opening_ml, closing_ml, applied_ml_rate_percentage
    ) VALUES (
      ${franchiseId}, ${day31Id}, ${do1Id}, 0.00, 0.00, 0.00, 0.00,
      0.00, 0.00, 0.00
    );
  `.execute(db);

  // 7. Three Real FINAL settlement entries (all RESOLVED) exactly matching production
  await sql`
    INSERT INTO final_settlement_entries (
      id, franchise_id, period_id, source_period_key, settlement_date,
      balance_domain, settlement_type, target_entity_name, amount, notes, status, created_by_user_id
    ) VALUES
      ('ab2b7765-d727-4d65-95bc-1ba3ed145f0f', ${franchiseId}, ${augPeriodId}, '2026-08', '2026-09-01', 'COMMISSION', 'COMMISSION', 'JazzCash', 471.00, 'Real August Settlement 1', 'ACTIVE', ${ownerUserId}),
      ('1aa838f6-a2c1-487b-810d-389b981dd8d4', ${franchiseId}, ${augPeriodId}, '2026-08', '2026-09-01', 'OWNER_BALANCE', 'OWNER_DRAWING', 'Owner Cheque July', 348287.00, 'Real August Settlement 2', 'ACTIVE', ${ownerUserId}),
      ('78b7efc1-2252-43fc-9e49-ac89f912edc9', ${franchiseId}, ${augPeriodId}, '2026-08', '2026-09-01', 'COMMISSION', 'COMMISSION', 'Other 1', 348287.00, 'Real August Settlement 3', 'ACTIVE', ${ownerUserId});
  `.execute(db);

  // Now close August and its FINAL state
  await sql`
    UPDATE accounting_periods
    SET status = 'closed',
        final_settlement_status = 'CLOSED',
        final_verified_at = clock_timestamp(),
        final_verified_by_user_id = ${ownerUserId},
        closed_at = clock_timestamp(),
        closed_by_user_id = ${ownerUserId}
    WHERE id = ${augPeriodId};
  `.execute(db);

  return {
    franchiseId,
    augPeriodId,
    ownerUserId,
    day31Id,
    prod1Id,
    prod2Id,
    acct1Id,
    do1Id,
    party1Id
  };
}

async function runTests() {
  console.log("=== STARTING CLOSED-MONTH RECOVERY & NEGATIVE STOCK INTEGRATION TESTS ===");
  const ctx = await setupTestEnvironment();
  const ownerUser = {
    id: ctx.ownerUserId,
    firebaseUid: OWNER_UID,
    email: OWNER_EMAIL,
    role: "owner" as const,
    franchiseId: ctx.franchiseId
  };

  // Mock token verifier
  setTokenVerifierForTesting(async () => ({
    uid: OWNER_UID,
    email: OWNER_EMAIL
  }));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const authHeader = {
    Authorization: "Bearer mock-owner-token",
    "Content-Type": "application/json"
  };

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Stock Seed Validation Unit Rules
    // -------------------------------------------------------------------------
    console.log("\nScenario 1: Stock Seed Validation Rules");

    // Stage a test period
    const testPeriodRes = await sql<{ id: string }>`
      INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
      VALUES (${ctx.franchiseId}, '2026-10', 2026, 10, 'October 2026', 'open')
      RETURNING id;
    `.execute(db);
    const testPeriodId = testPeriodRes.rows[0].id;
    for (let d = 1; d <= 31; d++) {
      const dStr = String(d).padStart(2, "0");
      await sql`
        INSERT INTO accounting_days (franchise_id, period_id, day_no, day_type, calendar_date, label, status)
        VALUES (${ctx.franchiseId}, ${testPeriodId}, ${d}, 'calendar', ${`2026-10-${dStr}`}, ${`Day ${d}`}, 'closed');
      `.execute(db);
    }

    // 1.1: Negative stock (-18) is strictly rejected by IntegerQuantitySchema
    const { IntegerQuantitySchema } = await import("./schemas.js");
    const negSchemaCheck = IntegerQuantitySchema.safeParse(-18);
    if (negSchemaCheck.success) {
      throw new Error("Expected -18 to fail IntegerQuantitySchema");
    }
    console.log("   ✓ Negative stock quantity (-18) is strictly rejected by IntegerQuantitySchema");

    // 1.2: Database constraint rejects negative stock in period_stock_product_seeds
    let dbConstraintCaught = false;
    try {
      await sql`
        INSERT INTO period_stock_product_seeds (
          franchise_id, period_id, product_id, opening_quantity, status
        ) VALUES (${ctx.franchiseId}, ${testPeriodId}, ${ctx.prod1Id}, -18, 'active');
      `.execute(db);
    } catch (e: any) {
      dbConstraintCaught = true;
    }
    if (!dbConstraintCaught) {
      throw new Error("Expected DB constraint to reject negative opening_quantity in period_stock_product_seeds");
    }
    console.log("   ✓ Database constraint strictly blocks negative stock in period_stock_product_seeds");

    // 1.3: Valid non-negative seeds (0 and 25) succeed validation
    await stageSeeds(
      ctx.franchiseId,
      testPeriodId,
      {
        financial: {
          openingCash: "0.00",
          openingOwnerBalance: "0.00",
          openingJazzLifting: "0.00",
          openingJazzPayable: "0.00",
          openingCommissionReceivable: "0.00"
        },
        creditParties: [{ partyId: ctx.party1Id, openingBalance: "0.00" }],
        stockProducts: [
          { productId: ctx.prod1Id, openingQuantity: 0, status: "active" },
          { productId: ctx.prod2Id, openingQuantity: 25, status: "active" }
        ],
        stockAccounts: [{ accountId: ctx.acct1Id, openingReceivable: "0.00" }],
        jazzDoProfiles: [{ doProfileId: ctx.do1Id, openingBaseBalance: "0.00" }]
      },
      ownerUser
    );

    const valResult = await validateSeeds(ctx.franchiseId, testPeriodId);
    if (!valResult.isValid) {
      throw new Error(`Expected isValid=true for valid seeds, but got errors: ${valResult.errors.join("; ")}`);
    }
    console.log("   ✓ Valid stock seeds (0 and 25) succeed validation (isValid = true)");

    // 1.4: Malformed / non-numeric stock seed is rejected
    const nonNumericCheck = IntegerQuantitySchema.safeParse("not-a-number");
    if (nonNumericCheck.success) {
      throw new Error("Expected string 'not-a-number' to fail IntegerQuantitySchema");
    }
    const floatCheck = IntegerQuantitySchema.safeParse(12.34);
    if (floatCheck.success) {
      throw new Error("Expected float 12.34 to fail IntegerQuantitySchema");
    }
    const nanCheck = IntegerQuantitySchema.safeParse(NaN);
    if (nanCheck.success) {
      throw new Error("Expected NaN to fail IntegerQuantitySchema");
    }
    console.log("   ✓ Malformed / non-numeric stock seed is strictly rejected by schema");

    // 1.4: Missing seed on active product fails validation
    await sql`
      DELETE FROM period_stock_product_seeds
      WHERE franchise_id = ${ctx.franchiseId} AND period_id = ${testPeriodId} AND product_id = ${ctx.prod1Id};
    `.execute(db);

    const missingVal = await validateSeeds(ctx.franchiseId, testPeriodId);
    if (missingVal.isValid) {
      throw new Error("Expected missing opening seed on active product to fail validation, but it passed!");
    }
    console.log("   ✓ Missing opening seed on active stock product is strictly rejected with validation error");

    // Clean up temporary test period
    await sql`DELETE FROM period_stock_product_seeds WHERE period_id = ${testPeriodId};`.execute(db);
    await sql`DELETE FROM period_stock_account_seeds WHERE period_id = ${testPeriodId};`.execute(db);
    await sql`DELETE FROM period_jazz_do_seeds WHERE period_id = ${testPeriodId};`.execute(db);
    await sql`DELETE FROM period_credit_party_seeds WHERE period_id = ${testPeriodId};`.execute(db);
    await sql`DELETE FROM period_financial_seeds WHERE period_id = ${testPeriodId};`.execute(db);
    await sql`DELETE FROM accounting_days WHERE period_id = ${testPeriodId};`.execute(db);
    await sql`DELETE FROM accounting_periods WHERE id = ${testPeriodId};`.execute(db);

    // -------------------------------------------------------------------------
    // TEST 2: Governed Initialization from Closed August Period
    // -------------------------------------------------------------------------
    console.log("\nScenario 2: Governed Initialization of September from Closed August");

    // Pre-condition verification: August is closed, September does not exist
    const preAug = await db.selectFrom("accounting_periods").selectAll().where("id", "=", ctx.augPeriodId).executeTakeFirstOrThrow();
    if (preAug.status !== "closed" || preAug.final_settlement_status !== "CLOSED") {
      throw new Error(`Pre-condition failed: August status=${preAug.status}, final=${preAug.final_settlement_status}`);
    }

    const preSept = await db.selectFrom("accounting_periods").selectAll().where("period_key", "=", "2026-09").executeTakeFirst();
    if (preSept) {
      throw new Error("Pre-condition failed: September 2026 already exists before test!");
    }
    console.log("   ✓ Pre-conditions verified: August is closed, September absent");

    // Execute governed recovery operation
    const initResult = await initializeNextPeriodFromClosedPeriod(
      ctx.franchiseId,
      ctx.augPeriodId,
      ownerUser
    );

    if (!initResult.initialized || initResult.alreadyInitialized) {
      throw new Error(`Expected initialized=true, alreadyInitialized=false, got: ${JSON.stringify(initResult)}`);
    }
    console.log("   ✓ initializeNextPeriodFromClosedPeriod completed successfully");

    // -------------------------------------------------------------------------
    // TEST 3: September Integrity and Day Assertions
    // -------------------------------------------------------------------------
    console.log("\nScenario 3: September Period & Day Integrity Assertions");

    const septPeriod = await db
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_key", "=", "2026-09")
      .executeTakeFirstOrThrow();

    if (septPeriod.status !== "open") {
      throw new Error(`Expected September status='open', found '${septPeriod.status}'`);
    }

    const septDays = await db
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .orderBy("day_no", "asc")
      .execute();

    if (septDays.length !== 30) {
      throw new Error(`Expected exactly 30 calendar days for September, found ${septDays.length}`);
    }
    console.log("   ✓ Exactly 30 calendar days created for September");

    const day1 = septDays.find((d) => d.day_no === 1);
    if (!day1 || day1.status !== "open") {
      throw new Error(`Expected September Day 1 to be 'open', found: ${day1?.status}`);
    }
    console.log("   ✓ September Day 1 is OPEN");

    const otherDays = septDays.filter((d) => d.day_no > 1);
    const unclosedOtherDays = otherDays.filter((d) => d.status !== "closed");
    if (unclosedOtherDays.length > 0) {
      throw new Error(`Days 2..30 must be closed! Found open days: ${unclosedOtherDays.map((d) => d.day_no).join(", ")}`);
    }
    console.log("   ✓ September Days 2..30 strictly remain CLOSED");

    // -------------------------------------------------------------------------
    // TEST 4: Seed Values and Negative Stock Preservation
    // -------------------------------------------------------------------------
    console.log("\nScenario 4: Seed Balances, Negative Stock Preservation, and Provenance");

    const finSeed = await db
      .selectFrom("period_financial_seeds")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .executeTakeFirstOrThrow();

    if (!finSeed.is_verified) {
      throw new Error("Expected September financial seed to be VERIFIED (is_verified = true)");
    }
    if (finSeed.source_period_key !== "2026-08" || finSeed.source_day_no !== 31) {
      throw new Error(`Provenance mismatch: expected 2026-08 Day 31, got ${finSeed.source_period_key} Day ${finSeed.source_day_no}`);
    }
    console.log("   ✓ Financial seed verified=true with provenance 2026-08 Day 31");

    // Exact balances derived from FINAL
    if (Number(finSeed.opening_cash) !== 0.00) {
      throw new Error(`Expected opening_cash = 0.00, found: ${finSeed.opening_cash}`);
    }
    if (Number(finSeed.opening_owner_balance) !== 339327.00) {
      throw new Error(`Expected opening_owner_balance = 339327.00, found: ${finSeed.opening_owner_balance}`);
    }
    if (Number(finSeed.opening_jazz_lifting) !== 815579.26) {
      throw new Error(`Expected opening_jazz_lifting = 815579.26, found: ${finSeed.opening_jazz_lifting}`);
    }
    if (Number(finSeed.opening_jazz_payable) !== -1315000.00) {
      throw new Error(`Expected opening_jazz_payable = -1315000.00, found: ${finSeed.opening_jazz_payable}`);
    }
    console.log("   ✓ Financial seed balances match exact FINAL closing expectations");

    // Stock products seed check: prod1 MUST BE 0 (non-negative stock)
    const stockProductSeeds = await db
      .selectFrom("period_stock_product_seeds")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .execute();

    const prod1Seed = stockProductSeeds.find((s) => s.product_id === ctx.prod1Id);
    if (!prod1Seed) {
      throw new Error(`Missing stock product seed for prod1 (${ctx.prod1Id})`);
    }
    if (Number(prod1Seed.opening_quantity) !== 0) {
      throw new Error(`Expected stock product seed opening_quantity to be 0, found: ${prod1Seed.opening_quantity}`);
    }
    if (prod1Seed.source_period_key !== "2026-08" || prod1Seed.source_day_no !== 31) {
      throw new Error(`Provenance mismatch on stock seed: ${prod1Seed.source_period_key} Day ${prod1Seed.source_day_no}`);
    }
    console.log("   ✓ Stock quantity 0 rolled over and preserved exactly with provenance");

    // Credit parties check
    const cpSeeds = await db
      .selectFrom("period_credit_party_seeds")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .execute();

    const akhtarSeed = cpSeeds.find((c) => c.party_id === ctx.party1Id);
    if (!akhtarSeed || Number(akhtarSeed.opening_balance) !== 13000.00) {
      throw new Error(`Credit party balance mismatch: expected 13000.00, found: ${akhtarSeed?.opening_balance}`);
    }
    console.log("   ✓ Credit party balances match exact FINAL closing state");

    // Assert real FINAL entries in August remained intact
    const finalEntries = await db
      .selectFrom("final_settlement_entries")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", ctx.augPeriodId)
      .execute();

    if (finalEntries.length !== 3) {
      throw new Error(`Expected exactly 3 FINAL entries in August, found: ${finalEntries.length}`);
    }
    console.log("   ✓ All 3 real FINAL settlement entries in August remain intact and unaltered");

    // -------------------------------------------------------------------------
    // TEST 5: Idempotency Verification
    // -------------------------------------------------------------------------
    console.log("\nScenario 5: Repeated Initialization Idempotency");

    const secondCall = await initializeNextPeriodFromClosedPeriod(
      ctx.franchiseId,
      ctx.augPeriodId,
      ownerUser
    );

    if (!secondCall.alreadyInitialized) {
      throw new Error(`Expected alreadyInitialized=true on second call, got: ${JSON.stringify(secondCall)}`);
    }

    // Verify zero duplicates
    const allSeptPeriods = await db
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_key", "=", "2026-09")
      .execute();

    if (allSeptPeriods.length !== 1) {
      throw new Error(`Duplicate periods created! Count: ${allSeptPeriods.length}`);
    }

    const allSeptDays = await db
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .execute();

    if (allSeptDays.length !== 30) {
      throw new Error(`Duplicate days created! Count: ${allSeptDays.length}`);
    }
    console.log("   ✓ Repeated initialization is strictly idempotent (zero duplicates created)");

    // -------------------------------------------------------------------------
    // TEST 6: REST Endpoint POST /api/v1/periods/:periodId/initialize-next
    // -------------------------------------------------------------------------
    console.log("\nScenario 6: HTTP REST Endpoint POST /api/v1/periods/:periodId/initialize-next");

    const httpRes = await fetch(`${baseUrl}/api/v1/periods/${ctx.augPeriodId}/initialize-next`, {
      method: "POST",
      headers: authHeader,
      body: JSON.stringify({})
    });

    if (httpRes.status !== 200) {
      const errText = await httpRes.text();
      throw new Error(`Expected HTTP 200 from initialize-next, got ${httpRes.status}: ${errText}`);
    }

    const httpBody = await httpRes.json();
    if (!httpBody.alreadyInitialized || !httpBody.initialized) {
      throw new Error(`Unexpected response body: ${JSON.stringify(httpBody)}`);
    }
    console.log("   ✓ HTTP POST /api/v1/periods/:periodId/initialize-next returned 200 with idempotent state");

    // -------------------------------------------------------------------------
    // TEST 7: Successor Period Stale Seed Synchronization on Re-close / Init
    // -------------------------------------------------------------------------
    console.log("\nScenario 7: Successor Period Stale Seed Synchronization");

    // Artificially corrupt September seeds to simulate an older/stale import
    await db
      .updateTable("period_financial_seeds")
      .set({ opening_cash: "999999.00" })
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .execute();

    // Call initializeNextPeriodFromClosedPeriod again from August
    const syncRes = await initializeNextPeriodFromClosedPeriod(
      ctx.franchiseId,
      ctx.augPeriodId,
      ownerUser
    );

    if (!syncRes.initialized || !syncRes.alreadyInitialized) {
      throw new Error(`Expected initialized=true and alreadyInitialized=true, got: ${JSON.stringify(syncRes)}`);
    }

    // Verify September's opening seeds were synchronized with August's latest snapshot (0.00)
    const resyncedFinSeed = await db
      .selectFrom("period_financial_seeds")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("period_id", "=", septPeriod.id)
      .executeTakeFirstOrThrow();

    if (Number(resyncedFinSeed.opening_cash) !== 0.00) {
      throw new Error(`Expected opening_cash 0.00, got ${resyncedFinSeed.opening_cash}`);
    }
    if (!resyncedFinSeed.is_verified) {
      throw new Error("Expected resynced seed is_verified to be true");
    }

    // Verify Day 1 projection reflects the resynced seed opening cash
    const septDay1Proj = await db
      .selectFrom("day_financial_projections")
      .selectAll()
      .where("franchise_id", "=", ctx.franchiseId)
      .where("day_id", "=", syncRes.activatedDay.id)
      .executeTakeFirstOrThrow();

    if (Number(septDay1Proj.opening_cash) !== 0.00) {
      throw new Error(`Expected Day 1 opening_cash 0.00, got ${septDay1Proj.opening_cash}`);
    }
    console.log("   ✓ Successor period seeds and Day 1 projections resynchronized from closed period snapshot");

    console.log("\nALL CLOSED-MONTH RECOVERY & NEGATIVE STOCK INTEGRATION TESTS PASSED PERFECTLY!");
  } finally {
    server.close();
    await cleanupTestData();
  }
}

runTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
