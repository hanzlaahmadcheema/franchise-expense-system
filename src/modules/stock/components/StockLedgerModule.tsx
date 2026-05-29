import { useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { BarChart3, CalendarDays, Check, ChevronDown, ChevronRight, FileDown, FileSpreadsheet, Pencil, Printer, Save, Settings, Trash2, X, PlusCircle, ArrowUpRight, ArrowDownRight } from "lucide-react";
import type { UserRole } from "../../../types/ledger";
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
  closeStockDay,
  ensureStockMonth,
  ensureStockOpeningSeed,
  listStockBackup,
  reopenStockDayFor15Minutes,
  roleCanStock,
  saveStockDay,
  setStockMonthStatus,
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

type StockSection = "dashboard" | "stockIn" | "daily" | "records" | "balances" | "jazzPayable" | "dues" | "products" | "accounts" | "settings" | "backup";
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

function canEditStockDay(role: UserRole | null, month: StockMonth | undefined, monthId: string, day: StockDayRecord | undefined, dayNo: number, now = new Date()) {
  if (!roleCanStock(role, "daily")) return false;
  if (month?.status === "closed") return false;
  if (role === "admin") return isLiveDay(monthId, dayNo, now) && day?.status !== "closed";
  if (isLiveDay(monthId, dayNo, now)) return day?.status !== "closed";
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
  function dayStatus(dayNo: number, day?: StockDayRecord) {
    if (!available.has(dayNo)) return "Future";
    if (monthStatus === "closed") return "Closed";
    if (day && isReopenActive(day, now)) return "Re-open";
    if (day?.status === "closed") return "Closed";
    if (isLiveDay(monthId, dayNo, now)) return "Open";
    if (day?.status === "open") return "Open";
    return "Closed";
  }
  function chipClass(status: string) {
    if (status === "Open") return "bg-emerald-400/15 text-emerald-200";
    if (status === "Re-open") return "bg-blue-400/15 text-blue-200";
    if (status === "Closed") return "bg-rose-400/15 text-rose-200";
    return "bg-slate-800 text-slate-500";
  }
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
          const status = dayStatus(cell.dayNo, day);
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
              <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chipClass(status)}`}>{status}</span>
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
  onSave: (row: StockProduct | StockAccountProfile) => void;
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
        <div className="mb-5 grid grid-cols-1 gap-3 md:grid-cols-5 md:items-end">
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
                                  rate: kind === "product" ? (row as StockProduct).rate : 0,
                                  type: kind === "account" ? (row as StockAccountProfile).type : "CCR",
                                  order: row.displayOrder,
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
                <td colSpan={kind === "product" ? (canEdit ? 7 : 6) : kind === "account" ? (canEdit ? 6 : 5) : canEdit ? 5 : 4}>
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
  const [draft, setDraft] = useState<StockDailyAccountDraft>({ accountId: "", productQuantities: {}, productPayments: {} });
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
      subscribeStockMonthlySummary(monthId, (nextSummary, metadata) => { setSummary(nextSummary); callbacksRef.current.onSnapshotMetadata(metadata); }, (err) => callbacksRef.current.onFirestoreError(err.message))
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
      productPayments: Object.fromEntries(activeProducts.map((product) => [
        product.id,
        nextEntry?.products.find((item) => item.productId === product.id)?.paymentReceived ?? 0
      ])),
      carryForwardBalance: nextEntry?.carryForwardBalance ?? previousEntry?.dueBalance ?? previousMonthDueBalance ?? selectedAccount?.openingBalance ?? 0,
      notes: nextEntry?.notes ?? ""
    });
  }, [activeProducts, previousEntry?.dueBalance, previousMonthDueBalance, selectedAccount?.openingBalance, selectedAccountId, selectedDayRecord]);

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
    const nextDay = { ...selectedDayRecord, status: "closed" as const, closedAt: Date.now(), closedBy: user.uid };
    setDays((current) => [...current.filter((day) => day.dayNo !== selectedDay), nextDay].sort((a, b) => a.dayNo - b.dayNo));
    onQueueWrite(closeStockDay(workingMonth, nextDay, days, user, role), "Could not queue stock day close.");
    onStatus(`Closed stock day ${selectedDay}.`);
  }

  async function reopenSelectedDay() {
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    const day = selectedDayRecord ?? buildStockDayRecord({
      month: workingMonth,
      dayNo: selectedDay,
      date: dayDate(monthId, selectedDay),
      entries: [],
      createdBy: user.uid
    });
    onQueueWrite(reopenStockDayFor15Minutes(workingMonth, day, days, user, role), "Could not queue stock day reopen.");
    onStatus(`Reopened stock day ${selectedDay} for 15 minutes.`);
  }

  async function closeAllStock() {
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    onQueueWrite(setStockMonthStatus(workingMonth, "closed", user, role), "Could not close all stock ledger sections.");
    onStatus("Closed all Stock Ledger sections for this month.");
  }

  async function reopenAllStock() {
    const workingMonth = month ?? (await ensureStockMonth(monthId, user, role));
    onQueueWrite(setStockMonthStatus(workingMonth, "open", user, role), "Could not reopen all stock ledger sections.");
    onStatus("Reopened all Stock Ledger sections for this month.");
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
    ["records", "Previous Records", FileSpreadsheet],
    ["balances", "Current Inventory", FileSpreadsheet],
    ["jazzPayable", "Jazz Payable Ledger", ArrowDownRight],
    ["dues", "Customer Dues Report", FileSpreadsheet],
    ["products", "Product Summary", FileSpreadsheet],
    ["accounts", "Account Summary", FileSpreadsheet],
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
            <p>{monthLabel(monthId)} · {dayDate(monthId, selectedDay)} · {month?.status ?? "open"}</p>
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
            disabled={isLiveDay(monthId, selectedDay, now) || monthBootstrapPending}
            onClick={() => void reopenSelectedDay()}
          >
            Reopen Selected Day
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!canMonthControls || month?.status !== "closed" || monthBootstrapPending}
            onClick={() => void reopenAllStock()}
          >
            Reopen All
          </button>
          <button
            className="btn-secondary w-full sm:w-auto"
            disabled={!canMonthControls || month?.status === "closed" || monthBootstrapPending}
            onClick={() => void closeAllStock()}
          >
            Close All
          </button>
        </div>
      </section>

      {activeSectionVisible && section === "daily" && (
        <>
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>Daily Stock Entry</h2>
                <p>{monthLabel(monthId)} · {dayDate(monthId, selectedDay)} · {month?.status ?? "open"}</p>
              </div>
              <CalendarDays />
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <span className="btn-chip">Auto-save off</span>
              <button className="btn-secondary" disabled={!selectedDayRecord || selectedDayRecord.status === "closed" || monthBootstrapPending} onClick={() => void closeSelectedDay()}>Close Day</button>
              <button className="btn-primary" disabled={!canEdit || loading || monthBootstrapPending} onClick={() => void saveEntry()}><Save />Save Now</button>
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
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th rowSpan={2}>Account</th>
                      {activeProducts.map((product) => (
                        <th key={product.id} colSpan={productPaymentTrackingEnabled(product) ? 4 : 2} className="text-center">
                          {product.name}
                          <br />
                          <span className="text-[10px] text-slate-500">@ {formatMoney(product.rate)}</span>
                        </th>
                      ))}
                      <th rowSpan={2}>Total Qty</th>
                      <th rowSpan={2}>Total Amount</th>
                      <th rowSpan={2}>Payment</th>
                      <th rowSpan={2}>Carry Forward</th>
                      <th rowSpan={2}>Due</th>
                    </tr>
                    <tr>
                      {activeProducts.flatMap((product) => {
                        const headers = ["Qty", "Amount"];
                        if (productPaymentTrackingEnabled(product)) headers.push("Payment", "Due");
                        return headers.map((label) => (
                          <th key={`${product.id}-${label}`} className="text-[11px] font-medium text-slate-400">
                            {label}
                          </th>
                        ));
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{selectedAccount.name}</td>
                      {activeProducts.flatMap((product) => {
                        const snapshot = previewEntry.products.find((item) => item.productId === product.id);
                        const cells = [
                          <td key={`${product.id}-qty`}>
                            <NumberInput
                              value={draft.productQuantities[product.id] ?? 0}
                              disabled={!canEdit || monthBootstrapPending}
                              onChange={(value) => setDraft((current) => ({ ...current, productQuantities: { ...current.productQuantities, [product.id]: value } }))}
                            />
                          </td>,
                          <td key={`${product.id}-amount`} className="text-slate-300">
                            {formatMoney(snapshot?.amount ?? 0)}
                          </td>
                        ];
                        if (productPaymentTrackingEnabled(product)) {
                          cells.push(
                            <td key={`${product.id}-payment`}>
                              <NumberInput
                                value={draft.productPayments[product.id] ?? 0}
                                disabled={!canEdit || monthBootstrapPending}
                                onChange={(value) => setDraft((current) => ({ ...current, productPayments: { ...current.productPayments, [product.id]: value } }))}
                              />
                            </td>,
                            <td key={`${product.id}-due`} className="text-slate-300">
                              {formatMoney(snapshot?.dueBalance ?? 0)}
                            </td>
                          );
                        }
                        return cells;
                      })}
                      <td>{formatMoney(previewEntry.totalQty)}</td>
                      <td>{formatMoney(previewEntry.totalAmount)}</td>
                      <td>{formatMoney(previewEntry.totalPaymentReceived)}</td>
                      <td>
                        <NumberInput
                          value={draft.carryForwardBalance ?? 0}
                          disabled={!canEdit || Boolean(previousEntry) || monthBootstrapPending}
                          onChange={(value) => setDraft((current) => ({ ...current, carryForwardBalance: value }))}
                        />
                      </td>
                      <td>{formatMoney(previewEntry.dueBalance)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <label className="mt-4">
                Notes
                <input value={draft.notes ?? ""} disabled={!canEdit || monthBootstrapPending} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} />
              </label>
              {!isLiveDay(monthId, selectedDay, now) && (
                <p className="warning mt-4">
                  ⚠️ Warning: You are editing a past date. Saving changes here will not automatically update later days' carry-forward balances. Please verify subsequent days' balances if you change today's due balance.
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
        </>
      )}

      {activeSectionVisible && section === "dashboard" && (
        <section className="panel">
          <div className="panel-title"><div><h2>Stock Dashboard</h2><p>Daily stock issuance, payments, and due balances.</p></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Date</th><th>Accounts</th><th>Qty Issued</th><th>Issued Value</th><th>Payment Received</th><th>Total Outstanding Dues</th><th>Status</th></tr></thead>
              <tbody>{metrics.dayRows.map((row) => <tr key={row.dayNo}><td>{row.dayNo}</td><td>{row.date}</td><td>{row.accountCount}</td><td>{formatMoney(row.totalQty)}</td><td>{formatMoney(row.totalAmount)}</td><td>{formatMoney(row.totalPaymentReceived)}</td><td>{formatMoney(row.totalDueBalance)}</td><td>{row.status}</td></tr>)}</tbody>
            </table>
          </div>
        </section>
      )}

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
                  <p className="warning text-xs">ℹ️ In Cash mode, the paid amount is automatically set to the full total amount.</p>
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

      {activeSectionVisible && section === "records" && (
        <section className="panel">
          <div className="panel-title"><div><h2>Previous Stock Records</h2><p>Account-wise saved entries for the selected month.</p></div></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Day</th><th>Account</th><th>Qty</th><th>Amount</th><th>Payment</th><th>Carry</th><th>Due</th><th>Notes</th></tr></thead>
              <tbody>{days.flatMap((day) => day.entries.map((entry) => <tr key={`${day.dayNo}-${entry.id}`}><td>{day.dayNo}</td><td>{entry.accountName}</td><td>{formatMoney(entry.totalQty)}</td><td>{formatMoney(entry.totalAmount)}</td><td>{formatMoney(entry.totalPaymentReceived)}</td><td>{formatMoney(entry.carryForwardBalance)}</td><td>{formatMoney(entry.dueBalance)}</td><td>{entry.notes ?? ""}</td></tr>))}</tbody>
            </table>
          </div>
        </section>
      )}

      {activeSectionVisible && section === "balances" && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>Current Stock Balance</h2>
              <p>Inventory level derived from opening stock, received shipments, and allotments.</p>
            </div>
            <FileSpreadsheet className="text-emerald-500" />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Rate</th>
                  <th>Opening Stock</th>
                  <th>Total Stock In (Jazz)</th>
                  <th>Total Stock Out (Allotments)</th>
                  <th>Current Balance</th>
                  <th>Balance Value</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {currentStockBalances.map((row) => {
                  const isLow = row.currentStock <= 5;
                  const rate = productRateById[row.productId] ?? 0;
                  const balanceValue = roundMoney(row.currentStock * rate);
                  return (
                    <tr key={row.productId}>
                      <td className="font-semibold text-slate-200">{row.productName}</td>
                      <td className="font-mono">{formatMoney(rate)}</td>
                      <td className="font-mono">{formatMoney(row.openingStock)}</td>
                      <td className="font-mono text-emerald-400">+{formatMoney(row.totalStockIn)}</td>
                      <td className="font-mono text-rose-400">-{formatMoney(row.totalStockOut)}</td>
                      <td className={`font-mono font-bold ${row.currentStock < 0 ? "text-rose-500" : isLow ? "text-amber-400" : "text-slate-100"}`}>
                        {formatMoney(row.currentStock)}
                      </td>
                      <td className="font-mono font-semibold text-slate-100">{formatMoney(balanceValue)}</td>
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
                {currentStockBalances.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-slate-400 italic">No products configured.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeSectionVisible && section === "jazzPayable" && (
        <section className="panel">
          <div className="panel-title">
            <div>
              <h2>Jazz Company Payable Ledger</h2>
              <p>Chronological transaction history of received stock and payments made to Jazz Company.</p>
            </div>
            <ArrowDownRight className="text-rose-500" />
          </div>
          
          <div className="p-4 rounded-lg bg-slate-900/60 border border-slate-800 grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div>
              <span className="text-slate-400 text-xs uppercase font-semibold">Opening Payable Balance</span>
              <p className="text-xl font-bold text-slate-100">{formatMoney(openingBalances.jazzOpeningPayable)} Rs.</p>
            </div>
            <div>
              <span className="text-slate-400 text-xs uppercase font-semibold">Total Stock In Value</span>
              <p className="text-xl font-bold text-emerald-400">+{formatMoney(allStockInRecords.reduce((sum, r) => sum + r.totalAmount, 0))} Rs.</p>
            </div>
            <div>
              <span className="text-slate-400 text-xs uppercase font-semibold">Current Outstanding Payable</span>
              <p className="text-xl font-bold text-rose-400">
                {formatMoney(
                  roundMoney(
                    openingBalances.jazzOpeningPayable + 
                    allStockInRecords.reduce((sum, r) => sum + r.totalAmount - r.paidAmount, 0)
                  )
                )} Rs.
              </p>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Stock In Mode</th>
                  <th>Total Received Qty</th>
                  <th>Total Stock Amount</th>
                  <th>Paid Amount</th>
                  <th>Payable Change</th>
                  <th>Running Jazz Payable</th>
                  <th>Reference / Notes</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="text-slate-400 italic">—</td>
                  <td className="font-semibold text-slate-400 uppercase">Opening Balance</td>
                  <td className="text-slate-400 font-mono">—</td>
                  <td className="text-slate-400 font-mono">—</td>
                  <td className="text-slate-400 font-mono">—</td>
                  <td className="text-slate-400 font-mono">—</td>
                  <td className="font-bold text-slate-200 font-mono">{formatMoney(openingBalances.jazzOpeningPayable)}</td>
                  <td className="text-slate-400 italic text-xs">Initial ledger setup</td>
                </tr>
                {jazzPayableLedger.map((row) => (
                  <tr key={row.id}>
                    <td>{row.date}</td>
                    <td>
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${row.stockInMode === "cash" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border border-rose-500/20"}`}>
                        {row.stockInMode}
                      </span>
                    </td>
                    <td>{row.totalQty}</td>
                    <td className="font-mono text-slate-200">{formatMoney(row.totalAmount)}</td>
                    <td className="font-mono text-blue-400">-{formatMoney(row.paidAmount)}</td>
                    <td className={`font-mono font-semibold ${row.changePayable > 0 ? "text-rose-400" : "text-slate-400"}`}>
                      {row.changePayable > 0 ? "+" : ""}{formatMoney(row.changePayable)}
                    </td>
                    <td className="font-mono font-bold text-rose-400">{formatMoney(row.runningPayable)}</td>
                    <td className="text-slate-400 italic text-xs">{row.notes ?? "—"}</td>
                  </tr>
                ))}
                {jazzPayableLedger.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-slate-400 italic text-center py-4">No Jazz stock-in transactions entered for this month.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {activeSectionVisible && section === "dues" && <SummaryTable title="Customer Dues Report" headers={["Account", "Type", "Due Balance"]} rows={metrics.accountTotals.filter((row) => row.dueBalance !== 0).map((row) => [row.accountName, row.accountType, formatMoney(row.dueBalance)])} />}
      {activeSectionVisible && section === "products" && <SummaryTable title="Product Summary" headers={["Product", "Quantity", "Amount"]} rows={metrics.productTotals.map((row) => [row.productName, formatMoney(row.quantity), formatMoney(row.amount)])} />}
      {activeSectionVisible && section === "accounts" && <SummaryTable title="Account Summary" headers={["Account", "Type", "Qty", "Amount", "Payment", "Due", "Days"]} rows={metrics.accountTotals.map((row) => [row.accountName, row.accountType, formatMoney(row.totalQty), formatMoney(row.totalAmount), formatMoney(row.totalPaymentReceived), formatMoney(row.dueBalance), row.activeDays])} />}

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
