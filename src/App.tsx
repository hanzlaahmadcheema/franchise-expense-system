import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInAnonymously, type User } from "firebase/auth";
import { Cloud, Database, FileDown, FileSpreadsheet, RefreshCw, Upload } from "lucide-react";
import { DailyEntryForm } from "./components/DailyEntryForm";
import { HomeDashboard } from "./components/HomeDashboard";
import type { DailyLedgerInput, MonthComputed, MonthRecord, WorkbookImportPreview } from "./types/ledger";
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
  fetchMonthDays,
  getUserRole,
  listMonths,
  saveDayAndRecalculate,
  saveMonthRecord,
  setMonthStatus
} from "./lib/firestoreService";

type View = "dashboard" | "entry" | "import" | "blueprint";

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
      await getUserRole(nextUser.uid, nextUser.email);
      setAuthStatus("Connected to Firestore");
    });
  }, []);

  async function refreshMonthList() {
    const records = await listMonths();
    setMonths(records);
    return records;
  }

  async function loadMonth(nextMonthId = monthId) {
    setLoading(true);
    setStatus("");
    try {
      const records = await refreshMonthList();
      const existing = records.find((month) => month.id === nextMonthId);
      if (!existing) {
        const created = createMonth(nextMonthId, openingBalance);
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
    if (user) void loadMonth(monthId);
  }, [user]);

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

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,#064e3b33,transparent_32rem),linear-gradient(180deg,#020617,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
      <header className="mb-6 flex flex-col gap-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-xl shadow-black/20 backdrop-blur md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">Franchise Finance</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">Operating Ledger</h1>
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-400">
            <Cloud className="h-4 w-4 text-emerald-300" />
            {authStatus}{user ? ` · ${user.uid.slice(0, 8)}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
          <Database className="h-5 w-5 text-blue-300" />
          <div>
            <p className="text-xs text-slate-500">Active month</p>
            <p className="font-semibold text-white">{monthId} · {monthStatus}</p>
          </div>
        </div>
      </header>

      <section className="mb-4 grid grid-cols-1 gap-3 rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20 md:grid-cols-[1fr_1fr_auto_auto_auto] md:items-end">
        <label>
          Month
          <input value={monthId} onChange={(event) => setMonthId(event.target.value)} />
        </label>
        <label>
          Opening Balance
          <input
            type="number"
            value={openingBalance}
            disabled={isClosed}
            onChange={(event) => setOpeningBalance(Number(event.target.value))}
          />
        </label>
        <button className="btn-primary" disabled={loading || !user} onClick={() => loadMonth(monthId)}>
          Load / Create
        </button>
        <button className="btn-secondary" disabled={loading || !user} onClick={recalc}>
          <RefreshCw className="h-4 w-4" />
          Recalculate
        </button>
        <button className="btn-secondary" disabled={loading || !user} onClick={toggleClosed}>
          {isClosed ? "Reopen Month" : "Close Month"}
        </button>
      </section>

      {months.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {months.slice(0, 8).map((month) => (
            <button
              className={month.id === monthId ? "btn-chip btn-chip-active" : "btn-chip"}
              key={month.id}
              onClick={() => loadMonth(month.id)}
            >
              {month.id} · {month.status}
            </button>
          ))}
        </div>
      )}

      <nav className="mb-5 flex flex-wrap gap-2">
        <button className={view === "dashboard" ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => setView("dashboard")}>
          Dashboard
        </button>
        <button className={view === "entry" ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => setView("entry")}>
          Daily Entry
        </button>
        <button className={view === "import" ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => setView("import")}>
          Excel Import
        </button>
        <button className={view === "blueprint" ? "btn-tab btn-tab-active" : "btn-tab"} onClick={() => setView("blueprint")}>
          System Blueprint
        </button>
      </nav>

      {status && <p className="status">{status}</p>}
      {isClosed && <p className="warning">This month is closed. Reopen it before editing.</p>}

      {view === "dashboard" && (
        <>
          <div className="mb-5 flex flex-wrap gap-2">
            <button className="btn-primary" disabled={!computed} onClick={() => computed && exportMonthToExcel(computed)}>
              <FileSpreadsheet className="h-4 w-4" />
              Export Excel
            </button>
            <button className="btn-secondary" disabled={!computed} onClick={printMonthReport}>
              Print / PDF
            </button>
            <button className="btn-secondary" disabled={loading || !user} onClick={exportBackup}>
              <FileDown className="h-4 w-4" />
              Export Backup
            </button>
            <label className="file-button">
              <Upload className="h-4 w-4" />
              Import Backup
              <input type="file" accept=".json" onChange={(event) => importBackup(event.target.files?.[0] ?? null)} />
            </label>
          </div>
          <HomeDashboard month={computed} />
        </>
      )}

      {view === "entry" && (
        <>
          <section className="mb-4 max-w-xs rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-xl shadow-black/20">
            <label>
              Day / Period
              <input
                type="number"
                min={1}
                max={32}
                value={selectedDay}
                onChange={(event) => setSelectedDay(Number(event.target.value))}
              />
            </label>
          </section>
          <DailyEntryForm
            key={`${monthId}-${selectedDay}`}
            dayNo={selectedDay}
            openingBalance={selectedOpening}
            initial={selectedDayInput}
            previousDay={previousDayInput}
            disabled={isClosed || loading || !user}
            onSave={saveDay}
          />
        </>
      )}

      {view === "import" && (
        <section className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 shadow-xl shadow-black/20">
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
    </main>
  );
}

export default App;
