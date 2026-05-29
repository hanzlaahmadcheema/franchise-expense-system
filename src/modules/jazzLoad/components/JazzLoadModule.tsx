import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { BarChart3, CalendarDays, FileDown, FileSpreadsheet, Pencil, Printer, Save, Settings, Trash2, X } from "lucide-react";
import type { UserRole } from "../../../types/ledger";
import type { SyncState } from "../../../lib/syncStatus";
import {
  calculateDailyLifting,
  calculateDailySummary,
  calculateDoRow,
  calculateMonthlySummary,
  latestEntryForDraft,
  previousEntryForDraftAcrossDays,
  snapshotRate,
  validateJazzLoadDrafts
} from "../services/jazzLoadCalculations";
import {
  closeJazzLoadDaysExceptToday,
  ensureJazzLoadMonth,
  deleteJazzLoadDoLine,
  deleteJazzLoadDoName,
  loadJazzLoadDays,
  recalculateJazzLoadMonth,
  reopenJazzLoadDaysFor15Minutes,
  roleCanJazzLoad,
  saveJazzLoadDay,
  subscribeJazzLoadDoAssignments,
  subscribeJazzLoadDoLines,
  subscribeJazzLoadDoNames,
  subscribeJazzLoadDays,
  subscribeJazzLoadDoProfiles,
  subscribeJazzLoadMonthlySummary,
  subscribeJazzLoadMonths,
  subscribeJazzLoadRates,
  upsertJazzLoadDoAssignment,
  upsertJazzLoadDoLine,
  upsertJazzLoadDoName,
  upsertJazzLoadDoProfile,
  upsertJazzLoadRate,
  type FirestoreSnapshotMeta
} from "../services/jazzLoadFirestore";
import { exportJazzLoadPrintable, exportJazzLoadXlsx } from "../services/jazzLoadReports";
import type {
  ActiveJazzLoadRates,
  JazzLoadDoAssignment,
  JazzLoadDay,
  JazzLoadDoEntryDraft,
  JazzLoadDoLine,
  JazzLoadDoName,
  JazzLoadDoProfile,
  JazzLoadMonth,
  JazzLoadMonthlySummary,
  JazzLoadRateConfig,
  JazzLoadRateType
} from "../types/jazzLoad.types";
import {
  dayDate,
  daysInMonth,
  formatCurrency,
  formatPercentage,
  monthLabel,
  parseMoneyInput
} from "../utils/jazzLoadFormatters";

type JazzLoadSection = "daily" | "dashboard" | "reports" | "settings" | "backup";
type JazzLoadPopup = {
  kind: "success" | "warning" | "error";
  text: string;
};

type Props = {
  user: User;
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
  loading?: boolean;
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

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || crypto.randomUUID();
}

function activeRateFor(rates: JazzLoadRateConfig[], primaryType: JazzLoadRateType, legacyTypes: JazzLoadRateType[] = []) {
  return rates.find((rate) => rate.active && rate.type === primaryType) ??
    rates.find((rate) => rate.active && legacyTypes.includes(rate.type)) ??
    null;
}

function getMillis(val: unknown): number {
  if (!val) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && "toMillis" in val && typeof val.toMillis === "function") return val.toMillis();
  if (val instanceof Date) return val.getTime();
  if (typeof val === "object" && "seconds" in val) {
    const timestamp = val as { seconds: number; nanoseconds?: number };
    return timestamp.seconds * 1000 + Math.floor((timestamp.nanoseconds ?? 0) / 1000000);
  }
  return Number(val);
}

