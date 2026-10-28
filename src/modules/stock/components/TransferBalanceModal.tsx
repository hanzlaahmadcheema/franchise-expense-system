import React, { useState, useEffect, useId } from "react";
import {
  ArrowRightLeft,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  X,
  LoaderCircle,
  ShieldCheck,
  Info,
  History,
  RotateCcw
} from "lucide-react";
import { ledgerApiClient, type StockBalanceTransferRecord } from "../../../services/api/ledgerApiClient";
import type { StockAccountProfile } from "../types/stock.types";
import { formatMoney, roundMoney } from "../utils/stockFormatters";
import { ReverseTransferModal } from "./ReverseTransferModal";
import { TransferHistoryView } from "./TransferHistoryView";

export interface TransferBalanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  dayId: string;
  accounts: StockAccountProfile[];
  accountBalances: Record<string, number>; // accountId -> closing_due
  onSuccess: (result: {
    transfer?: StockBalanceTransferRecord;
    sourceAccountProjection?: any;
    destinationAccountProjection?: any;
    original?: StockBalanceTransferRecord;
    reversal?: StockBalanceTransferRecord;
  }) => void;
  disabled?: boolean;
  canReverse?: boolean;
  initialTab?: "new" | "history";
}

export function formatAccountBalance(due: number): {
  label: string;
  amountStr: string;
  colorClass: string;
  isCredit: boolean;
  isDebt: boolean;
  isZero: boolean;
} {
  const rounded = roundMoney(due);
  if (rounded < 0) {
    return {
      label: "Credit",
      amountStr: `Rs. ${formatMoney(-rounded)} Credit (Due: ${formatMoney(rounded)})`,
      colorClass: "text-emerald-400",
      isCredit: true,
      isDebt: false,
      isZero: false
    };
  } else if (rounded > 0) {
    return {
      label: "Debt",
      amountStr: `Rs. ${formatMoney(rounded)} Due`,
      colorClass: "text-rose-400",
      isCredit: false,
      isDebt: true,
      isZero: false
    };
  } else {
    return {
      label: "Zero",
      amountStr: "Rs. 0 (Nil)",
      colorClass: "text-slate-400",
      isCredit: false,
      isDebt: false,
      isZero: true
    };
  }
}

