import { AlertTriangle } from "lucide-react";
import { resolveStockAccountOpeningDue } from "../services/stockCalculations";
import type {
  StockAccountProfile,
  StockAccountType,
  StockDayRecord,
  StockMonthlySummary,
  StockProduct,
  StockProductBalance
} from "../types/stock.types";
import { formatMoney, roundMoney } from "../utils/stockFormatters";

type StockLiftingSummaryTableProps = {
  products: StockProduct[];
  days: StockDayRecord[];
  monthId: string;
  filterStartDate: number;
  filterEndDate: number;
  monthOpeningStock: Record<string, number | null>;
  currentStockBalances: StockProductBalance[];
  productRateById: Record<string, number>;
};

type StockIssuanceSummaryTableProps = {
  products: StockProduct[];
  accounts: StockAccountProfile[];
  days: StockDayRecord[];
  prevSummary: StockMonthlySummary | null | undefined;
  stockAccountOpening?: Record<string, number>;
  filterStartDate: number;
  filterEndDate: number;
  filterProductId: string;
  filterAccountType: "" | StockAccountType;
  filterAccountId: string;
  filterDueStatus: "" | "due" | "nodue";
  filterDayStatus: "" | "open" | "closed" | "reopen";
  filterActiveStatus: "all" | "active" | "inactive";
};

type ProductStockFlowTableProps = {
  products: StockProduct[];
  days: StockDayRecord[];
  filterStartDate: number;
  filterEndDate: number;
  filterProductId: string;
  filterStockInMode: "" | "cash" | "credit";
  filterAccountType: "" | StockAccountType;
  filterAccountId: string;
  monthOpeningStock: Record<string, number | null>;
};

type CashCreditStockInTableProps = {
  days: StockDayRecord[];
  filterStartDate: number;
  filterEndDate: number;
};

