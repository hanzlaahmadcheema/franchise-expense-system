import React from "react";
import { CheckCircle2, LoaderCircle, AlertTriangle, AlertCircle, Save, Undo2, ShieldCheck } from "lucide-react";
import { Button } from "./Button";

export type SaveBarStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "offline";

export interface SaveControlBarProps {
  status: SaveBarStatus;
  isDirty: boolean;
  lastSavedAt?: Date | number | null;
  errorMessage?: string | null;
  disabled?: boolean;
  readOnlyNotice?: string;
  onSave?: () => void;
  onVerifySave?: () => void;
  onDiscard?: () => void;
  saveLabel?: string;
  verifyLabel?: string;
  showDiscard?: boolean;
  showVerify?: boolean;
  className?: string;
}

function formatSavedTime(time: Date | number | null | undefined): string {
  if (!time) return "";
  const d = typeof time === "number" ? new Date(time) : time;
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const SaveControlBar: React.FC<SaveControlBarProps> = ({
  status,
  isDirty,
  lastSavedAt,
  errorMessage,
  disabled = false,
  readOnlyNotice,
  onSave,
  onVerifySave,
  onDiscard,
  saveLabel = "Save Entry",
  verifyLabel = "Save & Verify",
  showDiscard = false,
  showVerify = false,
  className = "",
}) => {
  const isSaving = status === "saving";
  const isError = status === "error";
  const isOffline = status === "offline";
  const isSaved = status === "saved";
  const timeStr = formatSavedTime(lastSavedAt);

  // Status indicator and text logic
  let statusIndicator: React.ReactNode;
  let statusText: string;
  let statusTextClass: string = "text-slate-400";

  if (readOnlyNotice) {
    statusIndicator = (
      <span className="h-2.5 w-2.5 rounded-full bg-slate-500" aria-hidden="true" />
    );
    statusText = readOnlyNotice;
    statusTextClass = "text-slate-400 font-medium";
  } else if (isSaving) {
    statusIndicator = (
      <LoaderCircle className="h-4 w-4 animate-spin text-sky-400" aria-hidden="true" />
    );
    statusText = "Posting to PostgreSQL ledger...";
    statusTextClass = "text-sky-300 font-medium";
  } else if (isError) {
    statusIndicator = (
      <AlertCircle className="h-4 w-4 text-rose-400" aria-hidden="true" />
    );
    statusText = errorMessage || "Save failed: Server unreachable";
    statusTextClass = "text-rose-400 font-medium";
  } else if (isOffline) {
    statusIndicator = (
      <AlertTriangle className="h-4 w-4 text-amber-400" aria-hidden="true" />
    );
    statusText = "Working offline: pending sync";
    statusTextClass = "text-amber-300 font-medium";
  } else if (isDirty) {
    statusIndicator = (
      <span className="h-2.5 w-2.5 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
    );
    statusText = "Unsaved entries in draft";
    statusTextClass = "text-amber-300 font-medium";
  } else if (isSaved) {
    statusIndicator = (
      <CheckCircle2 className="h-4 w-4 text-emerald-400" aria-hidden="true" />
    );
    statusText = timeStr ? `Saved to Database at ${timeStr}` : "Saved & verified (HTTP 200)";
    statusTextClass = "text-emerald-400 font-medium";
  } else {
    // Idle / Pristine
    statusIndicator = (
      <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" aria-hidden="true" />
    );
    statusText = timeStr
      ? `All entries verified with server (last: ${timeStr})`
      : "All entries verified with server";
    statusTextClass = "text-slate-400";
  }

  // Save button is active when dirty or on error retry, unless disabled or already saving
  const canSave = !disabled && !isSaving && (isDirty || isError);

  return (
    <div
      role="region"
      aria-label="Save and synchronization status bar"
      className={`sticky bottom-0 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/95 px-4 py-3 shadow-xl shadow-black/40 backdrop-blur-md transition-all ${className}`}
    >
      {/* Left: Status indicator and messaging */}
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <div className="shrink-0 flex items-center justify-center">{statusIndicator}</div>
        <span className={`text-xs md:text-sm truncate ${statusTextClass}`} title={statusText}>
          {statusText}
        </span>
      </div>

      {/* Right: Action buttons */}
      <div className="flex items-center gap-2 shrink-0">
        {showDiscard && onDiscard && isDirty && !isSaving && !disabled && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            icon={<Undo2 className="h-3.5 w-3.5" />}
            title="Discard pending changes"
          >
            Discard
          </Button>
        )}

        {showVerify && onVerifySave && !disabled && (
          <Button
            variant="secondary"
            size="md"
            className="font-bold text-sm"
            onClick={onVerifySave}
            disabled={!canSave}
            icon={<ShieldCheck className="h-4 w-4 text-emerald-400" />}
            title="Save and run ledger integrity checks"
          >
            {verifyLabel}
          </Button>
        )}

        {onSave && (
          <Button
            variant="primary"
            size="sm"
            onClick={onSave}
            disabled={!canSave}
            loading={isSaving}
            loadingText="Saving..."
            icon={!isSaving ? <Save className="h-3.5 w-3.5" /> : undefined}
            title={canSave ? "Save entries to database" : "No pending changes"}
          >
            {isError ? "Retry Save" : saveLabel}
          </Button>
        )}
      </div>
    </div>
  );
};
