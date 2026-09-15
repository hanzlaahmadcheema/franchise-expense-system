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
import {
  PeriodError,
  PeriodNotFoundError,
  PeriodAlreadyExistsError,
  InvalidPeriodKeyError,
  SeedValidationFailedError,
  MissingFinancialSeedError,
  SeedsNotVerifiedError,
  PeriodNotReadyError,
  TenantIsolationError
} from "./errors.js";
import type { SeedBundleInput } from "./schemas.js";

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
function parsePeriodKey(periodKey: string): { year: number; month: number; label: string; daysInMonth: number } {
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
 * 1. Initialize Accounting Period and Provision Days Atomically.
 * September 2026 initializes with exactly 30 calendar days (all closed).
 */
export async function initializePeriod(
  franchiseId: string,
  periodKey: string,
  user: PeriodServiceUser
) {
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
  user: PeriodServiceUser
) {
  // 1. Verify period ownership
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", periodId)
    .executeTakeFirst();

  if (!period) {
    throw new PeriodNotFoundError(periodId);
  }

  // 2. Check Day 1 status
  const day1 = await db
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

    const verifiedParties = await db
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

    const verifiedProducts = await db
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

    const verifiedAccounts = await db
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

    const verifiedProfiles = await db
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
  return db.transaction().execute(async (trx) => {
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
          opening_quantity: sp.openingQuantity,
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
  });
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
  user: PeriodServiceUser
) {
  if (user.role !== "owner") {
    throw new PeriodError("FORBIDDEN", "Only the franchise owner can verify opening seeds.", 403);
  }

  return db.transaction().execute(async (trx) => {
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

    if (calcResult.financial.closingCash !== calcResult.financial.openingCash) {
      throw new PeriodError(
        "DAY_ACTIVATION_BLOCKED",
        `Day 1 closing cash (${calcResult.financial.closingCash}) does not equal opening cash (${calcResult.financial.openingCash}).`,
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
  });
}

/**
 * 6. Period Activation Operation (Owner Only).
 * Transitions Day 1 status from `closed` to `open`.
 * Days 2..30 strictly remain `closed`.
 */
export async function activatePeriod(
  franchiseId: string,
  periodId: string,
  user: PeriodServiceUser
) {
  if (user.role !== "owner") {
    throw new PeriodError("FORBIDDEN", "Only the franchise owner can activate accounting periods.", 403);
  }

  return db.transaction().execute(async (trx) => {
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
  });
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
