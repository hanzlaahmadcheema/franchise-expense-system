import { CheckCircle2, AlertTriangle, LoaderCircle, X, ArrowRight } from "lucide-react";

export interface GuidedMonthCloseModalProps {
  isOpen: boolean;
  step: "prompt" | "success";
  monthId: string;
  nextMonthId: string;
  isClosing?: boolean;
  errorMessage?: string | null;
  onCloseMonth: () => void | Promise<void>;
  onNotNow: () => void;
  onProceedToNextMonth?: () => void;
  onDismiss?: () => void;
}

function formatMonthLabel(monthKey: string): string {
  const [yearText, monthText] = monthKey.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, 1);
  if (Number.isNaN(date.getTime())) return monthKey;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
}

function getMonthNameOnly(monthKey: string): string {
  const formatted = formatMonthLabel(monthKey);
  return formatted.split(" ")[0] || formatted;
}

export function GuidedMonthCloseModal({
  isOpen,
  step,
  monthId,
  nextMonthId,
  isClosing = false,
  errorMessage = null,
  onCloseMonth,
  onNotNow,
  onProceedToNextMonth,
  onDismiss
}: GuidedMonthCloseModalProps) {
  if (!isOpen) return null;

  const monthLabel = formatMonthLabel(monthId);
  const nextMonthName = getMonthNameOnly(nextMonthId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 text-slate-100 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="guided-month-close-title"
      data-testid="guided-month-close-modal"
    >
      <section className="w-full max-w-lg rounded-xl border border-emerald-400/30 bg-slate-900 p-6 shadow-2xl shadow-black/40">
        {step === "prompt" && (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-emerald-300 border border-emerald-500/30">
                  FINAL Verified
                </span>
                <h2 id="guided-month-close-title" className="mt-2 text-xl font-bold text-white">
                  Close {monthLabel}?
                </h2>
              </div>
              {!isClosing && (
                <button
                  type="button"
                  className="btn-ghost !h-9 !w-9 !px-0 text-slate-400 hover:text-white"
                  onClick={onNotNow}
                  title="Close dialog"
                  data-testid="btn-modal-x-close"
                >
                  <X className="h-5 w-5" />
                </button>
              )}
            </div>

            <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4 text-slate-200">
              <p className="text-base font-medium leading-relaxed">
                FINAL closed successfully. The month is still open. Would you like to close {monthLabel} now?
              </p>
              <p className="mt-2 text-xs text-slate-400">
                Closing the month seals all operational transactions and unlocks the next period rollover.
              </p>
            </div>

            {errorMessage && (
              <div
                className="mt-4 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200"
                data-testid="month-close-error-message"
              >
                <div className="flex items-center gap-2 font-semibold text-rose-300">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>Cannot close month</span>
                </div>
                <p className="mt-1">{errorMessage}</p>
              </div>
            )}

            {isClosing && (
              <div className="mt-4 flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-sm text-slate-200">
                <LoaderCircle className="h-5 w-5 animate-spin text-emerald-400" />
                <span>Closing {monthLabel} in authoritative PostgreSQL ledger...</span>
              </div>
            )}

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-secondary !h-11 w-full sm:w-auto"
                disabled={isClosing}
                onClick={onNotNow}
                data-testid="btn-not-now"
              >
                Not Now
              </button>
              <button
                type="button"
                className="btn-primary !h-11 w-full sm:w-auto"
                disabled={isClosing}
                onClick={() => void onCloseMonth()}
                data-testid="btn-close-month"
              >
                {isClosing && <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />}
                Close Month
              </button>
            </div>
          </div>
        )}

        {step === "success" && (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-emerald-300">
                    Month Closed
                  </span>
                  <h2 id="guided-month-close-title" className="text-xl font-bold text-white">
                    {monthLabel} Closed
                  </h2>
                </div>
              </div>
              <button
                type="button"
                className="btn-ghost !h-9 !w-9 !px-0 text-slate-400 hover:text-white"
                onClick={onDismiss || onNotNow}
                title="Dismiss"
                data-testid="btn-success-dismiss"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-100">
              <p
                className="text-base font-semibold text-white leading-relaxed"
                data-testid="month-close-success-message"
              >
                {monthLabel} is now closed. You can proceed to {nextMonthName} Day 1.
              </p>
              <div className="mt-2 space-y-1 text-xs text-emerald-200/90">
                <p>{monthLabel} closed successfully.</p>
                <p>{nextMonthName} has been initialized from {monthLabel} FINAL.</p>
                <p>{nextMonthName} Day 1 is now open.</p>
              </div>
            </div>

            <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="btn-secondary !h-11 w-full sm:w-auto"
                onClick={onDismiss || onNotNow}
                data-testid="btn-done"
              >
                Done
              </button>
              {onProceedToNextMonth && (
                <button
                  type="button"
                  className="btn-primary !h-11 w-full sm:w-auto"
                  onClick={onProceedToNextMonth}
                  data-testid="btn-proceed-next-month"
                >
                  Proceed to {nextMonthName} Day 1
                  <ArrowRight className="ml-2 h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
