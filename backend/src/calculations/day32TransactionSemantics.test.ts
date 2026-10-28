/**
 * Day 32 / FINAL Transaction Semantics Integration Tests
 *
 * Verifies that Day 32 preserves exact accounting meanings:
 * 1. EXPENSE: decreases cash, increases expenses, decreases operating profit (NOT mapped to CASH_SETTLEMENT)
 * 2. COMMISSION: increases cash, increases total revenue/issues, increases operating profit (NOT mapped to COMMISSION_RECEIVABLE)
 * 3. CREDIT_LOAN: increases credit party debt, does not trigger over-settlement
 * 4. CREDIT_RECEIVE: decreases credit party debt
 * 5. Both CREDIT_LOAN and CREDIT_RECEIVE coexist for the same credit party
 * 6. OWNER_DRAWING (+ drawing) increases owner balance
 * 7. OWNER_INJECTION (- injection) decreases owner balance
 * 8. operationalBalances preserves pre-FINAL Day 31 position for Daily Entry opening hydration
 * 9. closingBalances reflects Day 31 + Day 32 net position for rollover seeds
 * 10. Day 31 operational tables and accounting_days remain 100% untouched
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";
import { getPeriodFinalProjections } from "./service.js";

const FRANCHISE_CODE = "TEST-D32-F1";
const OWNER_UID = "test-d32-owner";
const OWNER_EMAIL = "owner@d32.test";

function assert(condition: boolean, message: string, actual?: any): asserts condition {
  if (!condition) {
    const detail = actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : "";
    throw new Error(`Assertion Failed: ${message}${detail}`);
  }
  console.log(`   ✓ ${message}`);
}

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
    DELETE FROM calculation_runs WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM invariant_violations WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM day_financial_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM mutation_idempotency WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM audit_logs WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM commission_settlement_receipts WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM final_settlement_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM franchise_users WHERE franchise_id IN (SELECT id FROM franchises WHERE code = 'TEST-D32-F1');
    DELETE FROM franchises WHERE code = 'TEST-D32-F1';
    DELETE FROM users WHERE firebase_uid = 'test-d32-owner';
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

async function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: any
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = http.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer test-token-${OWNER_UID}`
        }
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode || 500, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log("=== DAY 32 TRANSACTION SEMANTICS TEST SUITE ===");

  setTokenVerifierForTesting(async (token: string) => {
    if (token === `test-token-${OWNER_UID}`) {
      return {
        uid: OWNER_UID,
        email: OWNER_EMAIL,
        role: "owner",
        franchiseCode: FRANCHISE_CODE
      };
    }
    throw new Error("Invalid token");
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;

  try {
    await cleanupTestData();

    // 1. Setup Franchise, Owner, Catalogs, Period
    const franchiseRes = await sql<{ id: string }>`
      INSERT INTO franchises (name, code)
      VALUES ('Test Day32 Franchise', ${FRANCHISE_CODE})
      RETURNING id;
    `.execute(db);
    const franchiseId = franchiseRes.rows[0].id;

    const u = await sql<{ id: string }>`
      INSERT INTO users (firebase_uid, email, display_name, is_active)
      VALUES (${OWNER_UID}, ${OWNER_EMAIL}, 'Day32 Owner', true)
      RETURNING id;
    `.execute(db);
    const ownerUserId = u.rows[0].id;

    await sql`
      INSERT INTO franchise_users (franchise_id, user_id, role)
      VALUES (${franchiseId}, ${ownerUserId}, 'owner');
    `.execute(db);

    const cpRes = await sql<{ id: string }>`
      INSERT INTO credit_parties (franchise_id, slug, name, is_active)
      VALUES (${franchiseId}, 'd32-cp-alpha', 'Alpha Dealer', true)
      RETURNING id;
    `.execute(db);
    const creditPartyId = cpRes.rows[0].id;

    const catRes = await sql<{ id: string }>`
      INSERT INTO expense_categories (franchise_id, slug, name, is_active)
      VALUES (${franchiseId}, 'd32-util', 'Utilities', true)
      RETURNING id;
    `.execute(db);
    const expenseCategoryId = catRes.rows[0].id;

    const initRes = await makeRequest(base, "POST", "/api/v1/periods/initialize", {
      periodKey: "2026-08"
    });
    assert(initRes.status === 201, "Initialized August 2026 period");
    const periodId = initRes.body.period.id;

    // Stage genesis seeds
    await makeRequest(base, "PUT", `/api/v1/periods/${periodId}/seeds`, {
      financial: {
        openingCash: 50000,
        openingOwnerBalance: 5000,
        openingJazzLifting: 0,
        openingJazzPayable: 0,
        openingCommissionReceivable: 0
      },
      creditParties: [{ partyId: creditPartyId, openingBalance: 8000 }],
      stockProducts: [],
      stockAccounts: [],
      jazzDoProfiles: []
    });

    await makeRequest(base, "POST", `/api/v1/periods/${periodId}/verify-seeds`);
    await makeRequest(base, "POST", `/api/v1/periods/${periodId}/activate`);

    // Get Day 31
    const day31Row = await sql<{ id: string }>`
      SELECT id FROM accounting_days WHERE franchise_id = ${franchiseId} AND period_id = ${periodId} AND day_no = 31;
    `.execute(db);
    const day31Id = day31Row.rows[0].id;

    // Simulate Day 31 closing projections:
    // Cash: 50,000 | Owner: 5,000 | Total Expenses: 10,000 | Total Issues: 30,000 | Operating Profit: 20,000
    // Credit Party Alpha debt: 8,000
    await sql`
      INSERT INTO day_financial_projections (
        franchise_id, day_id, opening_cash, total_issues, total_expenses,
        closing_cash, operating_profit, owner_opening_balance, owner_closing_balance,
        opening_jazz_payable, closing_jazz_payable
      ) VALUES (
        ${franchiseId}, ${day31Id}, 30000.00, 30000.00, 10000.00,
        50000.00, 20000.00, 5000.00, 5000.00,
        0.00, 0.00
      );
    `.execute(db);

    await sql`
      INSERT INTO credit_party_day_projections (
        franchise_id, day_id, party_id, opening_balance, total_loans, total_receipts, manual_adjustments, closing_balance
      ) VALUES (
        ${franchiseId}, ${day31Id}, ${creditPartyId}, 8000.00, 0.00, 0.00, 0.00, 8000.00
      );
    `.execute(db);

    // Close Day 31
    await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${day31Id};`.execute(db);

    // Initial check: Day 31 baseline
    const baseline = await getPeriodFinalProjections(franchiseId, periodId);
    assert(Boolean(baseline), "Day 31 baseline projection loaded");
    assert(baseline!.operationalBalances?.financial.closingCash === "50000.00", "Baseline cash is 50,000.00");
    assert(baseline!.operationalBalances?.financial.closingOwnerBalance === "5000.00", "Baseline owner balance is 5,000.00");
    assert(baseline!.operationalBalances?.financial.operatingProfit === "20000.00", "Baseline operating profit is 20,000.00");
    assert(baseline!.operationalBalances?.financial.totalExpenses === "10000.00", "Baseline total expenses is 10,000.00");
    assert(baseline!.operationalBalances?.financial.totalIssues === "30000.00", "Baseline total issues is 30,000.00");
    const cpBaseline = baseline!.operationalBalances?.creditParties.find((c) => c.partyId === creditPartyId);
    assert(cpBaseline?.closingBalance === "8000.00", "Baseline credit party debt is 8,000.00");

    console.log("\n--- Testing Day 32 Transaction Semantics ---");

    // 1. Post Day 32 EXPENSE: 2,500
    const addExpRes = await makeRequest(base, "POST", `/api/v1/periods/${periodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "EXPENSE",
      settlementType: "EXPENSE",
      targetEntityId: expenseCategoryId,
      targetEntityName: "Utilities",
      sourceReference: "Electricity Bill",
      notes: "Office electricity invoice",
      amount: 2500
    });
    assert(addExpRes.status === 201, "Posted Day 32 EXPENSE (HTTP 201)");

    // 2. Post Day 32 COMMISSION: 4,000
    const addCommRes = await makeRequest(base, "POST", `/api/v1/periods/${periodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION",
      settlementType: "COMMISSION",
      targetEntityName: "Special Incentive",
      sourceReference: "Special Incentive",
      notes: "Month-end performance commission",
      amount: 4000
    });
    assert(addCommRes.status === 201, "Posted Day 32 COMMISSION (HTTP 201)");

    // 3. Post Day 32 CREDIT_LOAN: 3,000
    const addLoanRes = await makeRequest(base, "POST", `/api/v1/periods/${periodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "CREDIT_PARTY_BALANCE",
      settlementType: "CREDIT_LOAN",
      targetEntityId: creditPartyId,
      targetEntityName: "Alpha Dealer",
      sourceReference: "Credit advance",
      notes: "Credit advance",
      amount: 3000
    });
    assert(addLoanRes.status === 201, "Posted Day 32 CREDIT_LOAN (HTTP 201)");

    // 4. Post Day 32 CREDIT_RECEIVE: 1,500 (both loan and receive for Alpha)
    const addReceiveRes = await makeRequest(base, "POST", `/api/v1/periods/${periodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "CREDIT_PARTY_BALANCE",
      settlementType: "CREDIT_RECEIVE",
      targetEntityId: creditPartyId,
      targetEntityName: "Alpha Dealer",
      sourceReference: "Cash repayment",
      notes: "Cash repayment",
      amount: 1500
    });
    assert(addReceiveRes.status === 201, "Posted Day 32 CREDIT_RECEIVE (HTTP 201)");

    // 5. Post Day 32 OWNER_DRAWING: 1,000
    const addDrawingRes = await makeRequest(base, "POST", `/api/v1/periods/${periodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "OWNER_BALANCE",
      settlementType: "OWNER_DRAWING",
      sourceReference: "Owner Personal Drawing",
      notes: "Personal drawing",
      amount: 1000
    });
    assert(addDrawingRes.status === 201, "Posted Day 32 OWNER_DRAWING (HTTP 201)");

    // 6. Post Day 32 OWNER_INJECTION: 2,000
    const addInjRes = await makeRequest(base, "POST", `/api/v1/periods/${periodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "OWNER_BALANCE",
      settlementType: "OWNER_INJECTION",
      sourceReference: "Owner Equity Contribution",
      notes: "Equity contribution",
      amount: 2000
    });
    assert(addInjRes.status === 201, "Posted Day 32 OWNER_INJECTION (HTTP 201)");

    console.log("\n--- Verifying Authoritative FINAL Projections ---");
    const finalProj = await getPeriodFinalProjections(franchiseId, periodId);
    assert(Boolean(finalProj), "Authoritative FINAL projections loaded");

    // A. Operational balances (pre-Day 32 baseline strictly preserved for Daily Entry hydration)
    const opFin = finalProj!.operationalBalances?.financial;
    assert(opFin?.closingCash === "50000.00", "Hydration openingCash matches Day 31 closing: 50,000.00");
    assert(opFin?.closingOwnerBalance === "5000.00", "Hydration ownerOpeningBalance matches Day 31 closing: 5,000.00");
    const opCp = finalProj!.operationalBalances?.creditParties.find((c) => c.partyId === creditPartyId);
    assert(opCp?.closingBalance === "8000.00", "Hydration credit opening matches Day 31 closing: 8,000.00");

    // B. Post-FINAL Closing Balances (Day 31 + Day 32 net position)
    const closeFin = finalProj!.closingBalances.financial;
    // Cash: 50,000 - 2,500 (expense) + 4,000 (commission) = 51,500.00
    assert(closeFin.closingCash === "51500.00", "Post-FINAL closing cash is 51,500.00 (-2500 exp, +4000 comm)", closeFin.closingCash);
    // Expenses: 10,000 + 2,500 = 12,500.00
    assert(closeFin.totalExpenses === "12500.00", "Post-FINAL total expenses is 12,500.00 (+2500 exp)", closeFin.totalExpenses);
    // Total Issues / Revenue: 30,000 + 4,000 = 34,000.00
    assert(closeFin.totalIssues === "34000.00", "Post-FINAL total issues is 34,000.00 (+4000 comm)", closeFin.totalIssues);
    // Operating Profit: 20,000 - 2,500 + 4,000 = 21,500.00
    assert(closeFin.operatingProfit === "21500.00", "Post-FINAL operating profit is 21,500.00 (+4000 comm - 2500 exp)", closeFin.operatingProfit);
    // Owner Balance: 5,000 + 1,000 (drawing) - 2,000 (injection) = 4,000.00
    assert(closeFin.closingOwnerBalance === "4000.00", "Post-FINAL owner balance is 4,000.00 (+1000 drawing, -2000 injection)", closeFin.closingOwnerBalance);

    // Credit Party Alpha: 8,000 + 3,000 (loan) - 1,500 (receive) = 9,500.00
    const closeCp = finalProj!.closingBalances.creditParties.find((c) => c.partyId === creditPartyId);
    assert(closeCp?.closingBalance === "9500.00", "Post-FINAL Alpha debt is 9,500.00 (+3000 loan, -1500 receive)", closeCp?.closingBalance);
    assert(closeCp?.totalLoans === "3000.00", "Alpha total loans reflects Day 32 loan (3,000.00)");
    assert(closeCp?.totalReceipts === "1500.00", "Alpha total receipts reflects Day 32 receive (1,500.00)");

    // C. Verify Rollover Seed Bundle matches post-FINAL position
    const seeds = finalProj!.seedBundle;
    assert(seeds.financial.openingCash === "51500.00", "September seed opening cash is 51,500.00", seeds.financial.openingCash);
    assert(seeds.financial.openingOwnerBalance === "4000.00", "September seed owner balance is 4,000.00", seeds.financial.openingOwnerBalance);
    const cpSeed = seeds.creditParties.find((c) => c.partyId === creditPartyId);
    assert(cpSeed?.openingBalance === "9500.00", "September seed Alpha balance is 9,500.00", cpSeed?.openingBalance);

    // D. Verify Isolation: Day 31 operational records remain strictly untouched
    const exp31Count = await sql<{ count: string }>`SELECT count(*) as count FROM expense_items WHERE franchise_id = ${franchiseId};`.execute(db);
    assert(parseInt(exp31Count.rows[0].count, 10) === 0, "Zero rows in Day 31 expense_items table");
    const comm31Count = await sql<{ count: string }>`SELECT count(*) as count FROM commission_items WHERE franchise_id = ${franchiseId};`.execute(db);
    assert(parseInt(comm31Count.rows[0].count, 10) === 0, "Zero rows in Day 31 commission_items table");
    const cred31Count = await sql<{ count: string }>`SELECT count(*) as count FROM credit_transactions WHERE franchise_id = ${franchiseId};`.execute(db);
    assert(parseInt(cred31Count.rows[0].count, 10) === 0, "Zero rows in Day 31 credit_transactions table");
    const owner31Count = await sql<{ count: string }>`SELECT count(*) as count FROM owner_transactions WHERE franchise_id = ${franchiseId};`.execute(db);
    assert(parseInt(owner31Count.rows[0].count, 10) === 0, "Zero rows in Day 31 owner_transactions table");
    const day32Rows = await sql<{ count: string }>`SELECT count(*) as count FROM accounting_days WHERE franchise_id = ${franchiseId} AND day_no = 32;`.execute(db);
    assert(parseInt(day32Rows.rows[0].count, 10) === 0, "Zero rows for Day 32 in accounting_days table");

    console.log("\nALL DAY 32 TRANSACTION SEMANTICS TESTS PASSED PERFECTLY!");
  } finally {
    try {
      await cleanupTestData();
    } catch (e) {
      console.error("Cleanup error:", e);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeDatabase();
  }
}

runTests().catch((err) => {
  console.error("\nTEST SUITE FAILED:", err);
  process.exit(1);
});
