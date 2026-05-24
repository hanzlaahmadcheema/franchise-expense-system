type InputDay = {
  dayNo: number;
  date?: string;
  notes?: string;
  expenses: Array<{ amount: number }>;
  commissions: Array<{ amount: number; category: string }>;
  credits: Array<{ opening: number; today: number; receive: number; partyName: string }>;
  ownerBalances?: Array<{ label: string; amount: number }>;
};

const sum = (nums: number[]) => nums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

export function computeMonth(dailyInputs: InputDay[], openingBalance: number, monthId?: string) {
  const sorted = [...dailyInputs].sort((a, b) => a.dayNo - b.dayNo);
  let currentOpening = openingBalance;

  const days = sorted.map((day) => {
    const issueBalance = sum(day.commissions.map((item) => item.amount));
    const totalBalance = currentOpening + issueBalance;
    const expenseTotal = sum(day.expenses.map((item) => item.amount));
    const returnBalance = totalBalance - expenseTotal;
    const ownerBalances = day.ownerBalances ?? [];
    const ownerBalanceTotal = sum(ownerBalances.map((row) => row.amount));
    const creditRows = day.credits.map((row) => ({
      ...row,
      balance: row.opening + row.today - row.receive
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
      ownerBalanceTotal,
      ownerBalances,
      creditRows,
      creditTotals: {
        opening: sum(creditRows.map((r) => r.opening)),
        today: sum(creditRows.map((r) => r.today)),
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
