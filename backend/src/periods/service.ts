/**
 * Phase 7B: Period and Opening Seed Management Service
 *
 * Implements:
 * 1. Period Initialization & Calendar Day Provisioning (30 days for September 2026, closed by default)
 * 2. Opening Seed Staging & Idempotent Bundling (financial, credit, stock product, stock account, Jazz DO)
 * 3. Opening Seed Validation (catalog completeness, tenant boundary, non-negative inventory)
 * 4. Seed Verification & Zero-Transaction Day 1 Baseline Calculation
 * 5. Period Activation (Day 1 opens; Days 2..30 remain closed)
 * 6. Governed Audit Logging & RBAC Enforcement
 */

import { sql, type Kysely, type Transaction } from "kysely";
import { db } from "../config/database.js";
import type { Database } from "../db/types.js";
import { recordAuditLog } from "../transactions/audit.js";
import { calculateDayInternal, recalculateFromDayInternal } from "../calculations/engine.js";
import { getPeriodFinalProjectionsInternal } from "../calculations/service.js";
import { round2 } from "../calculations/evaluators.js";
import { InvariantViolationError } from "../calculations/invariants.js";
import { checkIdempotency, saveIdempotencyRecord, computePayloadHash } from "../transactions/idempotency.js";
import {
  PeriodError,
  PeriodNotFoundError,
  PeriodAlreadyExistsError,
  InvalidPeriodKeyError,
  SeedValidationFailedError,
  MissingFinancialSeedError,
  SeedsNotVerifiedError,
  PeriodNotReadyError,
  TenantIsolationError,
  DayNotFoundError,
  DayAlreadyClosedError,
  PreviousDayNotClosedError,
  MultipleOpenDaysError,
  NonSequentialDayError,
  PeriodAlreadyClosedError,
  PeriodNotClosedError,
  PeriodHasOpenDaysError,
  HistoricalPeriodImmutableError,
  OverSettlementError,
  FinalSettlementImmutableError
} from "./errors.js";
import type { SeedBundleInput, CreateFinalSettlementInput, UpdateFinalSettlementInput } from "./schemas.js";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

export interface PeriodServiceUser {
  id: string | null;
  email: string | null;
  role: string;
}

export interface SeedValidationResult {
  isValid: boolean;
  periodId: string;
  errors: string[];
  warnings: string[];
}

/**
 * Parses and validates periodKey format (YYYY-MM).
 */
export function parsePeriodKey(periodKey: string): { year: number; month: number; label: string; daysInMonth: number } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(periodKey);
  if (!match) {
    throw new InvalidPeriodKeyError(periodKey, "Must be formatted as YYYY-MM (e.g. '2026-09').");
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);

  if (year < 2020) {
    throw new InvalidPeriodKeyError(periodKey, "Year must be 2020 or later.");
  }

  const label = `${MONTH_NAMES[month - 1]} ${year}`;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  return { year, month, label, daysInMonth };
}

/**
 * Generically computes the next accounting period key and dynamic calendar days.
 */
export function getNextPeriodKey(currentPeriodKey: string): { nextPeriodKey: string; daysInNextMonth: number } {
  const { year, month } = parsePeriodKey(currentPeriodKey);
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }
  const nextPeriodKey = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
  const daysInNextMonth = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return { nextPeriodKey, daysInNextMonth };
}

export function formatSettlementDate(val: unknown): string {
  if (typeof val === "string") {
    return val.slice(0, 10);
  }
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, "0");
    const d = String(val.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(val ?? "");
}

/**
 * 1. Initialize Accounting Period and Provision Days Atomically.
 * Provisions exact calendar days dynamically derived from periodKey (all closed).
 */
export async function initializePeriod(
  franchiseId: string,
  periodKey: string,
  user: PeriodServiceUser
) {
  if (periodKey < "2026-08") {
    throw new HistoricalPeriodImmutableError(
      `Historical periods prior to genesis period '2026-08' cannot be initialized in PostgreSQL.`
    );
  }

  const { year, month, label, daysInMonth } = parsePeriodKey(periodKey);

  // Check if period already exists
  const existingPeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_key", "=", periodKey)
    .executeTakeFirst();

  if (existingPeriod) {
    // Verify day completeness
    const existingDays = await db
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", existingPeriod.id)
      .orderBy("day_no", "asc")
      .execute();

    if (existingDays.length === daysInMonth) {
      return {
        created: false,
        message: `Period '${periodKey}' is already initialized with ${existingDays.length} days.`,
        period: existingPeriod,
        daysCount: existingDays.length
      };
    }

    throw new PeriodAlreadyExistsError(periodKey, {
      reason: `Period exists but has inconsistent day provisioning (${existingDays.length} of ${daysInMonth} days).`,
      existingDaysCount: existingDays.length,
      expectedDaysCount: daysInMonth
    });
  }

  // Create period and 30 calendar days atomically in transaction
  return db.transaction().execute(async (trx) => {
    let period = await trx
      .insertInto("accounting_periods")
      .values({
        franchise_id: franchiseId,
        period_key: periodKey,
        year_num: year,
        month_num: month,
        label,
        status: "open"
      })
      .onConflict((oc) => oc.columns(["franchise_id", "period_key"]).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (!period) {
      // Concurrently inserted by another process
      period = await trx
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("period_key", "=", periodKey)
        .executeTakeFirstOrThrow();

      const existingDays = await trx
        .selectFrom("accounting_days")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("period_id", "=", period.id)
        .execute();

      return {
        created: false,
        message: `Period '${periodKey}' was concurrently initialized with ${existingDays.length} days.`,
        period,
        daysCount: existingDays.length
      };
    }

    // Provision exactly daysInMonth days (Day 1..Day 30, closed)
    for (let dayNo = 1; dayNo <= daysInMonth; dayNo++) {
      const dayStr = dayNo < 10 ? `0${dayNo}` : `${dayNo}`;
      const monthStr = month < 10 ? `0${month}` : `${month}`;
      const calendarDate = `${year}-${monthStr}-${dayStr}`;

      await trx
        .insertInto("accounting_days")
        .values({
          franchise_id: franchiseId,
          period_id: period.id,
          day_no: dayNo,
          day_type: "calendar",
          calendar_date: calendarDate,
          label: `Day ${dayNo}`,
          status: "closed"
        })
        .execute();
    }

    // Record governance audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "CREATE",
      entityType: "accounting_period",
      entityId: period.id,
      afterState: {
        periodKey,
        year,
        month,
        label,
        daysCount: daysInMonth,
        status: "open",
        allDaysClosed: true
      }
    });

    return {
      created: true,
      message: `Period '${periodKey}' successfully initialized with ${daysInMonth} closed calendar days.`,
      period,
      daysCount: daysInMonth
    };
  });
}

/**
 * 2. Fetch Period by ID with its Accounting Days.
 */
export async function getPeriod(franchiseId: string, periodId: string) {
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  const days = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .orderBy("day_no", "asc")
    .execute();

  return { period, days };
}

/**
 * List all accounting periods for the authenticated franchise.
 */
export async function listPeriods(franchiseId: string) {
  return db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("year_num", "desc")
    .orderBy("month_num", "desc")
    .execute();
}

/**
 * 3. Stage or Update Opening Seeds.
 * Accepts a complete 5-domain opening bundle.
 * Resets `is_verified = false`.
 */
