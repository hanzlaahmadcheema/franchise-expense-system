import React from "react";

export type StatusType =
  | "open"
  | "closed"
  | "reopened"
  | "locked"
  | "future"
  | "synced"
  | "syncing"
  | "error"
  | "offline"
  | "verified"
  | "pending"
  | "dirty"
  | "info";

export type BadgeSize = "xs" | "sm" | "md";

export interface StatusBadgeProps {
  status: StatusType;
  label?: string;
  size?: BadgeSize;
  withDot?: boolean;
  pulseDot?: boolean;
  className?: string;
}

interface StatusConfig {
  defaultLabel: string;
  badgeClass: string;
  dotClass: string;
}

const statusConfigs: Record<StatusType, StatusConfig> = {
  open: {
    defaultLabel: "OPEN",
    badgeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    dotClass: "bg-emerald-400",
  },
  closed: {
    defaultLabel: "CLOSED",
    badgeClass: "bg-rose-500/10 text-rose-400 border-rose-500/30",
    dotClass: "bg-rose-400",
  },
  reopened: {
    defaultLabel: "REOPENED",
    badgeClass: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    dotClass: "bg-blue-400",
  },
  locked: {
    defaultLabel: "LOCKED",
    badgeClass: "bg-slate-800/80 text-slate-400 border-slate-700",
    dotClass: "bg-slate-400",
  },
  future: {
    defaultLabel: "FUTURE",
    badgeClass: "bg-slate-800/80 text-slate-400 border-slate-700",
    dotClass: "bg-slate-400",
  },
  synced: {
    defaultLabel: "SYNCED",
    badgeClass: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    dotClass: "bg-emerald-400",
  },
  syncing: {
    defaultLabel: "SYNCING",
    badgeClass: "bg-blue-500/10 text-blue-400 border-blue-500/30",
    dotClass: "bg-blue-400",
  },
  error: {
    defaultLabel: "ERROR",
    badgeClass: "bg-rose-500/10 text-rose-400 border-rose-500/30",
    dotClass: "bg-rose-400",
  },
  offline: {
    defaultLabel: "OFFLINE",
    badgeClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    dotClass: "bg-amber-400",
  },
  verified: {
    defaultLabel: "VERIFIED",
    badgeClass: "bg-teal-500/10 text-teal-400 border-teal-500/30",
    dotClass: "bg-teal-400",
  },
  pending: {
    defaultLabel: "PENDING",
    badgeClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    dotClass: "bg-amber-400",
  },
  dirty: {
    defaultLabel: "UNSAVED",
    badgeClass: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    dotClass: "bg-amber-400",
  },
  info: {
    defaultLabel: "INFO",
    badgeClass: "bg-sky-500/10 text-sky-400 border-sky-500/30",
    dotClass: "bg-sky-400",
  },
};

const sizeClasses: Record<BadgeSize, { badge: string; dot: string; text: string }> = {
  xs: {
    badge: "px-2 py-0.5 text-[10px] gap-1 rounded-md",
    dot: "h-1.5 w-1.5",
    text: "font-semibold tracking-wider uppercase",
  },
  sm: {
    badge: "px-2.5 py-0.5 text-xs gap-1.5 rounded-full",
    dot: "h-2 w-2",
    text: "font-semibold tracking-wider uppercase",
  },
  md: {
    badge: "px-3 py-1 text-xs gap-2 rounded-full",
    dot: "h-2.5 w-2.5",
    text: "font-bold tracking-wider uppercase",
  },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  label,
  size = "sm",
  withDot = true,
  pulseDot = false,
  className = "",
}) => {
  const config = statusConfigs[status] || statusConfigs.info;
  const sizeConfig = sizeClasses[size];
  const displayLabel = label ?? config.defaultLabel;

  return (
    <span
      className={`inline-flex items-center border font-mono select-none ${config.badgeClass} ${sizeConfig.badge} ${className}`}
      role="status"
    >
      {withDot && (
        <span
          className={`shrink-0 rounded-full ${config.dotClass} ${sizeConfig.dot} ${
            pulseDot || status === "syncing" ? "animate-pulse" : ""
          }`}
          aria-hidden="true"
        />
      )}
      <span className={sizeConfig.text}>{displayLabel}</span>
    </span>
  );
};
