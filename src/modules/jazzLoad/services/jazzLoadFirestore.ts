import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  writeBatch,
  type FirestoreError,
  type SnapshotMetadata
} from "firebase/firestore";
import type { User } from "firebase/auth";
import { auth, db } from "../../../lib/firebase";
import { buildAuditLogDocument, writeAuditLog } from "../../../lib/auditLogService";
import type { UserRole } from "../../../types/ledger";
import {
  calculateDailyLifting,
  calculateDailySummary,
  calculateDoRow,
  calculateMonthlySummary
} from "./jazzLoadCalculations";
import type {
  ActiveJazzLoadRates,
  JazzLoadAuditEvent,
  JazzLoadBackup,
  JazzLoadCommissionRule,
  JazzLoadDoAssignment,
  JazzLoadDay,
  JazzLoadDoEntry,
  JazzLoadDoLine,
  JazzLoadDoName,
  JazzLoadDoProfile,
  JazzLoadMonth,
  JazzLoadMonthlySummary,
  JazzLoadRateConfig
} from "../types/jazzLoad.types";

export type FirestoreSnapshotMeta = Pick<SnapshotMetadata, "fromCache" | "hasPendingWrites">;

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

function rateCollection() {
  return collection(requireDb(), "jazzLoadSettings", "rates", "items");
}

function commissionCollection() {
  return collection(requireDb(), "jazzLoadSettings", "commissionRules", "items");
}

function doProfileCollection() {
  return collection(requireDb(), "jazzLoadSettings", "doProfiles", "items");
}

function doNameCollection() {
  return collection(requireDb(), "jazzLoadSettings", "doNames", "items");
}

function doLineCollection() {
  return collection(requireDb(), "jazzLoadSettings", "doLines", "items");
}

function doAssignmentCollection(monthId: string, dayNo: number) {
  return collection(dayRef(monthId, dayNo), "doAssignments");
}

function settingsAuditCollection() {
  return collection(requireDb(), "jazzLoadSettings", "audit", "items");
}

function monthRef(monthId: string) {
  return doc(requireDb(), "jazzLoadMonths", monthId);
}

function dayRef(monthId: string, dayNo: number) {
  return doc(monthRef(monthId), "days", String(dayNo));
}

function auditRef(monthId: string, id = `${now()}-${Math.random().toString(36).slice(2, 8)}`) {
  return doc(monthRef(monthId), "audit", id);
}

function unifiedAuditRef(id: string) {
  return doc(requireDb(), "auditLogs", id);
}

function mapJazzSettingsAction(action: string) {
  if (action.includes("rate") || action.includes("commission-rule")) return "jazz-rate-change";
  return "jazz-do-change";
}

function jazzSettingsSummary(action: string, targetType: string, targetId: string) {
  return `${action.replace(/-/g, " ")} on ${targetType} ${targetId}`;
}

function stageUnifiedAudit(
  batch: ReturnType<typeof writeBatch>,
  input: Parameters<typeof buildAuditLogDocument>[0],
  actorRole: UserRole
) {
  const log = buildAuditLogDocument(input, actorRole);
  batch.set(unifiedAuditRef(log.id), log);
}

async function writeUnifiedAudit(
  input: Parameters<typeof buildAuditLogDocument>[0],
  actorRole: UserRole
) {
  await writeAuditLog(input, { actorRole });
}

