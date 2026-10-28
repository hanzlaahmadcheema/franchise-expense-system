/**
 * Phase 12C: Global Sync Status Header Pill
 *
 * Provides a persistent status indicator across all application modules:
 * - Color + accessible text labels (never color-only)
 * - Reactive count of pending offline mutations
 * - Interactive button that opens the Queue Inspector modal
 * - Respects the Feature Flag: when OFF, explicitly indicates Direct Mode (Queue Standby)
 *   so users are not misled into believing offline mutation queues are active.
 */

import React, { useState } from "react";
import {
  Cloud,
  CloudOff,
  RefreshCw,
  AlertTriangle,
  XCircle,
  Clock,
  ShieldCheck,
  Shield
} from "lucide-react";
import { useOfflineQueue } from "../../services/offlineQueue/useOfflineQueue";
import { QueueInspectorModal } from "./QueueInspectorModal";
import { ConflictResolutionModal } from "./ConflictResolutionModal";
import type { QueuedMutationRecord } from "../../services/offlineQueue/types";

export interface SyncStatusHeaderPillProps {
  className?: string;
}

export const SyncStatusHeaderPill: React.FC<SyncStatusHeaderPillProps> = ({ className = "" }) => {
  const {
    queueState,
    statusLabel,
    isOnline,
    isQueueEnabled,
    items,
    pendingCount,
    conflictCount,
    retryItem,
    retryAll,
    discardItem,
    clearQueue
  } = useOfflineQueue();

  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [activeConflictRecord, setActiveConflictRecord] = useState<QueuedMutationRecord | null>(null);

  const handleConflictClick = (record: QueuedMutationRecord) => {
    setActiveConflictRecord(record);
  };

  // Determine pill styling based on state
  let pillStyle = "border-slate-700 bg-slate-800/80 text-slate-300 hover:bg-slate-800";
  let dotColor = "bg-slate-400";
  let Icon = Cloud;

  if (!isQueueEnabled) {
    // Feature Flag is OFF: Transparent direct-API indicator
    if (!isOnline) {
      pillStyle = "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20";
      dotColor = "bg-amber-400";
      Icon = CloudOff;
    } else {
      pillStyle = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20";
      dotColor = "bg-emerald-400";
      Icon = ShieldCheck;
    }
  } else {
    // Feature Flag is ON: Full offline queue indicators
    switch (queueState) {
      case "conflict":
        pillStyle = "border-rose-500/40 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30";
        dotColor = "bg-rose-400";
        Icon = AlertTriangle;
        break;
      case "failed_governance":
        pillStyle = "border-orange-500/40 bg-orange-500/20 text-orange-200 hover:bg-orange-500/30";
        dotColor = "bg-orange-400";
        Icon = AlertTriangle;
        break;
      case "failed_fatal":
        pillStyle = "border-red-500/40 bg-red-500/20 text-red-200 hover:bg-red-500/30";
        dotColor = "bg-red-400";
        Icon = XCircle;
        break;
      case "syncing":
        pillStyle = "border-sky-500/40 bg-sky-500/20 text-sky-200 hover:bg-sky-500/30";
        dotColor = "bg-sky-400";
        Icon = RefreshCw;
        break;
      case "pending":
        pillStyle = "border-amber-500/40 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30";
        dotColor = "bg-amber-400";
        Icon = Clock;
        break;
      case "offline":
        pillStyle = "border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700";
        dotColor = "bg-slate-400";
        Icon = CloudOff;
        break;
      case "synced":
      default:
        pillStyle = "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20";
        dotColor = "bg-emerald-400";
        Icon = ShieldCheck;
        break;
    }
  }

  return (
    <>
      <button
        type="button"
        role="button"
        aria-label={`Sync status: ${statusLabel}. Click to open queue inspector.`}
        onClick={() => setInspectorOpen(true)}
        className={`group flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-all shadow-sm ${pillStyle} ${className}`}
      >
        <span className="relative flex h-2 w-2">
          {queueState === "syncing" && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${dotColor}`} />
          )}
          <span className={`relative inline-flex h-2 w-2 rounded-full ${dotColor}`} />
        </span>

        <Icon className={`h-3.5 w-3.5 ${queueState === "syncing" ? "animate-spin" : ""}`} aria-hidden="true" />

        <span className="truncate">{statusLabel}</span>

        {isQueueEnabled && pendingCount > 0 && (
          <span className="ml-1 rounded-full bg-amber-500/30 px-1.5 py-0.2 text-[10px] font-bold text-amber-200">
            {pendingCount}
          </span>
        )}

        {isQueueEnabled && conflictCount > 0 && (
          <span className="ml-1 rounded-full bg-rose-500/30 px-1.5 py-0.2 text-[10px] font-bold text-rose-200">
            {conflictCount}
          </span>
        )}
      </button>

      {/* Queue Inspector Modal */}
      <QueueInspectorModal
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        items={items}
        isOnline={isOnline}
        isQueueEnabled={isQueueEnabled}
        onRetryItem={retryItem}
        onRetryAll={retryAll}
        onDiscardItem={discardItem}
        onOpenConflict={handleConflictClick}
        onClearQueue={clearQueue}
      />

      {/* Conflict Resolution Modal */}
      {activeConflictRecord && (
        <ConflictResolutionModal
          record={activeConflictRecord}
          onClose={() => setActiveConflictRecord(null)}
          onRetry={(record) => {
            void retryItem(record.id);
            setActiveConflictRecord(null);
          }}
          onDiscard={(record) => {
            void discardItem(record.id);
            setActiveConflictRecord(null);
          }}
        />
      )}
    </>
  );
};
