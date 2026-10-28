import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { BarChart3, CalendarDays, FileDown, FileSpreadsheet, GripVertical, Pencil, Printer, RefreshCw, Save, Settings, Trash2, X } from "lucide-react";
import type { LedgerUser, UserRole } from "../../../types/ledger";
import type { SyncState } from "../../../lib/syncStatus";
import { MASTER_REFRESH_ACCESS } from "../../../shared/services/masterRefreshPermissions";
import {
  calculateDailyLifting,
  calculateDailySummary,
  calculateDoRow,
  calculateMonthlySummary,
  latestEntryForDraft,
  previousEntryForDraftAcrossDays,
  resolveDoLineBindingForDate,
  resolveJazzLoadRatesForDay,
  snapshotResolvedRates,
  validateJazzLoadDrafts
} from "../services/jazzLoadCalculations";
import {
  closeJazzLoadDaysExceptToday,
  ensureJazzLoadMonth,
  deleteJazzLoadDoLine,
  deleteJazzLoadDoName,
  deleteJazzLoadRate,
  loadJazzLoadDays,
  applyJazzLoadDoBindingBackfill,
  previewJazzLoadDoBindingBackfill,
  recalculateJazzLoadLedgerLocal,
  reopenJazzLoadDaysFor15Minutes,
  roleCanJazzLoad,
  saveJazzLoadDay,
  subscribeJazzLoadDoLineBindings,
  subscribeJazzLoadDoLines,
  subscribeJazzLoadDoNames,
  subscribeJazzLoadDays,
  subscribeJazzLoadDoProfiles,
  subscribeJazzLoadMonthlySummary,
  subscribeJazzLoadMonths,
  subscribeJazzLoadRates,
  updateJazzLoadDoLineSortOrder,
  updateJazzLoadDoNameSortOrder,
  updateJazzLoadRateSortOrder,
  upsertJazzLoadDoLineBinding,
  upsertJazzLoadDoLine,
  upsertJazzLoadDoName,
  upsertJazzLoadDoProfile,
  upsertJazzLoadRate,
  type FirestoreSnapshotMeta
} from "../services/jazzLoadFirestore";
import { exportJazzLoadPrintable, exportJazzLoadXlsx } from "../services/jazzLoadReports";
import {
  getJazzLoadSaveState,
  type JazzLoadSaveBlockReason
} from "../services/jazzLoadSaveState";
import type {
  ActiveJazzLoadRates,
  JazzLoadDay,
  JazzLoadDoBindingBackfillPreview,
  JazzLoadDoEntryDraft,
  JazzLoadDoLine,
  JazzLoadDoLineBinding,
  JazzLoadDoName,
  JazzLoadDoProfile,
  JazzLoadMonth,
  JazzLoadMonthlySummary,
  JazzLoadRateConfig,
  JazzLoadRateType,
  ValidationResult
} from "../types/jazzLoad.types";
import {
  dayDate,
  daysInMonth,
  formatCurrency,
  formatPercentage,
  monthLabel,
  normalizeDoKey,
  parseMoneyInput
} from "../utils/jazzLoadFormatters";
import { UniversalCalendar } from "../../../shared/calendar/UniversalCalendar";
import { UniversalDayControlBar } from "../../../shared/dayControls/UniversalDayControlBar";
import { useSidebarDayControls } from "../../../shared/context/SidebarDayControlsContext";
import { useSelectedDate } from "../../../shared/context/SelectedDateContext";
import { canEditOperationalDailyEntry, canReopenDay, isActiveReopenWindow, isAdminEditableReopenedDay } from "../../../shared/services/dayEditPermissions";
import { resolveUniversalDayStatus, statusLabel } from "../../../shared/services/dayStatusService";
import { useAutoSaveEntry } from "../../../shared/hooks/useAutoSaveEntry";
import { runMasterRecalculation } from "../../../shared/services/masterRecalculationService";
import { resolveLedgerUiReadDecision } from "../../../shared/ledger/ledgerReadMode";
import type { LedgerReadModeConfig } from "../../../shared/ledger/ledgerTypes";
import type { MasterRecalculationAdapter, UniversalDaySnapshot } from "../../../shared/types/dayControl.types";
import { applySortOrder, changedSortOrderPatches, orderedBySortOrder, reorderItems } from "../../../shared/services/orderUtils";
import { createJazzLoadRecalculationAdapter } from "../adapters/jazzLoadRecalculationAdapter";
import { SaveProgressDialog, type SaveProgressState } from "../../../shared/components/SaveProgressDialog";
import { isPostgreSqlPeriod, getAccountingPeriodWithDays } from "../../../services/api/periodDayService";
import { saveJazzLoadDayPostgres, loadJazzLoadDayPostgres, loadJazzLoadMonthPostgres } from "../../../services/api/jazzLoadTransactionService";
import { ledgerApiClient } from "../../../services/api/ledgerApiClient";
import { closeOperationalDayUnified, reopenOperationalDayUnified, subscribeDayStatus } from "../../../services/api/dayLifecycleService";

export function isServerLoadedJazzDay(day?: JazzLoadDay | null): boolean {
  if (!day) return false;
  if (
    (day.doEntries && day.doEntries.length > 0) ||
    (day.lifting && (day.lifting.mlLifting > 0 || day.lifting.openingBalance > 0)) ||
    Boolean(day.notes)
  ) {
    return true;
  }
  return false;
}

type JazzLoadSection = "daily" | "dashboard" | "reports" | "settings" | "backup";
type JazzLoadPopup = {
  kind: "success" | "warning" | "error";
  text: string;
};

function shouldLogJazzLoadSaveDebug() {
  if (import.meta.env.DEV) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("jazzLoadSaveDebug") === "true" ||
      window.localStorage.getItem("permissionDebug") === "true";
  } catch {
    return false;
  }
}

function debugJazzLoadSaveBlock(input: {
  source: "autosave" | "manual-save" | "verified-save" | "save-guard";
  reason: JazzLoadSaveBlockReason | "Permission denied";
  detail: string;
  role: UserRole | null;
  monthId: string;
  dayNo: number;
  selectedDayLive: boolean;
  selectedDayFuture: boolean;
}) {
  if (!shouldLogJazzLoadSaveDebug()) return;
  console.info("[jazz-load-save-debug]", input);
}

function normalizeSaveError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /permission|insufficient/i.test(message) ? "Permission denied" : message;
}

type Props = {
  user: LedgerUser;
  role: UserRole | null;
  monthId: string;
  syncState: SyncState;
  syncLabel: string;
  onSnapshotMetadata: (metadata: FirestoreSnapshotMeta) => void;
  onFirestoreError: (message: string) => void;
  onQueueWrite: (promise: Promise<unknown>, failureMessage: string) => void;
  onStatus: (message: string) => void;
  onExportBackup: () => void;
  onImportBackup: (file: File | null) => void;
  onTriggerMasterRefresh?: (adapter: MasterRecalculationAdapter, title: string) => Promise<void>;
  ledgerReadModeConfig: LedgerReadModeConfig;
  loading?: boolean;
  onPendingStateChange?: (pending: boolean) => void;
};

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function currentMonthId(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function currentDateState(date = new Date()) {
  return {
    monthId: currentMonthId(date),
    dayNo: date.getDate()
  };
}

function compareMonthIds(left: string, right: string) {
  return left.localeCompare(right);
}

function isFutureJazzDay(monthId: string, dayNo: number, now = new Date()) {
  const liveDate = currentDateState(now);
  return compareMonthIds(monthId, liveDate.monthId) > 0 || (monthId === liveDate.monthId && dayNo > liveDate.dayNo);
}

function availableJazzLoadDayNumbers(monthId: string, now = new Date()) {
  const liveDate = currentDateState(now);
  if (compareMonthIds(monthId, liveDate.monthId) > 0) return [];
  const maxDay = monthId === liveDate.monthId ? liveDate.dayNo : daysInMonth(monthId);
  return Array.from({ length: maxDay }, (_, index) => index + 1);
}

function datePartsFromInput(dateText: string, fallbackMonthId: string, fallbackDay: number) {
  const [year, month, day] = dateText.split("-").map(Number);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return { monthId: fallbackMonthId, dayNo: fallbackDay };
  }
  const nextMonthId = `${year}-${pad2(month)}`;
  const maxDay = daysInMonth(nextMonthId);
  return {
    monthId: nextMonthId,
    dayNo: Math.min(Math.max(day, 1), maxDay)
  };
}

function bindingEffectiveDateLabel(binding: Pick<JazzLoadDoLineBinding, "effectiveFromMonthId" | "effectiveFromDay">) {
  return `${binding.effectiveFromMonthId}-${pad2(binding.effectiveFromDay)}`;
}

function formatDoBindingBackfillPreview(preview: JazzLoadDoBindingBackfillPreview) {
  const lines = [
    `Days scanned: ${preview.daysScanned}`,
    `Rows scanned: ${preview.rowsScanned}`,
    `Rows that will change: ${preview.rowsThatWillChange}`,
    `Rows already correct: ${preview.rowsAlreadyCorrect}`,
    `Rows missing binding: ${preview.rowsMissingBinding}`,
    `Rows skipped because no current binding exists: ${preview.rowsSkippedNoCurrentBinding}`
  ];
  if (preview.sampleChanges.length > 0) {
    lines.push(
      "",
      "Sample changes:",
      ...preview.sampleChanges.map((sample) =>
        `${sample.monthId} day ${sample.dayNo} ${sample.doLine ?? sample.doLineId ?? "DO line"}: ${sample.oldDoName || "(blank)"} -> ${sample.newDoName}`
      )
    );
  }
  return lines.join("\n");
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID();
}

function doNameIdentityKey(input: { doNameId?: string; doName?: string }) {
  const name = input.doName?.trim() ?? "";
  if (!input.doNameId && !name) return "";
  return input.doNameId ?? normalizeDoKey(name);
}

function activeRateFor(rates: JazzLoadRateConfig[], primaryType: JazzLoadRateType, legacyTypes: JazzLoadRateType[] = []) {
  return rates.find((rate) => rate.active && rate.type === primaryType) ??
    rates.find((rate) => rate.active && legacyTypes.includes(rate.type)) ??
    null;
}

