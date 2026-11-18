/**
 * Phase 4: Master Catalog Services
 *
 * Pure service functions that perform tenant-scoped database operations
 * using Kysely. All functions require an explicit franchiseId parameter —
 * they never read it from client input.
 *
 * Tenant isolation is enforced by WHERE franchise_id = $franchiseId on
 * every SELECT, INSERT, UPDATE, and DELETE.
 */
import { db } from "../config/database.js";
import type {
  ExpenseCategoryCreate,
  ExpenseCategoryUpdate,
  CommissionCategoryCreate,
  CommissionCategoryUpdate,
  CreditPartyCreate,
  CreditPartyUpdate,
  JazzLoadRateCreate,
  JazzLoadRateUpdate,
  JazzLoadDoProfileCreate,
  JazzLoadDoProfileUpdate,
  StockProductCreate,
  StockProductUpdate,
  StockAccountCreate,
  StockAccountUpdate
} from "./schemas.js";

// ---------------------------------------------------------------------------
// Expense Categories
// ---------------------------------------------------------------------------

export async function listExpenseCategories(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("expense_categories")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("sort_order", "asc")
    .orderBy("name", "asc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getExpenseCategory(franchiseId: string, id: string) {
  return db
    .selectFrom("expense_categories")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createExpenseCategory(franchiseId: string, data: ExpenseCategoryCreate) {
  return db
    .insertInto("expense_categories")
    .values({
      franchise_id: franchiseId,
      slug: data.slug,
      name: data.name,
      sort_order: data.sort_order,
      is_active: data.is_active
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateExpenseCategory(franchiseId: string, id: string, data: ExpenseCategoryUpdate) {
  return db
    .updateTable("expense_categories")
    .set({ ...data })
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteExpenseCategory(franchiseId: string, id: string) {
  const existing = await getExpenseCategory(franchiseId, id);
  if (!existing) return null;

  // Check if referenced by historical transactions
  const txRef = await db
    .selectFrom("expense_items")
    .select(db.fn.count("id").as("count"))
    .where("franchise_id", "=", franchiseId)
    .where("category_id", "=", id)
    .executeTakeFirst();

  const refCount = Number(txRef?.count ?? 0);
  if (refCount > 0) {
    // Referenced by accounting transactions: preserve historical integrity via soft-delete
    const updated = await db
      .updateTable("expense_categories")
      .set({ is_active: false })
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...updated, soft_deleted: true };
  }

  // Not referenced: safe to permanently delete
  const deleted = await db
    .deleteFrom("expense_categories")
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return { ...deleted, soft_deleted: false };
}

// ---------------------------------------------------------------------------
// Commission Categories
// ---------------------------------------------------------------------------

export async function listCommissionCategories(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("commission_categories")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("sort_order", "asc")
    .orderBy("name", "asc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getCommissionCategory(franchiseId: string, id: string) {
  return db
    .selectFrom("commission_categories")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createCommissionCategory(franchiseId: string, data: CommissionCategoryCreate) {
  return db
    .insertInto("commission_categories")
    .values({
      franchise_id: franchiseId,
      slug: data.slug,
      name: data.name,
      sort_order: data.sort_order,
      is_active: data.is_active
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateCommissionCategory(franchiseId: string, id: string, data: CommissionCategoryUpdate) {
  return db
    .updateTable("commission_categories")
    .set({ ...data })
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteCommissionCategory(franchiseId: string, id: string) {
  const existing = await getCommissionCategory(franchiseId, id);
  if (!existing) return null;

  const txRef = await db
    .selectFrom("commission_items")
    .select(db.fn.count("id").as("count"))
    .where("franchise_id", "=", franchiseId)
    .where("category_id", "=", id)
    .executeTakeFirst();

  const refCount = Number(txRef?.count ?? 0);
  if (refCount > 0) {
    const updated = await db
      .updateTable("commission_categories")
      .set({ is_active: false })
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...updated, soft_deleted: true };
  }

  const deleted = await db
    .deleteFrom("commission_categories")
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return { ...deleted, soft_deleted: false };
}

// ---------------------------------------------------------------------------
// Credit Parties
// ---------------------------------------------------------------------------

export async function listCreditParties(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("credit_parties")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("sort_order", "asc")
    .orderBy("name", "asc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getCreditParty(franchiseId: string, id: string) {
  return db
    .selectFrom("credit_parties")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createCreditParty(franchiseId: string, data: CreditPartyCreate) {
  return db
    .insertInto("credit_parties")
    .values({
      franchise_id: franchiseId,
      slug: data.slug,
      name: data.name,
      type: data.type,
      sort_order: data.sort_order,
      is_active: data.is_active,
      notes: data.notes ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateCreditParty(franchiseId: string, id: string, data: CreditPartyUpdate) {
  const { notes, ...rest } = data;
  const setData: Record<string, unknown> = { ...rest, updated_at: new Date() };
  if (notes !== undefined) setData.notes = notes;

  return db
    .updateTable("credit_parties")
    .set(setData)
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

export async function deleteCreditParty(franchiseId: string, id: string) {
  const existing = await getCreditParty(franchiseId, id);
  if (!existing) return null;

  const [txRef, seedRef] = await Promise.all([
    db
      .selectFrom("credit_transactions")
      .select(db.fn.count("id").as("count"))
      .where("franchise_id", "=", franchiseId)
      .where("party_id", "=", id)
      .executeTakeFirst(),
    db
      .selectFrom("period_credit_party_seeds")
      .select(db.fn.count("id").as("count"))
      .where("franchise_id", "=", franchiseId)
      .where("party_id", "=", id)
      .executeTakeFirst()
  ]);

  const refCount = Number(txRef?.count ?? 0) + Number(seedRef?.count ?? 0);
  if (refCount > 0) {
    const updated = await db
      .updateTable("credit_parties")
      .set({ is_active: false })
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return { ...updated, soft_deleted: true };
  }

  const deleted = await db
    .deleteFrom("credit_parties")
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return { ...deleted, soft_deleted: false };
}

// ---------------------------------------------------------------------------
// Jazz Load Rates
// ---------------------------------------------------------------------------

export async function listJazzLoadRates(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("jazz_load_rates")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("effective_from", "desc")
    .orderBy("created_at", "desc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getJazzLoadRate(franchiseId: string, id: string) {
  return db
    .selectFrom("jazz_load_rates")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createJazzLoadRate(franchiseId: string, data: JazzLoadRateCreate) {
  return db
    .insertInto("jazz_load_rates")
    .values({
      franchise_id: franchiseId,
      name: data.name,
      ml_rate: data.ml_rate,
      comm1_rate: data.comm1_rate,
      comm2_rate: data.comm2_rate,
      effective_from: data.effective_from,
      is_active: data.is_active
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateJazzLoadRate(franchiseId: string, id: string, data: JazzLoadRateUpdate) {
  // Only name and is_active can be updated. The rate values and effective_from
  // are immutable once created; corrections require a new rate record.
  return db
    .updateTable("jazz_load_rates")
    .set({ ...data })
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Jazz Load DO Profiles
// ---------------------------------------------------------------------------

export async function listJazzLoadDoProfiles(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("jazz_load_do_profiles")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("sort_order", "asc")
    .orderBy("do_name", "asc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getJazzLoadDoProfile(franchiseId: string, id: string) {
  return db
    .selectFrom("jazz_load_do_profiles")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createJazzLoadDoProfile(franchiseId: string, data: JazzLoadDoProfileCreate) {
  return db
    .insertInto("jazz_load_do_profiles")
    .values({
      franchise_id: franchiseId,
      do_name: data.do_name,
      do_line: data.do_line ?? null,
      sort_order: data.sort_order,
      is_active: data.is_active,
      notes: data.notes ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateJazzLoadDoProfile(franchiseId: string, id: string, data: JazzLoadDoProfileUpdate) {
  const { notes, do_line, ...rest } = data;
  const setData: Record<string, unknown> = { ...rest, updated_at: new Date() };
  if (notes !== undefined) setData.notes = notes;
  if (do_line !== undefined) setData.do_line = do_line;

  return db
    .updateTable("jazz_load_do_profiles")
    .set(setData)
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Stock Products
// ---------------------------------------------------------------------------

export async function listStockProducts(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("sort_order", "asc")
    .orderBy("name", "asc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getStockProduct(franchiseId: string, id: string) {
  return db
    .selectFrom("stock_products")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createStockProduct(franchiseId: string, data: StockProductCreate) {
  return db
    .insertInto("stock_products")
    .values({
      franchise_id: franchiseId,
      slug: data.slug,
      name: data.name,
      rate: data.rate,
      payment_tracking_enabled: data.payment_tracking_enabled,
      category: data.category ?? null,
      sort_order: data.sort_order,
      is_active: data.is_active,
      notes: data.notes ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateStockProduct(franchiseId: string, id: string, data: StockProductUpdate) {
  const { notes, category, ...rest } = data;
  const setData: Record<string, unknown> = { ...rest, updated_at: new Date() };
  if (notes !== undefined) setData.notes = notes;
  if (category !== undefined) setData.category = category;

  return db
    .updateTable("stock_products")
    .set(setData)
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Stock Accounts
// ---------------------------------------------------------------------------

export async function listStockAccounts(franchiseId: string, includeInactive: boolean) {
  let q = db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("sort_order", "asc")
    .orderBy("name", "asc");

  if (!includeInactive) {
    q = q.where("is_active", "=", true);
  }

  return q.execute();
}

export async function getStockAccount(franchiseId: string, id: string) {
  return db
    .selectFrom("stock_accounts")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .executeTakeFirst();
}

export async function createStockAccount(franchiseId: string, data: StockAccountCreate) {
  return db
    .insertInto("stock_accounts")
    .values({
      franchise_id: franchiseId,
      slug: data.slug,
      name: data.name,
      type: data.type,
      sort_order: data.sort_order,
      is_active: data.is_active,
      notes: data.notes ?? null
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function updateStockAccount(franchiseId: string, id: string, data: StockAccountUpdate) {
  const { notes, ...rest } = data;
  const setData: Record<string, unknown> = { ...rest, updated_at: new Date() };
  if (notes !== undefined) setData.notes = notes;

  return db
    .updateTable("stock_accounts")
    .set(setData)
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirst();
}

// ---------------------------------------------------------------------------
// Dealer Reports & Master Ledger Performance
// ---------------------------------------------------------------------------

export function cleanDealerName(s: string): string {
  return s
    .replace(/^(DO|DSO|CCR)\s+/i, "")
    .replace(/\s+(CCR|DSO|DO)$/i, "")
    .trim();
}

export function getCanonicalDealerKey(name: string): string {
  const cleaned = cleanDealerName(name).toLowerCase();
  if (/rizwan/i.test(cleaned)) return "discard-rizwan";
  if (/waseem.*gujjar/i.test(cleaned)) return "discard-waseem";
  if (/ghot.*hussain/i.test(cleaned)) return "hussain";
  if (/mubash[ia]r/i.test(cleaned)) return "mubashir";
  if (/irfan.*mirza|mirza.*irfan/i.test(cleaned)) return "irfan-mirza";
  if (/naveed.*bangla|bangla.*naveed/i.test(cleaned)) return "naveed-bangla";
  if (/fix.*line|office.*line.*1|office.*line(?!\s*2)/i.test(cleaned)) return "office-line-1";
  if (/office.*line.*2|other/i.test(cleaned)) return "office-line-2";
  if (/fakhar|t[ie]t[au]s/i.test(cleaned)) return "fakhar-titus";
  if (/hussain/i.test(cleaned)) return "hussain";
  if (/free.*sim|face.*sim/i.test(cleaned)) return "free-sim";
  if (/net.*stock/i.test(cleaned)) return "net-stock";
  if (/anni|any/i.test(cleaned)) return "anni";
  if (/saram/i.test(cleaned)) return "saram";
  if (/hasan|hassan/i.test(cleaned)) {
    if (/dso/i.test(name) || cleaned === "hasan") return "dso-hasan";
    return "do-hassan";
  }
  return cleaned.replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
}

export interface DealerReportQueryOptions {
  periodId?: string;
  periodKey?: string;
  dealerId?: string;
}

export async function getDealerReports(franchiseId: string, options: DealerReportQueryOptions = {}) {
  // 1. Fetch available periods
  const periods = await db
    .selectFrom("accounting_periods")
    .select(["id", "period_key", "label", "year_num", "month_num", "status", "final_settlement_status"])
    .where("franchise_id", "=", franchiseId)
    .orderBy("year_num", "desc")
    .orderBy("month_num", "desc")
    .execute();

  if (periods.length === 0) {
    return {
      period: null,
      periods: [],
      summary: [],
      dailyStatements: {}
    };
  }

  // 2. Resolve selected period
  let selectedPeriod = periods[0];
  if (options.periodId) {
    const found = periods.find((p) => p.id === options.periodId);
    if (found) selectedPeriod = found;
  } else if (options.periodKey) {
    const found = periods.find((p) => p.period_key === options.periodKey);
    if (found) selectedPeriod = found;
  }

  // 3. Fetch days in this period
  const days = await db
    .selectFrom("accounting_days")
    .select(["id", "day_no", "calendar_date", "status"])
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", selectedPeriod.id)
    .orderBy("day_no", "asc")
    .execute();

  const daysCount = days.length;
  const firstDayNo = days[0]?.day_no ?? 1;
  const lastDayNo = days[daysCount - 1]?.day_no ?? 31;

  // 4. Fetch stock accounts and jazz DO profiles
  const [stockAccounts, jazzProfiles] = await Promise.all([
    db
      .selectFrom("stock_accounts")
      .select(["id", "name", "type", "sort_order", "notes", "is_active"])
      .where("franchise_id", "=", franchiseId)
      .orderBy("sort_order", "asc")
      .execute(),
    db
      .selectFrom("jazz_load_do_profiles")
      .select(["id", "do_name", "do_line", "sort_order", "notes", "is_active"])
      .where("franchise_id", "=", franchiseId)
      .orderBy("sort_order", "asc")
      .execute()
  ]);

  // 5. Fetch stock account day projections, jazz day projections, and stock order lines
  const dayIds = days.map((d) => d.id);
  let stockProjections: any[] = [];
  let jazzProjections: any[] = [];
  let stockOrderLines: any[] = [];

  if (dayIds.length > 0) {
    [stockProjections, jazzProjections, stockOrderLines] = await Promise.all([
      db
        .selectFrom("stock_account_day_projections as sad")
        .innerJoin("accounting_days as d", "d.id", "sad.day_id")
        .select([
          "sad.account_id",
          "d.day_no",
          "sad.opening_due",
          "sad.stock_taken_amount",
          "sad.payment_received_amount",
          "sad.transfers_out_amount",
          "sad.transfers_in_amount",
          "sad.closing_due"
        ])
        .where("sad.franchise_id", "=", franchiseId)
        .where("d.period_id", "=", selectedPeriod.id)
        .execute(),
      db
        .selectFrom("jazz_load_do_day_projections as jdp")
        .innerJoin("accounting_days as d", "d.id", "jdp.day_id")
        .select([
          "jdp.do_profile_id",
          "d.day_no",
          "jdp.opening_base",
          "jdp.issuance_base",
          "jdp.payment_base",
          "jdp.closing_base",
          "jdp.opening_ml",
          "jdp.closing_ml"
        ])
        .where("jdp.franchise_id", "=", franchiseId)
        .where("d.period_id", "=", selectedPeriod.id)
        .execute(),
      db
        .selectFrom("stock_order_lines as sol")
        .innerJoin("stock_orders as so", "so.id", "sol.stock_order_id")
        .innerJoin("accounting_days as d", "d.id", "so.day_id")
        .select([
          "so.account_id",
          "d.day_no",
          "sol.product_name_snapshot",
          "sol.quantity",
          "sol.unit_rate",
          "sol.line_amount"
        ])
        .where("so.franchise_id", "=", franchiseId)
        .where("d.period_id", "=", selectedPeriod.id)
        .execute()
    ]);
  }

  // Lookup maps
  const stockByAccDay = new Map<string, any>();
  stockProjections.forEach((r) => stockByAccDay.set(`${r.account_id}_${r.day_no}`, r));

  const jazzByProfileDay = new Map<string, any>();
  jazzProjections.forEach((r) => jazzByProfileDay.set(`${r.do_profile_id}_${r.day_no}`, r));

  const stockLinesByAccDay = new Map<string, any[]>();
  stockOrderLines.forEach((l) => {
    const k = `${l.account_id}_${l.day_no}`;
    const list = stockLinesByAccDay.get(k) || [];
    list.push({
      productName: l.product_name_snapshot,
      quantity: Number(l.quantity),
      unitRate: Number(l.unit_rate),
      lineAmount: Number(l.line_amount)
    });
    stockLinesByAccDay.set(k, list);
  });

  // Build unified dealer map
  const dealerMap = new Map<string, any>();

  stockAccounts.forEach((sa) => {
    const key = getCanonicalDealerKey(sa.name);
    if (key.startsWith("discard-")) return;
    const line = sa.notes?.replace(/^Line:\s*/i, "").trim() || null;
    dealerMap.set(key, {
      id: key,
      name: sa.name,
      type: sa.type,
      line,
      sortOrder: sa.sort_order,
      stockAccountId: sa.id,
      jazzDoId: null,
      isActive: sa.is_active
    });
  });

  jazzProfiles.forEach((jp) => {
    const key = getCanonicalDealerKey(jp.do_name);
    if (key.startsWith("discard-")) return;
    const existing = dealerMap.get(key);
    if (existing) {
      existing.jazzDoId = jp.id;
      if (!existing.line && jp.do_line) existing.line = jp.do_line;
    } else {
      dealerMap.set(key, {
        id: key,
        name: jp.do_name,
        type: "DO",
        line: jp.do_line ?? null,
        sortOrder: jp.sort_order,
        stockAccountId: null,
        jazzDoId: jp.id,
        isActive: jp.is_active
      });
    }
  });

  const allDealers = Array.from(dealerMap.values()).sort((a, b) => a.sortOrder - b.sortOrder);

  // Compute summary and daily statements
  const summary: any[] = [];
  const dailyStatements: Record<string, any[]> = {};

  for (const d of allDealers) {
    let loadOpening = 0;
    let loadIssuance = 0;
    let loadPayment = 0;
    let loadClosing = 0;
    let activeLoadDays = 0;

    let stockOpening = 0;
    let stockIssued = 0;
    let stockPayment = 0;
    let stockTransfersOut = 0;
    let stockTransfersIn = 0;
    let stockClosing = 0;
    let activeStockDays = 0;

    if (d.jazzDoId) {
      const day1 = jazzByProfileDay.get(`${d.jazzDoId}_${firstDayNo}`);
      if (day1) loadOpening = Number(day1.opening_base);
      const dayLast = jazzByProfileDay.get(`${d.jazzDoId}_${lastDayNo}`);
      if (dayLast) loadClosing = Number(dayLast.closing_base);

      for (let dayNo = firstDayNo; dayNo <= lastDayNo; dayNo++) {
        const row = jazzByProfileDay.get(`${d.jazzDoId}_${dayNo}`);
        if (row) {
          const iss = Number(row.issuance_base);
          const pay = Number(row.payment_base);
          loadIssuance += iss;
          loadPayment += pay;
          if (iss > 0 || pay > 0) activeLoadDays++;
        }
      }
    }

    if (d.stockAccountId) {
      const day1 = stockByAccDay.get(`${d.stockAccountId}_${firstDayNo}`);
      if (day1) stockOpening = Number(day1.opening_due);
      const dayLast = stockByAccDay.get(`${d.stockAccountId}_${lastDayNo}`);
      if (dayLast) stockClosing = Number(dayLast.closing_due);

      for (let dayNo = firstDayNo; dayNo <= lastDayNo; dayNo++) {
        const row = stockByAccDay.get(`${d.stockAccountId}_${dayNo}`);
        if (row) {
          const iss = Number(row.stock_taken_amount);
          const pay = Number(row.payment_received_amount);
          stockIssued += iss;
          stockPayment += pay;
          stockTransfersOut += Number(row.transfers_out_amount);
          stockTransfersIn += Number(row.transfers_in_amount);
          if (iss > 0 || pay > 0) activeStockDays++;
        }
      }
    }

    const totalDisbursed = loadIssuance + stockIssued;
    const totalRecovered = loadPayment + stockPayment;
    const netOutstanding = loadClosing + stockClosing;

    summary.push({
      id: d.id,
      name: d.name,
      type: d.type,
      line: d.line,
      sortOrder: d.sortOrder,
      isActive: d.isActive,
      stockAccountId: d.stockAccountId,
      jazzDoId: d.jazzDoId,
      // Load
      loadOpening,
      loadIssuance,
      loadPayment,
      loadClosing,
      activeLoadDays,
      // Stock
      stockOpening,
      stockIssued,
      stockPayment,
      stockTransfersOut,
      stockTransfersIn,
      stockClosing,
      activeStockDays,
      // Combined
      totalDisbursed,
      totalRecovered,
      netOutstanding
    });

    // Build day-by-day statement for dealer
    const dStatements: any[] = [];
    for (const day of days) {
      const jazzRow = d.jazzDoId ? jazzByProfileDay.get(`${d.jazzDoId}_${day.day_no}`) : null;
      const stockRow = d.stockAccountId ? stockByAccDay.get(`${d.stockAccountId}_${day.day_no}`) : null;
      const stockLines = d.stockAccountId ? stockLinesByAccDay.get(`${d.stockAccountId}_${day.day_no}`) : undefined;

      const dLoadOpening = jazzRow ? Number(jazzRow.opening_base) : 0;
      const dLoadIssuance = jazzRow ? Number(jazzRow.issuance_base) : 0;
      const dLoadPayment = jazzRow ? Number(jazzRow.payment_base) : 0;
      const dLoadClosing = jazzRow ? Number(jazzRow.closing_base) : 0;

      const dStockOpening = stockRow ? Number(stockRow.opening_due) : 0;
      const dStockIssued = stockRow ? Number(stockRow.stock_taken_amount) : 0;
      const dStockPayment = stockRow ? Number(stockRow.payment_received_amount) : 0;
      const dStockTransfersOut = stockRow ? Number(stockRow.transfers_out_amount) : 0;
      const dStockTransfersIn = stockRow ? Number(stockRow.transfers_in_amount) : 0;
      const dStockClosing = stockRow ? Number(stockRow.closing_due) : 0;

      dStatements.push({
        dayNo: day.day_no,
        calendarDate: day.calendar_date ? new Date(day.calendar_date).toISOString().slice(0, 10) : "",
        dayStatus: day.status,
        loadOpening: dLoadOpening,
        loadIssuance: dLoadIssuance,
        loadPayment: dLoadPayment,
        loadClosing: dLoadClosing,
        stockOpening: dStockOpening,
        stockIssued: dStockIssued,
        stockPayment: dStockPayment,
        stockTransfersOut: dStockTransfersOut,
        stockTransfersIn: dStockTransfersIn,
        stockClosing: dStockClosing,
        dailyDisbursed: dLoadIssuance + dStockIssued,
        dailyRecovered: dLoadPayment + dStockPayment,
        dailyNetDue: dLoadClosing + dStockClosing,
        stockLines: stockLines && stockLines.length > 0 ? stockLines : undefined
      });
    }
    dailyStatements[d.id] = dStatements;
  }

  return {
    period: selectedPeriod,
    periods,
    summary,
    dailyStatements
  };
}
