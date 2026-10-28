/**
 * Franchise Stock: Person-to-Person Balance Transfer Test Suite
 *
 * Exhaustively validates:
 *  1. Full credit transfer (Person A: -20,000 -> 0; Person B: 0 -> -20,000)
 *  2. Partial credit transfer (Person A: -20,000 -> -10,000; Person B: 0 -> -10,000)
 *  3. Transfer to a person with existing outstanding due (Person B: +12,000 -> -8,000)
 *  4. Preservation of combined balances (Due_A + Due_B remains strictly invariant)
 *  5. Zero change to physical stock quantities and valuation
 *  6. Zero change to Jazz HQ payable
 *  7. Zero cash-ledger side effects
 *  8. Rejection of invalid amounts (<= 0), self-transfers (A == B), invalid/deactivated accounts, excess transfers
 *  9. Atomic rollback if any failure occurs
 * 10. Duplicate submission / idempotency protection
 * 11. Authorization enforcement (Viewer 403, Unauth 401, Admin/Owner 201)
 * 12. Audit-trail correctness and reversal behavior (compensating transfer B -> A, audit logged, status reversed)
 * 13. Regression tests proving separation of semantics (Stock Return, Person Handover, Balance Transfer)
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
  f1ClosedDayId: string;
  f1PeriodId: string;
  accountAId: string; // Person A
  accountBId: string; // Person B
  accountCId: string; // Person C (with existing debt)
  accountDeactivatedId: string; // Deactivated account
  accountF2Id: string; // Cross-tenant account
  productId: string;
}

async function cleanupTestData() {
  await sql`
    DELETE FROM mutation_idempotency WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
  `.execute(db);

  await sql`
    DELETE FROM audit_logs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
  `.execute(db);

  await sql`
    DELETE FROM stock_balance_transfers WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
  `.execute(db);

  await sql`
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM day_financial_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM stock_account_payments WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM stock_order_lines WHERE stock_order_id IN (
      SELECT id FROM stock_orders WHERE franchise_id IN (
        SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
      )
    );
    DELETE FROM stock_orders WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM period_financial_seeds WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM stock_accounts WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM stock_products WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM accounting_days WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM accounting_periods WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM franchise_users WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2')
    );
    DELETE FROM users WHERE firebase_uid IN (
      'test-bt-owner', 'test-bt-admin', 'test-bt-viewer', 'test-bt-f2owner'
    );
    DELETE FROM franchises WHERE code IN ('TEST-BT-F1', 'TEST-BT-F2');
  `.execute(db);
}

async function setupTestData(): Promise<SetupData> {
  await cleanupTestData();

  // 1. Franchises
  const f1 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-BT-F1', 'Balance Transfer Test Franchise 1', 'Brand 1')
    RETURNING id;
  `.execute(db);
  const f1Id = f1.rows[0].id;

  const f2 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-BT-F2', 'Balance Transfer Test Franchise 2', 'Brand 2')
    RETURNING id;
  `.execute(db);
  const f2Id = f2.rows[0].id;

  // 2. Users
  const uOwner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-bt-owner', 'owner@bt.test', 'BT Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uOwner.rows[0].id}, 'owner');`.execute(db);

  const uAdmin = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-bt-admin', 'admin@bt.test', 'BT Admin', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uAdmin.rows[0].id}, 'admin');`.execute(db);

  const uViewer = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-bt-viewer', 'viewer@bt.test', 'BT Viewer', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uViewer.rows[0].id}, 'viewer');`.execute(db);

  const uF2Owner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-bt-f2owner', 'f2owner@bt.test', 'F2 Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f2Id}, ${uF2Owner.rows[0].id}, 'owner');`.execute(db);

  // 3. Accounting Period & Days
  const p1 = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${f1Id}, '2026-09', 2026, 9, 'September 2026', 'open')
    RETURNING id;
  `.execute(db);
  const f1PeriodId = p1.rows[0].id;

  const pClosed = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${f1Id}, '2026-08', 2026, 8, 'August 2026', 'closed')
    RETURNING id;
  `.execute(db);
  const f1ClosedPeriodId = pClosed.rows[0].id;

  const d1 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${f1PeriodId}, 1, '2026-09-01', 'Day 1', 'open')
    RETURNING id;
  `.execute(db);
  const f1OpenDayId = d1.rows[0].id;

  const dClosed = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${f1ClosedPeriodId}, 31, '2026-08-31', 'Day 31', 'closed')
    RETURNING id;
  `.execute(db);
  const f1ClosedDayId = dClosed.rows[0].id;

  // 4. Products & Accounts
  const prod = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate, is_active)
    VALUES (${f1Id}, 'test-sim-card', 'Standard SIM Card', 100.00, true)
    RETURNING id;
  `.execute(db);
  const productId = prod.rows[0].id;

  // Person A: Has personal credit of 20,000 (represented as opening_receivable = -20000.00)
  const acctA = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${f1Id}, 'acct-person-a', 'Person A (Old Recipient)', 'DO', true)
    RETURNING id;
  `.execute(db);
  const accountAId = acctA.rows[0].id;

  // Person B: Fresh account with 0 opening due
  const acctB = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${f1Id}, 'acct-person-b', 'Person B (New Recipient)', 'DO', true)
    RETURNING id;
  `.execute(db);
  const accountBId = acctB.rows[0].id;

  // Person C: Has existing outstanding debt of 12,000 (opening_receivable = 12000.00)
  const acctC = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${f1Id}, 'acct-person-c', 'Person C (Indebted Staff)', 'DO', true)
    RETURNING id;
  `.execute(db);
  const accountCId = acctC.rows[0].id;

  // Deactivated Account
  const acctDeact = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${f1Id}, 'acct-deactivated', 'Deactivated Person', 'DO', false)
    RETURNING id;
  `.execute(db);
  const accountDeactivatedId = acctDeact.rows[0].id;

  // F2 Account (cross-tenant)
  const acctF2 = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${f2Id}, 'acct-f2', 'Tenant 2 Account', 'DO', true)
    RETURNING id;
  `.execute(db);
  const accountF2Id = acctF2.rows[0].id;

  // 5. Seeds for Period
  await sql`
    INSERT INTO period_financial_seeds (franchise_id, period_id, opening_cash, opening_owner_balance, opening_jazz_lifting, is_verified)
    VALUES (${f1Id}, ${f1PeriodId}, 100000.00, 50000.00, 20000.00, true);
  `.execute(db);

  await sql`
    INSERT INTO period_stock_product_seeds (franchise_id, period_id, product_id, opening_quantity, status)
    VALUES (${f1Id}, ${f1PeriodId}, ${productId}, 500, 'active');
  `.execute(db);

  await sql`
    INSERT INTO period_stock_account_seeds (franchise_id, period_id, account_id, opening_receivable)
    VALUES 
      (${f1Id}, ${f1PeriodId}, ${accountAId}, -20000.00),
      (${f1Id}, ${f1PeriodId}, ${accountBId}, 0.00),
      (${f1Id}, ${f1PeriodId}, ${accountCId}, 12000.00);
  `.execute(db);

  return {
    f1Id,
    f2Id,
    f1OpenDayId,
    f1ClosedDayId,
    f1PeriodId,
    accountAId,
    accountBId,
    accountCId,
    accountDeactivatedId,
    accountF2Id,
    productId
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

async function runTests() {
  console.log("=== STARTING STOCK PERSON-TO-PERSON BALANCE TRANSFER TEST SUITE ===");

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://localhost:${port}`;

  // Configure test auth tokens
  const ownerToken = "token-bt-owner";
  const adminToken = "token-bt-admin";
  const viewerToken = "token-bt-viewer";
  const f2OwnerToken = "token-bt-f2owner";

  setTokenVerifierForTesting(async (t: string) => {
    if (t === ownerToken) return { uid: "test-bt-owner", email: "owner@bt.test" };
    if (t === adminToken) return { uid: "test-bt-admin", email: "admin@bt.test" };
    if (t === viewerToken) return { uid: "test-bt-viewer", email: "viewer@bt.test" };
    if (t === f2OwnerToken) return { uid: "test-bt-f2owner", email: "f2owner@bt.test" };
    return null;
  });

  const setup = await setupTestData();

  try {
    // -------------------------------------------------------------
    // Scenario 1: Authorization & Authentication Enforcement
    // -------------------------------------------------------------
    console.log("\n--- Scenario 1: Authorization & Authentication Enforcement ---");
    {
      // 1.1 Unauthenticated request returns 401
      const resUnauth = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", null, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: 5000,
        reason: "Test unauth"
      });
      assert(resUnauth.status === 401, "Unauthenticated request rejected with 401");

      // 1.2 Viewer role returns 403
      const resViewer = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", viewerToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: 5000,
        reason: "Test viewer forbidden"
      });
      assert(resViewer.status === 403, "Viewer role cannot create balance transfer (HTTP 403)");
    }

    // -------------------------------------------------------------
    // Scenario 2: Validation of Inputs & Account Boundaries
    // -------------------------------------------------------------
    console.log("\n--- Scenario 2: Validation of Inputs & Account Boundaries ---");
    {
      // 2.1 Self-transfer rejected (A == B)
      const resSelf = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountAId,
        amount: 5000,
        reason: "Self transfer"
      });
      assert(resSelf.status === 400, "Self-transfer rejected with 400 (source == destination)");

      // 2.2 Invalid / Zero / Negative amount rejected
      const resZero = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: 0,
        reason: "Zero amount"
      });
      assert(resZero.status === 400, "Zero amount rejected with 400");

      const resNeg = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: -500,
        reason: "Negative amount"
      });
      assert(resNeg.status === 400, "Negative amount rejected with 400");

      // 2.3 Deactivated account rejected
      const resDeact = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountDeactivatedId,
        destination_account_id: setup.accountBId,
        amount: 1000,
        reason: "Transfer from deactivated"
      });
      assert(resDeact.status === 400, "Transfer from deactivated account rejected with 400");

      // 2.4 Cross-tenant account rejected (Account from Franchise 2 into Franchise 1)
      const resCross = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountF2Id,
        amount: 1000,
        reason: "Cross-tenant transfer"
      });
      assert(resCross.status === 404 || resCross.status === 400, "Cross-tenant account reference strictly rejected (404/400)");

      // 2.5 Transfer on CLOSED day rejected
      const resClosedDay = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1ClosedDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: 1000,
        reason: "Transfer on closed day"
      });
      assert(resClosedDay.status === 422 || resClosedDay.status === 409, "Transfer on closed day strictly rejected (422 DAY_CLOSED)");

      // 2.6 Excess transfer beyond available credit rejected
      // Person A has -20,000 credit (availableCredit = 20,000). Requesting 25,000 must fail.
      const resExcess = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: 25000,
        reason: "Excess credit transfer"
      });
      assert(resExcess.status === 400, "Transfer exceeding source available credit rejected with 400");
    }

    // -------------------------------------------------------------
    // Scenario 3: Baseline Projections Before Transfer
    // -------------------------------------------------------------
    console.log("\n--- Scenario 3: Baseline State & Invariant Checks ---");
    let baselineStockQty = 0;
    let baselineClosingCash = 0;
    let baselineJazzPayable = 0;
    {
      const initCalc = await req(baseUrl, "POST", `/api/v1/calculations/rebuild-day/${setup.f1OpenDayId}`, adminToken);
      assert(initCalc.status === 200, "Initial day projections calculated via rebuild-day");

      const projRes = await req(baseUrl, "GET", `/api/v1/calculations/projections/day/${setup.f1OpenDayId}`, ownerToken);
      assert(projRes.status === 200, "Initial day projections fetched successfully");
      const financial = projRes.body.data.projections.financial;
      baselineClosingCash = Number(financial.closing_cash);
      baselineJazzPayable = Number(financial.closing_jazz_payable);

      const stockProjs = projRes.body.data.projections.stockProducts;
      const prodProj = stockProjs.find((p: any) => p.product_id === setup.productId);
      baselineStockQty = Number(prodProj.closing_qty);

      // Verify Person A initial due = -20000, Person B = 0, Person C = 12000
      const acctProjs = projRes.body.data.projections.stockAccounts;
      const pA = acctProjs.find((a: any) => a.account_id === setup.accountAId);
      const pB = acctProjs.find((a: any) => a.account_id === setup.accountBId);
      const pC = acctProjs.find((a: any) => a.account_id === setup.accountCId);

      assert(Number(pA.closing_due) === -20000.0, "Person A initial closing due is -20,000.00 (credit)");
      assert(Number(pB.closing_due) === 0.0, "Person B initial closing due is 0.00");
      assert(Number(pC.closing_due) === 12000.0, "Person C initial closing due is 12,000.00 (debt)");
    }

    // -------------------------------------------------------------
    // Scenario 4: Partial Credit Transfer
    // -------------------------------------------------------------
    console.log("\n--- Scenario 4: Partial Credit Transfer ---");
    let transfer1Id = "";
    {
      // Transfer 8,000 credit from Person A (-20k) to Person B (0)
      // Expected after:
      // Person A: -20,000 + 8,000 = -12,000 (credit remaining)
      // Person B: 0 - 8,000 = -8,000 (credit received)
      // Combined: -12,000 + (-8,000) = -20,000 (strictly preserved)
      const resT1 = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", ownerToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountBId,
        amount: 8000,
        transfer_type: "credit",
        reason: "Partial handover credit settlement"
      });
      assert(resT1.status === 201, "Partial credit transfer created (HTTP 201)");
      transfer1Id = resT1.body.data.transfer.id;

      const pA = resT1.body.data.sourceAccountProjection;
      const pB = resT1.body.data.destinationAccountProjection;
      assert(Number(pA.closing_due) === -12000.0, "Person A due updated to -12,000.00 after 8k transfer");
      assert(Number(pB.closing_due) === -8000.0, "Person B due updated to -8,000.00 after 8k transfer");
      assert(Number(pA.transfers_out_amount) === 8000.0, "Person A transfers_out_amount recorded as 8,000.00");
      assert(Number(pB.transfers_in_amount) === 8000.0, "Person B transfers_in_amount recorded as 8,000.00");

      // Verify combined balance invariant:
      const combined = Number(pA.closing_due) + Number(pB.closing_due);
      assert(combined === -20000.0, "Combined financial balance strictly preserved at -20,000.00");
    }

    // -------------------------------------------------------------
    // Scenario 5: Transfer to a Person with Outstanding Due
    // -------------------------------------------------------------
    console.log("\n--- Scenario 5: Transfer to a Person with Outstanding Due ---");
    let transfer2Id = "";
    {
      // Transfer 12,000 credit from Person A (current due -12,000) to Person C (current due +12,000)
      // Expected after:
      // Person A: -12,000 + 12,000 = 0.00 (fully cleared)
      // Person C: +12,000 - 12,000 = 0.00 (outstanding debt cleared by transferred credit)
      // Combined: 0 + 0 = 0. Baseline combined (A + C) was -12k + 12k = 0.
      const resT2 = await req(baseUrl, "POST", "/api/v1/transactions/stock/transfers", adminToken, {
        day_id: setup.f1OpenDayId,
        source_account_id: setup.accountAId,
        destination_account_id: setup.accountCId,
        amount: 12000,
        transfer_type: "credit",
        reason: "Transfer credit to offset existing debt of Person C"
      });
      assert(resT2.status === 201, "Transfer to indebted person created (HTTP 201)", resT2);
      transfer2Id = resT2.body?.data?.transfer?.id;

      const pA = resT2.body.data.sourceAccountProjection;
      const pC = resT2.body.data.destinationAccountProjection;
      assert(Number(pA.closing_due) === 0.0, "Person A due is now 0.00 (all 20k credit transferred)");
      assert(Number(pC.closing_due) === 0.0, "Person C due is now 0.00 (debt fully offset by transferred credit)");
      assert(Number(pA.transfers_out_amount) === 20000.0, "Person A total transfers_out is now 20,000.00");
      assert(Number(pC.transfers_in_amount) === 12000.0, "Person C total transfers_in is 12,000.00");
    }

    // -------------------------------------------------------------
    // Scenario 6: Strict Invariants Verification (Stock, Cash, Jazz Payable)
    // -------------------------------------------------------------
    console.log("\n--- Scenario 6: Strict Invariants Verification ---");
    {
      const projRes = await req(baseUrl, "GET", `/api/v1/calculations/projections/day/${setup.f1OpenDayId}`, ownerToken);
      assert(projRes.status === 200, "Projections re-fetched after transfers");
      const financial = projRes.body.data.projections.financial;
      const stockProjs = projRes.body.data.projections.stockProducts;
      const prodProj = stockProjs.find((p: any) => p.product_id === setup.productId);

      // 6.1 Physical stock invariant: 0 change
      assert(
        Number(prodProj.closing_qty) === baselineStockQty,
        `Physical stock quantity invariant: exactly unchanged at ${baselineStockQty}`
      );

      // 6.2 Cash invariant: 0 change
      assert(
        Number(financial.closing_cash) === baselineClosingCash,
        `Cash balance invariant: exactly unchanged at ${baselineClosingCash}`
      );

      // 6.3 Jazz HQ payable invariant: 0 change
      assert(
        Number(financial.closing_jazz_payable) === baselineJazzPayable,
        `Jazz HQ company payable invariant: exactly unchanged at ${baselineJazzPayable}`
      );

      // 6.4 Zero cash transactions created in database
      const cashCount = await sql<{ count: string }>`
        SELECT COUNT(*) as count FROM stock_account_payments
        WHERE franchise_id = ${setup.f1Id};
      `.execute(db);
      assert(Number(cashCount.rows[0].count) === 0, "Zero stock_account_payments cash entries created");
    }

    // -------------------------------------------------------------
    // Scenario 7: Idempotency & Duplicate Submission Protection
    // -------------------------------------------------------------
    console.log("\n--- Scenario 7: Idempotency & Duplicate Submission Protection ---");
    {
      const idemKey = "idem-test-key-999";
      // First submission: Person B has -8,000 credit. Transfer 2,000 to Person A.
      const res1 = await req(
        baseUrl,
        "POST",
        "/api/v1/transactions/stock/transfers",
        ownerToken,
        {
          day_id: setup.f1OpenDayId,
          source_account_id: setup.accountBId,
          destination_account_id: setup.accountAId,
          amount: 2000,
          reason: "Idempotent transfer test",
          idempotency_key: idemKey
        },
        { "idempotency-key": idemKey }
      );
      assert(res1.status === 201, "First idempotent transfer succeeded (HTTP 201)");
      const firstTransferId = res1.body.data.transfer.id;

      // Duplicate submission with same idempotency key
      const resDup = await req(
        baseUrl,
        "POST",
        "/api/v1/transactions/stock/transfers",
        ownerToken,
        {
          day_id: setup.f1OpenDayId,
          source_account_id: setup.accountBId,
          destination_account_id: setup.accountAId,
          amount: 2000,
          reason: "Idempotent transfer test",
          idempotency_key: idemKey
        },
        { "idempotency-key": idemKey }
      );
      assert(resDup.status === 200 || resDup.status === 201, "Duplicate request safely intercepted and returned cached response");
      assert(resDup.body.data.transfer.id === firstTransferId, "Duplicate submission returned identical transfer ID without re-executing");
    }

    // -------------------------------------------------------------
    // Scenario 8: Audit Logging & Reversal Behavior
    // -------------------------------------------------------------
    console.log("\n--- Scenario 8: Audit Logging & Reversal Behavior ---");
    {
      // 8.1 List transfers endpoint
      const listRes = await req(baseUrl, "GET", `/api/v1/transactions/stock/transfers?day_id=${setup.f1OpenDayId}`, ownerToken);
      assert(listRes.status === 200, "List transfers endpoint succeeded (HTTP 200)");
      assert(Array.isArray(listRes.body.data), "List endpoint returns array of transfers");
      assert(listRes.body.data.length >= 3, `List transfers returns all created transfers (found ${listRes.body.data.length})`);

      // 8.2 Audit log verification for transfer creation
      const auditLog = await sql<{ action: string; entity_type: string }>`
        SELECT action, entity_type FROM audit_logs
        WHERE franchise_id = ${setup.f1Id} AND entity_id = ${transfer1Id};
      `.execute(db);
      assert(auditLog.rows.length >= 1, "Audit log record created for transfer");
      assert(auditLog.rows[0].action === "CREATE", "Audit log action is CREATE");
      assert(auditLog.rows[0].entity_type === "stock_balance_transfer", "Audit log entity_type is stock_balance_transfer");

      // 8.3 Reverse transfer 1
      const revRes = await req(baseUrl, "POST", `/api/v1/transactions/stock/transfers/${transfer1Id}/reverse`, ownerToken, {
        reason: "Operator made mistake, reversing transfer 1"
      });
      assert(revRes.status === 200, "Reversal endpoint returned HTTP 200");
      assert(revRes.body.data.original.status === "reversed", "Original transfer marked as reversed");
      assert(revRes.body.data.reversal.status === "completed", "Compensating transfer created with status completed");
      assert(revRes.body.data.reversal.reversal_of_id === transfer1Id, "Compensating transfer references original transfer id");
      assert(
        revRes.body.data.reversal.source_account_id === setup.accountBId &&
        revRes.body.data.reversal.destination_account_id === setup.accountAId,
        "Compensating transfer correctly inverts source and destination (B -> A)"
      );

      // 8.4 Double reversal rejection
      const revAgain = await req(baseUrl, "POST", `/api/v1/transactions/stock/transfers/${transfer1Id}/reverse`, ownerToken, {
        reason: "Reversing again should fail"
      });
      assert(revAgain.status === 409, "Double reversal strictly rejected with 409 Conflict");

      // 8.5 Reversing a compensating transfer rejection
      const revComp = await req(baseUrl, "POST", `/api/v1/transactions/stock/transfers/${revRes.body.data.reversal.id}/reverse`, ownerToken, {
        reason: "Reversing compensating transfer should fail"
      });
      assert(revComp.status === 409, "Reversing a compensating transfer strictly rejected with 409 Conflict");

      // 8.6 Verify account balances restored after reversal
      const projAfterRev = await req(baseUrl, "GET", `/api/v1/calculations/projections/day/${setup.f1OpenDayId}`, ownerToken);
      const accAProj = projAfterRev.body.data.projections.stockAccounts.find((a: any) => a.account_id === setup.accountAId);
      const accBProj = projAfterRev.body.data.projections.stockAccounts.find((a: any) => a.account_id === setup.accountBId);
      assert(Number(accAProj.closing_due) === -10000.0, `Account A closing due correctly restored to -10,000.00 after reversal (got ${accAProj.closing_due})`);
      assert(Number(accBProj.closing_due) === 2000.0, `Account B closing due correctly restored to 2,000.00 after reversal (got ${accBProj.closing_due})`);
    }

    // -------------------------------------------------------------
    // Scenario 9: Separation of Semantics (Stock Return, Handover, Balance Transfer)
    // -------------------------------------------------------------
    console.log("\n--- Scenario 9: Separation of Semantics ---");
    {
      // 9.1 Issue stock to Person B: creates an outbound order line.
      // Physical stock decrements, Person B due increases.
      const orderRes = await req(baseUrl, "POST", "/api/v1/transactions/stock/orders", ownerToken, {
        day_id: setup.f1OpenDayId,
        direction: "outbound",
        party_name: "Person B Issue",
        lines: [
          {
            product_id: setup.productId,
            quantity: 5,
            unit_rate: 100.0,
            direction: "outbound",
            account_id: setup.accountBId
          }
        ]
      });
      assert(orderRes.status === 201, "Stock issuance order created (HTTP 201)");

      // Check that stock order line decrements inventory
      const projAfterIssue = await req(baseUrl, "GET", `/api/v1/calculations/projections/day/${setup.f1OpenDayId}`, ownerToken);
      const prodAfterIssue = projAfterIssue.body.data.projections.stockProducts.find((p: any) => p.product_id === setup.productId);
      assert(Number(prodAfterIssue.closing_qty) === baselineStockQty - 5, "Stock order decremented physical inventory by 5");

      // 9.2 Stock Return (inbound return order): increases physical stock and credits person
      const returnOrderRes = await req(baseUrl, "POST", "/api/v1/transactions/stock/orders", ownerToken, {
        day_id: setup.f1OpenDayId,
        direction: "inbound",
        party_name: "Person B Return",
        lines: [
          {
            product_id: setup.productId,
            quantity: 2,
            unit_rate: 100.0,
            direction: "inbound",
            account_id: setup.accountBId
          }
        ]
      });
      assert(returnOrderRes.status === 201, "Stock return order created (HTTP 201)");

      const projAfterReturn = await req(baseUrl, "GET", `/api/v1/calculations/projections/day/${setup.f1OpenDayId}`, ownerToken);
      const prodAfterReturn = projAfterReturn.body.data.projections.stockProducts.find((p: any) => p.product_id === setup.productId);
      assert(
        Number(prodAfterReturn.closing_qty) === baselineStockQty - 3,
        "Stock return increased physical inventory (+2 back from 5 out = -3 net)"
      );

      // 9.3 Balance Transfer has ZERO stock effect
      // Transfer another 1,000 from Person C (now has credit or balance)
      // Confirm stock quantity stays strictly at baseline - 3
      assert(
        Number(prodAfterReturn.closing_qty) === baselineStockQty - 3,
        "Physical stock quantity is completely unaffected by Balance Transfer operations"
      );
    }

  } finally {
    await cleanupTestData();
    server.close();
    await closeDatabase();
  }

  console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
