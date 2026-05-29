type InputDay = {
  dayNo: number;
  date?: string;
  label?: string;
  notes?: string;
  expenses: Array<{ amount: number; category?: string; name?: string; description?: string }>;
  commissions: Array<{ amount: number; category: string }>;
  credits: Array<{ opening: number; today?: number; loan?: number; receive: number; partyName: string }>;
  ownerBalances?: Array<{ label?: string; description?: string; opening?: number; amount: number; expense?: number; received?: number }>;
};

const sum = (nums: number[]) => nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function normalizeCommissionCategory(category: string) {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return category;
}

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

export function computeMonth(dailyInputs: InputDay[], openingBalance: number, monthId?: string, ownerOpeningBalance = 0) {
  const sorted = [...dailyInputs].sort((a, b) => a.dayNo - b.dayNo);
  let currentOpening = openingBalance;
  let currentOwnerOpening = ownerOpeningBalance;

  const days = sorted.map((day) => {
    const issueBalance = sum(day.commissions.map((item) => item.amount));
    const commissions = day.commissions.map((item) => ({
      ...item,
      category: normalizeCommissionCategory(item.category)
    }));
    const totalBalance = currentOpening + issueBalance;
    const expenseTotal = sum(day.expenses.map((item) => item.amount));
    const returnBalance = totalBalance - expenseTotal;
    const ownerRows = (day.ownerBalances ?? []).filter((row) => {
      const description = (row.description ?? row.label ?? "").trim().toLowerCase();
      return description !== "opening bal";
    });
    let ownerRunningOpening = currentOwnerOpening || (ownerRows[0]?.opening ?? 0);
    const ownerBalances = ownerRows.map((row) => {
      const expense = row.expense ?? Math.max(row.amount, 0);
      const received = row.received ?? Math.max(-row.amount, 0);
      const amount = expense - received;
      const rowOpening = ownerRunningOpening;
      const balance = rowOpening + amount;
      ownerRunningOpening = balance;
      return {
        ...row,
        amount,
        expense,
        received,
        opening: rowOpening,
        label: row.label ?? row.description,
        description: row.description ?? row.label ?? "",
        balance
      };
    });
    const ownerBalanceTotal = ownerBalances.at(-1)?.balance ?? currentOwnerOpening;
    const creditRows = day.credits.map((row) => ({
      ...row,
      loan: row.loan ?? row.today ?? 0,
      today: row.loan ?? row.today ?? 0,
      receive: row.receive ?? 0,
      balance: row.opening + (row.loan ?? row.today ?? 0) - (row.receive ?? 0)
    }));

    const result = {
      dayNo: day.dayNo,
      date: day.date,
      label: day.label,
      notes: day.notes,
      openingBalance: currentOpening,
      issueBalance,
      totalBalance,
      expenseTotal,
      returnBalance,
      commissionTotal: issueBalance,
      commissions,
      ownerBalanceTotal,
      ownerBalances,
      creditRows,
      creditTotals: {
        opening: sum(creditRows.map((r) => r.opening)),
        today: sum(creditRows.map((r) => r.loan ?? r.today ?? 0)),
        receive: sum(creditRows.map((r) => r.receive)),
        balance: sum(creditRows.map((r) => r.balance))
      }
    };

    currentOpening = returnBalance;
    currentOwnerOpening = ownerBalanceTotal;
    return result;
  });

  const commissionMatrix = days.map((day) => {
    const byCategory: Record<string, number> = {};
    for (const item of sorted.find((d) => d.dayNo === day.dayNo)?.commissions ?? []) {
      const category = normalizeCommissionCategory(item.category);
      byCategory[category] = (byCategory[category] ?? 0) + item.amount;
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
      ownerBalanceTotal: days.at(-1)?.ownerBalanceTotal ?? ownerOpeningBalance,
      creditBalanceTotal: sum(days.map((d) => d.creditTotals.balance)),
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
      commissionMatrix
    }
  };
}
