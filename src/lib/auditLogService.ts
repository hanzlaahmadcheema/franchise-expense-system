import {
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  startAfter,
  where,
  type DocumentData,
  type FirestoreError,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  type SnapshotMetadata,
  type WriteBatch
} from "firebase/firestore";
import { auth, db } from "./firebase";
import type { AuditLogFilters, AuditLogModule, SystemAuditLog, UserRole } from "../types/ledger";

const SUMMARY_MAX = 500;
const PAGE_SIZE = 50;

export type FirestoreSnapshotMeta = Pick<SnapshotMetadata, "fromCache" | "hasPendingWrites">;

export type WriteAuditLogInput = {
  id?: string;
  module: AuditLogModule;
  action: string;
  summary: string;
  actorUid?: string;
  actorEmail?: string | null;
  actorRole?: UserRole;
  monthId?: string;
  dayNo?: number;
  targetType?: string;
  targetId?: string;
  sourcePath?: string;
  createdAt?: number;
};

function requireDb() {
  if (!db) throw new Error("Firebase is not configured.");
  return db;
}

function now() {
  return Date.now();
}

function newLogId(createdAt = now()) {
  return `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
}

export function truncateAuditSummary(summary: string) {
  const trimmed = summary.trim();
  if (trimmed.length <= SUMMARY_MAX) return trimmed;
  return `${trimmed.slice(0, SUMMARY_MAX - 1)}…`;
}

export function buildAuditLogDocument(
  input: WriteAuditLogInput,
  actorRole: UserRole
): SystemAuditLog {
  const createdAt = input.createdAt ?? now();
  const id = input.id ?? newLogId(createdAt);
  const actorUid = input.actorUid ?? auth?.currentUser?.uid ?? "";
  return {
    id,
    createdAt,
    module: input.module,
    action: input.action,
    summary: truncateAuditSummary(input.summary),
    actorUid,
    actorEmail: input.actorEmail ?? auth?.currentUser?.email ?? null,
    actorRole,
    ...(input.monthId ? { monthId: input.monthId } : {}),
    ...(input.dayNo != null ? { dayNo: input.dayNo } : {}),
    ...(input.targetType ? { targetType: input.targetType } : {}),
    ...(input.targetId ? { targetId: input.targetId } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {})
  };
}

export function buildAuditLogQueryConstraints(filters: AuditLogFilters): QueryConstraint[] {
  const constraints: QueryConstraint[] = [];
  if (filters.fromMs != null) constraints.push(where("createdAt", ">=", filters.fromMs));
  if (filters.toMs != null) constraints.push(where("createdAt", "<=", filters.toMs));
  if (filters.module) constraints.push(where("module", "==", filters.module));
  if (filters.action) constraints.push(where("action", "==", filters.action));
  if (filters.actorUid) constraints.push(where("actorUid", "==", filters.actorUid));
  if (filters.monthId) constraints.push(where("monthId", "==", filters.monthId));
  constraints.push(orderBy("createdAt", "desc"));
  return constraints;
}

function auditLogCollection() {
  return collection(requireDb(), "auditLogs");
}

function auditLogRef(id: string) {
  return doc(requireDb(), "auditLogs", id);
}

export async function writeAuditLog(
  input: WriteAuditLogInput,
  options?: { batch?: WriteBatch; actorRole?: UserRole }
): Promise<SystemAuditLog | null> {
  const actorUid = input.actorUid ?? auth?.currentUser?.uid;
  if (!actorUid) return null;
  const actorRole = options?.actorRole ?? "viewer";
  const log = buildAuditLogDocument({ ...input, actorUid }, actorRole);
  const payload = { ...log };
  if (options?.batch) {
    options.batch.set(auditLogRef(log.id), payload);
  } else {
    await setDoc(auditLogRef(log.id), payload);
  }
  return log;
}

export function matchesAuditSearch(log: SystemAuditLog, search: string) {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [log.summary, log.actorEmail ?? "", log.action, log.module, log.monthId ?? "", log.targetId ?? ""]
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export async function queryAuditLogs(
  filters: AuditLogFilters,
  pageCursor?: QueryDocumentSnapshot<DocumentData>
): Promise<{ logs: SystemAuditLog[]; lastDoc: QueryDocumentSnapshot<DocumentData> | null }> {
  const constraints = [orderBy("createdAt", "desc"), limit(1000)];
  const snap = await getDocs(query(auditLogCollection(), ...constraints));
  let logs = snap.docs.map((entry) => entry.data() as SystemAuditLog);

  if (filters.fromMs != null) logs = logs.filter(l => l.createdAt >= filters.fromMs!);
  if (filters.toMs != null) logs = logs.filter(l => l.createdAt <= filters.toMs!);
  if (filters.module) logs = logs.filter(l => l.module === filters.module);
  if (filters.action) logs = logs.filter(l => l.action === filters.action);
  if (filters.actorUid) logs = logs.filter(l => l.actorUid === filters.actorUid);
  if (filters.monthId) logs = logs.filter(l => l.monthId === filters.monthId);
  if (filters.search) {
    logs = logs.filter((entry) => matchesAuditSearch(entry, filters.search!));
  }

  let startIndex = 0;
  if (pageCursor) {
    const cursorId = pageCursor.id;
    const index = logs.findIndex(l => l.id === cursorId);
    if (index !== -1) {
      startIndex = index + 1;
    }
  }

  const pageLogs = logs.slice(startIndex, startIndex + PAGE_SIZE);

  let lastDoc: QueryDocumentSnapshot<DocumentData> | null = null;
  if (pageLogs.length > 0) {
    const lastLog = pageLogs[pageLogs.length - 1];
    const foundDoc = snap.docs.find(d => d.id === lastLog.id);
    if (foundDoc) {
      lastDoc = foundDoc;
    }
  }

  return { logs: pageLogs, lastDoc };
}

export function subscribeAuditLogs(
  filters: AuditLogFilters,
  onNext: (logs: SystemAuditLog[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  const constraints = [orderBy("createdAt", "desc"), limit(1000)];
  return onSnapshot(
    query(auditLogCollection(), ...constraints),
    { includeMetadataChanges: true },
    (snap) => {
      let logs = snap.docs.map((entry) => entry.data() as SystemAuditLog);

      if (filters.fromMs != null) logs = logs.filter(l => l.createdAt >= filters.fromMs!);
      if (filters.toMs != null) logs = logs.filter(l => l.createdAt <= filters.toMs!);
      if (filters.module) logs = logs.filter(l => l.module === filters.module);
      if (filters.action) logs = logs.filter(l => l.action === filters.action);
      if (filters.actorUid) logs = logs.filter(l => l.actorUid === filters.actorUid);
      if (filters.monthId) logs = logs.filter(l => l.monthId === filters.monthId);
      if (filters.search) {
        logs = logs.filter((entry) => matchesAuditSearch(entry, filters.search!));
      }

      onNext(logs.slice(0, PAGE_SIZE), snap.metadata);
    },
    onError
  );
}

export const AUDIT_LOG_PAGE_SIZE = PAGE_SIZE;
