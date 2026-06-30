import { describe, expect, it } from "vitest";
import { buildExpenseCarryForwardSeed, computeMonth, resolveCreditClosingBalance } from "./formulaEngine";

describe("formulaEngine", () => {
  it("resolves credit closing balances from supported saved field shapes", () => {
    const base = { id: "credit", partyName: "Party", opening: 10, loan: 5, receive: 2 };

    expect(resolveCreditClosingBalance({ ...base, closingBalance: "1,200" } as never)).toBe(1200);
    expect(resolveCreditClosingBalance({ ...base, balance: "900" } as never)).toBe(900);
    expect(resolveCreditClosingBalance({ ...base, calculatedBalance: 800 } as never)).toBe(800);
    expect(resolveCreditClosingBalance({ ...base, holdingBalance: "700" } as never)).toBe(700);
    expect(resolveCreditClosingBalance(base)).toBe(13);
  });

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

  it("repairs credit party carry-forward from previous closing balances without changing manual movement", () => {
    const month = computeMonth(
      [
        {
          dayNo: 29,
          expenses: [],
          commissions: [],
          credits: [
            {
              id: "day-29-masjid",
              partyId: "masjid-account",
              partyName: "Masjid Account",
              opening: 1000,
              loan: 250,
              loanDescription: "Day 29 loan",
              receive: 50
            }
          ],
          ownerBalances: []
        },
        {
          dayNo: 30,
          expenses: [],
          commissions: [],
          credits: [
            {
              id: "day-30-masjid",
              partyId: "masjid-account",
              partyName: "Masjid Account",
              opening: "0" as unknown as number,
              loan: "75" as unknown as number,
              receive: "25" as unknown as number,
              receiveDescription: "Day 30 receive"
            }
          ],
          ownerBalances: []
        },
        {
          dayNo: 31,
          expenses: [],
          commissions: [],
          credits: [],
          ownerBalances: []
        }
      ],
      0
    );

    expect(month.days[0].creditRows[0].balance).toBe(1200);
    expect(month.days[0].creditRows[0].loanDescription).toBe("Day 29 loan");
    expect(month.days[1].creditRows[0].opening).toBe(1200);
    expect(month.days[1].creditRows[0].loan).toBe(75);
    expect(month.days[1].creditRows[0].receive).toBe(25);
    expect(month.days[1].creditRows[0].balance).toBe(1250);
    expect(month.days[1].creditRows[0].receiveDescription).toBe("Day 30 receive");
    expect(month.days[2].creditRows[0].opening).toBe(1250);
    expect(month.days[2].creditRows[0].balance).toBe(1250);
    expect(month.days[2].creditRows[0].loanDescription).toBeUndefined();
    expect(month.days[2].creditRows[0].receiveDescription).toBeUndefined();
  });

  it("rebuilds credit openings day-by-day from day 28 through day 30 while preserving manual movement", () => {
    const month = computeMonth(
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

    const day28Usman = month.days[0].creditRows.find((row) => row.partyId === "usman-cheema");
    const day28Akhtar = month.days[0].creditRows.find((row) => row.partyId === "akhtar");
    const day29Usman = month.days[1].creditRows.find((row) => row.partyId === "usman-cheema");
    const day29Akhtar = month.days[1].creditRows.find((row) => row.partyId === "akhtar");
    const day30Usman = month.days[2].creditRows.find((row) => row.partyId === "usman-cheema");
    const day30Akhtar = month.days[2].creditRows.find((row) => row.partyId === "akhtar");

    expect(day28Usman?.balance).toBe(2000);
    expect(day28Akhtar?.balance).toBe(18000);
    expect(day29Usman?.opening).toBe(day28Usman?.balance);
    expect(day29Usman?.balance).toBe(day28Usman?.balance);
    expect(day29Akhtar?.opening).toBe(day28Akhtar?.balance);
    expect(day29Akhtar?.balance).toBe(day28Akhtar?.balance);
    expect(day30Usman?.opening).toBe(day29Usman?.balance);
    expect(day30Usman?.loan).toBe(9000);
    expect(day30Usman?.today).toBe(9000);
    expect(day30Usman?.receive).toBe(0);
    expect(day30Usman?.balance).toBe(11000);
    expect(day30Akhtar?.opening).toBe(day29Akhtar?.balance);
    expect(day30Akhtar?.balance).toBe(day29Akhtar?.balance);
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

  it("seeds a new month from previous final calculated expense balances", () => {
    const may = computeMonth(
      [
        {
          dayNo: 31,
          expenses: [{ id: "e1", name: "Expense", description: "Expense", amount: 500 }],
          commissions: [{ id: "c1", category: "JazzLoad", amount: 2500 }],
          credits: [{ id: "usman-may", partyId: "usman", partyName: "Usman", opening: 2000, loan: 9000, receive: 0 }],
          ownerBalances: [{ id: "owner-may", description: "Cash", opening: 100, amount: 50 }]
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
          ownerBalances: [{ id: "owner-june", description: "Cash", opening: 0, amount: 25 }]
        }
      ],
      seed?.openingBalance ?? 0,
      "2026-06",
      seed?.ownerOpeningBalance ?? 0,
      seed ?? undefined
    );

    expect(seed).toMatchObject({
      sourceMonthId: "2026-05",
      sourceDayNo: 31,
      openingBalance: 3000,
      ownerOpeningBalance: 150
    });
    expect(june.days[0].openingBalance).toBe(3000);
    expect(june.days[0].ownerBalances[0].opening).toBe(150);
    expect(june.days[0].creditRows[0]).toMatchObject({
      partyId: "usman",
      opening: 11000,
      receive: 1000,
      balance: 10000
    });
  });
});
