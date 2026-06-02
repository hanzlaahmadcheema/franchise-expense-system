import { describe, expect, it } from "vitest";
import { availableDayNumbers, calendarCells, isFutureDay, isLiveDay, statusLabel } from "../services/dayStatusService";

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
    expect(statusLabel("futureDisabled")).toBe("Future");
    expect(statusLabel("today")).toBe("Open");
    expect(statusLabel("reopened")).toBe("Re-Open");
    expect(statusLabel("missing")).toBe("Missing");
    expect(statusLabel("closed")).toBe("Closed");
    expect(statusLabel("locked")).toBe("Closed");
  });
});
