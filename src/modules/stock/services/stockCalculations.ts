import type {
  StockAccountProfile,
  StockDailyAccountDraft,
  StockDailyAccountEntry,
  StockDailySummary,
  StockDayRecord,
  StockJazzCompanyBalance,
  StockMonth,
  StockMonthlySummary,
  StockPaymentSnapshot,
  StockProduct,
  StockProductBalance,
  StockProductSnapshot,
  StockValidationResult,
  StockInRecord,
  StockProductLine
} from "../types/stock.types";
import { daysInMonth, normalizeKey, roundMoney } from "../utils/stockFormatters";

function sum(values: number[]) {
  return roundMoney(values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0));
}

export function productPaymentTrackingEnabled(product: Pick<StockProduct, "paymentTrackingEnabled">) {
  return product.paymentTrackingEnabled !== false;
}

export function calculateProductAmount(quantity: number, rate: number) {
  return roundMoney(quantity * rate);
}

export function calculateProductDueBalance(amount: number, paymentReceived: number) {
  return roundMoney(amount - paymentReceived);
}

export function calculateStockEntryTotals(products: StockProductSnapshot[]) {
  return {
    totalQty: sum(products.map((product) => product.quantity)),
    totalAmount: sum(products.map((product) => product.amount))
  };
}

export function calculatePaymentTotal(payments: StockPaymentSnapshot[]) {
  return sum(payments.map((payment) => payment.amount));
}

export function calculateEntryPaymentReceived(products: StockProductSnapshot[], legacyPayments: StockPaymentSnapshot[] = []) {
  const trackedTotal = sum(
    products
      .filter((product) => product.paymentTrackingEnabled)
      .map((product) => product.paymentReceived)
  );
  if (trackedTotal > 0 || products.some((product) => product.paymentTrackingEnabled)) {
    return trackedTotal;
  }
  return calculatePaymentTotal(legacyPayments);
}

export function calculateDueBalance(input: {
  carryForwardBalance: number;
  totalAmount: number;
  totalPaymentReceived: number;
}) {
  return roundMoney(input.carryForwardBalance + input.totalAmount - input.totalPaymentReceived);
}

export function resolveStockAccountOpeningDue(
  account: Pick<StockAccountProfile, "id" | "openingBalance">,
  previousSummary?: StockMonthlySummary | null
) {
  return roundMoney(previousSummary?.accountTotals.find((item) => item.accountId === account.id)?.dueBalance ?? account.openingBalance ?? 0);
}

export function resolveStockCarryForwardBalance(input: {
  previousEntryDueBalance?: number;
  previousMonthDueBalance?: number;
  accountOpeningBalance?: number;
}) {
  return roundMoney(input.previousEntryDueBalance ?? input.previousMonthDueBalance ?? input.accountOpeningBalance ?? 0);
}

export function calculateDailyAccountSummary(entry: StockDailyAccountEntry) {
  return {
    accountId: entry.accountId,
    accountName: entry.accountName,
    accountType: entry.accountType,
    totalQty: entry.totalQty,
    totalAmount: entry.totalAmount,
    totalPaymentReceived: entry.totalPaymentReceived,
    dueBalance: entry.dueBalance
  };
}

export function calculateDailySummary(entries: StockDailyAccountEntry[]): StockDailySummary {
  return {
    accountCount: entries.length,
    totalQty: sum(entries.map((entry) => entry.totalQty)),
    totalAmount: sum(entries.map((entry) => entry.totalAmount)),
    totalPaymentReceived: sum(entries.map((entry) => entry.totalPaymentReceived)),
    totalDueBalance: sum(entries.map((entry) => entry.dueBalance))
  };
}

export function validateStockDraft(
  draft: StockDailyAccountDraft,
  products: StockProduct[],
  account?: StockAccountProfile
): StockValidationResult {
  const errors: string[] = [];
  if (!account) errors.push("Select a CCR/DO account before saving.");
  if (products.filter((product) => product.active).length === 0) errors.push("Add at least one active stock product in Stock Settings.");

  for (const [productId, quantity] of Object.entries(draft.productQuantities)) {
    if (quantity < 0) errors.push(`Quantity cannot be negative for product ${productId}.`);
  }
  if (draft.paymentReceived != null && draft.paymentReceived < 0) {
    errors.push("Payment received cannot be negative.");
  }

  return { valid: errors.length === 0, errors };
}

