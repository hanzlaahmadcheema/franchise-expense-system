import { strict as assert } from "node:assert";
import test from "node:test";
import { buildExpenseCarryForwardSeed, computeMonth } from "./formulaEngine";

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

test("computeMonth rebuilds credit openings day-by-day while preserving manual movement", () => {
  const result = computeMonth(
    [
      {
        dayNo: 28,
        expenses: [],
        commissions: [],
        credits: [
          {
            id: "day-28-usman",
            partyId: "usman-cheema",
            partyName: "Usman cheema",
            opening: 1000,
            loan: 1500,
            receive: 500
          },
          {
            id: "day-28-akhtar",
            partyId: "akhtar",
            partyName: "AKHTAR",
            opening: 10000,
            loan: 10000,
            receive: 2000
          }
        ],
        ownerBalances: []
      },
      {
        dayNo: 29,
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: []
      },
      {
        dayNo: 30,
        expenses: [],
        commissions: [],
        credits: [
          {
            id: "day-30-usman",
            partyId: "usman-cheema",
            partyName: "Usman cheema",
            opening: 0,
            loan: 9000,
            today: 9000,
            receive: 0
          }
        ],
        ownerBalances: []
      }
    ],
    0
  );

  const day28Usman = result.days[0].creditRows.find((row) => row.partyId === "usman-cheema");
  const day28Akhtar = result.days[0].creditRows.find((row) => row.partyId === "akhtar");
  const day29Usman = result.days[1].creditRows.find((row) => row.partyId === "usman-cheema");
  const day29Akhtar = result.days[1].creditRows.find((row) => row.partyId === "akhtar");
  const day30Usman = result.days[2].creditRows.find((row) => row.partyId === "usman-cheema");
  const day30Akhtar = result.days[2].creditRows.find((row) => row.partyId === "akhtar");

  assert.equal(day28Usman?.balance, 2000);
  assert.equal(day28Akhtar?.balance, 18000);
  assert.equal(day29Usman?.opening, day28Usman?.balance);
  assert.equal(day29Usman?.balance, day28Usman?.balance);
  assert.equal(day29Akhtar?.opening, day28Akhtar?.balance);
  assert.equal(day29Akhtar?.balance, day28Akhtar?.balance);
  assert.equal(day30Usman?.opening, day29Usman?.balance);
  assert.equal(day30Usman?.loan, 9000);
  assert.equal(day30Usman?.today, 9000);
  assert.equal(day30Usman?.receive, 0);
  assert.equal(day30Usman?.balance, 11000);
  assert.equal(day30Akhtar?.opening, day29Akhtar?.balance);
  assert.equal(day30Akhtar?.balance, day29Akhtar?.balance);
});

test("computeMonth seeds a new month from previous final calculated expense balances", () => {
  const may = computeMonth(
    [
      {
        dayNo: 31,
        expenses: [{ name: "Expense", description: "Expense", amount: 500 }],
        commissions: [{ category: "JazzLoad", amount: 2500 }],
        credits: [{ id: "usman-may", partyId: "usman", partyName: "Usman", opening: 2000, loan: 9000, receive: 0 }],
        ownerBalances: [{ description: "Cash", opening: 100, amount: 50 }]
      }
    ],
    1000,
    "2026-05",
    100
  );
  const seed = buildExpenseCarryForwardSeed("2026-05", may);
  const june = computeMonth(
    [
      {
        dayNo: 1,
        expenses: [],
        commissions: [],
        credits: [{ id: "usman-june", partyId: "usman", partyName: "Usman", opening: 0, loan: 0, receive: 1000 }],
        ownerBalances: [{ description: "Cash", opening: 0, amount: 25 }]
      }
    ],
    seed?.openingBalance ?? 0,
    "2026-06",
    seed?.ownerOpeningBalance ?? 0,
    seed ?? undefined
  );

  assert.equal(seed?.openingBalance, 3000);
  assert.equal(seed?.ownerOpeningBalance, 150);
  assert.equal(june.days[0].openingBalance, 3000);
  assert.equal(june.days[0].ownerBalances[0].opening, 150);
  assert.equal(june.days[0].creditRows[0].opening, 11000);
  assert.equal(june.days[0].creditRows[0].balance, 10000);
});
