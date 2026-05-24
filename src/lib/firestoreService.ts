import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  orderBy,
  setDoc,
  updateDoc,
  writeBatch
} from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { auth, db, functions } from "./firebase";
import { computeMonth } from "./formulaEngine";
import type {
  AuditEvent,
  DailyLedgerInput,
  MonthComputed,
  MonthRecord,
  MonthStatus,
  CatalogItem,
  UserProfile,
  UserRole,
  WorkbookImportPreview
} from "../types/ledger";

function now() {
  return Date.now();
}

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

function actor() {
  return {
    actorUid: auth?.currentUser?.uid,
    actorEmail: auth?.currentUser?.email ?? null
  };
}

async function addAudit(monthId: string, event: Omit<AuditEvent, "id" | "createdAt">) {
  const firestore = requireDb();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await setDoc(doc(firestore, "months", monthId, "audit", id), {
    id,
    createdAt: now(),
    ...event
  });
}

export async function getUserRole(uid: string, email?: string | null): Promise<UserRole> {
  const firestore = requireDb();
  const ref = doc(firestore, "users", uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    const role = snap.data().role;
    return role === "staff" ? "admin" : ((role as UserRole) ?? "viewer");
  }

  const firstUserRole: UserRole = "viewer";
  await setDoc(ref, {
    uid,
    email: email ?? "",
    role: firstUserRole,
    active: true,
    createdAt: now(),
    updatedAt: now()
  });
  return firstUserRole;
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

export async function updateUserProfile(uid: string, updates: Pick<UserProfile, "role" | "active">) {
  const firestore = requireDb();
  await updateDoc(doc(firestore, "users", uid), {
    ...updates,
    updatedAt: now()
  });
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
  if (role === "admin") return permission === "daily" || permission === "catalogs" || permission === "importBackup";
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

export async function listMonths(): Promise<MonthRecord[]> {
  const firestore = requireDb();
  const snap = await getDocs(query(collection(firestore, "months"), orderBy("id", "desc")));
  return snap.docs.map((monthDoc) => monthDoc.data() as MonthRecord);
}

export async function upsertDay(monthId: string, day: DailyLedgerInput): Promise<void> {
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

  for (const expense of day.expenses) {
    await setDoc(doc(dayRef, "expenses", expense.id), cleanForFirestore(expense), { merge: true });
  }
  for (const commission of day.commissions) {
    await setDoc(doc(dayRef, "commissions", commission.id), cleanForFirestore(commission), { merge: true });
  }
  for (const credit of day.credits) {
    await setDoc(doc(dayRef, "credits", credit.id), cleanForFirestore(credit), { merge: true });
  }
  for (const ownerBalance of day.ownerBalances) {
    await setDoc(doc(dayRef, "ownerBalances", ownerBalance.id), cleanForFirestore(ownerBalance), { merge: true });
  }
  await addAudit(monthId, {
    action: "edit-day",
    detail: `Saved day ${day.dayNo}`,
    ...actor()
  });
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
      updatedAt: base.updatedAt,
      expenses: expenseSnap.docs.map((d) => d.data() as DailyLedgerInput["expenses"][number]),
      commissions: commissionSnap.docs.map(
        (d) => d.data() as DailyLedgerInput["commissions"][number]
      ),
      credits: creditsSnap.docs.map((d) => d.data() as DailyLedgerInput["credits"][number]),
      ownerBalances: ownerSnap.docs.map(
        (d) => d.data() as DailyLedgerInput["ownerBalances"][number]
      )
    });
  }

  return days.sort((a, b) => a.dayNo - b.dayNo);
}

export async function recalculateMonth(monthId: string): Promise<void> {
  const fn = httpsCallable(requireFunctions(), "recalculateMonth");
  await fn({ monthId });
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
  day: DailyLedgerInput
) {
  await ensureMonth(monthId, openingBalance);
  await upsertDay(monthId, day);
  const days = await fetchMonthDays(monthId);
  const computed = computeMonth(days, openingBalance, monthId);
  await updateHomeSummary(monthId, computed.homeSummary);
  return computed;
}

export async function lockDayAndRecalculate(
  monthId: string,
  openingBalance: number,
  day: DailyLedgerInput,
  role: UserRole | null
) {
  const unlockedDay = {
    ...day,
    lockedAt: undefined,
    lockedBy: undefined,
    lockedByRole: undefined
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
    cleanForFirestore({
      lockedAt: lockedDay.lockedAt,
      lockedBy: lockedDay.lockedBy,
      lockedByRole: lockedDay.lockedByRole,
      updatedAt: now()
    }),
    { merge: true }
  );
  const days = await fetchMonthDays(monthId);
  const computed = computeMonth(days, openingBalance, monthId);
  await updateHomeSummary(monthId, computed.homeSummary);
  await addAudit(monthId, {
    action: "lock-day",
    detail: `Closed day ${day.dayNo}`,
    ...actor()
  });
  return computed;
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
    for (const credit of day.credits) batch.set(doc(dayRef, "credits", credit.id), cleanForFirestore(credit));
    for (const ownerBalance of day.ownerBalances) {
      batch.set(doc(dayRef, "ownerBalances", ownerBalance.id), cleanForFirestore(ownerBalance));
    }
  }
  batch.set(doc(monthRef, "summary", "home"), cleanForFirestore(preview.computed.homeSummary), {
    merge: true
  });
  await batch.commit();
  await addAudit(preview.monthId, {
    action: "import",
    detail: `Imported ${preview.fileName} with ${preview.days.length} day sheets`,
    ...actor()
  });
  return preview.computed;
}

export async function saveMonthRecord(
  month: MonthRecord,
  days: DailyLedgerInput[]
): Promise<MonthComputed> {
  const firestore = requireDb();
  const computed = computeMonth(days, month.openingBalance, month.id);
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
  for (const day of days) {
    const dayRef = doc(monthRef, "days", String(day.dayNo));
    batch.set(dayRef, cleanForFirestore({ ...day, updatedAt: now() }), { merge: true });
    for (const expense of day.expenses) {
      batch.set(doc(dayRef, "expenses", expense.id), cleanForFirestore(expense));
    }
    for (const commission of day.commissions) {
      batch.set(doc(dayRef, "commissions", commission.id), cleanForFirestore(commission));
    }
    for (const credit of day.credits) batch.set(doc(dayRef, "credits", credit.id), cleanForFirestore(credit));
    for (const ownerBalance of day.ownerBalances) {
      batch.set(doc(dayRef, "ownerBalances", ownerBalance.id), cleanForFirestore(ownerBalance));
    }
  }
  batch.set(doc(monthRef, "summary", "home"), cleanForFirestore(computed.homeSummary), { merge: true });
  await batch.commit();
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