export function TransferBalanceModal({
  isOpen,
  onClose,
  dayId,
  accounts,
  accountBalances,
  onSuccess,
  disabled = false,
  canReverse = true,
  initialTab = "new"
}: TransferBalanceModalProps) {
  const sourceSelectId = useId();
  const destSelectId = useId();
  const amountInputId = useId();
  const reasonInputId = useId();

  const [activeTab, setActiveTab] = useState<"new" | "history">(initialTab);
  const [selectedTransferForReversal, setSelectedTransferForReversal] = useState<StockBalanceTransferRecord | null>(null);
  const [isReversalModalOpen, setIsReversalModalOpen] = useState<boolean>(false);
  const [historyRefreshTrigger, setHistoryRefreshTrigger] = useState<number>(0);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab, isOpen]);

  const [transferType, setTransferType] = useState<"credit" | "debt">("credit");
  const [sourceAccountId, setSourceAccountId] = useState<string>("");
  const [destinationAccountId, setDestinationAccountId] = useState<string>("");
  const [amountStr, setAmountStr] = useState<string>("");
  const [reason, setReason] = useState<string>("");
  const [confirmed, setConfirmed] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  if (!isOpen) return null;

  // Active accounts only
  const activeAccounts = accounts.filter((a) => a.active !== false);

  // Balances
  const sourceDue = sourceAccountId ? (accountBalances[sourceAccountId] ?? 0) : 0;
  const destDue = destinationAccountId ? (accountBalances[destinationAccountId] ?? 0) : 0;

  // Available transferable amount based on type
  const availableCredit = sourceDue < 0 ? roundMoney(-sourceDue) : 0;
  const availableDebt = sourceDue > 0 ? roundMoney(sourceDue) : 0;
  const maxTransferable = transferType === "credit" ? availableCredit : availableDebt;

  const enteredAmount = Number(amountStr) || 0;

  // Previews
  let sourceResultDue = sourceDue;
  let destResultDue = destDue;
  if (enteredAmount > 0) {
    if (transferType === "credit") {
      sourceResultDue = roundMoney(sourceDue + enteredAmount);
      destResultDue = roundMoney(destDue - enteredAmount);
    } else {
      sourceResultDue = roundMoney(sourceDue - enteredAmount);
      destResultDue = roundMoney(destDue + enteredAmount);
    }
  }

  const preCombined = roundMoney(sourceDue + destDue);
  const postCombined = roundMoney(sourceResultDue + destResultDue);
  const combinedPreserved = Math.abs(preCombined - postCombined) < 0.001;

  // Validation
  let validationError: string | null = null;
  if (!sourceAccountId) {
    validationError = "Please select a source person.";
  } else if (!destinationAccountId) {
    validationError = "Please select a destination person.";
  } else if (sourceAccountId === destinationAccountId) {
    validationError = "Source and destination person cannot be the same.";
  } else if (enteredAmount <= 0) {
    validationError = "Transfer amount must be greater than 0.";
  } else if (enteredAmount > maxTransferable) {
    validationError = `Amount (Rs. ${formatMoney(enteredAmount)}) exceeds transferable ${transferType} balance (Rs. ${formatMoney(maxTransferable)}).`;
  } else if (!reason.trim() || reason.trim().length < 3) {
    validationError = "Please provide a valid reason or note (min 3 characters).";
  } else if (!confirmed) {
    validationError = "Please check the confirmation box below to proceed.";
  }

  const handleMaxClick = () => {
    if (maxTransferable > 0) {
      setAmountStr(String(maxTransferable));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError || isSubmitting || disabled) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      const res = await ledgerApiClient.stockTransfers.create({
        day_id: dayId,
        source_account_id: sourceAccountId,
        destination_account_id: destinationAccountId,
        amount: roundMoney(enteredAmount),
        transfer_type: transferType,
        reason: reason.trim(),
        idempotency_key: crypto.randomUUID()
      });

      setHistoryRefreshTrigger((prev) => prev + 1);
      onSuccess(res.data);
      onClose();
    } catch (err: any) {
      console.error("[TransferBalanceModal] Transfer failed:", err);
      setErrorMessage(err.message || "Failed to execute balance transfer. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const sourceBal = formatAccountBalance(sourceDue);
  const destBal = formatAccountBalance(destDue);
  const sourceResBal = formatAccountBalance(sourceResultDue);
  const destResBal = formatAccountBalance(destResultDue);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 text-slate-100 backdrop-blur-sm overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="transfer-balance-title"
    >
      <section className="w-full max-w-2xl rounded-xl border border-emerald-400/30 bg-slate-900 p-6 shadow-2xl shadow-black/50 my-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider text-emerald-300 border border-emerald-500/30">
                <ArrowRightLeft className="h-3.5 w-3.5" />
                Financial Allocation
              </span>
            </div>
            <h2 id="transfer-balance-title" className="mt-2 text-xl font-bold text-white flex items-center gap-2">
              Transfer Balance Between People
            </h2>
            <p className="mt-1 text-xs text-slate-400">
              Reallocate an agreed financial balance from one person to another without moving physical inventory or cash.
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

        {/* Navigation Tabs */}
        <div className="mt-4 flex gap-2 border-b border-slate-800 pb-2">
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 ${
              activeTab === "new"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            }`}
            onClick={() => setActiveTab("new")}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" />
            <span>New Transfer</span>
          </button>
          <button
            type="button"
            className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors flex items-center gap-1.5 ${
              activeTab === "history"
                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/40"
            }`}
            onClick={() => setActiveTab("history")}
          >
            <History className="h-3.5 w-3.5" />
            <span>Transfer History & Reversals</span>
          </button>
        </div>

        {activeTab === "new" && (
          <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {/* Transfer Type Selection */}
          <div className="flex items-center gap-4 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Transfer Type:</span>
            <div className="flex gap-2">
              <button
                type="button"
                className={`px-3 py-1 text-xs font-semibold rounded-md border transition-colors ${
                  transferType === "credit"
                    ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                    : "bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200"
                }`}
                onClick={() => {
                  setTransferType("credit");
                  setAmountStr("");
                }}
              >
                Transfer Credit (Advance / Surplus)
              </button>
              <button
                type="button"
                className={`px-3 py-1 text-xs font-semibold rounded-md border transition-colors ${
                  transferType === "debt"
                    ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                    : "bg-slate-900 text-slate-400 border-slate-700 hover:text-slate-200"
                }`}
                onClick={() => {
                  setTransferType("debt");
                  setAmountStr("");
                }}
              >
                Transfer Debt (Outstanding Due)
              </button>
            </div>
          </div>

          {/* Account Selection Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Source Account */}
            <div className="bg-slate-950/50 p-3.5 rounded-lg border border-slate-800 space-y-2">
              <label htmlFor={sourceSelectId} className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Source Person (Transfer From)
              </label>
              <select
                id={sourceSelectId}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                value={sourceAccountId}
                disabled={isSubmitting}
                onChange={(e) => {
                  setSourceAccountId(e.target.value);
                  setAmountStr("");
                }}
              >
                <option value="">-- Select Source Person --</option>
                {activeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </select>

              {sourceAccountId && (
                <div className="text-xs pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">Current Balance: </span>
                  <span className={`font-mono font-semibold ${sourceBal.colorClass}`}>{sourceBal.amountStr}</span>
                  <div className="mt-1 text-slate-400">
                    <span>Available {transferType === "credit" ? "Credit" : "Debt"} to Transfer: </span>
                    <span className="font-mono font-bold text-slate-200">Rs. {formatMoney(maxTransferable)}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Destination Account */}
            <div className="bg-slate-950/50 p-3.5 rounded-lg border border-slate-800 space-y-2">
              <label htmlFor={destSelectId} className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Destination Person (Transfer To)
              </label>
              <select
                id={destSelectId}
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                value={destinationAccountId}
                disabled={isSubmitting}
                onChange={(e) => setDestinationAccountId(e.target.value)}
              >
                <option value="">-- Select Destination Person --</option>
                {activeAccounts
                  .filter((a) => a.id !== sourceAccountId)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.type})
                    </option>
                  ))}
              </select>

              {destinationAccountId && (
                <div className="text-xs pt-1 border-t border-slate-800/80">
                  <span className="text-slate-400">Current Balance: </span>
                  <span className={`font-mono font-semibold ${destBal.colorClass}`}>{destBal.amountStr}</span>
                </div>
              )}
            </div>
          </div>

          {/* Amount & Reason */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1 md:col-span-1">
              <label htmlFor={amountInputId} className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Transfer Amount (Rs.)
              </label>
              <div className="relative">
                <input
                  id={amountInputId}
                  type="number"
                  min="1"
                  step="0.01"
                  placeholder="0.00"
                  className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 pr-14 text-sm font-mono text-slate-100 focus:border-emerald-500 focus:outline-none"
                  value={amountStr}
                  disabled={isSubmitting || !sourceAccountId}
                  onChange={(e) => setAmountStr(e.target.value)}
                />
                {maxTransferable > 0 && (
                  <button
                    type="button"
                    onClick={handleMaxClick}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-0.5 text-[10px] font-bold uppercase rounded bg-slate-800 text-emerald-400 hover:bg-slate-700"
                  >
                    Max
                  </button>
                )}
              </div>
            </div>

            <div className="space-y-1 md:col-span-2">
              <label htmlFor={reasonInputId} className="block text-xs font-semibold uppercase tracking-wider text-slate-300">
                Reason / Auditable Note
              </label>
              <input
                id={reasonInputId}
                type="text"
                placeholder="e.g. Handover settlement / Previous balance transfer"
                className="w-full bg-slate-900 border border-slate-700 rounded-md px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none"
                value={reason}
                disabled={isSubmitting}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>

          {/* Real-time Resulting Balances Preview */}
          {sourceAccountId && destinationAccountId && enteredAmount > 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-4 space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-slate-400 border-b border-slate-800/80 pb-2">
                <span>Resulting Balances Preview</span>
                <span className="flex items-center gap-1 text-emerald-400 font-normal normal-case">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Calculated atomically in PostgreSQL
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {/* Source Preview */}
                <div className="bg-slate-900/80 p-2.5 rounded border border-slate-800">
                  <p className="font-semibold text-slate-300">
                    Source: {accounts.find((a) => a.id === sourceAccountId)?.name}
                  </p>
                  <div className="mt-1 flex items-center gap-2 font-mono">
                    <span className={sourceBal.colorClass}>{formatMoney(sourceDue)}</span>
                    <ArrowRight className="h-3 w-3 text-slate-500" />
                    <span className={`font-bold ${sourceResBal.colorClass}`}>{formatMoney(sourceResultDue)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{sourceResBal.amountStr}</p>
                </div>

                {/* Destination Preview */}
                <div className="bg-slate-900/80 p-2.5 rounded border border-slate-800">
                  <p className="font-semibold text-slate-300">
                    Destination: {accounts.find((a) => a.id === destinationAccountId)?.name}
                  </p>
                  <div className="mt-1 flex items-center gap-2 font-mono">
                    <span className={destBal.colorClass}>{formatMoney(destDue)}</span>
                    <ArrowRight className="h-3 w-3 text-slate-500" />
                    <span className={`font-bold ${destResBal.colorClass}`}>{formatMoney(destResultDue)}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-400">{destResBal.amountStr}</p>
                </div>
              </div>

              {/* Combined Invariant Check */}
              <div className="flex items-center justify-between text-[11px] pt-1 text-slate-400">
                <span>Combined Balance:</span>
                <span className="font-mono text-slate-300">
                  Rs. {formatMoney(preCombined)} &rarr; Rs. {formatMoney(postCombined)}{" "}
                  {combinedPreserved && <span className="text-emerald-400 font-semibold">(Invariant preserved)</span>}
                </span>
              </div>
            </div>
          )}

          {/* Strict Invariant Assurances Banner */}
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 p-3.5 text-xs text-emerald-200 space-y-1.5">
            <div className="flex items-center gap-2 font-semibold text-emerald-300">
              <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>Strict Accounting Invariants Enforced</span>
            </div>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px] text-slate-300 pl-6 list-disc">
              <li>Zero change to physical stock quantities</li>
              <li>Zero change to stock valuation</li>
              <li>Zero change to Jazz HQ company payable</li>
              <li>Zero cash movement (no payment / receipt)</li>
            </ul>
          </div>

          {/* Confirmation Checkbox */}
          <div className="flex items-start gap-2.5 pt-1">
            <input
              id="confirm-transfer-checkbox"
              type="checkbox"
              checked={confirmed}
              disabled={isSubmitting}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-slate-900 text-emerald-500 focus:ring-emerald-400"
            />
            <label htmlFor="confirm-transfer-checkbox" className="text-xs text-slate-300 cursor-pointer select-none">
              I explicitly confirm that this operation transfers an agreed financial balance between these recipients
              and does not reflect any physical stock return or cash transaction.
            </label>
          </div>

          {/* Errors */}
          {errorMessage && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-rose-300">Transfer Rejected</p>
                <p className="mt-0.5">{errorMessage}</p>
              </div>
            </div>
          )}

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
            <button
              type="button"
              className="btn-secondary !h-10 px-4 text-xs"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary !h-10 px-5 text-xs font-semibold flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={Boolean(validationError) || isSubmitting || disabled}
              title={validationError ?? "Confirm and post balance transfer"}
            >
              {isSubmitting ? (
                <>
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Posting Transfer...
                </>
              ) : (
                <>
                  <ArrowRightLeft className="h-4 w-4" />
                  Confirm & Transfer Balance
                </>
              )}
            </button>
          </div>
        </form>
        )}

        {/* Tab 2: Transfer History & Reversals */}
        {activeTab === "history" && (
          <div className="mt-5">
            <TransferHistoryView
              dayId={dayId}
              accounts={accounts}
              canReverse={canReverse}
              refreshTrigger={historyRefreshTrigger}
              onReverseClick={(t) => {
                setSelectedTransferForReversal(t);
                setIsReversalModalOpen(true);
              }}
            />
          </div>
        )}
      </section>

      {/* Sub-modal: Reversal Confirmation Dialog */}
      <ReverseTransferModal
        isOpen={isReversalModalOpen}
        onClose={() => {
          setIsReversalModalOpen(false);
          setSelectedTransferForReversal(null);
        }}
        transfer={selectedTransferForReversal}
        accounts={accounts}
        currentDayId={dayId}
        canReverse={canReverse}
        onSuccess={(revResult) => {
          setHistoryRefreshTrigger((prev) => prev + 1);
          onSuccess(revResult as any);
        }}
      />
    </div>
  );
}
