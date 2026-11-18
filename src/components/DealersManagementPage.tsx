import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UserCheck,
  Users,
  X
} from "lucide-react";
import { Alert, StatusBadge } from "../shared/components";
import { ledgerApiClient } from "../services/api/ledgerApiClient";
import type { UserRole } from "../types/ledger";
import type { StockAccountType } from "../modules/stock/types/stock.types";

export function cleanDealerName(s: string): string {
  return s
    .replace(/^(DO|DSO|CCR)\s+/i, "")
    .replace(/\s+(CCR|DSO|DO)$/i, "")
    .trim();
}

export function getCanonicalDealerKey(name: string): string {
  const cleaned = cleanDealerName(name).toLowerCase();
  if (/rizwan/i.test(cleaned)) return "discard-rizwan";
  if (/waseem.*gujjar/i.test(cleaned)) return "discard-waseem";
  if (/ghot.*hussain/i.test(cleaned)) return "hussain";
  if (/mubash[ia]r/i.test(cleaned)) return "mubashir";
  if (/irfan.*mirza|mirza.*irfan/i.test(cleaned)) return "irfan-mirza";
  if (/naveed.*bangla|bangla.*naveed/i.test(cleaned)) return "naveed-bangla";
  if (/fix.*line|office.*line.*1|office.*line(?!\s*2)/i.test(cleaned)) return "office-line-1";
  if (/office.*line.*2|other/i.test(cleaned)) return "office-line-2";
  if (/fakhar|t[ie]t[au]s/i.test(cleaned)) return "fakhar-titus";
  if (/hussain/i.test(cleaned)) return "hussain";
  if (/free.*sim|face.*sim/i.test(cleaned)) return "free-sim";
  if (/net.*stock/i.test(cleaned)) return "net-stock";
  if (/anni|any/i.test(cleaned)) return "anni";
  if (/saram/i.test(cleaned)) return "saram";
  if (/hasan|hassan/i.test(cleaned)) {
    if (/dso/i.test(name) || cleaned === "hasan") return "dso-hasan";
    return "do-hassan";
  }
  return cleaned.replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
}

export function resolveCanonicalDealerInfo(name: string, explicitType?: StockAccountType): { name: string; type: StockAccountType; sortOrder: number } {
  const key = getCanonicalDealerKey(name);
  switch (key) {
    case "mirza":
      return { name: "Mirza", type: "DO", sortOrder: 1 };
    case "adnan":
      return { name: "Adnan", type: "DO", sortOrder: 2 };
    case "arslan":
      return { name: "Arslan", type: "DO", sortOrder: 3 };
    case "mubashir":
      return { name: "Mubashir", type: "DO", sortOrder: 4 };
    case "irfan-mirza":
      return { name: "Irfan Mirza", type: "DO", sortOrder: 5 };
    case "do-hassan":
      return { name: "Hassan", type: "DO", sortOrder: 6 };
    case "naveed":
      return { name: "Naveed", type: "DO", sortOrder: 7 };
    case "irfan":
      return { name: "Irfan", type: "DO", sortOrder: 8 };
    case "naveed-bangla":
      return { name: "Naveed Bangla", type: "DO", sortOrder: 9 };
    case "office-line-1":
      return { name: "Office Line 1", type: "OFFICE", sortOrder: 10 };
    case "office-line-2":
      return { name: "Office Line 2", type: "OFFICE", sortOrder: 11 };
    case "fakhar-titus":
      return { name: "Fakhar (Titus)", type: "CCR", sortOrder: 12 };
    case "anni":
      return { name: "Anni", type: "CCR", sortOrder: 13 };
    case "saram":
      return { name: "Saram", type: "CCR", sortOrder: 14 };
    case "hussain":
      return { name: "Hussain", type: "CCR", sortOrder: 15 };
    case "dso-hasan":
      return { name: "Hasan", type: "DSO", sortOrder: 16 };
    case "abdullah":
      return { name: "Abdullah", type: "DSO", sortOrder: 17 };
    case "free-sim":
      return { name: "Free SIM", type: "STOCK", sortOrder: 18 };
    case "net-stock":
      return { name: "Net Stock", type: "STOCK", sortOrder: 19 };
    default:
      return { name: cleanDealerName(name), type: explicitType || "DO", sortOrder: 99 };
  }
}

