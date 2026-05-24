import * as XLSX from "xlsx";
import type { MonthComputed } from "../types/ledger";

export function exportMonthToExcel(month: MonthComputed) {
  const workbook = XLSX.utils.book_new();
  const commissionCategories = [
    ...new Set(month.homeSummary.commissionMatrix.flatMap((row) => Object.keys(row.byCategory)))
  ];
  const summaryRows = [
    ["Month", month.monthId ?? ""],
    ["Opening Balance", month.openingBalance],
    ["Monthly Issue Total", month.homeSummary.monthlyIssueTotal],
    ["Monthly Expense Total", month.homeSummary.monthlyExpenseTotal],
    ["Final Return Balance", month.homeSummary.monthlyReturnBalance],
    ["Owner Balance Total", month.homeSummary.ownerBalanceTotal],
    ["Credit Balance Total", month.homeSummary.creditBalanceTotal],
    [],
    ["Day", "Date", "Opening", "Issue", "Total", "Expense", "Return", "Credit Balance"],
    ...month.homeSummary.dayRows.map((row) => [
      row.dayNo,
      row.date ?? "",
      row.openingBalance,
      row.issueBalance,
      row.totalBalance,
      row.expenseTotal,
      row.returnBalance,
      row.creditBalance
    ])
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summaryRows), "Dashboard");
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      month.homeSummary.commissionMatrix.map((row) => ({
        Day: row.dayNo,
        ...commissionCategories.reduce(
          (acc, category) => ({ ...acc, [category]: row.byCategory[category] ?? 0 }),
          {}
        ),
        Total: row.rowTotal
      }))
    ),
    "Commissions"
  );

  XLSX.writeFile(workbook, `${month.monthId ?? "month"}-franchise-report.xlsx`);
}

export function exportBackupPackage(payload: unknown, fileName = "franchise-backup.json") {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readBackupPackage(file: File) {
  return JSON.parse(await file.text()) as unknown;
}

export function printMonthReport() {
  window.print();
}
