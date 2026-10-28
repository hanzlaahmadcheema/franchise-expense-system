/**
 * Phase 12C: Conflict Resolution Modal
 *
 * Provides strictly manual conflict review for mutations that returned HTTP 409:
 * - Displays affected domain and entity details
 * - Displays pending local facts vs. current server state
 * - Displays conflict reason and mutation timestamp
 * - Explicit actions: "Retry / Rebase" or "Discard Local Mutation"
 *
 * CRITICAL ACCOUNTING RULE:
 * NEVER silently overwrite server data, auto-merge fields, or discard local facts.
 * User must explicitly choose between retrying or discarding.
 */

import React from "react";
import { AlertTriangle, X, RefreshCw, Trash2 } from "lucide-react";
import type { QueuedMutationRecord } from "../../services/offlineQueue/types";

export interface ConflictResolutionModalProps {
  record: QueuedMutationRecord | null;
  serverEntity?: Record<string, unknown> | null;
  onRetry: (record: QueuedMutationRecord) => void;
  onDiscard: (record: QueuedMutationRecord) => void;
  onClose: () => void;
}

export const ConflictResolutionModal: React.FC<ConflictResolutionModalProps> = ({
  record,
  serverEntity,
  onRetry,
  onDiscard,
  onClose
}) => {
  if (!record) return null;

  const formattedDate = new Date(record.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div className="relative w-full max-w-2xl rounded-2xl border border-rose-500/30 bg-slate-950 p-6 text-slate-100 shadow-2xl">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-rose-500/20 text-rose-400">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <h2 id="conflict-modal-title" className="text-lg font-semibold text-white">
                Concurrency Conflict Detected
              </h2>
              <p className="text-xs text-slate-400">
                Period {record.periodKey} · Day {record.dayNo} · Enqueued at {formattedDate}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close modal"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Conflict Reason Banner */}
        <div className="my-4 rounded-xl border border-rose-500/20 bg-rose-500/10 p-3.5 text-xs text-rose-200">
          <span className="font-semibold">Reason: </span>
          {record.lastError?.message ??
            "The record was modified by another user or session while you were offline. Manual review is required."}
          <div className="mt-1 text-[11px] text-rose-300/80">
            Target: <span className="font-mono">{record.entityType}</span> · Action:{" "}
            <span className="font-mono">{record.action}</span> · Client Base Revision:{" "}
            <span className="font-mono">{record.baseRevision ?? "None"}</span>
          </div>
        </div>

        {/* Side-by-Side Comparison */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* User's Local Facts */}
          <div className="rounded-xl border border-amber-500/20 bg-slate-900/80 p-4">
            <div className="mb-2 flex items-center justify-between border-b border-slate-800 pb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-amber-300">
                Your Local Changes (Pending)
              </h3>
              <span className="text-[10px] text-slate-400 font-mono">Offline Facts</span>
            </div>
            <div className="max-h-56 overflow-y-auto font-mono text-xs">
              <pre className="whitespace-pre-wrap text-slate-300">
                {JSON.stringify(record.rawPayload, null, 2)}
              </pre>
            </div>
          </div>

          {/* Current Server State */}
          <div className="rounded-xl border border-sky-500/20 bg-slate-900/80 p-4">
            <div className="mb-2 flex items-center justify-between border-b border-slate-800 pb-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-sky-300">
                Current Server State
              </h3>
              <span className="text-[10px] text-slate-400 font-mono">
                {serverEntity ? `Rev ${serverEntity.revision ?? "?"}` : "Unavailable"}
              </span>
            </div>
            <div className="max-h-56 overflow-y-auto font-mono text-xs">
              {serverEntity ? (
                <pre className="whitespace-pre-wrap text-slate-300">
                  {JSON.stringify(serverEntity, null, 2)}
                </pre>
              ) : (
                <p className="py-4 text-center text-xs text-slate-500 italic">
                  Server state could not be loaded or record does not exist.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Governance Notice */}
        <p className="mt-4 text-[11px] text-slate-400">
          <strong className="text-slate-300">Strict Safety Rule:</strong> Automatic merging is disabled to protect accounting integrity. You can choose to re-attempt sync (which rebases onto the latest server revision) or discard your local uncommitted edits.
        </p>

        {/* Action Buttons */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-slate-800 pt-4">
          <button
            type="button"
            onClick={() => onDiscard(record)}
            className="flex items-center gap-1.5 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
          >
            <Trash2 className="h-4 w-4" />
            Discard Local Mutation
          </button>
          <button
            type="button"
            onClick={() => onRetry(record)}
            className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-xs font-medium text-slate-950 shadow-md hover:bg-amber-400"
          >
            <RefreshCw className="h-4 w-4" />
            Retry My Mutation
          </button>
        </div>
      </div>
    </div>
  );
};
