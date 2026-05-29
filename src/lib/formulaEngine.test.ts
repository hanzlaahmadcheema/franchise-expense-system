import { describe, expect, it } from "vitest";
import { computeMonth } from "./formulaEngine";

describe("formulaEngine", () => {
  it("computes carry-forward and totals in day order", () => {
    const month = computeMonth(
      [
        {
          dayNo: 1,
          expenses: [{ id: "e1", name: "A", description: "A", amount: 19540 }],
          commissions: [{ id: "c1", category: "JazzLoad", amount: 11436 }],
          credits: [{ id: "cr1", partyId: "p", partyName: "P", opening: 10, loan: 3, receive: 2 }],
          ownerBalances: [{ id: "o1", description: "Cash", opening: 100, amount: 900 }]
        },
        {
          dayNo: 2,
          expenses: [{ id: "e2", name: "A", description: "A", amount: 0 }],
          commissions: [{ id: "c2", category: "JazzLoad", amount: 0 }],
          credits: [{ id: "cr2", partyId: "p", partyName: "P", opening: 11, loan: 0, receive: 0 }],
          ownerBalances: []
        }
      ],
      0
    );

    expect(month.days[0].issueBalance).toBe(11436);
    expect(month.days[0].returnBalance).toBe(-8104);
    expect(month.days[1].openingBalance).toBe(-8104);
    expect(month.homeSummary.monthlyIssueTotal).toBe(11436);
    expect(month.homeSummary.monthlyExpenseTotal).toBe(19540);
    expect(month.homeSummary.ownerBalanceTotal).toBe(1000);
    expect(month.homeSummary.creditBalanceTotal).toBe(22);
  });

  it("carries owner closing through blank owner days", () => {
    const month = computeMonth(
      [
        {
          dayNo: 1,
          expenses: [],
          commissions: [],
          credits: [],
          ownerBalances: [{ id: "o1", description: "Cash", opening: -85427, amount: 50681 }]
        },
        {
          dayNo: 2,
          expenses: [],
          commissions: [],
          credits: [],
          ownerBalances: []
        }
      ],
      0,
      "2026-05",
      -85427
    );

    expect(month.days[0].ownerBalanceTotal).toBe(-34746);
    expect(month.days[1].ownerBalanceTotal).toBe(-34746);
    expect(month.homeSummary.ownerBalanceTotal).toBe(-34746);
  });

  it("uses the first owner row as the seed when the month owner seed is missing", () => {
    const month = computeMonth(
      [
        {
          dayNo: 1,
          expenses: [],
          commissions: [],
          credits: [],
          ownerBalances: [{ id: "o1", description: "Cash", opening: -85427, amount: 1000 }]
        }
      ],
      0,
      "2026-05"
    );

    expect(month.days[0].ownerBalances[0].opening).toBe(-85427);
    expect(month.days[0].ownerBalanceTotal).toBe(-84427);
    expect(month.homeSummary.ownerBalanceTotal).toBe(-84427);
  });

  it("recomputes deterministically after a locally queued offline edit", () => {
    const originalDays = [
      {
        dayNo: 1,
        expenses: [{ id: "e1", name: "Salary", description: "Salary", amount: 100 }],
        commissions: [{ id: "c1", category: "JazzLoad", amount: 500 }],
        credits: [],
        ownerBalances: [{ id: "o1", description: "Cash", opening: 10, amount: 15 }]
      },
      {
        dayNo: 2,
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: []
      }
    ];
    const editedDay = {
      ...originalDays[0],
      expenses: [{ id: "e1", name: "Salary", description: "Salary", amount: 250 }]
    };
    const offlineDays = [editedDay, originalDays[1]];

    const localComputed = computeMonth(offlineDays, 1000, "2026-05", 10);
    const reloadedComputed = computeMonth([...offlineDays].reverse(), 1000, "2026-05", 10);

    expect(localComputed.homeSummary).toEqual(reloadedComputed.homeSummary);
    expect(localComputed.days[1].openingBalance).toBe(1250);
    expect(localComputed.homeSummary.monthlyExpenseTotal).toBe(250);
  });

  it("keeps automated balance fields derived from inputs", () => {
    const month = computeMonth(
      [
        {
          dayNo: 32,
          expenses: [{ id: "e1", name: "Fuel", description: "Fuel", amount: 100, categoryId: "fuel", category: "Fuel" }],
          commissions: [{ id: "c1", category: "JazzCash", amount: 500 }],
          credits: [{ id: "cr1", partyId: "party-1", partyName: "Party 1", opening: 50, loan: 25, receive: 10 }],
          ownerBalances: [{ id: "o1", description: "Cash", opening: 20, amount: 5 }]
        }
      ],
      1000
    );

    expect(month.days[0].openingBalance).toBe(1000);
    expect(month.days[0].issueBalance).toBe(500);
    expect(month.days[0].totalBalance).toBe(1500);
    expect(month.days[0].returnBalance).toBe(1400);
    expect(month.days[0].creditRows[0].balance).toBe(65);
    expect(month.days[0].ownerBalances[0].balance).toBe(25);
  });
});
