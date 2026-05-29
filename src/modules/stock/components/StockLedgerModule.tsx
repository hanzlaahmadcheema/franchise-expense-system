import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { BarChart3, CalendarDays, Check, ChevronDown, ChevronRight, FileDown, FileSpreadsheet, Pencil, Printer, Save, Settings, Trash2, X, PlusCircle, ArrowUpRight, ArrowDownRight, RefreshCw, Wrench, AlertTriangle, Info, Box } from "lucide-react";
import type { UserRole, SystemAuditLog } from "../../../types/ledger";
import { subscribeAuditLogs } from "../../../lib/auditLogService";
import type { SyncState } from "../../../lib/syncStatus";
import {
  accountsSorted,
  buildStockDayRecord,
  buildStockEntry,
  calculateMonthlySummary,
  findPreviousEntry,
  productPaymentTrackingEnabled,
  productsSorted,
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
  subscribeStockOpeningBalances,
  type FirestoreSnapshotMeta
} from "../services/stockFirestore";
import { exportStockDayXlsx, exportStockMonthlyXlsx, exportStockPrintable } from "../services/stockReports";
import type {
  StockAccountProfile,
  StockAccountType,
  StockDailyAccountDraft,
  StockDayRecord,
  StockMonth,
  StockMonthlySummary,
  StockProduct,
  StockProductLine,
  StockInRecord,
  StockOpeningBalances
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

type StockSection = "dashboard" | "stockIn" | "daily" | "records" | "balances" | "jazzPayable" | "dues" | "products" | "accounts" | "settings" | "backup" | "reportsHub";
type StockSectionGroup = "entries" | "reports";

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
  loading?: boolean;
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
  return Boolean(day?.reopenedUntilAt && day.reopenedUntilAt > now.getTime());
}

function getStockDayStatus(
  monthId: string,
  dayNo: number,
  day: StockDayRecord | undefined,
  monthStatus: StockMonth["status"] | undefined,
  now = new Date()
) {
  const available = new Set(availableDays(monthId, now));
  if (!available.has(dayNo)) return "Future";
  if (monthStatus === "closed") return "Closed";
  if (day && isReopenActive(day, now)) return "Re-open";
  if (day?.status === "closed") return "Closed";
  if (isLiveDay(monthId, dayNo, now)) return "Open";
  if (day?.status === "open") return "Open";
  return "Closed";
}

function getDayStatusChipClass(status: string) {
  if (status === "Open") return "bg-emerald-400/15 text-emerald-200";
  if (status === "Re-open") return "bg-blue-400/15 text-blue-200";
  if (status === "Closed") return "bg-rose-400/15 text-rose-200";
  return "bg-slate-800 text-slate-500";
}

function canEditStockDay(role: UserRole | null, month: StockMonth | undefined, monthId: string, day: StockDayRecord | undefined, dayNo: number, now = new Date()) {
  if (!roleCanStock(role, "daily")) return false;
  if (month?.status === "closed") return false;
  if (role === "admin") return isLiveDay(monthId, dayNo, now) && (day?.status !== "closed" || isReopenActive(day, now));
  if (isLiveDay(monthId, dayNo, now)) return day?.status !== "closed" || isReopenActive(day, now);
  return isReopenActive(day, now);
}

function calendarCells(monthId: string) {
  const totalDays = daysInMonth(monthId);
  const [yearText, monthText] = monthId.split("-");
  const firstDate = new Date(Number(yearText), Number(monthText) - 1, 1);
  const cells: Array<{ dayNo: number | null }> = Array.from({ length: firstDate.getDay() }, () => ({ dayNo: null }));
  for (let day = 1; day <= totalDays; day += 1) cells.push({ dayNo: day });
  while (cells.length % 7 !== 0) cells.push({ dayNo: null });
  return cells;
}

