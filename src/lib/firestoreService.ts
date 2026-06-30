import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  type DocumentData,
  type FirestoreError,
  getDoc,
  getDocs,
  type QueryDocumentSnapshot,
  type SnapshotMetadata,
  onSnapshot,
  query,
  orderBy,
  setDoc,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { buildAuditLogDocument, writeAuditLog } from "./auditLogService";
import { buildExpenseCarryForwardSeed, computeMonth } from "./formulaEngine";
import { ChunkedFirestoreBatch, type FirestoreBatchWriter } from "../shared/services/chunkedFirestoreBatch";
import { assertMasterRefreshAccess, canRunMasterRefresh, MASTER_REFRESH_ACCESS } from "../shared/services/masterRefreshPermissions";
import { canReopenDay, isActiveReopenWindow } from "../shared/services/dayEditPermissions";
import { changedSortOrderPatches, orderedBySortOrder } from "../shared/services/orderUtils";
import {
  defaultLedgerReadModeConfig,
  LEDGER_CALC_VERSION,
  type LedgerReadModeConfig
} from "../shared/ledger/ledgerTypes";
import { assertLedgerV2UiReadAllowed, type LedgerUiReadDecision } from "../shared/ledger/ledgerReadMode";
import {
  projectionToLegacyCreditRows,
  type ExpenseCreditProjection,
  type ExpenseCreditRawEntry
} from "../shared/ledger/expenseCreditLedger";
import type {
  AuditEvent,
  AuthorizedEmail,
  DailyLedgerInput,
  ExpenseCarryForwardSeed,
  MonthComputed,
  MonthRecord,
  MonthStatus,
  NotificationSettings,
  CatalogItem,
  UserProfile,
  UserRole,
  WorkbookImportPreview
} from "../types/ledger";

function now() {
  return Date.now();
}

export const defaultOwnerOpeningBalance = -85427;

export type FirestoreSnapshotMeta = Pick<SnapshotMetadata, "fromCache" | "hasPendingWrites">;

export type LedgerMismatchReportSummary = {
  id: string;
  module: "expense" | "jazzLoad" | "stock";
  monthId: string;
  status: "open" | "repaired" | "ignored";
  issueCount: number;
  createdAt: number;
};

export type { LedgerReadModeConfig };

type LedgerUiReadOptions = {
  readDecision?: LedgerUiReadDecision;
};

function requireDb() {
  if (!db) throw new Error("Firebase is not configured.");
  return db;
}

function cleanForFirestore<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cleanForFirestore(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanForFirestore(entryValue)])
    ) as T;
  }
  return value;
}

function mergeStoredRows<T extends { id: string }>(embeddedRows: unknown, subcollectionRows: T[]): T[] {
  const safeEmbeddedRows = Array.isArray(embeddedRows)
    ? embeddedRows.filter((row): row is T => Boolean(row && typeof row === "object" && "id" in row))
    : [];

  if (safeEmbeddedRows.length > 0) {
    return safeEmbeddedRows;
  }

  return subcollectionRows;
}

function rowsFromDocs<T extends { id: string }>(docs: QueryDocumentSnapshot<DocumentData>[]): T[] {
  return docs
    .map((itemDoc) => ({ id: itemDoc.id, ...itemDoc.data() }) as T)
    .filter((row) => Boolean(row.id));
}

function mergeCreditRowsForRead(
  embeddedRows: unknown,
  subcollectionRows: DailyLedgerInput["credits"]
): DailyLedgerInput["credits"] {
  const safeEmbeddedRows = Array.isArray(embeddedRows)
    ? embeddedRows.filter((row): row is DailyLedgerInput["credits"][number] => Boolean(row && typeof row === "object" && "id" in row))
    : [];
  return safeEmbeddedRows.length > 0 ? safeEmbeddedRows : subcollectionRows;
}

let auditActorRole: UserRole = "viewer";

export function setAuditActorRole(role: UserRole | null) {
  auditActorRole = role ?? "viewer";
}

type PermissionDebugPathMode = "client-save" | "callable" | "local-fallback";

type PermissionDebugContext = {
  module?: "expense" | "jazzLoad" | "stock" | "auth";
  source?: string;
  pathMode?: PermissionDebugPathMode;
};

type SaveMonthRecordOptions = {
  suppressPerDayAudit?: boolean;
  onlyWriteEditableDays?: boolean;
  skipPostCommitUpsert?: boolean;
  carryForwardSeed?: ExpenseCarryForwardSeed | null;
  recalculationWrite?: boolean;
  debugSource?: string;
  debugPathMode?: PermissionDebugPathMode;
};

type ExpenseRecalculationStamp = Pick<
  DailyLedgerInput,
  "recalculatedAt" | "recalculatedBy" | "recalculatedByRole" | "recalculationSource"
>;

function shouldLogPermissionDebug() {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("permissionDebug") === "true";
  } catch {
    return false;
  }
}

function debugPermissionWrite(
  context: PermissionDebugContext,
  path: string,
  operation: "set" | "update" | "delete" | "commit" | "callable"
) {
  if (!shouldLogPermissionDebug()) return;
  const user = auth?.currentUser;
  console.info("[permission-debug]", {
    module: context.module ?? "expense",
    source: context.source ?? "unspecified",
    pathMode: context.pathMode ?? "client-save",
    operation,
    path,
    role: auditActorRole,
    uid: user?.uid ?? null,
    email: user?.email ?? null
  });
}

function actor() {
  return {
    actorUid: auth?.currentUser?.uid,
    actorEmail: auth?.currentUser?.email ?? null
  };
}

function resolveActorRole(role?: UserRole) {
  return role ?? auditActorRole;
}

async function writeExpenseAuditLog(
  monthId: string,
  auditId: string,
  createdAt: number,
  event: Omit<AuditEvent, "id" | "createdAt">,
  options?: { actorRole?: UserRole; batch?: FirestoreBatchWriter; dayNo?: number }
) {
  const actorRole = resolveActorRole(options?.actorRole);
  const actorFields = actor();
  const actorUid = event.actorUid ?? actorFields.actorUid;
  if (!actorUid) return;
  const input = {
    id: auditId,
    createdAt,
    module: (event.action === "role-change" ? "auth" : "expense") as "auth" | "expense",
    action: event.action,
    summary: event.detail,
    monthId,
    dayNo: options?.dayNo,
    targetType: options?.dayNo != null ? "day" : event.action.includes("month") ? "month" : undefined,
    targetId: options?.dayNo != null ? String(options.dayNo) : undefined,
    actorUid,
    actorEmail: event.actorEmail ?? actorFields.actorEmail,
    sourcePath: `months/${monthId}/audit/${auditId}`
  };
  if (options?.batch) {
    const log = buildAuditLogDocument(input, actorRole);
    debugPermissionWrite({ module: "expense", source: "expense-audit-log", pathMode: "client-save" }, `auditLogs/${log.id}`, "set");
    options.batch.set(doc(requireDb(), "auditLogs", log.id), log);
    return;
  }
  await writeAuditLog(input, { actorRole });
}

export function emailKey(email: string) {
  return email.trim().toLowerCase();
}

async function addAudit(
  monthId: string,
  event: Omit<AuditEvent, "id" | "createdAt">,
  options?: { actorRole?: UserRole; dayNo?: number }
) {
  const firestore = requireDb();
  const createdAt = now();
  const id = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { id, createdAt, ...event, ...actor() };
  debugPermissionWrite({ module: "expense", source: "expense-audit", pathMode: "client-save" }, `months/${monthId}/audit/${id}`, "set");
  await setDoc(doc(firestore, "months", monthId, "audit", id), payload);
  await writeExpenseAuditLog(monthId, id, createdAt, { ...event, ...actor() }, options);
}

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  sendOnDayClose: true,
  sendOnMonthClose: true,
  sendOnImport: false,
  sendOnRecalculate: false,
  sendOnRoleChange: false
};

function notificationConfigRef() {
  return doc(requireDb(), "settings", "notifications", "config", "default");
}

function ledgerReadModeConfigRef() {
  return doc(requireDb(), "settings", "ledger", "config", "main");
}

function snapshotError(handler?: (error: FirestoreError) => void) {
  return handler;
}

export function subscribeNotificationSettings(
  onNext: (settings: NotificationSettings | null, metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    notificationConfigRef(),
    { includeMetadataChanges: true },
    (snap) => {
      onNext(
        snap.exists() ? ({ ...defaultNotificationSettings, ...snap.data() } as NotificationSettings) : null,
        snap.metadata
      );
    },
    snapshotError(onError)
  );
}

