import React from "react";
import { LoaderCircle, AlertCircle, FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "./Button";

export interface LoadingStateProps {
  title?: string;
  description?: string;
  compact?: boolean;
  className?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = ({
  title = "Loading...",
  description,
  compact = false,
  className = "",
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "py-6 px-4" : "py-16 px-6"
      } ${className}`}
      role="status"
    >
      <LoaderCircle className="h-8 w-8 animate-spin text-emerald-400" aria-hidden="true" />
      <h3 className="mt-3 text-sm font-semibold text-slate-200">{title}</h3>
      {description && <p className="mt-1 text-xs text-slate-400 max-w-sm">{description}</p>}
    </div>
  );
};

export interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
  retryText?: string;
  compact?: boolean;
  className?: string;
}

export const ErrorState: React.FC<ErrorStateProps> = ({
  title = "Failed to load data",
  description = "An error occurred while loading ledger records. Please try again.",
  onRetry,
  retryText = "Try Again",
  compact = false,
  className = "",
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "py-6 px-4" : "py-16 px-6"
      } ${className}`}
      role="alert"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-rose-500/20 bg-rose-500/10 text-rose-400">
        <AlertCircle className="h-6 w-6" aria-hidden="true" />
      </div>
      <h3 className="mt-3 text-sm font-semibold text-rose-200">{title}</h3>
      {description && <p className="mt-1 text-xs text-slate-400 max-w-md">{description}</p>}
      {onRetry && (
        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={onRetry}
            icon={<RefreshCw className="h-3.5 w-3.5" />}
          >
            {retryText}
          </Button>
        </div>
      )}
    </div>
  );
};

export interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  onAction?: () => void;
  actionLabel?: string;
  compact?: boolean;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title = "No records found",
  description,
  icon,
  action,
  onAction,
  actionLabel = "Add Record",
  compact = false,
  className = "",
}) => {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "py-6 px-4" : "py-16 px-6"
      } ${className}`}
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-800 bg-slate-900/60 text-slate-400">
        {icon || <FolderOpen className="h-6 w-6" aria-hidden="true" />}
      </div>
      <h3 className="mt-3 text-sm font-semibold text-slate-200">{title}</h3>
      {description && <p className="mt-1 text-xs text-slate-400 max-w-sm">{description}</p>}
      {action ? (
        <div className="mt-4">{action}</div>
      ) : onAction ? (
        <div className="mt-4">
          <Button variant="primary" size="sm" onClick={onAction}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
