import { CheckCircle2, LoaderCircle, X, XCircle } from "lucide-react";

export type SaveProgressState = {
  status: "saving" | "success" | "error";
  title: string;
  message: string;
} | null;

export function SaveProgressDialog({ state, onClose }: { state: SaveProgressState; onClose: () => void }) {
  if (!state) return null;
  const saving = state.status === "saving";
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-live="assertive">
      <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl shadow-black/50">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            {saving ? <LoaderCircle className="h-7 w-7 shrink-0 animate-spin text-emerald-300" /> : state.status === "success" ? <CheckCircle2 className="h-7 w-7 shrink-0 text-emerald-300" /> : <XCircle className="h-7 w-7 shrink-0 text-rose-300" />}
            <div>
              <h2 className="text-base font-semibold text-white">{state.title}</h2>
              <p className="mt-1 text-sm leading-6 text-slate-300">{state.message}</p>
            </div>
          </div>
          {!saving && <button className="btn-ghost !h-8 !w-8 !px-0" onClick={onClose} title="Close save result"><X /></button>}
        </div>
        {saving && <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className="loading-bar h-full bg-emerald-400" /></div>}
        {!saving && <button className="btn-primary mt-5 w-full" onClick={onClose}>Done</button>}
      </div>
    </div>
  );
}
