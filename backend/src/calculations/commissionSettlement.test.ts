/**
 * Commission Settlement Timing & Month-End FINAL Integration Tests
 *
 * Validates the revised month-end settlement workflow:
 * August Day 1..31 -> FINAL -> September Day 1 settlement -> Verify -> Close August -> September active
 *
 * Specific requirements verified:
 * 1. Day 31 -> FINAL boundary with commission provenance (earned = 20000, receivable = 20000, PENDING_SETTLEMENT)
 * 2. No Day 32 in accounting_days
 * 3. September staged with opening_commission_receivable = 20000 from FINAL
 * 4. Activation of September blocked while August FINAL is PENDING_SETTLEMENT
 * 5. Premature formal August close blocked while receivable > 0 and unverified
 * 6. September Day 1 receives settlement receipt = 20000 with source_period_key = '2026-08'
 * 7. Decoupled Cash vs Profit: Cash +20000, September commission income remains 0.00, operating profit unaffected
 * 8. Zero double-counting across periods; September's own Day 1 commission earned remains independent
 * 9. Duplicate settlement protection & Idempotency
 * 10. August receivable drops to 0.00, August FINAL transitions PENDING_SETTLEMENT -> SETTLED
 * 11. Owner verification transitions FINAL to VERIFIED (Role-based access enforced)
 * 12. Formal August close transitions to CLOSED; August and FINAL become strictly immutable
 * 13. September Day 1 activates successfully once August is CLOSED
 * 14. Fresh PostgreSQL reload produces authoritative projections without in-memory prior days
 * 15. 100% test data cleanup
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";
import { getPeriodFinalProjections, getPeriodCommissionSummary } from "./service.js";
import { rolloverPeriod, closeAccountingPeriod, activatePeriod, verifyPeriodFinalSeeds, verifyPeriodFinalSettlement } from "../periods/service.js";
import { createCommissionSettlementReceipt } from "../transactions/service.js";

interface SetupData {
  franchiseId: string;
  augPeriodId: string;
  ownerUser: { id: string; email: string };
  adminUser: { id: string; email: string };
  viewerUser: { id: string; email: string };
  creditPartyId: string;
  commissionCatId: string;
  augDays: Array<{ id: string; dayNo: number }>;
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
  `.execute(db);

  await sql`
    DELETE FROM calculation_runs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM invariant_violations WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM day_financial_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM mutation_idempotency WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM audit_logs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1')
    );
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM commission_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM commission_settlement_receipts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM credit_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM owner_transactions WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM jazz_load_lifting_records WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM jazz_load_do_entries WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM expense_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM commission_categories WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-COMM-F1'));
    DELETE FROM franchises WHERE code IN ('TEST-COMM-F1');
    DELETE FROM users WHERE firebase_uid LIKE 'test-comm-%';
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
  `.execute(db);
}

async function setupTestData(): Promise<SetupData> {
  await cleanupTestData();

  // 1. Franchise
  const f = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-COMM-F1', 'Commission Settlement Test Franchise', 'SettlementBrand')
    RETURNING id;
  `.execute(db);
  const franchiseId = f.rows[0].id;

  // 2. Users
  const uOwner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-comm-owner', 'owner@comm.test', 'Comm Owner', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${uOwner.rows[0].id}, 'owner');`.execute(db);

  const uAdmin = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-comm-admin', 'admin@comm.test', 'Comm Admin', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${uAdmin.rows[0].id}, 'admin');`.execute(db);

  const uViewer = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-comm-viewer', 'viewer@comm.test', 'Comm Viewer', true)
    RETURNING id;
  `.execute(db);
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${franchiseId}, ${uViewer.rows[0].id}, 'viewer');`.execute(db);

  // 3. Catalogs
  const cp = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type, is_active)
    VALUES (${franchiseId}, 'test-credit-party', 'Test Credit Party', 'dealer', true)
    RETURNING id;
  `.execute(db);

  const commCat = await sql<{ id: string }>`
    INSERT INTO commission_categories (franchise_id, slug, name, is_active)
    VALUES (${franchiseId}, 'jazz-cash', 'Jazz Cash Commission', true)
    RETURNING id;
  `.execute(db);

  // 4. August 2026 Period with 31 calendar days
  const periodRes = await sql<{ id: string }>`
    INSERT INTO accounting_periods (franchise_id, period_key, year_num, month_num, label, status)
    VALUES (${franchiseId}, '2026-08', 2026, 8, 'August 2026', 'open')
    RETURNING id;
  `.execute(db);
  const augPeriodId = periodRes.rows[0].id;

  const augDays: Array<{ id: string; dayNo: number }> = [];
  for (let d = 1; d <= 31; d++) {
    const dStr = String(d).padStart(2, "0");
    const r = await sql<{ id: string }>`
      INSERT INTO accounting_days (franchise_id, period_id, day_no, day_type, calendar_date, label, status)
      VALUES (${franchiseId}, ${augPeriodId}, ${d}, 'calendar', ${`2026-08-${dStr}`}, ${`Day ${d}`}, 'closed')
      RETURNING id;
    `.execute(db);
    augDays.push({ id: r.rows[0].id, dayNo: d });
  }

  // 5. Genesis Seeds
  await sql`
    INSERT INTO period_financial_seeds (
      franchise_id, period_id, opening_cash, opening_owner_balance, opening_jazz_lifting, opening_jazz_payable,
      opening_commission_receivable, is_verified, verified_at, verified_by_user_id
    ) VALUES (
      ${franchiseId}, ${augPeriodId}, 50000.00, 100000.00, 0.00, 0.00, 20000.00, true, clock_timestamp(), ${uOwner.rows[0].id}
    );
  `.execute(db);

  await sql`
    INSERT INTO day_financial_projections (
      franchise_id, day_id, opening_cash, total_issues, total_expenses,
      closing_cash, operating_profit, owner_opening_balance, owner_closing_balance,
      opening_jazz_payable, closing_jazz_payable, opening_commission_receivable,
      closing_commission_receivable
    ) VALUES (
      ${franchiseId}, ${augDays[29].id}, 50000.00, 0.00, 0.00,
      50000.00, 0.00, 100000.00, 100000.00,
      0.00, 0.00, 20000.00, 20000.00
    );
  `.execute(db);

  return {
    franchiseId,
    augPeriodId,
    ownerUser: { id: uOwner.rows[0].id, email: "owner@comm.test" },
    adminUser: { id: uAdmin.rows[0].id, email: "admin@comm.test" },
    viewerUser: { id: uViewer.rows[0].id, email: "viewer@comm.test" },
    creditPartyId: cp.rows[0].id,
    commissionCatId: commCat.rows[0].id,
    augDays
  };
}

function makeRequest(
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
          Authorization: `Bearer test-token-comm-${authRole}`,
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
  console.log("=== COMMISSION SETTLEMENT & FINAL WORKFLOW INTEGRATION TESTS ===");
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;

  let data: SetupData;

  try {
    data = await setupTestData();

    // Configure token mock
    setTokenVerifierForTesting(async (token: string) => {
      if (token === "test-token-comm-owner") {
        return { uid: "test-comm-owner", email: "owner@comm.test" };
      }
      if (token === "test-token-comm-admin") {
        return { uid: "test-comm-admin", email: "admin@comm.test" };
      }
      if (token === "test-token-comm-viewer") {
        return { uid: "test-comm-viewer", email: "viewer@comm.test" };
      }
      throw new Error("Invalid test token");
    });

    // -------------------------------------------------------------------------
    console.log("\nGroup 1: August Operational Day 31 & Commission Fact Injection");
    // -------------------------------------------------------------------------
    // Reopen Day 31 momentarily to record commission earned = 20,000
    const day31 = data.augDays[30]; // 31st day
    await sql`
      UPDATE accounting_days SET status = 'open' WHERE id = ${day31.id};
    `.execute(db);

    const commPostRes = await makeRequest(base, "POST", "/api/v1/transactions/commissions", "owner", {
      day_id: day31.id,
      category_id: data.commissionCatId,
      amount: 20000.00,
      description: "August earned commission receivable"
    });
    assert(commPostRes.status === 201, "Commission of 20,000 posted to August Day 31", commPostRes.status);

    // Day 31 projections were materialized upon commission creation
    const calcDay31Res = await makeRequest(base, "GET", `/api/v1/calculations/projections/day/${day31.id}`, "owner");
    assert(calcDay31Res.status === 200, "Day 31 projections retrieved successfully", calcDay31Res.status);
    const day31Fin = calcDay31Res.body.data.projections.financial;
    assert(Number(day31Fin.total_issues) === 20000, "Day 31 total issues is 20000", day31Fin.total_issues);

    // Close Day 31
    const closeDay31Res = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/days/31/close`, "owner");
    assert(closeDay31Res.status === 200, "Day 31 closed via period governance endpoint", closeDay31Res.status);

    // -------------------------------------------------------------------------
    console.log("\nGroup 2: FINAL Month-End Boundary & Commission Settlement Exposure");
    // -------------------------------------------------------------------------
    const finalRes = await makeRequest(base, "GET", `/api/v1/calculations/projections/period/${data.augPeriodId}/final`, "owner");
    assert(finalRes.status === 200, "GET /calculations/projections/period/:periodId/final returns 200 OK", finalRes.status);
    const finalData = finalRes.body.data;
    assert(finalData.boundary === "FINAL", "Snapshot boundary strictly marked 'FINAL'", finalData.boundary);
    assert(finalData.finalDay.dayNo === 31, "FINAL source day is Day 31", finalData.finalDay.dayNo);
    
    // Check commission settlement fields in FINAL
    const commSettlement = finalData.closingBalances.commissionSettlement;
    assert(commSettlement !== undefined, "FINAL exposes commissionSettlement block", commSettlement);
    assert(commSettlement.totalCommissionEarned === "20000", "Total commission earned is 20,000", commSettlement.totalCommissionEarned);
    assert(commSettlement.commissionSettledDuringPeriod === "0", "Commission settled during August is 0", commSettlement.commissionSettledDuringPeriod);
    assert(commSettlement.outstandingCommissionReceivable === "20000", "Outstanding commission receivable is 20,000", commSettlement.outstandingCommissionReceivable);
    assert(commSettlement.settlementStatus === "PENDING_SETTLEMENT", "Settlement status is PENDING_SETTLEMENT", commSettlement.settlementStatus);

    // Verify seed bundle carries forward opening commission receivable
    assert(finalData.seedBundle.financial.openingCommissionReceivable === "20000", "Seed bundle openingCommissionReceivable is 20,000", finalData.seedBundle.financial.openingCommissionReceivable);

    // Verify database contains NO Day 32 row
    const day32Check = await sql`
      SELECT count(*) as count FROM accounting_days WHERE period_id = ${data.augPeriodId} AND day_no >= 32;
    `.execute(db);
    assert(Number(day32Check.rows[0].count) === 0, "No Day 32 exists in accounting_days", day32Check.rows[0].count);

    // -------------------------------------------------------------------------
    console.log("\nGroup 3: Governed Period Rollover to September (Staged)");
    // -------------------------------------------------------------------------
    const rolloverRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/rollover`, "owner");
    assert(rolloverRes.status === 200, "Rollover August -> September succeeded", rolloverRes.status);
    assert(rolloverRes.body.sourcePeriodKey === "2026-08", "Source period is 2026-08", rolloverRes.body.sourcePeriodKey);
    assert(rolloverRes.body.targetPeriod.periodKey === "2026-09", "Target period is 2026-09", rolloverRes.body.targetPeriod.periodKey);
    assert(rolloverRes.body.daysCount === 30, "September calendar has 30 days", rolloverRes.body.daysCount);

    const sepPeriodId = rolloverRes.body.targetPeriod.id;

    // Verify seeds staged for September
    const seedsRes = await makeRequest(base, "GET", `/api/v1/periods/${sepPeriodId}/seeds`, "owner");
    assert(seedsRes.status === 200, "GET /seeds returns 200 OK", seedsRes.status);
    assert(Number(seedsRes.body.seeds.financial.opening_commission_receivable) === 20000, "September staged opening_commission_receivable is 20,000", seedsRes.body.seeds.financial.opening_commission_receivable);
    assert(seedsRes.body.seeds.financial.source_period_key === "2026-08", "Provenance source_period_key is 2026-08", seedsRes.body.seeds.financial.source_period_key);
    assert(seedsRes.body.seeds.financial.source_day_no === 31, "Provenance source_day_no is 31", seedsRes.body.seeds.financial.source_day_no);

    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Governance Guardrails (Activation & Closure Gating)");
    // -------------------------------------------------------------------------
    // Verify September seeds first
    const verifySeedsRes = await makeRequest(base, "POST", `/api/v1/periods/${sepPeriodId}/verify-seeds`, "owner");
    assert(verifySeedsRes.status === 200, "September seeds verified by owner", verifySeedsRes.status);

    // Attempt to activate September Day 1 BEFORE August FINAL is verified/closed -> must fail
    const prematureActivateRes = await makeRequest(base, "POST", `/api/v1/periods/${sepPeriodId}/activate`, "owner");
    assert(prematureActivateRes.status === 422, "Activating September Day 1 blocked while August is PENDING_SETTLEMENT (422)", prematureActivateRes.status);

    // Attempt to close August period BEFORE settlement/verification -> must fail
    const prematureCloseRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/close`, "owner");
    assert(prematureCloseRes.status === 422, "Closing August period blocked with outstanding unsettled commission (422)", prematureCloseRes.status);

    // -------------------------------------------------------------------------
    console.log("\nGroup 5: September Day 1 Settlement Receipt & Decoupled Profit/Cash");
    // -------------------------------------------------------------------------
    // Get September Day 1
    const sepDaysRes = await sql<{ id: string; day_no: number }>`
      SELECT id, day_no FROM accounting_days WHERE period_id = ${sepPeriodId} ORDER BY day_no ASC;
    `.execute(db);
    const sepDay1 = sepDaysRes.rows[0];

    // Record settlement receipt of 20,000 for August in September Day 1
    const settlementRes = await makeRequest(base, "POST", "/api/v1/transactions/commission-settlements", "owner", {
      day_id: sepDay1.id,
      source_period_key: "2026-08",
      amount: 20000.00,
      notes: "Settlement of August 2026 commission"
    });
    assert(settlementRes.status === 201, "Commission settlement receipt created (201 Created)", settlementRes.status);
    assert(Number(settlementRes.body.data.amount) === 20000, "Settlement amount is 20000.00", settlementRes.body.data.amount);
    assert(settlementRes.body.data.source_period_key === "2026-08", "Source period key is 2026-08", settlementRes.body.data.source_period_key);

    // Duplicate settlement protection: Attempting to settle another amount for August 2026 must be blocked
    const overSettlementRes = await makeRequest(base, "POST", "/api/v1/transactions/commission-settlements", "owner", {
      day_id: sepDay1.id,
      source_period_key: "2026-08",
      amount: 100.00,
      notes: "Excess settlement attempt"
    });
    assert(overSettlementRes.status === 422, "Over-settlement blocked by duplicate settlement protection (422)", overSettlementRes.status);

    // Check Day 1 projections for September:
    // Cash increased by 20,000, but operating profit is 0.00 (not double counted)
    const sepDay1ProjRes = await makeRequest(base, "GET", `/api/v1/calculations/projections/day/${sepDay1.id}`, "owner");
    assert(sepDay1ProjRes.status === 200, "GET /calculations/projections/day/:dayId returns 200 OK", sepDay1ProjRes.status);
    const fin = sepDay1ProjRes.body.data.projections.financial;
    assert(Number(fin.commission_settlement_receipts) === 20000, "Settlement receipt recorded in Day 1 financial projections", fin.commission_settlement_receipts);
    assert(Number(fin.total_issues) === 0, "September commission income remains 0.00", fin.total_issues);
    assert(Number(fin.operating_profit) === 0, "September operating profit remains 0.00 (settlement is NOT profit)", fin.operating_profit);
    assert(Number(fin.closing_cash) === Number(fin.opening_cash) + 20000, "Closing cash increased by exactly 20,000 (settlement receipt)", fin.closing_cash);
    assert(Number(fin.closing_commission_receivable) === 0, "Closing commission receivable reduced to 0.00", fin.closing_commission_receivable);

    // -------------------------------------------------------------------------
    console.log("\nGroup 6: Separate September Operational Day 1 Commission (Zero Double-Counting)");
    // -------------------------------------------------------------------------
    // Record September's own Day 1 commission earned of 5,000
    // Temporarily open Day 1 to record transaction
    await sql`UPDATE accounting_days SET status = 'open' WHERE id = ${sepDay1.id};`.execute(db);
    const sepCommRes = await makeRequest(base, "POST", "/api/v1/transactions/commissions", "owner", {
      day_id: sepDay1.id,
      category_id: data.commissionCatId,
      amount: 5000.00,
      description: "September Day 1 own commission"
    });
    assert(sepCommRes.status === 201, "September Day 1 own commission of 5,000 posted", sepCommRes.status);
    // Day 1 projections updated automatically upon commission creation
    const recalcRes = await makeRequest(base, "GET", `/api/v1/calculations/projections/day/${sepDay1.id}`, "owner");
    assert(recalcRes.status === 200, "September Day 1 projections retrieved", recalcRes.status);
    const sepFinUpdated = recalcRes.body.data.projections.financial;
    assert(Number(sepFinUpdated.total_issues) === 5000, "September Day 1 total issues is strictly 5,000", sepFinUpdated.total_issues);
    assert(Number(sepFinUpdated.operating_profit) === 5000, "September operating profit is strictly 5,000", sepFinUpdated.operating_profit);
    assert(Number(sepFinUpdated.commission_settlement_receipts) === 20000, "Settlement receipts remain 20,000", sepFinUpdated.commission_settlement_receipts);
    assert(Number(sepFinUpdated.closing_cash) === Number(fin.opening_cash) + 20000 + 5000, "Closing cash is openingCash + 20,000 + 5,000", sepFinUpdated.closing_cash);

    // Keep Day 1 closed until formal August closure and activation in Group 10
    await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${sepDay1.id};`.execute(db);

    // -------------------------------------------------------------------------
    console.log("\nGroup 7: Commission Summary & Reconciliation Reports");
    // -------------------------------------------------------------------------
    const augSummaryRes = await makeRequest(base, "GET", `/api/v1/calculations/projections/period/${data.augPeriodId}/commission-summary`, "owner");
    assert(augSummaryRes.status === 200, "August commission summary returns 200 OK", augSummaryRes.status);
    assert(augSummaryRes.body.data.commissionEarned === "20000", "August commission earned is 20,000", augSummaryRes.body.data.commissionEarned);
    assert(augSummaryRes.body.data.outstandingCommissionReceivable === "0", "August outstanding receivable is 0.00 after September settlement", augSummaryRes.body.data.outstandingCommissionReceivable);
    assert(augSummaryRes.body.data.settlementStatus === "SETTLED", "August settlement status transitioned to SETTLED", augSummaryRes.body.data.settlementStatus);

    const sepSummaryRes = await makeRequest(base, "GET", `/api/v1/calculations/projections/period/${sepPeriodId}/commission-summary`, "owner");
    assert(sepSummaryRes.status === 200, "September commission summary returns 200 OK", sepSummaryRes.status);
    assert(sepSummaryRes.body.data.commissionEarned === "5000", "September commission earned is 5,000", sepSummaryRes.body.data.commissionEarned);
    assert(sepSummaryRes.body.data.priorPeriodSettlementReceived === "20000", "September prior period settlement received is 20,000", sepSummaryRes.body.data.priorPeriodSettlementReceived);

    // -------------------------------------------------------------------------
    console.log("\nGroup 8: Month-End FINAL Verification (Owner Only) & Formal Close");
    // -------------------------------------------------------------------------
    // Viewer/Admin rejected from verification (RBAC)
    const viewerVerifyRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final/verify`, "viewer");
    assert(viewerVerifyRes.status === 403, "Viewer rejected from verifying FINAL (403 Forbidden)", viewerVerifyRes.status);

    const adminVerifyRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final/verify`, "admin");
    assert(adminVerifyRes.status === 403, "Admin rejected from verifying FINAL (403 Forbidden)", adminVerifyRes.status);

    // Owner verifies FINAL
    const ownerVerifyRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/final/verify`, "owner", {
      notes: "August month-end commission fully reconciled and verified"
    });
    if (ownerVerifyRes.status !== 200) {
      console.log("OWNER VERIFY FAILED:", ownerVerifyRes.status, ownerVerifyRes.body);
    }
    assert(ownerVerifyRes.status === 200, "Owner verified August FINAL (200 OK)", ownerVerifyRes.status);
    assert(ownerVerifyRes.body.status === "VERIFIED", "Status is VERIFIED", ownerVerifyRes.body.status);

    // Formal August close
    const augCloseRes = await makeRequest(base, "POST", `/api/v1/periods/${data.augPeriodId}/close`, "owner");
    assert(augCloseRes.status === 200, "August period formally closed (200 OK)", augCloseRes.status);
    assert(augCloseRes.body.status === "closed", "August period status is closed", augCloseRes.body.status);

    // -------------------------------------------------------------------------
    console.log("\nGroup 9: Post-Close Immutability of August & FINAL");
    // -------------------------------------------------------------------------
    // Attempting to post any transaction to August Day 31 fails with 422 DAY_CLOSED
    const postClosedRes = await makeRequest(base, "POST", "/api/v1/transactions/expenses", "owner", {
      day_id: day31.id,
      amount: 100,
      item_name: "Illegal expense after close"
    });
    assert(postClosedRes.status === 422, "API blocks transaction posting on closed Day 31 (422 DAY_CLOSED)", postClosedRes.status);

    // Attempting to mutate settlement receipt on closed day fails via trigger
    const receiptRow = await sql<{ id: string }>`
      SELECT id FROM commission_settlement_receipts WHERE source_period_key = '2026-08' LIMIT 1;
    `.execute(db);
    
    // Close Day 1 of September to test trigger immutability
    await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${sepDay1.id};`.execute(db);
    let triggerBlocked = false;
    try {
      await sql`
        DELETE FROM commission_settlement_receipts WHERE id = ${receiptRow.rows[0].id};
      `.execute(db);
    } catch (err: any) {
      if (err.message.includes("closed accounting day") || err.message.includes("Financial Ledger Violation")) {
        triggerBlocked = true;
      }
    }
    assert(triggerBlocked, "PostgreSQL trigger trg_commission_settlement_receipts_immutability blocked mutation on closed day");

    // -------------------------------------------------------------------------
    console.log("\nGroup 10: September Day 1 Activation Now Authorized");
    // -------------------------------------------------------------------------
    // Now that August is formally closed, September Day 1 activation succeeds!
    const activateSepRes = await makeRequest(base, "POST", `/api/v1/periods/${sepPeriodId}/activate`, "owner");
    assert(activateSepRes.status === 200, "September Day 1 activated successfully (200 OK)", activateSepRes.status);
    assert(activateSepRes.body.activated === true, "September Day 1 is active", activateSepRes.body.activated);
    assert(activateSepRes.body.day1.status === "open", "September Day 1 status is open", activateSepRes.body.day1.status);

    // -------------------------------------------------------------------------
    console.log("\nGroup 11: Fresh Cold Reload from PostgreSQL");
    // -------------------------------------------------------------------------
    const coldDay1Res = await makeRequest(base, "GET", `/api/v1/calculations/projections/day/${sepDay1.id}`, "owner");
    assert(coldDay1Res.status === 200, "Cold reload of September Day 1 returns 200 OK", coldDay1Res.status);
    const coldFin = coldDay1Res.body.data.projections.financial;
    assert(Number(coldFin.commission_settlement_receipts) === 20000, "Cold reload preserves settlement receipts 20,000", coldFin.commission_settlement_receipts);
    assert(Number(coldFin.total_issues) === 5000, "Cold reload preserves Day 1 commission earned 5,000", coldFin.total_issues);
    assert(Number(coldFin.operating_profit) === 5000, "Cold reload operating profit is 5,000", coldFin.operating_profit);

    // -------------------------------------------------------------------------
    console.log("\nGroup 12: 100% Database Cleanup");
    // -------------------------------------------------------------------------
    await cleanupTestData();

    const remainingPeriods = await sql<{ count: string }>`
      SELECT count(*) as count FROM accounting_periods WHERE franchise_id = ${data.franchiseId};
    `.execute(db);
    assert(Number(remainingPeriods.rows[0].count) === 0, "Zero test periods remain in database", remainingPeriods.rows[0].count);

    const remainingReceipts = await sql<{ count: string }>`
      SELECT count(*) as count FROM commission_settlement_receipts WHERE franchise_id = ${data.franchiseId};
    `.execute(db);
    assert(Number(remainingReceipts.rows[0].count) === 0, "Zero test settlement receipts remain in database", remainingReceipts.rows[0].count);

    console.log("\n=== ALL COMMISSION SETTLEMENT & FINAL TESTS PASSED SUCCESSFULLY ===");
  } finally {
    server.close();
    await closeDatabase();
  }
}

runTests().catch((err) => {
  console.error("\n❌ Test execution failed:", err);
  process.exit(1);
});
