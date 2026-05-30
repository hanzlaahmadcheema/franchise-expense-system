import * as XLSX from "xlsx";
import type { StockDayRecord, StockMonthlySummary } from "../types/stock.types";
import { formatMoney, monthLabel } from "../utils/stockFormatters";

const BRAND_NAME = "Jazz Franchise - 7301";

function money(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
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

function appendSheet(workbook: XLSX.WorkBook, name: string, rows: Array<Array<string | number>>, widths: number[]) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  const range = XLSX.utils.decode_range(sheet["!ref"] ?? "A1:A1");
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    for (let colIndex = range.s.c; colIndex <= range.e.c; colIndex += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: colIndex })];
      if (cell && typeof rows[rowIndex]?.[colIndex] === "number") cell.z = "#,##0;[Red]-#,##0";
    }
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

export function exportStockMonthlyXlsx(summary: StockMonthlySummary, days: StockDayRecord[]) {
  const workbook = XLSX.utils.book_new();
  appendSheet(
    workbook,
    "Summary",
    [
      [BRAND_NAME],
      [`Stock Ledger - ${monthLabel(summary.monthId)}`],
      [`Generated ${reportDateTime()}`],
      [],
      ["Metric", "Amount"],
      ["Total Quantity", money(summary.totalQty)],
      ["Total Stock Amount", money(summary.totalAmount)],
      ["Payment Received", money(summary.totalPaymentReceived)],
      ["Due Balance", money(summary.totalDueBalance)]
    ],
    [26, 18]
  );
  appendSheet(
    workbook,
    "Daily",
    [
      [BRAND_NAME],
      [`Daily Stock Summary - ${monthLabel(summary.monthId)}`],
      [`Generated ${reportDateTime()}`],
      [],
      ["Day", "Date", "Accounts", "Qty", "Amount", "Payment", "Due", "Status"],
      ...summary.dayRows.map((row) => [
        row.dayNo,
        row.date,
        row.accountCount,
        money(row.totalQty),
        money(row.totalAmount),
        money(row.totalPaymentReceived),
        money(row.totalDueBalance),
        row.status
      ])
    ],
    [8, 24, 12, 12, 16, 16, 16, 12]
  );
  appendSheet(
    workbook,
    "Accounts",
    [
      [BRAND_NAME],
      [`CCR/DO Summary - ${monthLabel(summary.monthId)}`],
      [`Generated ${reportDateTime()}`],
      [],
      ["Account", "Type", "Qty", "Amount", "Payment", "Due", "Active Days"],
      ...summary.accountTotals.map((row) => [
        row.accountName,
        row.accountType,
        money(row.totalQty),
        money(row.totalAmount),
        money(row.totalPaymentReceived),
        money(row.dueBalance),
        row.activeDays
      ])
    ],
    [24, 12, 12, 16, 16, 16, 14]
  );


  appendSheet(
    workbook,
    "Products",
    [
      [BRAND_NAME],
      [`Product Totals - ${monthLabel(summary.monthId)}`],
      [`Generated ${reportDateTime()}`],
      [],
      ["Product", "Quantity", "Amount"],
      ...summary.productTotals.map((row) => [row.productName, money(row.quantity), money(row.amount)])
    ],
    [28, 14, 16]
  );
  appendSheet(
    workbook,
    "Payments",
    [
      [BRAND_NAME],
      [`Payment Totals - ${monthLabel(summary.monthId)}`],
      [`Generated ${reportDateTime()}`],
      [],
      ["Product", "Payment Received"],
      ...summary.paymentTotals.map((row) => [row.productName, money(row.amount)])
    ],
    [28, 16]
  );
  appendSheet(
    workbook,
    "Entries",
    [
      [BRAND_NAME],
      [`Detailed Entries - ${monthLabel(summary.monthId)}`],
      [`Generated ${reportDateTime()}`],
      [],
      ["Day", "Date", "Account", "Qty", "Amount", "Payment", "Carry Forward", "Due", "Notes"],
      ...days.flatMap((day) =>
        day.entries.map((entry) => [
          day.dayNo,
          day.date,
          entry.accountName,
          money(entry.totalQty),
          money(entry.totalAmount),
          money(entry.totalPaymentReceived),
          money(entry.carryForwardBalance),
          money(entry.dueBalance),
          entry.notes ?? ""
        ])
      )
    ],
    [8, 24, 24, 12, 16, 16, 16, 16, 32]
  );
  XLSX.writeFile(workbook, `stock-ledger-${summary.monthId}.xlsx`);
}

