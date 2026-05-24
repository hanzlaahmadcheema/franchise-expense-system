type InputDay = {
  dayNo: number;
  date?: string;
  notes?: string;
  expenses: Array<{ amount: number }>;
  commissions: Array<{ amount: number; category: string }>;
  credits: Array<{ opening: number; today?: number; loan?: number; receive: number; partyName: string }>;
  ownerBalances?: Array<{ label?: string; description?: string; opening?: number; amount: number }>;
};

const sum = (nums: number[]) => nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

function normalizeCommissionCategory(category: string) {
  if (category === "Jazz Cash") return "JazzCash";
  if (category === "Jazz Load") return "JazzLoad";
  return category;
}

export function computeMonth(dailyInputs: InputDay[], openingBalance: number, monthId?: string) {
  const sorted = [...dailyInputs].sort((a, b) => a.dayNo - b.dayNo);
  let currentOpening = openingBalance;

  const days = sorted.map((day) => {
    const issueBalance = sum(day.commissions.map((item) => item.amount));
    const commissions = day.commissions.map((item) => ({
      ...item,
      category: normalizeCommissionCategory(item.category)
    }));
    const totalBalance = currentOpening + issueBalance;
    const expenseTotal = sum(day.expenses.map((item) => item.amount));
    const returnBalance = totalBalance - expenseTotal;
    const ownerBalances = (day.ownerBalances ?? []).map((row) => {
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

    const result = {
      dayNo: day.dayNo,
      date: day.date,
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
    return result;
  });

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
      dayRows: days.map((d) => ({
        dayNo: d.dayNo,
        date: d.date,
        openingBalance: d.openingBalance,
        issueBalance: d.issueBalance,
        totalBalance: d.totalBalance,
        expenseTotal: d.expenseTotal,
        returnBalance: d.returnBalance,
        creditBalance: d.creditTotals.balance
      }))
    }
  };
}