export function buildStockEntry(
  input: {
    id: string;
    date: string;
    monthId: string;
    dayNo: number;
    account: StockAccountProfile;
    draft: StockDailyAccountDraft;
    products: StockProduct[];
    previous?: StockDailyAccountEntry;
    carryForwardBalance: number;
    createdBy: string;
    timestamp?: number;
  }
): StockDailyAccountEntry {
  const timestamp = input.timestamp ?? Date.now();
  const activeProducts = productsSorted(input.products.filter((product) => product.active));
  const products: StockProductSnapshot[] = activeProducts.map((product) => {
    const quantity = roundMoney(input.draft.productQuantities[product.id] ?? 0);
    const rateSnapshot = roundMoney(product.rate);
    const amount = calculateProductAmount(quantity, rateSnapshot);
    return {
      productId: product.id,
      productName: product.name,
      rate: rateSnapshot,
      quantity,
      amount,
      paymentTrackingEnabled: false,
      paymentReceived: 0,
      dueBalance: 0,
      displayOrder: product.sortOrder ?? product.displayOrder
    };
  });

  const totals = calculateStockEntryTotals(products);

  const totalPaymentReceived = input.draft.paymentReceived != null
    ? roundMoney(input.draft.paymentReceived)
    : input.draft.productPayments
      ? sum(Object.values(input.draft.productPayments))
      : calculateEntryPaymentReceived(products, input.previous?.payments ?? []);

  const carryForwardBalance = roundMoney(input.carryForwardBalance);

  const dueBalance = roundMoney(carryForwardBalance + totals.totalAmount - totalPaymentReceived);

  return {
    id: input.id,
    date: input.date,
    monthId: input.monthId,
    dayNo: input.dayNo,
    accountId: input.account.id,
    accountName: input.account.name,
    accountType: input.account.type,
    products,
    payments: [],
    totalQty: totals.totalQty,
    totalAmount: totals.totalAmount,
    totalPaymentReceived,
    carryForwardBalance,
    dueBalance,
    status: input.previous?.status ?? "open",
    notes: input.draft.notes?.trim() || undefined,
    createdBy: input.previous?.createdBy ?? input.createdBy,
    updatedBy: input.previous ? input.createdBy : undefined,
    createdAt: input.previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    closedAt: input.previous?.closedAt,
    closedBy: input.previous?.closedBy
  };
}

export function calculateMonthlySummary(monthId: string, days: StockDayRecord[]): StockMonthlySummary {
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);
  const productMap = new Map<string, StockMonthlySummary["productTotals"][number]>();
  const accountMap = new Map<string, StockMonthlySummary["accountTotals"][number]>();

  for (const day of sortedDays) {
    for (const entry of day.entries) {
      const accountKey = entry.accountId;
      const account = accountMap.get(accountKey) ?? {
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountType: entry.accountType,
        totalQty: 0,
        totalAmount: 0,
        totalPaymentReceived: 0,
        dueBalance: 0,
        activeDays: 0
      };
      account.totalQty = roundMoney(account.totalQty + entry.totalQty);
      account.totalAmount = roundMoney(account.totalAmount + entry.totalAmount);
      account.totalPaymentReceived = roundMoney(account.totalPaymentReceived + entry.totalPaymentReceived);
      account.dueBalance = roundMoney(entry.dueBalance);
      account.activeDays += 1;
      accountMap.set(accountKey, account);

      for (const product of entry.products) {
        const productKey = product.productId || normalizeKey(product.productName);
        const current = productMap.get(productKey) ?? {
          productId: product.productId,
          productName: product.productName,
          quantity: 0,
          amount: 0
        };
        current.quantity = roundMoney(current.quantity + product.quantity);
        current.amount = roundMoney(current.amount + product.amount);
        productMap.set(productKey, current);
      }
    }
  }

  const totalRecoveryPayments = sum(sortedDays.map((day) => day.summary.totalPaymentReceived));
  const paymentTotals = [
    {
      productId: "account-recovery",
      productName: "Account Recovery Payments",
      amount: totalRecoveryPayments
    }
  ];

  const enteredDays = new Set(sortedDays.map((day) => day.dayNo));

  return {
    monthId,
    totalQty: sum(sortedDays.map((day) => day.summary.totalQty)),
    totalAmount: sum(sortedDays.map((day) => day.summary.totalAmount)),
    totalPaymentReceived: totalRecoveryPayments,
    totalDueBalance: sum([...accountMap.values()].map((account) => account.dueBalance)),
    productTotals: [...productMap.values()].sort((a, b) => a.productName.localeCompare(b.productName)),
    accountTotals: [...accountMap.values()].sort((a, b) => b.dueBalance - a.dueBalance),
    paymentTotals,
    dayRows: sortedDays.map((day) => ({
      dayNo: day.dayNo,
      date: day.date,
      accountCount: day.summary.accountCount,
      totalQty: day.summary.totalQty,
      totalAmount: day.summary.totalAmount,
      totalPaymentReceived: day.summary.totalPaymentReceived,
      totalDueBalance: day.summary.totalDueBalance,
      status: day.status
    })),
    missingDays: Array.from({ length: daysInMonth(monthId) }, (_, index) => index + 1).filter((dayNo) => !enteredDays.has(dayNo)),
    updatedAt: Date.now()
  };
}

