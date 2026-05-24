import { strict as assert } from "node:assert";
import test from "node:test";
import { computeMonth } from "./formulaEngine";

test("computeMonth handles carry-forward", () => {
  const result = computeMonth(
    [
      {
        dayNo: 1,
        expenses: [{ amount: 19540 }],
        commissions: [{ amount: 11436, category: "Jazz Load" }],
        credits: [{ opening: 0, today: 0, receive: 0, partyName: "p1" }],
        ownerBalances: [{ label: "Cash", amount: 1000 }]
      },
      {
        dayNo: 2,
        expenses: [{ amount: 0 }],
        commissions: [{ amount: 0, category: "Jazz Load" }],
        credits: [{ opening: 0, today: 0, receive: 0, partyName: "p1" }],
        ownerBalances: []
      }
    ],
    0
  );

  assert.equal(result.days[0].returnBalance, -8104);
  assert.equal(result.days[1].openingBalance, -8104);
  assert.equal(result.homeSummary.ownerBalanceTotal, 1000);
});
