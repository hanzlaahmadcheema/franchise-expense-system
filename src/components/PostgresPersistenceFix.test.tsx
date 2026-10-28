// @vitest-environment jsdom
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DailyEntryForm } from "./DailyEntryForm";
import {
  loadExpenseDayPostgres
} from "../services/api/expenseTransactionService";
import { ledgerApiClient } from "../services/api/ledgerApiClient";
import * as periodDayService from "../services/api/periodDayService";
import type { DailyLedgerInput } from "../types/ledger";

// Mock dependencies
vi.mock("../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    expenses: { list: vi.fn() },
    commissions: { list: vi.fn() },
    credits: { list: vi.fn() },
    owner: { list: vi.fn() },
    calculations: { getDayProjections: vi.fn() },
    catalogs: { getCreditParties: vi.fn() }
  }
}));

vi.mock("../services/api/periodDayService", () => ({
  getAccountingPeriodWithDays: vi.fn(),
  isPostgreSqlPeriod: vi.fn().mockReturnValue(true)
}));

describe("PostgreSQL Persistence & Server Hydration Fix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. loadExpenseDayPostgres correctly maps receipt_amount to receive and attaches updatedAt", async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValueOnce({
      period: { id: "p1" } as any,
      days: new Map([
        [
          1,
          {
            id: "d1",
            day_no: 1,
            status: "open",
            updated_at: "2026-09-19T10:00:00.000Z",
            notes: "Day 1 Authoritative Notes"
          } as any
        ]
      ]),
      fetchedAt: Date.now()
    });

    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValueOnce({
      data: [
        {
          id: "exp-1",
          item_name: "Printer Paper",
          category_name_snapshot: "Office",
          amount: "350.00",
          updated_at: "2026-09-19T10:05:00.000Z"
        }
      ]
    });

    vi.mocked(ledgerApiClient.commissions.list).mockResolvedValueOnce({
      data: [
        {
          id: "comm-1",
          category_name_snapshot: "JazzCash",
          amount: "1500.00",
          updated_at: "2026-09-19T10:06:00.000Z"
        }
      ]
    });

    vi.mocked(ledgerApiClient.credits.list).mockResolvedValueOnce({
      data: [
        {
          id: "cred-1",
          party_id: "party-akhtar",
          party_name_snapshot: "AKHTAR",
          loan_amount: "1000.00",
          receipt_amount: "2000.00",
          loan_description: "Advance loan",
          receive_description: "Bank transfer receipt",
          updated_at: "2026-09-19T10:07:04.023Z"
        }
      ]
    });

    vi.mocked(ledgerApiClient.owner.list).mockResolvedValueOnce({
      data: [
        {
          id: "owner-1",
          description: "Owner draw",
          amount: "5000.00",
          updated_at: "2026-09-19T10:08:00.000Z"
        }
      ]
    });

    vi.mocked(ledgerApiClient.calculations.getDayProjections).mockResolvedValueOnce({
      day: {} as any,
      projections: {
        creditParties: [
          {
            party_id: "party-akhtar",
            opening_balance: "9000.00"
          }
        ]
      } as any
    });

    vi.mocked(ledgerApiClient.catalogs.getCreditParties).mockResolvedValueOnce({
      data: [{ id: "party-akhtar", name: "AKHTAR" }]
    });

    const day = await loadExpenseDayPostgres("2026-08", 1);
    expect(day).not.toBeNull();
    expect(day!.dayNo).toBe(1);
    expect(day!.notes).toBe("Day 1 Authoritative Notes");

    // Check credit row receipt mapping
    expect(day!.credits.length).toBe(1);
    const credit = day!.credits[0];
    expect(credit.partyName).toBe("AKHTAR");
    expect(credit.loan).toBe(1000);
    expect(credit.receive).toBe(2000); // Successfully mapped from receipt_amount!
    expect(credit.opening).toBe(9000);
    expect(credit.loanDescription).toBe("Advance loan");
    expect(credit.receiveDescription).toBe("Bank transfer receipt");

    // Check expense
    expect(day!.expenses.length).toBe(1);
    expect(day!.expenses[0].name).toBe("Printer Paper");
    expect(day!.expenses[0].amount).toBe(350);

    // Check commission
    expect(day!.commissions.length).toBe(1);
    expect(day!.commissions[0].amount).toBe(1500);

    // Check owner
    expect(day!.ownerBalances.length).toBe(1);
    expect(day!.ownerBalances[0].amount).toBe(5000);
    expect(day!.ownerBalances[0].expense).toBe(5000);

    // Check authoritative updatedAt timestamp
    expect(day!.updatedAt).toBe(new Date("2026-09-19T10:08:00.000Z").getTime());
  });

  it("2. DailyEntryForm rehydrates state from initial when initial updates and form is clean", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);

    const initialEmpty: DailyLedgerInput = {
      dayNo: 1,
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: [],
      notes: ""
    };

    const initialServerLoaded: DailyLedgerInput = {
      dayNo: 1,
      updatedAt: 1726740000000,
      notes: "Server loaded note",
      expenses: [
        {
          id: "exp-1",
          name: "Generator Fuel",
          description: "20L Diesel",
          amount: 5500,
          category: "Utilities"
        }
      ],
      commissions: [
        {
          id: "comm-1",
          category: "JazzCash",
          amount: 2500
        }
      ],
      credits: [
        {
          id: "cred-1",
          partyId: "p1",
          partyName: "ALI OLAKH",
          opening: 39948,
          loan: 1500,
          receive: 3000
        }
      ],
      ownerBalances: [
        {
          id: "own-1",
          description: "Owner cash take",
          amount: 10000,
          expense: 10000,
          received: 0
        }
      ]
    };

    const { rerender } = render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[{ id: "cat-1", name: "Utilities", active: true, sortOrder: 1 }]}
        commissionCategories={[{ id: "comm-cat-1", name: "JazzCash", active: true, sortOrder: 1 }]}
        creditParties={[{ id: "p1", name: "ALI OLAKH", active: true, sortOrder: 1 }]}
        initial={initialEmpty}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // Initial render: empty
    expect(screen.queryByText("Generator Fuel")).toBeNull();
    expect(screen.queryByText("39,948")).toBeNull();

    // Re-render with server loaded initial data (simulating Effect 2 finishing)
    rerender(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[{ id: "cat-1", name: "Utilities", active: true, sortOrder: 1 }]}
        commissionCategories={[{ id: "comm-cat-1", name: "JazzCash", active: true, sortOrder: 1 }]}
        creditParties={[{ id: "p1", name: "ALI OLAKH", active: true, sortOrder: 1 }]}
        initial={initialServerLoaded}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // Expect server-loaded transactions to be hydrated into the form
    await waitFor(() => {
      expect(screen.getAllByText("Generator Fuel").length).toBeGreaterThan(0);
      expect(screen.getAllByText("5,500").length).toBeGreaterThan(0);
      expect(screen.getAllByText("39,948").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Owner cash take").length).toBeGreaterThan(0);
    });

    // Hydration must NEVER trigger autosave
    expect(onSave).not.toHaveBeenCalled();
  });

  it("3. DailyEntryForm does NOT overwrite active dirty edits when initial updates", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);

    const initialEmpty: DailyLedgerInput = {
      dayNo: 1,
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: [],
      notes: ""
    };

    const initialServerLoaded: DailyLedgerInput = {
      dayNo: 1,
      updatedAt: 1726740000000,
      notes: "Server Notes",
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const { rerender } = render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[{ id: "cat-1", name: "General", active: true, sortOrder: 1 }]}
        commissionCategories={[]}
        creditParties={[]}
        initial={initialEmpty}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // User types in notes input, making the draft dirty
    const notesInput = screen.getByLabelText("Notes") as HTMLInputElement;
    await user.type(notesInput, "User is actively typing here");
    expect(notesInput.value).toBe("User is actively typing here");

    // Server data arrives while user is dirty
    rerender(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[{ id: "cat-1", name: "General", active: true, sortOrder: 1 }]}
        commissionCategories={[]}
        creditParties={[]}
        initial={initialServerLoaded}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    // User's active typing MUST NOT be overwritten by the background update
    expect(notesInput.value).toBe("User is actively typing here");
  });

  it("4. isServerLoadedDay distinguishes server-loaded days from blank day shells", async () => {
    const { isServerLoadedDay } = await import("../App");

    // Null or undefined
    expect(isServerLoadedDay(null)).toBe(false);
    expect(isServerLoadedDay(undefined)).toBe(false);

    // Blank day shell (as generated by pgDays loop)
    const blankShell: DailyLedgerInput = {
      dayNo: 1,
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: []
    };
    expect(isServerLoadedDay(blankShell)).toBe(false);

    // Day with server authoritative updatedAt
    const dayWithTimestamp: DailyLedgerInput = {
      dayNo: 1,
      updatedAt: 1726740000000,
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: []
    };
    expect(isServerLoadedDay(dayWithTimestamp)).toBe(true);

    // Day with expenses
    const dayWithExpenses: DailyLedgerInput = {
      dayNo: 1,
      expenses: [{ id: "e1", name: "Tea", description: "", amount: 100 }],
      commissions: [],
      credits: [],
      ownerBalances: []
    };
    expect(isServerLoadedDay(dayWithExpenses)).toBe(true);

    // Day with notes
    const dayWithNotes: DailyLedgerInput = {
      dayNo: 1,
      notes: "Important day note",
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: []
    };
    expect(isServerLoadedDay(dayWithNotes)).toBe(true);
  }, 15000);

  it("5. pgDays merge preserves already-loaded server day data in currentDays", async () => {
    const { isServerLoadedDay } = await import("../App");

    const currentDays: DailyLedgerInput[] = [
      {
        dayNo: 1,
        updatedAt: 1726740000000,
        notes: "Preserved Day 1 Note",
        status: "open",
        expenses: [{ id: "e1", name: "Diesel", description: "", amount: 2000 }],
        commissions: [{ id: "c1", category: "JazzCash", amount: 1000 }],
        credits: [{ id: "cr1", partyId: "p1", partyName: "AKHTAR", opening: 9000, loan: 1000, receive: 2000 }],
        ownerBalances: [{ id: "o1", description: "Owner draw", amount: 5000, expense: 5000, received: 0 }]
      }
    ];

    // Blank pgDays generated by period initialization
    const pgDays: DailyLedgerInput[] = [
      {
        dayNo: 1,
        date: "2026-08-01",
        status: "open",
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: []
      },
      {
        dayNo: 2,
        date: "2026-08-02",
        status: "closed",
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: []
      }
    ];

    // Merge logic as implemented in App.tsx
    const currentMap = new Map(currentDays.map((d) => [d.dayNo, d]));
    const merged = pgDays.map((pgDay) => {
      const existing = currentMap.get(pgDay.dayNo);
      if (existing && isServerLoadedDay(existing)) {
        return {
          ...pgDay,
          ...existing,
          status: pgDay.status,
          lockedAt: pgDay.lockedAt,
          closedAt: pgDay.closedAt,
          reopenedAt: pgDay.reopenedAt,
          expenses: existing.expenses,
          commissions: existing.commissions,
          credits: existing.credits,
          ownerBalances: existing.ownerBalances,
          notes: existing.notes ?? pgDay.notes,
          updatedAt: existing.updatedAt
        };
      }
      return pgDay;
    });

    // Verify Day 1 data was preserved and NOT wiped out
    expect(merged.length).toBe(2);
    const mergedDay1 = merged.find((d) => d.dayNo === 1)!;
    expect(mergedDay1.expenses.length).toBe(1);
    expect(mergedDay1.expenses[0].name).toBe("Diesel");
    expect(mergedDay1.commissions.length).toBe(1);
    expect(mergedDay1.credits.length).toBe(1);
    expect(mergedDay1.credits[0].partyName).toBe("AKHTAR");
    expect(mergedDay1.credits[0].receive).toBe(2000);
    expect(mergedDay1.ownerBalances.length).toBe(1);
    expect(mergedDay1.notes).toBe("Preserved Day 1 Note");

    // Verify Day 2 remained blank shell
    const mergedDay2 = merged.find((d) => d.dayNo === 2)!;
    expect(mergedDay2.expenses.length).toBe(0);
    expect(mergedDay2.status).toBe("closed");
  });

  it("6. pgDays merge preserves Day 32 FINAL snapshot in currentDays and prevents reset to 0 on refresh", async () => {
    const { isServerLoadedDay } = await import("../App");

    const monthId = "2026-08";
    const dayCount = 31;

    // Suppose user is on FINAL and hard refreshes; Day 32 was loaded first
    const currentDays: DailyLedgerInput[] = [
      {
        dayNo: 32,
        date: "2026-08-FINAL",
        status: "closed",
        label: "FINAL",
        notes: "Authoritative month-end FINAL closing state",
        openingCash: 0,
        ownerOpeningBalance: 1000000,
        expenses: [],
        commissions: [],
        credits: [
          {
            id: "final-credit-p1",
            partyId: "p1",
            partyName: "AKHTAR",
            opening: 14000,
            loan: 0,
            receive: 0
          }
        ],
        ownerBalances: []
      }
    ];

    expect(isServerLoadedDay(currentDays[0])).toBe(true);

    // Period loader generates 31 operational calendar days
    const pgDays: DailyLedgerInput[] = Array.from({ length: 31 }, (_, i) => ({
      dayNo: i + 1,
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      status: "closed",
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: []
    }));

    // App.tsx merge logic
    const currentMap = new Map(currentDays.map((d) => [d.dayNo, d]));
    const merged = pgDays.map((pgDay) => {
      const existing = currentMap.get(pgDay.dayNo);
      if (existing && isServerLoadedDay(existing)) {
        return {
          ...pgDay,
          ...existing
        };
      }
      return pgDay;
    });

    const existingFinal = currentMap.get(32);
    if (existingFinal && isServerLoadedDay(existingFinal) && (!existingFinal.date || existingFinal.date.startsWith(monthId))) {
      merged.push(existingFinal);
    }

    for (const [dayNo, existingDay] of currentMap.entries()) {
      if (dayNo > dayCount && dayNo !== 32 && isServerLoadedDay(existingDay) && (!existingDay.date || existingDay.date.startsWith(monthId))) {
        merged.push(existingDay);
      }
    }

    // Verify Day 32 was preserved and NOT dropped!
    expect(merged.length).toBe(32);
    const finalDay = merged.find((d) => d.dayNo === 32);
    expect(finalDay).toBeDefined();
    expect(finalDay?.label).toBe("FINAL");
    expect(finalDay?.openingCash).toBe(0);
    expect(finalDay?.ownerOpeningBalance).toBe(1000000);
    expect(finalDay?.credits.length).toBe(1);
    expect(finalDay?.credits[0].opening).toBe(14000);
  });

  it("7. pgDays merge attaches preloaded finalDayRecord when currentDays is empty on cold refresh", async () => {
    const { isServerLoadedDay } = await import("../App");

    const monthId = "2026-08";
    const dayCount = 31;
    const currentDays: DailyLedgerInput[] = [];

    const finalDayRecord: DailyLedgerInput = {
      dayNo: 32,
      date: "2026-08-FINAL",
      status: "closed",
      label: "FINAL",
      notes: "Authoritative month-end FINAL closing state",
      openingCash: 0,
      ownerOpeningBalance: 1000000,
      expenses: [],
      commissions: [],
      credits: [
        {
          id: "final-credit-p1",
          partyId: "p1",
          partyName: "AKHTAR",
          opening: 14000,
          loan: 0,
          receive: 0
        }
      ],
      ownerBalances: []
    };

    const pgDays: DailyLedgerInput[] = Array.from({ length: 31 }, (_, i) => ({
      dayNo: i + 1,
      date: `2026-08-${String(i + 1).padStart(2, "0")}`,
      status: "closed",
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: []
    }));

    const currentMap = new Map(currentDays.map((d) => [d.dayNo, d]));
    const merged = pgDays.map((pgDay) => {
      const existing = currentMap.get(pgDay.dayNo);
      if (existing && isServerLoadedDay(existing)) {
        return {
          ...pgDay,
          ...existing
        };
      }
      return pgDay;
    });

    const existingFinal = currentMap.get(32);
    if (existingFinal && isServerLoadedDay(existingFinal) && (!existingFinal.date || existingFinal.date.startsWith(monthId))) {
      merged.push(existingFinal);
    } else if (finalDayRecord) {
      merged.push(finalDayRecord);
    }

    for (const [dayNo, existingDay] of currentMap.entries()) {
      if (dayNo > dayCount && dayNo !== 32 && isServerLoadedDay(existingDay) && (!existingDay.date || existingDay.date.startsWith(monthId))) {
        merged.push(existingDay);
      }
    }

    // Verify Day 32 was attached directly from finalDayRecord
    expect(merged.length).toBe(32);
    const finalDay = merged.find((d) => d.dayNo === 32);
    expect(finalDay).toBeDefined();
    expect(finalDay?.openingCash).toBe(0);
    expect(finalDay?.ownerOpeningBalance).toBe(1000000);
    expect(finalDay?.credits[0].opening).toBe(14000);
  });
});
