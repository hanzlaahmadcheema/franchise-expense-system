import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
export interface LedgerUser { uid: string; email?: string | null; displayName?: string | null; }
import { BarChart3, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileDown, FileSpreadsheet, GripVertical, Pencil, Plus, PlusCircle, Printer, Save, Settings, Trash2, X, ArrowUpRight, ArrowDownRight, RefreshCw, Wrench, AlertTriangle, Info, Box, ArrowRightLeft, History, Table, User, Search, Maximize2 } from "lucide-react";
import type { UserRole, SystemAuditLog } from "../../../types/ledger";
import { subscribeAuditLogs } from "../../../lib/auditLogService";
import type { SyncState } from "../../../lib/syncStatus";
import { MASTER_REFRESH_ACCESS } from "../../../shared/services/masterRefreshPermissions";
import { Alert, StatusBadge } from "../../../shared/components";
import {
  accountsSorted,
  buildStockDayRecord,
  buildStockEntry,
  calculateMonthlySummary,
  findPreviousEntry,
  productPaymentTrackingEnabled,
  productsSorted,
  resolveStockAccountOpeningDue,
  resolveStockCarryForwardBalance,
  validateStockDraft,
  validateStockInDraft,
  calculateJazzPayableLedger,
  calculateCurrentStock
} from "../services/stockCalculations";
import {
  ensureStockMonth,
  ensureStockOpeningSeed,
  listStockBackup,
  roleCanStock,
  recalculateStockLedgerLocal,
  saveStockDay,
  updateStockDaysStatusBatch,
  subscribeStockAccounts,
  subscribeStockDays,
  subscribeStockMonths,
  subscribeStockMonthlySummary,
  subscribeStockProducts,
  deleteStockAccount,
  deleteStockProduct,
  upsertStockAccount,
  upsertStockProduct,
  updateStockAccountSortOrder,
  updateStockProductSortOrder,
  subscribeStockOpeningBalances,
  subscribeStockSettingsConfig,
  type FirestoreSnapshotMeta
} from "../services/stockFirestore";
import { exportStockDayXlsx, exportStockMonthlyXlsx, exportStockPrintable } from "../services/stockReports";
import type {
  StockAccountProfile,
  StockAccountType,
  StockDailyAccountDraft,
  StockDayRecord,
  StockDayStatus,
  StockMonth,
  StockMonthlySummary,
  StockProduct,
  StockProductLine,
  StockInRecord,
  StockOpeningBalances,
  StockSettingsConfig,
  StockAccountMonthlyTotal
} from "../types/stock.types";
import {
  compareMonthIds,
  currentDateState,
  dayDate,
  daysInMonth,
  formatMoney,
  monthLabel,
  parseMoneyInput,
  previousMonthId,
  roundMoney,
  slug
} from "../utils/stockFormatters";
import { UniversalCalendar } from "../../../shared/calendar/UniversalCalendar";
import { UniversalDayControlBar } from "../../../shared/dayControls/UniversalDayControlBar";
import { useSidebarDayControls } from "../../../shared/context/SidebarDayControlsContext";
import { useSelectedDate } from "../../../shared/context/SelectedDateContext";
import { CashCreditStockInTable, hasAnyNonZeroSummaryValue, ProductStockFlowTable, StockIssuanceSummaryTable, StockLiftingSummaryTable } from "./StockDashboardTables";
import { canEditOperationalDailyEntry, canReopenDay, isActiveReopenWindow } from "../../../shared/services/dayEditPermissions";
import { resolveUniversalDayStatus } from "../../../shared/services/dayStatusService";
import { useAutoSaveEntry } from "../../../shared/hooks/useAutoSaveEntry";
import { runMasterRecalculation } from "../../../shared/services/masterRecalculationService";
import { resolveLedgerUiReadDecision } from "../../../shared/ledger/ledgerReadMode";
import type { LedgerReadModeConfig } from "../../../shared/ledger/ledgerTypes";
import type { MasterRecalculationAdapter, UniversalDaySnapshot } from "../../../shared/types/dayControl.types";
import { applySortOrder, changedSortOrderPatches, reorderItems } from "../../../shared/services/orderUtils";
import { createStockRecalculationAdapter } from "../adapters/stockRecalculationAdapter";
import { SaveProgressDialog, type SaveProgressState } from "../../../shared/components/SaveProgressDialog";
import { isPostgreSqlPeriod, resolveAccountingDayId, getAccountingPeriodWithDays } from "../../../services/api/periodDayService";
import { saveStockDayPostgres, loadStockDayPostgres, loadStockMonthPostgres, deleteStockInPostgres } from "../../../services/api/stockTransactionService";
import { recordJazzCompanyPaymentPostgres } from "../../../services/api/jazzLoadTransactionService";
import { ledgerApiClient } from "../../../services/api/ledgerApiClient";
import { closeOperationalDayUnified, reopenOperationalDayUnified, subscribeDayStatus } from "../../../services/api/dayLifecycleService";
import { TransferBalanceModal } from "./TransferBalanceModal";

export function isServerLoadedStockDay(day?: StockDayRecord | null): boolean {
  if (!day) return false;
  if (
    (day.entries && day.entries.length > 0) ||
    (day.stockIn && day.stockIn.length > 0) ||
    (day.stockProductProjections && day.stockProductProjections.length > 0) ||
    (day.stockAccountProjections && day.stockAccountProjections.length > 0) ||
    Boolean(day.notes)
  ) {
    return true;
  }
  return false;
}

export type StockSection = "daily" | "stockIn" | "reportsHub" | "settings" | "backup" | "records" | "balances" | "jazzPayable" | "dues" | "products" | "accounts";

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
  onTriggerMasterRefresh?: (adapter: MasterRecalculationAdapter, title: string) => Promise<void>;
  ledgerReadModeConfig: LedgerReadModeConfig;
  loading?: boolean;
  onPendingStateChange?: (pending: boolean) => void;
  section?: StockSection;
  onSectionChange?: (sec: StockSection) => void;
  hideOnPageTabs?: boolean;
};

function isFutureDay(monthId: string, dayNo: number, now = new Date()) {
  const live = currentDateState(now);
  return compareMonthIds(monthId, live.monthId) > 0 || (monthId === live.monthId && dayNo > live.dayNo);
}

function isLiveDay(monthId: string, dayNo: number, now = new Date()) {
  const live = currentDateState(now);
  return monthId === live.monthId && dayNo === live.dayNo;
}

function availableDays(monthId: string, now = new Date()) {
  const live = currentDateState(now);
  if (compareMonthIds(monthId, live.monthId) > 0) return [];
  const maxDay = monthId === live.monthId ? live.dayNo : daysInMonth(monthId);
  return Array.from({ length: maxDay }, (_, index) => index + 1);
}

function isReopenActive(day: StockDayRecord | undefined, now = new Date()) {
  return isActiveReopenWindow(day, now.getTime());
}

function getStockDayStatus(
  monthId: string,
  dayNo: number,
  day: StockDayRecord | undefined,
  monthStatus: StockMonth["status"] | undefined,
  now = new Date()
) {
  void monthId;
  void dayNo;
  if (!day) return "Open";
  if (monthStatus === "closed") return "Closed";
  if (day.status === "reopen" || isReopenActive(day, now)) return "Reopen";
  if (day.status === "open") return "Open";
  if (day?.status === "closed" || day?.lockedAt != null || day?.closedAt != null) return "Closed";
  return "Open";
}

function getDayStatusChipClass(status: string) {
  if (status === "Open") return "bg-emerald-400/15 text-emerald-200";
  if (status === "Reopen") return "bg-blue-400/15 text-blue-200";
  if (status === "Closed") return "bg-red-400/15 text-red-200";
  return "bg-emerald-400/15 text-emerald-200";
}

function canEditStockDay(role: UserRole | null, month: StockMonth | undefined, monthId: string, day: StockDayRecord | undefined, dayNo: number, now = new Date()) {
  return canEditOperationalDailyEntry({
    role,
    canWriteDaily: roleCanStock(role, "daily"),
    monthClosed: month?.status === "closed",
    isFutureDay: isFutureDay(monthId, dayNo, now),
    isLiveDay: isLiveDay(monthId, dayNo, now),
    dayClosed: day?.status === "closed" && !isReopenActive(day, now),
    day,
    nowMs: now.getTime()
  });
}

function NumberInput({
  value,
  onChange,
  disabled,
  onFocus,
  onBlur,
  className = ""
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
}) {
  const [text, setText] = useState(value ? String(value) : "");
  const [focused, setFocused] = useState(false);
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (focused || dirtyRef.current) return;
    setText(value ? String(value) : "");
  }, [focused, value]);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={text}
      disabled={disabled}
      className={`text-left font-mono font-bold tabular-nums text-white ${className}`}
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
        onChange(parseMoneyInput(next));
      }}
      onBlur={() => {
        setText((current) => current ? String(parseMoneyInput(current)) : "");
        dirtyRef.current = false;
        setFocused(false);
        onBlur?.();
      }}
    />
  );
}

function splitProductName(name: string): [string, string] {
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return [name, ""];
  if (parts.length === 2) return [parts[0], parts[1]];
  const mid = Math.ceil(parts.length / 2);
  return [parts.slice(0, mid).join(" "), parts.slice(mid).join(" ")];
}

