import { describe, it, expect, vi, beforeEach } from "vitest";
import { isServerLoadedJazzDay } from "../modules/jazzLoad/components/JazzLoadModule";
import { isServerLoadedStockDay } from "../modules/stock/components/StockLedgerModule";
import { loadJazzLoadDayPostgres } from "../services/api/jazzLoadTransactionService";
import { loadStockDayPostgres, deleteStockInPostgres } from "../services/api/stockTransactionService";
import { ledgerApiClient } from "../services/api/ledgerApiClient";
import * as periodDayService from "../services/api/periodDayService";
import type { JazzLoadDay, JazzLoadDoProfile, JazzLoadRateConfig } from "../modules/jazzLoad/types/jazzLoad.types";
import type { StockDayRecord, StockProduct, StockAccountProfile } from "../modules/stock/types/stock.types";

vi.mock("../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    jazzDo: { list: vi.fn(), delete: vi.fn() },
    jazzLifting: { list: vi.fn(), delete: vi.fn() },
    stockOrders: { list: vi.fn(), delete: vi.fn() },
    stockPayments: { list: vi.fn(), delete: vi.fn() },
    jazzCompanyPayments: { list: vi.fn(), delete: vi.fn() },
    calculations: { getDayProjections: vi.fn() }
  }
}));

vi.mock("../services/api/periodDayService", async () => {
  const actual = await vi.importActual<typeof import("../services/api/periodDayService")>("../services/api/periodDayService");
  return {
    ...actual,
    resolveAccountingDayId: vi.fn(),
    getAccountingPeriodWithDays: vi.fn()
  };
});

