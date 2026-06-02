type InputDay = {
  dayNo: number;
  date?: string;
  label?: string;
  notes?: string;
  expenses: Array<{ amount: number; category?: string; name?: string; description?: string }>;
  commissions: Array<{ amount: number; category: string }>;
  credits: Array<{ id?: string; partyId?: string; opening: number; today?: number; loan?: number; receive: number; partyName: string; balance?: number; closingBalance?: number; calculatedBalance?: number; holdingBalance?: number }>;
  ownerBalances?: Array<{ label?: string; description?: string; opening?: number; amount: number; expense?: number; received?: number }>;
};

type ExpenseCarryForwardSeed = {
  sourceMonthId: string;
  sourceDayNo: number;
  openingBalance: number;
  ownerOpeningBalance: number;
  creditBalances: Array<{ partyId?: string; partyName: string; balance: number }>;
};

const sum = (nums: number[]) => nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

function roundAmount(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function parseLedgerNumber(value: unknown): number {
  if (typeof value === "number") return roundAmount(value);
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? roundAmount(parsed) : 0;
  }
  return 0;
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function normalizeCommissionCategory(category: string) {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return category;
}

function creditCarryKey(row: { partyId?: string; partyName: string }) {
  return row.partyId ? `id:${row.partyId}` : `name:${normalizeKey(row.partyName ?? "")}`;
}

function resolveCreditClosingBalance(row: Record<string, unknown>) {
  const explicit = [row.closingBalance, row.balance, row.calculatedBalance, row.holdingBalance];
  for (const value of explicit) {
    if (value !== undefined && value !== null && value !== "") return parseLedgerNumber(value);
  }
  return roundAmount(
    parseLedgerNumber(row.opening) +
    parseLedgerNumber(row.loan ?? row.today) -
    parseLedgerNumber(row.receive)
  );
}

function normalizeCreditRow(row: InputDay["credits"][number]) {
  const loan = parseLedgerNumber(row.loan ?? row.today);
  return {
    ...row,
    opening: parseLedgerNumber(row.opening),
    loan,
    today: loan,
    receive: parseLedgerNumber(row.receive),
    balance: resolveCreditClosingBalance(row as Record<string, unknown>)
  };
}

function applyCreditCarryForward(
  dayNo: number,
  rows: InputDay["credits"],
  runningBalances: Map<string, { partyId?: string; partyName: string; balance: number }>
) {
  const normalizedRows = rows.map(normalizeCreditRow);
  const seenKeys = new Set(normalizedRows.map(creditCarryKey));
  const carriedRows = normalizedRows.map((row) => {
    const previous = runningBalances.get(creditCarryKey(row));
    if (!previous) return row;
    return {
      ...row,
      opening: previous.balance,
      balance: roundAmount(previous.balance + parseLedgerNumber(row.loan ?? row.today) - parseLedgerNumber(row.receive))
    };
  });

  for (const [key, previous] of runningBalances.entries()) {
    if (previous.balance === 0 || seenKeys.has(key)) continue;
    carriedRows.push({
      id: `${dayNo}-credit-carry-${key.replace(/[^a-z0-9-]+/gi, "-")}`,
      partyId: previous.partyId,
      partyName: previous.partyName,
      opening: previous.balance,
      loan: 0,
      today: 0,
      receive: 0,
      balance: previous.balance
    });
  }

  return carriedRows;
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

export function computeMonth(
  dailyInputs: InputDay[],
  openingBalance: number,
  monthId?: string,
  ownerOpeningBalance = 0,
  carryForwardSeed?: Pick<ExpenseCarryForwardSeed, "creditBalances">
) {
  const sorted = [...dailyInputs].sort((a, b) => a.dayNo - b.dayNo);
  let currentOpening = Number.isFinite(openingBalance) ? openingBalance : 0;
  let currentOwnerOpening = Number.isFinite(ownerOpeningBalance) ? ownerOpeningBalance : 0;
  const creditRunningBalances = new Map<string, { partyId?: string; partyName: string; balance: number }>(
    (carryForwardSeed?.creditBalances ?? [])
      .filter((row) => parseLedgerNumber(row.balance) !== 0)
      .map((row) => [
        creditCarryKey(row),
        {
          partyId: row.partyId,
          partyName: row.partyName,
          balance: parseLedgerNumber(row.balance)
        }
      ])
  );

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
      const amt = Number.isFinite(row.amount) ? (row.amount as number) : 0;
      const expense = Number.isFinite(row.expense) ? (row.expense as number) : Math.max(amt, 0);
      const received = Number.isFinite(row.received) ? (row.received as number) : Math.max(-amt, 0);
      const amount = expense - received;
      const rowOpening = Number.isFinite(ownerRunningOpening) ? ownerRunningOpening : 0;
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
    const carriedCredits = applyCreditCarryForward(day.dayNo, day.credits, creditRunningBalances);
    const creditRows = carriedCredits.map((row) => {
      const opening = parseLedgerNumber(row.opening);
      const loan = parseLedgerNumber(row.loan ?? row.today);
      const receive = parseLedgerNumber(row.receive);
      return {
        ...row,
        opening,
        loan,
        today: loan,
        receive,
        balance: opening + loan - receive
      };
    });

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
    for (const row of creditRows) {
      const key = creditCarryKey(row);
      const balance = resolveCreditClosingBalance(row as Record<string, unknown>);
      if (balance === 0) {
        creditRunningBalances.delete(key);
      } else {
        creditRunningBalances.set(key, {
          partyId: row.partyId,
          partyName: row.partyName,
          balance
        });
      }
    }
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

export function finalExpenseComputedDay(computed: { days: Array<Record<string, unknown>> }) {
  return computed.days.find((day) => Number(day.dayNo) === 32) ??
    [...computed.days].filter((day) => Number(day.dayNo) >= 1 && Number(day.dayNo) <= 31).at(-1) ??
    computed.days.at(-1);
}

export function buildExpenseCarryForwardSeed(sourceMonthId: string, computed: ReturnType<typeof computeMonth>): ExpenseCarryForwardSeed | null {
  const finalDay = finalExpenseComputedDay(computed);
  if (!finalDay) return null;
  const creditRows = Array.isArray(finalDay.creditRows) ? finalDay.creditRows as Array<Record<string, unknown>> : [];
  return {
    sourceMonthId,
    sourceDayNo: numberValue(finalDay.dayNo),
    openingBalance: numberValue(finalDay.returnBalance),
    ownerOpeningBalance: numberValue(finalDay.ownerBalanceTotal),
    creditBalances: creditRows
      .filter((row) => parseLedgerNumber(row.balance) !== 0)
      .map((row) => ({
        partyId: typeof row.partyId === "string" ? row.partyId : undefined,
        partyName: String(row.partyName ?? ""),
        balance: parseLedgerNumber(row.balance)
      }))
  };
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}
