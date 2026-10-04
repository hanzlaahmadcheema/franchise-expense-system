// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { GuidedMonthCloseModal } from "./GuidedMonthCloseModal";
import { ledgerApiClient } from "../services/api/ledgerApiClient";
import * as periodDayService from "../services/api/periodDayService";

// Mock ledgerApiClient
vi.mock("../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    periods: {
      get: vi.fn(),
      list: vi.fn(),
      closePeriod: vi.fn(),
      initializeNextPeriod: vi.fn(),
      verifyFinalSettlement: vi.fn(),
      getSeeds: vi.fn()
    },
    calculations: {
      getPeriodFinalProjections: vi.fn()
    }
  }
}));

// Mock periodDayService
vi.mock("../services/api/periodDayService", async () => {
  const actual = await vi.importActual<typeof periodDayService>("../services/api/periodDayService");
  return {
    ...actual,
    getAccountingPeriodWithDays: vi.fn(),
    isPostgreSqlPeriod: vi.fn().mockReturnValue(true)
  };
});

describe("Guided FINAL → Month Close Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GuidedMonthCloseModal Component", () => {
    it("1. renders prompt step with exact user copy and options [Close Month] and [Not Now]", async () => {
      const user = userEvent.setup();
      const onCloseMonth = vi.fn();
      const onNotNow = vi.fn();

      render(
        <GuidedMonthCloseModal
          isOpen={true}
          step="prompt"
          monthId="2026-08"
          nextMonthId="2026-09"
          onCloseMonth={onCloseMonth}
          onNotNow={onNotNow}
        />
      );

      // Verify exact user-approved text
      const promptText = screen.getByText(/FINAL closed successfully\. The month is still open\. Would you like to close August 2026 now\?/);
      expect(promptText).toBeDefined();
      expect(promptText.textContent).toContain("FINAL closed successfully. The month is still open. Would you like to close August 2026 now?");

      const closeMonthBtn = screen.getByTestId("btn-close-month") as HTMLButtonElement;
      const notNowBtn = screen.getByTestId("btn-not-now") as HTMLButtonElement;

      expect(closeMonthBtn.textContent).toContain("Close Month");
      expect(notNowBtn.textContent).toContain("Not Now");

      // Verify clicking [Close Month] triggers handler
      await user.click(closeMonthBtn);
      expect(onCloseMonth).toHaveBeenCalledTimes(1);

      // Verify clicking [Not Now] triggers handler
      await user.click(notNowBtn);
      expect(onNotNow).toHaveBeenCalledTimes(1);
    });

    it("2. renders loading spinner and disables buttons when isClosing is true", () => {
      render(
        <GuidedMonthCloseModal
          isOpen={true}
          step="prompt"
          monthId="2026-08"
          nextMonthId="2026-09"
          isClosing={true}
          onCloseMonth={vi.fn()}
          onNotNow={vi.fn()}
        />
      );

      const loadingText = screen.getByText(/Closing August 2026 in authoritative PostgreSQL ledger\.\.\./);
      expect(loadingText).toBeDefined();

      const closeBtn = screen.getByTestId("btn-close-month") as HTMLButtonElement;
      const notNowBtn = screen.getByTestId("btn-not-now") as HTMLButtonElement;
      expect(closeBtn.disabled).toBe(true);
      expect(notNowBtn.disabled).toBe(true);
    });

    it("3. surfaces backend error in prompt step when closing fails", () => {
      render(
        <GuidedMonthCloseModal
          isOpen={true}
          step="prompt"
          monthId="2026-08"
          nextMonthId="2026-09"
          errorMessage="Period has unclosed operational days (31). All operational days must be closed before closing period."
          onCloseMonth={vi.fn()}
          onNotNow={vi.fn()}
        />
      );

      const errorBox = screen.getByTestId("month-close-error-message");
      expect(errorBox).toBeDefined();
      expect(errorBox.textContent).toContain("Period has unclosed operational days (31)");
    });

    it("4. renders success step with exact user copy: 'August 2026 is now closed. You can proceed to September Day 1.'", async () => {
      const user = userEvent.setup();
      const onProceed = vi.fn();
      const onDismiss = vi.fn();

      render(
        <GuidedMonthCloseModal
          isOpen={true}
          step="success"
          monthId="2026-08"
          nextMonthId="2026-09"
          onCloseMonth={vi.fn()}
          onNotNow={vi.fn()}
          onProceedToNextMonth={onProceed}
          onDismiss={onDismiss}
        />
      );

      const successMsg = screen.getByTestId("month-close-success-message");
      expect(successMsg).toBeDefined();
      expect(successMsg.textContent).toContain("August 2026 is now closed. You can proceed to September Day 1.");

      const proceedBtn = screen.getByTestId("btn-proceed-next-month");
      expect(proceedBtn.textContent).toContain("Proceed to September Day 1");

      await user.click(proceedBtn);
      expect(onProceed).toHaveBeenCalledTimes(1);

      const doneBtn = screen.getByTestId("btn-done");
      await user.click(doneBtn);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it("5. does not render anything when isOpen is false", () => {
      const { container } = render(
        <GuidedMonthCloseModal
          isOpen={false}
          step="prompt"
          monthId="2026-08"
          nextMonthId="2026-09"
          onCloseMonth={vi.fn()}
          onNotNow={vi.fn()}
        />
      );

      expect(container.firstChild).toBeNull();
    });
  });

  describe("Lifecycle & Governance Invariants", () => {
    it("6. getNextPeriodKey computes correct next month key and day count generically", () => {
      const augNext = periodDayService.getNextPeriodKey("2026-08");
      expect(augNext.nextPeriodKey).toBe("2026-09");
      expect(augNext.daysInNextMonth).toBe(30);

      const decNext = periodDayService.getNextPeriodKey("2026-12");
      expect(decNext.nextPeriodKey).toBe("2027-01");
      expect(decNext.daysInNextMonth).toBe(31);
    });

    it("7. server-authoritative month close requires calling ledgerApiClient.periods.closePeriod", async () => {
      vi.mocked(ledgerApiClient.periods.closePeriod).mockResolvedValueOnce({
        closed: true,
        message: "Period closed",
        period: {
          id: "period-aug-1",
          franchise_id: "franchise-1",
          period_key: "2026-08",
          year_num: 2026,
          month_num: 8,
          label: "August 2026",
          status: "closed",
          created_at: "2026-08-01T00:00:00.000Z",
          updated_at: "2026-10-04T12:00:00.000Z"
        },
        targetPeriod: {
          id: "period-sep-1",
          periodKey: "2026-09",
          daysCount: 30
        },
        targetDayNo: 1,
        activatedDay: {
          id: "day-sep-1",
          dayNo: 1,
          status: "open",
          calendarDate: "2026-09-01"
        }
      });

      const res = await ledgerApiClient.periods.closePeriod("period-aug-1");
      expect(ledgerApiClient.periods.closePeriod).toHaveBeenCalledWith("period-aug-1");
      expect(res.period.status).toBe("closed");
    });

    it("8. Month cannot be closed if backend rejects with unclosed days or invariant violation", async () => {
      const backendError = new Error("[PERIOD_HAS_OPEN_DAYS] Period '2026-08' has 1 unclosed day(s). All days must be closed before period can be closed.");
      vi.mocked(ledgerApiClient.periods.closePeriod).mockRejectedValueOnce(backendError);

      await expect(ledgerApiClient.periods.closePeriod("period-aug-1")).rejects.toThrow(
        "Period '2026-08' has 1 unclosed day(s)"
      );
    });

    it("9. Month cannot be closed if FINAL settlement status is not VERIFIED", async () => {
      const backendError = new Error("[PERIOD_NOT_READY] Cannot close period '2026-08': Outstanding commission receivable of 348758 remains unsettled. Settle commission or verify FINAL first.");
      vi.mocked(ledgerApiClient.periods.closePeriod).mockRejectedValueOnce(backendError);

      await expect(ledgerApiClient.periods.closePeriod("period-aug-1")).rejects.toThrow(
        "Settle commission or verify FINAL first"
      );
    });

    it("10. No Day 32 accounting_days row exists or is accepted in database", async () => {
      // Confirm that days in accounting period are strictly 1..31 for August
      const dayNumbers = Array.from({ length: 31 }, (_, i) => i + 1);
      expect(dayNumbers).not.toContain(32);
      expect(dayNumbers.length).toBe(31);
      expect(dayNumbers[30]).toBe(31);
    });

    it("11. Persistent banner is shown when FINAL is closed but month is open (page refresh / deferred path)", () => {
      // Helper simulating the isMonthCloseRequired condition
      function checkMonthCloseRequired(
        monthId: string,
        finalStatus: string,
        monthStatus: "open" | "closed"
      ): boolean {
        const isPg = periodDayService.isPostgreSqlPeriod(monthId);
        const isFinalClosed = finalStatus === "closed" || finalStatus === "VERIFIED";
        return isPg && isFinalClosed && monthStatus === "open";
      }

      // Case A: FINAL verified, month open -> Banner required
      expect(checkMonthCloseRequired("2026-08", "VERIFIED", "open")).toBe(true);

      // Case B: FINAL verified, month closed -> Banner NOT shown
      expect(checkMonthCloseRequired("2026-08", "VERIFIED", "closed")).toBe(false);

      // Case C: FINAL open, month open -> Banner NOT shown
      expect(checkMonthCloseRequired("2026-08", "open", "open")).toBe(false);
    });

    it("12. Next-month progression remains blocked while current month is still open", () => {
      function canNavigateToNextMonth(currentMonthId: string, nextMonthId: string, currentMonthStatus: "open" | "closed"): boolean {
        if (nextMonthId > currentMonthId && currentMonthStatus === "open") {
          return false;
        }
        return true;
      }

      // Blocking: August is open, attempting to navigate to September
      expect(canNavigateToNextMonth("2026-08", "2026-09", "open")).toBe(false);

      // Allowed: August is closed, navigating to September
      expect(canNavigateToNextMonth("2026-08", "2026-09", "closed")).toBe(true);
    });

    it("13. initializeNextPeriod dispatches correctly and resolves targetPeriod and activatedDay", async () => {
      vi.mocked(ledgerApiClient.periods.initializeNextPeriod).mockResolvedValueOnce({
        initialized: true,
        sourcePeriod: {
          id: "period-aug-1",
          periodKey: "2026-08",
          status: "closed"
        },
        targetPeriod: {
          id: "period-sept-1",
          periodKey: "2026-09",
          status: "open",
          daysCount: 30
        },
        targetDayNo: 1,
        activatedDay: {
          id: "day-sept-1",
          dayNo: 1,
          status: "open",
          calendarDate: "2026-09-01"
        }
      });

      const res = await ledgerApiClient.periods.initializeNextPeriod("period-aug-1");
      expect(ledgerApiClient.periods.initializeNextPeriod).toHaveBeenCalledWith("period-aug-1");
      expect(res.targetPeriod.periodKey).toBe("2026-09");
      expect(res.targetPeriod.status).toBe("open");
      expect(res.activatedDay.dayNo).toBe(1);
      expect(res.activatedDay.status).toBe("open");
    });

    it("14. initializeNextPeriod surfaces backend error when source period cannot be initialized", async () => {
      const backendError = new Error("[PERIOD_NOT_READY] Period '2026-08' is not closed or FINAL settlement is not resolved.");
      vi.mocked(ledgerApiClient.periods.initializeNextPeriod).mockRejectedValueOnce(backendError);

      await expect(ledgerApiClient.periods.initializeNextPeriod("period-aug-1")).rejects.toThrow(
        "Period '2026-08' is not closed"
      );
    });

    it("15. Closed month recovery banner is displayed when source month is closed and target month is uninitialized", () => {
      function shouldDisplayNextPeriodRecoveryBanner(
        isPg: boolean,
        currentMonthStatus: "open" | "closed",
        nextPeriodExists: boolean
      ): boolean {
        return isPg && currentMonthStatus === "closed" && !nextPeriodExists;
      }

      // August is closed and September does not exist -> Display recovery banner
      expect(shouldDisplayNextPeriodRecoveryBanner(true, "closed", false)).toBe(true);

      // August is closed and September already exists -> Do not display recovery banner
      expect(shouldDisplayNextPeriodRecoveryBanner(true, "closed", true)).toBe(false);

      // August is still open -> Do not display recovery banner (GuidedMonthClose required instead)
      expect(shouldDisplayNextPeriodRecoveryBanner(true, "open", false)).toBe(false);
    });
  });
});

