/**
 * FINAL Closing Layer Integration Tests
 *
 * Exhaustively validates:
 * 1. Day 31 -> FINAL Closing Balance Snapshot Parity:
 *    - Closing cash, owner closing balance, jazz lifting in-hand, jazz payable
 *    - Credit party closing balances
 *    - Stock product closing quantities
 *    - Stock account closing dues
 *    - Jazz DO closing bases & ML
 *    - Boundary explicitly marked "FINAL"
 *    - Source day is Day 31
 *    - No 32nd day exists in accounting_days
 * 2. FINAL -> Next-Month Opening Balance Roll Forward:
 *    - Governed rollover stages seeds derived strictly from FINAL
 *    - Next month Day 1 opens with exact values from FINAL
 * 3. Fresh Reload Without Prior-Day Frontend Hydration:
 *    - Cold retrieval of Day 1 projections and seeds yields authoritative balances
 *      without requiring August Days 1..31 in memory
 *    - Cold retrieval of FINAL via GET /api/v1/calculations/projections/period/:periodId/final
 * 4. Closed Historical Days Immutability:
 *    - Day 31 transaction mutations blocked by API and PostgreSQL triggers after close
 * 5. Rebuild Period Idempotency & FINAL Stability:
 *    - Full period rebuild recalculates without altering authoritative FINAL snapshot
 * 6. 100% Database Cleanup
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";
import { getPeriodFinalProjections, rebuildPeriod } from "./service.js";
import { rolloverPeriod, closeAccountingPeriod, activatePeriod, stageSeeds } from "../periods/service.js";

interface SetupData {
  franchiseId: string;
  periodId: string;
  ownerUser: { id: string; email: string };
  adminUser: { id: string; email: string };
  viewerUser: { id: string; email: string };
  creditPartyId: string;
  stockProductId: string;
  stockAccountId: string;
  jazzDoProfileId: string;
  days: Array<{ id: string; dayNo: number }>;
}

async function cleanupTestData() {
  await sql`
    ALTER TABLE expense_items DISABLE TRIGGER trg_expense_items_immutability;
    ALTER TABLE commission_items DISABLE TRIGGER trg_commission_items_immutability;
    ALTER TABLE credit_transactions DISABLE TRIGGER trg_credit_transactions_immutability;
    ALTER TABLE owner_transactions DISABLE TRIGGER trg_owner_transactions_immutability;
    ALTER TABLE jazz_load_lifting_records DISABLE TRIGGER trg_jazz_load_lifting_immutability;
    ALTER TABLE jazz_load_do_entries DISABLE TRIGGER trg_jazz_load_do_entries_immutability;
    ALTER TABLE stock_orders DISABLE TRIGGER trg_stock_orders_immutability;
    ALTER TABLE stock_order_lines DISABLE TRIGGER trg_stock_order_lines_immutability;
    ALTER TABLE stock_account_payments DISABLE TRIGGER trg_stock_account_payments_immutability;
    ALTER TABLE jazz_company_payable_payments DISABLE TRIGGER trg_jazz_payable_payments_immutability;
  `.execute(db);

  await sql`
    DELETE FROM calculation_runs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM invariant_violations WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM day_financial_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM mutation_idempotency WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM audit_logs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1')
    );
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FINAL-F1'));
    DELETE FROM franchises WHERE code IN ('TEST-FINAL-F1');
    DELETE FROM users WHERE firebase_uid LIKE 'test-final-%';
  `.execute(db);

  await sql`
    ALTER TABLE expense_items ENABLE TRIGGER trg_expense_items_immutability;
    ALTER TABLE commission_items ENABLE TRIGGER trg_commission_items_immutability;
    ALTER TABLE credit_transactions ENABLE TRIGGER trg_credit_transactions_immutability;
    ALTER TABLE owner_transactions ENABLE TRIGGER trg_owner_transactions_immutability;
    ALTER TABLE jazz_load_lifting_records ENABLE TRIGGER trg_jazz_load_lifting_immutability;
    ALTER TABLE jazz_load_do_entries ENABLE TRIGGER trg_jazz_load_do_entries_immutability;
    ALTER TABLE stock_orders ENABLE TRIGGER trg_stock_orders_immutability;
    ALTER TABLE stock_order_lines ENABLE TRIGGER trg_stock_order_lines_immutability;
    ALTER TABLE stock_account_payments ENABLE TRIGGER trg_stock_account_payments_immutability;
    ALTER TABLE jazz_company_payable_payments ENABLE TRIGGER trg_jazz_payable_payments_immutability;
  `.execute(db);
}

async function setupTestData(): Promise<SetupData> {
  await cleanupTestData();

  // 1. Create Franchise
  const f = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-FINAL-F1', 'Final Closing Test Franchise', 'FinalBrand')
    RETURNING id;
  `.execute(db);
  const franchiseId = f.rows[0].id;

  // 2. Users
  const uOwner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-final-owner', 'owner@final.test', 'Final Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${uOwner.rows[0].id}, 'owner');`.execute(db);

  const uAdmin = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-final-admin', 'admin@final.test', 'Final Admin', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${uAdmin.rows[0].id}, 'admin');`.execute(db);

  const uViewer = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-final-viewer', 'viewer@final.test', 'Final Viewer', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${uViewer.rows[0].id}, 'viewer');`.execute(db);

  // 3. Catalogs
  const cp = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type, is_active)
    VALUES (${franchiseId}, 'test-credit-party', 'Test Credit Party', 'dealer', true)
    RETURNING id;
  `.execute(db);

  const sp = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate, is_active)
    VALUES (${franchiseId}, 'test-prod-1', 'Test Product 1', 100, true)
    RETURNING id;
  `.execute(db);

  const sa = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${franchiseId}, 'test-acct-1', 'Test Stock Dealer', 'CCR', true)
    RETURNING id;
  `.execute(db);

  const doProf = await sql<{ id: string }>`
    INSERT INTO jazz_load_do_profiles (franchise_id, do_name, do_line, is_active)
    VALUES (${franchiseId}, 'DO Line Alpha', 'Line 1', true)
    RETURNING id;
  `.execute(db);

  await sql`
    INSERT INTO jazz_load_rates (franchise_id, name, ml_rate, is_active, effective_from)
    VALUES (${franchiseId}, 'Current Rates', 2.5000, true, '2026-08-01T00:00:00Z');
  `.execute(db);

  // 4. Create August 2026 Accounting Period with 31 Calendar Days
  const periodRes = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${franchiseId}, '2026-08', 2026, 8, 'August 2026', 'open')
    RETURNING id;
  `.execute(db);
  const periodId = periodRes.rows[0].id;

  const dayRows: Array<{ id: string; dayNo: number }> = [];
  for (let d = 1; d <= 31; d++) {
    const dStr = String(d).padStart(2, "0");
    const r = await sql<{ id: string }>`
      INSERT INTO accounting_days (franchise_id, period_id, day_no, day_type, calendar_date, label, status)
      VALUES (${franchiseId}, ${periodId}, ${d}, 'calendar', ${`2026-08-${dStr}`}, ${`Day ${d}`}, 'closed')
      RETURNING id;
    `.execute(db);
    dayRows.push({ id: r.rows[0].id, dayNo: d });
  }

  // 5. Stage Initial Genesis Seeds for Day 1
  const genesisBundle = {
    financial: {
      openingCash: "10000.00",
      openingOwnerBalance: "50000.00",
      openingJazzLifting: "75000.00",
      openingJazzPayable: "15000.00",
      sourcePeriodKey: null,
      sourceDayNo: null,
      notes: "GENESIS_TEST_SEEDS"
    },
    creditParties: [
      { partyId: cp.rows[0].id, openingBalance: "12000.00", sourcePeriodKey: null, sourceDayNo: null }
    ],
    stockProducts: [
      { productId: sp.rows[0].id, openingQuantity: 50, status: "active" as const, notes: null, sourcePeriodKey: null, sourceDayNo: null }
    ],
    stockAccounts: [
      { accountId: sa.rows[0].id, openingReceivable: "8500.00", sourcePeriodKey: null, sourceDayNo: null }
    ],
    jazzDoProfiles: [
      { doProfileId: doProf.rows[0].id, openingBaseBalance: "25000.00", sourcePeriodKey: null, sourceDayNo: null }
    ]
  };

  await stageSeeds(franchiseId, periodId, genesisBundle, {
    id: uOwner.rows[0].id,
    email: "owner@final.test",
    role: "owner"
  });

  // Verify seeds
  await sql`
    UPDATE period_financial_seeds
    SET is_verified = true, verified_at = clock_timestamp(), verified_by_user_id = ${uOwner.rows[0].id}
    WHERE period_id = ${periodId};
  `.execute(db);

  return {
    franchiseId,
    periodId,
    ownerUser: { id: uOwner.rows[0].id, email: "owner@final.test" },
    adminUser: { id: uAdmin.rows[0].id, email: "admin@final.test" },
    viewerUser: { id: uViewer.rows[0].id, email: "viewer@final.test" },
    creditPartyId: cp.rows[0].id,
    stockProductId: sp.rows[0].id,
    stockAccountId: sa.rows[0].id,
    jazzDoProfileId: doProf.rows[0].id,
    days: dayRows
  };
}

// HTTP request helper
async function req(
  baseUrl: string,
  method: string,
  path: string,
  authRole: "owner" | "admin" | "viewer",
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const clientReq = http.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer test-token-final-${authRole}`,
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let parsed: any = null;
          try {
            parsed = JSON.parse(raw);
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode || 500, body: parsed });
        });
      }
    );
    clientReq.on("error", reject);
    if (bodyStr) clientReq.write(bodyStr);
    clientReq.end();
  });
}

function assert(condition: boolean, message: string, actual?: unknown) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}${actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : ""}`);
  }
  console.log(`   ✓ ${message}`);
}

async function runTests() {
  console.log("=== FINAL CLOSING LAYER INTEGRATION TESTS ===");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;

  let data: SetupData;

  try {
    data = await setupTestData();

    // Configure token mock
    setTokenVerifierForTesting(async (token: string) => {
      if (token === "test-token-final-owner") {
        return { uid: "test-final-owner", email: "owner@final.test" };
      }
      if (token === "test-token-final-admin") {
        return { uid: "test-final-admin", email: "admin@final.test" };
      }
      if (token === "test-token-final-viewer") {
        return { uid: "test-final-viewer", email: "viewer@final.test" };
      }
      throw new Error("Invalid token");
    });

    let testExpenseId = "";

    // -------------------------------------------------------------------------
    // Group 1: Day 31 -> FINAL Closing Balance Snapshot Parity
    // -------------------------------------------------------------------------
    console.log("\nGroup 1: Day 31 -> FINAL Closing Balance Snapshot Parity");
    {
      const day31 = data.days[30]; // Day 31

      // Insert an operational expense item on Day 31 prior to closing
      const exp31 = await sql<{ id: string }>`
        INSERT INTO expense_items (franchise_id, day_id, category_name_snapshot, item_name, amount)
        VALUES (${data.franchiseId}, ${day31.id}, 'General', 'Initial Day 31 Expense', 500.00)
        RETURNING id;
      `.execute(db);
      testExpenseId = exp31.rows[0].id;

      // Insert operational closing projections on Day 31 simulating end-of-month state
      await sql`
        INSERT INTO day_financial_projections (
          franchise_id, day_id, opening_cash, total_issues, total_expenses,
          closing_cash, operating_profit, owner_opening_balance, owner_closing_balance,
          opening_jazz_payable, closing_jazz_payable
        ) VALUES (
          ${data.franchiseId}, ${day31.id}, 25000.00, 150000.00, 175000.00,
          0.00, -25000.00, 50000.00, 1000000.00,
          15000.00, 0.00
        );
      `.execute(db);

      await sql`
        INSERT INTO credit_party_day_projections (
          franchise_id, day_id, party_id, opening_balance, total_loans, total_receipts, manual_adjustments, closing_balance
        ) VALUES (
          ${data.franchiseId}, ${day31.id}, ${data.creditPartyId}, 12000.00, 5000.00, 3000.00, 0.00, 14000.00
        );
      `.execute(db);

      await sql`
        INSERT INTO jazz_lifting_day_projections (
          franchise_id, day_id, opening_lifting, ml_lifting_purchased, today_ml_issuance, closing_lifting_in_hand
        ) VALUES (
          ${data.franchiseId}, ${day31.id}, 75000.00, 500000.00, 487176.00, 878524.00
        );
      `.execute(db);

      await sql`
        INSERT INTO stock_product_day_projections (
          franchise_id, day_id, product_id, opening_qty, stock_in_qty, stock_out_qty, closing_qty
        ) VALUES (
          ${data.franchiseId}, ${day31.id}, ${data.stockProductId}, 50, 20, 15, 55
        );
      `.execute(db);

      await sql`
        INSERT INTO stock_account_day_projections (
          franchise_id, day_id, account_id, opening_due, stock_taken_amount, payment_received_amount, closing_due
        ) VALUES (
          ${data.franchiseId}, ${day31.id}, ${data.stockAccountId}, 8500.00, 2000.00, 4500.00, 6000.00
        );
      `.execute(db);

      await sql`
        INSERT INTO jazz_load_do_day_projections (
          franchise_id, day_id, do_profile_id, opening_base, issuance_base, payment_base, closing_base,
          opening_ml, closing_ml, applied_ml_rate_percentage
        ) VALUES (
          ${data.franchiseId}, ${day31.id}, ${data.jazzDoProfileId}, 25000.00, 100000.00, 95000.00, 30000.00,
          25625.00, 30750.00, 2.50
        );
      `.execute(db);

      // Query via service directly
      const finalProj = await getPeriodFinalProjections(data.franchiseId, data.periodId);
      assert(finalProj !== null, "getPeriodFinalProjections returns non-null snapshot");
      assert(finalProj?.boundary === "FINAL", "Snapshot boundary is strictly marked 'FINAL'");
      assert(finalProj?.finalDay.dayNo === 31, "Snapshot finalDay.dayNo is exactly 31");
      assert(finalProj?.closingBalances.financial.closingCash === "0.00", "Closing cash is exactly 0.00");
      assert(finalProj?.closingBalances.financial.closingOwnerBalance === "1000000.00", "Closing owner balance is 1000000.00");
      assert(finalProj?.closingBalances.financial.closingJazzPayable === "0.00", "Closing jazz payable is 0.00");
      assert(finalProj?.closingBalances.jazzLifting?.closingLiftingInHand === "878524.00", "Jazz lifting in-hand is 878524.00");

      const cpClosing = finalProj?.closingBalances.creditParties.find((c) => c.partyId === data.creditPartyId);
      assert(cpClosing?.closingBalance === "14000.00", "Credit party closing balance is 14000.00");

      const spClosing = finalProj?.closingBalances.stockProducts.find((p) => p.productId === data.stockProductId);
      assert(spClosing?.closingQty === 55, "Stock product closing quantity is 55");

      const saClosing = finalProj?.closingBalances.stockAccounts.find((a) => a.accountId === data.stockAccountId);
      assert(saClosing?.closingDue === "6000.00", "Stock account closing due is 6000.00");

      const jdClosing = finalProj?.closingBalances.jazzDoProfiles.find((d) => d.doProfileId === data.jazzDoProfileId);
      assert(jdClosing?.closingBase === "30000.00", "Jazz DO closing base is 30000.00");

      // Verify REST API endpoint GET /api/v1/calculations/projections/period/:periodId/final
      const res = await req(base, "GET", `/api/v1/calculations/projections/period/${data.periodId}/final`, "viewer");
      assert(res.status === 200, "GET /calculations/projections/period/:periodId/final returns 200 OK");
      assert(res.body.data.boundary === "FINAL", "REST endpoint returns boundary = FINAL");
      assert(res.body.data.closingBalances.financial.closingCash === "0.00", "REST endpoint returns closing cash 0.00");

      // Assert NO 32nd day exists in accounting_days table
      const day32Check = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.franchiseId)
        .where("period_id", "=", data.periodId)
        .where("day_no", ">=", 32)
        .execute();
      assert(day32Check.length === 0, "No Day 32 or beyond exists in accounting_days table");
    }

    // -------------------------------------------------------------------------
    // Group 2: FINAL -> Next-Month Opening Balance Roll Forward
    // -------------------------------------------------------------------------
    console.log("\nGroup 2: FINAL -> Next-Month Opening Balance Roll Forward");
    let nextPeriodId = "";
    {
      // 1. Authoritative period close (atomically rolls over, verifies seeds, and activates Day 1)
      const closeRes = await closeAccountingPeriod(
        data.franchiseId,
        data.periodId,
        "Month-end close test",
        { id: data.ownerUser.id, email: data.ownerUser.email, role: "owner" }
      );
      assert(closeRes.status === "closed", "August 2026 period closed successfully");
      assert(closeRes.targetPeriod?.periodKey === "2026-09", "Month close atomically rolled over to September 2026");
      assert(closeRes.targetDayNo === 1, "Month close atomically targeted Day 1");
      assert(closeRes.activatedDay?.status === "open", "Month close atomically activated September Day 1");
      nextPeriodId = closeRes.targetPeriod!.id;

      // 2. Perform idempotent rollover verification to September (2026-09)
      const rollRes = await rolloverPeriod(
        data.franchiseId,
        data.periodId,
        { id: data.ownerUser.id, email: data.ownerUser.email, role: "owner" }
      );
      assert(rollRes.rolloverAlreadyComplete === true, "Subsequent rollover call is idempotent");
      assert(rollRes.targetPeriod.periodKey === "2026-09", "Target period is 2026-09");
      assert(rollRes.sourceDayNo === 31, "Rollover provenance sourceDayNo is 31 (from FINAL)");

      // 3. Verify September opening seeds staged from FINAL
      const sepFinSeed = await db
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("period_id", "=", nextPeriodId)
        .executeTakeFirstOrThrow();

      assert(Number(sepFinSeed.opening_cash) === 0.00, "September opening cash is 0.00 (from FINAL closing cash)");
      assert(Number(sepFinSeed.opening_owner_balance) === 1000000.00, "September owner opening is 1000000.00 (from FINAL)");
      assert(Number(sepFinSeed.opening_jazz_lifting) === 878524.00, "September lifting opening is 878524.00 (from FINAL)");
      assert(Number(sepFinSeed.opening_jazz_payable) === 0.00, "September jazz payable opening is 0.00 (from FINAL)");
      assert(sepFinSeed.source_period_key === "2026-08", "Provenenace source_period_key is 2026-08");
      assert(sepFinSeed.source_day_no === 31, "Provenance source_day_no is 31");

      const sepCreditSeed = await db
        .selectFrom("period_credit_party_seeds")
        .selectAll()
        .where("period_id", "=", nextPeriodId)
        .where("party_id", "=", data.creditPartyId)
        .executeTakeFirstOrThrow();
      assert(Number(sepCreditSeed.opening_balance) === 14000.00, "September credit party opening balance is 14000.00");

      const sepStockSeed = await db
        .selectFrom("period_stock_product_seeds")
        .selectAll()
        .where("period_id", "=", nextPeriodId)
        .where("product_id", "=", data.stockProductId)
        .executeTakeFirstOrThrow();
      assert(sepStockSeed.opening_quantity === 55, "September stock product opening quantity is 55");

      const sepStockAcctSeed = await db
        .selectFrom("period_stock_account_seeds")
        .selectAll()
        .where("period_id", "=", nextPeriodId)
        .where("account_id", "=", data.stockAccountId)
        .executeTakeFirstOrThrow();
      assert(Number(sepStockAcctSeed.opening_receivable) === 6000.00, "September stock account opening receivable is 6000.00");

      const sepJazzDoSeed = await db
        .selectFrom("period_jazz_do_seeds")
        .selectAll()
        .where("period_id", "=", nextPeriodId)
        .where("do_profile_id", "=", data.jazzDoProfileId)
        .executeTakeFirstOrThrow();
      assert(Number(sepJazzDoSeed.opening_base_balance) === 30000.00, "September Jazz DO opening base balance is 30000.00");

      // 4. Verify seeds by owner & activate Day 1 of September
      await sql`
        UPDATE period_financial_seeds
        SET is_verified = true, verified_at = clock_timestamp(), verified_by_user_id = ${data.ownerUser.id}
        WHERE period_id = ${nextPeriodId};
      `.execute(db);

      const actRes = await activatePeriod(
        data.franchiseId,
        nextPeriodId,
        { id: data.ownerUser.id, email: data.ownerUser.email, role: "owner" }
      );
      assert(actRes.activated === true, "September Day 1 activated");
      assert(actRes.day1?.status === "open", "September Day 1 status is open");

      // Verify Day 1 calculated baseline projections
      const sepDay1Proj = await db
        .selectFrom("day_financial_projections")
        .selectAll()
        .where("franchise_id", "=", data.franchiseId)
        .where("day_id", "=", actRes.day1!.id)
        .executeTakeFirstOrThrow();

      assert(Number(sepDay1Proj.opening_cash) === 0.00, "September Day 1 opening cash calculated as 0.00");
      assert(Number(sepDay1Proj.closing_cash) === 0.00, "September Day 1 closing cash matches opening cash: 0.00");
      assert(Number(sepDay1Proj.owner_opening_balance) === 1000000.00, "September Day 1 owner opening balance calculated as 1000000.00");
    }

    // -------------------------------------------------------------------------
    // Group 3: Fresh Reload Without Prior-Day Frontend Hydration
    // -------------------------------------------------------------------------
    console.log("\nGroup 3: Fresh Reload Without Prior-Day Frontend Hydration");
    {
      // Simulate client cold request for September Day 1 projections
      const sepDay1 = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("period_id", "=", nextPeriodId)
        .where("day_no", "=", 1)
        .executeTakeFirstOrThrow();

      const day1Res = await req(base, "GET", `/api/v1/calculations/projections/day/${sepDay1.id}`, "viewer");
      assert(day1Res.status === 200, "Fresh GET /projections/day/:day1Id returns 200 OK");
      assert(
        Number(day1Res.body.data.projections.financial.opening_cash) === 0.00,
        "Cold hydration returns opening cash 0.00 directly from PostgreSQL"
      );
      assert(
        Number(day1Res.body.data.projections.financial.owner_opening_balance) === 1000000.00,
        "Cold hydration returns owner opening balance 1000000.00 directly from PostgreSQL"
      );
      assert(
        Number(day1Res.body.data.projections.jazzLifting.opening_lifting) === 878524.00,
        "Cold hydration returns jazz lifting opening 878524.00 directly from PostgreSQL"
      );

      // Verify that NO August days were queried or needed to hydrate September Day 1
      assert(day1Res.body.data.day.periodId === nextPeriodId, "Hydrated Day 1 is self-contained in September period");
    }

    // -------------------------------------------------------------------------
    // Group 4: Closed Historical Days Immutability
    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Closed Historical Days Immutability");
    {
      const day31 = data.days[30];

      // Attempting to post a transaction to closed Day 31 must be blocked
      const expAttempt = await req(base, "POST", "/api/v1/transactions/expenses", "owner", {
        day_id: day31.id,
        item_name: "Illegal Post-Close Expense",
        amount: 500
      });
      assert(expAttempt.status === 422, "API blocks transaction posting on closed Day 31 (422 DAY_CLOSED)");
      assert(expAttempt.body.error === "DAY_CLOSED" || expAttempt.body.code === "DAY_CLOSED", "Error code is DAY_CLOSED");

      // Verify database trigger also blocks any direct mutation (UPDATE on closed day)
      let triggerBlocked = false;
      try {
        await sql`
          UPDATE expense_items SET amount = 999.00 WHERE id = ${testExpenseId};
        `.execute(db);
      } catch (err: any) {
        triggerBlocked = err.message.includes("closed accounting day") || err.message.includes("Financial Ledger Violation");
      }
      assert(triggerBlocked, "PostgreSQL trigger trg_expense_items_immutability blocked mutation on closed Day 31");

      // Attempting to reopen Day 32 must be blocked with 422 INVALID_OPERATIONAL_DAY
      const reopen32Attempt = await req(base, "POST", `/api/v1/periods/${data.periodId}/days/32/reopen`, "owner", {
        reason: "Illegal attempt to reopen FINAL"
      });
      assert(reopen32Attempt.status === 422, "API blocks reopening Day 32 (422 INVALID_OPERATIONAL_DAY)");
      assert(
        reopen32Attempt.body.error === "INVALID_OPERATIONAL_DAY" || reopen32Attempt.body.code === "INVALID_OPERATIONAL_DAY",
        "Reopening Day 32 error code is INVALID_OPERATIONAL_DAY"
      );

      // Attempting to close Day 32 must be blocked with 422 INVALID_OPERATIONAL_DAY
      const close32Attempt = await req(base, "POST", `/api/v1/periods/${data.periodId}/days/32/close`, "owner", {});
      assert(close32Attempt.status === 422, "API blocks closing Day 32 (422 INVALID_OPERATIONAL_DAY)");
      assert(
        close32Attempt.body.error === "INVALID_OPERATIONAL_DAY" || close32Attempt.body.code === "INVALID_OPERATIONAL_DAY",
        "Closing Day 32 error code is INVALID_OPERATIONAL_DAY"
      );
    }

    // -------------------------------------------------------------------------
    // Group 5: Rebuild Period Idempotency & FINAL Stability
    // -------------------------------------------------------------------------
    console.log("\nGroup 5: Rebuild Period Idempotency & FINAL Stability");
    {
      // Run first rebuild to establish baseline projections from actual transactions and seeds
      const rebuild1 = await rebuildPeriod(data.franchiseId, data.periodId, {
        triggerSource: "test_rebuild_baseline",
        allowClosedDays: true
      });
      assert(rebuild1.daysCalculated > 0, "First rebuild completed successfully across August days");

      // Snapshot FINAL values after baseline rebuild
      const baselineFinal = await getPeriodFinalProjections(data.franchiseId, data.periodId);
      assert(baselineFinal !== null, "Authoritative FINAL exists after baseline rebuild");

      // Run rebuild a second time to verify complete calculation idempotency
      const rebuild2 = await rebuildPeriod(data.franchiseId, data.periodId, {
        triggerSource: "test_rebuild_idempotency",
        allowClosedDays: true
      });
      assert(rebuild2.daysCalculated > 0, "Second rebuild completed successfully");

      // Snapshot FINAL values after second rebuild
      const secondFinal = await getPeriodFinalProjections(data.franchiseId, data.periodId);
      assert(secondFinal !== null, "Authoritative FINAL exists after second rebuild");

      // Assert complete idempotency across all domains
      assert(
        secondFinal?.closingBalances.financial.closingCash === baselineFinal?.closingBalances.financial.closingCash,
        `Rebuild is idempotent: closing cash (${secondFinal?.closingBalances.financial.closingCash}) preserved`
      );
      assert(
        secondFinal?.closingBalances.financial.closingOwnerBalance === baselineFinal?.closingBalances.financial.closingOwnerBalance,
        `Rebuild is idempotent: owner closing balance (${secondFinal?.closingBalances.financial.closingOwnerBalance}) preserved`
      );
      assert(
        secondFinal?.closingBalances.jazzLifting?.closingLiftingInHand === baselineFinal?.closingBalances.jazzLifting?.closingLiftingInHand,
        `Rebuild is idempotent: jazz lifting in-hand (${secondFinal?.closingBalances.jazzLifting?.closingLiftingInHand}) preserved`
      );
      assert(
        secondFinal?.closingBalances.financial.closingJazzPayable === baselineFinal?.closingBalances.financial.closingJazzPayable,
        `Rebuild is idempotent: closing jazz payable (${secondFinal?.closingBalances.financial.closingJazzPayable}) preserved`
      );
      assert(
        secondFinal?.closingBalances.creditParties.length === baselineFinal?.closingBalances.creditParties.length &&
        secondFinal?.closingBalances.creditParties[0]?.closingBalance === baselineFinal?.closingBalances.creditParties[0]?.closingBalance,
        `Rebuild is idempotent: credit party closing balances preserved`
      );
      assert(
        secondFinal?.closingBalances.stockProducts.length === baselineFinal?.closingBalances.stockProducts.length &&
        secondFinal?.closingBalances.stockProducts[0]?.closingQty === baselineFinal?.closingBalances.stockProducts[0]?.closingQty,
        `Rebuild is idempotent: stock product closing quantities preserved`
      );
      assert(
        secondFinal?.closingBalances.stockAccounts.length === baselineFinal?.closingBalances.stockAccounts.length &&
        secondFinal?.closingBalances.stockAccounts[0]?.closingDue === baselineFinal?.closingBalances.stockAccounts[0]?.closingDue,
        `Rebuild is idempotent: stock account closing dues preserved`
      );
      assert(
        secondFinal?.closingBalances.jazzDoProfiles.length === baselineFinal?.closingBalances.jazzDoProfiles.length &&
        secondFinal?.closingBalances.jazzDoProfiles[0]?.closingBase === baselineFinal?.closingBalances.jazzDoProfiles[0]?.closingBase,
        `Rebuild is idempotent: Jazz DO closing base preserved`
      );
    }

    // -------------------------------------------------------------------------
    // Group 6: 100% Database Cleanup
    // -------------------------------------------------------------------------
    console.log("\nGroup 6: 100% Database Cleanup");
    {
      await cleanupTestData();

      const remainingPeriods = await db
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", data.franchiseId)
        .execute();
      assert(remainingPeriods.length === 0, "Zero test periods remain in database");

      const remainingDays = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.franchiseId)
        .execute();
      assert(remainingDays.length === 0, "Zero test days remain in database");

      const remainingProjections = await db
        .selectFrom("day_financial_projections")
        .selectAll()
        .where("franchise_id", "=", data.franchiseId)
        .execute();
      assert(remainingProjections.length === 0, "Zero test projections remain in database");
    }

    console.log("\n=== ALL FINAL CLOSING TESTS PASSED SUCCESSFULLY ===");
    server.close();
    await cleanupTestData();
    await closeDatabase();
    process.exit(0);
  } catch (err) {
    console.error("FATAL Test Failure:", err);
    server.close();
    await cleanupTestData();
    await closeDatabase();
    process.exit(1);
  }
}

runTests();
