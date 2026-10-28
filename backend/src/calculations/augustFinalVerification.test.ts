/**
 * August 2026 Exact Final Verification Scenario & Governance Regression Tests
 *
 * Verifies the exact August 2026 scenario and governance invariants:
 * 1.  August exact scenario:
 *     - Cash: -348,758.00
 *     - Owner: -8,960.00
 *     - Commission earned: 1,004,506.00
 *     - Actual commission receivable: 0.00
 *     - Credit balances: 107,411.00 across customer accounts
 *     - Zero FINAL entries
 *     - Verifies normally without requiring allowOutstanding: true
 *     - totalOutstanding is 0 and allResolved is true
 * 2.  September rollover seeds preserve exact carried-forward balances:
 *     - openingCash = -348,758.00
 *     - openingOwnerBalance = -8,960.00
 *     - openingCommissionReceivable = 0.00
 *     - credit parties sum to 107,411.00
 * 3.  Unclosed Day 31 blocks verification (HTTP 422 PERIOD_NOT_READY)
 * 4.  Critical invariant violation blocks verification (HTTP 422 PERIOD_NOT_READY)
 * 5.  Genuine over-settlement fails (HTTP 422 OVER_SETTLEMENT)
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";

const FRANCHISE_CODE = "TEST-AUG-VERIF";
const OWNER_UID = "test-aug-owner";
const OWNER_EMAIL = "owner@august-verif.test";

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
    DELETE FROM calculation_runs WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM invariant_violations WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM day_financial_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM mutation_idempotency WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM audit_logs WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM commission_settlement_receipts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM final_settlement_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-AUG-VERIF'));
    DELETE FROM franchises WHERE code IN ('TEST-AUG-VERIF');
    DELETE FROM users WHERE firebase_uid IN ('test-aug-owner');
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

interface SetupData {
  franchiseId: string;
  augPeriodId: string;
  ownerUserId: string;
  day31Id: string;
  creditPartyIds: {
    akhtar: string;
    dsoHasan: string;
    usmanCheema: string;
    others: string;
  };
}

async function setupAugustExactScenario(): Promise<SetupData> {
  await cleanupTestData();

  // 1. Franchise
  const f = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES (${FRANCHISE_CODE}, 'August Verification Test Franchise', 'AugBrand')
    RETURNING id;
  `.execute(db);
  const franchiseId = f.rows[0].id;

  // 2. Owner User
  const u = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES (${OWNER_UID}, ${OWNER_EMAIL}, 'August Owner', true)
    RETURNING id;
  `.execute(db);
  const ownerUserId = u.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${ownerUserId}, 'owner');`.execute(db);

  // 3. Catalogs: Commission category
  const commCat = await sql<{ id: string }>`
    INSERT INTO commission_categories (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'aug-comm', 'August Commission', true)
    RETURNING id;
  `.execute(db);

  // 4. Catalogs: Credit Parties with August balances
  // Akhtar: 13,000 | DSO Hasan: 25,000 | Usman Cheema: 27,600 | Others: 41,811 -> Total = 107,411
  const cp1 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'akhtar', 'Akhtar', true)
    RETURNING id;
  `.execute(db);
  const cp2 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'dso-hasan', 'DSO Hasan', true)
    RETURNING id;
  `.execute(db);
  const cp3 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'usman-cheema', 'Usman Cheema', true)
    RETURNING id;
  `.execute(db);
  const cp4 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'others', 'Other Parties', true)
    RETURNING id;
  `.execute(db);

  // 5. Accounting Period August 2026
  const periodRes = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${franchiseId}, '2026-08', 2026, 8, 'August 2026', 'open')
    RETURNING id;
  `.execute(db);
  const augPeriodId = periodRes.rows[0].id;

  // Days 1..31 (all closed)
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

  // Genesis seeds for August: opening_commission_receivable = 0.00
  await sql`
    INSERT INTO period_financial_seeds (
      franchise_id, period_id, opening_cash, opening_owner_balance,
      opening_jazz_lifting, opening_jazz_payable, opening_commission_receivable,
      is_verified, verified_at, verified_by_user_id
    ) VALUES (
      ${franchiseId}, ${augPeriodId}, 100000.00, 0.00, 0.00, 0.00, 0.00,
      true, clock_timestamp(), ${ownerUserId}
    );
  `.execute(db);

  // Credit party genesis seeds
  await sql`
    INSERT INTO period_credit_party_seeds (franchise_id, period_id, party_id, opening_balance) VALUES
      (${franchiseId}, ${augPeriodId}, ${cp1.rows[0].id}, 13000.00),
      (${franchiseId}, ${augPeriodId}, ${cp2.rows[0].id}, 25000.00),
      (${franchiseId}, ${augPeriodId}, ${cp3.rows[0].id}, 27600.00),
      (${franchiseId}, ${augPeriodId}, ${cp4.rows[0].id}, 41811.00);
  `.execute(db);

  // Day 31 financial projection reflecting August exact authoritative state:
  // closing_cash: -348,758.00
  // owner_closing_balance: -8,960.00
  // total_issues: 1,004,506.00 (earned commission)
  // closing_commission_receivable: 0.00 (authoritative receivable balance)
  await sql`
    INSERT INTO day_financial_projections (
      franchise_id, day_id, opening_cash, total_issues, total_expenses,
      closing_cash, operating_profit, owner_opening_balance, owner_closing_balance,
      opening_jazz_payable, closing_jazz_payable, opening_commission_receivable,
      closing_commission_receivable
    ) VALUES (
      ${franchiseId}, ${day31Id}, -300000.00, 1004506.00, 1053264.00,
      -348758.00, -48758.00, 0.00, -8960.00,
      0.00, 0.00, 0.00, 0.00
    );
  `.execute(db);

  // Day 31 credit party projections
  await sql`
    INSERT INTO credit_party_day_projections (
      franchise_id, day_id, party_id, opening_balance, total_loans, total_receipts, manual_adjustments, closing_balance
    ) VALUES
      (${franchiseId}, ${day31Id}, ${cp1.rows[0].id}, 13000.00, 0.00, 0.00, 0.00, 13000.00),
      (${franchiseId}, ${day31Id}, ${cp2.rows[0].id}, 25000.00, 0.00, 0.00, 0.00, 25000.00),
      (${franchiseId}, ${day31Id}, ${cp3.rows[0].id}, 27600.00, 0.00, 0.00, 0.00, 27600.00),
      (${franchiseId}, ${day31Id}, ${cp4.rows[0].id}, 41811.00, 0.00, 0.00, 0.00, 41811.00);
  `.execute(db);

  // Commission items in DB totalling 1,004,506.00
  await sql`
    INSERT INTO commission_items (franchise_id, day_id, category_id, category_name_snapshot, amount)
    VALUES (${franchiseId}, ${day31Id}, ${commCat.rows[0].id}, 'August Total Commission Earned', 1004506.00);
  `.execute(db);

  return {
    franchiseId,
    augPeriodId,
    ownerUserId,
    day31Id,
    creditPartyIds: {
      akhtar: cp1.rows[0].id,
      dsoHasan: cp2.rows[0].id,
      usmanCheema: cp3.rows[0].id,
      others: cp4.rows[0].id
    }
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
          Authorization: "Bearer test-token-aug-owner",
          "Content-Type": "application/json",
          ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {})
        }
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
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
    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function assert(condition: boolean, message: string, actual?: unknown) {
  if (!condition) {
    throw new Error(
      `Assertion Failed: ${message}${actual !== undefined ? ` (Actual: ${JSON.stringify(actual)})` : ""}`
    );
  }
  console.log(`   ✓ ${message}`);
}

// ---------------------------------------------------------------------------
// Main Test Suite
// ---------------------------------------------------------------------------
async function runTests() {
  console.log("=== AUGUST FINAL VERIFICATION & GOVERNANCE TESTS ===");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;

  let data: SetupData;

  try {
    data = await setupAugustExactScenario();

    setTokenVerifierForTesting(async (token: string) => {
      if (token === "test-token-aug-owner") {
        return { uid: OWNER_UID, email: OWNER_EMAIL };
      }
      throw new Error("Invalid test token");
    });

    // -------------------------------------------------------------------------
    console.log("\nScenario 1: August Exact Scenario — FINAL Projections Evaluation");
    // -------------------------------------------------------------------------
    const finalRes = await makeRequest(
      base,
      "GET",
      `/api/v1/calculations/projections/period/${data.augPeriodId}/final`
    );
    assert(finalRes.status === 200, "FINAL endpoint returns HTTP 200 OK", finalRes.status);
    const finalData = finalRes.body.data;

    // Check financial balances
    const fin = finalData.closingBalances.financial;
    assert(Number(fin.closingCash) === -348758, "Authoritative negative cash: -348,758.00", fin.closingCash);
    assert(Number(fin.closingOwnerBalance) === -8960, "Authoritative owner balance: -8,960.00", fin.closingOwnerBalance);

    // Check commission
    const cs = finalData.commissionSettlement;
    assert(Number(cs.totalCommissionEarned) === 1004506, "Commission earned: 1,004,506.00", cs.totalCommissionEarned);
    assert(Number(cs.outstandingCommissionReceivable) === 0, "Actual commission receivable is 0 (not 1,004,506!)", cs.outstandingCommissionReceivable);

    // Check credit parties: total 107,411.00
    const cps = finalData.closingBalances.creditParties;
    const totalCredit = cps.reduce((sum: number, c: any) => sum + Number(c.closingBalance), 0);
    assert(totalCredit === 107411, "Credit parties closing total: 107,411.00", totalCredit);

    // Check finalSettlements layer
    const fse = finalData.finalSettlements;
    assert(fse.entries.length === 0, "Zero FINAL settlement entries in August", fse.entries.length);
    assert(Number(fse.totalOutstanding) === 0, "totalOutstanding is 0 (clean ledger)", fse.totalOutstanding);
    assert(fse.allResolved === true, "allResolved is true (operational balances roll forward)", fse.allResolved);

    // Verify all domain summaries are resolved
    for (const d of fse.domainSummaries) {
      assert(d.isResolved === true, `Domain '${d.balanceDomain}' (${d.label}) is resolved`, d.isResolved);
      assert(d.status === "SETTLED", `Domain '${d.balanceDomain}' status is SETTLED`, d.status);
      if (d.balanceDomain === "COMMISSION_RECEIVABLE" || d.balanceDomain === "CASH_SETTLEMENT") {
        assert(Number(d.remainingOutstanding) === 0, `Domain '${d.balanceDomain}' remainingOutstanding is 0`, d.remainingOutstanding);
      }
    }

    // -------------------------------------------------------------------------
    console.log("\nScenario 2: August Normal Verification (Succeeds Without allowOutstanding)");
    // -------------------------------------------------------------------------
    const verifyRes = await makeRequest(
      base,
      "POST",
      `/api/v1/periods/${data.augPeriodId}/final/verify`,
      {
        allowOutstanding: false,
        notes: "August month-end clean verification"
      }
    );
    assert(verifyRes.status === 200, "Verification succeeds with HTTP 200 (allowOutstanding: false)", verifyRes.status);
    assert(verifyRes.body.status === "VERIFIED", "Period final_settlement_status is VERIFIED", verifyRes.body.status);
    assert(verifyRes.body.verified === true, "Verification flag is true", verifyRes.body.verified);

    // -------------------------------------------------------------------------
    console.log("\nScenario 3: September Rollover Seeds Preserved Unchanged");
    // -------------------------------------------------------------------------
    // Close August formally
    const closeRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/close`);
    assert(closeRes.status === 200, "August closed successfully", closeRes.status);

    // Rollover to September
    const rolloverRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/rollover`);
    assert(rolloverRes.status === 200 || rolloverRes.status === 201, "Rollover August → September succeeded", rolloverRes.status);
    const sepPeriodId = rolloverRes.body.targetPeriod?.id ?? rolloverRes.body.period?.id;

    // Fetch September seeds
    const seedsRes = await makeRequest(base, "GET", `/api/v1/periods/${sepPeriodId}/seeds`);
    assert(seedsRes.status === 200, "Fetched September seeds", seedsRes.status);
    const seeds = seedsRes.body.seeds;

    assert(
      Number(seeds.financial.opening_cash) === -348758,
      "September opening cash seed is -348,758.00 (authoritative carry-forward)",
      seeds.financial.opening_cash
    );
    assert(
      Number(seeds.financial.opening_owner_balance) === -8960,
      "September opening owner balance seed is -8,960.00",
      seeds.financial.opening_owner_balance
    );
    assert(
      Number(seeds.financial.opening_commission_receivable) === 0,
      "September opening commission receivable seed is 0",
      seeds.financial.opening_commission_receivable
    );

    const creditSeedsTotal = seeds.creditParties.reduce((sum: number, c: any) => sum + Number(c.opening_balance), 0);
    assert(
      creditSeedsTotal === 107411,
      "September credit parties seed total is 107,411.00 (exact match)",
      creditSeedsTotal
    );

    // -------------------------------------------------------------------------
    console.log("\nScenario 4: Unclosed Day 31 Blocks Verification (HTTP 422 PERIOD_NOT_READY)");
    // -------------------------------------------------------------------------
    // Set up a second test period to verify negative gating
    const p2Res = await sql<{ id: string }>`
      INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
      VALUES (${data.franchiseId}, '2026-10', 2026, 10, 'October 2026', 'open')
      RETURNING id;
    `.execute(db);
    const octPeriodId = p2Res.rows[0].id;

    // Day 31 is open
    const octDay31 = await sql<{ id: string }>`
      INSERT INTO accounting_days (franchise_id, period_id, day_no, day_type, calendar_date, label, status)
      VALUES (${data.franchiseId}, ${octPeriodId}, 31, 'calendar', '2026-10-31', 'Day 31', 'open')
      RETURNING id;
    `.execute(db);

    const unclosedVerifyRes = await makeRequest(
      base,
      "POST",
      `/api/v1/periods/${octPeriodId}/final/verify`,
      { allowOutstanding: false }
    );
    assert(unclosedVerifyRes.status === 422, "Unclosed Day 31 rejected with HTTP 422", unclosedVerifyRes.status);
    assert(unclosedVerifyRes.body.code === "PERIOD_NOT_READY", "Error code is PERIOD_NOT_READY", unclosedVerifyRes.body.code);
    assert(unclosedVerifyRes.body.message.includes("must be closed first"), "Message notes day must be closed first", unclosedVerifyRes.body.message);

    // -------------------------------------------------------------------------
    console.log("\nScenario 5: Critical Invariant Violation Blocks Verification (HTTP 422 PERIOD_NOT_READY)");
    // -------------------------------------------------------------------------
    // Close Day 31 in October
    await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${octDay31.rows[0].id};`.execute(db);

    // Insert seeds and projections so period is otherwise calculable
    await sql`
      INSERT INTO period_financial_seeds (
        franchise_id, period_id, opening_cash, opening_owner_balance,
        opening_jazz_lifting, opening_jazz_payable, opening_commission_receivable,
        is_verified, verified_at, verified_by_user_id
      ) VALUES (
        ${data.franchiseId}, ${octPeriodId}, 10000, 0, 0, 0, 0,
        true, clock_timestamp(), ${data.ownerUserId}
      );
    `.execute(db);

    await sql`
      INSERT INTO day_financial_projections (
        franchise_id, day_id, opening_cash, total_issues, total_expenses,
        closing_cash, operating_profit, owner_opening_balance, owner_closing_balance,
        opening_jazz_payable, closing_jazz_payable, opening_commission_receivable,
        closing_commission_receivable
      ) VALUES (
        ${data.franchiseId}, ${octDay31.rows[0].id}, 10000, 0, 0,
        10000, 0, 0, 0,
        0, 0, 0, 0
      );
    `.execute(db);

    // Insert critical invariant violation
    const violId = await sql<{ id: string }>`
      INSERT INTO invariant_violations (
        franchise_id, period_id, day_id, invariant_code, severity, message
      ) VALUES (
        ${data.franchiseId}, ${octPeriodId}, ${octDay31.rows[0].id},
        'FIN_CASH_CRITICAL_TEST', 'critical', 'Critical cash imbalance detected in October'
      ) RETURNING id;
    `.execute(db);

    const violVerifyRes = await makeRequest(
      base,
      "POST",
      `/api/v1/periods/${octPeriodId}/final/verify`,
      { allowOutstanding: false }
    );
    assert(violVerifyRes.status === 422, "Critical invariant violation rejected with HTTP 422", violVerifyRes.status);
    assert(violVerifyRes.body.code === "PERIOD_NOT_READY", "Error code is PERIOD_NOT_READY", violVerifyRes.body.code);
    assert(violVerifyRes.body.message.includes("critical invariant violation"), "Message notes critical invariant violation", violVerifyRes.body.message);

    // Clean up violation
    await sql`DELETE FROM invariant_violations WHERE id = ${violId.rows[0].id};`.execute(db);

    // -------------------------------------------------------------------------
    console.log("\nScenario 6: Genuine FINAL Over-Settlement Rejection (HTTP 422 OVER_SETTLEMENT)");
    // -------------------------------------------------------------------------
    // October has 0 commission receivable. Attempting to add 5,000 commission settlement must fail:
    const overCommRes = await makeRequest(
      base,
      "POST",
      `/api/v1/periods/${octPeriodId}/final-settlements`,
      {
        settlementDate: "2026-11-01",
        balanceDomain: "COMMISSION_RECEIVABLE",
        settlementType: "COMMISSION_SETTLEMENT",
        amount: 5000,
        notes: "Attempted commission settlement with 0 receivable"
      }
    );
    assert(overCommRes.status === 422, "Commission over-settlement rejected with HTTP 422", overCommRes.status);
    assert(overCommRes.body.code === "OVER_SETTLEMENT", "Rejection code is OVER_SETTLEMENT", overCommRes.body.code);

    // Over-settlement for credit party:
    const cpOct = await sql<{ id: string }>`
      INSERT INTO credit_parties (franchise_id, slug, name, is_active)
      VALUES (${data.franchiseId}, 'oct-cp', 'Oct Credit Party', true)
      RETURNING id;
    `.execute(db);

    await sql`
      INSERT INTO credit_party_day_projections (
        franchise_id, day_id, party_id, opening_balance, total_loans, total_receipts, manual_adjustments, closing_balance
      ) VALUES
        (${data.franchiseId}, ${octDay31.rows[0].id}, ${cpOct.rows[0].id}, 2000.00, 0.00, 0.00, 0.00, 2000.00);
    `.execute(db);

    // Attempting to settle 5,000 on a 2,000 debt
    const overCpRes = await makeRequest(
      base,
      "POST",
      `/api/v1/periods/${octPeriodId}/final-settlements`,
      {
        settlementDate: "2026-11-01",
        balanceDomain: "CREDIT_PARTY_BALANCE",
        settlementType: "CREDIT_RECOVERY",
        targetEntityId: cpOct.rows[0].id,
        targetEntityName: "Oct Credit Party",
        amount: 5000,
        notes: "Excess credit recovery"
      }
    );
    assert(overCpRes.status === 422, "Credit party over-settlement rejected with HTTP 422", overCpRes.status);
    assert(overCpRes.body.code === "OVER_SETTLEMENT", "Rejection code is OVER_SETTLEMENT", overCpRes.body.code);

    console.log("\nALL AUGUST FINAL VERIFICATION & GOVERNANCE TESTS PASSED PERFECTLY!");
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