function buildStockCarryForwardSeed(
  days: StockDayRecord[],
  accounts: StockAccountProfile[],
  previousSummary?: StockMonthlySummary | null
) {
  const seed = new Map<string, number>();
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);
  const previousDueByAccount = new Map(
    (previousSummary?.accountTotals ?? []).map((account) => [account.accountId, roundMoney(account.dueBalance)])
  );
  for (const account of accounts) {
    const previousDue = previousDueByAccount.get(account.id);
    if (previousDue !== undefined) {
      seed.set(account.id, previousDue);
      continue;
    }
    const firstEntry = sortedDays.flatMap((day) => day.entries.filter((entry) => entry.accountId === account.id)).at(0);
    if (firstEntry) {
      seed.set(account.id, roundMoney(firstEntry.carryForwardBalance));
      continue;
    }
    seed.set(account.id, roundMoney(account.openingBalance ?? 0));
  }
  for (const account of previousSummary?.accountTotals ?? []) {
    if (!seed.has(account.accountId)) {
      seed.set(account.accountId, roundMoney(account.dueBalance));
    }
  }
  return seed;
}

export function recalculateStockMonthEntries(
  days: StockDayRecord[],
  accounts: StockAccountProfile[],
  previousSummary?: StockMonthlySummary | null
) {
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);
  const seedByAccount = buildStockCarryForwardSeed(sortedDays, accounts, previousSummary);
  const runningByAccount = new Map(seedByAccount);

  return sortedDays.map((day) => {
    const nextEntries = [...day.entries]
      .sort((a, b) => a.accountName.localeCompare(b.accountName))
      .map((entry) => {
        const carryForwardBalance = roundMoney(runningByAccount.get(entry.accountId) ?? seedByAccount.get(entry.accountId) ?? 0);
        const dueBalance = roundMoney(carryForwardBalance + entry.totalAmount - entry.totalPaymentReceived);
        const nextEntry = {
          ...entry,
          carryForwardBalance,
          dueBalance
        };
        runningByAccount.set(entry.accountId, dueBalance);
        return nextEntry;
      });

    return {
      ...day,
      entries: nextEntries,
      stockOut: nextEntries,
      summary: calculateDailySummary(nextEntries)
    };
  });
}

export function productsSorted(products: StockProduct[]) {
  return [...products].sort((a, b) => (a.sortOrder ?? a.displayOrder) - (b.sortOrder ?? b.displayOrder) || a.name.localeCompare(b.name));
}

export function accountsSorted(accounts: StockAccountProfile[]) {
  return [...accounts].sort((a, b) => (a.sortOrder ?? a.displayOrder) - (b.sortOrder ?? b.displayOrder) || a.name.localeCompare(b.name));
}

export function findPreviousEntry(
  days: StockDayRecord[],
  selectedDay: number,
  accountId: string
) {
  for (let dayNo = selectedDay - 1; dayNo >= 1; dayNo -= 1) {
    const day = days.find((item) => item.dayNo === dayNo);
    const entry = day?.entries.find((item) => item.accountId === accountId);
    if (entry) return entry;
  }
  return undefined;
}

