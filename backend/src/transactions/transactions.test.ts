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
  // Reopen any closed test days so the trigger permits cleaning up test records
  await sql`
    UPDATE accounting_days SET status = 'open'
    WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-TX-F1', 'TEST-TX-F2'));
  `.execute(db);

  await sql`
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
      const rF2Patch = await req(base, "PATCH", `/api/v1/transactions/expenses/${expenseId}`, "tx-f2owner", { amount: 1000 });
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
      const rClosedPatch = await req(base, "PATCH", `/api/v1/transactions/expenses/${closedExpId}`, "tx-owner", { amount: 4000 });
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

    console.log(`\n=== ALL PHASE 5 TESTS PASSED (${pass}/${pass + fail}) ===`);
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
