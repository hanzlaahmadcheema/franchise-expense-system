import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Calendar, CalendarDays, Maximize2, X } from "lucide-react";
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
  if (status === "reopen") return "bg-amber-400";
  if (status === "closed") return "bg-slate-600";
  return "bg-emerald-400";
}

function selectedCellClass(status: UniversalDayStatus) {
  void status;
  return "border-blue-500 bg-blue-500/20 text-blue-100 ring-2 ring-blue-400 shadow-md shadow-blue-500/20 font-bold";
}

function unselectedCellClass(status: UniversalDayStatus) {
  if (status === "reopen") return "border-amber-500/40 bg-amber-500/10 text-amber-200 hover:border-amber-400 hover:bg-amber-500/20";
  if (status === "closed") return "border-slate-800/60 bg-slate-950/40 text-slate-500 hover:bg-slate-900/50 hover:text-slate-400";
  return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:border-emerald-400 hover:bg-emerald-500/20";
}

function futureCellClass(selected: boolean) {
  return selected
    ? "border-slate-500 bg-slate-800/50 text-slate-300"
    : "border-slate-800 bg-slate-900/40 text-slate-500";
}

function formatMonthLabel(monthId: string): string {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return monthId;
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function formatMonthLong(monthId: string): string {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!year || !month) return monthId;
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
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
  const [isExpanded, setIsExpanded] = useState(false);
  const dayByNo = new Map(days.map((day) => [day.dayNo, day]));

  // Days of week with Sunday at last (Mon -> Sun)
  const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const mini = variant === "mini";

  // Escape key closes expanded center modal
  useEffect(() => {
    if (!isExpanded) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsExpanded(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isExpanded]);

  return (
    <>
      <div className={`${mini ? "mb-3 rounded-lg p-2" : "mb-4 rounded-xl p-3"} border border-slate-800 bg-slate-950/40 ${disabled ? "opacity-60" : ""}`} data-module-calendar={moduleKey}>
        {/* Calendar Header with Expand Button */}
        <div className="mb-2 flex items-center justify-between border-b border-slate-800/60 pb-1.5">
          <div className="flex items-center gap-1.5">
            <span className={`${mini ? "text-[10px]" : "text-xs"} font-semibold uppercase tracking-wider text-slate-300`}>
              {formatMonthLabel(monthId)}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 transition border border-transparent hover:border-sky-500/30"
            title="Expand Calendar into Center Pop-up"
            aria-label="Expand Calendar into Center Pop-up"
          >
            <Maximize2 className="h-3 w-3" />
            <span>Expand</span>
          </button>
        </div>

        {/* Days of week listed at top with Sunday at last */}
        <div className={`${mini ? "mb-1 gap-1 text-[9px]" : "mb-2 gap-2 text-[11px]"} grid grid-cols-7 text-center font-semibold uppercase text-slate-500`}>
          {weekdays.map((day, idx) => (
            <span key={day} className={idx === 6 ? "text-amber-400/80 font-bold" : ""}>
              {day}
            </span>
          ))}
        </div>

        {/* Calendar Cells Grid */}
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
                {selected && !mini && <span className="mt-1 text-[10px] uppercase tracking-wide text-blue-300 font-bold">Selected</span>}
              </button>
            );
          })}
        </div>

        {/* Day 32 FINAL */}
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
                {selected && !mini && <span className="text-[9px] uppercase tracking-wide text-blue-300 font-bold">Selected</span>}
              </button>
            </div>
          );
        })()}
      </div>

      {/* Centered Expanded Calendar Pop-up Modal */}
      {isExpanded &&
        (typeof document !== "undefined"
          ? createPortal(
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Expanded Operational Calendar"
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 overflow-y-auto animate-in fade-in duration-150"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setIsExpanded(false);
                }}
              >
                <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-2xl shadow-black/90 my-auto">
                  {/* Header */}
                  <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                        <CalendarDays className="h-5 w-5" />
                      </span>
                      <div>
                        <h3 className="text-base font-bold text-white tracking-tight">
                          {formatMonthLong(monthId)} · Operational Calendar
                        </h3>
                        <p className="text-xs text-slate-400">
                          Days of the week with Sunday at last. Click any day to switch records.
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsExpanded(false)}
                      className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition"
                      title="Close Calendar"
                      aria-label="Close Calendar"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>

                  {/* Status Color Legend */}
                  <div className="flex flex-wrap items-center gap-4 text-xs mb-4 p-2.5 rounded-lg bg-slate-950/60 border border-slate-800/80">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Status Legend:</span>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
                      <span className="text-emerald-300 font-medium">Open (Green)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
                      <span className="text-amber-300 font-medium">Re-opened (Orange/Yellow)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-slate-600" />
                      <span className="text-slate-400 font-medium">Closed (Disabled)</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-full bg-blue-500 ring-2 ring-blue-400/50" />
                      <span className="text-blue-300 font-medium">Selected (Blue)</span>
                    </div>
                  </div>

                  {/* Weekdays row with Sunday at last */}
                  <div className="grid grid-cols-7 gap-2 text-center text-xs font-bold uppercase text-slate-400 mb-2">
                    {weekdays.map((day, idx) => (
                      <span key={day} className={idx === 6 ? "text-amber-400/90 font-extrabold" : ""}>
                        {day}
                      </span>
                    ))}
                  </div>

                  {/* Modal Calendar Grid */}
                  <div className="grid grid-cols-7 gap-2">
                    {calendarCells(monthId).map((cell, index) => {
                      if (cell.dayNo == null) {
                        return <div key={`modal-empty-${index}`} className="h-16 rounded-xl bg-slate-950/20 border border-transparent" aria-hidden="true" />;
                      }
                      const snapshot = dayByNo.get(cell.dayNo);
                      const status = snapshot?.status ?? fallbackStatus(monthId, cell.dayNo, now);
                      const future = snapshot?.future ?? false;
                      const selected = selectedDay === cell.dayNo;
                      const label = statusLabel(status);

                      return (
                        <button
                          key={`modal-day-${cell.dayNo}`}
                          type="button"
                          disabled={disabled || future}
                          onClick={() => {
                            onSelect(cell.dayNo!);
                            setIsExpanded(false);
                          }}
                          className={[
                            "h-16 flex-col rounded-xl border p-2 text-xs font-semibold flex items-center justify-center transition shadow-sm",
                            future
                              ? futureCellClass(selected)
                              : selected
                                ? selectedCellClass(status)
                                : unselectedCellClass(status),
                            future ? "cursor-not-allowed opacity-50" : ""
                          ].join(" ")}
                          title={future ? snapshot?.disabledReason ?? "Future days are disabled." : snapshot?.disabledReason ?? `${snapshot?.dateLabel ?? `Day ${cell.dayNo}`} - ${label}`}
                        >
                          <span className="text-sm font-bold">{cell.dayNo}</span>
                          <span className={`mt-1 rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${future ? "bg-slate-800 text-slate-500" : statusChipClass(status)}`}>
                            {future ? "Future" : label}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Day 32 FINAL option */}
                  {showFinal && (() => {
                    const finalSnapshot = dayByNo.get(32);
                    const finalStatus: UniversalDayStatus = finalSnapshot?.status ?? "closed";
                    const selected = selectedDay === 32;
                    const label = statusLabel(finalStatus);
                    return (
                      <div className="mt-4 pt-3 border-t border-slate-800 flex items-center justify-between">
                        <span className="text-xs text-slate-400">Month-End Settlement Closing Snapshot</span>
                        <button
                          type="button"
                          className={[
                            "h-9 inline-flex items-center gap-2 rounded-xl border px-3 text-xs font-semibold transition",
                            selected ? selectedCellClass(finalStatus) : unselectedCellClass(finalStatus),
                            disabled || !canSelectFinal || daysInMonth(monthId) < 1 ? "cursor-not-allowed opacity-60" : ""
                          ].join(" ")}
                          disabled={disabled || !canSelectFinal || daysInMonth(monthId) < 1}
                          onClick={() => {
                            onSelect(32);
                            setIsExpanded(false);
                          }}
                          title={finalSnapshot?.disabledReason ?? `FINAL Month-End Closing Snapshot - ${label}`}
                        >
                          <span>{getFinalLabel()} (Day 32)</span>
                          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${statusChipClass(finalStatus)}`}>
                            {label}
                          </span>
                        </button>
                      </div>
                    );
                  })()}
                </div>
              </div>,
              document.body
            )
          : null)}
    </>
  );
}
