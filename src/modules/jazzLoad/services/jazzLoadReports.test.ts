import { describe, expect, it, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import { buildJazzLoadReportSheets, exportJazzLoadXlsx, exportJazzLoadPrintable } from "./jazzLoadReports";
import type { JazzLoadDay, JazzLoadMonthlySummary } from "../types/jazzLoad.types";

vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>();
  return {
    ...actual,
    writeFile: vi.fn()
  };
});

const summary: JazzLoadMonthlySummary = {
  monthId: "2026-05",
  totalOpeningBase: 0,
  totalIssuanceBase: 100,
  totalIssuanceMl: 103,
  totalPaymentsBase: 50,
  totalPaymentsMl: 51,
  totalClosingBase: 50,
  totalClosingMl: 51,
  totalLifting: 10,
  latestInHandBalance: 20,
  totalCommission: 2,
  dayRows: [{ dayNo: 1, issuanceBase: 100, issuanceMl: 103, paymentBase: 50, paymentMl: 51, closingBase: 50, lifting: 10, inHandBalance: 20, commission1: 1, commission2: 1, commission: 2 }],
  doBalances: [{ doName: "A", openingBase: 0, issuanceBase: 100, paymentBase: 50, closingBase: 50, closingMl: 51, activeDays: 1 }],
  missingDays: [2],
  updatedAt: 1
};

const days: JazzLoadDay[] = [
  {
    id: "1",
    monthId: "2026-05",
    dayNo: 1,
    date: "2026-05-01",
    status: "open",
    doEntries: [
      {
        id: "a",
        doName: "A",
        openingBalance: { baseAmount: 0, calculatedAmount: 0, appliedRateId: "r", appliedRateName: "R", appliedRatePercentage: 2.6, calculatedAt: 1 },
        todayMlIssuance: { baseAmount: 100, calculatedAmount: 103, appliedRateId: "r", appliedRateName: "R", appliedRatePercentage: 2.6, calculatedAt: 1 },
        dayTotal: { baseAmount: 100, calculatedAmount: 103, appliedRateId: "r", appliedRateName: "R", appliedRatePercentage: 2.6, calculatedAt: 1 },
        paymentReceived: { baseAmount: 50, calculatedAmount: 51, appliedRateId: "r", appliedRateName: "R", appliedRatePercentage: 2.6, calculatedAt: 1 },
        closingBalance: { baseAmount: 50, calculatedAmount: 51, appliedRateId: "r", appliedRateName: "R", appliedRatePercentage: 2.6, calculatedAt: 1 },
        createdBy: "u",
        createdAt: 1,
        updatedAt: 1
      }
    ],
    lifting: { openingBalance: 0, mlLifting: 10, totalBalance: 10, todayMlIssuance: 102.6, inHandBalance: -92.6 },
    summary: {
      openingBase: 0,
      openingMl: 0,
      issuanceBase: 100,
      issuanceMl: 103,
      dayTotalBase: 100,
      dayTotalMl: 103,
      paymentBase: 50,
      paymentMl: 51,
      closingBase: 50,
      closingMl: 51,
      commission1: 1,
      commission1MlDeduction: 1,
      commission1AdjustedPayment: 50,
      commission2: 1,
      totalCommission: 2,
      outstandingDoCount: 1
    },
    createdBy: "u",
    createdAt: 1,
    updatedAt: 1
  }
];

describe("jazzLoadReports", () => {
  it("builds separate Jazz Load report sheets", () => {
    const sheets = buildJazzLoadReportSheets(summary, days);

    expect(sheets.map((sheet) => sheet.name)).toEqual(["Summary", "Daily", "DO Balances", "Entries"]);
    expect(sheets[0].rows).toContainEqual(["Total Issuance Jazz Load", 103]);
    expect(sheets[2].rows).toContainEqual(["A", "-", 0, 100, 50, 50, 1]);
    expect(sheets[3].rows).toContainEqual([1, "A", "-", 0, 0, 100, 103, 50, 50, 51]);
  });

  it("exports monthly Jazz Load report to XLSX", () => {
    exportJazzLoadXlsx(summary, days);

    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
    const [workbook, fileName] = vi.mocked(XLSX.writeFile).mock.calls[0];
    expect(fileName).toBe("jazz-load-2026-05.xlsx");
    expect(workbook.SheetNames).toEqual(["Summary", "Daily", "DO Balances", "Entries"]);
  });

  it("exports printable Jazz Load report by opening print window without noopener", () => {
    const mockDoc = {
      write: vi.fn(),
      close: vi.fn()
    };
    const mockWin = {
      document: mockDoc,
      print: vi.fn()
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(mockWin as unknown as Window);

    exportJazzLoadPrintable(summary);

    expect(openSpy).toHaveBeenCalledWith("", "_blank");
    expect(mockDoc.write).toHaveBeenCalled();
    expect(mockDoc.close).toHaveBeenCalled();
    expect(mockWin.print).toHaveBeenCalled();

    const writtenHtml = mockDoc.write.mock.calls[0][0];
    expect(writtenHtml).toContain("Jazz Load Report - 2026-05");
    expect(writtenHtml).toContain("Total Issuance Jazz Load");
  });

  it("throws clear error when popup is blocked during Jazz Load print export", () => {
    vi.spyOn(window, "open").mockReturnValue(null);

    expect(() => exportJazzLoadPrintable(summary)).toThrow(
      "Popup blocked. Allow popups to print the report."
    );
  });
});
