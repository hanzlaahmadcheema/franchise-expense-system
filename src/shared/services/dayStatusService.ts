import type { ModuleKey, UniversalDaySnapshot, UniversalDayStatus } from "../types/dayControl.types";

export function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function currentDateState(date = new Date()) {
  return {
    monthId: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`,
    dayNo: date.getDate()
  };
}

export function compareMonthIds(left: string, right: string) {
  return left.localeCompare(right);
}

export function daysInMonth(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return 31;
  return new Date(year, month, 0).getDate();
}

export function availableDayNumbers(monthId: string, now = new Date()) {
  const live = currentDateState(now);
  if (compareMonthIds(monthId, live.monthId) > 0) return [];
  const maxDay = monthId === live.monthId ? live.dayNo : daysInMonth(monthId);
  return Array.from({ length: maxDay }, (_, index) => index + 1);
}

export function isFutureDay(monthId: string, dayNo: number, now = new Date()) {
  return !availableDayNumbers(monthId, now).includes(dayNo);
}

export function isLiveDay(monthId: string, dayNo: number, now = new Date()) {
  const live = currentDateState(now);
  return monthId === live.monthId && dayNo === live.dayNo;
}

export function calendarCells(monthId: string) {
  const totalDays = daysInMonth(monthId);
  const [yearText, monthText] = monthId.split("-");
  const firstDate = new Date(Number(yearText), Number(monthText) - 1, 1);
  const cells: Array<{ dayNo: number | null }> = Array.from({ length: firstDate.getDay() }, () => ({ dayNo: null }));
  for (let day = 1; day <= totalDays; day += 1) cells.push({ dayNo: day });
  while (cells.length % 7 !== 0) cells.push({ dayNo: null });
  return cells;
}

export function statusLabel(status: UniversalDayStatus) {
  if (status === "futureDisabled") return "Future";
  if (status === "reopened") return "Re-Open";
  if (status === "today" || status === "open") return "Open";
  if (status === "missing") return "Missing";
  if (status === "closed" || status === "locked") return "Closed";
  return "Open";
}

export function statusChipClass(status: UniversalDayStatus) {
  if (status === "open" || status === "today") return "bg-emerald-400/15 text-emerald-200";
  if (status === "reopened") return "bg-blue-400/15 text-blue-200";
  if (status === "closed" || status === "locked") return "bg-red-400/15 text-red-200";
  if (status === "missing") return "bg-orange-400/15 text-orange-200";
  return "bg-slate-800 text-slate-500";
}

export function buildDaySnapshot(input: {
  moduleKey: ModuleKey;
  monthId: string;
  dayNo: number;
  status: UniversalDayStatus;
  dateLabel?: string;
  saved?: boolean;
  reopenedUntilAt?: number;
  disabledReason?: string;
}): UniversalDaySnapshot {
  return input;
}
