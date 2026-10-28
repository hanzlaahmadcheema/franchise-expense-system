import { describe, expect, it } from "vitest";
import {
  canEditOperationalDailyEntry,
  canReopenDay,
  canReopenOperationalDay,
  isAdminEditableReopenedDay
} from "./dayEditPermissions";

describe("day edit permissions", () => {
  const nowMs = new Date("2026-06-04T12:00:00Z").getTime();
  const activeOwnerReopen = { status: "reopen" as const, reopenedAt: nowMs - 60_000, reopenedByRole: "owner" as const };
  const activeLegacyReopen = { reopenedUntilAt: nowMs + 60_000, reopenedByRole: null };
  const expiredOwnerReopen = { reopenedUntilAt: nowMs - 1, reopenedByRole: "owner" as const };

  it("keeps reopen controls owner-only", () => {
    expect(canReopenDay("owner")).toBe(true);
    expect(canReopenDay("admin")).toBe(false);
    expect(canReopenDay("viewer")).toBe(false);
    expect(canReopenOperationalDay({ role: "owner", isLiveDay: false })).toBe(true);
    expect(canReopenOperationalDay({ role: "admin", isLiveDay: false })).toBe(false);
    expect(canReopenOperationalDay({ role: "admin", isLiveDay: true })).toBe(false);
    expect(canReopenOperationalDay({ role: "viewer", isLiveDay: true })).toBe(false);
  });

  it("lets admin edit current day or an active owner-reopened previous day only", () => {
    expect(canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: true,
      dayClosed: false,
      nowMs
    })).toBe(true);

    expect(canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: false,
      nowMs
    })).toBe(true);

    expect(canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: true,
      day: activeOwnerReopen,
      nowMs
    })).toBe(true);

    expect(canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: true,
      day: activeLegacyReopen,
      nowMs
    })).toBe(false);

    expect(canEditOperationalDailyEntry({
      role: "admin",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: true,
      day: expiredOwnerReopen,
      nowMs
    })).toBe(false);
  });

  it("keeps viewer read-only and owner editable while a previous day is manually reopened", () => {
    expect(isAdminEditableReopenedDay(activeOwnerReopen, nowMs)).toBe(true);
    expect(canEditOperationalDailyEntry({
      role: "viewer",
      canWriteDaily: false,
      monthClosed: false,
      isLiveDay: true,
      dayClosed: false,
      nowMs
    })).toBe(false);
    expect(canEditOperationalDailyEntry({
      role: "owner",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: true,
      day: activeOwnerReopen,
      nowMs
    })).toBe(true);
  });

  it("keeps a closed live day read-only for owner and admin until explicit reopen", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(canEditOperationalDailyEntry({
        role,
        canWriteDaily: true,
        monthClosed: false,
        isLiveDay: true,
        dayClosed: true,
        day: { lockedAt: nowMs },
        nowMs
      })).toBe(false);
    }

    expect(canEditOperationalDailyEntry({
      role: "owner",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: true,
      dayClosed: true,
      day: { status: "reopen", lockedAt: nowMs, reopenedAt: nowMs + 1, reopenedByRole: "owner" },
      nowMs: nowMs + 2
    })).toBe(true);
  });

  it("treats legacy lock metadata as closed even when status was mapped as open", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(canEditOperationalDailyEntry({
        role,
        canWriteDaily: true,
        monthClosed: false,
        isLiveDay: false,
        dayClosed: false,
        day: { status: "open", lockedAt: nowMs },
        nowMs
      })).toBe(false);
    }

    expect(canEditOperationalDailyEntry({
      role: "owner",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: false,
      day: { status: "open", closedAt: nowMs },
      nowMs
    })).toBe(false);
  });

  it("does not auto-reopen when stale reopen metadata predates the close", () => {
    const staleReopen = {
      status: "closed" as const,
      lockedAt: nowMs,
      reopenedAt: nowMs - 1,
      reopenedByRole: "owner" as const
    };
    expect(isAdminEditableReopenedDay(staleReopen, nowMs)).toBe(false);
    expect(canEditOperationalDailyEntry({
      role: "owner",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: true,
      day: staleReopen,
      nowMs
    })).toBe(false);
  });

  it("keeps legacy closed days read-only even when old reopen timestamps are present", () => {
    const legacyTimedReopen = {
      status: "closed" as const,
      closedAt: nowMs - 120_000,
      reopenedAt: nowMs - 60_000,
      reopenedUntilAt: nowMs + 60_000,
      reopenedByRole: "owner" as const
    };

    expect(isAdminEditableReopenedDay(legacyTimedReopen, nowMs)).toBe(false);
    expect(canEditOperationalDailyEntry({
      role: "owner",
      canWriteDaily: true,
      monthClosed: false,
      isLiveDay: false,
      dayClosed: true,
      day: legacyTimedReopen,
      nowMs
    })).toBe(false);
  });

  it("does not let admin-authored reopen metadata unlock a previous day for admin", () => {
    expect(isAdminEditableReopenedDay({
      reopenedAt: nowMs,
      reopenedByRole: "admin"
    }, nowMs + 1)).toBe(false);
  });
});
