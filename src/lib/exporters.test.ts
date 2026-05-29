import { describe, expect, it } from "vitest";
import { buildDailyReportSheets, buildMonthlyReportSheets } from "./exporters";
import type { DailyLedgerInput, MonthComputed } from "../types/ledger";

const month: MonthComputed = {
  monthId: "2026-05",
  openingBalance: 1000,
  days: [
    {
      dayNo: 1,
      label: "Day 1",
      openingBalance: 1000,
      issueBalance: 500,
      totalBalance: 1500,
      expenseTotal: 200,
      returnBalance: 1300,
      commissionTotal: 500,
      ownerBalanceTotal: -300,
      ownerBalances: [
        {
          id: "owner-1",
          description: "Owner payout",
          amount: 300,
          opening: 0,
          expense: 300,
          received: 0,
          balance: -300
        }
      ],
      creditRows: [
        {
          id: "credit-1",
          partyName: "Customer A",
          opening: 100,
          loan: 50,
          receive: 25,
          balance: 125
        }
      ],
      creditTotals: {
        opening: 100,
        today: 50,
        receive: 25,
        balance: 125
      }
    }
  ],
  homeSummary: {
    monthlyIssueTotal: 500,
    monthlyExpenseTotal: 200,
    monthlyReturnBalance: 1300,
    ownerBalanceTotal: -300,
    creditBalanceTotal: 125,
    expenseByCategory: [{ category: "Rent", amount: 200 }],
    creditPartyBalances: [{ partyName: "Customer A", balance: 125, activeDays: 1 }],
    dayRows: [
      {
        dayNo: 1,
        openingBalance: 1000,
        issueBalance: 500,
        totalBalance: 1500,
        expenseTotal: 200,
        returnBalance: 1300,
        creditBalance: 125
      }
    ],
    commissionMatrix: [{ dayNo: 1, byCategory: { JazzCash: 500 }, rowTotal: 500 }]
  }
};

const input: DailyLedgerInput = {
  dayNo: 1,
  label: "Day 1",
  expenses: [{ id: "expense-1", name: "Rent", description: "Shop rent", amount: 200, category: "Rent" }],
  commissions: [{ id: "commission-1", category: "JazzCash", amount: 500 }],
  credits: [],
  ownerBalances: []
};

describe("report builders", () => {
  it("builds workbook-like monthly sheets with summary and ledgers", () => {
    const sheets = buildMonthlyReportSheets(month);

    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "Summary",
      "Daily Ledger",
      "Commissions",
      "Expenses",
      "Credits",
      "Owner Balance"
    ]);
    expect(sheets[0].rows).toContainEqual(["Monthly Issue Total", 500]);
    expect(sheets[1].rows).toContainEqual([1, "-", 1000, 500, 1500, 200, 1300, 125]);
    expect(sheets[5].rows).toContainEqual(["Day 1", 0, 300, 0, -300]);
  });

  it("builds daily sheets with raw line items and calculated balances", () => {
    const sheets = buildDailyReportSheets(month, 1, input);

    expect(sheets.map((sheet) => sheet.name)).toEqual([
      "Day Summary",
      "Expenses",
      "Commissions",
      "Credit Parties",
      "Owner Balance"
    ]);
    expect(sheets[1].rows).toContainEqual(["Rent", "Rent", "Shop rent", 200]);
    expect(sheets[2].rows).toContainEqual(["JazzCash", 500]);
    expect(sheets[4].rows).toContainEqual(["Owner payout", 0, 300, 0, -300]);
  });

  it("throws clearly when a daily report has no saved day", () => {
    expect(() => buildDailyReportSheets(month, 2)).toThrow("No saved report data found for day 2.");
  });
});
