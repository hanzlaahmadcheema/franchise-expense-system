import type { UserRole } from "../../types/ledger";

export type ReopenedDayState = {
  status?: "open" | "closed" | null;
  lockedAt?: number | null;
  closedAt?: number | null;
  reopenedUntilAt?: number | null;
  reopenedAt?: number | null;
  reopenedByRole?: UserRole | null;
};

export function isActiveReopenWindow(day: ReopenedDayState | undefined | null, nowMs = Date.now()) {
  if (typeof day?.reopenedAt === "number") {
    const closedAt = Math.max(day.lockedAt ?? 0, day.closedAt ?? 0);
    return day.reopenedAt > closedAt;
  }
  return typeof day?.reopenedUntilAt === "number" && day.reopenedUntilAt > nowMs;
}

export function isAdminEditableReopenedDay(day: ReopenedDayState | undefined | null, nowMs = Date.now()) {
  return isActiveReopenWindow(day, nowMs) && (!day?.reopenedByRole || day.reopenedByRole === "owner");
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
  if (input.dayClosed && !activeReopen) return false;
  if (input.role === "owner") return input.isLiveDay || !input.dayClosed || activeReopen;
  if (input.role === "admin") return input.isLiveDay || isAdminEditableReopenedDay(input.day, input.nowMs);
  return false;
}

export function canReopenOperationalDay(input: {
  role: UserRole | null;
  isLiveDay: boolean;
}) {
  return input.role === "owner" || (input.role === "admin" && input.isLiveDay);
}
