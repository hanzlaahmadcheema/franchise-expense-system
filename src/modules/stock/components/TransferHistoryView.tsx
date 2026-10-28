import React, { useState, useEffect, useCallback } from "react";
import {
  History,
  RotateCcw,
  RefreshCw,
  Search,
  Filter,
  CheckCircle2,
  Clock,
  ArrowRight,
  AlertCircle
} from "lucide-react";
import {
  ledgerApiClient,
  type StockBalanceTransferRecord
} from "../../../services/api/ledgerApiClient";
import type { StockAccountProfile } from "../types/stock.types";
import { formatMoney } from "../utils/stockFormatters";

export interface TransferHistoryViewProps {
  dayId?: string;
  accounts: StockAccountProfile[];
  onReverseClick: (transfer: StockBalanceTransferRecord) => void;
  canReverse?: boolean;
  refreshTrigger?: number;
}

export function TransferHistoryView({
  dayId,
  accounts,
  onReverseClick,
  canReverse = true,
  refreshTrigger = 0
}: TransferHistoryViewProps) {
  const [transfers, setTransfers] = useState<StockBalanceTransferRecord[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterScope, setFilterScope] = useState<"day" | "all">(dayId ? "day" : "all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  const loadTransfers = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage(null);

    try {
      const params = filterScope === "day" && dayId ? { day_id: dayId } : undefined;
      const res = await ledgerApiClient.stockTransfers.list(params);
      setTransfers(res.data || []);
    } catch (err: any) {
      console.error("[TransferHistoryView] Failed to load transfers:", err);
      setErrorMessage(err.message || "Failed to load transfer history.");
    } finally {
      setIsLoading(false);
    }
  }, [filterScope, dayId]);

  useEffect(() => {
    void loadTransfers();
  }, [loadTransfers, refreshTrigger]);

  const accountMap = new Map(accounts.map((a) => [a.id, a.name]));

  const filteredTransfers = transfers.filter((t) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const sourceName = (accountMap.get(t.source_account_id) || "").toLowerCase();
    const destName = (accountMap.get(t.destination_account_id) || "").toLowerCase();
    const reason = (t.reason || "").toLowerCase();
    const amount = String(t.amount);
    return (
      sourceName.includes(q) ||
      destName.includes(q) ||
      reason.includes(q) ||
      amount.includes(q)
    );
  });

  return (
    <div className="space-y-3">
      {/* Controls Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800">
        <div className="flex items-center gap-2">
          {dayId && (
            <div className="flex gap-1 bg-slate-900 p-0.5 rounded border border-slate-800 text-xs">
              <button
                type="button"
                className={`px-2.5 py-1 rounded transition-colors ${
                  filterScope === "day"
                    ? "bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                onClick={() => setFilterScope("day")}
              >
                Selected Day
              </button>
              <button
                type="button"
                className={`px-2.5 py-1 rounded transition-colors ${
                  filterScope === "all"
                    ? "bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30"
                    : "text-slate-400 hover:text-slate-200"
                }`}
                onClick={() => setFilterScope("all")}
              >
                All Transfers
              </button>
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
            <input
              type="text"
              className="bg-slate-900 border border-slate-800 rounded pl-8 pr-3 py-1 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-slate-700 w-48 sm:w-60"
              placeholder="Search person or note…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex items-center gap-2 justify-end">
          <span className="text-[11px] text-slate-500">
            {filteredTransfers.length} {filteredTransfers.length === 1 ? "record" : "records"}
          </span>
          <button
            type="button"
            className="btn-secondary !h-7 !px-2 text-xs flex items-center gap-1 text-slate-400 hover:text-white"
            onClick={() => void loadTransfers()}
            disabled={isLoading}
            title="Refresh transfer list"
          >
            <RefreshCw className={`h-3 w-3 ${isLoading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Error state */}
      {errorMessage && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-950/20 p-3 text-xs text-rose-300 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="py-8 text-center text-xs text-slate-500 flex flex-col items-center gap-2">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span>Loading transfer history…</span>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && filteredTransfers.length === 0 && (
        <div className="rounded-lg border border-slate-800/80 bg-slate-950/20 py-8 px-4 text-center">
          <History className="h-8 w-8 text-slate-600 mx-auto mb-2" />
          <p className="text-xs font-semibold text-slate-300">No Stock Balance Transfers Found</p>
          <p className="text-[11px] text-slate-500 mt-1 max-w-sm mx-auto">
            {searchQuery
              ? `No transfer matches search query "${searchQuery}".`
              : filterScope === "day"
              ? "No balance transfers have been recorded for this accounting day."
              : "No balance transfers recorded in this franchise."}
          </p>
        </div>
      )}

      {/* Table */}
      {!isLoading && filteredTransfers.length > 0 && (
        <div className="table-wrap border border-slate-800 rounded-lg max-h-72 overflow-y-auto">
          <table className="!text-xs">
            <thead className="sticky top-0 bg-slate-950/90 backdrop-blur z-10">
              <tr>
                <th>Date & Time</th>
                <th>Source</th>
                <th>Destination</th>
                <th>Amount</th>
                <th>Type</th>
                <th>Reason</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredTransfers.map((t) => {
                const sourceName = accountMap.get(t.source_account_id) || "Unknown";
                const destName = accountMap.get(t.destination_account_id) || "Unknown";
                const isReversed = t.status === "reversed";
                const isReversalRecord = Boolean(t.reversal_of_id);
                const dateStr = t.created_at
                  ? new Date(t.created_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit"
                    })
                  : "—";

                return (
                  <tr key={t.id} className={isReversed ? "opacity-60 bg-slate-950/20" : isReversalRecord ? "bg-purple-950/10" : ""}>
                    <td className="whitespace-nowrap text-slate-400 font-mono text-[11px]">
                      {dateStr}
                    </td>
                    <td className="font-semibold text-slate-200">{sourceName}</td>
                    <td className="font-semibold text-slate-200">{destName}</td>
                    <td className="font-mono font-bold text-emerald-400 whitespace-nowrap">
                      Rs. {formatMoney(Number(t.amount))}
                    </td>
                    <td className="uppercase text-[10px] font-semibold text-slate-400">
                      {t.transfer_type || "credit"}
                    </td>
                    <td className="max-w-[140px] truncate text-slate-300" title={t.reason}>
                      {t.reason || "—"}
                    </td>
                    <td>
                      {isReversalRecord ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-purple-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-purple-300 border border-purple-500/30">
                          <RotateCcw className="h-2.5 w-2.5" />
                          Reversal Record
                        </span>
                      ) : isReversed ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-400 border border-slate-700">
                          <RotateCcw className="h-2.5 w-2.5" />
                          Reversed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/30">
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Completed
                        </span>
                      )}
                    </td>
                    <td className="text-right whitespace-nowrap">
                      {isReversalRecord ? (
                        <span className="text-[10px] text-purple-400/80 italic">Reversal Record</span>
                      ) : !isReversed ? (
                        <button
                          type="button"
                          className="btn-secondary !h-6 !px-2 text-[11px] text-amber-300 border-amber-500/30 hover:bg-amber-500/10 font-medium inline-flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                          disabled={!canReverse}
                          title={!canReverse ? "Admin/Owner authorization required to reverse" : "Reverse this transfer"}
                          onClick={() => onReverseClick(t)}
                        >
                          <RotateCcw className="h-3 w-3" />
                          <span>Reverse</span>
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-500 italic">Reversed</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