export function buildStockDayRecord(input: {
  month: StockMonth;
  dayNo: number;
  date: string;
  entries: StockDailyAccountEntry[];
  stockIn?: StockInRecord[];
  previous?: StockDayRecord;
  createdBy: string;
  timestamp?: number;
}): StockDayRecord {
  const timestamp = input.timestamp ?? Date.now();
  const [yearText, monthText] = input.month.id.split("-");
  return {
    id: String(input.dayNo),
    monthId: input.month.id,
    dayNo: input.dayNo,
    entryYear: Number(yearText) || undefined,
    entryMonth: Number(monthText) || undefined,
    entryDay: input.dayNo,
    date: input.date,
    status: input.previous?.status ?? "open",
    manualOverride: input.previous?.manualOverride ?? false,
    entries: [...input.entries].sort((a, b) => a.accountName.localeCompare(b.accountName)),
    stockOut: [...input.entries].sort((a, b) => a.accountName.localeCompare(b.accountName)),
    stockIn: input.stockIn ?? input.previous?.stockIn ?? [],
    summary: calculateDailySummary(input.entries),
    notes: input.previous?.notes,
    createdBy: input.previous?.createdBy ?? input.createdBy,
    updatedBy: input.previous ? input.createdBy : undefined,
    createdAt: input.previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    closedAt: input.previous?.closedAt,
    closedBy: input.previous?.closedBy,
    lockedAt: input.previous?.lockedAt,
    lockedBy: input.previous?.lockedBy,
    lockedByRole: input.previous?.lockedByRole,
    reopenedAt: input.previous?.reopenedAt,
    reopenedBy: input.previous?.reopenedBy,
    reopenedByRole: input.previous?.reopenedByRole,
    reopenedUntilAt: input.previous?.reopenedUntilAt
  };
}

export function validateStockInDraft(
  date: string,
  mode: "cash" | "credit",
  quantities: Record<string, number>,
  paidAmount: number,
  products: StockProduct[]
): StockValidationResult {
  const errors: string[] = [];
  if (!date) errors.push("Date is required.");
  if (!mode) errors.push("Stock In mode (Cash or Credit) is required.");
  if (paidAmount < 0) errors.push("Paid amount cannot be negative.");

  const activeProducts = products.filter((product) => product.active);
  if (activeProducts.length === 0) {
    errors.push("No active stock products configured in Settings.");
  }

  let hasQty = false;
  for (const [productId, qty] of Object.entries(quantities)) {
    if (qty < 0) {
      errors.push(`Quantity cannot be negative for product ${productId}.`);
    }
    if (qty > 0) hasQty = true;
  }
  if (!hasQty) {
    errors.push("Enter at least one product quantity.");
  }

  return { valid: errors.length === 0, errors };
}

export function calculateJazzPayableLedger(
  openingPayable: number,
  stockInRecords: StockInRecord[]
) {
  const sorted = [...stockInRecords].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  let running = openingPayable;
  return sorted.map((record) => {
    const prev = running;
    running = roundMoney(running + record.totalAmount - record.paidAmount);
    return {
      ...record,
      prevPayable: prev,
      changePayable: roundMoney(record.totalAmount - record.paidAmount),
      runningPayable: running
    };
  });
}

export function calculateJazzCompanyBalance(
  openingPayable: number,
  stockInRecords: StockInRecord[],
  updatedAt = Date.now()
): StockJazzCompanyBalance {
  const totalStockInAmount = sum(stockInRecords.map((record) => record.totalAmount));
  const totalPaidAmount = sum(stockInRecords.map((record) => record.paidAmount));
  return {
    openingPayable: roundMoney(openingPayable),
    totalStockInAmount,
    totalPaidAmount,
    currentPayable: roundMoney(openingPayable + totalStockInAmount - totalPaidAmount),
    updatedAt
  };
}

export function calculateCurrentStock(
  products: StockProduct[],
  openingStock: Record<string, number | null | undefined>,
  stockInRecords: StockInRecord[],
  allDays: StockDayRecord[]
): StockProductBalance[] {
  const stockInMap = new Map<string, number>();
  const stockOutMap = new Map<string, number>();

  // Aggregate stock-in
  for (const record of stockInRecords) {
    for (const productLine of record.products) {
      const current = stockInMap.get(productLine.productId) ?? 0;
      stockInMap.set(productLine.productId, roundMoney(current + productLine.quantity));
    }
  }

  // Aggregate stock-out
  for (const day of allDays) {
    for (const entry of day.entries) {
      for (const productSnapshot of entry.products) {
        const current = stockOutMap.get(productSnapshot.productId) ?? 0;
        stockOutMap.set(productSnapshot.productId, roundMoney(current + productSnapshot.quantity));
      }
    }
  }

  return products.map((product) => {
    const rawOpening = openingStock[product.id];
    const isSkipped = rawOpening === null;
    const opening = isSkipped ? null : (rawOpening ?? 0);
    const inFromJazz = stockInMap.get(product.id) ?? 0;
    const outToAccounts = stockOutMap.get(product.id) ?? 0;
    const current = isSkipped ? null : roundMoney((opening ?? 0) + inFromJazz - outToAccounts);
    return {
      productId: product.id,
      productName: product.name,
      openingStock: opening,
      totalStockIn: inFromJazz,
      totalStockOut: outToAccounts,
      currentStock: current,
      updatedAt: Date.now()
    };
  });
}