function stockDraftSignature(draft: StockDailyAccountDraft) {
  return JSON.stringify({
    accountId: draft.accountId,
    productQuantities: Object.fromEntries(Object.entries(draft.productQuantities).sort(([left], [right]) => left.localeCompare(right))),
    paymentReceived: draft.paymentReceived ?? 0,
    carryForwardBalance: draft.carryForwardBalance ?? 0,
    notes: draft.notes ?? ""
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

function StockProductEntryTable({
  products,
  quantities,
  quantityLabel,
  totalQty,
  totalAmount,
  disabled,
  onQuantityChange,
  onQuantityFocus,
  onQuantityBlur,
  footerRows
}: {
  products: StockProduct[];
  quantities: Record<string, number>;
  quantityLabel: string;
  totalQty: number;
  totalAmount: number;
  disabled: boolean;
  onQuantityChange: (productId: string, value: number) => void;
  onQuantityFocus?: (productId: string) => void;
  onQuantityBlur?: (productId: string) => void;
  footerRows?: ReactNode;
}) {
  return (
    <div className="table-wrap mt-3">
      <table className="stock-entry-table">
        <thead>
          <tr>
            <th>Product Name</th>
            <th>{quantityLabel}</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => {
            const quantity = quantities[product.id] ?? 0;
            return (
              <tr key={product.id}>
                <td className="font-bold text-white">{product.name}</td>
                <td className="w-36">
                  <NumberInput
                    value={quantity}
                    disabled={disabled}
                    onFocus={() => onQuantityFocus?.(product.id)}
                    onBlur={() => onQuantityBlur?.(product.id)}
                    onChange={(value) => onQuantityChange(product.id, value)}
                  />
                </td>
                <td className="whitespace-nowrap font-mono font-bold text-white">{formatMoney(product.rate)}</td>
                <td className="whitespace-nowrap font-mono font-bold text-white">{formatMoney(roundMoney(quantity * product.rate))}</td>
              </tr>
            );
          })}
          <tr className="bg-slate-950/40 font-bold">
            <td className="font-bold text-white">Total</td>
            <td className="font-bold text-white">{formatMoney(totalQty)}</td>
            <td className="text-slate-500 font-bold">—</td>
            <td className="font-mono font-bold text-white">{formatMoney(totalAmount)}</td>
          </tr>
          {footerRows}
        </tbody>
      </table>
    </div>
  );
}

function stockCarryForwardWarnings(
  days: StockDayRecord[],
  summary: StockMonthlySummary | null,
  prevSummary: StockMonthlySummary | null
) {
  if (!prevSummary) return [];
  const warnings: string[] = [];
  const previousDueByAccount = new Map(prevSummary.accountTotals.map((account) => [account.accountId, account]));
  const day1 = days.find((day) => day.dayNo === 1);
  for (const entry of day1?.entries ?? []) {
    const previous = previousDueByAccount.get(entry.accountId);
    if (!previous) continue;
    if (entry.carryForwardBalance !== previous.dueBalance) {
      warnings.push(`${entry.accountName} due opening ${formatMoney(entry.carryForwardBalance)} should equal previous month closing ${formatMoney(previous.dueBalance)}`);
    }
  }

  const previousClosingStock = prevSummary.closingStock ?? {};
  const openingStock = summary?.openingStock ?? {};
  for (const [productId, expected] of Object.entries(previousClosingStock)) {
    const actual = openingStock[productId];
    if (actual !== undefined && actual !== expected) {
      const formatVal = (v: number | null | undefined) => (v == null ? "Skipped" : formatMoney(v));
      warnings.push(`${productId} opening stock ${formatVal(actual)} should equal previous month closing stock ${formatVal(expected)}`);
    }
  }
  if (summary?.openingJazzPayable !== undefined && prevSummary.closingJazzPayable !== undefined && summary.openingJazzPayable !== prevSummary.closingJazzPayable) {
    warnings.push(`Jazz Company payable opening ${formatMoney(summary.openingJazzPayable)} should equal previous month closing payable ${formatMoney(prevSummary.closingJazzPayable)}`);
  }
  return warnings;
}

export function StockLedgerModule({
  user,
  role,
  monthId,
  syncState,
  syncLabel,
  onSnapshotMetadata,
  onFirestoreError,
  onQueueWrite,
  onStatus,
  onTriggerMasterRefresh,
  ledgerReadModeConfig,
  loading,
  onPendingStateChange,
  section: externalSection,
  onSectionChange: onExternalSectionChange,
  hideOnPageTabs = false
}: Props) {
  const { selectedDay, setSelectedDay } = useSelectedDate();
  const [internalSection, setInternalSection] = useState<StockSection>("daily");
  const section = externalSection ?? internalSection;
  const setSection = (nextSection: StockSection) => {
    if (onExternalSectionChange) {
      onExternalSectionChange(nextSection);
    } else {
      setInternalSection(nextSection);
    }
  };
  const [months, setMonths] = useState<StockMonth[]>([]);
  const [days, setDays] = useState<StockDayRecord[]>([]);
  const [stockDaysInitialized, setStockDaysInitialized] = useState(false);
  const [stockPreviousSummaryInitialized, setStockPreviousSummaryInitialized] = useState(false);
  const [stockSettingsInitialized, setStockSettingsInitialized] = useState({
    products: false,
    accounts: false,
    months: false,
    openingBalances: false,
    config: false
  });
  const [summary, setSummary] = useState<StockMonthlySummary | null>(null);
  const [prevSummary, setPrevSummary] = useState<StockMonthlySummary | null>(null);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [accounts, setAccounts] = useState<StockAccountProfile[]>([]);

  // Stock Settings: Unified Master DO Directory & Products State
  const [doProfiles, setDoProfiles] = useState<any[]>([]);
  const [newAccountName, setNewAccountName] = useState("");
  const [newAccountType, setNewAccountType] = useState<StockAccountType>("DO");
  const [newAccountLine, setNewAccountLine] = useState("");
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null);
  const [editAccountName, setEditAccountName] = useState("");
  const [editAccountType, setEditAccountType] = useState<StockAccountType>("DO");
  const [editAccountLine, setEditAccountLine] = useState("");

  const [newProductName, setNewProductName] = useState("");
  const [newProductRate, setNewProductRate] = useState<number | string>(0);
  const [newProductPaymentTracking, setNewProductPaymentTracking] = useState(true);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [editProductName, setEditProductName] = useState("");
  const [editProductRate, setEditProductRate] = useState<number | string>(0);
  const [editProductPaymentTracking, setEditProductPaymentTracking] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [entryViewMode, setEntryViewMode] = useState<"sheet" | "focus">("sheet");
  const [activeColumnKey, setActiveColumnKey] = useState<string | null>(null);
  const [dealerSearchQuery, setDealerSearchQuery] = useState("");
  const [draft, setDraft] = useState<StockDailyAccountDraft>({ accountId: "", productQuantities: {}, paymentReceived: 0 });
  const [activeReportSubTab, setActiveReportSubTab] = useState<
    "masterSummary" | "stockPosition" | "products" | "cashCredit"
  >("masterSummary");
  const [filterStartDate, setFilterStartDate] = useState<number>(1);
  const [filterEndDate, setFilterEndDate] = useState<number>(31);
  const [filterProductId, setFilterProductId] = useState<string>("");
  const [filterAccountType, setFilterAccountType] = useState<string>("");
  const [filterAccountId, setFilterAccountId] = useState<string>("");
  const [filterStockInMode, setFilterStockInMode] = useState<string>("");
  const [filterDueStatus, setFilterDueStatus] = useState<string>("");
  const [filterDayStatus, setFilterDayStatus] = useState<string>("");
  const [filterActiveStatus, setFilterActiveStatus] = useState<string>("all");
  const [auditLogs, setAuditLogs] = useState<SystemAuditLog[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [monthBootstrapPending, setMonthBootstrapPending] = useState(false);
  const [verifiedSave, setVerifiedSave] = useState<SaveProgressState>(null);
  const [isTransferModalOpen, setIsTransferModalOpen] = useState(false);
  const [transferModalTab, setTransferModalTab] = useState<"new" | "history">("new");
  const [currentDayId, setCurrentDayId] = useState<string>("");
  const monthBootstrapPendingRef = useRef(false);
  const openingSeedAttemptedRef = useRef(false);
  const [openingBalances, setOpeningBalances] = useState<StockOpeningBalances>({ openingStock: {}, jazzOpeningPayable: 0 });
  const [stockSettingsConfig, setStockSettingsConfig] = useState<StockSettingsConfig>({ allowManualCarryForwardInput: false });
  const ledgerReadDecision = useMemo(
    () => resolveLedgerUiReadDecision({ config: ledgerReadModeConfig, module: "stock", role, monthId }),
    [ledgerReadModeConfig, monthId, role]
  );
  const stockDraftRef = useRef(draft);
  const stockDraftDirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);
  const inFlightSavePromiseRef = useRef<Promise<void> | null>(null);
  const stockDraftHydrationKeyRef = useRef("");
  const focusedStockDraftFieldsRef = useRef(new Set<string>());

  const callbacksRef = useRef({
    onSnapshotMetadata,
    onFirestoreError,
    onQueueWrite,
    onStatus
  });
  const closedDayKeysRef = useRef(new Set<string>());
  callbacksRef.current = {
    onSnapshotMetadata,
    onFirestoreError,
    onQueueWrite,
    onStatus
  };

  useEffect(() => {
    stockDraftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    stockDraftDirtyRef.current = false;
    focusedStockDraftFieldsRef.current.clear();
    stockDraftHydrationKeyRef.current = "";
  }, [monthId, selectedDay, selectedAccountId]);

  function markStockDraftDirty() {
    stockDraftDirtyRef.current = true;
  }

  function focusStockDraftField(fieldId: string) {
    focusedStockDraftFieldsRef.current.add(fieldId);
  }

  function blurStockDraftField(fieldId: string) {
    focusedStockDraftFieldsRef.current.delete(fieldId);
  }

  function currentStockDraftSignature() {
    return stockDraftSignature(stockDraftRef.current);
  }

  function updateStockDraft(nextDraft: StockDailyAccountDraft | ((current: StockDailyAccountDraft) => StockDailyAccountDraft)) {
    markStockDraftDirty();
    setDraft(nextDraft);
  }

  function shouldApplyRemoteStockDraft(hydrationKey: string) {
    if (stockDraftHydrationKeyRef.current !== hydrationKey) return true;
    if (focusedStockDraftFieldsRef.current.size > 0 || stockDraftDirtyRef.current) return false;
    return true;
  }

  function applyRemoteStockDraft(hydrationKey: string, nextDraft: StockDailyAccountDraft) {
    if (!shouldApplyRemoteStockDraft(hydrationKey)) return;
    setDraft(nextDraft);
    stockDraftHydrationKeyRef.current = hydrationKey;
    stockDraftDirtyRef.current = false;
  }

  function markStockSettingInitialized(key: keyof typeof stockSettingsInitialized) {
    setStockSettingsInitialized((current) => ({ ...current, [key]: true }));
  }

  const month = months.find((item) => item.id === monthId);
  const selectedDayRecord = days.find((day) => day.monthId === monthId && day.dayNo === selectedDay);
  const selectedDayStatus = getStockDayStatus(monthId, selectedDay, selectedDayRecord, month?.status, now);
  const sortedProducts = useMemo(() => productsSorted(products), [products]);
  const activeProducts = useMemo(() => sortedProducts.filter((product) => product.active), [sortedProducts]);
  const sortedAccounts = useMemo(() => accountsSorted(accounts), [accounts]);
  const activeAccounts = useMemo(() => {
    return sortedAccounts.filter((account) =>
      account.active ||
      days.some((day) => day.entries.some((entry) => entry.accountId === account.id && (entry.totalQty > 0 || entry.totalPaymentReceived > 0)))
    );
  }, [sortedAccounts, days]);

  const currentAccountBalances = useMemo(() => {
    const map: Record<string, number> = {};
    if (selectedDayRecord?.entries) {
      for (const entry of selectedDayRecord.entries) {
        map[entry.accountId] = Number(entry.dueBalance ?? 0);
      }
    }
    if (selectedDayRecord?.stockAccountProjections) {
      for (const proj of selectedDayRecord.stockAccountProjections) {
        if (proj.account_id && proj.closing_due !== undefined) {
          map[proj.account_id] = Number(proj.closing_due);
        }
      }
    }
    for (const acc of activeAccounts) {
      if (map[acc.id] === undefined) {
        map[acc.id] = Number(openingBalances.stockAccountOpening?.[acc.id] ?? acc.openingBalance ?? 0);
      }
    }
    return map;
  }, [selectedDayRecord?.entries, selectedDayRecord?.stockAccountProjections, activeAccounts, openingBalances.stockAccountOpening]);

  const handleOpenTransferModal = async (tab: "new" | "history" = "new") => {
    try {
      const dayId = await resolveAccountingDayId(monthId, selectedDay);
      if (!dayId) {
        onStatus(`Cannot find accounting day ${selectedDay} for period ${monthId}.`);
        return;
      }
      setCurrentDayId(dayId);
      setTransferModalTab(tab);
      setIsTransferModalOpen(true);
    } catch (err) {
      console.error("[StockLedgerModule] Failed to resolve day ID:", err);
      onStatus("Failed to resolve active accounting day.");
    }
  };

  const handleTransferSuccess = async (result: any) => {
    if (result?.reversal) {
      onStatus(`Reversal of balance transfer completed successfully via compensating record.`);
    } else if (result?.transfer) {
      onStatus(`Balance transfer of Rs. ${formatMoney(Number(result.transfer.amount))} completed.`);
    } else {
      onStatus(`Stock balance transfer operation completed.`);
    }
    try {
      const loadedDay = await loadStockDayPostgres(monthId, selectedDay, products, accounts);
      if (loadedDay) {
        setDays((current) => {
          const exists = current.some((d) => d.dayNo === loadedDay.dayNo);
          if (exists) {
            return current.map((d) => (d.dayNo === loadedDay.dayNo ? loadedDay : d));
          }
          return [...current, loadedDay].sort((a, b) => a.dayNo - b.dayNo);
        });
      }
      if (isPostgreSqlPeriod(monthId)) {
        const monthDays = await loadStockMonthPostgres(monthId, products, accounts);
        if (monthDays && monthDays.length > 0) {
          setDays(monthDays);
        }
      }
    } catch (err) {
      console.warn("[StockLedgerModule] Failed to reload stock after transfer:", err);
    }
  };

  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedEntry = selectedDayRecord?.entries.find((entry) => entry.accountId === selectedAccountId);
  const previousMonthDueBalance = useMemo(() => {
    if (!selectedAccountId || !prevSummary) return undefined;
    return prevSummary.accountTotals.find((item) => item.accountId === selectedAccountId)?.dueBalance;
  }, [selectedAccountId, prevSummary]);
  const previousEntry = selectedAccountId ? findPreviousEntry(days, selectedDay, selectedAccountId) : undefined;
  const selectedPgAccountProj = isPostgreSqlPeriod(monthId) && selectedAccountId
    ? (selectedDayRecord?.stockAccountProjections?.find((p) => p.account_id === selectedAccountId) ??
       selectedDayRecord?.entries?.find((e) => e.accountId === selectedAccountId))
    : undefined;
  const getAccountCarryForward = (acc: StockAccountProfile) => {
    const prevEntry = findPreviousEntry(days, selectedDay, acc.id);
    const prevMonthDue = prevSummary?.accountTotals.find((item) => item.accountId === acc.id)?.dueBalance;
    const pgProj = isPostgreSqlPeriod(monthId)
      ? (selectedDayRecord?.stockAccountProjections?.find((p) => p.account_id === acc.id) ??
         selectedDayRecord?.entries?.find((e) => e.accountId === acc.id))
      : undefined;
    return pgProj
      ? Number((pgProj as any).opening_due ?? (pgProj as any).carryForwardBalance ?? 0)
      : resolveStockCarryForwardBalance({
        previousEntryDueBalance: prevEntry?.dueBalance,
        previousMonthDueBalance: prevMonthDue,
        accountOpeningBalance: openingBalances.stockAccountOpening?.[acc.id] ?? acc.openingBalance
      });
  };

  const selectedCarryForwardBalance = selectedAccount ? getAccountCarryForward(selectedAccount) : 0;
  const effectiveCarryForwardBalance = selectedCarryForwardBalance;

  const allStockInRecords = useMemo(() => {
    return days.flatMap((day) => day.stockIn ?? []);
  }, [days]);
  const monthOpeningStock = useMemo(() => {
    return prevSummary?.closingStock ?? openingBalances.openingStock;
  }, [openingBalances.openingStock, prevSummary?.closingStock]);
  const monthOpeningJazzPayable = prevSummary?.closingJazzPayable ?? openingBalances.jazzOpeningPayable;

  const currentStockBalances = useMemo(() => {
    if (isPostgreSqlPeriod(monthId)) {
      if (section === "reportsHub" || section === "stockIn") {
        return calculateCurrentStock(products, monthOpeningStock, allStockInRecords, days);
      }
      const targetDayRecord = selectedDayRecord;

      if (targetDayRecord?.stockProductProjections && targetDayRecord.stockProductProjections.length > 0) {
        const projMap = new Map(targetDayRecord.stockProductProjections.map((p) => [p.product_id, p]));
        return products.map((product) => {
          const proj = projMap.get(product.id);
          const opening = proj ? Number(proj.opening_qty) : (openingBalances.openingStock[product.id] ?? 0);
          const stockIn = proj ? Number(proj.stock_in_qty ?? proj.received_qty ?? 0) : 0;
          const stockOut = proj ? Number(proj.stock_out_qty ?? proj.sold_qty ?? 0) : 0;
          const current = proj ? Number(proj.closing_qty) : opening;
          return {
            productId: product.id,
            productName: product.name,
            openingStock: opening,
            totalStockIn: stockIn,
            totalStockOut: stockOut,
            currentStock: current,
            updatedAt: Date.now()
          };
        });
      }
    }
    return calculateCurrentStock(products, monthOpeningStock, allStockInRecords, days);
  }, [allStockInRecords, days, isPostgreSqlPeriod, monthId, monthOpeningStock, openingBalances.openingStock, products, section, selectedDayRecord]);
  const productRateById = useMemo(() => {
    return Object.fromEntries(products.map((product) => [product.id, product.rate]));
  }, [products]);
  const currentInventoryQty = useMemo(() => {
    return roundMoney(currentStockBalances.reduce((total, row) => total + (row.currentStock ?? 0), 0));
  }, [currentStockBalances]);
  const currentInventoryAmount = useMemo(() => {
    return roundMoney(currentStockBalances.reduce((total, row) => total + ((row.currentStock ?? 0) * (productRateById[row.productId] ?? 0)), 0));
  }, [currentStockBalances, productRateById]);
  const selectedAccountDayRows = useMemo(() => {
    if (!selectedAccountId) return [];
    return [...days]
      .filter((day) => day.dayNo >= 1 && day.dayNo <= daysInMonth(monthId))
      .sort((a, b) => a.dayNo - b.dayNo)
      .flatMap((day) => {
        const entry = day.entries.find((item) => item.accountId === selectedAccountId);
        if (!entry) return [];
        return [{
          dayNo: day.dayNo,
          date: day.date,
          totalQty: entry.totalQty,
          totalAmount: entry.totalAmount,
          totalPaymentReceived: entry.totalPaymentReceived,
          totalDueBalance: entry.dueBalance,
          carryForwardBalance: entry.carryForwardBalance,
          status: day.status
        }];
      });
  }, [days, monthId, selectedAccountId]);
  const selectedAccountDayTotals = useMemo(() => {
    return selectedAccountDayRows.reduce((totals, row) => ({
      totalQty: roundMoney(totals.totalQty + row.totalQty),
      totalAmount: roundMoney(totals.totalAmount + row.totalAmount),
      totalPaymentReceived: roundMoney(totals.totalPaymentReceived + row.totalPaymentReceived),
      totalDueBalance: roundMoney(totals.totalDueBalance + row.totalDueBalance)
    }), {
      totalQty: 0,
      totalAmount: 0,
      totalPaymentReceived: 0,
      totalDueBalance: 0
    });
  }, [selectedAccountDayRows]);
  const selectedDealerMasterSummary = useMemo(() => {
    if (!selectedAccountId || !selectedAccount) return null;
    const entriesPeriod = days
      .filter((day) => day.dayNo >= 1 && day.dayNo <= daysInMonth(monthId))
      .sort((a, b) => a.dayNo - b.dayNo)
      .flatMap((day) => day.entries.filter((entry) => entry.accountId === selectedAccountId));
    const sortedDaysWithEntries = [...days].sort((a, b) => a.dayNo - b.dayNo);
    const firstEntry = sortedDaysWithEntries.flatMap((day) => day.entries.filter((entry) => entry.accountId === selectedAccountId)).at(0);
    const latestEntry = entriesPeriod.at(-1);
    const activeProductTotals = Object.fromEntries(activeProducts.map((product) => [product.id, 0]));

    for (const entry of entriesPeriod) {
      for (const line of entry.products) {
        if (activeProductTotals[line.productId] !== undefined) {
          activeProductTotals[line.productId] = roundMoney(activeProductTotals[line.productId] + line.quantity);
        }
      }
    }

    const day1Record = days.find((d) => d.dayNo === 1);
    const day1Proj = isPostgreSqlPeriod(monthId)
      ? (day1Record?.stockAccountProjections?.find((p) => p.account_id === selectedAccount.id) ??
         day1Record?.entries?.find((e) => e.accountId === selectedAccount.id))
      : undefined;
    const opening = openingBalances.stockAccountOpening?.[selectedAccount.id]
      ?? (day1Proj ? Number((day1Proj as any).opening_due ?? (day1Proj as any).carryForwardBalance ?? 0) : undefined)
      ?? selectedAccount.openingBalance
      ?? (firstEntry ? firstEntry.carryForwardBalance : resolveStockAccountOpeningDue(selectedAccount, prevSummary))
      ?? 0;
    const totalQty = entriesPeriod.reduce((sum, entry) => sum + entry.totalQty, 0);
    const totalAmount = entriesPeriod.reduce((sum, entry) => sum + entry.totalAmount, 0);
    const totalPayments = entriesPeriod.reduce((sum, entry) => sum + entry.totalPaymentReceived, 0);
    const currentDue = latestEntry?.dueBalance ?? opening;
    const closing = currentDue;

    return {
      opening,
      totalQty,
      totalAmount,
      totalPayments,
      currentDue,
      closing,
      productTotals: activeProductTotals
    };
  }, [activeProducts, days, monthId, openingBalances.stockAccountOpening, prevSummary, selectedAccount, selectedAccountId]);
  const selectedDealerMasterDayRows = useMemo(() => {
    if (!selectedAccountId || !selectedAccount) return [];
    return [...days]
      .filter((day) => day.dayNo >= 1 && day.dayNo <= daysInMonth(monthId))
      .sort((a, b) => a.dayNo - b.dayNo)
      .flatMap((day) => {
        const entry = day.entries.find((item) => item.accountId === selectedAccountId);
        if (!entry) return [];
        const productTotals = Object.fromEntries(activeProducts.map((product) => [product.id, 0]));
        for (const line of entry.products) {
          if (productTotals[line.productId] !== undefined) {
            productTotals[line.productId] = roundMoney(productTotals[line.productId] + line.quantity);
          }
        }
        return [{
          entryId: entry.id,
          dayNo: day.dayNo,
          date: day.date,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          opening: entry.carryForwardBalance,
          productTotals,
          totalQty: entry.totalQty,
          totalAmount: entry.totalAmount,
          totalPaymentReceived: entry.totalPaymentReceived,
          currentDue: entry.dueBalance,
          closing: entry.dueBalance
        }];
      })
      .sort((a, b) =>
        a.date.localeCompare(b.date) ||
        a.createdAt - b.createdAt ||
        a.updatedAt - b.updatedAt ||
        a.entryId.localeCompare(b.entryId)
      );
  }, [activeProducts, days, monthId, selectedAccount, selectedAccountId]);
  const visibleSelectedDealerMasterDayRows = useMemo(() => {
    return selectedDealerMasterDayRows.filter((row) => hasAnyNonZeroSummaryValue([
      ...activeProducts.map((product) => row.productTotals[product.id]),
      row.totalQty,
      row.totalAmount,
      row.totalPaymentReceived,
      row.opening !== row.closing ? 1 : 0
    ]));
  }, [activeProducts, selectedDealerMasterDayRows]);
  const selectedDealerMasterDayTotals = useMemo(() => {
    const summedTotals = visibleSelectedDealerMasterDayRows.reduce((totals, row) => {
      for (const [productId, qty] of Object.entries(row.productTotals)) {
        totals.productTotals[productId] = roundMoney((totals.productTotals[productId] ?? 0) + qty);
      }
      return {
        totalQty: roundMoney(totals.totalQty + row.totalQty),
        totalAmount: roundMoney(totals.totalAmount + row.totalAmount),
        totalPaymentReceived: roundMoney(totals.totalPaymentReceived + row.totalPaymentReceived),
        productTotals: totals.productTotals
      };
    }, {
      totalQty: 0,
      totalAmount: 0,
      totalPaymentReceived: 0,
      productTotals: Object.fromEntries(activeProducts.map((product) => [product.id, 0]))
    });
    const latestRow = visibleSelectedDealerMasterDayRows.at(-1);

    return {
      ...summedTotals,
      closing: latestRow?.closing ?? 0
    };
  }, [activeProducts, visibleSelectedDealerMasterDayRows]);

  const jazzPayableLedger = useMemo(() => {
    return calculateJazzPayableLedger(monthOpeningJazzPayable, allStockInRecords);
  }, [monthOpeningJazzPayable, allStockInRecords]);

  const canRead = roleCanStock(role, "read");
  const canManageSettings = roleCanStock(role, "settings");
  const stockSettingsReady = Object.values(stockSettingsInitialized).every(Boolean);
  const stockDailyReady = stockSettingsReady && stockDaysInitialized && stockPreviousSummaryInitialized;
  const canEdit = stockDailyReady && canEditStockDay(role, month, monthId, selectedDayRecord, selectedDay, now);
  const canUseStockBackup = roleCanStock(role, "backup");
  const selectedDayIsCanonicalReopen = selectedDayRecord?.status === "reopen";
  const selectedDayIsCanonicalClosed = selectedDayRecord?.status === "closed";
  const selectedDayIsLegacyLocked =
    !selectedDayIsCanonicalReopen &&
    selectedDayRecord?.status !== "open" &&
    (
      selectedDayRecord?.closedAt != null ||
      selectedDayRecord?.lockedAt != null ||
      selectedDayRecord?.reopenedUntilAt != null
    );
  const selectedDayHasLegacyTimedReopen =
    selectedDayIsLegacyLocked &&
    (selectedDayRecord?.reopenedAt != null || selectedDayRecord?.reopenedUntilAt != null);
  const shouldMirrorStockLedgerV2RawEntries = monthId === currentDateState(now).monthId && isLiveDay(monthId, selectedDay, now);
  const shouldWriteCurrentStockDerivedBalances = monthId === currentDateState(now).monthId;
  const canReopenSelectedDay =
    Boolean(selectedDayRecord && (selectedDayIsCanonicalClosed || selectedDayIsLegacyLocked)) &&
    month?.status !== "closed" &&
    canReopenDay(role);
  const carryForwardWarnings = useMemo(
    () => (isPostgreSqlPeriod(monthId) ? [] : stockCarryForwardWarnings(days, summary, prevSummary)),
    [days, monthId, prevSummary, summary]
  );
  const stockCalendarDays = useMemo<UniversalDaySnapshot[]>(() => {
    return Array.from({ length: daysInMonth(monthId) }, (_, index) => {
      const dayNo = index + 1;
      const day = days.find((item) => item.dayNo === dayNo);
      const future = isFutureDay(monthId, dayNo, now);
      const status = month?.status === "closed" ? "closed" : resolveUniversalDayStatus({
          exists: Boolean(day),
          future,
          live: isLiveDay(monthId, dayNo, now),
          day,
          nowMs: now.getTime()
        });
      return {
        moduleKey: "stock",
        monthId,
        dayNo,
        future,
        saved: Boolean(day),
        dateLabel: dayDate(monthId, dayNo),
        reopenedUntilAt: day?.reopenedUntilAt,
        reopenedAt: day?.reopenedAt,
        disabledReason: future ? "Future Stock Ledger days are disabled and cannot create records." : undefined,
        status
      };
    });
  }, [days, month?.status, monthId, now, stockDaysInitialized]);
  const selectedStockStatus = stockCalendarDays.find((day) => day.dayNo === selectedDay)?.status ?? "open";

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (isPostgreSqlPeriod(monthId)) {
      if (!user || !role) return;
      let cancelled = false;

      void (async () => {
        try {
          const [productsRes, accountsRes, periodsRes, periodData, doProfilesRes] = await Promise.all([
            ledgerApiClient.catalogs.getStockProducts().catch(() => ({ data: [] })),
            ledgerApiClient.catalogs.getStockAccounts().catch(() => ({ data: [] })),
            ledgerApiClient.periods.list().catch(() => ({ periods: [] })),
            getAccountingPeriodWithDays(monthId).catch(() => null),
            ledgerApiClient.catalogs.getJazzLoadDoProfiles().catch(() => ({ data: [] }))
          ]);
          if (doProfilesRes?.data) {
            setDoProfiles(doProfilesRes.data);
          }
          if (cancelled) return;

          const openingStock: Record<string, number | null> = {};
          const stockAccountOpening: Record<string, number> = {};
          let jazzOpeningPayable = 0;

          if (periodData) {
            try {
              const seedsRes = await ledgerApiClient.periods.getSeeds(periodData.period.id);
              if (!cancelled && seedsRes?.seeds) {
                for (const sp of (seedsRes.seeds.stockProducts || seedsRes.seeds.stock_products || [])) {
                  if (sp.status === "skipped") {
                    openingStock[sp.product_id] = null;
                  } else {
                    openingStock[sp.product_id] = Number(sp.opening_quantity ?? 0);
                  }
                }
                for (const sa of (seedsRes.seeds.stockAccounts || seedsRes.seeds.stock_accounts || [])) {
                  stockAccountOpening[sa.account_id] = Number(sa.opening_receivable ?? 0);
                }
                jazzOpeningPayable = Number(seedsRes.seeds.financial?.opening_jazz_payable ?? 0);
              }
            } catch (err) {
              console.warn("[StockLedger] Could not load PostgreSQL seeds:", err);
            }
          }

          if (cancelled) return;

          const mappedProducts: StockProduct[] = (productsRes.data || []).map((p: any) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            rate: Number(p.rate ?? 0),
            active: p.is_active,
            displayOrder: Number(p.sort_order ?? 0),
            sortOrder: p.sort_order,
            category: "sim",
            paymentTrackingEnabled: true,
            createdBy: "system",
            createdAt: Date.now(),
            updatedAt: Date.now()
          }));
          setProducts(mappedProducts);
          markStockSettingInitialized("products");

          const mappedAccounts: StockAccountProfile[] = (accountsRes.data || []).map((a: any) => ({
            id: a.id,
            name: a.name,
            slug: a.slug,
            type: a.type as StockAccountType,
            openingBalance: Number(stockAccountOpening[a.id] ?? a.opening_balance ?? 0),
            active: a.is_active,
            displayOrder: Number(a.sort_order ?? 0),
            sortOrder: a.sort_order,
            notes: a.notes ?? undefined,
            createdBy: "system",
            createdAt: Date.now(),
            updatedAt: Date.now()
          }));
          setAccounts(mappedAccounts);
          markStockSettingInitialized("accounts");
          markStockSettingInitialized("config");

          const pgStockMonths: StockMonth[] = (periodsRes.periods || []).map((p) => ({
            id: p.period_key,
            label: p.label || p.period_key,
            status: p.status as "open" | "closed",
            createdBy: "system",
            createdAt: p.created_at ? new Date(p.created_at).getTime() : Date.now(),
            updatedAt: p.updated_at ? new Date(p.updated_at).getTime() : Date.now()
          }));
          setMonths(pgStockMonths);
          markStockSettingInitialized("months");

          setOpeningBalances({
            openingStock,
            jazzOpeningPayable,
            stockAccountOpening
          });
          markStockSettingInitialized("openingBalances");

          if (periodData) {
            const pgStockDays: StockDayRecord[] = [];
            const dayCount = periodData.days.size || 31;
            for (let d = 1; d <= dayCount; d++) {
              const dayRec = periodData.days.get(d);
              const status = (dayRec?.status ?? "closed") as StockDayStatus;
              pgStockDays.push({
                id: String(d),
                monthId,
                dayNo: d,
                date: `${monthId}-${String(d).padStart(2, "0")}`,
                status,
                entries: [],
                stockOut: [],
                stockIn: [],
                summary: {
                  accountCount: 0,
                  totalQty: 0,
                  totalAmount: 0,
                  totalPaymentReceived: 0,
                  totalDueBalance: 0
                },
                createdBy: "system",
                createdAt: 0,
                updatedAt: 0,
                closedAt: status === "closed" && dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : undefined,
                lockedAt: status === "closed" ? (dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : Date.now()) : undefined,
                reopenedAt: dayRec?.reopened_at ? new Date(dayRec.reopened_at).getTime() : undefined
              });
            }
            setDays((currentDays) => {
              if (!currentDays || currentDays.length === 0) {
                return pgStockDays;
              }
              const currentDaysMap = new Map(currentDays.map((d) => [d.dayNo, d]));
              return pgStockDays.map((newDay) => {
                const existing = currentDaysMap.get(newDay.dayNo);
                if (existing && existing.monthId === monthId && isServerLoadedStockDay(existing)) {
                  return {
                    ...existing,
                    status: newDay.status,
                    closedAt: newDay.closedAt,
                    lockedAt: newDay.lockedAt,
                    reopenedAt: newDay.reopenedAt
                  };
                }
                return newDay;
              });
            });

            void loadStockMonthPostgres(monthId, mappedProducts, mappedAccounts)
              .then((monthDays) => {
                if (cancelled) return;
                if (monthDays && monthDays.length > 0) {
                  setDays((current) => {
                    if (!current || current.length === 0) {
                      return monthDays;
                    }
                    const monthDaysMap = new Map(monthDays.map((d) => [d.dayNo, d]));
                    const updated = current.map((existingDay) => {
                      const loaded = monthDaysMap.get(existingDay.dayNo);
                      if (!loaded) return existingDay;
                      if (!isServerLoadedStockDay(existingDay)) {
                        return loaded;
                      }
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
                  setStockDaysInitialized(true);
                }
              })
              .catch((err) => {
                console.warn("[StockLedger] Failed to load month stock days from PostgreSQL:", err);
              });
          }
        } catch (err) {
          console.error("[StockLedger] Failed to initialize PostgreSQL stock data:", err);
        }
      })();

      return () => {
        cancelled = true;
      };
    }

    const unsubscribers = [
      subscribeStockProducts((rows, metadata) => {
        setProducts(rows);
        markStockSettingInitialized("products");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockAccounts((rows, metadata) => {
        setAccounts(rows);
        markStockSettingInitialized("accounts");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockMonths((rows, metadata) => {
        setMonths(rows);
        markStockSettingInitialized("months");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockOpeningBalances((bal, metadata) => {
        if (bal) setOpeningBalances(bal);
        markStockSettingInitialized("openingBalances");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (err) => {
        markStockSettingInitialized("openingBalances");
        console.error("Could not subscribe to opening balances:", err);
      }),
      subscribeStockSettingsConfig((config, metadata) => {
        setStockSettingsConfig(config);
        markStockSettingInitialized("config");
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (err) => {
        markStockSettingInitialized("config");
        console.error("Could not subscribe to stock settings config:", err);
      })
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [monthId, role, user]);

  useEffect(() => {
    if (!user || !roleCanStock(role, "settings") || products.length === 0 || openingSeedAttemptedRef.current || isPostgreSqlPeriod(monthId)) return;
    openingSeedAttemptedRef.current = true;
    const seedPromise = ensureStockOpeningSeed(products, user, role).then((seeded) => {
      if (seeded) callbacksRef.current.onStatus("Seeded one-time Stock opening quantities.");
      return seeded;
    });
    callbacksRef.current.onQueueWrite(seedPromise, "Could not seed one-time Stock opening quantities.");
  }, [monthId, products, role, user]);

  useEffect(() => {
    setStockDaysInitialized(false);
    setDays((curr) => curr.filter((d) => d.monthId === monthId));
    setFilterStartDate(1);
    setFilterEndDate(daysInMonth(monthId));
    setFilterProductId("");
    setFilterAccountId("");
    setFilterAccountType("");
    setFilterStockInMode("");
    setFilterDueStatus("");
    setFilterDayStatus("");
    setFilterActiveStatus("all");
  }, [monthId]);

  useEffect(() => {
    if (!user || !isPostgreSqlPeriod(monthId) || products.length === 0) return;
    let cancelled = false;
    void loadStockDayPostgres(monthId, selectedDay, products, accounts).then((loadedDay) => {
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
      console.warn("[StockLedgerModule] Failed to load day transactions from PostgreSQL:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [accounts, monthId, products, selectedDay, user]);

  const [reportsRefreshing, setReportsRefreshing] = useState(false);
  const productsRef = useRef(products);
  productsRef.current = products;
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const refreshStockReports = useCallback(async () => {
    if (!isPostgreSqlPeriod(monthId) || productsRef.current.length === 0) return;
    setReportsRefreshing(true);
    try {
      const monthDays = await loadStockMonthPostgres(monthId, productsRef.current, accountsRef.current);
      if (monthDays && monthDays.length > 0) {
        setDays((current) => {
          const map = new Map(current.filter((d) => d.monthId === monthId).map((d) => [d.dayNo, d]));
          monthDays.forEach((d) => map.set(d.dayNo, d));
          return Array.from(map.values()).sort((a, b) => a.dayNo - b.dayNo);
        });
        setSummary(calculateMonthlySummary(monthId, monthDays));
      }
    } catch (err) {
      console.warn("[StockLedgerModule] Failed to refresh reports from PostgreSQL:", err);
    } finally {
      setReportsRefreshing(false);
    }
  }, [isPostgreSqlPeriod, monthId]);

  useEffect(() => {
    if (section === "reportsHub" && isPostgreSqlPeriod(monthId)) {
      void refreshStockReports();
    }
  }, [isPostgreSqlPeriod, monthId, refreshStockReports, section]);

  useEffect(() => {
    if (isPostgreSqlPeriod(monthId)) {
      setStockDaysInitialized(true);
      setStockPreviousSummaryInitialized(true);
      return;
    }
    if (!user || !role) return;
    if (!month && roleCanStock(role, "daily") && !monthBootstrapPendingRef.current) {
      const createMonthPromise = ensureStockMonth(monthId, user, role);
      monthBootstrapPendingRef.current = true;
      setMonthBootstrapPending(true);
      callbacksRef.current.onQueueWrite(createMonthPromise, `Could not create stock month ${monthId}.`);
      void createMonthPromise.finally(() => {
        monthBootstrapPendingRef.current = false;
        setMonthBootstrapPending(false);
      });
    }
    const unsubscribers = [
      subscribeStockDays(monthId, (rows, metadata) => {
        setDays(rows);
        setStockDaysInitialized(true);
        callbacksRef.current.onSnapshotMetadata(metadata);
      }, (err) => callbacksRef.current.onFirestoreError(err.message), { readDecision: ledgerReadDecision }),
      subscribeStockMonthlySummary(monthId, (nextSummary, metadata) => { setSummary(nextSummary); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message), { readDecision: ledgerReadDecision }),
      subscribeAuditLogs({ module: "stock", monthId }, (logs) => setAuditLogs(logs), (err) => console.error("Could not subscribe to audit logs:", err))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [ledgerReadDecision, month, monthBootstrapPending, monthId, role, user]);

  useEffect(() => {
    if (!user || !role || isPostgreSqlPeriod(monthId)) return;
    const prevId = previousMonthId(monthId);
    setStockPreviousSummaryInitialized(false);
    return subscribeStockMonthlySummary(
      prevId,
      (nextSummary) => {
        setPrevSummary(nextSummary);
        setStockPreviousSummaryInitialized(true);
      },
      (err) => {
        setStockPreviousSummaryInitialized(true);
        console.error("Could not subscribe to previous month summary:", err);
      }
    );
  }, [monthId, role, user]);

  useEffect(() => {
    const maxDay = availableDays(monthId, now).at(-1) ?? 1;
    if (selectedDay > maxDay || isFutureDay(monthId, selectedDay, now)) {
      setSelectedDay(maxDay);
    }
  }, [monthId, now, selectedDay]);

  useEffect(() => {
    if (!selectedAccountId && activeAccounts[0]) setSelectedAccountId(activeAccounts[0].id);
  }, [activeAccounts, selectedAccountId]);

  useEffect(() => {
    if (!selectedAccountId) return;
    if (!stockDailyReady) return;
    const nextEntry = selectedDayRecord?.entries.find((entry) => entry.accountId === selectedAccountId);
    const nextDraft = {
      accountId: selectedAccountId,
      productQuantities: Object.fromEntries(activeProducts.map((product) => [
        product.id,
        nextEntry?.products.find((item) => item.productId === product.id)?.quantity ?? 0
      ])),
      paymentReceived: nextEntry?.totalPaymentReceived ?? 0,
      carryForwardBalance: selectedCarryForwardBalance,
      notes: nextEntry?.notes ?? ""
    };
    applyRemoteStockDraft(`${monthId}-${selectedDay}-${selectedAccountId}`, nextDraft);
  }, [activeProducts, monthId, selectedAccountId, selectedCarryForwardBalance, selectedDay, selectedDayRecord, stockDailyReady]);

  const previewEntry = selectedAccount ? buildStockEntry({
    id: selectedAccount.id,
    date: dayDate(monthId, selectedDay),
    monthId,
    dayNo: selectedDay,
    account: selectedAccount,
    draft,
    products,
    previous: selectedEntry,
    carryForwardBalance: effectiveCarryForwardBalance,
    createdBy: user.uid
  }) : null;

  async function saveEntry(nextDraft = draft, options: { throwOnError?: boolean } = {}) {
    if (closedDayKeysRef.current.has(`${monthId}/${selectedDay}`)) {
      const message = `Stock Ledger day ${selectedDay} is closed. Reopen it before saving.`;
      onStatus(message);
      if (options.throwOnError) throw new Error(message);
      return false;
    }
    if (!canEdit) {
      const message = "Your role can view Stock Ledger but cannot edit this day.";
      onStatus(message);
      if (options.throwOnError) throw new Error(message);
      return false;
    }
    if (!selectedAccount) {
      if (options.throwOnError) throw new Error("Select a stock account before saving.");
      return false;
    }
    const computedPreviewEntry = buildStockEntry({
      id: selectedAccount.id,
      date: dayDate(monthId, selectedDay),
      monthId,
      dayNo: selectedDay,
      account: selectedAccount,
      draft: nextDraft,
      products,
      previous: selectedEntry,
      carryForwardBalance: selectedCarryForwardBalance,
      createdBy: user.uid
    });
    if (!computedPreviewEntry) {
      if (options.throwOnError) throw new Error("The stock entry could not be prepared.");
      return false;
    }
    const validation = validateStockDraft(nextDraft, products, selectedAccount);
    if (!validation.valid) {
      onStatus(validation.errors.join(" "));
      if (options.throwOnError) throw new Error(validation.errors.join(" "));
      return false;
    }
    const savedDraftSignature = stockDraftSignature(nextDraft);
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const entries = [
      ...(selectedDayRecord?.entries.filter((entry) => entry.accountId !== selectedAccount.id) ?? []),
      computedPreviewEntry
    ];
    const nextDay = buildStockDayRecord({
      month: workingMonth,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      entries,
      previous: selectedDayRecord,
      createdBy: user.uid
    });
    const productQuantitiesChanged = products.some((product) => {
      const nextQuantity = roundMoney(nextDraft.productQuantities[product.id] ?? 0);
      const previousQuantity = roundMoney(selectedEntry?.products.find((item) => item.productId === product.id)?.quantity ?? 0);
      return nextQuantity !== previousQuantity;
    });
    if (isPostgreSqlPeriod(monthId)) {
      try {
        await saveStockDayPostgres(monthId, selectedDay, nextDraft, products);
        const reloadedDay = await loadStockDayPostgres(monthId, selectedDay, products, accounts).catch(() => null);
        const dayToSet = reloadedDay ?? nextDay;
        setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), dayToSet].sort((a, b) => a.dayNo - b.dayNo));
        if (currentStockDraftSignature() === savedDraftSignature) {
          stockDraftDirtyRef.current = false;
        }
        onStatus(`Saved stock record for ${selectedAccount.name} to PostgreSQL.`);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "PostgreSQL did not confirm the stock save.";
        onStatus(message);
        if (options.throwOnError) throw new Error(message);
        return false;
      }
    }

    setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));

    const write = saveStockDay(workingMonth, nextDay, days, user, role, "save-day", {
      openingBalances,
      previousSummary: prevSummary,
      products,
      skipExistingDocCleanup: true,
      skipJazzCompanyBalanceWrite: !shouldWriteCurrentStockDerivedBalances,
      skipProductBalanceWrites: !shouldWriteCurrentStockDerivedBalances || !productQuantitiesChanged,
      skipAccountBalanceWrites: !shouldWriteCurrentStockDerivedBalances,
      skipRawEntryCleanup: true,
      skipLedgerV2RawEntryWrites: !shouldMirrorStockLedgerV2RawEntries
    });
    onQueueWrite(write, "Could not queue stock entry save.");
    try {
      await write;
      if (currentStockDraftSignature() === savedDraftSignature) {
        stockDraftDirtyRef.current = false;
      }
      onStatus(`Saved stock record for ${selectedAccount.name} to Firestore.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Firestore did not confirm the stock save.";
      onStatus(message);
      if (options.throwOnError) throw new Error(message);
      return false;
    }
  }

  async function handleVerifiedSave() {
    if (!canEdit || saveInFlightRef.current) return;
    const isPg = isPostgreSqlPeriod(monthId);
    setVerifiedSave({
      status: "saving",
      title: isPg ? "Saving Stock Day to PostgreSQL" : "Saving Stock Day",
      message: isPg
        ? "Writing day transactions to PostgreSQL ledger and waiting for confirmation..."
        : "Writing the selected account entry to storage and waiting for confirmation..."
    });
    saveInFlightRef.current = true;
    try {
      await saveEntry(draft, { throwOnError: true });
      setVerifiedSave({
        status: "success",
        title: "Save Confirmed",
        message: isPg
          ? `Stock day ${selectedDay} was saved successfully to PostgreSQL.`
          : `Stock day ${selectedDay} was saved successfully.`
      });
      window.setTimeout(() => {
        setVerifiedSave((current) => current?.status === "success" ? null : current);
      }, 2200);
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

  async function switchDealer(newAccountId: string) {
    if (newAccountId === selectedAccountId) return;
    if (stockDraftDirtyRef.current && selectedAccount) {
      try {
        await saveEntry(draft, { throwOnError: false });
      } catch (err) {
        console.warn("Autosave before dealer switch:", err);
      }
    }
    setSelectedAccountId(newAccountId);
  }

  const currentDealerIndex = activeAccounts.findIndex((acc) => acc.id === selectedAccountId);
  const prevDealer = currentDealerIndex > 0 ? activeAccounts[currentDealerIndex - 1] : null;
  const nextDealer = currentDealerIndex >= 0 && currentDealerIndex < activeAccounts.length - 1 ? activeAccounts[currentDealerIndex + 1] : null;

  const filteredAccounts = useMemo(() => {
    if (!dealerSearchQuery.trim()) return activeAccounts;
    const q = dealerSearchQuery.toLowerCase().trim();
    return activeAccounts.filter(
      (acc) => acc.name.toLowerCase().includes(q) || acc.type.toLowerCase().includes(q)
    );
  }, [activeAccounts, dealerSearchQuery]);

  const allDealersSheetRows = useMemo(() => {
    return activeAccounts.map((account) => {
      const isSelected = account.id === selectedAccountId;
      const entry = selectedDayRecord?.entries.find((e) => e.accountId === account.id);
      const openingDue = getAccountCarryForward(account);

      if (isSelected) {
        const totalQty = previewEntry?.totalQty ?? 0;
        const totalAmount = previewEntry?.totalAmount ?? 0;
        const paymentReceived = draft.paymentReceived ?? 0;
        const closingDue = previewEntry?.dueBalance ?? (openingDue + totalAmount - paymentReceived);
        const productQuantities = draft.productQuantities;
        const notes = draft.notes ?? "";
        const hasMovement = totalQty > 0 || paymentReceived > 0 || Boolean(notes.trim());

        return {
          account,
          isSelected: true,
          openingDue,
          productQuantities,
          totalQty,
          totalAmount,
          paymentReceived,
          closingDue,
          notes,
          hasMovement
        };
      }

      const productQuantities: Record<string, number> = {};
      activeProducts.forEach((p) => {
        productQuantities[p.id] = entry?.products.find((item) => item.productId === p.id)?.quantity ?? 0;
      });
      const totalQty = entry?.totalQty ?? 0;
      const totalAmount = entry?.totalAmount ?? 0;
      const paymentReceived = entry?.totalPaymentReceived ?? 0;
      const closingDue = entry?.dueBalance ?? (openingDue + totalAmount - paymentReceived);
      const notes = entry?.notes ?? "";
      const hasMovement = totalQty > 0 || paymentReceived > 0 || Boolean(notes.trim());

      return {
        account,
        isSelected: false,
        openingDue,
        productQuantities,
        totalQty,
        totalAmount,
        paymentReceived,
        closingDue,
        notes,
        hasMovement
      };
    });
  }, [
    activeAccounts,
    activeProducts,
    draft,
    previewEntry,
    selectedAccountId,
    selectedDayRecord,
    days,
    selectedDay,
    prevSummary,
    openingBalances,
    monthId
  ]);

  const sheetTotals = useMemo(() => {
    const productQtyTotals: Record<string, number> = {};
    activeProducts.forEach((p) => {
      productQtyTotals[p.id] = allDealersSheetRows.reduce((sum, r) => sum + (r.productQuantities[p.id] ?? 0), 0);
    });
    const totalOpening = allDealersSheetRows.reduce((sum, r) => sum + r.openingDue, 0);
    const grandTotalQty = allDealersSheetRows.reduce((sum, r) => sum + r.totalQty, 0);
    const grandTotalAmount = allDealersSheetRows.reduce((sum, r) => sum + r.totalAmount, 0);
    const grandTotalPayment = allDealersSheetRows.reduce((sum, r) => sum + r.paymentReceived, 0);
    const grandTotalClosingDue = allDealersSheetRows.reduce((sum, r) => sum + r.closingDue, 0);

    return {
      productQtyTotals,
      totalOpening,
      grandTotalQty,
      grandTotalAmount,
      grandTotalPayment,
      grandTotalClosingDue
    };
  }, [activeProducts, allDealersSheetRows]);

  const handlePrint = (title: string, elementId: string) => {
    const content = document.getElementById(elementId)?.innerHTML;
    if (!content) return;
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`
      <html>
        <head>
          <title>\${title}</title>
          <style>
            body { font-family: sans-serif; padding: 20px; background: #fff; color: #000; }
            h1 { font-size: 18px; border-bottom: 2px solid #000; padding-bottom: 8px; margin-bottom: 15px; text-transform: uppercase; letter-spacing: 0.05em; }
            h2 { font-size: 14px; color: #555; margin-top: -10px; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; margin-top: 15px; }
            th, td { border: 1px solid #ddd; padding: 8px; text-align: left; font-size: 11px; }
            th { background-color: #f8f9fa; font-weight: bold; text-transform: uppercase; color: #333; }
            .font-bold { font-weight: bold; }
            .text-emerald-400, .text-emerald-600 { color: #059669 !important; font-weight: bold; }
            .text-rose-400, .text-rose-600 { color: #dc2626 !important; font-weight: bold; }
            .text-indigo-400, .text-indigo-600 { color: #4f46e5 !important; }
            .card { border: 1px solid #ddd; padding: 15px; margin-bottom: 10px; border-radius: 6px; background: #fafafa; display: inline-block; width: 30%; margin-right: 2%; box-sizing: border-box; vertical-align: top; }
            .card span { font-size: 10px; color: #777; text-transform: uppercase; font-weight: bold; display: block; margin-bottom: 4px; }
            .card p { font-size: 18px; font-weight: bold; margin: 0; }
            .grid { width: 100%; margin-bottom: 20px; }
          </style>
        </head>
        <body>
          <h1>\${title}</h1>
          <h2>Month: \${monthLabel(monthId)} | Date: \${new Date().toLocaleDateString()}</h2>
          \${content}
        </body>
      </html>
    `);
    win.document.close();
    win.print();
  };

  const [stockInQuantities, setStockInQuantities] = useState<Record<string, number>>({});
  const [stockInMode, setStockInMode] = useState<"cash" | "credit">("cash");
  const [stockInPaidAmount, setStockInPaidAmount] = useState<number>(0);
  const [stockInNotes, setStockInNotes] = useState<string>("");
  const [editingStockInId, setEditingStockInId] = useState<string | null>(null);

  useEffect(() => {
    setStockInQuantities({});
    setStockInMode("cash");
    setStockInPaidAmount(0);
    setStockInNotes("");
    setEditingStockInId(null);
  }, [monthId, selectedDay]);

  const previewStockInRecord = useMemo((): StockInRecord | null => {
    const activeProducts = productsSorted(products.filter((p) => p.active));
    const lines: StockProductLine[] = activeProducts.map((p) => {
      const quantity = stockInQuantities[p.id] ?? 0;
      const rate = p.rate;
      return {
        productId: p.id,
        productName: p.name,
        rate,
        quantity,
        amount: roundMoney(quantity * rate)
      };
    }).filter((line) => line.quantity > 0);

    if (lines.length === 0) return null;

    const totalQty = lines.reduce((acc, curr) => acc + curr.quantity, 0);
    const totalAmount = roundMoney(lines.reduce((acc, curr) => acc + curr.amount, 0));
    const paidAmount = stockInMode === "cash" ? totalAmount : roundMoney(stockInPaidAmount || 0);
    const jazzPayableAmount = roundMoney(totalAmount - paidAmount);
    const existingRecord = selectedDayRecord?.stockIn?.find((record) => record.id === editingStockInId);

    return {
      id: existingRecord?.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      date: dayDate(monthId, selectedDay),
      monthId,
      sourceName: "Jazz Company" as const,
      stockInMode,
      products: lines,
      totalQty,
      totalAmount,
      paidAmount,
      jazzPayableAmount,
      notes: stockInNotes.trim() || undefined,
      createdBy: existingRecord?.createdBy ?? user.uid,
      createdAt: existingRecord?.createdAt ?? Date.now(),
      updatedBy: existingRecord ? user.uid : undefined,
      updatedAt: Date.now()
    };
  }, [editingStockInId, monthId, products, selectedDay, selectedDayRecord?.stockIn, stockInMode, stockInNotes, stockInPaidAmount, stockInQuantities, user.uid]);

  async function saveStockIn() {
    if (!canEdit) {
      onStatus("Your role can view Stock Ledger but cannot edit this day.");
      return;
    }
    if (!previewStockInRecord) return;
    const validation = validateStockInDraft(
      dayDate(monthId, selectedDay),
      stockInMode,
      stockInQuantities,
      stockInPaidAmount,
      products
    );
    if (!validation.valid) {
      onStatus(validation.errors.join(" "));
      return;
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const stockIn = [
      ...(selectedDayRecord?.stockIn ?? []).filter((record) => record.id !== editingStockInId),
      previewStockInRecord
    ];
    const nextDay = buildStockDayRecord({
      month: workingMonth,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      entries: selectedDayRecord?.entries ?? [],
      stockIn,
      previous: selectedDayRecord,
      createdBy: user.uid
    });
    setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));

    if (isPostgreSqlPeriod(monthId)) {
      try {
        const dayId = await resolveAccountingDayId(monthId, selectedDay);
        if (dayId) {
          const orderLines = Object.entries(stockInQuantities)
            .filter(([_, q]) => Number(q) > 0)
            .map(([pId, q]) => ({
              product_id: pId,
              quantity: Math.round(Number(q)),
              unit_rate: products.find((p) => p.id === pId)?.rate ?? 0
            }));
          if (orderLines.length > 0) {
            await ledgerApiClient.stockOrders.create({
              day_id: dayId,
              direction: "inbound",
              supplier_name: "Jazz Company",
              notes: stockInNotes || null,
              lines: orderLines
            });
          }
          if (previewStockInRecord && previewStockInRecord.paidAmount > 0) {
            await recordJazzCompanyPaymentPostgres(monthId, selectedDay, {
              amount: previewStockInRecord.paidAmount,
              paymentReference: stockInNotes || null,
              notes: stockInNotes ? `Stock In payment: ${stockInNotes}` : "Stock In payment to Jazz Company"
            });
          }
        }
        onStatus(`Saved Stock In from Jazz Company to PostgreSQL.`);
      } catch (error) {
        onStatus(error instanceof Error ? error.message : "Failed to save Stock In to PostgreSQL.");
      }
      setStockInQuantities({});
      setStockInMode("cash");
      setStockInPaidAmount(0);
      setStockInNotes("");
      setEditingStockInId(null);
      return;
    }

    onQueueWrite(saveStockDay(workingMonth, nextDay, days, user, role, "save-day", {
      skipLedgerV2RawEntryWrites: !shouldMirrorStockLedgerV2RawEntries,
      skipProductBalanceWrites: !shouldWriteCurrentStockDerivedBalances,
      skipAccountBalanceWrites: !shouldWriteCurrentStockDerivedBalances,
      skipJazzCompanyBalanceWrite: !shouldWriteCurrentStockDerivedBalances
    }), "Could not queue stock-in save.");
    onStatus(`${editingStockInId ? "Updated" : "Saved"} Stock In from Jazz Company. totalAmount: ${formatMoney(previewStockInRecord.totalAmount)}, paid: ${formatMoney(previewStockInRecord.paidAmount)}`);
    // Clear form
    setStockInQuantities({});
    setStockInMode("cash");
    setStockInPaidAmount(0);
    setStockInNotes("");
    setEditingStockInId(null);
  }

  async function closeSelectedDay() {
    if (!roleCanStock(role, "daily") || (role !== "owner" && role !== "admin")) {
      onStatus("Only owner/admin can close Stock Ledger days.");
      return;
    }
    if (month?.status === "closed") {
      onStatus("Reopen the Stock Ledger month before closing days.");
      return;
    }
    if (isFutureDay(monthId, selectedDay, now)) {
      onStatus("Future Stock Ledger days are disabled.");
      return;
    }
    if (!window.confirm(`Close Stock Ledger day ${selectedDay}? Inputs and saves will be locked until an explicit reopen.`)) {
      return;
    }

    if (isPostgreSqlPeriod(monthId)) {
      try {
        await closeOperationalDayUnified({
          monthId,
          dayNo: selectedDay,
          flushDraft: async () => {
            if (inFlightSavePromiseRef.current) {
              await inFlightSavePromiseRef.current;
            }
            if (hasPendingStockChanges || stockDraftDirtyRef.current) {
              await saveEntry(draft, { throwOnError: true });
            }
            return true;
          }
        });
        closedDayKeysRef.current.add(`${monthId}/${selectedDay}`);
        setDays((current) => current.map((day) => day.dayNo === selectedDay ? { ...day, status: "closed", closedAt: Date.now(), lockedAt: Date.now() } : day));
        onStatus(`Closed Stock day ${selectedDay} in PostgreSQL authoritative ledger.`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to close Stock day in PostgreSQL.";
        onStatus(message);
        return;
      }
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    const dayKey = `${monthId}/${selectedDay}`;
    const baseDay = selectedDayRecord ?? buildStockDayRecord({
      month: workingMonth,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      entries: [],
      createdBy: user.uid,
      timestamp
    });
    const nextDay = {
      ...baseDay,
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
    closedDayKeysRef.current.add(dayKey);
    setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
    const closePromise = updateStockDaysStatusBatch(workingMonth, [nextDay], days, user, role, "close-days")
      .then((result) => {
        setDays(result.days);
        setSummary(result.summary);
      })
      .catch((error) => {
        closedDayKeysRef.current.delete(dayKey);
        setDays((current) => {
          const withoutSelected = current.filter((day) => day.dayNo !== selectedDay);
          return selectedDayRecord
            ? [...withoutSelected, selectedDayRecord].sort((a, b) => a.dayNo - b.dayNo)
            : withoutSelected;
        });
        throw error;
      });
    onQueueWrite(closePromise, "Could not queue stock day close.");
    onStatus(`Closed stock day ${selectedDay}.`);
  }

  async function reopenSelectedDay() {
    if (!canReopenSelectedDay) {
      onStatus("Only owner can reopen Stock Ledger days.");
      return;
    }
    if (!window.confirm(`Reopen Stock Ledger day ${selectedDay}?`)) {
      return;
    }

    if (isPostgreSqlPeriod(monthId)) {
      try {
        await reopenOperationalDayUnified({
          monthId,
          dayNo: selectedDay,
          reason: "Reopened by owner"
        });
        closedDayKeysRef.current.delete(`${monthId}/${selectedDay}`);
        setDays((current) => current.map((day) => day.dayNo === selectedDay ? { ...day, status: "reopen", reopenedAt: Date.now() } : day));
        onStatus(`Reopened Stock day ${selectedDay} in PostgreSQL authoritative ledger.`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to reopen Stock day in PostgreSQL.";
        onStatus(message);
        return;
      }
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    closedDayKeysRef.current.delete(`${monthId}/${selectedDay}`);
    const day = selectedDayRecord ?? buildStockDayRecord({
      month: workingMonth,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      entries: [],
      createdBy: user.uid,
      timestamp
    });
    const nextDay = {
      ...day,
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
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(updateStockDaysStatusBatch(workingMonth, [nextDay], days, user, role, "reopen-days"), "Could not queue stock day reopen.");
    onStatus(`Reopened stock day ${selectedDay} until you close it again.`);
  }

  async function closeAllStock() {
    if (role !== "owner") {
      onStatus("Only owner can close all previous Stock Ledger days.");
      return;
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    const live = currentDateState(now);
    const targetDayNos = availableDays(monthId, now).filter((dayNo) => !(monthId === live.monthId && dayNo === live.dayNo));
    if (targetDayNos.length === 0) {
      onStatus("No previous Stock Ledger days are available to close.");
      return;
    }
    const nextClosedDays = targetDayNos.map((dayNo) => {
      const existing = days.find((day) => day.dayNo === dayNo) ?? buildStockDayRecord({
        month: workingMonth,
        dayNo,
        date: dayDate(monthId, dayNo),
        entries: [],
        createdBy: user.uid,
        timestamp
      });
      return {
        ...existing,
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
    });
    const nextDays = nextClosedDays.reduce(
      (updatedDays, closedDay) => [...updatedDays.filter((day) => day.dayNo !== closedDay.dayNo), closedDay].sort((a, b) => a.dayNo - b.dayNo),
      days
    );
    setDays(nextDays);
    nextClosedDays.forEach((day) => closedDayKeysRef.current.add(`${monthId}/${day.dayNo}`));
    const closePromise = updateStockDaysStatusBatch(workingMonth, nextClosedDays, days, user, role, "close-days")
      .then((result) => {
        setDays(result.days);
        setSummary(result.summary);
      });
    onQueueWrite(closePromise, "Could not close all previous stock ledger days.");
    onStatus(`Closed ${nextClosedDays.length} Stock Ledger day${nextClosedDays.length === 1 ? "" : "s"} except today.`);
  }

  async function reopenAllStock() {
    if (role !== "owner") {
      onStatus("Only owner can reopen all Stock Ledger days.");
      return;
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    const targetDayNos = availableDays(monthId, now).filter((dayNo) => {
      const day = days.find((item) => item.dayNo === dayNo);
      return day?.status !== "reopen" && (day?.status === "closed" || Boolean(day?.lockedAt || day?.closedAt || day?.reopenedUntilAt));
    });
    const nextReopenedDays = targetDayNos.map((dayNo) => {
      const existing = days.find((day) => day.dayNo === dayNo) ?? buildStockDayRecord({
        month: workingMonth,
        dayNo,
        date: dayDate(monthId, dayNo),
        entries: [],
        createdBy: user.uid,
        timestamp
      });
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
    const nextDays = nextReopenedDays.reduce(
      (updatedDays, reopenedDay) => [...updatedDays.filter((day) => day.dayNo !== reopenedDay.dayNo), reopenedDay].sort((a, b) => a.dayNo - b.dayNo),
      days
    );
    setDays(nextDays);
    nextReopenedDays.forEach((day) => closedDayKeysRef.current.delete(`${monthId}/${day.dayNo}`));
    const reopenPromise = updateStockDaysStatusBatch(workingMonth, nextReopenedDays, days, user, role, "reopen-days")
      .then((result) => {
        setMonths((current) => [result.month, ...current.filter((item) => item.id !== result.month.id)].sort((a, b) => b.id.localeCompare(a.id)));
        setDays(result.days);
        setSummary(result.summary);
      });
    onQueueWrite(reopenPromise, "Could not reopen all stock ledger days.");
    onStatus(`Reopened ${nextReopenedDays.length} Stock Ledger days until manually closed.`);
  }

  async function masterRefreshStockCalculations() {
    if (!roleCanStock(role, MASTER_REFRESH_ACCESS)) {
      onStatus("Only owner/admin can run Stock Ledger master calculations.");
      return;
    }
    const adapter = createStockRecalculationAdapter({
      monthId,
      canRun: roleCanStock(role, MASTER_REFRESH_ACCESS),
      disabledReason: "Only owner/admin can run Stock Ledger master refresh.",
      run: async () => {
        const result = await recalculateStockLedgerLocal(monthId, user, role);
        setMonths((current) => [result.month, ...current.filter((item) => item.id !== result.month.id)].sort((a, b) => b.id.localeCompare(a.id)));
        setDays(result.days);
        setSummary(result.summary);
        return {
          daysChecked: result.days.length,
          mismatchesCorrected: result.days.length,
          monthlySummariesUpdated: 1,
          message: "Stock Ledger openings now follow previous closings."
        };
      }
    });
    if (onTriggerMasterRefresh) {
      await onTriggerMasterRefresh(adapter, "Stock Ledger");
    } else {
      onQueueWrite(runMasterRecalculation({ adapter }), "Could not refresh Stock Ledger calculations.");
      onStatus("Stock Ledger master refresh queued.");
    }
  }

  async function handleSaveStockProduct(row: StockProduct) {
    if (!canManageSettings) return;
    if (isPostgreSqlPeriod(monthId)) {
      try {
        const isExisting = Boolean(row.id && products.some((p) => p.id === row.id));
        if (isExisting) {
          const res = await ledgerApiClient.catalogs.updateStockProduct(row.id, {
            name: row.name.trim(),
            rate: Number(row.rate ?? 0),
            payment_tracking_enabled: row.paymentTrackingEnabled !== false,
            is_active: row.active ?? true,
            sort_order: row.sortOrder ?? row.displayOrder
          });
          const updated = res.data;
          setProducts((prev) =>
            prev.map((p) =>
              p.id === updated.id
                ? {
                    ...p,
                    name: updated.name,
                    rate: Number(updated.rate ?? 0),
                    active: updated.is_active,
                    sortOrder: updated.sort_order,
                    displayOrder: Number(updated.sort_order ?? p.displayOrder),
                    paymentTrackingEnabled: updated.payment_tracking_enabled
                  }
                : p
            )
          );
          onStatus(`${row.name} updated in PostgreSQL catalog.`);
          return;
        }

        const productSlug = (slug(row.name) || "product").replace(/[^a-z0-9_-]/g, "-");
        const res = await ledgerApiClient.catalogs.createStockProduct({
          slug: productSlug,
          name: row.name.trim(),
          rate: Number(row.rate ?? 0),
          payment_tracking_enabled: row.paymentTrackingEnabled !== false,
          is_active: row.active ?? true,
          sort_order: row.sortOrder ?? row.displayOrder ?? (products.length + 1)
        });
        const created = res.data;
        const newProduct: StockProduct = {
          id: created.id,
          name: created.name,
          rate: Number(created.rate ?? 0),
          active: created.is_active,
          displayOrder: Number(created.sort_order ?? 0),
          sortOrder: created.sort_order,
          category: "sim",
          paymentTrackingEnabled: created.payment_tracking_enabled,
          createdBy: "system",
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        setProducts((prev) => [...prev.filter((p) => p.id !== newProduct.id), newProduct]);
        onStatus(`${row.name} created in PostgreSQL catalog.`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save stock product to PostgreSQL.";
        onStatus(msg);
        throw err;
      }
    }
    return onQueueWrite(
      upsertStockProduct(
        {
          ...row,
          paymentTrackingEnabled: row.paymentTrackingEnabled !== false
        },
        user,
        role
      ),
      "Could not save stock product."
    );
  }

  async function handleDeleteStockProduct(id: string) {
    if (!canManageSettings) return;
    if (isPostgreSqlPeriod(monthId)) {
      try {
        await ledgerApiClient.catalogs.updateStockProduct(id, { is_active: false });
        setProducts((prev) =>
          prev.map((p) => (p.id === id ? { ...p, active: false } : p))
        );
        onStatus("Stock product deactivated in PostgreSQL catalog.");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to delete stock product in PostgreSQL.";
        onStatus(msg);
        throw err;
      }
    }
    return onQueueWrite(deleteStockProduct(id, user, role), "Could not delete stock product.");
  }

  async function handleReorderStockProducts(before: Array<StockProduct | StockAccountProfile>, after: Array<StockProduct | StockAccountProfile>) {
    if (!canManageSettings) return;
    const typedBefore = before as StockProduct[];
    const typedAfter = after as StockProduct[];
    if (isPostgreSqlPeriod(monthId)) {
      const patches = changedSortOrderPatches(typedBefore, typedAfter);
      if (patches.length === 0) return;
      try {
        await Promise.all(
          patches.map((p) =>
            ledgerApiClient.catalogs.updateStockProduct(p.id, { sort_order: p.sortOrder })
          )
        );
        const orderMap = new Map(patches.map((p) => [p.id, p.sortOrder]));
        setProducts((prev) =>
          prev.map((p) =>
            orderMap.has(p.id)
              ? { ...p, sortOrder: orderMap.get(p.id)!, displayOrder: orderMap.get(p.id)! }
              : p
          )
        );
        onStatus("Stock products reordered in PostgreSQL.");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to reorder stock products in PostgreSQL.";
        onStatus(msg);
        throw err;
      }
    }
    return onQueueWrite(updateStockProductSortOrder(typedBefore, typedAfter), "Could not reorder stock products.");
  }

  async function handleSaveStockAccount(row: StockAccountProfile) {
    if (!canManageSettings) return;
    if (isPostgreSqlPeriod(monthId)) {
      try {
        const isExisting = Boolean(row.id && accounts.some((a) => a.id === row.id));
        if (isExisting) {
          const res = await ledgerApiClient.catalogs.updateStockAccount(row.id, {
            name: row.name.trim(),
            type: row.type,
            is_active: row.active ?? true,
            sort_order: row.sortOrder ?? row.displayOrder,
            notes: row.notes ?? null
          });
          const updated = res.data;
          setAccounts((prev) =>
            prev.map((a) =>
              a.id === updated.id
                ? {
                    ...a,
                    name: updated.name,
                    type: updated.type as StockAccountType,
                    active: updated.is_active,
                    sortOrder: updated.sort_order,
                    displayOrder: Number(updated.sort_order ?? a.displayOrder)
                  }
                : a
            )
          );
          onStatus(`${row.name} updated in PostgreSQL catalog.`);
          return;
        }

        const accountSlug = (slug(row.name) || "account").replace(/[^a-z0-9_-]/g, "-");
        const res = await ledgerApiClient.catalogs.createStockAccount({
          slug: accountSlug,
          name: row.name.trim(),
          type: row.type,
          is_active: row.active ?? true,
          sort_order: row.sortOrder ?? row.displayOrder ?? (accounts.length + 1),
          notes: row.notes ?? null
        });
        const created = res.data;
        const newAccount: StockAccountProfile = {
          id: created.id,
          name: created.name,
          type: created.type as StockAccountType,
          openingBalance: 0,
          active: created.is_active,
          displayOrder: Number(created.sort_order ?? 0),
          sortOrder: created.sort_order,
          notes: created.notes ?? undefined,
          createdBy: "system",
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        setAccounts((prev) => [...prev.filter((a) => a.id !== newAccount.id), newAccount]);
        onStatus(`${row.name} created in PostgreSQL catalog.`);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to save stock account to PostgreSQL.";
        onStatus(msg);
        throw err;
      }
    }
    return onQueueWrite(upsertStockAccount(row, user, role), "Could not save stock account.");
  }

  async function handleDeleteStockAccount(id: string) {
    if (!canManageSettings) return;
    if (isPostgreSqlPeriod(monthId)) {
      try {
        await ledgerApiClient.catalogs.updateStockAccount(id, { is_active: false });
        setAccounts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, active: false } : a))
        );
        onStatus("Stock account deactivated in PostgreSQL catalog.");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to delete stock account in PostgreSQL.";
        onStatus(msg);
        throw err;
      }
    }
    return onQueueWrite(deleteStockAccount(id, user, role), "Could not delete stock account.");
  }

  async function handleReorderStockAccounts(before: Array<StockProduct | StockAccountProfile>, after: Array<StockProduct | StockAccountProfile>) {
    if (!canManageSettings) return;
    const typedBefore = before as StockAccountProfile[];
    const typedAfter = after as StockAccountProfile[];
    if (isPostgreSqlPeriod(monthId)) {
      const patches = changedSortOrderPatches(typedBefore, typedAfter);
      if (patches.length === 0) return;
      try {
        await Promise.all(
          patches.map((p) =>
            ledgerApiClient.catalogs.updateStockAccount(p.id, { sort_order: p.sortOrder })
          )
        );
        const orderMap = new Map(patches.map((p) => [p.id, p.sortOrder]));
        setAccounts((prev) =>
          prev.map((a) =>
            orderMap.has(a.id)
              ? { ...a, sortOrder: orderMap.get(a.id)!, displayOrder: orderMap.get(a.id)! }
              : a
          )
        );
        onStatus("Stock accounts reordered in PostgreSQL.");
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to reorder stock accounts in PostgreSQL.";
        onStatus(msg);
        throw err;
      }
    }
    return onQueueWrite(updateStockAccountSortOrder(typedBefore, typedAfter), "Could not reorder stock accounts.");
  }

  function getAccountLine(account: StockAccountProfile): string {
    if (account.notes?.startsWith("Line:")) {
      return account.notes.replace(/^Line:\s*/i, "").trim();
    }
    const norm = (s: string) => s.toLowerCase().replace(/^do\s+/, "").replace(/[^a-z0-9]/g, "");
    const targetNorm = norm(account.name);
    const matched = doProfiles.find((p) => norm(p.do_name) === targetNorm);
    return matched?.do_line || account.notes || "—";
  }

  async function handleSyncWithDoDirectory() {
    if (!canManageSettings) return;
    try {
      const res = await ledgerApiClient.catalogs.getJazzLoadDoProfiles(true);
      const profiles = res.data || [];
      if (profiles.length === 0) {
        onStatus("No DO profiles found in Master DO Directory.");
        return;
      }
      const norm = (s: string) => s.toLowerCase().replace(/^do\s+/, "").replace(/[^a-z0-9]/g, "");
      const existingNormalized = new Set(accounts.map((a) => norm(a.name)));

      let addedCount = 0;
      for (const p of profiles) {
        const normName = norm(p.do_name);
        if (!existingNormalized.has(normName)) {
          const accountSlug = (slug(`do-${p.do_name}`) || "do-account").replace(/[^a-z0-9_-]/g, "-");
          const createdRes = await ledgerApiClient.catalogs.createStockAccount({
            slug: accountSlug,
            name: p.do_name,
            type: "DO",
            is_active: p.is_active ?? true,
            sort_order: accounts.length + addedCount + 1,
            notes: p.do_line ? `Line: ${p.do_line}` : null
          });
          const created = createdRes.data;
          setAccounts((prev) => [
            ...prev,
            {
              id: created.id,
              name: created.name,
              type: "DO",
              openingBalance: 0,
              active: created.is_active,
              displayOrder: Number(created.sort_order ?? 0),
              sortOrder: created.sort_order,
              notes: created.notes ?? undefined,
              createdBy: "system",
              createdAt: Date.now(),
              updatedAt: Date.now()
            }
          ]);
          existingNormalized.add(normName);
          addedCount++;
        }
      }
      setDoProfiles(profiles);
      if (addedCount > 0) {
        onStatus(`Successfully synced ${addedCount} DO(s) from Master Directory into Stock Accounts!`);
      } else {
        onStatus("All DOs from Master Directory are already synchronized.");
      }
    } catch (err) {
      onStatus(err instanceof Error ? err.message : "Failed to sync DOs from Master Directory.");
    }
  }

  async function handleMoveAccount(index: number, direction: "up" | "down") {
    if (!canManageSettings) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= sortedAccounts.length) return;
    const reordered = [...sortedAccounts];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    const updated = applySortOrder(reordered).map((a) => ({
      ...a,
      sortOrder: a.sortOrder ?? a.displayOrder,
      displayOrder: a.sortOrder ?? a.displayOrder
    }));
    await handleReorderStockAccounts(sortedAccounts, updated);
  }

  async function handleMoveProduct(index: number, direction: "up" | "down") {
    if (!canManageSettings) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= sortedProducts.length) return;
    const reordered = [...sortedProducts];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    const updated = applySortOrder(reordered).map((p) => ({
      ...p,
      sortOrder: p.sortOrder ?? p.displayOrder,
      displayOrder: p.sortOrder ?? p.displayOrder
    }));
    await handleReorderStockProducts(sortedProducts, updated);
  }

  async function handleAddAccount() {
    if (!canManageSettings || !newAccountName.trim()) return;
    const name = newAccountName.trim();
    const type = newAccountType;
    const line = newAccountLine.trim();
    const nextOrder = accounts.length + 1;
    await handleSaveStockAccount({
      id: slug(name),
      name,
      type,
      active: true,
      displayOrder: nextOrder,
      sortOrder: nextOrder,
      notes: line ? `Line: ${line}` : undefined,
      createdBy: "system",
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as StockAccountProfile);
    setNewAccountName("");
    setNewAccountLine("");
  }

  async function handleSaveEditAccount(account: StockAccountProfile) {
    if (!canManageSettings || !editAccountName.trim()) return;
    const name = editAccountName.trim();
    const type = editAccountType;
    const line = editAccountLine.trim();
    await handleSaveStockAccount({
      ...account,
      name,
      type,
      notes: line ? `Line: ${line}` : account.notes,
      updatedAt: Date.now()
    });
    setEditingAccountId(null);
  }

  async function handleAddProduct() {
    if (!canManageSettings || !newProductName.trim()) return;
    const name = newProductName.trim();
    const rate = Number(newProductRate) || 0;
    const nextOrder = products.length + 1;
    await handleSaveStockProduct({
      id: slug(name),
      name,
      rate,
      paymentTrackingEnabled: newProductPaymentTracking,
      active: true,
      displayOrder: nextOrder,
      sortOrder: nextOrder,
      createdBy: "system",
      createdAt: Date.now(),
      updatedAt: Date.now()
    } as StockProduct);
    setNewProductName("");
    setNewProductRate(0);
  }

  async function handleSaveEditProduct(product: StockProduct) {
    if (!canManageSettings || !editProductName.trim()) return;
    const name = editProductName.trim();
    const rate = Number(editProductRate) || 0;
    await handleSaveStockProduct({
      ...product,
      name,
      rate,
      paymentTrackingEnabled: editProductPaymentTracking,
      updatedAt: Date.now()
    });
    setEditingProductId(null);
  }

  const stockAutosaveData = useMemo(
    () => ({
      monthId,
      selectedDay,
      selectedAccountId,
      draft
    }),
    [draft, monthId, selectedAccountId, selectedDay]
  );

  const stockEntryAutoSave = useAutoSaveEntry({
    data: stockAutosaveData,
    enabled: stockDraftDirtyRef.current && Boolean(stockDailyReady && canEdit && selectedAccount && previewEntry && !monthBootstrapPending && section === "daily"),
    disabled: !stockDailyReady || !canEdit || !selectedAccount || !previewEntry || monthBootstrapPending || section !== "daily" || !stockDraftDirtyRef.current,
    debounceMs: 900,
    resetKey: `${monthId}-${selectedDay}-${selectedAccountId}`,
    validate: (snapshot) => {
      if (!stockDailyReady) return "Loading Stock Ledger data.";
      if (!selectedAccount) return "Select an account.";
      const snapshotDraft = snapshot.draft;
      const hasMovement = Object.values(snapshotDraft.productQuantities).some((quantity) => quantity !== 0) ||
        (snapshotDraft.paymentReceived ?? 0) !== 0 ||
        Boolean(snapshotDraft.notes?.trim()) ||
        Boolean(selectedEntry);
      if (!hasMovement) return "Enter stock movement before autosave.";
      return validateStockDraft(snapshotDraft, products, selectedAccount).errors;
    },
    save: async (snapshot) => {
      const p = saveEntry(snapshot.draft, { throwOnError: true });
      inFlightSavePromiseRef.current = p.then(() => {});
      try {
        await p;
      } finally {
        inFlightSavePromiseRef.current = null;
      }
    }
  });

  const hasPendingStockChanges = stockDraftDirtyRef.current && (
    stockEntryAutoSave.autoSaveStatus === "typing" ||
    stockEntryAutoSave.autoSaveStatus === "saving" ||
    stockEntryAutoSave.autoSaveStatus === "unsaved"
  );

  useEffect(() => {
    onPendingStateChange?.(hasPendingStockChanges);
    return () => {
      onPendingStateChange?.(false);
    };
  }, [hasPendingStockChanges, onPendingStateChange]);

  useEffect(() => {
    return subscribeDayStatus((event) => {
      if (event.monthId === monthId) {
        if (event.status === "closed") {
          closedDayKeysRef.current.add(`${monthId}/${event.dayNo}`);
        } else {
          closedDayKeysRef.current.delete(`${monthId}/${event.dayNo}`);
        }
        setDays((current) => current.map((day) => day.dayNo === event.dayNo ? { ...day, status: event.status } : day));
      }
    });
  }, [monthId]);

  const sidebarDayControls = useMemo(() => (
    <>
      <p className="text-xs font-semibold uppercase text-slate-500">Day Controls</p>
      {/* <p className="mt-1 text-sm font-semibold text-white">{dayDate(monthId, selectedDay)}</p> */}
      <UniversalCalendar
        moduleKey="stock"
        monthId={monthId}
        selectedDay={selectedDay}
        days={stockCalendarDays}
        now={now}
        disabled={!stockDaysInitialized}
        onSelect={setSelectedDay}
        variant="mini"
      />
      <UniversalDayControlBar
        moduleKey="stock"
        selectedDateLabel={dayDate(monthId, selectedDay)}
        selectedMonthLabel={monthLabel(monthId)}
        selectedStatus={selectedStockStatus}
        role={role}
        density="compact"
        busy={Boolean(loading) || monthBootstrapPending || !stockDailyReady}
        autoSaveStatus={section === "daily" ? (!stockDailyReady ? "readOnly" : canEdit ? stockEntryAutoSave.autoSaveStatus : selectedDayRecord?.status === "closed" ? "closed" : "readOnly") : undefined}
        permissions={{
          canCloseSelectedDay: roleCanStock(role, "daily") &&
            (role === "owner" || role === "admin") &&
            month?.status !== "closed" &&
            !isFutureDay(monthId, selectedDay, now) &&
            selectedDayRecord?.status !== "closed" &&
            !monthBootstrapPending,
          canReopenSelectedDay: canReopenSelectedDay && month?.status !== "closed" && !monthBootstrapPending,
          canReopenAllDays: role === "owner" && !monthBootstrapPending && availableDays(monthId, now).length > 0,
          canClosePreviousDaysExceptToday: role === "owner" && month?.status !== "closed" && !monthBootstrapPending,
          canRunMasterRefresh: roleCanStock(role, MASTER_REFRESH_ACCESS),
          closeDisabledReason: "This Stock Ledger day cannot be closed.",
          reopenDisabledReason: "Only owner can reopen Stock Ledger days.",
          reopenAllDisabledReason: "Only owner can reopen all Stock Ledger days.",
          closePreviousDisabledReason: "Only owner can close previous Stock Ledger days.",
          masterRefreshDisabledReason: "Only owner/admin can run master refresh."
        }}
        onCloseSelectedDay={closeSelectedDay}
        onReopenSelectedDay={reopenSelectedDay}
        onReopenAllDays={reopenAllStock}
        onClosePreviousDaysExceptToday={closeAllStock}
        onRunMasterRefresh={masterRefreshStockCalculations}
        extraActions={
          <>
            <button
              className="btn-primary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={!canEdit || Boolean(loading) || monthBootstrapPending}
              onClick={() => void saveEntry()}
            >
              <Save />
              Save
            </button>
	            <button
	              className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
	              disabled={!canEdit || Boolean(loading) || monthBootstrapPending || verifiedSave?.status === "saving"}
	              title={!canEdit
                  ? selectedDayHasLegacyTimedReopen
                    ? "This day has legacy timed reopen data. Owner must reopen it again before saving."
                    : selectedDayIsCanonicalClosed || selectedDayIsLegacyLocked
                      ? "Reopen the day before saving."
                      : "You do not have permission to save this stock day."
                  : "Save immediately and wait for Firestore confirmation"}
	              onClick={() => void handleVerifiedSave()}
	            >
              <Save />
              Save Now & Verify
            </button>
            <button
              className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={!selectedDayRecord || monthBootstrapPending}
              onClick={() => selectedDayRecord && exportStockDayXlsx(selectedDayRecord)}
            >
              <FileSpreadsheet />
              Export Daily Excel
            </button>
            <button
              className="btn-secondary !h-9 w-full !justify-start !px-2 text-xs"
              disabled={!selectedDayRecord || monthBootstrapPending}
              onClick={() => selectedDayRecord && exportStockPrintable(calculateMonthlySummary(monthId, [selectedDayRecord]), [selectedDayRecord])}
            >
              <FileDown />
              Export Daily PDF
            </button>
          </>
        }
      />
    </>
  ), [
    canEdit,
    canReopenSelectedDay,
    days.length,
    loading,
    masterRefreshStockCalculations,
    month?.status,
    monthBootstrapPending,
    monthId,
    now,
    role,
    section,
    selectedDay,
    selectedDayRecord,
    selectedStockStatus,
    setSelectedDay,
    stockCalendarDays,
    stockEntryAutoSave.autoSaveStatus,
    verifiedSave?.status
  ]);
  useSidebarDayControls("stock", sidebarDayControls, canRead && section === "daily");

  useEffect(() => {
    if (section === "settings" && !canManageSettings) {
      setSection("daily");
      onStatus("Owner and Admin only. Stock Settings are restricted.");
    }
    if (section === "backup" && !canUseStockBackup) {
      setSection("reportsHub");
      onStatus("Owner only. Stock backup is restricted to owner access.");
    }
  }, [canManageSettings, canUseStockBackup, onStatus, section]);

  function metricSummary() {
    if (summary) return summary;
    const accountTotals: StockAccountMonthlyTotal[] = accounts.map((account) => {
      const entries = days.flatMap((d) => d.entries.filter((e) => e.accountId === account.id));
      const firstEntry = days.flatMap((d) => d.entries.filter((e) => e.accountId === account.id)).at(0);
      const opening = firstEntry ? firstEntry.carryForwardBalance : (openingBalances.stockAccountOpening?.[account.id] ?? account.openingBalance ?? 0);
      const totalQty = entries.reduce((s, e) => s + e.totalQty, 0);
      const totalAmount = entries.reduce((s, e) => s + e.totalAmount, 0);
      const totalPaymentReceived = entries.reduce((s, e) => s + e.totalPaymentReceived, 0);
      const dueBalance = roundMoney(opening + totalAmount - totalPaymentReceived);
      const activeDays = new Set(days.filter((d) => d.entries.some((e) => e.accountId === account.id)).map((d) => d.dayNo)).size;
      return {
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        totalQty,
        totalAmount,
        totalPaymentReceived,
        dueBalance,
        activeDays
      };
    });
    const totalDueBalance = roundMoney(accountTotals.reduce((sum, a) => sum + a.dueBalance, 0));
    return {
      monthId,
      totalQty: 0,
      totalAmount: 0,
      totalPaymentReceived: 0,
      totalDueBalance,
      productTotals: [],
      accountTotals,
      paymentTotals: [],
      dayRows: [],
      missingDays: [],
      updatedAt: Date.now()
    };
  }

  const metrics = metricSummary();
  const stockSections = useMemo(
    () => [
      { id: "daily" as const, label: "Daily Stock Issuance", icon: ArrowUpRight, show: true },
      { id: "stockIn" as const, label: "Stock Lifting (Stock In)", icon: PlusCircle, show: true },
      { id: "reportsHub" as const, label: "Reports & Summaries", icon: FileSpreadsheet, show: true },
      {
        id: "settings" as const,
        label: "Products & Accounts",
        icon: Settings,
        show: true,
        disabled: !canManageSettings,
        disabledReason: "Only owner and admin can manage Stock Settings."
      }
    ],
    [canManageSettings]
  );

  async function handleSectionChange(nextSection: StockSection) {
    if (nextSection === section) return;
    if (nextSection === "settings" && !canManageSettings) {
      onStatus("Owner and Admin only. Stock Settings are restricted to owner/admin access.");
      return;
    }
    if (nextSection === "backup" && !canUseStockBackup) {
      onStatus("Owner only. Stock backup is restricted to owner access.");
      return;
    }
    if (stockDraftDirtyRef.current && selectedAccount && canEdit) {
      try {
        await saveEntry(draft, { throwOnError: false });
      } catch (err) {
        console.warn("Autosave before section switch:", err);
      }
    } else if (hasPendingStockChanges) {
      if (!window.confirm("There are unsaved Stock changes. Leave this screen anyway?")) {
        return;
      }
    }
    setSection(nextSection);
  }

  if (!canRead) {
    return (
      <section className="panel">
        <h2>Stock Ledger</h2>
        <Alert
          variant="warning"
          title="Access Restricted"
          message="This account is not allowed to access Stock Ledger data."
        />
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <SaveProgressDialog state={verifiedSave} onClose={() => setVerifiedSave(null)} />
      {carryForwardWarnings.length > 0 && (role === "owner" || role === "admin") && (
        <Alert
          variant="warning"
          title="Opening Mismatches Detected"
          message={
            <div>
              <p>{carryForwardWarnings.length} Stock month-to-month opening mismatch{carryForwardWarnings.length === 1 ? "" : "es"} detected. Run Master Calculation Refresh to repair openings from the previous month final projection.</p>
              <ul className="mt-2 list-disc pl-5 text-xs space-y-0.5">
                {carryForwardWarnings.slice(0, 5).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          }
        />
      )}

      {/* Primary Stock Navigation Tabs */}
      {!hideOnPageTabs && (
        <div className="py-2">
          <nav aria-label="Stock navigation tabs" className="inline-flex flex-wrap gap-1 rounded-xl border border-slate-800 bg-slate-900/90 p-1.5 shadow-sm">
            {stockSections.map(({ id, label, icon: Icon, disabled, disabledReason }) => {
              const isActive = section === id || (id === "reportsHub" && section === "backup");
              return (
                <button
                  key={id}
                  type="button"
                  disabled={disabled}
                  title={disabled ? disabledReason : label}
                  onClick={() => handleSectionChange(id)}
                  className={`flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-all ${
                    isActive
                      ? "bg-slate-800 text-white shadow-sm ring-1 ring-slate-700/60"
                      : disabled
                      ? "cursor-not-allowed opacity-40 text-slate-500"
                      : "text-slate-400 hover:bg-slate-850 hover:text-slate-200"
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? "text-emerald-400" : "text-slate-500"}`} />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {section === "daily" && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
          {/* Left Column: Data entry and tables */}
          <div className="min-w-0 space-y-5">
            <section className="panel bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950/70 border-slate-800 shadow-xl">
              {/* Header with Title and Mode Switcher */}
              <div className="panel-title border-b border-slate-800/60 pb-4 flex-wrap gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2>Stock Issuance</h2>
                    {/* View Mode Toggle: All Dealers Sheet vs Single Dealer Focus */}
                    <div className="inline-flex rounded-lg border border-slate-800 bg-slate-950 p-1">
                      <button
                        type="button"
                        onClick={() => setEntryViewMode("sheet")}
                        className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-bold transition-all ${
                          entryViewMode === "sheet"
                            ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-500/50"
                            : "text-slate-400 hover:text-white"
                        }`}
                        title="Direct spreadsheet entry across all active dealers"
                      >
                        <Table className="h-3.5 w-3.5" />
                        <span>All Dealers Sheet</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEntryViewMode("focus")}
                        className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-bold transition-all ${
                          entryViewMode === "focus"
                            ? "bg-emerald-600 text-white shadow-sm ring-1 ring-emerald-500/50"
                            : "text-slate-400 hover:text-white"
                        }`}
                        title="Focused card selector and single dealer issuance form"
                      >
                        <User className="h-3.5 w-3.5" />
                        <span>Single Dealer Focus</span>
                      </button>
                    </div>
                  </div>
                  <p className="text-slate-400 text-sm mt-1">
                    {entryViewMode === "sheet"
                      ? "Direct spreadsheet entry across all active dealers and employees for today."
                      : `Issuing stock for ${selectedAccount?.name ?? "selected dealer"}.`}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {/* Screen reader accessible fallback select */}
                  <select
                    aria-label="Employee / Dealer"
                    title="Employee / Dealer"
                    className="sr-only"
                    value={selectedAccountId}
                    disabled={!stockDailyReady || !canEdit || activeAccounts.length === 0 || monthBootstrapPending}
                    onChange={(event) => void switchDealer(event.target.value)}
                  >
                    {activeAccounts.map((account) => (
                      <option key={account.id} value={account.id}>{account.name} · {account.type}</option>
                    ))}
                  </select>

                  <span className={`inline-flex whitespace-nowrap rounded-md border border-slate-800 bg-slate-950/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide ${
                    !canEdit
                      ? "text-slate-400"
                      : stockEntryAutoSave.autoSaveStatus === "saving" || saveInFlightRef.current
                      ? "text-amber-300"
                      : stockEntryAutoSave.autoSaveStatus === "error"
                      ? "text-rose-300"
                      : stockDraftDirtyRef.current
                      ? "text-amber-400"
                      : "text-emerald-300"
                  }`}>
                    {!stockDailyReady
                      ? "Loading..."
                      : !canEdit
                      ? "Day closed"
                      : stockEntryAutoSave.autoSaveStatus === "saving" || saveInFlightRef.current
                      ? "Saving…"
                      : stockEntryAutoSave.autoSaveStatus === "error"
                      ? "Save failed"
                      : stockDraftDirtyRef.current
                      ? "Unsaved changes"
                      : "Saved"}
                  </span>
                </div>
              </div>

              {/* Warnings */}
              {!stockDailyReady && <p className="status mt-4 bg-slate-500/10 text-slate-300 border border-slate-500/20 px-3 py-2 rounded-lg text-xs">Loading Stock Ledger data...</p>}
              {stockDailyReady && !canEdit && <p className="warning mt-4 bg-rose-500/10 text-rose-400 border border-rose-500/20 px-3 py-2 rounded-lg text-xs">This stock day is read-only for your role or current day status.</p>}
              {stockDailyReady && activeAccounts.length === 0 && <p className="warning mt-4 bg-amber-500/10 text-amber-400 border border-amber-500/20 px-3 py-2 rounded-lg text-xs">Add active CCR/DO accounts in Stock Settings before using daily stock entry.</p>}

              {/* MODE 1: ALL DEALERS SHEET (DIRECT GRID ENTRY) */}
              {entryViewMode === "sheet" && activeAccounts.length > 0 && (
                <div className="table-wrap mt-4">
                  <table className="stock-entry-table w-full">
                    <thead className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur-sm shadow-sm">
                      <tr>
                        <th className="w-32 max-w-[130px] text-left text-xs sticky top-0 left-0 z-30 bg-slate-900 shadow-sm border-r border-slate-800">
                          <span className="block leading-tight">Dealer /</span>
                          <span className="block leading-tight">Employee</span>
                        </th>
                        <th className="text-left text-xs min-w-[90px] sticky top-0 z-20 bg-slate-900">
                          <span className="block leading-tight">Opening</span>
                          <span className="block leading-tight">Balance</span>
                        </th>
                        {activeProducts.map((p) => {
                          const isColActive = activeColumnKey === `product:${p.id}`;
                          const [line1, line2] = splitProductName(p.name);
                          return (
                            <th
                              key={p.id}
                              className={`text-left text-xs min-w-[76px] sticky top-0 z-20 cursor-pointer transition-colors ${
                                isColActive
                                  ? "bg-emerald-950/90 text-emerald-300 ring-1 ring-inset ring-emerald-500/50 stock-col-active-th"
                                  : "bg-slate-900/95 text-white hover:bg-slate-800"
                              }`}
                              onClick={() => setActiveColumnKey(`product:${p.id}`)}
                              title={`Click to highlight column for ${p.name}`}
                            >
                              <span className={`block font-bold text-xs leading-tight whitespace-nowrap ${isColActive ? "text-emerald-300 font-extrabold" : "text-white"}`}>{line1}</span>
                              {line2 ? (
                                <span className={`block font-bold text-xs leading-tight whitespace-nowrap ${isColActive ? "text-emerald-300 font-extrabold" : "text-white"}`}>{line2}</span>
                              ) : null}
                              <span className={`block text-[10px] font-normal mt-0.5 whitespace-nowrap ${isColActive ? "text-emerald-400 font-semibold" : "text-slate-400"}`}>({formatMoney(p.rate)})</span>
                            </th>
                          );
                        })}
                        <th className="text-left text-xs sticky top-0 z-20 bg-slate-900">
                          <span className="block leading-tight">Total</span>
                          <span className="block leading-tight">Qty</span>
                        </th>
                        <th className="text-left text-xs min-w-[90px] sticky top-0 z-20 bg-slate-900">
                          <span className="block leading-tight">Stock</span>
                          <span className="block leading-tight">Amount</span>
                        </th>
                        {(() => {
                          const isPaymentActive = activeColumnKey === "paymentReceived";
                          return (
                            <th
                              className={`text-left text-xs min-w-[96px] sticky top-0 z-20 cursor-pointer transition-colors ${
                                isPaymentActive
                                  ? "bg-emerald-950/90 text-emerald-300 ring-1 ring-inset ring-emerald-500/50 stock-col-active-th"
                                  : "bg-slate-900/95 text-white hover:bg-slate-800"
                              }`}
                              onClick={() => setActiveColumnKey("paymentReceived")}
                              title="Click to highlight Payment Received column"
                            >
                              <span className={`block leading-tight ${isPaymentActive ? "text-emerald-300 font-bold" : ""}`}>Payment</span>
                              <span className={`block leading-tight ${isPaymentActive ? "text-emerald-300 font-bold" : ""}`}>Received</span>
                            </th>
                          );
                        })()}
                        <th className="text-left text-xs min-w-[90px] sticky top-0 z-20 bg-slate-900">
                          <span className="block leading-tight">Closing</span>
                          <span className="block leading-tight">Due</span>
                        </th>
                        <th className="w-8 text-center sticky top-0 z-20 bg-slate-900" title="Focus Single Dealer">
                          <Maximize2 className="h-3.5 w-3.5 inline text-slate-400" />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {allDealersSheetRows.map((row) => {
                        const isSelected = row.isSelected;
                        return (
                          <tr
                            key={row.account.id}
                            className={`transition-colors ${
                              isSelected
                                ? "bg-emerald-950/20 ring-1 ring-inset ring-emerald-500/40"
                                : "hover:bg-slate-900/50"
                            }`}
                          >
                            <td className={`w-32 max-w-[130px] truncate sticky left-0 z-10 border-r border-slate-800 transition-colors ${
                              isSelected ? "bg-emerald-950/90" : "bg-slate-900/95"
                            }`}>
                              <button
                                type="button"
                                onClick={() => void switchDealer(row.account.id)}
                                className={`text-left font-bold truncate block w-full transition-colors ${
                                  isSelected ? "text-emerald-300 font-extrabold" : "text-white hover:text-emerald-400"
                                }`}
                                title={row.account.name}
                              >
                                {row.account.name}
                              </button>
                            </td>
                            <td className="font-mono font-bold text-white whitespace-nowrap">
                              {formatMoney(row.openingDue)}
                            </td>

                            {/* Product Quantities */}
                            {activeProducts.map((product) => {
                              const qty = row.productQuantities[product.id] ?? 0;
                              const isColActive = activeColumnKey === `product:${product.id}`;
                              return (
                                <td
                                  key={product.id}
                                  className={`min-w-[76px] transition-colors ${
                                    isColActive
                                      ? isSelected
                                        ? "bg-emerald-900/40 ring-1 ring-inset ring-emerald-500/60 stock-col-active-cell-selected"
                                        : "bg-emerald-950/25 stock-col-active-cell"
                                      : ""
                                  }`}
                                >
                                  {isSelected ? (
                                    <NumberInput
                                      value={draft.productQuantities[product.id] ?? 0}
                                      disabled={!canEdit || monthBootstrapPending}
                                      className={`w-full min-w-[56px] max-w-[68px] !h-8 !py-1 !px-2 text-xs !font-normal text-center ${
                                        isColActive ? "!border-emerald-500 !ring-1 !ring-emerald-500/60 bg-emerald-950/50 text-emerald-200" : ""
                                      }`}
                                      onFocus={() => {
                                        focusStockDraftField(`product:${product.id}`);
                                        setActiveColumnKey(`product:${product.id}`);
                                      }}
                                      onBlur={() => blurStockDraftField(`product:${product.id}`)}
                                      onChange={(value) =>
                                        updateStockDraft((current) => ({
                                          ...current,
                                          productQuantities: {
                                            ...current.productQuantities,
                                            [product.id]: value
                                          }
                                        }))
                                      }
                                    />
                                  ) : (
                                    <input
                                      type="text"
                                      readOnly
                                      value={qty ? String(qty) : ""}
                                      placeholder="0"
                                      onClick={() => {
                                        void switchDealer(row.account.id);
                                        setActiveColumnKey(`product:${product.id}`);
                                      }}
                                      className={`cursor-pointer text-center font-mono !font-normal tabular-nums text-white w-full min-w-[56px] max-w-[68px] !h-8 !py-1 !px-2 text-xs transition-colors ${
                                        isColActive
                                          ? "bg-emerald-950/40 border border-emerald-500/40 text-emerald-200 hover:border-emerald-400"
                                          : "bg-slate-950/40 hover:border-slate-600"
                                      }`}
                                      title="Click to edit this dealer"
                                    />
                                  )}
                                </td>
                              );
                            })}

                            <td className="font-mono font-bold text-white whitespace-nowrap">
                              {formatMoney(row.totalQty)}
                            </td>
                            <td className="font-mono font-bold text-white whitespace-nowrap">
                              {formatMoney(row.totalAmount)}
                            </td>

                            {/* Payment Received */}
                            {(() => {
                              const isPaymentActive = activeColumnKey === "paymentReceived";
                              return (
                                <td
                                  className={`min-w-[96px] transition-colors ${
                                    isPaymentActive
                                      ? isSelected
                                        ? "bg-emerald-900/40 ring-1 ring-inset ring-emerald-500/60 stock-col-active-cell-selected"
                                        : "bg-emerald-950/25 stock-col-active-cell"
                                      : ""
                                  }`}
                                >
                                  {isSelected ? (
                                    <NumberInput
                                      value={draft.paymentReceived ?? 0}
                                      disabled={!canEdit || monthBootstrapPending}
                                      className={`w-full min-w-[80px] max-w-[100px] !h-8 !py-1 !px-2 text-xs !font-normal text-left ${
                                        isPaymentActive ? "!border-emerald-500 !ring-1 !ring-emerald-500/60 bg-emerald-950/50 text-emerald-200" : ""
                                      }`}
                                      onFocus={() => {
                                        focusStockDraftField("paymentReceived");
                                        setActiveColumnKey("paymentReceived");
                                      }}
                                      onBlur={() => blurStockDraftField("paymentReceived")}
                                      onChange={(value) =>
                                        updateStockDraft((current) => ({ ...current, paymentReceived: value }))
                                      }
                                    />
                                  ) : (
                                    <input
                                      type="text"
                                      readOnly
                                      value={row.paymentReceived ? String(row.paymentReceived) : ""}
                                      placeholder="0"
                                      onClick={() => {
                                        void switchDealer(row.account.id);
                                        setActiveColumnKey("paymentReceived");
                                      }}
                                      className={`cursor-pointer text-left font-mono !font-normal tabular-nums text-white w-full max-w-[76px] !h-7 !py-0.5 !px-1.5 text-xs transition-colors ${
                                        isPaymentActive
                                          ? "bg-emerald-950/40 border border-emerald-500/40 text-emerald-200 hover:border-emerald-400"
                                          : "bg-slate-950/40 hover:border-slate-600"
                                      }`}
                                      title="Click to edit this dealer"
                                    />
                                  )}
                                </td>
                              );
                            })()}

                            <td className="font-mono font-bold text-white whitespace-nowrap">
                              {formatMoney(row.closingDue)}
                            </td>

                            <td className="w-8 text-center">
                              <button
                                type="button"
                                onClick={() => {
                                  void switchDealer(row.account.id);
                                  setEntryViewMode("focus");
                                }}
                                className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 bg-slate-800 text-slate-300 hover:border-emerald-500 hover:bg-slate-700 hover:text-white transition-all shadow-sm"
                                title={`Focus on ${row.account.name}`}
                                aria-label={`Focus on ${row.account.name}`}
                              >
                                <Maximize2 className="h-3.5 w-3.5" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-700 bg-slate-950/90 font-bold text-white sticky bottom-0 z-20">
                        <td className="font-bold text-white uppercase tracking-wider text-xs sticky left-0 z-20 bg-slate-950 border-r border-slate-800">Total Franchise</td>
                        <td className="font-mono font-bold text-white whitespace-nowrap">
                          {formatMoney(sheetTotals.totalOpening)}
                        </td>
                        {activeProducts.map((p) => {
                          const isColActive = activeColumnKey === `product:${p.id}`;
                          return (
                            <td
                              key={p.id}
                              className={`font-mono font-bold whitespace-nowrap transition-colors ${
                                isColActive
                                  ? "bg-emerald-950/60 text-emerald-300 ring-1 ring-inset ring-emerald-500/40 stock-col-active-footer"
                                  : "text-white"
                              }`}
                            >
                              {formatMoney(sheetTotals.productQtyTotals[p.id] ?? 0)}
                            </td>
                          );
                        })}
                        <td className="font-mono font-bold text-white whitespace-nowrap">
                          {formatMoney(sheetTotals.grandTotalQty)}
                        </td>
                        <td className="font-mono font-bold text-white whitespace-nowrap">
                          {formatMoney(sheetTotals.grandTotalAmount)}
                        </td>
                        <td
                          className={`font-mono font-bold text-white whitespace-nowrap transition-colors ${
                            activeColumnKey === "paymentReceived"
                              ? "bg-emerald-950/60 text-emerald-300 ring-1 ring-inset ring-emerald-500/40 stock-col-active-footer"
                              : ""
                          }`}
                        >
                          {formatMoney(sheetTotals.grandTotalPayment)}
                        </td>
                        <td className="font-mono font-bold text-white whitespace-nowrap">
                          {formatMoney(sheetTotals.grandTotalClosingDue)}
                        </td>
                        <td className="w-8 text-center text-slate-600">—</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}

              {/* MODE 2: SINGLE DEALER FOCUS (CARDS + DETAILED FORM) */}
              {entryViewMode === "focus" && selectedAccount && previewEntry && (
                <div className="space-y-5 mt-4">
                  {/* Search & Dealer Selector Ribbon */}
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="relative min-w-[200px] flex-1 max-w-xs">
                        <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-400" />
                        <input
                          type="text"
                          value={dealerSearchQuery}
                          onChange={(e) => setDealerSearchQuery(e.target.value)}
                          placeholder="Search dealer by name or type..."
                          className="!pl-8 !py-1 text-xs"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={!prevDealer}
                          onClick={() => prevDealer && void switchDealer(prevDealer.id)}
                          className="btn-secondary !h-7 text-xs font-semibold px-2.5 disabled:opacity-30"
                          title="Previous dealer"
                        >
                          <ChevronLeft className="h-3.5 w-3.5 mr-0.5" />
                          Prev
                        </button>
                        <span className="text-xs font-mono font-bold text-slate-400">
                          {currentDealerIndex >= 0 ? `${currentDealerIndex + 1} / ${activeAccounts.length}` : ""}
                        </span>
                        <button
                          type="button"
                          disabled={!nextDealer}
                          onClick={() => nextDealer && void switchDealer(nextDealer.id)}
                          className="btn-secondary !h-7 text-xs font-semibold px-2.5 disabled:opacity-30"
                          title="Next dealer"
                        >
                          Next
                          <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
                        </button>
                      </div>
                    </div>

                    {/* Dealer Cards Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                      {filteredAccounts.map((account) => {
                        const isSelected = account.id === selectedAccountId;
                        const row = allDealersSheetRows.find((r) => r.account.id === account.id);
                        return (
                          <button
                            key={account.id}
                            type="button"
                            onClick={() => void switchDealer(account.id)}
                            className={`flex flex-col text-left p-2.5 rounded-xl border transition-all ${
                              isSelected
                                ? "border-emerald-500 bg-emerald-950/50 ring-1 ring-emerald-500 shadow-md"
                                : "border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900"
                            }`}
                          >
                            <div className="flex items-start justify-between gap-1">
                              <span className="font-bold text-white text-xs truncate">{account.name}</span>
                              <span className="text-[10px] font-semibold text-slate-400 uppercase shrink-0">{account.type}</span>
                            </div>
                            <div className="mt-1 flex items-center justify-between text-[11px]">
                              {row?.hasMovement ? (
                                <span className="text-emerald-400 font-bold font-mono">✓ Rs {formatMoney(row.totalAmount)}</span>
                              ) : (
                                <span className="text-slate-500 font-medium">• No entry</span>
                              )}
                            </div>
                            <div className="mt-0.5 text-[10px] font-mono text-slate-400 truncate">
                              Due: {formatMoney(row?.closingDue ?? 0)}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Focused Dealer Header & Notes */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
                    <div>
                      <h3 className="text-base font-bold text-white">
                        {selectedAccount.name}
                        <span className="ml-2 text-xs font-semibold uppercase text-slate-400">({selectedAccount.type})</span>
                      </h3>
                      <p className="text-xs text-slate-400">
                        Opening Due: <span className="font-mono font-bold text-white">{formatMoney(effectiveCarryForwardBalance)}</span>
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="w-52">
                        <span className="mb-1 block text-[10px] font-semibold uppercase text-slate-500">Notes</span>
                        <input
                          value={draft.notes ?? ""}
                          disabled={!canEdit || monthBootstrapPending}
                          onFocus={() => focusStockDraftField("notes")}
                          onBlur={() => blurStockDraftField("notes")}
                          onChange={(event) => updateStockDraft((current) => ({ ...current, notes: event.target.value }))}
                          placeholder="Optional note"
                          className="!py-1 text-xs"
                        />
                      </div>
                    </div>
                  </div>

                  <StockProductEntryTable
                    products={activeProducts}
                    quantities={draft.productQuantities}
                    quantityLabel="Quantity Issued"
                    totalQty={previewEntry.totalQty}
                    totalAmount={previewEntry.totalAmount}
                    disabled={!canEdit || monthBootstrapPending}
                    onQuantityFocus={(productId) => {
                      focusStockDraftField(`product:${productId}`);
                      setActiveColumnKey(`product:${productId}`);
                    }}
                    onQuantityBlur={(productId) => blurStockDraftField(`product:${productId}`)}
                    onQuantityChange={(productId, value) => updateStockDraft((current) => ({
                      ...current,
                      productQuantities: {
                        ...current.productQuantities,
                        [productId]: value
                      }
                    }))}
                  />

                  {!isLiveDay(monthId, selectedDay, now) && (
                    <Alert
                      variant="warning"
                      title="Past Date Warning"
                      message="Warning: You are editing a past date. Saving changes here will not automatically update later days' carry-forward balances. Please verify subsequent days' balances if you change today's due balance."
                    />
                  )}
                </div>
              )}
            </section>


          <section className="panel mt-6">
            <div className="panel-title">
              <div>
                <h2>{selectedAccount?.name ?? "Employee Monthly Summary"}</h2>
              </div>
              <FileSpreadsheet className="text-emerald-500" />
            </div>
            {selectedDealerMasterDayRows.length === 0 ? (
              <p className="warning mt-4">Select a CCR/DO/DSO account to view the dealer master summary.</p>
            ) : visibleSelectedDealerMasterDayRows.length === 0 ? (
              <p className="status mt-4">No employee stock issuance activity found for this month.</p>
            ) : (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                  {[
                    ["Opening Balance", selectedDealerMasterSummary?.opening ?? 0],
                    ["Total Quantity", selectedDealerMasterDayTotals.totalQty],
                    ["Total Amount", selectedDealerMasterDayTotals.totalAmount],
                    ["Payment", selectedDealerMasterDayTotals.totalPaymentReceived],
                    ["Closing Balance", selectedDealerMasterDayTotals.closing]
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border border-slate-800 bg-slate-950/40 px-3 py-2">
                      <p className="text-xs font-medium text-slate-400">{label}</p>
                      <p className="mt-1 font-mono text-sm font-semibold text-slate-100">{formatMoney(Number(value))}</p>
                    </div>
                  ))}
                </div>
                <div className="table-wrap mt-3">
                  <table className="table-compact w-full">
                    <thead className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur-sm shadow-sm">
                      <tr>
                        <th className="sticky top-0 left-0 z-30 bg-slate-900 border-r border-slate-800">Date</th>
                        <th className="sticky top-0 z-20 bg-slate-900">Opening Balance</th>
                        {activeProducts.map((p) => {
                          const isColActive = activeColumnKey === `product:${p.id}`;
                          return (
                            <th
                              key={p.id}
                              className={`text-left font-mono sticky top-0 z-20 cursor-pointer transition-colors ${
                                isColActive
                                  ? "bg-emerald-950/90 text-emerald-300 ring-1 ring-inset ring-emerald-500/50 stock-col-active-th"
                                  : "bg-slate-900/95 text-slate-300 hover:text-white"
                              }`}
                              onClick={() => setActiveColumnKey(`product:${p.id}`)}
                              title={`Click to highlight ${p.name}`}
                            >
                              {p.name}
                            </th>
                          );
                        })}
                        <th className="sticky top-0 z-20 bg-slate-900">Total Qty</th>
                        <th className="sticky top-0 z-20 bg-slate-900">Total Stock Amount</th>
                        <th
                          className={`sticky top-0 z-20 cursor-pointer transition-colors ${
                            activeColumnKey === "paymentReceived"
                              ? "bg-emerald-950/90 text-emerald-300 ring-1 ring-inset ring-emerald-500/50 stock-col-active-th"
                              : "bg-slate-900/95"
                          }`}
                          onClick={() => setActiveColumnKey("paymentReceived")}
                          title="Click to highlight Payment Received"
                        >
                          Payment Received
                        </th>
                        <th className="sticky top-0 z-20 bg-slate-900">Closing Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleSelectedDealerMasterDayRows.map((row) => (
                        <tr key={row.dayNo}>
                          <td className="font-bold text-white sticky left-0 z-10 bg-slate-900/95 border-r border-slate-800 whitespace-nowrap">{new Date(`${monthId}-${String(row.dayNo).padStart(2, "0")}T00:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}</td>
                          <td className="font-mono font-bold text-white">{formatMoney(row.opening)}</td>
                          {activeProducts.map((p) => {
                            const isColActive = activeColumnKey === `product:${p.id}`;
                            return (
                              <td
                                key={p.id}
                                className={`text-left font-mono font-bold transition-colors ${
                                  isColActive ? "bg-emerald-950/25 text-emerald-200 stock-col-active-cell" : "text-white"
                                }`}
                              >
                                {formatMoney(row.productTotals[p.id] ?? 0)}
                              </td>
                            );
                          })}
                          <td className="font-bold text-white">{formatMoney(row.totalQty)}</td>
                          <td className="font-mono font-bold text-white">{formatMoney(row.totalAmount)}</td>
                          <td
                            className={`font-bold font-mono transition-colors ${
                              activeColumnKey === "paymentReceived" ? "bg-emerald-950/25 text-emerald-200 stock-col-active-cell" : "text-white"
                            }`}
                          >
                            {formatMoney(row.totalPaymentReceived)}
                          </td>
                          <td className="font-bold font-mono text-white">{formatMoney(row.closing)}</td>
                        </tr>
                      ))}
                      <tr className="border-t border-slate-800 bg-slate-950/90 font-bold sticky bottom-0 z-20">
                        <td className="font-bold text-white sticky left-0 z-20 bg-slate-950 border-r border-slate-800">Total</td>
                        <td className="text-slate-500 font-bold">—</td>
                        {activeProducts.map((p) => {
                          const isColActive = activeColumnKey === `product:${p.id}`;
                          return (
                            <td
                              key={p.id}
                              className={`text-left font-mono font-bold transition-colors ${
                                isColActive ? "bg-emerald-950/60 text-emerald-300 ring-1 ring-inset ring-emerald-500/40 stock-col-active-footer" : "text-white"
                              }`}
                            >
                              {formatMoney(selectedDealerMasterDayTotals.productTotals[p.id] ?? 0)}
                            </td>
                          );
                        })}
                        <td className="font-bold text-white">{formatMoney(selectedDealerMasterDayTotals.totalQty)}</td>
                        <td className="font-mono font-bold text-white">{formatMoney(selectedDealerMasterDayTotals.totalAmount)}</td>
                        <td
                          className={`font-bold font-mono transition-colors ${
                            activeColumnKey === "paymentReceived" ? "bg-emerald-950/60 text-emerald-300 ring-1 ring-inset ring-emerald-500/40 stock-col-active-footer" : "text-white"
                          }`}
                        >
                          {formatMoney(selectedDealerMasterDayTotals.totalPaymentReceived)}
                        </td>
                        <td className="font-bold font-mono text-white">{formatMoney(selectedDealerMasterDayTotals.closing)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          <section className="panel mt-6">
            <div className="panel-title">
              <div>
                <h2>Stock Issuance Summary</h2>
                {/* <p>Reusable full-month issuance summary for all dealers and active products.</p> */}
              </div>
              <FileSpreadsheet className="text-emerald-500" />
            </div>
            <StockIssuanceSummaryTable
              products={products}
              accounts={accounts}
              days={days}
              prevSummary={prevSummary}
              stockAccountOpening={openingBalances.stockAccountOpening}
              filterStartDate={1}
              filterEndDate={daysInMonth(monthId)}
              filterProductId=""
              filterAccountType=""
              filterAccountId=""
              filterDueStatus=""
              filterDayStatus=""
              filterActiveStatus="all"
            />
          </section>
        </div>

        {/* Right-Side Vertical Panel: Day info & Operations at the top, followed by financial summary cards */}
        <aside className="space-y-3 xl:sticky xl:top-14 xl:self-start order-first xl:order-none">
          {/* Day and operations section — at the top */}
          <div className="rounded-xl border border-slate-800 bg-slate-900/90 p-4 shadow-xl shadow-black/30 backdrop-blur-sm space-y-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-white leading-tight">
                  {dayDate(monthId, selectedDay)}
                </h3>
                <span className="sr-only">{monthId}-{String(selectedDay).padStart(2, "0")}</span>
              </div>
              <StatusBadge
                status={
                  selectedDayStatus === "Closed"
                    ? "closed"
                    : selectedDayStatus === "Reopen"
                    ? "reopened"
                    : "open"
                }
              />
            </div>

            {/* {selectedDayRecord && isReopenActive(selectedDayRecord, now) && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-300 animate-pulse">
                Reopened until manual close
              </div>
            )}
            {selectedDayHasLegacyTimedReopen && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-[11px] font-semibold text-amber-300">
                Owner must reopen again before editing
              </div>
            )} */}

            {/* Save status */}
            <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80 text-xs">
              <span className="text-slate-400">Save Status:</span>
              <span className={`font-semibold uppercase ${
                !canEdit
                  ? "text-slate-400"
                  : (stockEntryAutoSave.autoSaveStatus === "saving" || saveInFlightRef.current)
                  ? "text-amber-300"
                  : stockEntryAutoSave.autoSaveStatus === "error"
                  ? "text-rose-300"
                  : stockDraftDirtyRef.current
                  ? "text-amber-400"
                  : "text-emerald-300"
              }`}>
                {!stockDailyReady
                  ? "Loading…"
                  : !canEdit
                  ? "Day closed"
                  : (stockEntryAutoSave.autoSaveStatus === "saving" || saveInFlightRef.current)
                  ? "Saving…"
                  : stockEntryAutoSave.autoSaveStatus === "error"
                  ? "Save failed"
                  : stockDraftDirtyRef.current
                  ? "Unsaved changes"
                  : "Saved"}
              </span>
            </div>

            {/* Primary Save Now & Verify button */}
            <div className="pt-1">
              <button
                type="button"
                className="btn-primary !h-11 w-full !justify-center text-sm font-bold tracking-wide shadow-md shadow-emerald-950/50"
                disabled={!canEdit || Boolean(loading) || monthBootstrapPending || verifiedSave?.status === "saving"}
                title={!canEdit
                  ? selectedDayHasLegacyTimedReopen
                    ? "This day has legacy timed reopen data. Owner must reopen it again before saving."
                    : selectedDayIsCanonicalClosed || selectedDayIsLegacyLocked
                      ? "Reopen the day before saving."
                      : "You do not have permission to save this stock day."
                  : "Save immediately and wait for confirmation"}
                onClick={() => void handleVerifiedSave()}
              >
                <Save className="h-4 w-4 mr-2" />
                Save Now & Verify
              </button>
            </div>

            {/* Operational buttons: Transfer Balance, History */}
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                className="btn-secondary !h-8 flex-1 !justify-center text-xs font-semibold flex items-center justify-center gap-1.5 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10 shrink-0 font-medium"
                disabled={!stockDailyReady || !canEdit || activeAccounts.length < 2 || monthBootstrapPending}
                onClick={() => void handleOpenTransferModal("new")}
                title="Transfer financial balance between people without stock or cash movements"
                data-testid="btn-transfer-balance"
              >
                <ArrowRightLeft className="h-3.5 w-3.5" />
                <span>Transfer Balance</span>
              </button>
              <button
                type="button"
                className="btn-secondary !h-8 flex-1 !justify-center text-xs font-semibold flex items-center justify-center gap-1.5 border-slate-700 text-slate-300 hover:text-white shrink-0 font-medium"
                disabled={!stockDailyReady || monthBootstrapPending}
                onClick={() => void handleOpenTransferModal("history")}
                title="View balance transfer history and reversals"
                data-testid="btn-transfer-history"
              >
                <History className="h-3.5 w-3.5 text-slate-400" />
                <span>History</span>
              </button>
            </div>
          </div>

          {/* Financial Summary Cards */}
          <div className="grid grid-cols-1 gap-3">
            {/* 1. Opening Balance */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-xl shadow-black/20">
              <p className="text-sm font-black uppercase tracking-wider text-white">Opening Balance</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white">
                {formatMoney(effectiveCarryForwardBalance)}
              </p>
            </div>

            {/* 2. Payment Received (with input) */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-2.5 shadow-xl shadow-black/20">
              <label className="text-sm font-black uppercase tracking-wider text-white shrink-0">
                Payment Received
              </label>
              <div className="w-36">
                <NumberInput
                  value={draft.paymentReceived ?? 0}
                  disabled={!canEdit || monthBootstrapPending}
                  onFocus={() => focusStockDraftField("paymentReceived")}
                  onBlur={() => blurStockDraftField("paymentReceived")}
                  onChange={(value) => updateStockDraft((current) => ({ ...current, paymentReceived: value }))}
                />
              </div>
            </div>

            {/* 3. Total Receivable */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-xl shadow-black/20">
              <p className="text-sm font-black uppercase tracking-wider text-white">Total Receivable</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white">
                {formatMoney(effectiveCarryForwardBalance + (previewEntry?.totalAmount ?? 0))}
              </p>
            </div>

            {/* 4. Stock Amount */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-xl shadow-black/20">
              <p className="text-sm font-black uppercase tracking-wider text-white">Stock Amount</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white">
                {formatMoney(previewEntry?.totalAmount ?? 0)}
              </p>
            </div>

            {/* 5. Closing Due Balance */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-xl shadow-black/20">
              <p className="text-sm font-black uppercase tracking-wider text-white">Closing Due Balance</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white">
                {formatMoney(previewEntry?.dueBalance ?? 0)}
              </p>
            </div>

            {/* 6. Issued Quantity */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/90 px-4 py-3 shadow-xl shadow-black/20">
              <p className="text-sm font-black uppercase tracking-wider text-white">Issued Quantity</p>
              <p className="text-xl font-bold font-mono tabular-nums text-white">
                {formatMoney(previewEntry?.totalQty ?? 0)}
              </p>
            </div>
          </div>
        </aside>
      </div>
    )}

      {section === "stockIn" && (
        <div className="space-y-5">
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Stock Received from Jazz Company</h2>
                {/* <p>Enter quantities received. Product rates are snapshots of current active prices.</p> */}
              </div>
              <PlusCircle className="text-emerald-500" />
            </div>

            {activeProducts.length === 0 ? (
              <p className="warning">No active stock products configured. Owner must configure Stock Settings first.</p>
            ) : (
              <div>
                <StockProductEntryTable
                  products={activeProducts}
                  quantities={stockInQuantities}
                  quantityLabel="Quantity Received"
                  totalQty={previewStockInRecord?.totalQty ?? 0}
                  totalAmount={previewStockInRecord?.totalAmount ?? 0}
                  disabled={!canEdit || monthBootstrapPending}
                  onQuantityChange={(productId, value) => setStockInQuantities((current) => ({
                    ...current,
                    [productId]: value
                  }))}
                  footerRows={(
                    <>
                      <tr>
                        <td>
                          <select
                            className="!h-8 !min-h-8"
                            value={stockInMode}
                            disabled={!canEdit || monthBootstrapPending}
                            onChange={(event) => {
                              const mode = event.target.value === "credit" ? "credit" : "cash";
                              setStockInMode(mode);
                              if (mode === "cash") setStockInPaidAmount(0);
                            }}
                          >
                            <option value="cash">Cash (Paid Fully)</option>
                            <option value="credit">Credit Party (Partial / Later)</option>
                          </select>
                        </td>
                        <td className="min-w-56">
                          <div className="flex h-8 items-center gap-2">
                            <span className="shrink-0 font-sans font-semibold text-slate-400">Paid Amount</span>
                            <div className="min-w-36 flex-1">
                              <NumberInput
                                value={stockInMode === "cash" ? (previewStockInRecord?.totalAmount ?? 0) : stockInPaidAmount}
                                disabled={!canEdit || stockInMode === "cash" || monthBootstrapPending}
                                onChange={(value) => setStockInPaidAmount(Math.max(0, value))}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="min-w-48 whitespace-nowrap font-mono text-rose-300">
                          <div className="flex h-8 items-center gap-2">
                            <span className="font-sans font-semibold text-slate-400">Payable</span>
                            <span>{formatMoney(previewStockInRecord?.jazzPayableAmount ?? 0)}</span>
                          </div>
                        </td>
                        <td>
                          <div className="flex h-8 items-center gap-2">
                          <input
                            type="text"
                            className="!h-8 !min-h-8"
                            value={stockInNotes}
                            disabled={!canEdit || monthBootstrapPending}
                            onChange={(event) => setStockInNotes(event.target.value)}
                            placeholder="Receipt or invoice reference"
                          />
                          <button
                            type="button"
                            className="btn-primary stock-entry-action !h-8 !min-h-8 shrink-0 !px-3"
                            title={editingStockInId ? "Update stock lifting row" : "Save stock lifting row"}
                            aria-label={editingStockInId ? "Update stock lifting row" : "Save stock lifting row"}
                            disabled={!canEdit || !previewStockInRecord || monthBootstrapPending}
                            onClick={() => void saveStockIn()}
                          >
                            <Save className="h-4 w-4" />
                            <span>{editingStockInId ? "Update Stock" : "Add Stock"}</span>
                          </button>
                          </div>
                        </td>
                      </tr>
                    </>
                  )}
                />

                {stockInMode === "cash" && previewStockInRecord && (
                  <p className="warning mt-3 text-xs flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                    <span>In Cash mode, the paid amount is automatically set to the full total amount.</span>
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Today's Stock Received Records</h2>
                {/* <p>Saved shipments from Jazz Company for this date.</p> */}
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead className="sticky top-0 z-20 bg-slate-900/95 backdrop-blur-sm shadow-sm">
                  <tr>
                    <th>Mode</th>
                    <th>Products Received</th>
                    <th>Total Qty</th>
                    <th>Total Value</th>
                    <th>Paid Amount</th>
                    <th>Payable</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedDayRecord?.stockIn && selectedDayRecord.stockIn.length > 0 ? (
                    selectedDayRecord.stockIn.map((record) => (
                      <tr key={record.id}>
                        <td>
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${record.stockInMode === "cash" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border border-rose-500/20"}`}>
                            {record.stockInMode}
                          </span>
                        </td>
                        <td>
                          <div className="text-xs space-y-0.5">
                            {record.products.map((p) => (
                              <div key={p.productId} className="text-slate-300">
                                • {p.productName}: {p.quantity} @ {formatMoney(p.rate)} = {formatMoney(p.amount)}
                              </div>
                            ))}
                          </div>
                        </td>
                        <td>{record.totalQty}</td>
                        <td className="font-semibold text-slate-200">{formatMoney(record.totalAmount)}</td>
                        <td className="text-blue-400">{formatMoney(record.paidAmount)}</td>
                        <td className="text-rose-400 font-semibold">{formatMoney(record.jazzPayableAmount)}</td>
                        <td className="text-slate-400 italic text-xs">{record.notes ?? "—"}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <button
                              className="btn-secondary !h-8 !w-8 !px-0"
                              title="Edit record"
                              aria-label="Edit stock lifting record"
                              disabled={!canEdit || monthBootstrapPending}
                              onClick={() => {
                                setStockInQuantities(Object.fromEntries(record.products.map((product) => [product.productId, product.quantity])));
                                setStockInMode(record.stockInMode === "credit" ? "credit" : "cash");
                                setStockInPaidAmount(record.stockInMode === "credit" ? record.paidAmount : 0);
                                setStockInNotes(record.notes ?? "");
                                setEditingStockInId(record.id);
                                window.scrollTo({ top: 0, behavior: "smooth" });
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              className="btn-secondary !h-8 !w-8 !px-0 flex items-center justify-center text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30"
                              title="Delete record"
                              disabled={!canEdit || monthBootstrapPending}
                              onClick={async () => {
                                if (window.confirm("Are you sure you want to delete this Jazz stock-in record? This will reduce the product stock balance and update the payable ledger.")) {
                                  if (isPostgreSqlPeriod(monthId)) {
                                    try {
                                      await deleteStockInPostgres(monthId, selectedDay, record.id, record.paidAmount, record.notes);
                                      const nextStockIn = selectedDayRecord.stockIn?.filter((r) => r.id !== record.id) ?? [];
                                      const workingMonth = month ?? ({
                                        id: monthId,
                                        label: monthId,
                                        status: "open",
                                        createdBy: "system",
                                        createdAt: Date.now(),
                                        updatedAt: Date.now()
                                      } as StockMonth);
                                      const nextDay = buildStockDayRecord({
                                        month: workingMonth,
                                        dayNo: selectedDay,
                                        date: dayDate(monthId, selectedDay),
                                        entries: selectedDayRecord.entries ?? [],
                                        stockIn: nextStockIn,
                                        previous: selectedDayRecord,
                                        createdBy: user.uid
                                      });
                                      setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
                                      if (editingStockInId === record.id) {
                                        setStockInQuantities({});
                                        setStockInMode("cash");
                                        setStockInPaidAmount(0);
                                        setStockInNotes("");
                                        setEditingStockInId(null);
                                      }
                                      onStatus("Deleted Jazz stock-in record successfully.");
                                    } catch (error) {
                                      onStatus(error instanceof Error ? error.message : "Failed to delete Stock In record.");
                                    }
                                    return;
                                  }
                                  const nextStockIn = selectedDayRecord.stockIn?.filter((r) => r.id !== record.id) ?? [];
                                  const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
                                  const nextDay = buildStockDayRecord({
                                    month: workingMonth,
                                    dayNo: selectedDay,
                                    date: dayDate(monthId, selectedDay),
                                    entries: selectedDayRecord.entries ?? [],
                                    stockIn: nextStockIn,
                                    previous: selectedDayRecord,
                                    createdBy: user.uid
                                  });
                                  setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
                                  onQueueWrite(saveStockDay(workingMonth, nextDay, days, user, role, "save-day", {
                                    skipLedgerV2RawEntryWrites: !shouldMirrorStockLedgerV2RawEntries,
                                    skipProductBalanceWrites: !shouldWriteCurrentStockDerivedBalances,
                                    skipAccountBalanceWrites: !shouldWriteCurrentStockDerivedBalances,
                                    skipJazzCompanyBalanceWrite: !shouldWriteCurrentStockDerivedBalances
                                  }), "Could not queue delete stock-in.");
                                  if (editingStockInId === record.id) {
                                    setStockInQuantities({});
                                    setStockInMode("cash");
                                    setStockInPaidAmount(0);
                                    setStockInNotes("");
                                    setEditingStockInId(null);
                                  }
                                  onStatus("Deleted Jazz stock-in record successfully.");
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="text-slate-400 italic">No stock-in records saved for this date.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Stock Lifting Summary</h2>
                {/* <p>Reusable full-month stock lifting, in-hand, and valuation summary.</p> */}
              </div>
              <FileSpreadsheet className="text-emerald-500" />
            </div>
            <StockLiftingSummaryTable
              products={products}
              days={days}
              monthId={monthId}
              filterStartDate={1}
              filterEndDate={daysInMonth(monthId)}
              monthOpeningStock={monthOpeningStock}
              currentStockBalances={currentStockBalances}
              productRateById={productRateById}
            />
          </section>
        </div>
      )}

      {section === "reportsHub" && (
        <div className="space-y-5">
          {/* Executive KPI Metric Cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label="Stock Amount" value={formatMoney(currentInventoryAmount)} helper="Current inventory value from stock balance and product rates." />
            <MetricCard label="Payment Received" value={formatMoney(metrics.totalPaymentReceived)} helper={syncLabel} />
            <MetricCard label="Due Balance" value={formatMoney(metrics.totalDueBalance)} helper={syncState === "offline" ? "Offline changes are queued." : "Firestore stock summary."} />
            <MetricCard label="Quantity" value={formatMoney(currentInventoryQty)} helper="Current stock balance quantity." />
          </div>

          {/* Action Bar with Excel, Print, and Standalone Stock JSON Backup */}
          <div className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4 text-emerald-400" />
                <span>Stock Reports, Exports & Backup</span>
              </h3>
              <p className="mt-0.5 text-xs text-slate-400">
                Interactive reporting, printable ledgers, Excel exports, and standalone Stock JSON backups.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-secondary !h-8 !px-3 text-xs flex items-center gap-1.5 border-slate-700 hover:border-emerald-500/50"
                disabled={reportsRefreshing}
                onClick={() => void refreshStockReports()}
                title="Refresh month reports and calculation summaries from PostgreSQL without reloading the page"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${reportsRefreshing ? "animate-spin text-emerald-400" : "text-emerald-400"}`} />
                <span>{reportsRefreshing ? "Refreshing..." : "Refresh Reports"}</span>
              </button>
              <button
                type="button"
                className="btn-primary !h-8 !px-3 text-xs flex items-center gap-1.5"
                disabled={!summary}
                onClick={() => summary && exportStockMonthlyXlsx(summary, days)}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" />
                <span>Export Stock Excel</span>
              </button>
              <button
                type="button"
                className="btn-secondary !h-8 !px-3 text-xs flex items-center gap-1.5"
                disabled={!summary}
                onClick={() => summary && exportStockPrintable(summary, days)}
              >
                <Printer className="h-3.5 w-3.5" />
                <span>Print</span>
              </button>
              <button
                type="button"
                className="btn-secondary !h-8 !px-3 text-xs flex items-center gap-1.5 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                disabled={!canUseStockBackup}
                title={!canUseStockBackup ? "Only owner can export Stock JSON backup." : "Export complete Stock Ledger JSON backup"}
                onClick={() => onQueueWrite(listStockBackup().then((backup) => {
                  const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), stock: backup }, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = url;
                  link.download = `stock-backup-${monthId}.json`;
                  link.click();
                  URL.revokeObjectURL(url);
                }), "Could not export stock backup.")}
              >
                <FileDown className="h-3.5 w-3.5" />
                <span>Stock JSON Backup</span>
              </button>
            </div>
          </div>

          <section className="panel">
            <div className="panel-title border-b border-slate-800 pb-3">
              <div>
                <h2>Stock Monthly Reports Center</h2>
                <p>Comprehensive interactive reporting and analytics engine derived entirely from Stock Ledger ledger entries.</p>
              </div>
              <FileSpreadsheet className="text-emerald-500 h-6 w-6" />
            </div>

          {/* DELUXE FILTERS BAR */}
          <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
            <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-3 flex items-center gap-1.5">
              <Wrench className="h-3.5 w-3.5 text-emerald-400" />
              <span>Filter & Segment Report Data</span>
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {/* Date Range Picker inside selected month */}
              <label>
                Start Day
                <select value={filterStartDate} onChange={(e) => setFilterStartDate(Number(e.target.value))}>
                  {Array.from({ length: daysInMonth(monthId) }).map((_, i) => (
                    <option key={i + 1} value={i + 1}>
                      Day {i + 1}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                End Day
                <select value={filterEndDate} onChange={(e) => setFilterEndDate(Number(e.target.value))}>
                  {Array.from({ length: daysInMonth(monthId) }).map((_, i) => (
                    <option key={i + 1} value={i + 1}>
                      Day {i + 1}
                    </option>
                  ))}
                </select>
              </label>

              {/* Product selector */}
              <label>
                Stock Product
                <select value={filterProductId} onChange={(e) => setFilterProductId(e.target.value)}>
                  <option value="">-- All Products --</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              {/* Account Type selector */}
              <label>
                Account / Person Type
                <select value={filterAccountType} onChange={(e) => setFilterAccountType(e.target.value)}>
                  <option value="">-- All Types --</option>
                  <option value="CCR">CCR</option>
                  <option value="DO">DO</option>
                  <option value="DSO">DSO</option>
                  <option value="STOCK">Stock Account</option>
                  <option value="OTHER">Other</option>
                </select>
              </label>

              {/* Specific CCR/DO/DSO Account Filter */}
              <label>
                Specific Account / Person
                <select value={filterAccountId} onChange={(e) => setFilterAccountId(e.target.value)}>
                  <option value="">-- All Accounts --</option>
                  {accounts
                    .filter((a) => !filterAccountType || a.type === filterAccountType)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.type})
                      </option>
                    ))}
                </select>
              </label>

              {/* Stock In mode */}
              <label>
                Stock In Mode (Jazz)
                <select value={filterStockInMode} onChange={(e) => setFilterStockInMode(e.target.value)}>
                  <option value="">-- All Modes --</option>
                  <option value="cash">Cash Mode</option>
                  <option value="credit">Credit Mode</option>
                </select>
              </label>

              {/* Due Status */}
              <label>
                Due Status
                <select value={filterDueStatus} onChange={(e) => setFilterDueStatus(e.target.value)}>
                  <option value="">-- All Outstanding --</option>
                  <option value="due">Has Outstanding Due</option>
                  <option value="nodue">No Remaining Due</option>
                </select>
              </label>

              {/* Day Status */}
              <label>
                Day Ledger Status
                <select value={filterDayStatus} onChange={(e) => setFilterDayStatus(e.target.value)}>
                  <option value="">-- All Days --</option>
                  <option value="open">Open Days Only</option>
                  <option value="closed">Closed Days Only</option>
                </select>
              </label>

              {/* Account Active Status */}
              <label>
                Account Active Status
                <select value={filterActiveStatus} onChange={(e) => setFilterActiveStatus(e.target.value)}>
                  <option value="all">All Accounts</option>
                  <option value="active">Active Only</option>
                  <option value="inactive">Inactive Only</option>
                </select>
              </label>
            </div>

            <div className="mt-3 flex justify-end">
              <button
                type="button"
                className="btn-secondary text-xs !py-1.5 !px-3"
                onClick={() => {
                  setFilterStartDate(1);
                  setFilterEndDate(daysInMonth(monthId));
                  setFilterProductId("");
                  setFilterAccountType("");
                  setFilterAccountId("");
                  setFilterStockInMode("");
                  setFilterDueStatus("");
                  setFilterDayStatus("");
                  setFilterActiveStatus("all");
                }}
              >
                Reset All Filters
              </button>
            </div>
          </div>

          {/* REPORTS SUB-TABS GRID */}
          <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5">
            {[
              { id: "masterSummary", label: "Stock Issuance Summary" },
              { id: "stockPosition", label: "Stock Lifting Summary" },
              { id: "products", label: "Product Stock Flow" },
              { id: "cashCredit", label: "Cash vs Credit In" }
            ].map((sub) => {
              const active = activeReportSubTab === sub.id;
              return (
                <button
                  key={sub.id}
                  type="button"
                  onClick={() => setActiveReportSubTab(sub.id as any)}
                  className={`flex flex-col items-center justify-center p-3 rounded-xl border text-center transition-all ${
                    active
                      ? "bg-emerald-500/10 border-emerald-500 text-emerald-100 shadow-lg shadow-emerald-500/5"
                      : "bg-slate-900/50 border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                  }`}
                >
                  <span className="text-xs font-bold uppercase tracking-wider">{sub.label}</span>
                </button>
              );
            })}
          </div>

          {/* DYNAMIC SUB-REPORT VIEW */}
          <div className="mt-6 border-t border-slate-800 pt-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-extrabold text-slate-100 capitalize">
                {activeReportSubTab.replace(/([A-Z])/g, " $1")} Report
              </h3>
              <button
                type="button"
                className="btn-primary !h-8 !px-3 text-xs"
                onClick={() => handlePrint(`Stock ${activeReportSubTab} Report`, "printable-report-area")}
              >
                <Printer className="mr-1 h-3.5 w-3.5" />
                Print / Export PDF
              </button>
            </div>

            <div id="printable-report-area">
              {activeReportSubTab === "stockPosition" && (
                <StockLiftingSummaryTable
                  products={products}
                  days={days}
                  monthId={monthId}
                  filterStartDate={filterStartDate}
                  filterEndDate={filterEndDate}
                  monthOpeningStock={monthOpeningStock}
                  currentStockBalances={currentStockBalances}
                  productRateById={productRateById}
                />
              )}

              {activeReportSubTab === "masterSummary" && (
                <StockIssuanceSummaryTable
                  products={products}
                  accounts={accounts}
                  days={days}
                  prevSummary={prevSummary}
                  stockAccountOpening={openingBalances.stockAccountOpening}
                  filterStartDate={filterStartDate}
                  filterEndDate={filterEndDate}
                  filterProductId={filterProductId}
                  filterAccountType={filterAccountType as "" | StockAccountType}
                  filterAccountId={filterAccountId}
                  filterDueStatus={filterDueStatus as "" | "due" | "nodue"}
                  filterDayStatus={filterDayStatus as "" | "open" | "closed" | "reopen"}
                  filterActiveStatus={filterActiveStatus as "all" | "active" | "inactive"}
                />
              )}

              {/* 2. Product-wise Stock Flow Report */}
              {activeReportSubTab === "products" && (
                <ProductStockFlowTable
                  products={products}
                  days={days}
                  filterStartDate={filterStartDate}
                  filterEndDate={filterEndDate}
                  filterProductId={filterProductId}
                  filterStockInMode={filterStockInMode as "" | "cash" | "credit"}
                  filterAccountType={filterAccountType as "" | StockAccountType}
                  filterAccountId={filterAccountId}
                  monthOpeningStock={monthOpeningStock}
                />
              )}

              {/* 9. Cash/Credit Stock In Report */}
              {activeReportSubTab === "cashCredit" && (
                <CashCreditStockInTable
                  days={days}
                  filterStartDate={filterStartDate}
                  filterEndDate={filterEndDate}
                />
              )}

                          </div>
          </div>
        </section>
        </div>
      )}

      {section === "settings" && (
        canManageSettings ? (
          <div className="space-y-6">
            {/* 1. CCR & DO Dealer Accounts Directory */}
            <section className="panel">
              <div className="panel-title border-b border-slate-800 pb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2">
                    <User className="h-4 w-4 text-sky-400" />
                    Distribution Officers & Accounts Directory
                  </h3>
                  <p className="text-xs text-slate-400">
                    Central directory for DOs, CCRs, and counters. Synchronized with the Master DO Directory.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-slate-400">
                    Total: <span className="font-semibold text-white">{sortedAccounts.length}</span> ({sortedAccounts.filter((a) => a.active).length} active)
                  </span>
                  <button
                    type="button"
                    className="btn-secondary flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 hover:border-sky-500/40"
                    onClick={handleSyncWithDoDirectory}
                    title="Import / link any missing DOs from Jazz Load DO Directory"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Sync with Master DO Directory
                  </button>
                </div>
              </div>

              {/* Quick Add Account Bar */}
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                  Add Account / Distribution Officer
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.5fr_1fr_1.2fr_auto] sm:items-end">
                  <label className="text-xs font-medium text-slate-300">
                    Account / Officer Name
                    <input
                      type="text"
                      value={newAccountName}
                      onChange={(e) => setNewAccountName(e.target.value)}
                      placeholder="e.g. Naveed Bangla"
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Account Type
                    <select
                      value={newAccountType}
                      onChange={(e) => setNewAccountType(e.target.value as StockAccountType)}
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                    >
                      <option value="DO">DO (Distribution Officer)</option>
                      <option value="CCR">CCR (Customer Care Rep)</option>
                      <option value="DSO">DSO (Direct Sales Officer)</option>
                      <option value="STOCK">Stock Counter</option>
                      <option value="OTHER">Other Party</option>
                    </select>
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Line / MSISDN (Optional)
                    <input
                      type="text"
                      value={newAccountLine}
                      onChange={(e) => setNewAccountLine(e.target.value)}
                      placeholder="e.g. 03001234567"
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                    />
                  </label>
                  <button
                    type="button"
                    className="btn-primary flex items-center justify-center gap-1.5 !h-9 text-xs"
                    disabled={!newAccountName.trim()}
                    onClick={handleAddAccount}
                  >
                    <Plus className="h-4 w-4" />
                    Add Account
                  </button>
                </div>
              </div>

              {/* Compact Accounts Table */}
              <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/80 font-semibold text-slate-300">
                      <th className="w-16 px-2.5 py-2 text-center">#</th>
                      <th className="px-3 py-2">Account Name</th>
                      <th className="w-28 px-3 py-2">Type</th>
                      <th className="w-40 px-3 py-2">Linked Jazz Line</th>
                      <th className="w-24 px-3 py-2 text-center">Status</th>
                      <th className="w-48 px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {sortedAccounts.map((account, idx) => {
                      const isEditing = editingAccountId === account.id;
                      const line = getAccountLine(account);
                      return (
                        <tr
                          key={account.id}
                          className={`transition-colors hover:bg-slate-900/40 ${
                            !account.active ? "opacity-60 bg-slate-950/30" : ""
                          }`}
                        >
                          {/* Order & Reorder arrows */}
                          <td className="px-2 py-1.5 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <span className="w-4 text-center font-mono text-slate-400">{idx + 1}</span>
                              <div className="flex flex-col">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveAccount(idx, "up")}
                                  className="text-slate-500 hover:text-white disabled:opacity-20 disabled:hover:text-slate-500"
                                  title="Move up"
                                >
                                  <ChevronUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === sortedAccounts.length - 1}
                                  onClick={() => handleMoveAccount(idx, "down")}
                                  className="text-slate-500 hover:text-white disabled:opacity-20 disabled:hover:text-slate-500"
                                  title="Move down"
                                >
                                  <ChevronDown className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          </td>

                          {/* Account Name */}
                          <td className="px-3 py-1.5">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editAccountName}
                                onChange={(e) => setEditAccountName(e.target.value)}
                                className="w-full rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                                autoFocus
                              />
                            ) : (
                              <div className="font-semibold text-white">
                                {account.name}
                              </div>
                            )}
                          </td>

                          {/* Type */}
                          <td className="px-3 py-1.5">
                            {isEditing ? (
                              <select
                                value={editAccountType}
                                onChange={(e) => setEditAccountType(e.target.value as StockAccountType)}
                                className="rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                              >
                                <option value="DO">DO</option>
                                <option value="CCR">CCR</option>
                                <option value="DSO">DSO</option>
                                <option value="STOCK">STOCK</option>
                                <option value="OTHER">OTHER</option>
                              </select>
                            ) : (
                              <span
                                className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold border ${
                                  account.type === "DO"
                                    ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
                                    : account.type === "CCR"
                                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                    : account.type === "DSO"
                                    ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                                    : "bg-slate-800 text-slate-300 border-slate-700"
                                }`}
                              >
                                {account.type}
                              </span>
                            )}
                          </td>

                          {/* Line / MSISDN */}
                          <td className="px-3 py-1.5">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editAccountLine}
                                onChange={(e) => setEditAccountLine(e.target.value)}
                                placeholder="e.g. 03001234567"
                                className="w-full rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs font-mono text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                              />
                            ) : (
                              <span className="font-mono text-slate-300">
                                {line !== "—" ? line : <span className="italic text-slate-500">—</span>}
                              </span>
                            )}
                          </td>

                          {/* Status */}
                          <td className="px-3 py-1.5 text-center">
                            {account.active ? (
                              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400 border border-slate-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                                Inactive
                              </span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className="px-3 py-1.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn-primary !h-7 !px-2.5 text-xs flex items-center gap-1"
                                    onClick={() => handleSaveEditAccount(account)}
                                    disabled={!editAccountName.trim()}
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1"
                                    onClick={() => setEditingAccountId(null)}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1"
                                    onClick={() => {
                                      setEditingAccountId(account.id);
                                      setEditAccountName(account.name);
                                      setEditAccountType(account.type);
                                      setEditAccountLine(line !== "—" ? line : "");
                                    }}
                                    title="Edit Account"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className={`btn-secondary !h-7 !px-2 text-xs ${
                                      account.active ? "text-slate-400 hover:text-amber-300" : "text-emerald-400 hover:text-emerald-300"
                                    }`}
                                    onClick={() => handleSaveStockAccount({ ...account, active: !account.active })}
                                    title={account.active ? "Deactivate Account" : "Activate Account"}
                                  >
                                    {account.active ? "Deactivate" : "Activate"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-7 !w-7 !p-0 text-rose-400 hover:text-rose-300 hover:border-rose-500/40"
                                    onClick={() => {
                                      if (window.confirm(`Deactivate account "${account.name}"?`)) {
                                        handleDeleteStockAccount(account.id);
                                      }
                                    }}
                                    title="Delete / Deactivate Account"
                                  >
                                    <Trash2 className="h-3.5 w-3.5 mx-auto" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {sortedAccounts.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-500">
                          No accounts found. Click &quot;Sync with Master DO Directory&quot; or add an account above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 2. Stock Products Catalog */}
            <section className="panel">
              <div className="panel-title border-b border-slate-800 pb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-white flex items-center gap-2">
                    <Box className="h-4 w-4 text-emerald-400" />
                    Stock Products Catalog
                  </h3>
                  <p className="text-xs text-slate-400">
                    Manage inventory product rates, units, and company payment tracking definitions.
                  </p>
                </div>
                <div className="text-xs text-slate-400">
                  Total Items: <span className="font-semibold text-white">{sortedProducts.length}</span> ({sortedProducts.filter((p) => p.active).length} active)
                </div>
              </div>

              {/* Quick Add Product Bar */}
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3.5">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2">
                  Add Stock Product
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.5fr_1fr_auto_auto] sm:items-end">
                  <label className="text-xs font-medium text-slate-300">
                    Product Name
                    <input
                      type="text"
                      value={newProductName}
                      onChange={(e) => setNewProductName(e.target.value)}
                      placeholder="e.g. Prepaid SIM"
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                    />
                  </label>
                  <label className="text-xs font-medium text-slate-300">
                    Unit Rate (Rs.)
                    <input
                      type="number"
                      step="0.01"
                      value={newProductRate}
                      onChange={(e) => setNewProductRate(e.target.value === "" ? "" : Number(e.target.value))}
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                    />
                  </label>
                  <label className="flex items-center gap-2 pb-2 text-xs text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newProductPaymentTracking}
                      onChange={(e) => setNewProductPaymentTracking(e.target.checked)}
                      className="rounded border-slate-700 bg-slate-900 text-sky-500 focus:ring-0"
                    />
                    <span>Track in Company Payable</span>
                  </label>
                  <button
                    type="button"
                    className="btn-primary flex items-center justify-center gap-1.5 !h-9 text-xs"
                    disabled={!newProductName.trim()}
                    onClick={handleAddProduct}
                  >
                    <Plus className="h-4 w-4" />
                    Add Product
                  </button>
                </div>
              </div>

              {/* Compact Products Table */}
              <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900/80 font-semibold text-slate-300">
                      <th className="w-16 px-2.5 py-2 text-center">#</th>
                      <th className="px-3 py-2">Product Name</th>
                      <th className="w-36 px-3 py-2 text-right">Unit Rate (Rs.)</th>
                      <th className="w-36 px-3 py-2 text-center">Payment Tracking</th>
                      <th className="w-24 px-3 py-2 text-center">Status</th>
                      <th className="w-48 px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {sortedProducts.map((product, idx) => {
                      const isEditing = editingProductId === product.id;
                      return (
                        <tr
                          key={product.id}
                          className={`transition-colors hover:bg-slate-900/40 ${
                            !product.active ? "opacity-60 bg-slate-950/30" : ""
                          }`}
                        >
                          {/* Order & Reorder arrows */}
                          <td className="px-2 py-1.5 text-center">
                            <div className="flex items-center justify-center gap-1">
                              <span className="w-4 text-center font-mono text-slate-400">{idx + 1}</span>
                              <div className="flex flex-col">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => handleMoveProduct(idx, "up")}
                                  className="text-slate-500 hover:text-white disabled:opacity-20 disabled:hover:text-slate-500"
                                  title="Move up"
                                >
                                  <ChevronUp className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === sortedProducts.length - 1}
                                  onClick={() => handleMoveProduct(idx, "down")}
                                  className="text-slate-500 hover:text-white disabled:opacity-20 disabled:hover:text-slate-500"
                                  title="Move down"
                                >
                                  <ChevronDown className="h-3 w-3" />
                                </button>
                              </div>
                            </div>
                          </td>

                          {/* Product Name */}
                          <td className="px-3 py-1.5">
                            {isEditing ? (
                              <input
                                type="text"
                                value={editProductName}
                                onChange={(e) => setEditProductName(e.target.value)}
                                className="w-full rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                                autoFocus
                              />
                            ) : (
                              <div className="font-semibold text-white">
                                {product.name}
                              </div>
                            )}
                          </td>

                          {/* Unit Rate */}
                          <td className="px-3 py-1.5 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                step="0.01"
                                value={editProductRate}
                                onChange={(e) => setEditProductRate(e.target.value === "" ? "" : Number(e.target.value))}
                                className="w-28 rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-right text-xs font-mono text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                              />
                            ) : (
                              <span className="font-mono text-slate-200">
                                {formatMoney(product.rate)}
                              </span>
                            )}
                          </td>

                          {/* Payment Tracking */}
                          <td className="px-3 py-1.5 text-center">
                            {isEditing ? (
                              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={editProductPaymentTracking}
                                  onChange={(e) => setEditProductPaymentTracking(e.target.checked)}
                                  className="rounded border-slate-700 bg-slate-900 text-sky-500"
                                />
                                <span className="text-[11px] text-slate-300">Tracked</span>
                              </label>
                            ) : (
                              product.paymentTrackingEnabled !== false ? (
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
                                  Tracked
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400 border border-slate-700">
                                  Off
                                </span>
                              )
                            )}
                          </td>

                          {/* Status */}
                          <td className="px-3 py-1.5 text-center">
                            {product.active ? (
                              <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400 border border-emerald-500/20">
                                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400 border border-slate-700">
                                <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                                Inactive
                              </span>
                            )}
                          </td>

                          {/* Actions */}
                          <td className="px-3 py-1.5 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {isEditing ? (
                                <>
                                  <button
                                    type="button"
                                    className="btn-primary !h-7 !px-2.5 text-xs flex items-center gap-1"
                                    onClick={() => handleSaveEditProduct(product)}
                                    disabled={!editProductName.trim()}
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                    Save
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1"
                                    onClick={() => setEditingProductId(null)}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1"
                                    onClick={() => {
                                      setEditingProductId(product.id);
                                      setEditProductName(product.name);
                                      setEditProductRate(product.rate);
                                      setEditProductPaymentTracking(product.paymentTrackingEnabled !== false);
                                    }}
                                    title="Edit Product"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className={`btn-secondary !h-7 !px-2 text-xs ${
                                      product.active ? "text-slate-400 hover:text-amber-300" : "text-emerald-400 hover:text-emerald-300"
                                    }`}
                                    onClick={() => handleSaveStockProduct({ ...product, active: !product.active })}
                                    title={product.active ? "Deactivate Product" : "Activate Product"}
                                  >
                                    {product.active ? "Deactivate" : "Activate"}
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-7 !w-7 !p-0 text-rose-400 hover:text-rose-300 hover:border-rose-500/40"
                                    onClick={() => {
                                      if (window.confirm(`Deactivate product "${product.name}"?`)) {
                                        handleDeleteStockProduct(product.id);
                                      }
                                    }}
                                    title="Delete / Deactivate Product"
                                  >
                                    <Trash2 className="h-3.5 w-3.5 mx-auto" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {sortedProducts.length === 0 && (
                      <tr>
                        <td colSpan={6} className="py-6 text-center text-slate-500">
                          No stock products found. Add a product above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        ) : (
          <section className="panel">
            <h2>Stock Settings</h2>
            <Alert
              variant="warning"
              title="Access Restricted"
              message="Stock Settings are restricted to owner and admin roles."
            />
          </section>
        )
      )}

      {section === "backup" && (
        canUseStockBackup ? (
          <section className="panel">
            <div className="panel-title"><div><h2>Stock Backup / Export</h2><p>Exports only Stock Ledger settings and stock records.</p></div><FileDown /></div>
            <div className="flex flex-wrap gap-2">
              <button className="btn-primary" disabled={!summary} onClick={() => summary && exportStockMonthlyXlsx(summary, days)}><FileSpreadsheet />Export Stock Excel</button>
              <button className="btn-secondary" disabled={!summary} onClick={() => summary && exportStockPrintable(summary, days)}><Printer />Print</button>
              <button className="btn-secondary" onClick={() => onQueueWrite(listStockBackup().then((backup) => {
                const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), stock: backup }, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = `stock-backup-${monthId}.json`;
                link.click();
                URL.revokeObjectURL(url);
              }), "Could not export stock backup.")}>Stock JSON Backup</button>
            </div>
          </section>
        ) : (
          <section className="panel">
            <h2>Stock Backup / Export</h2>
            <Alert
              variant="warning"
              title="Access Restricted"
              message="Stock Backup is restricted to owner role."
            />
          </section>
        )
      )}
      <TransferBalanceModal
        isOpen={isTransferModalOpen}
        onClose={() => setIsTransferModalOpen(false)}
        dayId={currentDayId}
        accounts={activeAccounts}
        accountBalances={currentAccountBalances}
        onSuccess={handleTransferSuccess}
        disabled={!canEdit}
        canReverse={role === "owner" || role === "admin"}
        initialTab={transferModalTab}
      />
    </section>
  );
}

function SummaryTable({ title, headers, rows }: { title: string; headers: string[]; rows: Array<Array<string | number>> }) {
  return (
    <section className="panel">
      <div className="panel-title"><div><h2>{title}</h2><p>Stock Ledger report only.</p></div></div>
      <div className="table-wrap">
        <table className="table-compact w-full">
          <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>{rows.length > 0 ? rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex} className="font-bold text-white">{cell}</td>)}</tr>) : <tr><td colSpan={headers.length} className="font-bold text-white">No stock data yet.</td></tr>}</tbody>
        </table>
      </div>
    </section>
  );
}
