import React, { useEffect, useRef, useCallback } from "react";
import { AlertTriangle, AlertCircle, Info, CheckCircle2, X } from "lucide-react";
import { Button } from "./Button";

export type ConfirmVariant = "primary" | "destructive" | "warning";

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  message: React.ReactNode;
  consequence?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
  iconVariant?: "warning" | "destructive" | "info" | "success";
  loading?: boolean;
  loadingText?: string;
  disableEscapeDismiss?: boolean;
  disableBackdropDismiss?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

const iconConfigs = {
  destructive: {
    icon: <AlertCircle className="h-6 w-6 text-rose-400" aria-hidden="true" />,
    bg: "bg-rose-500/10 border-rose-500/20",
  },
  warning: {
    icon: <AlertTriangle className="h-6 w-6 text-amber-400" aria-hidden="true" />,
    bg: "bg-amber-500/10 border-amber-500/20",
  },
  info: {
    icon: <Info className="h-6 w-6 text-sky-400" aria-hidden="true" />,
    bg: "bg-sky-500/10 border-sky-500/20",
  },
  success: {
    icon: <CheckCircle2 className="h-6 w-6 text-emerald-400" aria-hidden="true" />,
    bg: "bg-emerald-500/10 border-emerald-500/20",
  },
};

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  consequence,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "primary",
  iconVariant,
  loading = false,
  loadingText = "Processing...",
  disableEscapeDismiss = false,
  disableBackdropDismiss = false,
  onConfirm,
  onCancel,
}) => {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const dialogCardRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);
  const actionTakenRef = useRef(false);

  const titleId = "confirm-dialog-title";
  const descId = "confirm-dialog-desc";

  // Effective icon variant derived from button variant if not specified
  const effectiveIcon =
    iconVariant ?? (variant === "destructive" ? "destructive" : variant === "warning" ? "warning" : "info");
  const iconConfig = iconConfigs[effectiveIcon] || iconConfigs.info;

  const handleCancel = useCallback(() => {
    if (loading || actionTakenRef.current) return;
    actionTakenRef.current = true;
    onCancel();
  }, [loading, onCancel]);

  const handleConfirm = useCallback(() => {
    if (loading || actionTakenRef.current) return;
    actionTakenRef.current = true;
    void onConfirm();
  }, [loading, onConfirm]);

  const getFocusableElements = useCallback((): HTMLElement[] => {
    if (!dialogCardRef.current) return [];
    const selector =
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const elements = Array.from(dialogCardRef.current.querySelectorAll<HTMLElement>(selector));
    return elements.filter((el) => el.getAttribute("aria-hidden") !== "true");
  }, []);

  // Keyboard navigation: Escape key and Tab focus trap
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (!loading && !disableEscapeDismiss) {
          e.preventDefault();
          handleCancel();
        }
        return;
      }

      if (e.key === "Tab") {
        const focusable = getFocusableElements();
        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const firstElement = focusable[0];
        const lastElement = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === firstElement || !dialogCardRef.current?.contains(document.activeElement)) {
            e.preventDefault();
            lastElement.focus();
          }
        } else {
          if (document.activeElement === lastElement || !dialogCardRef.current?.contains(document.activeElement)) {
            e.preventDefault();
            firstElement.focus();
          }
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, loading, disableEscapeDismiss, handleCancel, getFocusableElements]);

  // Capture previous active element and manage initial focus
  useEffect(() => {
    if (isOpen) {
      actionTakenRef.current = false;
      previousActiveElementRef.current = document.activeElement as HTMLElement | null;

      // Focus the safe Cancel button by default
      if (cancelBtnRef.current) {
        cancelBtnRef.current.focus();
      } else if (dialogCardRef.current) {
        dialogCardRef.current.focus();
      }
    } else {
      // Restore focus to original triggering element upon close
      if (
        previousActiveElementRef.current &&
        typeof previousActiveElementRef.current.focus === "function" &&
        document.contains(previousActiveElementRef.current)
      ) {
        previousActiveElementRef.current.focus();
      }
      previousActiveElementRef.current = null;
      actionTakenRef.current = false;
    }
  }, [isOpen]);

  // Ensure focus is restored if component unmounts while open
  useEffect(() => {
    return () => {
      if (
        previousActiveElementRef.current &&
        typeof previousActiveElementRef.current.focus === "function" &&
        document.contains(previousActiveElementRef.current)
      ) {
        previousActiveElementRef.current.focus();
      }
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      onClick={(e) => {
        if (e.target === e.currentTarget && !loading && !disableBackdropDismiss) {
          handleCancel();
        }
      }}
    >
      <div
        ref={dialogCardRef}
        tabIndex={-1}
        className="w-full max-w-lg rounded-xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl shadow-black/60 outline-none"
      >
        <div className="flex items-start gap-4">
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border ${iconConfig.bg}`}
          >
            {iconConfig.icon}
          </div>

          <div className="flex-1 min-w-0">
            <h3 id={titleId} className="text-lg font-bold text-white">
              {title}
            </h3>
            <div id={descId} className="mt-2 text-sm leading-6 text-slate-300">
              {message}
            </div>

            {consequence && (
              <div className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-xs leading-5 text-amber-200">
                <span className="font-semibold text-amber-300">Accounting Note: </span>
                {consequence}
              </div>
            )}
          </div>

          {!loading && (
            <button
              type="button"
              onClick={handleCancel}
              className="shrink-0 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100 transition"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
          <Button
            ref={cancelBtnRef}
            variant="secondary"
            size="md"
            disabled={loading}
            onClick={handleCancel}
          >
            {cancelText}
          </Button>

          <Button
            variant={variant}
            size="md"
            loading={loading}
            loadingText={loadingText}
            onClick={handleConfirm}
          >
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
};
