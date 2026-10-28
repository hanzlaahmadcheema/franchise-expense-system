import { describe, it, expect } from "vitest";
import {
  expenseCarryForwardWarnings,
  isServerLoadedDay,
} from "../../App";
import type { DailyLedgerInput, MonthRecord, ExpenseCarryForwardSeed, ExpenseCarryForwardCreditBalance } from "../../types/ledger";

describe("Expense Carry-Forward Hydration Awareness", () => {
  const sampleMonth: MonthRecord = {
    id: "2026-10",
    label: "October 2026",
    openingBalance: 150000,
    ownerOpeningBalance: 50000,
    status: "closed"
  };

  const sampleSeed: ExpenseCarryForwardSeed = {
    isGenesis: false,
    sourceMonthId: "2026-09",
    sourceDayNo: 31,
    openingBalance: 150000,
    ownerOpeningBalance: 50000,
    creditBalances: [
      { partyId: "party-1", partyName: "AKHTAR", balance: 25000 },
      { partyId: "party-2", partyName: "ALI OLAKH", balance: 12000 },
      { partyId: "party-3", partyName: "DSO HASAN", balance: 8000 },
      { partyId: "party-4", partyName: "IMRAN OLAKH", balance: 15000 },
      { partyId: "party-5", partyName: "Masjid Account", balance: 500 },
      { partyId: "party-6", partyName: "MIRZA DO DEVICES", balance: 35000 },
      { partyId: "party-7", partyName: "Tetas ccr", balance: 4200 },
      { partyId: "party-8", partyName: "Usman cheema", balance: 19000 },
    ]
  };

  const skeletonDay1: DailyLedgerInput = {
    dayNo: 1,
    date: "2026-10-01",
    status: "closed",
    lockedAt: 1727740800000,
    closedAt: 1727740800000,
    expenses: [],
    commissions: [],
    credits: [],
    ownerBalances: []
  };

  const hydratedDay8: DailyLedgerInput = {
    dayNo: 8,
    date: "2026-10-08",
    status: "open",
    updatedAt: 1728345600000,
    openingCash: 120000,
    expenses: [
      { id: "exp-1", name: "Tea", description: "Office tea", amount: 200 }
    ],
    commissions: [],
    credits: [],
    ownerBalances: []
  };

  describe("isServerLoadedDay helper", () => {
    it("returns false for undefined or null days", () => {
      expect(isServerLoadedDay(undefined)).toBe(false);
      expect(isServerLoadedDay(null)).toBe(false);
    });

    it("returns false for skeleton placeholder days", () => {
      expect(isServerLoadedDay(skeletonDay1)).toBe(false);
    });

    it("returns false when day has a loadError", () => {
      const errorDay: DailyLedgerInput = {
        ...skeletonDay1,
        loadError: "Network timeout fetching day 1"
      };
      expect(isServerLoadedDay(errorDay)).toBe(false);
    });

    it("returns true for server-loaded days with updatedAt > 0", () => {
      expect(isServerLoadedDay(hydratedDay8)).toBe(true);
    });

    it("returns true for days with openingCash defined", () => {
      const dayWithCash: DailyLedgerInput = {
        ...skeletonDay1,
        openingCash: 1000
      };
      expect(isServerLoadedDay(dayWithCash)).toBe(true);
    });

    it("returns true for days with credits populated", () => {
      const dayWithCredits: DailyLedgerInput = {
        ...skeletonDay1,
        credits: [
          { id: "c1", partyId: "p1", partyName: "Party 1", opening: 100, loan: 0, receive: 0 }
        ]
      };
      expect(isServerLoadedDay(dayWithCredits)).toBe(true);
    });
  });

  describe("Cold refresh on Day 8 with unhydrated Day 1", () => {
    it("does not report false credit opening mismatches when Day 1 is an unhydrated placeholder", () => {
      const days = [skeletonDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(sampleMonth, days, sampleSeed);

      // Should NOT flag the 8 credit parties as missing because Day 1 is not yet server-loaded
      expect(warnings).toEqual([]);
    });

    it("still checks month-level cash and owner opening balances even when Day 1 is unhydrated", () => {
      const mismatchedMonth: MonthRecord = {
        ...sampleMonth,
        openingBalance: 999999
      };
      const days = [skeletonDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(mismatchedMonth, days, sampleSeed);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("cash opening 999,999 should equal 2026-09 closing 150,000");
    });
  });

  describe("Hydrated Day 1 validation", () => {
    it("reports 0 warnings when authoritative Day 1 matches seed credit balances perfectly", () => {
      const authoritativeDay1: DailyLedgerInput = {
        dayNo: 1,
        date: "2026-10-01",
        status: "closed",
        updatedAt: 1727740800000,
        openingCash: 150000,
        ownerOpeningBalance: 50000,
        expenses: [],
        commissions: [],
        credits: sampleSeed.creditBalances.map((cb: ExpenseCarryForwardCreditBalance) => ({
          id: `c-${cb.partyId}`,
          partyId: cb.partyId,
          partyName: cb.partyName,
          opening: cb.balance,
          loan: 0,
          receive: 0
        })),
        ownerBalances: []
      };

      const days = [authoritativeDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(sampleMonth, days, sampleSeed);
      expect(warnings).toEqual([]);
    });

    it("detects and reports genuine credit opening amount mismatches after Day 1 hydrates", () => {
      const authoritativeDay1: DailyLedgerInput = {
        dayNo: 1,
        date: "2026-10-01",
        status: "closed",
        updatedAt: 1727740800000,
        openingCash: 150000,
        ownerOpeningBalance: 50000,
        expenses: [],
        commissions: [],
        credits: sampleSeed.creditBalances.map((cb: ExpenseCarryForwardCreditBalance) => ({
          id: `c-${cb.partyId}`,
          partyId: cb.partyId,
          partyName: cb.partyName,
          // Intentionally mismatch AKHTAR
          opening: cb.partyName === "AKHTAR" ? 999 : cb.balance,
          loan: 0,
          receive: 0
        })),
        ownerBalances: []
      };

      const days = [authoritativeDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(sampleMonth, days, sampleSeed);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("AKHTAR credit opening 999 should equal 2026-09 closing 25,000");
    });

    it("detects and reports missing credit party when authoritative Day 1 is missing an expected party", () => {
      // Authoritative Day 1 has 7 parties instead of 8
      const authoritativeDay1: DailyLedgerInput = {
        dayNo: 1,
        date: "2026-10-01",
        status: "closed",
        updatedAt: 1727740800000,
        openingCash: 150000,
        ownerOpeningBalance: 50000,
        expenses: [],
        commissions: [],
        credits: sampleSeed.creditBalances
          .filter((cb: ExpenseCarryForwardCreditBalance) => cb.partyName !== "Usman cheema")
          .map((cb: ExpenseCarryForwardCreditBalance) => ({
            id: `c-${cb.partyId}`,
            partyId: cb.partyId,
            partyName: cb.partyName,
            opening: cb.balance,
            loan: 0,
            receive: 0
          })),
        ownerBalances: []
      };

      const days = [authoritativeDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(sampleMonth, days, sampleSeed);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("Usman cheema credit opening is missing; expected 19,000 from 2026-09");
    });
  });

  describe("Day 1 Load Failure", () => {
    it("reports verification unavailable when options.day1LoadError is provided", () => {
      const days = [skeletonDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(sampleMonth, days, sampleSeed, {
        day1LoadError: "PostgreSQL 500 Internal Server Error"
      });

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toBe("Day 1 opening carry-forward verification unavailable: PostgreSQL 500 Internal Server Error");
    });

    it("reports verification unavailable when Day 1 has loadError property set", () => {
      const failedDay1: DailyLedgerInput = {
        ...skeletonDay1,
        loadError: "Network timeout"
      };
      const days = [failedDay1, hydratedDay8];
      const warnings = expenseCarryForwardWarnings(sampleMonth, days, sampleSeed);

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toBe("Day 1 opening carry-forward verification unavailable: Network timeout");
    });
  });
});
