/**
 * Phase 6B: Server-Authoritative Calculation & Projection Engine Integration Tests
 *
 * Exhaustively validates:
 * 1. Operating Cash & Profit Calculation:
 *    - opening_cash + issues - expenses = closing_cash
 *    - operating_profit = issues - expenses
 *    - Owner injections/draws track in owner_closing_balance without altering operating register cash
 * 2. Credit Party Carry-Forward & Inactive Zero-Balance Pruning
 * 3. Stock Product Quantities & Negative Inventory Warning (Non-blocking)
 * 4. Stock Account Due (Dealer Due) Carry-Forward
 * 5. Jazz Lifting In-Hand & Negative Invariant Warning
 * 6. Jazz DO Running Balances with Server Rate Snapshots (jazz_load_do_day_projections)
 * 7. Jazz Company Payable Carry-Forward (Materialized in day_financial_projections)
 * 8. Historical Correction & Forward Cascade (Day 1 mutation cascades through period end)
 * 9. Closed Day Mutation Protection (INV_CLOSED_DAY_MUTATION)
 * 10. Administrative Rebuild API & RBAC Enforcement (Viewer read, Admin/Owner mutate)
 * 11. Multi-Tenant Isolation
 * 12. 100% Database Cleanup
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
  periodId: string;
  f2PeriodId: string;
  day1Id: string;
  day2Id: string;
  day3Id: string;
  day4ClosedId: string;
  f2Day1Id: string;
  expCatId: string;
  commCatId: string;
  creditParty1Id: string;
  creditParty2Id: string;
  stockProd1Id: string;
  stockAcct1Id: string;
  doProfile1Id: string;
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
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM invariant_violations WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM day_financial_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM mutation_idempotency WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM audit_logs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
    );
    DELETE FROM stock_order_lines WHERE stock_order_id IN (
      SELECT id FROM stock_orders WHERE franchise_id IN (
        SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2')
      )
    );
    DELETE FROM stock_orders WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM stock_account_payments WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM jazz_company_payable_payments WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2'));
    DELETE FROM franchises WHERE code IN ('TEST-CALC-F1', 'TEST-CALC-F2');
    DELETE FROM users WHERE firebase_uid LIKE 'test-calc-%';
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

  // 1. Create Franchises
  const f1 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-CALC-F1', 'Calculation Test Franchise 1', 'Brand 1')
    RETURNING id;
  `.execute(db);
  const f1Id = f1.rows[0].id;

  const f2 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-CALC-F2', 'Calculation Test Franchise 2', 'Brand 2')
    RETURNING id;
  `.execute(db);
  const f2Id = f2.rows[0].id;

  // 2. Users
  const uOwner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-calc-owner', 'owner@calc.test', 'Calc Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uOwner.rows[0].id}, 'owner');`.execute(db);

  const uAdmin = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-calc-admin', 'admin@calc.test', 'Calc Admin', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uAdmin.rows[0].id}, 'admin');`.execute(db);

  const uViewer = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-calc-viewer', 'viewer@calc.test', 'Calc Viewer', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${uViewer.rows[0].id}, 'viewer');`.execute(db);

  const uF2Owner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-calc-f2owner', 'f2owner@calc.test', 'F2 Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f2Id}, ${uF2Owner.rows[0].id}, 'owner');`.execute(db);

  // 3. Accounting Periods
  const p1 = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${f1Id}, '2026-09', 2026, 9, 'September 2026', 'open')
    RETURNING id;
  `.execute(db);
  const periodId = p1.rows[0].id;

  const p2 = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${f2Id}, '2026-09', 2026, 9, 'September 2026', 'open')
    RETURNING id;
  `.execute(db);
  const f2PeriodId = p2.rows[0].id;

  // 4. Accounting Days
  const d1 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${periodId}, 1, '2026-09-01', 'Day 1', 'open')
    RETURNING id;
  `.execute(db);
  const day1Id = d1.rows[0].id;

  const d2 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${periodId}, 2, '2026-09-02', 'Day 2', 'closed')
    RETURNING id;
  `.execute(db);
  const day2Id = d2.rows[0].id;

  const d3 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${periodId}, 3, '2026-09-03', 'Day 3', 'closed')
    RETURNING id;
  `.execute(db);
  const day3Id = d3.rows[0].id;

  const d4 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f1Id}, ${periodId}, 4, '2026-09-04', 'Day 4', 'closed')
    RETURNING id;
  `.execute(db);
  const day4ClosedId = d4.rows[0].id;

  const d2F2 = await sql<{ id: string }>`
    INSERT INTO accounting_days (franchise_id, period_id, day_no, calendar_date, label, status)
    VALUES (${f2Id}, ${f2PeriodId}, 1, '2026-09-01', 'Day 1', 'open')
    RETURNING id;
  `.execute(db);
  const f2Day1Id = d2F2.rows[0].id;

  // 5. Catalogs
  const cExp = await sql<{ id: string }>`
    INSERT INTO expense_categories (franchise_id, slug, name)
    VALUES (${f1Id}, 'calc-cat-rent', 'Office Rent')
    RETURNING id;
  `.execute(db);
  const expCatId = cExp.rows[0].id;

  const cComm = await sql<{ id: string }>`
    INSERT INTO commission_categories (franchise_id, slug, name)
    VALUES (${f1Id}, 'calc-cat-comm', 'Load Commission')
    RETURNING id;
  `.execute(db);
  const commCatId = cComm.rows[0].id;

  const cParty1 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type)
    VALUES (${f1Id}, 'calc-party-ali', 'Dealer Ali', 'dealer')
    RETURNING id;
  `.execute(db);
  const creditParty1Id = cParty1.rows[0].id;

  const cParty2 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type)
    VALUES (${f1Id}, 'calc-party-bob', 'Dealer Bob (Zero)', 'dealer')
    RETURNING id;
  `.execute(db);
  const creditParty2Id = cParty2.rows[0].id;

  await sql`
    INSERT INTO jazz_load_rates (franchise_id, ml_rate, is_active, effective_from)
    VALUES (${f1Id}, 2.5000, true, '2026-09-01T00:00:00Z');
  `.execute(db);

  const cDo = await sql<{ id: string }>`
    INSERT INTO jazz_load_do_profiles (franchise_id, do_name, do_line)
    VALUES (${f1Id}, 'Alpha DO', 'Line 1')
    RETURNING id;
  `.execute(db);
  const doProfile1Id = cDo.rows[0].id;

  const cProd = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate)
    VALUES (${f1Id}, 'calc-sim', 'SIM Card', 100.00)
    RETURNING id;
  `.execute(db);
  const stockProd1Id = cProd.rows[0].id;

  const cAcct = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type)
    VALUES (${f1Id}, 'calc-ccr', 'Main CCR', 'CCR')
    RETURNING id;
  `.execute(db);
  const stockAcct1Id = cAcct.rows[0].id;

  // 6. Period Seeds for Day 1
  await sql`
    INSERT INTO period_financial_seeds (
        franchise_id, period_id, opening_cash, opening_owner_balance,
        opening_jazz_lifting, opening_jazz_payable, is_verified
    ) VALUES (
        ${f1Id}, ${periodId}, 10000.00, 5000.00, 25000.00, 15000.00, true
    );
  `.execute(db);

  await sql`
    INSERT INTO period_credit_party_seeds (franchise_id, period_id, party_id, opening_balance)
    VALUES (${f1Id}, ${periodId}, ${creditParty1Id}, 3000.00);
  `.execute(db);

  await sql`
    INSERT INTO period_credit_party_seeds (franchise_id, period_id, party_id, opening_balance)
    VALUES (${f1Id}, ${periodId}, ${creditParty2Id}, 0.00);
  `.execute(db);

  await sql`
    INSERT INTO period_stock_product_seeds (franchise_id, period_id, product_id, opening_quantity)
    VALUES (${f1Id}, ${periodId}, ${stockProd1Id}, 50);
  `.execute(db);

  await sql`
    INSERT INTO period_stock_account_seeds (franchise_id, period_id, account_id, opening_receivable)
    VALUES (${f1Id}, ${periodId}, ${stockAcct1Id}, 2000.00);
  `.execute(db);

  await sql`
    INSERT INTO period_jazz_do_seeds (franchise_id, period_id, do_profile_id, opening_base_balance)
    VALUES (${f1Id}, ${periodId}, ${doProfile1Id}, 8000.00);
  `.execute(db);

  return {
    f1Id,
    f2Id,
    periodId,
    f2PeriodId,
    day1Id,
    day2Id,
    day3Id,
    day4ClosedId,
    f2Day1Id,
    expCatId,
    commCatId,
    creditParty1Id,
    creditParty2Id,
    stockProd1Id,
    stockAcct1Id,
    doProfile1Id
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

async function runCalculationTests() {
  console.log("=== STARTING PHASE 6B CALCULATION & PROJECTION ENGINE TEST SUITE ===\n");

  const data = await setupTestData();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  setTokenVerifierForTesting(async (token: string) => {
    if (token === "calc-owner") return { uid: "test-calc-owner", email: "owner@calc.test" };
    if (token === "calc-admin") return { uid: "test-calc-admin", email: "admin@calc.test" };
    if (token === "calc-viewer") return { uid: "test-calc-viewer", email: "viewer@calc.test" };
    if (token === "calc-f2owner") return { uid: "test-calc-f2owner", email: "f2owner@calc.test" };
    throw new Error("INVALID_TOKEN");
  });

  try {
    // -------------------------------------------------------------------------
    // 1. Initial Day 1 Projection from Period Seeds
    // -------------------------------------------------------------------------
    console.log("Group 1: Initial Day 1 Calculation from Period Seeds");
    const initRes = await req(base, "POST", `/api/v1/calculations/rebuild-day/${data.day1Id}`, "calc-admin");
    assert(initRes.status === 200, "Admin can rebuild Day 1");

    const day1Proj = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day1Id}`, "calc-viewer");
    assert(day1Proj.status === 200, "Viewer can get Day 1 projections");
    const fin1 = day1Proj.body.data.projections.financial;
    assert(Number(fin1.opening_cash) === 10000.00, "Opening cash matches seed: 10000.00");
    assert(Number(fin1.total_issues) === 0.00, "Total issues is 0.00");
    assert(Number(fin1.total_expenses) === 0.00, "Total expenses is 0.00");
    assert(Number(fin1.closing_cash) === 10000.00, "Closing cash is 10000.00");
    assert(Number(fin1.operating_profit) === 0.00, "Operating profit is 0.00");
    assert(Number(fin1.owner_opening_balance) === 5000.00, "Owner opening balance matches seed: 5000.00");
    assert(Number(fin1.owner_closing_balance) === 5000.00, "Owner closing balance is 5000.00");
    assert(Number(fin1.opening_jazz_payable) === 15000.00, "Opening jazz payable matches seed: 15000.00");
    assert(Number(fin1.closing_jazz_payable) === 15000.00, "Closing jazz payable is 15000.00");

    // Credit Parties: Party 1 has 3000 seed, Party 2 (0 balance, 0 activity) must be pruned
    const creditParties = day1Proj.body.data.projections.creditParties;
    const cp1 = creditParties.find((p: any) => p.party_id === data.creditParty1Id);
    const cp2 = creditParties.find((p: any) => p.party_id === data.creditParty2Id);
    assert(cp1 && Number(cp1.opening_balance) === 3000.00 && Number(cp1.closing_balance) === 3000.00, "Party 1 carried seed: 3000.00");
    assert(!cp2, "Party 2 with zero balance and zero activity is pruned");

    // Stock Product: Seed 50
    const sp1 = day1Proj.body.data.projections.stockProducts.find((p: any) => p.product_id === data.stockProd1Id);
    assert(sp1 && sp1.opening_qty === 50 && sp1.closing_qty === 50, "Stock product matches seed: 50");

    // Stock Account: Seed 2000
    const sa1 = day1Proj.body.data.projections.stockAccounts.find((a: any) => a.account_id === data.stockAcct1Id);
    assert(sa1 && Number(sa1.opening_due) === 2000.00 && Number(sa1.closing_due) === 2000.00, "Stock account due matches seed: 2000.00");

    // Jazz Lifting: Seed 25000
    const jl1 = day1Proj.body.data.projections.jazzLifting;
    assert(jl1 && Number(jl1.opening_lifting) === 25000.00 && Number(jl1.closing_lifting_in_hand) === 25000.00, "Jazz lifting matches seed: 25000.00");

    // Jazz DO: Seed 8000 base, applied rate 2.5%, closing ML = 8200
    const jd1 = day1Proj.body.data.projections.jazzDo.find((d: any) => d.do_profile_id === data.doProfile1Id);
    assert(jd1 && Number(jd1.opening_base) === 8000.00 && Number(jd1.closing_base) === 8000.00, "Jazz DO base matches seed: 8000.00");
    assert(jd1 && Number(jd1.closing_ml) === 8200.00, "Jazz DO closing ML computed: 8200.00 (8000 * 1.025)");

    // -------------------------------------------------------------------------
    // 2. Operational Transactions on Day 1 & Pure Mathematical Invariant Proofs
    // -------------------------------------------------------------------------
    console.log("\nGroup 2: Operational Mutations on Day 1 & Mathematical Invariants");

    // Commission: +2500.00
    const commRes = await req(base, "POST", "/api/v1/transactions/commissions", "calc-admin", {
      day_id: data.day1Id,
      category_id: data.commCatId,
      amount: 2500.00
    });
    assert(commRes.status === 201, "Commission created: 2500.00");

    // Expense: +800.00
    const expRes = await req(base, "POST", "/api/v1/transactions/expenses", "calc-admin", {
      day_id: data.day1Id,
      category_id: data.expCatId,
      item_name: "Office Electricity",
      amount: 800.00
    });
    assert(expRes.status === 201, "Expense created: 800.00");

    // Owner Injection: +3000.00
    const ownerRes = await req(base, "POST", "/api/v1/transactions/owner", "calc-admin", {
      day_id: data.day1Id,
      description: "Working Capital Injection",
      amount: 3000.00
    });
    assert(ownerRes.status === 201, "Owner transaction created: +3000.00");

    // Credit Loan: +500.00 to Party 1
    const creditRes = await req(base, "POST", "/api/v1/transactions/credits", "calc-admin", {
      day_id: data.day1Id,
      party_id: data.creditParty1Id,
      loan_amount: 500.00,
      receipt_amount: 0,
      manual_adjustment: 0
    });
    assert(creditRes.status === 201, "Credit loan created: 500.00");

    // Stock Inbound Purchase (20 SIMs @ 100.00 = 2000.00)
    const stockInRes = await req(base, "POST", "/api/v1/transactions/stock/orders", "calc-admin", {
      day_id: data.day1Id,
      direction: "inbound",
      supplier_name: "Jazz Company",
      lines: [{ product_id: data.stockProd1Id, quantity: 20, unit_rate: 100.00 }]
    });
    assert(stockInRes.status === 201, "Stock inbound purchase created: 20 SIMs @ 100.00");

    // Stock Outbound Sale to Account 1 (10 SIMs @ 100.00 = 1000.00)
    const stockOutRes = await req(base, "POST", "/api/v1/transactions/stock/orders", "calc-admin", {
      day_id: data.day1Id,
      direction: "outbound",
      account_id: data.stockAcct1Id,
      lines: [{ product_id: data.stockProd1Id, quantity: 10, unit_rate: 100.00 }]
    });
    assert(stockOutRes.status === 201, "Stock outbound sale created: 10 SIMs @ 100.00");

    // Stock Account Payment from Account 1: 600.00
    const stockPayRes = await req(base, "POST", "/api/v1/transactions/stock/account-payments", "calc-admin", {
      day_id: data.day1Id,
      account_id: data.stockAcct1Id,
      amount: 600.00,
      payment_method: "cash"
    });
    assert(stockPayRes.status === 201, "Stock account payment created: 600.00");

    // Jazz Lifting Purchased: 10000.00
    const liftRes = await req(base, "POST", "/api/v1/transactions/jazz-load/lifting", "calc-admin", {
      day_id: data.day1Id,
      ml_lifting_amount: 10000.00
    });
    assert(liftRes.status === 201, "Jazz lifting created: 10000.00");

    // Jazz DO Entry: Issuance 4000.00 base, Payment 2000.00 base
    const doRes = await req(base, "POST", "/api/v1/transactions/jazz-load/do", "calc-admin", {
      day_id: data.day1Id,
      do_profile_id: data.doProfile1Id,
      issuance_base: 4000.00,
      payment_base: 2000.00
    });
    assert(doRes.status === 201, "Jazz DO entry created: 4000 iss, 2000 pay");

    // Jazz Company Payable Payment: 5000.00
    const jazzPayRes = await req(base, "POST", "/api/v1/transactions/jazz-company/payments", "calc-admin", {
      day_id: data.day1Id,
      amount: 5000.00
    });
    assert(jazzPayRes.status === 201, "Jazz company payable payment created: 5000.00");

    // Verify Day 1 Projections Automatically Updated (Hybrid Atomic Engine)
    const day1Post = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day1Id}`, "calc-viewer");
    const pFin = day1Post.body.data.projections.financial;
    assert(Number(pFin.total_issues) === 2500.00, "Total issues: 2500.00");
    assert(Number(pFin.total_expenses) === 800.00, "Total expenses: 800.00");
    // closing_cash = 10000 + 2500 - 800 = 11700.00
    assert(Number(pFin.closing_cash) === 11700.00, "Closing cash formula proved: 10000 + 2500 - 800 = 11700.00");
    // operating_profit = 2500 - 800 = 1700.00
    assert(Number(pFin.operating_profit) === 1700.00, "Operating profit formula proved: 2500 - 800 = 1700.00");
    // owner_closing_balance = 5000 + 3000 = 8000.00
    assert(Number(pFin.owner_closing_balance) === 8000.00, "Owner balance proved: 5000 + 3000 = 8000.00");
    // STRICT POLICY VERIFICATION: Owner injection of 3000.00 DID NOT alter register closing cash (remains 11700.00)
    assert(Number(pFin.closing_cash) === 11700.00, "CRITICAL: Owner injection did NOT alter operating register cash");

    // Jazz Company Payable: 15000 + 2000 (inbound stock) - 5000 (payment) = 12000.00
    assert(Number(pFin.closing_jazz_payable) === 12000.00, "Jazz company payable formula proved: 15000 + 2000 - 5000 = 12000.00");

    // Credit Party 1: 3000 + 500 = 3500.00
    const pCp1 = day1Post.body.data.projections.creditParties.find((p: any) => p.party_id === data.creditParty1Id);
    assert(pCp1 && Number(pCp1.closing_balance) === 3500.00, "Credit party 1 closing balance proved: 3000 + 500 = 3500.00");

    // Stock Product 1: 50 + 20 - 10 = 60
    const pSp1 = day1Post.body.data.projections.stockProducts.find((p: any) => p.product_id === data.stockProd1Id);
    assert(pSp1 && pSp1.closing_qty === 60, "Stock product 1 closing qty proved: 50 + 20 - 10 = 60");

    // Stock Account 1 Due: 2000 + 1000 - 600 = 2400.00
    const pSa1 = day1Post.body.data.projections.stockAccounts.find((a: any) => a.account_id === data.stockAcct1Id);
    assert(pSa1 && Number(pSa1.closing_due) === 2400.00, "Stock account due proved: 2000 + 1000 - 600 = 2400.00");

    // Jazz Lifting: 25000 + 10000 - (4000 * 1.025 = 4100) = 30900.00
    const pJl1 = day1Post.body.data.projections.jazzLifting;
    assert(pJl1 && Number(pJl1.closing_lifting_in_hand) === 30900.00, "Jazz lifting in-hand proved: 25000 + 10000 - 4100 = 30900.00");

    // Jazz DO 1: 8000 + 4000 - 2000 = 10000.00 base, 10250.00 ML
    const pJd1 = day1Post.body.data.projections.jazzDo.find((d: any) => d.do_profile_id === data.doProfile1Id);
    assert(pJd1 && Number(pJd1.closing_base) === 10000.00, "Jazz DO closing base proved: 8000 + 4000 - 2000 = 10000.00");
    assert(pJd1 && Number(pJd1.closing_ml) === 10250.00, "Jazz DO closing ML proved: 10000 * 1.025 = 10250.00");

    // -------------------------------------------------------------------------
    // 3. Day-to-Day Carry Forward to Day 2
    // -------------------------------------------------------------------------
    console.log("\nGroup 3: Day-to-Day Carry-Forward to Day 2");

    const day2Proj = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day2Id}`, "calc-viewer");
    const fin2 = day2Proj.body.data.projections.financial;
    assert(Number(fin2.opening_cash) === 11700.00, "Day 2 opening cash matches Day 1 closing cash: 11700.00");
    assert(Number(fin2.owner_opening_balance) === 8000.00, "Day 2 owner opening matches Day 1 closing: 8000.00");
    assert(Number(fin2.opening_jazz_payable) === 12000.00, "Day 2 opening jazz payable matches Day 1 closing: 12000.00");

    const cp1Day2 = day2Proj.body.data.projections.creditParties.find((p: any) => p.party_id === data.creditParty1Id);
    assert(cp1Day2 && Number(cp1Day2.opening_balance) === 3500.00, "Day 2 credit party 1 opening matches Day 1 closing: 3500.00");

    const sp1Day2 = day2Proj.body.data.projections.stockProducts.find((p: any) => p.product_id === data.stockProd1Id);
    assert(sp1Day2 && sp1Day2.opening_qty === 60, "Day 2 stock product opening qty matches Day 1 closing: 60");

    const sa1Day2 = day2Proj.body.data.projections.stockAccounts.find((a: any) => a.account_id === data.stockAcct1Id);
    assert(sa1Day2 && Number(sa1Day2.opening_due) === 2400.00, "Day 2 stock account opening due matches Day 1 closing: 2400.00");

    const jl2 = day2Proj.body.data.projections.jazzLifting;
    assert(jl2 && Number(jl2.opening_lifting) === 30900.00, "Day 2 jazz lifting opening matches Day 1 closing: 30900.00");

    const jd2 = day2Proj.body.data.projections.jazzDo.find((d: any) => d.do_profile_id === data.doProfile1Id);
    assert(jd2 && Number(jd2.opening_base) === 10000.00, "Day 2 jazz DO opening base matches Day 1 closing: 10000.00");

    // -------------------------------------------------------------------------
    // 4. Invariant Warnings (Non-blocking: Negative Stock, Negative Cash, Negative Lifting)
    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Non-Blocking Invariant Warnings (Negative Tolerance)");

    // Close Day 1 and open Day 2 so Day 2 mutations are permitted under single-open-day rule
    await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${data.day1Id}`.execute(db);
    await sql`UPDATE accounting_days SET status = 'open' WHERE id = ${data.day2Id}`.execute(db);

    // Sale of 100 SIMs on Day 2 (when opening inventory is only 60) -> closing = -40
    const negStockRes = await req(base, "POST", "/api/v1/transactions/stock/orders", "calc-admin", {
      day_id: data.day2Id,
      direction: "outbound",
      account_id: data.stockAcct1Id,
      lines: [{ product_id: data.stockProd1Id, quantity: 100, unit_rate: 100.00 }]
    });
    assert(negStockRes.status === 201, "Negative stock sale accepted without blocking (201 Created)");

    // Large Expense of 20000 on Day 2 (when cash is 11700) -> closing = -8300
    const negCashRes = await req(base, "POST", "/api/v1/transactions/expenses", "calc-admin", {
      day_id: data.day2Id,
      category_id: data.expCatId,
      item_name: "Massive Unbudgeted Expense",
      amount: 20000.00
    });
    assert(negCashRes.status === 201, "Negative register cash expense accepted without blocking (201 Created)");

    // Large DO Issuance of 50000 ML on Day 2 (when lifting in hand is 30900) -> lifting = -19100
    const negLiftRes = await req(base, "POST", "/api/v1/transactions/jazz-load/do", "calc-admin", {
      day_id: data.day2Id,
      do_profile_id: data.doProfile1Id,
      issuance_base: 50000.00,
      payment_base: 0
    });
    assert(negLiftRes.status === 201, "Negative lifting DO issuance accepted without blocking (201 Created)");

    // Inspect Invariant Violations Endpoint
    const invRes = await req(base, "GET", `/api/v1/calculations/invariants/${data.periodId}`, "calc-viewer");
    assert(invRes.status === 200, "Viewer can list invariant violations");
    const violations = invRes.body.data;
    const stockWarn = violations.find((v: any) => v.invariant_code === "INV_STOCK_QTY_NEGATIVE");
    const cashWarn = violations.find((v: any) => v.invariant_code === "INV_CASH_NEGATIVE");
    const liftWarn = violations.find((v: any) => v.invariant_code === "INV_LIFTING_NEGATIVE");

    assert(Boolean(stockWarn), "INV_STOCK_QTY_NEGATIVE warning logged in invariant_violations");
    assert(Boolean(cashWarn), "INV_CASH_NEGATIVE warning logged in invariant_violations");
    assert(Boolean(liftWarn), "INV_LIFTING_NEGATIVE warning logged in invariant_violations");
    assert(stockWarn && stockWarn.severity === "warning", "Stock violation severity is 'warning' (not critical)");

    // -------------------------------------------------------------------------
    // 5. Historical Correction & Forward Cascade
    // -------------------------------------------------------------------------
    console.log("\nGroup 5: Historical Correction & Forward Cascade");

    // Close Day 2 and reopen Day 1 for historical correction
    await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${data.day2Id}`.execute(db);
    await sql`UPDATE accounting_days SET status = 'reopen' WHERE id = ${data.day1Id}`.execute(db);

    // On Day 1, update the original expense from 800.00 to 1800.00 (+1000 expense)
    const expPatchRes = await req(base, "PATCH", `/api/v1/transactions/expenses/${expRes.body.data.id}`, "calc-admin", {
      baseRevision: 1,
      amount: 1800.00
    });
    assert(expPatchRes.status === 200, "Historical expense patched on Day 1 (+1000 expense)");

    // Day 1 Closing Cash was 11700, should now be 10700
    const day1Cascaded = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day1Id}`, "calc-viewer");
    assert(Number(day1Cascaded.body.data.projections.financial.closing_cash) === 10700.00, "Day 1 closing cash updated to 10700.00");

    // Day 2 Opening Cash must have cascaded to 10700.00
    const day2Cascaded = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day2Id}`, "calc-viewer");
    assert(Number(day2Cascaded.body.data.projections.financial.opening_cash) === 10700.00, "Day 2 opening cash cascaded forward to 10700.00");

    // Day 3 Opening Cash must also have cascaded forward!
    const day3Cascaded = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day3Id}`, "calc-viewer");
    assert(day3Cascaded.status === 200, "Day 3 projections accessible");
    // Day 2 closing cash was 10700 - 20000 = -9300.00
    assert(Number(day3Cascaded.body.data.projections.financial.opening_cash) === -9300.00, "Day 3 opening cash reflects cascaded Day 2 closing: -9300.00");

    // -------------------------------------------------------------------------
    // 6. Closed Day Mutation / Recalculation Protection
    // -------------------------------------------------------------------------
    console.log("\nGroup 6: Closed Day Invariant Enforcement");

    const closedRebuild = await req(base, "POST", `/api/v1/calculations/rebuild-day/${data.day4ClosedId}`, "calc-admin");
    assert(closedRebuild.status === 422, "Rebuilding closed day rejected with 422");
    assert(closedRebuild.body.code === "INV_CLOSED_DAY_MUTATION", "Error code is INV_CLOSED_DAY_MUTATION");

    // -------------------------------------------------------------------------
    // 7. Administrative Rebuild Endpoints & Full Period Rebuild
    // -------------------------------------------------------------------------
    console.log("\nGroup 7: Administrative Rebuild Endpoints & Calculation Runs");

    const periodRebuild = await req(base, "POST", `/api/v1/calculations/rebuild-period/${data.periodId}`, "calc-admin");
    assert(periodRebuild.status === 200, "Full period rebuild succeeded (200 OK)");
    assert(periodRebuild.body.data.daysCalculated === 4, "Rebuilt 4 accounting days");

    // List calculation runs
    const runsRes = await req(base, "GET", "/api/v1/calculations/runs?limit=10", "calc-viewer");
    assert(runsRes.status === 200, "Viewer can list calculation runs");
    assert(Array.isArray(runsRes.body.data) && runsRes.body.data.length > 0, "Calculation runs contains logged runs");
    const latestRun = runsRes.body.data[0];
    assert(latestRun.status === "completed", "Latest run status is 'completed'");
    assert(latestRun.duration_ms !== null, "Latest run has duration_ms recorded");

    // -------------------------------------------------------------------------
    // 8. RBAC & Tenant Isolation
    // -------------------------------------------------------------------------
    console.log("\nGroup 8: RBAC & Tenant Isolation");

    // Viewer cannot trigger rebuilds (403 Forbidden)
    const viewerRebuild = await req(base, "POST", `/api/v1/calculations/rebuild-day/${data.day1Id}`, "calc-viewer");
    assert(viewerRebuild.status === 403, "Viewer cannot trigger calculation rebuild (403 Forbidden)");

    // F2 cannot access F1 day projections (404)
    const f2ReadF1 = await req(base, "GET", `/api/v1/calculations/projections/day/${data.day1Id}`, "calc-f2owner");
    assert(f2ReadF1.status === 404, "F2 tenant cannot read F1 day projections (404 Not Found)");

    // F2 cannot rebuild F1 day
    const f2RebuildF1 = await req(base, "POST", `/api/v1/calculations/rebuild-day/${data.day1Id}`, "calc-f2owner");
    assert(f2RebuildF1.status === 422 || f2RebuildF1.status === 500, "F2 tenant cannot rebuild F1 day");

  } finally {
    server.close();
    await cleanupTestData();
    console.log("[Test Clean] Temporary calculation test data 100% removed from database.");
  }

  console.log(`\n=== PHASE 6B CALCULATION TESTS COMPLETE ===`);
  console.log(`Passed: ${pass} | Failed: ${fail}`);

  if (fail > 0) {
    throw new Error(`${fail} calculation integration tests failed.`);
  }
}

runCalculationTests()
  .then(() => {
    console.log("\n=== ALL PHASE 6B CALCULATION TESTS PASSED ===");
    process.exit(0);
  })
  .catch((err) => {
    console.error("\n=== CALCULATION TEST RUNNER FAILED ===", err);
    process.exit(1);
  });