export async function stageSeeds(
  franchiseId: string,
  periodId: string,
  bundle: SeedBundleInput,
  user: PeriodServiceUser,
  customTrx?: Transaction<Database>
) {
  const dbOrTrx = customTrx ?? db;

  // 1. Verify period ownership
  const period = await dbOrTrx
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  // 2. Check Day 1 status
  const day1 = await dbOrTrx
    .selectFrom("accounting_days")
    .select(["id", "day_no", "status"])
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .where("day_no", "=", 1)
    .executeTakeFirst();

  if (!day1) {
    throw new PeriodNotReadyError("Day 1 does not exist for this period.");
  }

  const isDay1Active = day1.status !== "closed";

  // If Day 1 is already open, only owner can perform post-activation seed correction
  if (isDay1Active && user.role !== "owner") {
    throw new PeriodError(
      "FORBIDDEN",
      "Only the franchise owner can modify opening seeds after period activation.",
      403
    );
  }

  // 3. Validate Catalog References (Strict Multi-Tenant Scoping)
  // 3.1 Credit Parties
  if (bundle.creditParties.length > 0) {
    const partyIds = bundle.creditParties.map((cp) => cp.partyId);
    const uniquePartyIds = new Set(partyIds);
    if (uniquePartyIds.size !== partyIds.length) {
      throw new PeriodError(
        "INVALID_CATALOG_REFERENCE",
        "Duplicate credit party ID in seed bundle.",
        422
      );
    }

    const verifiedParties = await dbOrTrx
      .selectFrom("credit_parties")
      .select(["id"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "in", partyIds)
      .execute();

    if (verifiedParties.length !== partyIds.length) {
      throw new TenantIsolationError(
        "One or more credit parties do not exist or belong to another franchise."
      );
    }
  }

  // 3.2 Stock Products
  if (bundle.stockProducts.length > 0) {
    const productIds = bundle.stockProducts.map((sp) => sp.productId);
    const uniqueProductIds = new Set(productIds);
    if (uniqueProductIds.size !== productIds.length) {
      throw new PeriodError(
        "INVALID_CATALOG_REFERENCE",
        "Duplicate stock product ID in seed bundle.",
        422
      );
    }

    const verifiedProducts = await dbOrTrx
      .selectFrom("stock_products")
      .select(["id"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "in", productIds)
      .execute();

    if (verifiedProducts.length !== productIds.length) {
      throw new TenantIsolationError(
        "One or more stock products do not exist or belong to another franchise."
      );
    }
  }

  // 3.3 Stock Accounts
  if (bundle.stockAccounts.length > 0) {
    const accountIds = bundle.stockAccounts.map((sa) => sa.accountId);
    const uniqueAccountIds = new Set(accountIds);
    if (uniqueAccountIds.size !== accountIds.length) {
      throw new PeriodError(
        "INVALID_CATALOG_REFERENCE",
        "Duplicate stock account ID in seed bundle.",
        422
      );
    }

    const verifiedAccounts = await dbOrTrx
      .selectFrom("stock_accounts")
      .select(["id"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "in", accountIds)
      .execute();

    if (verifiedAccounts.length !== accountIds.length) {
      throw new TenantIsolationError(
        "One or more stock accounts do not exist or belong to another franchise."
      );
    }
  }

  // 3.4 Jazz DO Profiles
  if (bundle.jazzDoProfiles.length > 0) {
    const profileIds = bundle.jazzDoProfiles.map((jd) => jd.doProfileId);
    const uniqueProfileIds = new Set(profileIds);
    if (uniqueProfileIds.size !== profileIds.length) {
      throw new PeriodError(
        "INVALID_CATALOG_REFERENCE",
        "Duplicate Jazz DO profile ID in seed bundle.",
        422
      );
    }

    const verifiedProfiles = await dbOrTrx
      .selectFrom("jazz_load_do_profiles")
      .select(["id"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "in", profileIds)
      .execute();

    if (verifiedProfiles.length !== profileIds.length) {
      throw new TenantIsolationError(
        "One or more Jazz DO profiles do not exist or belong to another franchise."
      );
    }
  }

  // 4. Atomic Transaction Persistence
  const runInTrx = async (trx: Transaction<Database>) => {
    // Capture before state for audit
    const beforeFin = await trx
      .selectFrom("period_financial_seeds")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .executeTakeFirst();

    // 4.1 Upsert financial seed (ALWAYS resets is_verified = false)
    const finSeed = await trx
      .insertInto("period_financial_seeds")
      .values({
        franchise_id: franchiseId,
        period_id: periodId,
        opening_cash: bundle.financial.openingCash,
        opening_owner_balance: bundle.financial.openingOwnerBalance,
        opening_jazz_lifting: bundle.financial.openingJazzLifting,
        opening_jazz_payable: bundle.financial.openingJazzPayable,
        opening_commission_receivable: bundle.financial.openingCommissionReceivable ?? "0.00",
        source_period_key: bundle.financial.sourcePeriodKey,
        source_day_no: bundle.financial.sourceDayNo,
        is_verified: false,
        verified_by_user_id: null,
        verified_at: null,
        notes: bundle.financial.notes
      })
      .onConflict((oc) =>
        oc.columns(["franchise_id", "period_id"]).doUpdateSet({
          opening_cash: bundle.financial.openingCash,
          opening_owner_balance: bundle.financial.openingOwnerBalance,
          opening_jazz_lifting: bundle.financial.openingJazzLifting,
          opening_jazz_payable: bundle.financial.openingJazzPayable,
          opening_commission_receivable: bundle.financial.openingCommissionReceivable ?? "0.00",
          source_period_key: bundle.financial.sourcePeriodKey,
          source_day_no: bundle.financial.sourceDayNo,
          is_verified: false,
          verified_by_user_id: null,
          verified_at: null,
          notes: bundle.financial.notes,
          updated_at: sql`clock_timestamp()`
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    // 4.2 Replace Credit Party Seeds
    await trx
      .deleteFrom("period_credit_party_seeds")
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .execute();

    for (const cp of bundle.creditParties) {
      await trx
        .insertInto("period_credit_party_seeds")
        .values({
          franchise_id: franchiseId,
          period_id: periodId,
          party_id: cp.partyId,
          opening_balance: cp.openingBalance,
          source_period_key: cp.sourcePeriodKey,
          source_day_no: cp.sourceDayNo
        })
        .execute();
    }

    // 4.3 Replace Stock Product Seeds
    await trx
      .deleteFrom("period_stock_product_seeds")
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .execute();

    for (const sp of bundle.stockProducts) {
      await trx
        .insertInto("period_stock_product_seeds")
        .values({
          franchise_id: franchiseId,
          period_id: periodId,
          product_id: sp.productId,
          opening_quantity: sp.status === "skipped" ? null : sp.openingQuantity,
          status: sp.status ?? "active",
          notes: sp.notes ?? (sp.status === "skipped" ? "INTENTIONAL_GENESIS_EXCLUSION" : null),
          source_period_key: sp.sourcePeriodKey,
          source_day_no: sp.sourceDayNo
        })
        .execute();
    }

    // 4.4 Replace Stock Account Seeds
    await trx
      .deleteFrom("period_stock_account_seeds")
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .execute();

    for (const sa of bundle.stockAccounts) {
      await trx
        .insertInto("period_stock_account_seeds")
        .values({
          franchise_id: franchiseId,
          period_id: periodId,
          account_id: sa.accountId,
          opening_receivable: sa.openingReceivable,
          source_period_key: sa.sourcePeriodKey,
          source_day_no: sa.sourceDayNo
        })
        .execute();
    }

    // 4.5 Replace Jazz DO Seeds
    await trx
      .deleteFrom("period_jazz_do_seeds")
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .execute();

    for (const jd of bundle.jazzDoProfiles) {
      await trx
        .insertInto("period_jazz_do_seeds")
        .values({
          franchise_id: franchiseId,
          period_id: periodId,
          do_profile_id: jd.doProfileId,
          opening_base_balance: jd.openingBaseBalance,
          source_period_key: jd.sourcePeriodKey,
          source_day_no: jd.sourceDayNo
        })
        .execute();
    }

    // Record Audit Log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: beforeFin ? "UPDATE" : "CREATE",
      entityType: "period_seeds",
      entityId: periodId,
      beforeState: beforeFin ? { financial: beforeFin } : null,
      afterState: {
        financial: finSeed,
        creditPartiesCount: bundle.creditParties.length,
        stockProductsCount: bundle.stockProducts.length,
        stockAccountsCount: bundle.stockAccounts.length,
        jazzDoProfilesCount: bundle.jazzDoProfiles.length
      }
    });

    // If Day 1 was active, recalculate Day 1 and forward cascade
    if (isDay1Active) {
      await recalculateFromDayInternal(trx, franchiseId, day1.id, {
        triggerSource: "seed_correction",
        userId: user.id,
        allowClosedDays: true
      });
    }

    return {
      message: "Opening seed bundle staged successfully. Seeds are unverified.",
      periodId,
      isVerified: false,
      financial: finSeed,
      creditPartiesCount: bundle.creditParties.length,
      stockProductsCount: bundle.stockProducts.length,
      stockAccountsCount: bundle.stockAccounts.length,
      jazzDoProfilesCount: bundle.jazzDoProfiles.length
    };
  };

  if (customTrx) {
    return runInTrx(customTrx);
  }
  return db.transaction().execute(runInTrx);
}

/**
 * 4. Validate Complete Opening State.
 * Evaluates period existence, calendar completeness, financial seed presence,
 * active catalog completeness (stock products, stock accounts, Jazz DO profiles),
 * and provenance metadata.
 */
export async function validateSeeds(
  franchiseId: string,
  periodId: string,
  trxOrDb: Kysely<Database> | Transaction<Database> = db
): Promise<SeedValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Period existence and days check
  const period = await trxOrDb
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  const { daysInMonth } = parsePeriodKey(period.period_key);

  const days = await trxOrDb
    .selectFrom("accounting_days")
    .select(["id", "day_no", "day_type", "status", "calendar_date"])
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .orderBy("day_no", "asc")
    .execute();

  if (days.length !== daysInMonth) {
    errors.push(
      `Period calendar incomplete: expected ${daysInMonth} calendar days, found ${days.length}.`
    );
  }

  // 2. Financial Seed Check
  const finSeed = await trxOrDb
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .executeTakeFirst();

  if (!finSeed) {
    errors.push(`Missing required period_financial_seeds for period '${periodId}'.`);
  } else {
    // Numeric checks
    if (isNaN(Number(finSeed.opening_cash))) {
      errors.push("Financial seed 'opening_cash' is not a valid number.");
    }
    if (isNaN(Number(finSeed.opening_owner_balance))) {
      errors.push("Financial seed 'opening_owner_balance' is not a valid number.");
    }
    if (isNaN(Number(finSeed.opening_jazz_lifting))) {
      errors.push("Financial seed 'opening_jazz_lifting' is not a valid number.");
    }
    if (isNaN(Number(finSeed.opening_jazz_payable))) {
      errors.push("Financial seed 'opening_jazz_payable' is not a valid number.");
    }

    // Provenance check for September 2026 cutover
    if (period.period_key === "2026-09") {
      if (finSeed.source_period_key !== "2026-08" || finSeed.source_day_no !== 31) {
        errors.push(
          `Provenance error: September 2026 cutover seed must reference source_period_key '2026-08' and source_day_no 31 (found '${finSeed.source_period_key}' Day ${finSeed.source_day_no}).`
        );
      }
    }
  }

  // 3. Catalog Completeness Checks
  // 3.1 Stock Products: Every active product must have a non-negative seed
  const activeProducts = await trxOrDb
    .selectFrom("stock_products")
    .select(["id", "name", "slug"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();

  const productSeeds = await trxOrDb
    .selectFrom("period_stock_product_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  const seededProductMap = new Map(productSeeds.map((ps) => [ps.product_id, ps]));

  for (const prod of activeProducts) {
    const seed = seededProductMap.get(prod.id);
    if (!seed) {
      errors.push(`Missing required opening seed for active stock product '${prod.name}' (${prod.id}).`);
    } else if (seed.status === "skipped") {
      if (seed.opening_quantity !== null && seed.opening_quantity !== undefined) {
        errors.push(`Stock product seed for '${prod.name}' is marked SKIPPED but has non-null opening quantity (${seed.opening_quantity}).`);
      }
    } else if (seed.opening_quantity === null || seed.opening_quantity === undefined) {
      errors.push(`Stock product seed for '${prod.name}' has null opening quantity but is not marked SKIPPED.`);
    } else if (seed.opening_quantity < 0) {
      errors.push(`Stock product seed for '${prod.name}' has invalid negative quantity (${seed.opening_quantity}).`);
    }
  }

  // 3.2 Stock Accounts: Every active account must have a seed
  const activeAccounts = await trxOrDb
    .selectFrom("stock_accounts")
    .select(["id", "name", "slug"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();

  const accountSeeds = await trxOrDb
    .selectFrom("period_stock_account_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  const seededAccountMap = new Map(accountSeeds.map((sa) => [sa.account_id, sa]));

  for (const acct of activeAccounts) {
    const seed = seededAccountMap.get(acct.id);
    if (!seed) {
      errors.push(`Missing required opening seed for active stock account '${acct.name}' (${acct.id}).`);
    } else if (isNaN(Number(seed.opening_receivable))) {
      errors.push(`Stock account seed for '${acct.name}' has invalid receivable (${seed.opening_receivable}).`);
    }
  }

  // 3.3 Jazz DO Profiles: Every active DO profile must have a seed
  const activeProfiles = await trxOrDb
    .selectFrom("jazz_load_do_profiles")
    .select(["id", "do_name", "do_line"])
    .where("franchise_id", "=", franchiseId)
    .where("is_active", "=", true)
    .execute();

  const doSeeds = await trxOrDb
    .selectFrom("period_jazz_do_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  const seededDoMap = new Map(doSeeds.map((jd) => [jd.do_profile_id, jd]));

  for (const prof of activeProfiles) {
    const seed = seededDoMap.get(prof.id);
    if (!seed) {
      errors.push(`Missing required opening seed for active Jazz DO profile '${prof.do_name}' (${prof.id}).`);
    } else if (isNaN(Number(seed.opening_base_balance))) {
      errors.push(`Jazz DO seed for '${prof.do_name}' has invalid base balance (${seed.opening_base_balance}).`);
    }
  }

  // 3.4 Credit Parties: Check validity of seeded parties (pruning of unseeded/inactive is allowed)
  const creditSeeds = await trxOrDb
    .selectFrom("period_credit_party_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  for (const cs of creditSeeds) {
    if (isNaN(Number(cs.opening_balance))) {
      errors.push(`Credit party seed (${cs.party_id}) has invalid balance (${cs.opening_balance}).`);
    }
  }

  const isValid = errors.length === 0;

  return {
    isValid,
    periodId,
    errors,
    warnings
  };
}

/**
 * 5. Seed Verification Operation (Owner Only).
 * Runs full validation, executes Day 1 baseline calculation with zero operational
 * transactions, verifies Opening == Closing on Day 1 across all domains,
 * and flags `is_verified = true`.
 */
export async function verifySeeds(
  franchiseId: string,
  periodId: string,
  user: PeriodServiceUser,
  customTrx?: Transaction<Database>
) {
  if (user.role !== "owner") {
    throw new PeriodError("FORBIDDEN", "Only the franchise owner can verify opening seeds.", 403);
  }

  const runInTrx = async (trx: Transaction<Database>) => {
    // 1. Run seed validation
    const validation = await validateSeeds(franchiseId, periodId, trx);
    if (!validation.isValid) {
      throw new SeedValidationFailedError(validation.errors, validation.warnings);
    }

    // 2. Fetch Day 1
    const day1 = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", "=", 1)
      .executeTakeFirst();

    if (!day1) {
      throw new PeriodNotReadyError("Day 1 does not exist for this period.");
    }

    // 3. Run Day 1 baseline calculation (zero transactions expected)
    const calcResult = await calculateDayInternal(trx, franchiseId, day1.id, null, {
      triggerSource: "seed_verification",
      allowClosedDays: true,
      userId: user.id
    });

    // 4. Fetch the seed values to verify mathematical identity
    const finSeed = await trx
      .selectFrom("period_financial_seeds")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .executeTakeFirstOrThrow();

    // Verify Day 1 Financial Identity: Opening === Closing, Issues === 0, Expenses === 0, Profit === 0
    if (calcResult.financial.totalIssues !== 0 || calcResult.financial.totalExpenses !== 0) {
      throw new PeriodError(
        "DAY_ACTIVATION_BLOCKED",
        "Day 1 baseline calculation detected non-zero operational movements during seed verification.",
        422
      );
    }

    if (calcResult.financial.openingCash !== Number(finSeed.opening_cash)) {
      throw new PeriodError(
        "DAY_ACTIVATION_BLOCKED",
        `Day 1 opening cash (${calcResult.financial.openingCash}) does not match seed (${finSeed.opening_cash}).`,
        422
      );
    }

    // Closing cash identity check.
    // Standard expectation: Day 1 has no operational transactions, so
    //   closingCash === openingCash.
    //
    // Exception: a commission settlement receipt for the prior period may
    // legitimately be recorded on Day 1 before seed verification (this is the
    // core use-case of the staged-period settlement fix).  Settlement receipts
    // are NOT operational movements (they are excluded from totalIssues and
    // totalExpenses), but they DO flow into closingCash.  If settlement receipts
    // are present on Day 1, the correct expected closing cash is:
    //   openingCash + settlementReceipts
    // which is exactly what calculateDayInternal already computes.
    // The financial identity (no double-counting) is preserved because
    // totalIssues === 0 check above already caught any operational revenue.
    const settlementReceiptsOnDay1 = calcResult.financial.commissionSettlementReceipts ?? 0;
    const expectedClosingCashForVerification = calcResult.financial.openingCash + settlementReceiptsOnDay1;
    if (calcResult.financial.closingCash !== expectedClosingCashForVerification) {
      throw new PeriodError(
        "DAY_ACTIVATION_BLOCKED",
        `Day 1 closing cash (${calcResult.financial.closingCash}) does not equal expected (${expectedClosingCashForVerification}) [openingCash=${calcResult.financial.openingCash} + settlementReceipts=${settlementReceiptsOnDay1}].`,
        422
      );
    }

    // 5. Mark financial seed as verified
    await trx
      .updateTable("period_financial_seeds")
      .set({
        is_verified: true,
        verified_by_user_id: user.id,
        verified_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`
      })
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .execute();

    // 6. Record governance audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "period_financial_seeds",
      entityId: finSeed.id,
      afterState: {
        is_verified: true,
        verified_at: new Date().toISOString(),
        day1BaselineProjections: {
          openingCash: calcResult.financial.openingCash,
          closingCash: calcResult.financial.closingCash,
          operatingProfit: calcResult.financial.operatingProfit,
          ownerClosingBalance: calcResult.financial.ownerClosingBalance,
          jazzLifting: calcResult.jazzLifting.closingLiftingInHand
        }
      }
    });

    return {
      verified: true,
      message: "Opening seed bundle successfully verified. Day 1 baseline calculation proved.",
      periodId,
      verifiedAt: new Date().toISOString(),
      baselineSummary: {
        openingCash: calcResult.financial.openingCash,
        closingCash: calcResult.financial.closingCash,
        operatingProfit: calcResult.financial.operatingProfit,
        ownerClosingBalance: calcResult.financial.ownerClosingBalance,
        jazzPayable: calcResult.financial.closingJazzPayable,
        jazzLifting: calcResult.jazzLifting.closingLiftingInHand,
        stockProductsCount: calcResult.stockProducts.length,
        stockAccountsCount: calcResult.stockAccounts.length,
        jazzDoProfilesCount: calcResult.jazzDo.length,
        creditPartiesCount: calcResult.creditParties.length
      }
    };
  };

  if (customTrx) {
    return runInTrx(customTrx);
  }
  return db.transaction().execute(runInTrx);
}

/**
 * 6. Period Activation Operation (Owner Only).
 * Transitions Day 1 status from `closed` to `open`.
 * Days 2..30 strictly remain `closed`.
 */
export async function activatePeriod(
  franchiseId: string,
  periodId: string,
  user: PeriodServiceUser,
  customTrx?: Transaction<Database>
) {
  if (user.role !== "owner") {
    throw new PeriodError("FORBIDDEN", "Only the franchise owner can activate accounting periods.", 403);
  }

  const runInTrx = async (trx: Transaction<Database>) => {
    // 1. Period verification
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  // 2. Financial Seed Verification Check
  const finSeed = await trx
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .executeTakeFirst();

  if (!finSeed) {
    throw new MissingFinancialSeedError(periodId);
  }

  if (!finSeed.is_verified) {
    throw new SeedsNotVerifiedError(periodId);
  }

  // 3. Validation Check
  const validation = await validateSeeds(franchiseId, periodId, trx);
  if (!validation.isValid) {
    throw new SeedValidationFailedError(validation.errors, validation.warnings);
  }

  // 3B. Enforce Previous Period Settlement Governance (if derived from prior period)
  if (finSeed.source_period_key) {
    const prevPeriod = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_key", "=", finSeed.source_period_key)
      .executeTakeFirst();

    if (prevPeriod && prevPeriod.final_settlement_status !== "VERIFIED" && prevPeriod.status !== "closed") {
      throw new PeriodNotReadyError(
        `Cannot activate period '${period.period_key}': Previous period '${prevPeriod.period_key}' FINAL settlement status is '${prevPeriod.final_settlement_status}'. It must be VERIFIED or CLOSED first.`
      );
    }
  }

  // 4. Fetch Day 1
  const day1 = await trx
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .where("day_no", "=", 1)
    .executeTakeFirst();

  if (!day1) {
    throw new PeriodNotReadyError("Day 1 does not exist for this period.");
  }

  if (day1.status === "open") {
    return {
      activated: true,
      message: "Day 1 is already open. Period is actively operational.",
      periodId,
      day1Id: day1.id,
      day1: {
        id: day1.id,
        dayNo: day1.day_no,
        status: day1.status,
        calendarDate: day1.calendar_date
      },
      dayNo: 1,
      status: "open"
    };
  }

  // 5. Baseline Calculation
  await calculateDayInternal(trx, franchiseId, day1.id, null, {
    triggerSource: "period_activation",
    allowClosedDays: true,
    userId: user.id
  });

  // 6. Transition Day 1 from closed to open
  await trx
    .updateTable("accounting_days")
    .set({
      status: "open",
      reopened_at: sql`clock_timestamp()`,
      reopened_by_user_id: user.id,
      updated_at: sql`clock_timestamp()`
    })
    .where("id", "=", day1.id)
    .where("franchise_id", "=", franchiseId)
    .execute();

  // 7. Record Governance Audit Log
  await recordAuditLog(trx, {
    franchiseId,
    userId: user.id,
    userEmail: user.email,
    action: "UPDATE",
    entityType: "accounting_day",
    entityId: day1.id,
    afterState: {
      periodId,
      dayNo: 1,
      status: "open",
      activatedAt: new Date().toISOString(),
      days2Through30Status: "closed"
    }
  });

    return {
      activated: true,
      message: "Day 1 successfully activated. Days 2-30 remain closed until opened individually.",
      periodId,
      day1: {
        id: day1.id,
        dayNo: 1,
        status: "open",
        calendarDate: day1.calendar_date
      }
    };
  };

  if (customTrx) {
    return runInTrx(customTrx);
  }
  return db.transaction().execute(runInTrx);
}

/**
 * 7. Fetch all staged opening seeds for a period.
 */
export async function getSeeds(franchiseId: string, periodId: string) {
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  const financial = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .executeTakeFirst();

  const creditParties = await db
    .selectFrom("period_credit_party_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  const stockProducts = await db
    .selectFrom("period_stock_product_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  const stockAccounts = await db
    .selectFrom("period_stock_account_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  const jazzDoProfiles = await db
    .selectFrom("period_jazz_do_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .execute();

  return {
    periodId,
    isVerified: financial?.is_verified ?? false,
    verifiedAt: financial?.verified_at ?? null,
    verifiedByUserId: financial?.verified_by_user_id ?? null,
    seeds: {
      financial: financial ?? null,
      creditParties,
      stockProducts,
      stockAccounts,
      jazzDoProfiles
    }
  };
}

/**
 * 8. Close an Active Accounting Day.
 * Locks the day, enforces authoritative recalculation, verifies invariants,
 * transitions status to 'closed', records audit log, and saves idempotency.
 */
export async function closeAccountingDay(
  franchiseId: string,
  periodId: string,
  dayNo: number,
  notes: string | null = null,
  user: PeriodServiceUser,
  clientMutationId?: string
) {
  const payloadHash = computePayloadHash({ periodId, dayNo, notes });

  if (clientMutationId) {
    const idemp = await checkIdempotency(db, franchiseId, clientMutationId, payloadHash);
    if (idemp.isDuplicate) {
      return idemp.body as any;
    }
  }

  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .select(["id", "period_key", "status"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

    if (!period) {
      throw new PeriodNotFoundError(periodId);
    }

    if (dayNo >= 32) {
      throw new PeriodError(
        "INVALID_OPERATIONAL_DAY",
        `Day ${dayNo} is not an operational accounting day. FINAL is a month-end closing snapshot and cannot be modified via daily operational controls.`,
        422,
        { dayNo, periodId }
      );
    }

    if (period.status === "closed") {
      throw new PeriodAlreadyClosedError(period.period_key);
    }

    const day = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", "=", dayNo)
      .forUpdate()
      .executeTakeFirst();

    if (!day) {
      throw new DayNotFoundError(dayNo, periodId);
    }

    if (day.status === "closed") {
      throw new DayAlreadyClosedError(dayNo, { periodId, calendarDate: day.calendar_date });
    }

    // Recalculate Day projections to verify calculations and invariants before closing
    const calcResult = await calculateDayInternal(trx, franchiseId, day.id, null, {
      triggerSource: "day_close",
      allowClosedDays: true,
      userId: user.id
    });

    const criticalViolations = calcResult.violations.filter((v) => v.severity === "critical");
    if (criticalViolations.length > 0) {
      throw new InvariantViolationError(
        criticalViolations[0].invariantCode,
        `Cannot close day ${dayNo} due to critical invariant violation: ${criticalViolations[0].message}`
      );
    }

    // Update day status to closed
    await trx
      .updateTable("accounting_days")
      .set({
        status: "closed",
        closed_at: sql`clock_timestamp()`,
        closed_by_user_id: user.id,
        notes: notes !== null ? notes : day.notes,
        updated_at: sql`clock_timestamp()`
      })
      .where("id", "=", day.id)
      .execute();

    // Record audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "accounting_day",
      entityId: day.id,
      afterState: {
        periodId,
        dayNo,
        status: "closed",
        closedAt: new Date().toISOString(),
        closedBy: user.email,
        notes
      }
    });

    const result = {
      closed: true,
      periodId,
      dayNo,
      status: "closed",
      day: {
        id: day.id,
        dayNo,
        status: "closed"
      },
      closedAt: new Date().toISOString(),
      summary: {
        closingCash: calcResult.financial.closingCash,
        ownerClosingBalance: calcResult.financial.ownerClosingBalance,
        closingJazzPayable: calcResult.financial.closingJazzPayable,
        closingJazzLifting: calcResult.jazzLifting.closingLiftingInHand
      }
    };

    if (clientMutationId) {
      await saveIdempotencyRecord(trx, {
        franchiseId,
        clientMutationId,
        userId: user.id,
        endpoint: `POST /api/v1/periods/${periodId}/days/${dayNo}/close`,
        payloadHash,
        responseStatus: 200,
        responseBody: result
      });
    }

    return result;
  });
}

/**
 * 9. Open Next Accounting Day.
 * Strictly enforces sequential day progression: Day N+1 cannot open until Day N is closed.
 * Enforces maximum one open day per period.
 * Materializes Day N+1 baseline projections from Day N closing projections.
 */
export async function openNextAccountingDay(
  franchiseId: string,
  periodId: string,
  dayNo: number,
  notes: string | null = null,
  user: PeriodServiceUser,
  clientMutationId?: string
) {
  if (dayNo <= 1) {
    throw new NonSequentialDayError("Day 1 must be opened via period activation after seed verification.");
  }

  const payloadHash = computePayloadHash({ periodId, dayNo, notes });

  if (clientMutationId) {
    const idemp = await checkIdempotency(db, franchiseId, clientMutationId, payloadHash);
    if (idemp.isDuplicate) {
      return idemp.body as any;
    }
  }

  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .select(["id", "period_key", "status"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

    if (!period) {
      throw new PeriodNotFoundError(periodId);
    }

    if (dayNo >= 32) {
      throw new PeriodError(
        "INVALID_OPERATIONAL_DAY",
        `Day ${dayNo} is not an operational accounting day. FINAL is a month-end closing snapshot and cannot be modified via daily operational controls.`,
        422,
        { dayNo, periodId }
      );
    }

    if (period.status === "closed") {
      throw new PeriodAlreadyClosedError(period.period_key);
    }

    // 1. Assert Day N-1 is closed
    const prevDay = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", "=", dayNo - 1)
      .forUpdate()
      .executeTakeFirst();

    if (!prevDay) {
      throw new DayNotFoundError(dayNo - 1, periodId);
    }

    if (prevDay.status !== "closed") {
      throw new PreviousDayNotClosedError(dayNo - 1, {
        dayNo,
        previousDayStatus: prevDay.status
      });
    }

    // 2. Assert NO other day is currently open or reopened
    const openDay = await trx
      .selectFrom("accounting_days")
      .select(["id", "day_no", "status"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("status", "in", ["open", "reopen"])
      .executeTakeFirst();

    if (openDay) {
      throw new MultipleOpenDaysError(openDay.day_no, {
        targetDayNo: dayNo,
        currentOpenDayNo: openDay.day_no
      });
    }

    // 3. Fetch target Day N
    const targetDay = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", "=", dayNo)
      .forUpdate()
      .executeTakeFirst();

    if (!targetDay) {
      throw new DayNotFoundError(dayNo, periodId);
    }

    if (targetDay.status === "open") {
      return {
        opened: true,
        periodId,
        dayNo,
        status: "open",
        calendarDate: targetDay.calendar_date
      };
    }

    // 4. Baseline calculation for Day N (inheriting Day N-1 closing projections)
    await calculateDayInternal(trx, franchiseId, targetDay.id, null, {
      triggerSource: "day_open",
      allowClosedDays: true,
      userId: user.id
    });

    // 5. Transition Day N to open
    await trx
      .updateTable("accounting_days")
      .set({
        status: "open",
        reopened_at: sql`clock_timestamp()`,
        reopened_by_user_id: user.id,
        notes: notes !== null ? notes : targetDay.notes,
        updated_at: sql`clock_timestamp()`
      })
      .where("id", "=", targetDay.id)
      .execute();

    // 6. Record audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "accounting_day",
      entityId: targetDay.id,
      afterState: {
        periodId,
        dayNo,
        status: "open",
        openedAt: new Date().toISOString(),
        openedBy: user.email,
        inheritedFromDayNo: dayNo - 1
      }
    });

    const result = {
      opened: true,
      periodId,
      dayNo,
      status: "open",
      day: {
        id: targetDay.id,
        dayNo,
        status: "open"
      },
      calendarDate: targetDay.calendar_date
    };

    if (clientMutationId) {
      await saveIdempotencyRecord(trx, {
        franchiseId,
        clientMutationId,
        userId: user.id,
        endpoint: `POST /api/v1/periods/${periodId}/days/${dayNo}/open`,
        payloadHash,
        responseStatus: 200,
        responseBody: result
      });
    }

    return result;
  });
}

/**
 * 10. Reopen a Closed Accounting Day (Owner Only).
 * Requires explicit reason. Enforces single open day invariant: any currently open day must be closed first.
 * Enforces that all days subsequent to dayNo in this period are closed.
 */
export async function reopenAccountingDay(
  franchiseId: string,
  periodId: string,
  dayNo: number,
  reason: string,
  user: PeriodServiceUser
) {
  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .select(["id", "period_key", "status"])
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

    if (!period) {
      throw new PeriodNotFoundError(periodId);
    }

    if (dayNo >= 32) {
      throw new PeriodError(
        "INVALID_OPERATIONAL_DAY",
        `Day ${dayNo} is not an operational accounting day. FINAL is a month-end closing snapshot and cannot be reopened. Reopen an operational day (such as Day 31) to make corrections.`,
        422,
        { dayNo, periodId }
      );
    }

    if (period.status === "closed") {
      throw new PeriodAlreadyClosedError(period.period_key);
    }

    // Assert NO other day is currently open or reopened
    const openDay = await trx
      .selectFrom("accounting_days")
      .select(["id", "day_no", "status"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("status", "in", ["open", "reopen"])
      .executeTakeFirst();

    if (openDay) {
      throw new MultipleOpenDaysError(openDay.day_no, {
        message: `Cannot reopen day ${dayNo} while day ${openDay.day_no} is currently open. Close day ${openDay.day_no} first.`
      });
    }

    // Assert all days > dayNo in this period are closed
    const unclosedFutureDays = await trx
      .selectFrom("accounting_days")
      .select(["day_no"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", ">", dayNo)
      .where("status", "!=", "closed")
      .execute();

    if (unclosedFutureDays.length > 0) {
      throw new NonSequentialDayError(
        `Cannot reopen day ${dayNo} while subsequent days (${unclosedFutureDays.map((d) => d.day_no).join(", ")}) are unclosed.`
      );
    }

    const targetDay = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", "=", dayNo)
      .forUpdate()
      .executeTakeFirst();

    if (!targetDay) {
      throw new DayNotFoundError(dayNo, periodId);
    }

    await trx
      .updateTable("accounting_days")
      .set({
        status: "reopen",
        reopened_at: sql`clock_timestamp()`,
        reopened_by_user_id: user.id,
        notes: reason,
        updated_at: sql`clock_timestamp()`
      })
      .where("id", "=", targetDay.id)
      .execute();

    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "accounting_day",
      entityId: targetDay.id,
      afterState: {
        periodId,
        dayNo,
        status: "reopen",
        reason,
        reopenedAt: new Date().toISOString(),
        reopenedBy: user.email
      }
    });

    return {
      reopened: true,
      periodId,
      dayNo,
      status: "reopen",
      day: {
        id: targetDay.id,
        dayNo,
        status: "reopen"
      },
      calendarDate: targetDay.calendar_date
    };
  });
}

/**
 * 11B. Verify Month-End FINAL Settlement (Owner Only).
 * Transitions FINAL status from PENDING_SETTLEMENT to VERIFIED.
 * Requires:
 * - Final operational day closed
 * - Zero critical invariant violations
 * - Commission receivable settled to 0 (or explicitly accepted)
 */
export async function verifyPeriodFinalSettlement(
  franchiseId: string,
  periodId: string,
  user: PeriodServiceUser,
  options?: { allowOutstanding?: boolean; notes?: string }
) {
  if (user.role !== "owner") {
    throw new PeriodError("FORBIDDEN", "Only the franchise owner can verify month-end FINAL settlement.", 403);
  }

  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .forUpdate()
      .executeTakeFirst();

    if (!period) {
      throw new PeriodNotFoundError(periodId);
    }

    if (period.status === "closed") {
      throw new PeriodAlreadyClosedError(period.period_key);
    }

    // 1. Assert final operational day is closed
    const prevDays = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .orderBy("day_no", "desc")
      .execute();

    if (prevDays.length === 0) {
      throw new PeriodNotReadyError(`Period '${period.period_key}' has no provisioned days.`);
    }

    const finalDay = prevDays[0];
    if (finalDay.status !== "closed") {
      throw new PeriodNotReadyError(
        `Cannot verify FINAL for period '${period.period_key}': Final operational day (${finalDay.day_no}) must be closed first.`
      );
    }

    // 2. Assert zero critical invariant violations
    const violations = await trx
      .selectFrom("invariant_violations")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("severity", "=", "critical")
      .execute();

    if (violations.length > 0) {
      throw new PeriodNotReadyError(
        `Cannot verify FINAL for period '${period.period_key}' with ${violations.length} unresolved critical invariant violation(s).`
      );
    }

    // 3. Check settlement reconciliation across all domains
    const finalClosing = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);
    if (!finalClosing) {
      throw new PeriodNotReadyError(`Cannot verify FINAL for period '${period.period_key}': Projections could not be loaded.`);
    }

    const { totalOutstanding, allResolved } = finalClosing.finalSettlements;
    const outstandingNum = Number(totalOutstanding);

    if (!allResolved && outstandingNum > 0 && !options?.allowOutstanding) {
      throw new PeriodNotReadyError(
        `Cannot verify FINAL for period '${period.period_key}': Outstanding balance of ${totalOutstanding} remains unresolved across settlement domains. Settle all outstanding amounts or explicitly accept.`
      );
    }

    // 4. Update accounting_periods
    await trx
      .updateTable("accounting_periods")
      .set({
        final_settlement_status: "VERIFIED",
        final_verified_at: sql`clock_timestamp()`,
        final_verified_by_user_id: user.id,
        final_notes: options?.notes ?? null,
        updated_at: sql`clock_timestamp()`
      })
      .where("id", "=", period.id)
      .execute();

    // 5. Record audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "accounting_period_final",
      entityId: period.id,
      afterState: {
        periodKey: period.period_key,
        final_settlement_status: "VERIFIED",
        verifiedBy: user.email,
        totalOutstanding,
        allResolved
      }
    });

    return {
      verified: true,
      periodId: period.id,
      periodKey: period.period_key,
      status: "VERIFIED",
      verifiedAt: new Date().toISOString()
    };
  });
}

/**
 * 11. Close an Accounting Period (Owner Only).
 * Requires all days in the period to be closed, FINAL to be VERIFIED, and zero unresolved critical invariant violations.
 */
export async function closeAccountingPeriod(
  franchiseId: string,
  periodId: string,
  notes: string | null = null,
  user: PeriodServiceUser,
  clientMutationId?: string,
  customTrx?: Transaction<Database>
) {
  const payloadHash = computePayloadHash({ periodId, notes });

  if (clientMutationId && !customTrx) {
    const idemp = await checkIdempotency(db, franchiseId, clientMutationId, payloadHash);
    if (idemp.isDuplicate) {
      return idemp.body as any;
    }
  }

  const runInTrx = async (trx: Transaction<Database>) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .forUpdate()
      .executeTakeFirst();

    if (!period) {
      throw new PeriodNotFoundError(periodId);
    }

    const { nextPeriodKey, daysInNextMonth } = getNextPeriodKey(period.period_key);

    // Idempotency check: if period is already closed, check if next period is already active
    if (period.status === "closed") {
      const existingNextPeriod = await trx
        .selectFrom("accounting_periods")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("period_key", "=", nextPeriodKey)
        .executeTakeFirst();

      if (existingNextPeriod) {
        const day1 = await trx
          .selectFrom("accounting_days")
          .selectAll()
          .where("franchise_id", "=", franchiseId)
          .where("period_id", "=", existingNextPeriod.id)
          .where("day_no", "=", 1)
          .executeTakeFirst();

        if (day1 && day1.status === "open") {
          return {
            closed: true,
            alreadyClosed: true,
            periodId: period.id,
            periodKey: period.period_key,
            status: "closed",
            period: {
              id: period.id,
              periodKey: period.period_key,
              status: "closed"
            },
            closedAt: period.closed_at ? new Date(period.closed_at).toISOString() : new Date().toISOString(),
            targetPeriod: {
              id: existingNextPeriod.id,
              periodKey: existingNextPeriod.period_key,
              daysCount: daysInNextMonth
            },
            targetDayNo: 1,
            activatedDay: {
              id: day1.id,
              dayNo: 1,
              status: day1.status,
              calendarDate: day1.calendar_date
            }
          };
        }
      }
      // If next period is not yet initialized or Day 1 is not yet open, proceed to complete rollover & activation!
    } else {
      // 1. Assert all days are closed
      const unclosedDays = await trx
        .selectFrom("accounting_days")
        .select(["day_no", "status"])
        .where("franchise_id", "=", franchiseId)
        .where("period_id", "=", periodId)
        .where("status", "!=", "closed")
        .execute();

      if (unclosedDays.length > 0) {
        throw new PeriodHasOpenDaysError(unclosedDays.length, {
          unclosedDayNumbers: unclosedDays.map((d) => d.day_no)
        });
      }

      // 2. Assert zero unresolved critical invariant violations
      const violations = await trx
        .selectFrom("invariant_violations")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("period_id", "=", periodId)
        .where("severity", "=", "critical")
        .execute();

      if (violations.length > 0) {
        throw new PeriodNotReadyError(
          `Cannot close period '${period.period_key}' with ${violations.length} unresolved critical invariant violation(s).`
        );
      }

      // 3. Assert Month-End FINAL Settlement is VERIFIED or all pending commission/settlement obligations resolved
      if (period.final_settlement_status !== "VERIFIED") {
        const finalClosing = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);
        if (!finalClosing) {
          throw new PeriodNotReadyError(`Cannot close period '${period.period_key}': Projections could not be loaded.`);
        }

        const commReceivable = Number(finalClosing.commissionSettlement?.outstandingCommissionReceivable ?? 0);
        if (commReceivable > 0) {
          throw new PeriodNotReadyError(
            `Cannot close period '${period.period_key}': Outstanding commission receivable of ${commReceivable} remains unsettled. Settle commission or verify FINAL first.`
          );
        }

        const closingCash = Number(finalClosing.closingBalances.financial.closingCash);
        if (closingCash < 0) {
          throw new PeriodNotReadyError(
            `Cannot close period '${period.period_key}': Closing cash is negative (${closingCash}). Record a cash settlement on FINAL or verify FINAL first.`
          );
        }

        if (finalClosing.finalSettlements.entries.length > 0 && !finalClosing.finalSettlements.allResolved) {
          throw new PeriodNotReadyError(
            `Cannot close period '${period.period_key}': Active settlement entries exist but remaining balances are not fully resolved. Verify FINAL first.`
          );
        }
      }

      // 4. Update period status to closed
      await trx
        .updateTable("accounting_periods")
        .set({
          status: "closed",
          final_settlement_status: "CLOSED",
          closed_at: sql`clock_timestamp()`,
          closed_by_user_id: user.id,
          updated_at: sql`clock_timestamp()`
        })
        .where("id", "=", period.id)
        .execute();

      // Record audit log for period close
      await recordAuditLog(trx, {
        franchiseId,
        userId: user.id,
        userEmail: user.email,
        action: "UPDATE",
        entityType: "accounting_period",
        entityId: period.id,
        afterState: {
          periodKey: period.period_key,
          status: "closed",
          closedAt: new Date().toISOString(),
          closedBy: user.email,
          notes
        }
      });
    }

    // 5. ATOMIC TRANSITION: Rollover -> Seed Verification -> Day 1 Activation
    // 5.1 Execute rolloverPeriod within the same atomic transaction
    const rollRes = await rolloverPeriod(franchiseId, period.id, user, undefined, trx);

    // Check if target period is already verified or active
    const targetFinSeed = await trx
      .selectFrom("period_financial_seeds")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", rollRes.targetPeriod.id)
      .executeTakeFirst();

    const targetDay1 = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", rollRes.targetPeriod.id)
      .where("day_no", "=", 1)
      .executeTakeFirst();

    // 5.2 Execute verifySeeds for target period if not already verified
    if (!targetFinSeed?.is_verified && targetDay1?.status !== "open") {
      await verifySeeds(franchiseId, rollRes.targetPeriod.id, user, trx);
    }

    // 5.3 Execute activatePeriod for target period within the same atomic transaction
    const actRes = await activatePeriod(franchiseId, rollRes.targetPeriod.id, user, trx);

    // 5.4 Record governance lifecycle transition audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "period_lifecycle_transition",
      entityId: period.id,
      afterState: {
        fromPeriod: period.period_key,
        toPeriod: rollRes.targetPeriod.periodKey,
        transition: "MONTH_CLOSE_AUTO_ROLLOVER_ACTIVATION",
        activatedDay: actRes.day1?.dayNo,
        timestamp: new Date().toISOString()
      }
    });

    const result = {
      closed: true,
      periodId: period.id,
      periodKey: period.period_key,
      status: "closed",
      period: {
        id: period.id,
        periodKey: period.period_key,
        status: "closed"
      },
      closedAt: period.closed_at ? new Date(period.closed_at).toISOString() : new Date().toISOString(),
      targetPeriod: {
        id: rollRes.targetPeriod.id,
        periodKey: rollRes.targetPeriod.periodKey,
        daysCount: rollRes.targetPeriod.daysCount
      },
      targetDayNo: 1,
      activatedDay: actRes.day1 ? {
        id: actRes.day1.id,
        dayNo: actRes.day1.dayNo,
        status: actRes.day1.status,
        calendarDate: actRes.day1.calendarDate
      } : {
        id: "",
        dayNo: 1,
        status: "open" as const,
        calendarDate: ""
      }
    };

    if (clientMutationId && !customTrx) {
      await saveIdempotencyRecord(trx, {
        franchiseId,
        clientMutationId,
        userId: user.id,
        endpoint: `POST /api/v1/periods/${periodId}/close`,
        payloadHash,
        responseStatus: 200,
        responseBody: result
      });
    }

    return result;
  };

  if (customTrx) {
    return runInTrx(customTrx);
  }
  return db.transaction().execute(runInTrx);
}

/**
 * 12. Governed Month Rollover (Owner Only).
 * Requires previous period to be fully closed.
 * Dynamically provisions next calendar period (e.g. 31 days for Oct) with all days closed.
 * Generates an independent opening seed snapshot from previous period's final day materialized projections.
 */
export async function rolloverPeriod(
  franchiseId: string,
  previousPeriodId: string,
  user: PeriodServiceUser,
  clientMutationId?: string,
  customTrx?: Transaction<Database>
) {
  const payloadHash = computePayloadHash({ previousPeriodId });

  if (clientMutationId && !customTrx) {
    const idemp = await checkIdempotency(db, franchiseId, clientMutationId, payloadHash);
    if (idemp.isDuplicate) {
      return idemp.body as any;
    }
  }

  const runInTrx = async (trx: Transaction<Database>) => {
    const prevPeriod = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", previousPeriodId)
      .forUpdate()
      .executeTakeFirst();

    if (!prevPeriod) {
      throw new PeriodNotFoundError(previousPeriodId);
    }

    if (prevPeriod.status !== "closed") {
      const unclosedDays = await trx
        .selectFrom("accounting_days")
        .select(["day_no"])
        .where("franchise_id", "=", franchiseId)
        .where("period_id", "=", prevPeriod.id)
        .where("status", "!=", "closed")
        .execute();

      if (unclosedDays.length > 0) {
        throw new PeriodNotClosedError(prevPeriod.period_key, {
          reason: `Previous period '${prevPeriod.period_key}' has unclosed operational days (${unclosedDays.map((d) => d.day_no).join(", ")}). All operational days must be closed before staging rollover.`
        });
      }
    }

    // Derive next period key generically
    const { nextPeriodKey, daysInNextMonth } = getNextPeriodKey(prevPeriod.period_key);
    const { year: nextYear, month: nextMonth, label: nextLabel } = parsePeriodKey(nextPeriodKey);

    // Fetch previous period's final day
    const prevDays = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", prevPeriod.id)
      .orderBy("day_no", "desc")
      .execute();

    if (prevDays.length === 0) {
      throw new PeriodNotReadyError(`Previous period '${prevPeriod.period_key}' has no provisioned days.`);
    }

    const prevFinalDay = prevDays[0];
    if (prevFinalDay.status !== "closed") {
      throw new PeriodNotReadyError(
        `Cannot rollover period '${prevPeriod.period_key}': Final operational day ${prevFinalDay.day_no} must be closed first.`
      );
    }

    // Check if next period already exists
    let nextPeriod = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_key", "=", nextPeriodKey)
      .executeTakeFirst();

    if (nextPeriod) {
      const existingSeeds = await trx
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("franchise_id", "=", franchiseId)
        .where("period_id", "=", nextPeriod.id)
        .executeTakeFirst();

      if (
        existingSeeds &&
        existingSeeds.source_period_key === prevPeriod.period_key &&
        existingSeeds.notes?.startsWith(`ROLLED_FORWARD_FROM_${prevPeriod.period_key}`)
      ) {
        return {
          created: false,
          rolloverAlreadyComplete: true,
          period: nextPeriod,
          daysCount: daysInNextMonth,
          sourcePeriodKey: prevPeriod.period_key,
          sourceDayNo: prevFinalDay.day_no,
          message: `Rollover already executed for ${nextPeriodKey}.`,
          sourcePeriod: {
            id: prevPeriod.id,
            periodKey: prevPeriod.period_key
          },
          targetPeriod: {
            id: nextPeriod.id,
            periodKey: nextPeriodKey,
            daysCount: daysInNextMonth
          }
        };
      }
    } else {
      nextPeriod = await trx
        .insertInto("accounting_periods")
        .values({
          franchise_id: franchiseId,
          period_key: nextPeriodKey,
          year_num: nextYear,
          month_num: nextMonth,
          label: nextLabel,
          status: "open"
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // Provision child calendar days (all closed)
      const dayValues = [];
      for (let d = 1; d <= daysInNextMonth; d++) {
        const dStr = String(d).padStart(2, "0");
        const mStr = String(nextMonth).padStart(2, "0");
        const calDate = `${nextYear}-${mStr}-${dStr}`;
        dayValues.push({
          franchise_id: franchiseId,
          period_id: nextPeriod.id,
          day_no: d,
          day_type: "calendar" as const,
          calendar_date: calDate,
          label: `Day ${d}`,
          status: "closed" as const
        });
      }

      await trx
        .insertInto("accounting_days")
        .values(dayValues)
        .onConflict((oc) => oc.columns(["franchise_id", "period_id", "day_no"]).doNothing())
        .execute();

      await recordAuditLog(trx, {
        franchiseId,
        userId: user.id,
        userEmail: user.email,
        action: "CREATE",
        entityType: "accounting_period",
        entityId: nextPeriod.id,
        afterState: {
          periodKey: nextPeriodKey,
          daysProvisioned: daysInNextMonth,
          sourcePeriodKey: prevPeriod.period_key
        }
      });
    }

    // Extract authoritative month-end FINAL closing state
    const finalClosing = await getPeriodFinalProjectionsInternal(trx, franchiseId, prevPeriod.id);
    if (!finalClosing) {
      throw new PeriodNotReadyError(
        `Cannot rollover period '${prevPeriod.period_key}': no final closing projections found.`
      );
    }

    const seedBundle = finalClosing.seedBundle;

    // Stage seeds into next period
    await stageSeeds(franchiseId, nextPeriod.id, seedBundle, user, trx);

    // Link active commission final settlement entries to target days
    const activeCommSettlements = await trx
      .selectFrom("final_settlement_entries")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", prevPeriod.id)
      .where("balance_domain", "=", "COMMISSION_RECEIVABLE")
      .where("status", "=", "ACTIVE")
      .execute();

    const targetDays = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", nextPeriod.id)
      .execute();

    for (const fse of activeCommSettlements) {
      const fseDate = formatSettlementDate(fse.settlement_date);
      const targetDay = targetDays.find((d) => d.calendar_date === fseDate) || targetDays.find((d) => d.day_no === 1);
      if (targetDay) {
        const existingReceipt = await trx
          .selectFrom("commission_settlement_receipts")
          .selectAll()
          .where("franchise_id", "=", franchiseId)
          .where("final_settlement_entry_id", "=", fse.id)
          .executeTakeFirst();

        if (!existingReceipt) {
          await trx.insertInto("commission_settlement_receipts").values({
            franchise_id: franchiseId,
            day_id: targetDay.id,
            source_period_key: prevPeriod.period_key,
            amount: fse.amount,
            notes: fse.notes,
            final_settlement_entry_id: fse.id
          }).execute();
        }

        await trx.updateTable("final_settlement_entries")
          .set({ target_day_id: targetDay.id })
          .where("id", "=", fse.id)
          .execute();
      }
    }

    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "CREATE",
      entityType: "rollover",
      entityId: nextPeriod.id,
      afterState: {
        fromPeriod: prevPeriod.period_key,
        fromDayNo: prevFinalDay.day_no,
        toPeriod: nextPeriodKey,
        stagedAt: new Date().toISOString()
      }
    });

    const result = {
      created: true,
      period: nextPeriod,
      daysCount: daysInNextMonth,
      sourcePeriodKey: prevPeriod.period_key,
      sourceDayNo: prevFinalDay.day_no,
      isVerified: false,
      message: `Rollover staged successfully for ${nextPeriodKey}. Owner must verify seeds before activating Day 1.`,
      sourcePeriod: {
        id: prevPeriod.id,
        periodKey: prevPeriod.period_key
      },
      targetPeriod: {
        id: nextPeriod.id,
        periodKey: nextPeriodKey,
        daysCount: daysInNextMonth
      }
    };

    if (clientMutationId) {
      await saveIdempotencyRecord(trx, {
        franchiseId,
        clientMutationId,
        userId: user.id,
        endpoint: "POST /api/v1/periods/rollover",
        payloadHash,
        responseStatus: 200,
        responseBody: result
      });
    }

    return result;
  };

  if (customTrx) {
    return runInTrx(customTrx);
  }
  return db.transaction().execute(runInTrx);
}

/**
 * 13. Detect Seed Delta (Discrepancy) Post-Rollover.
 * Compares current opening seeds against source period's latest final day closing projections.
 */
export async function getSeedDelta(franchiseId: string, periodId: string) {
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  const currentFinSeed = await db
    .selectFrom("period_financial_seeds")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .executeTakeFirst();

  if (!currentFinSeed || !currentFinSeed.source_period_key) {
    return {
      periodId,
      periodKey: period.period_key,
      hasDiscrepancy: false,
      isGenesis: true,
      discrepancies: []
    };
  }

  const sourcePeriod = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_key", "=", currentFinSeed.source_period_key)
    .executeTakeFirst();

  if (!sourcePeriod) {
    return {
      periodId,
      periodKey: period.period_key,
      hasDiscrepancy: false,
      sourceMissing: true,
      discrepancies: []
    };
  }

  const finalClosing = await getPeriodFinalProjectionsInternal(db, franchiseId, sourcePeriod.id);
  if (!finalClosing) {
    return {
      periodId,
      periodKey: period.period_key,
      hasDiscrepancy: false,
      discrepancies: []
    };
  }

  const discrepancies: Array<{
    category: string;
    field: string;
    entityId?: string;
    stagedSeedValue: number | string;
    sourceClosingValue: number | string;
    delta: number;
  }> = [];

  const sourceFin = finalClosing.closingBalances.financial;
  if (sourceFin) {
    const cashSeed = Number(currentFinSeed.opening_cash);
    const cashClose = Number(sourceFin.closingCash);
    if (Math.abs(cashSeed - cashClose) > 0.001) {
      discrepancies.push({
        category: "financial",
        field: "openingCash",
        stagedSeedValue: cashSeed,
        sourceClosingValue: cashClose,
        delta: cashClose - cashSeed
      });
    }

    const ownerSeed = Number(currentFinSeed.opening_owner_balance);
    const ownerClose = Number(sourceFin.closingOwnerBalance);
    if (Math.abs(ownerSeed - ownerClose) > 0.001) {
      discrepancies.push({
        category: "financial",
        field: "openingOwnerBalance",
        stagedSeedValue: ownerSeed,
        sourceClosingValue: ownerClose,
        delta: ownerClose - ownerSeed
      });
    }

    const payableSeed = Number(currentFinSeed.opening_jazz_payable);
    const payableClose = Number(sourceFin.closingJazzPayable ?? 0);
    if (Math.abs(payableSeed - payableClose) > 0.001) {
      discrepancies.push({
        category: "financial",
        field: "openingJazzPayable",
        stagedSeedValue: payableSeed,
        sourceClosingValue: payableClose,
        delta: payableClose - payableSeed
      });
    }
  }

  const sourceLifting = finalClosing.closingBalances.jazzLifting;
  if (sourceLifting) {
    const liftSeed = Number(currentFinSeed.opening_jazz_lifting);
    const liftClose = Number(sourceLifting.closingLiftingInHand);
    if (Math.abs(liftSeed - liftClose) > 0.001) {
      discrepancies.push({
        category: "financial",
        field: "openingJazzLifting",
        stagedSeedValue: liftSeed,
        sourceClosingValue: liftClose,
        delta: liftClose - liftSeed
      });
    }
  }

  return {
    periodId,
    periodKey: period.period_key,
    targetPeriodKey: period.period_key,
    sourcePeriodKey: currentFinSeed.source_period_key,
    sourceDayNo: currentFinSeed.source_day_no,
    hasDelta: discrepancies.length > 0,
    hasDiscrepancy: discrepancies.length > 0,
    discrepancies
  };
}

/**
 * 14. Governed Cross-Period Seed Correction (Owner Only).
 * Updates seeds with an explicit Owner-approved correction reason.
 * Re-runs Day 1 baseline calculation.
 * If the period already has active transactions or opened days,
 * triggers an ascending forward recalculation cascade across all active days.
 * Resets is_verified = false (Owner must re-verify).
 */
export async function applySeedCorrection(
  franchiseId: string,
  periodId: string,
  reason: string,
  bundle: SeedBundleInput,
  user: PeriodServiceUser,
  clientMutationId?: string
) {
  const payloadHash = computePayloadHash({ periodId, reason, bundle });

  if (clientMutationId) {
    const idemp = await checkIdempotency(db, franchiseId, clientMutationId, payloadHash);
    if (idemp.isDuplicate) {
      return idemp.body as any;
    }
  }

  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .forUpdate()
      .executeTakeFirst();

    if (!period) {
      throw new PeriodNotFoundError(periodId);
    }

    // 1. Stage updated seeds (resets is_verified = false)
    const modifiedBundle: SeedBundleInput = {
      ...bundle,
      financial: {
        ...bundle.financial,
        notes: `CORRECTED_BY_OWNER: ${reason} (at ${new Date().toISOString()})`
      }
    };

    await stageSeeds(franchiseId, periodId, modifiedBundle, user, trx);

    // 2. Fetch Day 1
    const day1 = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("day_no", "=", 1)
      .forUpdate()
      .executeTakeFirst();

    if (!day1) {
      throw new PeriodNotReadyError("Day 1 does not exist for this period.");
    }

    // 3. Re-run Day 1 baseline calculation
    await calculateDayInternal(trx, franchiseId, day1.id, null, {
      triggerSource: "seed_correction",
      allowClosedDays: true,
      userId: user.id
    });

    // 4. If Day 1 or any subsequent day in this period has been opened, forward cascade recalculation
    const hasOpenOrReopenedDays = await trx
      .selectFrom("accounting_days")
      .select(["id", "day_no"])
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("status", "in", ["open", "reopen"])
      .execute();

    if (day1.status !== "closed" || hasOpenOrReopenedDays.length > 0) {
      await recalculateFromDayInternal(trx, franchiseId, day1.id, {
        triggerSource: "seed_correction",
        allowClosedDays: true,
        userId: user.id
      });
    }

    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "period_seed_correction",
      entityId: periodId,
      afterState: {
        reason,
        appliedAt: new Date().toISOString(),
        appliedBy: user.email,
        financial: modifiedBundle.financial
      }
    });

    const result = {
      corrected: true,
      correctionApplied: true,
      periodId,
      isVerified: false,
      message: "Seed correction applied successfully. Owner must re-verify seeds before opening subsequent days."
    };

    if (clientMutationId) {
      await saveIdempotencyRecord(trx, {
        franchiseId,
        clientMutationId,
        userId: user.id,
        endpoint: `POST /api/v1/periods/${periodId}/seed-correction`,
        payloadHash,
        responseStatus: 200,
        responseBody: result
      });
    }

    return result;
  });
}

/**
 * List all final settlement entries and domain summaries for a period.
 */
export async function listPeriodFinalSettlements(
  franchiseId: string,
  periodId: string
) {
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) throw new PeriodNotFoundError(periodId);

  const finalClosing = await getPeriodFinalProjectionsInternal(db, franchiseId, periodId);
  if (!finalClosing) {
    throw new PeriodNotReadyError(`Final closing projections could not be computed for period '${period.period_key}'.`);
  }

  return finalClosing.finalSettlements;
}

/**
 * Create a new final settlement record on a period's FINAL closing snapshot.
 * Enforces:
 * - Period exists and is open
 * - FINAL is not yet VERIFIED or CLOSED (immutability)
 * - Domain-specific balance limits (rejects over-settlement with 422)
 * - If target day exists for COMMISSION_RECEIVABLE, creates linked commission_settlement_receipt
 * - Audit logging
 */
export async function createPeriodFinalSettlement(
  franchiseId: string,
  periodId: string,
  input: CreateFinalSettlementInput,
  user: PeriodServiceUser,
  clientMutationId?: string
) {
  return db.transaction().execute(async (trx) => {
    // 1. Validate period
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

    if (!period) throw new PeriodNotFoundError(periodId);

    if (period.status === "closed" || period.final_settlement_status === "VERIFIED" || period.final_settlement_status === "CLOSED") {
      throw new FinalSettlementImmutableError(
        `Cannot add settlement record to period '${period.period_key}': FINAL settlement status is '${period.final_settlement_status}' and period status is '${period.status}'. Period/FINAL must be reopened first.`
      );
    }

    // 2. Fetch current FINAL state to check balance domain limits
    const currentFinal = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);
    if (!currentFinal) {
      throw new PeriodNotReadyError(`Cannot load FINAL state for period '${period.period_key}'.`);
    }

    const amount = Math.round((Number(input.amount) + Number.EPSILON) * 100) / 100;
    if (amount <= 0) {
      throw new PeriodError("INVALID_AMOUNT", "Settlement amount must be greater than zero.", 400);
    }

    // 3. Domain-specific validation (Over-settlement check)
    if (input.balanceDomain === "COMMISSION_RECEIVABLE") {
      const commSummary = currentFinal.finalSettlements.domainSummaries.find(
        (d) => d.balanceDomain === "COMMISSION_RECEIVABLE"
      );
      const remaining = Number(commSummary?.remainingOutstanding ?? 0);
      if (amount > remaining) {
        throw new OverSettlementError(
          `Over-settlement rejected: Settlement amount of ${amount} exceeds remaining commission receivable of ${remaining}.`,
          { requestedAmount: amount, remainingReceivable: remaining }
        );
      }
    } else if (input.balanceDomain === "CREDIT_PARTY_BALANCE") {
      if (!input.targetEntityId) {
        throw new PeriodError("TARGET_ENTITY_REQUIRED", "targetEntityId (Credit Party ID) is required for CREDIT_PARTY_BALANCE.", 400);
      }
      if (input.settlementType === "CREDIT_RECEIVE" || input.settlementType === "CREDIT_RECOVERY") {
        const cpSummary = currentFinal.finalSettlements.domainSummaries.find(
          (d) => d.balanceDomain === "CREDIT_PARTY_BALANCE" && d.targetEntityId === input.targetEntityId
        );
        const remaining = Number(cpSummary?.remainingOutstanding ?? 0);
        if (amount > remaining) {
          throw new OverSettlementError(
            `Over-settlement rejected: Settlement amount of ${amount} exceeds remaining balance of ${remaining} for credit party '${input.targetEntityName || input.targetEntityId}'.`,
            { requestedAmount: amount, remainingBalance: remaining, targetEntityId: input.targetEntityId }
          );
        }
      }
    }

    // 4. Check if target day already exists (e.g. September Day 1 matching settlementDate)
    let targetDayId: string | null = null;
    const targetDay = await trx
      .selectFrom("accounting_days")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("calendar_date", "=", input.settlementDate)
      .executeTakeFirst();

    if (targetDay) {
      targetDayId = targetDay.id;
    }

    // 5. Insert final_settlement_entries
    const newEntry = await trx
      .insertInto("final_settlement_entries")
      .values({
        franchise_id: franchiseId,
        period_id: period.id,
        source_period_key: period.period_key,
        settlement_date: input.settlementDate,
        balance_domain: input.balanceDomain,
        settlement_type: input.settlementType,
        target_entity_id: input.targetEntityId ?? null,
        target_entity_name: input.targetEntityName ?? null,
        amount,
        source_reference: input.sourceReference ?? null,
        notes: input.notes ?? null,
        target_day_id: targetDayId,
        created_by_user_id: user.id
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    // 6. If target day exists and domain is COMMISSION_RECEIVABLE, create linked receipt
    if (targetDay && input.balanceDomain === "COMMISSION_RECEIVABLE") {
      await trx.insertInto("commission_settlement_receipts").values({
        franchise_id: franchiseId,
        day_id: targetDay.id,
        source_period_key: period.period_key,
        amount,
        notes: input.notes ?? null,
        final_settlement_entry_id: newEntry.id
      }).execute();

      // Recalculate target day if active & verified
      const targetPeriod = await trx
        .selectFrom("accounting_periods")
        .selectAll()
        .where("id", "=", targetDay.period_id)
        .executeTakeFirst();

      const targetSeeds = await trx
        .selectFrom("period_financial_seeds")
        .selectAll()
        .where("period_id", "=", targetDay.period_id)
        .executeTakeFirst();

      if (targetDay.status === "open" && targetSeeds?.is_verified) {
        await calculateDayInternal(trx, franchiseId, targetDay.id, "final_settlement_sync");
      }
    }

    // 7. Record audit log
    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "CREATE",
      entityType: "final_settlement_entry",
      entityId: newEntry.id,
      afterState: {
        periodKey: period.period_key,
        balanceDomain: input.balanceDomain,
        settlementType: input.settlementType,
        amount,
        settlementDate: input.settlementDate,
        targetDayId
      }
    });

    // 8. Re-fetch updated FINAL state
    const updatedFinal = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);

    return {
      success: true,
      entry: {
        id: newEntry.id,
        periodId: newEntry.period_id,
        sourcePeriodKey: newEntry.source_period_key,
        settlementDate: formatSettlementDate(newEntry.settlement_date),
        balanceDomain: newEntry.balance_domain,
        settlementType: newEntry.settlement_type,
        targetEntityId: newEntry.target_entity_id,
        targetEntityName: newEntry.target_entity_name,
        amount: String(newEntry.amount),
        sourceReference: newEntry.source_reference,
        notes: newEntry.notes,
        status: newEntry.status,
        targetDayId: newEntry.target_day_id,
        createdAt: new Date(newEntry.created_at as unknown as string).toISOString()
      },
      finalSettlements: updatedFinal?.finalSettlements
    };
  });
}

/**
 * Update an existing final settlement record before period/FINAL verification.
 */
export async function updatePeriodFinalSettlement(
  franchiseId: string,
  periodId: string,
  settlementId: string,
  input: UpdateFinalSettlementInput,
  user: PeriodServiceUser
) {
  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

    if (!period) throw new PeriodNotFoundError(periodId);

    if (period.status === "closed" || period.final_settlement_status === "VERIFIED" || period.final_settlement_status === "CLOSED") {
      throw new FinalSettlementImmutableError(
        `Cannot edit settlement record in period '${period.period_key}': FINAL is '${period.final_settlement_status}' and period status is '${period.status}'.`
      );
    }

    const existing = await trx
      .selectFrom("final_settlement_entries")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("id", "=", settlementId)
      .executeTakeFirst();

    if (!existing) {
      throw new PeriodError("SETTLEMENT_NOT_FOUND", `Settlement record '${settlementId}' not found.`, 404);
    }

    // Check oversettlement if amount updated
    if (input.amount !== undefined) {
      const newAmount = Math.round((Number(input.amount) + Number.EPSILON) * 100) / 100;
      if (newAmount <= 0) throw new PeriodError("INVALID_AMOUNT", "Amount must be greater than zero.", 400);

      if (
        existing.balance_domain === "COMMISSION_RECEIVABLE" ||
        (existing.balance_domain === "CREDIT_PARTY_BALANCE" &&
          (existing.settlement_type === "CREDIT_RECEIVE" || existing.settlement_type === "CREDIT_RECOVERY"))
      ) {
        const currentFinal = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);
        const summary = currentFinal?.finalSettlements.domainSummaries.find(
          (d) => d.balanceDomain === existing.balance_domain && (!existing.target_entity_id || d.targetEntityId === existing.target_entity_id)
        );
        const maxAllowed = round2(Number(summary?.remainingOutstanding ?? 0) + Number(existing.amount));
        if (newAmount > maxAllowed) {
          throw new OverSettlementError(
            `Over-settlement rejected: Updated amount of ${newAmount} exceeds allowable balance of ${maxAllowed}.`,
            { requestedAmount: newAmount, maxAllowed }
          );
        }
      }
    }

    const updated = await trx
      .updateTable("final_settlement_entries")
      .set({
        amount: input.amount !== undefined ? Number(input.amount) : undefined,
        settlement_date: input.settlementDate ?? undefined,
        settlement_type: input.settlementType ?? undefined,
        target_entity_id: input.targetEntityId !== undefined ? input.targetEntityId : undefined,
        target_entity_name: input.targetEntityName !== undefined ? input.targetEntityName : undefined,
        source_reference: input.sourceReference !== undefined ? input.sourceReference : undefined,
        notes: input.notes !== undefined ? input.notes : undefined,
        revision: sql`revision + 1`,
        updated_at: sql`clock_timestamp()`
      })
      .where("id", "=", settlementId)
      .returningAll()
      .executeTakeFirstOrThrow();

    // If linked receipt exists, update it as well
    if (input.amount !== undefined || input.notes !== undefined) {
      await trx
        .updateTable("commission_settlement_receipts")
        .set({
          amount: input.amount !== undefined ? Number(input.amount) : undefined,
          notes: input.notes !== undefined ? input.notes : undefined,
          revision: sql`revision + 1`,
          updated_at: sql`clock_timestamp()`
        })
        .where("final_settlement_entry_id", "=", settlementId)
        .execute();
    }

    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "UPDATE",
      entityType: "final_settlement_entry",
      entityId: settlementId,
      afterState: updated
    });

    const updatedFinal = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);

    return {
      success: true,
      entry: updated,
      finalSettlements: updatedFinal?.finalSettlements
    };
  });
}

/**
 * Delete a final settlement record before period/FINAL verification.
 */
export async function deletePeriodFinalSettlement(
  franchiseId: string,
  periodId: string,
  settlementId: string,
  user: PeriodServiceUser
) {
  return db.transaction().execute(async (trx) => {
    const period = await trx
      .selectFrom("accounting_periods")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("id", "=", periodId)
      .executeTakeFirst();

    if (!period) throw new PeriodNotFoundError(periodId);

    if (period.status === "closed" || period.final_settlement_status === "VERIFIED" || period.final_settlement_status === "CLOSED") {
      throw new FinalSettlementImmutableError(
        `Cannot delete settlement record in period '${period.period_key}': FINAL is '${period.final_settlement_status}' and period status is '${period.status}'.`
      );
    }

    const existing = await trx
      .selectFrom("final_settlement_entries")
      .selectAll()
      .where("franchise_id", "=", franchiseId)
      .where("period_id", "=", periodId)
      .where("id", "=", settlementId)
      .executeTakeFirst();

    if (!existing) {
      throw new PeriodError("SETTLEMENT_NOT_FOUND", `Settlement record '${settlementId}' not found.`, 404);
    }

    // Delete linked receipt if any
    await trx
      .deleteFrom("commission_settlement_receipts")
      .where("final_settlement_entry_id", "=", settlementId)
      .execute();

    await trx
      .deleteFrom("final_settlement_entries")
      .where("id", "=", settlementId)
      .execute();

    await recordAuditLog(trx, {
      franchiseId,
      userId: user.id,
      userEmail: user.email,
      action: "DELETE",
      entityType: "final_settlement_entry",
      entityId: settlementId,
      beforeState: existing
    });

    const updatedFinal = await getPeriodFinalProjectionsInternal(trx, franchiseId, period.id);

    return {
      deleted: true,
      id: settlementId,
      finalSettlements: updatedFinal?.finalSettlements
    };
  });
}

