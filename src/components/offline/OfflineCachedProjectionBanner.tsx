/**
 * Phase 12C: Offline Cached Projection Banner
 *
 * Renders a clear informational banner whenever balances/projections are loaded
 * from offline cache rather than live confirmed server responses.
 *
 * CRITICAL ACCOUNTING RULE:
 * Explicitly labels figures as read-only cached snapshots from the server.
 * Never allows client code to calculate or commit derived accounting projections.
 */

import React from "react";
import { Info } from "lucide-react";

export interface OfflineCachedProjectionBannerProps {
  cachedAt?: number;
  className?: string;
}

export const OfflineCachedProjectionBanner: React.FC<OfflineCachedProjectionBannerProps> = ({
  cachedAt,
  className = ""
}) => {
  const timeLabel = cachedAt
    ? new Date(cachedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "previous online session";

  return (
    <div
      role="note"
      aria-label="Cached projection notice"
      className={`flex items-center gap-2.5 rounded-xl border border-sky-500/20 bg-sky-500/10 px-4 py-2.5 text-xs text-sky-200 shadow-sm ${className}`}
    >
      <Info className="h-4 w-4 shrink-0 text-sky-400" aria-hidden="true" />
      <div>
        <span className="font-semibold text-sky-100">Viewing Cached Projections: </span>
        <span>
          Balances shown reflect the last server-confirmed state from {timeLabel}. The PostgreSQL backend remains the sole authoritative accounting engine.
        </span>
      </div>
    </div>
  );
};
