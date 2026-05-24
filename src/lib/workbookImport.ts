import * as XLSX from "xlsx";
import {
  COMMISSION_CATEGORIES,
  type CommissionCategory,
  type CreditRow,
  type DailyLedgerInput,
  type ExpenseItem,
  type OwnerBalanceRow,
  type WorkbookImportPreview
} from "../types/ledger";
import { computeMonth } from "./formulaEngine";

function numberValue(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function stringValue(value: unknown): string {
  return String(value ?? "").trim();
}

function cell(ws: XLSX.WorkSheet, address: string): unknown {
  return ws[address]?.v ?? ws[address]?.w;
}

function sheetDate(sheetName: string): string | undefined {
  if (sheetName === "FINAL") return "FINAL";
  const dayNo = Number(sheetName);
  if (!Number.isInteger(dayNo) || dayNo < 1 || dayNo > 31) return undefined;
  return String(dayNo).padStart(2, "0");
}

function inferExpenseCategory(name: string, description: string) {
  const text = `${name} ${description}`.toLowerCase();
  if (text.includes("salary")) return "Salary";
  if (text.includes("water") || text.includes("coffee") || text.includes("chay") || text.includes("bist")) {
    return "Refreshment";
  }
  if (text.includes("imsi") || text.includes("pospaid") || text.includes("postpaid")) return "IMSI";
  if (text.includes("rent")) return "Rent";
  if (text.includes("bill") || text.includes("electric")) return "Utilities";
  return "General";
}

function parseExpenses(ws: XLSX.WorkSheet, dayNo: number): ExpenseItem[] {
  const rows: ExpenseItem[] = [];
  for (let row = 3; row <= 29; row += 1) {
    const name = stringValue(cell(ws, `A${row}`));
    const description = stringValue(cell(ws, `B${row}`));
    const amount = numberValue(cell(ws, `C${row}`));
    if (!name && !description && amount === 0) continue;
    rows.push({
      id: `${dayNo}-expense-${row}`,
      name: name || "Expense",
      description: description || name || "Expense",
      amount,
      category: inferExpenseCategory(name, description)
    });
  }
  return rows;
}

function parseCommissions(ws: XLSX.WorkSheet, dayNo: number): DailyLedgerInput["commissions"] {
  return COMMISSION_CATEGORIES.map((category, index) => ({
    id: `${dayNo}-commission-${index}`,
    category,
    amount: numberValue(cell(ws, `F${index + 3}`))
  })).filter((item) => item.amount !== 0);
}

function parseOwnerBalances(ws: XLSX.WorkSheet, dayNo: number): OwnerBalanceRow[] {
  const rows: OwnerBalanceRow[] = [];
  for (let row = 3; row <= 14; row += 1) {
    const label = stringValue(cell(ws, `H${row}`));
    const amount = numberValue(cell(ws, `I${row}`));
    if (!label && amount === 0) continue;
    rows.push({
      id: `${dayNo}-owner-${row}`,
      label: label || "Owner Balance",
      amount
    });
  }
  return rows;
}

function parseCredits(ws: XLSX.WorkSheet, dayNo: number): CreditRow[] {
  const rows: CreditRow[] = [];
  for (let row = 22; row <= 40; row += 1) {
    const partyName = stringValue(cell(ws, `E${row}`));
    const opening = numberValue(cell(ws, `F${row}`));
    const today = numberValue(cell(ws, `G${row}`));
    const receive = numberValue(cell(ws, `H${row}`));
    if (!partyName && opening === 0 && today === 0 && receive === 0) continue;
    rows.push({
      id: `${dayNo}-credit-${row}`,
      partyName: partyName || "Credit Party",
      opening,
      today,
      receive
    });
  }
  return rows;
}

function categoryFromCell(value: unknown): CommissionCategory | null {
  const name = stringValue(value);
  return COMMISSION_CATEGORIES.find((category) => category === name) ?? null;
}

export async function parseWorkbookFile(file: File, monthId: string): Promise<WorkbookImportPreview> {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { cellFormula: true, cellText: true });
  const warnings: WorkbookImportPreview["warnings"] = [];

  const daySheets = workbook.SheetNames.filter((name) => {
    const dayNo = Number(name);
    return (Number.isInteger(dayNo) && dayNo >= 1 && dayNo <= 31) || name === "FINAL";
  }).sort((a, b) => {
    if (a === "FINAL") return 1;
    if (b === "FINAL") return -1;
    return Number(a) - Number(b);
  });

  if (!workbook.Sheets.Home) {
    warnings.push({ level: "warning", message: "Home sheet was not found." });
  }
  if (daySheets.length === 0) {
    warnings.push({ level: "error", message: "No day sheets named 1 through 31 were found." });
  }

  const days = daySheets.map((sheetName) => {
    const dayNo = sheetName === "FINAL" ? 32 : Number(sheetName);
    const ws = workbook.Sheets[sheetName];
    const commissions = parseCommissions(ws, dayNo);

    for (let row = 3; row <= 14; row += 1) {
      const category = categoryFromCell(cell(ws, `E${row}`));
      if (!category && stringValue(cell(ws, `E${row}`))) {
        warnings.push({
          level: "info",
          sheetName,
          message: `Unmapped commission label at E${row}: ${stringValue(cell(ws, `E${row}`))}`
        });
      }
    }

    return {
      dayNo,
      date: sheetDate(sheetName),
      label: sheetName === "FINAL" ? "FINAL" : `Day ${sheetName}`,
      expenses: parseExpenses(ws, dayNo),
      commissions,
      ownerBalances: parseOwnerBalances(ws, dayNo),
      credits: parseCredits(ws, dayNo)
    };
  });

  const openingBalance = numberValue(cell(workbook.Sheets["1"], "E18"));
  const computed = computeMonth(days, openingBalance, monthId);
  const workbookTotals = workbook.Sheets.Home
    ? {
        monthlyIssueTotal: numberValue(cell(workbook.Sheets.Home, "C34")),
        monthlyExpenseTotal: numberValue(cell(workbook.Sheets.Home, "E34"))
      }
    : undefined;

  if (workbookTotals) {
    const issueDiff = Math.abs(computed.homeSummary.monthlyIssueTotal - workbookTotals.monthlyIssueTotal);
    const expenseDiff = Math.abs(
      computed.homeSummary.monthlyExpenseTotal - workbookTotals.monthlyExpenseTotal
    );
    if (issueDiff > 0.01) {
      warnings.push({
        level: "warning",
        message: `Imported issue total ${computed.homeSummary.monthlyIssueTotal} differs from Home C34 ${workbookTotals.monthlyIssueTotal}.`
      });
    }
    if (expenseDiff > 0.01) {
      warnings.push({
        level: "warning",
        message: `Imported expense total ${computed.homeSummary.monthlyExpenseTotal} differs from Home E34 ${workbookTotals.monthlyExpenseTotal}.`
      });
    }
  }

  return {
    monthId,
    fileName: file.name,
    openingBalance,
    workbookTotals,
    days,
    computed,
    warnings
  };
}
