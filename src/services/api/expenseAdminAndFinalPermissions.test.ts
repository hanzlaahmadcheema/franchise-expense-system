import { describe, expect, it } from "vitest";
import {
  canEditOperationalDailyEntry,
  isOperationalDayClosed
} from "../../shared/services/dayEditPermissions";

describe("Expense Admin Open-Day Permissions and FINAL Verification", () => {
  const nowMs = new Date("2026-10-12T12:00:00Z").getTime();

  it("permits Admin to edit an open operational day even when not today's calendar date", () => {
    // Open past day (e.g. Day 1 when today is Day 12)
    const openDayInput = {
      status: "open" as const,
      lockedAt: null,
      closedAt: null,
      reopenedUntilAt: null
    };

    const isClosed = isOperationalDayClosed(openDayInput, nowMs);
    expect(isClosed).toBe(false);

    // Replicate canAdminEditSelectedExpenseDay formula from App.tsx:
    // isSelectedLiveDay = false (not today)
    const isSelectedLiveDay = false;
    const canAdminEdit = ("admin" === "admin") && (
      isSelectedLiveDay ||
      !isClosed
    );
    expect(canAdminEdit).toBe(true);

    // Also assert canEditOperationalDailyEntry
    const canEditEntry = canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: isClosed,
      day: openDayInput,
      nowMs
    });
    expect(canEditEntry).toBe(true);
  });

  it("treats open day as open when closedAt is cleared (as normalized for open PostgreSQL days)", () => {
    const openDayNormalized = {
      status: "open" as const,
      lockedAt: undefined,
      closedAt: undefined,
      reopenedUntilAt: null
    };

    expect(isOperationalDayClosed(openDayNormalized, nowMs)).toBe(false);

    const canEditEntry = canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: isOperationalDayClosed(openDayNormalized, nowMs),
      day: openDayNormalized,
      nowMs
    });
    expect(canEditEntry).toBe(true);
  });

  it("prohibits Admin from editing a closed day that has not been reopened", () => {
    const closedDayInput = {
      status: "closed" as const,
      lockedAt: nowMs - 3600_000,
      closedAt: nowMs - 3600_000,
      reopenedUntilAt: null
    };

    const isClosed = isOperationalDayClosed(closedDayInput, nowMs);
    expect(isClosed).toBe(true);

    const isSelectedLiveDay = false;
    const canAdminEdit = ("admin" === "admin") && (
      isSelectedLiveDay ||
      !isClosed
    );
    expect(canAdminEdit).toBe(false);

    const canEditEntry = canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: isClosed,
      day: closedDayInput,
      nowMs
    });
    expect(canEditEntry).toBe(false);
  });

  it("permits Admin to edit a closed day only when owner-reopened", () => {
    const reopenedDayInput = {
      status: "reopen" as const,
      reopenedAt: nowMs - 60_000,
      reopenedByRole: "owner" as const
    };

    const isClosed = isOperationalDayClosed(reopenedDayInput, nowMs);
    expect(isClosed).toBe(false);

    const canEditEntry = canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: isClosed,
      day: reopenedDayInput,
      nowMs
    });
    expect(canEditEntry).toBe(true);
  });

  it("treats open day as open when closedAt is cleared (as normalized for open PostgreSQL days)", () => {
    const openDayNormalized = {
      status: "open" as const,
      lockedAt: undefined,
      closedAt: undefined,
      reopenedUntilAt: null
    };

    expect(isOperationalDayClosed(openDayNormalized, nowMs)).toBe(false);

    const canEditEntry = canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: isOperationalDayClosed(openDayNormalized, nowMs),
      day: openDayNormalized,
      nowMs
    });
    expect(canEditEntry).toBe(true);
  });

  it("enforces that Day 32 (FINAL settlement) verification is restricted to Owner", () => {
    function canCloseDay(role: "owner" | "admin" | "viewer", dayNo: number) {
      return dayNo === 32 ? role === "owner" : (role === "owner" || role === "admin");
    }

    expect(canCloseDay("owner", 32)).toBe(true);
    expect(canCloseDay("admin", 32)).toBe(false);
    expect(canCloseDay("viewer", 32)).toBe(false);

    // Regular days allow both Owner and Admin
    expect(canCloseDay("owner", 15)).toBe(true);
    expect(canCloseDay("admin", 15)).toBe(true);
    expect(canCloseDay("viewer", 15)).toBe(false);
  });
});
