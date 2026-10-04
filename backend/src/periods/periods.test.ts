/**
 * Phase 7B: Period Initialization & Opening Seed Governance Integration Tests
 *
 * Exhaustively validates:
 * 1. Test 1 — Period initialization:
 *    - 30 calendar days for September 2026
 *    - Dates 2026-09-01 through 2026-09-30
 *    - All day_type = 'calendar'
 *    - All initially status = 'closed'
 *    - No Day 31
 * 2. Test 2 — Idempotent & Concurrent Initialization:
 *    - Re-initialization returns existing period (200 OK)
 *    - Concurrent requests resolve safely without duplicates
 * 3. Test 3 — Seed Bundle Staging:
 *    - Synthetic August 31 closing snapshot persisted across all 5 seed domains
 *    - Provenance metadata (source_period_key = '2026-08', source_day_no = 31)
 *    - Staging resets is_verified = false
 * 4. Test 4 — Multi-Tenant Isolation:
 *    - Cross-tenant period reads, seed reads, seed writes, activations rejected
 *    - Seed bundle referencing foreign catalog entities rejected
 * 5. Test 5 — Missing Financial Seed Hard Failure:
 *    - Day 1 calculation without period_financial_seeds throws INV_MISSING_FINANCIAL_SEEDS
 *    - Aborts calculation, zero false-zero projections written
 * 6. Test 6 — Catalog Completeness Validation:
 *    - Missing active stock product, account, or DO profile seed fails validation (422)
 * 7. Test 7 — Explicit Zero Opening Balances:
 *    - Explicit 0.00 / 0 quantities are valid and not treated as missing
 * 8. Test 8 — Seed Verification Operation (Owner Only):
 *    - Runs validation, computes Day 1 baseline, sets is_verified = true
 *    - Records verifying user and verified_at timestamp
 * 9. Test 9 — Verification Failure:
 *    - Invalid/missing seed blocks verification and leaves is_verified = false
 * 10. Test 10 — Day 1 Activation Operation:
 *     - Only verified seeds permit activation
 *     - Day 1 transitions to 'open'; Days 2..30 strictly remain 'closed'
 * 11. Test 11 — Activation Rejection:
 *     - Unverified seeds block activation (422 SEEDS_NOT_VERIFIED)
 * 12. Test 12 — Seed Mutation Invalidates Verification:
 *     - Modifying verified seeds returns is_verified to false and blocks activation
 * 13. Test 13 — Zero-Transaction Baseline Proved:
 *     - Day 1 opening equals August 31 closing snapshot
 *     - Day 1 closing equals Day 1 opening across all domains (issues = 0, expenses = 0, profit = 0)
 * 14. Test 14 — Governance Audit Logging:
 *     - All lifecycle actions logged (period creation, seed staging, verification, activation)
 * 15. Test 15 — Closed-Day Safety:
 *     - Posting to closed days blocked by database trigger trg_block_closed_day_mutation
 * 16. Test 16 — Role-Based Access Control:
 *     - Viewer read-only, Admin can stage/validate, Owner-only for init/verify/activate
 * 17. 100% Database Cleanup.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "../auth/firebaseAdmin.js";
import { sql } from "kysely";
import { recalculateFromDayInternal } from "../calculations/engine.js";

interface SetupData {
  f1Id: string;
  f2Id: string;
  ownerId: string;
  adminId: string;
  viewerId: string;
  f2OwnerId: string;
  prod1Id: string;
  prod2Id: string;
  f2ProdId: string;
  acct1Id: string;
  do1Id: string;
  party1Id: string;
  rateId: string;
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
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM invariant_violations WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM day_financial_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM credit_party_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM stock_product_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM stock_account_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM jazz_lifting_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM jazz_load_do_day_projections WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM mutation_idempotency WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM audit_logs WHERE franchise_id IN (
      SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2')
    );
    DELETE FROM expense_items WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM period_financial_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM period_credit_party_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM period_stock_product_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM period_stock_account_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM period_jazz_do_seeds WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM credit_parties WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM jazz_load_rates WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM jazz_load_do_profiles WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM stock_products WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM stock_accounts WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM accounting_days WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM accounting_periods WHERE franchise_id IN (SELECT id FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2'));
    DELETE FROM franchises WHERE code IN ('TEST-PERIOD-F1', 'TEST-PERIOD-F2');
    DELETE FROM users WHERE firebase_uid LIKE 'test-period-%';
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

  // 1. Franchises
  const f1 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-PERIOD-F1', 'Period Test Franchise 1', 'Brand 1')
    RETURNING id;
  `.execute(db);
  const f1Id = f1.rows[0].id;

  const f2 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-PERIOD-F2', 'Period Test Franchise 2', 'Brand 2')
    RETURNING id;
  `.execute(db);
  const f2Id = f2.rows[0].id;

  // 2. Users
  const uOwner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-period-owner', 'owner@period.test', 'Period Owner', true)
    RETURNING id;
  `.execute(db);
  const ownerId = uOwner.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${ownerId}, 'owner');`.execute(db);

  const uAdmin = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-period-admin', 'admin@period.test', 'Period Admin', true)
    RETURNING id;
  `.execute(db);
  const adminId = uAdmin.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${adminId}, 'admin');`.execute(db);

  const uViewer = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-period-viewer', 'viewer@period.test', 'Period Viewer', true)
    RETURNING id;
  `.execute(db);
  const viewerId = uViewer.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f1Id}, ${viewerId}, 'viewer');`.execute(db);

  const uF2Owner = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-period-f2owner', 'f2owner@period.test', 'F2 Owner', true)
    RETURNING id;
  `.execute(db);
  const f2OwnerId = uF2Owner.rows[0].id;
  await sql`INSERT INTO franchise_users (franchise_id, user_id, role) VALUES (${f2Id}, ${f2OwnerId}, 'owner');`.execute(db);

  // 3. Catalogs for F1
  const p1 = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate, is_active)
    VALUES (${f1Id}, 'period-sim-1', 'SIM Card 4G', 100.00, true)
    RETURNING id;
  `.execute(db);
  const prod1Id = p1.rows[0].id;

  const p2 = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate, is_active)
    VALUES (${f1Id}, 'period-sim-2', 'SIM Card 5G', 200.00, true)
    RETURNING id;
  `.execute(db);
  const prod2Id = p2.rows[0].id;

  const f2Prod = await sql<{ id: string }>`
    INSERT INTO stock_products (franchise_id, slug, name, rate, is_active)
    VALUES (${f2Id}, 'period-f2-sim', 'F2 Foreign SIM', 100.00, true)
    RETURNING id;
  `.execute(db);
  const f2ProdId = f2Prod.rows[0].id;

  const acct1 = await sql<{ id: string }>`
    INSERT INTO stock_accounts (franchise_id, slug, name, type, is_active)
    VALUES (${f1Id}, 'period-ccr-1', 'Main Dealer CCR', 'CCR', true)
    RETURNING id;
  `.execute(db);
  const acct1Id = acct1.rows[0].id;

  const do1 = await sql<{ id: string }>`
    INSERT INTO jazz_load_do_profiles (franchise_id, do_name, do_line, is_active)
    VALUES (${f1Id}, 'Alpha DO 7301', 'Line A', true)
    RETURNING id;
  `.execute(db);
  const do1Id = do1.rows[0].id;

  const rate1 = await sql<{ id: string }>`
    INSERT INTO jazz_load_rates (franchise_id, ml_rate, is_active, effective_from)
    VALUES (${f1Id}, 2.5000, true, '2026-01-01T00:00:00Z')
    RETURNING id;
  `.execute(db);
  const rateId = rate1.rows[0].id;

  const party1 = await sql<{ id: string }>`
    INSERT INTO credit_parties (franchise_id, slug, name, type, is_active)
    VALUES (${f1Id}, 'period-party-1', 'Retailer Tariq', 'dealer', true)
    RETURNING id;
  `.execute(db);
  const party1Id = party1.rows[0].id;

  return {
    f1Id,
    f2Id,
    ownerId,
    adminId,
    viewerId,
    f2OwnerId,
    prod1Id,
    prod2Id,
    f2ProdId,
    acct1Id,
    do1Id,
    party1Id,
    rateId
  };
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

async function req(
  baseUrl: string,
  method: Method,
  path: string,
  token: string | null,
  body?: unknown
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  };
  const res = await fetch(`${baseUrl}${path}`, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function formatDate(val: unknown): string {
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(val).split("T")[0];
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

async function runPeriodTests() {
  console.log("=== STARTING PHASE 7B PERIOD & OPENING SEED INTEGRATION TESTS ===\n");

  const data = await setupTestData();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  setTokenVerifierForTesting(async (token: string) => {
    if (token === "period-owner") return { uid: "test-period-owner", email: "owner@period.test" };
    if (token === "period-admin") return { uid: "test-period-admin", email: "admin@period.test" };
    if (token === "period-viewer") return { uid: "test-period-viewer", email: "viewer@period.test" };
    if (token === "period-f2owner") return { uid: "test-period-f2owner", email: "f2owner@period.test" };
    throw new Error("INVALID_TOKEN");
  });

  try {
    let f1PeriodId = "";

    // -------------------------------------------------------------------------
    // 1. Test 1 — Period Initialization API & Day Provisioning
    // -------------------------------------------------------------------------
    console.log("Group 1: Period Initialization & Day Provisioning");
    {
      const initRes = await req(base, "POST", "/api/v1/periods/initialize", "period-owner", {
        periodKey: "2026-09"
      });

      assert(initRes.status === 201, "Period initialization returns 201 Created", initRes);
      assert(initRes.body.created === true, "created flag is true");
      assert(initRes.body.daysCount === 30, "daysCount is exactly 30");

      f1PeriodId = initRes.body.period.id;
      assert(Boolean(f1PeriodId), "Created period ID returned");
      assert(initRes.body.period.period_key === "2026-09", "period_key is 2026-09");
      assert(initRes.body.period.year_num === 2026, "year_num is 2026");
      assert(initRes.body.period.month_num === 9, "month_num is 9");
      assert(initRes.body.period.label === "September 2026", "label is September 2026");
      assert(initRes.body.period.status === "open", "period status is open");

      // Verify all 30 days in database
      const days = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .orderBy("day_no", "asc")
        .execute();

      assert(days.length === 30, "Exactly 30 day records created in DB");
      assert(days[0].day_no === 1, "First day is Day 1");
      assert(formatDate(days[0].calendar_date) === "2026-09-01", "Day 1 date is 2026-09-01");
      assert(days[0].day_type === "calendar", "Day 1 type is calendar");
      assert(days[0].status === "closed", "Day 1 status is initially closed");

      assert(days[29].day_no === 30, "Last day is Day 30");
      assert(formatDate(days[29].calendar_date) === "2026-09-30", "Day 30 date is 2026-09-30");
      assert(days[29].status === "closed", "Day 30 status is initially closed");

      const hasDay31 = days.some((d) => d.day_no === 31);
      assert(!hasDay31, "No settlement Day 31 provisioned during initialization");
    }

    // -------------------------------------------------------------------------
    // 2. Test 2 — Idempotent and Concurrent Initialization
    // -------------------------------------------------------------------------
    console.log("\nGroup 2: Idempotent and Concurrent Initialization");
    {
      // Serial re-initialization
      const retryRes = await req(base, "POST", "/api/v1/periods/initialize", "period-owner", {
        periodKey: "2026-09"
      });
      assert(retryRes.status === 200, "Re-initialization returns 200 OK (idempotent)");
      assert(retryRes.body.created === false, "created is false on retry");
      assert(retryRes.body.period.id === f1PeriodId, "Returns identical period ID");

      // Concurrent race condition test for F2
      const [conc1, conc2] = await Promise.all([
        req(base, "POST", "/api/v1/periods/initialize", "period-f2owner", { periodKey: "2026-09" }),
        req(base, "POST", "/api/v1/periods/initialize", "period-f2owner", { periodKey: "2026-09" })
      ]);

      assert(conc1.status === 201 || conc1.status === 200, "Concurrent Request 1 succeeded");
      assert(conc2.status === 201 || conc2.status === 200, "Concurrent Request 2 succeeded");
      assert(conc1.body.period.id === conc2.body.period.id, "Both concurrent requests returned identical period ID");

      const f2Periods = await db
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", data.f2Id)
        .where("period_key", "=", "2026-09")
        .execute();
      assert(f2Periods.length === 1, "Exactly one period row exists for F2 after concurrent race");
    }

    // -------------------------------------------------------------------------
    // 3. Test 3 — Opening Seed Bundle Staging & Ingestion
    // -------------------------------------------------------------------------
    console.log("\nGroup 3: Opening Seed Bundle Staging");
    {
      const syntheticBundle = {
        financial: {
          openingCash: "15000.00",
          openingOwnerBalance: "6500.00",
          openingJazzLifting: "30000.00",
          openingJazzPayable: "12000.00",
          sourcePeriodKey: "2026-08",
          sourceDayNo: 31,
          notes: "Synthetic August 31 closing snapshot for testing"
        },
        creditParties: [
          { partyId: data.party1Id, openingBalance: "4000.00" }
        ],
        stockProducts: [
          { productId: data.prod1Id, openingQuantity: 80 }
          // intentionally omitting prod2Id for catalog completeness test next
        ],
        stockAccounts: [
          { accountId: data.acct1Id, openingReceivable: "3500.00" }
        ],
        jazzDoProfiles: [
          { doProfileId: data.do1Id, openingBaseBalance: "5000.00" }
        ]
      };

      const stageRes = await req(base, "PUT", `/api/v1/periods/${f1PeriodId}/seeds`, "period-admin", syntheticBundle);
      assert(stageRes.status === 200, "Admin can stage opening seeds (200 OK)", stageRes);
      assert(stageRes.body.isVerified === false, "isVerified is false during staging");

      // Verify direct database persistence
      const finDb = await db
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .executeTakeFirstOrThrow();

      assert(Number(finDb.opening_cash) === 15000.00, "DB opening_cash is 15000.00");
      assert(Number(finDb.opening_owner_balance) === 6500.00, "DB opening_owner_balance is 6500.00");
      assert(Number(finDb.opening_jazz_lifting) === 30000.00, "DB opening_jazz_lifting is 30000.00");
      assert(Number(finDb.opening_jazz_payable) === 12000.00, "DB opening_jazz_payable is 12000.00");
      assert(finDb.source_period_key === "2026-08", "source_period_key is 2026-08");
      assert(finDb.source_day_no === 31, "source_day_no is 31");
      assert(finDb.is_verified === false, "is_verified in DB is false");
    }

    // -------------------------------------------------------------------------
    // 4. Test 4 — Multi-Tenant Isolation
    // -------------------------------------------------------------------------
    console.log("\nGroup 4: Multi-Tenant Isolation");
    {
      const f2Read = await req(base, "GET", `/api/v1/periods/${f1PeriodId}`, "period-f2owner");
      assert(f2Read.status === 404, "Foreign tenant period read returns 404");

      const f2SeedRead = await req(base, "GET", `/api/v1/periods/${f1PeriodId}/seeds`, "period-f2owner");
      assert(f2SeedRead.status === 404, "Foreign tenant seed read returns 404");

      const f2SeedWrite = await req(base, "PUT", `/api/v1/periods/${f1PeriodId}/seeds`, "period-f2owner", {
        financial: { openingCash: "100.00" }
      });
      assert(f2SeedWrite.status === 404, "Foreign tenant seed write returns 404");

      // Cross-tenant catalog injection: F1 tries to use F2 product
      const crossCatalogRes = await req(base, "PUT", `/api/v1/periods/${f1PeriodId}/seeds`, "period-admin", {
        financial: { openingCash: "15000.00" },
        stockProducts: [{ productId: data.f2ProdId, openingQuantity: 10 }]
      });
      assert(crossCatalogRes.status === 403 || crossCatalogRes.status === 422, "Cross-tenant catalog reference rejected");
      assert(
        crossCatalogRes.body.error === "INV_TENANT_ISOLATION" || crossCatalogRes.body.error === "INVALID_CATALOG_REFERENCE",
        "Error indicates tenant isolation breach"
      );
    }

    // -------------------------------------------------------------------------
    // 5. Test 5 — Missing Financial Seed Hard Failure
    // -------------------------------------------------------------------------
    console.log("\nGroup 5: Missing Financial Seed Hard Failure");
    {
      // F2 has initialized period but zero seeds
      const f2Period = await db
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", data.f2Id)
        .where("period_key", "=", "2026-09")
        .executeTakeFirstOrThrow();

      const f2Day1 = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.f2Id)
        .where("period_id", "=", f2Period.id)
        .where("day_no", "=", 1)
        .executeTakeFirstOrThrow();

      let hardErrorThrown = false;
      let errorCode = "";
      try {
        await db.transaction().execute(async (trx) => {
          await recalculateFromDayInternal(trx, data.f2Id, f2Day1.id, {
            triggerSource: "test",
            allowClosedDays: true
          });
        });
      } catch (err: any) {
        hardErrorThrown = true;
        errorCode = err.code ?? "";
      }

      assert(hardErrorThrown, "Calculation aborted without financial seeds");
      assert(errorCode === "INV_MISSING_FINANCIAL_SEEDS", "Invariant code is INV_MISSING_FINANCIAL_SEEDS");

      const f2Projs = await db
        .selectFrom("day_financial_projections")
        .selectAll()
        .where("franchise_id", "=", data.f2Id)
        .execute();
      assert(f2Projs.length === 0, "Zero partial projections written on invariant failure");
    }

    // -------------------------------------------------------------------------
    // 6. Test 6 — Catalog Completeness Validation
    // -------------------------------------------------------------------------
    console.log("\nGroup 6: Catalog Completeness Validation");
    {
      // F1 currently has prod2Id missing from staged seeds
      const valRes = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/validate-seeds`, "period-admin");
      assert(valRes.status === 422, "Incomplete seeds return 422 SEED_VALIDATION_FAILED", valRes);
      assert(valRes.body.isValid === false, "isValid is false");
      const hasProd2Error = valRes.body.errors.some((e: string) => e.includes("SIM Card 5G"));
      assert(hasProd2Error, "Validation flags missing active stock product 'SIM Card 5G'");
    }

    // -------------------------------------------------------------------------
    // 7. Test 7 — Explicit Zero Opening Balances
    // -------------------------------------------------------------------------
    console.log("\nGroup 7: Explicit Zero Opening Balances");
    {
      // Now supply complete catalog with explicit zeros
      const completeBundle = {
        financial: {
          openingCash: "15000.00",
          openingOwnerBalance: "6500.00",
          openingJazzLifting: "30000.00",
          openingJazzPayable: "12000.00",
          sourcePeriodKey: "2026-08",
          sourceDayNo: 31
        },
        creditParties: [
          { partyId: data.party1Id, openingBalance: "4000.00" }
        ],
        stockProducts: [
          { productId: data.prod1Id, openingQuantity: 80 },
          { productId: data.prod2Id, openingQuantity: 0 } // Explicit 0 units!
        ],
        stockAccounts: [
          { accountId: data.acct1Id, openingReceivable: "3500.00" }
        ],
        jazzDoProfiles: [
          { doProfileId: data.do1Id, openingBaseBalance: "5000.00" }
        ]
      };

      await req(base, "PUT", `/api/v1/periods/${f1PeriodId}/seeds`, "period-admin", completeBundle);

      const valRes2 = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/validate-seeds`, "period-admin");
      assert(valRes2.status === 200, "Complete bundle with explicit 0 returns 200 OK", valRes2);
      assert(valRes2.body.isValid === true, "isValid is true");
      assert(valRes2.body.errors.length === 0, "errors list is empty");
    }

    // -------------------------------------------------------------------------
    // 8. Test 8 — Seed Verification (Owner Only) & Day 1 Baseline
    // -------------------------------------------------------------------------
    console.log("\nGroup 8: Seed Verification & Day 1 Baseline");
    {
      // Non-owner cannot verify
      const adminVerify = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/verify-seeds`, "period-admin");
      assert(adminVerify.status === 403, "Admin cannot verify seeds (403 Forbidden)");

      // Owner verifies
      const verifyRes = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/verify-seeds`, "period-owner");
      assert(verifyRes.status === 200, "Owner can verify seeds (200 OK)", verifyRes);
      assert(verifyRes.body.verified === true, "verified is true");
      assert(Boolean(verifyRes.body.verifiedAt), "verifiedAt timestamp is set");

      // Verify DB flags
      const finSeed = await db
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .executeTakeFirstOrThrow();

      assert(finSeed.is_verified === true, "DB is_verified is true");
      assert(finSeed.verified_by_user_id === data.ownerId, "DB verified_by_user_id is owner ID");
      assert(Boolean(finSeed.verified_at), "DB verified_at is populated");
    }

    // -------------------------------------------------------------------------
    // 9. Test 9 — Verification Failure on Invalid Bundle
    // -------------------------------------------------------------------------
    console.log("\nGroup 9: Verification Failure on Invalid Bundle");
    {
      // F2 has no seeds staged yet
      const f2Period = await db
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", data.f2Id)
        .executeTakeFirstOrThrow();

      const f2VerifyRes = await req(base, "POST", `/api/v1/periods/${f2Period.id}/verify-seeds`, "period-f2owner");
      assert(f2VerifyRes.status === 422, "Verification fails when seeds are missing (422 SEED_VALIDATION_FAILED)");
      assert(f2VerifyRes.body.error === "SEED_VALIDATION_FAILED", "Error code is SEED_VALIDATION_FAILED");
    }

    // -------------------------------------------------------------------------
    // 10. Test 10 — Day 1 Activation Operation
    // -------------------------------------------------------------------------
    console.log("\nGroup 10: Day 1 Activation Operation");
    {
      // Viewer cannot activate
      const viewerAct = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/activate`, "period-viewer");
      assert(viewerAct.status === 403, "Viewer cannot activate period (403 Forbidden)");

      // Owner activates
      const actRes = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/activate`, "period-owner");
      assert(actRes.status === 200, "Owner can activate period (200 OK)", actRes);
      assert(actRes.body.activated === true, "activated is true");
      assert(actRes.body.day1.status === "open", "Day 1 status is open");

      // Verify in DB that Day 1 is OPEN and Days 2..30 remain CLOSED
      const days = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .orderBy("day_no", "asc")
        .execute();

      assert(days[0].status === "open", "Day 1 status in DB is open");
      for (let i = 1; i < 30; i++) {
        if (days[i].status !== "closed") {
          assert(false, `Day ${days[i].day_no} status is unexpectedly ${days[i].status}`);
        }
      }
      assert(true, "Days 2 through 30 strictly remain CLOSED");
    }

    // -------------------------------------------------------------------------
    // 11. Test 11 — Activation Rejection on Unverified Seeds
    // -------------------------------------------------------------------------
    console.log("\nGroup 11: Activation Rejection on Unverified Seeds");
    {
      const f2Period = await db
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", data.f2Id)
        .executeTakeFirstOrThrow();

      const f2ActRes = await req(base, "POST", `/api/v1/periods/${f2Period.id}/activate`, "period-f2owner");
      assert(f2ActRes.status === 422, "Activation rejected when seeds not verified");
      assert(
        f2ActRes.body.error === "SEEDS_NOT_VERIFIED" || f2ActRes.body.error === "MISSING_FINANCIAL_SEED",
        "Rejection error matches unverified/missing seeds"
      );
    }

    // -------------------------------------------------------------------------
    // 12. Test 12 — Seed Mutation Invalidates Verification
    // -------------------------------------------------------------------------
    console.log("\nGroup 12: Seed Mutation Invalidates Verification");
    {
      // Create a fresh period 2026-10 to test pre-activation invalidation
      const octInit = await req(base, "POST", "/api/v1/periods/initialize", "period-owner", {
        periodKey: "2026-10"
      });
      const octPeriodId = octInit.body.period.id;

      const octBundle = {
        financial: {
          openingCash: "5000.00",
          openingOwnerBalance: "2000.00",
          openingJazzLifting: "10000.00",
          openingJazzPayable: "5000.00",
          sourcePeriodKey: "2026-09",
          sourceDayNo: 30
        },
        creditParties: [{ partyId: data.party1Id, openingBalance: "1000.00" }],
        stockProducts: [
          { productId: data.prod1Id, openingQuantity: 20 },
          { productId: data.prod2Id, openingQuantity: 10 }
        ],
        stockAccounts: [{ accountId: data.acct1Id, openingReceivable: "1500.00" }],
        jazzDoProfiles: [{ doProfileId: data.do1Id, openingBaseBalance: "2500.00" }]
      };

      // Stage and verify October
      await req(base, "PUT", `/api/v1/periods/${octPeriodId}/seeds`, "period-admin", octBundle);
      const vOct = await req(base, "POST", `/api/v1/periods/${octPeriodId}/verify-seeds`, "period-owner");
      assert(vOct.status === 200, "October seeds verified");

      // Verify it was marked true
      let finCheck = await db
        .selectFrom("period_financial_seeds")
        .select(["is_verified"])
        .where("period_id", "=", octPeriodId)
        .executeTakeFirstOrThrow();
      assert(finCheck.is_verified === true, "October is_verified is true");

      // Modify seed before activation
      const modRes = await req(base, "PUT", `/api/v1/periods/${octPeriodId}/seeds`, "period-admin", {
        ...octBundle,
        financial: { ...octBundle.financial, openingCash: "5500.00" }
      });
      assert(modRes.status === 200, "Seed update succeeded");

      // Assert is_verified reset to false
      finCheck = await db
        .selectFrom("period_financial_seeds")
        .select(["is_verified"])
        .where("period_id", "=", octPeriodId)
        .executeTakeFirstOrThrow();
      assert(finCheck.is_verified === false, "is_verified was reset to false upon seed modification");

      // Activation now blocked!
      const blockedAct = await req(base, "POST", `/api/v1/periods/${octPeriodId}/activate`, "period-owner");
      assert(blockedAct.status === 422, "Activation blocked after seed modification");
      assert(blockedAct.body.error === "SEEDS_NOT_VERIFIED", "Error is SEEDS_NOT_VERIFIED");
    }

    // -------------------------------------------------------------------------
    // 13. Test 13 — Zero-Transaction Day 1 Baseline Math Proved
    // -------------------------------------------------------------------------
    console.log("\nGroup 13: Zero-Transaction Day 1 Baseline Math Proved");
    {
      const day1 = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .where("day_no", "=", 1)
        .executeTakeFirstOrThrow();

      // Projections for Day 1
      const finProj = await db
        .selectFrom("day_financial_projections")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("day_id", "=", day1.id)
        .executeTakeFirstOrThrow();

      assert(Number(finProj.opening_cash) === 15000.00, "Day 1 opening cash is 15000.00");
      assert(Number(finProj.total_issues) === 0.00, "Day 1 total issues is 0.00");
      assert(Number(finProj.total_expenses) === 0.00, "Day 1 total expenses is 0.00");
      assert(Number(finProj.closing_cash) === 15000.00, "Day 1 closing cash matches opening cash (15000.00)");
      assert(Number(finProj.operating_profit) === 0.00, "Day 1 operating profit is 0.00");
      assert(Number(finProj.owner_opening_balance) === 6500.00, "Owner opening balance is 6500.00");
      assert(Number(finProj.owner_closing_balance) === 6500.00, "Owner closing balance matches opening (6500.00)");
      assert(Number(finProj.opening_jazz_payable) === 12000.00, "Opening Jazz payable is 12000.00");
      assert(Number(finProj.closing_jazz_payable) === 12000.00, "Closing Jazz payable matches opening (12000.00)");

      // Jazz Lifting
      const liftProj = await db
        .selectFrom("jazz_lifting_day_projections")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("day_id", "=", day1.id)
        .executeTakeFirstOrThrow();
      assert(Number(liftProj.opening_lifting) === 30000.00, "Opening lifting is 30000.00");
      assert(Number(liftProj.closing_lifting_in_hand) === 30000.00, "Closing lifting matches opening (30000.00)");

      // Jazz DO
      const doProj = await db
        .selectFrom("jazz_load_do_day_projections")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("day_id", "=", day1.id)
        .executeTakeFirstOrThrow();
      assert(Number(doProj.opening_base) === 5000.00, "DO opening base is 5000.00");
      assert(Number(doProj.closing_base) === 5000.00, "DO closing base matches opening (5000.00)");
      assert(Number(doProj.opening_ml) === 5125.00, "DO opening ML is 5125.00 (5000 * 1.025)");
      assert(Number(doProj.closing_ml) === 5125.00, "DO closing ML matches opening (5125.00)");

      // Credit Party
      const cpProj = await db
        .selectFrom("credit_party_day_projections")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("day_id", "=", day1.id)
        .executeTakeFirstOrThrow();
      assert(Number(cpProj.opening_balance) === 4000.00, "Credit party opening is 4000.00");
      assert(Number(cpProj.closing_balance) === 4000.00, "Credit party closing matches opening (4000.00)");

      // Stock Products
      const spProjs = await db
        .selectFrom("stock_product_day_projections")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("day_id", "=", day1.id)
        .execute();
      const p1Proj = spProjs.find((p) => p.product_id === data.prod1Id);
      const p2Proj = spProjs.find((p) => p.product_id === data.prod2Id);
      assert(p1Proj?.opening_qty === 80, "Prod 1 opening qty is 80");
      assert(p1Proj?.closing_qty === 80, "Prod 1 closing qty matches opening (80)");
      assert(p2Proj?.opening_qty === 0, "Prod 2 opening qty is 0");
      assert(p2Proj?.closing_qty === 0, "Prod 2 closing qty matches opening (0)");

      // Stock Accounts
      const saProj = await db
        .selectFrom("stock_account_day_projections")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("day_id", "=", day1.id)
        .executeTakeFirstOrThrow();
      assert(Number(saProj.opening_due) === 3500.00, "Stock account opening due is 3500.00");
      assert(Number(saProj.closing_due) === 3500.00, "Stock account closing due matches opening (3500.00)");
    }

    // -------------------------------------------------------------------------
    // 14. Test 14 — Governance Audit Logging
    // -------------------------------------------------------------------------
    console.log("\nGroup 14: Governance Audit Logging");
    {
      const auditRows = await db
        .selectFrom("audit_logs")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .orderBy("created_at", "asc")
        .execute();

      const periodInitLog = auditRows.find(
        (a) => a.entity_type === "accounting_period" && a.action === "CREATE"
      );
      assert(Boolean(periodInitLog), "Audit log recorded for accounting_period CREATE");

      const seedLog = auditRows.find((a) => a.entity_type === "period_seeds");
      assert(Boolean(seedLog), "Audit log recorded for period_seeds staging");

      const verifyLog = auditRows.find(
        (a) => a.entity_type === "period_financial_seeds" && a.action === "UPDATE"
      );
      assert(Boolean(verifyLog), "Audit log recorded for period_financial_seeds verification");

      const activateLog = auditRows.find(
        (a) => a.entity_type === "accounting_day" && a.action === "UPDATE"
      );
      assert(Boolean(activateLog), "Audit log recorded for accounting_day activation");
    }

    // -------------------------------------------------------------------------
    // 15. Test 15 — Closed-Day Safety (API & Trigger Enforcement)
    // -------------------------------------------------------------------------
    console.log("\nGroup 15: Closed-Day Safety");
    {
      // Day 2 is closed. Attempting to insert an operational transaction on Day 2 via API must fail!
      const day2 = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .where("day_no", "=", 2)
        .executeTakeFirstOrThrow();

      const closedRes = await req(base, "POST", "/api/v1/transactions/expenses", "period-owner", {
        day_id: day2.id,
        item_name: "Blocked Expense on Closed Day 2",
        amount: 500.00
      });

      assert(closedRes.status === 422, "API blocks transaction posting on closed Day 2 (422 DAY_CLOSED)", closedRes);
      assert(closedRes.body.error === "DAY_CLOSED", "Error code is DAY_CLOSED");

      // Day 1 is open. Inserting an operational transaction on Day 1 succeeds!
      const day1 = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("period_id", "=", f1PeriodId)
        .where("day_no", "=", 1)
        .executeTakeFirstOrThrow();

      const openRes = await req(base, "POST", "/api/v1/transactions/expenses", "period-owner", {
        day_id: day1.id,
        item_name: "Allowed Expense on Open Day 1",
        amount: 500.00
      });

      assert(openRes.status === 201, "Transaction posting permitted on activated open Day 1 (201 Created)", openRes);

      // Now test database trigger trg_enforce_ledger_immutability:
      // Temporarily close Day 1 and attempt to UPDATE the created expense item
      await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${day1.id};`.execute(db);

      let triggerBlocked = false;
      try {
        await sql`
          UPDATE expense_items
          SET amount = 999.00
          WHERE id = ${openRes.body.data.id};
        `.execute(db);
      } catch (err: any) {
        triggerBlocked = err.message.includes("Cannot UPDATE record on a closed accounting day");
      }

      assert(triggerBlocked, "PostgreSQL trigger trg_enforce_ledger_immutability blocked mutation on closed day");

      // Re-open Day 1 to delete test expense, then close Day 1 so subsequent tests start with a clean period
      await sql`UPDATE accounting_days SET status = 'open' WHERE id = ${day1.id};`.execute(db);
      await sql`DELETE FROM expense_items WHERE id = ${openRes.body.data.id};`.execute(db);
      await sql`UPDATE accounting_days SET status = 'closed' WHERE id = ${day1.id};`.execute(db);
    }

    // -------------------------------------------------------------------------
    // 16. Test 16 — Role-Based Access Control (RBAC) Matrix
    // -------------------------------------------------------------------------
    console.log("\nGroup 16: Role-Based Access Control Matrix");
    {
      // Viewer cannot mutate
      const vInit = await req(base, "POST", "/api/v1/periods/initialize", "period-viewer", { periodKey: "2026-11" });
      assert(vInit.status === 403, "Viewer rejected from POST /initialize (403)");

      const vSeed = await req(base, "PUT", `/api/v1/periods/${f1PeriodId}/seeds`, "period-viewer", {});
      assert(vSeed.status === 403, "Viewer rejected from PUT /seeds (403)");

      const vVal = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/validate-seeds`, "period-viewer");
      assert(vVal.status === 403, "Viewer rejected from POST /validate-seeds (403)");

      const vVer = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/verify-seeds`, "period-viewer");
      assert(vVer.status === 403, "Viewer rejected from POST /verify-seeds (403)");

      const vAct = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/activate`, "period-viewer");
      assert(vAct.status === 403, "Viewer rejected from POST /activate (403)");

      // Admin cannot initialize or verify or activate
      const aInit = await req(base, "POST", "/api/v1/periods/initialize", "period-admin", { periodKey: "2026-11" });
      assert(aInit.status === 403, "Admin rejected from POST /initialize (403)");

      const aVer = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/verify-seeds`, "period-admin");
      assert(aVer.status === 403, "Admin rejected from POST /verify-seeds (403)");

      const aAct = await req(base, "POST", `/api/v1/periods/${f1PeriodId}/activate`, "period-admin");
      assert(aAct.status === 403, "Admin rejected from POST /activate (403)");
    }

    // -------------------------------------------------------------------------
    // 17. Dynamic Calendar Days & Genesis Support for August 2026 (Phase 13)
    // -------------------------------------------------------------------------
    console.log("\nGroup 17: Dynamic Calendar Days & Genesis Support for August 2026 (Phase 13)");
    let augPeriodId = "";
    {
      // A. Rejection of period prior to 2026-08
      const rPrior = await req(base, "POST", "/api/v1/periods/initialize", "period-owner", {
        periodKey: "2026-07"
      });
      assert(rPrior.status === 422, "Initializing period prior to 2026-08 is rejected (422)", rPrior.status);
      assert(rPrior.body?.error === "HISTORICAL_PERIOD_IMMUTABLE", "Error code is HISTORICAL_PERIOD_IMMUTABLE");

      // B. Initialization of August 2026 (31 days)
      const rAug = await req(base, "POST", "/api/v1/periods/initialize", "period-owner", {
        periodKey: "2026-08"
      });
      assert(rAug.status === 201, "August 2026 initialized successfully (201 Created)", rAug.status);
      assert(rAug.body?.daysCount === 31, "August 2026 has exactly 31 calendar days (dynamic daysCount)");
      assert(rAug.body?.period?.period_key === "2026-08", "Period key is 2026-08");
      augPeriodId = rAug.body?.period?.id;

      // Verify days in DB: 31 days, Day 1 is 2026-08-01, Day 31 is 2026-08-31
      const augDays = await db
        .selectFrom("accounting_days")
        .selectAll()
        .where("period_id", "=", augPeriodId)
        .orderBy("day_no", "asc")
        .execute();
      assert(augDays.length === 31, "DB contains exactly 31 days for August 2026");
      const fmtDate = (d: any) => {
        if (d instanceof Date) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${day}`;
        }
        return String(d).slice(0, 10);
      };
      assert(fmtDate(augDays[0].calendar_date) === "2026-08-01", "Day 1 is 2026-08-01");
      assert(fmtDate(augDays[30].calendar_date) === "2026-08-31", "Day 31 is 2026-08-31");
      assert(augDays.every((d) => d.status === "closed"), "All 31 August days are initially closed");

      // C. Manual Genesis Opening Seeds Staging
      const genesisSeedBundle = {
        financial: {
          openingCash: 25000.00,
          openingOwnerBalance: 12000.00,
          openingJazzLifting: 35000.00,
          openingJazzPayable: 18000.00,
          sourcePeriodKey: null,
          sourceDayNo: null,
          notes: "MANUAL_INITIAL_GENESIS_SEED"
        },
        creditParties: [
          { partyId: data.party1Id, openingBalance: 5000.00, sourcePeriodKey: null, sourceDayNo: null }
        ],
        stockProducts: [
          { productId: data.prod1Id, openingQuantity: 80, sourcePeriodKey: null, sourceDayNo: null },
          { productId: data.prod2Id, openingQuantity: 0, sourcePeriodKey: null, sourceDayNo: null }
        ],
        stockAccounts: [
          { accountId: data.acct1Id, openingReceivable: 4500.00, sourcePeriodKey: null, sourceDayNo: null }
        ],
        jazzDoProfiles: [
          { doProfileId: data.do1Id, openingBaseBalance: 10000.00, sourcePeriodKey: null, sourceDayNo: null }
        ]
      };

      const rGenesisStage = await req(base, "PUT", `/api/v1/periods/${augPeriodId}/seeds`, "period-admin", genesisSeedBundle);
      assert(rGenesisStage.status === 200, "Manual genesis seeds staged successfully (200 OK)", rGenesisStage.status);

      // Verify DB provenance
      const finSeed = await db
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("period_id", "=", augPeriodId)
        .executeTakeFirstOrThrow();
      assert(finSeed.source_period_key === null, "Genesis financial seed source_period_key is NULL");
      assert(finSeed.source_day_no === null, "Genesis financial seed source_day_no is NULL");
      assert(finSeed.notes === "MANUAL_INITIAL_GENESIS_SEED", "Genesis notes recorded as MANUAL_INITIAL_GENESIS_SEED");

      // D. Verify Seeds & Activate Day 1
      const rVer = await req(base, "POST", `/api/v1/periods/${augPeriodId}/verify-seeds`, "period-owner");
      if (rVer.status !== 200) {
        console.error("rVer failure details:", JSON.stringify(rVer.body, null, 2));
      }
      assert(rVer.status === 200, "Genesis seeds verified by owner", rVer.status);

      const rAct = await req(base, "POST", `/api/v1/periods/${augPeriodId}/activate`, "period-owner");
      assert(rAct.status === 200, "August Day 1 activated (200 OK)", rAct.status);

      const d1Aug = await db
        .selectFrom("accounting_days")
        .select(["status"])
        .where("period_id", "=", augPeriodId)
        .where("day_no", "=", 1)
        .executeTakeFirstOrThrow();
      assert(d1Aug.status === "open", "August Day 1 is OPEN");
    }

    // -------------------------------------------------------------------------
    // 18. Sequential Day Progression & Concurrency Invariants (Phase 13)
    // -------------------------------------------------------------------------
    console.log("\nGroup 18: Sequential Day Progression & Concurrency Invariants (Phase 13)");
    {
      // A. Attempting to open Day 3 while Day 1 is open -> rejected
      const rSkipOpen = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/3/open`, "period-admin");
      assert(rSkipOpen.status === 409 || rSkipOpen.status === 400, "Opening Day 3 skipping Day 2 is rejected (409/400)");

      // B. Attempting to open Day 2 while Day 1 is still open -> rejected
      const rOpenD2WhileD1Open = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/2/open`, "period-admin");
      assert(rOpenD2WhileD1Open.status === 409 || rOpenD2WhileD1Open.status === 422, "Opening Day 2 while Day 1 is OPEN is rejected (409/422)", rOpenD2WhileD1Open.status);

      // C. Close Day 1
      const rCloseD1 = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/1/close`, "period-admin", {
        notes: "End of Day 1 operations"
      });
      assert(rCloseD1.status === 200, "August Day 1 successfully closed (200 OK)", rCloseD1.status);
      assert(rCloseD1.body?.day?.status === "closed", "Returned Day 1 status is closed");

      // D. Attempt to close Day 1 again -> idempotent / already closed
      const rCloseD1Again = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/1/close`, "period-admin");
      assert(rCloseD1Again.status === 200 || rCloseD1Again.status === 409, "Closing already-closed Day 1 is handled gracefully (200/409)");

      // E. Open Day 2 (Day 1 is closed) -> succeeds
      const rOpenD2 = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/2/open`, "period-admin");
      assert(rOpenD2.status === 200, "August Day 2 opened sequentially (200 OK)", rOpenD2.status);
      assert(rOpenD2.body?.day?.status === "open", "Returned Day 2 status is open");

      // F. Attempt to reopen Day 1 while Day 2 is OPEN -> rejected (violates single open day)
      const rReopenD1Conflict = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/1/reopen`, "period-owner", {
        reason: "Correction conflict test"
      });
      assert(rReopenD1Conflict.status === 409, "Reopening Day 1 while Day 2 is open rejected (409 MULTIPLE_OPEN_DAYS)");

      // G. Close Day 2, then reopen Day 1 -> succeeds
      const rCloseD2 = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/2/close`, "period-admin");
      assert(rCloseD2.status === 200, "Day 2 closed");

      const rReopenD1 = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/1/reopen`, "period-owner", {
        reason: "Governed correction of Day 1"
      });
      assert(rReopenD1.status === 200, "Day 1 reopened when no other day is open (200 OK)", rReopenD1.status);
      assert(rReopenD1.body?.day?.status === "reopen", "Day 1 status is reopen");

      // Close Day 1 again, and reopen Day 2
      await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/1/close`, "period-admin");
      const rReopenD2 = await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/2/open`, "period-admin");
      assert(rReopenD2.status === 200, "Day 2 reopened");
    }

    // -------------------------------------------------------------------------
    // 19. Server-Authoritative Period Close & Rollover (August -> September)
    // -------------------------------------------------------------------------
    console.log("\nGroup 19: Server-Authoritative Period Close & Rollover (Phase 13)");
    let rolledOverSepPeriodId = "";
    {
      // A. Attempting to close period while Day 2 is OPEN -> rejected
      const rPrematureClose = await req(base, "POST", `/api/v1/periods/${augPeriodId}/close`, "period-owner");
      assert(rPrematureClose.status === 422 || rPrematureClose.status === 409, "Closing period with open day rejected (422 PERIOD_HAS_OPEN_DAYS)", rPrematureClose.status);

      // B. Attempting rollover while period is NOT closed -> rejected
      const rPrematureRollover = await req(base, "POST", `/api/v1/periods/${augPeriodId}/rollover`, "period-owner");
      assert(rPrematureRollover.status === 422 || rPrematureRollover.status === 409, "Rollover on unclosed period rejected (422 PERIOD_NOT_CLOSED)", rPrematureRollover.status);

      // C. Close all days through Day 31
      await req(base, "POST", `/api/v1/periods/${augPeriodId}/days/2/close`, "period-admin");
      const openCount = await db
        .selectFrom("accounting_days")
        .select(db.fn.count("id").as("cnt"))
        .where("period_id", "=", augPeriodId)
        .where("status", "in", ["open", "reopen"])
        .executeTakeFirstOrThrow();
      assert(Number(openCount.cnt) === 0, "All 31 days in August are closed");

      // D. Authoritative Period Close
      const rClosePeriod = await req(base, "POST", `/api/v1/periods/${augPeriodId}/close`, "period-owner", {
        notes: "August 2026 month-end authoritative close"
      });
      assert(rClosePeriod.status === 200, "August 2026 period closed successfully (200 OK)", rClosePeriod.status);
      assert(rClosePeriod.body?.period?.status === "closed", "August period status is closed");
      assert(rClosePeriod.body?.targetPeriod?.periodKey === "2026-09", "Atomic transition returned target period 2026-09");
      assert(rClosePeriod.body?.targetDayNo === 1, "Atomic transition targeted Day 1");
      assert(rClosePeriod.body?.activatedDay?.status === "open", "Atomic transition activated Day 1 as open");

      // E. Rollover August -> September
      const rRollover = await req(base, "POST", `/api/v1/periods/${augPeriodId}/rollover`, "period-owner", {
        notes: "Rollover August to September 2026"
      });
      assert(rRollover.status === 200, "Rollover August -> September succeeded (200 OK)", rRollover.status);
      assert(rRollover.body?.sourcePeriod?.periodKey === "2026-08", "Source period is 2026-08");
      assert(rRollover.body?.targetPeriod?.periodKey === "2026-09", "Target period is 2026-09");
      assert(rRollover.body?.targetPeriod?.daysCount === 30, "September target period has 30 days (dynamic calendar length)");
      rolledOverSepPeriodId = rRollover.body?.targetPeriod?.id;

      // Verify generated September opening seeds
      const sepFinSeed = await db
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("period_id", "=", rolledOverSepPeriodId)
        .executeTakeFirstOrThrow();
      assert(sepFinSeed.source_period_key === "2026-08", "September opening seed provenance source_period_key is 2026-08");
      assert(sepFinSeed.source_day_no === 31, "September opening seed provenance source_day_no is 31 (from August 31)");
      assert(Number(sepFinSeed.opening_cash) === 25000.00, "September opening cash matches August 31 closing snapshot: 25000.00", Number(sepFinSeed.opening_cash));

      // F. Idempotency test: calling rollover again on August
      const rRolloverRetry = await req(base, "POST", `/api/v1/periods/${augPeriodId}/rollover`, "period-owner");
      assert(rRolloverRetry.status === 200, "Rollover retry is idempotent (200 OK)", rRolloverRetry.status);
      assert(rRolloverRetry.body?.rolloverAlreadyComplete === true, "rolloverAlreadyComplete flag is true");
      assert(rRolloverRetry.body?.targetPeriod?.id === rolledOverSepPeriodId, "Returns same target period ID");
    }

    // -------------------------------------------------------------------------
    // 20. Governed Seed Delta & Seed Correction Workflow (Phase 13)
    // -------------------------------------------------------------------------
    console.log("\nGroup 20: Governed Seed Delta & Seed Correction Workflow (Phase 13)");
    {
      // A. Seed Delta endpoint
      const rDelta = await req(base, "GET", `/api/v1/periods/${rolledOverSepPeriodId}/seed-delta`, "period-admin");
      assert(rDelta.status === 200, "GET /seed-delta returns 200 OK", rDelta.status);
      assert(rDelta.body?.targetPeriodKey === "2026-09", "Target period is 2026-09");
      assert(rDelta.body?.sourcePeriodKey === "2026-08", "Source period is 2026-08");
      assert(rDelta.body?.hasDelta === false, "Zero delta immediately after rollover");

      // B. Viewer / Admin cannot apply seed correction (Owner only)
      const rViewerCorr = await req(base, "POST", `/api/v1/periods/${rolledOverSepPeriodId}/seed-correction`, "period-viewer", {
        reason: "Unauthorized attempt",
        seeds: {}
      });
      assert(rViewerCorr.status === 403, "Viewer cannot apply seed correction (403)");

      const rAdminCorr = await req(base, "POST", `/api/v1/periods/${rolledOverSepPeriodId}/seed-correction`, "period-admin", {
        reason: "Unauthorized attempt",
        seeds: {}
      });
      assert(rAdminCorr.status === 403, "Admin cannot apply seed correction (403)");

      // C. Owner Governed Seed Correction
      const correctedSeeds = {
        reason: "Audited owner adjustment to opening cash after bank statement reconciliation",
        seeds: {
          financial: {
            openingCash: 28000.00,
            openingOwnerBalance: 12000.00,
            openingJazzLifting: 35000.00,
            openingJazzPayable: 18000.00,
            sourcePeriodKey: "2026-08",
            sourceDayNo: 31,
            notes: "Corrected from 25000 to 28000"
          },
          creditParties: [
            { partyId: data.party1Id, openingBalance: 5000.00, sourcePeriodKey: "2026-08", sourceDayNo: 31 }
          ],
          stockProducts: [
            { productId: data.prod1Id, openingQuantity: 80, sourcePeriodKey: "2026-08", sourceDayNo: 31 },
            { productId: data.prod2Id, openingQuantity: 0, sourcePeriodKey: "2026-08", sourceDayNo: 31 }
          ],
          stockAccounts: [
            { accountId: data.acct1Id, openingReceivable: 4500.00, sourcePeriodKey: "2026-08", sourceDayNo: 31 }
          ],
          jazzDo: [
            { doProfileId: data.do1Id, openingBaseBalance: 10000.00, sourcePeriodKey: "2026-08", sourceDayNo: 31 }
          ]
        }
      };

      const rOwnerCorr = await req(base, "POST", `/api/v1/periods/${rolledOverSepPeriodId}/seed-correction`, "period-owner", correctedSeeds);
      assert(rOwnerCorr.status === 200, "Owner successfully applied seed correction (200 OK)", rOwnerCorr.status);
      assert(rOwnerCorr.body?.correctionApplied === true, "correctionApplied is true");
      assert(rOwnerCorr.body?.isVerified === false, "Verification reset to false upon seed correction");

      // Verify updated seed in DB
      const updatedFin = await db
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("period_id", "=", rolledOverSepPeriodId)
        .executeTakeFirstOrThrow();
      assert(Number(updatedFin.opening_cash) === 28000.00, "Opening cash updated to 28000.00 in DB");
      assert(updatedFin.is_verified === false, "is_verified reset to false in DB");

      // Verify audit log
      const corrAudit = await db
        .selectFrom("audit_logs")
        .selectAll()
        .where("franchise_id", "=", data.f1Id)
        .where("action", "=", "UPDATE")
        .where("entity_type", "=", "period_seed_correction")
        .execute();
      assert(corrAudit.length > 0, "Audit log recorded for period_seed_correction");
    }
  } finally {
    server.close();
    await cleanupTestData();
    console.log("\n[Test Clean] Temporary period test data 100% removed from database.");
  }

  // 17. Verify Database Cleanliness
  const remainingPeriods = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "in", [data.f1Id, data.f2Id])
    .execute();

  const remainingDays = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "in", [data.f1Id, data.f2Id])
    .execute();

  const remainingSeeds = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "in", [data.f1Id, data.f2Id])
    .execute();

  const remainingProjs = await db
    .selectFrom("day_financial_projections")
    .selectAll()
    .where("franchise_id", "in", [data.f1Id, data.f2Id])
    .execute();

  const remainingAudit = await db
    .selectFrom("audit_logs")
    .selectAll()
    .where("franchise_id", "in", [data.f1Id, data.f2Id])
    .execute();

  assert(remainingPeriods.length === 0, "Zero test periods remain in database");
  assert(remainingDays.length === 0, "Zero test days remain in database");
  assert(remainingSeeds.length === 0, "Zero test seeds remain in database");
  assert(remainingProjs.length === 0, "Zero test projections remain in database");
  assert(remainingAudit.length === 0, "Zero test audit records remain in database");

  console.log(`\n=== PHASE 7B PERIOD TESTS COMPLETE ===`);
  console.log(`Passed: ${pass} | Failed: ${fail}\n`);

  if (fail > 0) {
    process.exit(1);
  }

  await closeDatabase();
  process.exit(0);
}

runPeriodTests().catch(async (err) => {
  console.error("Fatal test error:", err);
  await cleanupTestData();
  await closeDatabase();
  process.exit(1);
});
