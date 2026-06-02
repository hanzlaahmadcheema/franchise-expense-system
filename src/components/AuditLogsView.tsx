import { useEffect, useMemo, useState } from "react";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { LoaderCircle } from "lucide-react";
import { AUDIT_LOG_PAGE_SIZE, queryAuditLogs } from "../lib/auditLogService";
import { listUsers } from "../lib/firestoreService";
import {
  AUDIT_LOG_ACTIONS,
  type AuditLogFilters,
  type AuditLogModule,
  type MonthRecord,
  type SystemAuditLog,
  type UserProfile
} from "../types/ledger";

type Props = {
  months: MonthRecord[];
  onActivityChange?: (active: boolean) => void;
};

function formatTimestamp(value: number) {
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function startOfDayMs(dateValue: string) {
  if (!dateValue) return undefined;
  const date = new Date(`${dateValue}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function endOfDayMs(dateValue: string) {
  if (!dateValue) return undefined;
  const date = new Date(`${dateValue}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

const MODULE_OPTIONS: Array<{ value: "" | AuditLogModule; label: string }> = [
  { value: "", label: "All modules" },
  { value: "expense", label: "Expense" },
  { value: "jazzLoad", label: "Jazz Load" },
  { value: "stock", label: "Stock Ledger" },
  { value: "settings", label: "Settings" },
  { value: "auth", label: "Auth" },
  { value: "system", label: "System" }
];

export function AuditLogsView({ months, onActivityChange }: Props) {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [logs, setLogs] = useState<SystemAuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [module, setModule] = useState<"" | AuditLogModule>("");
  const [action, setAction] = useState("");
  const [actorUid, setActorUid] = useState("");
  const [monthId, setMonthId] = useState("");
  const [search, setSearch] = useState("");

  const filters = useMemo<AuditLogFilters>(
    () => ({
      fromMs: startOfDayMs(fromDate),
      toMs: endOfDayMs(toDate),
      module: module || undefined,
      action: action || undefined,
      actorUid: actorUid || undefined,
      monthId: monthId || undefined,
      search: search.trim() || undefined
    }),
    [action, actorUid, fromDate, module, monthId, search, toDate]
  );

  useEffect(() => {
    onActivityChange?.(loading || loadingMore);
    return () => onActivityChange?.(false);
  }, [loading, loadingMore, onActivityChange]);

  const actionOptions = useMemo(() => {
    if (!module) {
      return Object.values(AUDIT_LOG_ACTIONS).flat();
    }
    return [...AUDIT_LOG_ACTIONS[module]];
  }, [module]);

  useEffect(() => {
    listUsers()
      .then(setUsers)
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load users."));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadInitial() {
      setLoading(true);
      setError(null);
      try {
        const result = await queryAuditLogs(filters);
        if (cancelled) return;
        setLogs(result.logs);
        setLastDoc(result.lastDoc);
        setHasMore(result.logs.length >= AUDIT_LOG_PAGE_SIZE && result.lastDoc != null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load audit logs.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadInitial();
    return () => {
      cancelled = true;
    };
  }, [filters]);

  async function loadMore() {
    if (!lastDoc || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await queryAuditLogs(filters, lastDoc);
      setLogs((current) => [...current, ...result.logs]);
      setLastDoc(result.lastDoc);
      setHasMore(result.logs.length >= AUDIT_LOG_PAGE_SIZE && result.lastDoc != null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load more audit logs.");
    } finally {
      setLoadingMore(false);
    }
  }

  function exportCsv() {
    const header = ["Time", "Actor", "Role", "Module", "Action", "Summary", "Month", "Day"];
    const rows = logs.map((log) => [
      formatTimestamp(log.createdAt),
      log.actorEmail ?? log.actorUid,
      log.actorRole,
      log.module,
      log.action,
      log.summary.replace(/"/g, '""'),
      log.monthId ?? "",
      log.dayNo != null ? String(log.dayNo) : ""
    ]);
    const csv = [header, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="panel">
      <div className="panel-title">
        <div>
          <h2>Audit Logs</h2>
          <p>Owner-only activity trail across expense, Jazz Load, Stock Ledger, settings, and user access changes.</p>
        </div>
        <button type="button" className="btn-secondary" disabled={logs.length === 0} onClick={exportCsv}>
          Export CSV
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <label className="field">
          <span>From</span>
          <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} />
        </label>
        <label className="field">
          <span>To</span>
          <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} />
        </label>
        <label className="field">
          <span>Module</span>
          <select value={module} onChange={(event) => { setModule(event.target.value as "" | AuditLogModule); setAction(""); }}>
            {MODULE_OPTIONS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Action</span>
          <select value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="">All actions</option>
            {actionOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Actor</span>
          <select value={actorUid} onChange={(event) => setActorUid(event.target.value)}>
            <option value="">All users</option>
            {users.map((profile) => (
              <option key={profile.uid} value={profile.uid}>
                {profile.email || profile.uid}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Month</span>
          <select value={monthId} onChange={(event) => setMonthId(event.target.value)}>
            <option value="">All months</option>
            {months.map((month) => (
              <option key={month.id} value={month.id}>
                {month.id}
              </option>
            ))}
          </select>
        </label>
        <label className="field md:col-span-2 xl:col-span-3">
          <span>Search summary</span>
          <input
            type="search"
            placeholder="Filter loaded rows by summary, email, action…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>

      {error && <p className="warning mt-4">{error}</p>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-slate-800">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-900/80 text-slate-300">
            <tr>
              <th className="px-3 py-2">Time</th>
              <th className="px-3 py-2">Actor</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Module</th>
              <th className="px-3 py-2">Action</th>
              <th className="px-3 py-2">Summary</th>
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2">Day</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  <span className="inline-flex items-center gap-2">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    Loading audit logs…
                  </span>
                </td>
              </tr>
            )}
            {!loading && logs.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-slate-400">
                  No audit entries match the current filters.
                </td>
              </tr>
            )}
            {!loading &&
              logs.map((log) => (
                <tr key={log.id} className="border-t border-slate-800/80">
                  <td className="px-3 py-2 whitespace-nowrap">{formatTimestamp(log.createdAt)}</td>
                  <td className="px-3 py-2">{log.actorEmail ?? log.actorUid}</td>
                  <td className="px-3 py-2">{log.actorRole}</td>
                  <td className="px-3 py-2">{log.module}</td>
                  <td className="px-3 py-2">{log.action}</td>
                  <td className="px-3 py-2 max-w-xl">{log.summary}</td>
                  <td className="px-3 py-2">{log.monthId ?? "—"}</td>
                  <td className="px-3 py-2">{log.dayNo ?? "—"}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button type="button" className="btn-secondary" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                Loading…
              </span>
            ) : (
              "Load more"
            )}
          </button>
        </div>
      )}
    </section>
  );
}