function NumberInput({ value, onChange, disabled }: { value: number; onChange: (value: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(value ? String(value) : "");
  useEffect(() => setText(value ? String(value) : ""), [value]);
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
        onChange(parseMoneyInput(next));
      }}
      onBlur={() => setText((current) => current ? String(parseMoneyInput(current)) : "")}
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

function StockCalendar({
  monthId,
  monthStatus,
  selectedDay,
  days,
  onSelect,
  disabled
}: {
  monthId: string;
  monthStatus?: StockMonth["status"];
  selectedDay: number;
  days: StockDayRecord[];
  onSelect: (dayNo: number) => void;
  disabled?: boolean;
}) {
  const now = new Date();
  const available = new Set(availableDays(monthId, now));
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="mb-2 grid grid-cols-7 gap-2 text-center text-[11px] font-semibold uppercase text-slate-500">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="grid grid-cols-7 gap-2">
        {calendarCells(monthId).map((cell, index) => {
          if (cell.dayNo == null) return <span key={`empty-${index}`} className="min-h-16" />;
          const day = days.find((item) => item.dayNo === cell.dayNo);
          const future = !available.has(cell.dayNo);
          const selected = selectedDay === cell.dayNo;
          const status = getStockDayStatus(monthId, cell.dayNo, day, monthStatus, now);
          return (
            <button
              key={cell.dayNo}
              type="button"
              className={[
                "min-h-16 flex-col rounded-lg border px-2 py-2 text-xs",
                selected ? "border-emerald-400 bg-emerald-400/10 text-emerald-100" : "border-slate-800 bg-slate-900/70 text-slate-200",
                future ? "opacity-40" : ""
              ].join(" ")}
              disabled={disabled || future}
              onClick={() => onSelect(cell.dayNo!)}
              title={`${dayDate(monthId, cell.dayNo)} - ${status}`}
            >
              <span className="text-sm font-semibold">{cell.dayNo}</span>
              <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${getDayStatusChipClass(status)}`}>{status}</span>
              {selected && <span className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">Selected</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SettingsTable({
  title,
  kind,
  canEdit,
  rows,
  onSave,
  onDelete
}: {
  title: string;
  kind: "product" | "account";
  canEdit: boolean;
  rows: Array<StockProduct | StockAccountProfile>;
  onSave: (row: any) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState({
    name: "",
    rate: 0,
    type: "CCR" as StockAccountType,
    order: rows.length + 1,
    paymentTracking: true
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    rate: number;
    type: StockAccountType;
    order: number;
    paymentTracking: boolean;
  } | null>(null);

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{title}</h2>
          <p>Managed separately for the Stock Ledger module.</p>
        </div>
        <Settings />
      </div>
      {canEdit && (
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-4 md:items-end">
          <label className="md:col-span-2">
            Name
            <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </label>
          {kind === "product" && (
            <label>
              Rate
              <NumberInput value={draft.rate} onChange={(rate) => setDraft((current) => ({ ...current, rate }))} />
            </label>
          )}
          {kind === "account" && (
            <label>
              Type
              <select value={draft.type} onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value as StockAccountType }))}>
                <option value="CCR">CCR</option>
                <option value="DO">DO</option>
                <option value="DSO">DSO</option>
                <option value="STOCK">Stock Account</option>
                <option value="OTHER">Other</option>
              </select>
            </label>
          )}
          <label>
            Display Order
            <NumberInput value={draft.order} onChange={(order) => setDraft((current) => ({ ...current, order }))} />
          </label>
          {kind === "product" && (
            <label className="flex items-end gap-2 pb-2">
              <input
                type="checkbox"
                checked={draft.paymentTracking}
                onChange={(event) => setDraft((current) => ({ ...current, paymentTracking: event.target.checked }))}
              />
              <span>Payment tracking</span>
            </label>
          )}
          <button
            className="btn-primary"
            disabled={!draft.name.trim()}
            onClick={() => {
              const id = slug(draft.name);
              const base = {
                id,
                name: draft.name.trim(),
                active: true,
                displayOrder: draft.order,
                createdBy: "",
                createdAt: Date.now(),
                updatedAt: Date.now()
              };
              if (kind === "product") {
                onSave({
                  ...base,
                  rate: draft.rate,
                  paymentTrackingEnabled: draft.paymentTracking
                } as StockProduct);
              } else {
                onSave({ ...base, type: draft.type, openingBalance: 0 } as StockAccountProfile);
              }
              setDraft({ name: "", rate: 0, type: "CCR", order: draft.order + 1, paymentTracking: true });
            }}
          >
            Add
          </button>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {kind === "product" && <th>Rate</th>}
              {kind === "product" && <th>Payment</th>}
              {kind === "account" && <th>Type</th>}
              <th>Order</th>
              <th>Status</th>
              {canEdit && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const isEditing = editingId === row.id;
              return (
                <tr key={row.id}>
                  <td>
                    {isEditing ? (
                      <input
                        value={editDraft?.name ?? ""}
                        onChange={(e) => setEditDraft((curr) => curr ? { ...curr, name: e.target.value } : null)}
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
                      />
                    ) : (
                      row.name
                    )}
                  </td>
                  {kind === "product" && (
                    <td>
                      {isEditing ? (
                        <NumberInput
                          value={editDraft?.rate ?? 0}
                          onChange={(rate) => setEditDraft((curr) => curr ? { ...curr, rate } : null)}
                        />
                      ) : (
                        formatMoney((row as StockProduct).rate)
                      )}
                    </td>
                  )}
                  {kind === "product" && (
                    <td>
                      {isEditing ? (
                        <input
                          type="checkbox"
                          checked={editDraft?.paymentTracking ?? false}
                          onChange={(event) => setEditDraft((curr) => curr ? { ...curr, paymentTracking: event.target.checked } : null)}
                        />
                      ) : (
                        (row as StockProduct).paymentTrackingEnabled !== false ? "Enabled" : "Off"
                      )}
                    </td>
                  )}
                  {kind === "account" && (
                    <td>
                      {isEditing ? (
                        <select
                          value={editDraft?.type ?? "CCR"}
                          onChange={(e) => setEditDraft((curr) => curr ? { ...curr, type: e.target.value as StockAccountType } : null)}
                          className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
                        >
                          <option value="CCR">CCR</option>
                          <option value="DO">DO</option>
                          <option value="DSO">DSO</option>
                          <option value="STOCK">Stock Account</option>
                          <option value="OTHER">Other</option>
                        </select>
                      ) : (
                        (row as StockAccountProfile).type
                      )}
                    </td>
                  )}
                  <td>
                    {isEditing ? (
                      <NumberInput
                        value={editDraft?.order ?? 0}
                        onChange={(order) => setEditDraft((curr) => curr ? { ...curr, order } : null)}
                      />
                    ) : (
                      row.displayOrder
                    )}
                  </td>
                  <td>
                    <button className={row.active ? "btn-chip btn-chip-active" : "btn-chip"} disabled={!canEdit} onClick={() => onSave({ ...row, active: !row.active })}>
                      {row.active ? "Active" : "Inactive"}
                    </button>
                  </td>
                  {canEdit && (
                    <td>
                      <div className="flex gap-1.5">
                        {isEditing ? (
                          <>
                            <button
                              className="btn-primary !h-8 !w-8 !px-0 flex items-center justify-center bg-emerald-600 hover:bg-emerald-700 text-white"
                              title="Save changes"
                              onClick={() => {
                                if (!editDraft || !editDraft.name.trim()) return;
                                const updated = {
                                  ...row,
                                  name: editDraft.name.trim(),
                                  displayOrder: editDraft.order,
                                  updatedAt: Date.now()
                                };
                                if (kind === "product") {
                                  (updated as StockProduct).rate = editDraft.rate;
                                  (updated as StockProduct).paymentTrackingEnabled = editDraft.paymentTracking;
                                } else if (kind === "account") {
                                  (updated as StockAccountProfile).type = editDraft.type;
                                }
                                onSave(updated);
                                setEditingId(null);
                                setEditDraft(null);
                              }}
                            >
                              <Check className="h-4 w-4" />
                            </button>
                            <button
                              className="btn-secondary !h-8 !w-8 !px-0 flex items-center justify-center"
                              title="Cancel editing"
                              onClick={() => {
                                setEditingId(null);
                                setEditDraft(null);
                              }}
                            >
                              <X className="h-4 w-4" />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="btn-secondary !h-8 !w-8 !px-0 flex items-center justify-center"
                              title="Edit item"
                              onClick={() => {
                                setEditingId(row.id);
                                setEditDraft({
                                  name: row.name,
                                  order: row.displayOrder,
                                  rate: kind === "product" ? (row as StockProduct).rate : 0,
                                  type: kind === "account" ? (row as StockAccountProfile).type : "CCR",
                                  paymentTracking: kind === "product" ? (row as StockProduct).paymentTrackingEnabled !== false : false
                                });
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </button>
                            <button
                              className="btn-secondary !h-8 !w-8 !px-0 flex items-center justify-center text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30"
                              title="Delete item"
                              onClick={() => {
                                if (window.confirm(`Are you sure you want to delete "${row.name}" permanently from settings?`)) {
                                  onDelete(row.id);
                                }
                              }}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={kind === "product" ? (canEdit ? 8 : 7) : kind === "account" ? (canEdit ? 6 : 5) : canEdit ? 5 : 4}>
                  No rows configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
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
  loading
}: Props) {
  const [section, setSection] = useState<StockSection>("daily");
  const [openSectionGroups, setOpenSectionGroups] = useState<Record<StockSectionGroup, boolean>>({
    entries: true,
    reports: false
  });
  const [selectedDay, setSelectedDay] = useState(currentDateState().dayNo);
  const [months, setMonths] = useState<StockMonth[]>([]);
  const [days, setDays] = useState<StockDayRecord[]>([]);
  const [summary, setSummary] = useState<StockMonthlySummary | null>(null);
  const [prevSummary, setPrevSummary] = useState<StockMonthlySummary | null>(null);
  const [products, setProducts] = useState<StockProduct[]>([]);
  const [accounts, setAccounts] = useState<StockAccountProfile[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [draft, setDraft] = useState<StockDailyAccountDraft>({ accountId: "", productQuantities: {}, paymentReceived: 0 });
  const [selectedProductIdInput, setSelectedProductIdInput] = useState("");
  const [selectedProductQtyInput, setSelectedProductQtyInput] = useState<number>(0);
  const [activeReportSubTab, setActiveReportSubTab] = useState<
    "masterSummary" | "stockPosition" | "overview" | "products" | "accounts" | "stockIn" | "stockOut" | "payments" | "dues" | "currentStock" | "cashCredit" | "audit"
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
  const monthBootstrapPendingRef = useRef(false);
  const openingSeedAttemptedRef = useRef(false);
  const [openingBalances, setOpeningBalances] = useState<StockOpeningBalances>({ openingStock: {}, jazzOpeningPayable: 0 });

  const callbacksRef = useRef({
    onSnapshotMetadata,
    onFirestoreError,
    onQueueWrite,
    onStatus
  });
  callbacksRef.current = {
    onSnapshotMetadata,
    onFirestoreError,
    onQueueWrite,
    onStatus
  };

  const month = months.find((item) => item.id === monthId);
  const selectedDayRecord = days.find((day) => day.dayNo === selectedDay);
  const selectedDayStatus = getStockDayStatus(monthId, selectedDay, selectedDayRecord, month?.status, now);
  const sortedProducts = useMemo(() => productsSorted(products), [products]);
  const activeProducts = useMemo(() => sortedProducts.filter((product) => product.active), [sortedProducts]);
  const sortedAccounts = useMemo(() => accountsSorted(accounts), [accounts]);
  const activeAccounts = useMemo(() => {
    return sortedAccounts.filter((account) => account.active || selectedDayRecord?.entries.some((entry) => entry.accountId === account.id));
  }, [sortedAccounts, selectedDayRecord]);
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const selectedEntry = selectedDayRecord?.entries.find((entry) => entry.accountId === selectedAccountId);
  const previousMonthDueBalance = useMemo(() => {
    if (!selectedAccountId || !prevSummary) return undefined;
    return prevSummary.accountTotals.find((item) => item.accountId === selectedAccountId)?.dueBalance;
  }, [selectedAccountId, prevSummary]);
  const previousEntry = selectedAccountId ? findPreviousEntry(days, selectedDay, selectedAccountId) : undefined;

  const allStockInRecords = useMemo(() => {
    return days.flatMap((day) => day.stockIn ?? []);
  }, [days]);
  const monthOpeningStock = useMemo(() => {
    return prevSummary?.closingStock ?? openingBalances.openingStock;
  }, [openingBalances.openingStock, prevSummary?.closingStock]);
  const monthOpeningJazzPayable = prevSummary?.closingJazzPayable ?? openingBalances.jazzOpeningPayable;

  const currentStockBalances = useMemo(() => {
    return calculateCurrentStock(products, monthOpeningStock, allStockInRecords, days);
  }, [products, monthOpeningStock, allStockInRecords, days]);
  const productRateById = useMemo(() => {
    return Object.fromEntries(products.map((product) => [product.id, product.rate]));
  }, [products]);
  const currentInventoryQty = useMemo(() => {
    return roundMoney(currentStockBalances.reduce((total, row) => total + row.currentStock, 0));
  }, [currentStockBalances]);
  const currentInventoryAmount = useMemo(() => {
    return roundMoney(currentStockBalances.reduce((total, row) => total + (row.currentStock * (productRateById[row.productId] ?? 0)), 0));
  }, [currentStockBalances, productRateById]);

  const jazzPayableLedger = useMemo(() => {
    return calculateJazzPayableLedger(monthOpeningJazzPayable, allStockInRecords);
  }, [monthOpeningJazzPayable, allStockInRecords]);

  const canManageSettings = roleCanStock(role, "settings");
  const canEdit = canEditStockDay(role, month, monthId, selectedDayRecord, selectedDay, now);
  const canMonthControls = roleCanStock(role, "monthControls");
  const canReopenSelectedDay = role === "owner" || (role === "admin" && isLiveDay(monthId, selectedDay, now));

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!user || !role) return;
    const unsubscribers = [
      subscribeStockProducts((rows, metadata) => { setProducts(rows); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockAccounts((rows, metadata) => { setAccounts(rows); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockMonths((rows, metadata) => { setMonths(rows); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockOpeningBalances((bal) => { if (bal) setOpeningBalances(bal); }, (err) => console.error("Could not subscribe to opening balances:", err))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [role, user]);

  useEffect(() => {
    if (!user || !roleCanStock(role, "settings") || products.length === 0 || openingSeedAttemptedRef.current) return;
    openingSeedAttemptedRef.current = true;
    const seedPromise = ensureStockOpeningSeed(products, user, role).then((seeded) => {
      if (seeded) callbacksRef.current.onStatus("Seeded one-time Stock opening quantities.");
      return seeded;
    });
    callbacksRef.current.onQueueWrite(seedPromise, "Could not seed one-time Stock opening quantities.");
  }, [products, role, user]);

  useEffect(() => {
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
      subscribeStockDays(monthId, (rows, metadata) => { setDays(rows); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeStockMonthlySummary(monthId, (nextSummary, metadata) => { setSummary(nextSummary); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message)),
      subscribeAuditLogs({ module: "stock", monthId }, (logs) => setAuditLogs(logs), (err) => console.error("Could not subscribe to audit logs:", err))
    ];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [month, monthBootstrapPending, monthId, role, user]);

  useEffect(() => {
    if (!user || !role) return;
    const prevId = previousMonthId(monthId);
    return subscribeStockMonthlySummary(
      prevId,
      (nextSummary) => setPrevSummary(nextSummary),
      (err) => console.error("Could not subscribe to previous month summary:", err)
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
    const nextEntry = selectedDayRecord?.entries.find((entry) => entry.accountId === selectedAccountId);

    setDraft({
      accountId: selectedAccountId,
      productQuantities: Object.fromEntries(activeProducts.map((product) => [
        product.id,
        nextEntry?.products.find((item) => item.productId === product.id)?.quantity ?? 0
      ])),
      paymentReceived: nextEntry?.totalPaymentReceived ?? 0,
      carryForwardBalance: nextEntry?.carryForwardBalance ?? previousEntry?.dueBalance ?? previousMonthDueBalance ?? selectedAccount?.openingBalance ?? 0,
      notes: nextEntry?.notes ?? ""
    });
  }, [activeProducts, previousEntry, previousMonthDueBalance, selectedAccount, selectedAccountId, selectedDayRecord]);

  const previewEntry = selectedAccount ? buildStockEntry({
    id: selectedAccount.id,
    date: dayDate(monthId, selectedDay),
    monthId,
    dayNo: selectedDay,
    account: selectedAccount,
    draft,
    products,
    previous: selectedEntry,
    carryForwardBalance: draft.carryForwardBalance ?? previousEntry?.dueBalance ?? previousMonthDueBalance ?? selectedAccount.openingBalance ?? 0,
    createdBy: user.uid
  }) : null;

  async function saveEntry() {
    if (!selectedAccount || !previewEntry) return;
    const validation = validateStockDraft(draft, products, selectedAccount);
    if (!validation.valid) {
      onStatus(validation.errors.join(" "));
      return;
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const entries = [
      ...(selectedDayRecord?.entries.filter((entry) => entry.accountId !== selectedAccount.id) ?? []),
      previewEntry
    ];
    const nextDay = buildStockDayRecord({
      month: workingMonth,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      entries,
      previous: selectedDayRecord,
      createdBy: user.uid
    });
    setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(saveStockDay(workingMonth, nextDay, days, user, role), "Could not queue stock entry save.");
    onStatus(`Saved stock record for ${selectedAccount.name}. Firestore will sync automatically.`);
  }

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
  const [stockInMode, setStockInMode] = useState<"cash" | "credit">("credit");
  const [stockInPaidAmount, setStockInPaidAmount] = useState<number>(0);
  const [stockInNotes, setStockInNotes] = useState<string>("");

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

    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      createdBy: user.uid,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }, [products, stockInQuantities, stockInMode, stockInPaidAmount, stockInNotes, selectedDay, monthId, user.uid]);

  async function saveStockIn() {
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
      ...(selectedDayRecord?.stockIn ?? []),
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
    onQueueWrite(saveStockDay(workingMonth, nextDay, days, user, role), "Could not queue stock-in save.");
    onStatus(`Saved Stock In from Jazz Company. totalAmount: ${formatMoney(previewStockInRecord.totalAmount)}, paid: ${formatMoney(previewStockInRecord.paidAmount)}`);
    // Clear form
    setStockInQuantities({});
    setStockInPaidAmount(0);
    setStockInNotes("");
  }

  async function closeSelectedDay() {
    if (!selectedDayRecord) return;
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    const nextDay = {
      ...selectedDayRecord,
      status: "closed" as const,
      closedAt: selectedDayRecord.closedAt ?? timestamp,
      closedBy: selectedDayRecord.closedBy ?? user.uid,
      reopenedAt: undefined,
      reopenedBy: undefined,
      reopenedUntilAt: undefined,
      updatedBy: user.uid,
      updatedAt: timestamp
    };
    setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(updateStockDaysStatusBatch(workingMonth, [nextDay], days, user, role, "close-days"), "Could not queue stock day close.");
    onStatus(`Closed stock day ${selectedDay}.`);
  }

  async function reopenSelectedDay() {
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    const reopenUntilAt = timestamp + 15 * 60 * 1000;
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
      status: "closed" as const,
      reopenedAt: timestamp,
      reopenedBy: user.uid,
      reopenedUntilAt: reopenUntilAt,
      updatedBy: user.uid,
      updatedAt: timestamp
    };
    setDays((current) => [...current.filter((item) => item.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(updateStockDaysStatusBatch(workingMonth, [nextDay], days, user, role, "reopen-days", reopenUntilAt), "Could not queue stock day reopen.");
    onStatus(`Reopened stock day ${selectedDay} until ${new Date(reopenUntilAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
  }

  async function closeAllStock() {
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
        closedAt: existing.closedAt ?? timestamp,
        closedBy: existing.closedBy ?? user.uid,
        reopenedAt: undefined,
        reopenedBy: undefined,
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
    const closePromise = updateStockDaysStatusBatch(workingMonth, nextClosedDays, days, user, role, "close-days")
      .then((result) => {
        setDays(result.days);
        setSummary(result.summary);
      });
    onQueueWrite(closePromise, "Could not close all previous stock ledger days.");
    onStatus(`Closed ${nextClosedDays.length} Stock Ledger day${nextClosedDays.length === 1 ? "" : "s"} except today.`);
  }

  async function reopenAllStock() {
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const timestamp = Date.now();
    const reopenUntilAt = timestamp + 15 * 60 * 1000;
    const targetDayNos = availableDays(monthId, now);
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
        status: "closed" as const,
        reopenedAt: timestamp,
        reopenedBy: user.uid,
        reopenedUntilAt: reopenUntilAt,
        updatedBy: user.uid,
        updatedAt: timestamp
      };
    });
    const nextDays = nextReopenedDays.reduce(
      (updatedDays, reopenedDay) => [...updatedDays.filter((day) => day.dayNo !== reopenedDay.dayNo), reopenedDay].sort((a, b) => a.dayNo - b.dayNo),
      days
    );
    setDays(nextDays);
    const reopenPromise = updateStockDaysStatusBatch(workingMonth, nextReopenedDays, days, user, role, "reopen-days", reopenUntilAt)
      .then((result) => {
        setMonths((current) => [result.month, ...current.filter((item) => item.id !== result.month.id)].sort((a, b) => b.id.localeCompare(a.id)));
        setDays(result.days);
        setSummary(result.summary);
      });
    onQueueWrite(reopenPromise, "Could not reopen all stock ledger days.");
    onStatus(`Reopened ${nextReopenedDays.length} Stock Ledger days until ${new Date(reopenUntilAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
  }

  async function masterRefreshStockCalculations() {
    if (!roleCanStock(role, "daily")) {
      onStatus("Only owner or admin can refresh Stock Ledger calculations.");
      return;
    }
    if (days.length === 0) {
      onStatus("No Stock Ledger days are available to refresh.");
      return;
    }
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const refreshDay = selectedDayRecord ?? days[0];
    onQueueWrite(saveStockDay(workingMonth, refreshDay, days, user, role), "Could not refresh Stock Ledger calculations.");
    onStatus("Stock Ledger master refresh queued.");
  }

  function metricSummary() {
    return summary ?? {
      monthId,
      totalQty: 0,
      totalAmount: 0,
      totalPaymentReceived: 0,
      totalDueBalance: 0,
      productTotals: [],
      accountTotals: [],
      paymentTotals: [],
      dayRows: [],
      missingDays: [],
      updatedAt: 0
    };
  }

  const metrics = metricSummary();
  const entrySections: Array<[StockSection, string, typeof CalendarDays]> = [
    ["daily", "Stock Out (Allotment)", ArrowUpRight],
    ["stockIn", "Stock In (Jazz)", PlusCircle],
    ["settings", "Stock Settings", Settings]
  ];
  const reportSections: Array<[StockSection, string, typeof CalendarDays]> = [
    ["dashboard", "Stock Dashboard", BarChart3],
    ["reportsHub", "Stock Monthly Reports", FileSpreadsheet],
    ["backup", "Backup / Export", FileDown]
  ];
  const sectionGroup: StockSectionGroup = entrySections.some(([id]) => id === section) ? "entries" : "reports";
  const activeSectionVisible = openSectionGroups[sectionGroup];

  function toggleSectionGroup(group: StockSectionGroup) {
    const fallbackSection = group === "entries" ? "daily" : "dashboard";
    const nextOpen = !openSectionGroups[group];
    if (nextOpen) setSection(fallbackSection);
    setOpenSectionGroups((current) => {
      return { ...current, [group]: nextOpen };
    });
  }

  function selectGroupedSection(group: StockSectionGroup, nextSection: StockSection) {
    setOpenSectionGroups((current) => ({ ...current, [group]: true }));
    setSection(nextSection);
  }

  return (
    <section className="space-y-5">
      <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-3 text-slate-100 shadow-xl shadow-black/20">
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
            <button
              type="button"
              className="btn-secondary w-full justify-between"
              onClick={() => toggleSectionGroup("entries")}
            >
              <span className="inline-flex items-center gap-2">
                {openSectionGroups.entries ? <ChevronDown /> : <ChevronRight />}
                Settings & Entries
              </span>
              <span>{openSectionGroups.entries ? "Close" : "Re-open"}</span>
            </button>
            {openSectionGroups.entries && (
              <nav className="mt-2 flex flex-wrap gap-2">
                {entrySections.map(([id, label, Icon]) => (
                  <button key={id} className={section === id ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => selectGroupedSection("entries", id)}>
                    <Icon />
                    {label}
                  </button>
                ))}
              </nav>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-2">
            <button
              type="button"
              className="btn-secondary w-full justify-between"
              onClick={() => toggleSectionGroup("reports")}
            >
              <span className="inline-flex items-center gap-2">
                {openSectionGroups.reports ? <ChevronDown /> : <ChevronRight />}
                Reports
              </span>
              <span>{openSectionGroups.reports ? "Close" : "Re-open"}</span>
            </button>
            {openSectionGroups.reports && (
              <nav className="mt-2 flex flex-wrap gap-2">
                {reportSections.map(([id, label, Icon]) => (
                  <button key={id} className={section === id ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => selectGroupedSection("reports", id)}>
                    <Icon />
                    {label}
                  </button>
                ))}
              </nav>
            )}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <MetricCard label="Stock Amount" value={formatMoney(currentInventoryAmount)} helper="Current inventory value from stock balance and product rates." />
        <MetricCard label="Payment Received" value={formatMoney(metrics.totalPaymentReceived)} helper={syncLabel} />
        <MetricCard label="Due Balance" value={formatMoney(metrics.totalDueBalance)} helper={syncState === "offline" ? "Offline changes are queued." : "Firestore stock summary."} />
        <MetricCard label="Quantity" value={formatMoney(currentInventoryQty)} helper="Current stock balance quantity." />
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <h2>Stock Ledger Calendar & Controls</h2>
            <p className="flex flex-wrap items-center gap-1.5 text-slate-400 text-sm">
              <span>{monthLabel(monthId)}</span>
              <span className="text-slate-700">·</span>
              <span>{dayDate(monthId, selectedDay)}</span>
              <span className="text-slate-700">·</span>
              <span className="text-slate-500 uppercase text-[10px] font-semibold tracking-wider">Month:</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-300">{month?.status ?? "open"}</span>
              <span className="text-slate-700">·</span>
              <span className="text-slate-500 uppercase text-[10px] font-semibold tracking-wider">Day:</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getDayStatusChipClass(selectedDayStatus)}`}>{selectedDayStatus}</span>
              {selectedDayRecord && isReopenActive(selectedDayRecord, now) && (
                <>
                  <span className="text-slate-700">·</span>
                  <span className="text-[10px] font-semibold uppercase text-emerald-300 animate-pulse">
                    Expires {new Date(selectedDayRecord.reopenedUntilAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </>
              )}
            </p>
          </div>
          <CalendarDays />
        </div>
        <StockCalendar monthId={monthId} monthStatus={month?.status} selectedDay={selectedDay} days={days} onSelect={setSelectedDay} />
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!selectedDayRecord || monthBootstrapPending}
            onClick={() => selectedDayRecord && exportStockDayXlsx(selectedDayRecord)}
          >
            <FileSpreadsheet />
            Export Daily Excel
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!selectedDayRecord || monthBootstrapPending}
            onClick={() => selectedDayRecord && exportStockPrintable(calculateMonthlySummary(monthId, [selectedDayRecord]), [selectedDayRecord])}
          >
            <FileDown />
            Export Daily PDF
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={days.length === 0 || month?.status === "closed" || monthBootstrapPending}
            onClick={() => void masterRefreshStockCalculations()}
          >
            Master Refresh Calculations
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!canReopenSelectedDay || month?.status === "closed" || monthBootstrapPending}
            onClick={() => void reopenSelectedDay()}
          >
            Reopen Selected Day
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!canMonthControls || monthBootstrapPending || availableDays(monthId, now).length === 0}
            onClick={() => void reopenAllStock()}
          >
            Reopen All
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!canMonthControls || month?.status === "closed" || monthBootstrapPending}
            onClick={() => void closeAllStock()}
          >
            Close All Except Today
          </button>
        </div>
      </section>

      {activeSectionVisible && section === "daily" && (
        <>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Daily Stock Entry</h2>
                <p className="flex flex-wrap items-center gap-1.5 text-slate-400 text-sm">
                  <span>{monthLabel(monthId)}</span>
                  <span className="text-slate-700">·</span>
                  <span>{dayDate(monthId, selectedDay)}</span>
                  <span className="text-slate-700">·</span>
                  <span className="text-slate-500 uppercase text-[10px] font-semibold tracking-wider">Month:</span>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-300">{month?.status ?? "open"}</span>
                  <span className="text-slate-700">·</span>
                  <span className="text-slate-500 uppercase text-[10px] font-semibold tracking-wider">Day:</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getDayStatusChipClass(selectedDayStatus)}`}>{selectedDayStatus}</span>
                  {selectedDayRecord && isReopenActive(selectedDayRecord, now) && (
                    <>
                      <span className="text-slate-700">·</span>
                      <span className="text-[10px] font-semibold uppercase text-emerald-300 animate-pulse">
                        Expires {new Date(selectedDayRecord.reopenedUntilAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </>
                  )}
                </p>
              </div>
              <CalendarDays />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="btn-chip">Auto-save off</span>
              <button className="btn-secondary" disabled={!selectedDayRecord || selectedDayRecord.status === "closed" || monthBootstrapPending} onClick={() => void closeSelectedDay()}>Close Day</button>
              <button className="btn-primary" disabled={!canEdit || loading || monthBootstrapPending} onClick={() => void saveEntry()}><Save />Save Now</button>
            </div>
          </section>

          {/* Selected Date Summary & Stock Flow Dashboard */}
          <section className="panel bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 border-slate-800">
            <div className="panel-title border-b border-slate-800 pb-3">
              <div>
                <h2>Selected Date Summary & Stock Flow</h2>
                <p>Quick summaries, stock-in, allotments, and stock closing flow for {dayDate(monthId, selectedDay)}.</p>
              </div>
              <BarChart3 className="text-emerald-500" />
            </div>

            {/* Metrics cards grid */}
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="card card-pad bg-slate-950/30 border-slate-800/80">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Total Stock Issued</span>
                <p className="mt-1 text-lg font-extrabold text-slate-100">{formatMoney(selectedDayRecord?.summary.totalQty ?? 0)}</p>
                <p className="text-[10px] text-slate-500 mt-1">Units allotted today</p>
              </div>
              <div className="card card-pad bg-slate-950/30 border-slate-800/80">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Total Amount</span>
                <p className="mt-1 text-lg font-extrabold text-emerald-400">{formatMoney(selectedDayRecord?.summary.totalAmount ?? 0)}</p>
                <p className="text-[10px] text-slate-500 mt-1">Total value issued</p>
              </div>
              <div className="card card-pad bg-slate-950/30 border-slate-800/80">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Payments Recovered</span>
                <p className="mt-1 text-lg font-extrabold text-blue-400">{formatMoney(selectedDayRecord?.summary.totalPaymentReceived ?? 0)}</p>
                <p className="text-[10px] text-slate-500 mt-1">Total collected today</p>
              </div>
              <div className="card card-pad bg-slate-950/30 border-slate-800/80">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Stock In (Jazz)</span>
                <p className="mt-1 text-lg font-extrabold text-indigo-400">
                  {formatMoney(
                    (selectedDayRecord?.stockIn ?? []).reduce((sum, r) => sum + r.totalQty, 0)
                  )}
                </p>
                <p className="text-[10px] text-slate-500 mt-1">Units received from Jazz</p>
              </div>
              <div className="card card-pad bg-slate-950/30 border-slate-800/80">
                <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Net Dues Change</span>
                <p className="mt-1 text-lg font-extrabold text-rose-400">
                  {formatMoney(
                    roundMoney(
                      (selectedDayRecord?.summary.totalAmount ?? 0) -
                        (selectedDayRecord?.summary.totalPaymentReceived ?? 0)
                    )
                  )}
                </p>
                <p className="text-[10px] text-slate-500 mt-1">Difference today</p>
              </div>
            </div>

            {/* Daily stock Closing Impact flow */}
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-slate-100 mb-2 flex items-center gap-1.5">
                <RefreshCw className="h-4 w-4 text-emerald-400 animate-spin-slow" />
                <span>Day Inventory Closing Flow & Impact</span>
              </h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Opening Stock (A)</th>
                      <th>Stock Received (B)</th>
                      <th>Stock Out / Allotted (C)</th>
                      <th>Closing Stock (A + B - C)</th>
                      <th>Rate Snapshot</th>
                      <th>Closing Value (Rs.)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.map((p) => {
                      const todayOpening = (() => {
                        const openingVal = monthOpeningStock[p.id] ?? 0;
                        let cumulativeStockIn = 0;
                        let cumulativeStockOut = 0;

                        for (const day of days) {
                          if (day.dayNo < selectedDay) {
                            // Stock In
                            const stockInRecs = day.stockIn ?? [];
                            for (const record of stockInRecs) {
                              const prodLine = record.products.find((line) => line.productId === p.id);
                              if (prodLine) cumulativeStockIn += prodLine.quantity;
                            }
                            // Stock Out
                            for (const entry of day.entries) {
                              const prodLine = entry.products.find((line) => line.productId === p.id);
                              if (prodLine) cumulativeStockOut += prodLine.quantity;
                            }
                          }
                        }
                        return roundMoney(openingVal + cumulativeStockIn - cumulativeStockOut);
                      })();

                      const stockInToday = (selectedDayRecord?.stockIn ?? []).reduce((sum, r) => {
                        const prodLine = r.products.find((line) => line.productId === p.id);
                        return sum + (prodLine?.quantity ?? 0);
                      }, 0);

                      const stockOutToday = (selectedDayRecord?.entries ?? []).reduce((sum, entry) => {
                        const prodLine = entry.products.find((line) => line.productId === p.id);
                        return sum + (prodLine?.quantity ?? 0);
                      }, 0);

                      const closingToday = roundMoney(todayOpening + stockInToday - stockOutToday);

                      return (
                        <tr key={p.id}>
                          <td className="font-semibold text-slate-200">{p.name}</td>
                          <td>{formatMoney(todayOpening)}</td>
                          <td className="text-indigo-400 font-semibold">{formatMoney(stockInToday)}</td>
                          <td className="text-rose-400 font-semibold">{formatMoney(stockOutToday)}</td>
                          <td className="font-bold text-slate-100">{formatMoney(closingToday)}</td>
                          <td>{formatMoney(p.rate)}</td>
                          <td className="font-mono text-emerald-400">{formatMoney(roundMoney(closingToday * p.rate))}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Grid of Stock In vs Stock Out lists for today */}
            <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Stock In today */}
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 p-3">
                <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <ArrowDownRight className="h-3.5 w-3.5 text-indigo-400" />
                    <span>Stock In Received Today (Jazz)</span>
                  </span>
                  <span className="text-[10px] text-slate-500 font-normal">{(selectedDayRecord?.stockIn ?? []).length} shipments</span>
                </h4>
                <div className="table-wrap max-h-60 overflow-y-auto">
                  <table className="!text-xs">
                    <thead>
                      <tr>
                        <th>Mode</th>
                        <th>Total Amount</th>
                        <th>Paid</th>
                        <th>Payable</th>
                        <th>Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedDayRecord?.stockIn ?? []).map((r) => (
                        <tr key={r.id}>
                          <td className="capitalize font-semibold text-slate-300">{r.stockInMode}</td>
                          <td className="font-mono">{formatMoney(r.totalAmount)}</td>
                          <td className="text-emerald-400 font-semibold">{formatMoney(r.paidAmount)}</td>
                          <td className="text-rose-400 font-semibold">{formatMoney(r.jazzPayableAmount)}</td>
                          <td className="text-slate-400 truncate max-w-[120px]" title={r.notes}>{r.notes || "—"}</td>
                        </tr>
                      ))}
                      {(selectedDayRecord?.stockIn ?? []).length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center text-slate-500 py-3 italic">No Jazz shipments received today.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Stock Out today */}
              <div className="rounded-lg border border-slate-800 bg-slate-950/20 p-3">
                <h4 className="text-xs uppercase font-bold text-slate-400 tracking-wider mb-2 flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <ArrowUpRight className="h-3.5 w-3.5 text-rose-400" />
                    <span>Stock Out Issued Today (Accounts)</span>
                  </span>
                  <span className="text-[10px] text-slate-500 font-normal">{(selectedDayRecord?.entries ?? []).length} accounts allotted</span>
                </h4>
                <div className="table-wrap max-h-60 overflow-y-auto">
                  <table className="!text-xs">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th>Qty</th>
                        <th>Issued Value</th>
                        <th>Payment</th>
                        <th>Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(selectedDayRecord?.entries ?? []).map((e) => (
                        <tr key={e.id}>
                          <td className="font-semibold text-slate-300">{e.accountName}</td>
                          <td>{formatMoney(e.totalQty)}</td>
                          <td className="font-mono">{formatMoney(e.totalAmount)}</td>
                          <td className="text-emerald-400 font-semibold">{formatMoney(e.totalPaymentReceived)}</td>
                          <td className="font-bold text-slate-200">{formatMoney(e.dueBalance)}</td>
                        </tr>
                      ))}
                      {(selectedDayRecord?.entries ?? []).length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center text-slate-500 py-3 italic">No customer allotments entered today.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>CCR/DO Account</h2>
                <p>Select an account before entering stock quantities.</p>
              </div>
              <Pencil />
            </div>
            <label>
              CCR/DO Account
              <select value={selectedAccountId} disabled={!canEdit || activeAccounts.length === 0 || monthBootstrapPending} onChange={(event) => setSelectedAccountId(event.target.value)}>
                {activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.name} · {account.type}</option>)}
              </select>
            </label>
            {!canEdit && <p className="warning mt-4">This stock day is read-only for your role or current day status.</p>}
            {activeAccounts.length === 0 && <p className="warning mt-4">Add active CCR/DO accounts in Stock Settings before using daily stock entry.</p>}
          </section>

          {selectedAccount && previewEntry && (
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h2>{selectedAccount.name} Stock Table</h2>
                  <p>Each product generates quantity, amount, payment, and due columns from Product Settings.</p>
                </div>
                <Save />
              </div>
              {/* Single Row Product Adder */}
              <div className="mb-6 rounded-xl border border-slate-800 bg-slate-950/50 p-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-4 items-end">
                  <label>
                    Select Product
                    <select
                      value={selectedProductIdInput || (activeProducts[0]?.id ?? "")}
                      disabled={!canEdit || activeProducts.length === 0 || monthBootstrapPending}
                      onChange={(e) => {
                        const prodId = e.target.value;
                        setSelectedProductIdInput(prodId);
                        setSelectedProductQtyInput(draft.productQuantities[prodId] ?? 0);
                      }}
                      className="mt-1"
                    >
                      {activeProducts.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (Rs. {p.rate})
                        </option>
                      ))}
                      {activeProducts.length === 0 && <option value="">-- No Products --</option>}
                    </select>
                  </label>

                  <label>
                    Quantity
                    <div className="mt-1">
                      <NumberInput
                        value={selectedProductQtyInput}
                        disabled={!canEdit || activeProducts.length === 0 || monthBootstrapPending}
                        onChange={(val) => setSelectedProductQtyInput(val)}
                      />
                    </div>
                  </label>

                  <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 h-[52px] flex flex-col justify-center">
                    <p className="text-[10px] uppercase font-semibold text-slate-500 tracking-wider">Subtotal Amount</p>
                    <p className="mt-0.5 text-base font-bold text-slate-200">
                      {(() => {
                        const activeId = selectedProductIdInput || activeProducts[0]?.id || "";
                        const prod = activeProducts.find((p) => p.id === activeId);
                        return prod ? formatMoney(selectedProductQtyInput * prod.rate) : "Rs. 0.00";
                      })()}
                    </p>
                  </div>

                  <div>
                    <button
                      type="button"
                      className="btn-primary w-full h-[38px] justify-center"
                      disabled={!canEdit || activeProducts.length === 0 || monthBootstrapPending}
                      onClick={() => {
                        const activeId = selectedProductIdInput || activeProducts[0]?.id || "";
                        if (!activeId) return;
                        setDraft((curr) => {
                          const prevQty = curr.productQuantities[activeId] ?? 0;
                          return {
                            ...curr,
                            productQuantities: {
                              ...curr.productQuantities,
                              [activeId]: prevQty + selectedProductQtyInput
                            }
                          };
                        });
                        // Reset quantity input and keep or reset the selection nicely
                        setSelectedProductQtyInput(0);
                        setSelectedProductIdInput("");
                      }}
                    >
                      <PlusCircle className="mr-1.5 h-4 w-4" />
                      Add / Update Item
                    </button>
                  </div>
                </div>
                {activeProducts.length === 0 && (
                  <p className="warning mt-3">No active stock products configured. Owner must configure Stock Settings first.</p>
                )}
              </div>

              {/* Added Products Table */}
              <div className="mb-6">
                <h3 className="text-sm font-semibold text-slate-100 mb-2">Added Products List</h3>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product Name</th>
                        <th>Rate Snapshot</th>
                        <th>Quantity</th>
                        <th>Calculated Amount</th>
                        {canEdit && <th>Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(draft.productQuantities)
                        .filter(([_, qty]) => qty > 0)
                        .map(([prodId, qty]) => {
                          const prod = products.find((p) => p.id === prodId);
                          if (!prod) return null;
                          const snapshot = previewEntry.products.find((item) => item.productId === prodId);
                          return (
                            <tr key={prodId}>
                              <td className="font-semibold text-slate-200">{prod.name}</td>
                              <td>{formatMoney(prod.rate)}</td>
                              <td>
                                {canEdit ? (
                                  <div className="w-24">
                                    <NumberInput
                                      value={qty}
                                      disabled={monthBootstrapPending}
                                      onChange={(val) => {
                                        setDraft((curr) => ({
                                          ...curr,
                                          productQuantities: {
                                            ...curr.productQuantities,
                                            [prodId]: val
                                          }
                                        }));
                                      }}
                                    />
                                  </div>
                                ) : (
                                  qty
                                )}
                              </td>
                              <td className="font-mono text-slate-300">{formatMoney(snapshot?.amount ?? (qty * prod.rate))}</td>
                              {canEdit && (
                                <td>
                                  <button
                                    type="button"
                                    className="btn-secondary !h-8 !w-8 !px-0 flex items-center justify-center text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30"
                                    title="Remove product"
                                    onClick={() => {
                                      setDraft((curr) => {
                                        const next = { ...curr.productQuantities };
                                        delete next[prodId];
                                        return { ...curr, productQuantities: next };
                                      });
                                    }}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                  </button>
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      {Object.entries(draft.productQuantities).filter(([_, qty]) => qty > 0).length === 0 && (
                        <tr>
                          <td colSpan={5} className="text-center text-slate-500 py-4 italic">
                            No products added to this daily entry yet. Select a product above to begin.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Single Account-Level Carry Forward & Payment Received Inputs */}
              <div className="mt-6 border-t border-slate-800 pt-6">
                <div className="mb-4">
                  <h3 className="text-base font-semibold text-slate-100">Account Recovery & Due Calculations</h3>
                  <p className="text-xs text-slate-400">Manage outstanding carry forwards and single payment recovery for this daily entry.</p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label>
                    Carry Forward / Initial Due Balance
                    {Boolean(previousEntry) ? (
                      <div className="mt-1 rounded-lg border border-slate-800 bg-slate-900/40 p-3 font-semibold text-slate-400">
                        {formatMoney(draft.carryForwardBalance ?? 0)}
                      </div>
                    ) : (
                      <div className="mt-1">
                        <NumberInput
                          value={draft.carryForwardBalance ?? 0}
                          disabled={!canEdit || monthBootstrapPending}
                          onChange={(value) => setDraft((current) => ({ ...current, carryForwardBalance: value }))}
                        />
                      </div>
                    )}
                  </label>
                  <label>
                    Payment Received
                    <div className="mt-1">
                      <NumberInput
                        value={draft.paymentReceived ?? 0}
                        disabled={!canEdit || monthBootstrapPending}
                        onChange={(value) => setDraft((current) => ({ ...current, paymentReceived: value }))}
                      />
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-5">
                <MetricCard label="Total Qty" value={formatMoney(previewEntry.totalQty)} helper="All active products." />
                <MetricCard label="Total Amount" value={formatMoney(previewEntry.totalAmount)} helper="Qty multiplied by rate snapshot." />
                <MetricCard label="Carry Forward" value={formatMoney(previewEntry.carryForwardBalance)} helper="Previous outstanding due." />
                <MetricCard label="Payment" value={formatMoney(previewEntry.totalPaymentReceived)} helper="Tracked single account payment." />
                <MetricCard label="Due" value={formatMoney(previewEntry.dueBalance)} helper="Amount minus payment plus carry." />
              </div>
              <label className="mt-4">
                Notes
                <input value={draft.notes ?? ""} disabled={!canEdit || monthBootstrapPending} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} />
              </label>
              {!isLiveDay(monthId, selectedDay, now) && (
                <p className="warning mt-4 flex items-start gap-1.5">
                  <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
                  <span>Warning: You are editing a past date. Saving changes here will not automatically update later days' carry-forward balances. Please verify subsequent days' balances if you change today's due balance.</span>
                </p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button className="btn-primary" disabled={!canEdit || loading || monthBootstrapPending} onClick={() => void saveEntry()}>
                  <Save />
                  Save Daily Stock Record
                </button>
                <button className="btn-secondary" disabled={!summary} onClick={() => summary && exportStockPrintable(summary, days)}>
                  <Printer />
                  Print Stock Report
                </button>
              </div>
            </section>
          )}

          {/* Whole Selected Month day-by-day overall summary */}
          <section className="panel mt-6">
            <div className="panel-title">
              <div>
                <h2>{monthLabel(monthId)} Day-by-Day Summary</h2>
                <p>Overall day-by-day rollup across all CCR/DO/DSO accounts in this month.</p>
              </div>
              <BarChart3 className="text-blue-500" />
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Day / Date</th>
                    <th>Total Qty</th>
                    <th>Stock Amount</th>
                    <th>Carry Forward</th>
                    <th>Payment Received</th>
                    <th>Outstanding Due</th>
                    <th>Status</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.dayRows.map((row) => {
                    const fullDay = days.find((d) => d.dayNo === row.dayNo);
                    const isReopened = row.status === "closed" && fullDay && isReopenActive(fullDay, now);
                    const statusLabel = isReopened ? "Re-open" : row.status === "closed" ? "Closed" : "Open";
                    const carryForward = roundMoney(row.totalDueBalance - row.totalAmount + row.totalPaymentReceived);
                    return (
                      <tr key={row.dayNo}>
                        <td className="font-semibold text-slate-200">
                          Day {row.dayNo} <span className="text-xs text-slate-500 font-normal">({row.date})</span>
                          <span className="block text-[10px] text-indigo-400 font-normal mt-0.5">
                            {row.accountCount} {row.accountCount === 1 ? "account" : "accounts"} allotted
                          </span>
                        </td>
                        <td>{formatMoney(row.totalQty)}</td>
                        <td className="font-mono text-slate-300">{formatMoney(row.totalAmount)}</td>
                        <td className="text-slate-400">{formatMoney(carryForward)}</td>
                        <td className="text-emerald-400 font-semibold">{formatMoney(row.totalPaymentReceived)}</td>
                        <td className="font-bold text-slate-100">{formatMoney(row.totalDueBalance)}</td>
                        <td>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${getDayStatusChipClass(statusLabel)}`}>
                            {statusLabel}
                          </span>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-secondary !py-1 !px-2 text-xs flex items-center gap-1"
                            onClick={() => {
                              setSelectedDay(row.dayNo);
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                            Load Day
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {metrics.dayRows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="text-center text-slate-500 py-4 italic">
                        No day summaries recorded in this month yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {activeSectionVisible && section === "dashboard" && (() => {
        // Calculations for Premium KPI Cards
        const totalStockInVal = allStockInRecords.reduce((sum, r) => sum + r.totalAmount, 0);
        const totalPayments = metrics.totalPaymentReceived;
        const totalAllotted = metrics.totalAmount;
        const recoveryRate = totalAllotted > 0 ? ((totalPayments / totalAllotted) * 100).toFixed(1) : "0.0";
        
        const jazzPayable = roundMoney(
          openingBalances.jazzOpeningPayable + 
          allStockInRecords.reduce((sum, r) => sum + r.totalAmount - r.paidAmount, 0)
        );

        const closingStockValToday = currentStockBalances.reduce((sum, row) => {
          const rate = productRateById[row.productId] ?? 0;
          return sum + (row.currentStock * rate);
        }, 0);

        const totalPhysicalUnits = currentStockBalances.reduce((sum, row) => sum + row.currentStock, 0);

        // Filter out low stock products
        const lowStockItems = currentStockBalances.filter((row) => row.currentStock <= 20);

        // Sort Top Debtors
        const topDebtors = [...metrics.accountTotals]
          .filter((a) => a.dueBalance > 0)
          .sort((a, b) => b.dueBalance - a.dueBalance)
          .slice(0, 5);

        // Account Segment Rollups (CCR, DO, DSO, etc.)
        const segmentRollup: Record<string, { count: number; qty: number; value: number; paid: number; due: number }> = {
          CCR: { count: 0, qty: 0, value: 0, paid: 0, due: 0 },
          DO: { count: 0, qty: 0, value: 0, paid: 0, due: 0 },
          DSO: { count: 0, qty: 0, value: 0, paid: 0, due: 0 },
          STOCK: { count: 0, qty: 0, value: 0, paid: 0, due: 0 },
          OTHER: { count: 0, qty: 0, value: 0, paid: 0, due: 0 },
        };

        metrics.accountTotals.forEach((a) => {
          const type = (a.accountType || "OTHER").toUpperCase();
          const target = segmentRollup[type] || segmentRollup.OTHER;
          target.count += 1;
          target.qty += a.totalQty;
          target.value += a.totalAmount;
          target.paid += a.totalPaymentReceived;
          target.due += a.dueBalance;
        });

        // Chart calculations for SVG Daily Bar Chart
        const chartHeight = 160;
        const chartWidth = Math.max(metrics.dayRows.length * 40, 800);
        const maxChartValue = Math.max(
          ...metrics.dayRows.map((r) => Math.max(r.totalAmount, r.totalPaymentReceived)),
          10000
        );

        return (
          <div className="space-y-6">
            <section className="panel">
              <div className="panel-title border-b border-slate-800 pb-3">
                <div>
                  <h2>All Products Stock Received Ledger</h2>
                  <p>Chronological details of stock received from Jazz for each product on all days.</p>
                </div>
                <Box className="text-teal-400 h-5 w-5" />
              </div>
            </section>

            {/* 1. HERO STATS GRID */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-xl transition-all hover:border-slate-700">
                <div className="absolute top-0 right-0 h-16 w-16 bg-gradient-to-br from-indigo-500/10 to-transparent rounded-bl-full" />
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest block">Total Issued Value</span>
                <div className="flex items-baseline gap-1 mt-2">
                  <span className="text-xl font-extrabold text-indigo-400 font-mono">{formatMoney(totalAllotted)}</span>
                  <span className="text-[10px] text-indigo-500">Rs.</span>
                </div>
                <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                  <ArrowUpRight className="h-3.5 w-3.5 text-indigo-400" />
                  <span>Outbound stock value</span>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-xl transition-all hover:border-slate-700">
                <div className="absolute top-0 right-0 h-16 w-16 bg-gradient-to-br from-emerald-500/10 to-transparent rounded-bl-full" />
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest block">Recovery Rate</span>
                <div className="flex items-baseline gap-1 mt-2">
                  <span className="text-xl font-extrabold text-emerald-400 font-mono">{recoveryRate}%</span>
                  <span className="text-[10px] text-emerald-500">Rate</span>
                </div>
                <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                  <span className="font-semibold text-emerald-400">{formatMoney(totalPayments)}</span>
                  <span>collected</span>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-xl transition-all hover:border-slate-700">
                <div className="absolute top-0 right-0 h-16 w-16 bg-gradient-to-br from-rose-500/10 to-transparent rounded-bl-full" />
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest block">Outstanding Due</span>
                <div className="flex items-baseline gap-1 mt-2">
                  <span className="text-xl font-extrabold text-rose-400 font-mono">{formatMoney(metrics.totalDueBalance)}</span>
                  <span className="text-[10px] text-rose-500">Rs.</span>
                </div>
                <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                  <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
                  <span>Customer debt due</span>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-xl transition-all hover:border-slate-700">
                <div className="absolute top-0 right-0 h-16 w-16 bg-gradient-to-br from-teal-500/10 to-transparent rounded-bl-full" />
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest block">Inventory Assets</span>
                <div className="flex items-baseline gap-1 mt-2">
                  <span className="text-xl font-extrabold text-teal-400 font-mono">{formatMoney(closingStockValToday)}</span>
                  <span className="text-[10px] text-teal-500">Rs.</span>
                </div>
                <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                  <FileSpreadsheet className="h-3.5 w-3.5 text-teal-400" />
                  <span>Real virtual value</span>
                </div>
              </div>

              <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-900/60 p-4 shadow-xl transition-all hover:border-slate-700">
                <div className="absolute top-0 right-0 h-16 w-16 bg-gradient-to-br from-amber-500/10 to-transparent rounded-bl-full" />
                <span className="text-[10px] uppercase font-bold text-slate-400 tracking-widest block">Physical Units</span>
                <div className="flex items-baseline gap-1 mt-2">
                  <span className="text-xl font-extrabold text-amber-400 font-mono">{formatMoney(totalPhysicalUnits)}</span>
                  <span className="text-[10px] text-amber-500">Qty</span>
                </div>
                <div className="flex items-center gap-1 mt-2 text-xs text-slate-400">
                  <Box className="h-3.5 w-3.5 text-amber-400" />
                  <span>Remaining items</span>
                </div>
              </div>
            </div>

            {/* 2. JAZZ COMPANY LOGISTICS SPLIT */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4 grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-indigo-500/10 flex items-center justify-center">
                  <ArrowDownRight className="text-indigo-400 h-5 w-5" />
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500">Jazz Stock Received</span>
                  <p className="text-sm font-bold text-slate-200 mt-0.5">{formatMoney(totalStockInVal)} Rs.</p>
                </div>
              </div>
              <div className="flex items-center gap-3 border-y border-slate-900 md:border-y-0 md:border-x border-slate-800/80 py-3 md:py-0 md:px-4">
                <div className="h-10 w-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
                  <Check className="text-emerald-400 h-5 w-5" />
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500">Paid to Jazz</span>
                  <p className="text-sm font-bold text-slate-200 mt-0.5">
                    {formatMoney(allStockInRecords.reduce((sum, r) => sum + r.paidAmount, 0))} Rs.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-lg bg-rose-500/10 flex items-center justify-center">
                  <AlertTriangle className="text-rose-400 h-5 w-5" />
                </div>
                <div>
                  <span className="text-[10px] uppercase font-bold text-slate-500">Jazz Remaining Payable</span>
                  <p className="text-sm font-bold text-rose-400 mt-0.5">{formatMoney(jazzPayable)} Rs.</p>
                </div>
              </div>
            </div>

            {/* 3. DOUBLE-BAR SVG CHART FOR DAILY STOCK FLOW */}
            <section className="panel">
              <div className="panel-title border-b border-slate-800 pb-3">
                <div>
                  <h2>Daily Activity Rollup</h2>
                  <p>Comparing stock issuance (indigo) against payment recovery (emerald) day-by-day.</p>
                </div>
                <div className="flex gap-4 text-xs font-semibold">
                  <span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-indigo-500 inline-block" /> Stock Issued</span>
                  <span className="flex items-center gap-1"><span className="h-3 w-3 rounded bg-emerald-500 inline-block" /> Recovered</span>
                </div>
              </div>

              <div className="mt-4 overflow-x-auto pb-2 scrollbar-thin">
                <div style={{ width: chartWidth }} className="h-48 relative">
                  <svg width={chartWidth} height={chartHeight} className="overflow-visible">
                    {/* Horizontal helper lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((p, idx) => {
                      const yVal = chartHeight - p * (chartHeight - 20) - 20;
                      const gridVal = Math.round(p * maxChartValue);
                      return (
                        <g key={idx}>
                          <line x1="0" y1={yVal} x2={chartWidth} y2={yVal} stroke="#1e293b" strokeDasharray="3" strokeWidth="1" />
                          <text x="5" y={yVal - 4} fill="#64748b" className="text-[8px] font-mono">
                            {formatMoney(gridVal)}
                          </text>
                        </g>
                      );
                    })}

                    {/* Bars rendering */}
                    {metrics.dayRows.map((row, idx) => {
                      const xBase = idx * 40 + 40;
                      const activeHeightVal = chartHeight - 30;

                      // Stock Issued bar calculations
                      const issuedHeight = (row.totalAmount / maxChartValue) * (activeHeightVal - 20);
                      const issuedY = activeHeightVal - issuedHeight;

                      // Recovered bar calculations
                      const recoveredHeight = (row.totalPaymentReceived / maxChartValue) * (activeHeightVal - 20);
                      const recoveredY = activeHeightVal - recoveredHeight;

                      return (
                        <g key={row.dayNo} className="group">
                          {/* Hover Tooltip trigger box */}
                          <rect x={xBase - 15} y="0" width="30" height={chartHeight} fill="transparent" />

                          {/* Stock Out Bar */}
                          {row.totalAmount > 0 && (
                            <rect
                              x={xBase - 8}
                              y={issuedY}
                              width="6"
                              height={issuedHeight}
                              fill="url(#indigoGrad)"
                              rx="2"
                              className="transition-all duration-300 group-hover:brightness-125"
                            />
                          )}

                          {/* Payment Recovered Bar */}
                          {row.totalPaymentReceived > 0 && (
                            <rect
                              x={xBase + 2}
                              y={recoveredY}
                              width="6"
                              height={recoveredHeight}
                              fill="url(#emeraldGrad)"
                              rx="2"
                              className="transition-all duration-300 group-hover:brightness-125"
                            />
                          )}

                          {/* Day Labels */}
                          <text x={xBase} y={chartHeight - 10} textAnchor="middle" fill="#64748b" className="text-[9px] font-bold">
                            d{row.dayNo}
                          </text>
                        </g>
                      );
                    })}

                    {/* Gradients definitions */}
                    <defs>
                      <linearGradient id="indigoGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#818cf8" />
                        <stop offset="100%" stopColor="#4f46e5" />
                      </linearGradient>
                      <linearGradient id="emeraldGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#34d399" />
                        <stop offset="100%" stopColor="#059669" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            </section>

            {/* 4. COMPLETE LIVE INVENTORY HEALTH GRID */}
            <section className="panel">
              <div className="panel-title border-b border-slate-800 pb-3">
                <div>
                  <h2>All Products Stock Received Ledger</h2>
                  <p>Chronological details of stock received from Jazz for each product on all days.</p>
                </div>
                <Box className="text-teal-400 h-5 w-5" />
              </div>
              <div className="table-wrap mt-3">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Payment Mode</th>
                      {products.filter(p => p.active).map((p) => (
                        <th key={p.id} className="text-center font-mono">
                          {p.name} (Rs. {productRateById[p.id] ?? 0})
                        </th>
                      ))}
                      <th>Total Qty</th>
                      <th>Total Amount</th>
                      <th>Paid Amount</th>
                      <th>Payable Remaining</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const allShipments = days
                        .flatMap((d) => d.stockIn ?? [])
                        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

                      if (allShipments.length === 0) {
                        const totalColSpan = 6 + products.filter(p => p.active).length;
                        return (
                          <tr>
                            <td colSpan={totalColSpan} className="text-center text-slate-500 py-4 italic">
                              No stock received entries found in this month.
                            </td>
                          </tr>
                        );
                      }

                      const activeProds = products.filter(p => p.active);

                      return allShipments.map((s) => {
                        return (
                          <tr key={s.id}>
                            <td className="font-semibold text-slate-200">{s.date}</td>
                            <td className="uppercase font-bold text-[10px] text-slate-400">{s.stockInMode}</td>
                            {activeProds.map((p) => {
                              const match = s.products.find((sp) => sp.productId === p.id);
                              const qty = match?.quantity ?? 0;
                              return (
                                <td key={p.id} className={`text-center font-mono font-semibold ${qty > 0 ? "text-indigo-400" : "text-slate-500"}`}>
                                  {qty > 0 ? qty : "—"}
                                </td>
                              );
                            })}
                            <td className="font-semibold text-slate-300">{formatMoney(s.totalQty)}</td>
                            <td className="font-mono text-slate-300">{formatMoney(s.totalAmount)}</td>
                            <td className="text-emerald-400 font-semibold font-mono">{formatMoney(s.paidAmount)}</td>
                            <td className="text-rose-400 font-bold font-mono">{formatMoney(s.jazzPayableAmount)}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            </section>

            {/* 5.5 MASTER DEALER & BALANCE SUMMARY PANEL */}
            <section className="panel">
              <div className="panel-title border-b border-slate-800 pb-3">
                <div>
                  <h2>Master Dealer & Balance Summary</h2>
                  <p>Consolidated performance, dynamic product allotments, and ending outstanding balance for every dealer account.</p>
                </div>
                <FileSpreadsheet className="text-emerald-400 h-5 w-5" />
              </div>
              <div className="table-wrap mt-3">
                <table className="!text-xs">
                  <thead>
                    <tr>
                      <th>Dealer / Account Name</th>
                      <th>Account Type</th>
                      <th>Opening Balance</th>
                      {products.filter(p => p.active).map((p) => (
                        <th key={p.id} className="text-center font-mono">
                          {p.name}
                        </th>
                      ))}
                      <th>Total Allotted Qty</th>
                      <th>Total Stock Amount</th>
                      <th>Payment Received</th>
                      <th>Adjustment / Return</th>
                      <th>Current Due</th>
                      <th>Closing Balance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((a) => {
                      const entriesPeriod = days.flatMap((d) => d.entries.filter((e) => e.accountId === a.id));
                      const activeProds = products.filter(p => p.active);

                      // Product-wise Allotment calculation
                      const productQuantities: Record<string, number> = {};
                      activeProds.forEach((p) => {
                        productQuantities[p.id] = 0;
                      });

                      entriesPeriod.forEach((e) => {
                        e.products.forEach((snap) => {
                          if (productQuantities[snap.productId] !== undefined) {
                            productQuantities[snap.productId] += snap.quantity;
                          }
                        });
                      });

                      const sortedDaysWithEntries = [...days]
                        .sort((x, y) => x.dayNo - y.dayNo);

                      const firstEntry = sortedDaysWithEntries
                        .flatMap((d) => d.entries.filter((e) => e.accountId === a.id))
                        .at(0);

                      const latestEntry = sortedDaysWithEntries
                        .flatMap((d) => d.entries.filter((e) => e.accountId === a.id))
                        .at(-1);

                      const opening = firstEntry ? firstEntry.carryForwardBalance : (a.openingBalance ?? 0);
                      const totalQty = entriesPeriod.reduce((sum, e) => sum + e.totalQty, 0);
                      const totalAmount = entriesPeriod.reduce((sum, e) => sum + e.totalAmount, 0);
                      const totalPayments = entriesPeriod.reduce((sum, e) => sum + e.totalPaymentReceived, 0);
                      const adjustments = 0;
                      
                      const currentDue = roundMoney(opening + totalAmount - totalPayments);
                      const closing = roundMoney(opening + totalAmount - totalPayments + adjustments);

                      return (
                        <tr key={a.id}>
                          <td className="font-semibold text-slate-200">{a.name}</td>
                          <td className="uppercase font-bold text-[10px] text-slate-400">{a.type}</td>
                          <td className="font-mono">{formatMoney(opening)}</td>
                          {activeProds.map((p) => {
                            const qty = productQuantities[p.id] ?? 0;
                            return (
                              <td key={p.id} className={`text-center font-mono font-semibold ${qty > 0 ? "text-indigo-400" : "text-slate-500"}`}>
                                {qty > 0 ? qty : "—"}
                              </td>
                            );
                          })}
                          <td className="font-semibold text-slate-300">{formatMoney(totalQty)}</td>
                          <td className="font-mono text-slate-300">{formatMoney(totalAmount)}</td>
                          <td className="text-emerald-400 font-semibold font-mono">{formatMoney(totalPayments)}</td>
                          <td className="text-slate-500 font-mono">—</td>
                          <td className="text-slate-300 font-semibold font-mono">{formatMoney(currentDue)}</td>
                          <td className="text-rose-400 font-bold font-mono">{formatMoney(closing)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>          
          </div>
        );
      })()}

      {activeSectionVisible && section === "stockIn" && (
        <>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Stock In from Jazz Company</h2>
                <p>{monthLabel(monthId)} · {dayDate(monthId, selectedDay)} · {month?.status ?? "open"}</p>
              </div>
              <CalendarDays />
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Enter Stock Received from Jazz Company</h2>
                <p>Enter quantities received. Product rates are snapshots of current active prices.</p>
              </div>
              <PlusCircle className="text-emerald-500" />
            </div>

            {activeProducts.length === 0 ? (
              <p className="warning">No active stock products configured. Owner must configure Stock Settings first.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label>
                    Stock In Mode
                    <select
                      value={stockInMode}
                      disabled={!canEdit || monthBootstrapPending}
                      onChange={(e) => {
                        const m = e.target.value as "cash" | "credit";
                        setStockInMode(m);
                        if (m === "cash") {
                          setStockInPaidAmount(0);
                        }
                      }}
                    >
                      <option value="credit">Credit (Paid Later / Partial)</option>
                      <option value="cash">Cash (Paid Fully)</option>
                    </select>
                  </label>

                  <label>
                    Paid Amount (Rs.)
                    <input
                      type="number"
                      value={stockInMode === "cash" ? (previewStockInRecord?.totalAmount ?? 0) : stockInPaidAmount}
                      disabled={!canEdit || stockInMode === "cash" || monthBootstrapPending}
                      onChange={(e) => setStockInPaidAmount(Math.max(0, Number(e.target.value) || 0))}
                    />
                  </label>
                </div>

                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Current Rate (Rs.)</th>
                        <th>Quantity Received</th>
                        <th>Subtotal (Rs.)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeProducts.map((p) => {
                        const qty = stockInQuantities[p.id] ?? 0;
                        const subtotal = roundMoney(qty * p.rate);
                        return (
                          <tr key={p.id}>
                            <td className="font-semibold text-slate-200">{p.name}</td>
                            <td>{formatMoney(p.rate)}</td>
                            <td>
                              <input
                                type="number"
                                className="w-24 text-center"
                                value={qty || ""}
                                placeholder="0"
                                disabled={!canEdit || monthBootstrapPending}
                                onChange={(e) => {
                                  const val = Math.max(0, Number(e.target.value) || 0);
                                  setStockInQuantities((prev) => ({ ...prev, [p.id]: val }));
                                }}
                              />
                            </td>
                            <td className="text-slate-300 font-mono">{formatMoney(subtotal)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {previewStockInRecord && (
                  <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                      <span className="text-slate-400 text-xs uppercase font-semibold">Total Qty</span>
                      <p className="text-lg font-bold text-slate-100">{formatMoney(previewStockInRecord.totalQty)}</p>
                    </div>
                    <div>
                      <span className="text-slate-400 text-xs uppercase font-semibold">Total Amount</span>
                      <p className="text-lg font-bold text-emerald-400">{formatMoney(previewStockInRecord.totalAmount)}</p>
                    </div>
                    <div>
                      <span className="text-slate-400 text-xs uppercase font-semibold">Paid Amount</span>
                      <p className="text-lg font-bold text-blue-400">{formatMoney(previewStockInRecord.paidAmount)}</p>
                    </div>
                    <div>
                      <span className="text-slate-400 text-xs uppercase font-semibold">Remaining Payable</span>
                      <p className="text-lg font-bold text-rose-400">{formatMoney(previewStockInRecord.jazzPayableAmount)}</p>
                    </div>
                  </div>
                )}

                <label>
                  Notes / Reference No.
                  <input
                    type="text"
                    value={stockInNotes}
                    disabled={!canEdit || monthBootstrapPending}
                    onChange={(e) => setStockInNotes(e.target.value)}
                    placeholder="e.g. Shipment receipt #4823"
                  />
                </label>

                {stockInMode === "cash" && previewStockInRecord && (
                  <p className="warning text-xs flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5 text-blue-400 shrink-0" />
                    <span>In Cash mode, the paid amount is automatically set to the full total amount.</span>
                  </p>
                )}

                <div className="flex gap-2 mt-4">
                  <button
                    className="btn-primary"
                    disabled={!canEdit || !previewStockInRecord || monthBootstrapPending}
                    onClick={() => void saveStockIn()}
                  >
                    <Save />
                    Save Jazz Stock In
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Today's Stock Received Records</h2>
                <p>Saved shipments from Jazz Company for this date.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
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
                          <button
                            className="btn-secondary !h-8 !w-8 !px-0 flex items-center justify-center text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/30"
                            title="Delete record"
                            disabled={!canEdit || monthBootstrapPending}
                            onClick={async () => {
                              if (window.confirm("Are you sure you want to delete this Jazz stock-in record? This will reduce the product stock balance and update the payable ledger.")) {
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
                                onQueueWrite(saveStockDay(workingMonth, nextDay, days, user, role), "Could not queue delete stock-in.");
                                onStatus("Deleted Jazz stock-in record successfully.");
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
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
        </>
      )}

      {activeSectionVisible && section === "reportsHub" && (
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
              { id: "masterSummary", label: "Master Stock Summary" },
              { id: "stockPosition", label: "Monthly Stock Position" },
              { id: "overview", label: "Monthly Overview" },
              { id: "products", label: "Product stock flow" },
              { id: "accounts", label: "Account summaries" },
              { id: "stockIn", label: "Stock In (Jazz)" },
              { id: "stockOut", label: "Stock Out (Allotments)" },
              { id: "payments", label: "Payment Recovery" },
              { id: "dues", label: "Due Balances" },
              { id: "currentStock", label: "Current Stock" },
              { id: "cashCredit", label: "Cash vs Credit In" },
              { id: "audit", label: "Audit & Log Report" }
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
              {/* 0.1 Monthly Stock Position & Value Report */}
              {activeReportSubTab === "stockPosition" && (() => {
                const activeProducts = products.filter((p) => p.active);
                
                // Days to display based on filters (default 1 to 31)
                const daysRange: number[] = [];
                for (let i = filterStartDate; i <= filterEndDate; i++) {
                  daysRange.push(i);
                }

                // Compute product-wise sums
                const productOpening: Record<string, number> = {};
                const productReceived: Record<string, number> = {};
                const productIssued: Record<string, number> = {};
                const productInHand: Record<string, number> = {};
                const productValuation: Record<string, number> = {};

                activeProducts.forEach((p) => {
                  const balanceRow = currentStockBalances.find(b => b.productId === p.id);
                  const rate = productRateById[p.id] ?? 0;
                  
                  productOpening[p.id] = monthOpeningStock[p.id] ?? 0;
                  productReceived[p.id] = (monthOpeningStock[p.id] ?? 0) + (balanceRow?.totalStockIn ?? 0);
                  productIssued[p.id] = balanceRow?.totalStockOut ?? 0;
                  productInHand[p.id] = balanceRow?.currentStock ?? 0;
                  productValuation[p.id] = (balanceRow?.currentStock ?? 0) * rate;
                });

                // Grand totals
                const grandOpening = activeProducts.reduce((sum, p) => sum + productOpening[p.id], 0);
                const grandReceived = activeProducts.reduce((sum, p) => sum + productReceived[p.id], 0);
                const grandIssued = activeProducts.reduce((sum, p) => sum + productIssued[p.id], 0);
                const grandInHand = activeProducts.reduce((sum, p) => sum + productInHand[p.id], 0);
                const grandValuation = activeProducts.reduce((sum, p) => sum + productValuation[p.id], 0);

                return (
                  <div className="space-y-4">
                    <div className="table-wrap border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                      <table className="!text-xs border-collapse w-full">
                        <thead>
                          {/* TOP HEADER BLOCK - CYAN/BLUE */}
                          <tr className="bg-sky-500 text-slate-900 font-extrabold text-center uppercase tracking-wider border-b border-sky-600">
                            <th className="py-2.5 px-3 border border-sky-600 text-left">Date</th>
                            <th colSpan={activeProducts.length} className="py-2.5 px-3 border border-sky-600">
                              Monthly Stock Position & Value
                            </th>
                            <th className="py-2.5 px-3 border border-sky-600">Total</th>
                          </tr>
                          
                          {/* DYNAMIC PRODUCT UNIT RATES HEADER ROW - GREEN */}
                          <tr className="bg-emerald-600 text-white font-mono text-center border-b border-emerald-700">
                            <th className="py-2 px-3 border border-emerald-700 text-left font-sans text-[10px] uppercase font-bold text-emerald-100">
                              Unit Rate (Rs.)
                            </th>
                            {activeProducts.map((p) => (
                              <th key={p.id} className="py-2 px-3 border border-emerald-700 font-bold">
                                {productRateById[p.id] ?? 0}
                              </th>
                            ))}
                            <th className="py-2 px-3 border border-emerald-700 font-bold">RATE</th>
                          </tr>

                          {/* DYNAMIC PRODUCT NAMES HEADER ROW - GREEN */}
                          <tr className="bg-emerald-600 text-white font-extrabold text-center border-b border-emerald-700">
                            <th className="py-2 px-3 border border-emerald-700 text-left text-[10px] uppercase tracking-wider text-emerald-100">
                              Product Name
                            </th>
                            {activeProducts.map((p) => (
                              <th key={p.id} className="py-2 px-3 border border-emerald-700 font-bold uppercase">
                                {p.name}
                              </th>
                            ))}
                            <th className="py-2 px-3 border border-emerald-700 font-bold uppercase">TOTAL QTY</th>
                          </tr>
                        </thead>

                        <tbody>
                          {/* OPENING ROW - GOLD/AMBER */}
                          <tr className="bg-amber-500 text-slate-950 font-bold border-b border-amber-600">
                            <td className="py-2.5 px-3 border border-amber-600 text-left font-black tracking-wide">
                              OPENING
                            </td>
                            {activeProducts.map((p) => {
                              const val = productOpening[p.id];
                              return (
                                <td key={p.id} className="py-2.5 px-3 border border-amber-600 text-center font-mono">
                                  {val > 0 ? val : "—"}
                                </td>
                              );
                            })}
                            <td className="py-2.5 px-3 border border-amber-600 text-center font-mono font-black">
                              {grandOpening > 0 ? grandOpening : "—"}
                            </td>
                          </tr>

                          {/* DAILY RECORD ROWS - DETAILED BY PRODUCT AND DATE */}
                          {daysRange.map((dayNo) => {
                            const dayRecord = days.find((d) => d.dayNo === dayNo);
                            const shipments = dayRecord?.stockIn ?? [];

                            // Find total received qty for this day across all products
                            const dayTotalQty = shipments.reduce((sum, s) => sum + s.totalQty, 0);

                            return (
                              <tr key={dayNo} className="hover:bg-slate-900/40 border-b border-slate-800 transition-colors">
                                <td className="py-2 px-3 border border-slate-800 text-left font-bold text-amber-400 bg-slate-900/60 w-24">
                                  Day {dayNo}
                                </td>
                                {activeProducts.map((p) => {
                                  const dayProductQty = shipments.reduce((sum, s) => {
                                    const match = s.products.find((sp) => sp.productId === p.id);
                                    return sum + (match?.quantity ?? 0);
                                  }, 0);

                                  return (
                                    <td key={p.id} className={`py-2 px-3 border border-slate-800 text-center font-mono font-semibold ${dayProductQty > 0 ? "text-indigo-400 font-bold bg-indigo-500/5" : "text-slate-600"}`}>
                                      {dayProductQty > 0 ? dayProductQty : "—"}
                                    </td>
                                  );
                                })}
                                <td className={`py-2 px-3 border border-slate-800 text-center font-mono font-bold bg-slate-900/60 ${dayTotalQty > 0 ? "text-slate-200" : "text-slate-600"}`}>
                                  {dayTotalQty > 0 ? dayTotalQty : "—"}
                                </td>
                              </tr>
                            );
                          })}

                          {/* TOTAL STOCK RECEIVED ROW (Opening + Shipments Received) - SLEEK DARK ROW */}
                          <tr className="bg-slate-900/90 text-slate-100 font-bold border-t-2 border-b border-slate-700">
                            <td className="py-2.5 px-3 border border-slate-700 text-left uppercase text-indigo-400 tracking-wider">
                              TOTAL STOCK RECEIVED
                            </td>
                            {activeProducts.map((p) => {
                              const val = productReceived[p.id];
                              return (
                                <td key={p.id} className="py-2.5 px-3 border border-slate-700 text-center font-mono font-black text-indigo-300">
                                  {val > 0 ? val : "—"}
                                </td>
                              );
                            })}
                            <td className="py-2.5 px-3 border border-slate-700 text-center font-mono font-black text-indigo-300 bg-indigo-500/10">
                              {grandReceived > 0 ? grandReceived : "—"}
                            </td>
                          </tr>

                          {/* TOTAL STOCK ISSUANCE ROW (Allotted) - SLEEK DARK ROW */}
                          <tr className="bg-slate-900/90 text-slate-100 font-bold border-b border-slate-700">
                            <td className="py-2.5 px-3 border border-slate-700 text-left uppercase text-rose-400 tracking-wider">
                              TOTAL STOCK ISSUANCE
                            </td>
                            {activeProducts.map((p) => {
                              const val = productIssued[p.id];
                              return (
                                <td key={p.id} className="py-2.5 px-3 border border-slate-700 text-center font-mono font-black text-rose-300">
                                  {val > 0 ? val : "—"}
                                </td>
                              );
                            })}
                            <td className="py-2.5 px-3 border border-slate-700 text-center font-mono font-black text-rose-300 bg-rose-500/10">
                              {grandIssued > 0 ? grandIssued : "—"}
                            </td>
                          </tr>

                          {/* STOCK IN HAND ROW (Received - Issued) - GOLD ROW */}
                          <tr className="bg-amber-500/10 text-amber-300 font-extrabold border-b-2 border-amber-500/30">
                            <td className="py-3 px-3 border border-amber-500/30 text-left uppercase tracking-wider text-amber-200">
                              STOCK IN HAND
                            </td>
                            {activeProducts.map((p) => {
                              const val = productInHand[p.id];
                              return (
                                <td key={p.id} className="py-3 px-3 border border-amber-500/30 text-center font-mono font-black text-[13px] text-amber-300">
                                  {val > 0 ? val : "—"}
                                </td>
                              );
                            })}
                            <td className="py-3 px-3 border border-amber-500/30 text-center font-mono font-black text-[13px] text-amber-300 bg-amber-500/25">
                              {grandInHand > 0 ? grandInHand : "—"}
                            </td>
                          </tr>

                          {/* STOCK VALUE ROW (Stock In Hand * Rate) - SLEEK VALUATION ROW */}
                          <tr className="bg-emerald-500/15 text-emerald-300 font-extrabold border-b border-emerald-500/30">
                            <td className="py-3 px-3 border border-emerald-500/30 text-left uppercase tracking-wider text-emerald-200">
                              STOCK VALUE
                            </td>
                            {activeProducts.map((p) => {
                              const val = productValuation[p.id];
                              return (
                                <td key={p.id} className="py-3 px-3 border border-emerald-500/30 text-center font-mono font-black text-[13px] text-emerald-300">
                                  {val > 0 ? formatMoney(val) : "—"}
                                </td>
                              );
                            })}
                            <td className="py-3 px-3 border border-emerald-500/30 text-center font-mono font-black text-[13px] text-emerald-300 bg-emerald-500/25">
                              {grandValuation > 0 ? formatMoney(grandValuation) : "—"}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* 0. Master Stock Summary Report */}
              {activeReportSubTab === "masterSummary" && (() => {
                const activeProducts = products.filter((p) => p.active);

                // Let's filter the accounts list
                const filteredAccounts = accounts.filter((a) => {
                  // Specific Account filter
                  if (filterAccountId && a.id !== filterAccountId) return false;
                  // Account Type filter
                  if (filterAccountType && a.type !== filterAccountType) return false;
                  // Active/Inactive filter
                  if (filterActiveStatus === "active" && !a.active) return false;
                  if (filterActiveStatus === "inactive" && a.active) return false;
                  return true;
                });

                return (
                  <div className="space-y-4">
                    <div className="table-wrap">
                      <table className="!text-xs">
                        <thead>
                          <tr>
                            <th>Dealer / Account Name</th>
                            <th>Account Type</th>
                            <th>Opening Balance</th>
                            {activeProducts.map((p) => (
                              <th key={p.id} className="text-center font-mono">
                                {p.name}
                              </th>
                            ))}
                            <th>Total Allotted Qty</th>
                            <th>Total Stock Amount</th>
                            <th>Payment Received</th>
                            <th>Adjustment / Return</th>
                            <th>Current Due</th>
                            <th>Closing Balance</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filteredAccounts.map((a) => {
                            const entriesPeriod = days
                              .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate && (filterDayStatus === "" || d.status === filterDayStatus))
                              .flatMap((d) => d.entries.filter((e) => e.accountId === a.id));

                            // Product-wise Allotment calculation
                            const productQuantities: Record<string, number> = {};
                            activeProducts.forEach((p) => {
                              productQuantities[p.id] = 0;
                            });

                            entriesPeriod.forEach((e) => {
                              e.products.forEach((snap) => {
                                if (productQuantities[snap.productId] !== undefined) {
                                  productQuantities[snap.productId] += snap.quantity;
                                }
                              });
                            });

                            // Filter by dynamic product allotment if product filter is active
                            if (filterProductId) {
                              const qtyForSelectedProduct = productQuantities[filterProductId] ?? 0;
                              if (qtyForSelectedProduct === 0) return null;
                            }

                            const sortedDaysWithEntries = [...days]
                              .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate && (filterDayStatus === "" || d.status === filterDayStatus))
                              .sort((x, y) => x.dayNo - y.dayNo);

                            const firstEntry = sortedDaysWithEntries
                              .flatMap((d) => d.entries.filter((e) => e.accountId === a.id))
                              .at(0);

                            const latestEntry = sortedDaysWithEntries
                              .flatMap((d) => d.entries.filter((e) => e.accountId === a.id))
                              .at(-1);

                            const opening = firstEntry ? firstEntry.carryForwardBalance : (a.openingBalance ?? 0);
                            const totalQty = entriesPeriod.reduce((sum, e) => sum + e.totalQty, 0);
                            const totalAmount = entriesPeriod.reduce((sum, e) => sum + e.totalAmount, 0);
                            const totalPayments = entriesPeriod.reduce((sum, e) => sum + e.totalPaymentReceived, 0);
                            const adjustments = 0; // standard default
                            
                            const currentDue = roundMoney(opening + totalAmount - totalPayments);
                            const closing = roundMoney(opening + totalAmount - totalPayments + adjustments);

                            // Due Status filters
                            if (filterDueStatus === "due" && closing === 0) return null;
                            if (filterDueStatus === "nodue" && closing !== 0) return null;

                            return (
                              <tr key={a.id}>
                                <td className="font-semibold text-slate-200">{a.name}</td>
                                <td className="uppercase font-bold text-[10px] text-slate-400">{a.type}</td>
                                <td className="font-mono">{formatMoney(opening)}</td>
                                {activeProducts.map((p) => {
                                  const qty = productQuantities[p.id] ?? 0;
                                  return (
                                    <td key={p.id} className={`text-center font-mono font-semibold ${qty > 0 ? "text-indigo-400" : "text-slate-500"}`}>
                                      {qty > 0 ? qty : "—"}
                                    </td>
                                  );
                                })}
                                <td className="font-semibold text-slate-300">{formatMoney(totalQty)}</td>
                                <td className="font-mono text-slate-300">{formatMoney(totalAmount)}</td>
                                <td className="text-emerald-400 font-semibold font-mono">{formatMoney(totalPayments)}</td>
                                <td className="text-slate-500 font-mono">—</td>
                                <td className="text-slate-300 font-semibold font-mono">{formatMoney(currentDue)}</td>
                                <td className="text-rose-400 font-bold font-mono">{formatMoney(closing)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })()}

              {/* 1. Monthly Overview Report */}
              {activeReportSubTab === "overview" && (() => {
                const filteredDaysList = days.filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate && (filterDayStatus === "" || d.status === filterDayStatus));
                const totalStockInVal = filteredDaysList.reduce((sum, d) => sum + (d.stockIn ?? []).filter(r => !filterStockInMode || r.stockInMode === filterStockInMode).reduce((s, r) => s + r.totalAmount, 0), 0);
                const totalStockOutVal = filteredDaysList.reduce((sum, d) => sum + d.entries.filter(e => (!filterAccountId || e.accountId === filterAccountId) && (!filterAccountType || e.accountType === filterAccountType)).reduce((s, e) => s + e.totalAmount, 0), 0);
                const totalPayments = filteredDaysList.reduce((sum, d) => sum + d.entries.filter(e => (!filterAccountId || e.accountId === filterAccountId) && (!filterAccountType || e.accountType === filterAccountType)).reduce((s, e) => s + e.totalPaymentReceived, 0), 0);
                const outstandingDues = roundMoney(totalStockOutVal - totalPayments);
                const closingStockValToday = currentStockBalances.reduce((sum, row) => {
                  const rate = productRateById[row.productId] ?? 0;
                  return sum + (row.currentStock * rate);
                }, 0);

                return (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="card card-pad bg-slate-900/60 border-slate-800">
                        <span className="text-xs uppercase font-bold text-slate-400 tracking-wider">Total Stock In (Jazz)</span>
                        <p className="text-2xl font-extrabold text-indigo-400 mt-1">{formatMoney(totalStockInVal)}</p>
                      </div>
                      <div className="card card-pad bg-slate-900/60 border-slate-800">
                        <span className="text-xs uppercase font-bold text-slate-400 tracking-wider">Total Stock Out (Allotted)</span>
                        <p className="text-2xl font-extrabold text-rose-400 mt-1">{formatMoney(totalStockOutVal)}</p>
                      </div>
                      <div className="card card-pad bg-slate-900/60 border-slate-800">
                        <span className="text-xs uppercase font-bold text-slate-400 tracking-wider">Payments Recovered</span>
                        <p className="text-2xl font-extrabold text-emerald-400 mt-1">{formatMoney(totalPayments)}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="card card-pad bg-slate-900/60 border-slate-800">
                        <span className="text-xs uppercase font-bold text-slate-400 tracking-wider">Net Outstanding Due Change</span>
                        <p className="text-2xl font-extrabold text-amber-500 mt-1">{formatMoney(outstandingDues)}</p>
                      </div>
                      <div className="card card-pad bg-slate-900/60 border-slate-800">
                        <span className="text-xs uppercase font-bold text-slate-400 tracking-wider">Closing Inventory Value</span>
                        <p className="text-2xl font-extrabold text-teal-400 mt-1">{formatMoney(closingStockValToday)}</p>
                      </div>
                      <div className="card card-pad bg-slate-900/60 border-slate-800">
                        <span className="text-xs uppercase font-bold text-slate-400 tracking-wider">Jazz Payable Balance</span>
                        <p className="text-2xl font-extrabold text-red-400 mt-1">
                          {formatMoney(
                            roundMoney(
                              openingBalances.jazzOpeningPayable + 
                              allStockInRecords.reduce((sum, r) => sum + r.totalAmount - r.paidAmount, 0)
                            )
                          )}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* 2. Product-wise Stock Flow Report */}
              {activeReportSubTab === "products" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Opening Stock</th>
                        <th>Stock Received</th>
                        <th>Stock Allotted</th>
                        <th>Closing Stock</th>
                        <th>Rate Snapshot</th>
                        <th>Inventory Value</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {products
                        .filter((p) => !filterProductId || p.id === filterProductId)
                        .map((p) => {
                          const todayOpening = (() => {
                            const openingVal = monthOpeningStock[p.id] ?? 0;
                            let cumulativeStockIn = 0;
                            let cumulativeStockOut = 0;

                            for (const day of days) {
                              if (day.dayNo < filterStartDate) {
                                const stockInRecs = day.stockIn ?? [];
                                for (const record of stockInRecs) {
                                  const prodLine = record.products.find((line) => line.productId === p.id);
                                  if (prodLine) cumulativeStockIn += prodLine.quantity;
                                }
                                for (const entry of day.entries) {
                                  const prodLine = entry.products.find((line) => line.productId === p.id);
                                  if (prodLine) cumulativeStockOut += prodLine.quantity;
                                }
                              }
                            }
                            return roundMoney(openingVal + cumulativeStockIn - cumulativeStockOut);
                          })();

                          const stockInPeriod = days
                            .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                            .reduce((sum, d) => {
                              const stockInRecs = (d.stockIn ?? []).filter(r => !filterStockInMode || r.stockInMode === filterStockInMode);
                              return sum + stockInRecs.reduce((s, r) => s + (r.products.find((l) => l.productId === p.id)?.quantity ?? 0), 0);
                            }, 0);

                          const stockOutPeriod = days
                            .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                            .reduce((sum, d) => {
                              const entriesRecs = d.entries.filter(e => (!filterAccountId || e.accountId === filterAccountId) && (!filterAccountType || e.accountType === filterAccountType));
                              return sum + entriesRecs.reduce((s, e) => s + (e.products.find((l) => l.productId === p.id)?.quantity ?? 0), 0);
                            }, 0);

                          const closingPeriod = roundMoney(todayOpening + stockInPeriod - stockOutPeriod);
                          const value = roundMoney(closingPeriod * p.rate);
                          const isLow = closingPeriod < 20;

                          return (
                            <tr key={p.id}>
                              <td className="font-semibold text-slate-200">{p.name}</td>
                              <td>{formatMoney(todayOpening)}</td>
                              <td className="text-indigo-400">+{formatMoney(stockInPeriod)}</td>
                              <td className="text-rose-400">-{formatMoney(stockOutPeriod)}</td>
                              <td className="font-bold text-slate-100">{formatMoney(closingPeriod)}</td>
                              <td>{formatMoney(p.rate)}</td>
                              <td className="font-mono text-emerald-400">{formatMoney(value)}</td>
                              <td>
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase flex items-center justify-center gap-1 ${isLow ? "bg-amber-500/10 text-amber-400 border border-amber-500/20" : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"}`}>
                                  {isLow && <AlertTriangle className="h-3 w-3" />}
                                  <span>{isLow ? "Low Stock" : "Healthy"}</span>
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 3. Account/Person-wise Report */}
              {activeReportSubTab === "accounts" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Account Name</th>
                        <th>Type</th>
                        <th>Total Qty Issued</th>
                        <th>Allotment Amount</th>
                        <th>Payment Recovered</th>
                        <th>Carry Forward</th>
                        <th>Remaining Outstanding</th>
                        <th>Last Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts
                        .filter((a) => (!filterAccountId || a.id === filterAccountId) && (!filterAccountType || a.type === filterAccountType))
                        .map((a) => {
                          const entriesPeriod = days
                            .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                            .flatMap((d) => d.entries.filter((e) => e.accountId === a.id));

                          if (entriesPeriod.length === 0 && filterDueStatus === "due") return null;

                          const totalQty = entriesPeriod.reduce((sum, e) => sum + e.totalQty, 0);
                          const totalAmount = entriesPeriod.reduce((sum, e) => sum + e.totalAmount, 0);
                          const totalPayments = entriesPeriod.reduce((sum, e) => sum + e.totalPaymentReceived, 0);
                          const latestEntry = entriesPeriod.at(-1);
                          const carry = latestEntry?.carryForwardBalance ?? a.openingBalance ?? 0;
                          const currentDue = latestEntry?.dueBalance ?? carry;

                          if (filterDueStatus === "due" && currentDue === 0) return null;
                          if (filterDueStatus === "nodue" && currentDue !== 0) return null;

                          return (
                            <tr key={a.id}>
                              <td className="font-semibold text-slate-200">{a.name}</td>
                              <td className="uppercase font-bold text-slate-400">{a.type}</td>
                              <td>{formatMoney(totalQty)}</td>
                              <td className="font-mono">{formatMoney(totalAmount)}</td>
                              <td className="text-emerald-400 font-semibold">{formatMoney(totalPayments)}</td>
                              <td>{formatMoney(carry)}</td>
                              <td className="font-bold text-slate-100">{formatMoney(currentDue)}</td>
                              <td className="text-xs text-slate-400">{latestEntry?.date || "—"}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 4. Stock In from Jazz Report */}
              {activeReportSubTab === "stockIn" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Mode</th>
                        <th>Products / Line Details</th>
                        <th>Total Qty</th>
                        <th>Total Amount</th>
                        <th>Paid Amount</th>
                        <th>Payable Remaining</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {days
                        .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                        .flatMap((d) => (d.stockIn ?? []).filter(r => !filterStockInMode || r.stockInMode === filterStockInMode))
                        .map((r) => (
                          <tr key={r.id}>
                            <td className="font-semibold">{r.date}</td>
                            <td>
                              <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${r.stockInMode === "cash" ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"}`}>
                                {r.stockInMode}
                              </span>
                            </td>
                            <td className="text-xs max-w-xs truncate">
                              {r.products
                                .filter((p) => !filterProductId || p.productId === filterProductId)
                                .map((p) => `${p.productName} (x${p.quantity})`)
                                .join(", ")}
                            </td>
                            <td>{formatMoney(r.totalQty)}</td>
                            <td className="font-mono">{formatMoney(r.totalAmount)}</td>
                            <td className="text-emerald-400 font-semibold">{formatMoney(r.paidAmount)}</td>
                            <td className="text-rose-400 font-semibold">{formatMoney(r.jazzPayableAmount)}</td>
                            <td className="text-xs text-slate-400 italic">{r.notes || "—"}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 5. Stock Out/Allotment Report */}
              {activeReportSubTab === "stockOut" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Day / Date</th>
                        <th>Account</th>
                        <th>Type</th>
                        <th>Products Allotted</th>
                        <th>Total Qty</th>
                        <th>Allotment Amount</th>
                        <th>Payment Received</th>
                        <th>Outstanding Due</th>
                      </tr>
                    </thead>
                    <tbody>
                      {days
                        .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                        .flatMap((d) => d.entries.filter(e => (!filterAccountId || e.accountId === filterAccountId) && (!filterAccountType || e.accountType === filterAccountType)))
                        .map((e) => (
                          <tr key={e.id}>
                            <td>Day {e.dayNo} <span className="text-xs text-slate-500">({e.date})</span></td>
                            <td className="font-semibold text-slate-200">{e.accountName}</td>
                            <td className="uppercase font-bold text-slate-400 text-xs">{e.accountType}</td>
                            <td className="text-xs max-w-xs truncate">
                              {e.products
                                .filter((p) => !filterProductId || p.productId === filterProductId)
                                .map((p) => `${p.productName} (x${p.quantity})`)
                                .join(", ")}
                            </td>
                            <td>{formatMoney(e.totalQty)}</td>
                            <td className="font-mono text-slate-300">{formatMoney(e.totalAmount)}</td>
                            <td className="text-emerald-400 font-semibold">{formatMoney(e.totalPaymentReceived)}</td>
                            <td className="font-bold text-slate-100">{formatMoney(e.dueBalance)}</td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 6. Payment Recovery Report */}
              {activeReportSubTab === "payments" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Account Name</th>
                        <th>Account Type</th>
                        <th>allotment total</th>
                        <th>payment recovered</th>
                        <th>outstanding balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts
                        .filter((a) => (!filterAccountId || a.id === filterAccountId) && (!filterAccountType || a.type === filterAccountType))
                        .map((a) => {
                          const entriesPeriod = days
                            .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                            .flatMap((d) => d.entries.filter((e) => e.accountId === a.id));

                          const totalAmount = entriesPeriod.reduce((sum, e) => sum + e.totalAmount, 0);
                          const totalPayments = entriesPeriod.reduce((sum, e) => sum + e.totalPaymentReceived, 0);
                          const latestEntry = entriesPeriod.at(-1);
                          const currentDue = latestEntry?.dueBalance ?? a.openingBalance ?? 0;

                          return (
                            <tr key={a.id}>
                              <td className="font-semibold text-slate-200">{a.name}</td>
                              <td className="uppercase font-bold text-slate-400 text-xs">{a.type}</td>
                              <td className="font-mono text-slate-300">{formatMoney(totalAmount)}</td>
                              <td className="text-emerald-400 font-extrabold">{formatMoney(totalPayments)}</td>
                              <td className="font-bold text-rose-400">{formatMoney(currentDue)}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 7. Due Balance Report */}
              {activeReportSubTab === "dues" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Customer / DO Name</th>
                        <th>Account Type</th>
                        <th>previous outstanding</th>
                        <th>new allotments</th>
                        <th>payment received</th>
                        <th>current outstanding</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accounts
                        .filter((a) => (!filterAccountId || a.id === filterAccountId) && (!filterAccountType || a.type === filterAccountType))
                        .map((a) => {
                          const entriesPeriod = days
                            .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                            .flatMap((d) => d.entries.filter((e) => e.accountId === a.id));

                          const totalAmount = entriesPeriod.reduce((sum, e) => sum + e.totalAmount, 0);
                          const totalPayments = entriesPeriod.reduce((sum, e) => sum + e.totalPaymentReceived, 0);
                          const latestEntry = entriesPeriod.at(-1);
                          const prevDue = latestEntry?.carryForwardBalance ?? a.openingBalance ?? 0;
                          const currentDue = latestEntry?.dueBalance ?? prevDue;

                          if (filterDueStatus === "due" && currentDue === 0) return null;
                          if (filterDueStatus === "nodue" && currentDue !== 0) return null;

                          return (
                            <tr key={a.id}>
                              <td className="font-semibold text-slate-200">{a.name}</td>
                              <td className="uppercase font-bold text-slate-400 text-xs">{a.type}</td>
                              <td>{formatMoney(prevDue)}</td>
                              <td className="text-amber-500 font-semibold">+{formatMoney(totalAmount)}</td>
                              <td className="text-emerald-400 font-semibold">-{formatMoney(totalPayments)}</td>
                              <td className="font-bold text-rose-400">{formatMoney(currentDue)}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 8. Current Stock Report */}
              {activeReportSubTab === "currentStock" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Rate Snapshot</th>
                        <th>Opening Stock</th>
                        <th>Received Today</th>
                        <th>Allotted Today</th>
                        <th>Real-time Balance</th>
                        <th>Balance Value</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currentStockBalances
                        .filter((row) => !filterProductId || row.productId === filterProductId)
                        .map((row) => {
                          const isLow = row.currentStock <= 5;
                          const rate = productRateById[row.productId] ?? 0;
                          const balanceValue = roundMoney(row.currentStock * rate);
                          return (
                            <tr key={row.productId}>
                              <td className="font-semibold text-slate-200">{row.productName}</td>
                              <td className="font-mono">{formatMoney(rate)}</td>
                              <td>{formatMoney(row.openingStock)}</td>
                              <td className="text-emerald-400">+{formatMoney(row.totalStockIn)}</td>
                              <td className="text-rose-400">-{formatMoney(row.totalStockOut)}</td>
                              <td className="font-bold text-slate-100">{formatMoney(row.currentStock)}</td>
                              <td className="font-mono font-semibold text-emerald-400">{formatMoney(balanceValue)}</td>
                              <td>
                                <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${
                                  row.currentStock < 0 
                                    ? "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                                    : isLow
                                      ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                      : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                }`}>
                                  {row.currentStock < 0 ? "Negative Stock" : isLow ? "Low Stock" : "In Stock"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* 9. Cash/Credit Stock In Report */}
              {activeReportSubTab === "cashCredit" && (() => {
                const stockInRecords = days
                  .filter((d) => d.dayNo >= filterStartDate && d.dayNo <= filterEndDate)
                  .flatMap((d) => d.stockIn ?? []);

                const cashRecords = stockInRecords.filter((r) => r.stockInMode === "cash");
                const creditRecords = stockInRecords.filter((r) => r.stockInMode === "credit");

                const cashTotalAmount = cashRecords.reduce((sum, r) => sum + r.totalAmount, 0);
                const creditTotalAmount = creditRecords.reduce((sum, r) => sum + r.totalAmount, 0);

                const creditPaidAmount = creditRecords.reduce((sum, r) => sum + r.paidAmount, 0);
                const creditPayable = creditRecords.reduce((sum, r) => sum + r.jazzPayableAmount, 0);

                return (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Payment Mode</th>
                          <th>Shipment Count</th>
                          <th>Total Value received (Rs.)</th>
                          <th>Paid Amount (Rs.)</th>
                          <th>outstanding payable (Rs.)</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="font-bold text-emerald-400">Cash Mode</td>
                          <td>{cashRecords.length}</td>
                          <td>{formatMoney(cashTotalAmount)}</td>
                          <td className="text-emerald-400 font-semibold">{formatMoney(cashTotalAmount)}</td>
                          <td>Rs. 0.00</td>
                        </tr>
                        <tr>
                          <td className="font-bold text-indigo-400">Credit Mode</td>
                          <td>{creditRecords.length}</td>
                          <td>{formatMoney(creditTotalAmount)}</td>
                          <td className="text-blue-400 font-semibold">{formatMoney(creditPaidAmount)}</td>
                          <td className="text-rose-400 font-bold">{formatMoney(creditPayable)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              {/* 10. Audit/Correction Report */}
              {activeReportSubTab === "audit" && (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Date & Time</th>
                        <th>Action Performed</th>
                        <th>Operator Email</th>
                        <th>Operator Role</th>
                        <th>Details / Summary</th>
                      </tr>
                    </thead>
                    <tbody>
                      {auditLogs.length > 0 ? (
                        auditLogs.map((log) => (
                          <tr key={log.id}>
                            <td className="text-xs">{new Date(log.createdAt).toLocaleString()}</td>
                            <td>
                              <span className="font-semibold text-indigo-400 capitalize">{log.action}</span>
                            </td>
                            <td>{log.actorEmail || "System Automation"}</td>
                            <td className="uppercase text-xs font-bold text-slate-500">{log.actorRole}</td>
                            <td className="text-slate-300 max-w-sm truncate" title={log.summary}>
                              {log.summary}
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="text-center text-slate-500 py-4 italic">
                            No logs recorded for Stock Ledger operations in {monthLabel(monthId)} yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {activeSectionVisible && section === "settings" && (
        <>
          {!canManageSettings && <p className="warning">Only owner can manage Stock Settings.</p>}

          <SettingsTable
            title="Products"
            kind="product"
            canEdit={canManageSettings}
            rows={sortedProducts}
            onSave={(row) => onQueueWrite(upsertStockProduct({
              ...(row as StockProduct),
              paymentTrackingEnabled: (row as StockProduct).paymentTrackingEnabled !== false
            }, user, role), "Could not save stock product.")}
            onDelete={(id) => onQueueWrite(deleteStockProduct(id, user, role), "Could not delete stock product.")}
          />
          <SettingsTable
            title="CCR/DO Accounts"
            kind="account"
            canEdit={canManageSettings}
            rows={sortedAccounts}
            onSave={(row) => onQueueWrite(upsertStockAccount(row as StockAccountProfile, user, role), "Could not save stock account.")}
            onDelete={(id) => onQueueWrite(deleteStockAccount(id, user, role), "Could not delete stock account.")}
          />
        </>
      )}

      {activeSectionVisible && section === "backup" && (
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
      )}
    </section>
  );
}

function SummaryTable({ title, headers, rows }: { title: string; headers: string[]; rows: Array<Array<string | number>> }) {
  return (
    <section className="panel">
      <div className="panel-title"><div><h2>{title}</h2><p>Stock Ledger report only.</p></div></div>
      <div className="table-wrap">
        <table>
          <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
          <tbody>{rows.length > 0 ? rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>) : <tr><td colSpan={headers.length}>No stock data yet.</td></tr>}</tbody>
        </table>
      </div>
    </section>
  );
}
