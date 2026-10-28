/**
 * Phase 5: Accounting Day Concurrency & Immutability Lock
 *
 * Enforces the accounting day boundary:
 * 1. Resolves the requested accounting day strictly within the authenticated tenant.
 * 2. Acquires an explicit row lock (`SELECT ... FOR UPDATE`) in PostgreSQL.
 * 3. Blocks any mutation if the accounting day is CLOSED.
 * 4. Allows mutation if the accounting day is OPEN or REOPEN.
 */
import type { Transaction } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/types.js";
import { DayClosedError, NotFoundError } from "./errors.js";

export interface LockedAccountingDay {
  id: string;
  franchise_id: string;
  period_id: string;
  day_no: number;
  status: "open" | "closed" | "reopen";
  calendar_date: string;
  label: string;
}

export async function assertAccountingDayActive(
  trx: Transaction<Database>,
  franchiseId: string,
  dayId: string
): Promise<LockedAccountingDay> {
  // Row lock the accounting day to prevent race conditions during state transitions
  const dayResult = await sql<LockedAccountingDay>`
    SELECT id, franchise_id, period_id, day_no, status, calendar_date, label
    FROM accounting_days
    WHERE id = ${dayId} AND franchise_id = ${franchiseId}
    FOR UPDATE;
  `.execute(trx);

  if (dayResult.rows.length === 0) {
    throw new NotFoundError("Accounting day not found or does not belong to your franchise.");
  }

  const day = dayResult.rows[0];

  if (day.status === "closed") {
    throw new DayClosedError(
      `Financial Ledger Violation: Accounting day ${day.day_no} (${day.calendar_date}) is CLOSED. Mutations are prohibited until reopened by an authorized Owner.`
    );
  }

  // Also assert parent accounting period is not CLOSED
  const period = await trx
    .selectFrom("accounting_periods")
    .select(["status", "period_key"])
    .where("id", "=", day.period_id)
    .where("franchise_id", "=", franchiseId)
    .executeTakeFirst();

  if (period && period.status === "closed") {
    throw new DayClosedError(
      `Financial Ledger Violation: Accounting period '${period.period_key}' is CLOSED. Mutations are prohibited.`
    );
  }

  return day;
}