function mapDayData(data: Partial<JazzLoadDay>, id: string): JazzLoadDay {
  const doEntries = Array.isArray(data.doEntries) ? data.doEntries : [];
  const fallbackSummary = calculateDailySummary({ doEntries });
  return {
    id,
    monthId: data.monthId ?? "",
    dayNo: Number(data.dayNo ?? id),
    date: data.date ?? "",
    status: data.status ?? "open",
    doEntries,
    lifting: data.lifting ?? {
      openingBalance: 0,
      mlLifting: 0,
      totalBalance: 0,
      todayMlIssuance: fallbackSummary.issuanceMl,
      inHandBalance: -fallbackSummary.issuanceMl
    },
    summary: { ...fallbackSummary, ...(data.summary ?? {}) },
    appliedRates: data.appliedRates,
    notes: data.notes,
    createdBy: data.createdBy ?? "",
    updatedBy: data.updatedBy,
    createdAt: data.createdAt ?? 0,
    updatedAt: data.updatedAt ?? 0,
    closedAt: data.closedAt,
    closedBy: data.closedBy,
    reopenedAt: data.reopenedAt,
    reopenedBy: data.reopenedBy,
    reopenedUntilAt: data.reopenedUntilAt
  };
}

export function roleCanJazzLoad(
  role: UserRole | null,
  permission: "read" | "daily" | "settings" | "backup" | "monthControls"
) {
  if (!role) return false;
  if (permission === "read") return true;
  if (role === "owner") return true;
  if (role === "admin") return permission === "daily" || permission === "backup";
  return false;
}

