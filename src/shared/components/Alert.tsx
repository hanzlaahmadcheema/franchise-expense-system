import React from "react";
import { Info, CheckCircle2, AlertTriangle, AlertCircle, X } from "lucide-react";

export type AlertVariant = "info" | "success" | "warning" | "error";

export interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  message?: React.ReactNode;
  children?: React.ReactNode;
  onClose?: () => void;
  action?: React.ReactNode;
  className?: string;
}

const variantStyles: Record<
  AlertVariant,
  { container: string; icon: string; title: string; defaultIcon: React.ReactNode }
> = {
  info: {
    container: "bg-sky-500/10 border-sky-500/30 text-sky-200",
    icon: "text-sky-400",
    title: "text-sky-300 font-semibold",
    defaultIcon: <Info className="h-5 w-5 shrink-0 text-sky-400" aria-hidden="true" />,
  },
  success: {
    container: "bg-emerald-500/10 border-emerald-500/30 text-emerald-200",
    icon: "text-emerald-400",
    title: "text-emerald-300 font-semibold",
    defaultIcon: <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" aria-hidden="true" />,
  },
  warning: {
    container: "bg-amber-500/10 border-amber-500/30 text-amber-200",
    icon: "text-amber-400",
    title: "text-amber-300 font-semibold",
    defaultIcon: <AlertTriangle className="h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />,
  },
  error: {
    container: "bg-rose-500/10 border-rose-500/30 text-rose-200",
    icon: "text-rose-400",
    title: "text-rose-300 font-semibold",
    defaultIcon: <AlertCircle className="h-5 w-5 shrink-0 text-rose-400" aria-hidden="true" />,
  },
};

export const Alert: React.FC<AlertProps> = ({
  variant = "info",
  title,
  message,
  children,
  onClose,
  action,
  className = "",
}) => {
  const config = variantStyles[variant];
  const content = message || children;

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border p-4 text-sm transition-all ${config.container} ${className}`}
    >
      <div className="shrink-0 mt-0.5">{config.defaultIcon}</div>
      <div className="flex-1 min-w-0">
        {title && <h4 className={`text-sm ${config.title}`}>{title}</h4>}
        {content && <div className={`${title ? "mt-1" : ""} leading-relaxed`}>{content}</div>}
        {action && <div className="mt-3">{action}</div>}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 -mr-1 -mt-1 rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition"
          aria-label="Dismiss alert"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
};
