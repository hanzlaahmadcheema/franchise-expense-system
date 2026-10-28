import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  closeOperationalDayUnified,
  reopenOperationalDayUnified,
  subscribeDayStatus,
  type UnifiedDayCloseInput
} from "./dayLifecycleService";
import { ledgerApiClient, type AccountingDayRecord } from "./ledgerApiClient";
import * as periodDayService from "./periodDayService";

describe("dayLifecycleService", () => {
  const monthId = "2026-08";
  const periodId = "f63be61b-1183-4f6a-ada5-87d267eeb4dc";
  const dummyDay: AccountingDayRecord = {
    id: "day-1-id",
    franchise_id: "franchise-1",
    period_id: periodId,
    day_no: 1,
    day_type: "calendar",
    status: "closed",
    calendar_date: "2026-08-01",
    label: "Day 1",
    notes: null,
    closed_at: "2026-08-01T20:00:00.000Z",
    reopened_at: null
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(periodDayService, "getAccountingPeriodWithDays").mockResolvedValue({
      period: {
        id: periodId,
        franchise_id: "franchise-1",
        period_key: monthId,
        year_num: 2026,
        month_num: 8,
        status: "open",
        label: "August 2026",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z"
      },
      days: new Map([[1, dummyDay]]),
      fetchedAt: Date.now()
    });
  });

  it("closes an operational day and refreshes cache upon success", async () => {
    const closeSpy = vi.spyOn(ledgerApiClient.periods, "closeDay").mockResolvedValue({
      message: "Day closed",
      day: dummyDay
    });
    const cacheSpy = vi.spyOn(periodDayService, "getAccountingPeriodWithDays");

    let statusNotification: any = null;
    const unsubscribe = subscribeDayStatus((event) => {
      statusNotification = event;
    });

    const result = await closeOperationalDayUnified({
      monthId,
      dayNo: 1,
      notes: "EOD close"
    });

    expect(closeSpy).toHaveBeenCalledWith(periodId, 1, "EOD close");
    expect(cacheSpy).toHaveBeenCalledWith(monthId, true);
    expect(result.day.status).toBe("closed");
    expect(statusNotification).toEqual({
      monthId,
      dayNo: 1,
      status: "closed",
      day: dummyDay
    });

    unsubscribe();
  });

  it("flushes pending draft before closing and proceeds if flush succeeds", async () => {
    const flushDraft = vi.fn().mockResolvedValue(true);
    const closeSpy = vi.spyOn(ledgerApiClient.periods, "closeDay").mockResolvedValue({
      message: "Day closed",
      day: dummyDay
    });

    await closeOperationalDayUnified({
      monthId,
      dayNo: 1,
      flushDraft
    });

    expect(flushDraft).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalled();
  });

  it("aborts close without calling backend if flushDraft returns false", async () => {
    const flushDraft = vi.fn().mockResolvedValue(false);
    const closeSpy = vi.spyOn(ledgerApiClient.periods, "closeDay");

    await expect(
      closeOperationalDayUnified({
        monthId,
        dayNo: 1,
        flushDraft
      })
    ).rejects.toThrow("Cannot close day: pending changes could not be saved");

    expect(flushDraft).toHaveBeenCalled();
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("aborts close and retains error detail if flushDraft throws", async () => {
    const flushDraft = vi.fn().mockRejectedValue(new Error("Network timeout"));
    const closeSpy = vi.spyOn(ledgerApiClient.periods, "closeDay");

    await expect(
      closeOperationalDayUnified({
        monthId,
        dayNo: 1,
        flushDraft
      })
    ).rejects.toThrow("Cannot close day: pending changes could not be saved (Network timeout)");

    expect(closeSpy).not.toHaveBeenCalled();
  });

  it("retains truthful state when save succeeds but close fails", async () => {
    const flushDraft = vi.fn().mockResolvedValue(true);
    vi.spyOn(ledgerApiClient.periods, "closeDay").mockRejectedValue(
      new Error("Cross-module invariant violated: negative stock detected")
    );

    let statusCalled = false;
    const unsubscribe = subscribeDayStatus(() => {
      statusCalled = true;
    });

    await expect(
      closeOperationalDayUnified({
        monthId,
        dayNo: 1,
        flushDraft
      })
    ).rejects.toThrow("Cross-module invariant violated: negative stock detected");

    expect(flushDraft).toHaveBeenCalled();
    // Status event must NOT be published for failed close
    expect(statusCalled).toBe(false);

    unsubscribe();
  });

  it("prevents duplicate concurrent close requests for the same day", async () => {
    let resolveClose: (val: any) => void;
    const closePromise = new Promise((resolve) => {
      resolveClose = resolve;
    });
    vi.spyOn(ledgerApiClient.periods, "closeDay").mockImplementation(() => closePromise as any);

    const call1 = closeOperationalDayUnified({ monthId, dayNo: 1 });
    const call2 = closeOperationalDayUnified({ monthId, dayNo: 1 });

    await expect(call2).rejects.toThrow("Day 1 close is already in progress");

    resolveClose!({ message: "Done", day: dummyDay });
    await call1;
  });

  it("reopens an operational day and publishes reopen status event", async () => {
    const reopenedDay: AccountingDayRecord = {
      ...dummyDay,
      status: "reopen",
      reopened_at: "2026-08-02T10:00:00.000Z",
      notes: "Owner correction"
    };
    const reopenSpy = vi.spyOn(ledgerApiClient.periods, "reopenDay").mockResolvedValue({
      message: "Day reopened",
      day: reopenedDay
    });

    let statusNotification: any = null;
    const unsubscribe = subscribeDayStatus((event) => {
      statusNotification = event;
    });

    const result = await reopenOperationalDayUnified({
      monthId,
      dayNo: 1,
      reason: "Owner correction"
    });

    expect(reopenSpy).toHaveBeenCalledWith(periodId, 1, "Owner correction");
    expect(result.day.status).toBe("reopen");
    expect(statusNotification).toEqual({
      monthId,
      dayNo: 1,
      status: "reopen",
      day: reopenedDay
    });

    unsubscribe();
  });
});
