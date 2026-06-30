import { describe, expect, it } from "vitest";
import {
  calculateAmountWithRate,
  calculateDailyLifting,
  calculateDailySummary,
  calculateDoRow,
  calculateMonthlySummary,
  latestEntryForDraft,
  previousEntryForDraftAcrossDays,
  resolveJazzLoadRatesForDay,
  snapshotResolvedRates,
  validateJazzLoadDrafts
} from "./jazzLoadCalculations";
import { rechainJazzLoadDays } from "./jazzLoadFirestore";
import type { ActiveJazzLoadRates, JazzLoadDay, JazzLoadRateConfig } from "../types/jazzLoad.types";

const mlRate: JazzLoadRateConfig = {
  id: "rate-ml",
  name: "Jazz Load 2.6",
  type: "ml_addition",
  percentage: 2.6,
  active: true,
  createdBy: "owner",
  createdAt: 1,
  updatedAt: 1
};

const rates: ActiveJazzLoadRates = {
  mlRate,
  commission1Rate: {
    id: "commission-1",
    name: "Commission 1 adjustment",
    type: "commission1_adjustment",
    percentage: 2.6,
    active: true,
    createdBy: "owner",
    createdAt: 1,
    updatedAt: 1
  },
  commission2Rate: {
    id: "commission-2",
    name: "Commission 2 payment",
    type: "commission2_payment",
    percentage: 1,
    active: true,
    createdBy: "owner",
    createdAt: 1,
    updatedAt: 1
  }
};

function ratesWithCommission1(percentage: number): ActiveJazzLoadRates {
  return {
    ...rates,
    commission1Rate: {
      ...rates.commission1Rate!,
      id: `commission-1-${percentage}`,
      name: `Commission 1 ${percentage}`,
      percentage
    }
  };
}