export function exportStockDayXlsx(day: StockDayRecord) {
  const workbook = XLSX.utils.book_new();
  const products = [...new Map(day.entries.flatMap((entry) => entry.products).map((product) => [product.productId, product])).entries()];
  const productTracksPayment = (product: (typeof products)[number][1]) => product.paymentTrackingEnabled !== false;
  const headers = [
    "Account",
    ...products.flatMap(([, product]) => [
      `${product.productName} Qty`,
      `${product.productName} Amt`,
      ...(productTracksPayment(product) ? [`${product.productName} Pay`, `${product.productName} Due`] : [])
    ]),
    "Total Qty",
    "Total Amount",
    "Payment",
    "Carry",
    "Due",
    "Notes"
  ];
  appendSheet(
    workbook,
    "Stock Day",
    [
      [BRAND_NAME],
      [`Stock Day ${day.dayNo} - ${day.date}`],
      [`Generated ${reportDateTime()}`],
      [],
      headers,
      ...day.entries.map((entry) => [
        entry.accountName,
        ...products.flatMap(([productId, product]) => {
          const row = entry.products.find((item) => item.productId === productId);
          const cells = [money(row?.quantity ?? 0), money(row?.amount ?? 0)];
          if (productTracksPayment(product)) {
            cells.push(money(row?.paymentReceived ?? 0), money(row?.dueBalance ?? 0));
          }
          return cells;
        }),
        money(entry.totalQty),
        money(entry.totalAmount),
        money(entry.totalPaymentReceived),
        money(entry.carryForwardBalance),
        money(entry.dueBalance),
        entry.notes ?? ""
      ])
    ],
    [24, ...products.flatMap(([, product]) => Array.from({ length: productTracksPayment(product) ? 4 : 2 }, () => 12)), 12, 16, 16, 16, 16, 32]
  );
  XLSX.writeFile(workbook, `stock-day-${day.monthId}-${day.dayNo}.xlsx`);
}

export function exportStockPrintable(summary: StockMonthlySummary, days: StockDayRecord[]) {
  const rows = days.flatMap((day) =>
    day.entries.map((entry) => `
      <tr>
        <td>${day.dayNo}</td>
        <td>${entry.accountName}</td>
        <td>${formatMoney(entry.totalQty)}</td>
        <td>${formatMoney(entry.totalAmount)}</td>
        <td>${formatMoney(entry.totalPaymentReceived)}</td>
        <td>${formatMoney(entry.carryForwardBalance)}</td>
        <td>${formatMoney(entry.dueBalance)}</td>
      </tr>
    `)
  ).join("");
  const totals = days.flatMap((day) => day.entries).reduce((acc, entry) => ({
    qty: acc.qty + entry.totalQty,
    amount: acc.amount + entry.totalAmount,
    payment: acc.payment + entry.totalPaymentReceived,
    carry: acc.carry + entry.carryForwardBalance,
    due: acc.due + entry.dueBalance
  }), { qty: 0, amount: 0, payment: 0, carry: 0, due: 0 });
  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) throw new Error("Popup blocked. Allow popups to print the stock report.");
  win.document.write(`
    <html>
      <head>
        <title>Stock Ledger ${summary.monthId}</title>
        <style>
          body { font-family: Arial, sans-serif; color: #111827; padding: 24px; }
          h1 { margin: 0 0 4px; font-size: 22px; }
          p { margin: 0 0 16px; color: #475569; }
          table { width: 100%; border-collapse: collapse; font-size: 12px; }
          th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: left; }
          th { background: #f1f5f9; }
          .metrics { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 16px 0; }
          .metric { border: 1px solid #cbd5e1; padding: 10px; border-radius: 8px; }
          .metric span { display: block; color: #64748b; font-size: 11px; text-transform: uppercase; }
          .metric strong { font-size: 16px; }
        </style>
      </head>
      <body>
        <h1>${BRAND_NAME}</h1>
        <p>Stock Ledger - ${monthLabel(summary.monthId)} · Generated ${reportDateTime()}</p>
        <div class="metrics">
          <div class="metric"><span>Quantity</span><strong>${formatMoney(summary.totalQty)}</strong></div>
          <div class="metric"><span>Amount</span><strong>${formatMoney(summary.totalAmount)}</strong></div>
          <div class="metric"><span>Payment</span><strong>${formatMoney(summary.totalPaymentReceived)}</strong></div>
          <div class="metric"><span>Due</span><strong>${formatMoney(summary.totalDueBalance)}</strong></div>
        </div>
        <table>
          <thead><tr><th>Day</th><th>Account</th><th>Qty</th><th>Amount</th><th>Payment</th><th>Carry</th><th>Due</th></tr></thead>
          <tbody>
            ${rows || "<tr><td colspan='7'>No stock records saved.</td></tr>"}
            ${rows ? `
              <tr>
                <td><strong>Total</strong></td>
                <td></td>
                <td><strong>${formatMoney(totals.qty)}</strong></td>
                <td><strong>${formatMoney(totals.amount)}</strong></td>
                <td><strong>${formatMoney(totals.payment)}</strong></td>
                <td></td>
                <td><strong>${formatMoney(totals.due)}</strong></td>
              </tr>
            ` : ""}
          </tbody>
        </table>
      </body>
    </html>
  `);
  win.document.close();
  win.focus();
  win.print();
}