export function subscribeJazzLoadRates(
  onNext: (rates: JazzLoadRateConfig[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(rateCollection(), orderBy("updatedAt", "desc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((rateDoc) => rateDoc.data() as JazzLoadRateConfig), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadCommissionRules(
  onNext: (rules: JazzLoadCommissionRule[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(commissionCollection(), orderBy("updatedAt", "desc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((ruleDoc) => ruleDoc.data() as JazzLoadCommissionRule), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDoProfiles(
  onNext: (profiles: JazzLoadDoProfile[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(doProfileCollection(), orderBy("name", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((profileDoc) => profileDoc.data() as JazzLoadDoProfile), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDoNames(
  onNext: (names: JazzLoadDoName[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(doNameCollection(), orderBy("name", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((nameDoc) => nameDoc.data() as JazzLoadDoName), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDoLines(
  onNext: (lines: JazzLoadDoLine[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(doLineCollection(), orderBy("line", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((lineDoc) => lineDoc.data() as JazzLoadDoLine), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDoAssignments(
  monthId: string,
  dayNo: number,
  onNext: (assignments: JazzLoadDoAssignment[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(doAssignmentCollection(monthId, dayNo), orderBy("doLine", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((assignmentDoc) => assignmentDoc.data() as JazzLoadDoAssignment), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadMonths(
  onNext: (months: JazzLoadMonth[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(requireDb(), "jazzLoadMonths"), orderBy("id", "desc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((item) => item.data() as JazzLoadMonth), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDays(
  monthId: string,
  onNext: (days: JazzLoadDay[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    query(collection(monthRef(monthId), "days"), orderBy("dayNo", "asc")),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((item) => mapDayData(item.data() as Partial<JazzLoadDay>, item.id)), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadMonthlySummary(
  monthId: string,
  onNext: (summary: JazzLoadMonthlySummary | null, metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    doc(monthRef(monthId), "summary", "monthly"),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.exists() ? (snap.data() as JazzLoadMonthlySummary) : null, snap.metadata),
    onError
  );
}

async function listJazzLoadDays(monthId: string) {
  const snap = await getDocs(query(collection(monthRef(monthId), "days"), orderBy("dayNo", "asc")));
  return snap.docs.map((item) => mapDayData(item.data() as Partial<JazzLoadDay>, item.id));
}

export async function loadJazzLoadDays(monthId: string) {
  return listJazzLoadDays(monthId);
}

export async function upsertJazzLoadRate(
  input: Omit<JazzLoadRateConfig, "createdBy" | "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadRateConfig, "createdBy" | "createdAt">>,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const rate: JazzLoadRateConfig = {
    ...input,
    createdBy: input.createdBy ?? currentActor.userId,
    createdAt: input.createdAt ?? timestamp,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(doc(rateCollection(), rate.id), cleanForFirestore(rate), { merge: true });
  batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
    id: auditId,
    action: "upsert-rate",
    ...currentActor,
    targetType: "rate",
    targetId: rate.id,
    after: rate,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "settings",
      action: "jazz-rate-change",
      summary: `Updated Jazz Load rate ${rate.id}`,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "rate",
      targetId: rate.id,
      sourcePath: `jazzLoadSettings/audit/items/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
}

export async function upsertJazzLoadCommissionRule(
  input: Omit<JazzLoadCommissionRule, "createdBy" | "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadCommissionRule, "createdBy" | "createdAt">>,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const rule: JazzLoadCommissionRule = {
    ...input,
    createdBy: input.createdBy ?? currentActor.userId,
    createdAt: input.createdAt ?? timestamp,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(doc(commissionCollection(), rule.id), cleanForFirestore(rule), { merge: true });
  batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
    id: auditId,
    action: "upsert-commission-rule",
    ...currentActor,
    targetType: "commissionRule",
    targetId: rule.id,
    after: rule,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "settings",
      action: "jazz-rate-change",
      summary: `Updated Jazz Load commission rule ${rule.id}`,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "commissionRule",
      targetId: rule.id,
      sourcePath: `jazzLoadSettings/audit/items/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
}

export async function upsertJazzLoadDoProfile(
  profile: Omit<JazzLoadDoProfile, "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadDoProfile, "createdAt">>,
  user?: User | null,
  role?: UserRole | null
) {
  const currentActor = user ? actor(user, role) : null;
  const timestamp = now();
  const nextProfile = { ...profile, createdAt: profile.createdAt ?? timestamp, updatedAt: timestamp };
  const batch = writeBatch(requireDb());
  batch.set(doc(doProfileCollection(), profile.id), cleanForFirestore(nextProfile), { merge: true });
  if (currentActor) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
      id: auditId,
      action: "upsert-do-profile",
      ...currentActor,
      targetType: "doProfile",
      targetId: profile.id,
      after: nextProfile,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "settings",
        action: mapJazzSettingsAction("upsert-do-profile"),
        summary: jazzSettingsSummary("upsert-do-profile", "doProfile", profile.id),
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "doProfile",
        targetId: profile.id,
        sourcePath: `jazzLoadSettings/audit/items/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }
  await batch.commit();
}

export async function upsertJazzLoadDoName(
  name: Omit<JazzLoadDoName, "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadDoName, "createdAt">>,
  user?: User | null,
  role?: UserRole | null
) {
  const currentActor = user ? actor(user, role) : null;
  const timestamp = now();
  const nextName = { ...name, createdAt: name.createdAt ?? timestamp, updatedAt: timestamp };
  const batch = writeBatch(requireDb());
  batch.set(doc(doNameCollection(), name.id), cleanForFirestore(nextName), { merge: true });
  if (currentActor) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
      id: auditId,
      action: "upsert-do-name",
      ...currentActor,
      targetType: "doName",
      targetId: name.id,
      after: nextName,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "settings",
        action: mapJazzSettingsAction("upsert-do-name"),
        summary: jazzSettingsSummary("upsert-do-name", "doName", name.id),
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "doName",
        targetId: name.id,
        sourcePath: `jazzLoadSettings/audit/items/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }
  await batch.commit();
}

export async function deleteJazzLoadDoName(
  id: string,
  user?: User | null,
  role?: UserRole | null
) {
  const currentActor = user ? actor(user, role) : null;
  const timestamp = now();
  const batch = writeBatch(requireDb());
  batch.delete(doc(doNameCollection(), id));
  if (currentActor) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
      id: auditId,
      action: "delete-do-name",
      ...currentActor,
      targetType: "doName",
      targetId: id,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "settings",
        action: mapJazzSettingsAction("delete-do-name"),
        summary: jazzSettingsSummary("delete-do-name", "doName", id),
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "doName",
        targetId: id,
        sourcePath: `jazzLoadSettings/audit/items/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }
  await batch.commit();
}

export async function upsertJazzLoadDoLine(
  line: Omit<JazzLoadDoLine, "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadDoLine, "createdAt">>,
  user?: User | null,
  role?: UserRole | null
) {
  const currentActor = user ? actor(user, role) : null;
  const timestamp = now();
  const nextLine = { ...line, createdAt: line.createdAt ?? timestamp, updatedAt: timestamp };
  const batch = writeBatch(requireDb());
  batch.set(doc(doLineCollection(), line.id), cleanForFirestore(nextLine), { merge: true });
  if (currentActor) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
      id: auditId,
      action: "upsert-do-line",
      ...currentActor,
      targetType: "doLine",
      targetId: line.id,
      after: nextLine,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "settings",
        action: mapJazzSettingsAction("upsert-do-line"),
        summary: jazzSettingsSummary("upsert-do-line", "doLine", line.id),
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "doLine",
        targetId: line.id,
        sourcePath: `jazzLoadSettings/audit/items/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }
  await batch.commit();
}

export async function deleteJazzLoadDoLine(
  id: string,
  user?: User | null,
  role?: UserRole | null
) {
  const currentActor = user ? actor(user, role) : null;
  const timestamp = now();
  const batch = writeBatch(requireDb());
  batch.delete(doc(doLineCollection(), id));
  if (currentActor) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
      id: auditId,
      action: "delete-do-line",
      ...currentActor,
      targetType: "doLine",
      targetId: id,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "settings",
        action: mapJazzSettingsAction("delete-do-line"),
        summary: jazzSettingsSummary("delete-do-line", "doLine", id),
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "doLine",
        targetId: id,
        sourcePath: `jazzLoadSettings/audit/items/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }
  await batch.commit();
}

export async function upsertJazzLoadDoAssignment(
  assignment: Omit<JazzLoadDoAssignment, "createdBy" | "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadDoAssignment, "createdBy" | "createdAt">>,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const nextAssignment: JazzLoadDoAssignment = {
    ...assignment,
    createdBy: assignment.createdBy ?? currentActor.userId,
    updatedBy: currentActor.userId,
    createdAt: assignment.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  batch.set(
    doc(doAssignmentCollection(nextAssignment.monthId, nextAssignment.dayNo), nextAssignment.id),
    cleanForFirestore(nextAssignment),
    { merge: true }
  );
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(auditRef(nextAssignment.monthId, auditId), cleanForFirestore({
    id: auditId,
    action: "assign-do-line",
    ...currentActor,
    targetType: "doAssignment",
    targetId: nextAssignment.id,
    after: nextAssignment,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "jazzLoad",
      action: "do-assignment",
      summary: `Assigned DO line ${nextAssignment.doLine} on day ${nextAssignment.dayNo}`,
      monthId: nextAssignment.monthId,
      dayNo: nextAssignment.dayNo,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "doAssignment",
      targetId: nextAssignment.id,
      sourcePath: `jazzLoadMonths/${nextAssignment.monthId}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
}

export async function deleteJazzLoadDoProfile(id: string) {
  await deleteDoc(doc(doProfileCollection(), id));
}

export async function ensureJazzLoadMonth(monthId: string, user: User | null, role: UserRole | null) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const month: JazzLoadMonth = {
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

export async function saveJazzLoadDay(
  month: JazzLoadMonth,
  day: JazzLoadDay,
  allDays: JazzLoadDay[],
  user: User | null,
  role: UserRole | null,
  action: "save-day" | "close-day" | "reopen-day" = "save-day"
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const nextDays = [...allDays.filter((item) => item.dayNo !== day.dayNo), day].sort((a, b) => a.dayNo - b.dayNo);
  const summary = calculateMonthlySummary(month.id, nextDays);
  const batch = writeBatch(requireDb());
  const nextMonth: JazzLoadMonth = {
    ...month,
    closingBalance: summary.totalClosingBase,
    totalMlIssuance: summary.totalIssuanceMl,
    totalPayments: summary.totalPaymentsBase,
    totalLifting: summary.totalLifting,
    totalCommission: summary.totalCommission,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const nextDay = {
    ...day,
    summary: day.summary,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const audit: JazzLoadAuditEvent = {
    id: auditId,
    action,
    ...currentActor,
    targetType: "day",
    targetId: `${month.id}/${day.dayNo}`,
    createdAt: timestamp
  };

  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  batch.set(dayRef(month.id, day.dayNo), cleanForFirestore(nextDay), { merge: true });
  for (const entry of nextDay.doEntries) {
    batch.set(doc(dayRef(month.id, day.dayNo), "doEntries", entry.id), cleanForFirestore(entry), { merge: true });
  }
  batch.set(doc(monthRef(month.id), "summary", "monthly"), cleanForFirestore(summary), { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore(audit));
  const summaryText =
    action === "close-day"
      ? `Closed Jazz Load day ${day.dayNo}`
      : action === "reopen-day"
        ? `Reopened Jazz Load day ${day.dayNo}`
        : `Saved Jazz Load day ${day.dayNo}`;
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "jazzLoad",
      action,
      summary: summaryText,
      monthId: month.id,
      dayNo: day.dayNo,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "day",
      targetId: `${month.id}/${day.dayNo}`,
      sourcePath: `jazzLoadMonths/${month.id}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
  return { month: nextMonth, day: nextDay, summary };
}

function matchingPreviousEntry(
  priorDays: JazzLoadDay[],
  entry: Pick<JazzLoadDoEntry, "doName" | "doLine" | "doNameId" | "doLineId" | "doProfileId">
) {
  for (let index = priorDays.length - 1; index >= 0; index -= 1) {
    const match = priorDays[index].doEntries.find((priorEntry) => {
      if (entry.doNameId && priorEntry.doNameId === entry.doNameId) return true;
      if (entry.doLineId && priorEntry.doLineId === entry.doLineId) return true;
      if (entry.doProfileId && priorEntry.doProfileId === entry.doProfileId) return true;
      return priorEntry.doName.trim().toLowerCase() === entry.doName.trim().toLowerCase() &&
        (priorEntry.doLine ?? "").trim().toLowerCase() === (entry.doLine ?? "").trim().toLowerCase();
    });
    if (match) return match;
  }
  return undefined;
}

function rechainJazzLoadDays(
  days: JazzLoadDay[],
  activeRates: ActiveJazzLoadRates,
  userId: string,
  timestamp: number
) {
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);
  const recalculatedDays: JazzLoadDay[] = [];

  for (const day of sortedDays) {
    const doEntries = day.doEntries.map((entry) => {
      const previous = matchingPreviousEntry(recalculatedDays, entry);
      return calculateDoRow(
        {
          id: entry.id,
          doProfileId: entry.doProfileId,
          doNameId: entry.doNameId,
          doLineId: entry.doLineId,
          assignmentId: entry.assignmentId,
          doLineSortOrder: entry.doLineSortOrder,
          doName: entry.doName,
          doLine: entry.doLine,
          openingBase: previous?.closingBalance.baseAmount ?? entry.openingBalance.baseAmount,
          todayMlIssuanceBase: entry.todayMlIssuance.baseAmount,
          paymentReceivedBase: entry.paymentReceived.baseAmount,
          notes: entry.notes
        },
        activeRates,
        { createdBy: userId, previous: entry, timestamp }
      );
    });
    const summary = calculateDailySummary({ doEntries }, activeRates, timestamp);
    const previousDay = recalculatedDays.at(-1);
    recalculatedDays.push({
      ...day,
      doEntries,
      summary,
      lifting: calculateDailyLifting(
        {
          openingBalance: previousDay?.lifting.inHandBalance ?? day.lifting.openingBalance,
          mlLifting: day.lifting.mlLifting
        },
        summary.issuanceMl
      ),
      updatedBy: userId,
      updatedAt: timestamp
    });
  }

  return recalculatedDays;
}

export function recalculateJazzLoadMonth(
  month: JazzLoadMonth,
  days: JazzLoadDay[],
  activeRates: ActiveJazzLoadRates,
  user: User | null,
  role: UserRole | null
) {
  if (!activeRates.mlRate) throw new Error("Active Jazz Load Addition Rate is required before recalculating.");
  const currentActor = actor(user, role);
  const timestamp = now();
  const recalculatedDays = rechainJazzLoadDays(days, activeRates, currentActor.userId, timestamp);
  const summary = calculateMonthlySummary(month.id, recalculatedDays);
  const batch = writeBatch(requireDb());
  const nextMonth: JazzLoadMonth = {
    ...month,
    closingBalance: summary.totalClosingBase,
    totalMlIssuance: summary.totalIssuanceMl,
    totalPayments: summary.totalPaymentsBase,
    totalLifting: summary.totalLifting,
    totalCommission: summary.totalCommission,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;

  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  recalculatedDays.forEach((day) => {
    batch.set(dayRef(month.id, day.dayNo), cleanForFirestore(day), { merge: true });
    day.doEntries.forEach((entry) => {
      batch.set(doc(dayRef(month.id, day.dayNo), "doEntries", entry.id), cleanForFirestore(entry), { merge: true });
    });
  });
  batch.set(doc(monthRef(month.id), "summary", "monthly"), cleanForFirestore(summary), { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore({
    id: auditId,
    action: "recalculate",
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
      module: "jazzLoad",
      action: "recalculate",
      summary: `Recalculated Jazz Load month ${month.id}`,
      monthId: month.id,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "month",
      targetId: month.id,
      sourcePath: `jazzLoadMonths/${month.id}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );

  return batch.commit().then(() => ({ month: nextMonth, days: recalculatedDays, summary }));
}

export function reopenJazzLoadDaysFor15Minutes(
  month: JazzLoadMonth,
  reopenedDays: JazzLoadDay[],
  allDays: JazzLoadDay[],
  user: User | null,
  role: UserRole | null,
  reopenUntilAt?: number
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const reopenUntil = reopenUntilAt ?? timestamp + 15 * 60 * 1000;
  const nextDays = allDays
    .map((day) => reopenedDays.find((item) => item.dayNo === day.dayNo) ?? day)
    .concat(reopenedDays.filter((day) => !allDays.some((item) => item.dayNo === day.dayNo)))
    .sort((a, b) => a.dayNo - b.dayNo);
  const summary = calculateMonthlySummary(month.id, nextDays);
  const batch = writeBatch(requireDb());
  const nextMonth: JazzLoadMonth = {
    ...month,
    closingBalance: summary.totalClosingBase,
    totalMlIssuance: summary.totalIssuanceMl,
    totalPayments: summary.totalPaymentsBase,
    totalLifting: summary.totalLifting,
    totalCommission: summary.totalCommission,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };

  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  reopenedDays.forEach((day) => {
    batch.set(
      dayRef(month.id, day.dayNo),
      cleanForFirestore({
        ...day,
        status: "closed",
        reopenedAt: timestamp,
        reopenedBy: currentActor.userId,
        reopenedUntilAt: reopenUntil,
        updatedBy: currentActor.userId,
        updatedAt: timestamp
      }),
      { merge: true }
    );
  });
  batch.set(doc(monthRef(month.id), "summary", "monthly"), cleanForFirestore(summary), { merge: true });

  if (reopenedDays.length > 0) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    const dayText = reopenedDays.length === 1 ? `day ${reopenedDays[0].dayNo}` : `${reopenedDays.length} days`;
    batch.set(auditRef(month.id, auditId), cleanForFirestore({
      id: auditId,
      action: "reopen-day",
      ...currentActor,
      targetType: reopenedDays.length === 1 ? "day" : "month",
      targetId: reopenedDays.length === 1 ? `${month.id}/${reopenedDays[0].dayNo}` : month.id,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "jazzLoad",
        action: "reopen-day",
        summary: `Reopened Jazz Load ${dayText}`,
        monthId: month.id,
        dayNo: reopenedDays.length === 1 ? reopenedDays[0].dayNo : undefined,
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: reopenedDays.length === 1 ? "day" : "month",
        targetId: reopenedDays.length === 1 ? `${month.id}/${reopenedDays[0].dayNo}` : month.id,
        sourcePath: `jazzLoadMonths/${month.id}/audit/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }

  return batch.commit();
}

export function closeJazzLoadDaysExceptToday(
  month: JazzLoadMonth,
  closedDays: JazzLoadDay[],
  allDays: JazzLoadDay[],
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const nextDays = allDays
    .map((day) => closedDays.find((item) => item.dayNo === day.dayNo) ?? day)
    .concat(closedDays.filter((day) => !allDays.some((item) => item.dayNo === day.dayNo)))
    .sort((a, b) => a.dayNo - b.dayNo);
  const summary = calculateMonthlySummary(month.id, nextDays);
  const batch = writeBatch(requireDb());
  const nextMonth: JazzLoadMonth = {
    ...month,
    closingBalance: summary.totalClosingBase,
    totalMlIssuance: summary.totalIssuanceMl,
    totalPayments: summary.totalPaymentsBase,
    totalLifting: summary.totalLifting,
    totalCommission: summary.totalCommission,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };

  batch.set(monthRef(month.id), cleanForFirestore(nextMonth), { merge: true });
  closedDays.forEach((day) => {
    const payload = cleanForFirestore({
      ...day,
      status: "closed",
      closedAt: day.closedAt ?? timestamp,
      closedBy: day.closedBy ?? currentActor.userId,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedUntilAt: undefined,
      updatedBy: currentActor.userId,
      updatedAt: timestamp
    });
    batch.set(
      dayRef(month.id, day.dayNo),
      {
        ...payload,
        reopenedAt: deleteField(),
        reopenedBy: deleteField(),
        reopenedUntilAt: deleteField()
      },
      { merge: true }
    );
  });
  batch.set(doc(monthRef(month.id), "summary", "monthly"), cleanForFirestore(summary), { merge: true });

  if (closedDays.length > 0) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(auditRef(month.id, auditId), cleanForFirestore({
      id: auditId,
      action: "close-day",
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
        module: "jazzLoad",
        action: "close-day",
        summary: `Closed ${closedDays.length} Jazz Load day${closedDays.length === 1 ? "" : "s"} except today`,
        monthId: month.id,
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "month",
        targetId: month.id,
        sourcePath: `jazzLoadMonths/${month.id}/audit/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }

  return batch.commit();
}

export async function setJazzLoadMonthStatus(
  month: JazzLoadMonth,
  status: "open" | "closed",
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  await updateDoc(monthRef(month.id), cleanForFirestore({
    status,
    updatedAt: timestamp,
    updatedBy: currentActor.userId,
    ...(status === "closed" ? { closedAt: timestamp, closedBy: currentActor.userId } : {})
  }));
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const monthAction = status === "closed" ? "close-month" : "reopen-month";
  await setDoc(auditRef(month.id, auditId), cleanForFirestore({
    id: auditId,
    action: monthAction,
    ...currentActor,
    targetType: "month",
    targetId: month.id,
    createdAt: timestamp
  }));
  await writeUnifiedAudit(
    {
      id: auditId,
      createdAt: timestamp,
      module: "jazzLoad",
      action: monthAction,
      summary: status === "closed" ? `Closed Jazz Load month ${month.id}` : `Reopened Jazz Load month ${month.id}`,
      monthId: month.id,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "month",
      targetId: month.id,
      sourcePath: `jazzLoadMonths/${month.id}/audit/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
}

export async function writeJazzLoadBackupRestoreAudit(monthCount: number, user: User | null, role: UserRole | null) {
  const currentActor = actor(user, role);
  await writeUnifiedAudit(
    {
      module: "jazzLoad",
      action: "backup-restore",
      summary: `Restored Jazz Load backup (${monthCount} month${monthCount === 1 ? "" : "s"})`,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail
    },
    currentActor.userRole ?? "viewer"
  );
}

export async function listJazzLoadBackup(): Promise<JazzLoadBackup> {
  const [monthsSnap, ratesSnap, rulesSnap, profilesSnap] = await Promise.all([
    getDocs(query(collection(requireDb(), "jazzLoadMonths"), orderBy("id", "desc"))),
    getDocs(query(rateCollection(), orderBy("updatedAt", "desc"))),
    getDocs(query(commissionCollection(), orderBy("updatedAt", "desc"))),
    getDocs(query(doProfileCollection(), orderBy("name", "asc")))
  ]);
  const [namesSnap, linesSnap] = await Promise.all([
    getDocs(query(doNameCollection(), orderBy("name", "asc"))),
    getDocs(query(doLineCollection(), orderBy("line", "asc")))
  ]);
  const months = monthsSnap.docs.map((item) => item.data() as JazzLoadMonth);
  const daysNested = await Promise.all(months.map((month) => listJazzLoadDays(month.id)));
  const assignmentsNested = await Promise.all(
    daysNested.flat().map(async (day) => {
      const snap = await getDocs(query(doAssignmentCollection(day.monthId, day.dayNo), orderBy("doLine", "asc")));
      return snap.docs.map((item) => item.data() as JazzLoadDoAssignment);
    })
  );
  return {
    months,
    days: daysNested.flat(),
    rates: ratesSnap.docs.map((item) => item.data() as JazzLoadRateConfig),
    commissionRules: rulesSnap.docs.map((item) => item.data() as JazzLoadCommissionRule),
    doProfiles: profilesSnap.docs.map((item) => item.data() as JazzLoadDoProfile),
    doNames: namesSnap.docs.map((item) => item.data() as JazzLoadDoName),
    doLines: linesSnap.docs.map((item) => item.data() as JazzLoadDoLine),
    doAssignments: assignmentsNested.flat()
  };
}

export async function restoreJazzLoadBackup(
  backup: Partial<JazzLoadBackup>,
  user?: User | null,
  role?: UserRole | null
) {
  const batch = writeBatch(requireDb());
  for (const rate of backup.rates ?? []) batch.set(doc(rateCollection(), rate.id), cleanForFirestore(rate), { merge: true });
  for (const rule of backup.commissionRules ?? []) batch.set(doc(commissionCollection(), rule.id), cleanForFirestore(rule), { merge: true });
  for (const profile of backup.doProfiles ?? []) batch.set(doc(doProfileCollection(), profile.id), cleanForFirestore(profile), { merge: true });
  for (const name of backup.doNames ?? []) batch.set(doc(doNameCollection(), name.id), cleanForFirestore(name), { merge: true });
  for (const line of backup.doLines ?? []) batch.set(doc(doLineCollection(), line.id), cleanForFirestore(line), { merge: true });
  for (const month of backup.months ?? []) batch.set(monthRef(month.id), cleanForFirestore(month), { merge: true });
  for (const day of backup.days ?? []) {
    batch.set(dayRef(day.monthId, day.dayNo), cleanForFirestore(day), { merge: true });
    for (const entry of day.doEntries ?? []) {
      batch.set(doc(dayRef(day.monthId, day.dayNo), "doEntries", entry.id), cleanForFirestore(entry), { merge: true });
    }
  }
  for (const assignment of backup.doAssignments ?? []) {
    batch.set(
      doc(doAssignmentCollection(assignment.monthId, assignment.dayNo), assignment.id),
      cleanForFirestore(assignment),
      { merge: true }
    );
  }
  await batch.commit();
  if (user && role) {
    await writeJazzLoadBackupRestoreAudit(backup.months?.length ?? 0, user, role);
  }
}
