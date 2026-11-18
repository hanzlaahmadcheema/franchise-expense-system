import { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertTriangle,
  ArrowUpDown,
  BarChart3,
  Calendar,
  Check,
  ChevronDown,
  ChevronUp,
  CreditCard,
  DollarSign,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Layers,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Trash2,
  TrendingUp,
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

  // Tab Navigation: "directory" | "reports"
  const [activeTab, setActiveTab] = useState<"directory" | "reports">("directory");

  // Dealer Reports State
  const [reportsLoading, setReportsLoading] = useState(false);
  const [reportData, setReportData] = useState<any | null>(null);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState<string>("");
  const [selectedDealerKey, setSelectedDealerKey] = useState<string | null>(null);
  const [reportCategoryFilter, setReportCategoryFilter] = useState<string>("ALL");
  const [reportSearchQuery, setReportSearchQuery] = useState("");

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
    void loadReports();
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

  // Load Dealer Reports from API
  const loadReports = async (periodKey?: string) => {
    setReportsLoading(true);
    try {
      const res = await ledgerApiClient.catalogs.getDealerReports({
        period_key: periodKey || selectedPeriodKey || undefined
      });
      if (res.data) {
        setReportData(res.data);
        if (res.data.period?.period_key) {
          setSelectedPeriodKey(res.data.period.period_key);
        }
      }
    } catch (err) {
      showStatus(err instanceof Error ? err.message : "Failed to load dealer reports.");
    } finally {
      setReportsLoading(false);
    }
  };

  // Filtered Summary for Reports Table
  const filteredReportSummary = useMemo(() => {
    if (!reportData?.summary) return [];
    return (reportData.summary as any[]).filter((item: any) => {
      const q = reportSearchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        (item.line && item.line.toLowerCase().includes(q));
      const matchesCategory =
        reportCategoryFilter === "ALL" || item.type === reportCategoryFilter;
      return matchesSearch && matchesCategory;
    });
  }, [reportData, reportSearchQuery, reportCategoryFilter]);

  // Aggregate Franchise Totals across filtered dealers
  const reportTotals = useMemo(() => {
    const items = filteredReportSummary;
    const loadIssuance = items.reduce((s, i) => s + (i.loadIssuance || 0), 0);
    const loadPayment = items.reduce((s, i) => s + (i.loadPayment || 0), 0);
    const loadClosing = items.reduce((s, i) => s + (i.loadClosing || 0), 0);
    const stockIssued = items.reduce((s, i) => s + (i.stockIssued || 0), 0);
    const stockPayment = items.reduce((s, i) => s + (i.stockPayment || 0), 0);
    const stockClosing = items.reduce((s, i) => s + (i.stockClosing || 0), 0);
    const totalDisbursed = loadIssuance + stockIssued;
    const totalRecovered = loadPayment + stockPayment;
    const netOutstanding = loadClosing + stockClosing;
    return {
      loadIssuance,
      loadPayment,
      loadClosing,
      stockIssued,
      stockPayment,
      stockClosing,
      totalDisbursed,
      totalRecovered,
      netOutstanding
    };
  }, [filteredReportSummary]);

  // Selected Dealer Statement lookup
  const selectedDealerSummary = useMemo(() => {
    if (!selectedDealerKey || !reportData?.summary) return null;
    return reportData.summary.find((s: any) => s.id === selectedDealerKey) || null;
  }, [selectedDealerKey, reportData]);

  const selectedDealerStatements = useMemo(() => {
    if (!selectedDealerKey || !reportData?.dailyStatements) return [];
    return reportData.dailyStatements[selectedDealerKey] || [];
  }, [selectedDealerKey, reportData]);

  // Format currency
  const formatRs = (val: number) => {
    return "Rs. " + Math.round(val || 0).toLocaleString();
  };

  // Export Dealer Reports to Excel
  const handleExportDealerReportsXlsx = () => {
    if (!reportData) return;
    const periodLabel = reportData.period?.label || selectedPeriodKey || "Period";
    const wb = XLSX.utils.book_new();

    const summaryRows = [
      ["Jazz Franchise - 7301"],
      [`Dealers Master Ledger Report - ${periodLabel}`],
      [`Generated: ${new Date().toLocaleString()}`],
      [],
      [
        "#",
        "Dealer Name",
        "Category / Role",
        "MSISDN Line",
        "Opening Load (Rs.)",
        "Load Disbursed (Rs.)",
        "Load Recovered (Rs.)",
        "Closing Load Due (Rs.)",
        "Active Load Days",
        "Opening Stock (Rs.)",
        "Stock Issued (Rs.)",
        "Stock Payment (Rs.)",
        "Closing Stock Due (Rs.)",
        "Total Disbursed (Rs.)",
        "Total Recovered (Rs.)",
        "Net Outstanding Due (Rs.)"
      ],
      ...filteredReportSummary.map((item, idx) => [
        idx + 1,
        item.name,
        item.type,
        item.line || "-",
        Math.round(item.loadOpening),
        Math.round(item.loadIssuance),
        Math.round(item.loadPayment),
        Math.round(item.loadClosing),
        item.activeLoadDays,
        Math.round(item.stockOpening),
        Math.round(item.stockIssued),
        Math.round(item.stockPayment),
        Math.round(item.stockClosing),
        Math.round(item.totalDisbursed),
        Math.round(item.totalRecovered),
        Math.round(item.netOutstanding)
      ]),
      [],
      [
        "Total",
        "",
        "",
        "",
        "",
        Math.round(reportTotals.loadIssuance),
        Math.round(reportTotals.loadPayment),
        Math.round(reportTotals.loadClosing),
        "",
        "",
        Math.round(reportTotals.stockIssued),
        Math.round(reportTotals.stockPayment),
        Math.round(reportTotals.stockClosing),
        Math.round(reportTotals.totalDisbursed),
        Math.round(reportTotals.totalRecovered),
        Math.round(reportTotals.netOutstanding)
      ]
    ];

    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    wsSummary["!cols"] = [
      { wch: 6 },
      { wch: 22 },
      { wch: 14 },
      { wch: 16 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 14 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 18 },
      { wch: 20 },
      { wch: 20 },
      { wch: 20 }
    ];
    XLSX.utils.book_append_sheet(wb, wsSummary, "Dealer Summary");

    if (selectedDealerSummary && selectedDealerStatements.length > 0) {
      const dRows = [
        ["Jazz Franchise - 7301"],
        [`Dealer Ledger Statement: ${selectedDealerSummary.name} (${selectedDealerSummary.type}) - ${periodLabel}`],
        [`Line: ${selectedDealerSummary.line || "None"} | Generated: ${new Date().toLocaleString()}`],
        [],
        [
          "Day #",
          "Date",
          "Status",
          "Load Opening",
          "Load Issuance",
          "Load Recovery",
          "Load Balance",
          "Stock Opening",
          "Stock Issued",
          "Stock Payment",
          "Stock Balance",
          "Daily Net Due"
        ],
        ...selectedDealerStatements.map((s: any) => [
          s.dayNo,
          s.calendarDate,
          s.dayStatus,
          Math.round(s.loadOpening),
          Math.round(s.loadIssuance),
          Math.round(s.loadPayment),
          Math.round(s.loadClosing),
          Math.round(s.stockOpening),
          Math.round(s.stockIssued),
          Math.round(s.stockPayment),
          Math.round(s.stockClosing),
          Math.round(s.dailyNetDue)
        ])
      ];
      const wsDealer = XLSX.utils.aoa_to_sheet(dRows);
      wsDealer["!cols"] = [
        { wch: 8 },
        { wch: 14 },
        { wch: 12 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 16 },
        { wch: 18 }
      ];
      XLSX.utils.book_append_sheet(wb, wsDealer, (selectedDealerSummary.name || "Dealer").slice(0, 31));
    }

    XLSX.writeFile(wb, `dealers-report-${periodLabel.toLowerCase().replace(/[^a-z0-9]/g, "-")}.xlsx`);
  };

  // Export Dealer Reports to CSV
  const handleExportDealerReportsCsv = () => {
    if (!reportData) return;
    const periodLabel = reportData.period?.label || selectedPeriodKey || "Period";
    const headers = [
      "#",
      "Dealer Name",
      "Category",
      "Line",
      "Load Disbursed",
      "Load Recovered",
      "Load Due",
      "Stock Issued",
      "Stock Payment",
      "Stock Due",
      "Total Disbursed",
      "Total Recovered",
      "Net Outstanding Due"
    ];
    const rows = filteredReportSummary.map((d, idx) => [
      String(idx + 1),
      `"${d.name.replace(/"/g, '""')}"`,
      d.type,
      `"${d.line || ""}"`,
      Math.round(d.loadIssuance),
      Math.round(d.loadPayment),
      Math.round(d.loadClosing),
      Math.round(d.stockIssued),
      Math.round(d.stockPayment),
      Math.round(d.stockClosing),
      Math.round(d.totalDisbursed),
      Math.round(d.totalRecovered),
      Math.round(d.netOutstanding)
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `dealers-report-${periodLabel.toLowerCase().replace(/[^a-z0-9]/g, "-")}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Print Dealer Statement
  const handlePrintDealerStatement = (dealer: any, statements: any[]) => {
    const periodLabel = reportData?.period?.label || selectedPeriodKey || "Period";
    const rows = statements
      .map(
        (s: any) =>
          `<tr>
            <td>Day ${s.dayNo}</td>
            <td>${s.calendarDate || "-"}</td>
            <td style="text-align:right">Rs. ${Math.round(s.loadIssuance).toLocaleString()}</td>
            <td style="text-align:right">Rs. ${Math.round(s.loadPayment).toLocaleString()}</td>
            <td style="text-align:right">Rs. ${Math.round(s.loadClosing).toLocaleString()}</td>
            <td style="text-align:right">Rs. ${Math.round(s.stockIssued).toLocaleString()}</td>
            <td style="text-align:right">Rs. ${Math.round(s.stockPayment).toLocaleString()}</td>
            <td style="text-align:right">Rs. ${Math.round(s.stockClosing).toLocaleString()}</td>
            <td style="text-align:right; font-weight: bold; color: ${s.dailyNetDue > 0 ? '#b91c1c' : '#047857'}">Rs. ${Math.round(s.dailyNetDue).toLocaleString()}</td>
          </tr>`
      )
      .join("");

    const win = window.open("", "_blank");
    if (!win) {
      alert("Popup blocked. Please allow popups to print report.");
      return;
    }

    win.document.write(`
      <!doctype html>
      <html>
      <head>
        <title>Dealer Statement - ${dealer.name} (${periodLabel})</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; padding: 24px; color: #1e293b; font-size: 13px; }
          .header { border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start; }
          .title { font-size: 20px; font-weight: bold; color: #0f172a; }
          .subtitle { color: #64748b; font-size: 12px; margin-top: 4px; }
          .badge { display: inline-block; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; background: #e0f2fe; color: #0369a1; }
          .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
          .kpi-card { border: 1px solid #cbd5e1; border-radius: 6px; padding: 10px; background: #f8fafc; }
          .kpi-title { font-size: 10px; text-transform: uppercase; color: #64748b; font-weight: 600; }
          .kpi-val { font-size: 16px; font-weight: bold; margin-top: 4px; color: #0f172a; }
          table { width: 100%; border-collapse: collapse; margin-top: 10px; }
          th { background: #f1f5f9; text-align: left; padding: 7px 8px; font-size: 11px; border: 1px solid #cbd5e1; text-transform: uppercase; color: #475569; }
          td { padding: 6px 8px; border: 1px solid #cbd5e1; font-size: 11px; }
          tr:nth-child(even) { background: #fafafa; }
          @media print { body { padding: 0; } }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <div class="title">Jazz Franchise - 7301</div>
            <div class="subtitle">Dealer Ledger Statement & Performance Report</div>
          </div>
          <div style="text-align: right">
            <span class="badge">${dealer.type}</span>
            <div style="font-weight: bold; font-size: 15px; margin-top: 4px;">${dealer.name}</div>
            <div style="color: #64748b; font-size: 11px;">Line: ${dealer.line || "None"}</div>
            <div style="color: #64748b; font-size: 11px;">Period: ${periodLabel}</div>
          </div>
        </div>

        <div class="kpis">
          <div class="kpi-card">
            <div class="kpi-title">Opening Balance</div>
            <div class="kpi-val">Rs. ${Math.round(dealer.loadOpening + dealer.stockOpening).toLocaleString()}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Total Disbursed</div>
            <div class="kpi-val" style="color: #0284c7">Rs. ${Math.round(dealer.totalDisbursed).toLocaleString()}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Total Recovered</div>
            <div class="kpi-val" style="color: #16a34a">Rs. ${Math.round(dealer.totalRecovered).toLocaleString()}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Closing Due Balance</div>
            <div class="kpi-val" style="color: ${dealer.netOutstanding > 0 ? '#dc2626' : '#16a34a'}">Rs. ${Math.round(dealer.netOutstanding).toLocaleString()}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Date</th>
              <th style="text-align:right">Load Issuance</th>
              <th style="text-align:right">Load Recovery</th>
              <th style="text-align:right">Load Due</th>
              <th style="text-align:right">Stock Issued</th>
              <th style="text-align:right">Stock Payment</th>
              <th style="text-align:right">Stock Due</th>
              <th style="text-align:right">Daily Net Due</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </body>
      </html>
    `);
    win.document.close();
    win.print();
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

        {/* Navigation Tabs */}
        <div className="mt-4 flex flex-wrap gap-2 rounded-xl border border-slate-800 bg-slate-900/50 p-1.5 text-slate-100 shadow-xl shadow-black/20">
          <button
            type="button"
            className={`btn-tab !h-9 !px-4 ${activeTab === "directory" ? "btn-tab-active" : ""}`}
            onClick={() => setActiveTab("directory")}
          >
            <Users className="h-4 w-4 text-sky-400" />
            Directory & Roster
            <span className="ml-1.5 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
              {dealers.length}
            </span>
          </button>

          <button
            type="button"
            className={`btn-tab !h-9 !px-4 ${activeTab === "reports" ? "btn-tab-active" : ""}`}
            onClick={() => {
              setActiveTab("reports");
              if (!reportData) void loadReports();
            }}
          >
            <BarChart3 className="h-4 w-4 text-emerald-400" />
            Dealer Reports & Statements
            <span className="ml-1.5 rounded-full bg-emerald-950/60 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">
              Multi-Module Ledger
            </span>
          </button>
        </div>

        {/* Directory View Tab */}
        {activeTab === "directory" && (
          <>
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
          </>
        )}
      </section>

      {/* Directory Tab: Table View */}
      {activeTab === "directory" && (
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
                  <th className="w-72 px-3 py-2 text-right">Actions</th>
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
                                className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1 text-sky-400 hover:text-sky-300 hover:border-sky-500/40"
                                onClick={() => {
                                  setActiveTab("reports");
                                  setSelectedDealerKey(dealer.id);
                                  if (!reportData) void loadReports();
                                }}
                                title="View Ledger Statement & Performance Report"
                              >
                                <BarChart3 className="h-3.5 w-3.5" />
                                Report
                              </button>

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
      )}

      {/* Reports View Tab */}
      {activeTab === "reports" && (
        <div className="space-y-6">
          {/* Reports Toolbar & Filters */}
          <section className="panel">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <Calendar className="h-4 w-4 text-sky-400" />
                  <span className="text-xs font-semibold text-slate-300">Period:</span>
                  <select
                    value={selectedPeriodKey || ""}
                    onChange={(e) => {
                      setSelectedPeriodKey(e.target.value);
                      void loadReports(e.target.value);
                    }}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-white focus:border-sky-500 focus:outline-none"
                  >
                    {reportData?.periods?.map((p: any) => (
                      <option key={p.id} value={p.period_key}>
                        {p.label} ({p.status === "open" ? "OPEN" : "CLOSED"})
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary !h-8 !px-2 text-xs flex items-center gap-1 text-slate-300 hover:text-white"
                    onClick={() => void loadReports(selectedPeriodKey)}
                    title="Refresh Report Data"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${reportsLoading ? "animate-spin text-sky-400" : ""}`} />
                  </button>
                </div>

                {/* Role / Category Filter Pills */}
                <div className="flex items-center gap-1 bg-slate-950/60 p-1 rounded-lg border border-slate-800">
                  {(["ALL", "DO", "CCR", "DSO", "STOCK", "OFFICE"] as const).map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setReportCategoryFilter(cat)}
                      className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        reportCategoryFilter === cat
                          ? "bg-sky-500/20 text-sky-300 border border-sky-500/30"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {cat === "ALL" ? "All Roles" : cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Search & Export Buttons */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[200px]">
                  <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                  <input
                    type="text"
                    value={reportSearchQuery}
                    onChange={(e) => setReportSearchQuery(e.target.value)}
                    placeholder="Search dealer or line..."
                    className="w-full rounded-md border border-slate-700 bg-slate-900 pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-500 focus:border-sky-500 focus:outline-none"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleExportDealerReportsXlsx}
                  className="btn-secondary flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 hover:border-emerald-500/40"
                  title="Export dealer ledger summary and statements to Excel (.xlsx)"
                >
                  <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
                  Export Excel (.xlsx)
                </button>

                <button
                  type="button"
                  onClick={handleExportDealerReportsCsv}
                  className="btn-secondary flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
                  title="Export dealer ledger summary as CSV"
                >
                  <Download className="h-3.5 w-3.5" />
                  Export CSV
                </button>
              </div>
            </div>

            {/* 4 Financial Summary Stat Cards */}
            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  Dealers In Report
                </p>
                <p className="mt-1 text-2xl font-bold text-white">
                  {filteredReportSummary.length}
                </p>
                <p className="text-[11px] text-slate-400">
                  {reportData?.period?.label || "Current Period"}
                </p>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  Jazz Load Flow
                </p>
                <p className="mt-1 text-xl font-bold text-sky-400">
                  {formatRs(reportTotals.loadIssuance)}
                </p>
                <div className="mt-0.5 flex justify-between text-[11px] text-slate-400">
                  <span>Rec: {formatRs(reportTotals.loadPayment)}</span>
                  <span className="font-semibold text-sky-300">Due: {formatRs(reportTotals.loadClosing)}</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  Stock Ledger Flow
                </p>
                <p className="mt-1 text-xl font-bold text-amber-400">
                  {formatRs(reportTotals.stockIssued)}
                </p>
                <div className="mt-0.5 flex justify-between text-[11px] text-slate-400">
                  <span>Pay: {formatRs(reportTotals.stockPayment)}</span>
                  <span className="font-semibold text-amber-300">Due: {formatRs(reportTotals.stockClosing)}</span>
                </div>
              </div>

              <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-3">
                <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                  Franchise Net Receivables
                </p>
                <p
                  className={`mt-1 text-2xl font-bold ${
                    reportTotals.netOutstanding > 0 ? "text-rose-400" : "text-emerald-400"
                  }`}
                >
                  {formatRs(reportTotals.netOutstanding)}
                </p>
                <p className="text-[11px] text-slate-400">
                  Disbursed: {formatRs(reportTotals.totalDisbursed)} | Rec: {formatRs(reportTotals.totalRecovered)}
                </p>
              </div>
            </div>
          </section>

          {/* Comparative Performance Table */}
          <section className="panel">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-bold text-white tracking-tight">
                  Dealer Master Ledger Performance ({reportData?.period?.label || "Period"})
                </h3>
                <p className="text-[11px] text-slate-400">
                  Multi-module comparative performance across Jazz Load and Stock Ledger with live net receivables.
                </p>
              </div>
              <span className="text-xs text-slate-400">
                Showing {filteredReportSummary.length} of {reportData?.summary?.length || 0} accounts
              </span>
            </div>

            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900/80 font-semibold text-slate-300">
                    <th className="w-12 px-2.5 py-2 text-center">#</th>
                    <th className="px-3 py-2">Dealer / Officer</th>
                    <th className="w-20 px-2 py-2 text-center">Role</th>
                    <th className="px-2.5 py-2 text-right">Load Issued</th>
                    <th className="px-2.5 py-2 text-right">Load Recv.</th>
                    <th className="px-2.5 py-2 text-right">Load Due</th>
                    <th className="px-2.5 py-2 text-right">Stock Issued</th>
                    <th className="px-2.5 py-2 text-right">Stock Pay.</th>
                    <th className="px-2.5 py-2 text-right">Stock Due</th>
                    <th className="px-3 py-2 text-right font-bold text-sky-300">Net Due</th>
                    <th className="w-24 px-2 py-2 text-center">Activity</th>
                    <th className="w-36 px-2.5 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 font-mono">
                  {reportsLoading ? (
                    <tr>
                      <td colSpan={12} className="py-8 text-center text-slate-400 font-sans">
                        <RefreshCw className="h-5 w-5 animate-spin mx-auto text-sky-400 mb-2" />
                        Loading multi-module dealer ledger reports...
                      </td>
                    </tr>
                  ) : filteredReportSummary.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="py-8 text-center text-slate-500 font-sans">
                        No dealer ledger records match your filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredReportSummary.map((item: any, idx: number) => {
                      const netDue = item.netOutstanding;
                      const isSelected = selectedDealerKey === item.id;
                      return (
                        <tr
                          key={item.id}
                          className={`transition-colors hover:bg-slate-900/40 ${
                            isSelected ? "bg-sky-500/10 border-l-2 border-sky-400" : ""
                          }`}
                        >
                          <td className="px-2 py-2 text-center text-slate-400 font-mono">{idx + 1}</td>
                          <td className="px-3 py-2 font-sans font-semibold text-white">
                            <div>{item.name}</div>
                            {item.line && (
                              <div className="font-mono text-[10px] text-slate-400">{item.line}</div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center font-sans">
                            <span
                              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold border ${
                                item.type === "DO"
                                  ? "bg-sky-500/10 text-sky-400 border-sky-500/20"
                                  : item.type === "CCR"
                                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                                  : item.type === "DSO"
                                  ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                                  : item.type === "STOCK"
                                  ? "bg-amber-500/10 text-amber-400 border-amber-500/20"
                                  : item.type === "OFFICE"
                                  ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                  : "bg-slate-800 text-slate-300 border-slate-700"
                              }`}
                            >
                              {item.type}
                            </span>
                          </td>
                          <td className="px-2.5 py-2 text-right text-slate-300">
                            {item.loadIssuance > 0 ? formatRs(item.loadIssuance) : "-"}
                          </td>
                          <td className="px-2.5 py-2 text-right text-slate-400">
                            {item.loadPayment > 0 ? formatRs(item.loadPayment) : "-"}
                          </td>
                          <td className="px-2.5 py-2 text-right font-medium text-sky-400">
                            {item.loadClosing !== 0 ? formatRs(item.loadClosing) : "-"}
                          </td>
                          <td className="px-2.5 py-2 text-right text-slate-300">
                            {item.stockIssued > 0 ? formatRs(item.stockIssued) : "-"}
                          </td>
                          <td className="px-2.5 py-2 text-right text-slate-400">
                            {item.stockPayment > 0 ? formatRs(item.stockPayment) : "-"}
                          </td>
                          <td className="px-2.5 py-2 text-right font-medium text-amber-400">
                            {item.stockClosing !== 0 ? formatRs(item.stockClosing) : "-"}
                          </td>
                          <td
                            className={`px-3 py-2 text-right font-bold ${
                              netDue > 0 ? "text-rose-400" : netDue < 0 ? "text-emerald-400" : "text-slate-400"
                            }`}
                          >
                            {formatRs(netDue)}
                          </td>
                          <td className="px-2 py-2 text-center font-sans text-[10px] text-slate-400">
                            {item.activeLoadDays > 0 && <div>Load: {item.activeLoadDays}d</div>}
                            {item.activeStockDays > 0 && <div>Stock: {item.activeStockDays}d</div>}
                            {item.activeLoadDays === 0 && item.activeStockDays === 0 && <div>—</div>}
                          </td>
                          <td className="px-2.5 py-2 text-right font-sans">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                type="button"
                                className="btn-secondary !h-7 !px-2 text-[11px] flex items-center gap-1 text-sky-400 hover:text-sky-300 hover:border-sky-500/40"
                                onClick={() => setSelectedDealerKey(item.id)}
                                title="View Day-by-Day Statement"
                              >
                                <Eye className="h-3 w-3" />
                                Statement
                              </button>
                              <button
                                type="button"
                                className="btn-secondary !h-7 !w-7 !p-0 text-slate-400 hover:text-white"
                                onClick={() => {
                                  setSelectedDealerKey(item.id);
                                  const stmts = reportData?.dailyStatements?.[item.id] || [];
                                  handlePrintDealerStatement(item, stmts);
                                }}
                                title="Print Statement"
                              >
                                <Printer className="h-3 w-3 mx-auto" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
                {filteredReportSummary.length > 0 && (
                  <tfoot>
                    <tr className="border-t-2 border-slate-700 bg-slate-900/90 font-mono font-bold text-white">
                      <td colSpan={3} className="px-3 py-2.5 font-sans uppercase text-[11px] tracking-wider text-slate-300">
                        Total ({filteredReportSummary.length} Dealers)
                      </td>
                      <td className="px-2.5 py-2.5 text-right text-slate-300">{formatRs(reportTotals.loadIssuance)}</td>
                      <td className="px-2.5 py-2.5 text-right text-slate-400">{formatRs(reportTotals.loadPayment)}</td>
                      <td className="px-2.5 py-2.5 text-right text-sky-400">{formatRs(reportTotals.loadClosing)}</td>
                      <td className="px-2.5 py-2.5 text-right text-slate-300">{formatRs(reportTotals.stockIssued)}</td>
                      <td className="px-2.5 py-2.5 text-right text-slate-400">{formatRs(reportTotals.stockPayment)}</td>
                      <td className="px-2.5 py-2.5 text-right text-amber-400">{formatRs(reportTotals.stockClosing)}</td>
                      <td className={`px-3 py-2.5 text-right ${reportTotals.netOutstanding > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                        {formatRs(reportTotals.netOutstanding)}
                      </td>
                      <td colSpan={2} className="px-3 py-2.5 text-right font-sans text-[11px] text-slate-400">
                        {reportData?.period?.label}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </section>

          {/* Selected Dealer Day-by-Day Statement Modal */}
          {selectedDealerSummary && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto animate-in fade-in duration-150">
              <div className="relative w-full max-w-5xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto">
                {/* Modal Header */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10 border border-sky-500/30 text-sky-400">
                      <FileText className="h-5 w-5" />
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-base font-bold text-white">{selectedDealerSummary.name}</h3>
                        <span className="rounded bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-400 border border-sky-500/20">
                          {selectedDealerSummary.type}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400">
                        Line: {selectedDealerSummary.line || "None"} | Period: {reportData?.period?.label || selectedPeriodKey}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handlePrintDealerStatement(selectedDealerSummary, selectedDealerStatements)}
                      className="btn-secondary flex items-center gap-1.5 text-xs text-slate-300 hover:text-white"
                      title="Print Statement"
                    >
                      <Printer className="h-3.5 w-3.5" />
                      Print
                    </button>
                    <button
                      type="button"
                      onClick={handleExportDealerReportsXlsx}
                      className="btn-secondary flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 hover:border-emerald-500/40"
                      title="Export Statement to Excel"
                    >
                      <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-400" />
                      Export Excel
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedDealerKey(null)}
                      className="btn-secondary !h-8 !w-8 !p-0 text-slate-400 hover:text-white"
                      title="Close Statement"
                    >
                      <X className="h-4 w-4 mx-auto" />
                    </button>
                  </div>
                </div>

                {/* 4 Dealer KPI Cards */}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[10px] font-semibold uppercase text-slate-400">Opening Balance</p>
                    <p className="mt-1 text-lg font-bold text-slate-200">
                      {formatRs(selectedDealerSummary.loadOpening + selectedDealerSummary.stockOpening)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[10px] font-semibold uppercase text-slate-400">Period Disbursed</p>
                    <p className="mt-1 text-lg font-bold text-sky-400">
                      {formatRs(selectedDealerSummary.totalDisbursed)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[10px] font-semibold uppercase text-slate-400">Period Recoveries</p>
                    <p className="mt-1 text-lg font-bold text-emerald-400">
                      {formatRs(selectedDealerSummary.totalRecovered)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                    <p className="text-[10px] font-semibold uppercase text-slate-400">Closing Outstanding Due</p>
                    <p
                      className={`mt-1 text-lg font-bold ${
                        selectedDealerSummary.netOutstanding > 0 ? "text-rose-400" : "text-emerald-400"
                      }`}
                    >
                      {formatRs(selectedDealerSummary.netOutstanding)}
                    </p>
                  </div>
                </div>

                {/* Day-by-Day Statement Table */}
                <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/40">
                  <table className="w-full border-collapse text-left text-xs font-mono">
                    <thead>
                      <tr className="border-b border-slate-800 bg-slate-900/80 font-semibold text-slate-300 font-sans">
                        <th className="w-16 px-2.5 py-2 text-center">Day</th>
                        <th className="w-24 px-2.5 py-2">Date</th>
                        <th className="px-2 py-2 text-right">Load Iss.</th>
                        <th className="px-2 py-2 text-right">Load Rec.</th>
                        <th className="px-2 py-2 text-right">Load Bal.</th>
                        <th className="px-2 py-2 text-right">Stock Iss.</th>
                        <th className="px-2 py-2 text-right">Stock Pay.</th>
                        <th className="px-2 py-2 text-right">Stock Bal.</th>
                        <th className="px-2.5 py-2 text-right font-bold text-sky-300">Daily Net Due</th>
                        <th className="px-3 py-2 font-sans">Stock Orders / Product Details</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60">
                      {selectedDealerStatements.length === 0 ? (
                        <tr>
                          <td colSpan={10} className="py-6 text-center text-slate-500 font-sans">
                            No ledger day statements recorded for this period.
                          </td>
                        </tr>
                      ) : (
                        selectedDealerStatements.map((stmt: any) => {
                          const hasOrders = stmt.stockLines && stmt.stockLines.length > 0;
                          return (
                            <tr key={stmt.dayNo} className="hover:bg-slate-900/40">
                              <td className="px-2.5 py-1.5 text-center text-slate-400 font-bold">
                                Day {stmt.dayNo}
                              </td>
                              <td className="px-2.5 py-1.5 text-slate-400 text-[11px]">
                                {stmt.calendarDate || "-"}
                              </td>
                              <td className="px-2 py-1.5 text-right text-slate-300">
                                {stmt.loadIssuance > 0 ? formatRs(stmt.loadIssuance) : "-"}
                              </td>
                              <td className="px-2 py-1.5 text-right text-slate-400">
                                {stmt.loadPayment > 0 ? formatRs(stmt.loadPayment) : "-"}
                              </td>
                              <td className="px-2 py-1.5 text-right font-medium text-sky-400">
                                {formatRs(stmt.loadClosing)}
                              </td>
                              <td className="px-2 py-1.5 text-right text-slate-300">
                                {stmt.stockIssued > 0 ? formatRs(stmt.stockIssued) : "-"}
                              </td>
                              <td className="px-2 py-1.5 text-right text-slate-400">
                                {stmt.stockPayment > 0 ? formatRs(stmt.stockPayment) : "-"}
                              </td>
                              <td className="px-2 py-1.5 text-right font-medium text-amber-400">
                                {formatRs(stmt.stockClosing)}
                              </td>
                              <td
                                className={`px-2.5 py-1.5 text-right font-bold ${
                                  stmt.dailyNetDue > 0 ? "text-rose-400" : stmt.dailyNetDue < 0 ? "text-emerald-400" : "text-slate-400"
                                }`}
                              >
                                {formatRs(stmt.dailyNetDue)}
                              </td>
                              <td className="px-3 py-1.5 font-sans">
                                {hasOrders ? (
                                  <div className="flex flex-wrap gap-1">
                                    {stmt.stockLines.map((line: any, lIdx: number) => (
                                      <span
                                        key={lIdx}
                                        className="inline-flex items-center gap-1 rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300 border border-slate-700"
                                      >
                                        <span className="font-semibold text-white">{line.productName}:</span>
                                        <span>{line.quantity} qty</span>
                                        <span className="text-slate-500">(@ Rs. {line.unitRate})</span>
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-slate-600 text-[11px]">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end pt-2 border-t border-slate-800">
                  <button
                    type="button"
                    onClick={() => setSelectedDealerKey(null)}
                    className="btn-secondary !h-8 text-xs"
                  >
                    Close Statement
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