function NumberInput({
  value,
  onChange,
  disabled
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  const formatInputValue = (nextValue: number) => nextValue ? String(Math.round(nextValue)) : "";
  const [text, setText] = useState(formatInputValue(value));

  useEffect(() => {
    setText(formatInputValue(value));
  }, [value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.target.value;
        if (!/^\d*\.?\d*$/.test(next)) return;
        setText(next);
        const parsed = parseMoneyInput(next);
        if (!Number.isNaN(parsed)) onChange(parsed);
      }}
      onBlur={() => {
        const parsed = parseMoneyInput(text);
        if (Number.isNaN(parsed)) {
          setText("");
          onChange(0);
          return;
        }
        setText(formatInputValue(parsed));
        onChange(parsed);
      }}
    />
  );
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

function asDraft(entry: JazzLoadDay["doEntries"][number]): JazzLoadDoEntryDraft {
  return {
    id: entry.id,
    doProfileId: entry.doProfileId,
    doName: entry.doName,
    doLine: entry.doLine,
    doLineSortOrder: entry.doLineSortOrder,
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
  loading
}: Props) {
  const [section, setSection] = useState<JazzLoadSection>("daily");
  const [selectedDay, setSelectedDay] = useState(new Date().getDate());
  const [months, setMonths] = useState<JazzLoadMonth[]>([]);
  const [days, setDays] = useState<JazzLoadDay[]>([]);
  const [previousMonthDays, setPreviousMonthDays] = useState<JazzLoadDay[]>([]);
  const [summary, setSummary] = useState<JazzLoadMonthlySummary | null>(null);
  const [rates, setRates] = useState<JazzLoadRateConfig[]>([]);
  const [doProfiles, setDoProfiles] = useState<JazzLoadDoProfile[]>([]);
  const [doNames, setDoNames] = useState<JazzLoadDoName[]>([]);
  const [doLines, setDoLines] = useState<JazzLoadDoLine[]>([]);
  const [doAssignments, setDoAssignments] = useState<JazzLoadDoAssignment[]>([]);
  const [drafts, setDrafts] = useState<JazzLoadDoEntryDraft[]>([]);
  const [liftingOpening, setLiftingOpening] = useState(0);
  const [mlLifting, setMlLifting] = useState(0);
  const [dayNotes, setDayNotes] = useState("");
  const [rateName, setRateName] = useState("");
  const [rateType, setRateType] = useState<JazzLoadRateType>("ml_addition");
  const [ratePercentage, setRatePercentage] = useState(0);
  const [profileName, setProfileName] = useState("");
  const [profileLine, setProfileLine] = useState("");
  const [doNameDraft, setDoNameDraft] = useState("");
  const [doLineDraft, setDoLineDraft] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [autoSaveState, setAutoSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [bulkReopening, setBulkReopening] = useState<"selected" | "all" | null>(null);
  const [bulkClosingDays, setBulkClosingDays] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState<boolean>(() => {
    const stored = localStorage.getItem("jazzLoadAutoSaveEnabled");
    return stored !== "false";
  });
  const toggleAutoSave = (enabled: boolean) => {
    setAutoSaveEnabled(enabled);
    localStorage.setItem("jazzLoadAutoSaveEnabled", String(enabled));
  };
  const [editingDoNameRows, setEditingDoNameRows] = useState<Set<string>>(() => new Set());
  const [popup, setPopup] = useState<JazzLoadPopup | null>(null);
  const saveInFlightRef = useRef(false);
  const lastSavedRef = useRef("");
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
  const selectedDayRecord = days.find((day) => day.dayNo === selectedDay);
  const latestPriorDay = selectedDay === 1
    ? [...previousMonthDays].sort((a, b) => a.dayNo - b.dayNo).at(-1)
    : [...days].filter((day) => day.dayNo < selectedDay).sort((a, b) => a.dayNo - b.dayNo).at(-1);
  const selectedDate = dayDate(monthId, selectedDay);
  const selectedDayFuture = isFutureJazzDay(monthId, selectedDay, now);
  const selectedDayLive = monthId === currentMonthId(now) && selectedDay === now.getDate();
  const selectedDayCorrectionActive = Boolean(selectedDayRecord?.reopenedUntilAt && getMillis(selectedDayRecord.reopenedUntilAt) > now.getTime());
  const activeRates: ActiveJazzLoadRates = useMemo(
    () => ({
      mlRate: activeRateFor(rates, "ml_addition"),
      commission1Rate: activeRateFor(rates, "commission1_adjustment", ["adjustment"]),
      commission2Rate: activeRateFor(rates, "commission2_payment", ["commission"])
    }),
    [rates]
  );
  const canRead = roleCanJazzLoad(role, "read");
  const canEditDaily =
    roleCanJazzLoad(role, "daily") &&
    !selectedDayFuture &&
    currentMonth?.status !== "closed" &&
    (role === "owner" || selectedDayLive) &&
    (selectedDayRecord?.status !== "closed" || selectedDayCorrectionActive);
  const canManageSettings = roleCanJazzLoad(role, "settings");
  const canBackup = roleCanJazzLoad(role, "backup");
  const sortedDoLines = useMemo(
    () =>
      [...doLines].sort((left, right) => {
        const orderLeft = left.sortOrder ?? Number.POSITIVE_INFINITY;
        const orderRight = right.sortOrder ?? Number.POSITIVE_INFINITY;
        if (orderLeft !== orderRight) return orderLeft - orderRight;
        return left.line.localeCompare(right.line, undefined, { numeric: true, sensitivity: "base" });
      }),
    [doLines]
  );
  const orderedDoLines = useMemo(
    () => sortedDoLines.map((line, index) => ({ ...line, sortOrder: index })),
    [sortedDoLines]
  );
  const activeLines = useMemo(() => orderedDoLines.filter((line) => line.active), [orderedDoLines]);

  useEffect(() => {
    const unsubscribers = [
      subscribeJazzLoadRates((items, metadata) => {
        setRates(items);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadDoProfiles((items, metadata) => {
        setDoProfiles(items);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadDoNames((items, metadata) => {
        setDoNames(items);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadDoLines((items, metadata) => {
        setDoLines(items);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadMonths((items, metadata) => {
        setMonths(items);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, []);

  useEffect(() => {
    const unsubscribers = [
      subscribeJazzLoadDays(monthId, (items, metadata) => {
        setDays(items);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message)),
      subscribeJazzLoadMonthlySummary(monthId, (item, metadata) => {
        setSummary(item);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (error) => callbacksRef.current.onFirestoreError(error.message))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [monthId]);

  useEffect(() => {
    let cancelled = false;
    async function loadPreviousMonth() {
      const [yearText, monthText] = monthId.split("-");
      const year = Number(yearText);
      const month = Number(monthText);
      if (!Number.isInteger(year) || !Number.isInteger(month)) {
        setPreviousMonthDays([]);
        return;
      }
      const previousMonthId = month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
      try {
        const items = await loadJazzLoadDays(previousMonthId);
        if (!cancelled) setPreviousMonthDays(items);
      } catch {
        if (!cancelled) setPreviousMonthDays([]);
      }
    }
    void loadPreviousMonth();
    return () => {
      cancelled = true;
    };
  }, [monthId]);

  useEffect(() => {
    if (selectedDayFuture) {
      setDoAssignments([]);
      return;
    }
    return subscribeJazzLoadDoAssignments(monthId, selectedDay, (items, metadata) => {
      setDoAssignments(items.filter((item) => item.active));
      callbacksRef.current.onSnapshotMetadata(metadata);
    }, (error) => callbacksRef.current.onFirestoreError(error.message));
  }, [monthId, selectedDay, selectedDayFuture]);

  // Auto-close reopened Jazz Load day when the correction window expires
  useEffect(() => {
    if (selectedDayFuture || !selectedDayRecord) return;
    if (selectedDayRecord.status !== "open" || !selectedDayRecord.reopenedUntilAt) return;
    
    const expiresAt = getMillis(selectedDayRecord.reopenedUntilAt);
    if (expiresAt > now.getTime()) return;

    void saveDay("closed", { silent: true });
  }, [now, selectedDayRecord, selectedDayFuture]);

  useEffect(() => {
    if (selectedDayFuture) {
      setDrafts([]);
      setLiftingOpening(0);
      setMlLifting(0);
      setDayNotes("");
      return;
    }
    const savedByLine = new Map((selectedDayRecord?.doEntries ?? []).map((entry) => [entry.doLineId ?? entry.doLine ?? entry.id, entry]));
    const assignmentByLine = new Map(doAssignments.map((assignment) => [assignment.doLineId, assignment]));
    if (selectedDayRecord) {
      const nextDrafts = activeLines.map((line) => {
        const saved = savedByLine.get(line.id) ?? savedByLine.get(line.line);
        const assignment = assignmentByLine.get(line.id);
        if (saved) {
          return {
            ...asDraft(saved),
            id: assignment?.id ?? saved.id,
            doLineId: line.id,
            doLine: line.line,
            doNameId: assignment?.doNameId ?? saved.doNameId,
            assignmentId: assignment?.id ?? saved.assignmentId,
            doName: assignment?.doName ?? saved.doName
          };
        }
        const carried = previousEntryForDraftAcrossDays(days, selectedDay, {
          doNameId: assignment?.doNameId,
          doName: assignment?.doName ?? "",
          doLineId: line.id,
          doLine: line.line
        });
        return lineDraft(
          line,
          assignment ?? (carried ? { doNameId: carried.doNameId, doName: carried.doName } : undefined)
        );
      });
      setDrafts(nextDrafts);
      setLiftingOpening(latestPriorDay?.lifting.inHandBalance ?? 0);
      setMlLifting(selectedDayRecord.lifting.mlLifting);
      setDayNotes(selectedDayRecord.notes ?? "");
      return;
    }
    setDrafts(
      activeLines.map((line) => {
        const assignment = assignmentByLine.get(line.id);
        const carried = previousEntryForDraftAcrossDays(days, selectedDay, {
          doNameId: assignment?.doNameId,
          doName: assignment?.doName ?? "",
          doLineId: line.id,
          doLine: line.line
        });
        return lineDraft(line, assignment ?? (carried ? { doNameId: carried.doNameId, doName: carried.doName } : undefined));
      })
    );
    setLiftingOpening(latestPriorDay?.lifting.inHandBalance ?? 0);
    setMlLifting(0);
    setDayNotes("");
  }, [activeLines, days, doAssignments, latestPriorDay, previousMonthDays, selectedDay, selectedDayFuture, selectedDayRecord]);

  const previewEntries = useMemo(() => {
    if (!activeRates.mlRate) return [];
    return drafts.map((draft) => {
      const previous = resolveOpeningEntry(draft);
      const openingBase = selectedDay === 1 ? previous?.closingBalance.baseAmount ?? draft.openingBase ?? 0 : previous?.closingBalance.baseAmount ?? draft.openingBase ?? 0;
      return calculateDoRow(
        { ...draft, openingBase },
        activeRates,
        { createdBy: user.uid, previous: selectedDayRecord?.doEntries.find((entry) => entry.id === draft.id), timestamp: Date.now() }
      );
    });
  }, [activeRates, days, drafts, previousMonthDays, selectedDay, selectedDayRecord?.doEntries, user.uid]);
  const previewSummary = calculateDailySummary({ doEntries: previewEntries }, activeRates);
  const previewLifting = calculateDailyLifting({ openingBalance: liftingOpening, mlLifting }, previewSummary.issuanceMl);
  const localSummary = summary ?? calculateMonthlySummary(monthId, days);
  const validation = validateJazzLoadDrafts(
    drafts.map((draft) => ({
      ...draft,
      openingBase: resolveOpeningEntry(draft)?.closingBalance.baseAmount ?? draft.openingBase ?? 0
    })),
    activeRates
  );

  const warningMessage = !currentMonth
    ? ""
    : syncState === "offline"
      ? "Offline mode: Jazz Load changes will sync when this device reconnects."
      : !activeRates.mlRate || !activeRates.commission1Rate || !activeRates.commission2Rate
        ? (canManageSettings
            ? "Owner must configure active Jazz Load Addition, Commission 1 Adjustment, and Commission 2 Payment rates before financial entry."
            : "Jazz Load calculation settings are unavailable until the owner configures them.")
        : isFutureJazzDay(monthId, selectedDay, now)
          ? "Future Jazz Load days are disabled and cannot create records."
          : currentMonth.status === "closed"
            ? "This Jazz Load month is closed. Reopen it before editing."
            : selectedDayRecord?.status === "closed" && !selectedDayCorrectionActive
              ? `Day ${selectedDay} is closed. Reopen it to edit.`
              : !validation.valid && canEditDaily
                ? validation.errors[0] ?? ""
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
      openingBase: openingEntry?.closingBalance.baseAmount ?? previous?.closingBalance.baseAmount ?? 0,
      todayMlIssuanceBase: 0,
      paymentReceivedBase: 0
    };
  }

  function emptyJazzLoadDay(dayNo: number, status: "open" | "closed", timestamp = Date.now()): JazzLoadDay {
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
    setDrafts((current) => current.map((draft, draftIndex) => (draftIndex === index ? { ...draft, ...patch } : draft)));
  }

  function setDoNameEditing(rowId: string, editing: boolean) {
    setEditingDoNameRows((current) => {
      const next = new Set(current);
      if (editing) next.add(rowId);
      else next.delete(rowId);
      return next;
    });
  }

  async function saveDay(status: "open" | "closed" = "open", options: { silent?: boolean } = {}) {
    if (selectedDayFuture) {
      if (!options.silent) pushPopup("warning", "Future Jazz Load days are disabled and cannot create records.");
      return;
    }
    if (!roleCanJazzLoad(role, "daily")) {
      if (!options.silent) pushPopup("error", "Your role can view Jazz Load but cannot save daily entries.");
      return;
    }
    if (role === "admin" && !selectedDayLive) {
      if (!options.silent) pushPopup("error", "Admins can only edit the current running day.");
      return;
    }
    if (!validation.valid) {
      if (!options.silent) pushPopup("error", validation.errors[0] ?? "Fix Jazz Load validation errors before saving.");
      return;
    }
    const month = currentMonth ?? await ensureJazzLoadMonth(monthId, user, role);
    const timestamp = Date.now();
    const nextStatus = status === "closed" || (selectedDayRecord?.status === "closed" && !selectedDayCorrectionActive) ? "closed" : "open";
    const entries = drafts.map((draft) => {
      const previous = resolveOpeningEntry(draft);
      const openingBase = previous?.closingBalance.baseAmount ?? draft.openingBase ?? 0;
      return calculateDoRow(
        { ...draft, openingBase },
        activeRates,
        { createdBy: user.uid, previous: selectedDayRecord?.doEntries.find((entry) => entry.id === draft.id), timestamp }
      );
    });
    const nextSummary = calculateDailySummary({ doEntries: entries }, activeRates, timestamp);
    const day: JazzLoadDay = {
      id: String(selectedDay),
      monthId,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      status: nextStatus,
      doEntries: entries,
      lifting: calculateDailyLifting({ openingBalance: liftingOpening, mlLifting }, nextSummary.issuanceMl),
      summary: nextSummary,
      appliedRates: {
        mlRate: activeRates.mlRate ? snapshotRate(activeRates.mlRate, timestamp) : undefined,
        commission1Rate: activeRates.commission1Rate ? snapshotRate(activeRates.commission1Rate, timestamp) : undefined,
        commission2Rate: activeRates.commission2Rate ? snapshotRate(activeRates.commission2Rate, timestamp) : undefined
      },
      notes: dayNotes.trim() || undefined,
      createdBy: selectedDayRecord?.createdBy ?? user.uid,
      updatedBy: user.uid,
      createdAt: selectedDayRecord?.createdAt ?? timestamp,
      updatedAt: timestamp,
      closedAt: nextStatus === "closed" ? (selectedDayRecord?.closedAt ?? timestamp) : undefined,
      closedBy: nextStatus === "closed" ? (selectedDayRecord?.closedBy ?? user.uid) : undefined,
      reopenedAt: nextStatus === "open" ? selectedDayRecord?.reopenedAt : undefined,
      reopenedBy: nextStatus === "open" ? selectedDayRecord?.reopenedBy : undefined,
      reopenedUntilAt: nextStatus === "open" ? selectedDayRecord?.reopenedUntilAt : undefined
    };
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), day].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(
      saveJazzLoadDay(month, day, days, user, role, status === "closed" ? "close-day" : "save-day"),
      "Could not queue Jazz Load day save."
    );
    if (!options.silent) {
      pushPopup("success", status === "closed" ? `Closed Jazz Load day ${selectedDay} locally.` : `Saved Jazz Load day ${selectedDay} locally.`);
    }
  }

  function reopenDay() {
    if (!selectedDayRecord || !roleCanJazzLoad(role, "daily")) return;
    if (role === "admin" && !selectedDayLive) {
      pushPopup("error", "Only owner can reopen previous days or correction periods.");
      return;
    }
    if (!window.confirm(`Reopen Jazz Load day ${selectedDay}?`)) return;
    const reopened = {
      ...selectedDayRecord,
      status: "closed" as const,
      reopenedAt: Date.now(),
      reopenedBy: user.uid,
      reopenedUntilAt: Date.now() + 15 * 60 * 1000
    };
    const month = currentMonth;
    if (!month) return;
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), reopened].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(saveJazzLoadDay(month, reopened, days, user, role, "reopen-day"), "Could not queue Jazz Load day reopen.");
    pushPopup("success", `Jazz Load day ${selectedDay} opened for a 15-minute correction window.`);
  }

  async function reopenMonthDays(scope: "selected" | "all") {
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

    const liveDate = currentDateState(now);
    const dayNumbers = scope === "selected"
      ? [selectedDay]
      : availableJazzLoadDayNumbers(monthId, now).filter((dayNo) => !(monthId === liveDate.monthId && dayNo === liveDate.dayNo));
    const timestamp = Date.now();
    const reopenUntilAt = timestamp + 15 * 60 * 1000;
    const nextReopenedDays = dayNumbers.map((dayNo) => {
      const existing = days.find((day) => day.dayNo === dayNo) ?? emptyJazzLoadDay(dayNo, "closed", timestamp);
      return {
        ...existing,
        status: "closed" as const,
        reopenedAt: timestamp,
        reopenedBy: user.uid,
        reopenedUntilAt: reopenUntilAt,
        updatedBy: user.uid,
        updatedAt: timestamp
      };
    });

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
      reopenJazzLoadDaysFor15Minutes(month, nextReopenedDays, days, user, role, reopenUntilAt)
        .finally(() => setBulkReopening(null)),
      "Could not queue Jazz Load day reopen."
    );
    pushPopup("success", `${scope === "selected" ? `Jazz Load day ${selectedDay}` : `${nextReopenedDays.length} Jazz Load days`} opened for correction until ${new Date(reopenUntilAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
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
        if (existing?.status === "closed" && !existing.reopenedUntilAt) return [];
        const day: JazzLoadDay = {
          ...(existing ?? emptyJazzLoadDay(dayNo, "closed", timestamp)),
          status: "closed" as const,
          closedAt: existing?.closedAt ?? timestamp,
          closedBy: existing?.closedBy ?? user.uid,
          reopenedAt: undefined,
          reopenedBy: undefined,
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
    onQueueWrite(
      closeJazzLoadDaysExceptToday(month, nextClosedDays, days, user, role)
        .finally(() => setBulkClosingDays(false)),
      "Could not queue Jazz Load close-all-days action."
    );
    pushPopup("success", `Closed ${nextClosedDays.length} Jazz Load day${nextClosedDays.length === 1 ? "" : "s"} except today locally.`);
  }

  async function masterRefreshCalculations() {
    if (!roleCanJazzLoad(role, "daily")) {
      pushPopup("error", "Only owner or admin can refresh Jazz Load calculations.");
      return;
    }
    if (days.length === 0) {
      pushPopup("warning", "No Jazz Load days are available to recalculate.");
      return;
    }
    if (!activeRates.mlRate) {
      pushPopup("error", "Active Jazz Load Addition Rate is required before recalculating.");
      return;
    }
    if (currentMonth?.status === "closed") {
      pushPopup("warning", "Reopen the Jazz Load month before refreshing calculations.");
      return;
    }
    const month = currentMonth ?? await ensureJazzLoadMonth(monthId, user, role);
    setRecalculating(true);
    const recalculation = recalculateJazzLoadMonth(month, days, activeRates, user, role)
      .then((result) => {
        setDays(result.days);
        setSummary(result.summary);
      })
      .finally(() => setRecalculating(false));
    onQueueWrite(recalculation, "Could not queue Jazz Load calculation refresh.");
    pushPopup("success", "Jazz Load master refresh queued. Openings will follow previous closings.");
  }

  function saveRate() {
    if (!canManageSettings || !rateName.trim()) return;
    const id = slug(`${rateType}-${rateName}`);
    onQueueWrite(
      upsertJazzLoadRate({
        id,
        name: rateName.trim(),
        type: rateType,
        percentage: ratePercentage,
        active: true,
        description: "Owner-managed Jazz Load calculation rate"
      }, user, role),
      "Could not queue Jazz Load rate."
    );
    setRateName("");
    setRatePercentage(0);
    pushPopup("success", "Jazz Load calculation rate saved locally.");
  }

  function toggleRate(rate: JazzLoadRateConfig) {
    if (!canManageSettings) return;
    onQueueWrite(
      upsertJazzLoadRate({ ...rate, active: !rate.active }, user, role),
      "Could not queue Jazz Load rate update."
    );
    pushPopup("success", `${rate.name} ${rate.active ? "deactivated" : "activated"} locally.`);
  }

  function saveProfile() {
    if (!roleCanJazzLoad(role, "daily") || !profileName.trim()) return;
    const id = slug(`${profileName}-${profileLine}`);
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
    onQueueWrite(
      upsertJazzLoadDoName({
        id: slug(doNameDraft),
        name: doNameDraft.trim(),
        active: true
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
    onQueueWrite(
      upsertJazzLoadDoName({ ...name, name: nextValue }, user, role),
      "Could not queue DO name update."
    );
    pushPopup("success", "DO name updated locally.");
  }

  function removeDoName(name: JazzLoadDoName) {
    if (!canManageSettings) return;
    if (!window.confirm(`Delete DO Name "${name.name}"?`)) return;
    onQueueWrite(
      deleteJazzLoadDoName(name.id, user, role),
      "Could not queue DO name delete."
    );
    pushPopup("success", "DO name deleted locally.");
  }

  function saveDoLine() {
    if (!canManageSettings || !doLineDraft.trim()) return;
    const nextSortOrder = orderedDoLines.length;
    onQueueWrite(
      upsertJazzLoadDoLine({
        id: slug(doLineDraft),
        line: doLineDraft.trim(),
        sortOrder: nextSortOrder,
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
    onQueueWrite(
      upsertJazzLoadDoLine({ ...line, line: nextValue }, user, role),
      "Could not queue DO line update."
    );
    pushPopup("success", "DO line updated locally.");
  }

  function removeDoLine(line: JazzLoadDoLine) {
    if (!canManageSettings) return;
    if (!window.confirm(`Delete DO Line "${line.line}"?`)) return;
    onQueueWrite(
      deleteJazzLoadDoLine(line.id, user, role),
      "Could not queue DO line delete."
    );
    pushPopup("success", "DO line deleted locally.");
  }

  function setDoLineOrder(lineId: string, nextOrder: number) {
    if (!canManageSettings) return;
    const index = orderedDoLines.findIndex((line) => line.id === lineId);
    if (index < 0) return;
    const reordered = [...orderedDoLines];
    const [line] = reordered.splice(index, 1);
    const targetIndex = Math.max(0, Math.min(Math.trunc(nextOrder), reordered.length));
    reordered.splice(targetIndex, 0, line);
    onQueueWrite(
      Promise.all(
        reordered.map((item, itemIndex) =>
          upsertJazzLoadDoLine({ ...item, sortOrder: itemIndex }, user, role)
        )
      ),
      "Could not queue DO line reorder."
    );
    pushPopup("success", "DO line order updated locally.");
  }

  function assignNameToLine(lineId: string, nameId: string) {
    if (!canEditDaily) {
      pushPopup("warning", selectedDayFuture ? "Future days are disabled." : "This Jazz Load day is read-only.");
      return;
    }
    const line = doLines.find((item) => item.id === lineId);
    const name = doNames.find((item) => item.id === nameId);
    if (!line || !name) return;
    const id = `${selectedDate}-${line.id}`;
    const assignment: Omit<JazzLoadDoAssignment, "createdBy" | "createdAt" | "updatedAt"> = {
      id,
      date: selectedDate,
      monthId,
      dayNo: selectedDay,
      doLineId: line.id,
      doLine: line.line,
      doLineSortOrder: line.sortOrder,
      doNameId: name.id,
      doName: name.name,
      active: true
    };
    setDoAssignments((current) => [...current.filter((item) => item.doLineId !== line.id), {
      ...assignment,
      createdBy: user.uid,
      updatedBy: user.uid,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }]);
    onQueueWrite(upsertJazzLoadDoAssignment(assignment, user, role), "Could not queue DO assignment.");
    pushPopup("success", `Assigned ${name.name} to line ${line.line} for ${selectedDate}.`);
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
        reopenedUntilAt: selectedDayRecord?.reopenedUntilAt
      }),
    [dayNotes, drafts, liftingOpening, mlLifting, monthId, selectedDay, selectedDayRecord?.reopenedUntilAt, selectedDayRecord?.status]
  );

  useEffect(() => {
    if (!canEditDaily || selectedDayFuture || !validation.valid || drafts.length === 0 || !activeRates.mlRate || !activeRates.commission1Rate || !activeRates.commission2Rate || !autoSaveEnabled) return;
    const timer = window.setTimeout(() => {
      if (autosaveSignature === lastSavedRef.current || saveInFlightRef.current) return;
      saveInFlightRef.current = true;
      setAutoSaveState("saving");
      void saveDay("open", { silent: true })
        .then(() => {
          lastSavedRef.current = autosaveSignature;
          setAutoSaveState("saved");
        })
        .catch(() => setAutoSaveState("error"))
        .finally(() => {
          saveInFlightRef.current = false;
        });
    }, 900);
    return () => window.clearTimeout(timer);
  }, [activeRates.commission1Rate, activeRates.commission2Rate, activeRates.mlRate, autosaveSignature, canEditDaily, drafts.length, selectedDayFuture, validation.valid, autoSaveEnabled]);

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
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-300">Separate Module</p>
          <h2 className="mt-1 text-2xl font-semibold text-white">Jazz Load Ledger</h2>
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
            { id: "settings", label: "Settings", icon: Settings, show: canManageSettings },
            { id: "backup", label: "Backup", icon: FileDown, show: canBackup }
          ] as Array<{ id: JazzLoadSection; label: string; icon: typeof BarChart3; show: boolean }>
        ).map(({ id, label, icon: Icon, show }) =>
          show ? (
            <button key={id} className={section === id ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => setSection(id)}>
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
              rows={localSummary.doBalances.slice(0, 8).map((row) => [row.doName, row.doLine ?? "-", formatCurrency(row.closingBase), String(row.activeDays)])}
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
            <div className="panel-title">
              <div>
                <h3>Daily DO Entry</h3>
                <p>Open a date from the calendar. Future days are disabled and do not create records.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex flex-row items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={autoSaveEnabled}
                    disabled={!canEditDaily}
                    onChange={(event) => toggleAutoSave(event.target.checked)}
                    className="h-4 w-4 accent-emerald-400 cursor-pointer rounded border-slate-700 bg-slate-950/70"
                  />
                  <span>Auto-Save</span>
                </label>
                <span className="btn-chip">
                  {autoSaveEnabled ? (
                    autoSaveState === "saving" ? "Autosaving..." : autoSaveState === "error" ? "Autosave failed" : "Autosave on"
                  ) : (
                    "Autosave off"
                  )}
                </span>
                <button className="btn-secondary" disabled={!canEditDaily || !validation.valid || loading} onClick={() => window.confirm(`Close Jazz Load day ${selectedDay}?`) && void saveDay("closed")}>
                  Close Day
                </button>
                <button className="btn-primary" disabled={!canEditDaily || !validation.valid || loading} onClick={() => void saveDay("open")}>
                  Save Now
                </button>
              </div>
            </div>
            <JazzLoadCalendar
              monthId={monthId}
              selectedDay={selectedDay}
              days={days}
              now={now}
              onSelect={setSelectedDay}
            />
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button className="btn-secondary w-full sm:w-auto" disabled={!selectedDayRecord} onClick={() => selectedDayRecord && exportJazzLoadXlsx(calculateMonthlySummary(monthId, [selectedDayRecord]), [selectedDayRecord])}>
                <FileSpreadsheet />
                Export Daily Excel
              </button>
              <button className="btn-secondary w-full sm:w-auto" disabled={!selectedDayRecord} onClick={() => selectedDayRecord && exportJazzLoadPrintable(calculateMonthlySummary(monthId, [selectedDayRecord]))}>
                <FileDown />
                Export Daily PDF
              </button>
              {roleCanJazzLoad(role, "daily") && (
                <button
                  className="btn-secondary w-full sm:w-auto"
                  disabled={loading || recalculating || days.length === 0 || currentMonth?.status === "closed"}
                  onClick={() => void masterRefreshCalculations()}
                  title="Refresh Jazz Load calculations so openings follow previous closings"
                >
                  {recalculating ? "Refreshing..." : "Master Refresh Calculations"}
                </button>
              )}
              {role === "owner" && (
                <>
                  <button
                    className="btn-secondary w-full sm:w-auto"
                    disabled={loading || bulkReopening !== null || selectedDayFuture || currentMonth?.status === "closed"}
                    onClick={() => reopenMonthDays("selected")}
                  >
                    {bulkReopening === "selected" ? "Reopening..." : "Reopen Selected Day"}
                  </button>
                  <button
                    className="btn-secondary w-full sm:w-auto"
                    disabled={loading || bulkReopening !== null || currentMonth?.status === "closed" || availableJazzLoadDayNumbers(monthId, now).length <= 1}
                    onClick={() => reopenMonthDays("all")}
                  >
                    {bulkReopening === "all" ? "Reopening..." : "Reopen All Days"}
                  </button>
                  <button
                    className="btn-secondary w-full sm:w-auto"
                    disabled={loading || bulkClosingDays || currentMonth?.status === "closed" || availableJazzLoadDayNumbers(monthId, now).length <= 1}
                    onClick={closeAllDaysExceptToday}
                  >
                    {bulkClosingDays ? "Closing..." : "Close All"}
                  </button>
                </>
              )}
            </div>
            <div className="mb-4 flex flex-wrap gap-2 text-sm text-slate-300">
              <span className="btn-chip"><CalendarDays /> {selectedDate}</span>
              <span className="btn-chip">Status: {selectedDayFuture ? "future disabled" : selectedDayRecord?.status ?? "new"}</span>
              {selectedDayCorrectionActive && <span className="btn-chip">Correction until {new Date(getMillis(selectedDayRecord?.reopenedUntilAt)).toLocaleTimeString()}</span>}
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
            <div className="table-wrap">
              <table className="min-w-[1180px]">
                <thead>
                  <tr>
                    <th>DO</th>
                    <th>Line</th>
                    <th>Opening Base</th>
                    <th>Opening Jazz Load</th>
                    <th>Issuance Base</th>
                    <th>Issuance Jazz Load</th>
                    <th>Day Total Base</th>
                    <th>Payment Base</th>
                    <th>Payment Jazz Load</th>
                    <th>Closing Base</th>
                    <th>Closing Jazz Load</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft, index) => {
                    const preview = previewEntries[index];
                    const editingDoName = !draft.doNameId || editingDoNameRows.has(draft.id);
                    return (
                      <tr key={draft.id}>
                        <td>
                          {editingDoName ? (
                            <>
                              <select
                                value={draft.doNameId ?? ""}
                                disabled={!canEditDaily}
                                onChange={(event) => {
                                  const name = doNames.find((item) => item.id === event.target.value);
                                  if (draft.doLineId && name) assignNameToLine(draft.doLineId, name.id);
                                  setDraft(index, {
                                    doNameId: name?.id,
                                    doName: name?.name ?? draft.doName
                                  });
                                  if (name) setDoNameEditing(draft.id, false);
                                }}
                              >
                                <option value="">Select DO Name</option>
                                {doNames.filter((name) => name.active).map((name) => (
                                  <option key={name.id} value={name.id}>{name.name}</option>
                                ))}
                              </select>
                              {!draft.doNameId && draft.doName && (
                                <p className="mt-2 text-xs text-slate-400">Saved name: {draft.doName}</p>
                              )}
                            </>
                          ) : (
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-white">{draft.doName}</span>
                              <button
                                type="button"
                                className="btn-icon"
                                disabled={!canEditDaily}
                                title="Edit DO name"
                                onClick={() => setDoNameEditing(draft.id, true)}
                              >
                                <Pencil />
                              </button>
                            </div>
                          )}
                        </td>
                        <td>
                          <p className="font-semibold text-white">{draft.doLine || "-"}</p>
                          <p className="text-xs text-slate-500">Fixed line row</p>
                        </td>
                        <td>
                          <NumberInput
                            value={selectedDay === 1 ? draft.openingBase ?? 0 : preview?.openingBalance.baseAmount ?? 0}
                            disabled={!canEditDaily || selectedDay !== 1}
                            onChange={(value) => setDraft(index, { openingBase: value })}
                          />
                        </td>
                        <td>{formatCurrency(preview?.openingBalance.calculatedAmount ?? 0)}</td>
                        <td><NumberInput value={draft.todayMlIssuanceBase} disabled={!canEditDaily} onChange={(value) => setDraft(index, { todayMlIssuanceBase: value })} /></td>
                        <td>{formatCurrency(preview?.todayMlIssuance.calculatedAmount ?? 0)}</td>
                        <td>{formatCurrency(preview?.dayTotal.baseAmount ?? 0)}</td>
                        <td><NumberInput value={draft.paymentReceivedBase} disabled={!canEditDaily} onChange={(value) => setDraft(index, { paymentReceivedBase: value })} /></td>
                        <td>{formatCurrency(preview?.paymentReceived.calculatedAmount ?? 0)}</td>
                        <td>{formatCurrency(preview?.closingBalance.baseAmount ?? 0)}</td>
                        <td>{formatCurrency(preview?.closingBalance.calculatedAmount ?? 0)}</td>
                      </tr>
                    );
                  })}
                  {drafts.length === 0 && (
                    <tr><td colSpan={11}>No DO lines configured. Add DO Lines in Settings.</td></tr>
                  )}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-700 font-semibold text-white">
                    <td className="uppercase tracking-[0.12em] text-slate-300">Daily Totals</td>
                    <td className="text-slate-500">-</td>
                    <td>{formatCurrency(previewSummary.openingBase)}</td>
                    <td>{formatCurrency(previewSummary.openingMl)}</td>
                    <td>{formatCurrency(previewSummary.issuanceBase)}</td>
                    <td>{formatCurrency(previewSummary.issuanceMl)}</td>
                    <td>{formatCurrency(previewSummary.dayTotalBase ?? 0)}</td>
                    <td>{formatCurrency(previewSummary.paymentBase)}</td>
                    <td>{formatCurrency(previewSummary.paymentMl)}</td>
                    <td>{formatCurrency(previewSummary.closingBase)}</td>
                    <td>{formatCurrency(previewSummary.closingMl)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h3>Daily Lifting</h3>
                  <p>Today Jazz Load issuance is derived from DO rows.</p>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-">
                <label>Opening Balance<NumberInput value={liftingOpening} disabled={true} onChange={setLiftingOpening} /></label>
                <label>Jazz Load Lifting<NumberInput value={mlLifting} disabled={!canEditDaily} onChange={setMlLifting} /></label>
                <label>Total Balance<input value={formatCurrency(previewLifting.totalBalance)} disabled readOnly /></label>
                <label>Today Jazz Load Issuance<input value={formatCurrency(previewLifting.todayMlIssuance)} disabled readOnly /></label>
                <label>In-Hand Balance<input value={formatCurrency(previewLifting.inHandBalance)} disabled readOnly /></label>
              </div>
            </section>
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h3>Daily Summary</h3>
                  <p>All totals are generated from saved DO rows.</p>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
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
              <label className="mt-4">Notes<input value={dayNotes} disabled={!canEditDaily} onChange={(event) => setDayNotes(event.target.value)} /></label>
            </section>
          </div>
        </div>
      )}

      {section === "reports" && (
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn-primary" disabled={localSummary.dayRows.length === 0} onClick={() => exportJazzLoadXlsx(localSummary, days)}><FileSpreadsheet /> Export Excel</button>
            <button className="btn-secondary" disabled={localSummary.dayRows.length === 0} onClick={() => exportJazzLoadPrintable(localSummary)}><FileDown /> Export PDF/Print</button>
          </div>
          <ReportTable title="DO Balance Report" headers={["DO", "Line", "Opening", "Issuance", "Payments", "Closing Jazz Load"]} rows={localSummary.doBalances.map((row) => [row.doName, row.doLine ?? "-", formatCurrency(row.openingBase), formatCurrency(row.issuanceBase), formatCurrency(row.paymentBase), formatCurrency(row.closingMl)])} />
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
              <button className="btn-primary" disabled={!canManageSettings || !rateName.trim()} onClick={saveRate}>Save Rate</button>
            </div>
            <SettingsRows
              rows={rates.map((rate) => ({
                id: rate.id,
                label: `${rate.active ? "Active" : "Inactive"} · ${rate.name} · ${formatPercentage(rate.percentage)} · ${rate.type}`,
                active: rate.active,
                onToggle: () => toggleRate(rate)
              }))}
              canEdit={canManageSettings}
            />
          </section>
          <section className="panel">
            <div className="panel-title"><div><h3>DO Names</h3><p>Names are managed independently from fixed lines.</p></div></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label>DO Name<input value={doNameDraft} disabled={!canManageSettings} onChange={(event) => setDoNameDraft(event.target.value)} /></label>
              <button className="btn-primary" disabled={!canManageSettings || !doNameDraft.trim()} onClick={saveDoName}>Save Name</button>
            </div>
            <div className="mt-4 space-y-2">
              {doNames.map((name) => (
                <div key={name.id} className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-white">{name.name}</p>
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
              {doNames.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
            </div>
          </section>
          <section className="panel">
            <div className="panel-title"><div><h3>DO Lines</h3><p>Lines stay fixed and can be assigned to different names per date.</p></div></div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label>DO Line<input value={doLineDraft} disabled={!canManageSettings} onChange={(event) => setDoLineDraft(event.target.value)} /></label>
              <button className="btn-primary" disabled={!canManageSettings || !doLineDraft.trim()} onClick={saveDoLine}>Save Line</button>
            </div>
            <div className="mt-4 space-y-2">
              {orderedDoLines.map((line, index) => (
                <div key={line.id} className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-white">{line.line}</p>
                      <p className="text-xs text-slate-500">Order {index} · {line.active ? "active" : "inactive"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-2 text-xs uppercase tracking-[0.12em] text-slate-500">
                      Index
                      <input
                        key={`${line.id}-${index}`}
                        type="number"
                        min={0}
                        step={1}
                        className="w-20"
                        disabled={!canManageSettings}
                        defaultValue={index}
                        onBlur={(event) => {
                          const next = Number(event.target.value);
                          if (!Number.isFinite(next)) return;
                          setDoLineOrder(line.id, next);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          const next = Number((event.target as HTMLInputElement).value);
                          if (!Number.isFinite(next)) return;
                          setDoLineOrder(line.id, next);
                        }}
                      />
                    </label>
                    <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canManageSettings} onClick={() => editDoLine(line)} title="Edit DO line">
                      <Pencil />
                    </button>
                    <button className="btn-secondary !h-9 !w-9 !px-0" disabled={!canManageSettings} onClick={() => removeDoLine(line)} title="Delete DO line">
                      <Trash2 />
                    </button>
                  </div>
                </div>
              ))}
              {orderedDoLines.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
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

      {section === "settings" && (
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
        <section className="panel">
          <div className="panel-title">
            <div>
              <h3>Jazz Load Backup / Export</h3>
              <p>Backup stores Jazz Load in its own JSON group, separate from normal expenses.</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <button className="btn-secondary" disabled={!canBackup || loading} onClick={onExportBackup}><FileDown /> Export Full Backup</button>
            <label className={`file-button ${!canBackup || loading ? "pointer-events-none opacity-50" : ""}`}>
              Import Full Backup
              <input type="file" accept=".json" disabled={!canBackup || loading} onChange={(event) => onImportBackup(event.target.files?.[0] ?? null)} />
            </label>
          </div>
        </section>
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

function JazzLoadCalendar({
  monthId,
  selectedDay,
  days,
  now,
  onSelect
}: {
  monthId: string;
  selectedDay: number;
  days: JazzLoadDay[];
  now: Date;
  onSelect: (dayNo: number) => void;
}) {
  const savedByDay = new Map(days.map((day) => [day.dayNo, day]));
  return (
    <div className="mb-4 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-2 grid grid-cols-7 gap-2 text-center text-[11px] font-semibold uppercase text-slate-500">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {Array.from({ length: daysInMonth(monthId) }, (_, index) => {
          const dayNo = index + 1;
          const saved = savedByDay.get(dayNo);
          const disabled = isFutureJazzDay(monthId, dayNo, now);
          const selected = dayNo === selectedDay;
          const correctionActive = Boolean(saved?.reopenedUntilAt && getMillis(saved.reopenedUntilAt) > now.getTime());
          const isOpen = !disabled && (saved?.status !== "closed" || correctionActive);
          const stateLabel = disabled ? "Future" : correctionActive ? "Re-open" : isOpen ? "Open" : "Closed";
          const stateClass = disabled
            ? "bg-slate-800 text-slate-500"
            : correctionActive
              ? "bg-blue-400/15 text-blue-200"
              : isOpen
              ? "bg-emerald-400/15 text-emerald-200"
              : "bg-rose-400/15 text-rose-200";
          return (
            <button
              key={dayNo}
              className={[
                "min-h-16 flex-col rounded-lg border px-2 py-2 text-xs",
                selected ? "border-emerald-400 bg-emerald-400/10 text-emerald-100" : "border-slate-800 bg-slate-900/70 text-slate-200",
                disabled ? "opacity-40" : ""
              ].join(" ")}
              disabled={disabled}
              onClick={() => onSelect(dayNo)}
              title={disabled ? "Future day disabled" : `Day ${dayNo} - ${stateLabel}`}
            >
              <span className="text-sm font-semibold">{dayNo}</span>
              <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${stateClass}`}>{stateLabel}</span>
              {selected && <span className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">Selected</span>}
            </button>
          );
        })}
      </div>
    </div>
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
  canEdit
}: {
  rows: Array<{ id: string; label: string; active: boolean; onToggle: () => void }>;
  canEdit: boolean;
}) {
  return (
    <div className="mt-4 space-y-2">
      {rows.map((row) => (
        <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between" key={row.id}>
          <span>{row.label}</span>
          <button className="btn-secondary !h-9" disabled={!canEdit} onClick={row.onToggle}>
            {row.active ? "Deactivate" : "Activate"}
          </button>
        </div>
      ))}
      {rows.length === 0 && <p className="text-sm text-slate-500">No rows configured.</p>}
    </div>
  );
}
