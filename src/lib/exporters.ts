import * as XLSX from "xlsx";
import type { DailyLedgerComputed, DailyLedgerInput, MonthComputed } from "../types/ledger";

type SheetSpec = {
  name: string;
  rows: Array<Array<string | number>>;
  widths: number[];
};

const BRAND_NAME = "Jazz Franchise - 7301";

function money(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function moneyText(value: number) {
  return money(value).toLocaleString();
}

function safeText(value: unknown) {
  if (value == null || value === "") return "-";
  return String(value);
}

function reportDateTime() {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

function dayTitle(day: DailyLedgerComputed) {
  return day.label ?? (day.dayNo === 32 ? "FINAL" : `Day ${day.dayNo}`);
}

function findDay(month: MonthComputed, dayNo: number) {
  const day = month.days.find((entry) => entry.dayNo === dayNo);
  if (!day) throw new Error(`No saved report data found for day ${dayNo}.`);
  return day;
}

function sectionRows(title: string, headers: string[], rows: Array<Array<string | number>>) {
  return [[title], headers, ...(rows.length > 0 ? rows : [["No rows", ...Array.from({ length: headers.length - 1 }, () => "")]])];
}

function monthlyOwnerRows(month: MonthComputed) {
  return month.days.map((day) => {
    const opening = day.ownerBalances[0]?.opening ?? 0;
    const expense = day.ownerBalances.reduce((total, row) => total + (row.expense ?? Math.max(row.amount, 0)), 0);
    const received = day.ownerBalances.reduce((total, row) => total + (row.received ?? Math.max(-row.amount, 0)), 0);
    return [
      dayTitle(day),
      money(opening),
      money(expense),
      money(received),
      money(day.ownerBalanceTotal)
    ];
  });
}

function applyWorkbookStyle(sheet: XLSX.WorkSheet, rows: Array<Array<string | number>>, widths: number[]) {
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  (sheet as XLSX.WorkSheet & { "!freeze"?: { xSplit: number; ySplit: number } })["!freeze"] = { xSplit: 0, ySplit: 4 };

  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
      const cellRef = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
      const cell = sheet[cellRef];
      if (!cell) continue;
      if (typeof rows[rowIndex]?.[colIndex] === "number") cell.z = "#,##0;[Red]-#,##0";
    }
  }
}

function appendSheet(workbook: XLSX.WorkBook, spec: SheetSpec) {
  const sheet = XLSX.utils.aoa_to_sheet(spec.rows);
  applyWorkbookStyle(sheet, spec.rows, spec.widths);
  XLSX.utils.book_append_sheet(workbook, sheet, spec.name);
}

function writeWorkbook(fileName: string, sheets: SheetSpec[]) {
  const workbook = XLSX.utils.book_new();
  sheets.forEach((sheet) => appendSheet(workbook, sheet));
  XLSX.writeFile(workbook, fileName);
}