function isNonZeroSummaryValue(value: unknown) {
  if (value == null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue !== 0;
}

export function hasAnyNonZeroSummaryValue(values: unknown[]) {
  return values.some(isNonZeroSummaryValue);
}

function dayLabel(monthId: string, dayNo: number) {
  return new Date(`${monthId}-${String(dayNo).padStart(2, "0")}T00:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric"
  });
}

export function StockLiftingSummaryTable({
  products,
  days,
  monthId,
  filterStartDate,
  filterEndDate,
  monthOpeningStock,
  currentStockBalances,
  productRateById
}: StockLiftingSummaryTableProps) {
  const activeProducts = products.filter((product) => product.active);
  const daysRange = Array.from(
    { length: Math.max(0, filterEndDate - filterStartDate + 1) },
    (_, index) => filterStartDate + index
  );

  const productOpening: Record<string, number> = {};
  const productReceived: Record<string, number> = {};
  const productIssued: Record<string, number> = {};
  const productInHand: Record<string, number> = {};
  const productValuation: Record<string, number> = {};

  const skippedProductIds = new Set(
    activeProducts
      .filter((p) => monthOpeningStock[p.id] === null)
      .map((p) => p.id)
  );

  activeProducts.forEach((product) => {
    const balanceRow = currentStockBalances.find((balance) => balance.productId === product.id);
    const rate = productRateById[product.id] ?? 0;
    const isSkipped = skippedProductIds.has(product.id);

    productOpening[product.id] = isSkipped ? 0 : (monthOpeningStock[product.id] ?? 0);
    productReceived[product.id] = isSkipped ? 0 : ((monthOpeningStock[product.id] ?? 0) + (balanceRow?.totalStockIn ?? 0));
    productIssued[product.id] = isSkipped ? 0 : (balanceRow?.totalStockOut ?? 0);
    productInHand[product.id] = isSkipped ? 0 : (balanceRow?.currentStock ?? 0);
    productValuation[product.id] = isSkipped ? 0 : ((balanceRow?.currentStock ?? 0) * rate);
  });

  const grandOpening = activeProducts.reduce((sum, product) => sum + productOpening[product.id], 0);
  const grandReceived = activeProducts.reduce((sum, product) => sum + productReceived[product.id], 0);
  const grandIssued = activeProducts.reduce((sum, product) => sum + productIssued[product.id], 0);
  const grandInHand = activeProducts.reduce((sum, product) => sum + productInHand[product.id], 0);
  const grandValuation = activeProducts.reduce((sum, product) => sum + productValuation[product.id], 0);
  const liftingRows = daysRange.flatMap((dayNo) => {
    const dayRecord = days.find((day) => day.dayNo === dayNo);
    const shipments = dayRecord?.stockIn ?? [];
    const productQuantities = Object.fromEntries(activeProducts.map((product) => {
      const dayProductQty = shipments.reduce((sum, shipment) => {
        const match = shipment.products.find((stockProduct) => stockProduct.productId === product.id);
        return sum + (match?.quantity ?? 0);
      }, 0);
      return [product.id, dayProductQty];
    })) as Record<string, number>;
    const dayTotalQty = Object.values(productQuantities).reduce((sum, quantity) => sum + quantity, 0);

    if (dayTotalQty <= 0) return [];
    return [{ dayNo, productQuantities, dayTotalQty }];
  });

  return (
    <div className="space-y-4">
      <div className="table-wrap">
        <table className="!text-xs w-full">
          <thead>
            <tr className="border-b border-slate-800 text-slate-100 font-semibold text-center uppercase tracking-wider">
              <th className="py-2.5 px-3 text-left">Date</th>
              <th colSpan={activeProducts.length} className="py-2.5 px-3 text-slate-100">
                Monthly Stock Position & Value
              </th>
              <th className="py-2.5 px-3 text-slate-100">Total</th>
            </tr>

            <tr className="border-b border-slate-800 text-slate-200 font-mono text-center">
              <th className="py-2 px-3 text-left font-sans text-[10px] uppercase font-bold text-slate-400">
                Unit Rate (Rs.)
              </th>
              {activeProducts.map((product) => (
                <th key={product.id} className="py-2 px-3 font-bold text-emerald-400">
                  {productRateById[product.id] ?? 0}
                </th>
              ))}
              <th className="py-2 px-3 font-bold text-slate-100">RATE</th>
            </tr>

            <tr className="border-b border-slate-800 text-slate-100 font-extrabold text-center">
              <th className="py-2 px-3 text-left text-[10px] uppercase tracking-wider text-slate-400">
                Product Name
              </th>
              {activeProducts.map((product) => (
                <th key={product.id} className="py-2 px-3 font-bold uppercase text-slate-100">
                  {product.name}
                </th>
              ))}
              <th className="py-2 px-3 font-bold uppercase text-slate-100">TOTAL QTY</th>
            </tr>
          </thead>

          <tbody>
            <tr className="border-b border-slate-800 font-bold">
              <td className="py-5 px-3 text-left font-black tracking-wide text-slate-400">OPENING</td>
              {activeProducts.map((product) => {
                const isSkipped = skippedProductIds.has(product.id);
                const value = productOpening[product.id];
                return (
                  <td key={product.id} className="py-5 px-3 text-center font-mono text-slate-100">
                    {isSkipped ? (
                      <span className="text-slate-500 italic font-normal">Skipped</span>
                    ) : value < 0 ? (
                      <span className="text-rose-400 font-bold">{formatMoney(value)}</span>
                    ) : value > 0 ? (
                      formatMoney(value)
                    ) : (
                      "-"
                    )}
                  </td>
                );
              })}
              <td className="py-5 px-3 text-center font-mono font-black text-slate-100">
                {grandOpening < 0 ? (
                  <span className="text-rose-400 font-bold">{formatMoney(grandOpening)}</span>
                ) : grandOpening > 0 ? (
                  formatMoney(grandOpening)
                ) : (
                  "-"
                )}
              </td>
            </tr>

            {liftingRows.map((row) => {
              return (
                <tr key={row.dayNo} className="border-b border-slate-800 transition-colors hover:bg-slate-900/40">
                  <td className="py-4 px-3 text-left font-bold text-slate-400 w-24">{dayLabel(monthId, row.dayNo)}</td>
                  {activeProducts.map((product) => {
                    const dayProductQty = row.productQuantities[product.id] ?? 0;

                    return (
                      <td key={product.id} className={`py-4 px-3 text-center font-mono font-semibold ${dayProductQty > 0 ? "text-slate-100 font-bold" : "text-slate-600"}`}>
                        {dayProductQty > 0 ? formatMoney(dayProductQty) : "-"}
                      </td>
                    );
                  })}
                  <td className="py-4 px-3 text-center font-mono font-bold text-slate-100">
                    {formatMoney(row.dayTotalQty)}
                  </td>
                </tr>
              );
            })}

            <SummaryRow label="STOCK RECEIVED" labelClassName="text-indigo-400" valuesByProduct={productReceived} total={grandReceived} products={activeProducts} skippedProductIds={skippedProductIds} sectionStart />
            <SummaryRow label="STOCK ISSUANCE" labelClassName="text-rose-400" valuesByProduct={productIssued} total={grandIssued} products={activeProducts} skippedProductIds={skippedProductIds} />
            <SummaryRow label="STOCK IN HAND" labelClassName="text-amber-400" valuesByProduct={productInHand} total={grandInHand} products={activeProducts} skippedProductIds={skippedProductIds} prominent />
            <SummaryRow label="STOCK VALUE" labelClassName="text-emerald-400" valuesByProduct={productValuation} total={grandValuation} products={activeProducts} skippedProductIds={skippedProductIds} prominent />
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SummaryRow({
  label,
  labelClassName,
  valuesByProduct,
  total,
  products,
  skippedProductIds,
  prominent = false,
  sectionStart = false
}: {
  label: string;
  labelClassName: string;
  valuesByProduct: Record<string, number>;
  total: number;
  products: StockProduct[];
  skippedProductIds?: Set<string>;
  prominent?: boolean;
  sectionStart?: boolean;
}) {
  const rowClass = [
    "border-b border-slate-700/80 bg-slate-900/90 font-bold shadow-[inset_0_1px_0_rgb(255_255_255_/_0.04)]",
    sectionStart ? "border-t-2 border-t-emerald-400/50" : "",
    prominent ? "bg-slate-900/90 font-extrabold" : ""
  ].filter(Boolean).join(" ");
  const cellClass = prominent
    ? "py-3.5 px-3 text-center font-mono font-black text-[13px] bg-slate-900/60"
    : "py-3 px-3 text-center font-mono font-black bg-slate-900/60";
  const labelCellClass = prominent
    ? "py-3.5 px-3 text-left uppercase tracking-wider font-black text-[13px] bg-slate-900/80 border-l-4 border-current"
    : "py-3 px-3 text-left uppercase tracking-wider font-black bg-slate-900/80 border-l-4 border-current";

  return (
    <tr className={rowClass}>
      <td className={`${labelCellClass} ${labelClassName}`}>{label}</td>
      {products.map((product) => {
        const isSkipped = skippedProductIds?.has(product.id);
        const value = valuesByProduct[product.id];
        return (
          <td key={product.id} className={`${cellClass} ${labelClassName}`}>
            {isSkipped ? (
              <span className="text-slate-500 italic font-normal">Skipped</span>
            ) : value < 0 ? (
              <span className="text-rose-400 font-bold">{formatMoney(value)}</span>
            ) : value > 0 ? (
              formatMoney(value)
            ) : (
              "-"
            )}
          </td>
        );
      })}
      <td className={`${cellClass} ${labelClassName}`}>
        {total < 0 ? (
          <span className="text-rose-400 font-bold">{formatMoney(total)}</span>
        ) : total > 0 ? (
          formatMoney(total)
        ) : (
          "-"
        )}
      </td>
    </tr>
  );
}

export function StockIssuanceSummaryTable({
  products,
  accounts,
  days,
  prevSummary,
  stockAccountOpening,
  filterStartDate,
  filterEndDate,
  filterProductId,
  filterAccountType,
  filterAccountId,
  filterDueStatus,
  filterDayStatus,
  filterActiveStatus
}: StockIssuanceSummaryTableProps) {
  const activeProducts = products.filter((product) => product.active);
  const filteredAccounts = accounts.filter((account) => {
    if (filterAccountId && account.id !== filterAccountId) return false;
    if (filterAccountType && account.type !== filterAccountType) return false;
    if (filterActiveStatus === "active" && !account.active) return false;
    if (filterActiveStatus === "inactive" && account.active) return false;
    return true;
  });
  const filteredDays = [...days]
    .filter((day) => day.dayNo >= filterStartDate && day.dayNo <= filterEndDate && (filterDayStatus === "" || day.status === filterDayStatus))
    .sort((left, right) => left.dayNo - right.dayNo);
  const rows = filteredAccounts.flatMap((account) => {
    const entriesPeriod = filteredDays.flatMap((day) => day.entries.filter((entry) => entry.accountId === account.id));
    const productQuantities: Record<string, number> = Object.fromEntries(activeProducts.map((product) => [product.id, 0]));

    entriesPeriod.forEach((entry) => {
      entry.products.forEach((snapshot) => {
        if (productQuantities[snapshot.productId] !== undefined) {
          productQuantities[snapshot.productId] += snapshot.quantity;
        }
      });
    });

    if (filterProductId && (productQuantities[filterProductId] ?? 0) === 0) return [];

    const firstEntry = filteredDays.flatMap((day) => day.entries.filter((entry) => entry.accountId === account.id)).at(0);
    const opening = firstEntry ? firstEntry.carryForwardBalance : (stockAccountOpening?.[account.id] ?? resolveStockAccountOpeningDue(account, prevSummary));
    const totalQty = entriesPeriod.reduce((sum, entry) => sum + entry.totalQty, 0);
    const totalAmount = entriesPeriod.reduce((sum, entry) => sum + entry.totalAmount, 0);
    const totalPayments = entriesPeriod.reduce((sum, entry) => sum + entry.totalPaymentReceived, 0);
    const calculatedDue = roundMoney(opening + totalAmount - totalPayments);
    const lastEntry = entriesPeriod.filter((e) => e.dueBalance !== undefined).at(-1);
    const closing = lastEntry?.dueBalance !== undefined ? roundMoney(lastEntry.dueBalance) : calculatedDue;
    const currentDue = closing;

    if (filterDueStatus === "due" && closing === 0) return [];
    if (filterDueStatus === "nodue" && closing !== 0) return [];

    return [{
      account,
      productQuantities,
      opening,
      totalQty,
      totalAmount,
      totalPayments,
      currentDue,
      closing
    }];
  });
  const visibleRows = rows.filter((row) => hasAnyNonZeroSummaryValue([
    row.opening,
    ...activeProducts.map((product) => row.productQuantities[product.id]),
    row.totalQty,
    row.totalAmount,
    row.totalPayments,
    row.currentDue,
    row.closing
  ]));
  const totals = visibleRows.reduce((acc, row) => {
    activeProducts.forEach((product) => {
      acc.productQuantities[product.id] = roundMoney((acc.productQuantities[product.id] ?? 0) + (row.productQuantities[product.id] ?? 0));
    });
    return {
      productQuantities: acc.productQuantities,
      opening: roundMoney(acc.opening + row.opening),
      totalQty: roundMoney(acc.totalQty + row.totalQty),
      totalAmount: roundMoney(acc.totalAmount + row.totalAmount),
      totalPayments: roundMoney(acc.totalPayments + row.totalPayments),
      currentDue: roundMoney(acc.currentDue + row.currentDue),
      closing: roundMoney(acc.closing + row.closing)
    };
  }, {
    productQuantities: Object.fromEntries(activeProducts.map((product) => [product.id, 0])) as Record<string, number>,
    opening: 0,
    totalQty: 0,
    totalAmount: 0,
    totalPayments: 0,
    currentDue: 0,
    closing: 0
  });

  return (
    <div className="space-y-4">
      <div className="table-wrap">
        <table className="!text-xs">
          <thead>
            <tr>
              <th>Dealer / Account Name</th>
              <th>Account Type</th>
              <th>Opening Balance</th>
              {activeProducts.map((product) => (
                <th key={product.id} className="text-center font-mono">
                  {product.name}
                </th>
              ))}
              <th>Total Allotted Qty</th>
              <th>Total Stock Amount</th>
              <th>Payment Received</th>
              <th>Closing Balance</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row) => (
                <tr key={row.account.id}>
                  <td className="font-semibold text-slate-200">{row.account.name}</td>
                  <td className="uppercase font-bold text-[10px] text-slate-400">{row.account.type}</td>
                  <td className="font-mono">{formatMoney(row.opening)}</td>
                  {activeProducts.map((product) => {
                    const quantity = row.productQuantities[product.id] ?? 0;
                    return (
                      <td key={product.id} className={`text-center font-mono font-semibold ${quantity !== 0 ? "text-indigo-400" : "text-slate-500"}`}>
                        {quantity !== 0 ? quantity : "-"}
                      </td>
                    );
                  })}
                  <td className="font-semibold text-slate-300">{formatMoney(row.totalQty)}</td>
                  <td className="font-mono text-slate-300">{formatMoney(row.totalAmount)}</td>
                  <td className="text-emerald-400 font-semibold font-mono">{formatMoney(row.totalPayments)}</td>
                  <td className="text-rose-400 font-bold font-mono">{formatMoney(row.closing)}</td>
                </tr>
            ))}
            {visibleRows.length > 0 ? (
              <tr className="border-t border-slate-800 bg-slate-950/40 font-semibold">
                <td className="text-slate-100">Total</td>
                <td className="text-slate-500">-</td>
                <td className="font-mono text-slate-100">{formatMoney(totals.opening)}</td>
                {activeProducts.map((product) => {
                  const quantity = totals.productQuantities[product.id] ?? 0;
                  return (
                    <td key={product.id} className="text-center font-mono text-slate-100">
                      {quantity !== 0 ? formatMoney(quantity) : "-"}
                    </td>
                  );
                })}
                <td className="text-slate-100">{formatMoney(totals.totalQty)}</td>
                <td className="font-mono text-slate-100">{formatMoney(totals.totalAmount)}</td>
                <td className="text-emerald-400 font-semibold font-mono">{formatMoney(totals.totalPayments)}</td>
                <td className="text-rose-400 font-bold font-mono">{formatMoney(totals.closing)}</td>
              </tr>
            ) : (
              <tr>
                <td colSpan={activeProducts.length + 7} className="py-6 text-center text-slate-500 italic">
                  No employee stock issuance activity found for this month.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ProductStockFlowTable({
  products,
  days,
  filterStartDate,
  filterEndDate,
  filterProductId,
  filterStockInMode,
  filterAccountType,
  filterAccountId,
  monthOpeningStock
}: ProductStockFlowTableProps) {
  const filteredProducts = products.filter((product) => !filterProductId || product.id === filterProductId);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Opening Stock</th>
            <th>Stock Received</th>
            <th>Stock Allotted</th>
            <th>Closing Stock</th>
            <th>Rate Snapshot</th>
            <th>Inventory Value</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {filteredProducts.map((product) => {
            const isSkipped = monthOpeningStock[product.id] === null;
            const todayOpening = (() => {
              if (isSkipped) return null;
              const openingValue = monthOpeningStock[product.id] ?? 0;
              let cumulativeStockIn = 0;
              let cumulativeStockOut = 0;

              for (const day of days) {
                if (day.dayNo < filterStartDate) {
                  const stockInRecords = day.stockIn ?? [];
                  for (const record of stockInRecords) {
                    const productLine = record.products.find((line) => line.productId === product.id);
                    if (productLine) cumulativeStockIn += productLine.quantity;
                  }
                  for (const entry of day.entries) {
                    const productLine = entry.products.find((line) => line.productId === product.id);
                    if (productLine) cumulativeStockOut += productLine.quantity;
                  }
                }
              }

              return roundMoney(openingValue + cumulativeStockIn - cumulativeStockOut);
            })();

            const stockInPeriod = days
              .filter((day) => day.dayNo >= filterStartDate && day.dayNo <= filterEndDate)
              .reduce((sum, day) => {
                const stockInRecords = (day.stockIn ?? []).filter((record) => !filterStockInMode || record.stockInMode === filterStockInMode);
                return sum + stockInRecords.reduce((stockInSum, record) => stockInSum + (record.products.find((line) => line.productId === product.id)?.quantity ?? 0), 0);
              }, 0);

            const stockOutPeriod = days
              .filter((day) => day.dayNo >= filterStartDate && day.dayNo <= filterEndDate)
              .reduce((sum, day) => {
                const entries = day.entries.filter((entry) => (!filterAccountId || entry.accountId === filterAccountId) && (!filterAccountType || entry.accountType === filterAccountType));
                return sum + entries.reduce((entrySum, entry) => entrySum + (entry.products.find((line) => line.productId === product.id)?.quantity ?? 0), 0);
              }, 0);

            const closingPeriod = isSkipped ? null : roundMoney((todayOpening ?? 0) + stockInPeriod - stockOutPeriod);
            const value = isSkipped ? 0 : roundMoney((closingPeriod ?? 0) * product.rate);
            const isLow = !isSkipped && (closingPeriod ?? 0) < 20;

            return (
              <tr key={product.id}>
                <td className="font-semibold text-slate-200">{product.name}</td>
                <td>{isSkipped ? <span className="text-slate-500 italic">Skipped</span> : formatMoney(todayOpening ?? 0)}</td>
                <td className="text-indigo-400">{isSkipped ? "—" : `+${formatMoney(stockInPeriod)}`}</td>
                <td className="text-rose-400">{isSkipped ? "—" : `-${formatMoney(stockOutPeriod)}`}</td>
                <td className="font-bold text-slate-100">{isSkipped ? <span className="text-slate-500 italic">Skipped</span> : formatMoney(closingPeriod ?? 0)}</td>
                <td>{formatMoney(product.rate)}</td>
                <td className="font-mono text-emerald-400">{isSkipped ? "—" : formatMoney(value)}</td>
                <td>
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase flex items-center justify-center gap-1 ${
                    isSkipped
                      ? "bg-slate-800 text-slate-400 border border-slate-700"
                      : isLow
                        ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                        : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                  }`}>
                    {isLow && <AlertTriangle className="h-3 w-3" />}
                    <span>{isSkipped ? "Skipped" : isLow ? "Low Stock" : "Healthy"}</span>
                  </span>
                </td>
              </tr>
            );
          })}
          {filteredProducts.length === 0 && (
            <tr>
              <td className="py-6 text-center text-slate-500" colSpan={8}>
                No product stock flow rows match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export function CashCreditStockInTable({
  days,
  filterStartDate,
  filterEndDate
}: CashCreditStockInTableProps) {
  const stockInRecords = days
    .filter((day) => day.dayNo >= filterStartDate && day.dayNo <= filterEndDate)
    .flatMap((day) => day.stockIn ?? []);
  const cashRecords = stockInRecords.filter((record) => record.stockInMode === "cash");
  const creditRecords = stockInRecords.filter((record) => record.stockInMode === "credit");
  const cashTotalAmount = cashRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const creditTotalAmount = creditRecords.reduce((sum, record) => sum + record.totalAmount, 0);
  const creditPaidAmount = creditRecords.reduce((sum, record) => sum + record.paidAmount, 0);
  const creditPayable = creditRecords.reduce((sum, record) => sum + record.jazzPayableAmount, 0);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Payment Mode</th>
            <th>Shipment Count</th>
            <th>Total Value received (Rs.)</th>
            <th>Paid Amount (Rs.)</th>
            <th>outstanding payable (Rs.)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="font-bold text-emerald-400">Cash Mode</td>
            <td>{cashRecords.length}</td>
            <td>{formatMoney(cashTotalAmount)}</td>
            <td className="text-emerald-400 font-semibold">{formatMoney(cashTotalAmount)}</td>
            <td>Rs. 0.00</td>
          </tr>
          <tr>
            <td className="font-bold text-indigo-400">Credit Mode</td>
            <td>{creditRecords.length}</td>
            <td>{formatMoney(creditTotalAmount)}</td>
            <td className="text-blue-400 font-semibold">{formatMoney(creditPaidAmount)}</td>
            <td className="text-rose-400 font-bold">{formatMoney(creditPayable)}</td>
          </tr>
          <tr className="border-t border-slate-800 bg-slate-950/40 font-semibold">
            <td className="text-slate-100">Total</td>
            <td>{cashRecords.length + creditRecords.length}</td>
            <td>{formatMoney(cashTotalAmount + creditTotalAmount)}</td>
            <td className="text-blue-400 font-semibold">{formatMoney(cashTotalAmount + creditPaidAmount)}</td>
            <td className="text-rose-400 font-bold">{formatMoney(creditPayable)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
