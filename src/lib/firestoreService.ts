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
  if (snap.exists()) return (snap.data().role as UserRole) ?? "staff";

  const firstUserRole: UserRole = "owner";
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
      notes: base.notes,
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