export function buildMonthlyReportSheets(month: MonthComputed): SheetSpec[] {
  const commissionCategories = [
    ...new Set(month.homeSummary.commissionMatrix.flatMap((row) => Object.keys(row.byCategory)))
  ];

  return [
    {
      name: "Summary",
      widths: [26, 18, 18, 18],
      rows: [
        [BRAND_NAME],
        [`Monthly Report - ${month.monthId ?? "Month"}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Metric", "Amount"],
        ["Opening Balance", money(month.openingBalance)],
        ["Monthly Issue Total", money(month.homeSummary.monthlyIssueTotal)],
        ["Monthly Expense Total", money(month.homeSummary.monthlyExpenseTotal)],
        ["Final Balance", money(month.homeSummary.monthlyReturnBalance)],
        ["Owner Balance Total", money(month.homeSummary.ownerBalanceTotal)],
        ["Credit Balance Total", money(month.homeSummary.creditBalanceTotal)]
      ]
    },
    {
      name: "Daily Ledger",
      widths: [10, 18, 16, 16, 16, 16, 16, 16],
      rows: [
        [BRAND_NAME],
        [`Daily Ledger - ${month.monthId ?? "Month"}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Day", "Date", "Opening", "Issue", "Total", "Expense", "Balance", "Credit Balance"],
        ...month.homeSummary.dayRows.map((row) => [
          row.dayNo,
          safeText(row.date),
          money(row.openingBalance),
          money(row.issueBalance),
          money(row.totalBalance),
          money(row.expenseTotal),
          money(row.returnBalance),
          money(row.creditBalance)
        ])
      ]
    },
    {
      name: "Commissions",
      widths: [10, ...commissionCategories.map(() => 16), 16],
      rows: [
        [BRAND_NAME],
        [`Commissions - ${month.monthId ?? "Month"}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Day", ...commissionCategories, "Total"],
        ...month.homeSummary.commissionMatrix.map((row) => [
          row.dayNo,
          ...commissionCategories.map((category) => money(row.byCategory[category] ?? 0)),
          money(row.rowTotal)
        ])
      ]
    },
    {
      name: "Expenses",
      widths: [28, 18],
      rows: [
        [BRAND_NAME],
        [`Expense Totals - ${month.monthId ?? "Month"}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Expense By Category",
          ["Category", "Amount"],
          month.homeSummary.expenseByCategory.map((row) => [row.category, money(row.amount)])
        )
      ]
    },
    {
      name: "Credits",
      widths: [30, 18, 14],
      rows: [
        [BRAND_NAME],
        [`Credit Balances - ${month.monthId ?? "Month"}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Credit Party Balances",
          ["Party", "Balance", "Active Days"],
          month.homeSummary.creditPartyBalances.map((row) => [
            row.partyName,
            money(row.balance),
            row.activeDays
          ])
        )
      ]
    },
    {
      name: "Owner Balance",
      widths: [18, 16, 16, 16, 16],
      rows: [
        [BRAND_NAME],
        [`Owner Balance - ${month.monthId ?? "Month"}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Franchise Owner Daily Balances",
          ["Day", "Opening", "Expense", "Received", "Balance"],
          monthlyOwnerRows(month)
        )
      ]
    }
  ];
}

export function buildDailyReportSheets(month: MonthComputed, dayNo: number, input?: DailyLedgerInput): SheetSpec[] {
  const day = findDay(month, dayNo);
  const title = `${dayTitle(day)} - ${month.monthId ?? "Month"}`;

  return [
    {
      name: "Day Summary",
      widths: [26, 18],
      rows: [
        [BRAND_NAME],
        [`Daily Report - ${title}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Metric", "Amount"],
        ["Opening Balance", money(day.openingBalance)],
        ["Issue", money(day.issueBalance)],
        ["Total", money(day.totalBalance)],
        ["Expense", money(day.expenseTotal)],
        ["Return Balance", money(day.returnBalance)],
        ["Commission", money(day.commissionTotal)],
        ["Owner Balance", money(day.ownerBalanceTotal)],
        ["Credit Balance", money(day.creditTotals.balance)]
      ]
    },
    {
      name: "Expenses",
      widths: [22, 24, 36, 16],
      rows: [
        [BRAND_NAME],
        [`Expenses - ${title}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Expenses",
          ["Category", "Name", "Description", "Amount"],
          (input?.expenses ?? []).map((row) => [
            safeText(row.category),
            safeText(row.name),
            safeText(row.description),
            money(row.amount)
          ])
        )
      ]
    },
    {
      name: "Commissions",
      widths: [28, 16],
      rows: [
        [BRAND_NAME],
        [`Commissions - ${title}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Commissions",
          ["Category", "Amount"],
          (input?.commissions ?? []).map((row) => [safeText(row.category), money(row.amount)])
        )
      ]
    },
    {
      name: "Credit Parties",
      widths: [28, 16, 16, 16, 16],
      rows: [
        [BRAND_NAME],
        [`Credit Parties - ${title}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Credit Parties",
          ["Party", "Opening", "Loan", "Receive", "Balance"],
          day.creditRows.map((row) => [
            row.partyName,
            money(row.opening),
            money(row.loan ?? row.today ?? 0),
            money(row.receive),
            money(row.balance ?? 0)
          ])
        )
      ]
    },
    {
      name: "Owner Balance",
      widths: [36, 16, 16, 16, 16],
      rows: [
        [BRAND_NAME],
        [`Owner Balance - ${title}`],
        [`Generated ${reportDateTime()}`],
        [],
        ...sectionRows(
          "Franchise Owner",
          ["Description", "Opening", "Expense", "Received", "Balance"],
          day.ownerBalances.map((row) => [
            safeText(row.description ?? row.label),
            money(row.opening ?? 0),
            money(row.expense ?? Math.max(row.amount, 0)),
            money(row.received ?? Math.max(-row.amount, 0)),
            money(row.balance ?? 0)
          ])
        )
      ]
    }
  ];
}

function dailyCommissionRows(day: DailyLedgerComputed) {
  return day.commissionTotal === 0
    ? []
    : [["Total Commission", money(day.commissionTotal)]];
}

export function exportMonthlyXlsx(month: MonthComputed) {
  writeWorkbook(`${month.monthId ?? "month"}-monthly-franchise-report.xlsx`, buildMonthlyReportSheets(month));
}

export function exportDailyXlsx(month: MonthComputed, dayNo: number, input?: DailyLedgerInput) {
  const day = findDay(month, dayNo);
  writeWorkbook(`${month.monthId ?? "month"}-${dayTitle(day).replace(/\s+/g, "-").toLowerCase()}-daily-report.xlsx`, buildDailyReportSheets(month, dayNo, input));
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tableHtml(title: string, headers: string[], rows: Array<Array<string | number>>) {
  const safeRows = rows.length > 0 ? rows : [["No rows", ...Array.from({ length: headers.length - 1 }, () => "")]];
  return `
    <section class="report-section">
      <h2>${htmlEscape(title)}</h2>
      <table>
        <thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr></thead>
        <tbody>
          ${safeRows.map((row) => `<tr>${row.map((cell) => `<td class="${typeof cell === "number" ? "num" : ""} ${typeof cell === "number" && cell < 0 ? "negative" : ""}">${typeof cell === "number" ? moneyText(cell) : htmlEscape(cell)}</td>`).join("")}</tr>`).join("")}
        </tbody>
      </table>
    </section>
  `;
}

function reportShell(title: string, orientation: "portrait" | "landscape", body: string) {
  const generatedAt = reportDateTime();
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${htmlEscape(title)}</title>
  <style>
    @page { size: A4 ${orientation}; margin: 12mm; }
    body { font-family: Arial, sans-serif; color: #111827; margin: 0; background: white; }
    .report-header { border-bottom: 3px solid #0f172a; padding-bottom: 10px; margin-bottom: 14px; display: flex; justify-content: space-between; gap: 16px; }
    h1 { margin: 0; font-size: 22px; color: #0f172a; }
    .brand { margin: 0 0 4px; color: #047857; font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    .meta { text-align: right; font-size: 11px; color: #475569; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 12px; }
    .kpi { border: 1px solid #cbd5e1; padding: 8px; background: #f8fafc; }
    .kpi span { display: block; font-size: 10px; color: #64748b; text-transform: uppercase; font-weight: 700; }
    .kpi strong { display: block; margin-top: 4px; font-size: 15px; color: #0f172a; }
    .report-section { break-inside: avoid; margin-top: 14px; }
    h2 { margin: 0 0 6px; font-size: 13px; color: #0f172a; }
    table { width: 100%; border-collapse: collapse; font-size: 10px; }
    th { background: #0f172a; color: white; text-align: left; padding: 6px; border: 1px solid #0f172a; }
    td { padding: 5px 6px; border: 1px solid #cbd5e1; vertical-align: top; }
    tbody tr:nth-child(even) td { background: #f8fafc; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .negative { color: #be123c; font-weight: 700; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <button class="no-print" onclick="window.print()" style="position: fixed; right: 16px; top: 16px; padding: 8px 12px;">Print / Save PDF</button>
  <header class="report-header">
    <div>
      <p class="brand">${BRAND_NAME}</p>
      <h1>${htmlEscape(title)}</h1>
    </div>
    <div class="meta">Generated<br>${htmlEscape(generatedAt)}</div>
  </header>
  ${body}
  <script>window.setTimeout(() => window.print(), 250);</script>
</body>
</html>`;
}

function openPrintableReport(title: string, orientation: "portrait" | "landscape", body: string) {
  const html = reportShell(title, orientation, body);
  const iframe = document.createElement("iframe");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "0";
  iframe.style.height = "0";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.setAttribute("aria-hidden", "true");
  document.body.appendChild(iframe);

  const cleanup = () => {
    window.setTimeout(() => {
      iframe.remove();
    }, 1000);
  };

  iframe.onload = () => {
    const printWindow = iframe.contentWindow;
    if (!printWindow) {
      cleanup();
      throw new Error("Could not open the PDF/print preview.");
    }
    printWindow.focus();
    window.setTimeout(() => {
      printWindow.print();
      cleanup();
    }, 250);
  };

  const doc = iframe.contentDocument;
  if (!doc) {
    iframe.remove();
    throw new Error("Could not open the PDF/print preview.");
  }
  doc.open();
  doc.write(html);
  doc.close();
}

function kpiGrid(kpis: Array<[string, number]>) {
  return `<section class="kpi-grid">${kpis.map(([label, value]) => `<div class="kpi"><span>${htmlEscape(label)}</span><strong class="${value < 0 ? "negative" : ""}">${moneyText(value)}</strong></div>`).join("")}</section>`;
}

export function exportMonthlyPdf(month: MonthComputed) {
  const commissionCategories = [
    ...new Set(month.homeSummary.commissionMatrix.flatMap((row) => Object.keys(row.byCategory)))
  ];
  const title = `Monthly Report - ${month.monthId ?? "Month"}`;
  const body = [
    kpiGrid([
      ["Issue Total", month.homeSummary.monthlyIssueTotal],
      ["Expense Total", month.homeSummary.monthlyExpenseTotal],
      ["Final Balance", month.homeSummary.monthlyReturnBalance],
      ["Credit Balance", month.homeSummary.creditBalanceTotal]
    ]),
    tableHtml(
      "Daily Ledger",
      ["Day", "Date", "Opening", "Issue", "Total", "Expense", "Balance", "Credit"],
      month.homeSummary.dayRows.map((row) => [
        row.dayNo,
        safeText(row.date),
        money(row.openingBalance),
        money(row.issueBalance),
        money(row.totalBalance),
        money(row.expenseTotal),
        money(row.returnBalance),
        money(row.creditBalance)
      ])
    ),
    tableHtml(
      "Commissions",
      ["Day", ...commissionCategories, "Total"],
      month.homeSummary.commissionMatrix.map((row) => [
        row.dayNo,
        ...commissionCategories.map((category) => money(row.byCategory[category] ?? 0)),
        money(row.rowTotal)
      ])
    ),
    tableHtml(
      "Expense By Category",
      ["Category", "Amount"],
      month.homeSummary.expenseByCategory.map((row) => [row.category, money(row.amount)])
    ),
    tableHtml(
      "Credit Party Balances",
      ["Party", "Balance", "Active Days"],
      month.homeSummary.creditPartyBalances.map((row) => [row.partyName, money(row.balance), row.activeDays])
    ),
    tableHtml(
      "Franchise Owner Daily Balances",
      ["Day", "Opening", "Expense", "Received", "Balance"],
      monthlyOwnerRows(month)
    )
  ].join("");
  openPrintableReport(title, "landscape", body);
}

export function exportDailyPdf(month: MonthComputed, dayNo: number, input?: DailyLedgerInput) {
  const day = findDay(month, dayNo);
  const title = `Daily Report - ${dayTitle(day)} - ${month.monthId ?? "Month"}`;
  const body = [
    kpiGrid([
      ["Issue", day.issueBalance],
      ["Expense", day.expenseTotal],
      ["Return Balance", day.returnBalance],
      ["Credit Balance", day.creditTotals.balance]
    ]),
    tableHtml(
      "Expenses",
      ["Category", "Name", "Description", "Amount"],
      (input?.expenses ?? []).map((row) => [safeText(row.category), safeText(row.name), safeText(row.description), money(row.amount)])
    ),
    tableHtml(
      "Commissions",
      ["Category", "Amount"],
      input?.commissions.map((row) => [safeText(row.category), money(row.amount)]) ?? dailyCommissionRows(day)
    ),
    tableHtml(
      "Credit Parties",
      ["Party", "Opening", "Loan", "Receive", "Balance"],
      day.creditRows.map((row) => [row.partyName, money(row.opening), money(row.loan ?? row.today ?? 0), money(row.receive), money(row.balance ?? 0)])
    ),
    tableHtml(
      "Franchise Owner",
      ["Description", "Opening", "Expense", "Received", "Balance"],
      day.ownerBalances.map((row) => [
        safeText(row.description ?? row.label),
        money(row.opening ?? 0),
        money(row.expense ?? Math.max(row.amount, 0)),
        money(row.received ?? Math.max(-row.amount, 0)),
        money(row.balance ?? 0)
      ])
    )
  ].join("");
  openPrintableReport(title, "portrait", body);
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
