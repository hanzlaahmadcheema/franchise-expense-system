export function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function currentMonthId(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

export function previousMonthId(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  let year = Number(yearText);
  let month = Number(monthText);
  if (!year || !month) return monthId;
  month -= 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return `${year}-${pad2(month)}`;
}

export function currentDateState(date = new Date()) {
  return {
    monthId: currentMonthId(date),
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

export function dayDate(monthId: string, dayNo: number) {
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, dayNo);
  if (Number.isNaN(date.getTime())) return `${monthId}-${pad2(dayNo)}`;
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

export function monthLabel(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, 1);
  if (Number.isNaN(date.getTime())) return monthId;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
}

export function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatMoney(value: number) {
  return roundMoney(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
}

export function parseMoneyInput(value: string) {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID();
}

export function normalizeKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
