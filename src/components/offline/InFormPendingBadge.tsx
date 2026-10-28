/**
 * Phase 12C: In-Form Pending Badge Component
 *
 * Reusable visual indicator for form records/rows that have pending, in-flight,
 * conflicting, or failed offline mutations.
 *
 * CRITICAL ACCOUNTING RULE:
 * A pending item is NEVER presented as a confirmed server-authoritative ledger record.
 * Visually distinguishes unconfirmed local state from server-confirmed records.
 */

import React from "react";
import { Clock, LoaderCircle, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import type { MutationQueueStatus } from "../../services/offlineQueue/types";

export interface InFormPendingBadgeProps {
  status: MutationQueueStatus;
  label?: string;
  className?: string;
  onClick?: () => void;
}

export const InFormPendingBadge: React.FC<InFormPendingBadgeProps> = ({
  status,
  label,
  className = "",
  onClick
}) => {
  switch (status) {
    case "queued":
      return (
        <span
          role="status"
          aria-label="Pending locally — not yet confirmed by server"
          className={`inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300 shadow-sm ${className}`}
          onClick={onClick}
        >
          <Clock className="h-3 w-3 animate-pulse text-amber-400" aria-hidden="true" />
          <span>{label ?? "Pending locally"}</span>
        </span>
      );

    case "sending":
      return (
        <span
          role="status"
          aria-label="Syncing to PostgreSQL server"
          className={`inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-medium text-sky-300 shadow-sm ${className}`}
          onClick={onClick}
        >
          <LoaderCircle className="h-3 w-3 animate-spin text-sky-400" aria-hidden="true" />
          <span>{label ?? "Syncing..."}</span>
        </span>
      );

    case "synced":
      return (
        <span
          role="status"
          aria-label="Confirmed by PostgreSQL server"
          className={`inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300 shadow-sm ${className}`}
          onClick={onClick}
        >
          <CheckCircle2 className="h-3 w-3 text-emerald-400" aria-hidden="true" />
          <span>{label ?? "Server Confirmed"}</span>
        </span>
      );

    case "conflict":
      return (
        <button
          type="button"
          role="status"
          aria-label="Concurrency conflict detected — action required"
          className={`inline-flex cursor-pointer items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/20 px-2.5 py-0.5 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/30 ${className}`}
          onClick={onClick}
        >
          <AlertTriangle className="h-3 w-3 text-rose-400" aria-hidden="true" />
          <span>{label ?? "Conflict — Review"}</span>
        </button>
      );

    case "failed_governance":
      return (
        <button
          type="button"
          role="status"
          aria-label="Accounting day was closed on server"
          className={`inline-flex cursor-pointer items-center gap-1 rounded-full border border-orange-500/40 bg-orange-500/20 px-2.5 py-0.5 text-[11px] font-medium text-orange-200 transition-colors hover:bg-orange-500/30 ${className}`}
          onClick={onClick}
        >
          <AlertTriangle className="h-3 w-3 text-orange-400" aria-hidden="true" />
          <span>{label ?? "Day Closed on Server"}</span>
        </button>
      );

    case "failed_fatal":
    default:
      return (
        <button
          type="button"
          role="status"
          aria-label="Sync failed"
          className={`inline-flex cursor-pointer items-center gap-1 rounded-full border border-red-500/40 bg-red-500/20 px-2.5 py-0.5 text-[11px] font-medium text-red-200 transition-colors hover:bg-red-500/30 ${className}`}
          onClick={onClick}
        >
          <XCircle className="h-3 w-3 text-red-400" aria-hidden="true" />
          <span>{label ?? "Sync Failed"}</span>
        </button>
      );
  }
};
