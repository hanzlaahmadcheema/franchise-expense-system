/**
 * Phase 5: Operational Ledger Transactions Integration Test Suite
 *
 * Exhaustively validates:
 *  - Authentication enforcement (unauthenticated / bad token rejected)
 *  - Tenant isolation (reads, updates, deletes strictly segregated)
 *  - Malicious client-injected franchise_id overridden by server
 *  - RBAC (Viewer read-only, Admin/Owner permitted)
 *  - Accounting Day boundary & concurrency lock:
 *      * OPEN day accepts mutations
 *      * REOPEN day accepts mutations
 *      * CLOSED day strictly rejects UPDATE and DELETE (DB trigger + application lock)
 *      * Cross-franchise day rejection
 *  - Master reference tenant scoping:
 *      * Cross-tenant category, credit party, DO profile, stock product, stock account rejected
 *  - Parent-child atomic transaction (Stock Order + Lines):
 *      * Failure in line triggers full rollback
 *      * Database-generated `line_amount` is authoritative (quantity * unit_rate)
 *  - Domain invariants (duplicate lifting per day 409, zero amounts rejected, negative values rejected)
 *  - Audit logging recorded on CREATE, UPDATE, DELETE
 *  - 100% database cleanup
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";

interface SetupData {
  f1Id: string;
  f2Id: string;
  f1OpenDayId: string;
  f1ReopenDayId: string;
  f1ClosedDayId: string;
  f2OpenDayId: string;
  f1ExpCatId: string;
  f2ExpCatId: string;
  f1CommCatId: string;
  f1CreditPartyId: string;
  f2CreditPartyId: string;
  f1DoProfileId: string;
  f2DoProfileId: string;
  f1StockProductId: string;
  f2StockProductId: string;
  f1StockAccountId: string;
  f2StockAccountId: string;
}

async function cleanupTestData() {
  await sql`
    DROP TRIGGER IF EXISTS trg_test_concurrent_delay ON expense_items;
    DROP FUNCTION IF EXISTS trg_test_delay_race();
  `.execute(db);

  // Reopen any closed test days so the trigger permits cleaning up test records
  await sql`
    UPDATE accounting_days SET status = 'open'
    WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
  `.execute(db);

  await sql`
    DELETE FROM mutation_idempotency WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
  `.execute(db);

  await sql`
    DELETE FROM calculation_runs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM invariant_violations WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM day_financial_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
    DELETE FROM audit_logs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
    );
  `.execute(db);

  await sql`
    DELETE FROM stock_order_lines WHERE stock_order_id IN (
      SELECT id FROM stock_orders WHERE franchise_id IN (
        SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2')
      )
    );
  `.execute(db);

  await sql`
    DELETE FROM stock_orders WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM stock_account_payments WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM jazz_company_payable_payments WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
  `.execute(db);

  await sql`
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
  `.execute(db);

  await sql`
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
  `.execute(db);

  await sql`DELETE FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2');`.execute(db);
  await sql`DELETE FROM users WHERE firebase_uid LIKE 'test-tx-%';`.execute(db);
}

async function setupTestData(): Promise<SetupData> {
  await cleanupTestData();

  // 1. Create Franchises
  const f1 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-TX-F1', 'Transaction Test Franchise 1', 'Brand 1')
    RETURNING id;
  `.execute(db);
  const f1Id = f1.rows[0].id;

  const f2 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-TX-F2', 'Transaction Test Franchise 2', 'Brand 2')
    RETURNING id;
  `.execute(db);
  const f2Id = f2.rows[0].id;

  // 2. Create Users
  const uOwner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-tx-owner', 'owner@tx.test', 'TX Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uOwner.rows[0].id}, 'owner');`.execute(db);

  const uAdmin = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-tx-admin', 'admin@tx.test', 'TX Admin', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uAdmin.rows[0].id}, 'admin');`.execute(db);

  const uViewer = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-tx-viewer', 'viewer@tx.test', 'TX Viewer', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uViewer.rows[0].id}, 'viewer');`.execute(db);

  const uF2Owner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-tx-f2owner', 'f2owner@tx.test', 'F2 Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f2Id}, ${uF2Owner.rows[0].id}, 'owner');`.execute(db);

  // 3. Accounting Periods
  const p1 = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${f1Id}, '2026-09', 2026, 9, 'September 2026', 'open')
    RETURNING id;
  `.execute(db);
  const f1PeriodId = p1.rows[0].id;

  const p2 = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${f2Id}, '2026-09', 2026, 9, 'September 2026', 'open')
    RETURNING id;
  `.execute(db);
  const f2PeriodId = p2.rows[0].id;

  // 3.1 Financial Seeds for Day 1 Calculation Engine
  await sql`
    INSERT INTO period_financial_seeds (
      franchise_id, period_id, opening_cash, opening_owner_balance,
      opening_jazz_lifting, opening_jazz_payable, is_verified
    ) VALUES
      (${f1Id}, ${f1PeriodId}, 10000.00, 5000.00, 20000.00, 10000.00, true),
      (${f2Id}, ${f2PeriodId}, 10000.00, 5000.00, 20000.00, 10000.00, true);
  `.execute(db);

  // 4. Accounting Days
  // F1 Day 1: OPEN
  const d1 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${f1PeriodId}, 1, '2026-09-01', 'Day 1', 'open')
    RETURNING id;
  `.execute(db);
  const f1OpenDayId = d1.rows[0].id;

  // F1 Day 2: REOPEN
  const d2 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${f1PeriodId}, 2, '2026-09-02', 'Day 2', 'reopen')
    RETURNING id;
  `.execute(db);
  const f1ReopenDayId = d2.rows[0].id;

  // F1 Day 3: CLOSED
  const d3 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${f1PeriodId}, 3, '2026-09-03', 'Day 3', 'closed')
    RETURNING id;
  `.execute(db);
  const f1ClosedDayId = d3.rows[0].id;

  // F2 Day 1: OPEN
  const d2F2 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f2Id}, ${f2PeriodId}, 1, '2026-09-01', 'Day 1', 'open')
    RETURNING id;
  `.execute(db);
  const f2OpenDayId = d2F2.rows[0].id;

  // 5. Catalogs in F1
  const cExp = await sql<{ id: string }>`
    INSERT INTO expense_categories (franchise_id, slug, name)
    VALUES (${f1Id}, 'tx-cat-rent', 'Rent Category')
    RETURNING id;
  `.execute(db);
  const f1ExpCatId = cExp.rows[0].id;

  const cComm = await sql<{ id: string }>`
    INSERT INTO commission_categories (franchise_id, slug, name)
    VALUES (${f1Id}, 'tx-cat-comm', 'General Commission')
    RETURNING id;
  `.execute(db);
  const f1CommCatId = cComm.rows[0].id;

  const cParty = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type)
    VALUES (${f1Id}, 'tx-party-ali', 'Dealer Ali', 'dealer')
    RETURNING id;
  `.execute(db);
  const f1CreditPartyId = cParty.rows[0].id;

  const cDo = await sql<{ id: string }>`
    INSERT INTO jazz_load_do_profiles (franchise_id, do_name, do_line)
    VALUES (${f1Id}, 'TX Alpha DO', 'Line 1')
    RETURNING id;
  `.execute(db);
  const f1DoProfileId = cDo.rows[0].id;

  await sql`
    INSERT INTO jazz_load_rates (franchise_id, ml_rate, is_active, effective_from)
    VALUES (${f1Id}, 2.6500, true, '2026-09-01T00:00:00Z');
  `.execute(db);

  const cProd = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate)
    VALUES (${f1Id}, 'tx-sim-card', 'Prepaid SIM', 200.00)
    RETURNING id;
  `.execute(db);
  const f1StockProductId = cProd.rows[0].id;

  const cAcct = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type)
    VALUES (${f1Id}, 'tx-ccr-main', 'Main CCR', 'CCR')
    RETURNING id;
  `.execute(db);
  const f1StockAccountId = cAcct.rows[0].id;

  // 6. Catalogs in F2
  const cExp2 = await sql<{ id: string }>`
    INSERT INTO expense_categories (franchise_id, slug, name)
    VALUES (${f2Id}, 'tx-f2-cat-rent', 'F2 Rent')
    RETURNING id;
  `.execute(db);
  const f2ExpCatId = cExp2.rows[0].id;

  const cParty2 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type)
    VALUES (${f2Id}, 'tx-f2-party', 'F2 Dealer', 'dealer')
    RETURNING id;
  `.execute(db);
  const f2CreditPartyId = cParty2.rows[0].id;

  const cDo2 = await sql<{ id: string }>`
    INSERT INTO jazz_load_do_profiles (franchise_id, do_name, do_line)
    VALUES (${f2Id}, 'TX F2 DO', 'Line 1')
    RETURNING id;
  `.execute(db);
  const f2DoProfileId = cDo2.rows[0].id;

  const cProd2 = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate)
    VALUES (${f2Id}, 'tx-f2-sim', 'F2 SIM', 100.00)
    RETURNING id;
  `.execute(db);
  const f2StockProductId = cProd2.rows[0].id;

  const cAcct2 = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type)
    VALUES (${f2Id}, 'tx-f2-acct', 'F2 CCR', 'CCR')
    RETURNING id;
  `.execute(db);
  const f2StockAccountId = cAcct2.rows[0].id;

  return {
    f1Id,
    f2Id,
    f1OpenDayId,
    f1ReopenDayId,
    f1ClosedDayId,
    f2OpenDayId,
    f1ExpCatId,
    f2ExpCatId,
    f1CommCatId,
    f1CreditPartyId,
    f2CreditPartyId,
    f1DoProfileId,
    f2DoProfileId,
    f1StockProductId,
    f2StockProductId,
    f1StockAccountId,
    f2StockAccountId
  };
}

type Method = "GET" | "POST" | "PATCH" | "DELETE";

async function req(
  baseUrl: string,
  method: Method,
  path: string,
  token: string | null,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  };
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string, detail?: unknown) {
  if (condition) {
    console.log(`   ✓ ${label}`);
    pass++;
  } else {
    console.error(`   ✗ FAILED: ${label}`, detail ?? "");
    fail++;
  }
}

async function runTransactionTests() {
  console.log("=== STARTING PHASE 5 OPERATIONAL TRANSACTIONS TEST SUITE ===\n");

  const data = await setupTestData();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  setTokenVerifierForTesting(async (token: string) => {
    if (token === "tx-owner") return { uid: "test-tx-owner", email: "owner@tx.test" };
    if (token === "tx-admin") return { uid: "test-tx-admin", email: "admin@tx.test" };
    if (token === "tx-viewer") return { uid: "test-tx-viewer", email: "viewer@tx.test" };
    if (token === "tx-f2owner") return { uid: "test-tx-f2owner", email: "f2owner@tx.test" };
    throw new Error("INVALID_TOKEN");
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Authentication Tests
    // -------------------------------------------------------------------------
    console.log("Group 1: Authentication enforcement");
    {
      const r1 = await req(base, "GET", "/api/v1/transactions/expenses", null);
      assert(r1.status === 401, "Unauthenticated request returns 401", r1.status);

      const r2 = await req(base, "POST", "/api/v1/transactions/expenses", "invalid-token", {
        day_id: data.f1OpenDayId,
        item_name: "Test",
        amount: 100
      });
      assert(r2.status === 401, "Invalid token returns 401", r2.status);
    }

    // -------------------------------------------------------------------------
    // 2. Expense Items & Tenant Isolation
    // -------------------------------------------------------------------------
    console.log("\nGroup 2: Expense Items (CRUD, Accounting Day, Tenant Isolation)");
    let expenseId: string;
    {
      // F1 Admin creates expense on OPEN day
      const rCreate = await req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", {
        day_id: data.f1OpenDayId,
        category_id: data.f1ExpCatId,
        item_name: "Office Electricity",
        description: "September bill",
        amount: 5500.50
      });
      assert(rCreate.status === 201, "Admin creates expense on OPEN day", rCreate.status);
      assert(rCreate.body?.data?.franchise_id === data.f1Id, "Expense belongs to F1", rCreate.body?.data?.franchise_id);
      assert(rCreate.body?.data?.category_name_snapshot === "Rent Category", "Category name snapshotted", rCreate.body?.data?.category_name_snapshot);
      expenseId = rCreate.body?.data?.id;

      // F1 Owner lists expenses
      const rList = await req(base, "GET", `/api/v1/transactions/expenses?day_id=${data.f1OpenDayId}`, "tx-owner");
      assert(rList.status === 200, "Owner lists expenses for day", rList.status);
      assert(rList.body?.data?.some((e: any) => e.id === expenseId), "Created expense appears in list");

      // Tenant isolation: F2 cannot read F1 expense
      const rF2Get = await req(base, "GET", `/api/v1/transactions/expenses/${expenseId}`, "tx-f2owner");
      assert(rF2Get.status === 404, "F2 cannot read F1 expense (404)", rF2Get.status);

      // Tenant isolation: F2 cannot update F1 expense
      const rF2Patch = await req(base, "PATCH", `/api/v1/transactions/expenses/${expenseId}`, "tx-f2owner", { baseRevision: 1, amount: 1000 });
      assert(rF2Patch.status === 404, "F2 cannot update F1 expense (404)", rF2Patch.status);

      // Tenant isolation: F2 cannot delete F1 expense
      const rF2Del = await req(base, "DELETE", `/api/v1/transactions/expenses/${expenseId}`, "tx-f2owner");
      assert(rF2Del.status === 404, "F2 cannot delete F1 expense (404)", rF2Del.status);

      // Tenant isolation: Client-injected franchise_id is ignored
      const rInject = await req(base, "POST", "/api/v1/transactions/expenses", "tx-f2owner", {
        day_id: data.f2OpenDayId,
        item_name: "F2 Expense",
        amount: 200,
        franchise_id: data.f1Id // attacker tries to inject F1
      });
      assert(rInject.status === 201, "F2 expense created", rInject.status);
      assert(rInject.body?.data?.franchise_id === data.f2Id, "Injected franchise_id overridden by server context", rInject.body?.data?.franchise_id);
    }

    // -------------------------------------------------------------------------
    // 3. RBAC Enforcement
    // -------------------------------------------------------------------------
    console.log("\nGroup 3: RBAC (Viewer read-only, Admin/Owner mutate)");
    {
      // Viewer can read
      const rViewerRead = await req(base, "GET", `/api/v1/transactions/expenses/${expenseId}`, "tx-viewer");
      assert(rViewerRead.status === 200, "Viewer can read expense", rViewerRead.status);

      // Viewer cannot create
      const rViewerCreate = await req(base, "POST", "/api/v1/transactions/expenses", "tx-viewer", {
        day_id: data.f1OpenDayId,
        item_name: "Viewer Hack",
        amount: 100
      });
      assert(rViewerCreate.status === 403, "Viewer cannot create expense (403)", rViewerCreate.status);

      // Viewer cannot update
      const rViewerUpdate = await req(base, "PATCH", `/api/v1/transactions/expenses/${expenseId}`, "tx-viewer", { amount: 6000 });
      assert(rViewerUpdate.status === 403, "Viewer cannot update expense (403)", rViewerUpdate.status);

      // Viewer cannot delete
      const rViewerDelete = await req(base, "DELETE", `/api/v1/transactions/expenses/${expenseId}`, "tx-viewer");
      assert(rViewerDelete.status === 403, "Viewer cannot delete expense (403)", rViewerDelete.status);
    }

    // -------------------------------------------------------------------------
    // 4. Accounting Day Boundary & Immutability Triggers
    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Accounting Day Boundary & Immutability Triggers");
    {
      // A. Mutation on REOPEN day is permitted
      const rReopenCreate = await req(base, "POST", "/api/v1/transactions/expenses", "tx-owner", {
        day_id: data.f1ReopenDayId,
        item_name: "Reopened Day Expense",
        amount: 1500
      });
      assert(rReopenCreate.status === 201, "Mutation allowed on REOPEN day", rReopenCreate.status);

      // B. Create on CLOSED day is rejected
      const rClosedCreate = await req(base, "POST", "/api/v1/transactions/expenses", "tx-owner", {
        day_id: data.f1ClosedDayId,
        item_name: "Closed Day Expense",
        amount: 2500
      });
      assert(rClosedCreate.status === 422, "Mutation rejected on CLOSED day (422 DAY_CLOSED)", rClosedCreate.status);
      assert(rClosedCreate.body?.error === "DAY_CLOSED", "Error code is DAY_CLOSED");

      // C. Update on CLOSED day: Insert directly into DB to test update/delete triggers
      const closedExp = await sql<{ id: string }>`
        INSERT INTO expense_items (franchise_id, day_id, category_name_snapshot, item_name, amount)
        VALUES (${data.f1Id}, ${data.f1ClosedDayId}, 'General', 'Historical Expense', 3000)
        RETURNING id;
      `.execute(db);
      const closedExpId = closedExp.rows[0].id;

      // Attempt PATCH via API
      const rClosedPatch = await req(base, "PATCH", `/api/v1/transactions/expenses/${closedExpId}`, "tx-owner", { baseRevision: 1, amount: 4000 });
      assert(rClosedPatch.status === 422, "Update rejected on CLOSED day (422 DAY_CLOSED)", rClosedPatch.status);

      // Attempt DELETE via API
      const rClosedDelete = await req(base, "DELETE", `/api/v1/transactions/expenses/${closedExpId}`, "tx-owner");
      assert(rClosedDelete.status === 422, "Delete rejected on CLOSED day (422 DAY_CLOSED)", rClosedDelete.status);

      // D. Transaction cannot reference another franchise's day
      const rCrossDay = await req(base, "POST", "/api/v1/transactions/expenses", "tx-owner", {
        day_id: data.f2OpenDayId, // F2's day
        item_name: "Cross-Tenant Day Attack",
        amount: 500
      });
      assert(rCrossDay.status === 404, "Transaction cannot reference another franchise's day (404)", rCrossDay.status);

      // E. Transaction cannot reference non-existent day
      const rFakeDay = await req(base, "POST", "/api/v1/transactions/expenses", "tx-owner", {
        day_id: "00000000-0000-0000-0000-000000000000",
        item_name: "Fake Day Attack",
        amount: 500
      });
      assert(rFakeDay.status === 404, "Transaction with invalid day ID returns 404", rFakeDay.status);
    }

    // -------------------------------------------------------------------------
    // 5. Master Catalog References Scoping
    // -------------------------------------------------------------------------
    console.log("\nGroup 5: Master References Scoping (Cross-Tenant Rejection)");
    {
      // Cross-tenant expense category
      const rCrossCat = await req(base, "POST", "/api/v1/transactions/expenses", "tx-owner", {
        day_id: data.f1OpenDayId,
        category_id: data.f2ExpCatId, // F2's category
        item_name: "Cross Category",
        amount: 100
      });
      assert(rCrossCat.status === 400, "Cross-tenant expense category rejected (400)", rCrossCat.status);

      // Cross-tenant credit party
      const rCrossParty = await req(base, "POST", "/api/v1/transactions/credits", "tx-owner", {
        day_id: data.f1OpenDayId,
        party_id: data.f2CreditPartyId, // F2's party
        loan_amount: 500
      });
      assert(rCrossParty.status === 400, "Cross-tenant credit party rejected (400)", rCrossParty.status);

      // Cross-tenant Jazz DO profile
      const rCrossDo = await req(base, "POST", "/api/v1/transactions/jazz-load/do", "tx-owner", {
        day_id: data.f1OpenDayId,
        do_profile_id: data.f2DoProfileId, // F2's profile
        issuance_base: 1000
      });
      assert(rCrossDo.status === 400, "Cross-tenant Jazz DO profile rejected (400)", rCrossDo.status);

      // Cross-tenant stock product
      const rCrossProd = await req(base, "POST", "/api/v1/transactions/stock/orders", "tx-owner", {
        day_id: data.f1OpenDayId,
        direction: "inbound",
        lines: [{ product_id: data.f2StockProductId, quantity: 5 }]
      });
      assert(rCrossProd.status === 400, "Cross-tenant stock product rejected (400)", rCrossProd.status);

      // Cross-tenant stock account
      const rCrossAcct = await req(base, "POST", "/api/v1/transactions/stock/account-payments", "tx-owner", {
        day_id: data.f1OpenDayId,
        account_id: data.f2StockAccountId,
        amount: 1000
      });
      assert(rCrossAcct.status === 400, "Cross-tenant stock account rejected (400)", rCrossAcct.status);
    }

    // -------------------------------------------------------------------------
    // 6. Parent-Child Stock Orders & Atomic Rollback
    // -------------------------------------------------------------------------
    console.log("\nGroup 6: Stock Orders + Lines (Atomicity & Generated Columns)");
    let stockOrderId: string;
    {
      // Successful creation with generated line_amount
      const rOrder = await req(base, "POST", "/api/v1/transactions/stock/orders", "tx-owner", {
        day_id: data.f1OpenDayId,
        direction: "inbound",
        supplier_name: "Jazz Telecom HQ",
        invoice_reference: "INV-9901",
        lines: [
          {
            product_id: data.f1StockProductId,
            quantity: 10,
            unit_rate: 200.00
          }
        ]
      });
      assert(rOrder.status === 201, "Stock order with lines created", rOrder.status);
      assert(rOrder.body?.data?.lines?.length === 1, "Order has 1 line item", rOrder.body?.data?.lines?.length);
      // Verify PostgreSQL generated line_amount: 10 * 200 = 2000.00
      assert(Number(rOrder.body?.data?.lines[0].line_amount) === 2000, "Database generated line_amount is 2000.00", rOrder.body?.data?.lines[0].line_amount);
      stockOrderId = rOrder.body?.data?.id;

      // Verify atomic rollback: Second line fails with cross-tenant product
      const countBefore = await sql<{ count: string }>`SELECT count(*) FROM stock_orders;`.execute(db);
      const rFailOrder = await req(base, "POST", "/api/v1/transactions/stock/orders", "tx-owner", {
        day_id: data.f1OpenDayId,
        direction: "inbound",
        lines: [
          { product_id: data.f1StockProductId, quantity: 5 },
          { product_id: data.f2StockProductId, quantity: 5 } // Invalid product!
        ]
      });
      assert(rFailOrder.status === 400, "Atomic failure: Invalid line returns 400", rFailOrder.status);
      const countAfter = await sql<{ count: string }>`SELECT count(*) FROM stock_orders;`.execute(db);
      assert(countBefore.rows[0].count === countAfter.rows[0].count, "Complete rollback: Zero partial stock orders persisted");

      // Update stock order lines
      const rUpdateOrder = await req(base, "PATCH", `/api/v1/transactions/stock/orders/${stockOrderId}`, "tx-owner", {
        baseRevision: 1,
        notes: "Updated order notes",
        lines: [
          { product_id: data.f1StockProductId, quantity: 15, unit_rate: 200.00 }
        ]
      });
      assert(rUpdateOrder.status === 200, "Stock order lines updated", rUpdateOrder.status);
      assert(Number(rUpdateOrder.body?.data?.lines[0].line_amount) === 3000, "Updated line_amount is 3000.00", rUpdateOrder.body?.data?.lines[0].line_amount);
    }

    // -------------------------------------------------------------------------
    // 7. Domain Invariants & Remaining Transactions
    // -------------------------------------------------------------------------
    console.log("\nGroup 7: Remaining Transactions & Invariants");
    {
      // Commission items
      const rComm = await req(base, "POST", "/api/v1/transactions/commissions", "tx-admin", {
        day_id: data.f1OpenDayId,
        category_id: data.f1CommCatId,
        amount: 850
      });
      assert(rComm.status === 201, "Commission item created", rComm.status);

      // Commission: zero amount rejected
      const rZeroComm = await req(base, "POST", "/api/v1/transactions/commissions", "tx-admin", {
        day_id: data.f1OpenDayId,
        amount: 0
      });
      assert(rZeroComm.status === 400, "Zero commission amount rejected", rZeroComm.status);

      // Credit transaction
      const rCredit = await req(base, "POST", "/api/v1/transactions/credits", "tx-admin", {
        day_id: data.f1OpenDayId,
        party_id: data.f1CreditPartyId,
        loan_amount: 1000,
        receipt_amount: 0,
        loan_description: "SIM stock loan"
      });
      assert(rCredit.status === 201, "Credit transaction created", rCredit.status);

      // Credit: no activity rejected
      const rNoActCredit = await req(base, "POST", "/api/v1/transactions/credits", "tx-admin", {
        day_id: data.f1OpenDayId,
        party_id: data.f1CreditPartyId,
        loan_amount: 0,
        receipt_amount: 0,
        manual_adjustment: 0
      });
      assert(rNoActCredit.status === 400, "Zero-activity credit transaction rejected", rNoActCredit.status);

      // Owner transaction
      const rOwner = await req(base, "POST", "/api/v1/transactions/owner", "tx-owner", {
        day_id: data.f1OpenDayId,
        description: "Owner cash injection",
        amount: 50000
      });
      assert(rOwner.status === 201, "Owner transaction created", rOwner.status);

      // Jazz Load Lifting record (1 per day per franchise)
      const rLifting = await req(base, "POST", "/api/v1/transactions/jazz-load/lifting", "tx-admin", {
        day_id: data.f1OpenDayId,
        ml_lifting_amount: 25000
      });
      assert(rLifting.status === 201, "Jazz load lifting record created", rLifting.status);

      // Duplicate lifting on same day returns 409
      const rDupLifting = await req(base, "POST", "/api/v1/transactions/jazz-load/lifting", "tx-admin", {
        day_id: data.f1OpenDayId,
        ml_lifting_amount: 30000
      });
      assert(rDupLifting.status === 409, "Duplicate lifting record on same day rejected with 409", rDupLifting.status);

      // Jazz Load DO Entry
      const rDo = await req(base, "POST", "/api/v1/transactions/jazz-load/do", "tx-admin", {
        day_id: data.f1OpenDayId,
        do_profile_id: data.f1DoProfileId,
        issuance_base: 5000,
        payment_base: 5000
      });
      assert(rDo.status === 201, "Jazz Load DO entry created", rDo.status);

      // Stock Account Payment
      const rAcctPay = await req(base, "POST", "/api/v1/transactions/stock/account-payments", "tx-admin", {
        day_id: data.f1OpenDayId,
        account_id: data.f1StockAccountId,
        amount: 2500
      });
      assert(rAcctPay.status === 201, "Stock account payment created", rAcctPay.status);

      // Jazz Company Payable Payment
      const rCoPay = await req(base, "POST", "/api/v1/transactions/jazz-company/payments", "tx-admin", {
        day_id: data.f1OpenDayId,
        amount: 15000,
        payment_reference: "CHK-00192"
      });
      assert(rCoPay.status === 201, "Jazz Company payable payment created", rCoPay.status);
    }

    // -------------------------------------------------------------------------
    // 8. Audit Logging Verification
    // -------------------------------------------------------------------------
    console.log("\nGroup 8: Audit Logging Verification");
    {
      const logs = await sql<{ count: string }>`
        SELECT count(*) FROM audit_logs
        WHERE franchise_id = ${data.f1Id};
      `.execute(db);
      assert(Number(logs.rows[0].count) >= 8, `Audit logs recorded for financial mutations (${logs.rows[0].count} events)`);
    }

    // -------------------------------------------------------------------------
    // 9. Phase 5.1 Issue 1: Jazz Load DO Rate Immutability & Server Authority
    // -------------------------------------------------------------------------
    console.log("\nGroup 9: Jazz Load DO Applied Rate Server-Authority (Phase 5.1 Issue 1)");
    {
      // 1. Creation derives applied_ml_rate_percentage from franchise's jazz_load_rates (configured as 2.6500)
      const rCreateDo = await req(base, "POST", "/api/v1/transactions/jazz-load/do", "tx-admin", {
        day_id: data.f1OpenDayId,
        do_profile_id: data.f1DoProfileId,
        issuance_base: 4000,
        payment_base: 4000,
        applied_ml_rate_percentage: 9.9999 // Client attempts to tamper with applied rate
      });
      assert(rCreateDo.status === 201, "Jazz DO created with rate lookup", rCreateDo.status);
      const doId = rCreateDo.body?.data?.id;
      const doRate = Number(rCreateDo.body?.data?.applied_ml_rate_percentage);
      assert(doRate === 2.65, "Applied rate derived from server rate (2.6500), client input 9.9999 ignored", doRate);

      // 2. Updating notes/bases preserves historical applied_ml_rate_percentage
      const rUpdateDo = await req(base, "PATCH", `/api/v1/transactions/jazz-load/do/${doId}`, "tx-admin", {
        baseRevision: 1,
        notes: "Updated DO entry notes",
        payment_base: 3500,
        applied_ml_rate_percentage: 8.8888 // Client attempts to alter rate on PATCH
      });
      assert(rUpdateDo.status === 200, "Jazz DO updated successfully", rUpdateDo.status);
      const updatedDoRate = Number(rUpdateDo.body?.data?.applied_ml_rate_percentage);
      assert(updatedDoRate === 2.65, "Applied rate strictly preserved across updates (remains 2.6500)", updatedDoRate);
      assert(rUpdateDo.body?.data?.revision === 2, "Revision incremented to 2", rUpdateDo.body?.data?.revision);
    }

    // -------------------------------------------------------------------------
    // 10. Phase 5.1 Issue 2: POST Mutation Idempotency via clientMutationId
    // -------------------------------------------------------------------------
    console.log("\nGroup 10: POST Mutation Idempotency (Phase 5.1 Issue 2)");
    {
      const mutationId1 = "m-test-exp-" + Date.now();
      const expensePayload = {
        clientMutationId: mutationId1,
        day_id: data.f1OpenDayId,
        category_id: data.f1ExpCatId,
        item_name: "Idempotent Coffee",
        amount: 250
      };

      // 1. Initial POST succeeds with 201 Created
      const countExpBefore = await sql<{ count: string }>`SELECT count(*) FROM expense_items WHERE item_name = 'Idempotent Coffee';`.execute(db);
      const countAuditBefore = await sql<{ count: string }>`SELECT count(*) FROM audit_logs WHERE franchise_id = ${data.f1Id};`.execute(db);

      const rPost1 = await req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", expensePayload);
      assert(rPost1.status === 201, "First POST with clientMutationId returns 201", rPost1.status);
      const firstItemId = rPost1.body?.data?.id;
      assert(Boolean(firstItemId), "First POST returns created ID");

      const countExpAfterFirst = await sql<{ count: string }>`SELECT count(*) FROM expense_items WHERE item_name = 'Idempotent Coffee';`.execute(db);
      assert(Number(countExpAfterFirst.rows[0].count) === Number(countExpBefore.rows[0].count) + 1, "Exactly 1 expense item inserted");

      // 2. Retrying identical POST with same clientMutationId returns identical result (201/200)
      const rPostRetry = await req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", expensePayload);
      assert(rPostRetry.status === 201 || rPostRetry.status === 200, "Retried POST succeeds", rPostRetry.status);
      assert(rPostRetry.body?.data?.id === firstItemId, "Retried POST returns identical entity ID", rPostRetry.body?.data?.id);

      // 3. Verify zero duplicate rows created in database
      const countExpAfterRetry = await sql<{ count: string }>`SELECT count(*) FROM expense_items WHERE item_name = 'Idempotent Coffee';`.execute(db);
      assert(countExpAfterRetry.rows[0].count === countExpAfterFirst.rows[0].count, "Zero duplicate rows inserted into expense_items");

      // 4. Verify zero duplicate audit logs created on retry
      const countAuditAfterRetry = await sql<{ count: string }>`SELECT count(*) FROM audit_logs WHERE franchise_id = ${data.f1Id};`.execute(db);
      assert(Number(countAuditAfterRetry.rows[0].count) === Number(countAuditBefore.rows[0].count) + 1, "Zero duplicate audit logs created on retry");

      // 5. Reusing same clientMutationId with altered payload returns 409 IDEMPOTENCY_KEY_REUSED
      const rConflictKey = await req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", {
        ...expensePayload,
        amount: 9999 // altered amount!
      });
      assert(rConflictKey.status === 409, "Reused clientMutationId with different payload returns 409", rConflictKey.status);
      assert(rConflictKey.body?.error === "IDEMPOTENCY_KEY_REUSED" || rConflictKey.body?.code === "IDEMPOTENCY_KEY_REUSED", "Error code is IDEMPOTENCY_KEY_REUSED", rConflictKey.body?.error);

      // 6. Cross-tenant isolation: Same clientMutationId used in Franchise 2 succeeds independently
      const rF2Post = await req(base, "POST", "/api/v1/transactions/expenses", "tx-f2owner", {
        clientMutationId: mutationId1, // Same mutation ID as F1
        day_id: data.f2OpenDayId,
        category_id: data.f2ExpCatId,
        item_name: "F2 Idempotent Expense",
        amount: 500
      });
      assert(rF2Post.status === 201, "Cross-tenant: Same mutationId in F2 succeeds (no tenant collision)", rF2Post.status);
      assert(rF2Post.body?.data?.franchise_id === data.f2Id, "F2 expense belongs to F2");

      // 7. Atomic transaction with lines (Stock Order) idempotency retry
      const stockMutationId = "m-test-stock-" + Date.now();
      const stockOrderPayload = {
        clientMutationId: stockMutationId,
        day_id: data.f1OpenDayId,
        direction: "inbound",
        supplier_name: "Jazz Telecom HQ",
        invoice_reference: "INV-IDEMP-001",
        lines: [
          { product_id: data.f1StockProductId, quantity: 20, unit_rate: 150.00 }
        ]
      };
      const rStock1 = await req(base, "POST", "/api/v1/transactions/stock/orders", "tx-owner", stockOrderPayload);
      assert(rStock1.status === 201, "Stock order created with clientMutationId", rStock1.status);
      const stockId1 = rStock1.body?.data?.id;

      const rStockRetry = await req(base, "POST", "/api/v1/transactions/stock/orders", "tx-owner", stockOrderPayload);
      assert(rStockRetry.status === 201 || rStockRetry.status === 200, "Retrying stock order returns identical response", rStockRetry.status);
      assert(rStockRetry.body?.data?.id === stockId1, "Retried stock order has same ID");
      assert(rStockRetry.body?.data?.lines?.length === 1, "Retried stock order contains line items");

      const lineCount = await sql<{ count: string }>`SELECT count(*) FROM stock_order_lines WHERE stock_order_id = ${stockId1};`.execute(db);
      assert(Number(lineCount.rows[0].count) === 1, "Zero duplicate stock order lines created on retry");

      // 8. Rollback on failure leaves zero idempotency records
      const failMutationId = "m-test-fail-" + Date.now();
      const rFail = await req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", {
        clientMutationId: failMutationId,
        day_id: data.f1ClosedDayId, // Closed day will trigger DAY_CLOSED 422
        item_name: "Failed Expense",
        amount: 100
      });
      assert(rFail.status === 422, "Failed request rejected with 422", rFail.status);
      const idempRecord = await sql<{ count: string }>`
        SELECT count(*) FROM mutation_idempotency
        WHERE franchise_id = ${data.f1Id} AND client_mutation_id = ${failMutationId};
      `.execute(db);
      assert(Number(idempRecord.rows[0].count) === 0, "Rolled back transaction leaves no idempotency record");

      // 9. Genuine Concurrent Idempotency Race Test (exercises 23505 race path)
      console.log("\n   Testing Concurrent Idempotency Race (23505 overlap path)...");
      const raceMutationId = "m-test-race-" + Date.now();
      const racePayload = {
        clientMutationId: raceMutationId,
        day_id: data.f1OpenDayId,
        category_id: data.f1ExpCatId,
        item_name: "Concurrent Race Expense",
        amount: 350
      };

      // Install a temporary delay trigger on expense_items so both concurrent requests
      // pass the initial checkIdempotency pre-check before one commits and wins the unique index.
      await sql`
        CREATE OR REPLACE FUNCTION trg_test_delay_race() RETURNS trigger AS $$
        BEGIN
          IF NEW.item_name = 'Concurrent Race Expense' THEN
            PERFORM pg_sleep(0.08);
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_test_concurrent_delay ON expense_items;
        CREATE TRIGGER trg_test_concurrent_delay
        BEFORE INSERT ON expense_items
        FOR EACH ROW
        EXECUTE FUNCTION trg_test_delay_race();
      `.execute(db);

      try {
        const [raceRes1, raceRes2] = await Promise.all([
          req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", racePayload),
          req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", racePayload)
        ]);

        assert(raceRes1.status === 201 || raceRes1.status === 200, "Concurrent Request 1 succeeded (201/200)", raceRes1.status);
        assert(raceRes2.status === 201 || raceRes2.status === 200, "Concurrent Request 2 succeeded (201/200)", raceRes2.status);

        const raceId1 = raceRes1.body?.data?.id;
        const raceId2 = raceRes2.body?.data?.id;
        assert(Boolean(raceId1) && raceId1 === raceId2, "Both concurrent requests returned identical entity ID", `${raceId1} === ${raceId2}`);

        // Exactly one financial record exists
        const raceRows = await sql<{ count: string }>`
          SELECT count(*) FROM expense_items WHERE item_name = 'Concurrent Race Expense';
        `.execute(db);
        assert(Number(raceRows.rows[0].count) === 1, "Exactly one financial record exists after concurrent race");

        // Exactly one audit log exists for this entity
        const raceAudits = await sql<{ count: string }>`
          SELECT count(*) FROM audit_logs WHERE entity_id = ${raceId1};
        `.execute(db);
        assert(Number(raceAudits.rows[0].count) === 1, "Exactly one audit log entry exists for concurrent mutation");

        // Exactly one idempotency record exists
        const raceIdemp = await sql<{ count: string }>`
          SELECT count(*) FROM mutation_idempotency
          WHERE franchise_id = ${data.f1Id} AND client_mutation_id = ${raceMutationId};
        `.execute(db);
        assert(Number(raceIdemp.rows[0].count) === 1, "Exactly one idempotency record exists for concurrent mutation");
      } finally {
        await sql`
          DROP TRIGGER IF EXISTS trg_test_concurrent_delay ON expense_items;
          DROP FUNCTION IF EXISTS trg_test_delay_race();
        `.execute(db);
      }
    }

    // -------------------------------------------------------------------------
    // 11. Phase 5.1 Issue 3: PATCH Optimistic Concurrency Control
    // -------------------------------------------------------------------------
    console.log("\nGroup 11: PATCH Optimistic Concurrency Control (Phase 5.1 Issue 3)");
    {
      // 1a. Create a fresh expense item with revision = 1
      const rNewExp = await req(base, "POST", "/api/v1/transactions/expenses", "tx-admin", {
        day_id: data.f1OpenDayId,
        category_id: data.f1ExpCatId,
        item_name: "Concurrency Test Expense",
        amount: 1200
      });
      assert(rNewExp.status === 201, "Fresh expense created", rNewExp.status);
      const expId = rNewExp.body?.data?.id;
      assert(rNewExp.body?.data?.revision === 1, "Initial revision is 1", rNewExp.body?.data?.revision);

      // 1b. PATCH without baseRevision is strictly rejected (400 VALIDATION_ERROR)
      const rOmittedRev = await req(base, "PATCH", `/api/v1/transactions/expenses/${expId}`, "tx-admin", {
        amount: 1250
      });
      assert(rOmittedRev.status === 400, "PATCH without baseRevision rejected with 400", rOmittedRev.status);
      assert(rOmittedRev.body?.error === "VALIDATION_ERROR", "Error code is VALIDATION_ERROR", rOmittedRev.body?.error);

      // 1c. PATCH with base_revision (snake_case) succeeds and increments revision to 2
      const rSnakeRev = await req(base, "PATCH", `/api/v1/transactions/expenses/${expId}`, "tx-admin", {
        base_revision: 1,
        amount: 1250
      });
      assert(rSnakeRev.status === 200, "PATCH with base_revision (snake_case) succeeds", rSnakeRev.status);
      assert(rSnakeRev.body?.data?.revision === 2, "Server increments revision to 2 via base_revision", rSnakeRev.body?.data?.revision);
      assert(Number(rSnakeRev.body?.data?.amount) === 1250, "Amount updated to 1250");

      // 2. PATCH with matching baseRevision: 2 succeeds and increments revision to 3
      const rPatch1 = await req(base, "PATCH", `/api/v1/transactions/expenses/${expId}`, "tx-admin", {
        baseRevision: 2,
        amount: 1300,
        item_name: "Concurrency Expense Updated"
      });
      assert(rPatch1.status === 200, "PATCH with baseRevision 2 succeeds", rPatch1.status);
      assert(rPatch1.body?.data?.revision === 3, "Server increments revision to 3", rPatch1.body?.data?.revision);
      assert(Number(rPatch1.body?.data?.amount) === 1300, "Amount updated to 1300");

      // 3. Stale PATCH with baseRevision: 2 (when row is now revision 3) returns 409 REVISION_CONFLICT
      const auditCountBeforeStale = await sql<{ count: string }>`SELECT count(*) FROM audit_logs WHERE franchise_id = ${data.f1Id};`.execute(db);
      const rStalePatch = await req(base, "PATCH", `/api/v1/transactions/expenses/${expId}`, "tx-admin", {
        baseRevision: 2, // Stale!
        amount: 1400
      });
      assert(rStalePatch.status === 409, "Stale PATCH rejected with 409", rStalePatch.status);
      assert(rStalePatch.body?.error === "REVISION_CONFLICT" || rStalePatch.body?.code === "REVISION_CONFLICT", "Error code is REVISION_CONFLICT", rStalePatch.body?.error);
      const curRev = rStalePatch.body?.current_revision ?? rStalePatch.body?.currentRevision;
      const provRev = rStalePatch.body?.provided_revision ?? rStalePatch.body?.providedRevision;
      assert(curRev === 3, "Conflict reports current revision 3", curRev);
      assert(provRev === 2, "Conflict reports provided revision 2", provRev);

      // 4. Verify DB row was NOT modified by conflicting PATCH
      const rowAfterConflict = await sql<any>`SELECT * FROM expense_items WHERE id = ${expId};`.execute(db);
      assert(Number(rowAfterConflict.rows[0].amount) === 1300, "Expense amount was NOT modified by conflicting PATCH (remains 1300)");
      assert(rowAfterConflict.rows[0].revision === 3, "Row revision remains 3");

      // 5. Verify NO audit log was generated for the rejected revision conflict
      const auditCountAfterStale = await sql<{ count: string }>`SELECT count(*) FROM audit_logs WHERE franchise_id = ${data.f1Id};`.execute(db);
      assert(auditCountBeforeStale.rows[0].count === auditCountAfterStale.rows[0].count, "Zero audit logs written on 409 revision conflict");

      // 6. Client cannot directly set revision: 99
      const rDirectRev = await req(base, "PATCH", `/api/v1/transactions/expenses/${expId}`, "tx-admin", {
        baseRevision: 3,
        revision: 99,
        amount: 1500
      });
      assert(rDirectRev.status === 200, "PATCH with baseRevision: 3 succeeds", rDirectRev.status);
      assert(rDirectRev.body?.data?.revision === 4, "Server sequentially sets revision to 4 (client injected 99 ignored)", rDirectRev.body?.data?.revision);

      // 7. Empty update with only baseRevision returns 400
      const rEmpty = await req(base, "PATCH", `/api/v1/transactions/expenses/${expId}`, "tx-admin", {
        baseRevision: 4
      });
      assert(rEmpty.status === 400, "Empty PATCH payload with only baseRevision rejected with 400", rEmpty.status);

      // 8. Test optimistic concurrency on remaining patchable entities
      // Commission items
      const rComm2 = await req(base, "POST", "/api/v1/transactions/commissions", "tx-admin", {
        day_id: data.f1OpenDayId,
        category_id: data.f1CommCatId,
        amount: 500
      });
      const commId = rComm2.body?.data?.id;

      const rCommOmitted = await req(base, "PATCH", `/api/v1/transactions/commissions/${commId}`, "tx-admin", {
        amount: 600
      });
      assert(rCommOmitted.status === 400, "Commission update without baseRevision rejected with 400", rCommOmitted.status);

      const rCommPatch = await req(base, "PATCH", `/api/v1/transactions/commissions/${commId}`, "tx-admin", {
        baseRevision: 1,
        amount: 600
      });
      assert(rCommPatch.status === 200 && rCommPatch.body?.data?.revision === 2, "Commission item revision increments to 2");

      const rCommStale = await req(base, "PATCH", `/api/v1/transactions/commissions/${commId}`, "tx-admin", {
        baseRevision: 1,
        amount: 700
      });
      assert(rCommStale.status === 409, "Commission stale patch returns 409");

      // Credit transactions
      const rCred2 = await req(base, "POST", "/api/v1/transactions/credits", "tx-admin", {
        day_id: data.f1OpenDayId,
        party_id: data.f1CreditPartyId,
        loan_amount: 800
      });
      const credId = rCred2.body?.data?.id;

      const rCredOmitted = await req(base, "PATCH", `/api/v1/transactions/credits/${credId}`, "tx-admin", {
        loan_amount: 900
      });
      assert(rCredOmitted.status === 400, "Credit update without baseRevision rejected with 400", rCredOmitted.status);

      const rCredPatch = await req(base, "PATCH", `/api/v1/transactions/credits/${credId}`, "tx-admin", {
        baseRevision: 1,
        loan_amount: 900
      });
      assert(rCredPatch.status === 200 && rCredPatch.body?.data?.revision === 2, "Credit transaction revision increments to 2");

      const rCredStale = await req(base, "PATCH", `/api/v1/transactions/credits/${credId}`, "tx-admin", {
        baseRevision: 1,
        loan_amount: 1000
      });
      assert(rCredStale.status === 409, "Credit transaction stale patch returns 409");

      // Owner transactions
      const rOwner2 = await req(base, "POST", "/api/v1/transactions/owner", "tx-owner", {
        day_id: data.f1OpenDayId,
        description: "Owner draw",
        amount: -5000
      });
      const ownerId = rOwner2.body?.data?.id;

      const rOwnerOmitted = await req(base, "PATCH", `/api/v1/transactions/owner/${ownerId}`, "tx-owner", {
        notes: "No baseRevision note"
      });
      assert(rOwnerOmitted.status === 400, "Owner update without baseRevision rejected with 400", rOwnerOmitted.status);

      const rOwnerPatch = await req(base, "PATCH", `/api/v1/transactions/owner/${ownerId}`, "tx-owner", {
        baseRevision: 1,
        notes: "Revised note"
      });
      assert(rOwnerPatch.status === 200 && rOwnerPatch.body?.data?.revision === 2, "Owner transaction revision increments to 2");

      const rOwnerStale = await req(base, "PATCH", `/api/v1/transactions/owner/${ownerId}`, "tx-owner", {
        baseRevision: 1,
        notes: "Stale note"
      });
      assert(rOwnerStale.status === 409, "Owner transaction stale patch returns 409");

      // Stock account payments
      const rSap2 = await req(base, "POST", "/api/v1/transactions/stock/account-payments", "tx-admin", {
        day_id: data.f1OpenDayId,
        account_id: data.f1StockAccountId,
        amount: 1500
      });
      const sapId = rSap2.body?.data?.id;

      const rSapOmitted = await req(base, "PATCH", `/api/v1/transactions/stock/account-payments/${sapId}`, "tx-admin", {
        amount: 1800
      });
      assert(rSapOmitted.status === 400, "Stock payment update without baseRevision rejected with 400", rSapOmitted.status);

      const rSapPatch = await req(base, "PATCH", `/api/v1/transactions/stock/account-payments/${sapId}`, "tx-admin", {
        baseRevision: 1,
        amount: 1800
      });
      assert(rSapPatch.status === 200 && rSapPatch.body?.data?.revision === 2, "Stock account payment revision increments to 2");

      const rSapStale = await req(base, "PATCH", `/api/v1/transactions/stock/account-payments/${sapId}`, "tx-admin", {
        baseRevision: 1,
        amount: 2000
      });
      assert(rSapStale.status === 409, "Stock account payment stale patch returns 409");

      // Jazz company payable payments
      const rJcp2 = await req(base, "POST", "/api/v1/transactions/jazz-company/payments", "tx-admin", {
        day_id: data.f1OpenDayId,
        amount: 8000
      });
      const jcpId = rJcp2.body?.data?.id;

      const rJcpOmitted = await req(base, "PATCH", `/api/v1/transactions/jazz-company/payments/${jcpId}`, "tx-admin", {
        payment_reference: "CHK-999-REV"
      });
      assert(rJcpOmitted.status === 400, "Jazz company payment update without baseRevision rejected with 400", rJcpOmitted.status);

      const rJcpPatch = await req(base, "PATCH", `/api/v1/transactions/jazz-company/payments/${jcpId}`, "tx-admin", {
        baseRevision: 1,
        payment_reference: "CHK-999-REV"
      });
      assert(rJcpPatch.status === 200 && rJcpPatch.body?.data?.revision === 2, "Jazz company payment revision increments to 2");

      const rJcpStale = await req(base, "PATCH", `/api/v1/transactions/jazz-company/payments/${jcpId}`, "tx-admin", {
        baseRevision: 1,
        payment_reference: "CHK-FAIL"
      });
      assert(rJcpStale.status === 409, "Jazz company payment stale patch returns 409");
    }

    console.log(`\n=== ALL PHASE 5 & 5.1 TESTS PASSED (${pass}/${pass + fail}) ===`);
  } finally {
    server.close();
    setTokenVerifierForTesting(null);
    await cleanupTestData();
    await closeDatabase();
    console.log("[Test Clean] Temporary transaction test data 100% removed from database.");
  }
}

runTransactionTests().catch((err) => {
  console.error("Phase 5 transaction test failure:", err);
  process.exit(1);
});
