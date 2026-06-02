import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import type { AutoSaveStatus, UniversalDayControlBarProps } from "../types/dayControl.types";
import { statusChipClass, statusLabel } from "../services/dayStatusService";

function autoSaveText(status?: AutoSaveStatus) {
  if (status === "saving") return "Saving...";
  if (status === "saved") return "Saved";
  if (status === "pendingSync") return "Pending sync";
  if (status === "error") return "Error saving";
  if (status === "readOnly") return "Read-only";
  if (status === "closed") return "Closed day";
  if (status === "unsaved") return "Unsaved changes";
  return "Ready";
}

function ActionButton({
  children,
  disabled,
  reason,
  onClick,
  primary,
  compact
}: {
  children: ReactNode;
  disabled?: boolean;
  reason?: string;
  onClick: () => void | Promise<void>;
  primary?: boolean;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${primary ? "btn-primary" : "btn-secondary"} w-full ${compact ? "!h-9 !justify-start !px-2 text-xs" : "sm:w-auto"}`}
      disabled={disabled}
      title={disabled ? reason : undefined}
      onClick={() => void onClick()}
    >
      {children}
    </button>
  );
}

export function UniversalDayControlBar({
  selectedDateLabel,
  selectedMonthLabel,
  selectedStatus,
  role,
  permissions,
  autoSaveStatus,
  busy,
  density = "regular",
  onCloseSelectedDay,
  onReopenSelectedDay,
  onReopenAllDays,
  onClosePreviousDaysExceptToday,
  onRunMasterRefresh,
  extraActions
}: UniversalDayControlBarProps) {
  const compact = density === "compact";
  return (
    <div className={`${compact ? "mt-3 space-y-2" : "mt-4 space-y-3"}`}>
      <div className={`flex flex-wrap items-center gap-2 ${compact ? "text-xs" : "text-sm"} text-slate-300`}>
        {/* <span className="btn-chip">{selectedMonthLabel}</span>
        <span className="btn-chip">{selectedDateLabel}</span> */}
        <span className={`btn-chip ${statusChipClass(selectedStatus)}`}>
          {statusLabel(selectedStatus)}
        </span>
        {/* <span className="btn-chip">Role: {role ?? "viewer"}</span> */}
        <span className="btn-chip">{autoSaveText(autoSaveStatus)}</span>
      </div>
      <div className={`${compact ? "flex flex-col" : "flex flex-col sm:flex-row sm:flex-wrap"} gap-2`}>
        {extraActions}
        <ActionButton
          disabled={busy || !permissions.canRunMasterRefresh}
          reason={permissions.masterRefreshDisabledReason ?? "Owner or admin access is required."}
          onClick={onRunMasterRefresh}
          compact={compact}
        >
          {busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Master Refresh Calculations
        </ActionButton>
        <ActionButton
          disabled={busy || !permissions.canReopenSelectedDay}
          reason={permissions.reopenDisabledReason ?? "This day cannot be reopened."}
          onClick={onReopenSelectedDay}
          compact={compact}
        >
          Reopen Selected Day
        </ActionButton>
        <ActionButton
          disabled={busy || !permissions.canReopenAllDays}
          reason={permissions.reopenAllDisabledReason ?? "Only owner can reopen all days."}
          onClick={onReopenAllDays}
          compact={compact}
        >
          Reopen All Days
        </ActionButton>
        <ActionButton
          disabled={busy || !permissions.canClosePreviousDaysExceptToday}
          reason={permissions.closePreviousDisabledReason ?? "Only owner can close previous days."}
          onClick={onClosePreviousDaysExceptToday}
          compact={compact}
        >
          Close All Previous Days Except Today
        </ActionButton>
        <ActionButton
          primary
          disabled={busy || !permissions.canCloseSelectedDay}
          reason={permissions.closeDisabledReason ?? "This day cannot be closed."}
          onClick={onCloseSelectedDay}
          compact={compact}
        >
          Close Day
        </ActionButton>
      </div>
    </div>
  );
}
