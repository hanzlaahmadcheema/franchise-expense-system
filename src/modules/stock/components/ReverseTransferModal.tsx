import React, { useState, useId } from "react";
import {
  RotateCcw,
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  ShieldCheck,
  X,
  LoaderCircle,
  ArrowRight,
  Info
} from "lucide-react";
import {
  ledgerApiClient,
  type StockBalanceTransferRecord
} from "../../../services/api/ledgerApiClient";
import type { StockAccountProfile } from "../types/stock.types";
import { formatMoney } from "../utils/stockFormatters";

export interface ReverseTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  transfer: StockBalanceTransferRecord | null;
  accounts: StockAccountProfile[];
  currentDayId?: string;
  onSuccess: (result: {
    original: StockBalanceTransferRecord;
    reversal: StockBalanceTransferRecord;
  }) => void;
  canReverse?: boolean;
  disabled?: boolean;
}

export function ReverseTransferModal({
  isOpen,
  onClose,
  transfer,
  accounts,
  currentDayId,
  onSuccess,
  canReverse = true,
  disabled = false
}: ReverseTransferModalProps) {
  const reasonInputId = useId();
  const confirmCheckboxId = useId();

  const [reason, setReason] = useState<string>("");
  const [confirmed, setConfirmed] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isConflict, setIsConflict] = useState<boolean>(false);

  if (!isOpen || !transfer) return null;

  const isAlreadyReversed = transfer.status === "reversed";
  const sourceAccount = accounts.find((a) => a.id === transfer.source_account_id);
  const destinationAccount = accounts.find((a) => a.id === transfer.destination_account_id);

  const sourceName = sourceAccount?.name || `Account (${transfer.source_account_id.slice(0, 8)}…)`;
  const destName = destinationAccount?.name || `Account (${transfer.destination_account_id.slice(0, 8)}…)`;

  let validationError: string | null = null;
  if (isAlreadyReversed) {
    validationError = "This transfer has already been reversed.";
  } else if (!canReverse) {
    validationError = "Unauthorized: Only administrators and franchise owners can reverse balance transfers.";
  } else if (!reason.trim() || reason.trim().length < 3) {
    validationError = "Please provide a valid reversal reason (min 3 characters).";
  } else if (!confirmed) {
    validationError = "Please check the confirmation box below to proceed.";
  }

  const isSubmitDisabled = Boolean(
    validationError ||
    isSubmitting ||
    disabled ||
    isAlreadyReversed ||
    !canReverse
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitDisabled) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    setIsConflict(false);

    try {
      const res = await ledgerApiClient.stockTransfers.reverse(
        transfer.id,
        {
          reason: reason.trim(),
          day_id: currentDayId
        }
      );

      onSuccess(res.data);
      onClose();
    } catch (err: any) {
      console.error("[ReverseTransferModal] Reversal failed:", err);
      const is409 =
        err?.status === 409 ||
        err?.code === "HTTP_409" ||
        err?.message?.includes("already reversed");

      if (is409) {
        setIsConflict(true);
        setErrorMessage("Conflict (HTTP 409): This transfer has already been reversed. Transfer records have been updated.");
      } else {
        setErrorMessage(err?.message || "Failed to reverse balance transfer. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const formattedDate = transfer.created_at
    ? new Date(transfer.created_at).toLocaleString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    : "—";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 text-slate-100 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reverse-transfer-title"
    >
      <section className="w-full max-w-xl rounded-xl border border-amber-400/30 bg-slate-900 p-6 shadow-2xl shadow-black/60 my-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-amber-300 border border-amber-500/30">
                <RotateCcw className="h-3.5 w-3.5" />
                Compensating Reversal
              </span>
              {isAlreadyReversed && (
                <span className="inline-flex items-center rounded-full bg-slate-800 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-slate-400 border border-slate-700">
                  Already Reversed
                </span>
              )}
            </div>
            <h2 id="reverse-transfer-title" className="mt-2 text-xl font-bold text-white flex items-center gap-2">
              Reverse Balance Transfer
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Creates an explicit compensating accounting record to restore original financial obligations without deleting history.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost !h-9 !w-9 !px-0 text-slate-400 hover:text-white"
            onClick={onClose}
            disabled={isSubmitting}
            title="Close modal"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Original Transfer Details */}
        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-4 space-y-3">
          <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5 text-amber-400" />
            <span>Original Transfer Details</span>
          </h3>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <span className="text-slate-500 block uppercase font-medium text-[10px]">Source Person</span>
              <span className="font-semibold text-slate-200">{sourceName}</span>
            </div>
            <div>
              <span className="text-slate-500 block uppercase font-medium text-[10px]">Destination Person</span>
              <span className="font-semibold text-slate-200">{destName}</span>
            </div>
            <div>
              <span className="text-slate-500 block uppercase font-medium text-[10px]">Transfer Amount</span>
              <span className="font-mono font-bold text-emerald-400 text-sm">
                Rs. {formatMoney(Number(transfer.amount))}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block uppercase font-medium text-[10px]">Transfer Type</span>
              <span className="font-semibold uppercase text-slate-300">
                {transfer.transfer_type || "credit"}
              </span>
            </div>
            <div>
              <span className="text-slate-500 block uppercase font-medium text-[10px]">Date Recorded</span>
              <span className="text-slate-300">{formattedDate}</span>
            </div>
            <div>
              <span className="text-slate-500 block uppercase font-medium text-[10px]">Status</span>
              <span className={isAlreadyReversed ? "font-bold text-amber-400" : "font-bold text-emerald-400"}>
                {isAlreadyReversed ? "Reversed" : "Completed"}
              </span>
            </div>
          </div>

          <div className="border-t border-slate-800/80 pt-2 text-xs">
            <span className="text-slate-500 block uppercase font-medium text-[10px]">Original Reason</span>
            <p className="text-slate-300 italic mt-0.5">{transfer.reason || "—"}</p>
          </div>
        </div>

        {/* Accounting Invariant & Debt Warnings */}
        <div className="mt-4 space-y-2">
          {/* Compensating Operation Notice */}
          <div className="flex items-start gap-2.5 rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-3 text-xs text-indigo-200">
            <ShieldCheck className="h-4 w-4 shrink-0 text-indigo-400 mt-0.5" />
            <div>
              <strong className="font-semibold text-indigo-300 block">Compensating Accounting Operation</strong>
              <span>
                This action inserts a new compensating transfer ({destName} <ArrowRight className="inline h-3 w-3" /> {sourceName}) in PostgreSQL.
                The original record is preserved in the audit log; accounting history is never altered or deleted.
              </span>
            </div>
          </div>

          {/* Debt Risk Warning */}
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400 mt-0.5" />
            <div>
              <strong className="font-semibold text-amber-300 block">Outstanding Debt Risk</strong>
              <span>
                If <strong>{destName}</strong> has subsequently consumed or drawn stock against this transferred balance,
                executing this reversal may legitimately leave their account with an outstanding debt (positive due balance).
              </span>
            </div>
          </div>
        </div>

        {/* Conflict / Already Reversed Warning */}
        {isAlreadyReversed && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-950/30 p-3 text-xs text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              This transfer has already been reversed. No further reversal operations can be performed on this record.
            </span>
          </div>
        )}

        {/* Unauthorized Warning */}
        {!canReverse && (
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/30 p-3 text-xs text-rose-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>
              Unauthorized: Only administrators and franchise owners can reverse balance transfers.
            </span>
          </div>
        )}

        {/* Error message */}
        {errorMessage && (
          <div
            className={`mt-4 rounded-lg border p-3 text-xs flex items-center gap-2 ${
              isConflict
                ? "border-amber-500/50 bg-amber-950/30 text-amber-300"
                : "border-rose-500/50 bg-rose-950/30 text-rose-300"
            }`}
          >
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Form */}
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor={reasonInputId} className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
              Reversal Reason / Justification <span className="text-amber-400">*</span>
            </label>
            <textarea
              id={reasonInputId}
              rows={2}
              className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-amber-400 focus:outline-none focus:ring-1 focus:ring-amber-400"
              placeholder="e.g. Staff allocation corrected or customer handover cancelled"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={isSubmitting || isAlreadyReversed || !canReverse || disabled}
              required
            />
          </div>

          <div className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
            <input
              type="checkbox"
              id={confirmCheckboxId}
              className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-900 text-amber-500 focus:ring-amber-400 cursor-pointer"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              disabled={isSubmitting || isAlreadyReversed || !canReverse || disabled}
            />
            <label htmlFor={confirmCheckboxId} className="text-xs text-slate-300 cursor-pointer select-none">
              I explicitly confirm that this creates a <strong>compensating reversal operation</strong> in PostgreSQL and does not delete or rewrite historical accounting transactions.
            </label>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 border-t border-slate-800 pt-4">
            <button
              type="button"
              className="btn-secondary !h-9 !px-4 text-xs text-slate-300 hover:text-white"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary !h-9 !px-4 text-xs !bg-amber-600 hover:!bg-amber-500 text-white font-semibold flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={isSubmitDisabled}
            >
              {isSubmitting ? (
                <>
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                  <span>Reversing Transfer…</span>
                </>
              ) : (
                <>
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Confirm & Reverse Transfer</span>
                </>
              )}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
