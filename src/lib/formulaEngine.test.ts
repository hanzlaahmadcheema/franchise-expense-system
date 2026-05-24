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
