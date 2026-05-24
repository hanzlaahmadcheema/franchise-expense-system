import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import {
  BookOpen,
  Cloud,
  Database,
  FileDown,
  FileSpreadsheet,
  LayoutDashboard,
  ListTree,
  Moon,
  RefreshCw,
  Shield,
  Sun,
  Tags,
  Upload,
  Users,
  WalletCards
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

type View = "dashboard" | "entry" | "expense-categories" | "credit-parties" | "users" | "import" | "backup" | "blueprint";

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

function formatMonth(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, 1));
  if (Number.isNaN(date.getTime())) return monthId;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

function dateLabelFor(monthId: string, dayNo: number) {
  if (dayNo === 32) return `FINAL - ${formatMonth(monthId)}`;
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, dayNo));
  if (Number.isNaN(date.getTime())) return `Day ${dayNo}`;
  return new Intl.DateTimeFormat("en", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  }).format(date);
}

function utcClockText(now: Date) {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(now);
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
                <td>{profile.uid === currentUid ? `${profile.uid.slice(0, 8)} (you)` : profile.uid.slice(0, 12)}</td>
                <td>{profile.email || "Anonymous"}</td>
                <td>
                  <select
                    value={profile.role}
                    disabled={!canEdit || profile.uid === currentUid}
                    onChange={(event) => onUpdate(profile.uid, { role: event.target.value as UserRole, active: profile.active })}
                  >
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="viewer">viewer</option>
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

function SystemBlueprint() {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl shadow-black/20">
      <div className="panel-title">
        <div>
          <h2 className="text-2xl font-semibold text-white">What This System Should Become</h2>
          <p className="mt-2 text-sm text-slate-400">A daily operating cockpit for a franchise, not just a spreadsheet replacement.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-5">
          <h3 className="font-semibold text-white">Single Entrance</h3>
          <p className="mt-2 text-sm text-slate-400">One daily entry captures expenses, commissions, cash/owner balance, credit parties, notes, and corrections.</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-5">
          <h3 className="font-semibold text-white">Automatic Ledger</h3>
          <p className="mt-2 text-sm text-slate-400">Opening, issue, total, expense, return, commission matrix, and credit balances recalculate from raw entries.</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-5">
          <h3 className="font-semibold text-white">Decision Dashboard</h3>
          <p className="mt-2 text-sm text-slate-400">The owner sees cash position, expense pressure, credit exposure, missing days, and unusual values quickly.</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-5">
          <h3 className="font-semibold text-white">Cloud With Escape Hatch</h3>
          <p className="mt-2 text-sm text-slate-400">Firestore is the working database, while backup/export packages keep the data portable.</p>
        </div>
      </div>

      <h3 className="mt-6 font-semibold text-white">Workbook Formula Understanding</h3>
      <div className="mt-3 flex flex-wrap gap-2">
        {[
          "Home rows 1-31 map to day sheets",
          "FINAL acts as adjustment period",
          "Daily F15 is issue total",
          "Daily C30 is expense total",
          "Daily I18 is return balance",
          "Credit opening carries previous balance",
          "Home C34/E34 are validation totals"
        ].map((item) => (
          <span className="rounded-full border border-slate-700 bg-slate-950 px-3 py-1 text-sm text-slate-300" key={item}>
            {item}
          </span>
        ))}
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
  const [view, setView] = useState<View>("dashboard");
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [authStatus, setAuthStatus] = useState("Connecting to Firebase...");
  const [monthId, setMonthId] = useState("2026-04");
  const [openingBalance, setOpeningBalance] = useState(0);
  const [selectedDay, setSelectedDay] = useState(1);
  const [months, setMonths] = useState<MonthRecord[]>([]);
  const [days, setDays] = useState<DailyLedgerInput[]>([]);
  const [computed, setComputed] = useState<MonthComputed | null>(null);
  const [importPreview, setImportPreview] = useState<WorkbookImportPreview | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [monthStatus, setMonthStatusState] = useState<"open" | "closed">("open");
  const [expenseCategories, setExpenseCategories] = useState<CatalogItem[]>([]);
  const [creditParties, setCreditParties] = useState<CatalogItem[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("theme") === "light" ? "light" : "dark"));
  const [now, setNow] = useState(() => new Date());

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
    const [expenses, parties, profiles] = await Promise.all([
      listCatalogItems("expenseCategories"),
      listCatalogItems("creditParties"),
      roleCan(role, "users") ? listUsers().catch(() => []) : Promise.resolve([])
    ]);
    setExpenseCategories(expenses);
    setCreditParties(parties);
    setUsers(profiles);
  }

  async function loadMonth(nextMonthId = monthId) {
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
      setOpeningBalance(existing.openingBalance);
      setMonthStatusState(existing.status);
      setDays(loadedDays);
      setComputed(computeMonth(loadedDays, existing.openingBalance, existing.id));
      setStatus(`Loaded ${existing.id} from Firestore.`);
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

  async function saveDay(day: DailyLedgerInput) {
    if (!roleCan(role, "daily")) {
      setStatus("Your role can view this month but cannot edit daily entries.");
      return;
    }
    setLoading(true);
    try {
      const nextComputed = await saveDayAndRecalculate(monthId, openingBalance, day);
      const nextDays = await fetchMonthDays(monthId);
      setDays(nextDays);
      setComputed(nextComputed);
      await refreshMonthList();
      setStatus(`Saved day ${day.label ?? day.dayNo} to Firestore.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save day.");
    } finally {
      setLoading(false);
    }
  }

  async function handleWorkbook(file: File | null) {
    if (!file) return;
    if (!roleCan(role, "ownerControls")) {
      setStatus("Workbook import is restricted to owner access.");
      return;
    }
    setLoading(true);
    setStatus("Parsing workbook...");
    try {
      const preview = await parseWorkbookFile(file, monthId);
      setImportPreview(preview);
      setStatus(`Parsed ${preview.days.length} periods from ${file.name}. Review before saving.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not parse workbook.");
    } finally {
      setLoading(false);
    }
  }

  async function commitImport() {
    if (!importPreview) return;
    if (!roleCan(role, "ownerControls")) {
      setStatus("Workbook import is restricted to owner access.");
      return;
    }
    setLoading(true);
    try {
      const nextComputed = await commitWorkbookImport(importPreview);
      setOpeningBalance(importPreview.openingBalance);
      setDays(importPreview.days);
      setComputed(nextComputed);
      setMonthStatusState("open");
      setImportPreview(null);
      setView("dashboard");
      await refreshMonthList();
      setStatus("Imported workbook into Firestore.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save import.");
    } finally {
      setLoading(false);
    }
  }

  async function recalc() {
    if (!roleCan(role, "ownerControls")) {
      setStatus("Manual recalculation is restricted to owner access.");
      return;
    }
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
      setStatus("Closing and reopening months is restricted to owner access.");
      return;
    }
    const nextStatus = monthStatus === "open" ? "closed" : "open";
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
    if (!roleCan(role, "ownerControls")) {
      setStatus("Backup export is restricted to owner access.");
      return;
    }
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
    if (!roleCan(role, "ownerControls")) {
      setStatus("Backup restore is restricted to owner access.");
      return;
    }
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
  const canEditDaily = roleCan(role, "daily") && !isClosed;
  const canManageCatalogs = roleCan(role, "catalogs");
  const canManageUsers = roleCan(role, "users");
  const canUseOwnerControls = roleCan(role, "ownerControls");
  const dateLabel = dateLabelFor(monthId, selectedDay);
  const utcClock = utcClockText(now);
  const shellTone =
    theme === "dark"
      ? "bg-[radial-gradient(circle_at_top_left,#064e3b33,transparent_32rem),linear-gradient(180deg,#020617,#0f172a)] text-slate-100"
      : "theme-light bg-[linear-gradient(180deg,#f8fafc,#e2e8f0)] text-slate-950";
  const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard; show: boolean }> = [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, show: true },
    { id: "entry", label: "Daily Entry", icon: WalletCards, show: true },
    { id: "expense-categories", label: "Expense Categories", icon: Tags, show: true },
    { id: "credit-parties", label: "Credit Parties", icon: ListTree, show: true },
    { id: "users", label: "Users", icon: Users, show: canManageUsers },
    { id: "import", label: "Excel Import", icon: FileSpreadsheet, show: canUseOwnerControls },
    { id: "backup", label: "Backup", icon: FileDown, show: canUseOwnerControls },
    { id: "blueprint", label: "System Blueprint", icon: BookOpen, show: true }
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
      <div className="grid min-h-screen lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="border-b border-slate-800 bg-slate-950/95 p-4 text-slate-100 lg:border-b-0 lg:border-r">
          <div className="mb-6 flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase text-emerald-300">Franchise Finance</p>
              <h1 className="text-xl font-semibold">Operating Ledger</h1>
            </div>
            <button className="btn-ghost !h-9 !px-3" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Toggle theme">
              {theme === "dark" ? <Sun /> : <Moon />}
            </button>
          </div>
          <nav className="flex gap-2 overflow-x-auto lg:flex-col lg:overflow-visible">
            {navItems.filter((item) => item.show).map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.id} className={view === item.id ? "btn-tab btn-tab-active justify-start" : "btn-tab justify-start"} onClick={() => setView(item.id)}>
                  <Icon />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <div className="mt-6 rounded-xl border border-slate-800 bg-slate-900 p-4">
            <p className="flex items-center gap-2 text-sm text-slate-400"><Cloud /> {authStatus}</p>
            <p className="mt-3 flex items-center gap-2 text-sm text-slate-400"><Shield /> {user ? user.uid.slice(0, 8) : "No user"}</p>
          </div>
        </aside>

        <div className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">
          <header className="mb-5 flex flex-col gap-4 rounded-xl border border-slate-800 bg-slate-900/80 p-5 text-slate-100 shadow-xl shadow-black/20 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-sm font-semibold uppercase text-emerald-300">{formatMonth(monthId)}</p>
              <h2 className="mt-1 text-2xl font-semibold">Operating Dashboard</h2>
              <p className="mt-2 text-sm text-slate-400">UTC {utcClock} · {monthStatus} · {role ?? "connecting"}</p>
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
              <Database className="h-5 w-5 text-blue-300" />
              <div>
                <p className="text-xs text-slate-500">Active month</p>
                <p className="font-semibold text-white">{monthId}</p>
              </div>
            </div>
          </header>

          <section className="mb-4 grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-slate-100 shadow-xl shadow-black/20 md:grid-cols-[1fr_1fr_auto_auto_auto] md:items-end">
            <label>
              Month
              <input value={monthId} onChange={(event) => setMonthId(event.target.value)} />
            </label>
            <label>
              Opening Balance
              <input type="text" value={openingBalance.toLocaleString()} disabled readOnly />
            </label>
            <button className="btn-primary" disabled={loading || !user} onClick={() => loadMonth(monthId)}>
              Load / Create
            </button>
            <button className="btn-secondary" disabled={loading || !user || !canUseOwnerControls} onClick={recalc}>
              <RefreshCw />
              Recalculate
            </button>
            <button className="btn-secondary" disabled={loading || !user || !canUseOwnerControls} onClick={toggleClosed}>
              {isClosed ? "Reopen Month" : "Close Month"}
            </button>
          </section>

          {months.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {months.slice(0, 8).map((month) => (
                <button className={month.id === monthId ? "btn-chip btn-chip-active" : "btn-chip"} key={month.id} onClick={() => loadMonth(month.id)}>
                  {formatMonth(month.id)} · {month.status}
                </button>
              ))}
            </div>
          )}

          {status && <p className="status">{status}</p>}
          {isClosed && <p className="warning">This month is closed. Reopen it before editing.</p>}

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

          {view === "entry" && (
            <>
              <section className="mb-4 max-w-sm rounded-xl border border-slate-800 bg-slate-900/80 p-4 text-slate-100 shadow-xl shadow-black/20">
                <label>
                  Day / Period
                  <select value={selectedDay} onChange={(event) => setSelectedDay(Number(event.target.value))}>
                    {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                      <option key={day} value={day}>Day {day}</option>
                    ))}
                    <option value={32}>FINAL</option>
                  </select>
                </label>
              </section>
              <DailyEntryForm
                key={`${monthId}-${selectedDay}`}
                dayNo={selectedDay}
                openingBalance={selectedOpening}
                dateLabel={dateLabel}
                utcClock={utcClock}
                expenseCategories={expenseCategories}
                creditParties={creditParties}
                initial={selectedDayInput}
                previousDay={previousDayInput}
                disabled={!canEditDaily || loading || !user}
                onSave={saveDay}
              />
            </>
          )}

          {view === "expense-categories" && (
            <CatalogManager title="Expense Categories" items={expenseCategories} canEdit={canManageCatalogs} onSave={(item) => saveCatalog("expenseCategories", item)} />
          )}

          {view === "credit-parties" && (
            <CatalogManager title="Credit Parties" items={creditParties} canEdit={canManageCatalogs} onSave={(item) => saveCatalog("creditParties", item)} />
          )}

          {view === "users" && (
            <UserManager users={users} currentUid={user?.uid} canEdit={canManageUsers} onUpdate={saveUserRole} />
          )}

          {view === "backup" && (
            <section className="panel">
              <div className="panel-title">
                <div>
                  <h2>Backup</h2>
                  <p>Owner-only backup export and restore.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" disabled={loading || !user || !canUseOwnerControls} onClick={exportBackup}>
                  <FileDown />
                  Export Backup
                </button>
                <label className={`file-button ${!canUseOwnerControls ? "pointer-events-none opacity-50" : ""}`}>
                  <Upload />
                  Import Backup
                  <input type="file" accept=".json" onChange={(event) => importBackup(event.target.files?.[0] ?? null)} />
                </label>
              </div>
            </section>
          )}

          {view === "import" && (
            <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 text-slate-100 shadow-xl shadow-black/20">
          <div className="panel-title">
            <div>
              <h2>Excel Import</h2>
              <p>Upload the workbook, validate Home totals, then store it in Firestore.</p>
            </div>
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(event) => handleWorkbook(event.target.files?.[0] ?? null)}
            />
          </div>
          {importPreview && (
            <>
              <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
                {[
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
              <button className="btn-primary" disabled={loading || isClosed || !user} onClick={commitImport}>
                Save Imported Month to Firestore
              </button>
            </>
          )}
            </section>
          )}

          {view === "blueprint" && <SystemBlueprint />}
        </div>
      </div>
    </main>
  );
}

export default App;
