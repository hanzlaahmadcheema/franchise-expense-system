import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  writeBatch,
  type FirestoreError,
  type SnapshotMetadata
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { auth, db } from "../../../lib/firebase";
import { buildAuditLogDocument, writeAuditLog } from "../../../lib/auditLogService";
import { LEDGER_CALC_VERSION } from "../../../shared/ledger/ledgerTypes";
import type { UserRole } from "../../../types/ledger";
import {
  calculateCurrentStock,
  calculateJazzCompanyBalance,
  calculateMonthlySummary,
  recalculateStockMonthEntries
} from "./stockCalculations";
import { normalizeKey, previousMonthId } from "../utils/stockFormatters";
import type {
  StockAccountProfile,
  StockAuditEvent,
  StockDayRecord,
  StockJazzCompanyBalance,
  StockMonth,
  StockMonthlySummary,
  StockProduct,
  StockProductBalance,
  StockOpeningBalances,
  StockInRecord
} from "../types/stock.types";

export type FirestoreSnapshotMeta = Pick<SnapshotMetadata, "fromCache" | "hasPendingWrites">;

const INITIAL_OPENING_STOCK_BY_PRODUCT_NAME: Record<string, number> = {
  "retailer sim": 1129,
  "franchise sim": 7,
  "load sim": 3,
  "data sim": 0,
  "e sim": 15,
  dongle: 0,
  "gold number": 85,
  "retailer imzi": 1610,
  "ccr imzi": 297
};

function now() {
  return Date.now();
}

function requireDb() {
  if (!db) throw new Error("Firebase is not configured.");
  return db;
}

function cleanForFirestore<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cleanForFirestore(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanForFirestore(entryValue)])
    ) as T;
  }
  return value;
}

function activeUser(user?: User | null) {
  const current = user ?? auth?.currentUser;
  if (!current) throw new Error("Sign in is required.");
  return current;
}

function actor(user?: User | null, role?: UserRole | null) {
  const current = activeUser(user);
  return {
    userId: current.uid,
    userEmail: current.email ?? null,
    userRole: role ?? null
  };
}

function productCollection() {
  return collection(requireDb(), "stockSettings", "products", "items");
}

function accountCollection() {
  return collection(requireDb(), "stockSettings", "accounts", "items");
}


function settingsAuditCollection() {
  return collection(requireDb(), "stockSettings", "audit", "items");
}

function monthRef(monthId: string) {
  return doc(requireDb(), "stockMonths", monthId);
}

function dayRef(monthId: string, dayNo: number) {
  return doc(monthRef(monthId), "days", String(dayNo));
}

function ledgerV2StockRawEntries(monthId: string, dayNo: number) {
  return collection(requireDb(), "ledgerV2", "stock", "months", monthId, "days", String(dayNo), "rawEntries");
}

async function syncStockLedgerV2RawEntriesInBatch(
  batch: ReturnType<typeof writeBatch>,
  day: StockDayRecord,
  actorUid: string,
  timestamp: number
) {
  const rawCollection = ledgerV2StockRawEntries(day.monthId, day.dayNo);
  const existingSnap = await getDocs(rawCollection);
  const rawEntries = [
    ...day.entries.map((entry) => ({
      id: `stock-out-${entry.id}`,
      type: "stockOut",
      raw: {
        accountId: entry.accountId,
        accountName: entry.accountName,
        accountType: entry.accountType,
        products: entry.products.map((product) => ({
          productId: product.productId,
          productName: product.productName,
          rate: product.rate,
          quantity: product.quantity,
          paymentReceived: product.paymentReceived
        })),
        totalPaymentReceived: entry.totalPaymentReceived,
        notes: entry.notes,
        source: "user"
      }
    })),
    ...(day.stockIn ?? []).map((record) => ({
      id: `stock-in-${record.id}`,
      type: "stockIn",
      raw: {
        sourceName: record.sourceName,
        stockInMode: record.stockInMode,
        products: record.products.map((product) => ({
          productId: product.productId,
          productName: product.productName,
          rate: product.rate,
          quantity: product.quantity
        })),
        paidAmount: record.paidAmount,
        notes: record.notes,
        source: "user"
      }
    }))
  ];
  const nextIds = new Set(rawEntries.map((entry) => entry.id));
  for (const entryDoc of existingSnap.docs) {
    if (!nextIds.has(entryDoc.id)) batch.delete(entryDoc.ref);
  }
  for (const entry of rawEntries) {
    batch.set(doc(rawCollection, entry.id), cleanForFirestore({
      id: entry.id,
      module: "stock" as const,
      type: entry.type,
      monthId: day.monthId,
      dayNo: day.dayNo,
      raw: entry.raw,
      calculated: null,
      meta: {
        updatedAt: timestamp,
        updatedBy: actorUid,
        status: typeof navigator !== "undefined" && navigator.onLine ? "pending" : "preview",
        calculationVersion: LEDGER_CALC_VERSION
      }
    }), { merge: true });
  }
}

