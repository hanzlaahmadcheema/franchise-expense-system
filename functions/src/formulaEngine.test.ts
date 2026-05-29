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

test("computeMonth carries owner closing across blank owner days", () => {
  const result = computeMonth(
    [
      {
        dayNo: 1,
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: [{ description: "Cash", opening: -85427, amount: 50681 }]
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

  assert.equal(result.days[0].ownerBalanceTotal, -34746);
  assert.equal(result.days[1].ownerBalanceTotal, -34746);
  assert.equal(result.homeSummary.ownerBalanceTotal, -34746);
});

test("computeMonth uses first owner row as seed when month owner seed is missing", () => {
  const result = computeMonth(
    [
      {
        dayNo: 1,
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: [{ description: "Cash", opening: -85427, amount: 1000 }]
      }
    ],
    0,
    "2026-05"
  );

  assert.equal(result.days[0].ownerBalances[0].opening, -85427);
  assert.equal(result.days[0].ownerBalanceTotal, -84427);
  assert.equal(result.homeSummary.ownerBalanceTotal, -84427);
});

test("computeMonth remains stable after a locally queued offline edit", () => {
  const originalDays = [
    {
      dayNo: 1,
      expenses: [{ name: "Salary", description: "Salary", amount: 100 }],
      commissions: [{ category: "JazzLoad", amount: 500 }],
      credits: [],
      ownerBalances: [{ description: "Cash", opening: 10, amount: 15 }]
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
    expenses: [{ name: "Salary", description: "Salary", amount: 250 }]
  };
  const offlineDays = [editedDay, originalDays[1]];

  const localComputed = computeMonth(offlineDays, 1000, "2026-05", 10);
  const reloadedComputed = computeMonth([...offlineDays].reverse(), 1000, "2026-05", 10);

  assert.deepEqual(localComputed.homeSummary, reloadedComputed.homeSummary);
  assert.equal(localComputed.days[1].openingBalance, 1250);
  assert.equal(localComputed.homeSummary.monthlyExpenseTotal, 250);
});
