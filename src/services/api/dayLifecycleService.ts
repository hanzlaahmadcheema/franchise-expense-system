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

export interface UnifiedDaySwitchInput {
  monthId: string;
  fromDayNo?: number | null;
  toDayNo: number;
  notes?: string | null;
  flushDraft?: () => Promise<boolean>;
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
const inFlightSwitchKeys = new Set<string>();

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

/**
 * Shared authoritative day switch for PostgreSQL periods.
 * Calendar Rule:
 * Automatically closes previous day and opens newly selected day in a single unified operation.
 * - Flushes pending drafts if flushDraft provided; aborts if flush fails.
 * - Prevents duplicate in-flight switch requests for the same target day.
 * - Invokes backend POST /api/v1/periods/:periodId/switch-day.
 * - Refreshes period cache and notifies all listeners of both closed and opened day status changes.
 */
export async function switchOperationalDayUnified(
  input: UnifiedDaySwitchInput
): Promise<{
  success: boolean;
  closedDay?: AccountingDayRecord | null;
  openedDay?: AccountingDayRecord | null;
  message: string;
}> {
  const { monthId, fromDayNo, toDayNo, notes, flushDraft } = input;
  const key = `${monthId}/switch-to-${toDayNo}`;

  if (inFlightSwitchKeys.has(key)) {
    throw new Error(`Day switch to ${toDayNo} is already in progress.`);
  }

  // 1. Mandatory Save-Before-Switch
  if (flushDraft) {
    let saveOk = false;
    try {
      saveOk = await flushDraft();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot switch day: pending changes could not be saved (${msg}).`);
    }
    if (!saveOk) {
      throw new Error("Cannot switch day: pending changes could not be saved.");
    }
  }

  inFlightSwitchKeys.add(key);
  try {
    const periodData = await getAccountingPeriodWithDays(monthId);
    if (!periodData) {
      throw new Error(`Cannot switch day: period ${monthId} not initialized in PostgreSQL.`);
    }

    const res = await ledgerApiClient.periods.switchDay(periodData.period.id, {
      fromDayNo: fromDayNo ?? null,
      toDayNo,
      notes: notes ?? null
    });

    // 2. Cache refresh & status synchronization across mounted modules
    await getAccountingPeriodWithDays(monthId, true);

    if (res.closedDay) {
      notifyDayStatus({
        monthId,
        dayNo: res.closedDay.day_no ?? (res.closedDay as any).dayNo,
        status: "closed",
        day: res.closedDay
      });
    }

    if (res.openedDay) {
      notifyDayStatus({
        monthId,
        dayNo: res.openedDay.day_no ?? (res.openedDay as any).dayNo,
        status: (res.openedDay.status as any) ?? "open",
        day: res.openedDay
      });
    }

    return res;
  } finally {
    inFlightSwitchKeys.delete(key);
  }
}
