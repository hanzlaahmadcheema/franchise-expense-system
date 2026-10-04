import type { ModuleKey, UniversalDaySnapshot, UniversalDayStatus } from "../types/dayControl.types";
import { calendarCells, daysInMonth, statusChipClass, statusLabel } from "../services/dayStatusService";

type Props = {
  moduleKey: ModuleKey;
  monthId: string;
  selectedDay: number;
  now: Date;
  days: UniversalDaySnapshot[];
  onSelect: (dayNo: number) => void;
  disabled?: boolean;
  showFinal?: boolean;
  canSelectFinal?: boolean;
  getFinalLabel?: () => string;
  variant?: "default" | "mini";
};

function fallbackStatus(monthId: string, dayNo: number, now: Date): UniversalDayStatus {
  void monthId;
  void dayNo;
  void now;
  return "closed";
}

function statusDotClass(status: UniversalDayStatus) {
  if (status === "reopen") return "bg-blue-400";
  if (status === "closed") return "bg-red-500";
  return "bg-emerald-400";
}

function selectedCellClass(status: UniversalDayStatus) {
  if (status === "reopen") return "border-blue-400 bg-blue-400/10 text-blue-100";
  if (status === "closed") return "border-red-400 bg-red-400/10 text-red-100";
  return "border-emerald-400 bg-emerald-400/10 text-emerald-100";
}

function unselectedCellClass(status: UniversalDayStatus) {
  if (status === "reopen") return "border-blue-400/40 bg-blue-400/5 text-blue-100";
  if (status === "closed") return "border-red-400/40 bg-red-400/5 text-red-100";
  return "border-emerald-400/40 bg-emerald-400/5 text-emerald-100";
}

function futureCellClass(selected: boolean) {
  return selected
    ? "border-slate-500 bg-slate-800/50 text-slate-300"
    : "border-slate-800 bg-slate-900/40 text-slate-500";
}

export function UniversalCalendar({
  moduleKey,
  monthId,
  selectedDay,
  now,
  days,
  onSelect,
  disabled,
  showFinal = false,
  canSelectFinal = false,
  getFinalLabel = () => "FINAL",
  variant = "default"
}: Props) {
  const dayByNo = new Map(days.map((day) => [day.dayNo, day]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const mini = variant === "mini";
  return (
    <div className={`${mini ? "mb-3 rounded-lg p-2" : "mb-4 rounded-xl p-3"} border border-slate-800 bg-slate-950/40 ${disabled ? "opacity-60" : ""}`} data-module-calendar={moduleKey}>
      <div className={`${mini ? "mb-1 gap-1 text-[9px]" : "mb-2 gap-2 text-[11px]"} grid grid-cols-7 text-center font-semibold uppercase text-slate-500`}>
        {weekdays.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className={`${mini ? "gap-1" : "gap-2"} grid grid-cols-7`}>
        {calendarCells(monthId).map((cell, index) => {
          if (cell.dayNo == null) return <span key={`empty-${index}`} className={mini ? "min-h-10" : "min-h-16"} aria-hidden="true" />;
          const snapshot = dayByNo.get(cell.dayNo);
          const status = snapshot?.status ?? fallbackStatus(monthId, cell.dayNo, now);
          const future = snapshot?.future ?? false;
          const selected = selectedDay === cell.dayNo;
          const label = statusLabel(status);
          return (
            <button
              key={cell.dayNo}
              type="button"
              className={[
                mini ? "min-h-10 flex-col rounded-md border px-1 py-1 text-[10px]" : "min-h-16 flex-col rounded-lg border px-2 py-2 text-xs",
                future
                  ? futureCellClass(selected)
                  : selected
                    ? selectedCellClass(status)
                    : unselectedCellClass(status),
                future ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
              disabled={disabled || future}
              onClick={() => onSelect(cell.dayNo!)}
              title={future ? snapshot?.disabledReason ?? "Future days are disabled." : snapshot?.disabledReason ?? `${snapshot?.dateLabel ?? `Day ${cell.dayNo}`} - ${label}`}
            >
              <span className={`${mini ? "text-xs" : "text-sm"} font-semibold`}>{cell.dayNo}</span>
              {mini ? (
                <span className={`mt-1 h-1.5 w-1.5 rounded-full ${future ? "bg-slate-500" : statusDotClass(status)}`} aria-label={future ? "Future" : label} />
              ) : (
                <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${future ? "bg-slate-800 text-slate-400" : statusChipClass(status)}`}>
                  {future ? "Future" : label}
                </span>
              )}
              {selected && !mini && <span className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">Selected</span>}
            </button>
          );
        })}
      </div>
      {showFinal && (() => {
        const finalSnapshot = dayByNo.get(32);
        const finalStatus: UniversalDayStatus = finalSnapshot?.status ?? "closed";
        const selected = selectedDay === 32;
        const label = statusLabel(finalStatus);
        return (
          <div className={`${mini ? "mt-2" : "mt-4"} flex justify-end`}>
            <button
              type="button"
              className={[
                mini
                  ? "min-h-8 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px]"
                  : "min-h-9 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs",
                "font-semibold transition",
                selected ? selectedCellClass(finalStatus) : unselectedCellClass(finalStatus),
                disabled || !canSelectFinal || daysInMonth(monthId) < 1 ? "cursor-not-allowed opacity-60" : ""
              ].join(" ")}
              disabled={disabled || !canSelectFinal || daysInMonth(monthId) < 1}
              onClick={() => onSelect(32)}
              title={finalSnapshot?.disabledReason ?? `FINAL Month-End Closing Snapshot - ${label}`}
            >
              <span>{getFinalLabel()}</span>
              {mini ? (
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(finalStatus)}`} aria-label={label} />
              ) : (
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${statusChipClass(finalStatus)}`}>
                  {label}
                </span>
              )}
              {selected && !mini && <span className="text-[9px] uppercase tracking-wide text-slate-400">Selected</span>}
            </button>
          </div>
        );
      })()}
    </div>
  );
}
