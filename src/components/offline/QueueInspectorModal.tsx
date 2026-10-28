/**
 * Phase 12C: Offline Queue Inspector Modal
 *
 * Provides full administrative and operational visibility into queued offline mutations:
 * - Summary statistics (Pending, Conflicts, Governance, Fatal, Paused Auth)
 * - Detailed table/list of all queued records
 * - Status badges and attempt counts
 * - Safe actions: Retry item, Retry All, Discard item, Open Conflict Details
 *
 * CRITICAL SAFETY RULES:
 * 1. Does NOT display authentication tokens or sensitive credentials.
 * 2. Does NOT allow arbitrary mutation payload tampering/editing.
 * 3. Does NOT provide a "force sync" bypass that skips server calculation authority.
 */

import React from "react";
import {
  X,
  RefreshCw,
  Trash2,
  AlertTriangle,
  Clock,
  Shield,
  Layers,
  AlertCircle
} from "lucide-react";
import type { QueuedMutationRecord } from "../../services/offlineQueue/types";
import { InFormPendingBadge } from "./InFormPendingBadge";

export interface QueueInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: QueuedMutationRecord[];
  isOnline: boolean;
  isQueueEnabled: boolean;
  onRetryItem: (id: string) => void;
  onRetryAll: () => void;
  onDiscardItem: (id: string) => void;
  onOpenConflict: (record: QueuedMutationRecord) => void;
  onClearQueue: () => void;
}

export const QueueInspectorModal: React.FC<QueueInspectorModalProps> = ({
  isOpen,
  onClose,
  items,
  isOnline,
  isQueueEnabled,
  onRetryItem,
  onRetryAll,
  onDiscardItem,
  onOpenConflict,
  onClearQueue
}) => {
  if (!isOpen) return null;

  const pendingItems = items.filter((i) => i.status === "queued" || i.status === "sending");
  const conflictItems = items.filter((i) => i.status === "conflict");
  const governanceItems = items.filter((i) => i.status === "failed_governance");
  const fatalItems = items.filter((i) => i.status === "failed_fatal");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="queue-inspector-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
    >
      <div className="relative flex max-h-[90vh] w-full max-w-4xl flex-col rounded-2xl border border-slate-800 bg-slate-950 text-slate-100 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 p-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-slate-300">
              <Layers className="h-5 w-5" />
            </div>
            <div>
              <h2 id="queue-inspector-title" className="text-base font-semibold text-white">
                Offline Mutation Queue Inspector
              </h2>
              <p className="text-xs text-slate-400">
                Connection:{" "}
                <span className={isOnline ? "font-semibold text-emerald-400" : "font-semibold text-amber-400"}>
                  {isOnline ? "Online" : "Offline"}
                </span>{" "}
                · Feature Flag:{" "}
                <span className={isQueueEnabled ? "font-semibold text-sky-400" : "font-semibold text-slate-500"}>
                  {isQueueEnabled ? "Enabled" : "Disabled (Standby Mode)"}
                </span>
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close inspector"
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Feature Flag Notice when Disabled */}
        {!isQueueEnabled && (
          <div className="flex items-center gap-2.5 border-b border-slate-800 bg-slate-900/60 px-5 py-2.5 text-xs text-slate-400">
            <Shield className="h-4 w-4 text-slate-500" />
            <span>
              Queue feature flag is currently <strong>OFF</strong>. Production operational mutations submit directly to PostgreSQL REST APIs.
            </span>
          </div>
        )}

        {/* Metrics Summary Bar */}
        <div className="grid grid-cols-2 gap-3 border-b border-slate-800 bg-slate-900/40 p-4 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
            <span className="text-[11px] font-medium text-slate-400 uppercase">Pending</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-amber-300">{pendingItems.length}</span>
              <span className="text-xs text-slate-500">items</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
            <span className="text-[11px] font-medium text-slate-400 uppercase">Conflicts</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-rose-400">{conflictItems.length}</span>
              <span className="text-xs text-slate-500">items</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
            <span className="text-[11px] font-medium text-slate-400 uppercase">Governance</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-orange-400">{governanceItems.length}</span>
              <span className="text-xs text-slate-500">closed days</span>
            </div>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-3">
            <span className="text-[11px] font-medium text-slate-400 uppercase">Fatal Errors</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-xl font-bold text-red-400">{fatalItems.length}</span>
              <span className="text-xs text-slate-500">errors</span>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
          <div className="text-xs text-slate-400">
            Total Records in Storage: <strong className="text-white">{items.length}</strong>
          </div>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={onRetryAll}
                  disabled={!isOnline}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Retry All Eligible
                </button>
                <button
                  type="button"
                  onClick={onClearQueue}
                  className="flex items-center gap-1.5 rounded-lg border border-rose-500/20 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  Clear All
                </button>
              </>
            )}
          </div>
        </div>

        {/* Queue Items List */}
        <div className="flex-1 overflow-y-auto p-5">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-slate-500">
              <Clock className="mb-3 h-10 w-10 text-slate-600" />
              <p className="text-sm font-medium text-slate-400">The mutation queue is empty.</p>
              <p className="mt-1 text-xs">All changes have been successfully committed to PostgreSQL.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {items.map((record) => {
                const timeString = new Date(record.createdAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit"
                });

                return (
                  <div
                    key={record.id}
                    className="flex flex-col justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4 transition-colors hover:border-slate-700 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <InFormPendingBadge status={record.status} />
                        <span className="font-mono text-xs font-semibold text-white uppercase">
                          {record.domain} · {record.entityType}
                        </span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-400">
                          {record.action}
                        </span>
                      </div>

                      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                        <span>
                          Period: <strong className="text-slate-300">{record.periodKey}</strong>
                        </span>
                        <span>
                          Day: <strong className="text-slate-300">{record.dayNo}</strong>
                        </span>
                        <span>
                          Time: <strong className="text-slate-300">{timeString}</strong>
                        </span>
                        <span>
                          Attempts: <strong className="text-slate-300">{record.attemptCount}</strong>
                        </span>
                      </div>

                      {record.lastError && (
                        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-rose-500/10 px-2.5 py-1 text-xs text-rose-300">
                          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                          <span className="truncate">{record.lastError.message}</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 sm:self-center">
                      {record.status === "conflict" && (
                        <button
                          type="button"
                          onClick={() => onOpenConflict(record)}
                          className="flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/20 px-2.5 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/30"
                        >
                          <AlertTriangle className="h-3.5 w-3.5" />
                          Resolve
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRetryItem(record.id)}
                        disabled={!isOnline}
                        title="Retry sending this mutation"
                        className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-50"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onDiscardItem(record.id)}
                        title="Discard this uncommitted mutation"
                        className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-1.5 text-rose-400 hover:bg-rose-500/20 hover:text-rose-300"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-slate-800 bg-slate-900/50 p-4 text-xs text-slate-500">
          <span>Server calculation engine is strictly authoritative. Mutations persist locally until acknowledged.</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-2 text-xs font-medium text-white hover:bg-slate-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