function normalizeLedgerReadModeConfig(data: Partial<LedgerReadModeConfig> | undefined): LedgerReadModeConfig {
  return {
    ...defaultLedgerReadModeConfig,
    ...(data ?? {})
  };
}

function assertLedgerCutoverIsReviewed(config: LedgerReadModeConfig) {
  const hardCutoverEnabled =
    config.expenseReadMode === "v2" ||
    config.jazzLoadReadMode === "v2" ||
    config.stockReadMode === "v2";
  if (hardCutoverEnabled && !config.verifiedReportId) {
    throw new Error("ledgerV2 read cutover requires a reviewed verification report id.");
  }
}

export function subscribeLedgerReadModeConfig(
  onNext: (config: LedgerReadModeConfig, metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    ledgerReadModeConfigRef(),
    { includeMetadataChanges: true },
    (snap) => {
      onNext(normalizeLedgerReadModeConfig(snap.exists() ? snap.data() as Partial<LedgerReadModeConfig> : undefined), snap.metadata);
    },
    snapshotError(onError)
  );
}

export async function saveLedgerReadModeConfig(config: LedgerReadModeConfig): Promise<void> {
  assertLedgerCutoverIsReviewed(config);
  await setDoc(
    ledgerReadModeConfigRef(),
    cleanForFirestore({
      ...normalizeLedgerReadModeConfig(config),
      updatedAt: now(),
      updatedBy: auth?.currentUser?.uid ?? "unknown"
    }),
    { merge: true }
  );
  await writeSettingsAuditLog("Updated ledger read mode feature flags", "ledger-read-mode-update", "ledger", "main");
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const snap = await getDoc(notificationConfigRef());
  return {
    ...defaultNotificationSettings,
    ...(snap.exists() ? snap.data() : {})
  } as NotificationSettings;
}

export async function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
  await setDoc(notificationConfigRef(), cleanForFirestore({ ...settings, updatedAt: now() }), { merge: true });
  await writeSettingsAuditLog("Updated notification email toggles", "notification-update", "notifications", "default");
}

export async function addRoleChangeAudit(monthId: string, detail: string): Promise<void> {
  await addAudit(
    monthId,
    {
      action: "role-change",
      detail,
      ...actor()
    },
    { actorRole: auditActorRole }
  );
}

export async function writeAuthAuditLog(summary: string, action: string, targetType?: string, targetId?: string) {
  const actorFields = actor();
  if (!actorFields.actorUid) return;
  await writeAuditLog({
    module: "auth",
    action,
    summary,
    targetType,
    targetId,
    actorUid: actorFields.actorUid,
    actorEmail: actorFields.actorEmail
  }, { actorRole: auditActorRole });
}

export async function writeSettingsAuditLog(
  summary: string,
  action: string,
  targetType?: string,
  targetId?: string
) {
  const actorFields = actor();
  if (!actorFields.actorUid) return;
  await writeAuditLog({
    module: "settings",
    action,
    summary,
    targetType,
    targetId,
    actorUid: actorFields.actorUid,
    actorEmail: actorFields.actorEmail
  }, { actorRole: auditActorRole });
}

export async function writeExpenseBackupRestoreAudit(monthCount: number) {
  const actorFields = actor();
  if (!actorFields.actorUid) return;
  await writeAuditLog({
    module: "expense",
    action: "backup-restore",
    summary: `Restored expense backup (${monthCount} month${monthCount === 1 ? "" : "s"})`,
    actorUid: actorFields.actorUid,
    actorEmail: actorFields.actorEmail
  }, { actorRole: auditActorRole });
}

export async function getUserRole(uid: string, email?: string | null): Promise<UserRole> {
  const firestore = requireDb();
  const ref = doc(firestore, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const data = snap.data() as Omit<UserProfile, "role"> & { role?: UserRole | "staff" };
    if (data.active === false) throw new Error("This user account is inactive.");
    const role = data.role;
    return role === "staff" ? "admin" : ((role as UserRole) ?? "viewer");
  }

  if (!email) throw new Error("This sign-in account does not have an email address.");
  const authorizedSnap = await getDoc(doc(firestore, "authorizedEmails", emailKey(email)));
  if (!authorizedSnap.exists()) throw new Error("This email is not authorized by the owner.");
  const authorized = authorizedSnap.data() as Omit<AuthorizedEmail, "role"> & { role?: UserRole | "staff" };
  if (!authorized.active) throw new Error("This email access is inactive.");
  const role: UserRole = authorized.role === "staff" ? "admin" : (authorized.role ?? "viewer");
  await setDoc(ref, {
    uid,
    email: emailKey(email),
    role,
    active: true,
    createdAt: now(),
    updatedAt: now()
  });
  return role;
}

export async function listUsers(): Promise<UserProfile[]> {
  const firestore = requireDb();
  const snap = await getDocs(query(collection(firestore, "users"), orderBy("createdAt", "asc")));
  return snap.docs.map((userDoc) => {
    const data = userDoc.data() as Omit<UserProfile, "role"> & { role?: UserRole | "staff" };
    return {
      ...data,
      uid: data.uid ?? userDoc.id,
      role: data.role === "staff" ? "admin" : (data.role ?? "viewer")
    };
  });
}

function mapUserDoc(userDoc: QueryDocumentSnapshot<DocumentData>): UserProfile {
  const data = userDoc.data() as Omit<UserProfile, "role"> & { role?: UserRole | "staff" };
  return {
    ...data,
    uid: data.uid ?? userDoc.id,
    role: data.role === "staff" ? "admin" : (data.role ?? "viewer")
  };
}

export function subscribeUsers(
  onNext: (users: UserProfile[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(requireDb(), "users"), orderBy("createdAt", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map(mapUserDoc), snap.metadata),
    snapshotError(onError)
  );
}

export async function updateUserProfile(uid: string, updates: Pick<UserProfile, "role" | "active">) {
  const firestore = requireDb();
  await updateDoc(doc(firestore, "users", uid), {
    ...updates,
    updatedAt: now()
  });
}

export async function deleteUserProfile(uid: string) {
  await deleteDoc(doc(requireDb(), "users", uid));
}

export async function listAuthorizedEmails(): Promise<AuthorizedEmail[]> {
  const firestore = requireDb();
  const snap = await getDocs(query(collection(firestore, "authorizedEmails"), orderBy("email", "asc")));
  return snap.docs.map((emailDoc) => {
    const data = emailDoc.data() as Omit<AuthorizedEmail, "id" | "role"> & { role?: UserRole | "staff" };
    return {
      ...data,
      id: emailDoc.id,
      role: data.role === "staff" ? "admin" : (data.role ?? "viewer")
    };
  });
}

function mapAuthorizedEmailDoc(emailDoc: QueryDocumentSnapshot<DocumentData>): AuthorizedEmail {
  const data = emailDoc.data() as Omit<AuthorizedEmail, "id" | "role"> & { role?: UserRole | "staff" };
  return {
    ...data,
    id: emailDoc.id,
    role: data.role === "staff" ? "admin" : (data.role ?? "viewer")
  };
}

export function subscribeAuthorizedEmails(
  onNext: (emails: AuthorizedEmail[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(requireDb(), "authorizedEmails"), orderBy("email", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map(mapAuthorizedEmailDoc), snap.metadata),
    snapshotError(onError)
  );
}

export async function upsertAuthorizedEmail(email: string, role: UserRole, active = true) {
  const firestore = requireDb();
  const cleanEmail = emailKey(email);
  await setDoc(doc(firestore, "authorizedEmails", cleanEmail), {
    id: cleanEmail,
    email: cleanEmail,
    role,
    active,
    updatedAt: now(),
    createdAt: now()
  }, { merge: true });
}

export async function deleteAuthorizedEmail(email: string) {
  await deleteDoc(doc(requireDb(), "authorizedEmails", emailKey(email)));
}

const defaultExpenseCategories = ["Salary", "Refreshment", "IMSI", "Utilities", "Rent", "General"];

export const defaultCommissionCatalog: CatalogItem[] = [
  "JazzCash",
  "JazzLoad",
  "Efics MFS",
  "Efics BILL",
  "SIM Commission",
  "Retail IMSI",
  "Franchise IMSI",
  "GST Comm",
  "Tax Claim Rebate",
  "MNP Comm",
  "Other 1",
  "Other 2"
].map((name, index) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
  name,
  active: true,
  sortOrder: index + 1
}));

function catalogCollection(name: "expenseCategories" | "creditParties" | "commissionCategories") {
  return collection(requireDb(), "settings", name, "items");
}

