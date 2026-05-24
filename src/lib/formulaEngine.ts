import {
  COMMISSION_CATEGORIES,
  type CommissionCategory,
  type DailyLedgerComputed,
  type DailyLedgerInput,
  type MonthComputed
} from "../types/ledger";

const sum = (nums: number[]) => nums.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);

function expenseCategory(item: { category?: string; name?: string; description?: string }) {
  if (item.category) return item.category;
  const text = `${item.name ?? ""} ${item.description ?? ""}`.toLowerCase();
  if (text.includes("salary")) return "Salary";
  if (text.includes("water") || text.includes("coffee") || text.includes("chay") || text.includes("bist")) {
    return "Refreshment";
  }
  if (text.includes("imsi") || text.includes("pospaid") || text.includes("postpaid")) return "IMSI";
  if (text.includes("rent")) return "Rent";
  if (text.includes("bill") || text.includes("electric")) return "Utilities";
  return "General";
}

const emptyCommissionMap = (): Record<CommissionCategory, number> =>
  COMMISSION_CATEGORIES.reduce(
    (acc, category) => ({ ...acc, [category]: 0 }),
    {} as Record<CommissionCategory, number>
  );

function normalizeCommissionCategory(category: string): CommissionCategory | null {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return COMMISSION_CATEGORIES.find((item) => item === category) ?? null;
}

export function computeDay(day: DailyLedgerInput, openingBalance: number): DailyLedgerComputed {
  const issueBalance = sum(day.commissions.map((item) => item.amount));
  const totalBalance = openingBalance + issueBalance;
  const expenseTotal = sum(day.expenses.map((item) => item.amount));
  const returnBalance = totalBalance - expenseTotal;
  const ownerBalances = day.ownerBalances.map((row) => {
    const rowOpening = row.opening ?? 0;
    const balance = rowOpening + row.amount;
    return {
      ...row,
      label: row.label ?? row.description,
      description: row.description ?? row.label ?? "",
      balance
    };
  });
  const ownerBalanceTotal = sum(ownerBalances.map((row) => row.balance ?? row.amount));

  const creditRows = day.credits.map((row) => ({
    ...row,
    loan: row.loan ?? row.today ?? 0,
    today: row.loan ?? row.today ?? 0,
    balance: row.opening + (row.loan ?? row.today ?? 0) - row.receive
  }));

  const creditTotals = {
    opening: sum(creditRows.map((row) => row.opening)),
    today: sum(creditRows.map((row) => row.loan ?? row.today ?? 0)),
    receive: sum(creditRows.map((row) => row.receive)),
    balance: sum(creditRows.map((row) => row.balance ?? 0))
  };

  return {
    dayNo: day.dayNo,
    date: day.date,
    label: day.label,
    notes: day.notes,
    openingBalance,
    issueBalance,
    totalBalance,
    expenseTotal,
    returnBalance,
    commissionTotal: issueBalance,
    ownerBalanceTotal,
    ownerBalances,
    creditRows,
    creditTotals
  };
}

export function computeMonth(
  dailyInputs: DailyLedgerInput[],
  openingBalance: number,
  monthId?: string
): MonthComputed {
  const sorted = [...dailyInputs].sort((a, b) => a.dayNo - b.dayNo);
  let currentOpening = openingBalance;

  const days = sorted.map((day) => {
    const computed = computeDay(day, currentOpening);
    currentOpening = computed.returnBalance;
    return computed;
  });

  const commissionMatrix = days.map((day) => {
    const byCategory = emptyCommissionMap();
    for (const item of sorted.find((d) => d.dayNo === day.dayNo)?.commissions ?? []) {
      const category = normalizeCommissionCategory(item.category);
      if (category) byCategory[category] += item.amount;
    }
    return {
      dayNo: day.dayNo,
      byCategory,
      rowTotal: sum(Object.values(byCategory))
    };
  });

  const expenseMap = new Map<string, number>();
  for (const day of sorted) {
    for (const item of day.expenses) {
      const category = expenseCategory(item);
      expenseMap.set(category, (expenseMap.get(category) ?? 0) + item.amount);
    }
  }

  const creditMap = new Map<string, { balance: number; activeDays: Set<number> }>();
  for (const day of days) {
    for (const row of day.creditRows) {
      const current = creditMap.get(row.partyName) ?? { balance: 0, activeDays: new Set<number>() };
      current.balance = row.balance ?? 0;
      if ((row.balance ?? 0) !== 0 || row.opening !== 0 || (row.loan ?? row.today ?? 0) !== 0 || row.receive !== 0) {
        current.activeDays.add(day.dayNo);
      }
      creditMap.set(row.partyName, current);
    }
  }

  return {
    monthId,
    openingBalance,
    days,
    homeSummary: {
      monthlyIssueTotal: sum(days.map((d) => d.issueBalance)),
      monthlyExpenseTotal: sum(days.map((d) => d.expenseTotal)),
      monthlyReturnBalance: days.at(-1)?.returnBalance ?? openingBalance,
      ownerBalanceTotal: sum(days.map((d) => d.ownerBalanceTotal)),
      creditBalanceTotal: sum(days.map((d) => d.creditTotals.balance)),
      expenseByCategory: [...expenseMap.entries()]
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
      creditPartyBalances: [...creditMap.entries()]
        .map(([partyName, value]) => ({
          partyName,
          balance: value.balance,
          activeDays: value.activeDays.size
        }))
        .sort((a, b) => b.balance - a.balance),
      dayRows: days.map((d) => ({
        dayNo: d.dayNo,
        date: d.date,
        label: d.label,
        openingBalance: d.openingBalance,
        issueBalance: d.issueBalance,
        totalBalance: d.totalBalance,
        expenseTotal: d.expenseTotal,
        returnBalance: d.returnBalance,
        creditBalance: d.creditTotals.balance
      })),
      commissionMatrix
    }
  };
}
