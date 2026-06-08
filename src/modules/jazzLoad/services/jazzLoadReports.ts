import * as XLSX from "xlsx";
import type { JazzLoadDay, JazzLoadMonthlySummary } from "../types/jazzLoad.types";
import { formatCurrency } from "../utils/jazzLoadFormatters";

const BRAND_NAME = "Jazz Franchise - 7301";

type SheetSpec = {
  name: string;
  rows: Array<Array<string | number>>;
  widths: number[];
};

function reportDateTime() {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date());
}

function money(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function appendSheet(workbook: XLSX.WorkBook, spec: SheetSpec) {
  const sheet = XLSX.utils.aoa_to_sheet(spec.rows);
  sheet["!cols"] = spec.widths.map((wch) => ({ wch }));
  XLSX.utils.book_append_sheet(workbook, sheet, spec.name);
}

export function buildJazzLoadReportSheets(summary: JazzLoadMonthlySummary, days: JazzLoadDay[]): SheetSpec[] {
  return [
    {
      name: "Summary",
      widths: [28, 18],
      rows: [
        [BRAND_NAME],
        [`Jazz Load Summary - ${summary.monthId}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Metric", "Amount"],
        ["Total Issuance Base", money(summary.totalIssuanceBase)],
        ["Total Issuance Jazz Load", money(summary.totalIssuanceMl)],
        ["Total Payments Base", money(summary.totalPaymentsBase)],
        ["Total Payments Jazz Load", money(summary.totalPaymentsMl)],
        ["Latest Closing Base", money(summary.totalClosingBase)],
        ["Latest Closing Jazz Load", money(summary.totalClosingMl)],
        ["Total Lifting", money(summary.totalLifting)],
        ["Latest In-Hand", money(summary.latestInHandBalance)],
        ["Total Commission", money(summary.totalCommission)]
      ]
    },
    {
      name: "Daily",
      widths: [10, 18, 18, 18, 18, 18, 18, 18, 18, 18, 18],
      rows: [
        [BRAND_NAME],
        [`Jazz Load Daily - ${summary.monthId}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Day", "Issuance Base", "Issuance Jazz Load", "Payment Base", "Payment Jazz Load", "Closing Base", "Lifting", "In-Hand", "Commission 1", "Commission 2", "Total Commission"],
        ...summary.dayRows.map((row) => [
          row.dayNo,
          money(row.issuanceBase),
          money(row.issuanceMl),
          money(row.paymentBase),
          money(row.paymentMl),
          money(row.closingBase),
          money(row.lifting),
          money(row.inHandBalance),
          money(row.commission1),
          money(row.commission2),
          money(row.commission)
        ])
      ]
    },
    {
      name: "DO Balances",
      widths: [26, 18, 18, 18, 18, 18, 14],
      rows: [
        [BRAND_NAME],
        [`Jazz Load DO Balances - ${summary.monthId}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["DO", "Line", "Opening", "Issuance", "Payments", "Closing", "Days"],
        ...summary.doBalances.map((row) => [
          row.doName,
          row.doLine ?? "-",
          money(row.openingBase),
          money(row.issuanceBase),
          money(row.paymentBase),
          money(row.closingBase),
          row.activeDays
        ])
      ]
    },
    {
      name: "Entries",
      widths: [10, 24, 18, 16, 16, 16, 16, 16, 16, 16],
      rows: [
        [BRAND_NAME],
        [`Jazz Load Entries - ${summary.monthId}`],
        [`Generated ${reportDateTime()}`],
        [],
        ["Day", "DO", "Line", "Opening Base", "Opening Jazz Load", "Issuance Base", "Issuance Jazz Load", "Payment Base", "Closing Base", "Closing Jazz Load"],
        ...days.flatMap((day) =>
          day.doEntries.map((entry) => [
            day.dayNo,
            entry.doName,
            entry.doLine ?? "-",
            money(entry.openingBalance.baseAmount),
            money(entry.openingBalance.calculatedAmount),
            money(entry.todayMlIssuance.baseAmount),
            money(entry.todayMlIssuance.calculatedAmount),
            money(entry.paymentReceived.baseAmount),
            money(entry.closingBalance.baseAmount),
            money(entry.closingBalance.calculatedAmount)
          ])
        )
      ]
    }
  ];
}

export function exportJazzLoadXlsx(summary: JazzLoadMonthlySummary, days: JazzLoadDay[]) {
  const workbook = XLSX.utils.book_new();
  buildJazzLoadReportSheets(summary, days).forEach((sheet) => appendSheet(workbook, sheet));
  XLSX.writeFile(workbook, `jazz-load-${summary.monthId}.xlsx`);
}

export function exportJazzLoadPrintable(summary: JazzLoadMonthlySummary) {
  const classic = window.localStorage.getItem("uiMode") === "classic";
  const rows = summary.dayRows
    .map(
      (row) =>
        `<tr><td>${row.dayNo}</td><td>${formatCurrency(row.issuanceMl)}</td><td>${formatCurrency(row.paymentBase)}</td><td>${formatCurrency(row.paymentMl)}</td><td>${formatCurrency(row.commission1)}</td><td>${formatCurrency(row.commission2)}</td><td>${formatCurrency(row.commission)}</td></tr>`
    )
    .join("");
  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) throw new Error("Popup blocked. Allow popups to print the report.");
  win.document.write(`<!doctype html><html><head><title>Jazz Load ${summary.monthId}</title><style>
    body{font-family:Arial,sans-serif;margin:24px;color:#0f172a;font-size:${classic ? "16px" : "14px"}}
    table{width:100%;border-collapse:collapse;margin-top:18px}
    th,td{border:${classic ? "2px" : "1px"} solid #cbd5e1;padding:${classic ? "11px" : "8px"};text-align:left}
    th{background:#e2e8f0}
  </style></head><body>
    <h1>${BRAND_NAME}</h1>
    <h2>Jazz Load Report - ${summary.monthId}</h2>
    <p>Total Issuance Jazz Load: ${formatCurrency(summary.totalIssuanceMl)} | Payments: ${formatCurrency(summary.totalPaymentsBase)} | Commission: ${formatCurrency(summary.totalCommission)}</p>
    <table><thead><tr><th>Day</th><th>Issuance Jazz Load</th><th>Payment Base</th><th>Payment Jazz Load</th><th>Commission 1</th><th>Commission 2</th><th>Total Commission</th></tr></thead><tbody>${rows}</tbody></table>
  </body></html>`);
  win.document.close();
  win.print();
}
