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
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "./firebase";
import { buildAuditLogDocument, writeAuditLog } from "./auditLogService";
import { computeMonth } from "./formulaEngine";
import type {
  AuditEvent,
  AuthorizedEmail,
  DailyLedgerInput,
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

function requireDb() {
  if (!db) throw new Error("Firebase is not configured.");
  return db;
}

function requireFunctions() {
  if (!functions) throw new Error("Firebase is not configured.");
  return functions;
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
  options?: { actorRole?: UserRole; batch?: ReturnType<typeof writeBatch>; dayNo?: number }
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
  sortOrder: index
}));

function catalogCollection(name: "expenseCategories" | "creditParties" | "commissionCategories") {
  return collection(requireDb(), "settings", name, "items");
}

export async function listCatalogItems(
  name: "expenseCategories" | "creditParties" | "commissionCategories"
): Promise<CatalogItem[]> {
  const snap = await getDocs(query(catalogCollection(name), orderBy("sortOrder", "asc")));
  return snap.docs.map((itemDoc) => itemDoc.data() as CatalogItem);
}

export function subscribeCatalogItems(
  name: "expenseCategories" | "creditParties" | "commissionCategories",
  onNext: (items: CatalogItem[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(catalogCollection(name), orderBy("sortOrder", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((itemDoc) => itemDoc.data() as CatalogItem), snap.metadata),
    snapshotError(onError)
  );
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
          sortOrder: index
        })
      )
    );
  }
  if (commissions.length === 0) {
    await Promise.all(defaultCommissionCatalog.map((item) => upsertCatalogItem("commissionCategories", item)));
  }
}