function stockDayDateFields(monthId: string, dayNo: number) {
  const [yearText, monthText] = monthId.split("-");
  return {
    entryYear: Number(yearText) || undefined,
    entryMonth: Number(monthText) || undefined,
    entryDay: dayNo
  };
}

function openingRef() {
  return doc(requireDb(), "stockSettings", "opening", "items", "main");
}

function productBalanceRef(productId: string) {
  return doc(requireDb(), "stockBalances", "products", "items", productId);
}

function accountBalanceRef(accountId: string) {
  return doc(requireDb(), "stockBalances", "accounts", "items", accountId);
}

function jazzCompanyBalanceRef() {
  return doc(requireDb(), "stockBalances", "jazzCompany", "items", "main");
}

function monthlySummaryRef(monthId: string) {
  return doc(monthRef(monthId), "summary", "monthly");
}

function auditRef(monthId: string, id = `${now()}-${Math.random().toString(36).slice(2, 8)}`) {
  return doc(monthRef(monthId), "audit", id);
}

function unifiedAuditRef(id: string) {
  return doc(requireDb(), "auditLogs", id);
}

function stageUnifiedAudit(
  batch: ReturnType<typeof writeBatch>,
  input: Parameters<typeof buildAuditLogDocument>[0],
  actorRole: UserRole
) {
  const log = buildAuditLogDocument(input, actorRole);
  batch.set(unifiedAuditRef(log.id), log);
}

function mapDayData(data: Partial<StockDayRecord>, id: string): StockDayRecord {
  const entries = Array.isArray(data.stockOut)
    ? data.stockOut
    : Array.isArray(data.entries)
      ? data.entries
      : [];
  return {
    id,
    monthId: data.monthId ?? "",
    dayNo: Number(data.dayNo ?? id),
    date: data.date ?? "",
    entryYear: data.entryYear,
    entryMonth: data.entryMonth,
    entryDay: data.entryDay,
    status: data.status ?? "open",
    entries,
    stockOut: entries,
    stockIn: Array.isArray(data.stockIn) ? data.stockIn : [],
    summary: data.summary ?? {
      accountCount: entries.length,
      totalQty: entries.reduce((total, entry) => total + (entry.totalQty ?? 0), 0),
      totalAmount: entries.reduce((total, entry) => total + (entry.totalAmount ?? 0), 0),
      totalPaymentReceived: entries.reduce((total, entry) => total + (entry.totalPaymentReceived ?? 0), 0),
      totalDueBalance: entries.reduce((total, entry) => total + (entry.dueBalance ?? 0), 0)
    },
    notes: data.notes,
    createdBy: data.createdBy ?? "",
    updatedBy: data.updatedBy,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
    closedAt: data.closedAt,
    closedBy: data.closedBy,
    lockedAt: data.lockedAt,
    lockedBy: data.lockedBy,
    lockedByRole: data.lockedByRole,
    reopenedAt: data.reopenedAt,
    reopenedBy: data.reopenedBy,
    reopenedByRole: data.reopenedByRole,
    reopenedUntilAt: data.reopenedUntilAt
  };
}

export function roleCanStock(
  role: UserRole | null,
  permission: "read" | "daily" | "settings" | "backup" | "monthControls"
) {
  if (!role) return false;
  if (permission === "read") return true;
  if (role === "owner") return true;
  if (role === "admin") return permission === "daily";
  return false;
}

