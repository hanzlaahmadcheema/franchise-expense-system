import { LoaderCircle, X } from "lucide-react";
import type { MasterRefreshModalState } from "./dayControl.types";

type Props = {
  state: MasterRefreshModalState;
  onClose?: () => void;
};

export function MasterCalculationRefreshModal({ state, onClose }: Props) {
  if (!state.open) return null;
  const finished = Boolean(state.result || state.error);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 p-4 text-slate-100 backdrop-blur-sm" role="dialog" aria-modal="true">
      <section className="w-full max-w-lg rounded-xl border border-emerald-400/30 bg-slate-900 p-5 shadow-2xl shadow-black/40">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">Master Refresh</p>
            <h2 className="mt-1 text-lg font-semibold text-white">{state.title}</h2>
          </div>
          {finished && onClose && (
            <button className="btn-ghost !h-9 !w-9 !px-0" onClick={onClose} title="Close">
              <X />
            </button>
          )}
        </div>
        {!finished && (
          <div className="mt-5 flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <LoaderCircle className="h-5 w-5 animate-spin text-emerald-300" />
            <span className="text-sm text-slate-200">{state.currentStep ?? "Preparing recalculation..."}</span>
          </div>
        )}
        <ol className="mt-4 space-y-2 text-sm text-slate-300">
          {state.progress.map((progress, index) => (
            <li key={`${progress.step}-${index}`} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
              <span className="font-medium text-slate-100">{progress.step}</span>
              {progress.detail && <span className="ml-2 text-slate-500">{progress.detail}</span>}
            </li>
          ))}
        </ol>
        {state.result && (
          <div className="mt-4 rounded-lg border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
            <p className="font-semibold">Recalculation completed.</p>
            <p className="mt-1">Days checked: {state.result.daysChecked}</p>
            <p>Mismatches corrected: {state.result.mismatchesCorrected}</p>
            <p>Monthly summaries updated: {state.result.monthlySummariesUpdated}</p>
            {state.result.message && <p className="mt-1 text-emerald-200">{state.result.message}</p>}
          </div>
        )}
        {state.error && (
          <div className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">
            <p className="font-semibold">Recalculation failed. Manual values were not changed.</p>
            <p className="mt-1">{state.error}</p>
          </div>
        )}
      </section>
    </div>
  );
}
