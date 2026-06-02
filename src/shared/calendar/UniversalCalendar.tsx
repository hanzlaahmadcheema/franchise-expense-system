import type { ModuleKey, UniversalDaySnapshot, UniversalDayStatus } from "../types/dayControl.types";
import { calendarCells, daysInMonth, isFutureDay, statusChipClass, statusLabel } from "../services/dayStatusService";

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
  return isFutureDay(monthId, dayNo, now) ? "futureDisabled" : "missing";
}

function statusDotClass(status: UniversalDayStatus) {
  if (status === "open" || status === "today") return "bg-emerald-400";
  if (status === "reopened") return "bg-blue-400";
  if (status === "missing") return "bg-orange-400";
  if (status === "closed" || status === "locked") return "bg-red-500";
  return "bg-slate-600";
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
          const future = status === "futureDisabled";
          const selected = selectedDay === cell.dayNo;
          const label = statusLabel(status);
          return (
            <button
              key={cell.dayNo}
              type="button"
              className={[
                mini ? "min-h-10 flex-col rounded-md border px-1 py-1 text-[10px]" : "min-h-16 flex-col rounded-lg border px-2 py-2 text-xs",
                selected ? "border-emerald-400 bg-emerald-400/10 text-emerald-100" : "border-slate-800 bg-slate-900/70 text-slate-200",
                future ? "opacity-40" : ""
              ].join(" ")}
              disabled={disabled || future}
              onClick={() => onSelect(cell.dayNo!)}
              title={snapshot?.disabledReason ?? `${snapshot?.dateLabel ?? `Day ${cell.dayNo}`} - ${label}`}
            >
              <span className={`${mini ? "text-xs" : "text-sm"} font-semibold`}>{cell.dayNo}</span>
              {mini ? (
                <span className={`mt-1 h-1.5 w-1.5 rounded-full ${statusDotClass(status)}`} aria-label={label} />
              ) : (
                <span className={`mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${statusChipClass(status)}`}>{label}</span>
              )}
              {selected && !mini && <span className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">Selected</span>}
            </button>
          );
        })}
      </div>
      {showFinal && (
        <div className={`${mini ? "mt-2" : "mt-4"} flex justify-end`}>
          <button
            type="button"
            className={`${selectedDay === 32 ? "btn-chip btn-chip-active" : "btn-chip"} ${mini ? "!h-8 text-[10px]" : ""}`}
            disabled={disabled || !canSelectFinal || daysInMonth(monthId) < 1}
            onClick={() => onSelect(32)}
          >
            {getFinalLabel()}
          </button>
        </div>
      )}
    </div>
  );
}
