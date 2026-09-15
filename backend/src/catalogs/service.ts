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
