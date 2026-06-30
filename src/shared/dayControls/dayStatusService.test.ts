import { describe, expect, it } from "vitest";
import { availableDayNumbers, calendarCells, isFutureDay, isLiveDay, resolveUniversalDayStatus, statusLabel } from "../services/dayStatusService";

describe("shared day status helpers", () => {
  const now = new Date(2026, 4, 30);

  it("disables future days in the current month", () => {
    expect(availableDayNumbers("2026-05", now).at(-1)).toBe(30);
    expect(isFutureDay("2026-05", 31, now)).toBe(true);
    expect(isFutureDay("2026-05", 30, now)).toBe(false);
  });

  it("allows all days for past months and no days for future months", () => {
    expect(availableDayNumbers("2026-04", now).length).toBe(30);
    expect(availableDayNumbers("2026-06", now)).toEqual([]);
  });

  it("identifies the live day and renders stable calendar cells", () => {
    expect(isLiveDay("2026-05", 30, now)).toBe(true);
    expect(calendarCells("2026-05").filter((cell) => cell.dayNo != null).length).toBe(31);
  });

  it("maps universal statuses to client-safe labels", () => {
    expect(statusLabel("open")).toBe("Open");
    expect(statusLabel("reopen")).toBe("Reopen");
    expect(statusLabel("closed")).toBe("Closed");
  });

  it("keeps a live day closed and only reports reopen after an explicit newer reopen", () => {
    const closedAt = now.getTime();
    expect(resolveUniversalDayStatus({
      exists: true,
      future: false,
      live: true,
      day: { status: "closed", lockedAt: closedAt, reopenedAt: closedAt - 1 },
      nowMs: closedAt
    })).toBe("closed");

    expect(resolveUniversalDayStatus({
      exists: true,
      future: false,
      live: true,
      day: { status: "reopen", lockedAt: closedAt, reopenedAt: closedAt + 1, reopenedByRole: "owner" },
      nowMs: closedAt + 2
    })).toBe("reopen");

    expect(resolveUniversalDayStatus({
      exists: true,
      future: false,
      live: false,
      day: { status: "reopen" },
      nowMs: closedAt + 2
    })).toBe("reopen");
  });
});
