/**
 * Shared Day Lifecycle Service
 *
 * Provides a single, authoritative day-close and day-reopen operation
 * for Expense, Jazz Load, and Stock modules in PostgreSQL accounting periods.
 *
 * Guarantees:
 * 1. Save-before-close: flushes pending drafts and aborts close on failure.
 * 2. Duplicate prevention: guards against concurrent double-click submissions.
 * 3. Authoritative server confirmation: never updates client status until backend confirms.
 * 4. Cache synchronization: invalidates and refreshes periodDayService cache.
 * 5. Multi-module status propagation: notifies active module listeners.
 */

import {
  ledgerApiClient,
  type AccountingDayRecord
} from "./ledgerApiClient";
import {
  getAccountingPeriodWithDays
} from "./periodDayService";

export interface UnifiedDayCloseInput {
  monthId: string;
  dayNo: number;
  notes?: string | null;
  flushDraft?: () => Promise<boolean>;
}

export interface UnifiedDayReopenInput {
  monthId: string;
  dayNo: number;
  reason?: string;
}

export type DayStatusChangeListener = (event: {
  monthId: string;
  dayNo: number;
  status: "open" | "closed" | "reopen";
  day: AccountingDayRecord;
}) => void;

const listeners = new Set<DayStatusChangeListener>();
const inFlightCloseKeys = new Set<string>();
const inFlightReopenKeys = new Set<string>();

export function subscribeDayStatus(listener: DayStatusChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyDayStatus(event: {
  monthId: string;
  dayNo: number;
  status: "open" | "closed" | "reopen";
  day: AccountingDayRecord;
}): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[dayLifecycleService] Listener error:", err);
    }
  }
}

/**
 * Shared authoritative day close for PostgreSQL periods.
 * - Flushes pending saves if flushDraft provided; aborts if flush fails.
 * - Prevents duplicate in-flight close requests for the same day.
 * - Invokes backend POST /api/v1/periods/:periodId/days/:dayNo/close.
 * - Force-refreshes period cache.
 * - Notifies all subscribers to sync day status across mounted modules.
 */
export async function closeOperationalDayUnified(
  input: UnifiedDayCloseInput
): Promise<{ message: string; day: AccountingDayRecord }> {
  const { monthId, dayNo, notes, flushDraft } = input;
  const key = `${monthId}/${dayNo}`;

  if (inFlightCloseKeys.has(key)) {
    throw new Error(`Day ${dayNo} close is already in progress.`);
  }

  // 1. Mandatory Save-Before-Close
  if (flushDraft) {
    let saveOk = false;
    try {
      saveOk = await flushDraft();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot close day: pending changes could not be saved (${msg}).`);
    }
    if (!saveOk) {
      throw new Error("Cannot close day: pending changes could not be saved.");
    }
  }

  // 2. Authoritative PostgreSQL Execution
  inFlightCloseKeys.add(key);
  try {
    const periodData = await getAccountingPeriodWithDays(monthId);
    if (!periodData) {
      throw new Error(`Cannot close day: period ${monthId} not initialized in PostgreSQL.`);
    }

    const res = await ledgerApiClient.periods.closeDay(
      periodData.period.id,
      dayNo,
      notes ?? null
    );

    // 3. Cache refresh & status synchronization
    await getAccountingPeriodWithDays(monthId, true);
    notifyDayStatus({
      monthId,
      dayNo,
      status: "closed",
      day: res.day
    });

    return res;
  } finally {
    inFlightCloseKeys.delete(key);
  }
}

/**
 * Shared authoritative day reopen for PostgreSQL periods (Owner-only).
 * - Prevents duplicate in-flight reopen requests for the same day.
 * - Invokes backend POST /api/v1/periods/:periodId/days/:dayNo/reopen.
 * - Force-refreshes period cache.
 * - Notifies all subscribers to sync day status across mounted modules.
 */
export async function reopenOperationalDayUnified(
  input: UnifiedDayReopenInput
): Promise<{ message: string; day: AccountingDayRecord }> {
  const { monthId, dayNo, reason } = input;
  const key = `${monthId}/${dayNo}`;

  if (inFlightReopenKeys.has(key)) {
    throw new Error(`Day ${dayNo} reopen is already in progress.`);
  }

  inFlightReopenKeys.add(key);
  try {
    const periodData = await getAccountingPeriodWithDays(monthId);
    if (!periodData) {
      throw new Error(`Cannot reopen day: period ${monthId} not initialized in PostgreSQL.`);
    }

    const res = await ledgerApiClient.periods.reopenDay(
      periodData.period.id,
      dayNo,
      reason ?? "Reopened by owner"
    );

    // Cache refresh & status synchronization
    await getAccountingPeriodWithDays(monthId, true);
    notifyDayStatus({
      monthId,
      dayNo,
      status: "reopen",
      day: res.day
    });

    return res;
  } finally {
    inFlightReopenKeys.delete(key);
  }
}