export interface UnifiedDealerRecord {
  id: string; // Master key (or jazzLoadDoProfile id / stockAccount id)
  name: string;
  type: StockAccountType;
  line?: string;
  jazzDoId?: string;
  stockAccountId?: string;
  active: boolean;
  sortOrder: number;
  notes?: string;
}

interface DealersManagementPageProps {
  role?: UserRole | null;
  onStatusChange?: (msg: string) => void;
}

export function DealersManagementPage({
  role = "owner",
  onStatusChange
}: DealersManagementPageProps) {
  const canManage = role === "owner" || role === "admin";

  const [loading, setLoading] = useState(true);
  const [dealers, setDealers] = useState<UnifiedDealerRecord[]>([]);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Quick Add State
  const [newName, setNewName] = useState("");
  const [newType, setNewType] = useState<StockAccountType>("DO");
  const [newLine, setNewLine] = useState("");

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<string>("ALL");

  // Inline Edit State
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState<StockAccountType>("DO");
  const [editLine, setEditLine] = useState("");

  const showStatus = (msg: string) => {
    setStatusMessage(msg);
    onStatusChange?.(msg);
  };

  // Load from both PostgreSQL Catalogs: jazz_load_do_profiles & stock_accounts
  const loadDirectory = async () => {
    setLoading(true);
    try {
      const [jazzRes, stockRes] = await Promise.all([
        ledgerApiClient.catalogs.getJazzLoadDoProfiles(true).catch(() => ({ data: [] })),
        ledgerApiClient.catalogs.getStockAccounts().catch(() => ({ data: [] }))
      ]);

      const jazzProfiles = jazzRes.data || [];
      const stockAccounts = stockRes.data || [];

      const recordsMap = new Map<string, UnifiedDealerRecord>();

      // 1. Process Jazz Load DO Profiles
      jazzProfiles.forEach((jp: any, idx: number) => {
        const key = getCanonicalDealerKey(jp.do_name);
        if (key.startsWith("discard-")) return;

        const info = resolveCanonicalDealerInfo(jp.do_name, jp.type);
        const resolvedLine = jp.do_line || undefined;

        recordsMap.set(key, {
          id: jp.id,
          name: info.name,
          type: info.type,
          line: resolvedLine,
          jazzDoId: jp.id,
          active: jp.is_active ?? true,
          sortOrder: info.sortOrder ?? jp.sort_order ?? idx + 1,
          notes: jp.do_line ? `Line: ${jp.do_line}` : undefined
        });
      });

      // 2. Process Stock Accounts
      stockAccounts.forEach((sa: any, idx: number) => {
        const key = getCanonicalDealerKey(sa.name);
        if (key.startsWith("discard-")) return;

        const info = resolveCanonicalDealerInfo(sa.name, sa.type);
        const existing = recordsMap.get(key);

        const stockLine = sa.notes?.replace(/^Line:\s*/i, "").trim() || undefined;
        const isLoadBearing = info.type === "DO" || info.type === "OFFICE" || info.type === "CCR";
        const resolvedLine = isLoadBearing ? (existing?.line || stockLine) : undefined;

        if (existing) {
          existing.stockAccountId = sa.id;
          existing.type = info.type; // Canonical type authority
          existing.name = info.name; // Canonical name authority
          if (!existing.line && resolvedLine) {
            existing.line = resolvedLine;
          }
          if (existing.sortOrder > info.sortOrder) {
            existing.sortOrder = info.sortOrder;
          }
        } else {
          recordsMap.set(key, {
            id: sa.id,
            name: info.name,
            type: info.type,
            line: resolvedLine,
            stockAccountId: sa.id,
            active: sa.is_active ?? true,
            sortOrder: info.sortOrder ?? sa.sort_order ?? recordsMap.size + idx + 1,
            notes: sa.notes ?? undefined
          });
        }
      });

      const records = Array.from(recordsMap.values());
      records.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      setDealers(records);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to load directory.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadDirectory();
  }, []);

  // Filtered & Searched List
  const filteredDealers = useMemo(() => {
    return dealers.filter((d) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        d.name.toLowerCase().includes(q) ||
        (d.line && d.line.toLowerCase().includes(q));

      const matchesType = typeFilter === "ALL" || d.type === typeFilter;
      const matchesStatus =
        statusFilter === "ALL" ||
        (statusFilter === "ACTIVE" && d.active) ||
        (statusFilter === "INACTIVE" && !d.active);

      return matchesSearch && matchesType && matchesStatus;
    });
  }, [dealers, searchQuery, typeFilter, statusFilter]);

  // Statistics
  const stats = useMemo(() => {
    const total = dealers.length;
    const active = dealers.filter((d) => d.active).length;
    const dos = dealers.filter((d) => d.type === "DO" && d.active).length;
    const ccrs = dealers.filter((d) => d.type === "CCR" && d.active).length;
    const lines = dealers.filter((d) => Boolean(d.line)).length;
    return { total, active, dos, ccrs, lines };
  }, [dealers]);

  // Handler: Register New Dealer across both modules
  const handleRegisterDealer = async () => {
    if (!canManage || !newName.trim()) return;
    const name = cleanDealerName(newName.trim());
    const type = newType;
    const isLoadBearing = type === "DO" || type === "OFFICE" || type === "CCR";
    const line = isLoadBearing ? (newLine.trim() || undefined) : undefined;
    const nextOrder = dealers.length + 1;

    try {
      let createdJazzId: string | undefined;
      let createdStockId: string | undefined;

      // Create in Jazz Load DO Profiles if load-bearing (DO / OFFICE / CCR with line)
      if (type === "DO" || type === "OFFICE" || line) {
        const jazzRes = await ledgerApiClient.catalogs.createJazzLoadDoProfile({
          do_name: name,
          do_line: line ?? null,
          sort_order: nextOrder,
          is_active: true
        });
        createdJazzId = jazzRes.data.id;
      }

      // Create in Stock Accounts
      const slugVal = `dealer-${name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-${Date.now().toString(36)}`;
      const stockRes = await ledgerApiClient.catalogs.createStockAccount({
        slug: slugVal,
        name,
        type,
        is_active: true,
        sort_order: nextOrder,
        notes: line ? `Line: ${line}` : null
      });
      createdStockId = stockRes.data.id;

      const newRecord: UnifiedDealerRecord = {
        id: createdJazzId || createdStockId || slugVal,
        name,
        type,
        line,
        jazzDoId: createdJazzId,
        stockAccountId: createdStockId,
        active: true,
        sortOrder: nextOrder,
        notes: line ? `Line: ${line}` : undefined
      };

      setDealers((prev) => [...prev, newRecord]);
      setNewName("");
      setNewLine("");
      showStatus(`Dealer "${name}" registered across all modules.`);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to register dealer.");
    }
  };

  // Handler: Inline Edit Save
  const handleSaveEdit = async (dealer: UnifiedDealerRecord) => {
    if (!canManage || !editName.trim()) return;
    const updatedName = cleanDealerName(editName.trim());
    const updatedType = editType;
    const isLoadBearing = updatedType === "DO" || updatedType === "OFFICE" || updatedType === "CCR";
    const updatedLine = isLoadBearing ? (editLine.trim() || undefined) : undefined;

    try {
      // Update Jazz Load DO Profile if exists
      if (dealer.jazzDoId) {
        await ledgerApiClient.catalogs.updateJazzLoadDoProfile(dealer.jazzDoId, {
          do_name: updatedName,
          do_line: updatedLine ?? null
        });
      } else if (updatedType === "DO" || updatedType === "OFFICE" || updatedLine) {
        // Create jazz load profile if converted to DO / Office
        const jRes = await ledgerApiClient.catalogs.createJazzLoadDoProfile({
          do_name: updatedName,
          do_line: updatedLine ?? null,
          sort_order: dealer.sortOrder,
          is_active: dealer.active
        });
        dealer.jazzDoId = jRes.data.id;
      }

      // Update Stock Account if exists
      if (dealer.stockAccountId) {
        await ledgerApiClient.catalogs.updateStockAccount(dealer.stockAccountId, {
          name: updatedName,
          type: updatedType,
          notes: updatedLine ? `Line: ${updatedLine}` : null
        });
      }

      setDealers((prev) =>
        prev.map((d) =>
          d.id === dealer.id
            ? {
                ...d,
                name: updatedName,
                type: updatedType,
                line: updatedLine,
                jazzDoId: dealer.jazzDoId,
                notes: updatedLine ? `Line: ${updatedLine}` : undefined
              }
            : d
        )
      );

      setEditingId(null);
      showStatus(`Updated profile for "${updatedName}".`);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to update dealer.");
    }
  };

  // Handler: One-Click Reassign Line
  const handleReassignLine = async (dealer: UnifiedDealerRecord) => {
    if (!canManage) return;
    const currentLine = dealer.line || "Unassigned";
    let newOfficer = window.prompt(
      `Reassign Line ${currentLine} (${dealer.name}) to New Officer Name:`,
      ""
    )?.trim();

    if (!newOfficer) return;
    newOfficer = cleanDealerName(newOfficer);
    if (!newOfficer || newOfficer === dealer.name) return;

    try {
      if (dealer.jazzDoId) {
        await ledgerApiClient.catalogs.updateJazzLoadDoProfile(dealer.jazzDoId, {
          do_name: newOfficer
        });
      }
      if (dealer.stockAccountId) {
        await ledgerApiClient.catalogs.updateStockAccount(dealer.stockAccountId, {
          name: newOfficer
        });
      }

      setDealers((prev) =>
        prev.map((d) => (d.id === dealer.id ? { ...d, name: newOfficer } : d))
      );
      showStatus(
        `Line ${currentLine} successfully reassigned to ${newOfficer}. Past closed days retain previous officer snapshots.`
      );
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to reassign line.");
    }
  };

  // Handler: Toggle Active / Inactive
  const handleToggleActive = async (dealer: UnifiedDealerRecord) => {
    if (!canManage) return;
    const nextActive = !dealer.active;

    try {
      if (dealer.jazzDoId) {
        await ledgerApiClient.catalogs.updateJazzLoadDoProfile(dealer.jazzDoId, {
          is_active: nextActive
        });
      }
      if (dealer.stockAccountId) {
        await ledgerApiClient.catalogs.updateStockAccount(dealer.stockAccountId, {
          is_active: nextActive
        });
      }

      setDealers((prev) =>
        prev.map((d) => (d.id === dealer.id ? { ...d, active: nextActive } : d))
      );
      showStatus(`Dealer "${dealer.name}" ${nextActive ? "activated" : "deactivated"}.`);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to toggle status.");
    }
  };

  // Handler: Delete / Deactivate Dealer
  const handleDeleteDealer = async (dealer: UnifiedDealerRecord) => {
    if (!canManage) return;
    if (!window.confirm(`Deactivate dealer "${dealer.name}" from all modules?`)) return;

    try {
      if (dealer.jazzDoId) {
        await ledgerApiClient.catalogs.updateJazzLoadDoProfile(dealer.jazzDoId, {
          is_active: false
        });
      }
      if (dealer.stockAccountId) {
        await ledgerApiClient.catalogs.updateStockAccount(dealer.stockAccountId, {
          is_active: false
        });
      }

      setDealers((prev) =>
        prev.map((d) => (d.id === dealer.id ? { ...d, active: false } : d))
      );
      showStatus(`Dealer "${dealer.name}" deactivated across all modules.`);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to deactivate dealer.");
    }
  };

  // Handler: Reorder Move Up / Down
  const handleMove = async (index: number, direction: "up" | "down") => {
    if (!canManage) return;
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= filteredDealers.length) return;

    const source = filteredDealers[index];
    const target = filteredDealers[targetIndex];

    const sourceNewOrder = target.sortOrder;
    const targetNewOrder = source.sortOrder;

    try {
      const updates = [];
      if (source.jazzDoId) {
        updates.push(
          ledgerApiClient.catalogs.updateJazzLoadDoProfile(source.jazzDoId, {
            sort_order: sourceNewOrder
          })
        );
      }
      if (source.stockAccountId) {
        updates.push(
          ledgerApiClient.catalogs.updateStockAccount(source.stockAccountId, {
            sort_order: sourceNewOrder
          })
        );
      }
      if (target.jazzDoId) {
        updates.push(
          ledgerApiClient.catalogs.updateJazzLoadDoProfile(target.jazzDoId, {
            sort_order: targetNewOrder
          })
        );
      }
      if (target.stockAccountId) {
        updates.push(
          ledgerApiClient.catalogs.updateStockAccount(target.stockAccountId, {
            sort_order: targetNewOrder
          })
        );
      }

      await Promise.all(updates);

      setDealers((prev) =>
        prev.map((d) => {
          if (d.id === source.id) return { ...d, sortOrder: sourceNewOrder };
          if (d.id === target.id) return { ...d, sortOrder: targetNewOrder };
          return d;
        }).sort((a, b) => a.sortOrder - b.sortOrder)
      );

      showStatus("Dealer order updated successfully.");
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to reorder dealers.");
    }
  };

  // Handler: Reconcile and Cross-Sync All Profiles
  const handleReconcileSync = async () => {
    if (!canManage) return;
    try {
      showStatus("Reconciling and synchronizing dealer profiles across all modules...");
      const [jazzRes, stockRes] = await Promise.all([
        ledgerApiClient.catalogs.getJazzLoadDoProfiles(true),
        ledgerApiClient.catalogs.getStockAccounts()
      ]);

      const jazzProfiles = jazzRes.data || [];
      const stockAccounts = stockRes.data || [];

      const stockNormMap = new Map<string, any>();
      stockAccounts.forEach((sa: any) => {
        const key = getCanonicalDealerKey(sa.name);
        if (!key.startsWith("discard-")) {
          stockNormMap.set(key, sa);
        }
      });

      let repairs = 0;

      // Ensure every Jazz DO exists in Stock Accounts with matching line in notes
      for (const jp of jazzProfiles) {
        const key = getCanonicalDealerKey(jp.do_name);
        if (key.startsWith("discard-")) continue;

        const info = resolveCanonicalDealerInfo(jp.do_name, jp.type);
        const existingStock = stockNormMap.get(key);

        if (!existingStock) {
          const slugVal = `dealer-${info.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}-${Date.now().toString(36)}`;
          await ledgerApiClient.catalogs.createStockAccount({
            slug: slugVal,
            name: info.name,
            type: info.type,
            is_active: jp.is_active ?? true,
            sort_order: info.sortOrder ?? jp.sort_order ?? 99,
            notes: jp.do_line ? `Line: ${jp.do_line}` : null
          });
          repairs++;
        } else {
          const needsNameUpdate = existingStock.name !== info.name;
          const needsTypeUpdate = existingStock.type !== info.type;
          const needsLineUpdate = jp.do_line && !existingStock.notes?.includes(jp.do_line);

          if (needsNameUpdate || needsTypeUpdate || needsLineUpdate) {
            await ledgerApiClient.catalogs.updateStockAccount(existingStock.id, {
              name: info.name,
              type: info.type,
              sort_order: info.sortOrder ?? existingStock.sort_order,
              notes: jp.do_line ? `Line: ${jp.do_line}` : existingStock.notes
            });
            repairs++;
          }
        }
      }

      await loadDirectory();
      showStatus(
        repairs > 0
          ? `Reconciliation complete: Synchronized ${repairs} profile(s) across Jazz Load and Stock Ledger.`
          : "All dealer profiles are already perfectly reconciled and synchronized across all modules!"
      );
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to reconcile profiles.");
    }
  };

  // Export to CSV
  const handleExportCSV = () => {
    const headers = ["#", "Name", "Type", "MSISDN Line", "Jazz Load", "Stock Ledger", "Status"];
    const rows = filteredDealers.map((d, idx) => [
      String(idx + 1),
      `"${d.name.replace(/"/g, '""')}"`,
      d.type,
      `"${d.line || ""}"`,
      d.jazzDoId ? "Yes" : "No",
      d.stockAccountId ? "Yes" : "No",
      d.active ? "Active" : "Inactive"
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `dealers-directory-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Top Header Card */}
      <section className="panel">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-400">
                <Users className="h-5 w-5" />
              </span>
              <div>
                <h2 className="text-lg font-bold text-white tracking-tight">
                  Central Dealers & DO Directory
                </h2>
                <p className="text-xs text-slate-400">
                  Single Master Directory for all Distribution Officers, Dealers, and Accounts across Jazz Load, Stock Ledger, and Expense modules.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-secondary flex items-center gap-1.5 text-xs text-sky-400 hover:text-sky-300 hover:border-sky-500/40"
              onClick={handleReconcileSync}
              disabled={!canManage}
              title="Ensure all profiles and lines match across Jazz Load and Stock Ledger"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Cross-Module Reconcile & Sync
            </button>
            <button
              type="button"
              className="btn-secondary flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
              onClick={handleExportCSV}
              title="Download directory as CSV"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
              Export CSV
            </button>
          </div>
        </div>

        {/* Status Toast */}
        {statusMessage && (
          <div className="mt-3 flex items-center justify-between rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-300">
            <span>{statusMessage}</span>
            <button
              type="button"
              className="text-slate-400 hover:text-white"
              onClick={() => setStatusMessage(null)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* 4 Summary Stat Cards */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Total Accounts
            </p>
            <p className="mt-1 text-2xl font-bold text-white">{stats.total}</p>
            <p className="text-[11px] text-emerald-400 font-medium">
              {stats.active} Active Profiles
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Active DOs
            </p>
            <p className="mt-1 text-2xl font-bold text-sky-400">{stats.dos}</p>
            <p className="text-[11px] text-slate-400">Load & Stock Distribution</p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Store & Counter CCRs
            </p>
            <p className="mt-1 text-2xl font-bold text-emerald-400">{stats.ccrs}</p>
            <p className="text-[11px] text-slate-400">Customer Care Accounts</p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              Assigned MSISDN Lines
            </p>
            <p className="mt-1 text-2xl font-bold text-indigo-400">{stats.lines}</p>
            <p className="text-[11px] text-slate-400">Dedicated Load Phone Lines</p>
          </div>
        </div>

        {/* Master Quick Add Bar */}
        {canManage && (
          <div className="mt-5 rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-300 mb-2.5">
              Register New Dealer / Distribution Officer
            </p>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-[1.5fr_1fr_1.2fr_auto] sm:items-end">
              <label className="text-xs font-medium text-slate-300">
                Officer / Dealer Name
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Naveed Bangla"
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                />
              </label>

              <label className="text-xs font-medium text-slate-300">
                Account Type / Role
                <select
                  value={newType}
                  onChange={(e) => {
                    const t = e.target.value as StockAccountType;
                    setNewType(t);
                    if (t === "DSO" || t === "STOCK") setNewLine("");
                  }}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white focus:border-sky-500 focus:outline-none"
                >
                  <option value="DO">DO (Distribution Officer)</option>
                  <option value="CCR">CCR (Customer Care Rep)</option>
                  <option value="OFFICE">Office Line / Account</option>
                  <option value="DSO">DSO (Direct Sales - Stock Only)</option>
                  <option value="STOCK">Stock Counter (Stock Only)</option>
                  <option value="OTHER">Other Dealer Party</option>
                </select>
              </label>

              <label className="text-xs font-medium text-slate-300">
                <span>Assigned Load Line (MSISDN)</span>
                <span className="text-[10px] text-slate-500 font-normal ml-1">
                  {newType === "DSO" || newType === "STOCK" ? "(Stock only - No line)" : "(Jazz Load only)"}
                </span>
                <input
                  type="text"
                  value={newLine}
                  disabled={newType === "DSO" || newType === "STOCK"}
                  onChange={(e) => setNewLine(e.target.value)}
                  placeholder={newType === "DSO" || newType === "STOCK" ? "No line for stock-only" : "e.g. 03001234567"}
                  className="mt-1 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </label>

              <button
                type="button"
                className="btn-primary flex items-center justify-center gap-1.5 !h-9 text-xs"
                disabled={!newName.trim()}
                onClick={handleRegisterDealer}
              >
                <Plus className="h-4 w-4" />
                Register Dealer
              </button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              💡 Registering a dealer here creates their profile simultaneously across Jazz Load and Stock Ledger with zero discrepancy.
            </p>
          </div>
        )}
      </section>

      {/* Directory Table Panel */}
      <section className="panel">
        {/* Search & Filter Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by dealer name or line..."
              className="w-full rounded-md border border-slate-700 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
            >
              <option value="ALL">All Account Types</option>
              <option value="DO">DO Only</option>
              <option value="CCR">CCR Only</option>
              <option value="DSO">DSO Only</option>
              <option value="STOCK">Stock Counters</option>
              <option value="OFFICE">Office Line Only</option>
              <option value="OTHER">Other Parties</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-200 focus:border-sky-500 focus:outline-none"
            >
              <option value="ALL">All Statuses</option>
              <option value="ACTIVE">Active Only</option>
              <option value="INACTIVE">Inactive Only</option>
            </select>
          </div>
        </div>

        {/* Compact Master Table */}
        <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/80 font-semibold text-slate-300">
                <th className="w-16 px-2.5 py-2 text-center">#</th>
                <th className="px-3 py-2">Dealer / Officer Name</th>
                <th className="w-28 px-3 py-2">Account Type</th>
                <th className="w-40 px-3 py-2">Assigned MSISDN Line</th>
                <th className="w-36 px-3 py-2 text-center">Modules</th>
                <th className="w-24 px-3 py-2 text-center">Status</th>
                <th className="w-64 px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    Loading Master Dealers Directory...
                  </td>
                </tr>
              ) : filteredDealers.map((dealer, idx) => {
                const isEditing = editingId === dealer.id;
                return (
                  <tr
                    key={dealer.id}
                    className={`transition-colors hover:bg-slate-900/40 ${
                      !dealer.active ? "opacity-60 bg-slate-950/30" : ""
                    }`}
                  >
                    {/* Order & Chevrons */}
                    <td className="px-2 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <span className="w-4 text-center font-mono text-slate-400">{idx + 1}</span>
                        {canManage && (
                          <div className="flex flex-col">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => handleMove(idx, "up")}
                              className="text-slate-500 hover:text-white disabled:opacity-20 disabled:hover:text-slate-500"
                              title="Move up"
                            >
                              <ChevronUp className="h-3 w-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === filteredDealers.length - 1}
                              onClick={() => handleMove(idx, "down")}
                              className="text-slate-500 hover:text-white disabled:opacity-20 disabled:hover:text-slate-500"
                              title="Move down"
                            >
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </div>
                        )}
                      </div>
                    </td>

                    {/* Dealer Name */}
                    <td className="px-3 py-1.5">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                          autoFocus
                        />
                      ) : (
                        <div className="font-semibold text-white flex items-center gap-1.5">
                          {dealer.name}
                        </div>
                      )}
                    </td>

                    {/* Type / Role */}
                    <td className="px-3 py-1.5">
                      {isEditing ? (
                        <select
                          value={editType}
                          onChange={(e) => {
                            const newType = e.target.value as StockAccountType;
                            setEditType(newType);
                            if (newType === "DSO" || newType === "STOCK") {
                              setEditLine("");
                            }
                          }}
                          className="rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
                        >
                          <option value="DO">DO</option>
                          <option value="CCR">CCR</option>
                          <option value="DSO">DSO</option>
                          <option value="STOCK">STOCK</option>
                          <option value="OFFICE">OFFICE</option>
                          <option value="OTHER">OTHER</option>
                        </select>
                      ) : (
                        <span
                          className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold border ${
                            dealer.type === "DO"
                              ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
                              : dealer.type === "CCR"
                              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                              : dealer.type === "DSO"
                              ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                              : dealer.type === "STOCK"
                              ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                              : dealer.type === "OFFICE"
                              ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                              : "bg-slate-800 text-slate-300 border-slate-700"
                          }`}
                        >
                          {dealer.type}
                        </span>
                      )}
                    </td>

                    {/* MSISDN Line */}
                    <td className="px-3 py-1.5">
                      {isEditing ? (
                        <input
                          type="text"
                          value={editLine}
                          onChange={(e) => setEditLine(e.target.value)}
                          disabled={editType === "DSO" || editType === "STOCK"}
                          placeholder={editType === "DSO" || editType === "STOCK" ? "No line (Stock only)" : "e.g. 03001234567"}
                          className="w-full rounded border border-sky-500/50 bg-slate-900 px-2 py-1 text-xs font-mono text-white focus:outline-none focus:ring-1 focus:ring-sky-500 disabled:opacity-50 disabled:bg-slate-950"
                        />
                      ) : (
                        <span className="font-mono text-slate-300">
                          {dealer.line || <span className="italic text-slate-500">—</span>}
                        </span>
                      )}
                    </td>

                    {/* Modules Availability Badges */}
                    <td className="px-3 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-1">
                        {dealer.jazzDoId && (
                          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-400 border border-sky-500/20">
                            Load
                          </span>
                        )}
                        {dealer.stockAccountId && (
                          <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400 border border-emerald-500/20">
                            Stock
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Status */}
                    <td className="px-3 py-1.5 text-center">
                      {dealer.active ? (
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
                              onClick={() => handleSaveEdit(dealer)}
                              disabled={!editName.trim()}
                            >
                              <Check className="h-3.5 w-3.5" />
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1"
                              onClick={() => setEditingId(null)}
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
                              disabled={!canManage}
                              onClick={() => {
                                setEditingId(dealer.id);
                                setEditName(dealer.name);
                                setEditType(dealer.type);
                                setEditLine(dealer.line ?? "");
                              }}
                              title="Edit Dealer Details"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              Edit
                            </button>

                            {dealer.line && (
                              <button
                                type="button"
                                className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1 text-sky-400 hover:text-sky-300 hover:border-sky-500/40"
                                disabled={!canManage}
                                onClick={() => handleReassignLine(dealer)}
                                title="Reassign this MSISDN line to a new officer without breaking past day history"
                              >
                                <UserCheck className="h-3.5 w-3.5" />
                                Reassign Line
                              </button>
                            )}

                            <button
                              type="button"
                              className={`btn-secondary !h-7 !px-2 text-xs ${
                                dealer.active
                                  ? "text-slate-400 hover:text-amber-300"
                                  : "text-emerald-400 hover:text-emerald-300"
                              }`}
                              disabled={!canManage}
                              onClick={() => handleToggleActive(dealer)}
                              title={dealer.active ? "Deactivate Dealer" : "Activate Dealer"}
                            >
                              {dealer.active ? "Deactivate" : "Activate"}
                            </button>

                            <button
                              type="button"
                              className="btn-secondary !h-7 !w-7 !p-0 text-rose-400 hover:text-rose-300 hover:border-rose-500/40"
                              disabled={!canManage}
                              onClick={() => handleDeleteDealer(dealer)}
                              title="Deactivate Dealer"
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

              {!loading && filteredDealers.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    No dealers or accounts match your search or filter criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer Note */}
        <p className="mt-3 text-[11px] text-slate-500">
          💡 <span className="font-medium text-slate-400">Master Directory Architecture:</span> Updates or reassignments made here automatically propagate across both Jazz Load and Stock Ledger. When an officer leaves or a line is reassigned, click &quot;Reassign Line&quot; to assign future sheets to the new officer while leaving historical saved snapshots completely frozen.
        </p>
      </section>
    </div>
  );
}
