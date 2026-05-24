import { strict as assert } from "node:assert";
import test from "node:test";
import { computeMonth } from "./formulaEngine";

test("computeMonth handles carry-forward", () => {
  const result = computeMonth(
    [
      {
        dayNo: 1,
        expenses: [{ amount: 19540 }],
        commissions: [{ amount: 11436, category: "JazzLoad" }],
        credits: [{ opening: 0, loan: 0, receive: 0, partyName: "p1" }],
        ownerBalances: [{ description: "Cash", opening: 100, amount: 900 }]
      },
      {
        dayNo: 2,
        expenses: [{ amount: 0 }],
        commissions: [{ amount: 0, category: "JazzLoad" }],
        credits: [{ opening: 0, loan: 0, receive: 0, partyName: "p1" }],
        ownerBalances: []
      }
    ],
    0
  );

  assert.equal(result.days[0].returnBalance, -8104);
  assert.equal(result.days[1].openingBalance, -8104);
  assert.equal(result.homeSummary.ownerBalanceTotal, 1000);
});
