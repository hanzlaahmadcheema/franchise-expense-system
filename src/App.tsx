import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import { signOut } from "firebase/auth";
import { localAuthService, type LocalUser } from "./services/api/localAuthService";
import type { LedgerUser } from "./types/ledger";

export interface AppUser {
  id: string;
  uid: string;
  username: string;
  email?: string | null;
  displayName?: string | null;
  role: UserRole;
}
import {
  Cloud,
  FileDown,
  FileSpreadsheet,
  LayoutDashboard,
  PackageOpen,
  ScrollText,
  LoaderCircle,
  Menu,
  MonitorCog,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Bell,
  CalendarDays,
  CreditCard,
  Shield,
  Sun,
  Tags,
  Upload,
  Users,
  X,
  GripVertical,
  AlertTriangle
} from "lucide-react";
import { AuditLogsView } from "./components/AuditLogsView";
import { DailyEntryForm } from "./components/DailyEntryForm";
import { HomeDashboard } from "./components/HomeDashboard";
import type {
  AuthorizedEmail,
  CatalogItem,
  DailyLedgerInput,
  ExpenseCarryForwardCreditBalance,
  ExpenseCarryForwardSeed,
  MonthComputed,
  MonthRecord,
  NotificationSettings,
  UserProfile,
  UserRole,
  WorkbookImportPreview
} from "./types/ledger";
import type { JazzLoadMonth } from "./modules/jazzLoad/types/jazzLoad.types";
import { computeMonth, resolveCreditClosingBalance } from "./lib/formulaEngine";
import { resolveCreditDescriptions } from "./lib/creditDescriptions";
import {
  exportDailyPdf,
  exportDailyXlsx,
  exportBackupPackage,
  exportMonthlyPdf,
  exportMonthlyXlsx,
  readBackupPackage
} from "./lib/exporters";
import { parseWorkbookFile } from "./lib/workbookImport";
import { auth, isFirebaseConfigured } from "./lib/firebase";
import { nextSyncState, syncStatusLabel, type SyncState } from "./lib/syncStatus";
import { JazzLoadModule } from "./modules/jazzLoad/components/JazzLoadModule";
import { StockLedgerModule } from "./modules/stock/components/StockLedgerModule";
import { UniversalCalendar } from "./shared/calendar/UniversalCalendar";
import { SidebarDayControlsProvider, SidebarDayControlsSlot } from "./shared/context/SidebarDayControlsContext";
import { SelectedDateProvider } from "./shared/context/SelectedDateContext";
import { MasterCalculationRefreshModal } from "./shared/dayControls/MasterCalculationRefreshModal";
import { UniversalDayControlBar } from "./shared/dayControls/UniversalDayControlBar";
import { canEditOperationalDailyEntry, canReopenOperationalDay, isActiveReopenWindow, isAdminEditableReopenedDay, isOperationalDayClosed } from "./shared/services/dayEditPermissions";
import { resolveUniversalDayStatus } from "./shared/services/dayStatusService";
import { runMasterRecalculation } from "./shared/services/masterRecalculationService";
import { MASTER_REFRESH_ACCESS } from "./shared/services/masterRefreshPermissions";
import type { MasterRecalculationAdapter, MasterRefreshModalState, UniversalDaySnapshot } from "./shared/types/dayControl.types";
import { defaultLedgerReadModeConfig, type LedgerReadModeConfig } from "./shared/ledger/ledgerTypes";
import { resolveLedgerUiReadDecision } from "./shared/ledger/ledgerReadMode";
import { closeOperationalDayUnified, reopenOperationalDayUnified, subscribeDayStatus } from "./services/api/dayLifecycleService";
import {
  isPostgreSqlPeriod,
  getAccountingPeriodWithDays,
  resolvePeriodRouting,
  isPeriodKnownInitialized,
  isGenesisPeriod,
  POSTGRESQL_GENESIS_PERIOD,
  getNextPeriodKey,
  clearPeriodCache,
  registerPostgreSqlPeriod,
  registerInitializedPeriod,
  type PeriodRoutingStatus
} from "./services/api/periodDayService";
import { ledgerApiClient, setAuthTokenProvider } from "./services/api/ledgerApiClient";
import { saveExpenseDayPostgres, loadExpenseDayPostgres } from "./services/api/expenseTransactionService";
import { createExpenseRecalculationAdapter } from "./modules/expense/adapters/expenseRecalculationAdapter";
import { GuidedMonthCloseModal } from "./components/GuidedMonthCloseModal";
import {
  listJazzLoadBackup,
  restoreJazzLoadBackup,
  roleCanJazzLoad,
  setJazzLoadMonthStatus
} from "./modules/jazzLoad/services/jazzLoadFirestore";
import {
  commitWorkbookImport,
  addRoleChangeAudit,
  closeMonthDaysExceptToday,
  deleteAuthorizedEmail,
  deleteCatalogItem,
  deleteUserProfile,
  emailKey,
  ensureDefaultCatalogs,
  fetchMonthDays,
  getUserRole,
  listMonths,
  reopenMonthDaysUntilClose,
  reopenPreviousDayUntilClose,
  recalculateMonth,
  roleCan,
  queueDayAndSummaryWrite,
  reopenCurrentDayUntilClose,
  saveNotificationSettings,
  sendManualActivityEmail,
  setAuditActorRole,
  setMonthStatus,
  writeExpenseBackupRestoreAudit,
  subscribeAuthorizedEmails,
  subscribeCatalogItems,
  subscribeLedgerMismatchReports,
  subscribeLedgerReadModeConfig,
  subscribeNotificationSettings,
  subscribeUsers,
  upsertAuthorizedEmail,
  updateUserProfile,
  updateCatalogSortOrder,
  upsertCatalogItem,
  resolveExpenseCarryForwardSeed,
  saveMonthRecord
} from "./lib/firestoreService";
import { applySortOrder, changedSortOrderPatches, reorderItems } from "./shared/services/orderUtils";

type View = "dashboard" | "records" | "expense" | "jazz-load" | "stock-ledger" | "users" | "import" | "backup" | "audit-logs";
type ExpenseSection = "daily-entry" | "previous-records" | "expense-dashboard" | "expense-categories" | "credit-parties" | "commission-categories";

const ownerOnlyViews = new Set<View>(["users", "import", "backup", "audit-logs"]);
const ownerOnlyExpenseSections = new Set<ExpenseSection>(["expense-categories", "credit-parties", "commission-categories"]);

function canAccessView(role: UserRole | null, view: View) {
  if (!role) return false;
  return role === "owner" || !ownerOnlyViews.has(view);
}

type BackupPackage = {
  exportedAt: number;
  months: Array<MonthRecord & { days: DailyLedgerInput[] }>;
  jazzLoad?: Awaited<ReturnType<typeof listJazzLoadBackup>>;
};

const LOGIN_DISABLED = true;
const SHOW_LEDGER_V2_SHADOW_WARNING = false;

function emptyDay(dayNo: number): DailyLedgerInput {
  return {
    dayNo,
    label: dayNo === 32 ? "FINAL" : `Day ${dayNo}`,
    status: dayNo === 32 ? "closed" : "open",
    manualOverride: false,
    expenses: [],
    commissions: [],
    credits: [],
    ownerBalances: []
  };
}

function previousMonthIdForPrefetch(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return monthId;
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function creditSeedKey(row: { partyId?: string; partyName: string }) {
  return row.partyId ? `id:${row.partyId}` : `name:${row.partyName.trim().toLowerCase()}`;
}

function previousDayFromExpenseSeed(seed: ExpenseCarryForwardSeed | null): DailyLedgerInput | undefined {
  if (!seed || seed.creditBalances.length === 0) return undefined;
  const sourceLabel = seed.isGenesis ? "Genesis Opening" : `${seed.sourceMonthId} final`;
  const dayNo = seed.sourceDayNo || 1;
  return {
    ...emptyDay(dayNo),
    label: sourceLabel,
    credits: seed.creditBalances.map((row) => ({
      id: `${seed.sourceMonthId || "genesis"}-${dayNo}-${creditSeedKey(row).replace(/[^a-z0-9-]+/gi, "-")}`,
      partyId: row.partyId,
      partyName: row.partyName,
      opening: row.balance,
      loan: 0,
      today: 0,
      receive: 0,
      balance: row.balance
    }))
  };
}

export type ExpenseCarryForwardValidationOptions = {
  day1LoadError?: string | null;
};

export function expenseCarryForwardWarnings(
  month: MonthRecord | undefined,
  days: DailyLedgerInput[],
  seed: ExpenseCarryForwardSeed | null,
  options?: ExpenseCarryForwardValidationOptions
) {
  if (!month || !seed) return [];
  if (isGenesisPeriod(month.id) || seed.isGenesis || !seed.sourceMonthId || seed.sourceMonthId === "genesis") {
    return [];
  }
  const warnings: string[] = [];
  if (month.openingBalance !== seed.openingBalance) {
    warnings.push(`cash opening ${month.openingBalance.toLocaleString()} should equal ${seed.sourceMonthId} closing ${seed.openingBalance.toLocaleString()}`);
  }
  if ((month.ownerOpeningBalance ?? 0) !== seed.ownerOpeningBalance) {
    warnings.push(`owner opening ${(month.ownerOpeningBalance ?? 0).toLocaleString()} should equal ${seed.sourceMonthId} owner closing ${seed.ownerOpeningBalance.toLocaleString()}`);
  }
  const day1 = days.find((day) => day.dayNo === 1);
  if (!day1) return warnings;

  const loadError = options?.day1LoadError || day1.loadError;
  if (loadError) {
    warnings.push(`Day 1 opening carry-forward verification unavailable: ${loadError}`);
    return warnings;
  }

  if (!isServerLoadedDay(day1)) {
    return warnings;
  }

  const expectedCredits = new Map(seed.creditBalances.map((row) => [creditSeedKey(row), row]));
  for (const row of day1.credits) {
    const expected = expectedCredits.get(creditSeedKey(row));
    if (!expected) continue;
    const actual = Number(row.opening ?? 0);
    if (actual !== expected.balance) {
      warnings.push(`${row.partyName} credit opening ${actual.toLocaleString()} should equal ${seed.sourceMonthId} closing ${expected.balance.toLocaleString()}`);
    }
  }
  const existingCreditKeys = new Set(day1.credits.map(creditSeedKey));
  for (const row of seed.creditBalances) {
    if (row.balance !== 0 && !existingCreditKeys.has(creditSeedKey(row))) {
      warnings.push(`${row.partyName} credit opening is missing; expected ${row.balance.toLocaleString()} from ${seed.sourceMonthId}`);
    }
  }
  const firstOwner = day1.ownerBalances.find((row) => (row.amount ?? 0) !== 0 || (row.expense ?? 0) !== 0 || (row.received ?? 0) !== 0);
  if (firstOwner && (firstOwner.opening ?? seed.ownerOpeningBalance) !== seed.ownerOpeningBalance) {
    warnings.push(`Day 1 owner opening ${(firstOwner.opening ?? 0).toLocaleString()} should equal ${seed.sourceMonthId} owner closing ${seed.ownerOpeningBalance.toLocaleString()}`);
  }
  return warnings;
}

type SaveDayOptions = {
  silent?: boolean;
  awaitRemote?: boolean;
};

type LoadMonthOptions = {
  skipPendingCheck?: boolean;
  targetDay?: number;
};

type UiMode = "modern" | "classic";

const CONNECTED_STATUS = "Connected to Firestore";
const FIRESTORE_ERROR_STATUS = "Firestore permission/error";

function createMonth(id: string, openingBalance: number, ownerOpeningBalance: number): MonthRecord {
  const timestamp = Date.now();
  return {
    id,
    label: id,
    openingBalance,
    ownerOpeningBalance,
    status: "open",
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function currentDateState(date = new Date()) {
  return {
    monthId: `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`,
    dayNo: date.getDate()
  };
}

function isLiveDay(monthId: string, dayNo: number, now: Date) {
  if (dayNo === 32) return false;
  const liveDate = currentDateState(now);
  return monthId === liveDate.monthId && dayNo === liveDate.dayNo;
}

function isReopenActive(day: DailyLedgerInput | undefined, now: Date) {
  return isActiveReopenWindow(day, now.getTime());
}

function LoadingIcon({ label = "Loading" }: { label?: string }) {
  return <LoaderCircle className="animate-spin" aria-label={label} />;
}

function LoadingPopup({ message }: { message: string }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4 text-slate-100 backdrop-blur-sm" role="status" aria-live="polite">
      <div className="w-full max-w-sm rounded-xl border border-emerald-400/30 bg-slate-900 p-6 text-center shadow-2xl shadow-black/40">
        <div className="relative mx-auto flex h-16 w-16 items-center justify-center">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/30" />
          <LoaderCircle className="relative h-11 w-11 animate-spin text-emerald-300" aria-hidden="true" />
        </div>
        <h2 className="mt-5 text-lg font-semibold text-white">Processing</h2>
        <p className="mt-2 text-sm text-slate-300">{message}</p>
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div className="loading-bar h-full rounded-full bg-emerald-400" />
        </div>
      </div>
    </div>
  );
}

function TopActivityProgress({ active, label }: { active: boolean; label: string }) {
  if (!active) return null;
  return (
    <div
      className="fixed left-0 right-0 top-0 z-[80] h-1 overflow-hidden bg-slate-950/30 backdrop-blur-[1px]"
      role="progressbar"
      aria-label={label || "Loading"}
    >
      <div className="loading-bar h-full rounded-full bg-emerald-400 shadow-[0_0_16px_rgba(52,211,153,0.65)]" />
    </div>
  );
}

function formatMonth(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, 1);
  if (Number.isNaN(date.getTime())) return monthId;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
}

function dateParts(monthId: string, dayNo: number) {
  if (dayNo === 32) return {};
  const [yearText, monthText] = monthId.split("-");
  return {
    entryYear: Number(yearText),
    entryMonth: Number(monthText),
    entryDay: dayNo
  };
}

function dateLabelFor(monthId: string, dayNo: number) {
  if (dayNo === 32) return `FINAL - ${formatMonth(monthId)}`;
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, dayNo);
  if (Number.isNaN(date.getTime())) return `Day ${dayNo}`;
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function dayWithMonthDate(monthId: string, dayNo: number, day?: DailyLedgerInput): DailyLedgerInput {
  const parts = dateParts(monthId, dayNo);
  return {
    ...emptyDay(dayNo),
    ...day,
    dayNo,
    label: day?.label ?? (dayNo === 32 ? "FINAL" : `Day ${dayNo}`),
    date: day?.date ?? dateLabelFor(monthId, dayNo),
      entryYear: day?.entryYear ?? parts.entryYear,
      entryMonth: day?.entryMonth ?? parts.entryMonth,
    entryDay: day?.entryDay ?? parts.entryDay,
    status: day?.status ?? "open",
    manualOverride: day?.manualOverride ?? false
  };
}

function daysInMonth(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return 31;
  return new Date(year, month, 0).getDate();
}

function compareMonthIds(left: string, right: string) {
  return left.localeCompare(right);
}

function replaceDay(days: DailyLedgerInput[], day: DailyLedgerInput) {
  const withoutDay = days.filter((entry) => entry.dayNo !== day.dayNo);
  return [...withoutDay, day].sort((a, b) => a.dayNo - b.dayNo);
}

export function isServerLoadedDay(day?: DailyLedgerInput | null): boolean {
  if (!day || day.loadError) return false;
  if (day.openingCash !== undefined || day.ownerOpeningBalance !== undefined) return true;
  if (day.updatedAt !== undefined && day.updatedAt > 0) return true;
  if (
    (day.expenses && day.expenses.length > 0) ||
    (day.commissions && day.commissions.length > 0) ||
    (day.credits && day.credits.length > 0) ||
    (day.ownerBalances && day.ownerBalances.length > 0) ||
    Boolean(day.notes)
  ) {
    return true;
  }
  return false;
}

function availableDayNumbers(monthId: string, now: Date) {
  const liveDate = currentDateState(now);
  if (compareMonthIds(monthId, liveDate.monthId) > 0) return [];
  const maxDay = monthId === liveDate.monthId ? liveDate.dayNo : daysInMonth(monthId);
  return Array.from({ length: maxDay }, (_, index) => index + 1);
}

function canUseFinalPeriod(monthId: string, now: Date) {
  if (isPostgreSqlPeriod(monthId)) return true;
  return compareMonthIds(monthId, currentDateState(now).monthId) < 0;
}

function clampSelectedDay(dayNo: number, monthId: string, now: Date) {
  const availableDays = availableDayNumbers(monthId, now);
  if (dayNo === 32) return canUseFinalPeriod(monthId, now) ? 32 : (availableDays.at(-1) ?? 1);
  if (availableDays.length === 0) return 1;
  if (availableDays.includes(dayNo)) return dayNo;
  return Math.min(dayNo, availableDays.at(-1) ?? 1);
}

const LAST_CALENDAR_SELECTION_KEY_PREFIX = "ledger:lastCalendarSelection:v1:";
const LAST_ACTIVE_MODULE_KEY_PREFIX = "ledger:lastActiveModule:v1:";
const persistedModuleToView: Record<string, View> = {
  expense: "expense",
  jazzLoad: "jazz-load",
  stock: "stock-ledger"
};
const viewToPersistedModule: Partial<Record<View, string>> = {
  expense: "expense",
  "jazz-load": "jazzLoad",
  "stock-ledger": "stock"
};

function calendarSelectionKey(uid: string) {
  return `${LAST_CALENDAR_SELECTION_KEY_PREFIX}${uid}`;
}

function activeModuleKey(uid: string) {
  return `${LAST_ACTIVE_MODULE_KEY_PREFIX}${uid}`;
}

function isValidMonthId(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) return false;
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return Number.isInteger(year) && Number.isInteger(month) && month >= 1 && month <= 12;
}

function purgeLegacyAccountingCaches() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key.startsWith("calendar_selection_") || key.startsWith(LAST_CALENDAR_SELECTION_KEY_PREFIX)) {
        try {
          const val = JSON.parse(localStorage.getItem(key) || "{}");
          if (!val?.monthId || val.monthId < "2026-08") {
            localStorage.removeItem(key);
          }
        } catch {
          localStorage.removeItem(key);
        }
      }
    }
  } catch {
    // Non-blocking
  }
}
purgeLegacyAccountingCaches();

function readStoredCalendarSelection(uid: string, now = new Date()) {
  try {
    const raw = localStorage.getItem(calendarSelectionKey(uid));
    if (!raw) return { monthId: "2026-08", dayNo: 1 };
    const parsed = JSON.parse(raw) as { monthId?: unknown; day?: unknown };
    if (!isValidMonthId(parsed.monthId) || parsed.monthId < "2026-08") {
      localStorage.removeItem(calendarSelectionKey(uid));
      return { monthId: "2026-08", dayNo: 1 };
    }
    // Default must be deterministic: 2026-08, Day 1
    // unless the user has an explicitly stored valid initialized PostgreSQL period selection.
    const targetMonth = isPeriodKnownInitialized(parsed.monthId) ? parsed.monthId : "2026-08";
    const parsedDay = typeof parsed.day === "number" && Number.isFinite(parsed.day) ? Math.trunc(parsed.day) : 1;
    return {
      monthId: targetMonth,
      dayNo: targetMonth === "2026-08" && targetMonth !== parsed.monthId ? 1 : clampSelectedDay(parsedDay, targetMonth, now)
    };
  } catch {
    return { monthId: "2026-08", dayNo: 1 };
  }
}

function readStoredView(uid: string): View {
  const stored = localStorage.getItem(activeModuleKey(uid));
  return stored ? persistedModuleToView[stored] ?? "dashboard" : "dashboard";
}

function liveClockText(now: Date) {
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true
  }).format(now);
}

function roleLabel(role: UserRole | null) {
  if (role === "owner") return "Owner";
  if (role === "admin") return "Admin";
  if (role === "viewer") return "Viewer";
  return "Connecting";
}

function userDisplayName(user: { uid: string; email?: string | null; displayName?: string | null; username?: string } | null) {
  if (!user) return "No user";
  if (user.username) return user.username;
  if (user.displayName) return user.displayName;
  if (user.email) return user.email.split("@")[0].replace(/[._-]+/g, " ");
  return "Anonymous User";
}

function userSimpleId(user: { uid: string } | null) {
  if (!user) return "0000";
  const total = Array.from(user.uid).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return String(total % 10000).padStart(4, "0");
}

