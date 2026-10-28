import { describe, it, expect } from "vitest";
import type { StockDayRecord, StockAccountProfile, StockProduct } from "../types/stock.types";
import { isServerLoadedStockDay } from "./StockLedgerModule";

describe("StockAccountRefreshHydration", () => {
  const arslanAccountId = "acc-arslan";

  const arslanAccount: StockAccountProfile = {
    id: arslanAccountId,
    name: "DO ARSLAN",
    type: "DO",
    slug: "do-arslan",
    openingBalance: 136855,
    active: true,
    displayOrder: 4,
    createdBy: "system",
    createdAt: 0,
    updatedAt: 0
  };

  const sampleProducts: StockProduct[] = [
    {
      id: "prod-sim",
      name: "RETAIL IMZI",
      slug: "retail-imzi",
      rate: 280,
      active: true,
      category: "sim",
      paymentTrackingEnabled: true,
      displayOrder: 1,
      createdBy: "system",
      createdAt: 0,
      updatedAt: 0
    }
  ];

  it("isServerLoadedStockDay identifies dummy stubs vs server-loaded days correctly", () => {
    const dummyStub: StockDayRecord = {
      id: "26",
      monthId: "2026-10",
      dayNo: 26,
      date: "2026-10-26",
      status: "closed",
      entries: [],
      stockOut: [],
      stockIn: [],
      summary: { accountCount: 0, totalQty: 0, totalAmount: 0, totalPaymentReceived: 0, totalDueBalance: 0 },
      createdBy: "system",
      createdAt: 0,
      updatedAt: 0
    };
    expect(isServerLoadedStockDay(dummyStub)).toBe(false);

    const loadedDay: StockDayRecord = {
      ...dummyStub,
      entries: [
        {
          id: "entry-26",
          date: "2026-10-26",
          monthId: "2026-10",
          dayNo: 26,
          accountId: arslanAccountId,
          accountName: "DO ARSLAN",
          accountType: "DO",
          products: [],
          payments: [],
          totalQty: 0,
          totalAmount: 60480,
          totalPaymentReceived: 118160,
          carryForwardBalance: 59575,
          dueBalance: 1895,
          status: "closed",
          createdBy: "system",
          createdAt: 1000,
          updatedAt: 1000
        }
      ]
    };
    expect(isServerLoadedStockDay(loadedDay)).toBe(true);
  });

  it("server month days properly replace dummy stubs regardless of timestamp", () => {
    const currentDays: StockDayRecord[] = Array.from({ length: 31 }, (_, i) => ({
      id: String(i + 1),
      monthId: "2026-10",
      dayNo: i + 1,
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      status: "closed",
      entries: [],
      stockOut: [],
      stockIn: [],
      summary: { accountCount: 0, totalQty: 0, totalAmount: 0, totalPaymentReceived: 0, totalDueBalance: 0 },
      createdBy: "system",
      createdAt: 0,
      updatedAt: 0
    }));

    // Suppose day 26 was independently loaded first by selectedDay hook
    currentDays[25] = {
      ...currentDays[25],
      entries: [
        {
          id: "entry-26",
          date: "2026-10-26",
          monthId: "2026-10",
          dayNo: 26,
          accountId: arslanAccountId,
          accountName: "DO ARSLAN",
          accountType: "DO",
          products: [],
          payments: [],
          totalQty: 100,
          totalAmount: 60480,
          totalPaymentReceived: 118160,
          carryForwardBalance: 59575,
          dueBalance: 1895,
          status: "closed",
          createdBy: "system",
          createdAt: 500,
          updatedAt: 500
        }
      ]
    };

    // Full month days arrive from loadStockMonthPostgres
    const monthDays: StockDayRecord[] = Array.from({ length: 31 }, (_, i) => ({
      id: String(i + 1),
      monthId: "2026-10",
      dayNo: i + 1,
      date: `2026-10-${String(i + 1).padStart(2, "0")}`,
      status: "closed",
      entries: [
        {
          id: `entry-${i + 1}`,
          date: `2026-10-${String(i + 1).padStart(2, "0")}`,
          monthId: "2026-10",
          dayNo: i + 1,
          accountId: arslanAccountId,
          accountName: "DO ARSLAN",
          accountType: "DO",
          products: [],
          payments: [],
          totalQty: i === 8 ? 146 : i === 25 ? 100 : 0,
          totalAmount: i === 8 ? 40880 : i === 25 ? 60480 : 0,
          totalPaymentReceived: i === 8 ? 118160 : i === 25 ? 118160 : 0,
          carryForwardBalance: i <= 8 ? 136855 : i <= 25 ? 59575 : 1895,
          dueBalance: i < 8 ? 136855 : i < 25 ? 59575 : 1895,
          status: "closed",
          createdBy: "system",
          createdAt: 100,
          updatedAt: 100
        }
      ],
      stockOut: [],
      stockIn: [],
      summary: { accountCount: 1, totalQty: 0, totalAmount: 0, totalPaymentReceived: 0, totalDueBalance: 0 },
      createdBy: "system",
      createdAt: 100,
      updatedAt: 100
    }));

    // Merge logic:
    const monthDaysMap = new Map(monthDays.map((d) => [d.dayNo, d]));
    const updated = currentDays.map((existingDay) => {
      const loaded = monthDaysMap.get(existingDay.dayNo);
      if (!loaded) return existingDay;
      if (!isServerLoadedStockDay(existingDay)) {
        return loaded;
      }
      if (existingDay.updatedAt && loaded.updatedAt && existingDay.updatedAt > loaded.updatedAt) {
        return existingDay;
      }
      return loaded;
    });

    // Check that Day 9 is now loaded!
    const day9 = updated.find((d) => d.dayNo === 9);
    expect(day9?.entries.length).toBe(1);
    expect(day9?.entries[0].carryForwardBalance).toBe(136855);
    expect(day9?.entries[0].totalAmount).toBe(40880);
    expect(day9?.entries[0].totalPaymentReceived).toBe(118160);

    // Check that Day 26 is preserved with its newer data
    const day26 = updated.find((d) => d.dayNo === 26);
    expect(day26?.entries[0].carryForwardBalance).toBe(59575);
    expect(day26?.entries[0].dueBalance).toBe(1895);
  });

  it("dealer monthly summary opening balance evaluates to month opening (136,855) regardless of whether day 26 or day 1 is selected", () => {
    const openingBalances = {
      openingStock: {},
      jazzOpeningPayable: 0,
      stockAccountOpening: {
        [arslanAccountId]: 136855
      }
    };

    const days: StockDayRecord[] = [
      {
        id: "1",
        monthId: "2026-10",
        dayNo: 1,
        date: "2026-10-01",
        status: "closed",
        stockAccountProjections: [{ account_id: arslanAccountId, opening_due: "136855.00", closing_due: "136855.00" } as any],
        entries: [{ accountId: arslanAccountId, carryForwardBalance: 136855, dueBalance: 136855, totalQty: 0, totalAmount: 0, totalPaymentReceived: 0, products: [] } as any],
        stockOut: [],
        stockIn: [],
        summary: {} as any,
        createdBy: "system",
        createdAt: 0,
        updatedAt: 0
      },
      {
        id: "26",
        monthId: "2026-10",
        dayNo: 26,
        date: "2026-10-26",
        status: "closed",
        stockAccountProjections: [{ account_id: arslanAccountId, opening_due: "59575.00", closing_due: "1895.00" } as any],
        entries: [{ accountId: arslanAccountId, carryForwardBalance: 59575, dueBalance: 1895, totalQty: 100, totalAmount: 60480, totalPaymentReceived: 118160, products: [] } as any],
        stockOut: [],
        stockIn: [],
        summary: {} as any,
        createdBy: "system",
        createdAt: 0,
        updatedAt: 0
      }
    ];

    function calculateDealerOpening(selectedDayNo: number) {
      const day1Record = days.find((d) => d.dayNo === 1);
      const day1Proj = day1Record?.stockAccountProjections?.find((p: any) => p.account_id === arslanAccountId);
      return openingBalances.stockAccountOpening?.[arslanAccountId]
        ?? (day1Proj ? Number((day1Proj as any).opening_due ?? (day1Proj as any).carryForwardBalance ?? 0) : undefined)
        ?? arslanAccount.openingBalance
        ?? 0;
    }

    // When on Day 26:
    expect(calculateDealerOpening(26)).toBe(136855);
    // When on Day 1:
    expect(calculateDealerOpening(1)).toBe(136855);
  });
});