function NumberInput({
  value,
  onChange,
  disabled,
  onFocus,
  onBlur
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}) {
  const formatInputValue = (nextValue: number) => nextValue ? String(Math.round(nextValue)) : "";
  const [text, setText] = useState(formatInputValue(value));
  const [focused, setFocused] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (focused || dirtyRef.current) return;
    setText(formatInputValue(value));
  }, [focused, value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onFocus={() => {
        dirtyRef.current = false;
        setFocused(true);
        onFocus?.();
      }}
      onChange={(event) => {
        const next = event.target.value;
        if (!/^\d*\.?\d*$/.test(next)) return;
        dirtyRef.current = true;
        setText(next);
        const parsed = parseMoneyInput(next);
        if (!Number.isNaN(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        const parsed = parseMoneyInput(text);
        if (Number.isNaN(parsed)) {
          setText("");
          if (dirtyRef.current && value !== 0) onChange(0);
          dirtyRef.current = false;
          setFocused(false);
          onBlur?.();
          return;
        }
        setText(formatInputValue(parsed));
        if (dirtyRef.current && parsed !== value) {
          onChange(parsed);
        }
        dirtyRef.current = false;
        setFocused(false);
        onBlur?.();
      }}
    />
  );
}

function jazzDraftStateSignature(input: {
  drafts: JazzLoadDoEntryDraft[];
  liftingOpening: number;
  mlLifting: number;
  dayNotes: string;
}) {
  return JSON.stringify({
    drafts: input.drafts.map((draft) => ({
      id: draft.id,
      doProfileId: draft.doProfileId,
      doNameId: draft.doNameId,
      doLineId: draft.doLineId,
      assignmentId: draft.assignmentId,
      doName: draft.doName,
      doLine: draft.doLine,
      doLineSortOrder: draft.doLineSortOrder,
      openingBase: draft.openingBase ?? 0,
      todayMlIssuanceBase: draft.todayMlIssuanceBase ?? 0,
      paymentReceivedBase: draft.paymentReceivedBase ?? 0,
      notes: draft.notes ?? ""
    })),
    liftingOpening: input.liftingOpening,
    mlLifting: input.mlLifting,
    dayNotes: input.dayNotes
  });
}

function MetricCard({ label, value, helper }: { label: string; value: string; helper: string }) {
  return (
    <div className="card card-pad">
      <p className="text-sm font-medium text-slate-400">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-white">{value}</p>
      <p className="mt-3 text-xs text-slate-500">{helper}</p>
    </div>
  );
}

function jazzCarryForwardWarnings(days: JazzLoadDay[], previousMonthDays: JazzLoadDay[]) {
  const day1 = days.find((day) => day.dayNo === 1);
  const previousFinalDay = [...previousMonthDays].sort((a, b) => a.dayNo - b.dayNo).at(-1);
  if (!day1 || !previousFinalDay) return [];
  const warnings: string[] = [];
  if (day1.lifting.openingBalance !== previousFinalDay.lifting.inHandBalance) {
    warnings.push(`lifting opening ${formatCurrency(day1.lifting.openingBalance)} should equal previous month in-hand ${formatCurrency(previousFinalDay.lifting.inHandBalance)}`);
  }
  for (const entry of day1.doEntries) {
    const previous = latestEntryForDraft(previousMonthDays, entry);
    if (!previous) continue;
    const expected = previous.closingBalance.baseAmount;
    const actual = entry.openingBalance.baseAmount;
    if (actual !== expected) {
      warnings.push(`${entry.doName}${entry.doLine ? ` ${entry.doLine}` : ""} opening ${formatCurrency(actual)} should equal previous month closing ${formatCurrency(expected)}`);
    }
  }
  return warnings;
}

function asDraft(entry: JazzLoadDay["doEntries"][number]): JazzLoadDoEntryDraft {
  return {
    id: entry.id,
    doProfileId: entry.doProfileId,
    doNameId: entry.doNameId,
    doLineId: entry.doLineId,
    assignmentId: entry.assignmentId,
    doName: entry.doName,
    doLine: entry.doLine,
    doLineSortOrder: entry.doLineSortOrder,
    bindingEffectiveFromMonthId: entry.bindingEffectiveFromMonthId,
    bindingEffectiveFromDay: entry.bindingEffectiveFromDay,
    bindingUpdatedAt: entry.bindingUpdatedAt,
    bindingUpdatedBy: entry.bindingUpdatedBy,
    bindingBackfillId: entry.bindingBackfillId,
    bindingBackfillMode: entry.bindingBackfillMode,
    openingBase: entry.openingBalance.baseAmount,
    todayMlIssuanceBase: entry.todayMlIssuance.baseAmount,
    paymentReceivedBase: entry.paymentReceived.baseAmount,
    notes: entry.notes
  };
}

export function JazzLoadModule({
  user,
  role,
  monthId,
  syncState,
  syncLabel,
  onSnapshotMetadata,
  onFirestoreError,
  onQueueWrite,
  onStatus,
  onExportBackup,
  onImportBackup,
  onTriggerMasterRefresh,
  ledgerReadModeConfig,
  loading,
  onPendingStateChange
}: Props) {
  const { selectedDay, setSelectedDay } = useSelectedDate();
  const [section, setSection] = useState<JazzLoadSection>("daily");
  const [months, setMonths] = useState<JazzLoadMonth[]>([]);
  const [days, setDays] = useState<JazzLoadDay[]>([]);
  const [jazzDaysInitialized, setJazzDaysInitialized] = useState(false);
  const [jazzPreviousMonthInitialized, setJazzPreviousMonthInitialized] = useState(false);
  const [jazzSettingsInitialized, setJazzSettingsInitialized] = useState({
    rates: false,
    profiles: false,
    names: false,
    lines: false,
    bindings: false,
    months: false
  });
  const [previousMonthDays, setPreviousMonthDays] = useState<JazzLoadDay[]>([]);
  const [summary, setSummary] = useState<JazzLoadMonthlySummary | null>(null);
  const [rates, setRates] = useState<JazzLoadRateConfig[]>([]);
  const [doProfiles, setDoProfiles] = useState<JazzLoadDoProfile[]>([]);
  const [doNames, setDoNames] = useState<JazzLoadDoName[]>([]);
  const [doLines, setDoLines] = useState<JazzLoadDoLine[]>([]);
  const [doLineBindings, setDoLineBindings] = useState<JazzLoadDoLineBinding[]>([]);
  const [drafts, setDrafts] = useState<JazzLoadDoEntryDraft[]>([]);
  const [liftingOpening, setLiftingOpening] = useState(0);
  const [mlLifting, setMlLifting] = useState(0);
  const [dayNotes, setDayNotes] = useState("");
  const [rateName, setRateName] = useState("");
  const [rateType, setRateType] = useState<JazzLoadRateType>("ml_addition");
  const [ratePercentage, setRatePercentage] = useState(0);
  const [editingRateId, setEditingRateId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileLine, setProfileLine] = useState("");
  const [doNameDraft, setDoNameDraft] = useState("");
  const [doLineDraft, setDoLineDraft] = useState("");
  const [bindingLineId, setBindingLineId] = useState("");
  const [bindingDoNameId, setBindingDoNameId] = useState("");
  const [bindingEffectiveDate, setBindingEffectiveDate] = useState("");
  const [bindingBackfillFromMonthId, setBindingBackfillFromMonthId] = useState(monthId);
  const [bindingBackfillToMonthId, setBindingBackfillToMonthId] = useState(monthId);
  const [bindingBackfillPreview, setBindingBackfillPreview] = useState<JazzLoadDoBindingBackfillPreview | null>(null);
  const [bindingBackfillRunning, setBindingBackfillRunning] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [bulkReopening, setBulkReopening] = useState<"selected" | "all" | null>(null);
  const [bulkClosingDays, setBulkClosingDays] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [popup, setPopup] = useState<JazzLoadPopup | null>(null);
  const [verifiedSave, setVerifiedSave] = useState<SaveProgressState>(null);
  const [pgSeedsVerified, setPgSeedsVerified] = useState(false);
  const [pgJazzDoOpenings, setPgJazzDoOpenings] = useState<Map<string, number>>(new Map());
  const pgLiftingOpeningSeedRef = useRef<number | null>(null);
  const ledgerReadDecision = useMemo(
    () => resolveLedgerUiReadDecision({ config: ledgerReadModeConfig, module: "jazzLoad", role, monthId }),
    [ledgerReadModeConfig, monthId, role]
  );
  const lastSavedRef = useRef("");
  const draftHydrationKeyRef = useRef("");
  const draftDirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const inFlightSavePromiseRef = useRef<Promise<void> | null>(null);
  const focusedDraftFieldsRef = useRef(new Set<string>());
  const draftsRef = useRef(drafts);
  const liftingOpeningRef = useRef(liftingOpening);
  const mlLiftingRef = useRef(mlLifting);
  const dayNotesRef = useRef(dayNotes);
  const closedDayKeysRef = useRef(new Set<string>());
  const lastSystemMessageRef = useRef("");
  const callbacksRef = useRef({
    onSnapshotMetadata,
    onFirestoreError
  });

  useEffect(() => {
    callbacksRef.current = {
      onSnapshotMetadata,
      onFirestoreError
    };
  }, [onFirestoreError, onSnapshotMetadata]);

  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  useEffect(() => {
    liftingOpeningRef.current = liftingOpening;
  }, [liftingOpening]);

  useEffect(() => {
    mlLiftingRef.current = mlLifting;
  }, [mlLifting]);

  useEffect(() => {
    dayNotesRef.current = dayNotes;
  }, [dayNotes]);

  useEffect(() => {
    draftDirtyRef.current = false;
    focusedDraftFieldsRef.current.clear();
    draftHydrationKeyRef.current = "";
  }, [monthId, selectedDay]);

  useEffect(() => {
    setBindingBackfillFromMonthId(monthId);
    setBindingBackfillToMonthId(monthId);
    setBindingBackfillPreview(null);
  }, [monthId]);

  function markDraftDirty() {
    draftDirtyRef.current = true;
  }

  function focusDraftField(fieldId: string) {
    focusedDraftFieldsRef.current.add(fieldId);
  }

  function blurDraftField(fieldId: string) {
    focusedDraftFieldsRef.current.delete(fieldId);
  }

  function currentDraftStateSignature() {
    return jazzDraftStateSignature({
      drafts: draftsRef.current,
      liftingOpening: liftingOpeningRef.current,
      mlLifting: mlLiftingRef.current,
      dayNotes: dayNotesRef.current
    });
  }

  function shouldApplyRemoteDraftState(hydrationKey: string) {
    if (draftHydrationKeyRef.current !== hydrationKey) return true;
    if (focusedDraftFieldsRef.current.size > 0 || draftDirtyRef.current) return false;
    return true;
  }

  function applyRemoteDraftState(input: {
    hydrationKey: string;
    drafts: JazzLoadDoEntryDraft[];
    liftingOpening: number;
    mlLifting: number;
    dayNotes: string;
  }) {
    if (!shouldApplyRemoteDraftState(input.hydrationKey)) return;
    setDrafts(input.drafts);
    if (isPostgreSqlPeriod(monthId) && selectedDay === 1 && input.liftingOpening === 0 && (pgLiftingOpeningSeedRef.current !== null || liftingOpening > 0)) {
      setLiftingOpening(pgLiftingOpeningSeedRef.current ?? liftingOpening);
    } else {
      setLiftingOpening(input.liftingOpening);
    }
    setMlLifting(input.mlLifting);
    setDayNotes(input.dayNotes);
    draftHydrationKeyRef.current = input.hydrationKey;
    draftDirtyRef.current = false;
  }

  function markJazzSettingInitialized(key: keyof typeof jazzSettingsInitialized) {
    setJazzSettingsInitialized((current) => ({ ...current, [key]: true }));
  }

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const maxDay = daysInMonth(monthId);
    if (selectedDay > maxDay) setSelectedDay(maxDay);
  }, [monthId, selectedDay]);

  function pushPopup(kind: JazzLoadPopup["kind"], text: string, alsoStatus = true) {
    setPopup({ kind, text });
    if (alsoStatus) onStatus(text);
  }

  function dismissPopup() {
    setPopup(null);
  }

  const currentMonth = months.find((month) => month.id === monthId);
  const selectedDayRecord = days.find((day) => day.monthId === monthId && day.dayNo === selectedDay);
  const latestPriorDay = selectedDay === 1
    ? [...previousMonthDays].sort((a, b) => a.dayNo - b.dayNo).at(-1)
    : [...days].filter((day) => day.dayNo < selectedDay).sort((a, b) => a.dayNo - b.dayNo).at(-1);
  const selectedDate = dayDate(monthId, selectedDay);
  const selectedDayFuture = isFutureJazzDay(monthId, selectedDay, now);
  const selectedDayLive = monthId === currentMonthId(now) && selectedDay === now.getDate();
  const selectedDayCorrectionActive = isActiveReopenWindow(selectedDayRecord, now.getTime());
  const selectedDayClosed = Boolean(
    selectedDayRecord &&
    (
      selectedDayRecord.status === "closed" ||
      (selectedDayRecord.status !== "reopen" && selectedDayRecord.status !== "open" && (selectedDayRecord.lockedAt != null || selectedDayRecord.closedAt != null))
    ) &&
    !selectedDayCorrectionActive
  );
  const adminCanEditSelectedDay = role === "admin" && (
    selectedDayLive ||
    !selectedDayClosed ||
    (!selectedDayLive && isAdminEditableReopenedDay(selectedDayRecord, now.getTime()))
  );
  const activeRates: ActiveJazzLoadRates = useMemo(
    () => ({
      mlRate: activeRateFor(rates, "ml_addition"),
      commission1Rate: activeRateFor(rates, "commission1_adjustment", ["adjustment"]),
      commission2Rate: activeRateFor(rates, "commission2_payment", ["commission"])
    }),
    [rates]
  );
  const selectedRateResolution = useMemo(
    () => resolveJazzLoadRatesForDay({
      dayRecord: selectedDayRecord,
      activeRates,
      mode: selectedDayRecord ? "existing-day" : "new-day"
    }),
    [activeRates, selectedDayRecord]
  );
  const selectedCalculationRates = selectedRateResolution.rates;
  const canRead = roleCanJazzLoad(role, "read");
  const canWriteDaily = roleCanJazzLoad(role, "daily");
  const canRunMasterRefresh = roleCanJazzLoad(role, MASTER_REFRESH_ACCESS);
  const canEditDaily = canEditOperationalDailyEntry({
    role,
    canWriteDaily,
    monthClosed: currentMonth?.status === "closed",
    isFutureDay: selectedDayFuture,
    isLiveDay: selectedDayLive,
    dayClosed: selectedDayClosed,
    day: selectedDayRecord,
    nowMs: now.getTime()
  });
  const jazzCalendarDays = useMemo<UniversalDaySnapshot[]>(() => {
    return Array.from({ length: daysInMonth(monthId) }, (_, index) => {
      const dayNo = index + 1;
      const day = days.find((entry) => entry.dayNo === dayNo);
      const future = isFutureJazzDay(monthId, dayNo, now);
      const live = monthId === currentMonthId(now) && dayNo === now.getDate();
      const status = resolveUniversalDayStatus({
          exists: Boolean(day),
          future,
          live,
          day,
          nowMs: now.getTime()
        });
      return {
        moduleKey: "jazzLoad",
        monthId,
        dayNo,
        future,
        saved: Boolean(day),
        dateLabel: dayDate(monthId, dayNo),
        reopenedUntilAt: day?.reopenedUntilAt,
        reopenedAt: day?.reopenedAt,
        disabledReason: future ? "Future Jazz Load days are disabled and cannot create records." : undefined,
        status
      };
    });
  }, [days, jazzDaysInitialized, monthId, now]);
  const selectedJazzStatus = jazzCalendarDays.find((day) => day.dayNo === selectedDay)?.status ?? "open";
  const canManageSettings = roleCanJazzLoad(role, "settings");
  const canBackup = roleCanJazzLoad(role, "backup");
  const orderedRates = useMemo(() => orderedBySortOrder(rates), [rates]);
  const orderedDoNames = useMemo(() => orderedBySortOrder(doNames), [doNames]);
  const orderedDoLines = useMemo(() => orderedBySortOrder(doLines), [doLines]);
  const activeLines = useMemo(() => orderedDoLines.filter((line) => line.active), [orderedDoLines]);
  const activeDoNames = useMemo(() => orderedDoNames.filter((name) => name.active), [orderedDoNames]);
  const [displayRates, setDisplayRates] = useState(orderedRates);
  const [displayDoNames, setDisplayDoNames] = useState(orderedDoNames);
  const [displayDoLines, setDisplayDoLines] = useState(orderedDoLines);
  const draggedRateIdRef = useRef<string | null>(null);
  const draggedDoNameIdRef = useRef<string | null>(null);
  const draggedDoLineIdRef = useRef<string | null>(null);
  const jazzSettingsReady = Object.values(jazzSettingsInitialized).every(Boolean);
  const jazzDailyReady = jazzSettingsReady && jazzDaysInitialized && jazzPreviousMonthInitialized;

  useEffect(() => setDisplayRates(orderedRates), [orderedRates]);
  useEffect(() => setDisplayDoNames(orderedDoNames), [orderedDoNames]);
  useEffect(() => setDisplayDoLines(orderedDoLines), [orderedDoLines]);

  useEffect(() => {
    if (isPostgreSqlPeriod(monthId)) {
      if (!user) return;
      void ledgerApiClient.catalogs.getJazzLoadDoProfiles().then((res) => {
        const profiles = res.data || [];
        const now = Date.now();
        const mappedProfiles: JazzLoadDoProfile[] = profiles.map((p: any) => ({
          id: p.id,
          name: p.do_name,
          line: p.do_line,
          active: p.is_active,
          sortOrder: p.sort_order,
          createdAt: p.created_at ? new Date(p.created_at).getTime() : now,
          updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : now
        }));
        const mappedLines: JazzLoadDoLine[] = profiles.map((p: any) => ({
          id: p.id,
          line: p.do_line,
          active: p.is_active,
          sortOrder: p.sort_order,
          createdAt: p.created_at ? new Date(p.created_at).getTime() : now,
          updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : now
        }));
        const mappedNames: JazzLoadDoName[] = profiles.map((p: any) => ({
          id: p.id,
          name: p.do_name,
          active: p.is_active,
          sortOrder: p.sort_order,
          createdAt: p.created_at ? new Date(p.created_at).getTime() : now,
          updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : now
        }));
        const mappedBindings: JazzLoadDoLineBinding[] = profiles.map((p: any) => ({
          id: p.id,
          doLineId: p.id,
          doLineName: p.do_line,
          doNameId: p.id,
          doName: p.do_name,
          effectiveFromMonthId: "2026-08",
          effectiveFromDay: 1,
          createdBy: "system",
          createdAt: now
        }));
        setDoProfiles(mappedProfiles);
        setDoLines(mappedLines);
        setDoNames(mappedNames);
        setDoLineBindings(mappedBindings);
        markJazzSettingInitialized("profiles");
        markJazzSettingInitialized("lines");
        markJazzSettingInitialized("names");
        markJazzSettingInitialized("bindings");
      }).catch((err) => {
        console.warn("[JazzLoadModule] Could not load DO profiles from PostgreSQL:", err);
      });

      void ledgerApiClient.periods.list().then((res) => {
        const pgMonths: JazzLoadMonth[] = (res.periods || []).map((p) => ({
          id: p.period_key,
          label: p.label || p.period_key,
          status: p.status as "open" | "closed",
          createdBy: "system",
          createdAt: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
          updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : Date.now()
        }));
        setMonths(pgMonths);
        markJazzSettingInitialized("months");
      }).catch(() => {
        markJazzSettingInitialized("months");
      });

      void getAccountingPeriodWithDays(monthId).then(async (periodData) => {
        if (!periodData) return;
        try {
          const seedsRes = await ledgerApiClient.periods.getSeeds(periodData.period.id);
          if (seedsRes?.seeds) {
            const liftOpening = Number(seedsRes.seeds.financial?.opening_jazz_lifting ?? 0);
            pgLiftingOpeningSeedRef.current = liftOpening;
            setLiftingOpening(liftOpening);
            const verified = Boolean(seedsRes.isVerified ?? seedsRes.seeds?.isVerified);
            setPgSeedsVerified(verified);
            const doOpenings = new Map<string, number>();
            for (const jd of (seedsRes.seeds.jazzDoProfiles || seedsRes.seeds.jazz_do || [])) {
              doOpenings.set(jd.do_profile_id, Number(jd.opening_base_balance ?? 0));
            }
            setPgJazzDoOpenings(doOpenings);
          }
        } catch (err) {
          console.warn("[JazzLoadModule] Could not load PostgreSQL seeds:", err);
        }
      });

      void ledgerApiClient.catalogs.getJazzLoadRates().then((res) => {
        const mappedRates: JazzLoadRateConfig[] = [];
        for (const row of res.data || []) {
          mappedRates.push({ id: row.id + '_ml', type: 'ml_addition', percentage: Number(row.ml_rate), active: row.is_active, sortOrder: 1, name: row.name + ' ML', createdBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
          mappedRates.push({ id: row.id + '_c1', type: 'commission1_adjustment', percentage: Number(row.comm1_rate), active: row.is_active, sortOrder: 2, name: row.name + ' Comm1', createdBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
          mappedRates.push({ id: row.id + '_c2', type: 'commission2_payment', percentage: Number(row.comm2_rate), active: row.is_active, sortOrder: 3, name: row.name + ' Comm2', createdBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
        }
        setRates(mappedRates);
        markJazzSettingInitialized("rates");
      }).catch(() => {
        markJazzSettingInitialized("rates");
      });
      return;
    }

    const unsubscribers = [
      subscribeJazzLoadDoProfiles((items, metadata) => {
        setDoProfiles(items);
        markJazzSettingInitialized("profiles");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadDoNames((items, metadata) => {
        setDoNames(items);
        markJazzSettingInitialized("names");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadDoLines((items, metadata) => {
        setDoLines(items);
        markJazzSettingInitialized("lines");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadDoLineBindings((items, metadata) => {
        setDoLineBindings(items);
        markJazzSettingInitialized("bindings");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadRates((items, metadata) => {
        setRates(items);
        markJazzSettingInitialized("rates");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadMonths((items, metadata) => {
        setMonths(items);
        markJazzSettingInitialized("months");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message))
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [monthId, user]);

  useEffect(() => {
    setJazzDaysInitialized(false);
  }, [monthId]);

  useEffect(() => {
    if (isPostgreSqlPeriod(monthId)) {
      let cancelled = false;
      void getAccountingPeriodWithDays(monthId).then((periodData) => {
        if (cancelled || !periodData) {
          if (!cancelled) setJazzDaysInitialized(true);
          return;
        }
        const pgJazzDays: JazzLoadDay[] = [];
        const dayCount = periodData.days?.size || daysInMonth(monthId);
        for (let d = 1; d <= dayCount; d++) {
          const dayRec = periodData.days?.get(d);
          const status = (dayRec?.status ?? "closed") as JazzLoadDay["status"];
          const isClosed = status === "closed";
          const closedTimestamp = isClosed && dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : undefined;
          const reopenedTimestamp = dayRec?.reopened_at ? new Date(dayRec.reopened_at).getTime() : undefined;
          if (isClosed) {
            closedDayKeysRef.current.add(`${monthId}/${d}`);
          }
          pgJazzDays.push({
            id: `${monthId}-${String(d).padStart(2, "0")}`,
            monthId,
            dayNo: d,
            date: dayDate(monthId, d),
            status,
            manualOverride: isClosed,
            doEntries: [],
            lifting: calculateDailyLifting({ openingBalance: 0, mlLifting: 0 }, 0),
            summary: calculateDailySummary({ doEntries: [] }, activeRates),
            createdBy: "system",
            createdAt: 0,
            updatedAt: 0,
            closedAt: closedTimestamp,
            lockedAt: isClosed ? (closedTimestamp ?? Date.now()) : undefined,
            reopenedAt: reopenedTimestamp
          });
        }
        if (!cancelled) {
          setDays((currentDays) => {
            if (currentDays.length === 0) return pgJazzDays;
            const currentMap = new Map(currentDays.map((d) => [d.dayNo, d]));
            return pgJazzDays.map((pgDay) => {
              const existing = currentMap.get(pgDay.dayNo);
              if (existing && isServerLoadedJazzDay(existing)) {
                return {
                  ...pgDay,
                  ...existing,
                  status: pgDay.status,
                  lockedAt: pgDay.lockedAt,
                  closedAt: pgDay.closedAt,
                  reopenedAt: pgDay.reopenedAt
                };
              }
              return pgDay;
            });
          });
          setJazzDaysInitialized(true);

          void loadJazzLoadMonthPostgres(monthId, doProfiles, rates)
            .then((monthDays) => {
              if (cancelled) return;
              if (monthDays && monthDays.length > 0) {
                setDays((current) => {
                  if (!current || current.length === 0) return monthDays;
                  const monthDaysMap = new Map(monthDays.map((d) => [d.dayNo, d]));
                  const updated = current.map((existingDay) => {
                    const loaded = monthDaysMap.get(existingDay.dayNo);
                    if (!loaded) return existingDay;
                    if (!isServerLoadedJazzDay(existingDay)) return loaded;
                    if (existingDay.updatedAt && loaded.updatedAt && existingDay.updatedAt > loaded.updatedAt) {
                      return existingDay;
                    }
                    return loaded;
                  });
                  for (const loaded of monthDays) {
                    if (!updated.some((d) => d.dayNo === loaded.dayNo)) {
                      updated.push(loaded);
                    }
                  }
                  return updated.sort((a, b) => a.dayNo - b.dayNo);
                });
                setSummary(calculateMonthlySummary(monthId, monthDays));
              }
            })
            .catch((err) => {
              console.warn("[JazzLoadModule] Failed to load month days from PostgreSQL:", err);
            });
        }
      }).catch((err) => {
        console.warn("[JazzLoadModule] Failed to load PostgreSQL days:", err);
        if (!cancelled) setJazzDaysInitialized(true);
      });
      return () => {
        cancelled = true;
      };
    }
    const unsubscribers = [
      subscribeJazzLoadDays(monthId, (items, metadata) => {
        setDays(items);
        setJazzDaysInitialized(true);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message), { readDecision: ledgerReadDecision }),
      subscribeJazzLoadMonthlySummary(monthId, (item, metadata) => {
        setSummary(item);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message), { readDecision: ledgerReadDecision })
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [ledgerReadDecision, monthId]);

  useEffect(() => {
    if (isPostgreSqlPeriod(monthId)) {
      setJazzPreviousMonthInitialized(true);
      return;
    }
    let cancelled = false;
    setJazzPreviousMonthInitialized(false);
    async function loadPreviousMonth() {
      const [yearText, monthText] = monthId.split("-");
      const year = Number(yearText);
      const month = Number(monthText);
      if (!Number.isInteger(year) || !Number.isInteger(month)) {
        setPreviousMonthDays([]);
        setJazzPreviousMonthInitialized(true);
        return;
      }
      const previousMonthId = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
      try {
        const items = await loadJazzLoadDays(previousMonthId);
        if (!cancelled) {
          setPreviousMonthDays(items);
          setJazzPreviousMonthInitialized(true);
        }
      } catch {
        if (!cancelled) {
          setPreviousMonthDays([]);
          setJazzPreviousMonthInitialized(true);
        }
      }
    }
    void loadPreviousMonth();
    return () => {
      cancelled = true;
    };
  }, [monthId]);

  useEffect(() => {
    if (!user || !isPostgreSqlPeriod(monthId) || doProfiles.length === 0) return;
    let cancelled = false;
    void loadJazzLoadDayPostgres(monthId, selectedDay, doProfiles, rates).then((loadedDay) => {
      if (!cancelled && loadedDay) {
        setDays((current) => {
          const exists = current.some((d) => d.dayNo === loadedDay.dayNo);
          if (exists) {
            return current.map((d) => (d.dayNo === loadedDay.dayNo ? loadedDay : d));
          }
          return [...current, loadedDay].sort((a, b) => a.dayNo - b.dayNo);
        });
      }
    }).catch((err) => {
      console.warn("[JazzLoadModule] Failed to load day transactions from PostgreSQL:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [doProfiles, monthId, rates, selectedDay, user]);

  useEffect(() => {
    const hydrationKey = `${monthId}-${selectedDay}`;
    if (selectedDayFuture) {
      applyRemoteDraftState({
        hydrationKey,
        drafts: [],
        liftingOpening: 0,
        mlLifting: 0,
        dayNotes: ""
      });
      return;
    }
    if (!jazzDailyReady) return;
    const savedEntries = selectedDayRecord?.doEntries ?? [];
    const savedByLine = new Map(savedEntries.map((entry) => [entry.doLineId ?? entry.doLine ?? entry.id, entry]));
    const usedSavedEntryIds = new Set<string>();
    if (selectedDayRecord) {
      const lineDrafts = activeLines.map((line) => {
        const saved = savedByLine.get(line.id) ?? savedByLine.get(line.line);
        const binding = resolveDoLineBindingForDate(doLineBindings, line.id, monthId, selectedDay);
        if (saved) {
          usedSavedEntryIds.add(saved.id);
          const hasSavedName = (saved.doName ?? "").trim().length > 0;
          const savedNameMatchesBinding = Boolean(
            binding &&
            doNameIdentityKey(saved) === doNameIdentityKey({ doNameId: binding.doNameId, doName: binding.doName })
          );
          return {
            ...asDraft(saved),
            doLineId: line.id,
            doLine: line.line,
            doLineSortOrder: line.sortOrder,
            doNameId: hasSavedName ? saved.doNameId : binding?.doNameId,
            doName: hasSavedName ? saved.doName : binding?.doName ?? "",
            bindingEffectiveFromMonthId: hasSavedName
              ? saved.bindingEffectiveFromMonthId ?? (savedNameMatchesBinding ? binding?.effectiveFromMonthId : undefined)
              : binding?.effectiveFromMonthId,
            bindingEffectiveFromDay: hasSavedName
              ? saved.bindingEffectiveFromDay ?? (savedNameMatchesBinding ? binding?.effectiveFromDay : undefined)
              : binding?.effectiveFromDay
          };
        }
        const doProfile = doProfiles.find((p) => p.id === line.id || p.line === line.line);
        const doName = binding?.doName || doProfile?.name || "";
        const doNameId = binding?.doNameId || doProfile?.id || line.id;
        const openingBase = isPostgreSqlPeriod(monthId)
          ? (selectedDayRecord?.doEntries.find((e) => e.doProfileId === (doProfile?.id ?? line.id))?.openingBalance.baseAmount ??
             (selectedDay === 1 ? (pgJazzDoOpenings.get(doProfile?.id ?? line.id) ?? 0) : 0))
          : 0;
        return {
          ...lineDraft(
            line,
            binding
              ? {
                  doNameId: binding.doNameId,
                  doName: binding.doName,
                  bindingEffectiveFromMonthId: binding.effectiveFromMonthId,
                  bindingEffectiveFromDay: binding.effectiveFromDay
                }
              : (doName ? {
                  doNameId,
                  doName,
                  bindingEffectiveFromMonthId: monthId,
                  bindingEffectiveFromDay: 1
                } : undefined)
          ),
          doProfileId: doProfile?.id ?? line.id,
          doName: doName || (binding?.doName ?? ""),
          openingBase: isPostgreSqlPeriod(monthId) ? openingBase : undefined
        };
      });
      const legacySavedDrafts = savedEntries
        .filter((entry) => !usedSavedEntryIds.has(entry.id) && !activeLines.some((line) => entry.doLineId === line.id || entry.doLine === line.line))
        .map(asDraft);
      const defaultLifting = isPostgreSqlPeriod(monthId)
        ? (selectedDayRecord?.lifting?.openingBalance ?? (selectedDay === 1 ? (pgLiftingOpeningSeedRef.current ?? liftingOpening) : 0))
        : (latestPriorDay?.lifting.inHandBalance ?? 0);
      applyRemoteDraftState({
        hydrationKey,
        drafts: [...lineDrafts, ...legacySavedDrafts],
        liftingOpening: isPostgreSqlPeriod(monthId)
          ? (selectedDayRecord?.lifting?.openingBalance ?? defaultLifting)
          : (selectedDayRecord.lifting?.openingBalance || defaultLifting),
        mlLifting: selectedDayRecord.lifting.mlLifting,
        dayNotes: selectedDayRecord.notes ?? ""
      });
      return;
    }
    const lineDrafts = activeLines.map((line) => {
      const binding = resolveDoLineBindingForDate(doLineBindings, line.id, monthId, selectedDay);
      const doProfile = doProfiles.find((p) => p.id === line.id || p.line === line.line);
      const doName = binding?.doName || doProfile?.name || "";
      const doNameId = binding?.doNameId || doProfile?.id || line.id;
      const openingBase = (selectedDay === 1 && isPostgreSqlPeriod(monthId))
        ? (pgJazzDoOpenings.get(doProfile?.id ?? line.id) ?? 0)
        : 0;
      return {
        ...lineDraft(
          line,
          {
            doNameId,
            doName,
            bindingEffectiveFromMonthId: binding?.effectiveFromMonthId ?? monthId,
            bindingEffectiveFromDay: binding?.effectiveFromDay ?? 1
          }
        ),
        doProfileId: doProfile?.id ?? line.id,
        doName,
        openingBase
      };
    });
    const defaultLifting = isPostgreSqlPeriod(monthId)
      ? (selectedDay === 1 ? (pgLiftingOpeningSeedRef.current ?? liftingOpening) : 0)
      : (latestPriorDay?.lifting.inHandBalance ?? 0);
    applyRemoteDraftState({
      hydrationKey,
      drafts: lineDrafts,
      liftingOpening: defaultLifting,
      mlLifting: 0,
      dayNotes: ""
    });
  }, [activeLines, days, doLineBindings, doProfiles, jazzDailyReady, latestPriorDay, liftingOpening, monthId, pgJazzDoOpenings, previousMonthDays, selectedDate, selectedDay, selectedDayFuture, selectedDayRecord]);

  const previewEntries = useMemo(() => {
    if (!selectedCalculationRates.mlRate) return [];
    return drafts.map((draft) => {
      const previous = resolveOpeningEntry(draft);
      const openingBase = isPostgreSqlPeriod(monthId)
        ? (draft.openingBase ?? previous?.closingBalance.baseAmount ?? 0)
        : (selectedDay === 1 ? previous?.closingBalance.baseAmount ?? draft.openingBase ?? 0 : previous?.closingBalance.baseAmount ?? draft.openingBase ?? 0);
      return calculateDoRow(
        { ...draft, openingBase },
        selectedCalculationRates,
        { createdBy: user.uid, previous: selectedDayRecord?.doEntries.find((entry) => entry.id === draft.id), timestamp: Date.now() }
      );
    });
  }, [days, drafts, previousMonthDays, selectedCalculationRates, selectedDay, selectedDayRecord?.doEntries, user.uid]);
  const previewSummary = calculateDailySummary({ doEntries: previewEntries }, selectedCalculationRates);
  const previewLifting = calculateDailyLifting({ openingBalance: liftingOpening, mlLifting }, previewSummary.issuanceMl);
  const localSummary = summary ?? calculateMonthlySummary(monthId, days);
  const unboundLineDrafts = useMemo(
    () => drafts.filter((draft) => draft.doLineId && !draft.doName.trim()),
    [drafts]
  );
  const orderedDoLineBindings = useMemo(
    () => [...doLineBindings].sort((left, right) => {
      const rightDate = `${right.effectiveFromMonthId}-${pad2(right.effectiveFromDay)}`;
      const leftDate = `${left.effectiveFromMonthId}-${pad2(left.effectiveFromDay)}`;
      const dateOrder = rightDate.localeCompare(leftDate);
      if (dateOrder !== 0) return dateOrder;
      return (left.doLineName ?? left.doLineId).localeCompare(right.doLineName ?? right.doLineId, undefined, {
        numeric: true,
        sensitivity: "base"
      });
    }),
    [doLineBindings]
  );
  const doBalanceRows = useMemo(() => {
    const rows: JazzLoadMonthlySummary["doBalances"] = [...localSummary.doBalances];
    const seenNameKeys = new Set(rows.map(doNameIdentityKey).filter(Boolean));
    const seedDays = [
      ...[...previousMonthDays].sort((left, right) => left.dayNo - right.dayNo),
      ...[...days].sort((left, right) => left.dayNo - right.dayNo)
    ];
    for (const name of activeDoNames) {
      const key = doNameIdentityKey({ doNameId: name.id, doName: name.name });
      if (!key || seenNameKeys.has(key)) continue;
      const previous = latestEntryForDraft(seedDays, { doNameId: name.id, doName: name.name });
      rows.push({
        doNameId: name.id,
        doLineId: previous?.doLineId,
        doName: name.name,
        doLine: previous?.doLine,
        doLineSortOrder: previous?.doLineSortOrder,
        openingBase: previous?.closingBalance.baseAmount ?? 0,
        issuanceBase: 0,
        paymentBase: 0,
        closingBase: previous?.closingBalance.baseAmount ?? 0,
        closingMl: previous?.closingBalance.calculatedAmount ?? 0,
        activeDays: 0
      });
      seenNameKeys.add(key);
    }
    return rows.sort((a, b) => {
      const orderA = a.doLineSortOrder ?? Number.POSITIVE_INFINITY;
      const orderB = b.doLineSortOrder ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) return orderA - orderB;
      const lineOrder = (a.doLine ?? a.doName).localeCompare(b.doLine ?? b.doName, undefined, {
        numeric: true,
        sensitivity: "base"
      });
      if (lineOrder !== 0) return lineOrder;
      return a.doName.localeCompare(b.doName, undefined, { numeric: true, sensitivity: "base" });
    });
  }, [activeDoNames, days, localSummary.doBalances, previousMonthDays]);
  const carryForwardWarnings = useMemo(
    () => (isPostgreSqlPeriod(monthId) ? [] : jazzCarryForwardWarnings(days, previousMonthDays)),
    [days, monthId, previousMonthDays]
  );
  const validation: ValidationResult = jazzDailyReady
    ? validateJazzLoadDrafts(
      drafts.map((draft) => ({
        ...draft,
        openingBase: resolveOpeningEntry(draft)?.closingBalance.baseAmount ?? draft.openingBase ?? 0
      })),
      selectedCalculationRates
    )
    : { valid: true, errors: [] };
  const saveState = getJazzLoadSaveState({
    role,
    canWriteDaily,
    selectedDayFuture,
    selectedDayLive,
    adminCanEditSelectedDay,
    monthClosed: currentMonth?.status === "closed",
    dayClosed: selectedDayClosed,
    hasDrafts: jazzDailyReady && drafts.length > 0,
    activeRates: jazzDailyReady ? selectedCalculationRates : { mlRate: null, commission1Rate: null, commission2Rate: null },
    validation
  });

  useEffect(() => {
    if (section === "settings" && !canManageSettings) {
      setSection("daily");
      onStatus("Owner only. Jazz Load Settings are restricted to owner access.");
    }
    if (section === "backup" && !canBackup) {
      setSection("daily");
      onStatus("Owner only. Jazz Load backup is restricted to owner access.");
    }
  }, [canBackup, canManageSettings, onStatus, section]);

  const warningMessage = !currentMonth
    ? ""
    : syncState === "offline"
      ? "Offline mode: Jazz Load changes will sync when this device reconnects."
    : !jazzDailyReady
      ? ""
      : saveState.reason === "No active rate"
        ? (canManageSettings
          ? "Owner must configure active Jazz Load Addition, Commission 1 Adjustment, and Commission 2 Payment rates before financial entry."
          : "No active rate.")
        : saveState.reason
          ? saveState.detail
          : "";

  useEffect(() => {
    if (!warningMessage) {
      if (popup?.text && popup.text === lastSystemMessageRef.current) {
        setPopup(null);
      }
      lastSystemMessageRef.current = "";
      return;
    }
    if (warningMessage === lastSystemMessageRef.current) return;
    lastSystemMessageRef.current = warningMessage;
    const kind: JazzLoadPopup["kind"] = warningMessage.includes("disabled") || warningMessage.includes("unavailable") || warningMessage.includes("closed")
      ? "warning"
      : "error";
    setPopup({ kind, text: warningMessage });
  }, [popup?.text, warningMessage]);

  function resolveOpeningEntry(draft: Pick<JazzLoadDoEntryDraft, "doProfileId" | "doNameId" | "doName" | "doLineId" | "doLine">) {
    if (isPostgreSqlPeriod(monthId)) {
      return undefined;
    }
    if (selectedDay === 1) {
      return latestEntryForDraft(previousMonthDays, draft);
    }
    return previousEntryForDraftAcrossDays(days, selectedDay, draft);
  }

  function lineDraft(
    line: JazzLoadDoLine,
    source?: {
      id?: string;
      doNameId?: string;
      doName?: string;
      bindingEffectiveFromMonthId?: string;
      bindingEffectiveFromDay?: number;
      bindingUpdatedAt?: number;
      bindingUpdatedBy?: string;
      bindingBackfillId?: string;
      bindingBackfillMode?: JazzLoadDoEntryDraft["bindingBackfillMode"];
    }
  ): JazzLoadDoEntryDraft {
    const previous = previousEntryForDraftAcrossDays(days, selectedDay, {
      doNameId: source?.doNameId,
      doName: source?.doName ?? "",
      doLineId: line.id,
      doLine: line.line
    });
    const openingEntry = resolveOpeningEntry({
      doNameId: source?.doNameId,
      doName: source?.doName ?? "",
      doLineId: line.id,
      doLine: line.line
    });
    return {
      id: source?.id ?? `${selectedDate}-${line.id}`,
      doLineId: line.id,
      doLine: line.line,
      doLineSortOrder: line.sortOrder,
      doNameId: source?.doNameId,
      assignmentId: source?.id,
      doName: source?.doName ?? "",
      bindingEffectiveFromMonthId: source?.bindingEffectiveFromMonthId,
      bindingEffectiveFromDay: source?.bindingEffectiveFromDay,
      bindingUpdatedAt: source?.bindingUpdatedAt,
      bindingUpdatedBy: source?.bindingUpdatedBy,
      bindingBackfillId: source?.bindingBackfillId,
      bindingBackfillMode: source?.bindingBackfillMode,
      openingBase: openingEntry?.closingBalance.baseAmount ?? previous?.closingBalance.baseAmount ?? 0,
      todayMlIssuanceBase: 0,
      paymentReceivedBase: 0
    };
  }

  function emptyJazzLoadDay(dayNo: number, status: JazzLoadDay["status"], timestamp = Date.now()): JazzLoadDay {
    const emptySummary = calculateDailySummary({ doEntries: [] }, activeRates, timestamp);
    const previousDay = dayNo === 1
      ? [...previousMonthDays].sort((a, b) => a.dayNo - b.dayNo).at(-1)
      : [...days].filter((day) => day.dayNo < dayNo).sort((a, b) => a.dayNo - b.dayNo).at(-1);
    return {
      id: String(dayNo),
      monthId,
      dayNo,
      date: dayDate(monthId, dayNo),
      status,
      manualOverride: status !== "open",
      doEntries: [],
      lifting: calculateDailyLifting({ openingBalance: previousDay?.lifting.inHandBalance ?? 0, mlLifting: 0 }, 0),
      summary: emptySummary,
      notes: undefined,
      createdBy: user.uid,
      updatedBy: user.uid,
      createdAt: timestamp,
      updatedAt: timestamp,
      closedAt: status === "closed" ? timestamp : undefined,
      closedBy: status === "closed" ? user.uid : undefined
    };
  }

  function setDraft(index: number, patch: Partial<JazzLoadDoEntryDraft>) {
    markDraftDirty();
    setDrafts((current) => current.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft)));
  }

  async function saveDay(
    status: "open" | "closed" = "open",
    options: {
      silent?: boolean;
      nextDrafts?: JazzLoadDoEntryDraft[];
      source?: "autosave" | "manual-save" | "verified-save";
      throwOnError?: boolean;
      rateMode?: "preserve-snapshot" | "active-settings";
    } = {}
  ) {
    const dayKey = `${monthId}/${selectedDay}`;
    if (status === "open" && closedDayKeysRef.current.has(dayKey)) {
      const message = `Jazz Load day ${selectedDay} is closed. Reopen it before saving.`;
      if (!options.silent) pushPopup("warning", message);
      if (options.throwOnError) throw new Error(message);
      return;
    }
    const currentDrafts = options.nextDrafts ?? drafts;
    const timestamp = Date.now();
    const rateResolution = options.rateMode === "active-settings"
      ? resolveJazzLoadRatesForDay({ activeRates, mode: "new-day", resolvedAt: timestamp })
      : resolveJazzLoadRatesForDay({
          dayRecord: selectedDayRecord,
          activeRates,
          mode: selectedDayRecord ? "existing-day" : "new-day",
          resolvedAt: timestamp
        });
    const calculationRates = rateResolution.rates;
    const workingValidation = validateJazzLoadDrafts(currentDrafts, calculationRates);
    const workingSaveState = getJazzLoadSaveState({
      role,
      canWriteDaily,
      selectedDayFuture,
      selectedDayLive,
      adminCanEditSelectedDay,
      monthClosed: currentMonth?.status === "closed",
      dayClosed: selectedDayClosed,
      hasDrafts: currentDrafts.length > 0,
      activeRates: calculationRates,
      validation: workingValidation
    });
    if (!workingSaveState.canSave) {
      debugJazzLoadSaveBlock({
        source: options.source ?? "save-guard",
        reason: workingSaveState.reason ?? "Invalid input",
        detail: workingSaveState.detail,
        role,
        monthId,
        dayNo: selectedDay,
        selectedDayLive,
        selectedDayFuture
      });
      if (!options.silent) pushPopup(workingSaveState.reason === "Day closed" || workingSaveState.reason === "Selected date is future" ? "warning" : "error", workingSaveState.detail);
      if (options.throwOnError) throw new Error(workingSaveState.detail);
      return;
    }
    const month = currentMonth ?? await ensureJazzLoadMonth(monthId, user, role);
    const nextStatus = status === "closed" ? "closed" : selectedDayRecord?.status ?? "open";
    const savedDraftSignature = jazzDraftStateSignature({
      drafts: currentDrafts,
      liftingOpening,
      mlLifting,
      dayNotes
    });
    const entries = currentDrafts.map((draft) => {
      const previous = resolveOpeningEntry(draft);
      const openingBase = previous?.closingBalance.baseAmount ?? draft.openingBase ?? 0;
      return calculateDoRow(
        { ...draft, openingBase },
        calculationRates,
        { createdBy: user.uid, previous: selectedDayRecord?.doEntries.find((entry) => entry.id === draft.id), timestamp }
      );
    });
    const nextSummary = calculateDailySummary({ doEntries: entries }, calculationRates, timestamp);
    const day: JazzLoadDay = {
      id: String(selectedDay),
      monthId,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      status: nextStatus,
      manualOverride: nextStatus === "open" ? selectedDayRecord?.manualOverride ?? false : true,
      doEntries: entries,
      lifting: calculateDailyLifting({ openingBalance: liftingOpening, mlLifting }, nextSummary.issuanceMl),
      summary: nextSummary,
      appliedRates: snapshotResolvedRates(calculationRates, timestamp),
      notes: dayNotes.trim() || undefined,
      createdBy: selectedDayRecord?.createdBy ?? user.uid,
      updatedBy: user.uid,
      createdAt: selectedDayRecord?.createdAt ?? timestamp,
      updatedAt: timestamp,
      closedAt: nextStatus === "closed" ? timestamp : selectedDayRecord?.closedAt,
      closedBy: nextStatus === "closed" ? user.uid : selectedDayRecord?.closedBy,
      lockedAt: nextStatus === "closed" ? timestamp : selectedDayRecord?.lockedAt,
      lockedBy: nextStatus === "closed" ? user.uid : selectedDayRecord?.lockedBy,
      lockedByRole: nextStatus === "closed" ? role ?? undefined : selectedDayRecord?.lockedByRole,
      reopenedAt: nextStatus === "reopen" ? selectedDayRecord?.reopenedAt : undefined,
      reopenedBy: nextStatus === "reopen" ? selectedDayRecord?.reopenedBy : undefined,
      reopenedByRole: nextStatus === "reopen" ? selectedDayRecord?.reopenedByRole : undefined,
      reopenedUntilAt: nextStatus === "reopen" ? selectedDayRecord?.reopenedUntilAt : undefined
    };
    if (isPostgreSqlPeriod(monthId)) {
      try {
        await saveJazzLoadDayPostgres(monthId, day, doProfiles);
        if (nextStatus === "closed") closedDayKeysRef.current.add(dayKey);
        setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), day].sort((a, b) => a.dayNo - b.dayNo));
        lastSavedRef.current = autosaveSignature;
        if (currentDraftStateSignature() === savedDraftSignature) {
          draftDirtyRef.current = false;
        }
        if (!options.silent) {
          pushPopup("success", `Saved Jazz Load day ${selectedDay} to PostgreSQL.`);
        }
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to save Jazz Load day to PostgreSQL.";
        if (!options.silent) {
          pushPopup("error", message);
        }
        if (options.throwOnError) throw new Error(message);
        return;
      }
    }

    if (nextStatus === "closed") closedDayKeysRef.current.add(dayKey);
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), day].sort((a, b) => a.dayNo - b.dayNo));

    const write = saveJazzLoadDay(month, day, days, user, role, status === "closed" ? "close-day" : "save-day")
      .catch((err) => {
        const message = normalizeSaveError(err);
        if (message === "Permission denied") {
          debugJazzLoadSaveBlock({
            source: options.source ?? "save-guard",
            reason: "Permission denied",
            detail: message,
            role,
            monthId,
            dayNo: selectedDay,
            selectedDayLive,
            selectedDayFuture
          });
        }
        throw new Error(message);
      });
    onQueueWrite(write, "Could not queue Jazz Load day save.");
    try {
      await write;
      lastSavedRef.current = autosaveSignature;
      if (currentDraftStateSignature() === savedDraftSignature) {
        draftDirtyRef.current = false;
      }
      if (!options.silent) {
        pushPopup("success", status === "closed" ? `Closed Jazz Load day ${selectedDay} locally.` : `Saved Jazz Load day ${selectedDay} locally.`);
      }
    } catch (err) {
      if (nextStatus === "closed") {
        closedDayKeysRef.current.delete(dayKey);
        setDays((current) => selectedDayRecord
          ? [...current.filter((item) => item.dayNo !== selectedDay), selectedDayRecord].sort((a, b) => a.dayNo - b.dayNo)
          : current.filter((item) => item.dayNo !== selectedDay));
      }
      const message = normalizeSaveError(err);
      if (!options.silent) pushPopup("error", message);
      if (options.throwOnError) throw new Error(message);
    }
  }

  async function closeSelectedDay() {
    if (!roleCanJazzLoad(role, "daily") || (role !== "owner" && role !== "admin")) {
      pushPopup("error", "Only owner/admin can close Jazz Load days.");
      return;
    }
    if (currentMonth?.status === "closed") {
      pushPopup("warning", "Reopen the Jazz Load month before closing days.");
      return;
    }
    if (selectedDayFuture) {
      pushPopup("warning", "Future Jazz Load days are disabled.");
      return;
    }
    if (!window.confirm(`Close Jazz Load day ${selectedDay}?`)) return;

    if (isPostgreSqlPeriod(monthId)) {
      try {
        await closeOperationalDayUnified({
          monthId,
          dayNo: selectedDay,
          flushDraft: async () => {
            if (inFlightSavePromiseRef.current) {
              await inFlightSavePromiseRef.current;
            }
            if (draftDirtyRef.current || hasPendingJazzChanges) {
              await saveDay("open", { silent: true, source: "verified-save", throwOnError: true });
            }
            return true;
          }
        });
        closedDayKeysRef.current.add(`${monthId}/${selectedDay}`);
        setDays((current) => current.map((item) => item.dayNo === selectedDay ? { ...item, status: "closed", closedAt: Date.now(), lockedAt: Date.now() } : item));
        pushPopup("success", `Closed Jazz Load day ${selectedDay}.`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to close Jazz Load day in PostgreSQL.";
        pushPopup("error", message);
        return;
      }
    }

    const month = currentMonth ?? await ensureJazzLoadMonth(monthId, user, role);
    const timestamp = Date.now();
    const existing = selectedDayRecord ?? emptyJazzLoadDay(selectedDay, "open", timestamp);
    const closedDay: JazzLoadDay = {
      ...existing,
      status: "closed",
      manualOverride: true,
      closedAt: timestamp,
      closedBy: user.uid,
      lockedAt: timestamp,
      lockedBy: user.uid,
      lockedByRole: role ?? undefined,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedByRole: undefined,
      reopenedUntilAt: undefined,
      updatedBy: user.uid,
      updatedAt: timestamp
    };
    closedDayKeysRef.current.add(`${monthId}/${selectedDay}`);
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), closedDay].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(saveJazzLoadDay(month, closedDay, days, user, role, "close-day"), "Could not queue Jazz Load day close.");
    pushPopup("success", `Closed Jazz Load day ${selectedDay}.`);
  }

  async function applyCurrentRatesToSelectedDay() {
    if (role !== "owner" || !selectedDayRecord || !canEditDaily) return;
    if (!window.confirm("This will replace this day's saved Jazz Load rate snapshot with the current settings and recalculate this day. Historical values for this day may change. Continue?")) return;
    try {
      await saveDay("open", {
        silent: true,
        source: "manual-save",
        rateMode: "active-settings",
        throwOnError: true
      });
      pushPopup("success", `Applied current Jazz Load rates to day ${selectedDay}.`);
    } catch (error) {
      pushPopup("error", error instanceof Error ? error.message : "Could not apply current rates.");
    }
  }

  async function reopenDay() {
    if (!selectedDayRecord || !roleCanJazzLoad(role, "daily")) return;
    if (!canReopenDay(role)) {
      pushPopup("error", "Only owner can reopen days.");
      return;
    }
    if (!window.confirm(`Reopen Jazz Load day ${selectedDay}?`)) return;

    if (isPostgreSqlPeriod(monthId)) {
      try {
        await reopenOperationalDayUnified({
          monthId,
          dayNo: selectedDay,
          reason: "Reopened by owner"
        });
        closedDayKeysRef.current.delete(`${monthId}/${selectedDay}`);
        setDays((current) => current.map((item) => item.dayNo === selectedDay ? { ...item, status: "reopen", reopenedAt: Date.now() } : item));
        pushPopup("success", `Reopened Jazz Load day ${selectedDay}.`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to reopen Jazz Load day in PostgreSQL.";
        pushPopup("error", message);
        return;
      }
    }
    const timestamp = Date.now();
    closedDayKeysRef.current.delete(`${monthId}/${selectedDay}`);
    const reopened = {
      ...selectedDayRecord,
      status: "reopen" as const,
      manualOverride: true,
      closedAt: undefined,
      closedBy: undefined,
      lockedAt: undefined,
      lockedBy: undefined,
      lockedByRole: undefined,
      reopenedAt: timestamp,
      reopenedBy: user.uid,
      reopenedByRole: role ?? undefined,
      reopenedUntilAt: undefined,
      updatedBy: user.uid,
      updatedAt: timestamp
    };
    const month = currentMonth;
    if (!month) return;
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), reopened].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(saveJazzLoadDay(month, reopened, days, user, role, "reopen-day"), "Could not queue Jazz Load day reopen.");
    pushPopup(
      "success",
      selectedDayLive
        ? `Jazz Load day ${selectedDay} reopened until you close it again.`
        : `Jazz Load day ${selectedDay} reopened until you close it again.`
    );
  }

  async function reopenMonthDays(scope: "selected" | "all") {
    if (isPostgreSqlPeriod(monthId)) {
      pushPopup("warning", "Bulk day actions for PostgreSQL operational periods are managed authoritatively via PostgreSQL.");
      return;
    }
    if (role !== "owner") {
      pushPopup("error", "Only owner can reopen selected or all Jazz Load days.");
      return;
    }
    if (currentMonth?.status === "closed") {
      pushPopup("warning", "Reopen the Jazz Load month before reopening its days.");
      return;
    }
    const month = currentMonth ?? await ensureJazzLoadMonth(monthId, user, role);
    if (scope === "selected" && selectedDayFuture) {
      pushPopup("warning", "Future Jazz Load days are disabled.");
      return;
    }

    const dayNumbers = scope === "selected"
      ? [selectedDay]
      : availableJazzLoadDayNumbers(monthId, now).filter((dayNo) => {
        const day = days.find((item) => item.dayNo === dayNo);
        return day?.status === "closed" || Boolean(day?.lockedAt || day?.closedAt);
      });
    const timestamp = Date.now();
    const nextReopenedDays = dayNumbers.map((dayNo) => {
      const existing = days.find((day) => day.dayNo === dayNo) ?? emptyJazzLoadDay(dayNo, "closed", timestamp);
      return {
        ...existing,
        status: "reopen" as const,
        manualOverride: true,
        closedAt: undefined,
        closedBy: undefined,
        lockedAt: undefined,
        lockedBy: undefined,
        lockedByRole: undefined,
        reopenedAt: timestamp,
        reopenedBy: user.uid,
        reopenedByRole: role ?? undefined,
        reopenedUntilAt: undefined,
        updatedBy: user.uid,
        updatedAt: timestamp
      };
    });
    nextReopenedDays.forEach((day) => closedDayKeysRef.current.delete(`${monthId}/${day.dayNo}`));

    if (nextReopenedDays.length === 0) {
      pushPopup("warning", "No previous Jazz Load days are available to reopen.");
      return;
    }

    setBulkReopening(scope);
    setDays((current) => nextReopenedDays.reduce(
      (nextDays, day) => [...nextDays.filter((item) => item.dayNo !== day.dayNo), day].sort((a, b) => a.dayNo - b.dayNo),
      current
    ));
    onQueueWrite(
      reopenJazzLoadDaysFor15Minutes(month, nextReopenedDays, days, user, role)
        .finally(() => setBulkReopening(null)),
      "Could not queue Jazz Load day reopen."
    );
    pushPopup("success", `${scope === "selected" ? `Jazz Load day ${selectedDay}` : `${nextReopenedDays.length} Jazz Load days`} reopened until manually closed.`);
  }

  async function closeAllDaysExceptToday() {
    if (role !== "owner") {
      pushPopup("error", "Only owner can close all Jazz Load days.");
      return;
    }
    if (currentMonth?.status === "closed") {
      pushPopup("warning", "Reopen the Jazz Load month before closing its days.");
      return;
    }
    const month = currentMonth ?? await ensureJazzLoadMonth(monthId, user, role);
    const liveDate = currentDateState(now);
    const timestamp = Date.now();
    const nextClosedDays = availableJazzLoadDayNumbers(monthId, now)
      .filter((dayNo) => !(monthId === liveDate.monthId && dayNo === liveDate.dayNo))
      .flatMap((dayNo) => {
        const existing = days.find((day) => day.dayNo === dayNo);
        if (existing?.status === "closed" && !isActiveReopenWindow(existing, now.getTime())) return [];
        const day: JazzLoadDay = {
          ...(existing ?? emptyJazzLoadDay(dayNo, "closed", timestamp)),
          status: "closed" as const,
          manualOverride: true,
          closedAt: timestamp,
          closedBy: user.uid,
          lockedAt: timestamp,
          lockedBy: user.uid,
          lockedByRole: role ?? undefined,
          reopenedAt: undefined,
          reopenedBy: undefined,
          reopenedByRole: undefined,
          reopenedUntilAt: undefined,
          updatedBy: user.uid,
          updatedAt: timestamp
        };
        return [day];
      });

    if (nextClosedDays.length === 0) {
      pushPopup("warning", "No open previous Jazz Load days are available to close.");
      return;
    }

    setBulkClosingDays(true);
    setDays((current) => nextClosedDays.reduce(
      (nextDays, day) => [...nextDays.filter((item) => item.dayNo !== day.dayNo), day].sort((a, b) => a.dayNo - b.dayNo),
      current
    ));
    nextClosedDays.forEach((day) => closedDayKeysRef.current.add(`${monthId}/${day.dayNo}`));
    onQueueWrite(
      closeJazzLoadDaysExceptToday(month, nextClosedDays, days, user, role)
        .finally(() => setBulkClosingDays(false)),
      "Could not queue Jazz Load close-all-days action."
    );
    pushPopup("success", `Closed ${nextClosedDays.length} Jazz Load day${nextClosedDays.length === 1 ? "" : "s"} except today locally.`);
  }

  async function masterRefreshCalculations() {
    if (!canRunMasterRefresh) {
      pushPopup("error", "Only owner/admin can refresh Jazz Load calculations.");
      return;
    }
    const adapter = createJazzLoadRecalculationAdapter({
      monthId,
      canRun: canRunMasterRefresh,
      disabledReason: "Only owner/admin can run Jazz Load master refresh.",
      run: async () => {
        const result = await recalculateJazzLoadLedgerLocal(monthId, user, role);
        setMonths((current) => [result.month, ...current.filter((item) => item.id !== result.month.id)].sort((a, b) => b.id.localeCompare(a.id)));
        setDays(result.days);
        setSummary(result.summary);
        return {
          daysChecked: result.days.length,
          mismatchesCorrected: result.days.length,
          monthlySummariesUpdated: 1,
          message: "Jazz Load openings now follow previous closings."
        };
      }
    });
    if (onTriggerMasterRefresh) {
      await onTriggerMasterRefresh(adapter, "Jazz Load");
    } else {
      setRecalculating(true);
      const recalculation = runMasterRecalculation({ adapter })
        .finally(() => setRecalculating(false));
      onQueueWrite(recalculation, "Could not queue Jazz Load calculation refresh.");
      pushPopup("success", "Jazz Load master refresh queued. Openings will follow previous closings.");
    }
  }

  function saveRate() {
    if (!canManageSettings || !rateName.trim()) return;
    const editingRate = editingRateId ? rates.find((rate) => rate.id === editingRateId) : undefined;
    const id = editingRate?.id ?? slug(`${rateType}-${rateName}`);

    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          if (editingRateId) {
            const dbId = editingRateId.replace(/_(ml|c1|c2)$/, "");
            if (editingRate && editingRate.percentage !== ratePercentage) {
              const currentMl = rates.find((r) => r.id === `${dbId}_ml`)?.percentage ?? 0;
              const currentC1 = rates.find((r) => r.id === `${dbId}_c1`)?.percentage ?? 0;
              const currentC2 = rates.find((r) => r.id === `${dbId}_c2`)?.percentage ?? 0;
              await ledgerApiClient.catalogs.createJazzLoadRate({
                name: rateName.trim(),
                ml_rate: rateType === "ml_addition" ? ratePercentage : currentMl,
                comm1_rate: rateType === "commission1_adjustment" ? ratePercentage : currentC1,
                comm2_rate: rateType === "commission2_payment" ? ratePercentage : currentC2,
                effective_from: `${monthId}-01`,
                is_active: true
              });
              await ledgerApiClient.catalogs.updateJazzLoadRate(dbId, { is_active: false });
            } else {
              await ledgerApiClient.catalogs.updateJazzLoadRate(dbId, {
                name: rateName.trim(),
                is_active: editingRate?.active ?? true
              });
            }
          } else {
            await ledgerApiClient.catalogs.createJazzLoadRate({
              name: rateName.trim(),
              ml_rate: rateType === "ml_addition" ? ratePercentage : 0,
              comm1_rate: rateType === "commission1_adjustment" ? ratePercentage : 0,
              comm2_rate: rateType === "commission2_payment" ? ratePercentage : 0,
              effective_from: `${monthId}-01`,
              is_active: true
            });
          }
          const res = await ledgerApiClient.catalogs.getJazzLoadRates();
          const mappedRates: JazzLoadRateConfig[] = [];
          for (const row of res.data || []) {
            mappedRates.push({ id: row.id + "_ml", type: "ml_addition", percentage: Number(row.ml_rate), active: row.is_active, sortOrder: 1, name: row.name + " ML", createdBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
            mappedRates.push({ id: row.id + "_c1", type: "commission1_adjustment", percentage: Number(row.comm1_rate), active: row.is_active, sortOrder: 2, name: row.name + " Comm1", createdBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
            mappedRates.push({ id: row.id + "_c2", type: "commission2_payment", percentage: Number(row.comm2_rate), active: row.is_active, sortOrder: 3, name: row.name + " Comm2", createdBy: "system", createdAt: Date.now(), updatedAt: Date.now() });
          }
          setRates(mappedRates);
          setRateName("");
          setRatePercentage(0);
          setEditingRateId(null);
          pushPopup("success", editingRateId ? "Jazz Load calculation rate updated in PostgreSQL." : "Jazz Load calculation rate saved to PostgreSQL.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to save Jazz Load rate in PostgreSQL.");
        }
      })();
      return;
    }

    onQueueWrite(
      upsertJazzLoadRate({
        id,
        name: rateName.trim(),
        type: rateType,
        percentage: ratePercentage,
        active: editingRate?.active ?? true,
        sortOrder: editingRate?.sortOrder ?? displayRates.length + 1,
        createdBy: editingRate?.createdBy,
        createdAt: editingRate?.createdAt,
        description: "Owner-managed Jazz Load calculation rate"
      }, user, role),
      "Could not queue Jazz Load rate."
    );
    setRateName("");
    setRatePercentage(0);
    setEditingRateId(null);
    pushPopup("success", editingRate ? "Jazz Load calculation rate updated locally." : "Jazz Load calculation rate saved locally.");
  }

  function toggleRate(rate: JazzLoadRateConfig) {
    if (!canManageSettings) return;
    if (isPostgreSqlPeriod(monthId)) {
      const dbId = rate.id.replace(/_(ml|c1|c2)$/, "");
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadRate(dbId, { is_active: !rate.active });
          setRates((prev) => prev.map((r) => r.id.startsWith(dbId) ? { ...r, active: !rate.active } : r));
          pushPopup("success", `${rate.name} ${rate.active ? "deactivated" : "activated"} in PostgreSQL.`);
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to toggle Jazz Load rate in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      upsertJazzLoadRate({ ...rate, active: !rate.active }, user, role),
      "Could not queue Jazz Load rate update."
    );
    pushPopup("success", `${rate.name} ${rate.active ? "deactivated" : "activated"} locally.`);
  }

  function editRate(rate: JazzLoadRateConfig) {
    if (!canManageSettings) return;
    setEditingRateId(rate.id);
    setRateType(rate.type);
    setRateName(rate.name);
    setRatePercentage(rate.percentage);
  }

  function cancelRateEdit() {
    setEditingRateId(null);
    setRateName("");
    setRatePercentage(0);
    setRateType("ml_addition");
  }

  function removeRate(rate: JazzLoadRateConfig) {
    if (!canManageSettings) return;
    if (!window.confirm(`Delete Jazz Load rate "${rate.name}"?`)) return;
    if (isPostgreSqlPeriod(monthId)) {
      const dbId = rate.id.replace(/_(ml|c1|c2)$/, "");
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadRate(dbId, { is_active: false });
          setRates((prev) => prev.map((r) => r.id.startsWith(dbId) ? { ...r, active: false } : r));
          if (editingRateId === rate.id) cancelRateEdit();
          pushPopup("success", "Jazz Load calculation rate deactivated in PostgreSQL.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to deactivate Jazz Load rate in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      deleteJazzLoadRate(rate.id, user, role),
      "Could not queue Jazz Load rate delete."
    );
    if (editingRateId === rate.id) cancelRateEdit();
    pushPopup("success", "Jazz Load calculation rate deleted locally.");
  }

  function saveProfile() {
    if (!roleCanJazzLoad(role, "daily") || !profileName.trim()) return;
    const id = slug(`${profileName}-${profileLine}`);
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          const res = await ledgerApiClient.catalogs.createJazzLoadDoProfile({
            do_name: profileName.trim(),
            do_line: profileLine.trim() || undefined,
            sort_order: doProfiles.length + 1,
            is_active: true
          });
          const p = res.data;
          const newProfile: JazzLoadDoProfile = {
            id: p.id,
            name: p.do_name,
            line: p.do_line,
            active: p.is_active,
            createdAt: Date.now(),
            updatedAt: Date.now()
          };
          setDoProfiles((prev) => [...prev, newProfile]);
          setDoLines((prev) => [...prev, { id: p.id, line: p.do_line, active: p.is_active, sortOrder: p.sort_order, createdAt: Date.now(), updatedAt: Date.now() }]);
          setDoNames((prev) => [...prev, { id: p.id, name: p.do_name, active: p.is_active, sortOrder: p.sort_order, createdAt: Date.now(), updatedAt: Date.now() }]);
          setProfileName("");
          setProfileLine("");
          pushPopup("success", "Jazz Load DO profile saved to PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to save DO profile to PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      upsertJazzLoadDoProfile({
        id,
        name: profileName.trim(),
        line: profileLine.trim() || undefined,
        active: true
      }, user, role),
      "Could not queue Jazz Load DO profile."
    );
    setProfileName("");
    setProfileLine("");
    pushPopup("success", "Jazz Load DO profile saved locally.");
  }

  function saveDoName() {
    if (!canManageSettings || !doNameDraft.trim()) return;
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          const res = await ledgerApiClient.catalogs.createJazzLoadDoProfile({
            do_name: doNameDraft.trim(),
            do_line: null,
            sort_order: displayDoNames.length + 1,
            is_active: true
          });
          const p = res.data;
          setDoNames((prev) => [...prev, { id: p.id, name: p.do_name, active: p.is_active, sortOrder: p.sort_order, createdAt: Date.now(), updatedAt: Date.now() }]);
          setDoProfiles((prev) => [...prev, { id: p.id, name: p.do_name, line: undefined, active: p.is_active, sortOrder: p.sort_order, createdAt: Date.now(), updatedAt: Date.now() }]);
          setDoNameDraft("");
          pushPopup("success", "DO name saved to PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to save DO name to PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      upsertJazzLoadDoName({
        id: slug(doNameDraft),
        name: doNameDraft.trim(),
        active: true,
        sortOrder: displayDoNames.length + 1
      }, user, role),
      "Could not queue DO name."
    );
    setDoNameDraft("");
    pushPopup("success", "DO name saved locally.");
  }

  function editDoName(name: JazzLoadDoName) {
    if (!canManageSettings) return;
    const nextValue = window.prompt("Edit DO Name", name.name)?.trim();
    if (!nextValue || nextValue === name.name) return;
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadDoProfile(name.id, { do_name: nextValue });
          setDoNames((prev) => prev.map((n) => n.id === name.id ? { ...n, name: nextValue } : n));
          setDoProfiles((prev) => prev.map((p) => p.id === name.id ? { ...p, name: nextValue } : p));
          pushPopup("success", "DO name updated in PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to update DO name in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      upsertJazzLoadDoName({ ...name, name: nextValue }, user, role),
      "Could not queue DO name update."
    );
    pushPopup("success", "DO name updated locally.");
  }

  function removeDoName(name: JazzLoadDoName) {
    if (!canManageSettings) return;
    if (!window.confirm(`Delete DO Name "${name.name}"?`)) return;
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadDoProfile(name.id, { is_active: false });
          setDoNames((prev) => prev.map((n) => n.id === name.id ? { ...n, active: false } : n));
          setDoProfiles((prev) => prev.map((p) => p.id === name.id ? { ...p, active: false } : p));
          pushPopup("success", "DO name deactivated in PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to delete DO name in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      deleteJazzLoadDoName(name.id, user, role),
      "Could not queue DO name delete."
    );
    pushPopup("success", "DO name deleted locally.");
  }

  function saveDoLine() {
    if (!canManageSettings || !doLineDraft.trim()) return;
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          const res = await ledgerApiClient.catalogs.createJazzLoadDoProfile({
            do_name: `DO ${doLineDraft.trim()}`,
            do_line: doLineDraft.trim(),
            sort_order: displayDoLines.length + 1,
            is_active: true
          });
          const p = res.data;
          setDoLines((prev) => [...prev, { id: p.id, line: p.do_line, active: p.is_active, sortOrder: p.sort_order, createdAt: Date.now(), updatedAt: Date.now() }]);
          setDoProfiles((prev) => [...prev, { id: p.id, name: p.do_name, line: p.do_line, active: p.is_active, sortOrder: p.sort_order, createdAt: Date.now(), updatedAt: Date.now() }]);
          setDoLineDraft("");
          pushPopup("success", "DO line saved to PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to save DO line to PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      upsertJazzLoadDoLine({
        id: slug(doLineDraft),
        line: doLineDraft.trim(),
        sortOrder: displayDoLines.length + 1,
        active: true
      }, user, role),
      "Could not queue DO line."
    );
    setDoLineDraft("");
    pushPopup("success", "DO line saved locally.");
  }

  function editDoLine(line: JazzLoadDoLine) {
    if (!canManageSettings) return;
    const nextValue = window.prompt("Edit DO Line", line.line)?.trim();
    if (!nextValue || nextValue === line.line) return;
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadDoProfile(line.id, { do_line: nextValue });
          setDoLines((prev) => prev.map((l) => l.id === line.id ? { ...l, line: nextValue } : l));
          setDoProfiles((prev) => prev.map((p) => p.id === line.id ? { ...p, line: nextValue } : p));
          pushPopup("success", "DO line updated in PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to update DO line in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      upsertJazzLoadDoLine({ ...line, line: nextValue }, user, role),
      "Could not queue DO line update."
    );
    pushPopup("success", "DO line updated locally.");
  }

  function removeDoLine(line: JazzLoadDoLine) {
    if (!canManageSettings) return;
    if (!window.confirm(`Delete DO Line "${line.line}"?`)) return;
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadDoProfile(line.id, { is_active: false });
          setDoLines((prev) => prev.map((l) => l.id === line.id ? { ...l, active: false } : l));
          setDoProfiles((prev) => prev.map((p) => p.id === line.id ? { ...p, active: false } : p));
          pushPopup("success", "DO line deactivated in PostgreSQL catalog.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to delete DO line in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(
      deleteJazzLoadDoLine(line.id, user, role),
      "Could not queue DO line delete."
    );
    pushPopup("success", "DO line deleted locally.");
  }

  function editDoLineBinding(line: JazzLoadDoLine) {
    if (!canManageSettings) return;
    const binding = resolveDoLineBindingForDate(doLineBindings, line.id, monthId, selectedDay);
    setBindingLineId(line.id);
    setBindingDoNameId(binding?.doNameId ?? "");
    setBindingEffectiveDate(selectedDate);
  }

  function saveDoLineBinding() {
    if (!canManageSettings || !bindingLineId || !bindingDoNameId) return;
    const line = doLines.find((item) => item.id === bindingLineId);
    const name = doNames.find((item) => item.id === bindingDoNameId);
    if (!line || !name) {
      pushPopup("warning", "Select a DO line and DO name before saving the binding.");
      return;
    }
    const effectiveDate = datePartsFromInput(bindingEffectiveDate || selectedDate, monthId, selectedDay);
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await ledgerApiClient.catalogs.updateJazzLoadDoProfile(line.id, { do_name: name.name });
          setDoProfiles((prev) => prev.map((p) => p.id === line.id ? { ...p, name: name.name } : p));
          setDoLineBindings((prev) => [
            {
              id: `${line.id}-${effectiveDate.monthId}-${pad2(effectiveDate.dayNo)}`,
              doLineId: line.id,
              doLineName: line.line,
              doNameId: name.id,
              doName: name.name,
              effectiveFromMonthId: effectiveDate.monthId,
              effectiveFromDay: effectiveDate.dayNo,
              createdBy: "system",
              createdAt: Date.now()
            },
            ...prev
          ]);
          pushPopup("success", `DO line ${line.line} will use ${name.name} from ${bindingEffectiveDate || selectedDate}.`);
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to update DO line binding in PostgreSQL.");
        }
      })();
      return;
    }
    const binding: Omit<JazzLoadDoLineBinding, "createdBy" | "createdAt" | "updatedAt"> = {
      id: `${line.id}-${effectiveDate.monthId}-${pad2(effectiveDate.dayNo)}`,
      doLineId: line.id,
      doLineName: line.line,
      doNameId: name.id,
      doName: name.name,
      effectiveFromMonthId: effectiveDate.monthId,
      effectiveFromDay: effectiveDate.dayNo
    };
    onQueueWrite(
      upsertJazzLoadDoLineBinding(binding, user, role),
      "Could not queue DO line binding."
    );
    pushPopup("success", `DO line ${line.line} will use ${name.name} from ${bindingEffectiveDate || selectedDate}.`);
  }

  async function applyCurrentDoBindingsBackfill() {
    if (role !== "owner") {
      pushPopup("error", "Only owner can run Jazz Load DO binding repair.");
      return;
    }
    if (!bindingBackfillFromMonthId || !bindingBackfillToMonthId) {
      pushPopup("warning", "Select a from and to month before running DO binding repair.");
      return;
    }
    setBindingBackfillRunning(true);
    try {
      const currentBindingDate = currentDateState(now);
      const preview = await previewJazzLoadDoBindingBackfill({
        fromMonthId: bindingBackfillFromMonthId,
        toMonthId: bindingBackfillToMonthId,
        currentBindingMonthId: currentBindingDate.monthId,
        currentBindingDayNo: currentBindingDate.dayNo
      });
      setBindingBackfillPreview(preview);
      if (preview.rowsThatWillChange === 0) {
        pushPopup("success", "DO binding repair preview found no rows to update.");
        return;
      }
      const confirmed = window.confirm(
        `${formatDoBindingBackfillPreview(preview)}\n\nThis will update historical Jazz Load days to use the current DO Line → DO Name bindings. This should be used only once for repair. Financial values will not be changed. Continue?`
      );
      if (!confirmed) {
        pushPopup("warning", "DO binding repair cancelled after preview.");
        return;
      }
      const write = applyJazzLoadDoBindingBackfill({
        fromMonthId: bindingBackfillFromMonthId,
        toMonthId: bindingBackfillToMonthId,
        currentBindingMonthId: currentBindingDate.monthId,
        currentBindingDayNo: currentBindingDate.dayNo,
        backfillId: preview.backfillId
      }, user, role);
      onQueueWrite(write, "Could not queue DO binding repair.");
      const result = await write;
      setBindingBackfillPreview(result);
      pushPopup("success", `DO binding repair updated ${result.rowsThatWillChange} row${result.rowsThatWillChange === 1 ? "" : "s"}.`);
    } catch (error) {
      pushPopup("error", error instanceof Error ? error.message : "Could not run DO binding repair.");
    } finally {
      setBindingBackfillRunning(false);
    }
  }

  function reorderRates(overId: string) {
    if (!canManageSettings) return;
    const activeId = draggedRateIdRef.current;
    draggedRateIdRef.current = null;
    if (!activeId || activeId === overId) return;
    const reordered = applySortOrder(reorderItems(displayRates, activeId, overId));
    setDisplayRates(reordered);
    if (isPostgreSqlPeriod(monthId)) {
      pushPopup("success", "Rate order updated.");
      return;
    }
    onQueueWrite(updateJazzLoadRateSortOrder(displayRates, reordered), "Could not queue Jazz Load rate reorder.");
    pushPopup("success", "Rate order updated locally.");
  }

  function reorderDoNames(overId: string) {
    if (!canManageSettings) return;
    const activeId = draggedDoNameIdRef.current;
    draggedDoNameIdRef.current = null;
    if (!activeId || activeId === overId) return;
    const reordered = applySortOrder(reorderItems(displayDoNames, activeId, overId));
    setDisplayDoNames(reordered);
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await Promise.all(
            reordered.map((item, idx) =>
              ledgerApiClient.catalogs.updateJazzLoadDoProfile(item.id, { sort_order: idx + 1 })
            )
          );
          pushPopup("success", "DO name order updated in PostgreSQL.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to reorder DO names in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(updateJazzLoadDoNameSortOrder(displayDoNames, reordered), "Could not queue DO name reorder.");
    pushPopup("success", "DO name order updated locally.");
  }

  function reorderDoLines(overId: string) {
    if (!canManageSettings) return;
    const activeId = draggedDoLineIdRef.current;
    draggedDoLineIdRef.current = null;
    if (!activeId || activeId === overId) return;
    const reordered = applySortOrder(reorderItems(displayDoLines, activeId, overId));
    setDisplayDoLines(reordered);
    if (isPostgreSqlPeriod(monthId)) {
      void (async () => {
        try {
          await Promise.all(
            reordered.map((item, idx) =>
              ledgerApiClient.catalogs.updateJazzLoadDoProfile(item.id, { sort_order: idx + 1 })
            )
          );
          pushPopup("success", "DO line order updated in PostgreSQL.");
        } catch (err) {
          pushPopup("error", err instanceof Error ? err.message : "Failed to reorder DO lines in PostgreSQL.");
        }
      })();
      return;
    }
    onQueueWrite(updateJazzLoadDoLineSortOrder(displayDoLines, reordered), "Could not queue DO line order.");
    pushPopup("success", "DO line order updated locally.");
  }

  const autosaveSignature = useMemo(
    () =>
      JSON.stringify({
        monthId,
        selectedDay,
        drafts,
        liftingOpening,
        mlLifting,
        dayNotes,
        status: selectedDayRecord?.status ?? "open",
        lockedAt: selectedDayRecord?.lockedAt,
        reopenedAt: selectedDayRecord?.reopenedAt,
        reopenedUntilAt: selectedDayRecord?.reopenedUntilAt
      }),
    [dayNotes, drafts, liftingOpening, mlLifting, monthId, selectedDay, selectedDayRecord?.lockedAt, selectedDayRecord?.reopenedAt, selectedDayRecord?.reopenedUntilAt, selectedDayRecord?.status]
  );

  useEffect(() => {
    if (!jazzDailyReady || !saveState.reason || !draftDirtyRef.current) return;
    debugJazzLoadSaveBlock({
      source: "autosave",
      reason: saveState.reason,
      detail: saveState.detail,
      role,
      monthId,
      dayNo: selectedDay,
      selectedDayLive,
      selectedDayFuture
    });
  }, [jazzDailyReady, monthId, role, saveState.detail, saveState.reason, selectedDay, selectedDayFuture, selectedDayLive]);

  const { autoSaveStatus, autoSaveError } = useAutoSaveEntry({
    data: autosaveSignature,
    enabled: draftDirtyRef.current && jazzDailyReady,
    disabled: !jazzDailyReady ||
      !draftDirtyRef.current ||
      saveState.reason === "Day closed" ||
      saveState.reason === "Read-only role" ||
      saveState.reason === "Selected date is future",
    debounceMs: 900,
    resetKey: `${monthId}-${selectedDay}`,
    validate: () => saveState.canSave || [saveState.detail],
    validationKey: !jazzDailyReady ? "loading" : saveState.canSave ? "can-save" : saveState.detail,
    savedStatus: "saved",
    save: async () => {
      const p = saveDay("open", { silent: true, source: "autosave", throwOnError: true });
      inFlightSavePromiseRef.current = p;
      try {
        await p;
      } finally {
        inFlightSavePromiseRef.current = null;
      }
    }
  });

  const hasPendingJazzChanges = draftDirtyRef.current && (
    autoSaveStatus === "typing" ||
    autoSaveStatus === "saving" ||
    autoSaveStatus === "unsaved" ||
    recalculating
  );

  useEffect(() => {
    onPendingStateChange?.(hasPendingJazzChanges);
    return () => {
      onPendingStateChange?.(false);
    };
  }, [hasPendingJazzChanges, onPendingStateChange]);

  useEffect(() => {
    return subscribeDayStatus((event) => {
      if (event.monthId === monthId) {
        if (event.status === "closed") {
          closedDayKeysRef.current.add(`${monthId}/${event.dayNo}`);
        } else {
          closedDayKeysRef.current.delete(`${monthId}/${event.dayNo}`);
        }
        setDays((current) => current.map((item) => item.dayNo === event.dayNo ? { ...item, status: event.status } : item));
      }
    });
  }, [monthId]);

  const manualSaveState = getJazzLoadSaveState({
    role,
    canWriteDaily,
    selectedDayFuture,
    selectedDayLive,
    adminCanEditSelectedDay,
    monthClosed: currentMonth?.status === "closed",
    dayClosed: selectedDayClosed,
    hasDrafts: jazzDailyReady && drafts.length > 0,
    activeRates: jazzDailyReady ? selectedCalculationRates : { mlRate: null, commission1Rate: null, commission2Rate: null },
    validation,
    saving: autoSaveStatus === "saving" || loading
  });
  const manualSaveDisabled = !manualSaveState.canSave;
  const manualSaveDisabledReason = manualSaveState.detail || "Save unavailable.";
  const verifiedSaveDisabled = !canWriteDaily || selectedDayFuture || selectedDayClosed || currentMonth?.status === "closed" || (role === "admin" && !adminCanEditSelectedDay);
  const canApplyCurrentRatesToSelectedDay = role === "owner" &&
    Boolean(selectedDayRecord) &&
    canEditDaily &&
    currentMonth?.status !== "closed" &&
    !selectedDayFuture;
  async function handleVerifiedSave() {
    if (verifiedSaveDisabled || saveInFlightRef.current) return;
    const isPg = isPostgreSqlPeriod(monthId);
    setVerifiedSave({
      status: "saving",
      title: isPg ? "Saving Jazz Load Day to PostgreSQL" : "Saving Jazz Load Day",
      message: isPg
        ? "Writing day transactions to PostgreSQL ledger and waiting for confirmation..."
        : "Writing the full day to storage and waiting for confirmation..."
    });
    saveInFlightRef.current = true;
    try {
      await saveDay("open", { silent: true, source: "verified-save", throwOnError: true });
      setVerifiedSave({
        status: "success",
        title: "Save Confirmed",
        message: isPg
          ? `Jazz Load day ${selectedDay} was saved successfully to PostgreSQL.`
          : `Jazz Load day ${selectedDay} was saved successfully.`
      });
    } catch (error) {
      setVerifiedSave({
        status: "error",
        title: "Save Failed",
        message: error instanceof Error ? error.message : "Failed to save day."
      });
    } finally {
      saveInFlightRef.current = false;
    }
  }
  const autoSaveChipText = !jazzDailyReady
    ? "Loading..."
    : selectedDayClosed
    ? "Day closed"
    : saveState.reason
    ? `Autosave blocked: ${saveState.detail}`
    : autoSaveStatus === "saving" || saveInFlightRef.current
    ? "Saving…"
    : autoSaveStatus === "error"
    ? `Save failed${autoSaveError ? `: ${autoSaveError}` : ""}`
    : draftDirtyRef.current
    ? "Unsaved changes"
    : "Saved";

  const sidebarDayControls = useMemo(() => (
    <>
      <p className="text-xs font-semibold uppercase text-slate-500">Day Controls</p>
      {/* <p className="mt-1 text-sm font-semibold text-white">{selectedDate}</p> */}
      <UniversalCalendar
        moduleKey="jazzLoad"
        monthId={monthId}
        selectedDay={selectedDay}
        days={jazzCalendarDays}
        now={now}
        disabled={!jazzDaysInitialized}
        onSelect={setSelectedDay}
        variant="mini"
      />
      <UniversalDayControlBar
        moduleKey="jazzLoad"
        selectedDateLabel={selectedDate}
        selectedMonthLabel={monthLabel(monthId)}
        selectedStatus={selectedJazzStatus}
        role={role}
        density="compact"
        busy={loading || recalculating || bulkReopening !== null || bulkClosingDays}
        autoSaveStatus={selectedDayClosed ? "closed" : autoSaveStatus}
        permissions={{
          canCloseSelectedDay: roleCanJazzLoad(role, "daily") &&
            (role === "owner" || role === "admin") &&
            !selectedDayFuture &&
            currentMonth?.status !== "closed" &&
            !selectedDayClosed,
          canReopenSelectedDay:
            Boolean(selectedDayRecord && selectedDayClosed) &&
            !selectedDayFuture &&
            currentMonth?.status !== "closed" &&
            canReopenDay(role),
          canReopenAllDays: role === "owner" && currentMonth?.status !== "closed" && availableJazzLoadDayNumbers(monthId, now).length > 1,
          canClosePreviousDaysExceptToday: role === "owner" && currentMonth?.status !== "closed" && availableJazzLoadDayNumbers(monthId, now).length > 1,
          canRunMasterRefresh,
          closeDisabledReason: "This Jazz Load day cannot be closed for the current role/status.",
          reopenDisabledReason: "Only owner can reopen Jazz Load days.",
          reopenAllDisabledReason: "Only owner can reopen all Jazz Load days.",
          closePreviousDisabledReason: "Only owner can close previous Jazz Load days.",
          masterRefreshDisabledReason: "Only owner/admin can run master refresh."
        }}
        onCloseSelectedDay={() => {
          void closeSelectedDay();
        }}
        onReopenSelectedDay={reopenDay}
        onReopenAllDays={() => void reopenMonthDays("all")}
        onClosePreviousDaysExceptToday={closeAllDaysExceptToday}
        onRunMasterRefresh={masterRefreshCalculations}
        extraActions={
          <>
            <button
              className="btn-primary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={manualSaveDisabled}
              title={manualSaveDisabled ? manualSaveDisabledReason : "Save Jazz Load day"}
              onClick={() => void saveDay("open", { source: "manual-save" })}
            >
              <Save />
              Save
            </button>
            <button
              className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={verifiedSaveDisabled || verifiedSave?.status === "saving"}
              title={verifiedSaveDisabled ? manualSaveDisabledReason : "Save immediately and wait for Firestore confirmation"}
              onClick={() => void handleVerifiedSave()}
            >
              <Save />
              Save Now & Verify
            </button>
            {canApplyCurrentRatesToSelectedDay && (
              <button
                className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
                title="Replace this day's saved Jazz Load rate snapshot with current settings"
                onClick={() => void applyCurrentRatesToSelectedDay()}
              >
                <RefreshCw />
                Apply Current Rates To This Day
              </button>
            )}
            <button className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs" disabled={!selectedDayRecord} onClick={() => selectedDayRecord && exportJazzLoadXlsx(calculateMonthlySummary(monthId, [selectedDayRecord]), [selectedDayRecord])}>
              <FileSpreadsheet />
              Export Daily Excel
            </button>
            <button className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs" disabled={!selectedDayRecord} onClick={() => selectedDayRecord && exportJazzLoadPrintable(calculateMonthlySummary(monthId, [selectedDayRecord]))}>
              <FileDown />
              Export Daily PDF
            </button>
          </>
        }
      />
    </>
  ), [
    applyCurrentRatesToSelectedDay,
    autoSaveStatus,
    bulkClosingDays,
    bulkReopening,
    canApplyCurrentRatesToSelectedDay,
    canEditDaily,
    currentMonth?.status,
    days.length,
    jazzCalendarDays,
    loading,
    masterRefreshCalculations,
    manualSaveDisabled,
    manualSaveDisabledReason,
    monthId,
    now,
    recalculating,
    role,
    selectedDate,
    selectedDay,
    selectedDayFuture,
    selectedDayRecord,
    selectedJazzStatus,
    setSelectedDay,
    validation.valid,
    verifiedSave?.status,
    verifiedSaveDisabled
  ]);
  useSidebarDayControls("jazzLoad", sidebarDayControls, canRead && section === "daily");

  if (!canRead) {
    return (
      <section className="panel">
        <h2>Jazz Load Ledger</h2>
        <p className="warning mt-4">This account is not allowed to access Jazz Load data.</p>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <SaveProgressDialog state={verifiedSave} onClose={() => setVerifiedSave(null)} />
      {popup && (
        <div className="fixed right-4 top-4 z-50 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-slate-700 bg-slate-950/95 p-4 text-slate-100 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={`text-xs font-semibold uppercase ${popup.kind === "success" ? "text-emerald-300" : popup.kind === "warning" ? "text-amber-300" : "text-rose-300"}`}>
                {popup.kind}
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-100">{popup.text}</p>
            </div>
            <button className="btn-ghost !h-8 !w-8 !px-0" onClick={dismissPopup} title="Dismiss message">
              <X />
            </button>
          </div>
        </div>
      )}
      {carryForwardWarnings.length > 0 && (role === "owner" || role === "admin") && (
        <div className="warning">
          <p>{carryForwardWarnings.length} Jazz Load month-to-month opening mismatch{carryForwardWarnings.length === 1 ? "" : "es"} detected. Run Master Calculation Refresh to repair openings from the previous month final projection.</p>
          <ul className="mt-2 list-disc pl-5 text-sm">
            {carryForwardWarnings.slice(0, 5).map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-white">Jazz Load Ledger</h2>
          <p className="mt-1 text-sm text-slate-400">{monthLabel(monthId)} · {currentMonth?.status ?? "new"} · {syncLabel}</p>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Active Month</p>
          <p className="mt-1 text-sm font-medium text-white">{monthLabel(monthId)}</p>
        </div>
      </div>

      <nav className="flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/80 p-2">
        {(
          [
            { id: "daily", label: "Daily Entry", icon: Save, show: true },
            { id: "dashboard", label: "Dashboard", icon: BarChart3, show: true },
            { id: "reports", label: "Reports", icon: FileSpreadsheet, show: true },
            { id: "settings", label: "Settings", icon: Settings, show: true, disabled: !canManageSettings, disabledReason: "Only owner can manage Jazz Load Settings." },
            { id: "backup", label: "Backup", icon: FileDown, show: true, disabled: !canBackup, disabledReason: "Only owner can use Jazz Load backup." }
          ] as Array<{ id: JazzLoadSection; label: string; icon: typeof BarChart3; show: boolean; disabled?: boolean; disabledReason?: string }>
        ).map(({ id, label, icon: Icon, show }) =>
          show ? (
            <button
              key={id}
              className={`${section === id ? "btn-tab btn-tab-active" : "btn-tab"}`}
              disabled={id === "settings" ? !canManageSettings : id === "backup" ? !canBackup : false}
              title={id === "settings" && !canManageSettings ? "Only owner can manage Jazz Load Settings." : id === "backup" && !canBackup ? "Only owner can use Jazz Load backup." : label}
              onClick={() => setSection(id)}
            >
              <Icon />
              {label}
            </button>
          ) : null
        )}
      </nav>

      {section === "dashboard" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            <MetricCard label="Issuance Jazz Load" value={formatCurrency(localSummary.totalIssuanceMl)} helper="Jazz Load only" />
            <MetricCard label="Payments" value={formatCurrency(localSummary.totalPaymentsBase)} helper="Base payment received" />
            <MetricCard label="Latest In-Hand" value={formatCurrency(localSummary.latestInHandBalance)} helper="Lifting balance" />
            <MetricCard label="Commission" value={formatCurrency(localSummary.totalCommission)} helper="Commission 1 + 2" />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <ReportTable
              title="Highest Outstanding DOs"
              headers={["DO", "Line", "Closing", "Active Days"]}
              rows={doBalanceRows.slice(0, 8).map((row) => [row.doName, row.doLine ?? "-", formatCurrency(row.closingBase), String(row.activeDays)])}
            />
            <ReportTable
              title="Daily Trend"
              headers={["Day", "Issuance Jazz Load", "Payment", "Closing", "In-Hand"]}
              rows={localSummary.dayRows.map((row) => [String(row.dayNo), formatCurrency(row.issuanceMl), formatCurrency(row.paymentBase), formatCurrency(row.closingBase), formatCurrency(row.inHandBalance)])}
            />
          </div>
        </div>
      )}

      {section === "daily" && (
        <div className="space-y-5">
          <section className="panel">
            <div className="mb-4">
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-[0.14em] text-slate-300">Daily Lifting</h3>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
                <label>Opening Balance<NumberInput value={liftingOpening} disabled={true} onChange={setLiftingOpening} /></label>
                <label>
                  Jazz Load Lifting
                  <NumberInput
                    value={mlLifting}
                    disabled={!canEditDaily}
                    onFocus={() => focusDraftField("mlLifting")}
                    onBlur={() => blurDraftField("mlLifting")}
                    onChange={(value) => {
                      markDraftDirty();
                      setMlLifting(value);
                    }}
                  />
                </label>
                <label>Total Balance<input value={formatCurrency(previewLifting.totalBalance)} disabled readOnly /></label>
                <label>Today Jazz Load Issuance<input value={formatCurrency(previewLifting.todayMlIssuance)} disabled readOnly /></label>
                <label>In-Hand Balance<input value={formatCurrency(previewLifting.inHandBalance)} disabled readOnly /></label>
              </div>
            </div>
            <div className="mb-5 border-b border-slate-800 pb-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[
                  ["Commission 1", previewSummary.commission1],
                  ["Commission 2", previewSummary.commission2],
                  ["Total Commission", previewSummary.totalCommission]
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm">
                    <p className="text-xs uppercase text-slate-500">{label}</p>
                    <p className="mt-1 font-semibold text-white">{formatCurrency(value as number)}</p>
                  </div>
                ))}
              </div>
              <label className="mt-4">
                Notes
                <input
                  value={dayNotes}
                  disabled={!canEditDaily}
                  onFocus={() => focusDraftField("dayNotes")}
                  onBlur={() => blurDraftField("dayNotes")}
                  onChange={(event) => {
                    markDraftDirty();
                    setDayNotes(event.target.value);
                  }}
                />
              </label>
            </div>
            <div className="panel-title">
              <div>
                <h3>Daily DO Entry</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="btn-chip" title={saveState.reason ? saveState.detail : autoSaveError || undefined}>
                  {autoSaveChipText}
                </span>
              </div>
            </div>
            <div className="mb-4 flex flex-wrap gap-2 text-sm text-slate-300">
              <span className="btn-chip"><CalendarDays /> {selectedDate}</span>
              <span className="btn-chip">Status: {statusLabel(selectedJazzStatus)}</span>
              {canManageSettings ? (
                <>
                  <span className="btn-chip">Active Jazz Load: {activeRates.mlRate ? `${activeRates.mlRate.name} ${formatPercentage(activeRates.mlRate.percentage)}` : "missing"}</span>
                  <span className="btn-chip">Commission 1: {activeRates.commission1Rate ? formatPercentage(activeRates.commission1Rate.percentage) : "missing"}</span>
                  <span className="btn-chip">Commission 2: {activeRates.commission2Rate ? formatPercentage(activeRates.commission2Rate.percentage) : "missing"}</span>
                </>
              ) : (
                <span className="btn-chip">Calculation rates locked</span>
              )}
            </div>
            {unboundLineDrafts.length > 0 && (
              <p className="warning mb-4">
                No DO binding configured for {unboundLineDrafts.map((draft) => draft.doLine ?? draft.doLineId).join(", ")} on {selectedDate}. Configure it in Jazz Load Settings.
              </p>
            )}
            <div className="table-wrap">
              <table className="min-w-[1180px]">
                <thead>
                  <tr>
                    <th>DO Line</th>
                    <th>Bound DO Name</th>
                    <th>Opening Balance</th>
                    {/* <th>Open Jazz Load</th> */}
                    <th>Issuance Balance</th>
                    <th>Issuance Jazz Load</th>
                    <th>Total Recieveable</th>
                    <th>Payment Recieved</th>
                    {/* <th>Payment Jazz Load</th> */}
                    <th>Closing Balance</th>
                    <th>Closing Jazz Load</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft, index) => {
                    const preview = previewEntries[index];
                    return (
                      <tr key={draft.id}>
                        <td>
                          <p className="font-semibold text-white">{draft.doLine || "-"}</p>
                          {/* <p className="text-xs text-slate-500">{draft.doLine ? "Settings-bound line" : "Legacy row"}</p> */}
                        </td>
                        <td>
                          {draft.doName ? (
                            <>
                              <p className="font-semibold text-white">{draft.doName}</p>
                              {draft.bindingEffectiveFromMonthId && draft.bindingEffectiveFromDay ? (
                                <p className="text-xs text-slate-500">Binding</p>
                              ) : (
                                <p className="text-xs text-slate-500">Saved row snapshot</p>
                              )}
                            </>
                          ) : (
                            <p className="text-xs text-amber-300">No DO binding configured for this line/date. Configure it in Jazz Load Settings.</p>
                          )}
                        </td>
                        <td>
                          <NumberInput
                            value={selectedDay === 1 && isPostgreSqlPeriod(monthId) && pgSeedsVerified ? (pgJazzDoOpenings.get(draft.doProfileId ?? '') ?? 0) : (selectedDay === 1 && previousMonthDays.length === 0 ? draft.openingBase ?? 0 : preview?.openingBalance.baseAmount ?? 0)}
                            disabled={(!canEditDaily || selectedDay !== 1 || previousMonthDays.length > 0) || (isPostgreSqlPeriod(monthId) && pgSeedsVerified)}
                            onFocus={() => focusDraftField(`${draft.id}:openingBase`)}
                            onBlur={() => blurDraftField(`${draft.id}:openingBase`)}
                            onChange={(value) => setDraft(index, { openingBase: value })}
                          />
                        </td>
                        {/* <td>{formatCurrency(preview?.openingBalance.calculatedAmount ?? 0)}</td> */}
                        <td>
                          <NumberInput
                            value={draft.todayMlIssuanceBase}
                            disabled={!canEditDaily}
                            onFocus={() => focusDraftField(`${draft.id}:todayMlIssuanceBase`)}
                            onBlur={() => blurDraftField(`${draft.id}:todayMlIssuanceBase`)}
                            onChange={(value) => setDraft(index, { todayMlIssuanceBase: value })}
                          />
                        </td>
                        <td>{formatCurrency(preview?.todayMlIssuance.calculatedAmount ?? 0)}</td>
                        <td>{formatCurrency(preview?.dayTotal.baseAmount ?? 0)}</td>
                        <td>
                          <NumberInput
                            value={draft.paymentReceivedBase}
                            disabled={!canEditDaily}
                            onFocus={() => focusDraftField(`${draft.id}:paymentReceivedBase`)}
                            onBlur={() => blurDraftField(`${draft.id}:paymentReceivedBase`)}
                            onChange={(value) => setDraft(index, { paymentReceivedBase: value })}
                          />
                        </td>
                        {/* <td>{formatCurrency(preview?.paymentReceived.calculatedAmount ?? 0)}</td> */}
                        <td>{formatCurrency(preview?.closingBalance.baseAmount ?? 0)}</td>
                        <td>{formatCurrency(preview?.closingBalance.calculatedAmount ?? 0)}</td>
                      </tr>
                    );
                  })}
                  {drafts.length === 0 && (
                    <tr><td colSpan={9}>No active DO names or lines configured. Add DO Names and DO Lines in Settings.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700 font-semibold text-white">
                    <td className="uppercase tracking-[0.12em] text-slate-300">Daily Totals</td>
                    <td className="text-slate-500">-</td>
                    <td>{formatCurrency(previewSummary.openingBase)}</td>
                    {/* <td>{formatCurrency(previewSummary.openingMl)}</td> */}
                    <td>{formatCurrency(previewSummary.issuanceBase)}</td>
                    <td>{formatCurrency(previewSummary.issuanceMl)}</td>
                    <td>{formatCurrency(previewSummary.dayTotalBase ?? 0)}</td>
                    <td>{formatCurrency(previewSummary.paymentBase)}</td>
                    {/* <td>{formatCurrency(previewSummary.paymentMl)}</td> */}
                    <td>{formatCurrency(previewSummary.closingBase)}</td>
                    <td>{formatCurrency(previewSummary.closingMl)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </div>
      )}

      {section === "reports" && (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn-primary" disabled={localSummary.dayRows.length === 0} onClick={() => exportJazzLoadXlsx(localSummary, days)}><FileSpreadsheet /> Export Excel</button>
            <button className="btn-secondary" disabled={localSummary.dayRows.length === 0} onClick={() => exportJazzLoadPrintable(localSummary)}><FileDown /> Export PDF/Print</button>
          </div>
          <ReportTable title="DO Balance Report" headers={["DO", "Line", "Opening", "Issuance", "Payments", "Closing Jazz Load"]} rows={doBalanceRows.map((row) => [row.doName, row.doLine ?? "-", formatCurrency(row.openingBase), formatCurrency(row.issuanceBase), formatCurrency(row.paymentBase), formatCurrency(row.closingMl)])} />
          <ReportTable title="Jazz Load Issuance Report" headers={["Day", "Issuance Base", "Issuance Jazz Load"]} rows={localSummary.dayRows.map((row) => [String(row.dayNo), formatCurrency(row.issuanceBase), formatCurrency(row.issuanceMl)])} />
          <ReportTable title="Payments Received" headers={["Day", "Payment Base", "Payment Jazz Load"]} rows={localSummary.dayRows.map((row) => [String(row.dayNo), formatCurrency(row.paymentBase), formatCurrency(row.paymentMl)])} />
          <ReportTable title="Lifting Summary" headers={["Day", "Lifting", "In-Hand"]} rows={localSummary.dayRows.map((row) => [String(row.dayNo), formatCurrency(row.lifting), formatCurrency(row.inHandBalance)])} />
          <ReportTable title="Commission Report" headers={["Day", "Commission 1", "Commission 2", "Total"]} rows={localSummary.dayRows.map((row) => [String(row.dayNo), formatCurrency(row.commission1), formatCurrency(row.commission2), formatCurrency(row.commission)])} />
        </div>
      )}

      {section === "settings" && canManageSettings && (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <section className="panel">
            <div className="panel-title"><div><h3>Calculation Rates</h3><p>Owner-managed rates apply only to new saves and are snapshotted on each day.</p></div></div>
            <p className="mb-3 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-xs text-slate-300">
              New rates apply to new Jazz Load days. Existing saved days keep their saved rate snapshots unless the owner explicitly applies current rates to that day.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end">
              <label>
                Type
                <select value={rateType} disabled={!canManageSettings} onChange={(event) => setRateType(event.target.value as JazzLoadRateType)}>
                  <option value="ml_addition">Jazz Load Addition Rate</option>
                  <option value="commission1_adjustment">Commission 1 Adjustment Rate</option>
                  <option value="commission2_payment">Commission 2 Payment Rate</option>
                </select>
              </label>
              <label>Name<input value={rateName} disabled={!canManageSettings} onChange={(event) => setRateName(event.target.value)} placeholder="Rate name" /></label>
              <label>Percentage<NumberInput value={ratePercentage} disabled={!canManageSettings} onChange={setRatePercentage} /></label>
              <div className="flex items-end gap-2">
                <button className="btn-primary" disabled={!canManageSettings || !rateName.trim()} onClick={saveRate}>
                  {editingRateId ? "Update Rate" : "Save Rate"}
                </button>
                {editingRateId && (
                  <button className="btn-secondary" disabled={!canManageSettings} onClick={cancelRateEdit}>
                    Cancel
                  </button>
                )}
              </div>
            </div>
            <SettingsRows
              rows={displayRates.map((rate) => ({
                id: rate.id,
                label: `${rate.active ? "Active" : "Inactive"} · ${rate.name} · ${formatPercentage(rate.percentage)} · ${rate.type}`,
                active: rate.active,
                onToggle: () => toggleRate(rate),
                onEdit: () => editRate(rate),
                onDelete: () => removeRate(rate)
              }))}
              canEdit={canManageSettings}
              onDragStart={(id) => { draggedRateIdRef.current = id; }}
              onDrop={reorderRates}
            />
          </section>
          <section className="panel">
            <div className="panel-title"><div><h3>DO Names</h3><p>Names are managed independently from fixed lines.</p></div></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label>DO Name<input value={doNameDraft} disabled={!canManageSettings} onChange={(event) => setDoNameDraft(event.target.value)} /></label>
              <button className="btn-primary" disabled={!canManageSettings || !doNameDraft.trim()} onClick={saveDoName}>Save Name</button>
            </div>
            <div className="mt-4 space-y-2">
              {displayDoNames.map((name) => (
                <div
                  key={name.id}
                  className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between"
                  draggable={canManageSettings}
                  onDragStart={() => { draggedDoNameIdRef.current = name.id; }}
                  onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                  onDrop={() => reorderDoNames(name.id)}
                >
                  <div>
                    <p className="flex items-center gap-2 font-medium text-white">
                      {canManageSettings && (
                        <button className="btn-secondary !h-8 !w-8 !px-0 cursor-grab" type="button" title="Drag to reorder">
                          <GripVertical className="h-4 w-4" />
                        </button>
                      )}
                      {name.name}
                    </p>
                    <p className="text-xs text-slate-500">{name.active ? "active" : "inactive"}</p>
                  </div>
                  <div className="flex gap-2">
                    <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canManageSettings} onClick={() => editDoName(name)} title="Edit DO name">
                      <Pencil />
                    </button>
                    <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canManageSettings} onClick={() => removeDoName(name)} title="Delete DO name">
                      <Trash2 />
                    </button>
                  </div>
                </div>
              ))}
              {displayDoNames.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
            </div>
          </section>
          <section className="panel">
            <div className="panel-title"><div><h3>DO Lines</h3><p>Lines stay fixed and can be assigned to different names per date.</p></div></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label>DO Line<input value={doLineDraft} disabled={!canManageSettings} onChange={(event) => setDoLineDraft(event.target.value)} /></label>
              <button className="btn-primary" disabled={!canManageSettings || !doLineDraft.trim()} onClick={saveDoLine}>Save Line</button>
            </div>
            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
              <p className="text-sm font-semibold text-white">DO Line Binding</p>
              <p className="mt-1 text-xs text-slate-400">New bindings apply from the effective date onward. Saved historical rows keep their stored DO name snapshots.</p>
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_11rem_auto] md:items-end">
                <label>
                  DO Line
                  <select value={bindingLineId} disabled={!canManageSettings} onChange={(event) => setBindingLineId(event.target.value)}>
                    <option value="">Select line</option>
                    {activeLines.map((line) => (
                      <option key={line.id} value={line.id}>{line.line}</option>
                    ))}
                  </select>
                </label>
                <label>
                  DO Name
                  <select value={bindingDoNameId} disabled={!canManageSettings} onChange={(event) => setBindingDoNameId(event.target.value)}>
                    <option value="">Select name</option>
                    {activeDoNames.map((name) => (
                      <option key={name.id} value={name.id}>{name.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Effective From
                  <input
                    type="date"
                    value={bindingEffectiveDate || selectedDate}
                    disabled={!canManageSettings}
                    onChange={(event) => setBindingEffectiveDate(event.target.value)}
                  />
                </label>
                <button className="btn-primary" disabled={!canManageSettings || !bindingLineId || !bindingDoNameId} onClick={saveDoLineBinding}>
                  Save Binding
                </button>
              </div>
            </div>
            <div className="mt-4 space-y-2">
              {displayDoLines.map((line, index) => {
                const currentBinding = resolveDoLineBindingForDate(doLineBindings, line.id, monthId, selectedDay);
                return (
                  <div
                    key={line.id}
                    className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between"
                    draggable={canManageSettings}
                    onDragStart={() => { draggedDoLineIdRef.current = line.id; }}
                    onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
                    onDrop={() => reorderDoLines(line.id)}
                  >
                    <div>
                      <p className="flex items-center gap-2 font-medium text-white">
                        {canManageSettings && (
                          <button className="btn-secondary !h-8 !w-8 !px-0 cursor-grab" type="button" title="Drag to reorder">
                            <GripVertical className="h-4 w-4" />
                          </button>
                        )}
                        {line.line}
                      </p>
                      <p className="text-xs text-slate-500">Order {index + 1} · {line.active ? "active" : "inactive"}</p>
                      <p className="text-xs text-slate-400">
                        Bound DO Name: {currentBinding ? `${currentBinding.doName} from ${bindingEffectiveDateLabel(currentBinding)}` : "No binding for selected date"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button className="btn-secondary !h-9" disabled={!canManageSettings} onClick={() => editDoLineBinding(line)} title="Bind DO line">
                        Bind
                      </button>
                      <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canManageSettings} onClick={() => editDoLine(line)} title="Edit DO line">
                        <Pencil />
                      </button>
                      <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canManageSettings} onClick={() => removeDoLine(line)} title="Delete DO line">
                        <Trash2 />
                      </button>
                    </div>
                  </div>
                );
              })}
              {displayDoLines.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
            </div>
            <div className="mt-4">
              <p className="text-sm font-semibold text-white">Binding History</p>
              <div className="mt-2 space-y-2">
                {orderedDoLineBindings.slice(0, 20).map((binding) => (
                  <p key={binding.id} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs text-slate-300">
                    {binding.doLineName ?? binding.doLineId} {"->"} {binding.doName} from {bindingEffectiveDateLabel(binding)}
                  </p>
                ))}
                {orderedDoLineBindings.length === 0 && <p className="text-sm text-slate-500">No DO line bindings configured.</p>}
              </div>
            </div>
            <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
              <p className="text-sm font-semibold text-amber-100">Historical DO Binding Repair</p>
              <p className="mt-1 text-xs text-amber-100/80">
                One-time owner repair for old saved days. It updates DO name snapshots only and leaves all financial values unchanged.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <label>
                  From Month
                  <input
                    type="month"
                    value={bindingBackfillFromMonthId}
                    disabled={bindingBackfillRunning || role !== "owner"}
                    onChange={(event) => {
                      setBindingBackfillFromMonthId(event.target.value);
                      setBindingBackfillPreview(null);
                    }}
                  />
                </label>
                <label>
                  To Month
                  <input
                    type="month"
                    value={bindingBackfillToMonthId}
                    disabled={bindingBackfillRunning || role !== "owner"}
                    onChange={(event) => {
                      setBindingBackfillToMonthId(event.target.value);
                      setBindingBackfillPreview(null);
                    }}
                  />
                </label>
                <button
                  className="btn-secondary"
                  disabled={bindingBackfillRunning || role !== "owner" || !bindingBackfillFromMonthId || !bindingBackfillToMonthId}
                  onClick={applyCurrentDoBindingsBackfill}
                >
                  {bindingBackfillRunning ? "Repair Running..." : "Apply Current DO Bindings To Previous Days"}
                </button>
              </div>
              {bindingBackfillPreview && (
                <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-300">
                  <p>Days scanned: {bindingBackfillPreview.daysScanned}</p>
                  <p>Rows scanned: {bindingBackfillPreview.rowsScanned}</p>
                  <p>Rows that will change: {bindingBackfillPreview.rowsThatWillChange}</p>
                  <p>Rows already correct: {bindingBackfillPreview.rowsAlreadyCorrect}</p>
                  <p>Rows missing binding: {bindingBackfillPreview.rowsMissingBinding}</p>
                  <p>Rows skipped because no current binding exists: {bindingBackfillPreview.rowsSkippedNoCurrentBinding}</p>
                  {bindingBackfillPreview.sampleChanges.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="font-semibold text-white">Sample changes</p>
                      {bindingBackfillPreview.sampleChanges.map((sample) => (
                        <p key={`${sample.monthId}-${sample.dayNo}-${sample.rowId}`}>
                          {sample.monthId} day {sample.dayNo} {sample.doLine ?? sample.doLineId ?? "DO line"}: {sample.oldDoName || "(blank)"} {"->"} {sample.newDoName}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
          <section className="panel xl:col-span-2">
            <div className="panel-title"><div><h3>Legacy DO Profiles</h3><p>Kept for old records only. New workflow uses separate DO Names and DO Lines.</p></div></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
              <label>Legacy Name<input value={profileName} disabled={!roleCanJazzLoad(role, "daily")} onChange={(event) => setProfileName(event.target.value)} /></label>
              <label>Legacy Line<input value={profileLine} disabled={!roleCanJazzLoad(role, "daily")} onChange={(event) => setProfileLine(event.target.value)} /></label>
              <button className="btn-secondary" disabled={!roleCanJazzLoad(role, "daily") || !profileName.trim()} onClick={saveProfile}>Save Legacy DO</button>
            </div>
            <SimpleBadges rows={doProfiles.map((profile) => `${profile.name} · ${profile.line ?? "No line"} · ${profile.active ? "active" : "inactive"}`)} />
          </section>
        </div>
      )}
      {section === "settings" && !canManageSettings && (
        <section className="panel">
          <h3>Settings</h3>
          <p className="warning mt-4">Only owner can manage Jazz Load calculation settings.</p>
        </section>
      )}

      {section === "settings" && canManageSettings && (
        <section className="panel mt-4">
          <div className="panel-title">
            <div>
              <h3>Calculation Formulas & Examples</h3>
              <p>Mathematical definitions and concrete examples for Jazz Load additions and daily commissions.</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
              <h4 className="font-semibold text-emerald-400">1. Jazz Load Addition (ML Addition)</h4>
              <p className="text-xs text-slate-400">
                Converts raw currency Base amounts to standard Jazz Load balances by adding the ML percentage rate.
              </p>
              <div className="rounded bg-slate-900/80 p-2.5 font-mono text-xs text-white border border-slate-800">
                Formula:<br />
                <span className="text-emerald-300">Jazz Load ML = Base Amount * (1 + ML Rate% / 100)</span>
              </div>
              <div className="text-xs space-y-1 text-slate-300">
                <span className="font-medium text-white">Example (at 2.6% ML Rate):</span>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Base Amount = <span className="font-mono text-emerald-300">100,000</span></li>
                  <li>ML Addition = <span className="font-mono">100,000 * 2.6% = 2,600</span></li>
                  <li>Result Jazz Load = <span className="font-mono text-emerald-300">102,600</span></li>
                </ul>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
              <h4 className="font-semibold text-sky-400">2. Daily Lifting & In-Hand Balance</h4>
              <p className="text-xs text-slate-400">
                Tracks inventory stock of Jazz Load. Opening balance carries over automatically from the previous day's In-Hand Balance.
              </p>
              <div className="rounded bg-slate-900/80 p-2.5 font-mono text-xs text-white border border-slate-800">
                Formulas:<br />
                <span className="text-sky-300">Total Balance = Opening Balance + Jazz Load Lifting</span><br />
                <span className="text-sky-300">In-Hand Balance = Total Balance - Today's Total Issuance ML</span>
              </div>
              <div className="text-xs space-y-1 text-slate-300">
                <span className="font-medium text-white">Example:</span>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Opening Balance = <span className="font-mono text-sky-300">50,000</span>, Lifting = <span className="font-mono">200,000</span></li>
                  <li>Total Balance = <span className="font-mono">50,000 + 200,000 = 250,000</span></li>
                  <li>Today's Total Issuance ML = <span className="font-mono">180,000</span></li>
                  <li>Result In-Hand = <span className="font-mono text-sky-300">70,000</span></li>
                </ul>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4 lg:col-span-2">
              <h4 className="font-semibold text-amber-400">3. Commission Calculations</h4>
              <p className="text-xs text-slate-400">
                Commissions are calculated daily on payments received. Commission 1 accounts for ML deductions, while Commission 2 is a flat rate.
              </p>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-200">Commission 1 (Adjustment)</span>
                  <div className="rounded bg-slate-900/80 p-2.5 font-mono text-[11px] text-white border border-slate-800 space-y-1">
                    <div>1. ML Deduction = Payment ML * Comm1 Rate% / 100</div>
                    <div>2. Adjusted Payment = Payment ML - ML Deduction</div>
                    <div>3. Commission 1 = Payment Base - Adjusted Payment</div>
                  </div>
                </div>
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-200">Commission 2 (Payment) & Total</span>
                  <div className="rounded bg-slate-900/80 p-2.5 font-mono text-[11px] text-white border border-slate-800 space-y-1">
                    <div>Commission 2 = Payment Base * Comm2 Rate% / 100</div>
                    <div className="mt-1 pt-1 border-t border-slate-800 text-amber-300">Total Commission = Commission 1 + Commission 2</div>
                  </div>
                </div>
              </div>
              <div className="text-xs space-y-1 text-slate-300 pt-2 border-t border-slate-900">
                <span className="font-medium text-white">Example Calculation (at 2.6% Commission 1 and 1.0% Commission 2):</span>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3 md:gap-4 font-mono text-[11px] bg-slate-900/50 p-3 rounded border border-slate-800/80">
                  <div>
                    <span className="text-slate-400">Input Data:</span><br />
                    Payment Base: <span className="text-white">100,000</span><br />
                    Payment ML: <span className="text-white">102,600</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Commission 1 Steps:</span><br />
                    ML Deduction: <span className="text-slate-400">102,600 * 2.6% =</span> <span className="text-white">2,667.60</span><br />
                    Adjusted Pay: <span className="text-slate-400">102,600 - 2,667.6 =</span> <span className="text-white">99,932.40</span><br />
                    Commission 1: <span className="text-slate-400">100,000 - 99,932.4 =</span> <span className="text-amber-300">67.60</span>
                  </div>
                  <div>
                    <span className="text-slate-400">Commission 2 & Total:</span><br />
                    Commission 2: <span className="text-slate-400">100,000 * 1.0% =</span> <span className="text-white">1,000.00</span><br />
                    Total Commission: <span className="text-slate-400">67.60 + 1,000 =</span> <span className="text-emerald-400 font-semibold">1,067.60</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {section === "backup" && (
        canBackup ? (
          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>Jazz Load Backup / Export</h3>
                <p>Backup stores Jazz Load in its own JSON group, separate from normal expenses.</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button className="btn-secondary" disabled={loading} onClick={onExportBackup}><FileDown /> Export Full Backup</button>
              <label className={`file-button ${loading ? "pointer-events-none opacity-50" : ""}`}>
                Import Full Backup
                <input type="file" accept=".json" disabled={loading} onChange={(event) => onImportBackup(event.target.files?.[0] ?? null)} />
              </label>
            </div>
          </section>
        ) : (
          <section className="panel">
            <h3>Jazz Load Backup / Export</h3>
            <p className="warning mt-4">Owner only.</p>
          </section>
        )
      )}
    </section>
  );
}

function SummaryValue({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 font-semibold text-white">{formatCurrency(value)}</p>
    </div>
  );
}

function ReportTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <section className="panel">
      <div className="panel-title"><div><h3>{title}</h3><p>{rows.length} rows</p></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, index) => <tr key={`${title}-${index}`}>{row.map((cell, cellIndex) => <td key={`${title}-${index}-${cellIndex}`}>{cell}</td>)}</tr>)}
            {rows.length === 0 && <tr><td colSpan={headers.length}>No Jazz Load rows yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SimpleBadges({ rows }: { rows: string[] }) {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {rows.map((row) => <span className="btn-chip" key={row}>{row}</span>)}
      {rows.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
    </div>
  );
}

function SettingsRows({
  rows,
  canEdit,
  onDragStart,
  onDrop
}: {
  rows: Array<{ id: string; label: string; active: boolean; onToggle: () => void; onEdit?: () => void; onDelete?: () => void }>;
  canEdit: boolean;
  onDragStart?: (id: string) => void;
  onDrop?: (id: string) => void;
}) {
  return (
    <div className="mt-4 space-y-2">
      {rows.map((row) => (
        <div
          className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between"
          draggable={canEdit && Boolean(onDragStart && onDrop)}
          key={row.id}
          onDragStart={() => onDragStart?.(row.id)}
          onDragOver={(event: DragEvent<HTMLDivElement>) => event.preventDefault()}
          onDrop={() => onDrop?.(row.id)}
        >
          <span className="flex items-center gap-2">
            {canEdit && onDragStart && onDrop && (
              <button className="btn-secondary !h-8 !w-8 !px-0 cursor-grab" type="button" title="Drag to reorder">
                <GripVertical className="h-4 w-4" />
              </button>
            )}
            {row.label}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {row.onEdit && (
              <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canEdit} onClick={row.onEdit} title="Edit row">
                <Pencil className="h-4 w-4" />
              </button>
            )}
            <button className="btn-secondary !h-9" disabled={!canEdit} onClick={row.onToggle}>
              {row.active ? "Deactivate" : "Activate"}
            </button>
            {row.onDelete && (
              <button className="btn-secondary !h-9 !w-9 !px-0 text-rose-200" disabled={!canEdit} onClick={row.onDelete} title="Delete row">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
    </div>
  );
}
