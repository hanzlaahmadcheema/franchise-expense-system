/**
 * Phase 8B: Stock Transaction Synchronization Service
 *
 * Synchronizes stock orders and account payments with PostgreSQL REST APIs:
 * - Stock Orders (`/api/v1/transactions/stock/orders`)
 * - Stock Account Payments (`/api/v1/transactions/stock/account-payments`)
 *
 * Fetches updated server-authoritative projections upon completion.
 * NEVER writes to Firestore.
 */

import type {
  StockDailyAccountDraft,
  StockProduct,
  StockAccountProfile,
  StockDayRecord,
  StockDailyAccountEntry,
  StockProductSnapshot,
  StockInRecord,
  StockProductLine,
  StockAccountType,
  StockDayStatus
} from "../../modules/stock/types/stock.types";
import {
  calculateDailySummary,
  calculateProductAmount,
  calculateStockEntryTotals
} from "../../modules/stock/services/stockCalculations";
import { dayDate, roundMoney } from "../../modules/stock/utils/stockFormatters";
import { ledgerApiClient, type DayProjectionsResponse } from "./ledgerApiClient";
import { getAccountingPeriodWithDays, resolveAccountingDayId } from "./periodDayService";

export interface SaveStockDayResult {
  success: boolean;
  dayId: string;
  projections: DayProjectionsResponse["projections"] | null;
  message: string;
}

export async function saveStockDayPostgres(
  periodKey: string,
  dayNo: number,
  draft: StockDailyAccountDraft,
  products: StockProduct[]
): Promise<SaveStockDayResult> {
  const dayId = await resolveAccountingDayId(periodKey, dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${dayNo} not found for period ${periodKey}.`);
  }

  // 1. Build stock order lines for non-zero quantities
  const orderLines = Object.entries(draft.productQuantities)
    .filter(([_, qty]) => Number(qty) > 0)
    .map(([productId, qty]) => {
      const product = products.find((p) => p.id === productId);
      return {
        product_id: productId,
        quantity: Math.round(Number(qty)),
        unit_rate: product?.rate ?? 0
      };
    });

  // Fetch existing stock orders for this day and account
  const existingOrdersRes = await ledgerApiClient.stockOrders.list(dayId);
  const existingOrders = existingOrdersRes.data || [];
  const existingOrderForAccount = existingOrders.find((o: any) => o.account_id === draft.accountId);

  if (orderLines.length > 0) {
    if (existingOrderForAccount) {
      await ledgerApiClient.stockOrders.update(existingOrderForAccount.id, {
        baseRevision: existingOrderForAccount.revision ?? 1,
        direction: "outbound",
        account_id: draft.accountId,
        notes: draft.notes || null,
        lines: orderLines
      });
    } else {
      await ledgerApiClient.stockOrders.create({
        day_id: dayId,
        direction: "outbound",
        account_id: draft.accountId,
        notes: draft.notes || null,
        lines: orderLines
      });
    }
  } else if (existingOrderForAccount) {
    await ledgerApiClient.stockOrders.delete(existingOrderForAccount.id);
  }

  // 2. Sync payment if paymentReceived > 0
  const paymentAmount = Number(draft.paymentReceived ?? 0);
  const existingPaymentsRes = await ledgerApiClient.stockPayments.list(dayId);
  const existingPayments = existingPaymentsRes.data || [];
  const existingPaymentForAccount = existingPayments.find((p: any) => p.account_id === draft.accountId);

  if (paymentAmount > 0) {
    if (existingPaymentForAccount) {
      if (Number(existingPaymentForAccount.amount) !== paymentAmount) {
        await ledgerApiClient.stockPayments.update(existingPaymentForAccount.id, {
          baseRevision: existingPaymentForAccount.revision ?? 1,
          account_id: draft.accountId,
          amount: paymentAmount
        });
      }
    } else {
      await ledgerApiClient.stockPayments.create({
        day_id: dayId,
        account_id: draft.accountId,
        amount: paymentAmount,
        payment_method: "cash"
      });
    }
  } else if (existingPaymentForAccount) {
    await ledgerApiClient.stockPayments.delete(existingPaymentForAccount.id);
  }

  // 3. Fetch latest day projections
  let projections: DayProjectionsResponse["projections"] | null = null;
  try {
    const projResponse = await ledgerApiClient.calculations.getDayProjections(dayId);
    projections = (projResponse as any)?.data?.projections ?? projResponse?.projections ?? null;
  } catch (err) {
    console.warn(`[stockTransactionService] Could not fetch projections for ${dayId}:`, err);
  }

  return {
    success: true,
    dayId,
    projections,
    message: `Stock transactions for day ${dayNo} saved to PostgreSQL successfully.`
  };
}

export interface SaveStockInInput {
  dayNo: number;
  products: { productId: string; quantity: number; unitRate: number }[];
  paidAmount: number;
  notes?: string | null;
}

export async function saveStockInPostgres(
  periodKey: string,
  input: SaveStockInInput
): Promise<{
  success: boolean;
  dayId: string;
  orderId?: string;
  paymentId?: string;
  projections: DayProjectionsResponse["projections"] | null;
  message: string;
}> {
  const dayId = await resolveAccountingDayId(periodKey, input.dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${input.dayNo} not found for period ${periodKey}.`);
  }

  let orderId: string | undefined;
  const orderLines = input.products
    .filter((p) => p.quantity > 0)
    .map((p) => ({
      product_id: p.productId,
      quantity: Math.round(p.quantity),
      unit_rate: p.unitRate
    }));

  if (orderLines.length > 0) {
    const orderRes = await ledgerApiClient.stockOrders.create({
      day_id: dayId,
      direction: "inbound",
      supplier_name: "Jazz Company",
      notes: input.notes || null,
      lines: orderLines
    });
    orderId = orderRes.data?.id;
  }

  let paymentId: string | undefined;
  if (input.paidAmount > 0) {
    const mutationId = crypto.randomUUID();
    const payRes = await ledgerApiClient.jazzCompanyPayments.create(
      {
        client_mutation_id: mutationId,
        day_id: dayId,
        amount: input.paidAmount,
        payment_reference: input.notes || null,
        notes: input.notes ? `Stock In payment: ${input.notes}` : "Stock In payment to Jazz Company"
      },
      mutationId
    );
    paymentId = payRes.data?.id;
  }

  let projections: DayProjectionsResponse["projections"] | null = null;
  try {
    const projResponse = await ledgerApiClient.calculations.getDayProjections(dayId);
    projections = (projResponse as any)?.data?.projections ?? projResponse?.projections ?? null;
  } catch (err) {
    console.warn(`[stockTransactionService] Could not fetch projections for ${dayId}:`, err);
  }

  return {
    success: true,
    dayId,
    orderId,
    paymentId,
    projections,
    message: `Stock In and Jazz Company payment for day ${input.dayNo} saved to PostgreSQL successfully.`
  };
}

