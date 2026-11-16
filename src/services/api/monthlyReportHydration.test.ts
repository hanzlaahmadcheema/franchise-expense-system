import { describe, expect, it, vi, beforeEach } from "vitest";
import { runWithConcurrency } from "./periodDayService";
import { loadExpenseMonthPostgres } from "./expenseTransactionService";
import { ledgerApiClient } from "./ledgerApiClient";
import * as periodDayService from "./periodDayService";

vi.mock("./ledgerApiClient", () => {
  return {
    ledgerApiClient: {
      expenses: { list: vi.fn().mockResolvedValue({ data: [] }) },
      commissions: { list: vi.fn().mockResolvedValue({ data: [] }) },
      credits: { list: vi.fn().mockResolvedValue({ data: [] }) },
      owner: { list: vi.fn().mockResolvedValue({ data: [] }) },
      calculations: {
        getDayProjections: vi.fn().mockResolvedValue({ projections: null }),
        getPeriodFinalProjections: vi.fn().mockResolvedValue({ data: null })
      },
      catalogs: {
        getCreditParties: vi.fn().mockResolvedValue({ data: [] })
      }
    }
  };
});

describe("runWithConcurrency", () => {
  it("enforces maximum concurrency limit while processing all items", async () => {
    let activeWorkers = 0;
    let maxObservedWorkers = 0;
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const concurrencyLimit = 3;

    const results = await runWithConcurrency(items, concurrencyLimit, async (num) => {
      activeWorkers++;
      maxObservedWorkers = Math.max(maxObservedWorkers, activeWorkers);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeWorkers--;
      return num * 2;
    });

    expect(maxObservedWorkers).toBeLessThanOrEqual(concurrencyLimit);
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
  });

  it("preserves item order even if items complete at different times", async () => {
    const items = [50, 10, 30, 5];
    const results = await runWithConcurrency(items, 4, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return `done-${delay}`;
    });

    expect(results).toEqual(["done-50", "done-10", "done-30", "done-5"]);
  });

  it("handles empty arrays immediately", async () => {
    const results = await runWithConcurrency([], 5, async (x) => x);
    expect(results).toEqual([]);
  });
});

describe("loadExpenseMonthPostgres", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads all days for a period and sorts them in ascending order", async () => {
    const mockPeriod = {
      period: { id: "p-uuid-2026-10", period_key: "2026-10", status: "open" } as any,
      days: new Map([
        [1, { id: "d-uuid-1", day_no: 1, status: "closed" } as any],
        [2, { id: "d-uuid-2", day_no: 2, status: "closed" } as any],
        [3, { id: "d-uuid-3", day_no: 3, status: "open" } as any]
      ]),
      fetchedAt: Date.now()
    };

    vi.spyOn(periodDayService, "getAccountingPeriodWithDays").mockResolvedValue(mockPeriod);
    vi.mocked(ledgerApiClient.commissions.list).mockImplementation(async (dayId) => {
      if (dayId === "d-uuid-1") {
        return { data: [{ id: "c1", category_name_snapshot: "JazzLoad", amount: 1500 }] } as any;
      }
      if (dayId === "d-uuid-2") {
        return { data: [{ id: "c2", category_name_snapshot: "JazzCash", amount: 800 }] } as any;
      }
      return { data: [] } as any;
    });

    const monthDays = await loadExpenseMonthPostgres("2026-10");
    expect(monthDays.length).toBe(3);
    expect(monthDays[0].dayNo).toBe(1);
    expect(monthDays[0].commissions[0].category).toBe("JazzLoad");
    expect(monthDays[0].commissions[0].amount).toBe(1500);
    expect(monthDays[1].dayNo).toBe(2);
    expect(monthDays[1].commissions[0].category).toBe("JazzCash");
    expect(monthDays[1].commissions[0].amount).toBe(800);
    expect(monthDays[2].dayNo).toBe(3);
    expect(monthDays[2].commissions.length).toBe(0);
  });

  it("returns empty array if period is not found", async () => {
    vi.spyOn(periodDayService, "getAccountingPeriodWithDays").mockResolvedValue(null);
    const result = await loadExpenseMonthPostgres("2099-01");
    expect(result).toEqual([]);
  });
});
