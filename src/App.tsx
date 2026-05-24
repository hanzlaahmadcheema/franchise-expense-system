import { useEffect, useMemo, useRef, useState } from "react";
import { onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import {
  CircleCheck,
  Cloud,
  FileDown,
  FileSpreadsheet,
  History,
  LayoutDashboard,
  LoaderCircle,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Shield,
  Sun,
  Tags,
  Upload,
  Users
} from "lucide-react";
import { DailyEntryForm } from "./components/DailyEntryForm";
import { HomeDashboard } from "./components/HomeDashboard";
import type {
  CatalogItem,
  DailyLedgerInput,
  MonthComputed,
  MonthRecord,
  UserProfile,
  UserRole,
  WorkbookImportPreview
} from "./types/ledger";
import { computeMonth } from "./lib/formulaEngine";
import {
  exportBackupPackage,
  exportMonthToExcel,
  printMonthReport,
  readBackupPackage
} from "./lib/exporters";
import { parseWorkbookFile } from "./lib/workbookImport";
import { auth, isFirebaseConfigured } from "./lib/firebase";
import {
  commitWorkbookImport,
  ensureDefaultCatalogs,
  fetchMonthDays,
  getUserRole,
  lockDayAndRecalculate,
  listCatalogItems,
  listMonths,
  listUsers,
  resolveOpeningBalance,
  roleCan,
  saveDayAndRecalculate,
  saveMonthRecord,
  setMonthStatus,
  updateUserProfile,
  upsertCatalogItem
} from "./lib/firestoreService";

type View = "dashboard" | "records" | "expense" | "users" | "import" | "backup";
type ExpenseSection = "daily-entry" | "expense-dashboard" | "expense-categories" | "credit-parties" | "commission-categories";

type BackupPackage = {
  exportedAt: number;
  months: Array<MonthRecord & { days: DailyLedgerInput[] }>;
};

function emptyDay(dayNo: number): DailyLedgerInput {
  return {
    dayNo,
    label: dayNo === 32 ? "FINAL" : `Day ${dayNo}`,
    expenses: [],
    commissions: [],
    credits: [],
    ownerBalances: []
  };
}

type SaveDayOptions = {
  silent?: boolean;
};

function createMonth(id: string, openingBalance: number): MonthRecord {
  const timestamp = Date.now();
  return {
    id,
    label: id,
    openingBalance,
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

function userDisplayName(user: { uid: string; email?: string | null; displayName?: string | null } | null) {
  if (!user) return "No user";
  if (user.displayName) return user.displayName;
  if (user.email) return user.email.split("@")[0].replace(/[._-]+/g, " ");
  return "Anonymous User";
}

function userSimpleId(user: { uid: string } | null) {
  if (!user) return "0000";
  const total = Array.from(user.uid).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return String(total % 10000).padStart(4, "0");
}

function CatalogManager({
  title,
  items,
  canEdit,
  onSave
}: {
  title: string;
  items: CatalogItem[];
  canEdit: boolean;
  onSave: (item: CatalogItem) => Promise<void>;
}) {
  const [name, setName] = useState("");
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>{title}</h2>
          <p>Create IDs once, then use dropdowns during daily entry.</p>
        </div>
      </div>
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
              await onSave({ id: slug(clean), name: clean, active: true, sortOrder: items.length });
              setName("");
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
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th>Order</th>
              {canEdit && <th>Action</th>}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.name}</td>
                <td>{item.active ? "Active" : "Inactive"}</td>
                <td>{item.sortOrder}</td>
                {canEdit && (
                  <td>
                    <button className="btn-secondary" onClick={() => onSave({ ...item, active: !item.active })}>
                      {item.active ? "Disable" : "Enable"}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function UserManager({
  users,
  currentUid,
  canEdit,
  onUpdate
}: {
  users: UserProfile[];
  currentUid?: string;
  canEdit: boolean;
  onUpdate: (uid: string, updates: Pick<UserProfile, "role" | "active">) => Promise<void>;
}) {
  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>Users</h2>
          <p>Owner assigns owner/admin/viewer access after sign-in.</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>User</th>
              <th>Email</th>
              <th>Role</th>
              <th>Active</th>
            </tr>
          </thead>
          <tbody>
            {users.map((profile) => (
              <tr key={profile.uid}>
                <td>{profile.uid === currentUid ? `${userDisplayName(profile)} · ID ${userSimpleId(profile)} (you)` : `${userDisplayName(profile)} · ID ${userSimpleId(profile)}`}</td>
                <td>{profile.email || "Anonymous"}</td>
                <td>
                  <select
                    value={profile.role}
                    disabled={!canEdit || profile.uid === currentUid}
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
                    disabled={!canEdit || profile.uid === currentUid}
                    onClick={() => onUpdate(profile.uid, { role: profile.role, active: !profile.active })}
                  >
                    {profile.active ? "Active" : "Inactive"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function currency(value: number) {
  return value.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function RecordsView({
  monthId,
  selectedDay,
  days,
  computed,
  loading,
  onDaySelect
}: {
  monthId: string;
  selectedDay: number;
  days: DailyLedgerInput[];
  computed: MonthComputed | null;
  loading: boolean;
  onDaySelect: (dayNo: number) => void;
}) {
  const [recordMode, setRecordMode] = useState<"month" | "day">("month");
  const dayInput = days.find((day) => day.dayNo === selectedDay);
  const dayComputed = computed?.days.find((day) => day.dayNo === selectedDay);
  const monthRows = computed?.homeSummary.dayRows ?? [];
  const ownerMonthRows = computed?.days.map((day) => {
    const opening = day.ownerBalances.reduce((total, row) => total + (row.opening ?? 0), 0);
    const debt = day.ownerBalances.reduce((total, row) => total + Math.abs(Math.min(row.amount, 0)), 0);
    const credit = day.ownerBalances.reduce((total, row) => total + Math.max(row.amount, 0), 0);
    return [
      day.label ?? `Day ${day.dayNo}`,
      currency(opening),
      currency(debt),
      currency(credit),
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
          <label className={recordMode === "day" ? "" : "opacity-50"}>
            Date / Period
            <select value={selectedDay} disabled={loading || recordMode === "month"} onChange={(event) => onDaySelect(Number(event.target.value))}>
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>{dateLabelFor(monthId, day)}</option>
              ))}
              <option value={32}>FINAL</option>
            </select>
          </label>
        </div>
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
              headers={["Day", "Opening", "Debt", "Credit", "Balance"]}
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
              headers={["Party", "Opening", "Loan", "Receive", "Balance"]}
              rows={[
                ...dayComputed.creditRows.map((row) => [
                  row.partyName,
                  currency(row.opening),
                  currency(row.loan ?? row.today ?? 0),
                  currency(row.receive),
                  currency(row.balance ?? 0)
                ]),
                [
                  "Total",
                  currency(dayComputed.creditTotals.opening),
                  currency(dayComputed.creditTotals.today),
                  currency(dayComputed.creditTotals.receive),
                  currency(dayComputed.creditTotals.balance)
                ]
              ]}
            />
            <RecordTable
              title="Franchise Owner"
              headers={["Opening", "Description", "Amount", "Balance"]}
              rows={[
                ...dayComputed.ownerBalances.map((row) => [
                  currency(row.opening ?? 0),
                  row.description ?? row.label ?? "-",
                  currency(row.amount),
                  currency(row.balance ?? 0)
                ]),
                ["-", "Total", "-", currency(dayComputed.ownerBalanceTotal)]
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
      <div className="table-wrap">
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

function App() {
  const initialDate = currentDateState();
  const [view, setView] = useState<View>("dashboard");
  const [expenseSection, setExpenseSection] = useState<ExpenseSection>("daily-entry");
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [authStatus, setAuthStatus] = useState("Connecting to Firebase...");
  const [monthId, setMonthId] = useState(initialDate.monthId);
  const [openingBalance, setOpeningBalance] = useState(0);
  const [selectedDay, setSelectedDay] = useState(initialDate.dayNo);
  const [months, setMonths] = useState<MonthRecord[]>([]);
  const [days, setDays] = useState<DailyLedgerInput[]>([]);
  const [computed, setComputed] = useState<MonthComputed | null>(null);
  const [importPreview, setImportPreview] = useState<WorkbookImportPreview | null>(null);
  const [importMonthId, setImportMonthId] = useState(initialDate.monthId);
  const [importType, setImportType] = useState<WorkbookImportPreview["importType"]>("full");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState("Working...");
  const [monthStatus, setMonthStatusState] = useState<"open" | "closed">("open");
  const [expenseCategories, setExpenseCategories] = useState<CatalogItem[]>([]);
  const [commissionCategories, setCommissionCategories] = useState<CatalogItem[]>([]);
  const [creditParties, setCreditParties] = useState<CatalogItem[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("theme") === "light" ? "light" : "dark"));
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const syncedLiveDateRef = useRef(false);

  useEffect(() => {
    const firebaseAuth = auth;
    if (!firebaseAuth) return;
    return onAuthStateChanged(firebaseAuth, async (nextUser) => {
      if (!nextUser) {
        try {
          await signInAnonymously(firebaseAuth);
        } catch (err) {
          setAuthStatus(
            err instanceof Error
              ? `${err.message}. Enable Anonymous Auth in Firebase Authentication.`
              : "Enable Anonymous Auth in Firebase Authentication."
          );
        }
        return;
      }
      setUser(nextUser);
      const nextRole = await getUserRole(nextUser.uid, nextUser.email);
      setRole(nextRole);
      setAuthStatus(`Connected to Firestore · ${nextRole}`);
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshMonthList() {
    const records = await listMonths();
    setMonths(records);
    return records;
  }

  async function refreshCatalogs() {
    if (roleCan(role, "catalogs")) await ensureDefaultCatalogs();
    const [expenses, commissions, parties, profiles] = await Promise.all([
      listCatalogItems("expenseCategories"),
      listCatalogItems("commissionCategories"),
      listCatalogItems("creditParties"),
      roleCan(role, "users") ? listUsers().catch(() => []) : Promise.resolve([])
    ]);
    setExpenseCategories(expenses);
    setCommissionCategories(commissions);
    setCreditParties(parties);
    setUsers(profiles);
  }

  async function loadMonth(nextMonthId = monthId) {
    const liveDateOnLoad = currentDateState();
    setLoadingMessage(`Loading ${formatMonth(nextMonthId)} records...`);
    setLoading(true);
    setStatus("");
    try {
      const records = await refreshMonthList();
      const existing = records.find((month) => month.id === nextMonthId);
      if (!existing) {
        if (!roleCan(role, "daily")) {
          setStatus("This month does not exist yet. Owner or admin access is required to create it.");
          return;
        }
        const resolvedOpening = await resolveOpeningBalance(nextMonthId);
        const created = createMonth(nextMonthId, resolvedOpening);
        const nextComputed = await saveMonthRecord(created, []);
        setMonthId(created.id);
        if (!syncedLiveDateRef.current && created.id === liveDateOnLoad.monthId) {
          setSelectedDay(liveDateOnLoad.dayNo);
          syncedLiveDateRef.current = true;
        }
        setOpeningBalance(created.openingBalance);
        setMonthStatusState(created.status);
        setDays([]);
        setComputed(nextComputed);
        setStatus(`Created Firestore month ${created.id}.`);
        await refreshMonthList();
        return;
      }
      const loadedDays = await fetchMonthDays(existing.id);
      setMonthId(existing.id);
      if (!syncedLiveDateRef.current && existing.id === liveDateOnLoad.monthId) {
        setSelectedDay(liveDateOnLoad.dayNo);
        syncedLiveDateRef.current = true;
      }
      setOpeningBalance(existing.openingBalance);
      setMonthStatusState(existing.status);
      setDays(loadedDays);
      setComputed(computeMonth(loadedDays, existing.openingBalance, existing.id));
      setStatus("");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not load Firestore month.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (user && role) {
      void refreshCatalogs();
      void loadMonth(monthId);
    }
  }, [user, role]);

  const selectedDayInput = useMemo(
    () => days.find((day) => day.dayNo === selectedDay) ?? emptyDay(selectedDay),
    [days, selectedDay]
  );

  const previousDayInput = useMemo(
    () => days.find((day) => day.dayNo === selectedDay - 1),
    [days, selectedDay]
  );

  const selectedOpening = useMemo(() => {
    const previous = computed?.days.find((day) => day.dayNo === selectedDay - 1);
    return selectedDay === 1 ? openingBalance : previous?.returnBalance ?? openingBalance;
  }, [computed?.days, openingBalance, selectedDay]);

  async function saveDay(day: DailyLedgerInput, options: SaveDayOptions = {}) {
    if (!roleCan(role, "daily")) {
      setStatus("Your role can view this month but cannot edit daily entries.");
      return;
    }
    if (!options.silent) {
      setLoadingMessage(`Saving ${day.label ?? `Day ${day.dayNo}`}...`);
      setLoading(true);
    }
    try {
      const nextComputed = await saveDayAndRecalculate(monthId, openingBalance, day);
      const nextDays = await fetchMonthDays(monthId);
      setDays(nextDays);
      setComputed(nextComputed);
      if (!options.silent) {
        await refreshMonthList();
        setStatus(`Saved day ${day.label ?? day.dayNo} to Firestore.`);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save day.");
    } finally {
      if (!options.silent) setLoading(false);
    }
  }

  async function closeDay(day: DailyLedgerInput) {
    if (!roleCan(role, "daily")) {
      setStatus("Your role can view this month but cannot close days.");
      return;
    }
    setLoadingMessage(`Closing ${day.label ?? `Day ${day.dayNo}`}...`);
    setLoading(true);
    try {
      const nextComputed = await lockDayAndRecalculate(monthId, openingBalance, day, role);
      const nextDays = await fetchMonthDays(monthId);
      setDays(nextDays);
      setComputed(nextComputed);
      await refreshMonthList();
      setStatus(`Closed day ${day.label ?? day.dayNo}. Admin users can view it but cannot edit it.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not close day.");
    } finally {
      setLoading(false);
    }
  }

  async function handleWorkbook(file: File | null) {
    if (!file) return;
    if (!roleCan(role, "importBackup")) {
      setStatus("Workbook import is restricted to owner or admin access.");
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
      setStatus("Workbook import is restricted to owner or admin access.");
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
    if (!roleCan(role, "ownerControls")) {
      setStatus("Manual recalculation is restricted to owner or admin access.");
      return;
    }
    setLoadingMessage(`Recalculating ${formatMonth(monthId)}...`);
    setLoading(true);
    try {
      const nextComputed = await saveMonthRecord(
        months.find((month) => month.id === monthId) ?? createMonth(monthId, openingBalance),
        days
      );
      setComputed(nextComputed);
      await refreshMonthList();
      setStatus("Recalculated and saved Firestore summary.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not recalculate.");
    } finally {
      setLoading(false);
    }
  }

  async function toggleClosed() {
    if (!roleCan(role, "ownerControls")) {
      setStatus("Closing and reopening months is restricted to owner or admin access.");
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

  async function exportBackup() {
    if (!roleCan(role, "importBackup")) {
      setStatus("Backup export is restricted to owner or admin access.");
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
      exportBackupPackage(
        { exportedAt: Date.now(), months: backedUpMonths } satisfies BackupPackage,
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
      setStatus("Backup restore is restricted to owner or admin access.");
      return;
    }
    setLoadingMessage(`Importing backup ${file.name}...`);
    setLoading(true);
    try {
      const backup = (await readBackupPackage(file)) as BackupPackage;
      for (const month of backup.months ?? []) {
        const { days: backupDays, ...record } = month;
        await saveMonthRecord(record, backupDays ?? []);
      }
      await refreshMonthList();
      setStatus(`Imported ${(backup.months ?? []).length} months from backup package.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not import backup package.");
    } finally {
      setLoading(false);
    }
  }

  if (!isFirebaseConfigured) return <FirebaseMissing />;

  const isClosed = monthStatus === "closed";
  const selectedDayLocked = Boolean(selectedDayInput.lockedAt);
  const canEditDaily = roleCan(role, "daily") && !isClosed;
  const liveDate = currentDateState(now);
  const isSelectedLiveDay = monthId === liveDate.monthId && selectedDay === liveDate.dayNo;
  const canEditSelectedDay =
    canEditDaily && (role === "owner" || (role === "admin" && isSelectedLiveDay && !selectedDayLocked));
  const canCloseSelectedDay = canEditDaily && !selectedDayLocked && (role === "owner" || role === "admin");
  const canManageCatalogs = roleCan(role, "catalogs");
  const canManageUsers = roleCan(role, "users");
  const canUseOwnerControls = roleCan(role, "ownerControls");
  const canSelectDailyDate = role === "owner" || role === "admin";
  const canUseImportBackup = roleCan(role, "importBackup");
  const dateLabel = dateLabelFor(monthId, selectedDay);
  const liveClock = liveClockText(now);
  const selectedDateParts = dateParts(monthId, selectedDay);
  const accessLabel = roleLabel(role);
  const displayName = userDisplayName(user);
  const displayId = userSimpleId(user);
  const shellGrid = sidebarOpen ? "lg:grid-cols-[20rem_minmax(0,1fr)]" : "lg:grid-cols-[5rem_minmax(0,1fr)]";
  const shellTone =
    theme === "dark"
      ? "bg-[radial-gradient(circle_at_top_left,#064e3b33,transparent_32rem),linear-gradient(180deg,#020617,#0f172a)] text-slate-100"
      : "theme-light bg-[linear-gradient(180deg,#f8fafc,#e2e8f0)] text-slate-950";
  const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard; show: boolean }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, show: true },
    { id: "records", label: "Previous Records", icon: History, show: true },
    { id: "expense", label: "Expense", icon: Tags, show: true },
    { id: "users", label: "Users", icon: Users, show: canManageUsers },
    { id: "import", label: "Excel Import", icon: FileSpreadsheet, show: canUseImportBackup },
    { id: "backup", label: "Backup", icon: FileDown, show: canUseImportBackup }
  ];

  async function saveCatalog(
    catalog: "expenseCategories" | "creditParties" | "commissionCategories",
    item: CatalogItem
  ) {
    await upsertCatalogItem(catalog, item);
    await refreshCatalogs();
    setStatus(`${item.name} saved.`);
  }

  async function saveUserRole(uid: string, updates: Pick<UserProfile, "role" | "active">) {
    await updateUserProfile(uid, updates);
    setUsers(await listUsers());
    setStatus("User access updated.");
  }

  return (
    <main className={`min-h-screen ${shellTone}`}>
      {loading && <LoadingPopup message={loadingMessage} />}
      <div className={`grid min-h-screen ${shellGrid}`}>
        <aside className="border-b border-slate-800 bg-slate-950/95 p-4 text-slate-100 lg:border-b-0 lg:border-r">
          <div className={`mb-6 flex gap-3 ${sidebarOpen ? "items-center justify-between" : "flex-col items-center"}`}>
            {sidebarOpen && (
              <div>
                <p className="text-xs font-semibold uppercase text-emerald-300">Name Software</p>
                <h1 className="text-xl font-semibold">Jazz Franchise - 7301</h1>
              </div>
            )}
            <button
              className="btn-ghost !h-11 !w-11 !px-0"
              onClick={() => setSidebarOpen((open) => !open)}
              title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
            </button>
            <button className={`${sidebarOpen ? "btn-ghost !h-9 !px-3" : "btn-ghost !h-11 !w-11 !px-0"}`} onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
            </button>
          </div>
          <nav className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {navItems.filter((item) => item.show).map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={`${view === item.id ? "btn-tab btn-tab-active" : "btn-tab"} !h-12 ${sidebarOpen ? "justify-start" : "!w-12 !px-0 justify-center"}`}
                  onClick={() => setView(item.id)}
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
              <div className="mt-6 rounded-xl border border-emerald-500/30 bg-slate-900 p-4">
                <p className="text-xs font-semibold uppercase text-emerald-300">Current Status</p>
                <p className="mt-2 text-sm font-semibold text-white">{liveClock}</p>
                <div className="mt-4 grid gap-2 text-sm text-slate-300">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Access</span>
                    <span className="font-medium text-slate-100">{accessLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-slate-500">Month Status</span>
                    <span className="font-medium capitalize text-slate-100">{monthStatus}</span>
                  </div>
                </div>
              </div>
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-semibold uppercase text-slate-500">Month Selection</p>
                <label className="mt-3">
                  Active Month
                  <input type="month" value={monthId} disabled={!canUseOwnerControls} onChange={(event) => setMonthId(event.target.value)} />
                </label>
                <label className="mt-3">
                  Opening Balance
                  <input type="text" value={openingBalance.toLocaleString()} disabled readOnly />
                </label>
                <div className="mt-4 grid gap-2">
                  <button className="btn-primary !h-11" disabled={loading || !user} onClick={() => loadMonth(monthId)}>
                    {loading && <LoadingIcon label="Loading month" />}
                    Load / Create
                  </button>
                  <button className="btn-secondary !h-11" disabled={loading || !user || !canUseOwnerControls} onClick={recalc}>
                    {loading ? <LoadingIcon label="Recalculating" /> : <RefreshCw />}
                    Recalculate
                  </button>
                  <button className="btn-secondary !h-11" disabled={loading || !user || !canUseOwnerControls} onClick={toggleClosed}>
                    {loading && <LoadingIcon label="Updating month status" />}
                    {isClosed ? "Reopen Month" : "Close Month"}
                  </button>
                </div>
                {months.length > 0 && (
                  <div className="mt-4 grid gap-2">
                    {months.slice(0, 8).map((month) => (
                      <button className={month.id === monthId ? "btn-chip btn-chip-active !justify-start" : "btn-chip !justify-start"} key={month.id} onClick={() => loadMonth(month.id)}>
                        {formatMonth(month.id)} · {month.status}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900 p-4">
                <p className="text-xs font-semibold uppercase text-slate-500">User</p>
                <p className="mt-2 text-sm font-semibold text-white">{displayName}</p>
                <p className="mt-1 text-sm text-slate-400">ID {displayId} · {accessLabel}</p>
                <p className="mt-4 flex items-center gap-2 text-sm text-slate-400"><Cloud /> {authStatus}</p>
                <p className="mt-3 flex items-center gap-2 text-sm text-slate-400"><Shield /> Connected</p>
              </div>
            </>
          )}
        </aside>

        <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">
          <header className="mb-5 flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 text-slate-100 shadow-xl shadow-black/20 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase text-emerald-300">{formatMonth(monthId)}</p>
              <h2 className="mt-1 flex items-center gap-2 text-2xl font-semibold">
                Operating Dashboard
                <CircleCheck className="h-6 w-6 text-emerald-400" aria-hidden="true" />
              </h2>
            </div>
          </header>

          {status && <p className="status">{status}</p>}
          {isClosed && <p className="warning">This month is closed. Reopen it before editing.</p>}
          {role === "admin" && !isSelectedLiveDay && (
            <p className="warning">Previous dates are read-only for admin edits. Admin can still recalculate and close records.</p>
          )}
          {selectedDayLocked && (
            <p className="warning">
              Day {selectedDay} is closed. Owner access can edit closed days; admin can view and manage status.
            </p>
          )}

          {view === "dashboard" && (
            <>
              <div className="mb-5 flex flex-wrap gap-2">
                <button className="btn-primary" disabled={!computed} onClick={() => computed && exportMonthToExcel(computed)}>
                  <FileSpreadsheet />
                  Export Excel
                </button>
                <button className="btn-secondary" disabled={!computed} onClick={printMonthReport}>
                  Print / PDF
                </button>
              </div>
              <HomeDashboard month={computed} />
            </>
          )}

          {view === "records" && (
            <RecordsView
              monthId={monthId}
              selectedDay={selectedDay}
              days={days}
              computed={computed}
              loading={loading}
              onDaySelect={setSelectedDay}
            />
          )}

          {view === "expense" && (
            <section>
              <nav className="mb-5 flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/80 p-2 text-slate-100 shadow-xl shadow-black/20">
                {[
                  ["daily-entry", "Daily Entry"],
                  ["expense-dashboard", "Dashboard"],
                  ["expense-categories", "Expense Categories"],
                  ["credit-parties", "Credit Parties"],
                  ["commission-categories", "Commission Categories"]
                ].map(([id, label]) => (
                  <button
                    className={expenseSection === id ? "btn-tab btn-tab-active" : "btn-tab"}
                    key={id}
                    onClick={() => setExpenseSection(id as ExpenseSection)}
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {expenseSection === "daily-entry" && (
                <>
                  <section className="mb-4 rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-slate-100 shadow-xl shadow-black/20">
                    <label>
                      Day / Period · {formatMonth(monthId)}
                      <select value={selectedDay} disabled={!canSelectDailyDate} onChange={(event) => setSelectedDay(Number(event.target.value))}>
                        {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                          <option key={day} value={day}>{dateLabelFor(monthId, day)}</option>
                        ))}
                        <option value={32}>FINAL</option>
                      </select>
                    </label>
                  </section>
                  <DailyEntryForm
                    key={`${monthId}-${selectedDay}`}
                    dayNo={selectedDay}
                    entryYear={selectedDateParts.entryYear}
                    entryMonth={selectedDateParts.entryMonth}
                    entryDay={selectedDateParts.entryDay}
                    openingBalance={selectedOpening}
                    dateLabel={dateLabel}
                    expenseCategories={expenseCategories}
                    commissionCategories={commissionCategories}
                    creditParties={creditParties}
                    initial={selectedDayInput}
                    previousDay={previousDayInput}
                    disabled={!canEditSelectedDay || !user}
                    locked={selectedDayLocked}
                    canClose={canCloseSelectedDay && !loading && Boolean(user)}
                    onSave={saveDay}
                    onCloseDay={closeDay}
                  />
                </>
              )}
              {expenseSection === "expense-dashboard" && <HomeDashboard month={computed} />}
              {expenseSection === "expense-categories" && (
                <CatalogManager title="Expense Categories" items={expenseCategories} canEdit={canManageCatalogs} onSave={(item) => saveCatalog("expenseCategories", item)} />
              )}
              {expenseSection === "credit-parties" && (
                <CatalogManager title="Credit Parties" items={creditParties} canEdit={canManageCatalogs} onSave={(item) => saveCatalog("creditParties", item)} />
              )}
              {expenseSection === "commission-categories" && (
                <CatalogManager title="Commission Categories" items={commissionCategories} canEdit={canManageCatalogs} onSave={(item) => saveCatalog("commissionCategories", item)} />
              )}
            </section>
          )}

          {view === "users" && (
            <UserManager users={users} currentUid={user?.uid} canEdit={canManageUsers} onUpdate={saveUserRole} />
          )}

          {view === "backup" && (
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h2>Backup</h2>
                  <p>Owner/admin backup export and restore.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={loading || !user || !canUseImportBackup} onClick={exportBackup}>
                  {loading ? <LoadingIcon label="Exporting backup" /> : <FileDown />}
                  Export Backup
                </button>
                <label className={`file-button ${loading || !canUseImportBackup ? "pointer-events-none opacity-50" : ""}`}>
                  {loading ? <LoadingIcon label="Importing backup" /> : <Upload />}
                  Import Backup
                  <input disabled={loading || !canUseImportBackup} type="file" accept=".json" onChange={(event) => importBackup(event.target.files?.[0] ?? null)} />
                </label>
              </div>
            </section>
          )}

          {view === "import" && (
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
              <button className="btn-primary" disabled={loading || !user} onClick={commitImport}>
                {loading && <LoadingIcon label="Saving import" />}
                Save {importPreview.importType === "expense" ? "Expense Only" : "Full Workbook"} Import to Firestore
              </button>
            </>
          )}
            </section>
          )}

        </div>
      </div>
    </main>
  );
}

export default App;