export async function ensureStockOpeningSeed(
  products: StockProduct[],
  user: User | null,
  role: UserRole | null
) {
  if (!roleCanStock(role, "settings")) return false;
  const existing = await getDoc(openingRef());
  if (existing.exists()) return false;

  const productByName = new Map(products.map((product) => [normalizeKey(product.name), product]));
  const openingStock: Record<string, number> = {};
  const missingProducts: string[] = [];

  for (const [productName, quantity] of Object.entries(INITIAL_OPENING_STOCK_BY_PRODUCT_NAME)) {
    const product = productByName.get(productName);
    if (!product) {
      missingProducts.push(productName);
      continue;
    }
    openingStock[product.id] = quantity;
  }

  if (missingProducts.length > 0) {
    throw new Error(`Missing Stock Settings products for opening stock seed: ${missingProducts.join(", ")}`);
  }

  const currentActor = actor(user, role);
  const batch = writeBatch(requireDb());
  const balances: StockOpeningBalances = {
    openingStock,
    jazzOpeningPayable: 0
  };
  batch.set(openingRef(), cleanForFirestore({
    ...balances,
    seededAt: now(),
    seedSource: "stock-ledger-initial-opening-stock"
  }), { merge: true });
  await writeSettingsAudit(batch, currentActor, role, "seed-opening-balances", "opening", "main", balances);
  await batch.commit();
  return true;
}

