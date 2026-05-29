export function roundMoney(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function formatCurrency(value: number) {
  return roundMoney(value).toLocaleString(undefined, {
    maximumFractionDigits: 0
  });
}

export function formatPercentage(value: number) {
  return `${roundMoney(value).toLocaleString(undefined, { maximumFractionDigits: 4 })}%`;
}

export function parseMoneyInput(value: string) {
  const clean = value.replace(/,/g, "").trim();
  if (clean === "") return 0;
  const parsed = Number(clean);
  return Number.isFinite(parsed) ? roundMoney(parsed) : Number.NaN;
}

export function normalizeDoKey(name: string, line?: string) {
  return `${name.trim().toLowerCase()}::${(line ?? "").trim().toLowerCase()}`;
}

export function monthLabel(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, 1);
  if (Number.isNaN(date.getTime())) return monthId;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
}

export function dayDate(monthId: string, dayNo: number) {
  const [yearText, monthText] = monthId.split("-");
  return `${yearText}-${monthText}-${String(dayNo).padStart(2, "0")}`;
}

export function daysInMonth(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return 31;
  return new Date(year, month, 0).getDate();
}