export async function listCatalogItems(
  name: "expenseCategories" | "creditParties" | "commissionCategories"
): Promise<CatalogItem[]> {
  const snap = await getDocs(catalogCollection(name));
  return orderedBySortOrder(snap.docs.map((itemDoc) => itemDoc.data() as CatalogItem));
}

export function subscribeCatalogItems(
  name: "expenseCategories" | "creditParties" | "commissionCategories",
  onNext: (items: CatalogItem[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    catalogCollection(name),
    { includeMetadataChanges: true },
    (snap) => onNext(orderedBySortOrder(snap.docs.map((itemDoc) => itemDoc.data() as CatalogItem)), snap.metadata),
    snapshotError(onError)
  );
}

export async function updateCatalogSortOrder(
  name: "expenseCategories" | "creditParties" | "commissionCategories",
  before: CatalogItem[],
  after: CatalogItem[]
) {
  const updates = changedSortOrderPatches(before, after);
  if (updates.length === 0) return;
  const batch = writeBatch(requireDb());
  const timestamp = now();
  updates.forEach((item) => {
    batch.set(
      doc(requireDb(), "settings", name, "items", item.id),
      cleanForFirestore({ sortOrder: item.sortOrder, updatedAt: timestamp }),
      { merge: true }
    );
  });
  await batch.commit();
}

export async function upsertCatalogItem(
  name: "expenseCategories" | "creditParties" | "commissionCategories",
  item: CatalogItem
) {
  await setDoc(
    doc(requireDb(), "settings", name, "items", item.id),
    cleanForFirestore({
      ...item,
      updatedAt: now(),
      createdAt: item.createdAt ?? now()
    }),
    { merge: true }
  );
  await writeSettingsAuditLog(
    `Updated ${name} catalog item "${item.name}"`,
    "catalog-upsert",
    name,
    item.id
  );
}

export async function deleteCatalogItem(
  name: "expenseCategories" | "creditParties" | "commissionCategories",
  itemId: string
) {
  await deleteDoc(doc(requireDb(), "settings", name, "items", itemId));
  await writeSettingsAuditLog(`Deleted ${name} catalog item ${itemId}`, "catalog-delete", name, itemId);
}

export async function ensureDefaultCatalogs() {
  const [expenses, commissions] = await Promise.all([
    listCatalogItems("expenseCategories"),
    listCatalogItems("commissionCategories")
  ]);
  if (expenses.length === 0) {
    await Promise.all(
      defaultExpenseCategories.map((name, index) =>
        upsertCatalogItem("expenseCategories", {
          id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          name,
          active: true,
          sortOrder: index + 1
        })
      )
    );
  }
  if (commissions.length === 0) {
    await Promise.all(defaultCommissionCatalog.map((item) => upsertCatalogItem("commissionCategories", item)));
  }
}

export function roleCan(
  role: UserRole | null,
  permission: "daily" | "catalogs" | "users" | "ownerControls" | "importBackup" | typeof MASTER_REFRESH_ACCESS | "read"
) {
  if (!role) return false;
  if (permission === "read") return true;
  if (permission === MASTER_REFRESH_ACCESS) return canRunMasterRefresh(role);
  if (role === "owner") return true;
  if (role === "admin") {
    return permission === "daily";
  }
  return false;
}

function previousMonthId(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  if (!Number.isInteger(year) || !Number.isInteger(monthIndex)) return null;
  const date = new Date(Date.UTC(year, monthIndex - 1, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function resolveOpeningBalance(monthId: string): Promise<number> {
  return (await resolveExpenseCarryForwardSeed(monthId))?.openingBalance ?? 0;
}

export async function resolveOwnerOpeningBalance(monthId: string): Promise<number> {
  return (await resolveExpenseCarryForwardSeed(monthId))?.ownerOpeningBalance ?? defaultOwnerOpeningBalance;
}

export async function resolveExpenseCarryForwardSeed(monthId: string): Promise<ExpenseCarryForwardSeed | null> {
  const previousId = previousMonthId(monthId);
  if (!previousId) return null;
  const previousMonthSnap = await getDoc(doc(requireDb(), "months", previousId));
  const previousMonth = previousMonthSnap.exists() ? previousMonthSnap.data() as MonthRecord : undefined;
  const previousDays = await fetchMonthDays(previousId).catch(() => []);
  if (!previousMonth && previousDays.length === 0) return null;
  const computed = computeMonth(
    previousDays,
    previousMonth?.openingBalance ?? 0,
    previousId,
    previousMonth?.ownerOpeningBalance ?? defaultOwnerOpeningBalance
  );
  return buildExpenseCarryForwardSeed(previousId, computed);
}

export async function listMonths(): Promise<MonthRecord[]> {
  const firestore = requireDb();
  const snap = await getDocs(query(collection(firestore, "months"), orderBy("id", "desc")));
  return snap.docs.map((monthDoc) => monthDoc.data() as MonthRecord);
}

export function subscribeMonths(
  onNext: (months: MonthRecord[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(requireDb(), "months"), orderBy("id", "desc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((monthDoc) => monthDoc.data() as MonthRecord), snap.metadata),
    snapshotError(onError)
  );
}

export function subscribeMonthRecord(
  monthId: string,
  onNext: (month: MonthRecord | null, metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    doc(requireDb(), "months", monthId),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.exists() ? (snap.data() as MonthRecord) : null, snap.metadata),
    snapshotError(onError)
  );
}

async function syncDaySubcollection<T extends { id: string }>(
  dayRef: ReturnType<typeof doc>,
  name: "expenses" | "commissions" | "credits" | "ownerBalances",
  rows: T[],
  debugContext?: PermissionDebugContext
) {
  const existingSnap = await getDocs(collection(dayRef, name));
  const nextIds = new Set(rows.map((row) => row.id));

  await Promise.all(
    existingSnap.docs
      .filter((itemDoc) => !nextIds.has(itemDoc.id))
      .map((itemDoc) => {
        debugPermissionWrite(debugContext ?? { module: "expense", source: "sync-day-subcollection", pathMode: "client-save" }, itemDoc.ref.path, "delete");
        return deleteDoc(itemDoc.ref);
      })
  );

  await Promise.all(
    rows.map((row) => {
      const rowRef = doc(dayRef, name, row.id);
      debugPermissionWrite(debugContext ?? { module: "expense", source: "sync-day-subcollection", pathMode: "client-save" }, rowRef.path, "set");
      return setDoc(rowRef, cleanForFirestore(row), { merge: true });
    })
  );
}

async function syncCreditSubcollectionInBatch(
  batch: FirestoreBatchWriter,
  dayRef: ReturnType<typeof doc>,
  credits: DailyLedgerInput["credits"],
  merge = true,
  debugContext?: PermissionDebugContext
) {
  const existingSnap = await getDocs(collection(dayRef, "credits"));
  const nextIds = new Set(credits.map((credit) => credit.id));
  for (const creditDoc of existingSnap.docs) {
    if (!nextIds.has(creditDoc.id)) {
      debugPermissionWrite(debugContext ?? { module: "expense", source: "sync-credit-batch", pathMode: "client-save" }, creditDoc.ref.path, "delete");
      batch.delete(creditDoc.ref);
    }
  }
  for (const credit of credits) {
    const creditRef = doc(dayRef, "credits", credit.id);
    debugPermissionWrite(debugContext ?? { module: "expense", source: "sync-credit-batch", pathMode: "client-save" }, creditRef.path, "set");
    batch.set(creditRef, cleanForFirestore(credit), { merge });
  }
}

function ledgerV2ExpenseRawEntriesPath(monthId: string, dayNo: number) {
  return collection(requireDb(), "ledgerV2", "expense", "months", monthId, "days", String(dayNo), "rawEntries");
}

function ledgerV2ExpenseDayPath(monthId: string, dayNo: number) {
  return doc(requireDb(), "ledgerV2", "expense", "months", monthId, "days", String(dayNo));
}

function expenseRawNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function hydrateExpenseV2Day(monthId: string, dayNo: number): Promise<DailyLedgerInput> {
  const [legacyDaySnap, rawSnap, projectionSnap] = await Promise.all([
    getDoc(doc(requireDb(), "months", monthId, "days", String(dayNo))),
    getDocs(ledgerV2ExpenseRawEntriesPath(monthId, dayNo)),
    getDocs(collection(ledgerV2ExpenseDayPath(monthId, dayNo), "projections"))
  ]);
  const legacyDay = legacyDaySnap.exists() ? mapDayDoc(legacyDaySnap as QueryDocumentSnapshot<DocumentData>) : null;
  const expenses: DailyLedgerInput["expenses"] = [];
  const commissions: DailyLedgerInput["commissions"] = [];
  const ownerBalances: DailyLedgerInput["ownerBalances"] = [];
  const creditRawEntries: ExpenseCreditRawEntry[] = [];

  rawSnap.docs.forEach((entryDoc) => {
    const entry = entryDoc.data() as { id?: string; type?: string; raw?: Record<string, unknown> };
    const raw = entry.raw ?? {};
    const rawId = String(entry.id ?? entryDoc.id).replace(/^(expense|commission|credit|owner)-/, "");
    if (entry.type === "expense") {
      expenses.push({
        id: rawId,
        name: String(raw.name ?? ""),
        description: String(raw.description ?? ""),
        amount: expenseRawNumber(raw.amount),
        categoryId: typeof raw.categoryId === "string" ? raw.categoryId : undefined,
        category: typeof raw.category === "string" ? raw.category : undefined
      });
    } else if (entry.type === "commission") {
      commissions.push({
        id: rawId,
        categoryId: typeof raw.categoryId === "string" ? raw.categoryId : undefined,
        category: String(raw.category ?? ""),
        amount: expenseRawNumber(raw.amount)
      });
    } else if (entry.type === "ownerBalance") {
      ownerBalances.push({
        id: rawId,
        description: String(raw.description ?? ""),
        label: typeof raw.label === "string" ? raw.label : undefined,
        amount: expenseRawNumber(raw.amount),
        expense: expenseRawNumber(raw.expense),
        received: expenseRawNumber(raw.received)
      });
    } else if (entry.type === "credit") {
      creditRawEntries.push({
        ...(entryDoc.data() as ExpenseCreditRawEntry),
        id: String(entry.id ?? entryDoc.id),
        monthId,
        dayNo,
        raw: raw as ExpenseCreditRawEntry["raw"]
      });
    }
  });

  const projections = projectionSnap.docs
    .map((projectionDoc) => ({ id: projectionDoc.id, ...projectionDoc.data() }) as ExpenseCreditProjection)
    .filter((projection) => projection.calculated && projection.partyId);
  const credits = projectionToLegacyCreditRows({ dayNo, rawEntries: creditRawEntries, projections, summary: {
    opening: 0,
    loan: 0,
    receive: 0,
    manualAdjustment: 0,
    delta: 0,
    closing: 0
  } });

  return {
    dayNo,
    date: legacyDay?.date,
    label: legacyDay?.label ?? `Day ${dayNo}`,
    notes: legacyDay?.notes,
    importType: legacyDay?.importType,
    entryYear: legacyDay?.entryYear,
    entryMonth: legacyDay?.entryMonth,
    entryDay: legacyDay?.entryDay,
    status: legacyDay?.status ?? "open",
    manualOverride: legacyDay?.manualOverride ?? false,
    lockedAt: legacyDay?.lockedAt,
    lockedBy: legacyDay?.lockedBy,
    lockedByRole: legacyDay?.lockedByRole,
    reopenedUntilAt: legacyDay?.reopenedUntilAt,
    reopenedAt: legacyDay?.reopenedAt,
    reopenedBy: legacyDay?.reopenedBy,
    reopenedByRole: legacyDay?.reopenedByRole,
    updatedAt: legacyDay?.updatedAt,
    expenses,
    commissions,
    credits,
    ownerBalances
  };
}

async function fetchExpenseV2MonthDays(monthId: string): Promise<DailyLedgerInput[]> {
  const daysSnap = await getDocs(query(collection(requireDb(), "ledgerV2", "expense", "months", monthId, "days"), orderBy("dayNo")));
  if (daysSnap.empty) {
    throw new Error(`ledgerV2 Expense projections are missing for ${monthId}. Run and review master refresh before enabling v2 UI reads.`);
  }
  const days = await Promise.all(daysSnap.docs.map((dayDoc) => hydrateExpenseV2Day(monthId, Number(dayDoc.data().dayNo ?? dayDoc.id))));
  return days.sort((a, b) => a.dayNo - b.dayNo);
}

function expenseRawEntryPayload(input: {
  id: string;
  type: "expense" | "commission" | "credit" | "ownerBalance";
  monthId: string;
  dayNo: number;
  raw: Record<string, unknown>;
  timestamp: number;
}) {
  return cleanForFirestore({
    id: input.id,
    module: "expense",
    type: input.type,
    monthId: input.monthId,
    dayNo: input.dayNo,
    raw: input.raw,
    calculated: null,
    meta: {
      updatedAt: input.timestamp,
      updatedBy: auth?.currentUser?.uid ?? "unknown",
      status: typeof navigator !== "undefined" && navigator.onLine ? "pending" : "preview",
      calculationVersion: LEDGER_CALC_VERSION
    }
  });
}

async function syncExpenseLedgerV2RawEntriesInBatch(
  batch: FirestoreBatchWriter,
  monthId: string,
  day: DailyLedgerInput,
  timestamp: number,
  debugContext?: PermissionDebugContext
) {
  const rawEntries = [
    ...day.expenses.map((expense) => ({
      id: `expense-${expense.id}`,
      type: "expense" as const,
      raw: {
        name: expense.name,
        description: expense.description,
        amount: expense.amount,
        categoryId: expense.categoryId,
        category: expense.category
      }
    })),
    ...day.commissions.map((commission) => ({
      id: `commission-${commission.id}`,
      type: "commission" as const,
      raw: {
        categoryId: commission.categoryId,
        category: commission.category,
        amount: commission.amount
      }
    })),
    ...day.credits.map((credit) => ({
      id: `credit-${credit.id}`,
      type: "credit" as const,
      raw: {
        partyId: credit.partyId,
        partyNameSnapshot: credit.partyName,
        notes: credit.description,
        loanDescription: credit.loanDescription,
        receiveDescription: credit.receiveDescription,
        loan: credit.loan ?? credit.today ?? 0,
        receive: credit.receive,
        manualAdjustment: 0,
        source: "user"
      }
    })),
    ...day.ownerBalances.map((ownerBalance) => ({
      id: `owner-${ownerBalance.id}`,
      type: "ownerBalance" as const,
      raw: {
        description: ownerBalance.description,
        label: ownerBalance.label,
        expense: ownerBalance.expense ?? Math.max(ownerBalance.amount, 0),
        received: ownerBalance.received ?? Math.max(-ownerBalance.amount, 0),
        amount: ownerBalance.amount
      }
    }))
  ];
  const rawCollection = ledgerV2ExpenseRawEntriesPath(monthId, day.dayNo);
  const existingSnap = await getDocs(rawCollection);
  const nextIds = new Set(rawEntries.map((entry) => entry.id));
  for (const entryDoc of existingSnap.docs) {
    if (!nextIds.has(entryDoc.id)) {
      debugPermissionWrite(debugContext ?? { module: "expense", source: "expense-ledger-v2-raw-sync", pathMode: "client-save" }, entryDoc.ref.path, "delete");
      batch.delete(entryDoc.ref);
    }
  }
  for (const entry of rawEntries) {
    const entryRef = doc(rawCollection, entry.id);
    debugPermissionWrite(debugContext ?? { module: "expense", source: "expense-ledger-v2-raw-sync", pathMode: "client-save" }, entryRef.path, "set");
    batch.set(
      entryRef,
      expenseRawEntryPayload({
        id: entry.id,
        type: entry.type,
        monthId,
        dayNo: day.dayNo,
        raw: entry.raw,
        timestamp
      }),
      { merge: true }
    );
  }
}

export async function upsertDay(
  monthId: string,
  day: DailyLedgerInput,
  options?: {
    suppressPerDayAudit?: boolean;
    debugSource?: string;
    debugPathMode?: PermissionDebugPathMode;
    recalculationStamp?: ExpenseRecalculationStamp;
  }
): Promise<void> {
  const firestore = requireDb();
  const dayRef = doc(firestore, "months", monthId, "days", String(day.dayNo));
  const debugContext = {
    module: "expense" as const,
    source: options?.debugSource ?? "upsert-day",
    pathMode: options?.debugPathMode ?? "client-save"
  };
  debugPermissionWrite(debugContext, dayRef.path, "set");
  await setDoc(
    dayRef,
    cleanForFirestore({
      ...day,
      ...(options?.recalculationStamp ?? {}),
      updatedAt: now()
    }),
    { merge: true }
  );

  await syncDaySubcollection(dayRef, "expenses", day.expenses, debugContext);
  await syncDaySubcollection(dayRef, "commissions", day.commissions, debugContext);
  await syncDaySubcollection(dayRef, "credits", day.credits, debugContext);
  await syncDaySubcollection(dayRef, "ownerBalances", day.ownerBalances, debugContext);
  if (!options?.suppressPerDayAudit) {
    await addAudit(
      monthId,
      {
        action: "edit-day",
        detail: `Saved day ${day.dayNo}`,
        ...actor()
      },
      { dayNo: day.dayNo }
    );
  }
}

export async function fetchMonthDays(monthId: string, options: LedgerUiReadOptions = {}): Promise<DailyLedgerInput[]> {
  if (options.readDecision?.mode === "v2") {
    assertLedgerV2UiReadAllowed(options.readDecision);
    return fetchExpenseV2MonthDays(monthId);
  }

  const firestore = requireDb();
  const daysSnap = await getDocs(query(collection(firestore, "months", monthId, "days"), orderBy("dayNo")));
  const days: DailyLedgerInput[] = [];

  for (const dayDoc of daysSnap.docs) {
    const base = dayDoc.data() as Partial<DailyLedgerInput>;
    const dayNo = Number(base.dayNo ?? dayDoc.id);
    const [expenseSnap, commissionSnap, creditsSnap, ownerSnap] = await Promise.all([
      getDocs(collection(dayDoc.ref, "expenses")),
      getDocs(collection(dayDoc.ref, "commissions")),
      getDocs(collection(dayDoc.ref, "credits")),
      getDocs(collection(dayDoc.ref, "ownerBalances"))
    ]);
    days.push({
      dayNo,
      date: base.date,
      label: base.label,
      notes: base.notes,
      importType: base.importType,
      entryYear: base.entryYear,
      entryMonth: base.entryMonth,
      entryDay: base.entryDay,
      status: base.status ?? "open",
      manualOverride: base.manualOverride ?? false,
      lockedAt: base.lockedAt,
      lockedBy: base.lockedBy,
      lockedByRole: base.lockedByRole,
      reopenedUntilAt: base.reopenedUntilAt,
      reopenedAt: base.reopenedAt,
      reopenedBy: base.reopenedBy,
      reopenedByRole: base.reopenedByRole,
      updatedAt: base.updatedAt,
      expenses: mergeStoredRows(
        base.expenses,
        expenseSnap.docs.map((d) => d.data() as DailyLedgerInput["expenses"][number])
      ),
      commissions: mergeStoredRows(
        base.commissions,
        commissionSnap.docs.map((d) => d.data() as DailyLedgerInput["commissions"][number])
      ),
      credits: mergeCreditRowsForRead(
        base.credits,
        rowsFromDocs<DailyLedgerInput["credits"][number]>(creditsSnap.docs)
      ),
      ownerBalances: mergeStoredRows(
        base.ownerBalances,
        ownerSnap.docs.map((d) => d.data() as DailyLedgerInput["ownerBalances"][number])
      )
    });
  }

  return days.sort((a, b) => a.dayNo - b.dayNo);
}

function mapDayDoc(dayDoc: QueryDocumentSnapshot<DocumentData>): DailyLedgerInput {
  const base = dayDoc.data() as Partial<DailyLedgerInput>;
  const dayNo = Number(base.dayNo ?? dayDoc.id);
  return {
    dayNo,
    date: base.date,
    label: base.label,
    notes: base.notes,
    importType: base.importType,
    entryYear: base.entryYear,
    entryMonth: base.entryMonth,
    entryDay: base.entryDay,
    status: base.status ?? "open",
    manualOverride: base.manualOverride ?? false,
    lockedAt: base.lockedAt,
    lockedBy: base.lockedBy,
    lockedByRole: base.lockedByRole,
    reopenedUntilAt: base.reopenedUntilAt,
    reopenedAt: base.reopenedAt,
    reopenedBy: base.reopenedBy,
    reopenedByRole: base.reopenedByRole,
    updatedAt: base.updatedAt,
    expenses: Array.isArray(base.expenses) ? base.expenses : [],
    commissions: Array.isArray(base.commissions) ? base.commissions : [],
    credits: Array.isArray(base.credits) ? base.credits : [],
    ownerBalances: Array.isArray(base.ownerBalances) ? base.ownerBalances : []
  };
}

async function hydrateDayDoc(dayDoc: QueryDocumentSnapshot<DocumentData>): Promise<DailyLedgerInput> {
  const base = dayDoc.data() as Partial<DailyLedgerInput>;
  const mustCheckCreditsSubcollection = !Array.isArray(base.credits) || base.credits.length === 0;

  const [expenseSnap, commissionSnap, creditsSnap, ownerSnap] = await Promise.all([
    Array.isArray(base.expenses) ? Promise.resolve(null) : getDocs(collection(dayDoc.ref, "expenses")),
    Array.isArray(base.commissions) ? Promise.resolve(null) : getDocs(collection(dayDoc.ref, "commissions")),
    mustCheckCreditsSubcollection ? getDocs(collection(dayDoc.ref, "credits")) : Promise.resolve(null),
    Array.isArray(base.ownerBalances) ? Promise.resolve(null) : getDocs(collection(dayDoc.ref, "ownerBalances"))
  ]);
  const mapped = mapDayDoc(dayDoc);

  return {
    ...mapped,
    expenses: Array.isArray(base.expenses)
      ? mapped.expenses
      : (expenseSnap?.docs.map((d) => d.data() as DailyLedgerInput["expenses"][number]) ?? []),
    commissions: Array.isArray(base.commissions)
      ? mapped.commissions
      : (commissionSnap?.docs.map((d) => d.data() as DailyLedgerInput["commissions"][number]) ?? []),
    credits: mergeCreditRowsForRead(
      base.credits,
      creditsSnap ? rowsFromDocs<DailyLedgerInput["credits"][number]>(creditsSnap.docs) : []
    ),
    ownerBalances: Array.isArray(base.ownerBalances)
      ? mapped.ownerBalances
      : (ownerSnap?.docs.map((d) => d.data() as DailyLedgerInput["ownerBalances"][number]) ?? [])
  };
}

export function subscribeMonthDays(
  monthId: string,
  onNext: (days: DailyLedgerInput[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError | Error) => void,
  options: LedgerUiReadOptions = {}
) {
  if (options.readDecision?.mode === "v2") {
    try {
      assertLedgerV2UiReadAllowed(options.readDecision);
    } catch (error) {
      window.setTimeout(() => onError?.(error as Error), 0);
      return () => {};
    }
    return onSnapshot(
      query(collection(requireDb(), "ledgerV2", "expense", "months", monthId, "days"), orderBy("dayNo")),
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.empty) {
          onError?.(new Error(`ledgerV2 Expense projections are missing for ${monthId}. Run and review master refresh before enabling v2 UI reads.`));
          return;
        }
        void Promise.all(snap.docs.map((dayDoc) => hydrateExpenseV2Day(monthId, Number(dayDoc.data().dayNo ?? dayDoc.id))))
          .then((days) => onNext(days.sort((a, b) => a.dayNo - b.dayNo), snap.metadata))
          .catch((error: Error) => onError?.(error));
      },
      snapshotError(onError as (error: FirestoreError) => void)
    );
  }

  return onSnapshot(
    query(collection(requireDb(), "months", monthId, "days"), orderBy("dayNo")),
    { includeMetadataChanges: true },
    (snap) => {
      void Promise.all(snap.docs.map(hydrateDayDoc))
        .then((days) => onNext(days.sort((a, b) => a.dayNo - b.dayNo), snap.metadata))
        .catch((error: FirestoreError) => onError?.(error));
    },
    snapshotError(onError)
  );
}

export function subscribeLedgerMismatchReports(
  module: "expense" | "jazzLoad" | "stock",
  monthId: string,
  onNext: (reports: LedgerMismatchReportSummary[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    collection(requireDb(), "ledgerV2", module, "months", monthId, "mismatchReports"),
    { includeMetadataChanges: true },
    (snap) => {
      onNext(
        snap.docs
          .map((entry) => {
            const data = entry.data() as {
              module?: "expense" | "jazzLoad" | "stock";
              monthId?: string;
              status?: "open" | "repaired" | "ignored";
              issues?: unknown[];
              createdAt?: number;
            };
            return {
              id: entry.id,
              module,
              monthId: data.monthId ?? monthId,
              status: data.status ?? "open",
              issueCount: Array.isArray(data.issues) ? data.issues.length : 0,
              createdAt: data.createdAt ?? 0
            };
          })
          .filter((report) => report.status === "open" && report.issueCount > 0)
          .sort((a, b) => b.createdAt - a.createdAt),
        snap.metadata
      );
    },
    snapshotError(onError)
  );
}

export async function recalculateMonth(monthId: string): Promise<{ ok: boolean; dayCount: number; computed: MonthComputed }> {
  assertMasterRefreshAccess(auditActorRole, "Expense master refresh");
  const firestore = requireDb();
  const monthSnap = await getDoc(doc(firestore, "months", monthId));
  const storedMonth = monthSnap.exists() ? (monthSnap.data() as MonthRecord) : null;
  const carryForwardSeed = await resolveExpenseCarryForwardSeed(monthId);
  const effectiveOpeningBalance = carryForwardSeed?.openingBalance ?? storedMonth?.openingBalance ?? 0;
  const effectiveOwnerOpeningBalance = carryForwardSeed?.ownerOpeningBalance ??
    storedMonth?.ownerOpeningBalance ??
    defaultOwnerOpeningBalance;
  const sourceDays = await fetchMonthDays(monthId);
  const computed = computeMonth(
    sourceDays,
    effectiveOpeningBalance,
    monthId,
    effectiveOwnerOpeningBalance,
    carryForwardSeed ?? undefined
  );
  const inputByDay = new Map(sourceDays.map((day) => [day.dayNo, day]));
  const rebuiltDays: DailyLedgerInput[] = computed.days.map((computedDay) => {
    const sourceDay = inputByDay.get(computedDay.dayNo);
    return {
      ...(sourceDay ?? {
        dayNo: computedDay.dayNo,
        expenses: [],
        commissions: [],
        credits: [],
        ownerBalances: []
      }),
      dayNo: computedDay.dayNo,
      date: sourceDay?.date ?? computedDay.date,
      label: sourceDay?.label ?? computedDay.label,
      notes: sourceDay?.notes ?? computedDay.notes,
      expenses: sourceDay?.expenses ?? [],
      commissions: sourceDay?.commissions ?? [],
      credits: computedDay.creditRows,
      ownerBalances: computedDay.ownerBalances
    };
  });
  const month: MonthRecord = {
    ...(storedMonth ?? {
      id: monthId,
      label: monthId,
      status: "open" as const,
      createdAt: now()
    }),
    id: monthId,
    label: storedMonth?.label ?? monthId,
    openingBalance: effectiveOpeningBalance,
    ownerOpeningBalance: effectiveOwnerOpeningBalance
  };
  debugPermissionWrite(
    { module: "expense", source: "master-refresh-local", pathMode: "client-save" },
    `months/${monthId}`,
    "set"
  );
  const savedComputed = await saveMonthRecord(month, rebuiltDays, {
    suppressPerDayAudit: true,
    skipPostCommitUpsert: true,
    carryForwardSeed,
    recalculationWrite: true,
    debugSource: "master-refresh-local",
    debugPathMode: "client-save"
  });
  return { ok: true, dayCount: rebuiltDays.length, computed: savedComputed };
}

export async function sendManualActivityEmail(monthId: string, dayNo?: number): Promise<void> {
  void monthId;
  void dayNo;
  throw new Error("Manual email reports require an email backend and are disabled in local-only mode.");
}

export async function getMonthDashboard(monthId: string): Promise<MonthComputed | null> {
  const firestore = requireDb();
  const monthSnap = await getDoc(doc(firestore, "months", monthId));
  const month = monthSnap.exists() ? (monthSnap.data() as MonthRecord) : null;
  const days = await fetchMonthDays(monthId);
  if (!month && days.length === 0) return null;
  const carryForwardSeed = await resolveExpenseCarryForwardSeed(monthId);
  return computeMonth(
    days,
    carryForwardSeed?.openingBalance ?? month?.openingBalance ?? 0,
    monthId,
    carryForwardSeed?.ownerOpeningBalance ?? month?.ownerOpeningBalance ?? defaultOwnerOpeningBalance,
    carryForwardSeed ?? undefined
  );
}

export async function ensureMonth(monthId: string, openingBalance: number): Promise<void> {
  const firestore = requireDb();
  await setDoc(
    doc(firestore, "months", monthId),
    {
      id: monthId,
      label: monthId,
      openingBalance,
      status: "open",
      updatedAt: now(),
      createdAt: now()
    },
    { merge: true }
  );
}

export async function updateHomeSummary(monthId: string, summary: MonthComputed["homeSummary"]) {
  const firestore = requireDb();
  await setDoc(doc(firestore, "months", monthId, "summary", "home"), cleanForFirestore(summary), {
    merge: true
  });
  await updateDoc(doc(firestore, "months", monthId), { updatedAt: now() });
}

export async function readHomeSummary(monthId: string) {
  const firestore = requireDb();
  const summaryRef = doc(firestore, "months", monthId, "summary", "home");
  const snap = await getDoc(summaryRef);
  return snap.exists() ? snap.data() : null;
}

export async function saveDayAndRecalculate(
  monthId: string,
  openingBalance: number,
  ownerOpeningBalance: number,
  day: DailyLedgerInput
) {
  await ensureMonth(monthId, openingBalance);
  await upsertDay(monthId, day);
  const days = await fetchMonthDays(monthId);
  const carryForwardSeed = await resolveExpenseCarryForwardSeed(monthId);
  const computed = computeMonth(
    days,
    carryForwardSeed?.openingBalance ?? openingBalance,
    monthId,
    carryForwardSeed?.ownerOpeningBalance ?? ownerOpeningBalance,
    carryForwardSeed ?? undefined
  );
  await updateHomeSummary(monthId, computed.homeSummary);
  return computed;
}

export async function queueDayAndSummaryWrite(
  month: MonthRecord,
  day: DailyLedgerInput,
  computed: MonthComputed,
  auditAction: "edit-day" | "lock-day" = "edit-day"
) {
  const firestore = requireDb();
  const timestamp = now();
  const batch = writeBatch(firestore);
  const monthRef = doc(firestore, "months", month.id);
  const dayRef = doc(monthRef, "days", String(day.dayNo));
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const debugContext = {
    module: "expense" as const,
    source: `queue-day-and-summary-write:${auditAction}`,
    pathMode: "client-save" as const
  };

  debugPermissionWrite(debugContext, monthRef.path, "set");
  batch.set(monthRef, cleanForFirestore({ ...month, updatedAt: timestamp, createdAt: month.createdAt ?? timestamp }), { merge: true });
  debugPermissionWrite(debugContext, dayRef.path, "set");
  batch.set(dayRef, cleanForFirestore({ ...day, updatedAt: timestamp }), { merge: true });
  if (auditAction === "lock-day") {
    debugPermissionWrite(debugContext, dayRef.path, "set");
    batch.set(
      dayRef,
      {
        status: "closed",
        manualOverride: true,
        lockedAt: day.lockedAt ?? timestamp,
        lockedBy: day.lockedBy ?? auth?.currentUser?.uid,
        lockedByRole: day.lockedByRole,
        reopenedUntilAt: deleteField(),
        reopenedAt: deleteField(),
        reopenedBy: deleteField(),
        reopenedByRole: deleteField(),
        updatedAt: timestamp
      },
      { merge: true }
    );
  }
  for (const expense of day.expenses) {
    const expenseRef = doc(dayRef, "expenses", expense.id);
    debugPermissionWrite(debugContext, expenseRef.path, "set");
    batch.set(expenseRef, cleanForFirestore(expense), { merge: true });
  }
  for (const commission of day.commissions) {
    const commissionRef = doc(dayRef, "commissions", commission.id);
    debugPermissionWrite(debugContext, commissionRef.path, "set");
    batch.set(commissionRef, cleanForFirestore(commission), { merge: true });
  }
  await syncCreditSubcollectionInBatch(batch, dayRef, day.credits, true, debugContext);
  for (const ownerBalance of day.ownerBalances) {
    const ownerBalanceRef = doc(dayRef, "ownerBalances", ownerBalance.id);
    debugPermissionWrite(debugContext, ownerBalanceRef.path, "set");
    batch.set(ownerBalanceRef, cleanForFirestore(ownerBalance), { merge: true });
  }
  await syncExpenseLedgerV2RawEntriesInBatch(batch, month.id, day, timestamp, debugContext);
  const summaryRef = doc(monthRef, "summary", "home");
  debugPermissionWrite(debugContext, summaryRef.path, "set");
  batch.set(summaryRef, cleanForFirestore(computed.homeSummary), { merge: true });
  const auditDetail = auditAction === "lock-day" ? `Closed day ${day.dayNo}` : `Saved day ${day.dayNo}`;
  const auditEvent = {
    action: auditAction,
    detail: auditDetail,
    ...actor()
  } as Omit<AuditEvent, "id" | "createdAt">;
  const auditRef = doc(monthRef, "audit", auditId);
  debugPermissionWrite(debugContext, auditRef.path, "set");
  batch.set(auditRef, {
    id: auditId,
    createdAt: timestamp,
    ...auditEvent
  });
  if (auditAction !== "lock-day") {
    writeExpenseAuditLog(month.id, auditId, timestamp, auditEvent, {
      batch,
      dayNo: day.dayNo
    });
  }
  const rawAuditLog = buildAuditLogDocument(
    {
      id: `${auditId}-raw`,
      createdAt: timestamp,
      module: "expense",
      action: "RAW_ENTRY_SAVED",
      summary: `Saved raw Expense entries for day ${day.dayNo}`,
      monthId: month.id,
      dayNo: day.dayNo,
      date: day.date,
      targetType: "day",
      targetId: `${month.id}/${day.dayNo}`,
      sourcePath: `ledgerV2/expense/months/${month.id}/days/${day.dayNo}/rawEntries`,
      actorUid: actor().actorUid,
      actorEmail: actor().actorEmail,
      after: {
        expenses: day.expenses.length,
        commissions: day.commissions.length,
        credits: day.credits.length,
        ownerBalances: day.ownerBalances.length
      }
    },
    auditActorRole
  );
  if (rawAuditLog.actorUid && auditAction !== "lock-day") {
    const rawAuditRef = doc(firestore, "auditLogs", rawAuditLog.id);
    debugPermissionWrite(debugContext, rawAuditRef.path, "set");
    batch.set(rawAuditRef, rawAuditLog);
  }

  debugPermissionWrite(debugContext, "batch:queueDayAndSummaryWrite", "commit");
  await batch.commit();
  if (auditAction === "lock-day") {
    const auditWrites: Promise<unknown>[] = [
      writeExpenseAuditLog(month.id, auditId, timestamp, auditEvent, { dayNo: day.dayNo })
    ];
    if (rawAuditLog.actorUid) {
      auditWrites.push(writeAuditLog(rawAuditLog, { actorRole: auditActorRole }));
    }
    void Promise.allSettled(auditWrites).then((results) => {
      if (results.some((result) => result.status === "rejected")) {
        console.warn("Expense day closed, but a secondary audit log write failed.");
      }
    });
  }
}

export async function lockDayAndRecalculate(
  monthId: string,
  openingBalance: number,
  ownerOpeningBalance: number,
  day: DailyLedgerInput,
  role: UserRole | null
) {
  const unlockedDay = {
    ...day,
    lockedAt: undefined,
    lockedBy: undefined,
    lockedByRole: undefined,
    reopenedUntilAt: undefined,
    reopenedAt: undefined,
    reopenedBy: undefined,
    reopenedByRole: undefined
  };
  const lockedDay = {
    ...day,
    lockedAt: day.lockedAt ?? now(),
    lockedBy: day.lockedBy ?? auth?.currentUser?.uid,
    lockedByRole: day.lockedByRole ?? role ?? undefined
  };
  await ensureMonth(monthId, openingBalance);
  await upsertDay(monthId, unlockedDay);
  await setDoc(
    doc(requireDb(), "months", monthId, "days", String(day.dayNo)),
    {
      lockedAt: lockedDay.lockedAt,
      lockedBy: lockedDay.lockedBy,
      lockedByRole: lockedDay.lockedByRole,
      reopenedUntilAt: deleteField(),
      reopenedAt: deleteField(),
      reopenedBy: deleteField(),
      reopenedByRole: deleteField(),
      updatedAt: now()
    },
    { merge: true }
  );
  const days = await fetchMonthDays(monthId);
  const carryForwardSeed = await resolveExpenseCarryForwardSeed(monthId);
  const computed = computeMonth(
    days,
    carryForwardSeed?.openingBalance ?? openingBalance,
    monthId,
    carryForwardSeed?.ownerOpeningBalance ?? ownerOpeningBalance,
    carryForwardSeed ?? undefined
  );
  await updateHomeSummary(monthId, computed.homeSummary);
  await addAudit(monthId, {
    action: "lock-day",
    detail: `Closed day ${day.dayNo}`,
    ...actor()
  });
  return computed;
}

export async function reopenPreviousDayUntilClose(
  monthId: string,
  dayNo: number,
  role: UserRole | null
) {
  if (!canReopenDay(role)) throw new Error("Only owner can reopen days.");
  const reopenAt = now();
  await setDoc(
    doc(requireDb(), "months", monthId, "days", String(dayNo)),
    {
      status: "reopen",
      manualOverride: true,
      lockedAt: deleteField(),
      lockedBy: deleteField(),
      lockedByRole: deleteField(),
      reopenedUntilAt: deleteField(),
      reopenedAt: reopenAt,
      reopenedBy: auth?.currentUser?.uid,
      ...(role ? { reopenedByRole: role } : { reopenedByRole: deleteField() }),
      updatedAt: reopenAt
    },
    { merge: true }
  );
  await addAudit(monthId, {
    action: "reopen-day",
    detail: `Reopened day ${dayNo} until manual close`,
    ...actor()
  });
  return reopenAt;
}

export function reopenMonthDaysUntilClose(
  monthId: string,
  days: DailyLedgerInput[],
  role: UserRole | null
) {
  if (!canReopenDay(role)) throw new Error("Only owner can reopen days.");
  const firestore = requireDb();
  const reopenAt = now();
  const batch = writeBatch(firestore);
  const monthRef = doc(firestore, "months", monthId);
  const actorFields = actor();

  days.forEach((day) => {
    const payload = cleanForFirestore({
      ...day,
      status: "reopen" as const,
      manualOverride: true,
      lockedAt: undefined,
      lockedBy: undefined,
      lockedByRole: undefined,
      reopenedUntilAt: undefined,
      reopenedAt: reopenAt,
      reopenedBy: actorFields.actorUid,
      reopenedByRole: role ?? undefined,
      updatedAt: reopenAt
    });
    batch.set(
      doc(monthRef, "days", String(day.dayNo)),
      {
        ...payload,
        lockedAt: deleteField(),
        lockedBy: deleteField(),
        lockedByRole: deleteField(),
        reopenedUntilAt: deleteField(),
        ...(role ? {} : { reopenedByRole: deleteField() })
      },
      { merge: true }
    );
  });

  if (days.length > 0) {
    const auditId = `${reopenAt}-${Math.random().toString(36).slice(2, 8)}`;
    const dayText = days.length === 1 ? `day ${days[0].dayNo}` : `${days.length} days`;
    const auditEvent = {
      action: "reopen-day",
      detail: `Reopened ${dayText} until manual close`,
      ...actorFields
    } as Omit<AuditEvent, "id" | "createdAt">;

    batch.set(doc(monthRef, "audit", auditId), {
      id: auditId,
      createdAt: reopenAt,
      ...auditEvent
    });
    writeExpenseAuditLog(monthId, auditId, reopenAt, auditEvent, {
      batch,
      dayNo: days.length === 1 ? days[0].dayNo : undefined
    });
  }

  return batch.commit();
}

export const reopenPreviousDayFor15Minutes = reopenPreviousDayUntilClose;
export const reopenMonthDaysFor15Minutes = reopenMonthDaysUntilClose;

export function closeMonthDaysExceptToday(
  month: MonthRecord,
  days: DailyLedgerInput[],
  computed: MonthComputed,
  role: UserRole | null
) {
  const firestore = requireDb();
  const timestamp = now();
  const batch = writeBatch(firestore);
  const monthRef = doc(firestore, "months", month.id);
  const actorFields = actor();

  batch.set(monthRef, cleanForFirestore({ ...month, updatedAt: timestamp, createdAt: month.createdAt ?? timestamp }), { merge: true });

  days.forEach((day) => {
    const dayRef = doc(monthRef, "days", String(day.dayNo));
    const payload = cleanForFirestore({
      ...day,
      status: "closed" as const,
      manualOverride: true,
      lockedAt: day.lockedAt ?? timestamp,
      lockedBy: day.lockedBy ?? actorFields.actorUid,
      lockedByRole: day.lockedByRole ?? role ?? undefined,
      reopenedUntilAt: undefined,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedByRole: undefined,
      updatedAt: timestamp
    });
    batch.set(
      dayRef,
      {
        ...payload,
        reopenedUntilAt: deleteField(),
        reopenedAt: deleteField(),
        reopenedBy: deleteField(),
        reopenedByRole: deleteField()
      },
      { merge: true }
    );
  });

  batch.set(doc(monthRef, "summary", "home"), cleanForFirestore(computed.homeSummary), { merge: true });

  if (days.length > 0) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const auditEvent = {
      action: "lock-day",
      detail: `Closed ${days.length} day${days.length === 1 ? "" : "s"} except today`,
      ...actorFields
    } as Omit<AuditEvent, "id" | "createdAt">;

    batch.set(doc(monthRef, "audit", auditId), {
      id: auditId,
      createdAt: timestamp,
      ...auditEvent
    });
    writeExpenseAuditLog(month.id, auditId, timestamp, auditEvent, { batch });
  }

  return batch.commit();
}

export async function reopenCurrentDayUntilClose(
  monthId: string,
  dayNo: number,
  role: UserRole | null
) {
  if (!canReopenDay(role)) throw new Error("Only owner can reopen days.");
  const timestamp = now();
  await setDoc(
    doc(requireDb(), "months", monthId, "days", String(dayNo)),
    {
      status: "reopen",
      manualOverride: true,
      lockedAt: deleteField(),
      lockedBy: deleteField(),
      lockedByRole: deleteField(),
      reopenedUntilAt: deleteField(),
      reopenedAt: timestamp,
      reopenedBy: auth?.currentUser?.uid,
      ...(role ? { reopenedByRole: role } : { reopenedByRole: deleteField() }),
      updatedAt: timestamp
    },
    { merge: true }
  );
  await addAudit(monthId, {
    action: "reopen-day",
    detail: `Reopened current day ${dayNo} until manual close`,
    ...actor()
  });
}

export async function closePreviousDayReopenWindow(monthId: string, dayNo: number) {
  await setDoc(doc(requireDb(), "months", monthId, "days", String(dayNo)), {
    reopenedUntilAt: deleteField(),
    reopenedAt: deleteField(),
    reopenedBy: deleteField(),
    reopenedByRole: deleteField(),
    updatedAt: now()
  }, { merge: true });
  const actorFields = actor();
  if (actorFields.actorUid) {
    await writeAuditLog(
      {
        module: "expense",
        action: "reopen-window-close",
        summary: `Closed reopen window for day ${dayNo}`,
        monthId,
        dayNo,
        targetType: "day",
        targetId: String(dayNo),
        actorUid: actorFields.actorUid,
        actorEmail: actorFields.actorEmail
      },
      { actorRole: auditActorRole }
    );
  }
}

export function queueClosePreviousDayReopenWindow(monthId: string, dayNo: number) {
  return setDoc(doc(requireDb(), "months", monthId, "days", String(dayNo)), {
    reopenedUntilAt: deleteField(),
    reopenedAt: deleteField(),
    reopenedBy: deleteField(),
    reopenedByRole: deleteField(),
    updatedAt: now()
  }, { merge: true });
}

export async function commitWorkbookImport(preview: WorkbookImportPreview): Promise<MonthComputed> {
  const firestore = requireDb();
  const batch = writeBatch(firestore);
  const monthRef = doc(firestore, "months", preview.monthId);
  batch.set(
    monthRef,
    {
      id: preview.monthId,
      label: preview.monthId,
      openingBalance: preview.openingBalance,
      status: "open" satisfies MonthStatus,
      importedFileName: preview.fileName,
      updatedAt: now(),
      createdAt: now()
    },
    { merge: true }
  );

  for (const day of preview.days) {
    const dayRef = doc(monthRef, "days", String(day.dayNo));
    batch.set(dayRef, cleanForFirestore({ ...day, updatedAt: now() }), { merge: true });
    for (const expense of day.expenses) {
      batch.set(doc(dayRef, "expenses", expense.id), cleanForFirestore(expense));
    }
    for (const commission of day.commissions) {
      batch.set(doc(dayRef, "commissions", commission.id), cleanForFirestore(commission));
    }
    await syncCreditSubcollectionInBatch(batch, dayRef, day.credits, false);
    for (const ownerBalance of day.ownerBalances) {
      batch.set(doc(dayRef, "ownerBalances", ownerBalance.id), cleanForFirestore(ownerBalance));
    }
  }
  batch.set(doc(monthRef, "summary", "home"), cleanForFirestore(preview.computed.homeSummary), {
    merge: true
  });
  await batch.commit();
  await Promise.all(preview.days.map((day) => upsertDay(preview.monthId, day)));
  await addAudit(preview.monthId, {
    action: "import",
    detail: `Imported ${preview.fileName} with ${preview.days.length} day sheets`,
    ...actor()
  });
  return preview.computed;
}

export async function saveMonthRecord(
  month: MonthRecord,
  days: DailyLedgerInput[],
  options?: SaveMonthRecordOptions
): Promise<MonthComputed> {
  const firestore = requireDb();
  const computed = computeMonth(days, month.openingBalance, month.id, month.ownerOpeningBalance ?? 0, options?.carryForwardSeed ?? undefined);
  const batch = new ChunkedFirestoreBatch(firestore, `expense:${month.id}:saveMonthRecord`);
  const monthRef = doc(firestore, "months", month.id);
  const timestamp = now();
  const debugContext = {
    module: "expense" as const,
    source: options?.debugSource ?? "save-month-record",
    pathMode: options?.debugPathMode ?? "client-save"
  };
  const recalculationStamp: ExpenseRecalculationStamp | undefined = options?.recalculationWrite
    ? cleanForFirestore({
        recalculatedAt: timestamp,
        recalculatedBy: auth?.currentUser?.uid,
        recalculatedByRole: auditActorRole,
        recalculationSource: options.debugSource ?? "master-refresh-local-fallback"
      })
    : undefined;
  debugPermissionWrite(debugContext, monthRef.path, "set");
  batch.set(
    monthRef,
    {
      ...cleanForFirestore(month),
      updatedAt: timestamp
    },
    { merge: true }
  );

  const date = new Date();
  const year = date.getFullYear();
  const monthString = String(date.getMonth() + 1).padStart(2, "0");
  const liveMonthId = `${year}-${monthString}`;
  const liveDayNo = date.getDate();

  const isEditable = (day: DailyLedgerInput) => {
    const isLive = month.id === liveMonthId && day.dayNo === liveDayNo;
    const isReopened = isActiveReopenWindow(day);
    return (isLive && !day.lockedAt) || isReopened;
  };

  for (const day of days) {
    if (options?.onlyWriteEditableDays && !isEditable(day)) {
      continue;
    }
    const dayRef = doc(monthRef, "days", String(day.dayNo));
    debugPermissionWrite(debugContext, dayRef.path, "set");
    batch.set(dayRef, cleanForFirestore({ ...day, ...(recalculationStamp ?? {}), updatedAt: timestamp }), { merge: true });
    for (const expense of day.expenses) {
      const expenseRef = doc(dayRef, "expenses", expense.id);
      debugPermissionWrite(debugContext, expenseRef.path, "set");
      batch.set(expenseRef, cleanForFirestore(expense));
    }
    for (const commission of day.commissions) {
      const commissionRef = doc(dayRef, "commissions", commission.id);
      debugPermissionWrite(debugContext, commissionRef.path, "set");
      batch.set(commissionRef, cleanForFirestore(commission));
    }
    await syncCreditSubcollectionInBatch(batch, dayRef, day.credits, false, debugContext);
    for (const ownerBalance of day.ownerBalances) {
      const ownerBalanceRef = doc(dayRef, "ownerBalances", ownerBalance.id);
      debugPermissionWrite(debugContext, ownerBalanceRef.path, "set");
      batch.set(ownerBalanceRef, cleanForFirestore(ownerBalance));
    }
  }
  const summaryRef = doc(monthRef, "summary", "home");
  debugPermissionWrite(debugContext, summaryRef.path, "set");
  batch.set(summaryRef, cleanForFirestore(computed.homeSummary), { merge: true });
  debugPermissionWrite(debugContext, "batch:saveMonthRecord", "commit");
  await batch.commit();
  if (options?.skipPostCommitUpsert) return computed;

  const daysToUpsert = options?.onlyWriteEditableDays ? days.filter(isEditable) : days;
  await Promise.all(daysToUpsert.map((day) => upsertDay(month.id, day, {
    suppressPerDayAudit: options?.suppressPerDayAudit,
    debugSource: `${debugContext.source}:upsert`,
    debugPathMode: debugContext.pathMode,
    recalculationStamp
  })));
  return computed;
}

export async function setMonthStatus(monthId: string, status: MonthStatus) {
  const firestore = requireDb();
  await updateDoc(doc(firestore, "months", monthId), { status, updatedAt: now() });
  await addAudit(monthId, {
    action: status === "closed" ? "close-month" : "reopen-month",
    detail: status === "closed" ? "Closed month" : "Reopened month",
    ...actor()
  });
}

export async function deleteMonth(monthId: string) {
  const firestore = requireDb();
  await deleteDoc(doc(firestore, "months", monthId));
}
