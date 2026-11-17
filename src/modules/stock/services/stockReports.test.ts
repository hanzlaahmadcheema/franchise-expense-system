import { describe, expect, it, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import { exportStockMonthlyXlsx, exportStockDayXlsx, exportStockPrintable } from "./stockReports";
import type { StockDayRecord, StockMonthlySummary } from "../types/stock.types";

vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();
  return {
    ...actual,
    writeFile: vi.fn()
  };
});

const mockSummary: StockMonthlySummary = {
  monthId: "2026-11",
  totalQty: 100,
  totalAmount: 50000,
  totalPaymentReceived: 45000,
  totalDueBalance: 5000,
  productTotals: [
    { productId: "p1", productName: "SIM Cards", quantity: 100, amount: 50000 }
  ],
  accountTotals: [
    { accountId: "a1", accountName: "Dealer Alpha", accountType: "DO", totalQty: 100, totalAmount: 50000, totalPaymentReceived: 45000, dueBalance: 5000, activeDays: 1 }
  ],
  paymentTotals: [
    { productId: "p1", productName: "SIM Cards", amount: 45000 }
  ],
  dayRows: [
    { dayNo: 1, date: "2026-11-01", accountCount: 1, totalQty: 100, totalAmount: 50000, totalPaymentReceived: 45000, totalDueBalance: 5000, status: "open" }
  ],
  missingDays: [],
  updatedAt: 1
};

const mockDays: StockDayRecord[] = [
  {
    id: "day-1",
    date: "2026-11-01",
    monthId: "2026-11",
    dayNo: 1,
    status: "open",
    summary: {
      accountCount: 1,
      totalQty: 100,
      totalAmount: 50000,
      totalPaymentReceived: 45000,
      totalDueBalance: 5000
    },
    entries: [
      {
        id: "entry-1",
        date: "2026-11-01",
        monthId: "2026-11",
        dayNo: 1,
        accountId: "a1",
        accountName: "Dealer Alpha",
        accountType: "DO",
        totalQty: 100,
        totalAmount: 50000,
        totalPaymentReceived: 45000,
        carryForwardBalance: 0,
        dueBalance: 5000,
        status: "open",
        notes: "Test entry",
        products: [
          {
            productId: "p1",
            productName: "SIM Cards",
            rate: 500,
            quantity: 100,
            amount: 50000,
            paymentTrackingEnabled: true,
            paymentReceived: 45000,
            dueBalance: 5000,
            displayOrder: 1
          }
        ],
        payments: [],
        createdBy: "tester",
        createdAt: 1,
        updatedAt: 1
      }
    ],
    createdBy: "tester",
    createdAt: 1,
    updatedAt: 1
  }
];

describe("stockReports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exports monthly stock ledger to XLSX with correct sheets", () => {
    exportStockMonthlyXlsx(mockSummary, mockDays);

    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [workbook, fileName] = vi.mocked(XLSX.writeFile).mock.calls[0];
    expect(fileName).toBe("stock-ledger-2026-11.xlsx");
    expect(workbook.SheetNames).toEqual(["Summary", "Daily", "Accounts", "Products", "Payments", "Entries"]);
  });

  it("exports daily stock ledger to XLSX with product columns", () => {
    exportStockDayXlsx(mockDays[0]);

    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [workbook, fileName] = vi.mocked(XLSX.writeFile).mock.calls[0];
    expect(fileName).toBe("stock-day-2026-11-1.xlsx");
    expect(workbook.SheetNames).toEqual(["Stock Day"]);
  });

  it("exports printable stock report by opening a print window without noopener", () => {
    const mockDoc = {
      open: vi.fn(),
      write: vi.fn(),
      close: vi.fn()
    };
    const mockWin = {
      document: mockDoc,
      focus: vi.fn(),
      print: vi.fn()
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(mockWin as unknown as Window);

    exportStockPrintable(mockSummary, mockDays);

    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(mockDoc.open).toHaveBeenCalled();
    expect(mockDoc.write).toHaveBeenCalled();
    expect(mockDoc.close).toHaveBeenCalled();

    const writtenHtml = mockDoc.write.mock.calls[0][0];
    expect(writtenHtml).toContain("Stock Ledger - November 2026");
    expect(writtenHtml).toContain("Dealer Alpha");
    expect(writtenHtml).toContain("50,000");
  });

  it("throws clear error when popup is blocked during print export", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    expect(() => exportStockPrintable(mockSummary, mockDays)).toThrow(
      "Popup blocked. Allow popups to print the stock report."
    );
  });
});
