import { describe, expect, it } from "vitest";
import { computeMonth } from "./formulaEngine";

describe("formulaEngine", () => {
  it("computes carry-forward and totals in day order", () => {
    const month = computeMonth(
      [
        {
          dayNo: 1,
          expenses: [{ id: "e1", name: "A", description: "A", amount: 19540 }],
          commissions: [{ id: "c1", category: "Jazz Load", amount: 11436 }],
          credits: [{ id: "cr1", partyName: "P", opening: 10, today: 3, receive: 2 }],
          ownerBalances: [{ id: "o1", label: "Cash", amount: 1000 }]
        },
        {
          dayNo: 2,
          expenses: [{ id: "e2", name: "A", description: "A", amount: 0 }],
          commissions: [{ id: "c2", category: "Jazz Load", amount: 0 }],
          credits: [{ id: "cr2", partyName: "P", opening: 11, today: 0, receive: 0 }],
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
});
