import { describe, expect, it } from "vitest";
import {
  checkExpenseCreditInvariants,
  type ExpenseCreditRawEntry,
  normalizeLegacyExpenseCreditDay,
  projectExpenseCreditMonth,
  projectionToLegacyCreditRows
} from "./expenseCreditLedger";

describe("expense credit ledger v2 projector", () => {
  it("rebuilds Day 29 carry-forward and preserves Day 30 Usman Cheema loan", () => {
    const monthId = "2026-05";
    const normalized = [
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 28,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [
          { id: "day-28-usman", partyId: "usman-cheema", partyName: "Usman Cheema", opening: 1000, loan: 1500, receive: 500 },
          { id: "day-28-akhtar", partyId: "akhtar", partyName: "AKHTAR", opening: 10000, loan: 10000, receive: 2000 }
        ],
        subcollectionCredits: []
      }),
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 29,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [],
        subcollectionCredits: []
      }),
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 30,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [
          { id: "day-30-usman", partyId: "usman-cheema", partyName: "Usman Cheema", opening: 0, loan: 9000, receive: 0 }
        ],
        subcollectionCredits: []
      }),
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 31,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [],
        subcollectionCredits: []
      })
    ];

    const projected = projectExpenseCreditMonth({
      monthId,
      calcRunId: "run-1",
      calculatedAt: 2,
      days: normalized.map((day) => ({
        dayNo: day.dayNo,
        rawEntries: day.rawEntries,
        seedOpenings: day.seedOpenings
      }))
    });

    const day29Usman = projected[1].projections.find((row) => row.partyId === "usman-cheema");
    const day30Usman = projected[2].projections.find((row) => row.partyId === "usman-cheema");
    const day31Usman = projected[3].projections.find((row) => row.partyId === "usman-cheema");

    expect(day29Usman?.calculated.opening).toBe(2000);
    expect(day29Usman?.calculated.closing).toBe(2000);
    expect(day30Usman?.calculated.opening).toBe(2000);
    expect(day30Usman?.calculated.loan).toBe(9000);
    expect(day30Usman?.calculated.receive).toBe(0);
    expect(day30Usman?.calculated.closing).toBe(11000);
    expect(day31Usman?.calculated.opening).toBe(11000);
    expect(day31Usman?.calculated.closing).toBe(11000);
    expect(checkExpenseCreditInvariants({ monthId, projectedDays: projected })).toEqual([]);
  });

  it("emits compatibility credit rows from generated projections", () => {
    const normalized = normalizeLegacyExpenseCreditDay({
      monthId: "2026-05",
      dayNo: 1,
      actorUid: "owner",
      timestamp: 1,
      embeddedCredits: [{ id: "credit-1", partyId: "p1", partyName: "P1", opening: 100, loan: 50, receive: 10 }],
      subcollectionCredits: []
    });
    const [day] = projectExpenseCreditMonth({
      monthId: "2026-05",
      calcRunId: "run-1",
      days: [{ dayNo: 1, rawEntries: normalized.rawEntries, seedOpenings: normalized.seedOpenings }]
    });

    expect(projectionToLegacyCreditRows(day)).toEqual([
      {
        id: "credit-1",
        partyId: "p1",
        partyName: "P1",
        opening: 100,
        loan: 50,
        today: 50,
        receive: 10,
        balance: 140
      }
    ]);
  });

  it("reports embedded/subcollection mismatches instead of silently merging", () => {
    const normalized = normalizeLegacyExpenseCreditDay({
      monthId: "2026-05",
      dayNo: 30,
      actorUid: "owner",
      timestamp: 1,
      embeddedCredits: [{ id: "usman", partyId: "usman", partyName: "Usman", opening: 0, loan: 9000, receive: 0 }],
      subcollectionCredits: [{ id: "usman", partyId: "usman", partyName: "Usman", opening: 0, loan: 0, receive: 0 }]
    });

    expect(normalized.conflicts).toHaveLength(1);
    expect(normalized.conflicts[0].type).toBe("embedded-subcollection-mismatch");
  });

  it("infers legacy balance-only rows as raw manual adjustment", () => {
    const normalized = normalizeLegacyExpenseCreditDay({
      monthId: "2026-05",
      dayNo: 1,
      actorUid: "owner",
      timestamp: 1,
      embeddedCredits: [{ id: "legacy", partyId: "legacy", partyName: "Legacy", opening: 100, balance: 125 }],
      subcollectionCredits: []
    });

    expect(normalized.rawEntries[0].raw.loan).toBe(0);
    expect(normalized.rawEntries[0].raw.receive).toBe(0);
    expect(normalized.rawEntries[0].raw.manualAdjustment).toBe(25);
    expect(normalized.rawEntries[0].raw.inferredFromLegacy).toBe(true);
  });

  it("dedupes Day 30 migration and autosave credit raw entries without double-counting movement", () => {
    const monthId = "2026-05";
    const normalized = [
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 28,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [{ id: "day-28-usman", partyId: "usman-cheema", partyName: "Usman cheema", opening: 2000, loan: 0, receive: 0 }],
        subcollectionCredits: []
      }),
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 29,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [],
        subcollectionCredits: []
      }),
      normalizeLegacyExpenseCreditDay({
        monthId,
        dayNo: 31,
        actorUid: "owner",
        timestamp: 1,
        embeddedCredits: [],
        subcollectionCredits: []
      })
    ];
    const migrationEntry: ExpenseCreditRawEntry = {
      id: "30-credit-1ee9a416-f677-45df-a118-9adee27e6869",
      monthId,
      dayNo: 30,
      raw: {
        partyId: "usman-cheema",
        partyNameSnapshot: "Usman cheema",
        loan: 9000,
        receive: 0,
        manualAdjustment: 0,
        source: "migration",
        legacyOpeningSeed: 2000,
        legacySourcePath: "months/2026-05/days/30.credits"
      },
      meta: {
        updatedAt: 1,
        updatedBy: "migration",
        revision: 1
      }
    };
    const autosaveDuplicate: ExpenseCreditRawEntry = {
      id: "credit-30-credit-1ee9a416-f677-45df-a118-9adee27e6869",
      monthId,
      dayNo: 30,
      raw: {
        partyId: "usman-cheema",
        partyNameSnapshot: "Usman cheema",
        loan: 9000,
        receive: 0,
        manualAdjustment: 0,
        source: "user"
      },
      meta: {
        updatedAt: 99,
        updatedBy: "owner"
      }
    };

    const projected = projectExpenseCreditMonth({
      monthId,
      calcRunId: "run-duplicates",
      calculatedAt: 100,
      days: [
        {
          dayNo: normalized[0].dayNo,
          rawEntries: normalized[0].rawEntries,
          seedOpenings: normalized[0].seedOpenings
        },
        {
          dayNo: normalized[1].dayNo,
          rawEntries: normalized[1].rawEntries,
          seedOpenings: normalized[1].seedOpenings
        },
        {
          dayNo: 30,
          rawEntries: [autosaveDuplicate, migrationEntry],
          seedOpenings: new Map([["id:usman-cheema", { partyId: "usman-cheema", partyName: "Usman cheema", opening: 2000 }]])
        },
        {
          dayNo: normalized[2].dayNo,
          rawEntries: normalized[2].rawEntries,
          seedOpenings: normalized[2].seedOpenings
        }
      ]
    });

    const day30 = projected.find((day) => day.dayNo === 30);
    const day31 = projected.find((day) => day.dayNo === 31);
    const day30Usman = day30?.projections.find((row) => row.partyId === "usman-cheema");
    const day31Usman = day31?.projections.find((row) => row.partyId === "usman-cheema");

    expect(day30?.rawEntries).toHaveLength(1);
    expect(day30?.rawEntries[0].id).toBe(migrationEntry.id);
    expect(day30?.summary.loan).toBe(9000);
    expect(day30Usman?.rawEntryId).toBe(migrationEntry.id);
    expect(day30Usman?.calculated.opening).toBe(2000);
    expect(day30Usman?.calculated.loan).toBe(9000);
    expect(day30Usman?.calculated.receive).toBe(0);
    expect(day30Usman?.calculated.closing).toBe(11000);
    expect(day31Usman?.calculated.opening).toBe(11000);
    expect(day31Usman?.calculated.closing).toBe(11000);
    expect(checkExpenseCreditInvariants({ monthId, projectedDays: projected })).toEqual([]);
  });

  it("prefers the latest valid non-migration duplicate raw entry by timestamp", () => {
    const monthId = "2026-05";
    const newerEntry: ExpenseCreditRawEntry = {
      id: "credit-newer",
      monthId,
      dayNo: 30,
      raw: {
        partyId: "akhtar",
        partyNameSnapshot: "AKHTAR",
        loan: 0,
        receive: 500,
        manualAdjustment: 0,
        source: "user"
      },
      meta: {
        updatedAt: 50,
        updatedBy: "owner"
      }
    };
    const olderEntry: ExpenseCreditRawEntry = {
      id: "credit-older",
      monthId,
      dayNo: 30,
      raw: {
        partyId: "akhtar",
        partyNameSnapshot: "AKHTAR",
        loan: 0,
        receive: 500,
        manualAdjustment: 0,
        source: "user"
      },
      meta: {
        updatedAt: 10,
        updatedBy: "owner"
      }
    };

    const [day30] = projectExpenseCreditMonth({
      monthId,
      calcRunId: "run-latest",
      calculatedAt: 100,
      days: [{ dayNo: 30, rawEntries: [newerEntry, olderEntry] }]
    });

    expect(day30.rawEntries).toHaveLength(1);
    expect(day30.rawEntries[0].id).toBe(newerEntry.id);
    expect(day30.projections[0].rawEntryId).toBe(newerEntry.id);
    expect(day30.summary.receive).toBe(500);
  });
});