describe("jazzLoadCalculations", () => {
  it("calculates Jazz Load values from owner-managed rate", () => {
    expect(calculateAmountWithRate(100000, mlRate, 10)).toEqual({
      baseAmount: 100000,
      calculatedAmount: 102600,
      appliedRateId: "rate-ml",
      appliedRateName: "Jazz Load 2.6",
      appliedRatePercentage: 2.6,
      calculatedAt: 10
    });
  });

  it("computes a DO row without compounding Jazz Load percentages", () => {
    const row = calculateDoRow(
      {
        id: "rizwan",
        doName: "RIZWAN",
        doLine: "3017211475",
        openingBase: 0,
        todayMlIssuanceBase: 185000,
        paymentReceivedBase: 185000
      },
      rates,
      { createdBy: "user-1", timestamp: 20 }
    );

    expect(row.todayMlIssuance.calculatedAmount).toBe(189810);
    expect(row.dayTotal.calculatedAmount).toBe(189810);
    expect(row.closingBalance.calculatedAmount).toBe(0);
  });

  it("calculates commission 1 and commission 2 from daily payment totals", () => {
    const row = calculateDoRow(
      {
        id: "rizwan",
        doName: "RIZWAN",
        openingBase: 0,
        todayMlIssuanceBase: 185000,
        paymentReceivedBase: 185000
      },
      rates,
      { createdBy: "user-1", timestamp: 20 }
    );
    const summary = calculateDailySummary({ doEntries: [row] }, rates, 30);

    expect(summary.paymentBase).toBe(185000);
    expect(summary.paymentMl).toBe(189810);
    expect(summary.commission1MlDeduction).toBe(4935.06);
    expect(summary.commission1AdjustedPayment).toBe(184874.94);
    expect(summary.commission1).toBe(125.06);
    expect(summary.commission2).toBe(1850);
    expect(summary.totalCommission).toBe(1975.06);
    expect(summary.commission1Rate?.percentage).toBe(2.6);
    expect(summary.commission2Rate?.percentage).toBe(1);
  });

  it("preserves a saved day rate snapshot when an old day is resaved after settings change", () => {
    const savedRates = ratesWithCommission1(2);
    const currentRates = ratesWithCommission1(3);
    const savedEntry = calculateDoRow(
      { id: "day-10-a", doName: "A", todayMlIssuanceBase: 1000, paymentReceivedBase: 500 },
      savedRates,
      { createdBy: "u", timestamp: 1 }
    );
    const savedDay: JazzLoadDay = {
      id: "10",
      monthId: "2026-05",
      dayNo: 10,
      date: "2026-05-10",
      status: "reopen",
      doEntries: [savedEntry],
      lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, savedEntry.todayMlIssuance.calculatedAmount),
      summary: calculateDailySummary({ doEntries: [savedEntry] }, savedRates, 1),
      appliedRates: snapshotResolvedRates(savedRates, 1),
      createdBy: "u",
      createdAt: 1,
      updatedAt: 1
    };

    const resolved = resolveJazzLoadRatesForDay({
      dayRecord: savedDay,
      activeRates: currentRates,
      mode: "existing-day",
      resolvedAt: 2
    });
    const resavedEntry = calculateDoRow(
      { id: "day-10-a", doName: "A", todayMlIssuanceBase: 1000, paymentReceivedBase: 500 },
      resolved.rates,
      { createdBy: "u", previous: savedEntry, timestamp: 2 }
    );
    const summary = calculateDailySummary({ doEntries: [resavedEntry] }, resolved.rates, 2);

    expect(resolved.source).toBe("saved-day");
    expect(summary.commission1Rate?.percentage).toBe(2);
    expect(summary.commission1Rate?.percentage).not.toBe(3);
  });

  it("uses current active settings for a new unsaved day", () => {
    const currentRates = ratesWithCommission1(3);
    const resolved = resolveJazzLoadRatesForDay({
      activeRates: currentRates,
      mode: "new-day",
      resolvedAt: 1
    });

    expect(resolved.source).toBe("active-settings");
    expect(resolved.rates.commission1Rate?.percentage).toBe(3);
  });

  it("derives daily lifting from total issuance Jazz Load", () => {
    expect(calculateDailyLifting({ openingBalance: 3485487, mlLifting: 0 }, 1319760.216)).toEqual({
      openingBalance: 3485487,
      mlLifting: 0,
      totalBalance: 3485487,
      todayMlIssuance: 1319760.22,
      inHandBalance: 2165726.78
    });
  });

  it("summarizes days and month-level DO balances", () => {
    const first = calculateDoRow(
      { id: "mirza", doName: "MIRZA", todayMlIssuanceBase: 30000, paymentReceivedBase: 0 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const second = calculateDoRow(
      { id: "mirza", doName: "MIRZA", openingBase: first.closingBalance.baseAmount, todayMlIssuanceBase: 0, paymentReceivedBase: 10000 },
      rates,
      { createdBy: "u", previous: first, timestamp: 2 }
    );
    const days: JazzLoadDay[] = [
      {
        id: "1",
        monthId: "2026-05",
        dayNo: 1,
        date: "2026-05-01",
        status: "open",
        doEntries: [first],
        lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, first.todayMlIssuance.calculatedAmount),
        summary: calculateDailySummary({ doEntries: [first] }, rates),
        createdBy: "u",
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: "2",
        monthId: "2026-05",
        dayNo: 2,
        date: "2026-05-02",
        status: "open",
        doEntries: [second],
        lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, second.todayMlIssuance.calculatedAmount),
        summary: calculateDailySummary({ doEntries: [second] }, rates),
        createdBy: "u",
        createdAt: 2,
        updatedAt: 2
      }
    ];
    const summary = calculateMonthlySummary("2026-05", days);

    expect(summary.totalIssuanceBase).toBe(30000);
    expect(summary.totalPaymentsBase).toBe(10000);
    expect(summary.doBalances[0].closingBase).toBe(20000);
    expect(summary.missingDays).toContain(3);
  });

  it("keeps monthly DO balances in fixed line order", () => {
    const lineB = calculateDoRow(
      { id: "b", doName: "B", doLine: "302", todayMlIssuanceBase: 500, paymentReceivedBase: 0 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const lineA = calculateDoRow(
      { id: "a", doName: "A", doLine: "301", todayMlIssuanceBase: 200, paymentReceivedBase: 0 },
      rates,
      { createdBy: "u", timestamp: 2 }
    );
    const summary = calculateMonthlySummary("2026-05", [
      {
        id: "1",
        monthId: "2026-05",
        dayNo: 1,
        date: "2026-05-01",
        status: "open",
        doEntries: [lineB, lineA],
        lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, lineB.todayMlIssuance.calculatedAmount + lineA.todayMlIssuance.calculatedAmount),
        summary: calculateDailySummary({ doEntries: [lineB, lineA] }, rates),
        createdBy: "u",
        createdAt: 1,
        updatedAt: 1
      }
    ]);

    expect(summary.doBalances.map((row) => row.doLine)).toEqual(["301", "302"]);
  });

  it("summarizes a DO name once even when it moves between fixed lines", () => {
    const dayOne = calculateDoRow(
      { id: "line-1-day-1", doNameId: "name-a", doLineId: "line-1", doName: "A", doLine: "301", doLineSortOrder: 0, todayMlIssuanceBase: 500, paymentReceivedBase: 0 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const dayTwo = calculateDoRow(
      { id: "line-2-day-2", doNameId: "name-a", doLineId: "line-2", doName: "A", doLine: "302", doLineSortOrder: 1, openingBase: dayOne.closingBalance.baseAmount, todayMlIssuanceBase: 0, paymentReceivedBase: 200 },
      rates,
      { createdBy: "u", previous: dayOne, timestamp: 2 }
    );

    const summary = calculateMonthlySummary("2026-05", [
      {
        id: "1",
        monthId: "2026-05",
        dayNo: 1,
        date: "2026-05-01",
        status: "open",
        doEntries: [dayOne],
        lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, dayOne.todayMlIssuance.calculatedAmount),
        summary: calculateDailySummary({ doEntries: [dayOne] }, rates),
        createdBy: "u",
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: "2",
        monthId: "2026-05",
        dayNo: 2,
        date: "2026-05-02",
        status: "open",
        doEntries: [dayTwo],
        lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, dayTwo.todayMlIssuance.calculatedAmount),
        summary: calculateDailySummary({ doEntries: [dayTwo] }, rates),
        createdBy: "u",
        createdAt: 2,
        updatedAt: 2
      }
    ]);

    expect(summary.doBalances).toHaveLength(1);
    expect(summary.doBalances[0]).toMatchObject({
      doNameId: "name-a",
      doName: "A",
      doLine: "302",
      issuanceBase: 500,
      paymentBase: 200,
      closingBase: 300,
      activeDays: 2
    });
  });

  it("carries the latest prior DO name and opening balance across skipped days", () => {
    const prior = calculateDoRow(
      { id: "line-1-day-1", doNameId: "name-a", doLineId: "line-1", doName: "RIZWAN", doLine: "301", todayMlIssuanceBase: 1000, paymentReceivedBase: 200 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const resolved = previousEntryForDraftAcrossDays(
      [
        {
          id: "1",
          monthId: "2026-05",
          dayNo: 1,
          date: "2026-05-01",
          status: "open",
          doEntries: [prior],
          lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, prior.todayMlIssuance.calculatedAmount),
          summary: calculateDailySummary({ doEntries: [prior] }, rates),
          createdBy: "u",
          createdAt: 1,
          updatedAt: 1
        }
      ],
      3,
      { doNameId: "name-a", doName: "RIZWAN", doLineId: "line-1", doLine: "301" }
    );

    expect(resolved?.closingBalance.baseAmount).toBe(800);
    expect(resolved?.doName).toBe("RIZWAN");
  });

  it("finds the latest matching DO entry across a previous month", () => {
    const firstMonthEntry = calculateDoRow(
      { id: "m1", doNameId: "name-a", doLineId: "line-1", doName: "RIZWAN", doLine: "301", todayMlIssuanceBase: 1000, paymentReceivedBase: 100 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const found = latestEntryForDraft(
      [
        {
          id: "1",
          monthId: "2026-04",
          dayNo: 30,
          date: "2026-04-30",
          status: "open",
          doEntries: [firstMonthEntry],
          lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, firstMonthEntry.todayMlIssuance.calculatedAmount),
          summary: calculateDailySummary({ doEntries: [firstMonthEntry] }, rates),
          createdBy: "u",
          createdAt: 1,
          updatedAt: 1
        }
      ],
      { doNameId: "name-a", doName: "RIZWAN", doLineId: "line-1", doLine: "301" }
    );

    expect(found?.closingBalance.baseAmount).toBe(900);
  });

  it("rechains Day 1 openings from the previous month final Jazz Load balances", () => {
    const mayFinalEntry = calculateDoRow(
      { id: "line-1-may", doNameId: "name-a", doLineId: "line-1", doName: "RIZWAN", doLine: "301", openingBase: 500, todayMlIssuanceBase: 1000, paymentReceivedBase: 200 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const mayFinal: JazzLoadDay = {
      id: "31",
      monthId: "2026-05",
      dayNo: 31,
      date: "2026-05-31",
      status: "closed",
      doEntries: [mayFinalEntry],
      lifting: calculateDailyLifting({ openingBalance: 3000, mlLifting: 500 }, mayFinalEntry.todayMlIssuance.calculatedAmount),
      summary: calculateDailySummary({ doEntries: [mayFinalEntry] }, rates),
      createdBy: "u",
      createdAt: 1,
      updatedAt: 1
    };
    const badJuneEntry = calculateDoRow(
      { id: "line-1-june", doNameId: "name-a", doLineId: "line-1", doName: "RIZWAN", doLine: "301", openingBase: 0, todayMlIssuanceBase: 100, paymentReceivedBase: 50 },
      rates,
      { createdBy: "u", timestamp: 2 }
    );
    const juneDay: JazzLoadDay = {
      id: "1",
      monthId: "2026-06",
      dayNo: 1,
      date: "2026-06-01",
      status: "open",
      doEntries: [badJuneEntry],
      lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, badJuneEntry.todayMlIssuance.calculatedAmount),
      summary: calculateDailySummary({ doEntries: [badJuneEntry] }, rates),
      createdBy: "u",
      createdAt: 2,
      updatedAt: 2
    };

    const [repaired] = rechainJazzLoadDays([juneDay], rates, "u", 3, [mayFinal]);

    expect(repaired.doEntries[0].openingBalance.baseAmount).toBe(mayFinalEntry.closingBalance.baseAmount);
    expect(repaired.doEntries[0].todayMlIssuance.baseAmount).toBe(100);
    expect(repaired.doEntries[0].paymentReceived.baseAmount).toBe(50);
    expect(repaired.lifting.openingBalance).toBe(mayFinal.lifting.inHandBalance);
  });

  it("rebuilds daily summary openings from previous recalculated closings without changing unmatched DO fallback", () => {
    const day10Entry = calculateDoRow(
      { id: "day-10-a", doNameId: "name-a", doLineId: "line-a", doName: "A", doLine: "301", openingBase: 100, todayMlIssuanceBase: 1000, paymentReceivedBase: 200 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const staleDay11Entry = calculateDoRow(
      { id: "day-11-b", doNameId: "name-b", doLineId: "line-b", doName: "B", doLine: "302", openingBase: 5000, todayMlIssuanceBase: 100, paymentReceivedBase: 50 },
      rates,
      { createdBy: "u", timestamp: 2 }
    );
    const day10: JazzLoadDay = {
      id: "10",
      monthId: "2026-05",
      dayNo: 10,
      date: "2026-05-10",
      status: "open",
      doEntries: [day10Entry],
      lifting: calculateDailyLifting({ openingBalance: 3000, mlLifting: 500 }, day10Entry.todayMlIssuance.calculatedAmount),
      summary: calculateDailySummary({ doEntries: [day10Entry] }, rates),
      createdBy: "u",
      createdAt: 1,
      updatedAt: 1
    };
    const day11: JazzLoadDay = {
      id: "11",
      monthId: "2026-05",
      dayNo: 11,
      date: "2026-05-11",
      status: "open",
      doEntries: [staleDay11Entry],
      lifting: calculateDailyLifting({ openingBalance: 9999, mlLifting: 0 }, staleDay11Entry.todayMlIssuance.calculatedAmount),
      summary: calculateDailySummary({ doEntries: [staleDay11Entry] }, rates),
      createdBy: "u",
      createdAt: 2,
      updatedAt: 2
    };

    const [repairedDay10, repairedDay11] = rechainJazzLoadDays([day10, day11], rates, "u", 3);

    expect(repairedDay11.doEntries[0].openingBalance.baseAmount).toBe(5000);
    expect(repairedDay11.summary.openingBase).toBe(repairedDay10.summary.closingBase);
    expect(repairedDay11.summary.openingMl).toBe(repairedDay10.summary.closingMl);
    expect(repairedDay11.summary.closingBase).toBe(repairedDay10.summary.closingBase + repairedDay11.summary.issuanceBase - repairedDay11.summary.paymentBase);
    expect(repairedDay11.summary.closingMl).toBeCloseTo(repairedDay10.summary.closingMl + repairedDay11.summary.issuanceMl - repairedDay11.summary.paymentMl);
    expect(repairedDay11.lifting.openingBalance).toBe(repairedDay10.lifting.inHandBalance);
  });

  it("preserves per-day rate snapshots during local master refresh", () => {
    const currentRates = ratesWithCommission1(3);
    const buildDay = (dayNo: number, dayRates: ActiveJazzLoadRates, includeSnapshots = true, includeSummaryRates = true): JazzLoadDay => {
      const entry = calculateDoRow(
        { id: `day-${dayNo}-a`, doName: "A", todayMlIssuanceBase: 1000, paymentReceivedBase: 500 },
        dayRates,
        { createdBy: "u", timestamp: dayNo }
      );
      const summary = calculateDailySummary({ doEntries: [entry] }, dayRates, dayNo);
      return {
        id: String(dayNo),
        monthId: "2026-05",
        dayNo,
        date: `2026-05-${String(dayNo).padStart(2, "0")}`,
        status: "open",
        doEntries: [entry],
        lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, entry.todayMlIssuance.calculatedAmount),
        summary: includeSummaryRates ? summary : { ...summary, commission1Rate: undefined, commission2Rate: undefined },
        appliedRates: includeSnapshots ? snapshotResolvedRates(dayRates, dayNo) : undefined,
        createdBy: "u",
        createdAt: dayNo,
        updatedAt: dayNo
      };
    };

    const [day1, day2, legacyDay] = rechainJazzLoadDays([
      buildDay(1, ratesWithCommission1(2)),
      buildDay(2, ratesWithCommission1(2.5)),
      buildDay(3, ratesWithCommission1(1.5), false, false)
    ], currentRates, "u", 10);

    expect(day1.summary.commission1Rate?.percentage).toBe(2);
    expect(day1.appliedRates?.commission1Rate?.percentage).toBe(2);
    expect(day2.summary.commission1Rate?.percentage).toBe(2.5);
    expect(day2.appliedRates?.commission1Rate?.percentage).toBe(2.5);
    expect(legacyDay.summary.commission1Rate?.percentage).toBe(3);
    expect(legacyDay.appliedRates?.commission1Rate?.percentage).toBe(3);
  });

  it("can seed Day 1 daily summary and lifting openings from the previous monthly summary", () => {
    const juneEntry = calculateDoRow(
      { id: "june-a", doNameId: "name-a", doLineId: "line-a", doName: "A", doLine: "301", openingBase: 0, todayMlIssuanceBase: 100, paymentReceivedBase: 25 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const juneDay: JazzLoadDay = {
      id: "1",
      monthId: "2026-06",
      dayNo: 1,
      date: "2026-06-01",
      status: "open",
      doEntries: [juneEntry],
      lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 10 }, juneEntry.todayMlIssuance.calculatedAmount),
      summary: calculateDailySummary({ doEntries: [juneEntry] }, rates),
      createdBy: "u",
      createdAt: 1,
      updatedAt: 1
    };

    const [repaired] = rechainJazzLoadDays([juneDay], rates, "u", 2, [], {
      totalClosingBase: 1234,
      totalClosingMl: 1266,
      latestInHandBalance: 9876
    });

    expect(repaired.summary.openingBase).toBe(1234);
    expect(repaired.summary.openingMl).toBe(1266);
    expect(repaired.summary.closingBase).toBe(1309);
    expect(repaired.lifting.openingBalance).toBe(9876);
  });

  it("carries opening by fixed DO line even when the assigned name changes", () => {
    const first = calculateDoRow(
      { id: "line-1-day-1", doNameId: "name-a", doLineId: "line-1", doName: "Old Name", doLine: "301", todayMlIssuanceBase: 1000, paymentReceivedBase: 200 },
      rates,
      { createdBy: "u", timestamp: 1 }
    );
    const second = calculateDoRow(
      { id: "line-1-day-2", doNameId: "name-b", doLineId: "line-1", doName: "New Name", doLine: "301", todayMlIssuanceBase: 0, paymentReceivedBase: 0 },
      rates,
      { createdBy: "u", previous: first, timestamp: 2 }
    );

    expect(second.openingBalance.baseAmount).toBe(800);
    expect(second.doName).toBe("New Name");
    expect(second.doLineId).toBe("line-1");
  });

  it("validates active rate, duplicates, negatives, and overpayments", () => {
    const result = validateJazzLoadDrafts(
      [
        { id: "a", doName: "A", openingBase: -50, todayMlIssuanceBase: 10, paymentReceivedBase: 25 },
        { id: "b", doName: "A", todayMlIssuanceBase: -1, paymentReceivedBase: 0 }
      ],
      { mlRate: null, commission1Rate: null, commission2Rate: null }
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "No active Jazz Load Addition Rate configured.",
      "No active Commission 1 Adjustment Rate configured.",
      "No active Commission 2 Payment Rate configured.",
      "Duplicate DO entry: A.",
      "A issuance cannot be negative."
    ]));
    expect(result.errors).not.toContain("A payment cannot be greater than day total.");
    expect(result.errors).not.toContain("A opening cannot be negative.");
  });

  it("blocks assigning one DO name to more than one row", () => {
    const result = validateJazzLoadDrafts(
      [
        { id: "a", doNameId: "name-a", doLineId: "line-1", doName: "A", doLine: "301", todayMlIssuanceBase: 10, paymentReceivedBase: 0 },
        { id: "b", doNameId: "name-a", doLineId: "line-2", doName: "A", doLine: "302", todayMlIssuanceBase: 20, paymentReceivedBase: 0 }
      ],
      rates
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Duplicate DO name assignment: A.");
  });
});