function CatalogItemEditor({
  item,
  canEdit,
  onSave,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop
}: {
  item: CatalogItem;
  canEdit: boolean;
  onSave: (item: CatalogItem) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onDragStart: (id: string) => void;
  onDragOver: (event: DragEvent<HTMLTableRowElement>) => void;
  onDrop: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    name: item.name,
    active: item.active,
    sortOrder: item.sortOrder
  });
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const lastSavedRef = useRef(JSON.stringify({ name: item.name, active: item.active, sortOrder: item.sortOrder }));

  useEffect(() => {
    const nextDraft = { name: item.name, active: item.active, sortOrder: item.sortOrder };
    setDraft(nextDraft);
    lastSavedRef.current = JSON.stringify(nextDraft);
    setSaveState("saved");
  }, [item.active, item.id, item.name, item.sortOrder]);

  useEffect(() => {
    if (!canEdit) return;
    const cleanName = draft.name.trim();
    const nextItem = {
      ...item,
      name: cleanName || item.name,
      active: draft.active,
      sortOrder: Number.isFinite(draft.sortOrder) ? draft.sortOrder : item.sortOrder
    };
    const signature = JSON.stringify({
      name: nextItem.name,
      active: nextItem.active,
      sortOrder: nextItem.sortOrder
    });
    if (!cleanName || signature === lastSavedRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void onSave(nextItem)
        .then(() => {
          lastSavedRef.current = signature;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [canEdit, draft.active, draft.name, draft.sortOrder, item, onSave]);

  return (
    <tr
      draggable={canEdit}
      onDragStart={() => onDragStart(item.id)}
      onDragOver={onDragOver}
      onDrop={() => onDrop(item.id)}
    >
      <td>
        {canEdit ? (
          <button className="btn-secondary !h-8 !w-8 !px-0 cursor-grab" type="button" title="Drag to reorder">
            <GripVertical className="h-4 w-4" />
          </button>
        ) : null}
      </td>
      <td>{item.id}</td>
      <td>
        <input
          value={draft.name}
          disabled={!canEdit}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </td>
      <td>
        {item.sortOrder}
      </td>
      <td>
        <button
          className="btn-secondary"
          disabled={!canEdit}
          onClick={() => setDraft((current) => ({ ...current, active: !current.active }))}
        >
          {draft.active ? "Active" : "Inactive"}
        </button>
      </td>
      {canEdit && (
        <td className="flex flex-wrap items-center gap-2">
          <span className={`text-xs ${saveState === "error" ? "text-red-300" : "text-slate-400"}`}>
            {saveState === "saving" ? "Saving..." : saveState === "error" ? "Save failed" : "Saved"}
          </span>
          <button
            className="btn-secondary"
            onClick={async () => {
              if (!window.confirm(`Delete ${item.name}?`)) return;
              await onDelete(item.id);
            }}
          >
            Delete
          </button>
        </td>
      )}
    </tr>
  );
}

function CatalogItemCard({
  item,
  canEdit,
  onSave,
  onDelete,
  onDragStart,
  onDrop
}: {
  item: CatalogItem;
  canEdit: boolean;
  onSave: (item: CatalogItem) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onDragStart: (id: string) => void;
  onDrop: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    name: item.name,
    active: item.active,
    sortOrder: item.sortOrder
  });
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const lastSavedRef = useRef(JSON.stringify({ name: item.name, active: item.active, sortOrder: item.sortOrder }));

  useEffect(() => {
    const nextDraft = { name: item.name, active: item.active, sortOrder: item.sortOrder };
    setDraft(nextDraft);
    lastSavedRef.current = JSON.stringify(nextDraft);
    setSaveState("saved");
  }, [item.active, item.id, item.name, item.sortOrder]);

  useEffect(() => {
    if (!canEdit) return;
    const cleanName = draft.name.trim();
    const nextItem = {
      ...item,
      name: cleanName || item.name,
      active: draft.active,
      sortOrder: Number.isFinite(draft.sortOrder) ? draft.sortOrder : item.sortOrder
    };
    const signature = JSON.stringify({
      name: nextItem.name,
      active: nextItem.active,
      sortOrder: nextItem.sortOrder
    });
    if (!cleanName || signature === lastSavedRef.current) return;
    setSaveState("saving");
    const timer = window.setTimeout(() => {
      void onSave(nextItem)
        .then(() => {
          lastSavedRef.current = signature;
          setSaveState("saved");
        })
        .catch(() => setSaveState("error"));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [canEdit, draft.active, draft.name, draft.sortOrder, item, onSave]);

  return (
    <article
      className="mobile-list-card"
      draggable={canEdit}
      onDragStart={() => onDragStart(item.id)}
      onDragOver={(event) => event.preventDefault()}
      onDrop={() => onDrop(item.id)}
    >
      <div className="mobile-card-head">
        <div>
          <p className="mobile-label">ID</p>
          <h3 className="mobile-card-title">{item.id}</h3>
        </div>
        {canEdit && (
          <button className="btn-secondary !h-8 !w-8 !px-0 cursor-grab" type="button" title="Drag to reorder">
            <GripVertical className="h-4 w-4" />
          </button>
        )}
        <span className={draft.active ? "mobile-pill mobile-pill-good" : "mobile-pill"}>{draft.active ? "Active" : "Inactive"}</span>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3">
        <label>
          Name
          <input
            value={draft.name}
            disabled={!canEdit}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </label>
        <p className="text-xs text-slate-500">Order {item.sortOrder}</p>
      </div>
      {canEdit && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            className="btn-secondary flex-1"
            onClick={() => setDraft((current) => ({ ...current, active: !current.active }))}
          >
            {draft.active ? "Mark Inactive" : "Mark Active"}
          </button>
          <button
            className="btn-ghost flex-1 text-rose-200"
            onClick={async () => {
              if (!window.confirm(`Delete ${item.name}?`)) return;
              await onDelete(item.id);
            }}
          >
            Delete
          </button>
          <span className={`w-full text-xs ${saveState === "error" ? "text-red-300" : "text-slate-400"}`}>
            {saveState === "saving" ? "Saving..." : saveState === "error" ? "Save failed" : "Saved"}
          </span>
        </div>
      )}
    </article>
  );
}

function CatalogManager({
  title,
  items,
  canEdit,
  lockedMessage,
  onSave,
  onDelete,
  onReorder
}: {
  title: string;
  items: CatalogItem[];
  canEdit: boolean;
  lockedMessage?: string;
  onSave: (item: CatalogItem) => Promise<void>;
  onDelete: (itemId: string) => Promise<void>;
  onReorder: (before: CatalogItem[], after: CatalogItem[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [displayItems, setDisplayItems] = useState(items);
  const draggedIdRef = useRef<string | null>(null);
  useEffect(() => setDisplayItems(items), [items]);
  function handleDrop(overId: string) {
    const activeId = draggedIdRef.current;
    draggedIdRef.current = null;
    if (!canEdit || !activeId || activeId === overId) return;
    const reordered = applySortOrder(reorderItems(displayItems, activeId, overId));
    setDisplayItems(reordered);
    void onReorder(displayItems, reordered);
  }
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{title}</h2>
          <p>Create IDs once, then use dropdowns during daily entry.</p>
        </div>
      </div>
      {!canEdit && lockedMessage && <p className="warning">{lockedMessage}</p>}
      {canEdit && (
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <button
            className="btn-primary self-end"
            disabled={!name.trim()}
            onClick={async () => {
              const clean = name.trim();
              await onSave({ id: slug(clean), name: clean, active: true, sortOrder: displayItems.length + 1 });
              setName("");
            }}
          >
            Add
          </button>
        </div>
      )}
      <div className="mobile-card-list md:hidden">
        {canEdit ? (
          <>
            {displayItems.map((item) => (
              <CatalogItemCard
                key={item.id}
                item={item}
                canEdit={canEdit}
                onSave={onSave}
                onDelete={onDelete}
                onDragStart={(id) => { draggedIdRef.current = id; }}
                onDrop={handleDrop}
              />
            ))}
            {displayItems.length === 0 && <p className="mobile-empty">No catalog items yet.</p>}
          </>
        ) : (
          <p className="mobile-empty">{lockedMessage ?? "Only owner can manage this section."}</p>
        )}
      </div>
      <div className="table-wrap hidden md:block">
        <table>
          <thead>
            <tr>
              {canEdit && <th>Move</th>}
              <th>ID</th>
              <th>Name</th>
              <th>Order</th>
              <th>Status</th>
              {canEdit && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {canEdit ? (
              displayItems.map((item) => (
                <CatalogItemEditor
                  key={item.id}
                  item={item}
                  canEdit={canEdit}
                  onSave={onSave}
                  onDelete={onDelete}
                  onDragStart={(id) => { draggedIdRef.current = id; }}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={handleDrop}
                />
              ))
            ) : (
              <tr>
                <td colSpan={4}>{lockedMessage ?? "Only owner can manage this section."}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserManager({
  users,
  authorizedEmails,
  notificationSettings,
  currentUid,
  currentEmail,
  canEdit,
  onUpdate,
  onDeleteUser,
  onAuthorizeEmail,
  onDeleteAuthorizedEmail,
  onSaveNotifications
}: {
  users: UserProfile[];
  authorizedEmails: AuthorizedEmail[];
  notificationSettings: NotificationSettings | null;
  currentUid?: string;
  currentEmail?: string | null;
  canEdit: boolean;
  onUpdate: (uid: string, updates: Pick<UserProfile, "role" | "active">) => Promise<void>;
  onDeleteUser: (profile: UserProfile) => Promise<void>;
  onAuthorizeEmail: (email: string, role: UserRole, active?: boolean) => Promise<void>;
  onDeleteAuthorizedEmail: (entry: AuthorizedEmail) => Promise<void>;
  onSaveNotifications: (settings: NotificationSettings) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const ownerRecipients = authorizedEmails.filter((entry) => entry.active && entry.role === "owner");
  const currentEmailKey = currentEmail ? emailKey(currentEmail) : "";
  const toggleRows: Array<[keyof NotificationSettings, string]> = [
    ["enabled", "Enable email notifications"],
    ["sendOnDayClose", "Day close"],
    ["sendOnMonthClose", "Month close"],
    ["sendOnImport", "Workbook import"],
    ["sendOnRecalculate", "Manual recalculation"],
    ["sendOnRoleChange", "Role or email authorization changes"]
  ];
  return (
    <section className="space-y-5">
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Owner Email Notifications</h2>
            <p>Emails are sent to active authorized owners only.</p>
          </div>
          <Bell />
        </div>
        <div className="mb-5 rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <p className="text-xs font-semibold uppercase text-slate-500">Current Recipients</p>
          <p className="mt-2 text-sm text-slate-300">
            {ownerRecipients.length > 0 ? ownerRecipients.map((entry) => entry.email).join(", ") : "No active owner emails configured."}
          </p>
        </div>
        {notificationSettings ? (
          <div className="grid gap-3 md:grid-cols-2">
            {toggleRows.map(([key, label]) => (
              <label className="toggle-row" key={String(key)}>
                <span>{label}</span>
                <input
                  type="checkbox"
                  checked={Boolean(notificationSettings[key])}
                  disabled={!canEdit}
                  onChange={(event) =>
                    onSaveNotifications({
                      ...notificationSettings,
                      [key]: event.target.checked
                    })
                  }
                />
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm text-slate-400">Loading notification settings...</p>
        )}
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Authorized Emails</h2>
            <p>Only these Google account emails can enter the app.</p>
          </div>
        </div>
        {canEdit && (
          <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <label>
              Email
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            </label>
            <div className="flex flex-wrap gap-2">
              {([
                ["owner", "Add Owner"],
                ["admin", "Add Admin"],
                ["viewer", "Add Viewer"]
              ] as Array<[UserRole, string]>).map(([role, label]) => (
                <button
                  key={role}
                  className={role === "owner" ? "btn-primary" : "btn-secondary"}
                  disabled={!email.trim()}
                  onClick={async () => {
                    await onAuthorizeEmail(email, role, true);
                    setEmail("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mobile-card-list md:hidden">
          {authorizedEmails.map((entry) => {
            const isCurrentEmail = entry.id === currentEmailKey;
            const isLastActiveOwner = entry.active && entry.role === "owner" && ownerRecipients.length <= 1;
            return (
              <article className="mobile-list-card" key={entry.id}>
                <div className="mobile-card-head">
                  <div className="min-w-0">
                    <p className="mobile-label">Email</p>
                    <h3 className="mobile-card-title break-words">{entry.email}{isCurrentEmail ? " (you)" : ""}</h3>
                  </div>
                  <span className={entry.active ? "mobile-pill mobile-pill-good" : "mobile-pill"}>{entry.active ? "Active" : "Inactive"}</span>
                </div>
                <label className="mt-3">
                  Role
                  <select
                    value={entry.role}
                    disabled={!canEdit || isCurrentEmail || isLastActiveOwner}
                    onChange={(event) => onAuthorizeEmail(entry.email, event.target.value as UserRole, entry.active)}
                  >
                    <option value="owner">Owner</option>
                    <option value="admin">Admin</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || isCurrentEmail || isLastActiveOwner}
                    onClick={() => onAuthorizeEmail(entry.email, entry.role, !entry.active)}
                  >
                    {entry.active ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    className="btn-ghost text-rose-200"
                    disabled={!canEdit || isCurrentEmail || isLastActiveOwner}
                    onClick={async () => {
                      if (!window.confirm(`Delete authorized email ${entry.email}? This account will not be able to sign in again.`)) return;
                      await onDeleteAuthorizedEmail(entry);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
          {authorizedEmails.length === 0 && <p className="mobile-empty">No authorized emails yet.</p>}
        </div>
        <div className="table-wrap hidden md:block">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Role</th>
                <th>Active</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {authorizedEmails.map((entry) => {
                const isCurrentEmail = entry.id === currentEmailKey;
                const isLastActiveOwner = entry.active && entry.role === "owner" && ownerRecipients.length <= 1;
                return (
                  <tr key={entry.id}>
                    <td>{entry.email}{isCurrentEmail ? " (you)" : ""}</td>
                    <td>
                      <select
                        value={entry.role}
                        disabled={!canEdit || isCurrentEmail || isLastActiveOwner}
                        onChange={(event) => onAuthorizeEmail(entry.email, event.target.value as UserRole, entry.active)}
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        disabled={!canEdit || isCurrentEmail || isLastActiveOwner}
                        onClick={() => onAuthorizeEmail(entry.email, entry.role, !entry.active)}
                      >
                        {entry.active ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        disabled={!canEdit || isCurrentEmail || isLastActiveOwner}
                        onClick={async () => {
                          if (!window.confirm(`Delete authorized email ${entry.email}? This account will not be able to sign in again.`)) return;
                          await onDeleteAuthorizedEmail(entry);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {authorizedEmails.length === 0 && (
                <tr>
                  <td colSpan={4}>No authorized emails yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Signed-In Users</h2>
            <p>Users appear here after signing in with Google.</p>
          </div>
        </div>
        <div className="mobile-card-list md:hidden">
          {users.map((profile) => {
            const isCurrentUser = profile.uid === currentUid;
            return (
              <article className="mobile-list-card" key={profile.uid}>
                <div className="mobile-card-head">
                  <div className="min-w-0">
                    <p className="mobile-label">User</p>
                    <h3 className="mobile-card-title">{userDisplayName(profile)} · ID {userSimpleId(profile)}{isCurrentUser ? " (you)" : ""}</h3>
                    <p className="mt-1 break-words text-sm text-slate-400">{profile.email || "No email"}</p>
                  </div>
                  <span className={profile.active ? "mobile-pill mobile-pill-good" : "mobile-pill"}>{profile.active ? "Active" : "Inactive"}</span>
                </div>
                <label className="mt-3">
                  Role
                  <select
                    value={profile.role}
                    disabled={!canEdit || isCurrentUser}
                    onChange={(event) => onUpdate(profile.uid, { role: event.target.value as UserRole, active: profile.active })}
                  >
                    <option value="owner">Owner</option>
                    <option value="admin">Admin</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </label>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    className="btn-secondary"
                    disabled={!canEdit || isCurrentUser}
                    onClick={() => onUpdate(profile.uid, { role: profile.role, active: !profile.active })}
                  >
                    {profile.active ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    className="btn-ghost text-rose-200"
                    disabled={!canEdit || isCurrentUser}
                    onClick={async () => {
                      if (!window.confirm(`Delete signed-in user ${profile.email || profile.uid}? Their authorized email entry is not deleted automatically.`)) return;
                      await onDeleteUser(profile);
                    }}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
          {users.length === 0 && <p className="mobile-empty">No signed-in users yet.</p>}
        </div>
        <div className="table-wrap hidden md:block">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Email</th>
                <th>Role</th>
                <th>Active</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {users.map((profile) => {
                const isCurrentUser = profile.uid === currentUid;
                return (
                  <tr key={profile.uid}>
                    <td>{isCurrentUser ? `${userDisplayName(profile)} · ID ${userSimpleId(profile)} (you)` : `${userDisplayName(profile)} · ID ${userSimpleId(profile)}`}</td>
                    <td>{profile.email || "No email"}</td>
                    <td>
                      <select
                        value={profile.role}
                        disabled={!canEdit || isCurrentUser}
                        onChange={(event) => onUpdate(profile.uid, { role: event.target.value as UserRole, active: profile.active })}
                      >
                        <option value="owner">Owner</option>
                        <option value="admin">Admin</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        disabled={!canEdit || isCurrentUser}
                        onClick={() => onUpdate(profile.uid, { role: profile.role, active: !profile.active })}
                      >
                        {profile.active ? "Active" : "Inactive"}
                      </button>
                    </td>
                    <td>
                      <button
                        className="btn-secondary"
                        disabled={!canEdit || isCurrentUser}
                        onClick={async () => {
                          if (!window.confirm(`Delete signed-in user ${profile.email || profile.uid}? Their authorized email entry is not deleted automatically.`)) return;
                          await onDeleteUser(profile);
                        }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr>
                  <td colSpan={5}>No signed-in users yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function currency(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function LedgerShadowStatusPanel({
  config,
  role
}: {
  config: LedgerReadModeConfig;
  role: UserRole;
}) {
  const metrics = config.shadowMetrics;
  const before = metrics?.day30DuplicateCreditRawEntriesBefore ?? 0;
  const after = metrics?.day30DuplicateCreditRawEntriesAfter ?? 0;
  const updatedAt = config.updatedAt ? new Date(config.updatedAt).toLocaleString() : null;

  return (
    <section className="mb-4 rounded-xl border border-sky-400/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-50">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-sky-200">Expense v2 Shadow</p>
          <h2 className="mt-1 text-base font-semibold text-white">
            {formatMonth(config.monthId ?? "2026-05")} shadow verification is active
          </h2>
          <p className="mt-1 text-xs text-sky-100/80">
            UI source of truth remains v1. Hard v2 reads are disabled for {role}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-lg border border-sky-300/30 bg-sky-950/40 px-2.5 py-1">{config.status ?? "shadow_verified"}</span>
          <span className="rounded-lg border border-sky-300/30 bg-sky-950/40 px-2.5 py-1">hard v2 off</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-lg border border-sky-300/20 bg-slate-950/30 px-3 py-2">
          <p className="text-xs text-sky-100/70">v1 vs v2 diffs</p>
          <p className="text-lg font-semibold text-white">{currency(metrics?.v1VsV2Diffs ?? 0)}</p>
        </div>
        <div className="rounded-lg border border-sky-300/20 bg-slate-950/30 px-3 py-2">
          <p className="text-xs text-sky-100/70">stored vs recomputed</p>
          <p className="text-lg font-semibold text-white">{currency(metrics?.storedV2VsRecomputedV2Diffs ?? 0)}</p>
        </div>
        <div className="rounded-lg border border-sky-300/20 bg-slate-950/30 px-3 py-2">
          <p className="text-xs text-sky-100/70">Day 30 credit raw</p>
          <p className="text-lg font-semibold text-white">{currency(before)} to {currency(after)}</p>
        </div>
        <div className="rounded-lg border border-sky-300/20 bg-slate-950/30 px-3 py-2">
          <p className="text-xs text-sky-100/70">invariant failures</p>
          <p className="text-lg font-semibold text-white">{currency(metrics?.invariantFailures ?? 0)}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-col gap-1 text-xs text-sky-100/75 md:flex-row md:flex-wrap md:gap-x-4">
        <span>Apply report: {config.verifiedReportId ?? "not set"}</span>
        <span>Shadow report: {config.shadowReportId ?? "not set"}</span>
        {updatedAt && <span>Updated: {updatedAt}</span>}
      </div>
    </section>
  );
}

function RecordsView({
  monthId,
  selectedDay,
  days,
  computed,
  loading
}: {
  monthId: string;
  selectedDay: number;
  days: DailyLedgerInput[];
  computed: MonthComputed | null;
  loading: boolean;
}) {
  const [recordMode, setRecordMode] = useState<"month" | "day">("month");
  const dayInput = days.find((day) => day.dayNo === selectedDay);
  const dayComputed = computed?.days.find((day) => day.dayNo === selectedDay);
  const monthRows = computed?.homeSummary.dayRows ?? [];
  const ownerMonthRows = computed?.days.map((day) => {
    const opening = day.ownerBalances[0]?.opening ?? day.ownerBalanceTotal ?? 0;
    const expense = day.ownerBalances.reduce((total, row) => total + (row.expense ?? Math.max(row.amount, 0)), 0);
    const received = day.ownerBalances.reduce((total, row) => total + (row.received ?? Math.max(-row.amount, 0)), 0);
    return [
      day.label ?? `Day ${day.dayNo}`,
      currency(opening),
      currency(expense),
      currency(received),
      currency(day.ownerBalanceTotal)
    ];
  }) ?? [];
  const creditAgingRows = computed
    ? [...computed.days
        .flatMap((day) => day.creditRows)
        .reduce((totals, row) => {
          const current = totals.get(row.partyName) ?? {
            opening: row.opening,
            debt: 0,
            credit: 0,
            balance: 0
          };
          current.debt += row.loan ?? row.today ?? 0;
          current.credit += row.receive;
          current.balance = row.balance ?? 0;
          totals.set(row.partyName, current);
          return totals;
        }, new Map<string, { opening: number; debt: number; credit: number; balance: number }>())
        .entries()]
        .sort((a, b) => b[1].balance - a[1].balance)
        .map(([partyName, row]) => [
          partyName,
          currency(row.opening),
          currency(row.debt),
          currency(row.credit),
          currency(row.balance)
        ])
    : [];

  return (
    <section className="space-y-5">
      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Previous Records</h2>
            <p>Review a full month or drill into a single date without entering edit mode.</p>
          </div>
        </div>
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            ["month", "Whole Month"],
            ["day", "Single Date"]
          ].map(([id, label]) => (
            <button
              className={recordMode === id ? "btn-tab btn-tab-active" : "btn-tab"}
              key={id}
              onClick={() => setRecordMode(id as "month" | "day")}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr] md:items-end">
          <label>
            Active Month
            <input value={formatMonth(monthId)} disabled readOnly />
          </label>
        </div>
        {recordMode === "day" && (
          <p className="mt-3 text-sm text-slate-400">Selected period: {dayInput?.date ?? dateLabelFor(monthId, selectedDay)}</p>
        )}
        {loading && (
          <p className="mt-4 flex items-center gap-2 text-sm font-medium text-slate-300">
            <LoadingIcon label="Loading previous records" />
            Loading records...
          </p>
        )}
      </section>

      {recordMode === "month" && computed ? (
        <>
          <HomeDashboard month={computed} />
          <section className="grid gap-5 xl:grid-cols-2">
            <RecordTable
              title="Commission Categories"
              headers={["Category", "Amount"]}
              rows={[...computed.homeSummary.commissionMatrix
                .reduce((totals, row) => {
                  for (const [category, amount] of Object.entries(row.byCategory)) {
                    totals.set(category, (totals.get(category) ?? 0) + amount);
                  }
                  return totals;
                }, new Map<string, number>())
                .entries()]
                .filter(([, amount]) => amount !== 0)
                .sort((a, b) => b[1] - a[1])
                .map(([category, amount]) => [category, currency(amount)])}
            />
            <RecordTable
              title="Expense Categories"
              headers={["Category", "Amount"]}
              rows={computed.homeSummary.expenseByCategory.map((row) => [row.category, currency(row.amount)])}
            />
            <RecordTable
              title="Month Day Records"
              headers={["Period", "Opening", "Issue", "Expense", "Balance", "Credit"]}
              rows={monthRows.map((row) => [
                row.label ?? `Day ${row.dayNo}`,
                currency(row.openingBalance),
                currency(row.issueBalance),
                currency(row.expenseTotal),
                currency(row.returnBalance),
                currency(row.creditBalance)
              ])}
            />
            <RecordTable
              title="Credit Party Aging"
              headers={["Party", "Opening", "Debt", "Credit", "Balance"]}
              rows={creditAgingRows}
            />
            <RecordTable
              title="Franchise Owner"
              headers={["Day", "Opening", "Expense", "Received", "Balance"]}
              rows={ownerMonthRows}
            />
          </section>
        </>
      ) : recordMode === "day" && dayInput && dayComputed ? (
        <>
          <section className="grid gap-3 md:grid-cols-5">
            {[
              ["Opening", dayComputed.openingBalance],
              ["Commission", dayComputed.commissionTotal],
              ["Expense", dayComputed.expenseTotal],
              ["Balance", dayComputed.returnBalance],
              ["Credit", dayComputed.creditTotals.balance]
            ].map(([label, value]) => (
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-4" key={label}>
                <p className="text-xs font-semibold uppercase text-slate-500">{label}</p>
                <p className="mt-2 text-2xl font-semibold text-white">{currency(Number(value))}</p>
              </div>
            ))}
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h3>{dayInput.label ?? `Day ${selectedDay}`}</h3>
                <p>{dayInput.date ?? dateLabelFor(monthId, selectedDay)} · read-only record</p>
              </div>
            </div>
            {dayInput.notes && <p className="status">{dayInput.notes}</p>}
          </section>

          <section className="grid gap-5 xl:grid-cols-2">
            <RecordTable
              title="Expenses"
              headers={["Category", "Name", "Description", "Amount"]}
              rows={[
                ...dayInput.expenses.map((item) => [
                  item.category ?? "-",
                  item.name || "-",
                  item.description || "-",
                  currency(item.amount)
                ]),
                ["-", "-", "Total", currency(dayComputed.expenseTotal)]
              ]}
            />
            <RecordTable
              title="Commissions"
              headers={["Category", "Amount"]}
              rows={[
                ...dayInput.commissions.map((item) => [item.category, currency(item.amount)]),
                ["Total", currency(dayComputed.commissionTotal)]
              ]}
            />
            <RecordTable
              title="Credit Parties"
              headers={["Party", "Opening", "Loan Description", "Loan", "Receive Description", "Receive", "Legacy Description", "Balance"]}
              rows={[
                ...dayComputed.creditRows.map((row) => {
                  const descriptions = resolveCreditDescriptions(row);
                  return [
                    row.partyName,
                    currency(row.opening),
                    descriptions.loanDescription || "-",
                    currency(row.loan ?? row.today ?? 0),
                    descriptions.receiveDescription || "-",
                    currency(row.receive),
                    descriptions.legacyDescription || "-",
                    currency(row.balance ?? 0)
                  ];
                }),
                [
                  "Total",
                  currency(dayComputed.creditTotals.opening),
                  "-",
                  currency(dayComputed.creditTotals.today),
                  "-",
                  currency(dayComputed.creditTotals.receive),
                  "-",
                  currency(dayComputed.creditTotals.balance)
                ]
              ]}
            />
            <RecordTable
              title="Franchise Owner"
              headers={["Description", "Opening", "Expense", "Received", "Balance"]}
              rows={[
                ...dayComputed.ownerBalances.map((row) => [
                  row.description ?? row.label ?? "-",
                  currency(row.opening ?? 0),
                  currency(row.expense ?? Math.max(row.amount, 0)),
                  currency(row.received ?? Math.max(-row.amount, 0)),
                  currency(row.balance ?? 0)
                ]),
                ["Total", "-", "-", "-", currency(dayComputed.ownerBalanceTotal)]
              ]}
            />
          </section>
        </>
      ) : (
        <section className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-10 text-center">
          <h2 className="text-xl font-semibold text-white">No record for this date</h2>
          <p className="mt-2 text-sm text-slate-400">Choose another day or load a month that has saved entries.</p>
        </section>
      )}
    </section>
  );
}

function RecordTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h3>{title}</h3>
          <p>{rows.length} saved rows</p>
        </div>
      </div>
      <div className="mobile-card-list md:hidden">
        {rows.map((row, index) => (
          <article className="mobile-list-card" key={`${title}-mobile-${index}`}>
            <div className="mobile-card-head">
              <div>
                <p className="mobile-label">{headers[0] ?? "Row"}</p>
                <h3 className="mobile-card-title">{row[0] ?? "-"}</h3>
              </div>
            </div>
            <dl className="mobile-kv-grid mt-3">
              {row.slice(1).map((cell, cellIndex) => (
                <div key={`${title}-mobile-${index}-${cellIndex}`}>
                  <dt>{headers[cellIndex + 1] ?? `Value ${cellIndex + 1}`}</dt>
                  <dd>{cell}</dd>
                </div>
              ))}
            </dl>
          </article>
        ))}
        {rows.length === 0 && <p className="mobile-empty">No saved rows.</p>}
      </div>
      <div className="table-wrap hidden md:block">
        <table>
          <thead>
            <tr>
              {headers.map((header) => <th key={header}>{header}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={`${title}-${index}`}>
                {row.map((cell, cellIndex) => <td key={`${title}-${index}-${cellIndex}`}>{cell}</td>)}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={headers.length}>No saved rows.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FirebaseMissing() {
  return (
    <main className="auth-page">
      <section className="panel auth-panel">
        <h1>Firebase Config Missing</h1>
        <p>The app is now Firestore-backed. Add the `VITE_FIREBASE_*` values and restart Vite.</p>
      </section>
    </main>
  );
}

function AuthPanel({
  message,
  busy,
  onSubmit
}: {
  message: string;
  busy: boolean;
  onSubmit: (usernameOrEmail: string, password: string) => Promise<void>;
}) {
  const [usernameOrEmail, setUsernameOrEmail] = useState("");
  const [password, setPassword] = useState("");

  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void onSubmit(usernameOrEmail, password);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 p-4 text-slate-100">
      <section className="w-full max-w-md rounded-xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/40">
        <p className="text-xs font-semibold uppercase text-emerald-300">Software</p>
        <h1 className="mt-1 text-2xl font-semibold">Jazz Franchise - 7301</h1>
        <p className="mt-4 text-sm text-slate-400">
          Sign in with your local account.
        </p>
        <form className="mt-5 space-y-3" onSubmit={handleFormSubmit}>
          <label className="block text-sm text-slate-300">
            Username or Email
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              type="text"
              autoComplete="username"
              placeholder="e.g. owner or admin"
              value={usernameOrEmail}
              disabled={busy}
              onChange={(event) => setUsernameOrEmail(event.target.value)}
            />
          </label>
          <label className="block text-sm text-slate-300">
            Password
            <input
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button className="btn-primary !w-full" disabled={busy || !usernameOrEmail.trim() || !password} type="submit">
            {busy && <LoadingIcon label="Signing in" />}
            Sign in
          </button>
        </form>
        {message && <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">{message}</p>}
        {busy && (
          <div className="mt-5 flex items-center justify-center gap-2 text-sm text-slate-400">
            <LoadingIcon label="Checking access" />
            Checking access...
          </div>
        )}
      </section>
    </main>
  );
}

function App() {
  const [view, setView] = useState<View>("dashboard");
  const [expenseSection, setExpenseSection] = useState<ExpenseSection>("daily-entry");
  const [user, setUser] = useState<AppUser | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [authStatus, setAuthStatus] = useState("Initializing local auth...");
  const [monthId, setMonthId] = useState("2026-08");
  const [openingBalance, setOpeningBalance] = useState(0);
  const [ownerOpeningBalance, setOwnerOpeningBalance] = useState(0);
  const [selectedDay, setSelectedDay] = useState(1);
  const [months, setMonths] = useState<MonthRecord[]>([]);
  const [jazzLoadMonths, setJazzLoadMonths] = useState<JazzLoadMonth[]>([]);
  const [days, setDays] = useState<DailyLedgerInput[]>([]);
  const [computed, setComputed] = useState<MonthComputed | null>(null);
  const [expenseCarryForwardSeed, setExpenseCarryForwardSeed] = useState<ExpenseCarryForwardSeed | null>(null);
  const [day1LoadError, setDay1LoadError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<WorkbookImportPreview | null>(null);
  const [importMonthId, setImportMonthId] = useState("2026-08");
  const [importType, setImportType] = useState<WorkbookImportPreview["importType"]>("full");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingMessage, setLoadingMessage] = useState("Loading application data...");
  const [isAutosaving, setIsAutosaving] = useState(false);
  const [pageActivityLoading, setPageActivityLoading] = useState(false);
  const [monthEmailing, setMonthEmailing] = useState(false);
  const [bulkReopening, setBulkReopening] = useState<"selected" | "all" | null>(null);
  const [bulkClosingDays, setBulkClosingDays] = useState(false);
  const [monthStatus, setMonthStatusState] = useState<"open" | "closed">("open");
  const [periodFinalSettlementStatus, setPeriodFinalSettlementStatus] = useState<string | null>(null);
  const [monthClosing, setMonthClosing] = useState(false);
  const [initializingNextPeriod, setInitializingNextPeriod] = useState(false);
  const [monthCloseModal, setMonthCloseModal] = useState<{
    isOpen: boolean;
    step: "prompt" | "success";
    errorMessage?: string | null;
  }>({
    isOpen: false,
    step: "prompt",
    errorMessage: null
  });
  const [expenseCategories, setExpenseCategories] = useState<CatalogItem[]>([]);
  const [commissionCategories, setCommissionCategories] = useState<CatalogItem[]>([]);
  const [creditParties, setCreditParties] = useState<CatalogItem[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [authorizedEmails, setAuthorizedEmails] = useState<AuthorizedEmail[]>([]);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettings | null>(null);
  const [ledgerReadModeConfig, setLedgerReadModeConfig] = useState<LedgerReadModeConfig>(defaultLedgerReadModeConfig);
  const [expenseMismatchCount, setExpenseMismatchCount] = useState(0);
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("theme") === "light" ? "light" : "dark"));
  const [uiMode, setUiMode] = useState<UiMode>(() => (localStorage.getItem("uiMode") === "classic" ? "classic" : "modern"));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const [authReady, setAuthReady] = useState(false);
  const [calendarSelectionReady, setCalendarSelectionReady] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [hasPendingDayChanges, setHasPendingDayChanges] = useState(false);
  const expenseManualSaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const [syncState, setSyncState] = useState<SyncState>(() => nextSyncState({ online: navigator.onLine, hasPendingWrites: false }));
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [masterRefreshModal, setMasterRefreshModal] = useState<MasterRefreshModalState>({
    open: false,
    title: "",
    progress: []
  });
  const creatingMonthsRef = useRef(new Set<string>());
  const pendingWritesRef = useRef(false);
  const syncErrorRef = useRef(false);
  const queuedWriteCountRef = useRef(0);
  const closedExpenseDayKeysRef = useRef(new Set<string>());

  const [pgPeriodRouting, setPgPeriodRouting] = useState<{
    checked: boolean;
    status: PeriodRoutingStatus;
    period: any | null;
  }>({ checked: false, status: "UNINITIALIZED", period: null });

  useEffect(() => {
    let cancelled = false;
    if (!user || !authReady) {
      setPgPeriodRouting({ checked: false, status: "UNINITIALIZED", period: null });
      return;
    }
    setPgPeriodRouting((prev) => ({ ...prev, checked: false }));
    if (isPostgreSqlPeriod(monthId)) {
      void resolvePeriodRouting(monthId).then((res) => {
        if (!cancelled) {
          setPgPeriodRouting({ checked: true, status: res.status, period: res.period });
          const periodObj = res.period;
          if (periodObj) {
            setMonths((currentMonths) => {
              if (currentMonths.some((m) => m.id === periodObj.period_key)) return currentMonths;
              return [
                ...currentMonths,
                {
                  id: periodObj.period_key,
                  label: periodObj.label || periodObj.period_key,
                  status: periodObj.status,
                  openingBalance: 0,
                  createdAt: periodObj.created_at ? new Date(periodObj.created_at).getTime() : undefined,
                  updatedAt: periodObj.updated_at ? new Date(periodObj.updated_at).getTime() : undefined
                }
              ];
            });
          }
        }
      });
    } else {
      setPgPeriodRouting({ checked: true, status: "INITIALIZED", period: null });
    }
    return () => { cancelled = true; };
  }, [authReady, monthId, user]);
  const expenseReadDecision = useMemo(
    () => resolveLedgerUiReadDecision({ config: ledgerReadModeConfig, module: "expense", role, monthId }),
    [ledgerReadModeConfig, monthId, role]
  );
  const jazzLoadReadDecision = useMemo(
    () => resolveLedgerUiReadDecision({ config: ledgerReadModeConfig, module: "jazzLoad", role, monthId }),
    [ledgerReadModeConfig, monthId, role]
  );
  const stockReadDecision = useMemo(
    () => resolveLedgerUiReadDecision({ config: ledgerReadModeConfig, module: "stock", role, monthId }),
    [ledgerReadModeConfig, monthId, role]
  );

  function confirmLeavePendingChanges() {
    return window.confirm("There are unsaved daily-entry changes. Leave this screen anyway?");
  }

  function updateSyncState(hasPendingWrites = pendingWritesRef.current) {
    pendingWritesRef.current = hasPendingWrites;
    setSyncState(nextSyncState({ online: navigator.onLine, hasPendingWrites, hasError: syncErrorRef.current }));
  }

  function applySnapshotMetadata(metadata: { hasPendingWrites: boolean }) {
    syncErrorRef.current = false;
    if (authStatus === FIRESTORE_ERROR_STATUS) setAuthStatus(CONNECTED_STATUS);
    updateSyncState(metadata.hasPendingWrites || queuedWriteCountRef.current > 0);
  }

  function handleFirestoreError(message: string) {
    if (isPostgreSqlPeriod(monthId)) {
      console.warn("[Firestore] Background legacy listener warning:", message);
      return;
    }
    syncErrorRef.current = true;
    setSyncState("error");
    setAuthStatus(FIRESTORE_ERROR_STATUS);
    setStatus(message);
  }

  function handleQueuedWrite(promise: Promise<unknown>, failureMessage: string) {
    queuedWriteCountRef.current += 1;
    updateSyncState(true);
    return promise
      .then(() => {
        queuedWriteCountRef.current = Math.max(queuedWriteCountRef.current - 1, 0);
        updateSyncState(queuedWriteCountRef.current > 0);
        return true;
      })
      .catch((err) => {
        queuedWriteCountRef.current = Math.max(queuedWriteCountRef.current - 1, 0);
        updateSyncState(queuedWriteCountRef.current > 0);
        setStatus(err instanceof Error ? err.message : failureMessage);
        return false;
      });
  }

  useEffect(() => {
    let cancelled = false;

    async function initAuth() {
      setCalendarSelectionReady(false);
      try {
        const session = await localAuthService.restoreSession();
        if (session && !cancelled) {
          const appUser: AppUser = {
            id: session.user.id,
            uid: session.user.id,
            username: session.user.username,
            email: session.user.email ?? `${session.user.username}@local`,
            displayName: session.user.displayName || session.user.username,
            role: session.user.role
          };
          const restoredSelection = readStoredCalendarSelection(appUser.uid);
          setMonthId(restoredSelection.monthId);
          setSelectedDay(restoredSelection.dayNo);
          setView(readStoredView(appUser.uid));
          setCalendarSelectionReady(true);
          setUser(appUser);
          setRole(appUser.role);
          setAuthStatus(CONNECTED_STATUS);
          setAuthMessage("");
          setAuthReady(true);
          return;
        }
      } catch (err) {
        console.warn("[App] Local session restore error:", err);
      }

      if (!cancelled) {
        setUser(null);
        setRole(null);
        setAuthStatus("Sign in required.");
        setAuthReady(true);
      }
    }

    void initAuth();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!user || !calendarSelectionReady) return;
    if (monthId < "2026-08") return;
    localStorage.setItem(calendarSelectionKey(user.uid), JSON.stringify({
      monthId,
      day: selectedDay,
      updatedAt: Date.now()
    }));
  }, [calendarSelectionReady, monthId, selectedDay, user]);

  useEffect(() => {
    if (!user || !calendarSelectionReady) return;
    const moduleKey = viewToPersistedModule[view];
    if (moduleKey) {
      localStorage.setItem(activeModuleKey(user.uid), moduleKey);
    }
  }, [calendarSelectionReady, user, view]);

  useEffect(() => {
    document.documentElement.dataset.uiMode = uiMode;
    localStorage.setItem("uiMode", uiMode);
  }, [uiMode]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setAuditActorRole(role);
  }, [role]);

  useEffect(() => {
    const handleConnectivityChange = () => updateSyncState();
    window.addEventListener("online", handleConnectivityChange);
    window.addEventListener("offline", handleConnectivityChange);
    handleConnectivityChange();
    return () => {
      window.removeEventListener("online", handleConnectivityChange);
      window.removeEventListener("offline", handleConnectivityChange);
    };
  }, []);

  useEffect(() => {
    const handleAutosaveStatus = (e: Event) => {
      const count = (e as CustomEvent<number>).detail;
      setIsAutosaving(count > 0);
    };
    window.addEventListener("autosave-active-count", handleAutosaveStatus);
    return () => window.removeEventListener("autosave-active-count", handleAutosaveStatus);
  }, []);


  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 5000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    if (!authMessage) return;
    const timer = window.setTimeout(() => setAuthMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [authMessage]);

  async function handleAuthLogin(usernameOrEmail: string, password: string) {
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const res = await localAuthService.login(usernameOrEmail.trim(), password);
      const appUser: AppUser = {
        id: res.user.id,
        uid: res.user.id,
        username: res.user.username,
        email: res.user.email ?? `${res.user.username}@local`,
        displayName: res.user.displayName || res.user.username,
        role: res.user.role
      };
      const restoredSelection = readStoredCalendarSelection(appUser.uid);
      setMonthId(restoredSelection.monthId);
      setSelectedDay(restoredSelection.dayNo);
      setView(readStoredView(appUser.uid));
      setCalendarSelectionReady(true);
      setUser(appUser);
      setRole(appUser.role);
      setAuthStatus(CONNECTED_STATUS);
      setAuthMessage("");
    } catch (err) {
      setAuthMessage(err instanceof Error ? err.message : "Authentication failed.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    try {
      await localAuthService.logout();
    } catch {
      // Ignore
    }
    if (auth) {
      try {
        await signOut(auth);
      } catch {
        // Ignore
      }
    }
    setUser(null);
    setRole(null);
    setCalendarSelectionReady(false);
    setAuthStatus("Sign in required.");
  }

  async function refreshMonthList() {
    try {
      const res = await ledgerApiClient.periods.list();
      const pgMonths = (res.periods || []).map((p) => ({
        id: p.period_key,
        label: p.label || p.period_key,
        status: p.status as "open" | "closed",
        openingBalance: 0,
        createdAt: p.created_at ? new Date(p.created_at).getTime() : undefined,
        updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : undefined
      }));
      setMonths(pgMonths);
      return pgMonths as unknown as MonthRecord[];
    } catch {
      return [];
    }
  }

  async function loadMonth(nextMonthId = monthId, options: LoadMonthOptions = {}) {
    if (!options.skipPendingCheck && hasPendingDayChanges && !confirmLeavePendingChanges()) {
      setStatus("Stayed on the current day because changes are still pending save.");
      return;
    }
    const currentStatus = months.find((m) => m.id === monthId)?.status ?? monthStatus;
    if (nextMonthId > monthId && currentStatus === "open") {
      setStatus(`Cannot proceed to ${formatMonth(nextMonthId)}: Current period ${formatMonth(monthId)} is still open. Please close ${formatMonth(monthId)} first.`);
      return;
    }
    setStatus("");
    setLoadingMessage("Loading month data...");
    setLoading(true);
    setMonthId(nextMonthId);
    const nextSelectedDay = options.targetDay ?? clampSelectedDay(selectedDay, nextMonthId, now);
    if (nextSelectedDay !== selectedDay) setSelectedDay(nextSelectedDay);
  }

  useEffect(() => {
    if (!user || !authReady) return;
    let cancelled = false;
    void ledgerApiClient.periods.list().then((res) => {
      if (cancelled) return;
      const pgMonths = (res.periods || []).map((p) => ({
        id: p.period_key,
        label: p.label || p.period_key,
        status: p.status as "open" | "closed",
        openingBalance: 0,
        createdAt: p.created_at ? new Date(p.created_at).getTime() : undefined,
        updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : undefined
      }));
      setMonths(pgMonths);
      setJazzLoadMonths(
        (res.periods || []).map((p) => ({
          id: p.period_key,
          label: p.label || p.period_key,
          status: p.status as "open" | "closed",
          createdBy: "system",
          createdAt: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
          updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : Date.now()
        }))
      );
    }).catch((err) => {
      console.warn("[App] Failed to load PostgreSQL accounting periods:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [authReady, user]);

  useEffect(() => {
    if (!user || !calendarSelectionReady || (role !== "owner" && role !== "admin") || isPostgreSqlPeriod(monthId)) {
      setExpenseMismatchCount(0);
      return;
    }
    const unsubscribe = subscribeLedgerMismatchReports(
      "expense",
      monthId,
      (reports, metadata) => {
        setExpenseMismatchCount(reports.reduce((total, report) => total + report.issueCount, 0));
        applySnapshotMetadata(metadata);
      },
      (err) => handleFirestoreError(err.message)
    );
    return unsubscribe;
  }, [calendarSelectionReady, monthId, role, user]);

  useEffect(() => {
    if (!user || !role) {
      setLedgerReadModeConfig(defaultLedgerReadModeConfig);
      return;
    }
    if (isPostgreSqlPeriod(monthId)) {
      setLedgerReadModeConfig(defaultLedgerReadModeConfig);
      return;
    }
    const unsubscribe = subscribeLedgerReadModeConfig(
      (config, metadata) => {
        setLedgerReadModeConfig(config);
        applySnapshotMetadata(metadata);
      },
      (err) => handleFirestoreError(err.message)
    );
    return unsubscribe;
  }, [monthId, role, user]);

  useEffect(() => {
    if (!user || !role || !calendarSelectionReady) return;
    if (isPostgreSqlPeriod(monthId)) {
      let cancelled = false;
      void Promise.all([
        ledgerApiClient.catalogs.getCreditParties().catch(() => ({ data: [] })),
        ledgerApiClient.catalogs.getExpenseCategories().catch(() => ({ data: [] })),
        ledgerApiClient.catalogs.getCommissionCategories().catch(() => ({ data: [] }))
      ]).then(([cpRes, expRes, commRes]) => {
        if (cancelled) return;
        if (cpRes.data && cpRes.data.length > 0) {
          setCreditParties(cpRes.data.map((p: any) => ({
            id: p.id,
            name: p.name,
            active: p.is_active,
            sortOrder: p.sort_order
          })));
        }
        if (expRes.data && expRes.data.length > 0) {
          setExpenseCategories(expRes.data.map((c: any) => ({
            id: c.id,
            name: c.name,
            active: c.is_active,
            sortOrder: c.sort_order
          })));
        }
        if (commRes.data && commRes.data.length > 0) {
          setCommissionCategories(commRes.data.map((c: any) => ({
            id: c.id,
            name: c.name,
            active: c.is_active,
            sortOrder: c.sort_order
          })));
        }
      });
      return () => {
        cancelled = true;
      };
    }

    if (roleCan(role, "catalogs")) void ensureDefaultCatalogs().catch((err) => setStatus(err instanceof Error ? err.message : "Could not seed catalogs."));

    const unsubscribers = [
      subscribeCatalogItems("expenseCategories", (items, metadata) => {
        setExpenseCategories(items);
        applySnapshotMetadata(metadata);
      }, (err) => handleFirestoreError(err.message)),
      subscribeCatalogItems("commissionCategories", (items, metadata) => {
        setCommissionCategories(items);
        applySnapshotMetadata(metadata);
      }, (err) => handleFirestoreError(err.message)),
      subscribeCatalogItems("creditParties", (items, metadata) => {
        setCreditParties(items);
        applySnapshotMetadata(metadata);
      }, (err) => handleFirestoreError(err.message))
    ];

    if (roleCan(role, "users")) {
      unsubscribers.push(
        subscribeUsers((profiles, metadata) => {
          setUsers(profiles);
          applySnapshotMetadata(metadata);
        }, (err) => handleFirestoreError(err.message)),
        subscribeAuthorizedEmails((emails, metadata) => {
          setAuthorizedEmails(emails);
          applySnapshotMetadata(metadata);
        }, (err) => handleFirestoreError(err.message)),
        subscribeNotificationSettings((settings, metadata) => {
          setNotificationSettings(settings);
          applySnapshotMetadata(metadata);
        }, (err) => handleFirestoreError(err.message))
      );
    } else {
      setUsers([]);
      setAuthorizedEmails([]);
      setNotificationSettings(null);
    }

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [calendarSelectionReady, monthId, role, user]);

  useEffect(() => {
    if (!user || !role) return;
    if (isPostgreSqlPeriod(monthId)) {
      let cancelled = false;
      void (async () => {
        try {
          const periodData = await getAccountingPeriodWithDays(monthId);
          if (cancelled) return;
          if (!periodData) {
            setMonthStatusState("open");
            setOpeningBalance(0);
            setOwnerOpeningBalance(0);
            setDays([]);
            setComputed(null);
            setLoading(false);
            return;
          }
          setMonthStatusState(periodData.period.status as "open" | "closed");
          setPeriodFinalSettlementStatus(periodData.period.final_settlement_status ?? null);
          try {
            const seedsRes = await ledgerApiClient.periods.getSeeds(periodData.period.id);
            if (!cancelled && seedsRes?.seeds?.financial) {
              const fin = seedsRes.seeds.financial as any;
              const cashOpening = Number(fin.opening_cash ?? fin.opening_cash_balance ?? 0);
              const ownerOpening = Number(fin.opening_owner_balance ?? fin.owner_opening_balance ?? 0);
              setOpeningBalance(cashOpening);
              setOwnerOpeningBalance(ownerOpening);

              setMonths((currentMonths) =>
                currentMonths.map((m) =>
                  m.id === monthId
                    ? { ...m, openingBalance: cashOpening, ownerOpeningBalance: ownerOpening }
                    : m
                )
              );

              const creditPartiesCatalog = await ledgerApiClient.catalogs.getCreditParties().catch(() => ({ data: [] }));
              const partyNameMap = new Map((creditPartiesCatalog.data || []).map((cp: any) => [cp.id, cp.name]));
              
              const creditBalances: ExpenseCarryForwardCreditBalance[] = (seedsRes.seeds.creditParties || []).map((cp: any) => ({
                partyId: cp.party_id,
                partyName: partyNameMap.get(cp.party_id) || cp.party_id,
                balance: Number(cp.opening_balance ?? 0)
              }));

              const isGenesis = isGenesisPeriod(monthId) || !fin.source_period_key;
              const carrySeed: ExpenseCarryForwardSeed = {
                isGenesis,
                sourceMonthId: fin.source_period_key || (isGenesis ? "genesis" : ""),
                sourceDayNo: fin.source_day_no || 0,
                openingBalance: cashOpening,
                ownerOpeningBalance: ownerOpening,
                creditBalances
              };
              setExpenseCarryForwardSeed(carrySeed);
            }
          } catch {
            // Seeds may be uninitialized or inaccessible to some roles
          }
          const pgDays: DailyLedgerInput[] = [];
          const dayCount = periodData.days.size || 31;
          for (let d = 1; d <= dayCount; d++) {
            const dayRec = periodData.days.get(d);
            const status = dayRec?.status ?? "closed";
            pgDays.push({
              dayNo: d,
              date: `${monthId}-${String(d).padStart(2, "0")}`,
              status,
              lockedAt: status === "closed" ? (dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : Date.now()) : undefined,
              closedAt: status === "closed" && dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : undefined,
              reopenedAt: dayRec?.reopened_at ? new Date(dayRec.reopened_at).getTime() : undefined,
              expenses: [],
              commissions: [],
              credits: [],
              ownerBalances: []
            });
          }

          let finalDayRecord: DailyLedgerInput | null = null;
          if (canUseFinalPeriod(monthId, new Date())) {
            try {
              finalDayRecord = await loadExpenseDayPostgres(monthId, 32);
            } catch {
              // Non-blocking
            }
          }

          if (!cancelled) {
            setDays((currentDays) => {
              const currentMap = new Map(currentDays.map((d) => [d.dayNo, d]));
              const merged = pgDays.map((pgDay) => {
                const existing = currentMap.get(pgDay.dayNo);
                if (existing && isServerLoadedDay(existing) && (!existing.date || existing.date.startsWith(monthId))) {
                  return {
                    ...pgDay,
                    ...existing,
                    status: pgDay.status,
                    lockedAt: pgDay.lockedAt,
                    closedAt: pgDay.closedAt,
                    reopenedAt: pgDay.reopenedAt,
                    openingCash: existing.openingCash,
                    ownerOpeningBalance: existing.ownerOpeningBalance,
                    expenses: existing.expenses,
                    commissions: existing.commissions,
                    credits: existing.credits,
                    ownerBalances: existing.ownerBalances,
                    notes: existing.notes ?? pgDay.notes,
                    updatedAt: existing.updatedAt
                  };
                }
                return pgDay;
              });

              const existingFinal = currentMap.get(32);
              if (finalDayRecord) {
                merged.push(finalDayRecord);
              } else if (existingFinal && isServerLoadedDay(existingFinal) && (!existingFinal.date || existingFinal.date.startsWith(monthId))) {
                merged.push(existingFinal);
              }

              for (const [dayNo, existingDay] of currentMap.entries()) {
                if (dayNo > dayCount && dayNo !== 32 && isServerLoadedDay(existingDay) && (!existingDay.date || existingDay.date.startsWith(monthId))) {
                  merged.push(existingDay);
                }
              }

              return merged;
            });
            setLoading(false);
          }
        } catch (err) {
          if (!cancelled) {
            setLoading(false);
            setStatus(err instanceof Error ? err.message : "Failed to load PostgreSQL period.");
          }
        }
      })();
      return () => {
        cancelled = true;
      };
    }
  }, [calendarSelectionReady, monthId, role, user]);

  useEffect(() => {
    setDay1LoadError(null);
  }, [monthId]);

  useEffect(() => {
    if (!user || !role || !calendarSelectionReady || !isPostgreSqlPeriod(monthId)) return;
    let cancelled = false;

    // Load selected day
    void loadExpenseDayPostgres(monthId, selectedDay).then((dayData) => {
      if (cancelled) return;
      if (dayData) {
        if (selectedDay === 1) {
          setDay1LoadError(null);
        }
        setDays((currentDays) => replaceDay(currentDays, dayData));
      } else if (selectedDay === 1) {
        const errorMsg = "Day 1 data not found";
        setDay1LoadError(errorMsg);
        setDays((currentDays) =>
          currentDays.map((d) => (d.dayNo === 1 ? { ...d, loadError: errorMsg } : d))
        );
      }
    }).catch((err) => {
      if (!cancelled && selectedDay === 1) {
        const errorMsg = err instanceof Error ? err.message : "Failed to load Day 1";
        setDay1LoadError(errorMsg);
        setDays((currentDays) =>
          currentDays.map((d) => (d.dayNo === 1 ? { ...d, loadError: errorMsg } : d))
        );
      }
    });

    // When a non-Day-1 is selected, also ensure Day 1 is hydrated in background for carry-forward verification
    if (selectedDay !== 1) {
      void loadExpenseDayPostgres(monthId, 1).then((day1Data) => {
        if (cancelled || !day1Data) return;
        setDay1LoadError(null);
        setDays((currentDays) => replaceDay(currentDays, day1Data));
      }).catch((err) => {
        if (cancelled) return;
        setDay1LoadError(err instanceof Error ? err.message : "Failed to load Day 1");
      });
    }

    return () => {
      cancelled = true;
    };
  }, [calendarSelectionReady, monthId, role, selectedDay, user]);

  const calculatedOpeningBalance = expenseCarryForwardSeed?.openingBalance ?? openingBalance;
  const calculatedOwnerOpeningBalance = expenseCarryForwardSeed?.ownerOpeningBalance ?? ownerOpeningBalance;

  useEffect(() => {
    setComputed(computeMonth(days, calculatedOpeningBalance, monthId, calculatedOwnerOpeningBalance, expenseCarryForwardSeed ?? undefined));
  }, [calculatedOpeningBalance, calculatedOwnerOpeningBalance, days, expenseCarryForwardSeed, monthId]);

  const selectedDayInput = useMemo(
    () => days.find((day) => day.dayNo === selectedDay) ?? emptyDay(selectedDay),
    [days, selectedDay]
  );

  const previousDayInput = useMemo(
    () =>
      selectedDay === 1
        ? previousDayFromExpenseSeed(expenseCarryForwardSeed)
        : [...days]
        .filter((day) => day.dayNo < selectedDay && day.dayNo !== 32 && day.credits.length > 0)
        .sort((a, b) => b.dayNo - a.dayNo)[0],
    [days, expenseCarryForwardSeed, selectedDay]
  );

  const selectedOpening = useMemo(() => {
    if (selectedDay === 32) {
      if (isPostgreSqlPeriod(monthId) && selectedDayInput.openingCash !== undefined) {
        return selectedDayInput.openingCash;
      }
      return 0;
    }
    if (isPostgreSqlPeriod(monthId) && selectedDayInput.openingCash !== undefined) {
      return selectedDayInput.openingCash;
    }
    const previous = computed?.days.find((day) => day.dayNo === selectedDay - 1);
    return selectedDay === 1 ? calculatedOpeningBalance : previous?.returnBalance ?? calculatedOpeningBalance;
  }, [calculatedOpeningBalance, computed?.days, monthId, selectedDay, selectedDayInput.openingCash]);

  useEffect(() => {
    const nextDay = clampSelectedDay(selectedDay, monthId, now);
    if (nextDay !== selectedDay) setSelectedDay(nextDay);
  }, [monthId, now, selectedDay]);

  useEffect(() => {
    return subscribeDayStatus((event) => {
      if (event.monthId === monthId) {
        if (event.status === "closed") {
          closedExpenseDayKeysRef.current.add(`${monthId}/${event.dayNo}`);
        } else {
          closedExpenseDayKeysRef.current.delete(`${monthId}/${event.dayNo}`);
        }
        setDays((currentDays) => {
          const existing = currentDays.find((d) => d.dayNo === event.dayNo);
          if (existing && existing.status !== event.status) {
            return replaceDay(currentDays, { ...existing, status: event.status });
          }
          return currentDays;
        });
      }
    });
  }, [monthId]);

  const isSelectedLiveDay = isLiveDay(monthId, selectedDay, now);
  const selectedDayReopenActive = isReopenActive(selectedDayInput, now);
  const isSelectedDayClosed = isOperationalDayClosed(selectedDayInput, now.getTime());
  const canAdminEditSelectedExpenseDay = role === "admin" && (
    isSelectedLiveDay ||
    !isSelectedDayClosed ||
    isAdminEditableReopenedDay(selectedDayInput, now.getTime())
  );

  function currentMonthRecord(): MonthRecord {
    return (
      months.find((month) => month.id === monthId) ??
      createMonth(monthId, calculatedOpeningBalance, calculatedOwnerOpeningBalance)
    );
  }

  async function saveDay(day: DailyLedgerInput, options: SaveDayOptions = {}) {
    const dayKey = `${monthId}/${day.dayNo}`;
    const currentDay = days.find((entry) => entry.dayNo === day.dayNo);
    if (closedExpenseDayKeysRef.current.has(dayKey) || (currentDay?.lockedAt && !isReopenActive(currentDay, now))) {
      const message = `Day ${day.dayNo} is closed. Reopen it before saving.`;
      if (!options.silent) setStatus(message);
      throw new Error(message);
    }
    if (!roleCan(role, "daily")) {
      const message = "Your role can view this month but cannot edit daily entries.";
      setStatus(message);
      throw new Error(message);
    }
    if (role === "admin" && !canAdminEditSelectedExpenseDay) {
      const message = "Admins can only edit an open operational day or an owner-reopened day.";
      setStatus(message);
      throw new Error(message);
    }

    if (isPostgreSqlPeriod(monthId)) {
      if (!pgPeriodRouting.checked || pgPeriodRouting.status !== "INITIALIZED") {
        const message = `Cannot save: Accounting period ${formatMonth(monthId)} is not initialized in PostgreSQL.`;
        if (!options.silent) setStatus(message);
        throw new Error(message);
      }
      if (!days.some((entry) => entry.dayNo === day.dayNo)) {
        const message = `Cannot save: Accounting day ${day.dayNo} is not resolved for ${formatMonth(monthId)}.`;
        if (!options.silent) setStatus(message);
        throw new Error(message);
      }
      try {
        const saveRes = await saveExpenseDayPostgres(monthId, day);
        const rehydratedDay = saveRes.rehydratedDay ?? day;
        const nextDays = replaceDay(days, rehydratedDay);
        const nextComputed = computeMonth(nextDays, calculatedOpeningBalance, monthId, calculatedOwnerOpeningBalance, expenseCarryForwardSeed ?? undefined);
        setDays(nextDays);
        setComputed(nextComputed);
        if (!options.silent) setStatus(`Saved ${day.label ?? `Day ${day.dayNo}`} to PostgreSQL.`);
        return;
      } catch (pgErr) {
        const message = pgErr instanceof Error ? pgErr.message : "Failed to save day to PostgreSQL.";
        if (!options.silent) setStatus(message);
        throw new Error(message);
      }
    }

    const nextDays = replaceDay(days, day);
    const nextComputed = computeMonth(nextDays, calculatedOpeningBalance, monthId, calculatedOwnerOpeningBalance, expenseCarryForwardSeed ?? undefined);
    setDays(nextDays);
    setComputed(nextComputed);

    const write = queueDayAndSummaryWrite(currentMonthRecord(), day, nextComputed);
    if (options.awaitRemote) {
      const wrote = await handleQueuedWrite(write, "Could not save day to Firestore.");
      if (!wrote) throw new Error("Firestore did not confirm the day save.");
      if (!options.silent) setStatus(`Saved ${day.label ?? `Day ${day.dayNo}`} to Firestore.`);
      return;
    }
    void handleQueuedWrite(write, "Could not queue day save.");
    if (!options.silent) setStatus(`Saved ${day.label ?? `Day ${day.dayNo}`} locally. Firestore will sync automatically.`);
  }

  async function closeDay(day: DailyLedgerInput) {
    if (day.dayNo === 32) {
      if (isPostgreSqlPeriod(monthId)) {
        if (role !== "owner") {
          const message = "Only owner can verify FINAL month-end settlement.";
          setStatus(message);
          throw new Error(message);
        }
        try {
          const periodData = await getAccountingPeriodWithDays(monthId);
          if (!periodData) throw new Error("Period not found.");
          await ledgerApiClient.periods.verifyFinalSettlement(periodData.period.id);
          setPeriodFinalSettlementStatus("VERIFIED");
          const rehydrated = await loadExpenseDayPostgres(monthId, 32);
          if (rehydrated) {
            setDays((currentDays) => replaceDay(currentDays, rehydrated));
          }
          await getAccountingPeriodWithDays(monthId, true);
          setStatus("FINAL month-end settlement formally verified.");
          setMonthCloseModal({
            isOpen: true,
            step: "prompt",
            errorMessage: null
          });
          return;
        } catch (err: any) {
          const message = err.message || "Failed to verify FINAL.";
          setStatus(message);
          throw new Error(message);
        }
      }
      setStatus("FINAL is a month-end closing snapshot and is already closed.");
      return;
    }
    if (isPostgreSqlPeriod(monthId)) {
      if (!roleCan(role, "daily") || (role !== "owner" && role !== "admin")) {
        setStatus("Your role can view this month but cannot close days.");
        return;
      }
      try {
        await closeOperationalDayUnified({
          monthId,
          dayNo: day.dayNo,
          flushDraft: hasPendingDayChanges && expenseManualSaveRef.current
            ? () => expenseManualSaveRef.current!()
            : undefined
        });
        closedExpenseDayKeysRef.current.add(`${monthId}/${day.dayNo}`);
        setDays((currentDays) => replaceDay(currentDays, { ...day, status: "closed" }));
        setStatus(`Day ${day.dayNo} successfully closed in PostgreSQL authoritative ledger.`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to close day in PostgreSQL.";
        setStatus(`Error closing day: ${msg}`);
        return;
      }
    }
    if (!roleCan(role, "daily")) {
      setStatus("Your role can view this month but cannot close days.");
      return;
    }
    const timestamp = Date.now();
    const dayKey = `${monthId}/${day.dayNo}`;
    const lockedDay = {
      ...day,
      status: "closed" as const,
      manualOverride: true,
      lockedAt: timestamp,
      lockedBy: user?.uid,
      lockedByRole: role ?? undefined,
      reopenedUntilAt: undefined,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedByRole: undefined
    };
    closedExpenseDayKeysRef.current.add(dayKey);
    const nextDays = replaceDay(days, lockedDay);
    const nextComputed = computeMonth(nextDays, calculatedOpeningBalance, monthId, calculatedOwnerOpeningBalance, expenseCarryForwardSeed ?? undefined);
    setDays(nextDays);
    setComputed(nextComputed);
    const wrote = await handleQueuedWrite(
      queueDayAndSummaryWrite(currentMonthRecord(), lockedDay, nextComputed, "lock-day"),
      "Could not queue day close."
    );
    if (!wrote) {
      closedExpenseDayKeysRef.current.delete(dayKey);
      setDays((currentDays) => replaceDay(currentDays, day));
      setComputed(computeMonth(replaceDay(nextDays, day), calculatedOpeningBalance, monthId, calculatedOwnerOpeningBalance, expenseCarryForwardSeed ?? undefined));
      return;
    }
    setStatus(`Closed ${day.label ?? `Day ${day.dayNo}`} locally. Firestore will sync automatically.`);
  }

  async function sendDailyEmail(day: DailyLedgerInput) {
    if (!roleCan(role, "ownerControls")) {
      setStatus("Email reports are restricted to owner access.");
      throw new Error("Email reports are restricted to owner access.");
    }
    setStatus(`Sending email report for ${day.label ?? `Day ${day.dayNo}`}...`);
    await sendManualActivityEmail(monthId, day.dayNo);
    setStatus(`Email report sent for ${day.label ?? `Day ${day.dayNo}`}.`);
  }

  async function sendMonthEmail() {
    if (!roleCan(role, "ownerControls")) {
      setStatus("Email reports are restricted to owner access.");
      return;
    }
    setMonthEmailing(true);
    setStatus(`Sending email report for ${formatMonth(monthId)}...`);
    try {
      await sendManualActivityEmail(monthId);
      setStatus(`Email report sent for ${formatMonth(monthId)}.`);
    } finally {
      setMonthEmailing(false);
    }
  }

  async function reopenDay(dayNo: number) {
    if (dayNo === 32) {
      setStatus("FINAL is a month-end closing snapshot and cannot be reopened. Reopen an operational day (such as Day 31) to make corrections.");
      return;
    }
    if (isPostgreSqlPeriod(monthId)) {
      if (!canReopenOperationalDay({ role, isLiveDay: isLiveDay(monthId, dayNo, now) })) {
        setStatus("Only owner can reopen days.");
        return;
      }
      try {
        await reopenOperationalDayUnified({
          monthId,
          dayNo,
          reason: "Governed UI day reopen"
        });
        closedExpenseDayKeysRef.current.delete(`${monthId}/${dayNo}`);
        setStatus(`Day ${dayNo} successfully reopened in PostgreSQL authoritative ledger.`);
        setDays((currentDays) => {
          const d = currentDays.find((entry) => entry.dayNo === dayNo) ?? emptyDay(dayNo);
          return replaceDay(currentDays, { ...d, status: "reopen" });
        });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to reopen day in PostgreSQL.";
        setStatus(`Error reopening day: ${msg}`);
        return;
      }
    }
    if (!canReopenOperationalDay({ role, isLiveDay: isLiveDay(monthId, dayNo, now) })) {
      setStatus("Only owner can reopen days.");
      return;
    }
    const day = days.find((entry) => entry.dayNo === dayNo) ?? emptyDay(dayNo);
    closedExpenseDayKeysRef.current.delete(`${monthId}/${dayNo}`);
    const reopenedDay = {
      ...day,
      status: "reopen" as const,
      manualOverride: true,
      lockedAt: undefined,
      lockedBy: undefined,
      lockedByRole: undefined,
      reopenedUntilAt: undefined,
      reopenedAt: Date.now(),
      reopenedBy: user?.uid,
      reopenedByRole: role ?? undefined
    };
    setDays((currentDays) => replaceDay(currentDays, reopenedDay));
    handleQueuedWrite(
      reopenPreviousDayUntilClose(monthId, dayNo, role),
      "Could not queue day reopen."
    );
    setStatus(
      `Day ${dayNo} reopened locally until you close it again. Firestore will sync automatically.`
    );
  }

  async function reopenMonthDays(scope: "selected" | "all") {
    if (isPostgreSqlPeriod(monthId)) {
      setStatus("Bulk day actions for PostgreSQL operational periods are managed through PostgreSQL governance workflows.");
      return;
    }
    if (role !== "owner") {
      setStatus("Only owner can reopen selected or all days for a month.");
      return;
    }
    if (isClosed) {
      setStatus("Reopen the month before reopening its days.");
      return;
    }
    if (scope === "selected" && selectedDay === 32) {
      setStatus("The final correction period cannot be reopened with this action.");
      return;
    }
    if (hasPendingDayChanges && !confirmLeavePendingChanges()) {
      setStatus("Stayed on the current day because changes are still pending save.");
      return;
    }
    if (scope === "selected") {
      if (!selectedDayLocked) {
        setStatus("Only closed days can be reopened.");
        return;
      }
      await reopenDay(selectedDay);
      return;
    }

    const dayNumbers = availableDayNumbers(monthId, now).filter((dayNo) => {
      const day = days.find((entry) => entry.dayNo === dayNo);
      return day?.status === "closed" || Boolean(day?.lockedAt);
    });
    const reopenAt = Date.now();
    const nextReopenedDays = dayNumbers.map((dayNo) => {
      const existing = days.find((entry) => entry.dayNo === dayNo);
      return {
        ...dayWithMonthDate(monthId, dayNo, existing),
        status: "reopen" as const,
        manualOverride: true,
        reopenedUntilAt: undefined,
        reopenedAt: reopenAt,
        reopenedBy: user?.uid,
        reopenedByRole: role
      };
    });
    nextReopenedDays.forEach((day) => closedExpenseDayKeysRef.current.delete(`${monthId}/${day.dayNo}`));

    if (nextReopenedDays.length === 0) {
      setStatus("No closed previous days are available to reopen for this month.");
      return;
    }

    setBulkReopening(scope);
    setDays((currentDays) => nextReopenedDays.reduce((nextDays, day) => replaceDay(nextDays, day), currentDays));
    try {
      await handleQueuedWrite(
        reopenMonthDaysUntilClose(monthId, nextReopenedDays, role),
        "Could not queue month day reopen."
      );
      const dayText = `${nextReopenedDays.length} days`;
      setStatus(`${dayText} reopened locally until manually closed. Firestore will sync automatically.`);
    } finally {
      setBulkReopening(null);
    }
  }

  function closeAllDaysExceptToday() {
    if (isPostgreSqlPeriod(monthId)) {
      setStatus("Bulk day actions for PostgreSQL operational periods are managed through PostgreSQL governance workflows.");
      return;
    }
    if (role !== "owner") {
      setStatus("Only owner can close all days for a month.");
      return;
    }
    if (isClosed) {
      setStatus("Reopen the month before closing its days.");
      return;
    }
    if (hasPendingDayChanges && !confirmLeavePendingChanges()) {
      setStatus("Stayed on the current day because changes are still pending save.");
      return;
    }
    const liveDate = currentDateState(now);
    const dayNumbers = availableDayNumbers(monthId, now).filter((dayNo) => !(monthId === liveDate.monthId && dayNo === liveDate.dayNo));
    const timestamp = Date.now();
    const nextClosedDays = dayNumbers.flatMap((dayNo) => {
        const existing = days.find((entry) => entry.dayNo === dayNo);
        if (existing?.lockedAt && !isReopenActive(existing, now)) return [];
        const day: DailyLedgerInput = {
          ...dayWithMonthDate(monthId, dayNo, existing),
          status: "closed" as const,
          manualOverride: true,
          lockedAt: timestamp,
          lockedBy: user?.uid,
          lockedByRole: role ?? undefined,
          reopenedUntilAt: undefined,
          reopenedAt: undefined,
          reopenedBy: undefined,
          reopenedByRole: undefined
        };
        return [day];
      });

    if (nextClosedDays.length === 0) {
      setStatus("No open previous days are available to close for this month.");
      return;
    }
    const nextDays = nextClosedDays.reduce((updatedDays, day) => replaceDay(updatedDays, day), days);
    nextClosedDays.forEach((day) => closedExpenseDayKeysRef.current.add(`${monthId}/${day.dayNo}`));
    const nextComputed = computeMonth(nextDays, calculatedOpeningBalance, monthId, calculatedOwnerOpeningBalance, expenseCarryForwardSeed ?? undefined);
    setBulkClosingDays(true);
    setDays(nextDays);
    setComputed(nextComputed);
    try {
      void handleQueuedWrite(
        closeMonthDaysExceptToday(currentMonthRecord(), nextClosedDays, nextComputed, role),
        "Could not queue close-all-days action."
      );
      setStatus(`Closed ${nextClosedDays.length} day${nextClosedDays.length === 1 ? "" : "s"} except today locally. Firestore will sync automatically.`);
    } finally {
      setBulkClosingDays(false);
    }
  }

  async function handleWorkbook(file: File | null) {
    if (!file) return;
    if (!canUseExcelImport) {
      setStatus("Only owner can import Excel workbooks.");
      return;
    }
    setLoadingMessage(`Parsing ${file.name}...`);
    setLoading(true);
    setStatus("Parsing workbook...");
    try {
      const preview = await parseWorkbookFile(file, importMonthId, { importType });
      setImportPreview(preview);
      const importLabel = importType === "full" ? "full workbook" : "expense-only";
      setStatus(`Parsed ${preview.days.length} ${importLabel} periods for ${formatMonth(importMonthId)} from ${file.name}. Review before saving.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not parse workbook.");
    } finally {
      setLoading(false);
    }
  }

  async function commitImport() {
    if (!importPreview) return;
    if (!roleCan(role, "importBackup")) {
      setStatus("Workbook import is restricted to owner access.");
      return;
    }
    setLoadingMessage(`Saving ${importPreview.fileName} to Firestore...`);
    setLoading(true);
    try {
      const nextComputed = await commitWorkbookImport(importPreview);
      setMonthId(importPreview.monthId);
      setOpeningBalance(importPreview.openingBalance);
      setDays(importPreview.days);
      setComputed(nextComputed);
      setMonthStatusState("open");
      setImportPreview(null);
      setView("dashboard");
      await refreshMonthList();
      setStatus(`Imported ${importPreview.importType === "full" ? "full workbook" : "expense-only workbook"} into Firestore.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save import.");
    } finally {
      setLoading(false);
    }
  }

  async function recalc() {
    if (!roleCan(role, MASTER_REFRESH_ACCESS)) {
      setStatus("Manual recalculation is restricted to owner/admin access.");
      return;
    }
    const adapter = createExpenseRecalculationAdapter({
      monthId,
      canRun: roleCan(role, MASTER_REFRESH_ACCESS),
      disabledReason: "Only owner/admin can run Expense master refresh.",
      run: async (emit) => {
        emit({ step: "Loading month data and recalculating daily balances locally..." });
        await recalculateMonth(monthId);
        emit({ step: "Loading recalculated records..." });
        const records = await refreshMonthList();
        const refreshedMonth = records.find((month) => month.id === monthId);
        const nextDays = await fetchMonthDays(monthId, { readDecision: expenseReadDecision });
        const carryForwardSeed = await resolveExpenseCarryForwardSeed(monthId);
        const repairedOpeningBalance = refreshedMonth?.openingBalance ?? carryForwardSeed?.openingBalance ?? openingBalance;
        const repairedOwnerOpeningBalance = refreshedMonth?.ownerOpeningBalance ?? carryForwardSeed?.ownerOpeningBalance ?? ownerOpeningBalance;
        const nextComputed = computeMonth(nextDays, repairedOpeningBalance, monthId, repairedOwnerOpeningBalance, carryForwardSeed ?? undefined);
        setExpenseCarryForwardSeed(carryForwardSeed);
        setOpeningBalance(repairedOpeningBalance);
        setOwnerOpeningBalance(repairedOwnerOpeningBalance);
        setDays(nextDays);
        setComputed(nextComputed);
        emit({ step: "Completed successfully." });
        return {
          daysChecked: nextDays.length,
          mismatchesCorrected: nextDays.length,
          monthlySummariesUpdated: 1,
          message: "Day openings now follow the previous closing balance."
        };
      }
    });
    try {
      const result = await runMasterRecalculation({
        adapter,
        confirm: () => window.confirm("This will recalculate balances and summaries. Manual entries will not be changed. Continue?"),
        onStart: () => {
          setLoadingMessage(`Recalculating ${formatMonth(monthId)}...`);
          setLoading(true);
          setMasterRefreshModal({
            open: true,
            title: `Refreshing Expense calculations for ${formatMonth(monthId)}`,
            currentStep: "Preparing recalculation...",
            progress: [{ step: "Preparing recalculation..." }]
          });
        },
        onProgress: (progress) => {
          setMasterRefreshModal((current) => ({
            ...current,
            currentStep: progress.step,
            progress: [...current.progress, progress]
          }));
        },
        onComplete: (nextResult) => {
          setMasterRefreshModal((current) => ({
            ...current,
            currentStep: "Completed successfully.",
            result: nextResult
          }));
        }
      });
      if (result) setStatus("Master refresh complete. Day openings now follow the previous closing balance.");
    } catch (err) {
      setMasterRefreshModal((current) => ({
        ...current,
        error: err instanceof Error ? err.message : "Could not recalculate."
      }));
      setStatus(err instanceof Error ? err.message : "Could not recalculate.");
    } finally {
      setLoading(false);
    }
  }

  async function triggerMasterRefresh(adapter: MasterRecalculationAdapter, title: string) {
    try {
      const result = await runMasterRecalculation({
        adapter,
        confirm: () => window.confirm("This will recalculate balances and summaries. Manual entries will not be changed. Continue?"),
        onStart: () => {
          setLoadingMessage(`Recalculating ${title}...`);
          setLoading(true);
          setMasterRefreshModal({
            open: true,
            title: `Refreshing ${title} calculations for ${formatMonth(monthId)}`,
            currentStep: "Preparing recalculation...",
            progress: [{ step: "Preparing recalculation..." }]
          });
        },
        onProgress: (progress) => {
          setMasterRefreshModal((current) => ({
            ...current,
            currentStep: progress.step,
            progress: [...current.progress, progress]
          }));
        },
        onComplete: (nextResult) => {
          setMasterRefreshModal((current) => ({
            ...current,
            currentStep: "Completed successfully.",
            result: nextResult
          }));
        }
      });
      if (result) setStatus(`Master refresh complete. ${title} openings now follow the previous closing balance.`);
    } catch (err) {
      setMasterRefreshModal((current) => ({
        ...current,
        error: err instanceof Error ? err.message : "Could not recalculate."
      }));
      setStatus(err instanceof Error ? err.message : "Could not recalculate.");
    } finally {
      setLoading(false);
    }
  }

  async function handleGuidedCloseMonth() {
    if (!isPostgreSqlPeriod(monthId)) {
      setStatus("Guided month close is only supported for PostgreSQL periods.");
      return;
    }
    if (!roleCan(role, "ownerControls")) {
      const msg = "Closing periods is restricted to owner access.";
      setStatus(msg);
      setMonthCloseModal((prev) => ({
        ...prev,
        isOpen: true,
        step: "prompt",
        errorMessage: msg
      }));
      return;
    }

    setMonthClosing(true);
    setMonthCloseModal((prev) => ({
      ...prev,
      isOpen: true,
      errorMessage: null
    }));

    try {
      const periodData = await getAccountingPeriodWithDays(monthId);
      if (!periodData) {
        throw new Error(`Cannot close period: ${monthId} not initialized in PostgreSQL.`);
      }

      const closeRes = await ledgerApiClient.periods.closePeriod(periodData.period.id);
      setMonthStatusState("closed");
      clearPeriodCache();
      if (closeRes.targetPeriod?.periodKey) {
        registerPostgreSqlPeriod(closeRes.targetPeriod.periodKey);
        registerInitializedPeriod(closeRes.targetPeriod.periodKey);
        await getAccountingPeriodWithDays(closeRes.targetPeriod.periodKey, true);
      }
      await getAccountingPeriodWithDays(monthId, true);
      await refreshMonthList();

      const successMsg = `Period ${formatMonth(monthId)} closed in PostgreSQL authoritative ledger.`;
      setStatus(successMsg);

      setMonthCloseModal({
        isOpen: true,
        step: "success",
        errorMessage: null
      });
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : (err?.message || "Failed to close accounting period.");
      setStatus(`Cannot close month: ${errorMsg}`);
      setMonthCloseModal({
        isOpen: true,
        step: "prompt",
        errorMessage: errorMsg
      });
    } finally {
      setMonthClosing(false);
    }
  }

  function handleNotNowMonthClose() {
    setMonthCloseModal((prev) => ({ ...prev, isOpen: false, errorMessage: null }));
  }

  function handleProceedToNextMonth() {
    setMonthCloseModal((prev) => ({ ...prev, isOpen: false, errorMessage: null }));
    const { nextPeriodKey } = getNextPeriodKey(monthId);
    void loadMonth(nextPeriodKey, { targetDay: 1 });
  }

  async function handleInitializeNextPeriod(sourceMonthKey?: string) {
    if (!roleCan(role, "ownerControls")) {
      setStatus("Initializing accounting periods is restricted to owner access.");
      return;
    }

    const sourceKey = sourceMonthKey || (isPeriodUninitialized ? "2026-08" : monthId);
    const targetKey = getNextPeriodKey(sourceKey).nextPeriodKey;

    setInitializingNextPeriod(true);
    setLoadingMessage(`Initializing ${formatMonth(targetKey)} from ${formatMonth(sourceKey)} FINAL...`);
    setLoading(true);

    try {
      const sourcePeriodData = await getAccountingPeriodWithDays(sourceKey);
      if (!sourcePeriodData) {
        throw new Error(`Cannot initialize: Source period ${sourceKey} not found in PostgreSQL.`);
      }

      const initRes = await ledgerApiClient.periods.initializeNextPeriod(sourcePeriodData.period.id);

      // Clear old period cache before loading the new period
      clearPeriodCache();

      const targetPeriodKey = initRes.targetPeriod?.periodKey || targetKey;
      registerPostgreSqlPeriod(targetPeriodKey);
      registerInitializedPeriod(targetPeriodKey);

      await refreshMonthList();
      await getAccountingPeriodWithDays(targetPeriodKey, true);

      setStatus(`Accounting period ${formatMonth(targetPeriodKey)} initialized successfully. Day 1 is OPEN.`);
      await loadMonth(targetPeriodKey, { targetDay: 1 });
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : (err?.message || "Failed to initialize next period.");
      setStatus(`Cannot initialize period: ${errorMsg}`);
      alert(`Cannot initialize period: ${errorMsg}`);
    } finally {
      setInitializingNextPeriod(false);
      setLoading(false);
    }
  }

  async function toggleClosed() {
    if (isPostgreSqlPeriod(monthId)) {
      if (!roleCan(role, "ownerControls")) {
        setStatus("Closing and reopening periods is restricted to owner access.");
        return;
      }
      if (monthStatus === "open") {
        await handleGuidedCloseMonth();
      } else {
        const { nextPeriodKey } = getNextPeriodKey(monthId);
        const nextPeriodUninitialized = !months.some((m) => m.id === nextPeriodKey);
        if (nextPeriodUninitialized) {
          await handleInitializeNextPeriod(monthId);
        } else {
          setStatus("Reopening a closed PostgreSQL period requires governed correction/rollover workflows.");
        }
      }
      return;
    }
    if (!roleCan(role, "ownerControls")) {
      setStatus("Closing and reopening months is restricted to owner access.");
      return;
    }
    const nextStatus = monthStatus === "open" ? "closed" : "open";
    setLoadingMessage(`${nextStatus === "closed" ? "Closing" : "Reopening"} ${formatMonth(monthId)}...`);
    setLoading(true);
    try {
      await setMonthStatus(monthId, nextStatus);
      setMonthStatusState(nextStatus);
      await refreshMonthList();
      setStatus(nextStatus === "closed" ? "Month closed in Firestore." : "Month reopened in Firestore.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not update month status.");
    } finally {
      setLoading(false);
    }
  }

  async function toggleJazzLoadClosed() {
    if (!roleCanJazzLoad(role, "monthControls")) {
      setStatus("Closing and reopening Jazz Load months is restricted to owner access.");
      return;
    }
    const jazzLoadMonth = jazzLoadMonths.find((record) => record.id === monthId);
    if (!jazzLoadMonth) {
      setStatus("Jazz Load month is not loaded yet.");
      return;
    }
    const nextStatus = jazzLoadMonth.status === "open" ? "closed" : "open";
    setLoadingMessage(`${nextStatus === "closed" ? "Closing" : "Reopening"} Jazz Load ${formatMonth(monthId)}...`);
    setLoading(true);
    try {
      await setJazzLoadMonthStatus(jazzLoadMonth, nextStatus, user, role);
      await refreshMonthList();
      setStatus(`Jazz Load month ${nextStatus === "closed" ? "closed" : "reopened"} in Firestore.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not update Jazz Load month status.");
    } finally {
      setLoading(false);
    }
  }

  async function exportBackup() {
    if (!roleCan(role, "importBackup")) {
      setStatus("Backup export is restricted to owner access.");
      return;
    }
    setLoadingMessage("Preparing backup package...");
    setLoading(true);
    try {
      const records = await refreshMonthList();
      const backedUpMonths = [];
      for (const month of records) {
        backedUpMonths.push({ ...month, days: await fetchMonthDays(month.id) });
      }
      const jazzLoad = await listJazzLoadBackup();
      exportBackupPackage(
        { exportedAt: Date.now(), months: backedUpMonths, jazzLoad } satisfies BackupPackage,
        `franchise-backup-${new Date().toISOString().slice(0, 10)}.json`
      );
      setStatus("Backup package exported.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not export backup.");
    } finally {
      setLoading(false);
    }
  }

  async function importBackup(file: File | null) {
    if (!file) return;
    if (!roleCan(role, "importBackup")) {
      setStatus("Backup restore is restricted to owner access.");
      return;
    }
    setLoadingMessage(`Importing backup ${file.name}...`);
    setLoading(true);
    try {
      const backup = (await readBackupPackage(file)) as BackupPackage;
      for (const month of backup.months ?? []) {
        const { days: backupDays, ...record } = month;
        await saveMonthRecord(record, backupDays ?? [], { suppressPerDayAudit: true });
      }
      await writeExpenseBackupRestoreAudit((backup.months ?? []).length);
      if (backup.jazzLoad) {
        await restoreJazzLoadBackup(backup.jazzLoad, user, role);
      }
      await refreshMonthList();
      setStatus(`Imported ${(backup.months ?? []).length} months and Jazz Load data from backup package.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not import backup package.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!role) return;
    if (!canAccessView(role, view)) {
      setView("dashboard");
      setStatus("Owner only. This section is restricted to owner access.");
    }
  }, [role, view]);

  useEffect(() => {
    if (role !== "owner" && ownerOnlyExpenseSections.has(expenseSection)) {
      setExpenseSection("daily-entry");
      setStatus("Owner only. Expense settings are restricted to owner access.");
    }
  }, [expenseSection, role]);

  const expenseCalendarDays = useMemo<UniversalDaySnapshot[]>(() => {
    const list: UniversalDaySnapshot[] = Array.from({ length: daysInMonth(monthId) }, (_, index) => {
      const dayNo = index + 1;
      const day = days.find((entry) => entry.dayNo === dayNo);
      const future = !availableDayNumbers(monthId, now).includes(dayNo);
      const live = isLiveDay(monthId, dayNo, now);
      const statusValue = resolveUniversalDayStatus({
        exists: Boolean(day),
        future,
        live,
        day,
        nowMs: now.getTime()
      });
      return {
        moduleKey: "expense",
        monthId,
        dayNo,
        status: statusValue,
        future,
        saved: Boolean(day),
        dateLabel: dateLabelFor(monthId, dayNo),
        reopenedUntilAt: day?.reopenedUntilAt,
        reopenedAt: day?.reopenedAt,
        disabledReason: future ? "Future days are disabled and cannot create records." : undefined
      };
    });
    if (canUseFinalPeriod(monthId, now)) {
      const finalDayEntry = days.find((d) => d.dayNo === 32);
      const isFinalClosed = finalDayEntry?.status === "closed";
      list.push({
        moduleKey: "expense",
        monthId,
        dayNo: 32,
        status: (finalDayEntry?.status as any) ?? "open",
        future: false,
        saved: true,
        dateLabel: `FINAL - ${formatMonth(monthId)}`,
        disabledReason: isFinalClosed ? "FINAL is verified and closed." : undefined
      });
    }
    return list;
  }, [days, monthId, now]);
  const monthChoices = useMemo(() => {
    const periodMap = new Map<string, string>();
    // 1. August 2026 genesis period is always present and authoritative
    const augRecord = months.find((m) => m.id === "2026-08");
    periodMap.set("2026-08", augRecord?.status ?? "open");

    // 2. All initialized periods from PostgreSQL
    for (const m of months) {
      if (m.id >= "2026-08") {
        periodMap.set(m.id, m.status);
      }
    }

    // 3. Current active monthId if >= 2026-08
    if (monthId >= "2026-08" && !periodMap.has(monthId)) {
      periodMap.set(monthId, "uninitialized");
    }

    // 4. September 2026 (for uninitialized lifecycle testing)
    if (!periodMap.has("2026-09")) {
      periodMap.set("2026-09", "uninitialized");
    }

    return Array.from(periodMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [monthId, months]);
  const selectedExpenseStatus = expenseCalendarDays.find((day) => day.dayNo === selectedDay)?.status ?? "closed";
  const topActivityActive = loading || isAutosaving || syncState === "syncing" || pageActivityLoading || authBusy || !authReady;
  const topActivityLabel = loading
    ? loadingMessage
    : isAutosaving
      ? "Saving changes..."
      : syncState === "syncing"
        ? "Syncing changes..."
        : pageActivityLoading
          ? "Loading data..."
          : authBusy || !authReady
            ? "Checking access..."
            : "";

  if (!authReady || !user || !role || !calendarSelectionReady) {
    return (
      <>
        <TopActivityProgress active={topActivityActive} label={topActivityLabel} />
        <AuthPanel
          message={authMessage || authStatus}
          busy={authBusy || !authReady}
          onSubmit={handleAuthLogin}
        />
      </>
    );
  }

  const currentExpenseMonth = months.find((month) => month.id === monthId);
  const expenseCarryForwardWarningList = expenseCarryForwardWarnings(currentExpenseMonth, days, expenseCarryForwardSeed, { day1LoadError });
  const expenseOpeningMismatchCount = expenseCarryForwardWarningList.length;
  const isPeriodRoutingPending = isPostgreSqlPeriod(monthId) && (!pgPeriodRouting.checked || loading);
  const isPeriodUninitialized = isPostgreSqlPeriod(monthId) && pgPeriodRouting.checked && pgPeriodRouting.status === "UNINITIALIZED";
  const isClosed = !isPeriodUninitialized && monthStatus === "closed";
  const isSelectedCanonicalReopen = selectedDayInput.status === "reopen";
  const isSelectedCanonicalOpen = selectedDayInput.status === "open";
  const isSelectedCanonicalClosed = selectedDayInput.status === "closed";
  const isSelectedLegacyLocked =
    !isSelectedCanonicalReopen &&
    !isSelectedCanonicalOpen &&
    (
      selectedDayInput.closedAt != null ||
      selectedDayInput.lockedAt != null ||
      selectedDayInput.reopenedUntilAt != null
    );
  const selectedDayLocked =
    isSelectedCanonicalClosed ||
    isSelectedLegacyLocked;
  const isSelectedDayPresent = days.some((entry) => entry.dayNo === selectedDay);
  const canEditDaily = roleCan(role, "daily") && !isClosed && !isPeriodUninitialized && !isPeriodRoutingPending;
  const liveDate = currentDateState(now);
  const canEditSelectedDay =
    !isPeriodUninitialized &&
    !isPeriodRoutingPending &&
    isSelectedDayPresent &&
    (selectedDay === 32
      ? (roleCan(role, "daily") && !isClosed && !selectedDayLocked)
      : canEditOperationalDailyEntry({
          role,
          canWriteDaily: roleCan(role, "daily"),
          monthClosed: isClosed,
          isLiveDay: isSelectedLiveDay,
          dayClosed: selectedDayLocked,
          day: selectedDayInput,
          nowMs: now.getTime()
        }));
  const canCloseSelectedDay =
    canEditDaily &&
    (role === "owner" || role === "admin") &&
    !selectedDayLocked;
  const canReopenSelectedDay =
    selectedDay !== 32 &&
    canEditDaily &&
    selectedDayLocked &&
    canReopenOperationalDay({ role, isLiveDay: isSelectedLiveDay }) &&
    !selectedDayReopenActive;
  const selectedDayReopenLabel = "Reopen Until Close";
  const selectedDayComputed = computed?.days.find((day) => day.dayNo === selectedDay);
  const ownerBulkReopenDayCount = availableDayNumbers(monthId, now)
    .filter((dayNo) => {
      const day = days.find((entry) => entry.dayNo === dayNo);
      return day?.status !== "reopen" && (day?.status === "closed" || Boolean(day?.lockedAt || day?.closedAt || day?.reopenedUntilAt));
    })
    .length;
  const canOwnerBulkReopenSelected =
    role === "owner" &&
    canEditDaily &&
    selectedDay !== 32 &&
    !selectedDayReopenActive &&
    selectedDayLocked;
  const canOwnerBulkReopenAll = role === "owner" && canEditDaily && ownerBulkReopenDayCount > 0;
  const canOwnerCloseAllExceptToday = role === "owner" && canEditDaily && ownerBulkReopenDayCount > 0;
  const canManageCatalogs = roleCan(role, "catalogs");
  const canManageUsers = roleCan(role, "users");
  const canUseOwnerControls = roleCan(role, "ownerControls");
  const canSelectDailyDate = role === "owner" || role === "admin";
  const canUseBackup = roleCan(role, "importBackup");
  const canUseExcelImport = role === "owner";
  const jazzLoadMonth = jazzLoadMonths.find((record) => record.id === monthId);
  const canToggleCurrentMonth = roleCan(role, "ownerControls") && canAccessView(role, "expense") && !isPeriodUninitialized;
  const currentMonthStatus = months.find((month) => month.id === monthId)?.status ?? (isPeriodUninitialized ? "uninitialized" : monthStatus);
  const finalDayEntry = days.find((d) => d.dayNo === 32);
  const isFinalClosed = finalDayEntry?.status === "closed" || periodFinalSettlementStatus === "VERIFIED" || periodFinalSettlementStatus === "CLOSED";
  const isMonthCloseRequired = isPostgreSqlPeriod(monthId) && isFinalClosed && currentMonthStatus === "open";
  const { nextPeriodKey } = getNextPeriodKey(monthId);
  const isNextPeriodUninitialized =
    isPostgreSqlPeriod(monthId) &&
    currentMonthStatus === "closed" &&
    isFinalClosed &&
    !months.some((m) => m.id === nextPeriodKey);
  const isMonthCloseAction = currentMonthStatus === "open";
  const handleMonthToggle = view === "jazz-load" ? toggleJazzLoadClosed : toggleClosed;
  const monthToggleLabel = isMonthCloseAction
    ? "Close Month"
    : isNextPeriodUninitialized
    ? `Initialize ${formatMonth(nextPeriodKey)}`
    : "Reopen Month";
  const dateLabel = dateLabelFor(monthId, selectedDay);
  const liveClock = liveClockText(now);
  const selectedDateParts = dateParts(monthId, selectedDay);
  const accessLabel = roleLabel(role);
  const displayName = userDisplayName(user);
  const displayId = userSimpleId(user);
  const v2ShadowModules = [
    ledgerReadModeConfig.expenseReadMode === "v2-shadow" ? "Expense" : null,
    ledgerReadModeConfig.jazzLoadReadMode === "v2-shadow" ? "Jazz Load" : null,
    ledgerReadModeConfig.stockReadMode === "v2-shadow" ? "Stock" : null
  ].filter((item): item is string => Boolean(item));
  const v2ActiveModules = [
    expenseReadDecision.readSource === "v2" ? "Expense" : null,
    jazzLoadReadDecision.readSource === "v2" ? "Jazz Load" : null,
    stockReadDecision.readSource === "v2" ? "Stock" : null
  ].filter((item): item is string => Boolean(item));
  const shadowAllowedRoles = ledgerReadModeConfig.enabledForRoles ?? ["owner", "admin"];
  const showExpenseV2ShadowPanel =
    Boolean(role) &&
    ledgerReadModeConfig.expenseReadMode === "v2-shadow" &&
    ledgerReadModeConfig.hardV2Allowed !== true &&
    shadowAllowedRoles.includes(role as UserRole) &&
    (ledgerReadModeConfig.monthId ?? monthId) === monthId;
  const shellGrid = sidebarOpen ? "lg:grid-cols-[20rem_minmax(0,1fr)]" : "lg:grid-cols-[6rem_minmax(0,1fr)]";
  const shellTone =
    theme === "dark"
      ? "bg-[radial-gradient(circle_at_top_left,#064e3b33,transparent_32rem),linear-gradient(180deg,#020617,#0f172a)] text-slate-100"
      : "theme-light bg-[linear-gradient(180deg,#f8fafc,#e2e8f0)] text-slate-950";
  const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard; show: boolean }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, show: true },
    { id: "expense", label: "Expense", icon: Tags, show: true },
    { id: "jazz-load", label: "Jazz Load", icon: FileSpreadsheet, show: true },
    { id: "stock-ledger", label: "Stock Ledger", icon: PackageOpen, show: true },
    { id: "users", label: "Users", icon: Users, show: canManageUsers },
    { id: "audit-logs", label: "Audit Logs", icon: ScrollText, show: role === "owner" },
    { id: "import", label: "Excel Import", icon: FileSpreadsheet, show: canUseExcelImport },
    { id: "backup", label: "Backup", icon: FileDown, show: canUseBackup }
  ];
  const syncLabel = syncStatusLabel(syncState);
  const showOfflineOwnerWarning = syncState === "offline";
  const currentViewLabel = navItems.find((item) => item.id === view)?.label ?? "Dashboard";
  const mobilePrimaryNav = navItems.filter((item) => item.show).filter((item) => ["dashboard", "expense", "jazz-load", "stock-ledger"].includes(item.id)).slice(0, 4);
  const showRegisteredSidebarControls = view === "jazz-load" || view === "stock-ledger";

  function navigateTo(nextView: View) {
    if (hasPendingDayChanges && nextView !== view && !confirmLeavePendingChanges()) {
      setStatus("Stayed on the current screen because changes are still pending save.");
      return;
    }
    setView(nextView);
    setMobileMenuOpen(false);
  }

  async function saveCatalog(
    catalog: "expenseCategories" | "creditParties" | "commissionCategories",
    item: CatalogItem
  ) {
    if (role !== "owner") {
      setStatus("Only owner can manage Expense settings.");
      return;
    }
    if (isPostgreSqlPeriod(monthId)) {
      try {
        if (catalog === "expenseCategories") {
          const isExisting = item.id && expenseCategories.some((c) => c.id === item.id);
          if (isExisting) {
            const res = await ledgerApiClient.catalogs.updateExpenseCategory(item.id, {
              name: item.name,
              is_active: item.active,
              sort_order: item.sortOrder
            });
            const updated = res.data;
            setExpenseCategories((prev) =>
              prev.map((c) =>
                c.id === updated.id
                  ? { id: updated.id, name: updated.name, active: updated.is_active, sortOrder: updated.sort_order }
                  : c
              )
            );
            setStatus(`${item.name} updated in PostgreSQL catalog.`);
            return;
          }

          const res = await ledgerApiClient.catalogs.createExpenseCategory({
            slug: item.id && !item.id.includes("-") ? item.id : item.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
            name: item.name,
            sort_order: item.sortOrder ?? (expenseCategories.length + 1),
            is_active: item.active ?? true
          });
          const created = res.data;
          setExpenseCategories((prev) => [
            ...prev.filter((c) => c.id !== created.id),
            { id: created.id, name: created.name, active: created.is_active, sortOrder: created.sort_order }
          ]);
          setStatus(`${item.name} saved to PostgreSQL catalog.`);
          return;
        } else if (catalog === "commissionCategories") {
          const isExisting = item.id && commissionCategories.some((c) => c.id === item.id);
          if (isExisting) {
            const res = await ledgerApiClient.catalogs.updateCommissionCategory(item.id, {
              name: item.name,
              is_active: item.active,
              sort_order: item.sortOrder
            });
            const updated = res.data;
            setCommissionCategories((prev) =>
              prev.map((c) =>
                c.id === updated.id
                  ? { id: updated.id, name: updated.name, active: updated.is_active, sortOrder: updated.sort_order }
                  : c
              )
            );
            setStatus(`${item.name} updated in PostgreSQL catalog.`);
            return;
          }

          const res = await ledgerApiClient.catalogs.createCommissionCategory({
            slug: item.id && !item.id.includes("-") ? item.id : item.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
            name: item.name,
            sort_order: item.sortOrder ?? (commissionCategories.length + 1),
            is_active: item.active ?? true
          });
          const created = res.data;
          setCommissionCategories((prev) => [
            ...prev.filter((c) => c.id !== created.id),
            { id: created.id, name: created.name, active: created.is_active, sortOrder: created.sort_order }
          ]);
          setStatus(`${item.name} saved to PostgreSQL catalog.`);
          return;
        } else if (catalog === "creditParties") {
          const isExisting = item.id && creditParties.some((p) => p.id === item.id);
          if (isExisting) {
            const res = await ledgerApiClient.catalogs.updateCreditParty(item.id, {
              name: item.name,
              is_active: item.active,
              sort_order: item.sortOrder
            });
            const updated = res.data;
            setCreditParties((prev) =>
              prev.map((p) =>
                p.id === updated.id
                  ? { id: updated.id, name: updated.name, active: updated.is_active, sortOrder: updated.sort_order }
                  : p
              )
            );
            setStatus(`${item.name} updated in PostgreSQL catalog.`);
            return;
          }

          const res = await ledgerApiClient.catalogs.createCreditParty({
            slug: item.id && !item.id.includes("-") ? item.id : item.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
            name: item.name,
            sort_order: item.sortOrder ?? (creditParties.length + 1),
            is_active: item.active ?? true
          });
          const created = res.data;
          setCreditParties((prev) => [
            ...prev.filter((p) => p.id !== created.id),
            { id: created.id, name: created.name, active: created.is_active, sortOrder: created.sort_order }
          ]);
          setStatus(`${item.name} saved to PostgreSQL catalog.`);
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save catalog item to PostgreSQL.";
        setStatus(msg);
        throw new Error(msg);
      }
    }
    handleQueuedWrite(upsertCatalogItem(catalog, { ...item, active: true }), `Could not queue ${item.name}.`);
    setStatus(`${item.name} saved locally. Firestore will sync automatically.`);
  }

  async function removeCatalogItem(
    catalog: "expenseCategories" | "creditParties" | "commissionCategories",
    itemId: string
  ) {
    if (role !== "owner") {
      setStatus("Only owner can manage Expense settings.");
      return;
    }
    if (isPostgreSqlPeriod(monthId)) {
      try {
        if (catalog === "expenseCategories") {
          const res = await ledgerApiClient.catalogs.deleteExpenseCategory(itemId);
          if (res.data?.soft_deleted) {
            setExpenseCategories((prev) =>
              prev.map((c) => (c.id === itemId ? { ...c, active: false } : c))
            );
            setStatus("Category has existing transactions; marked inactive.");
          } else {
            setExpenseCategories((prev) => prev.filter((c) => c.id !== itemId));
            setStatus("Category deleted from PostgreSQL catalog.");
          }
        } else if (catalog === "commissionCategories") {
          const res = await ledgerApiClient.catalogs.deleteCommissionCategory(itemId);
          if (res.data?.soft_deleted) {
            setCommissionCategories((prev) =>
              prev.map((c) => (c.id === itemId ? { ...c, active: false } : c))
            );
            setStatus("Category has existing transactions; marked inactive.");
          } else {
            setCommissionCategories((prev) => prev.filter((c) => c.id !== itemId));
            setStatus("Category deleted from PostgreSQL catalog.");
          }
        } else if (catalog === "creditParties") {
          const res = await ledgerApiClient.catalogs.deleteCreditParty(itemId);
          if (res.data?.soft_deleted) {
            setCreditParties((prev) =>
              prev.map((p) => (p.id === itemId ? { ...p, active: false } : p))
            );
            setStatus("Credit party has existing transactions; marked inactive.");
          } else {
            setCreditParties((prev) => prev.filter((p) => p.id !== itemId));
            setStatus("Credit party deleted from PostgreSQL catalog.");
          }
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to delete catalog item from PostgreSQL.";
        setStatus(msg);
        throw new Error(msg);
      }
    }
    handleQueuedWrite(deleteCatalogItem(catalog, itemId), `Could not queue ${itemId} delete.`);
    setStatus(`${itemId} deleted locally. Firestore will sync automatically.`);
  }

  async function handleReorderCatalog(
    catalog: "expenseCategories" | "creditParties" | "commissionCategories",
    before: CatalogItem[],
    after: CatalogItem[]
  ) {
    if (role !== "owner") {
      setStatus("Only owner can manage Expense settings.");
      return;
    }
    if (isPostgreSqlPeriod(monthId)) {
      const patches = changedSortOrderPatches(before, after);
      if (patches.length === 0) return;
      try {
        if (catalog === "expenseCategories") {
          await Promise.all(
            patches.map((p) =>
              ledgerApiClient.catalogs.updateExpenseCategory(p.id, { sort_order: p.sortOrder })
            )
          );
        } else if (catalog === "commissionCategories") {
          await Promise.all(
            patches.map((p) =>
              ledgerApiClient.catalogs.updateCommissionCategory(p.id, { sort_order: p.sortOrder })
            )
          );
        } else if (catalog === "creditParties") {
          await Promise.all(
            patches.map((p) =>
              ledgerApiClient.catalogs.updateCreditParty(p.id, { sort_order: p.sortOrder })
            )
          );
        }
        setStatus("Catalog order updated in PostgreSQL.");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to update catalog order in PostgreSQL.";
        setStatus(msg);
        throw new Error(msg);
      }
    }
    handleQueuedWrite(updateCatalogSortOrder(catalog, before, after), "Could not queue sort order update.");
  }

  async function saveUserRole(uid: string, updates: Pick<UserProfile, "role" | "active">) {
    if (role !== "owner") {
      setStatus("Only owner can manage users.");
      return;
    }
    handleQueuedWrite(
      Promise.all([
        updateUserProfile(uid, updates),
        addRoleChangeAudit(monthId, `Updated user ${uid} to ${updates.role} (${updates.active ? "active" : "inactive"})`)
      ]),
      "Could not queue user access update."
    );
    setStatus("User access saved locally. Firestore will sync automatically.");
  }

  async function removeUserProfile(profile: UserProfile) {
    if (role !== "owner") {
      setStatus("Only owner can manage users.");
      return;
    }
    if (profile.uid === user?.uid) {
      setStatus("You cannot delete your own signed-in user profile.");
      return;
    }
    handleQueuedWrite(
      Promise.all([
        deleteUserProfile(profile.uid),
        addRoleChangeAudit(monthId, `Deleted user profile ${profile.email || profile.uid}`)
      ]),
      "Could not queue user delete."
    );
    setStatus(`${profile.email || profile.uid} user profile deleted locally. Firestore will sync automatically.`);
  }

  async function saveAuthorizedEmail(email: string, nextRole: UserRole, active = true) {
    if (role !== "owner") {
      setStatus("Only owner can manage authorized emails.");
      return;
    }
    handleQueuedWrite(
      Promise.all([
        upsertAuthorizedEmail(email, nextRole, active),
        addRoleChangeAudit(monthId, `Authorized email ${emailKey(email)} as ${nextRole} (${active ? "active" : "inactive"})`)
      ]),
      "Could not queue email authorization."
    );
    setStatus(`${emailKey(email)} authorization saved locally. Firestore will sync automatically.`);
  }

  async function removeAuthorizedEmail(entry: AuthorizedEmail) {
    if (role !== "owner") {
      setStatus("Only owner can manage authorized emails.");
      return;
    }
    if (entry.id === emailKey(user?.email ?? "")) {
      setStatus("You cannot delete your own authorized email.");
      return;
    }
    const activeOwnerCount = authorizedEmails.filter((emailEntry) => emailEntry.active && emailEntry.role === "owner").length;
    if (entry.active && entry.role === "owner" && activeOwnerCount <= 1) {
      setStatus("Keep at least one active owner email before deleting this owner.");
      return;
    }
    handleQueuedWrite(
      Promise.all([
        deleteAuthorizedEmail(entry.email),
        addRoleChangeAudit(monthId, `Deleted authorized email ${emailKey(entry.email)}`)
      ]),
      "Could not queue authorized email delete."
    );
    setStatus(`${emailKey(entry.email)} authorization deleted locally. Firestore will sync automatically.`);
  }

  async function saveNotifications(settings: NotificationSettings) {
    if (role !== "owner") {
      setStatus("Only owner can manage notification settings.");
      return;
    }
    handleQueuedWrite(saveNotificationSettings(settings), "Could not queue notification settings.");
    setNotificationSettings(settings);
    setStatus("Notification settings saved locally. Firestore will sync automatically.");
  }

  function runReportExport(action: () => void) {
    try {
      action();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not export report.");
    }
  }

  const showExpenseSidebarControls = view === "expense" && (expenseSection === "daily-entry" || expenseSection === "previous-records");
  const expenseSidebarControls = showExpenseSidebarControls ? (
    <>
      <p className="text-xs font-semibold uppercase text-slate-500">Day Controls</p>
      {/* <p className="mt-1 text-sm font-semibold text-white">{dateLabel}</p> */}
      <UniversalCalendar
        moduleKey="expense"
        monthId={monthId}
        selectedDay={selectedDay}
        days={expenseCalendarDays}
        now={now}
        disabled={expenseSection === "daily-entry" ? !canSelectDailyDate : false}
        showFinal
        canSelectFinal={canUseFinalPeriod(monthId, now)}
        variant="mini"
        onSelect={(nextDay) => {
          if (hasPendingDayChanges && nextDay !== selectedDay && !confirmLeavePendingChanges()) {
            setStatus("Stayed on the current day because changes are still pending save.");
            return;
          }
          setSelectedDay(nextDay);
        }}
      />
      <UniversalDayControlBar
        moduleKey="expense"
        selectedDateLabel={dateLabel}
        selectedMonthLabel={formatMonth(monthId)}
        selectedStatus={selectedExpenseStatus}
        role={role}
        density="compact"
        busy={loading || bulkReopening !== null || bulkClosingDays}
        autoSaveStatus={
          selectedDayLocked
            ? "closed"
            : syncState === "offline" || syncState === "syncing"
              ? "pendingSync"
              : hasPendingDayChanges
                ? "typing"
                : expenseMismatchCount + expenseOpeningMismatchCount > 0
                  ? "pendingRecalculation"
                  : "saved"
        }
        permissions={{
          canCloseSelectedDay: expenseSection === "daily-entry" && (selectedDay === 32 ? role === "owner" : canCloseSelectedDay) && Boolean(user),
          canReopenSelectedDay: selectedDay !== 32 && expenseSection === "daily-entry" && Boolean(user) && (canReopenSelectedDay || canOwnerBulkReopenSelected),
          canReopenAllDays: expenseSection === "daily-entry" && Boolean(user) && canOwnerBulkReopenAll,
          canClosePreviousDaysExceptToday: expenseSection === "daily-entry" && Boolean(user) && canOwnerCloseAllExceptToday,
          canRunMasterRefresh: Boolean(user) && roleCan(role, MASTER_REFRESH_ACCESS),
          closeDisabledReason:
            selectedDayLocked
              ? (selectedDay === 32 ? "FINAL is verified and closed." : "This day is already closed.")
              : (selectedDay === 32 && role !== "owner")
                ? "Only owner can verify FINAL month-end settlement."
                : "This day cannot be closed for your role.",
          reopenDisabledReason:
            selectedDay === 32
              ? "FINAL is a month-end closing snapshot and cannot be reopened. Reopen an operational day (such as Day 31) to make corrections."
              : "Only owner can reopen days.",
          reopenAllDisabledReason: "Only owner can reopen all days.",
          closePreviousDisabledReason: "Only owner can close previous days.",
          masterRefreshDisabledReason: "Only owner/admin can run master refresh."
        }}
        closeDayLabel={selectedDay === 32 ? "Verify & Close FINAL" : "Close Day"}
        onCloseSelectedDay={() => {
          const confirmMsg = selectedDay === 32
            ? "Verify and close FINAL month-end settlement?"
            : `Close ${selectedDayInput.label ?? `Day ${selectedDay}`}?`;
          if (!window.confirm(confirmMsg)) return;
          void closeDay(selectedDayInput);
        }}
        onReopenSelectedDay={() => {
          void reopenDay(selectedDay);
        }}
        onReopenAllDays={() => void reopenMonthDays("all")}
        onClosePreviousDaysExceptToday={closeAllDaysExceptToday}
        onRunMasterRefresh={recalc}
        extraActions={
          <>
            <button
              className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={!computed || !selectedDayComputed}
              onClick={() => computed && runReportExport(() => exportDailyXlsx(computed, selectedDay, selectedDayInput))}
            >
              <FileSpreadsheet />
              Export Daily Excel
            </button>
            <button
              className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={!computed || !selectedDayComputed}
              onClick={() => computed && runReportExport(() => exportDailyPdf(computed, selectedDay, selectedDayInput))}
            >
              <FileDown />
              Export Daily PDF
            </button>
          </>
        }
      />
    </>
  ) : null;

  return (
    <SelectedDateProvider
      value={{
        monthId,
        selectedDay,
        selectedDateKey: selectedDay === 32 ? `${monthId}-FINAL` : `${monthId}-${String(selectedDay).padStart(2, "0")}`,
        setSelectedDay
      }}
    >
    <SidebarDayControlsProvider>
    <main className={`flex min-h-screen flex-col overflow-x-auto ${shellTone}`}>
      {loading && <LoadingPopup message={loadingMessage} />}
      <TopActivityProgress active={topActivityActive} label={topActivityLabel} />
      <MasterCalculationRefreshModal
        state={masterRefreshModal}
        onClose={() => setMasterRefreshModal({ open: false, title: "", progress: [] })}
      />
      <GuidedMonthCloseModal
        isOpen={monthCloseModal.isOpen}
        step={monthCloseModal.step}
        monthId={monthId}
        nextMonthId={getNextPeriodKey(monthId).nextPeriodKey}
        isClosing={monthClosing}
        errorMessage={monthCloseModal.errorMessage}
        onCloseMonth={handleGuidedCloseMonth}
        onNotNow={handleNotNowMonthClose}
        onProceedToNextMonth={handleProceedToNextMonth}
        onDismiss={handleNotNowMonthClose}
      />
      <header className="mobile-topbar lg:hidden">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-emerald-300">{currentViewLabel}</p>
          <h1 className="truncate text-base font-semibold text-white">
            {formatMonth(monthId)} · {currentMonthStatus}
            {isMonthCloseRequired && (
              <span className="ml-2 rounded border border-amber-500/40 bg-amber-500/20 px-2 py-0.5 text-xs font-semibold text-amber-300">
                Month Close Required
              </span>
            )}
          </h1>
          <p className="truncate text-xs text-slate-400">{syncLabel}</p>
        </div>
        <button className="btn-ghost !h-11 !w-11 !px-0" onClick={() => setMobileMenuOpen((open) => !open)} title="Open menu">
          {mobileMenuOpen ? <X /> : <Menu />}
        </button>
      </header>
      {mobileMenuOpen && (
        <section className="mobile-menu-panel lg:hidden">
          <div className="grid grid-cols-1 gap-3">
            <label>
              Active Month
              <select value={monthId} disabled={loading || monthChoices.length === 0} onChange={(event) => void loadMonth(event.target.value)}>
                {monthChoices.map(([id, status]) => (
                  <option key={id} value={id}>
                    {formatMonth(id)} · {status}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Opening Balance
              <input type="text" value={calculatedOpeningBalance.toLocaleString()} disabled readOnly />
            </label>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button className="btn-primary" disabled={loading || !user} onClick={() => void loadMonth(monthId)}>
              {loading && <LoadingIcon label="Loading month" />}
              Load
            </button>
            <button className="btn-secondary" disabled={loading || !user || !canToggleCurrentMonth} onClick={handleMonthToggle}>
              {loading && <LoadingIcon label="Updating month status" />}
              {monthToggleLabel}
            </button>
            <button className="btn-secondary" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
              {theme === "dark" ? <Sun /> : <Moon />}
              Theme
            </button>
            <label className="display-mode-control col-span-2">
              Display Mode
              <select value={uiMode} onChange={(event) => setUiMode(event.target.value as UiMode)}>
                <option value="modern">Modern</option>
                <option value="classic">Classic</option>
              </select>
            </label>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {navItems.filter((item) => item.show && !mobilePrimaryNav.some((primary) => primary.id === item.id)).map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={view === item.id ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => navigateTo(item.id)}>
                  <Icon />
                  {item.label}
                </button>
              );
            })}
          </div>
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-sm font-semibold text-white">{displayName}</p>
            <p className="mt-1 text-xs text-slate-400">ID {displayId} · {accessLabel}</p>
            <p className="mt-2 flex items-center gap-2 text-xs text-slate-400"><Cloud /> {authStatus}</p>
            <button className="btn-secondary mt-3 !w-full" onClick={() => void handleSignOut()}>Sign Out</button>
          </div>
        </section>
      )}
      <div className={`flex-1 lg:grid ${shellGrid}`}>
        <aside className="hidden min-w-0 border-b border-slate-800 bg-slate-950/95 p-3 text-slate-100 sm:p-4 lg:block lg:border-b-0 lg:border-r">
          <div className={`mb-6 flex gap-3 ${sidebarOpen ? "items-start justify-between" : "flex-col items-center"}`}>
            {sidebarOpen && (
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase text-emerald-300">Software</p>
                <h1 className="text-xl font-semibold leading-tight">Jazz Franchise - 7301</h1>
              </div>
            )}
            <div className={`${sidebarOpen ? "flex shrink-0 items-center gap-2" : "flex flex-col items-center gap-2"}`}>
              <button
                className="btn-ghost !h-11 !w-11 !px-0"
                onClick={() => setSidebarOpen((open) => !open)}
                title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
              >
                {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </button>
              <button className="btn-ghost !h-11 !w-11 !px-0" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
                {theme === "dark" ? <Sun /> : <Moon />}
              </button>
              {!sidebarOpen && (
                <button
                  className="btn-ghost !h-11 !w-11 !px-0"
                  onClick={() => setUiMode((mode) => mode === "modern" ? "classic" : "modern")}
                  title={`Display mode: ${uiMode === "modern" ? "Modern" : "Classic"}`}
                >
                  <MonitorCog />
                </button>
              )}
            </div>
          </div>
          <nav className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {navItems.filter((item) => item.show).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`${view === item.id ? "btn-tab btn-tab-active" : "btn-tab"} ${sidebarOpen ? "!h-12 justify-start" : "!h-14 !w-14 !px-0 justify-center [&_svg]:!h-6 [&_svg]:!w-6"}`}
                  onClick={() => navigateTo(item.id)}
                  title={item.label}
                >
                  <Icon />
                  {sidebarOpen && item.label}
                </button>
              );
            })}
          </nav>
          {sidebarOpen && (
            <>
                            {(expenseSidebarControls || showRegisteredSidebarControls) && (
                  <div className="mt-4 border-t border-slate-800 pt-4">
                    {expenseSidebarControls}
                    {showRegisteredSidebarControls && <SidebarDayControlsSlot />}
                  </div>
                )}
              <div className="mt-6 rounded-xl border border-emerald-500/30 bg-slate-900 p-4">
                <p className="text-sm font-semibold uppercase text-emerald-300">Operations</p>
                <p className="mt-2 text-lg font-semibold text-white">{liveClock}</p>
                <div className="mt-4 flex flex-col gap-2 text-sm text-slate-300">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Access</span>
                    <span className="font-medium text-slate-100">{accessLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Month Status</span>
                    <div className="flex items-center gap-2">
                      <span className="font-medium capitalize text-slate-100">{currentMonthStatus}</span>
                      {isMonthCloseRequired && (
                        <span className="rounded border border-amber-500/40 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
                          Close Required
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-4 border-t border-slate-800 pt-4">
                  <p className="text-xs font-semibold uppercase text-slate-500">Month Selection</p>
                  <label className="display-mode-control mt-3">
                    Display Mode
                    <select value={uiMode} onChange={(event) => setUiMode(event.target.value as UiMode)}>
                      <option value="modern">Modern</option>
                      <option value="classic">Classic</option>
                    </select>
                  </label>
                  <label className="mt-3">
                    Active Month
                    <select value={monthId} disabled={loading || monthChoices.length === 0} onChange={(event) => void loadMonth(event.target.value)}>
                      {monthChoices.map(([id, status]) => (
                        <option key={id} value={id}>
                          {formatMonth(id)} · {status}
                        </option>
                      ))}
                    </select>
                  </label>
                  {/* <label className="mt-3">
                    Opening Balance
                    <input type="text" value={calculatedOpeningBalance.toLocaleString()} disabled readOnly />
                  </label> */}
                  <div className="mt-4 flex flex-col gap-2">
                    <button className="btn-primary !h-11 !w-full" disabled={loading || !user} onClick={() => void loadMonth(monthId)}>
                      {loading && <LoadingIcon label="Loading month" />}
                      Load
                    </button>
                    <button className="btn-secondary !h-11 !w-full" disabled={loading || !user || !canToggleCurrentMonth} onClick={handleMonthToggle}>
                      {loading && <LoadingIcon label="Updating month status" />}
                      {monthToggleLabel}
                    </button>
                  </div>
                </div>
                {/* {months.length > 0 && (
                  <div className="mt-4 flex flex-col gap-2">
                    {months.slice(0, 8).map((month) => (
                      <button className={month.id === monthId ? "btn-chip btn-chip-active !h-10 !w-full !justify-start" : "btn-chip !h-10 !w-full !justify-start"} key={month.id} onClick={() => loadMonth(month.id)}>
                        {formatMonth(month.id)} · {month.status}
                      </button>
                    ))}
                  </div>
                )} */}
                </div>
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-semibold uppercase text-slate-500">User</p>
                <p className="mt-2 text-sm font-semibold text-white">{displayName}</p>
                <p className="mt-1 text-sm text-slate-400">ID {displayId} · {accessLabel}</p>
                <p className="mt-4 flex items-center gap-2 text-sm text-slate-400"><Cloud /> {authStatus}</p>
                <p className="mt-3 flex items-center gap-2 text-sm text-slate-400">
                  <Shield /> {syncLabel}
                </p>
                <button className="btn-secondary mt-4 !w-full" onClick={() => void handleSignOut()}>Sign Out</button>
              </div>
            </>
          )}
        </aside>

        <div className="min-w-0 px-3 pb-28 pt-4 sm:px-6 lg:px-8 lg:pb-8">
          {status && <p className="status">{status}</p>}
          {isMonthCloseRequired && (
            <div
              data-testid="month-close-required-banner"
              className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-100 shadow-lg shadow-black/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                  <div>
                    <h3 className="font-semibold text-amber-300">Month Open — Month Close Required</h3>
                    <p className="mt-0.5 text-sm text-amber-200/90">
                      FINAL is closed, but {formatMonth(monthId)} has not been closed yet.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="btn-banner-close-month"
                  className="btn-primary shrink-0 self-start sm:self-center"
                  disabled={loading || monthClosing}
                  onClick={() => void handleGuidedCloseMonth()}
                >
                  {monthClosing && <LoadingIcon label="Closing month" />}
                  Close Month
                </button>
              </div>
            </div>
          )}
          {isNextPeriodUninitialized && (
            <div
              data-testid="initialize-next-period-banner"
              className="mb-4 rounded-xl border border-blue-500/40 bg-blue-500/10 p-4 text-blue-100 shadow-lg shadow-black/20"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-blue-400" />
                  <div>
                    <h3 className="font-semibold text-blue-300">{formatMonth(nextPeriodKey)} is not initialized</h3>
                    <p className="mt-0.5 text-sm text-blue-200/90">
                      {formatMonth(nextPeriodKey)} will be initialized from {formatMonth(monthId)} FINAL closing balances and Day 1 will be opened.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  data-testid="btn-initialize-next-period"
                  className="btn-primary shrink-0 self-start sm:self-center"
                  disabled={loading || initializingNextPeriod}
                  onClick={() => void handleInitializeNextPeriod(monthId)}
                >
                  {initializingNextPeriod && <LoadingIcon label="Initializing..." />}
                  Initialize &amp; Open {formatMonth(nextPeriodKey)} Day 1
                </button>
              </div>
            </div>
          )}
          {showOfflineOwnerWarning && <p className="warning">Owner will see updates after this machine reconnects.</p>}
          {isPeriodUninitialized && (
            <div
              data-testid="period-uninitialized-banner"
              className="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-amber-200"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                  <div>
                    <h3 className="font-semibold text-amber-300">{formatMonth(monthId)} is not initialized</h3>
                    <p className="mt-0.5 text-sm text-amber-200/90">
                      Accounting period {formatMonth(monthId)} has not been initialized in the PostgreSQL authoritative ledger.
                      {(monthId === "2026-09" || months.find((m) => m.id === "2026-08")?.status === "closed") && (
                        <span> It will be initialized from {formatMonth("2026-08")} FINAL closing balances and Day 1 will be opened.</span>
                      )}
                    </p>
                  </div>
                </div>
                {(monthId === "2026-09" || months.find((m) => m.id === "2026-08")?.status === "closed") && (
                  <button
                    type="button"
                    data-testid="btn-initialize-uninitialized-period"
                    className="btn-primary shrink-0 self-start sm:self-center"
                    disabled={loading || initializingNextPeriod}
                    onClick={() => void handleInitializeNextPeriod("2026-08")}
                  >
                    {initializingNextPeriod && <LoadingIcon label="Initializing..." />}
                    Initialize &amp; Open {formatMonth(monthId)} Day 1
                  </button>
                )}
              </div>
            </div>
          )}
          {isPostgreSqlPeriod(monthId) && pgPeriodRouting.checked && (pgPeriodRouting.status === "AUTH_REQUIRED" || pgPeriodRouting.status === "UNAUTHORIZED") && (
            <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-rose-200">
              <div className="flex items-center gap-2 font-semibold text-rose-300">
                <AlertTriangle className="h-5 w-5 shrink-0 text-rose-400" />
                <span>Authentication Required</span>
              </div>
              <p className="mt-1 text-sm text-rose-200/90">
                You do not have permission to access PostgreSQL accounting period {formatMonth(monthId)}. Please sign in with an authorized account.
              </p>
            </div>
          )}
          {expenseMismatchCount > 0 && (
            <p className="warning">
              {expenseMismatchCount} Expense balance mismatch{expenseMismatchCount === 1 ? "" : "es"} detected. Run Master Calculation Refresh before treating this month as final.
            </p>
          )}
          {expenseOpeningMismatchCount > 0 && (role === "owner" || role === "admin") && (
            <div className="warning">
              <p>
                {expenseCarryForwardWarningList.some((w) => w.includes("verification unavailable"))
                  ? "Expense month-to-month opening verification warning. Verify opening carry-forward balances."
                  : `${expenseOpeningMismatchCount} Expense month-to-month opening mismatch${expenseOpeningMismatchCount === 1 ? "" : "es"} detected. Verify opening carry-forward balances.`}
              </p>
              <ul className="mt-2 list-disc pl-5 text-sm">
                {expenseCarryForwardWarningList.slice(0, 5).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}
          {showExpenseV2ShadowPanel && role && (
            <LedgerShadowStatusPanel config={ledgerReadModeConfig} role={role} />
          )}
          {SHOW_LEDGER_V2_SHADOW_WARNING && !showExpenseV2ShadowPanel && (role === "owner" || role === "admin") && v2ShadowModules.length > 0 && (
            <p className="warning">
              ledgerV2 shadow read verification is active for {v2ShadowModules.join(", ")}. The UI is still reading v1 until the reviewed verification report enables cutover.
            </p>
          )}
          {(role === "owner" || role === "admin") && v2ActiveModules.length > 0 && (
            <p className="status">
              LedgerV2 UI reads are active for {v2ActiveModules.join(", ")}.
            </p>
          )}
          {!isPeriodUninitialized && isClosed && <p className="warning">This month is closed. Reopen it before editing.</p>}
          {selectedDayLocked && (
            <p className="warning">
              {selectedDay === 32
                ? "FINAL is the authoritative month-end closing snapshot. To make corrections, reopen an operational day (such as Day 31)."
                : isSelectedLiveDay
                  ? `Day ${selectedDay} is closed.`
                  : `Day ${selectedDay} is closed. Reopen it to edit until it is manually closed.`}
            </p>
          )}
          {isSelectedCanonicalReopen && (
            <p className="status">Day {selectedDay} is reopened. You can edit it until the owner closes it again.</p>
          )}

          {view === "expense" && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-white">Expense Ledger</h2>
                <p className="mt-1 text-sm text-slate-400">{formatMonth(monthId)} · {monthStatus} · {syncLabel}</p>
              </div>
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Active Month</p>
                <p className="mt-1 text-sm font-medium text-white">{formatMonth(monthId)}</p>
              </div>
            </div>
          )}

          {view === "dashboard" && (
            <>
              <HomeDashboard month={computed} monthId={monthId} />
              <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button className="btn-primary w-full sm:w-auto" disabled={!computed} onClick={() => computed && runReportExport(() => exportMonthlyXlsx(computed))}>
                  <FileSpreadsheet />
                  Export Monthly Excel
                </button>
                <button className="btn-secondary w-full sm:w-auto" disabled={!computed} onClick={() => computed && runReportExport(() => exportMonthlyPdf(computed))}>
                  <FileDown />
                  Export Monthly PDF
                </button>
                {canUseOwnerControls && (
                  <button
                    className="btn-secondary w-full sm:w-auto"
                    disabled
                    title="Email sending is disabled until Firebase Functions deployment is available."
                    onClick={() => void sendMonthEmail()}
                  >
                    {monthEmailing && <LoaderCircle className="h-4 w-4 animate-spin" />}
                    {monthEmailing ? "Sending Email..." : "Send Email"}
                  </button>
                )}
              </div>
            </>
          )}

          {view === "records" && (
            <RecordsView
              monthId={monthId}
              selectedDay={selectedDay}
              days={days}
              computed={computed}
              loading={loading}
            />
          )}

          {view === "expense" && (
            <section className="mt-4">
              <nav className="mb-5 flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-100 shadow-xl shadow-black/20">
                {(
                  [
                    { id: "daily-entry", label: "Daily Entry", locked: false, icon: CalendarDays },
                    { id: "previous-records", label: "Previous Records", locked: false, icon: ScrollText },
                    { id: "expense-dashboard", label: "Dashboard", locked: false, icon: LayoutDashboard },
                    { id: "expense-categories", label: "Expense Categories", locked: !canManageCatalogs, icon: Tags },
                    { id: "credit-parties", label: "Credit Parties", locked: !canManageCatalogs, icon: CreditCard },
                    { id: "commission-categories", label: "Commission/Application Categories", locked: !canManageCatalogs, icon: FileSpreadsheet }
                  ] as Array<{ id: ExpenseSection; label: string; locked: boolean; icon: typeof CalendarDays }>
                ).map(({ id, label, locked, icon: Icon }) => (
                  <button
                    className={`${expenseSection === id ? "btn-tab btn-tab-active" : "btn-tab"} ${locked ? "cursor-not-allowed opacity-60" : ""}`}
                    disabled={locked}
                    key={id}
                    title={locked ? "Only owner can manage this section." : label}
                    onClick={() => {
                      if (locked) {
                        setStatus("Only owner can manage this section.");
                        return;
                      }
                      if (hasPendingDayChanges && id !== expenseSection && !confirmLeavePendingChanges()) {
                        setStatus("Stayed on Daily Entry because changes are still pending save.");
                        return;
                      }
                      setExpenseSection(id);
                    }}
                  >
                    <Icon />
                    {label}
                  </button>
                ))}
              </nav>

              {expenseSection === "daily-entry" && (
                <>
                  <DailyEntryForm
                    key={`${monthId}-${selectedDay}`}
                    dayNo={selectedDay}
                    entryYear={selectedDateParts.entryYear}
                    entryMonth={selectedDateParts.entryMonth}
                    entryDay={selectedDateParts.entryDay}
                    openingBalance={selectedOpening}
                    ownerOpeningBalance={
                      selectedDay === 32
                        ? (selectedDayInput.ownerOpeningBalance ?? 0)
                        : (isPostgreSqlPeriod(monthId) && selectedDayInput.ownerOpeningBalance !== undefined
                            ? selectedDayInput.ownerOpeningBalance
                            : calculatedOwnerOpeningBalance)
                    }
                    previousOwnerClosingBalance={
                      selectedDay === 32
                        ? (selectedDayInput.ownerOpeningBalance ?? 0)
                        : (isPostgreSqlPeriod(monthId) && selectedDayInput.ownerOpeningBalance !== undefined
                            ? selectedDayInput.ownerOpeningBalance
                            : (computed?.days.find((day) => day.dayNo === selectedDay - 1)?.ownerBalanceTotal ?? calculatedOwnerOpeningBalance))
                    }
                    dateLabel={dateLabel}
                    expenseCategories={expenseCategories}
                    commissionCategories={commissionCategories}
                    creditParties={creditParties}
                    initial={selectedDayInput}
                    previousDay={previousDayInput}
                    disabled={!canEditSelectedDay || !user}
                    locked={selectedDayLocked}
                    canClose={(selectedDay === 32 ? role === "owner" : canCloseSelectedDay) && !loading && Boolean(user)}
                    canReopen={canReopenSelectedDay && !loading && Boolean(user)}
                    reopenLabel={selectedDayReopenLabel}
                    reopenRequiresTime={false}
                    onReopenDay={() => reopenDay(selectedDay)}
                    canCreateCatalogs={canManageCatalogs}
                    onSave={saveDay}
                    onCloseDay={closeDay}
                    onSendEmail={sendDailyEmail}
                    canSendEmail={false}
                    onCreateCatalog={saveCatalog}
                    onPendingStateChange={setHasPendingDayChanges}
                    onManualSaveReady={(save) => {
                      expenseManualSaveRef.current = save;
                    }}
                    isOwner={role === "owner"}
                    monthId={monthId}
                  />
                </>
              )}
              {expenseSection === "previous-records" && (
                <RecordsView
                  monthId={monthId}
                  selectedDay={selectedDay}
                  days={days}
                  computed={computed}
                  loading={loading}
                />
              )}
              {expenseSection === "expense-dashboard" && <HomeDashboard month={computed} monthId={monthId} />}
              {expenseSection === "expense-categories" && (
                <CatalogManager
                  title="Expense Categories"
                  items={expenseCategories}
                  canEdit={canManageCatalogs}
                  lockedMessage={!canManageCatalogs ? "Only owner can manage this section." : undefined}
                  onSave={(item) => saveCatalog("expenseCategories", item)}
                  onDelete={(itemId) => removeCatalogItem("expenseCategories", itemId)}
                  onReorder={(before, after) => handleReorderCatalog("expenseCategories", before, after)}
                />
              )}
              {expenseSection === "credit-parties" && (
                <CatalogManager
                  title="Credit Parties"
                  items={creditParties}
                  canEdit={canManageCatalogs}
                  lockedMessage={!canManageCatalogs ? "Only owner can manage this section." : undefined}
                  onSave={(item) => saveCatalog("creditParties", item)}
                  onDelete={(itemId) => removeCatalogItem("creditParties", itemId)}
                  onReorder={(before, after) => handleReorderCatalog("creditParties", before, after)}
                />
              )}
              {expenseSection === "commission-categories" && (
                <CatalogManager
                  title="Commission/Application Categories"
                  items={commissionCategories}
                  canEdit={canManageCatalogs}
                  lockedMessage={!canManageCatalogs ? "Only owner can manage this section." : undefined}
                  onSave={(item) => saveCatalog("commissionCategories", item)}
                  onDelete={(itemId) => removeCatalogItem("commissionCategories", itemId)}
                  onReorder={(before, after) => handleReorderCatalog("commissionCategories", before, after)}
                />
              )}
            </section>
          )}

          {view === "jazz-load" && (
            <JazzLoadModule
              user={user}
              role={role}
              monthId={monthId}
              syncState={syncState}
              syncLabel={syncLabel}
              loading={loading}
              onSnapshotMetadata={applySnapshotMetadata}
              onFirestoreError={handleFirestoreError}
              onQueueWrite={handleQueuedWrite}
              onStatus={setStatus}
              onExportBackup={exportBackup}
              onImportBackup={importBackup}
              onTriggerMasterRefresh={triggerMasterRefresh}
              ledgerReadModeConfig={ledgerReadModeConfig}
              onPendingStateChange={setHasPendingDayChanges}
            />
          )}

          {view === "stock-ledger" && (
            <StockLedgerModule
              user={user}
              role={role}
              monthId={monthId}
              syncState={syncState}
              syncLabel={syncLabel}
              loading={loading}
              onSnapshotMetadata={applySnapshotMetadata}
              onFirestoreError={handleFirestoreError}
              onQueueWrite={handleQueuedWrite}
              onStatus={setStatus}
              onTriggerMasterRefresh={triggerMasterRefresh}
              ledgerReadModeConfig={ledgerReadModeConfig}
              onPendingStateChange={setHasPendingDayChanges}
            />
          )}

          {view === "audit-logs" && role === "owner" && <AuditLogsView months={months} onActivityChange={setPageActivityLoading} />}

          {view === "users" && (
            <UserManager
              users={users}
              authorizedEmails={authorizedEmails}
              notificationSettings={notificationSettings}
              currentUid={user?.uid}
              currentEmail={user?.email}
              canEdit={canManageUsers}
              onUpdate={saveUserRole}
              onDeleteUser={removeUserProfile}
              onAuthorizeEmail={saveAuthorizedEmail}
              onDeleteAuthorizedEmail={removeAuthorizedEmail}
              onSaveNotifications={saveNotifications}
            />
          )}

          {view === "backup" && (
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h2>Backup</h2>
                  <p>Owner/admin backup export and restore.</p>
                </div>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                <button className="btn-secondary w-full sm:w-auto" disabled={loading || !user || !canUseBackup} onClick={exportBackup}>
                  {loading ? <LoadingIcon label="Exporting backup" /> : <FileDown />}
                  Export Backup
                </button>
                <label className={`file-button w-full sm:w-auto ${loading || !canUseBackup ? "pointer-events-none opacity-50" : ""}`}>
                  {loading ? <LoadingIcon label="Importing backup" /> : <Upload />}
                  Import Backup
                  <input disabled={loading || !canUseBackup} type="file" accept=".json" onChange={(event) => importBackup(event.target.files?.[0] ?? null)} />
                </label>
              </div>
              {syncState === "offline" && (
                <p className="warning mt-4">Some records may not be available offline. Reconnect before final backup.</p>
              )}
            </section>
          )}

          {view === "import" && (
            canUseExcelImport ? (
              <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 text-slate-100 shadow-xl shadow-black/20">
                <div className="panel-title">
                  <div>
                    <h2>Excel Import</h2>
                    <p>Select month and import type, then upload the workbook.</p>
                  </div>
                </div>
                <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-[1fr_1fr_2fr] md:items-end">
                  <label>
                    Import Month
                    <input
                      type="month"
                      value={importMonthId}
                      onChange={(event) => {
                        setImportMonthId(event.target.value);
                        setImportPreview(null);
                      }}
                    />
                  </label>
                  <label>
                    Import Type
                    <select
                      value={importType}
                      onChange={(event) => {
                        setImportType(event.target.value as WorkbookImportPreview["importType"]);
                        setImportPreview(null);
                      }}
                    >
                      <option value="full">Full Workbook</option>
                      <option value="expense">Expense Only</option>
                    </select>
                  </label>
                  <label>
                    Workbook
                    <input
                      disabled={loading}
                      type="file"
                      accept=".xlsx,.xls"
                      onChange={(event) => handleWorkbook(event.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>
                {loading && (
                  <p className="mb-4 flex items-center gap-2 text-sm font-medium text-slate-300">
                    <LoadingIcon label="Processing import" />
                    Processing...
                  </p>
                )}
                {importPreview && (
                  <>
                    <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                      {[
                        ["Month", formatMonth(importPreview.monthId)],
                        ["Type", importPreview.importType === "full" ? "Full Workbook" : "Expense Only"],
                        ["File", importPreview.fileName],
                        ["Periods", importPreview.days.length.toString()],
                        ["Issue", importPreview.computed.homeSummary.monthlyIssueTotal.toLocaleString()],
                        ["Expense", importPreview.computed.homeSummary.monthlyExpenseTotal.toLocaleString()]
                      ].map(([label, value]) => (
                        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4" key={label}>
                          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                          <p className="mt-2 overflow-hidden text-ellipsis text-lg font-semibold text-white">{value}</p>
                        </div>
                      ))}
                    </div>
                    {importPreview.workbookTotals && (
                      <p className="status">
                        Workbook Home totals: issue {importPreview.workbookTotals.monthlyIssueTotal.toLocaleString()},
                        expense {importPreview.workbookTotals.monthlyExpenseTotal.toLocaleString()}
                      </p>
                    )}
                    {importPreview.warnings.length > 0 && (
                      <ul className="warnings">
                        {importPreview.warnings.map((warning, index) => (
                          <li key={`${warning.message}-${index}`}>
                            {warning.level}: {warning.sheetName ? `${warning.sheetName} - ` : ""}
                            {warning.message}
                          </li>
                        ))}
                      </ul>
                    )}
                    <HomeDashboard month={importPreview.computed} />
                    <button className="btn-primary w-full sm:w-auto" disabled={loading || !user} onClick={commitImport}>
                      {loading && <LoadingIcon label="Saving import" />}
                      Save {importPreview.importType === "expense" ? "Expense Only" : "Full Workbook"} Import to Firestore
                    </button>
                  </>
                )}
              </section>
            ) : (
              <section className="panel">
                <h2>Excel Import</h2>
                <p className="warning mt-4">Only owner can import Excel workbooks.</p>
              </section>
            )
          )}

        </div>
      </div>
      <nav className="mobile-bottom-nav lg:hidden" aria-label="Primary mobile navigation">
        {mobilePrimaryNav.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              className={view === item.id ? "mobile-bottom-item mobile-bottom-item-active" : "mobile-bottom-item"}
              onClick={() => navigateTo(item.id)}
            >
              <Icon />
              <span>{item.id === "expense" ? "Expense" : item.id === "jazz-load" ? "Jazz" : item.label.replace("Previous ", "")}</span>
            </button>
          );
        })}
        <button className={mobileMenuOpen ? "mobile-bottom-item mobile-bottom-item-active" : "mobile-bottom-item"} onClick={() => setMobileMenuOpen((open) => !open)}>
          <Menu />
          <span>More</span>
        </button>
      </nav>
    </main>
    </SidebarDayControlsProvider>
    </SelectedDateProvider>
  );
}

export default App;