describe("JazzLoad and Stock Persistence & Refresh Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isServerLoadedJazzDay", () => {
    it("returns false for null, undefined, or blank day shell", () => {
      expect(isServerLoadedJazzDay(null)).toBe(false);
      expect(isServerLoadedJazzDay(undefined)).toBe(false);
      const blankDay = {
        id: "1",
        date: "2026-08-01",
        monthId: "2026-08",
        dayNo: 1,
        status: "open",
        doEntries: [],
        lifting: {
          openingBalance: 0,
          mlLifting: 0,
          totalBalance: 0,
          todayMlIssuance: 0,
          inHandBalance: 0
        },
        summary: {
          openingBase: 0,
          openingMl: 0,
          issuanceBase: 0,
          issuanceMl: 0,
          dayTotalBase: 0,
          dayTotalMl: 0,
          paymentBase: 0,
          paymentMl: 0,
          closingBase: 0,
          closingMl: 0,
          commission1: 0,
          commission1MlDeduction: 0,
          commission1AdjustedPayment: 0,
          commission2: 0,
          totalCommission: 0,
          outstandingDoCount: 0
        },
        appliedRates: {
          mlRate: { id: "ml", name: "ML", type: "ml_addition", percentage: 2.4, active: true },
          commission1Rate: null,
          commission2Rate: null,
          snapshotTimestamp: Date.now()
        },
        createdBy: "system",
        createdAt: Date.now(),
        updatedAt: Date.now()
      } as unknown as JazzLoadDay;
      expect(isServerLoadedJazzDay(blankDay)).toBe(false);
    });

    it("returns true when DO entries exist", () => {
      const dayWithEntries = {
        doEntries: [{ id: "entry-1" }],
        lifting: { mlLifting: 0 },
        notes: ""
      } as unknown as JazzLoadDay;
      expect(isServerLoadedJazzDay(dayWithEntries)).toBe(true);
    });

    it("returns true when mlLifting > 0 or notes are present", () => {
      const dayWithLifting = {
        doEntries: [],
        lifting: { mlLifting: 50000 },
        notes: ""
      } as unknown as JazzLoadDay;
      expect(isServerLoadedJazzDay(dayWithLifting)).toBe(true);

      const dayWithNotes = {
        doEntries: [],
        lifting: { mlLifting: 0 },
        notes: "Some day notes"
      } as unknown as JazzLoadDay;
      expect(isServerLoadedJazzDay(dayWithNotes)).toBe(true);
    });
  });

  describe("isServerLoadedStockDay", () => {
    it("returns false for null, undefined, or blank day shell", () => {
      expect(isServerLoadedStockDay(null)).toBe(false);
      expect(isServerLoadedStockDay(undefined)).toBe(false);
      const blankDay: StockDayRecord = {
        id: "1",
        date: "2026-08-01",
        monthId: "2026-08",
        dayNo: 1,
        status: "open",
        entries: [],
        stockOut: [],
        stockIn: [],
        summary: {
          accountCount: 0,
          totalQty: 0,
          totalAmount: 0,
          totalPaymentReceived: 0,
          totalDueBalance: 0
        },
        createdBy: "system",
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      expect(isServerLoadedStockDay(blankDay)).toBe(false);
    });

    it("returns true when outbound entries, inbound stock, or notes exist", () => {
      const dayWithEntries = {
        entries: [{ id: "e-1" }],
        stockIn: [],
        notes: ""
      } as unknown as StockDayRecord;
      expect(isServerLoadedStockDay(dayWithEntries)).toBe(true);

      const dayWithStockIn = {
        entries: [],
        stockIn: [{ id: "in-1" }],
        notes: ""
      } as unknown as StockDayRecord;
      expect(isServerLoadedStockDay(dayWithStockIn)).toBe(true);

      const dayWithNotes = {
        entries: [],
        stockIn: [],
        notes: "Stock note"
      } as unknown as StockDayRecord;
      expect(isServerLoadedStockDay(dayWithNotes)).toBe(true);
    });
  });

  describe("Period blank shells merging algorithm", () => {
    it("preserves server-loaded JazzLoad day when period shell arrives", () => {
      const loadedDay1 = {
        id: "2026-08-01",
        dayNo: 1,
        status: "open",
        doEntries: [{ id: "saved-do-1" }],
        lifting: { mlLifting: 1000 },
        notes: "Day 1 notes"
      } as unknown as JazzLoadDay;

      const currentDays: JazzLoadDay[] = [loadedDay1];

      // New period initialization generates blank shells
      const pgJazzDays: JazzLoadDay[] = [
        { id: "1", dayNo: 1, status: "open", doEntries: [], lifting: { mlLifting: 0 } } as unknown as JazzLoadDay,
        { id: "2", dayNo: 2, status: "closed", doEntries: [], lifting: { mlLifting: 0 } } as unknown as JazzLoadDay
      ];

      const currentDaysMap = new Map(currentDays.map((d) => [d.dayNo, d]));
      const merged = pgJazzDays.map((newDay) => {
        const existing = currentDaysMap.get(newDay.dayNo);
        if (existing && isServerLoadedJazzDay(existing)) {
          return {
            ...existing,
            status: newDay.status
          };
        }
        return newDay;
      });

      expect(merged[0].doEntries).toHaveLength(1);
      expect(merged[0].notes).toBe("Day 1 notes");
      expect(merged[1].dayNo).toBe(2);
      expect(merged[1].doEntries).toHaveLength(0);
    });

    it("preserves server-loaded Stock day when period shell arrives", () => {
      const loadedStockDay1 = {
        id: "1",
        dayNo: 1,
        status: "open",
        entries: [],
        stockIn: [{ id: "shipment-1", totalAmount: 1315000 }],
        notes: "Stock in notes"
      } as unknown as StockDayRecord;

      const currentDays: StockDayRecord[] = [loadedStockDay1];

      const pgStockDays: StockDayRecord[] = [
        { id: "1", dayNo: 1, status: "open", entries: [], stockIn: [] } as unknown as StockDayRecord,
        { id: "2", dayNo: 2, status: "closed", entries: [], stockIn: [] } as unknown as StockDayRecord
      ];

      const currentDaysMap = new Map(currentDays.map((d) => [d.dayNo, d]));
      const merged = pgStockDays.map((newDay) => {
        const existing = currentDaysMap.get(newDay.dayNo);
        if (existing && isServerLoadedStockDay(existing)) {
          return {
            ...existing,
            status: newDay.status
          };
        }
        return newDay;
      });

      expect(merged[0].stockIn).toHaveLength(1);
      expect(merged[0].stockIn![0].totalAmount).toBe(1315000);
      expect(merged[1].dayNo).toBe(2);
      expect(merged[1].stockIn).toHaveLength(0);
    });
  });

  describe("loadJazzLoadDayPostgres", () => {
    it("fetches and reconstructs JazzLoadDay with DO entries and lifting", async () => {
      const mockDayId = "day-uuid-1";
      vi.mocked(periodDayService.resolveAccountingDayId).mockResolvedValue(mockDayId);
      vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue({
        period: { id: "period-1", period_key: "2026-08", status: "open" } as any,
        days: new Map([[1, { id: mockDayId, day_number: 1, status: "open" } as any]]),
        fetchedAt: Date.now()
      });

      vi.mocked(ledgerApiClient.jazzDo.list).mockResolvedValue({
        data: [
          {
            id: "tx-do-1",
            do_profile_id: "profile-mirza",
            do_name_snapshot: "Mirza",
            do_line_snapshot: "Line 1",
            issuance_base: 50000,
            payment_base: 14500,
            applied_ml_rate_percentage: 2.4,
            created_at: "2026-08-01T10:00:00Z",
            updated_at: "2026-08-01T10:30:00Z"
          }
        ]
      });

      vi.mocked(ledgerApiClient.jazzLifting.list).mockResolvedValue({
        data: [
          {
            id: "tx-lift-1",
            ml_lifting_amount: 100000,
            updated_at: "2026-08-01T09:00:00Z"
          }
        ]
      });

      vi.mocked(ledgerApiClient.calculations.getDayProjections).mockResolvedValue({
        day: { id: mockDayId, dayNo: 1, periodId: "period-1", status: "open", calendarDate: "2026-08-01" },
        projections: {
          financial: null,
          creditParties: [],
          stockProducts: [],
          stockAccounts: [],
          jazzLifting: { day_id: mockDayId, opening_balance: 878524, lifting_amount: 100000, issued_do_amount: 51200, closing_balance: 927324 },
          jazzDo: [{ day_id: mockDayId, do_profile_id: "profile-mirza", opening_base: 0, opening_balance_base: 0, issuance_base: 50000, payment_base: 14500, closing_balance_base: 35500 } as any]
        }
      });

      const profiles = [
        { id: "profile-mirza", name: "Mirza", line: "Line 1", active: true, createdBy: "user", createdAt: 0, updatedAt: 0 }
      ] as unknown as JazzLoadDoProfile[];
      const rates = [
        { id: "rate-ml", name: "ML", type: "ml_addition", percentage: 2.4, active: true, createdBy: "user", createdAt: 0, updatedAt: 0 }
      ] as unknown as JazzLoadRateConfig[];

      const loadedDay = await loadJazzLoadDayPostgres("2026-08", 1, profiles, rates);
      expect(loadedDay).not.toBeNull();
      expect(loadedDay?.dayNo).toBe(1);
      expect(loadedDay?.doEntries).toHaveLength(1);
      expect(loadedDay?.doEntries[0].doProfileId).toBe("profile-mirza");
      expect(loadedDay?.doEntries[0].todayMlIssuance.baseAmount).toBe(50000);
      expect(loadedDay?.doEntries[0].paymentReceived.baseAmount).toBe(14500);
      expect(loadedDay?.lifting.mlLifting).toBe(100000);
      expect(loadedDay?.lifting.openingBalance).toBe(878524);
    });
  });

  describe("loadStockDayPostgres", () => {
    it("fetches and reconstructs StockDayRecord with inbound stockIn and outbound entries", async () => {
      const mockDayId = "day-uuid-1";
      vi.mocked(periodDayService.resolveAccountingDayId).mockResolvedValue(mockDayId);
      vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue({
        period: { id: "period-1", period_key: "2026-08", status: "open" } as any,
        days: new Map([[1, { id: mockDayId, day_number: 1, status: "open" } as any]]),
        fetchedAt: Date.now()
      });

      // Inbound order (shipment from Jazz Company)
      vi.mocked(ledgerApiClient.stockOrders.list).mockResolvedValue({
        data: [
          {
            id: "order-inbound-1",
            direction: "inbound",
            supplier_name: "Jazz Company",
            notes: "Jazz shipment",
            lines: [
              { product_id: "prod-sim", quantity: 500, unit_rate: 100 }
            ],
            created_at: "2026-08-01T11:00:00Z",
            updated_at: "2026-08-01T11:00:00Z"
          },
          {
            id: "order-outbound-1",
            direction: "outbound",
            account_id: "acc-ccr-1",
            lines: [
              { product_id: "prod-sim", quantity: 50, unit_rate: 100 }
            ],
            created_at: "2026-08-01T12:00:00Z",
            updated_at: "2026-08-01T12:00:00Z"
          }
        ]
      });

      // Account payment
      vi.mocked(ledgerApiClient.stockPayments.list).mockResolvedValue({
        data: [
          {
            id: "pay-acc-1",
            account_id: "acc-ccr-1",
            amount: 5000,
            payment_method: "cash",
            created_at: "2026-08-01T12:30:00Z",
            updated_at: "2026-08-01T12:30:00Z"
          }
        ]
      });

      // Jazz company payment for inbound order
      vi.mocked(ledgerApiClient.jazzCompanyPayments.list).mockResolvedValue({
        data: [
          {
            id: "jazz-pay-1",
            amount: 50000,
            notes: "Payment for SIMs",
            created_at: "2026-08-01T11:15:00Z",
            updated_at: "2026-08-01T11:15:00Z"
          }
        ]
      });

      vi.mocked(ledgerApiClient.calculations.getDayProjections).mockResolvedValue({
        day: { id: mockDayId, dayNo: 1, periodId: "period-1", status: "open", calendarDate: "2026-08-01" },
        projections: {
          financial: null,
          creditParties: [],
          stockProducts: [],
          stockAccounts: [
            { day_id: mockDayId, account_id: "acc-ccr-1", opening_due: 0, purchases_amount: 5000, payments_amount: 5000, closing_due: 0 }
          ],
          jazzLifting: null,
          jazzDo: []
        }
      });

      const products: StockProduct[] = [
        {
          id: "prod-sim",
          name: "Jazz 4G SIM",
          rate: 100,
          active: true,
          displayOrder: 1,
          paymentTrackingEnabled: false,
          createdBy: "user",
          createdAt: 0,
          updatedAt: 0
        }
      ];

      const accounts: StockAccountProfile[] = [
        {
          id: "acc-ccr-1",
          name: "CCR Station 1",
          type: "CCR",
          active: true,
          displayOrder: 1,
          openingBalance: 0,
          createdBy: "user",
          createdAt: 0,
          updatedAt: 0
        }
      ];

      const loadedStockDay = await loadStockDayPostgres("2026-08", 1, products, accounts);
      expect(loadedStockDay).not.toBeNull();
      expect(loadedStockDay?.dayNo).toBe(1);

      // Verify stockIn
      expect(loadedStockDay?.stockIn).toHaveLength(1);
      const stockIn = loadedStockDay!.stockIn![0];
      expect(stockIn.id).toBe("order-inbound-1");
      expect(stockIn.totalQty).toBe(500);
      expect(stockIn.totalAmount).toBe(50000);
      expect(stockIn.paidAmount).toBe(50000);
      expect(stockIn.stockInMode).toBe("cash");

      // Verify outbound entries
      expect(loadedStockDay?.entries).toHaveLength(1);
      const entry = loadedStockDay!.entries[0];
      expect(entry.accountId).toBe("acc-ccr-1");
      expect(entry.totalQty).toBe(50);
      expect(entry.totalAmount).toBe(5000);
      expect(entry.totalPaymentReceived).toBe(5000);
      expect(entry.dueBalance).toBe(0);
      expect(entry.products[0].quantity).toBe(50);
    });
  });

  describe("deleteStockInPostgres", () => {
    it("deletes stock order and matching jazz company payment", async () => {
      const mockDayId = "day-uuid-1";
      vi.mocked(periodDayService.resolveAccountingDayId).mockResolvedValue(mockDayId);
      vi.mocked(ledgerApiClient.stockOrders.delete).mockResolvedValue({ success: true } as any);
      vi.mocked(ledgerApiClient.jazzCompanyPayments.list).mockResolvedValue({
        data: [
          { id: "pay-1", amount: 50000, notes: "Stock In payment: SIMs" }
        ]
      });
      vi.mocked(ledgerApiClient.jazzCompanyPayments.delete).mockResolvedValue({ success: true } as any);

      const result = await deleteStockInPostgres("2026-08", 1, "order-1", 50000, "SIMs");
      expect(result.success).toBe(true);
      expect(ledgerApiClient.stockOrders.delete).toHaveBeenCalledWith("order-1");
      expect(ledgerApiClient.jazzCompanyPayments.delete).toHaveBeenCalledWith("pay-1");
    });
  });
});