export async function deleteStockInPostgres(
  periodKey: string,
  dayNo: number,
  orderId: string,
  paidAmount?: number,
  notes?: string
): Promise<{ success: boolean; message: string }> {
  const dayId = await resolveAccountingDayId(periodKey, dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${dayNo} not found for period ${periodKey}.`);
  }

  // 1. Delete the stock order from PostgreSQL
  await ledgerApiClient.stockOrders.delete(orderId);

  // 2. If a payment was recorded for this Stock In, clean it up as well
  if (paidAmount && paidAmount > 0) {
    try {
      const jazzPaymentsRes = await ledgerApiClient.jazzCompanyPayments.list(dayId);
      const payments = jazzPaymentsRes.data || [];
      const matchingPayment = payments.find(
        (p: any) =>
          (p.payment_reference && notes && p.payment_reference === notes) ||
          (p.notes && p.notes.includes("Stock In payment") && Number(p.amount) === paidAmount) ||
          (payments.length === 1 && Number(p.amount) === paidAmount)
      );
      if (matchingPayment) {
        await ledgerApiClient.jazzCompanyPayments.delete(matchingPayment.id);
      }
    } catch (err) {
      console.warn("[stockTransactionService] Could not clean up associated jazz company payment:", err);
    }
  }

  return {
    success: true,
    message: `Stock In record deleted successfully from PostgreSQL.`
  };
}

export async function loadStockDayPostgres(
  periodKey: string,
  dayNo: number,
  products: StockProduct[] = [],
  accounts: StockAccountProfile[] = [],
  cachedPeriodData?: PeriodCacheEntry | null
): Promise<StockDayRecord | null> {
  const periodData = cachedPeriodData ?? (await getAccountingPeriodWithDays(periodKey).catch(() => null));
  const dayRec = periodData?.days?.get(dayNo);
  const dayId = dayRec?.id ?? (await resolveAccountingDayId(periodKey, dayNo));
  if (!dayId) return null;

  const [ordersRes, paymentsRes, jazzPaymentsRes, projRes] = await Promise.all([
    ledgerApiClient.stockOrders.list(dayId).catch(() => ({ data: [] })),
    ledgerApiClient.stockPayments.list(dayId).catch(() => ({ data: [] })),
    ledgerApiClient.jazzCompanyPayments.list(dayId).catch(() => ({ data: [] })),
    ledgerApiClient.calculations.getDayProjections(dayId).catch(() => ({ projections: null }))
  ]);

  const status = (dayRec?.status ?? "closed") as StockDayStatus;
  const isClosed = status === "closed";
  const closedTimestamp = isClosed && dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : undefined;
  const reopenedTimestamp = dayRec?.reopened_at ? new Date(dayRec.reopened_at).getTime() : undefined;

  const orders = ordersRes.data || [];
  const outboundOrders = orders.filter((o: any) => o.direction === "outbound");
  const inboundOrders = orders.filter((o: any) => o.direction === "inbound");
  const accountPayments = paymentsRes.data || [];
  const jazzPayments = jazzPaymentsRes.data || [];

  // Reconstruct stockIn records from inbound orders
  const stockIn: StockInRecord[] = inboundOrders.map((order: any) => {
    const productLines: StockProductLine[] = (order.lines || []).map((line: any) => {
      const prod = products.find((p) => p.id === line.product_id);
      const rate = Number(line.unit_rate ?? prod?.rate ?? 0);
      const quantity = Number(line.quantity ?? 0);
      return {
        productId: line.product_id,
        productName: prod?.name || line.product_name || "Unknown Product",
        rate,
        quantity,
        amount: roundMoney(quantity * rate)
      };
    });

    const totalQty = roundMoney(productLines.reduce((sum, p) => sum + p.quantity, 0));
    const totalAmount = roundMoney(productLines.reduce((sum, p) => sum + p.amount, 0));
    const paidAmount = roundMoney(
      jazzPayments.reduce((sum: number, p: any) => sum + Number(p.amount ?? 0), 0)
    );
    const jazzPayableAmount = roundMoney(totalAmount - paidAmount);
    const stockInMode = paidAmount >= totalAmount ? "cash" : "credit";

    return {
      id: order.id,
      date: dayDate(periodKey, dayNo),
      monthId: periodKey,
      sourceName: "Jazz Company" as const,
      stockInMode,
      products: productLines,
      totalQty,
      totalAmount,
      paidAmount,
      jazzPayableAmount,
      notes: order.notes || undefined,
      createdBy: order.created_by_user_id || "system",
      createdAt: order.created_at ? new Date(order.created_at).getTime() : Date.now(),
      updatedAt: order.updated_at ? new Date(order.updated_at).getTime() : Date.now()
    };
  });

  const dayProjections = (projRes as any)?.data?.projections ?? (projRes as any)?.projections ?? null;

  // Reconstruct outbound entries per account
  const accountIds = new Set<string>();
  outboundOrders.forEach((o: any) => {
    if (o.account_id) accountIds.add(o.account_id);
  });
  accountPayments.forEach((p: any) => {
    if (p.account_id) accountIds.add(p.account_id);
  });
  // Include accounts from dayProjections.stockAccounts and catalog accounts so a day with
  // zero transactions still receives its authoritative opening projections
  (dayProjections?.stockAccounts || []).forEach((p: any) => {
    if (p.account_id) accountIds.add(p.account_id);
  });
  accounts.forEach((a) => {
    if (a.active !== false) accountIds.add(a.id);
  });

  const entries: StockDailyAccountEntry[] = Array.from(accountIds).map((accountId) => {
    const account = accounts.find((a) => a.id === accountId);
    const order = outboundOrders.find((o: any) => o.account_id === accountId);
    const payment = accountPayments.find((p: any) => p.account_id === accountId);
    const totalPaymentReceived = roundMoney(Number(payment?.amount ?? 0));

    const orderLinesMap = new Map<string, { quantity: number; rate: number }>();
    if (order && order.lines) {
      for (const line of order.lines) {
        orderLinesMap.set(line.product_id, {
          quantity: Number(line.quantity ?? 0),
          rate: Number(line.unit_rate ?? 0)
        });
      }
    }

    const productSnapshots: StockProductSnapshot[] = products.map((product) => {
      const line = orderLinesMap.get(product.id);
      const quantity = line ? roundMoney(line.quantity) : 0;
      const rate = line ? roundMoney(line.rate) : roundMoney(product.rate);
      const amount = calculateProductAmount(quantity, rate);
      return {
        productId: product.id,
        productName: product.name,
        rate,
        quantity,
        amount,
        paymentTrackingEnabled: false,
        paymentReceived: 0,
        dueBalance: 0,
        displayOrder: product.sortOrder ?? product.displayOrder
      };
    });

    const totals = calculateStockEntryTotals(productSnapshots);
    const proj = dayProjections?.stockAccounts?.find((p: any) => p.account_id === accountId);
    const carryForwardBalance = roundMoney(
      proj ? Number(proj.opening_due ?? 0) : Number(account?.openingBalance ?? 0)
    );
    const dueBalance = roundMoney(
      proj?.closing_due !== undefined
        ? Number(proj.closing_due)
        : carryForwardBalance + totals.totalAmount - totalPaymentReceived
    );

    const orderUpdated = order?.updated_at ? new Date(order.updated_at).getTime() : 0;
    const paymentUpdated = payment?.updated_at ? new Date(payment.updated_at).getTime() : 0;
    const orderCreated = order?.created_at ? new Date(order.created_at).getTime() : Date.now();
    const paymentCreated = payment?.created_at ? new Date(payment.created_at).getTime() : Date.now();

    return {
      id: order?.id || payment?.id || `${dayId}-${accountId}`,
      date: dayDate(periodKey, dayNo),
      monthId: periodKey,
      dayNo,
      accountId,
      accountName: account?.name || "Unknown Account",
      accountType: (account?.type || "DO") as StockAccountType,
      products: productSnapshots,
      payments: [],
      totalQty: totals.totalQty,
      totalAmount: totals.totalAmount,
      totalPaymentReceived,
      carryForwardBalance,
      dueBalance,
      status: (dayRec?.status ?? "open") as StockDayStatus,
      notes: order?.notes || payment?.notes || undefined,
      createdBy: order?.created_by_user_id || payment?.created_by_user_id || "system",
      updatedBy: order?.updated_by_user_id || payment?.updated_by_user_id || undefined,
      createdAt: Math.min(orderCreated, paymentCreated),
      updatedAt: Math.max(orderUpdated, paymentUpdated, Date.now()),
      closedAt: closedTimestamp,
      closedBy: undefined
    };
  });

  const summary = calculateDailySummary(entries);

  let latestUpdated = closedTimestamp ?? Date.now();

  const txTimestamps = [
    ...(ordersRes.data || []),
    ...(paymentsRes.data || []),
    ...(jazzPaymentsRes.data || [])
  ]
    .map((t: any) => (t.updated_at ? new Date(t.updated_at).getTime() : 0))
    .filter((ts) => ts > 0);

  if (txTimestamps.length > 0) {
    latestUpdated = Math.max(latestUpdated, ...txTimestamps);
  }

  return {
    id: String(dayNo),
    date: dayDate(periodKey, dayNo),
    monthId: periodKey,
    dayNo,
    status,
    manualOverride: isClosed,
    entries,
    stockOut: entries,
    stockIn,
    summary,
    stockProductProjections: dayProjections?.stockProducts || [],
    stockAccountProjections: dayProjections?.stockAccounts || [],
    notes: dayRec?.notes || undefined,
    createdBy: "system",
    createdAt: closedTimestamp ?? Date.now(),
    updatedAt: latestUpdated,
    closedAt: closedTimestamp,
    lockedAt: isClosed ? (closedTimestamp ?? Date.now()) : undefined,
    reopenedAt: reopenedTimestamp
  };
}

export async function loadStockMonthPostgres(
  periodKey: string,
  products: StockProduct[] = [],
  accounts: StockAccountProfile[] = []
): Promise<StockDayRecord[]> {
  const periodData = await getAccountingPeriodWithDays(periodKey).catch(() => null);
  if (!periodData) return [];
  const dayCount = periodData.days.size || 31;
  const dayPromises: Promise<StockDayRecord | null>[] = [];
  for (let d = 1; d <= dayCount; d++) {
    dayPromises.push(
      loadStockDayPostgres(periodKey, d, products, accounts, periodData).catch((err) => {
        console.warn(`[stockTransactionService] Failed to load day ${d} for month ${periodKey}:`, err);
        return null;
      })
    );
  }
  const loadedDays = await Promise.all(dayPromises);
  return loadedDays.filter((d): d is StockDayRecord => Boolean(d)).sort((a, b) => a.dayNo - b.dayNo);
}
