import {
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
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
import { auth, db } from "../../../lib/firebase";
import { buildAuditLogDocument, writeAuditLog } from "../../../lib/auditLogService";
import { LEDGER_CALC_VERSION } from "../../../shared/ledger/ledgerTypes";
import { assertLedgerV2UiReadAllowed, type LedgerUiReadDecision } from "../../../shared/ledger/ledgerReadMode";
import { ChunkedFirestoreBatch, type FirestoreBatchWriter } from "../../../shared/services/chunkedFirestoreBatch";
import { assertMasterRefreshAccess, canRunMasterRefresh, MASTER_REFRESH_ACCESS } from "../../../shared/services/masterRefreshPermissions";
import { canReopenDay } from "../../../shared/services/dayEditPermissions";
import { changedSortOrderPatches, orderedBySortOrder } from "../../../shared/services/orderUtils";
import type { LedgerUser, UserRole } from "../../../types/ledger";

type User = LedgerUser;
import {
  calculateChainedDailySummary,
  calculateDailyLifting,
  calculateDailySummary,
  calculateDoRow,
  calculateMonthlySummary,
  resolveDoLineBindingForDate,
  resolveJazzLoadRatesForDay,
  snapshotResolvedRates
} from "./jazzLoadCalculations";
import type {
  ActiveJazzLoadRates,
  CalculatedMoney,
  JazzLoadAuditEvent,
  JazzLoadBackup,
  JazzLoadCommissionRule,
  JazzLoadDoAssignment,
  JazzLoadDoBindingBackfillMode,
  JazzLoadDoBindingBackfillPreview,
  JazzLoadDoBindingBackfillSample,
  JazzLoadDay,
  JazzLoadDoEntry,
  JazzLoadDoLineBinding,
  JazzLoadDoLine,
  JazzLoadDoName,
  JazzLoadDoProfile,
  JazzLoadMonth,
  JazzLoadMonthlySummary,
  JazzLoadRateConfig
} from "../types/jazzLoad.types";

export type FirestoreSnapshotMeta = Pick<SnapshotMetadata, "fromCache" | "hasPendingWrites">;

type LedgerUiReadOptions = {
  readDecision?: LedgerUiReadDecision;
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
  const current = user ?? (auth?.currentUser as unknown as LedgerUser | null);
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

function doLineBindingCollection() {
  return collection(requireDb(), "jazzLoadSettings", "doLineBindings", "items");
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

function ledgerV2JazzLoadRawEntries(monthId: string, dayNo: number) {
  return collection(requireDb(), "ledgerV2", "jazzLoad", "months", monthId, "days", String(dayNo), "rawEntries");
}

function ledgerV2JazzLoadDay(monthId: string, dayNo: number) {
  return doc(requireDb(), "ledgerV2", "jazzLoad", "months", monthId, "days", String(dayNo));
}

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function calculatedMoney(baseAmount: number, calculatedAmount = baseAmount): CalculatedMoney {
  return {
    baseAmount,
    calculatedAmount,
    appliedRateId: "ledger-v2",
    appliedRateName: "LedgerV2",
    appliedRatePercentage: 0,
    calculatedAt: now()
  };
}

async function hydrateJazzLoadV2Day(monthId: string, dayNo: number): Promise<JazzLoadDay> {
  const [legacySnap, rawSnap, projectionSnap, dayV2Snap] = await Promise.all([
    getDoc(dayRef(monthId, dayNo)),
    getDocs(ledgerV2JazzLoadRawEntries(monthId, dayNo)),
    getDocs(collection(ledgerV2JazzLoadDay(monthId, dayNo), "projections")),
    getDoc(ledgerV2JazzLoadDay(monthId, dayNo))
  ]);
  const legacyDay = legacySnap.exists() ? mapDayData(legacySnap.data() as Partial<JazzLoadDay>, legacySnap.id) : null;
  const projectionByRawId = new Map<string, Record<string, unknown>>();

  projectionSnap.docs.forEach((projectionDoc) => {
    const projection = projectionDoc.data() as Record<string, unknown>;
    const rawEntryId = typeof projection.rawEntryId === "string" ? projection.rawEntryId : null;
    if (rawEntryId) projectionByRawId.set(rawEntryId, projection);
  });
  const liftingProjection = projectionSnap.docs
    .map((projectionDoc) => projectionDoc.data() as Record<string, unknown>)
    .find((projection) => projection.type === "dailyLiftingBalance");

  const doEntries = rawSnap.docs.flatMap((entryDoc): JazzLoadDoEntry[] => {
    const entry = entryDoc.data() as { id?: string; type?: string; raw?: Record<string, unknown> };
    if (entry.type !== "doEntry") return [];
    const raw = entry.raw ?? {};
    const projection = projectionByRawId.get(entry.id ?? entryDoc.id);
    const calculated = projection?.calculated && typeof projection.calculated === "object"
      ? projection.calculated as Record<string, unknown>
      : {};
    const id = String(entry.id ?? entryDoc.id).replace(/^do-/, "");
    const issuanceBase = numberValue(calculated.issuance ?? raw.todayMlIssuanceBase);
    const paymentBase = numberValue(calculated.payment ?? raw.paymentReceivedBase);
    const openingBase = numberValue(calculated.opening);
    const closingBase = numberValue(calculated.closing);
    return [{
      id,
      doProfileId: typeof raw.doProfileId === "string" ? raw.doProfileId : undefined,
      doNameId: typeof raw.doNameId === "string" ? raw.doNameId : undefined,
      doLineId: typeof raw.doLineId === "string" ? raw.doLineId : undefined,
      assignmentId: typeof raw.assignmentId === "string" ? raw.assignmentId : undefined,
      doLineSortOrder: typeof raw.doLineSortOrder === "number" ? raw.doLineSortOrder : undefined,
      doName: String(raw.doName ?? projection?.doName ?? ""),
      doLine: typeof raw.doLine === "string" ? raw.doLine : typeof projection?.doLine === "string" ? projection.doLine : undefined,
      bindingEffectiveFromMonthId: typeof raw.bindingEffectiveFromMonthId === "string" ? raw.bindingEffectiveFromMonthId : undefined,
      bindingEffectiveFromDay: typeof raw.bindingEffectiveFromDay === "number" ? raw.bindingEffectiveFromDay : undefined,
      bindingUpdatedAt: typeof raw.bindingUpdatedAt === "number" ? raw.bindingUpdatedAt : undefined,
      bindingUpdatedBy: typeof raw.bindingUpdatedBy === "string" ? raw.bindingUpdatedBy : undefined,
      bindingBackfillId: typeof raw.bindingBackfillId === "string" ? raw.bindingBackfillId : undefined,
      bindingBackfillMode: raw.bindingBackfillMode === "current-binding-history-repair" ? raw.bindingBackfillMode : undefined,
      openingBalance: calculatedMoney(openingBase, numberValue(calculated.openingMl ?? openingBase)),
      todayMlIssuance: calculatedMoney(issuanceBase, numberValue(calculated.issuanceMl ?? issuanceBase)),
      dayTotal: calculatedMoney(openingBase + issuanceBase, numberValue(calculated.openingMl ?? openingBase) + numberValue(calculated.issuanceMl ?? issuanceBase)),
      paymentReceived: calculatedMoney(paymentBase, numberValue(calculated.paymentMl ?? paymentBase)),
      closingBalance: calculatedMoney(closingBase, numberValue(calculated.closingMl ?? closingBase)),
      notes: typeof raw.notes === "string" ? raw.notes : undefined,
      createdBy: legacyDay?.createdBy ?? "",
      createdAt: legacyDay?.createdAt ?? 0,
      updatedBy: legacyDay?.updatedBy,
      updatedAt: legacyDay?.updatedAt ?? 0
    }];
  });
  const fallbackSummary = calculateDailySummary({ doEntries });
  const liftingCalculated = liftingProjection?.calculated && typeof liftingProjection.calculated === "object"
    ? liftingProjection.calculated as Record<string, unknown>
    : {};
  const liftingRaw = rawSnap.docs.find((entryDoc) => (entryDoc.data() as { type?: string }).type === "lifting")?.data() as { raw?: Record<string, unknown> } | undefined;
  const dayV2 = dayV2Snap.exists() ? dayV2Snap.data() as Partial<JazzLoadDay> : {};

  return {
    ...(legacyDay ?? mapDayData({}, String(dayNo))),
    id: String(dayNo),
    monthId,
    dayNo,
    doEntries,
    lifting: {
      openingBalance: numberValue(liftingCalculated.opening),
      mlLifting: numberValue(liftingCalculated.lifting ?? liftingRaw?.raw?.mlLifting),
      totalBalance: numberValue(liftingCalculated.opening) + numberValue(liftingCalculated.lifting ?? liftingRaw?.raw?.mlLifting),
      todayMlIssuance: numberValue(liftingCalculated.issuance),
      inHandBalance: numberValue(liftingCalculated.closing)
    },
    summary: { ...fallbackSummary, ...(dayV2.summary ?? {}) },
    notes: legacyDay?.notes ?? (typeof liftingRaw?.raw?.notes === "string" ? liftingRaw.raw.notes : undefined)
  };
}

async function loadJazzLoadV2Days(monthId: string): Promise<JazzLoadDay[]> {
  const snap = await getDocs(query(collection(requireDb(), "ledgerV2", "jazzLoad", "months", monthId, "days"), orderBy("dayNo", "asc")));
  if (snap.empty) {
    throw new Error(`ledgerV2 Jazz Load projections are missing for ${monthId}. Run and review master refresh before enabling v2 UI reads.`);
  }
  const days = await Promise.all(snap.docs.map((item) => hydrateJazzLoadV2Day(monthId, Number(item.data().dayNo ?? item.id))));
  return days.sort((a, b) => a.dayNo - b.dayNo);
}

async function syncJazzLoadLedgerV2RawEntriesInBatch(
  batch: FirestoreBatchWriter,
  day: JazzLoadDay,
  actorUid: string,
  timestamp: number
) {
  const rawCollection = ledgerV2JazzLoadRawEntries(day.monthId, day.dayNo);
  const existingSnap = await getDocs(rawCollection);
  const rawEntries = [
    ...day.doEntries.map((entry) => ({
      id: `do-${entry.id}`,
      type: "doEntry",
      raw: {
        doProfileId: entry.doProfileId,
        doNameId: entry.doNameId,
        doLineId: entry.doLineId,
        assignmentId: entry.assignmentId,
        doLineSortOrder: entry.doLineSortOrder,
        doName: entry.doName,
        doLine: entry.doLine,
        bindingEffectiveFromMonthId: entry.bindingEffectiveFromMonthId,
        bindingEffectiveFromDay: entry.bindingEffectiveFromDay,
        bindingUpdatedAt: entry.bindingUpdatedAt,
        bindingUpdatedBy: entry.bindingUpdatedBy,
        bindingBackfillId: entry.bindingBackfillId,
        bindingBackfillMode: entry.bindingBackfillMode,
        todayMlIssuanceBase: entry.todayMlIssuance.baseAmount,
        paymentReceivedBase: entry.paymentReceived.baseAmount,
        notes: entry.notes,
        source: "user"
      }
    })),
    {
      id: "lifting-main",
      type: "lifting",
      raw: {
        mlLifting: day.lifting.mlLifting,
        notes: day.notes,
        source: "user"
      }
    }
  ];
  const nextIds = new Set(rawEntries.map((entry) => entry.id));
  for (const entryDoc of existingSnap.docs) {
    if (!nextIds.has(entryDoc.id)) batch.delete(entryDoc.ref);
  }
  for (const entry of rawEntries) {
    batch.set(doc(rawCollection, entry.id), cleanForFirestore({
      id: entry.id,
      module: "jazzLoad" as const,
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
  batch: FirestoreBatchWriter,
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
    manualOverride: data.manualOverride ?? false,
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
    lockedAt: data.lockedAt,
    lockedBy: data.lockedBy,
    lockedByRole: data.lockedByRole,
    reopenedAt: data.reopenedAt,
    reopenedBy: data.reopenedBy,
    reopenedByRole: data.reopenedByRole,
    reopenedUntilAt: data.reopenedUntilAt,
    lastDoBindingBackfillAt: data.lastDoBindingBackfillAt,
    lastDoBindingBackfillBy: data.lastDoBindingBackfillBy,
    lastDoBindingBackfillMode: data.lastDoBindingBackfillMode,
    lastDoBindingBackfillId: data.lastDoBindingBackfillId
  };
}

export function roleCanJazzLoad(
  role: UserRole | null,
  permission: "read" | "daily" | "settings" | "backup" | "monthControls" | typeof MASTER_REFRESH_ACCESS
) {
  if (!role) return false;
  if (permission === "read") return true;
  if (permission === MASTER_REFRESH_ACCESS) return canRunMasterRefresh(role);
  if (role === "owner") return true;
  if (role === "admin") return permission === "daily" || permission === "settings";
  return false;
}

function activeRateFor(
  rates: JazzLoadRateConfig[],
  primaryType: JazzLoadRateConfig["type"],
  legacyTypes: JazzLoadRateConfig["type"][] = []
) {
  return rates.find((rate) => rate.active && rate.type === primaryType) ??
    rates.find((rate) => rate.active && legacyTypes.includes(rate.type)) ??
    null;
}

function previousMonthId(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function parseMonthId(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid month: ${monthId}`);
  }
  return { year, month };
}

function compareMonthIds(left: string, right: string) {
  return left.localeCompare(right);
}

function nextMonthId(monthId: string) {
  const { year, month } = parseMonthId(monthId);
  return month === 12 ? `${year + 1}-01` : `${year}-${String(month + 1).padStart(2, "0")}`;
}

function monthIdsInRange(fromMonthId: string, toMonthId: string) {
  parseMonthId(fromMonthId);
  parseMonthId(toMonthId);
  if (compareMonthIds(fromMonthId, toMonthId) > 0) {
    throw new Error("From month must be before or equal to To month.");
  }
  const months: string[] = [];
  let cursor = fromMonthId;
  while (compareMonthIds(cursor, toMonthId) <= 0) {
    months.push(cursor);
    if (months.length > 120) throw new Error("Month range is too large.");
    cursor = nextMonthId(cursor);
  }
  return months;
}

function currentJazzLoadBindingDate(date = new Date()) {
  return {
    monthId: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
    dayNo: date.getDate()
  };
}

async function loadActiveJazzLoadRates(): Promise<ActiveJazzLoadRates> {
  const ratesSnap = await getDocs(query(rateCollection(), orderBy("updatedAt", "desc")));
  const rates = ratesSnap.docs.map((rateDoc) => rateDoc.data() as JazzLoadRateConfig);
  return {
    mlRate: activeRateFor(rates, "ml_addition"),
    commission1Rate: activeRateFor(rates, "commission1_adjustment", ["adjustment"]),
    commission2Rate: activeRateFor(rates, "commission2_payment", ["commission"])
  };
}

async function loadJazzLoadMonthForRefresh(monthId: string, user: User | null, role: UserRole | null) {
  const monthSnap = await getDoc(monthRef(monthId));
  if (monthSnap.exists()) return monthSnap.data() as JazzLoadMonth;
  const currentActor = actor(user, role);
  const timestamp = now();
  return {
    id: monthId,
    label: monthId,
    status: "open" as const,
    createdBy: currentActor.userId,
    updatedBy: currentActor.userId,
    createdAt: timestamp,
    updatedAt: timestamp
  } satisfies JazzLoadMonth;
}

async function loadJazzLoadMonthlySummary(monthId: string) {
  const summarySnap = await getDoc(doc(monthRef(monthId), "summary", "monthly"));
  return summarySnap.exists() ? (summarySnap.data() as JazzLoadMonthlySummary) : null;
}

async function loadJazzLoadDoLineBindings() {
  const snap = await getDocs(doLineBindingCollection());
  return snap.docs.map((item) => item.data() as JazzLoadDoLineBinding);
}

export function subscribeJazzLoadRates(
  onNext: (rates: JazzLoadRateConfig[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    rateCollection(),
    { includeMetadataChanges: true },
    (snap) => onNext(orderedBySortOrder(snap.docs.map((rateDoc) => rateDoc.data() as JazzLoadRateConfig)), snap.metadata),
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
    doNameCollection(),
    { includeMetadataChanges: true },
    (snap) => onNext(orderedBySortOrder(snap.docs.map((nameDoc) => nameDoc.data() as JazzLoadDoName)), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDoLines(
  onNext: (lines: JazzLoadDoLine[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    doLineCollection(),
    { includeMetadataChanges: true },
    (snap) => onNext(orderedBySortOrder(snap.docs.map((lineDoc) => lineDoc.data() as JazzLoadDoLine)), snap.metadata),
    onError
  );
}

export function subscribeJazzLoadDoLineBindings(
  onNext: (bindings: JazzLoadDoLineBinding[], metadata: FirestoreSnapshotMeta) => void,
  onError?: (error: FirestoreError) => void
) {
  return onSnapshot(
    doLineBindingCollection(),
    { includeMetadataChanges: true },
    (snap) => onNext(snap.docs.map((bindingDoc) => bindingDoc.data() as JazzLoadDoLineBinding), snap.metadata),
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
  onError?: (error: FirestoreError | Error) => void,
  options: LedgerUiReadOptions = {}
) {
  if (options.readDecision?.mode === "v2") {
    try {
      assertLedgerV2UiReadAllowed(options.readDecision);
    } catch (error) {
      setTimeout(() => onError?.(error as Error), 0);
      return () => {};
    }
    return onSnapshot(
      query(collection(requireDb(), "ledgerV2", "jazzLoad", "months", monthId, "days"), orderBy("dayNo", "asc")),
      { includeMetadataChanges: true },
      (snap) => {
        if (snap.empty) {
          onError?.(new Error(`ledgerV2 Jazz Load projections are missing for ${monthId}. Run and review master refresh before enabling v2 UI reads.`));
          return;
        }
        void Promise.all(snap.docs.map((item) => hydrateJazzLoadV2Day(monthId, Number(item.data().dayNo ?? item.id))))
          .then((days) => onNext(days.sort((a, b) => a.dayNo - b.dayNo), snap.metadata))
          .catch((error: Error) => onError?.(error));
      },
      onError as (error: FirestoreError) => void
    );
  }
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
  onError?: (error: FirestoreError | Error) => void,
  options: LedgerUiReadOptions = {}
) {
  if (options.readDecision?.mode === "v2") {
    try {
      assertLedgerV2UiReadAllowed(options.readDecision);
    } catch (error) {
      setTimeout(() => onError?.(error as Error), 0);
      return () => {};
    }
    return onSnapshot(
      doc(requireDb(), "ledgerV2", "jazzLoad", "months", monthId, "summary", "home"),
      { includeMetadataChanges: true },
      (snap) => onNext(snap.exists() ? (snap.data() as JazzLoadMonthlySummary) : null, snap.metadata),
      onError as (error: FirestoreError) => void
    );
  }
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

export async function loadJazzLoadDays(monthId: string, options: LedgerUiReadOptions = {}) {
  if (options.readDecision?.mode === "v2") {
    assertLedgerV2UiReadAllowed(options.readDecision);
    return loadJazzLoadV2Days(monthId);
  }
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
    sortOrder: Number(input.sortOrder) || 1,
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

export async function deleteJazzLoadRate(
  id: string,
  user?: User | null,
  role?: UserRole | null
) {
  const currentActor = user ? actor(user, role) : null;
  const timestamp = now();
  const batch = writeBatch(requireDb());
  batch.delete(doc(rateCollection(), id));
  if (currentActor) {
    const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
    batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
      id: auditId,
      action: "delete-rate",
      ...currentActor,
      targetType: "rate",
      targetId: id,
      createdAt: timestamp
    }));
    stageUnifiedAudit(
      batch,
      {
        id: auditId,
        createdAt: timestamp,
        module: "settings",
        action: mapJazzSettingsAction("delete-rate"),
        summary: jazzSettingsSummary("delete-rate", "rate", id),
        actorUid: currentActor.userId,
        actorEmail: currentActor.userEmail,
        targetType: "rate",
        targetId: id,
        sourcePath: `jazzLoadSettings/audit/items/${auditId}`
      },
      currentActor.userRole ?? "viewer"
    );
  }
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
  const nextName = { ...name, sortOrder: Number(name.sortOrder) || 1, createdAt: name.createdAt ?? timestamp, updatedAt: timestamp };
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
  const nextLine = { ...line, sortOrder: Number(line.sortOrder) || 1, createdAt: line.createdAt ?? timestamp, updatedAt: timestamp };
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

export async function upsertJazzLoadDoLineBinding(
  binding: Omit<JazzLoadDoLineBinding, "createdBy" | "createdAt" | "updatedAt"> & Partial<Pick<JazzLoadDoLineBinding, "createdBy" | "createdAt">>,
  user: User | null,
  role: UserRole | null
) {
  const currentActor = actor(user, role);
  const timestamp = now();
  const nextBinding: JazzLoadDoLineBinding = {
    ...binding,
    createdBy: binding.createdBy ?? currentActor.userId,
    createdAt: binding.createdAt ?? timestamp,
    updatedBy: currentActor.userId,
    updatedAt: timestamp
  };
  const batch = writeBatch(requireDb());
  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(doc(doLineBindingCollection(), nextBinding.id), cleanForFirestore(nextBinding), { merge: true });
  batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
    id: auditId,
    action: "upsert-do-line-binding",
    ...currentActor,
    targetType: "doLineBinding",
    targetId: nextBinding.id,
    after: nextBinding,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "settings",
      action: "jazz-do-change",
      summary: `Updated DO line binding ${nextBinding.doLineName ?? nextBinding.doLineId}`,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "doLineBinding",
      targetId: nextBinding.id,
      sourcePath: `jazzLoadSettings/audit/items/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
}

export async function updateJazzLoadRateSortOrder(before: JazzLoadRateConfig[], after: JazzLoadRateConfig[]) {
  const updates = changedSortOrderPatches(before, after);
  if (updates.length === 0) return;
  const batch = writeBatch(requireDb());
  const timestamp = now();
  updates.forEach((item) => {
    batch.set(doc(rateCollection(), item.id), cleanForFirestore({ sortOrder: item.sortOrder, updatedAt: timestamp }), { merge: true });
  });
  await batch.commit();
}

export async function updateJazzLoadDoNameSortOrder(before: JazzLoadDoName[], after: JazzLoadDoName[]) {
  const updates = changedSortOrderPatches(before, after);
  if (updates.length === 0) return;
  const batch = writeBatch(requireDb());
  const timestamp = now();
  updates.forEach((item) => {
    batch.set(doc(doNameCollection(), item.id), cleanForFirestore({ sortOrder: item.sortOrder, updatedAt: timestamp }), { merge: true });
  });
  await batch.commit();
}

export async function updateJazzLoadDoLineSortOrder(before: JazzLoadDoLine[], after: JazzLoadDoLine[]) {
  const updates = changedSortOrderPatches(before, after);
  if (updates.length === 0) return;
  const batch = writeBatch(requireDb());
  const timestamp = now();
  updates.forEach((item) => {
    batch.set(doc(doLineCollection(), item.id), cleanForFirestore({ sortOrder: item.sortOrder, updatedAt: timestamp }), { merge: true });
  });
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
  if (action === "reopen-day" && !canReopenDay(role)) throw new Error("Only owner can reopen days.");
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
  batch.set(dayRef(month.id, day.dayNo), {
    ...cleanForFirestore(nextDay),
    notes: nextDay.notes?.trim() ? nextDay.notes : deleteField(),
    lockedAt: nextDay.lockedAt ?? deleteField(),
    lockedBy: nextDay.lockedBy ?? deleteField(),
    lockedByRole: nextDay.lockedByRole ?? deleteField(),
    closedAt: nextDay.closedAt ?? deleteField(),
    closedBy: nextDay.closedBy ?? deleteField(),
    reopenedAt: nextDay.reopenedAt ?? deleteField(),
    reopenedBy: nextDay.reopenedBy ?? deleteField(),
    reopenedByRole: nextDay.reopenedByRole ?? deleteField(),
    reopenedUntilAt: nextDay.reopenedUntilAt ?? deleteField()
  }, { merge: true });
  for (const entry of nextDay.doEntries) {
    batch.set(doc(dayRef(month.id, day.dayNo), "doEntries", entry.id), cleanForFirestore(entry), { merge: true });
  }
  await syncJazzLoadLedgerV2RawEntriesInBatch(batch, nextDay, currentActor.userId, timestamp);
  batch.set(doc(monthRef(month.id), "summary", "monthly"), cleanForFirestore(summary), { merge: true });
  batch.set(auditRef(month.id, auditId), cleanForFirestore(audit));
  const summaryText =
    action === "close-day"
      ? `Closed Jazz Load day ${day.dayNo}`
      : action === "reopen-day"
        ? `Reopened Jazz Load day ${day.dayNo}`
        : `Saved Jazz Load day ${day.dayNo}`;
  const unifiedAuditInput = {
      id: auditId,
      createdAt: timestamp,
      module: "jazzLoad" as const,
      action,
      summary: summaryText,
      monthId: month.id,
      dayNo: day.dayNo,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "day",
      targetId: `${month.id}/${day.dayNo}`,
      sourcePath: `jazzLoadMonths/${month.id}/audit/${auditId}`
    };
  if (action !== "close-day") {
    stageUnifiedAudit(batch, unifiedAuditInput, currentActor.userRole ?? "viewer");
  }
  await batch.commit();
  if (action === "close-day") {
    void writeAuditLog(unifiedAuditInput, { actorRole: currentActor.userRole ?? "viewer" })
      .catch(() => console.warn("Jazz Load day closed, but the secondary audit log write failed."));
  }
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

type PreviousJazzLoadMonthSummarySeed = Pick<
  JazzLoadMonthlySummary,
  "totalClosingBase" | "totalClosingMl" | "latestInHandBalance"
>;

export function rechainJazzLoadDays(
  days: JazzLoadDay[],
  activeRates: ActiveJazzLoadRates,
  userId: string,
  timestamp: number,
  previousMonthDays: JazzLoadDay[] = [],
  previousMonthSummary?: PreviousJazzLoadMonthSummarySeed | null,
  doLineBindings: JazzLoadDoLineBinding[] = []
) {
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);
  const seedDays = [...previousMonthDays].sort((a, b) => a.dayNo - b.dayNo);
  const finalSeedDay = seedDays.at(-1);
  let previousSummaryClosing = previousMonthSummary
    ? {
        closingBase: previousMonthSummary.totalClosingBase,
        closingMl: previousMonthSummary.totalClosingMl
      }
    : finalSeedDay?.summary
      ? {
          closingBase: finalSeedDay.summary.closingBase,
          closingMl: finalSeedDay.summary.closingMl
        }
      : undefined;
  const seedInHandBalance = previousMonthSummary?.latestInHandBalance ?? finalSeedDay?.lifting.inHandBalance;
  const recalculatedDays: JazzLoadDay[] = [];

  for (const day of sortedDays) {
    const resolvedRates = resolveJazzLoadRatesForDay({
      dayRecord: day,
      activeRates,
      mode: "master-refresh",
      resolvedAt: timestamp
    });
    const doEntries = day.doEntries.map((entry) => {
      const previous = matchingPreviousEntry([...seedDays, ...recalculatedDays], entry);
      const savedDoName = (entry.doName ?? "").trim();
      const binding = resolveDoLineBindingForDate(doLineBindings, entry.doLineId, day.monthId, day.dayNo);
      const bindingMatchesSavedName = Boolean(
        binding &&
        savedDoName &&
        (
          (entry.doNameId && entry.doNameId === binding.doNameId) ||
          savedDoName.localeCompare(binding.doName, undefined, { sensitivity: "base" }) === 0
        )
      );
      const shouldUseBindingName = !savedDoName;
      return calculateDoRow(
        {
          id: entry.id,
          doProfileId: entry.doProfileId,
          doNameId: entry.doNameId ?? (shouldUseBindingName ? binding?.doNameId : undefined),
          doLineId: entry.doLineId,
          assignmentId: entry.assignmentId,
          doLineSortOrder: entry.doLineSortOrder,
          doName: savedDoName ? entry.doName : binding?.doName || "",
          doLine: entry.doLine || binding?.doLineName,
          bindingEffectiveFromMonthId: entry.bindingEffectiveFromMonthId ?? (shouldUseBindingName || bindingMatchesSavedName ? binding?.effectiveFromMonthId : undefined),
          bindingEffectiveFromDay: entry.bindingEffectiveFromDay ?? (shouldUseBindingName || bindingMatchesSavedName ? binding?.effectiveFromDay : undefined),
          openingBase: previous?.closingBalance.baseAmount ?? entry.openingBalance.baseAmount,
          todayMlIssuanceBase: entry.todayMlIssuance.baseAmount,
          paymentReceivedBase: entry.paymentReceived.baseAmount,
          notes: entry.notes
        },
        resolvedRates.rates,
        { createdBy: userId, previous: entry, timestamp }
      );
    });
    const summary = calculateChainedDailySummary({ doEntries }, resolvedRates.rates, timestamp, previousSummaryClosing);
    const previousDay = recalculatedDays.at(-1);
    recalculatedDays.push({
      ...day,
      doEntries,
      summary,
      appliedRates: snapshotResolvedRates(resolvedRates.rates, timestamp),
      lifting: calculateDailyLifting(
        {
          openingBalance: previousDay?.lifting.inHandBalance ?? seedInHandBalance ?? day.lifting.openingBalance,
          mlLifting: day.lifting.mlLifting
        },
        summary.issuanceMl
      ),
      updatedBy: userId,
      updatedAt: timestamp
    });
    previousSummaryClosing = {
      closingBase: summary.closingBase,
      closingMl: summary.closingMl
    };
  }

  return recalculatedDays;
}

export async function recalculateJazzLoadMonth(
  month: JazzLoadMonth,
  days: JazzLoadDay[],
  activeRates: ActiveJazzLoadRates,
  user: User | null,
  role: UserRole | null,
  options: { previousMonthDays?: JazzLoadDay[]; previousMonthSummary?: PreviousJazzLoadMonthSummarySeed | null; doLineBindings?: JazzLoadDoLineBinding[] } = {}
) {
  if (!activeRates.mlRate) throw new Error("Active Jazz Load Addition Rate is required before recalculating.");
  const currentActor = actor(user, role);
  const timestamp = now();
  const recalculatedDays = rechainJazzLoadDays(
    days,
    activeRates,
    currentActor.userId,
    timestamp,
    options.previousMonthDays ?? [],
    options.previousMonthSummary ?? null,
    options.doLineBindings ?? []
  );
  const summary = calculateMonthlySummary(month.id, recalculatedDays);
  const batch = new ChunkedFirestoreBatch(requireDb(), `jazzLoad:${month.id}:recalculateMonth`);
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
    batch.set(dayRef(month.id, day.dayNo), cleanForFirestore({
      ...day,
      recalculatedAt: timestamp,
      recalculatedBy: currentActor.userId,
      recalculatedByRole: currentActor.userRole
    }), { merge: true });
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

  await batch.commit();
  return { month: nextMonth, days: recalculatedDays, summary };
}

export async function recalculateJazzLoadLedgerLocal(
  monthId: string,
  user: User | null,
  role: UserRole | null
) {
  assertMasterRefreshAccess(role, "Jazz Load master refresh");
  const previousId = previousMonthId(monthId);
  const [month, days, previousMonthDays, previousMonthSummary, activeRates, doLineBindings] = await Promise.all([
    loadJazzLoadMonthForRefresh(monthId, user, role),
    loadJazzLoadDays(monthId),
    previousId ? loadJazzLoadDays(previousId).catch(() => []) : Promise.resolve([]),
    previousId ? loadJazzLoadMonthlySummary(previousId).catch(() => null) : Promise.resolve(null),
    loadActiveJazzLoadRates(),
    loadJazzLoadDoLineBindings()
  ]);
  const result = await recalculateJazzLoadMonth(month, days, activeRates, user, role, {
    previousMonthDays,
    previousMonthSummary,
    doLineBindings
  });
  return {
    ok: true,
    calcRunId: undefined,
    invariantIssueCount: 0,
    dayCount: result.days.length,
    ...result
  };
}

const DO_BINDING_BACKFILL_MODE: JazzLoadDoBindingBackfillMode = "current-binding-history-repair";

type JazzLoadDoBindingBackfillInput = {
  fromMonthId: string;
  toMonthId: string;
  currentBindingMonthId?: string;
  currentBindingDayNo?: number;
  backfillId?: string;
};

type JazzLoadDoBindingBackfillChangedDay = {
  day: JazzLoadDay;
  updatedEntries: JazzLoadDoEntry[];
  changedEntries: JazzLoadDoEntry[];
};

function doBindingSnapshotIncomplete(entry: JazzLoadDoEntry) {
  return !entry.doNameId ||
    !entry.doName.trim() ||
    !entry.bindingEffectiveFromMonthId ||
    !entry.bindingEffectiveFromDay;
}

function doBindingEntryNeedsChange(entry: JazzLoadDoEntry, binding: JazzLoadDoLineBinding) {
  const nextLine = binding.doLineName ?? entry.doLine;
  return entry.doNameId !== binding.doNameId ||
    entry.doName !== binding.doName ||
    entry.doLine !== nextLine ||
    entry.bindingEffectiveFromMonthId !== binding.effectiveFromMonthId ||
    entry.bindingEffectiveFromDay !== binding.effectiveFromDay;
}

function doBindingBackfillSample(
  day: JazzLoadDay,
  entry: JazzLoadDoEntry,
  binding: JazzLoadDoLineBinding
): JazzLoadDoBindingBackfillSample {
  return {
    monthId: day.monthId,
    dayNo: day.dayNo,
    rowId: entry.id,
    doLineId: entry.doLineId,
    doLine: entry.doLine ?? binding.doLineName,
    oldDoName: entry.doName,
    newDoName: binding.doName
  };
}

function buildDoBindingBackfillPlan(input: {
  daysByMonth: Array<{ monthId: string; days: JazzLoadDay[] }>;
  doLineBindings: JazzLoadDoLineBinding[];
  fromMonthId: string;
  toMonthId: string;
  currentBindingMonthId: string;
  currentBindingDayNo: number;
  backfillId: string;
  actorUid?: string;
  timestamp?: number;
}) {
  const preview: JazzLoadDoBindingBackfillPreview = {
    backfillId: input.backfillId,
    fromMonthId: input.fromMonthId,
    toMonthId: input.toMonthId,
    currentBindingMonthId: input.currentBindingMonthId,
    currentBindingDayNo: input.currentBindingDayNo,
    daysScanned: 0,
    rowsScanned: 0,
    rowsThatWillChange: 0,
    rowsAlreadyCorrect: 0,
    rowsMissingBinding: 0,
    rowsSkippedNoCurrentBinding: 0,
    sampleChanges: []
  };
  const changedDays: JazzLoadDoBindingBackfillChangedDay[] = [];
  const timestamp = input.timestamp ?? now();

  for (const month of input.daysByMonth) {
    for (const day of month.days) {
      preview.daysScanned += 1;
      const changedEntries: JazzLoadDoEntry[] = [];
      const updatedEntries = day.doEntries.map((entry) => {
        preview.rowsScanned += 1;
        if (doBindingSnapshotIncomplete(entry)) preview.rowsMissingBinding += 1;
        if (!entry.doLineId) {
          preview.rowsSkippedNoCurrentBinding += 1;
          return entry;
        }
        const binding = resolveDoLineBindingForDate(
          input.doLineBindings,
          entry.doLineId,
          input.currentBindingMonthId,
          input.currentBindingDayNo
        );
        if (!binding) {
          preview.rowsSkippedNoCurrentBinding += 1;
          return entry;
        }
        if (!doBindingEntryNeedsChange(entry, binding)) {
          preview.rowsAlreadyCorrect += 1;
          return entry;
        }
        preview.rowsThatWillChange += 1;
        if (preview.sampleChanges.length < 8) {
          preview.sampleChanges.push(doBindingBackfillSample(day, entry, binding));
        }
        const updatedEntry: JazzLoadDoEntry = {
          ...entry,
          doNameId: binding.doNameId,
          doName: binding.doName,
          doLine: binding.doLineName ?? entry.doLine,
          bindingEffectiveFromMonthId: binding.effectiveFromMonthId,
          bindingEffectiveFromDay: binding.effectiveFromDay,
          bindingUpdatedAt: timestamp,
          bindingUpdatedBy: input.actorUid,
          bindingBackfillId: input.backfillId,
          bindingBackfillMode: DO_BINDING_BACKFILL_MODE
        };
        changedEntries.push(updatedEntry);
        return updatedEntry;
      });
      if (changedEntries.length > 0) {
        changedDays.push({ day, updatedEntries, changedEntries });
      }
    }
  }

  return { preview, changedDays };
}

async function loadJazzLoadBackfillScope(input: JazzLoadDoBindingBackfillInput) {
  const currentBindingDate = input.currentBindingMonthId && input.currentBindingDayNo
    ? { monthId: input.currentBindingMonthId, dayNo: input.currentBindingDayNo }
    : currentJazzLoadBindingDate();
  const months = monthIdsInRange(input.fromMonthId, input.toMonthId);
  const [doLineBindings, daysByMonth] = await Promise.all([
    loadJazzLoadDoLineBindings(),
    Promise.all(months.map(async (scopeMonthId) => ({
      monthId: scopeMonthId,
      days: await listJazzLoadDays(scopeMonthId)
    })))
  ]);
  return {
    doLineBindings,
    daysByMonth,
    currentBindingMonthId: currentBindingDate.monthId,
    currentBindingDayNo: currentBindingDate.dayNo,
    backfillId: input.backfillId ?? `${now()}-${Math.random().toString(36).slice(2, 8)}`
  };
}

export async function previewJazzLoadDoBindingBackfill(
  input: JazzLoadDoBindingBackfillInput
): Promise<JazzLoadDoBindingBackfillPreview> {
  const scope = await loadJazzLoadBackfillScope(input);
  return buildDoBindingBackfillPlan({
    daysByMonth: scope.daysByMonth,
    doLineBindings: scope.doLineBindings,
    fromMonthId: input.fromMonthId,
    toMonthId: input.toMonthId,
    currentBindingMonthId: scope.currentBindingMonthId,
    currentBindingDayNo: scope.currentBindingDayNo,
    backfillId: scope.backfillId
  }).preview;
}

function backfilledSummaryDoBalances(
  summary: JazzLoadMonthlySummary,
  doLineBindings: JazzLoadDoLineBinding[],
  currentBindingMonthId: string,
  currentBindingDayNo: number
): JazzLoadMonthlySummary["doBalances"] {
  return summary.doBalances.map((balance) => {
    if (!balance.doLineId) return balance;
    const binding = resolveDoLineBindingForDate(doLineBindings, balance.doLineId, currentBindingMonthId, currentBindingDayNo);
    if (!binding) return balance;
    return {
      ...balance,
      doNameId: binding.doNameId,
      doName: binding.doName,
      doLine: binding.doLineName ?? balance.doLine
    };
  });
}

export async function applyJazzLoadDoBindingBackfill(
  input: JazzLoadDoBindingBackfillInput,
  user: User | null,
  role: UserRole | null
): Promise<JazzLoadDoBindingBackfillPreview> {
  if (role !== "owner") throw new Error("Only owner can run Jazz Load DO binding repair.");
  const currentActor = actor(user, role);
  const timestamp = now();
  const scope = await loadJazzLoadBackfillScope(input);
  const { preview, changedDays } = buildDoBindingBackfillPlan({
    daysByMonth: scope.daysByMonth,
    doLineBindings: scope.doLineBindings,
    fromMonthId: input.fromMonthId,
    toMonthId: input.toMonthId,
    currentBindingMonthId: scope.currentBindingMonthId,
    currentBindingDayNo: scope.currentBindingDayNo,
    backfillId: scope.backfillId,
    actorUid: currentActor.userId,
    timestamp
  });
  if (changedDays.length === 0) return preview;

  const batch = new ChunkedFirestoreBatch(requireDb(), `jazzLoad:doBindingBackfill:${scope.backfillId}`);
  const changedDaysByMonth = new Map<string, JazzLoadDoBindingBackfillChangedDay[]>();

  for (const changedDay of changedDays) {
    const day = changedDay.day;
    changedDaysByMonth.set(day.monthId, [...(changedDaysByMonth.get(day.monthId) ?? []), changedDay]);
    batch.set(dayRef(day.monthId, day.dayNo), cleanForFirestore({
      doEntries: changedDay.updatedEntries,
      lastDoBindingBackfillAt: timestamp,
      lastDoBindingBackfillBy: currentActor.userId,
      lastDoBindingBackfillMode: DO_BINDING_BACKFILL_MODE,
      lastDoBindingBackfillId: scope.backfillId
    }), { merge: true });

    const existingRawSnap = await getDocs(ledgerV2JazzLoadRawEntries(day.monthId, day.dayNo));
    const existingRawIds = new Set(existingRawSnap.docs.map((item) => item.id));
    for (const entry of changedDay.changedEntries) {
      const patch = cleanForFirestore({
        doNameId: entry.doNameId,
        doName: entry.doName,
        doLine: entry.doLine,
        bindingEffectiveFromMonthId: entry.bindingEffectiveFromMonthId,
        bindingEffectiveFromDay: entry.bindingEffectiveFromDay,
        bindingUpdatedAt: entry.bindingUpdatedAt,
        bindingUpdatedBy: entry.bindingUpdatedBy,
        bindingBackfillId: entry.bindingBackfillId,
        bindingBackfillMode: entry.bindingBackfillMode
      });
      batch.set(doc(dayRef(day.monthId, day.dayNo), "doEntries", entry.id), patch, { merge: true });
      const rawId = `do-${entry.id}`;
      if (existingRawIds.has(rawId)) {
        batch.set(doc(ledgerV2JazzLoadRawEntries(day.monthId, day.dayNo), rawId), cleanForFirestore({
          monthId: day.monthId,
          dayNo: day.dayNo,
          raw: patch,
          meta: {
            updatedAt: timestamp,
            updatedBy: currentActor.userId,
            status: typeof navigator !== "undefined" && navigator.onLine ? "pending" : "preview",
            calculationVersion: LEDGER_CALC_VERSION
          }
        }), { merge: true });
      }
    }
  }

  for (const [summaryMonthId] of changedDaysByMonth) {
    const summary = await loadJazzLoadMonthlySummary(summaryMonthId);
    if (!summary) continue;
    batch.set(doc(monthRef(summaryMonthId), "summary", "monthly"), cleanForFirestore({
      doBalances: backfilledSummaryDoBalances(
        summary,
        scope.doLineBindings,
        scope.currentBindingMonthId,
        scope.currentBindingDayNo
      )
    }), { merge: true });
  }

  const auditId = `${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(doc(settingsAuditCollection(), auditId), cleanForFirestore({
    id: auditId,
    action: "do-binding-backfill",
    ...currentActor,
    targetType: "doBindingBackfill",
    targetId: scope.backfillId,
    after: preview,
    createdAt: timestamp
  }));
  stageUnifiedAudit(
    batch,
    {
      id: auditId,
      createdAt: timestamp,
      module: "jazzLoad",
      action: "do-binding-backfill",
      summary: `Applied Jazz Load DO binding repair to ${preview.rowsThatWillChange} row${preview.rowsThatWillChange === 1 ? "" : "s"}`,
      actorUid: currentActor.userId,
      actorEmail: currentActor.userEmail,
      targetType: "doBindingBackfill",
      targetId: scope.backfillId,
      sourcePath: `jazzLoadSettings/audit/items/${auditId}`
    },
    currentActor.userRole ?? "viewer"
  );
  await batch.commit();
  return preview;
}

export function reopenJazzLoadDaysFor15Minutes(
  month: JazzLoadMonth,
  reopenedDays: JazzLoadDay[],
  allDays: JazzLoadDay[],
  user: User | null,
  role: UserRole | null,
  reopenUntilAt?: number
) {
  if (!canReopenDay(role)) throw new Error("Only owner can reopen days.");
  const currentActor = actor(user, role);
  const timestamp = now();
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
    const payload = cleanForFirestore({
      ...day,
      status: "reopen" as const,
      manualOverride: true,
      closedAt: undefined,
      closedBy: undefined,
      lockedAt: undefined,
      lockedBy: undefined,
      lockedByRole: undefined,
      reopenedAt: timestamp,
      reopenedBy: currentActor.userId,
      reopenedByRole: currentActor.userRole,
      reopenedUntilAt: reopenUntilAt,
      updatedBy: currentActor.userId,
      updatedAt: timestamp
    });
    batch.set(
      dayRef(month.id, day.dayNo),
      reopenUntilAt ? payload : {
        ...payload,
        closedAt: deleteField(),
        closedBy: deleteField(),
        lockedAt: deleteField(),
        lockedBy: deleteField(),
        lockedByRole: deleteField(),
        reopenedUntilAt: deleteField()
      },
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
      manualOverride: true,
      closedAt: timestamp,
      closedBy: currentActor.userId,
      lockedAt: timestamp,
      lockedBy: currentActor.userId,
      lockedByRole: currentActor.userRole,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedByRole: undefined,
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
        reopenedByRole: deleteField(),
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
  const [namesSnap, linesSnap, lineBindingsSnap] = await Promise.all([
    getDocs(query(doNameCollection(), orderBy("name", "asc"))),
    getDocs(query(doLineCollection(), orderBy("line", "asc"))),
    getDocs(doLineBindingCollection())
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
    doLineBindings: lineBindingsSnap.docs.map((item) => item.data() as JazzLoadDoLineBinding),
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
  for (const binding of backup.doLineBindings ?? []) batch.set(doc(doLineBindingCollection(), binding.id), cleanForFirestore(binding), { merge: true });
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
