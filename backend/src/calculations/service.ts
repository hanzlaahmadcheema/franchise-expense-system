/**
 * Phase 6B: Calculation Service Interface
 *
 * Provides transactional service operations and projection query methods.
 */

import { db } from "../config/database.js";
import {
  calculateDayInternal,
  recalculateFromDayInternal,
  rebuildPeriodInternal
} from "./engine.js";
import type {
  CalculationRunOptions,
  CalculationRunResult,
  DayCalculationResult
} from "./types.js";

export async function recalculateFromDay(
  franchiseId: string,
  startDayId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<CalculationRunResult> {
  return db.transaction().execute(async (trx) => {
    return recalculateFromDayInternal(trx, franchiseId, startDayId, options);
  });
}

export async function rebuildPeriod(
  franchiseId: string,
  periodId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<CalculationRunResult> {
  return db.transaction().execute(async (trx) => {
    return rebuildPeriodInternal(trx, franchiseId, periodId, options);
  });
}

export async function rebuildDay(
  franchiseId: string,
  dayId: string,
  options: CalculationRunOptions = { triggerSource: "rebuild" }
): Promise<DayCalculationResult> {
  return db.transaction().execute(async (trx) => {
    return calculateDayInternal(trx, franchiseId, dayId, null, options);
  });
}

/**
 * Fetch all calculated projections for a specific day.
 */
export async function getDayProjections(franchiseId: string, dayId: string) {
  const day = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("id", "=", dayId)
    .executeTakeFirst();

  if (!day) {
    return null;
  }

  const financial = await db
    .selectFrom("day_financial_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .executeTakeFirst();

  const creditParties = await db
    .selectFrom("credit_party_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  const stockProducts = await db
    .selectFrom("stock_product_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  const stockAccounts = await db
    .selectFrom("stock_account_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  const jazzLifting = await db
    .selectFrom("jazz_lifting_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .executeTakeFirst();

  const jazzDo = await db
    .selectFrom("jazz_load_do_day_projections")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("day_id", "=", dayId)
    .execute();

  return {
    day: {
      id: day.id,
      dayNo: day.day_no,
      periodId: day.period_id,
      status: day.status,
      calendarDate: day.calendar_date
    },
    projections: {
      financial: financial ?? null,
      creditParties,
      stockProducts,
      stockAccounts,
      jazzLifting: jazzLifting ?? null,
      jazzDo
    }
  };
}

/**
 * List invariant violations for a period.
 */
export async function getPeriodInvariants(franchiseId: string, periodId: string) {
  return db
    .selectFrom("invariant_violations")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("period_id", "=", periodId)
    .orderBy("created_at", "desc")
    .execute();
}

/**
 * List calculation runs for audit.
 */
export async function listCalculationRuns(
  franchiseId: string,
  limit = 50,
  offset = 0
) {
  return db
    .selectFrom("calculation_runs")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .orderBy("created_at", "desc")
    .limit(limit)
    .offset(offset)
    .execute();
}
