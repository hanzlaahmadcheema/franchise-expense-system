/**
 * FINAL Month-End Settlement Layer Integration Tests
 *
 * Validates the complete month-end settlement architecture:
 * 1.  Day 31 -> FINAL balance parity
 * 2.  Add FINAL settlement
 * 3.  FINAL remaining balance decreases correctly
 * 4.  August profit unaffected
 * 5.  No August expense created
 * 6.  No September commission income created
 * 7.  September settlement date with August source period
 * 8.  Multiple settlements
 * 9.  Partial settlement
 * 10. Over-settlement rejection (422)
 * 11. Verification gating on unresolved balances (unless allowOutstanding: true)
 * 12. Immutability on VERIFIED
 * 13. Immutability on CLOSED
 * 14. Rollover seeds reflect post-settlement values
 * 15. September Day 1 receives cash effect
 * 16. Cold reload idempotency and stability
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";
import { getPeriodFinalProjections, rebuildPeriod } from "./service.js";

const FRANCHISE_CODE = "TEST-FSE-F1";
const OWNER_UID = "test-fse-owner";
const OWNER_EMAIL = "owner@fse.test";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
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
    DELETE FROM calculation_runs WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM invariant_violations WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM day_financial_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM mutation_idempotency WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM audit_logs WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM commission_settlement_receipts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM final_settlement_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-FSE-F1'));
    DELETE FROM franchises WHERE code IN ('TEST-FSE-F1');
    DELETE FROM users WHERE firebase_uid IN ('test-fse-owner');
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

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
interface SetupData {
  franchiseId: string;
  augPeriodId: string;
  ownerUserId: string;
  expenseCatId: string;
  commissionCatId: string;
  creditPartyId: string;
  day31Id: string;
  openingCash: number;
}

async function setupTestData(): Promise<SetupData> {
  await cleanupTestData();

  const openingCash = 50000;
  const openingCreditBalance = 10000;

  // 1. Franchise
  const f = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES (${FRANCHISE_CODE}, 'Final Settlement Test Franchise', 'FSEBrand')
    RETURNING id;
  `.execute(db);
  const franchiseId = f.rows[0].id;

  // 2. Owner User
  const u = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES (${OWNER_UID}, ${OWNER_EMAIL}, 'FSE Owner', true)
    RETURNING id;
  `.execute(db);
  const ownerUserId = u.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${ownerUserId}, 'owner');`.execute(db);

  // 3. Catalogs
  const expCat = await sql<{ id: string }>`
    INSERT INTO expense_categories (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'fse-util', 'Utilities', true)
    RETURNING id;
  `.execute(db);

  const commCat = await sql<{ id: string }>`
    INSERT INTO commission_categories (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'fse-comm', 'Jazz Commission', true)
    RETURNING id;
  `.execute(db);

  const cp = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'fse-cp1', 'Credit Party Alpha', true)
    RETURNING id;
  `.execute(db);

  // 4. August 2026 Period (Days 1..31)
  const periodRes = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${franchiseId}, '2026-08', 2026, 8, 'August 2026', 'open')
    RETURNING id;
  `.execute(db);
  const augPeriodId = periodRes.rows[0].id;

  let day30Id = "";
  let day31Id = "";
  for (let d = 1; d <= 31; d++) {
    const dStr = String(d).padStart(2, "0");
    const r = await sql<{ id: string }>`
      INSERT INTO accounting_days (franchise_id, period_id, day_no, day_type, calendar_date, label, status)
      VALUES (${franchiseId}, ${augPeriodId}, ${d}, 'calendar', ${`2026-08-${dStr}`}, ${`Day ${d}`}, 'closed')
      RETURNING id;
    `.execute(db);
    if (d === 30) day30Id = r.rows[0].id;
    if (d === 31) day31Id = r.rows[0].id;
  }

  // 5. Genesis Seeds for August
  await sql`
    INSERT INTO period_financial_seeds (
      franchise_id, period_id, opening_cash, opening_owner_balance,
      opening_jazz_lifting, opening_jazz_payable, opening_commission_receivable,
      is_verified, verified_at, verified_by_user_id
    ) VALUES (
      ${franchiseId}, ${augPeriodId}, ${openingCash}, 0, 0, 0, 20000.00,
      true, clock_timestamp(), ${ownerUserId}
    );
  `.execute(db);

  await sql`
    INSERT INTO day_financial_projections (
      franchise_id, day_id, opening_cash, total_issues, total_expenses,
      closing_cash, operating_profit, owner_opening_balance, owner_closing_balance,
      opening_jazz_payable, closing_jazz_payable, opening_commission_receivable,
      closing_commission_receivable
    ) VALUES (
      ${franchiseId}, ${day30Id}, ${openingCash}, 0.00, 0.00,
      ${openingCash}, 0.00, 0.00, 0.00,
      0.00, 0.00, 20000.00, 20000.00
    );
  `.execute(db);

  await sql`
    INSERT INTO period_credit_party_seeds (
      franchise_id, period_id, party_id, opening_balance
    ) VALUES (
      ${franchiseId}, ${augPeriodId}, ${cp.rows[0].id}, ${openingCreditBalance}
    );
  `.execute(db);

  return {
    franchiseId,
    augPeriodId,
    ownerUserId,
    expenseCatId: expCat.rows[0].id,
    commissionCatId: commCat.rows[0].id,
    creditPartyId: cp.rows[0].id,
    day31Id,
    openingCash
  };
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      url,
      {
        method,
        headers: {
          Authorization: "Bearer test-token-fse-owner",
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any = null;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode || 500, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function assert(condition: boolean, message: string, actual?: unknown) {
  if (!condition) {
    throw new Error(`Assertion Failed: ${message}${actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : ""}`);
  }
  console.log(`   ✓ ${message}`);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
async function runTests() {
  console.log("=== FINAL MONTH-END SETTLEMENT LAYER INTEGRATION TESTS ===");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;

  let data: SetupData;

  try {
    data = await setupTestData();

    setTokenVerifierForTesting(async (token: string) => {
      if (token === "test-token-fse-owner") {
        return { uid: OWNER_UID, email: OWNER_EMAIL };
      }
      throw new Error("Invalid test token");
    });

    // Populate Day 31 transactions:
    // 1. Commission earned: 20,000 (creates 20,000 commission receivable)
    // 2. Expense: 5,000 (reduces cash by 5,000)
    // 3. Credit loan: 2,000 to Credit Party (increases credit party balance to 12,000)
    await sql`UPDATE accounting_days SET status = 'open' WHERE id = ${data.day31Id};`.execute(db);

    const commRes = await makeRequest(base, "POST", "/api/v1/transactions/commissions", {
      day_id: data.day31Id,
      category_id: data.commissionCatId,
      amount: 20000,
      description: "Aug 31 Commission Earned"
    });
    assert(commRes.status === 201, "Posted 20,000 commission on Day 31", commRes.status);

    const expRes = await makeRequest(base, "POST", "/api/v1/transactions/expenses", {
      day_id: data.day31Id,
      category_id: data.expenseCatId,
      amount: 5000,
      description: "Aug 31 Utilities Expense"
    });
    assert(expRes.status === 201, "Posted 5,000 expense on Day 31", expRes.status);

    const credRes = await makeRequest(base, "POST", "/api/v1/transactions/credits", {
      day_id: data.day31Id,
      party_id: data.creditPartyId,
      loan_amount: 2000,
      receive_amount: 0,
      notes: "Aug 31 Credit Loan"
    });
    assert(credRes.status === 201, "Posted 2,000 credit loan on Day 31", credRes.status);

    // Close Day 31
    const close31 = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/days/31/close`);
    assert(close31.status === 200, "Closed Day 31", close31.status);

    await rebuildPeriod(data.franchiseId, data.augPeriodId, {
      triggerSource: "test_rebuild_baseline",
      allowClosedDays: true
    });

    // -------------------------------------------------------------------------
    console.log("\nScenario 1: Day 31 -> FINAL balance parity");
    // -------------------------------------------------------------------------
    const finalParityRes = await makeRequest(base, "GET", `/api/v1/calculations/projections/period/${data.augPeriodId}/final`);
    assert(finalParityRes.status === 200, "FINAL endpoint returns 200 OK", finalParityRes.status);
    const finalData = finalParityRes.body.data;

    assert(finalData.boundary === "FINAL", "Marked as FINAL boundary snapshot", finalData.boundary);
    assert(finalData.finalDay.dayNo === 31, "Source day is Day 31", finalData.finalDay.dayNo);
    // Cash parity: 50000 + 20000 - 5000 = 65000
    assert(Number(finalData.closingBalances.financial.closingCash) === 65000, "FINAL cash parity: 65,000", finalData.closingBalances.financial.closingCash);
    // Credit party parity: 10000 + 2000 = 12000
    const cpSnap = finalData.closingBalances.creditParties.find((p: any) => p.partyId === data.creditPartyId);
    assert(Number(cpSnap.closingBalance) === 12000, "FINAL credit party parity: 12,000", cpSnap.closingBalance);
    // Commission earned: 20000
    assert(Number(finalData.commissionSettlement.totalCommissionEarned) === 20000, "FINAL commission earned: 20,000", finalData.commissionSettlement.totalCommissionEarned);

    // Verify initial finalSettlements layer
    const settlementsLayer = finalData.finalSettlements;
    assert(Boolean(settlementsLayer), "finalSettlements layer exists on FINAL");
    assert(settlementsLayer.entries.length === 0, "No settlements recorded initially", settlementsLayer.entries.length);
    assert(Number(settlementsLayer.totalSettled ?? 0) === 0, "Initial totalSettled is 0", settlementsLayer.totalSettled);
    assert(Number(settlementsLayer.totalOutstanding) > 0, "Initial totalOutstanding reflects unsettled balances", settlementsLayer.totalOutstanding);
    assert(settlementsLayer.allResolved === false, "allResolved is false before settlements", settlementsLayer.allResolved);

    // -------------------------------------------------------------------------
    console.log("\nScenario 2 & 7: Add FINAL settlement with September settlement date & August source period");
    // -------------------------------------------------------------------------
    const addSettlementRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION_RECEIVABLE",
      settlementType: "COMMISSION_SETTLEMENT",
      amount: 15000,
      notes: "Partial Jazz load commission received on Sep 1"
    });
    assert(addSettlementRes.status === 201, "Added 15,000 FINAL settlement entry (HTTP 201)", addSettlementRes.status);
    const entry1 = addSettlementRes.body.data;
    assert(entry1.sourcePeriodKey === "2026-08", "Source period key is 2026-08", entry1.sourcePeriodKey);
    assert(entry1.settlementDate.startsWith("2026-09-01"), "Settlement date is 2026-09-01", entry1.settlementDate);
    assert(Number(entry1.amount) === 15000, "Settlement amount is 15,000", entry1.amount);
    assert(entry1.balanceDomain === "COMMISSION_RECEIVABLE", "Domain is COMMISSION_RECEIVABLE", entry1.balanceDomain);

    // -------------------------------------------------------------------------
    console.log("\nScenario 3 & 9: FINAL remaining balance decreases correctly & partial settlement");
    // -------------------------------------------------------------------------
    const finalAfter1 = await makeRequest(base, "GET", `/api/v1/calculations/projections/period/${data.augPeriodId}/final`);
    const fse1 = finalAfter1.body.data.finalSettlements;
    const commDomain1 = fse1.domainSummaries.find((d: any) => d.balanceDomain === "COMMISSION_RECEIVABLE");
    assert(Number(commDomain1.operationalClosingBalance) === 20000, "Commission domain operational balance: 20,000", commDomain1.operationalClosingBalance);
    assert(Number(commDomain1.settledAmount) === 15000, "Commission domain settled: 15,000", commDomain1.settledAmount);
    assert(Number(commDomain1.remainingOutstanding) === 5000, "Commission domain remaining balance reduced to 5,000", commDomain1.remainingOutstanding);
    assert(commDomain1.isResolved === false, "Commission domain not yet fully resolved (partial)", commDomain1.isResolved);
    assert(fse1.allResolved === false, "allResolved is false", fse1.allResolved);

    // -------------------------------------------------------------------------
    console.log("\nScenario 4: August profit unaffected");
    // -------------------------------------------------------------------------
    // Query Day 31 projection — profit was 20,000 - 5,000 = 15,000 and should remain untouched
    const day31Proj = await makeRequest(base, "GET", `/api/v1/calculations/projections/day/${data.day31Id}`);
    assert(day31Proj.status === 200, "Day 31 projection returns 200", day31Proj.status);
    const day31Fin = day31Proj.body.data.projections.financial;
    assert(Number(day31Fin.operating_profit) === 15000, "Day 31 net profit is strictly 15,000", day31Fin.operating_profit);
    assert(Number(day31Fin.total_issues) === 20000, "August commission income remains 20,000", day31Fin.total_issues);

    // -------------------------------------------------------------------------
    console.log("\nScenario 5: No August expense created");
    // -------------------------------------------------------------------------
    const expensesInDb = await sql<{ count: string }>`
      SELECT count(*) as count FROM expense_items WHERE franchise_id = ${data.franchiseId};
    `.execute(db);
    assert(parseInt(expensesInDb.rows[0].count, 10) === 1, "Exactly 1 expense item in database (no fake settlement expense added)", expensesInDb.rows[0].count);

    // -------------------------------------------------------------------------
    console.log("\nScenario 6: No September commission income created");
    // -------------------------------------------------------------------------
    const commissionsInDb = await sql<{ count: string }>`
      SELECT count(*) as count FROM commission_items WHERE franchise_id = ${data.franchiseId};
    `.execute(db);
    assert(parseInt(commissionsInDb.rows[0].count, 10) === 1, "Exactly 1 commission item in database (settlement is in final_settlement_entries, not commission_items)", commissionsInDb.rows[0].count);

    // -------------------------------------------------------------------------
    console.log("\nScenario 10: Over-settlement rejection (HTTP 422)");
    // -------------------------------------------------------------------------
    // Remaining commission receivable is 5,000. Attempting to add 10,000 must fail with 422
    const overSettlementRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION_RECEIVABLE",
      settlementType: "COMMISSION_SETTLEMENT",
      amount: 10000,
      notes: "Excess settlement attempt"
    });
    assert(overSettlementRes.status === 422, "Over-settlement rejected with HTTP 422", overSettlementRes.status);
    assert(overSettlementRes.body.code === "OVER_SETTLEMENT", "Rejection code is OVER_SETTLEMENT", overSettlementRes.body.code);

    // -------------------------------------------------------------------------
    console.log("\nScenario 8: Multiple settlements & full resolution");
    // -------------------------------------------------------------------------
    // Add remaining 5,000 for COMMISSION_RECEIVABLE
    const addSecondCommRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION_RECEIVABLE",
      settlementType: "COMMISSION_SETTLEMENT",
      amount: 5000,
      notes: "Remaining 5,000 commission received"
    });
    assert(addSecondCommRes.status === 201, "Added second settlement for commission (HTTP 201)", addSecondCommRes.status);

    // Add 12,000 settlement for CREDIT_PARTY_BALANCE
    const addCreditSettlementRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "CREDIT_PARTY_BALANCE",
      settlementType: "CREDIT_RECOVERY",
      targetEntityId: data.creditPartyId,
      targetEntityName: "Credit Party Alpha",
      amount: 12000,
      notes: "Credit recovered on Sep 1"
    });
    assert(addCreditSettlementRes.status === 201, "Added credit party settlement of 12,000 (HTTP 201)", addCreditSettlementRes.status);

    // Check FINAL state now
    const finalAfterAll = await makeRequest(base, "GET", `/api/v1/calculations/projections/period/${data.augPeriodId}/final`);
    const fseAll = finalAfterAll.body.data.finalSettlements;
    assert(fseAll.entries.length === 3, "Total 3 settlement entries recorded", fseAll.entries.length);
    const settledSum = fseAll.entries.reduce((sum: number, e: any) => sum + Number(e.amount), 0);
    assert(settledSum === 32000, "Total settled is 32,000 (15k + 5k + 12k)", settledSum);
    assert(Number(fseAll.totalOutstanding) === 0, "Total outstanding is 0", fseAll.totalOutstanding);
    assert(fseAll.allResolved === true, "allResolved is true after full settlement", fseAll.allResolved);

    // -------------------------------------------------------------------------
    console.log("\nScenario 11: Verification gating on unresolved balances & successful verification");
    // -------------------------------------------------------------------------
    // To test gating when unresolved: delete the 5,000 entry temporarily
    const entry2Id = addSecondCommRes.body.data.id;
    const delRes = await makeRequest(base, "DELETE", `/api/v1/periods/${data.augPeriodId}/final-settlements/${entry2Id}`);
    assert(delRes.status === 200, "Deleted second settlement entry to test unresolved gating", delRes.status);

    // Attempt verify without allowOutstanding -> must be 422
    const verifyFail = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final/verify`, {
      allowOutstanding: false,
      notes: "Premature verification attempt"
    });
    assert(verifyFail.status === 422, "Verification rejected when balances unresolved (HTTP 422)", verifyFail.status);
    assert(verifyFail.body.code === "PERIOD_NOT_READY", "Code is PERIOD_NOT_READY", verifyFail.body.code);
    assert(verifyFail.body.message.includes("Outstanding balance"), "Message mentions unresolved balance", verifyFail.body.message);

    // Re-add the 5,000 settlement to fully resolve
    const reAddComm = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION_RECEIVABLE",
      settlementType: "COMMISSION_SETTLEMENT",
      amount: 5000,
      notes: "Full commission settlement completed"
    });
    assert(reAddComm.status === 201, "Re-added 5,000 settlement", reAddComm.status);

    // Now verify succeeds
    const verifySuccess = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final/verify`, {
      allowOutstanding: false,
      notes: "Verified with all balances resolved"
    });
    assert(verifySuccess.status === 200, "FINAL verified successfully (HTTP 200)", verifySuccess.status);
    assert(verifySuccess.body.status === "VERIFIED", "Status is VERIFIED", verifySuccess.body.status);
    assert(verifySuccess.body.verified === true, "Verified is true", verifySuccess.body.verified);

    // -------------------------------------------------------------------------
    console.log("\nScenario 12: Immutability on VERIFIED");
    // -------------------------------------------------------------------------
    // API attempt to add settlement -> 409
    const addAfterVerified = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION_RECEIVABLE",
      settlementType: "COMMISSION_SETTLEMENT",
      amount: 1000
    });
    assert(addAfterVerified.status === 409, "Adding settlement on VERIFIED period returns 409", addAfterVerified.status);
    assert(addAfterVerified.body.code === "FINAL_SETTLEMENT_IMMUTABLE", "Code is FINAL_SETTLEMENT_IMMUTABLE", addAfterVerified.body.code);

    // API attempt to delete settlement -> 409
    const delAfterVerified = await makeRequest(base, "DELETE", `/api/v1/periods/${data.augPeriodId}/final-settlements/${reAddComm.body.data.id}`);
    assert(delAfterVerified.status === 409, "Deleting settlement on VERIFIED period returns 409", delAfterVerified.status);

    // Direct SQL INSERT blocked by trg_final_settlement_entries_insert
    let sqlInsertBlocked = false;
    try {
      await sql`
        INSERT INTO final_settlement_entries (
          franchise_id, period_id, source_period_key, settlement_date,
          balance_domain, settlement_type, amount
        ) VALUES (
          ${data.franchiseId}, ${data.augPeriodId}, '2026-08', '2026-09-01',
          'COMMISSION_RECEIVABLE', 'COMMISSION_SETTLEMENT', 1000
        );
      `.execute(db);
    } catch (err: any) {
      sqlInsertBlocked = true;
      assert(err.message.includes("Month-End Settlement Violation"), "PostgreSQL INSERT trigger blocked direct mutation on VERIFIED period", err.message);
    }
    assert(sqlInsertBlocked, "Direct SQL insert was blocked by trigger");

    // Direct SQL UPDATE blocked by trg_final_settlement_entries_immutability
    let sqlUpdateBlocked = false;
    try {
      await sql`
        UPDATE final_settlement_entries SET amount = 99999 WHERE id = ${reAddComm.body.data.id};
      `.execute(db);
    } catch (err: any) {
      sqlUpdateBlocked = true;
      assert(err.message.includes("Month-End Settlement Violation"), "PostgreSQL UPDATE trigger blocked direct mutation on VERIFIED period", err.message);
    }
    assert(sqlUpdateBlocked, "Direct SQL update was blocked by trigger");

    // -------------------------------------------------------------------------
    console.log("\nScenario 13: Immutability on CLOSED");
    // -------------------------------------------------------------------------
    // Close August period
    const closeAug = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/close`);
    assert(closeAug.status === 200, "Closed August period (HTTP 200)", closeAug.status);
    assert(closeAug.body.period.status === "closed", "August period status is closed", closeAug.body.period.status);

    // Mutation remains blocked
    const addAfterClosed = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final-settlements`, {
      settlementDate: "2026-09-01",
      balanceDomain: "COMMISSION_RECEIVABLE",
      settlementType: "COMMISSION_SETTLEMENT",
      amount: 1000
    });
    assert(addAfterClosed.status === 409, "Adding settlement on CLOSED period returns 409", addAfterClosed.status);

    // -------------------------------------------------------------------------
    console.log("\nScenario 14: Rollover seeds reflect post-settlement values");
    // -------------------------------------------------------------------------
    const rolloverRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/rollover`);
    assert(rolloverRes.status === 200 || rolloverRes.status === 201, "Rollover August to September succeeded", rolloverRes.status);
    const sepPeriod = rolloverRes.body.period;
    assert(sepPeriod.period_key === "2026-09", "Target period is 2026-09", sepPeriod.period_key);

    // Inspect staged September seeds
    const sepSeedsRes = await makeRequest(base, "GET", `/api/v1/periods/${sepPeriod.id}/seeds`);
    assert(sepSeedsRes.status === 200, "Fetched September seeds", sepSeedsRes.status);
    const sepFinancialSeed = sepSeedsRes.body.seeds.financial;
    assert(Number(sepFinancialSeed.opening_cash) === 65000, "September opening cash is 65,000", sepFinancialSeed.opening_cash);
    assert(Number(sepFinancialSeed.opening_commission_receivable) === 0, "September opening commission receivable is 0 (fully settled on FINAL)", sepFinancialSeed.opening_commission_receivable);

    const sepCreditSeeds = sepSeedsRes.body.seeds.creditParties;
    const sepCp1 = sepCreditSeeds.find((cp: any) => cp.party_id === data.creditPartyId);
    assert(!sepCp1 || Number(sepCp1.opening_balance) === 0, "September Credit Party has 0 opening debt (fully settled on FINAL)");

    // -------------------------------------------------------------------------
    console.log("\nScenario 15: September Day 1 receives cash effect without commission income");
    // -------------------------------------------------------------------------
    // Rollover automatically linked commission settlement receipts to September Day 1!
    const receiptsInDb = await sql<{ id: string; amount: string; source_period_key: string }>`
      SELECT id, amount, source_period_key
      FROM commission_settlement_receipts
      WHERE franchise_id = ${data.franchiseId};
    `.execute(db);
    assert(receiptsInDb.rows.length === 2, "Two commission settlement receipts created on September Day 1 (15k + 5k)", receiptsInDb.rows.length);

    // Verify September seeds and activate September Day 1
    const verifySepSeeds = await makeRequest(base, "POST", `/api/v1/periods/${sepPeriod.id}/verify-seeds`);
    assert(verifySepSeeds.status === 200, "Verified September seeds", verifySepSeeds.status);

    // Open/activate September Day 1
    const openSepDay1 = await makeRequest(base, "POST", `/api/v1/periods/${sepPeriod.id}/activate`);
    assert(openSepDay1.status === 200, "Activated September Day 1", openSepDay1.status);
    const sepDay1Id = openSepDay1.body.day1?.id ?? openSepDay1.body.day1Id;

    // Calculate Day 1 projections
    const sepDay1Proj = await makeRequest(base, "GET", `/api/v1/calculations/projections/day/${sepDay1Id}`);
    assert(sepDay1Proj.status === 200, "September Day 1 projection calculated", sepDay1Proj.status);
    const sepDay1Fin = sepDay1Proj.body.data.projections.financial;

    // Cash: Opening 65,000 + 20,000 settlement receipts = 85,000
    assert(Number(sepDay1Fin.closing_cash) === 85000, "September Day 1 closing cash increased by 20,000 settlement receipts to 85,000", sepDay1Fin.closing_cash);
    // Commission income (total_issues) must remain 0!
    assert(Number(sepDay1Fin.total_issues) === 0, "September Day 1 commission income remains 0 (not recognized as revenue)", sepDay1Fin.total_issues);
    // Operating profit must remain 0!
    assert(Number(sepDay1Fin.operating_profit) === 0, "September Day 1 net profit remains 0", sepDay1Fin.operating_profit);

    // -------------------------------------------------------------------------
    console.log("\nScenario 16: Cold reload idempotency and stability");
    // -------------------------------------------------------------------------
    // Re-fetch August FINAL projections
    const reloadFinal = await getPeriodFinalProjections(data.franchiseId, data.augPeriodId);
    assert(Boolean(reloadFinal), "Reloaded FINAL exists");
    const reloadSettledSum = reloadFinal!.finalSettlements.entries.reduce((sum: number, e: any) => sum + Number(e.amount), 0);
    assert(reloadSettledSum === 32000, "Reloaded FINAL totalSettled is identical (32,000)", reloadSettledSum);
    assert(reloadFinal!.finalSettlements.entries.length === 3, "Reloaded FINAL settlement entries count identical (3)", reloadFinal!.finalSettlements.entries.length);

    // Rebuild period idempotency check
    const rebuild = await rebuildPeriod(data.franchiseId, data.augPeriodId, {
      triggerSource: "test_rebuild_scenario_16",
      allowClosedDays: true
    });
    assert(rebuild.daysCalculated === 31, "Rebuilt August period cleanly (31 days)", rebuild.daysCalculated);
    assert(rebuild.violationsCount === 0, "No violations after rebuild", rebuild.violationsCount);

    const postRebuildFinal = await getPeriodFinalProjections(data.franchiseId, data.augPeriodId);
    assert(Boolean(postRebuildFinal), "Post-rebuild FINAL exists");
    const postRebuildSettledSum = postRebuildFinal!.finalSettlements.entries.reduce((sum: number, e: any) => sum + Number(e.amount), 0);
    assert(postRebuildSettledSum === 32000, "Post-rebuild FINAL totalSettled preserved (32,000)", postRebuildSettledSum);
    assert(Number(postRebuildFinal!.closingBalances.financial.closingCash) === 65000, "Post-rebuild closing cash preserved (65,000)", postRebuildFinal!.closingBalances.financial.closingCash);

    console.log("\nALL 16 FINAL SETTLEMENT LAYER SCENARIOS PASSED PERFECTLY!");
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
