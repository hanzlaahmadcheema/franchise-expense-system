import {
  type DailyLedgerComputed,
  type DailyLedgerInput,
  type MonthComputed
} from "../types/ledger";

function roundAmount(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

const sum = (nums: number[]) => roundAmount(nums.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0));

export function parseLedgerNumber(value: unknown): number {
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

function normalizeCommissionCategory(category: string): string {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return category;
}

type CreditLike = DailyLedgerInput["credits"][number] & Record<string, unknown>;

function creditCarryKey(row: Pick<CreditLike, "partyId" | "partyName">) {
  return row.partyId ? `id:${row.partyId}` : `name:${normalizeKey(row.partyName ?? "")}`;
}

export function resolveCreditClosingBalance(row: Partial<CreditLike>): number {
  const explicit = [
    row.closingBalance,
    row.balance,
    row.calculatedBalance,
    row.holdingBalance
  ];
  for (const value of explicit) {
    if (value !== undefined && value !== null && value !== "") return parseLedgerNumber(value);
  }
  return roundAmount(
    parseLedgerNumber(row.opening) +
    parseLedgerNumber(row.loan ?? row.today) -
    parseLedgerNumber(row.receive)
  );
}

function normalizeCreditRow(row: DailyLedgerInput["credits"][number]): DailyLedgerInput["credits"][number] {
  const loan = parseLedgerNumber(row.loan ?? row.today);
  return {
    ...row,
    opening: parseLedgerNumber(row.opening),
    loan,
    today: loan,
    receive: parseLedgerNumber(row.receive),
    balance: resolveCreditClosingBalance(row as CreditLike)
  };
}

function applyCreditCarryForward(
  dayNo: number,
  rows: DailyLedgerInput["credits"],
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

export function computeDay(day: DailyLedgerInput, openingBalance: number, ownerOpeningBalance = 0): DailyLedgerComputed {
  const issueBalance = roundAmount(sum(day.commissions.map((item) => item.amount)));
  const totalBalance = roundAmount(openingBalance + issueBalance);
  const expenseTotal = roundAmount(sum(day.expenses.map((item) => item.amount)));
  const returnBalance = roundAmount(totalBalance - expenseTotal);
  const ownerRows = day.ownerBalances.filter((row) => normalizeKey(row.description ?? row.label ?? "") !== "opening bal");
  let ownerRunningOpening = roundAmount(ownerOpeningBalance || (ownerRows[0]?.opening ?? 0));
  const ownerBalances = ownerRows.map((row) => {
    const amt = Number.isFinite(row.amount) ? (row.amount as number) : 0;
    const expense = roundAmount(Number.isFinite(row.expense) ? (row.expense as number) : Math.max(amt, 0));
    const received = roundAmount(Number.isFinite(row.received) ? (row.received as number) : Math.max(-amt, 0));
    const amount = roundAmount(expense - received);
    const rowOpening = roundAmount(Number.isFinite(ownerRunningOpening) ? ownerRunningOpening : 0);
    const balance = roundAmount(rowOpening + amount);
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
  const ownerBalanceTotal = roundAmount(ownerBalances.at(-1)?.balance ?? ownerOpeningBalance);

  const creditRows = day.credits.map((row) => {
    const opening = parseLedgerNumber(row.opening);
    const loan = parseLedgerNumber(row.loan ?? row.today);
    const receive = parseLedgerNumber(row.receive);
    return {
      ...row,
      opening,
      loan,
      today: loan,
      receive,
      balance: roundAmount(opening + loan - receive)
    };
  });

  const creditTotals = {
    opening: roundAmount(sum(creditRows.map((row) => row.opening))),
    today: roundAmount(sum(creditRows.map((row) => row.loan ?? row.today ?? 0))),
    receive: roundAmount(sum(creditRows.map((row) => row.receive))),
    balance: roundAmount(sum(creditRows.map((row) => row.balance ?? 0)))
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
  monthId?: string,
  ownerOpeningBalance = 0
): MonthComputed {
  const sorted = [...dailyInputs].sort((a, b) => a.dayNo - b.dayNo);
  let currentOpening = openingBalance;
  let currentOwnerOpening = ownerOpeningBalance;
  const creditRunningBalances = new Map<string, { partyId?: string; partyName: string; balance: number }>();

  const days = sorted.map((day) => {
    const dayWithCarriedCredits = {
      ...day,
      credits: applyCreditCarryForward(day.dayNo, day.credits, creditRunningBalances)
    };
    const computed = computeDay(dayWithCarriedCredits, currentOpening, currentOwnerOpening);
    currentOpening = computed.returnBalance;
    currentOwnerOpening = computed.ownerBalanceTotal;
    for (const row of computed.creditRows) {
      const key = creditCarryKey(row as CreditLike);
      const balance = resolveCreditClosingBalance(row as CreditLike);
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
    return computed;
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
