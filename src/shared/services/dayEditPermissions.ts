import type { CalendarDayStatus, UserRole } from "../../types/ledger";

export type ReopenedDayState = {
  status?: CalendarDayStatus | null;
  manualOverride?: boolean | null;
  lockedAt?: number | null;
  closedAt?: number | null;
  reopenedUntilAt?: number | null;
  reopenedAt?: number | null;
  reopenedByRole?: UserRole | null;
};

export function isActiveReopenWindow(day: ReopenedDayState | undefined | null, nowMs = Date.now()) {
  void nowMs;
  return day?.status === "reopen";
}

export function isAdminEditableReopenedDay(day: ReopenedDayState | undefined | null, nowMs = Date.now()) {
  return isActiveReopenWindow(day, nowMs) && (!day?.reopenedByRole || day.reopenedByRole === "owner");
}

export function isOperationalDayClosed(day: ReopenedDayState | undefined | null, nowMs = Date.now()) {
  if (!day) return false;
  if (isActiveReopenWindow(day, nowMs)) return false;
  return day.status === "closed" || day.lockedAt != null || day.closedAt != null;
}

export function canEditOperationalDailyEntry(input: {
  role: UserRole | null;
  canWriteDaily: boolean;
  monthClosed: boolean;
  isFutureDay?: boolean;
  isLiveDay: boolean;
  dayClosed: boolean;
  day?: ReopenedDayState | null;
  nowMs?: number;
}) {
  if (!input.canWriteDaily || input.monthClosed || input.isFutureDay) return false;
  const activeReopen = isActiveReopenWindow(input.day, input.nowMs);
  const dayClosed = input.dayClosed || isOperationalDayClosed(input.day, input.nowMs);
  if (dayClosed && !activeReopen) return false;
  if (input.role === "owner") return input.isLiveDay || !dayClosed || activeReopen;
  if (input.role === "admin") return input.isLiveDay || isAdminEditableReopenedDay(input.day, input.nowMs);
  return false;
}

export function canReopenOperationalDay(input: {
  role: UserRole | null;
  isLiveDay: boolean;
}) {
  void input.isLiveDay;
  return canReopenDay(input.role);
}

export function canReopenDay(role: UserRole | null) {
  return role === "owner";
}
