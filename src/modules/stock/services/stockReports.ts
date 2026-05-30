import * as XLSX from "xlsx";
import type { StockDayRecord, StockMonthlySummary } from "../types/stock.types";
import { formatMoney, monthLabel } from "../utils/stockFormatters";

const BRAND_NAME = "Jazz Franchise - 7301";

function money(value: number) {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

function reportDayLabel(monthId: string, dayNo: number) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  }).format(new Date(`${monthId}-${String(dayNo).padStart(2, "0")}T00:00:00`));
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
  sheet["!autofilter"] = { ref: XLSX.utils.encode_range(range) };
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
      ]),
      [],
      ["Total", "", summary.dayRows.length, money(summary.totalQty), money(summary.totalAmount), money(summary.totalPaymentReceived), money(summary.totalDueBalance), ""]
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
      ]),
      [],
      ["Total", "", money(summary.totalQty), money(summary.totalAmount), money(summary.totalPaymentReceived), money(summary.totalDueBalance), summary.accountTotals.length]
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
      ...summary.productTotals.map((row) => [row.productName, money(row.quantity), money(row.amount)]),
      [],
      ["Total", money(summary.totalQty), money(summary.totalAmount)]
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
      ...summary.paymentTotals.map((row) => [row.productName, money(row.amount)]),
      [],
      ["Total", money(summary.totalPaymentReceived)]
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
          reportDayLabel(summary.monthId, day.dayNo),
          day.date,
          entry.accountName,
          money(entry.totalQty),
          money(entry.totalAmount),
          money(entry.totalPaymentReceived),
          money(entry.carryForwardBalance),
          money(entry.dueBalance),
          entry.notes ?? ""
        ])
      ),
      [],
      ["Total", "", "", money(summary.totalQty), money(summary.totalAmount), money(summary.totalPaymentReceived), "", money(summary.totalDueBalance), ""]
    ],
    [8, 24, 24, 12, 16, 16, 16, 16, 32]
  );
  XLSX.writeFile(workbook, `stock-ledger-${summary.monthId}.xlsx`);
}

export function exportStockDayXlsx(day: StockDayRecord) {
  const workbook = XLSX.utils.book_new();
  const products = [...new Map(day.entries.flatMap((entry) => entry.products).map((product) => [product.productId, product])).entries()];
  const productTracksPayment = (product: (typeof products)[number][1]) => product.paymentTrackingEnabled !== false;
  const productValueColumns = products.reduce((total, [, product]) => total + (productTracksPayment(product) ? 4 : 2), 0);
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
      ]),
      [],
      ["Total", ...Array.from({ length: productValueColumns }, () => ""), money(day.summary.totalQty), money(day.summary.totalAmount), money(day.summary.totalPaymentReceived), "", money(day.summary.totalDueBalance), ""]
    ],
    [24, ...products.flatMap(([, product]) => Array.from({ length: productTracksPayment(product) ? 4 : 2 }, () => 12)), 12, 16, 16, 16, 16, 32]
  );
  XLSX.writeFile(workbook, `stock-day-${day.monthId}-${day.dayNo}.xlsx`);
}

export function exportStockPrintable(summary: StockMonthlySummary, days: StockDayRecord[]) {
  const rows = days.flatMap((day) =>
    day.entries.map((entry) => `
      <tr>
        <td>${reportDayLabel(summary.monthId, day.dayNo)}</td>
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
  const html = `
    <!doctype html>
    <html>
      <head>
        <title>Stock Ledger ${summary.monthId}</title>
        <style>
          :root { color-scheme: dark; }
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 28px;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #020617;
            color: #e2e8f0;
          }
          .page { max-width: 1280px; margin: 0 auto; }
          .brand {
            font-size: 13px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: #2dd4bf;
            font-weight: 700;
            margin-bottom: 8px;
          }
          h1 { margin: 0; font-size: 28px; color: #f8fafc; }
          .meta { margin: 8px 0 18px; color: #94a3b8; font-size: 13px; }
          .metrics {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 12px;
            margin: 18px 0 24px;
          }
          .metric {
            border: 1px solid #1e293b;
            background: #0f172a;
            border-radius: 10px;
            padding: 12px 14px;
          }
          .metric span {
            display: block;
            color: #94a3b8;
            font-size: 11px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            margin-bottom: 6px;
          }
          .metric strong { font-size: 18px; color: #f8fafc; }
          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
            border: 1px solid #1e293b;
            border-radius: 12px;
            overflow: hidden;
          }
          th, td {
            border-bottom: 1px solid #1e293b;
            padding: 9px 10px;
            text-align: left;
            vertical-align: top;
          }
          th {
            background: #111827;
            color: #cbd5e1;
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-size: 10px;
          }
          tbody tr:nth-child(even) td { background: rgba(15, 23, 42, 0.55); }
          .total-row td {
            background: #08111f !important;
            font-weight: 700;
            color: #e2e8f0;
          }
          .muted { color: #94a3b8; }
          @media print {
            body { padding: 0; background: #ffffff; color: #111827; }
            .page { max-width: none; }
            .metric, table, th, td { border-color: #cbd5e1; }
            .metric { background: #ffffff; }
            .brand { color: #0f766e; }
            th { background: #f1f5f9; color: #0f172a; }
            tbody tr:nth-child(even) td { background: #f8fafc; }
            .total-row td { background: #e2e8f0 !important; color: #0f172a; }
          }
        </style>
      </head>
      <body>
        <div class="page">
          <div class="brand">${BRAND_NAME}</div>
          <h1>Stock Ledger - ${monthLabel(summary.monthId)}</h1>
          <div class="meta">Generated ${reportDateTime()}</div>
          <div class="metrics">
            <div class="metric"><span>Quantity</span><strong>${formatMoney(summary.totalQty)}</strong></div>
            <div class="metric"><span>Amount</span><strong>${formatMoney(summary.totalAmount)}</strong></div>
            <div class="metric"><span>Payment</span><strong>${formatMoney(summary.totalPaymentReceived)}</strong></div>
            <div class="metric"><span>Due</span><strong>${formatMoney(summary.totalDueBalance)}</strong></div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Account</th>
                <th>Qty</th>
                <th>Amount</th>
                <th>Payment</th>
                <th>Carry</th>
                <th>Due</th>
              </tr>
            </thead>
            <tbody>
              ${rows || "<tr><td colspan='7' class='muted'>No stock records saved.</td></tr>"}
              ${rows ? `
                <tr class="total-row">
                  <td>Total</td>
                  <td></td>
                  <td>${formatMoney(totals.qty)}</td>
                  <td>${formatMoney(totals.amount)}</td>
                  <td>${formatMoney(totals.payment)}</td>
                  <td></td>
                  <td>${formatMoney(totals.due)}</td>
                </tr>
              ` : ""}
            </tbody>
          </table>
        </div>
        <script>
          window.addEventListener('load', () => {
            setTimeout(() => {
              window.focus();
              window.print();
            }, 200);
          });
        </script>
      </body>
    </html>
  `;
  win.document.open();
  win.document.write(html);
  win.document.close();
}