export function subscribeStockProducts(
  onNext: (products: StockProduct[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(productCollection(), orderBy("displayOrder", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((item) => item.data() as StockProduct), snap.metadata),
    onError
  );
}

export function subscribeStockAccounts(
  onNext: (accounts: StockAccountProfile[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(accountCollection(), orderBy("displayOrder", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((item) => item.data() as StockAccountProfile), snap.metadata),
    onError
  );
}


export function subscribeStockOpeningBalances(
  onNext: (balances: StockOpeningBalances | null, metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    openingRef(),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.exists() ? (snap.data() as StockOpeningBalances) : null, snap.metadata),
    onError
  );
}

export async function saveStockOpeningBalances(
  balances: StockOpeningBalances,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const batch = writeBatch(requireDb());
  batch.set(openingRef(), cleanForFirestore(balances), { merge: true });
  await writeSettingsAudit(batch, currentActor, role, "update-opening-balances", "opening", "main", balances);
  await batch.commit();
}

export function subscribeStockMonths(
  onNext: (months: StockMonth[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(requireDb(), "stockMonths"), orderBy("id", "desc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((item) => item.data() as StockMonth), snap.metadata),
    onError
  );
}

export function subscribeStockDays(
  monthId: string,
  onNext: (days: StockDayRecord[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(monthRef(monthId), "days"), orderBy("dayNo", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((item) => mapDayData(item.data() as Partial<StockDayRecord>, item.id)), snap.metadata),
    onError
  );
}

export function subscribeStockMonthlySummary(
  monthId: string,
  onNext: (summary: StockMonthlySummary | null, metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    doc(monthRef(monthId), "summary", "monthly"),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.exists() ? (snap.data() as StockMonthlySummary) : null, snap.metadata),
    onError
  );
}

export async function loadStockDays(monthId: string) {
  const snap = await getDocs(query(collection(monthRef(monthId), "days"), orderBy("dayNo", "asc")));
  return snap.docs.map((item) => mapDayData(item.data() as Partial<StockDayRecord>, item.id));
}

async function writeSettingsAudit(
  batch: ReturnType<typeof writeBatch>,
  currentActor: ReturnType<typeof actor>,
  role: UserRole | null,
  action: string,
  targetType: string,
  targetId: string,
  after?: unknown
) {
  const timestamp = now();
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
    id: auditId,
    action,
    ...currentActor,
    targetType,
    targetId,
    after,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "settings",
      action: "stock-settings-change",
      summary: `${action.replace(/-/g, " ")} on ${targetType} ${targetId}`,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType,
      targetId,
      sourcePath: `stockSettings/audit/items/${auditId}`
    },
    role ?? "viewer"
  );
}

export async function upsertStockProduct(
  input: Omit<StockProduct, "createdBy" | "createdAt" | "updatedAt"> & Partial<Pick<StockProduct, "createdBy" | "createdAt">>,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const product: StockProduct = {
    ...input,
    rate: Number(input.rate) || 0,
    displayOrder: Number(input.displayOrder) || 0,
    paymentTrackingEnabled: input.paymentTrackingEnabled !== false,
    createdBy: input.createdBy ?? currentActor.userId,
    createdAt: input.createdAt ?? timestamp,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  batch.set(doc(productCollection(), product.id), cleanForFirestore(product), { merge: true });
  await writeSettingsAudit(batch, currentActor, role, "upsert-product", "product", product.id, product);
  await batch.commit();
}

export async function upsertStockAccount(
  input: Omit<StockAccountProfile, "createdBy" | "createdAt" | "updatedAt"> & Partial<Pick<StockAccountProfile, "createdBy" | "createdAt">>,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const account: StockAccountProfile = {
    ...input,
    displayOrder: Number(input.displayOrder) || 0,
    openingBalance: Number(input.openingBalance ?? 0) || 0,
    createdBy: input.createdBy ?? currentActor.userId,
    createdAt: input.createdAt ?? timestamp,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  batch.set(doc(accountCollection(), account.id), cleanForFirestore(account), { merge: true });
  await writeSettingsAudit(batch, currentActor, role, "upsert-account", "account", account.id, account);
  await batch.commit();
}

export async function deleteStockProduct(id: string, user: User | null, role: UserRole | null) {
  const currentActor = actor(user, role);
  const batch = writeBatch(requireDb());
  batch.delete(doc(productCollection(), id));
  await writeSettingsAudit(batch, currentActor, role, "delete-product", "product", id);
  await batch.commit();
}

export async function deleteStockAccount(id: string, user: User | null, role: UserRole | null) {
  const currentActor = actor(user, role);
  const batch = writeBatch(requireDb());
  batch.delete(doc(accountCollection(), id));
  await writeSettingsAudit(batch, currentActor, role, "delete-account", "account", id);
  await batch.commit();
}

export async function ensureStockMonth(monthId: string, user: User | null, role: UserRole | null) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const month: StockMonth = {
    id: monthId,
    label: monthId,
    status: "open",
    createdBy: currentActor.userId,
    updatedBy: currentActor.userId,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await setDoc(monthRef(monthId), cleanForFirestore(month), { merge: true });
  return month;
}

export async function saveStockDay(
  month: StockMonth,
  day: StockDayRecord,
  allDays: StockDayRecord[],
  user: User | null,
  role: UserRole | null,
  action: "save-day" | "close-day" | "reopen-day" = "save-day"
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const nextDays = [...allDays.filter((item) => item.dayNo !== day.dayNo), day].sort((a, b) => a.dayNo - b.dayNo);
  const baseSummary = calculateMonthlySummary(month.id, nextDays);
  const openingSnap = await getDoc(openingRef());
  const openingBalances = openingSnap.exists()
    ? (openingSnap.data() as StockOpeningBalances)
    : { openingStock: {}, jazzOpeningPayable: 0 };
  const previousSummarySnap = await getDoc(monthlySummaryRef(previousMonthId(month.id)));
  const previousSummary = previousSummarySnap.exists()
    ? (previousSummarySnap.data() as StockMonthlySummary)
    : null;
  const monthOpeningStock = previousSummary?.closingStock ?? openingBalances.openingStock;
  const monthOpeningJazzPayable = previousSummary?.closingJazzPayable ?? openingBalances.jazzOpeningPayable;
  const productsSnap = await getDocs(query(productCollection(), orderBy("displayOrder", "asc")));
  const products = productsSnap.docs.map((item) => item.data() as StockProduct);
  const allStockInRecords = nextDays.flatMap((item) => item.stockIn ?? []);
  const productBalances = calculateCurrentStock(products, monthOpeningStock, allStockInRecords, nextDays);
  const jazzCompanyBalance = calculateJazzCompanyBalance(monthOpeningJazzPayable, allStockInRecords);
  const closingStock = Object.fromEntries(productBalances.map((balance) => [balance.productId, balance.currentStock]));
  const summary: StockMonthlySummary = {
    ...baseSummary,
    openingStock: monthOpeningStock,
    closingStock,
    openingJazzPayable: monthOpeningJazzPayable,
    closingJazzPayable: jazzCompanyBalance.currentPayable
  };
  const nextMonth: StockMonth = {
    ...month,
    totalQty: summary.totalQty,
    totalAmount: summary.totalAmount,
    totalPaymentReceived: summary.totalPaymentReceived,
    totalDueBalance: summary.totalDueBalance,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const nextDay: StockDayRecord = {
    ...day,
    ...stockDayDateFields(month.id, day.dayNo),
    summary: day.summary,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const dayDocumentRef = dayRef(month.id, day.dayNo);
  const [existingEntrySnap, existingStockOutSnap, existingStockInSnap] = await Promise.all([
    getDocs(collection(dayDocumentRef, "entries")),
    getDocs(collection(dayDocumentRef, "stockOut")),
    getDocs(collection(dayDocumentRef, "stockIn"))
  ]);
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const audit: StockAuditEvent = {
    id: auditId,
    action,
    ...currentActor,
    targetType: "day",
    targetId: `${month.id}/${day.dayNo}`,
    createdAt: timestamp
  };

  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  batch.set(dayDocumentRef, {
    ...cleanForFirestore({ ...nextDay, stockOut: nextDay.entries }),
    closedAt: nextDay.closedAt ?? deleteField(),
    closedBy: nextDay.closedBy ?? deleteField(),
    lockedAt: nextDay.lockedAt ?? deleteField(),
    lockedBy: nextDay.lockedBy ?? deleteField(),
    lockedByRole: nextDay.lockedByRole ?? deleteField(),
    reopenedAt: nextDay.reopenedAt ?? deleteField(),
    reopenedBy: nextDay.reopenedBy ?? deleteField(),
    reopenedByRole: nextDay.reopenedByRole ?? deleteField(),
    reopenedUntilAt: nextDay.reopenedUntilAt ?? deleteField()
  }, { merge: true });
  const nextEntryIds = new Set(nextDay.entries.map((entry) => entry.id));
  const nextStockInIds = new Set((nextDay.stockIn ?? []).map((record) => record.id));
  existingEntrySnap.docs.forEach((entryDoc) => {
    if (!nextEntryIds.has(entryDoc.id)) batch.delete(entryDoc.ref);
  });
  existingStockOutSnap.docs.forEach((entryDoc) => {
    if (!nextEntryIds.has(entryDoc.id)) batch.delete(entryDoc.ref);
  });
  existingStockInSnap.docs.forEach((entryDoc) => {
    if (!nextStockInIds.has(entryDoc.id)) batch.delete(entryDoc.ref);
  });
  for (const entry of nextDay.entries) {
    batch.set(doc(dayDocumentRef, "stockOut", entry.id), cleanForFirestore(entry), { merge: true });
    batch.set(doc(dayDocumentRef, "entries", entry.id), cleanForFirestore(entry), { merge: true });
  }
  if (nextDay.stockIn) {
    for (const record of nextDay.stockIn) {
      batch.set(doc(dayDocumentRef, "stockIn", record.id), cleanForFirestore(record), { merge: true });
    }
  }
  await syncStockLedgerV2RawEntriesInBatch(batch, nextDay, currentActor.userId, timestamp);
  productBalances.forEach((balance) => {
    batch.set(productBalanceRef(balance.productId), cleanForFirestore(balance satisfies StockProductBalance), { merge: true });
  });
  summary.accountTotals.forEach((account) => {
    batch.set(
      accountBalanceRef(account.accountId),
      cleanForFirestore({ ...account, updatedAt: timestamp }),
      { merge: true }
    );
  });
  batch.set(
    jazzCompanyBalanceRef(),
    cleanForFirestore({ ...jazzCompanyBalance, updatedAt: timestamp } satisfies StockJazzCompanyBalance),
    { merge: true }
  );
  batch.set(monthlySummaryRef(month.id), cleanForFirestore(summary), { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore(audit));
  const unifiedAuditInput = {
      id: auditId,
      createdAt: timestamp,
      module: "stock" as const,
      action,
      summary: action === "close-day" ? `Closed stock day ${day.dayNo}` : action === "reopen-day" ? `Reopened stock day ${day.dayNo}` : `Saved stock day ${day.dayNo}`,
      monthId: month.id,
      dayNo: day.dayNo,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "day",
      targetId: `${month.id}/${day.dayNo}`,
      sourcePath: `stockMonths/${month.id}/audit/${auditId}`
    };
  if (action !== "close-day") {
    stageUnifiedAudit(batch, unifiedAuditInput, currentActor.userRole ?? "viewer");
  }
  await batch.commit();
  if (action === "close-day") {
    void writeAuditLog(unifiedAuditInput, { actorRole: currentActor.userRole ?? "viewer" })
      .catch(() => console.warn("Stock day closed, but the secondary audit log write failed."));
  }
  return { month: nextMonth, day: nextDay, summary };
}

export async function recalculateStockMonth(
  month: StockMonth,
  days: StockDayRecord[],
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const openingSnap = await getDoc(openingRef());
  const openingBalances = openingSnap.exists()
    ? (openingSnap.data() as StockOpeningBalances)
    : { openingStock: {}, jazzOpeningPayable: 0 };
  const previousSummarySnap = await getDoc(monthlySummaryRef(previousMonthId(month.id)));
  const previousSummary = previousSummarySnap.exists()
    ? (previousSummarySnap.data() as StockMonthlySummary)
    : null;
  const monthOpeningStock = previousSummary?.closingStock ?? openingBalances.openingStock;
  const monthOpeningJazzPayable = previousSummary?.closingJazzPayable ?? openingBalances.jazzOpeningPayable;
  const [productsSnap, accountsSnap] = await Promise.all([
    getDocs(query(productCollection(), orderBy("displayOrder", "asc"))),
    getDocs(query(accountCollection(), orderBy("displayOrder", "asc")))
  ]);
  const products = productsSnap.docs.map((item) => item.data() as StockProduct);
  const accounts = accountsSnap.docs.map((item) => item.data() as StockAccountProfile);
  const recalculatedDays = recalculateStockMonthEntries(days, accounts, previousSummary);
  const baseSummary = calculateMonthlySummary(month.id, recalculatedDays);
  const allStockInRecords = recalculatedDays.flatMap((item) => item.stockIn ?? []);
  const productBalances = calculateCurrentStock(products, monthOpeningStock, allStockInRecords, recalculatedDays);
  const jazzCompanyBalance = calculateJazzCompanyBalance(monthOpeningJazzPayable, allStockInRecords);
  const closingStock = Object.fromEntries(productBalances.map((balance) => [balance.productId, balance.currentStock]));
  const summary: StockMonthlySummary = {
    ...baseSummary,
    openingStock: monthOpeningStock,
    closingStock,
    openingJazzPayable: monthOpeningJazzPayable,
    closingJazzPayable: jazzCompanyBalance.currentPayable
  };
  const nextMonth: StockMonth = {
    ...month,
    totalQty: summary.totalQty,
    totalAmount: summary.totalAmount,
    totalPaymentReceived: summary.totalPaymentReceived,
    totalDueBalance: summary.totalDueBalance,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  recalculatedDays.forEach((day) => {
  batch.set(dayRef(month.id, day.dayNo), {
    ...cleanForFirestore({
      ...day,
      ...stockDayDateFields(month.id, day.dayNo),
      stockOut: day.entries,
      recalculatedAt: timestamp,
      updatedBy: currentActor.userId,
      updatedAt: timestamp
    }),
      closedAt: day.closedAt ?? deleteField(),
      closedBy: day.closedBy ?? deleteField(),
      lockedAt: day.lockedAt ?? deleteField(),
      lockedBy: day.lockedBy ?? deleteField(),
      lockedByRole: day.lockedByRole ?? deleteField(),
      reopenedAt: day.reopenedAt ?? deleteField(),
      reopenedBy: day.reopenedBy ?? deleteField(),
      reopenedByRole: day.reopenedByRole ?? deleteField(),
      reopenedUntilAt: day.reopenedUntilAt ?? deleteField()
    }, { merge: true });
  });
  batch.set(monthlySummaryRef(month.id), cleanForFirestore(summary), { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore({
    id: auditId,
    action: "recalculate-month",
    ...currentActor,
    targetType: "month",
    targetId: month.id,
    after: {
      dayCount: recalculatedDays.length
    },
    createdAt: timestamp
  } satisfies StockAuditEvent));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "stock",
      action: "recalculate-month",
      summary: `Recalculated stock month ${month.id}`,
      monthId: month.id,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "month",
      targetId: month.id,
      sourcePath: `stockMonths/${month.id}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  productBalances.forEach((balance) => {
    batch.set(productBalanceRef(balance.productId), cleanForFirestore(balance satisfies StockProductBalance), { merge: true });
  });
  summary.accountTotals.forEach((account) => {
    batch.set(accountBalanceRef(account.accountId), cleanForFirestore({ ...account, updatedAt: timestamp }), { merge: true });
  });
  batch.set(
    jazzCompanyBalanceRef(),
    cleanForFirestore({ ...jazzCompanyBalance, updatedAt: timestamp } satisfies StockJazzCompanyBalance),
    { merge: true }
  );
  await batch.commit();
  return { month: nextMonth, days: recalculatedDays, summary };
}

export function reopenStockDayFor15Minutes(
  month: StockMonth,
  day: StockDayRecord,
  allDays: StockDayRecord[],
  user: User | null,
  role: UserRole | null,
  reopenUntilAt?: number
) {
  const timestamp = now();
  return saveStockDay(
    month,
    {
      ...day,
      status: "open",
      reopenedAt: timestamp,
      reopenedBy: user?.uid,
      reopenedByRole: role ?? undefined,
      reopenedUntilAt: reopenUntilAt
    },
    allDays,
    user,
    role,
    "reopen-day"
  );
}

export async function updateStockDaysStatusBatch(
  month: StockMonth,
  nextDays: StockDayRecord[],
  allDays: StockDayRecord[],
  user: User | null,
  role: UserRole | null,
  action: "close-days" | "reopen-days",
  reopenUntilAt?: number
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const mergedDays = nextDays.reduce(
    (days, nextDay) => [...days.filter((day) => day.dayNo !== nextDay.dayNo), nextDay].sort((a, b) => a.dayNo - b.dayNo),
    allDays
  );
  const summary = calculateMonthlySummary(month.id, mergedDays);
  const nextMonth: StockMonth = {
    ...month,
    status: action === "reopen-days" ? "open" : month.status,
    totalQty: summary.totalQty,
    totalAmount: summary.totalAmount,
    totalPaymentReceived: summary.totalPaymentReceived,
    totalDueBalance: summary.totalDueBalance,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  nextDays.forEach((day) => {
    const nextDay = {
      ...day,
      ...stockDayDateFields(month.id, day.dayNo),
      updatedBy: currentActor.userId,
      updatedAt: timestamp
    };
    batch.set(dayRef(month.id, day.dayNo), {
      ...cleanForFirestore({ ...nextDay, stockOut: nextDay.entries }),
      closedAt: nextDay.closedAt ?? deleteField(),
      closedBy: nextDay.closedBy ?? deleteField(),
      lockedAt: nextDay.lockedAt ?? deleteField(),
      lockedBy: nextDay.lockedBy ?? deleteField(),
      lockedByRole: nextDay.lockedByRole ?? deleteField(),
      reopenedAt: nextDay.reopenedAt ?? deleteField(),
      reopenedBy: nextDay.reopenedBy ?? deleteField(),
      reopenedByRole: nextDay.reopenedByRole ?? deleteField(),
      reopenedUntilAt: nextDay.reopenedUntilAt ?? deleteField()
    }, { merge: true });
  });
  batch.set(monthlySummaryRef(month.id), cleanForFirestore(summary), { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore({
    id: auditId,
    action,
    ...currentActor,
    targetType: "month",
    targetId: month.id,
    after: {
      dayCount: nextDays.length,
      reopenUntilAt
    },
    createdAt: timestamp
  } satisfies StockAuditEvent));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "stock",
      action,
      summary: action === "reopen-days"
        ? `Reopened ${nextDays.length} stock days`
        : `Closed ${nextDays.length} stock days`,
      monthId: month.id,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "month",
      targetId: month.id,
      sourcePath: `stockMonths/${month.id}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
  return { month: nextMonth, days: mergedDays, summary };
}

export function closeStockDay(
  month: StockMonth,
  day: StockDayRecord,
  allDays: StockDayRecord[],
  user: User | null,
  role: UserRole | null
) {
  const timestamp = now();
  return saveStockDay(
    month,
    {
      ...day,
      status: "closed",
      closedAt: timestamp,
      closedBy: user?.uid,
      lockedAt: timestamp,
      lockedBy: user?.uid,
      lockedByRole: role ?? undefined,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedByRole: undefined,
      reopenedUntilAt: undefined
    },
    allDays,
    user,
    role,
    "close-day"
  );
}

export async function setStockMonthStatus(
  month: StockMonth,
  status: StockMonth["status"],
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const nextMonth: StockMonth = {
    ...month,
    status,
    updatedBy: currentActor.userId,
    updatedAt: timestamp,
    closedAt: status === "closed" ? timestamp : undefined,
    closedBy: status === "closed" ? currentActor.userId : undefined
  };
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(monthRef(month.id), {
    ...cleanForFirestore(nextMonth),
    closedAt: status === "closed" ? timestamp : deleteField(),
    closedBy: status === "closed" ? currentActor.userId : deleteField()
  }, { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore({
    id: auditId,
    action: status === "closed" ? "close-month" : "reopen-month",
    ...currentActor,
    targetType: "month",
    targetId: month.id,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "stock",
      action: status === "closed" ? "close-month" : "reopen-month",
      summary: `${status === "closed" ? "Closed" : "Reopened"} stock month ${month.id}`,
      monthId: month.id,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "month",
      targetId: month.id,
      sourcePath: `stockMonths/${month.id}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
  return nextMonth;
}

export async function listStockBackup() {
  const openingDoc = await getDoc(openingRef());
  const openingBalances = openingDoc.exists() ? openingDoc.data() as StockOpeningBalances : null;

  const [productsSnap, accountsSnap, monthsSnap, productBalancesSnap, accountBalancesSnap, jazzCompanySnap] = await Promise.all([
    getDocs(query(productCollection(), orderBy("displayOrder", "asc"))),
    getDocs(query(accountCollection(), orderBy("displayOrder", "asc"))),
    getDocs(query(collection(requireDb(), "stockMonths"), orderBy("id", "asc"))),
    getDocs(collection(requireDb(), "stockBalances", "products", "items")),
    getDocs(collection(requireDb(), "stockBalances", "accounts", "items")),
    getDoc(jazzCompanyBalanceRef())
  ]);
  const months = await Promise.all(
    monthsSnap.docs.map(async (monthDoc) => ({
      ...(monthDoc.data() as StockMonth),
      days: await loadStockDays(monthDoc.id)
    }))
  );
  return {
    settings: {
      products: productsSnap.docs.map((item) => item.data() as StockProduct),
      accounts: accountsSnap.docs.map((item) => item.data() as StockAccountProfile),
      openingStock: openingBalances?.openingStock ?? {},
      jazzOpeningPayable: openingBalances ? { amount: openingBalances.jazzOpeningPayable } : {}
    },
    records: {
      stockInFromJazz: months.flatMap((month) => month.days.flatMap((day) => day.stockIn ?? [])),
      stockOut: months.flatMap((month) => month.days.flatMap((day) => day.entries ?? []))
    },
    balances: {
      products: productBalancesSnap.docs.map((item) => item.data()),
      accounts: accountBalancesSnap.docs.map((item) => item.data()),
      jazzCompany: jazzCompanySnap.exists() ? jazzCompanySnap.data() : {}
    },
    summaries: months
  };
}

export async function writeStockBackupRestoreAudit(monthCount: number, user: User | null, role: UserRole | null) {
  const currentActor = actor(user, role);
  await writeAuditLog({
    module: "stock",
    action: "backup-restore",
    summary: `Restored stock backup (${monthCount} month${monthCount === 1 ? "" : "s"})`,
    actorUid: currentActor.userId,
    actorEmail: currentActor.userEmail
  }, { actorRole: currentActor.userRole ?? "viewer" });
}