export function roleCan(role: UserRole | null, permission: "daily" | "catalogs" | "users" | "ownerControls" | "importBackup" | "read") {
  if (!role) return false;
  if (permission === "read") return true;
  if (role === "owner") return true;
  if (role === "admin") {
    return permission === "daily" || permission === "ownerControls" || permission === "importBackup";
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
  const previousId = previousMonthId(monthId);
  if (!previousId) return 0;
  const previousDays = await fetchMonthDays(previousId).catch(() => []);
  const previousMonth = (await getDoc(doc(requireDb(), "months", previousId))).data() as MonthRecord | undefined;
  const computed = computeMonth(previousDays, previousMonth?.openingBalance ?? 0, previousId);
  return computed.days.find((day) => day.dayNo === 32)?.returnBalance ?? 0;
}

export async function resolveOwnerOpeningBalance(monthId: string): Promise<number> {
  const previousId = previousMonthId(monthId);
  if (!previousId) return defaultOwnerOpeningBalance;
  const previousDays = await fetchMonthDays(previousId).catch(() => []);
  const previousMonth = (await getDoc(doc(requireDb(), "months", previousId))).data() as MonthRecord | undefined;
  if (!previousMonth && previousDays.length === 0) {
    return defaultOwnerOpeningBalance;
  }
  const computed = computeMonth(previousDays, previousMonth?.openingBalance ?? 0, previousId);
  return computed.days.at(-1)?.ownerBalanceTotal ?? previousMonth?.ownerOpeningBalance ?? defaultOwnerOpeningBalance;
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
  rows: T[]
) {
  const existingSnap = await getDocs(collection(dayRef, name));
  const nextIds = new Set(rows.map((row) => row.id));

  await Promise.all(
    existingSnap.docs
      .filter((itemDoc) => !nextIds.has(itemDoc.id))
      .map((itemDoc) => deleteDoc(itemDoc.ref))
  );

  await Promise.all(
    rows.map((row) => setDoc(doc(dayRef, name, row.id), cleanForFirestore(row), { merge: true }))
  );
}

async function syncCreditSubcollectionInBatch(
  batch: ReturnType<typeof writeBatch>,
  dayRef: ReturnType<typeof doc>,
  credits: DailyLedgerInput["credits"],
  merge = true
) {
  const existingSnap = await getDocs(collection(dayRef, "credits"));
  const nextIds = new Set(credits.map((credit) => credit.id));
  for (const creditDoc of existingSnap.docs) {
    if (!nextIds.has(creditDoc.id)) batch.delete(creditDoc.ref);
  }
  for (const credit of credits) {
    batch.set(doc(dayRef, "credits", credit.id), cleanForFirestore(credit), { merge });
  }
}

export async function upsertDay(
  monthId: string,
  day: DailyLedgerInput,
  options?: { suppressPerDayAudit?: boolean }
): Promise<void> {
  const firestore = requireDb();
  const dayRef = doc(firestore, "months", monthId, "days", String(day.dayNo));
  await setDoc(
    dayRef,
    cleanForFirestore({
      ...day,
      updatedAt: now()
    }),
    { merge: true }
  );

  await syncDaySubcollection(dayRef, "expenses", day.expenses);
  await syncDaySubcollection(dayRef, "commissions", day.commissions);
  await syncDaySubcollection(dayRef, "credits", day.credits);
  await syncDaySubcollection(dayRef, "ownerBalances", day.ownerBalances);
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

export async function fetchMonthDays(monthId: string): Promise<DailyLedgerInput[]> {
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
  onError?: (error: FirestoreError) => void
) {
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

export async function recalculateMonth(monthId: string): Promise<void> {
  const fn = httpsCallable(requireFunctions(), "recalculateMonth");
  await fn({ monthId });
}

export async function sendManualActivityEmail(monthId: string, dayNo?: number): Promise<void> {
  const fn = httpsCallable(requireFunctions(), "sendManualActivityEmail");
  await fn({ monthId, dayNo });
}

export async function getMonthDashboard(monthId: string): Promise<MonthComputed | null> {
  const fn = httpsCallable(requireFunctions(), "getMonthDashboard");
  const result = await fn({ monthId });
  return (result.data ?? null) as MonthComputed | null;
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
  const computed = computeMonth(days, openingBalance, monthId, ownerOpeningBalance);
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

  batch.set(monthRef, cleanForFirestore({ ...month, updatedAt: timestamp, createdAt: month.createdAt ?? timestamp }), { merge: true });
  batch.set(dayRef, cleanForFirestore({ ...day, updatedAt: timestamp }), { merge: true });
  if (auditAction === "lock-day") {
    batch.set(
      dayRef,
      {
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
  for (const expense of day.expenses) batch.set(doc(dayRef, "expenses", expense.id), cleanForFirestore(expense), { merge: true });
  for (const commission of day.commissions) batch.set(doc(dayRef, "commissions", commission.id), cleanForFirestore(commission), { merge: true });
  await syncCreditSubcollectionInBatch(batch, dayRef, day.credits);
  for (const ownerBalance of day.ownerBalances) batch.set(doc(dayRef, "ownerBalances", ownerBalance.id), cleanForFirestore(ownerBalance), { merge: true });
  batch.set(doc(monthRef, "summary", "home"), cleanForFirestore(computed.homeSummary), { merge: true });
  const auditDetail = auditAction === "lock-day" ? `Closed day ${day.dayNo}` : `Saved day ${day.dayNo}`;
  const auditEvent = {
    action: auditAction,
    detail: auditDetail,
    ...actor()
  } as Omit<AuditEvent, "id" | "createdAt">;
  batch.set(doc(monthRef, "audit", auditId), {
    id: auditId,
    createdAt: timestamp,
    ...auditEvent
  });
  writeExpenseAuditLog(month.id, auditId, timestamp, auditEvent, {
    batch,
    dayNo: day.dayNo
  });

  return batch.commit();
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
  const computed = computeMonth(days, openingBalance, monthId, ownerOpeningBalance);
  await updateHomeSummary(monthId, computed.homeSummary);
  await addAudit(monthId, {
    action: "lock-day",
    detail: `Closed day ${day.dayNo}`,
    ...actor()
  });
  return computed;
}

export async function reopenPreviousDayFor15Minutes(
  monthId: string,
  dayNo: number,
  role: UserRole | null,
  reopenUntilAt?: number
) {
  const reopenAt = now();
  const reopenUntil = reopenUntilAt ?? reopenAt + 15 * 60 * 1000;
  await setDoc(
    doc(requireDb(), "months", monthId, "days", String(dayNo)),
    cleanForFirestore({
      reopenedUntilAt: reopenUntil,
      reopenedAt: reopenAt,
      reopenedBy: auth?.currentUser?.uid,
      reopenedByRole: role ?? undefined,
      updatedAt: reopenAt
    }),
    { merge: true }
  );
  await addAudit(monthId, {
    action: "reopen-day",
    detail: `Reopened day ${dayNo} until ${new Date(reopenUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    ...actor()
  });
  return reopenUntil;
}

export function reopenMonthDaysFor15Minutes(
  monthId: string,
  days: DailyLedgerInput[],
  role: UserRole | null,
  reopenUntilAt?: number
) {
  const firestore = requireDb();
  const reopenAt = now();
  const reopenUntil = reopenUntilAt ?? reopenAt + 15 * 60 * 1000;
  const batch = writeBatch(firestore);
  const monthRef = doc(firestore, "months", monthId);
  const actorFields = actor();

  days.forEach((day) => {
    batch.set(
      doc(monthRef, "days", String(day.dayNo)),
      cleanForFirestore({
        ...day,
        reopenedUntilAt: reopenUntil,
        reopenedAt: reopenAt,
        reopenedBy: actorFields.actorUid,
        reopenedByRole: role ?? undefined,
        updatedAt: reopenAt
      }),
      { merge: true }
    );
  });

  if (days.length > 0) {
    const auditId = `${reopenAt}-${Math.random().toString(36).slice(2, 8)}`;
    const dayText = days.length === 1 ? `day ${days[0].dayNo}` : `${days.length} days`;
    const auditEvent = {
      action: "reopen-day",
      detail: `Reopened ${dayText} until ${new Date(reopenUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
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
  await setDoc(
    doc(requireDb(), "months", monthId, "days", String(dayNo)),
    {
      lockedAt: deleteField(),
      lockedBy: deleteField(),
      lockedByRole: deleteField(),
      reopenedUntilAt: deleteField(),
      reopenedAt: now(),
      reopenedBy: auth?.currentUser?.uid,
      ...(role ? { reopenedByRole: role } : { reopenedByRole: deleteField() }),
      updatedAt: now()
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
  options?: { suppressPerDayAudit?: boolean; onlyWriteEditableDays?: boolean }
): Promise<MonthComputed> {
  const firestore = requireDb();
  const computed = computeMonth(days, month.openingBalance, month.id, month.ownerOpeningBalance ?? 0);
  const batch = writeBatch(firestore);
  const monthRef = doc(firestore, "months", month.id);
  batch.set(
    monthRef,
    {
      ...cleanForFirestore(month),
      updatedAt: now()
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
    const isReopened = Boolean(day.reopenedUntilAt && day.reopenedUntilAt > now());
    return (isLive && !day.lockedAt) || isReopened;
  };

  for (const day of days) {
    if (options?.onlyWriteEditableDays && !isEditable(day)) {
      continue;
    }
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
  batch.set(doc(monthRef, "summary", "home"), cleanForFirestore(computed.homeSummary), { merge: true });
  await batch.commit();

  const daysToUpsert = options?.onlyWriteEditableDays ? days.filter(isEditable) : days;
  await Promise.all(daysToUpsert.map((day) => upsertDay(month.id, day, { suppressPerDayAudit: options?.suppressPerDayAudit })));
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
