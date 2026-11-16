// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UniversalDayControlBar } from "./UniversalDayControlBar";
import type { UniversalDayControlBarProps } from "../types/dayControl.types";

describe("UniversalDayControlBar Component", () => {
  const defaultProps: UniversalDayControlBarProps = {
    moduleKey: "expense",
    selectedDateLabel: "August 10, 2026",
    selectedMonthLabel: "August 2026",
    selectedStatus: "open",
    role: "owner",
    permissions: {
      canCloseSelectedDay: true,
      canReopenSelectedDay: false,
      canRunMasterRefresh: true
    },
    autoSaveStatus: "saved",
    busy: false,
    density: "regular",
    onCloseSelectedDay: vi.fn(),
    onReopenSelectedDay: vi.fn(),
    onRunMasterRefresh: vi.fn(),
    closeDayLabel: "Close Day"
  };

  it("renders single-day action buttons and does not render bulk day actions", () => {
    render(<UniversalDayControlBar {...defaultProps} />);

    // Supported actions should exist
    expect(screen.getByText("Master Refresh Calculations")).toBeTruthy();
    expect(screen.getByText("Close Day")).toBeTruthy();
    expect(screen.getByText("Reopen Selected Day")).toBeTruthy();

    // Unsupported bulk day actions must NOT exist
    expect(screen.queryByText("Reopen All Days")).toBeNull();
    expect(screen.queryByText("Close All Previous Days Except Today")).toBeNull();
  });

  it("handles onCloseSelectedDay and onRunMasterRefresh clicks", () => {
    const onClose = vi.fn();
    const onRefresh = vi.fn();

    render(
      <UniversalDayControlBar
        {...defaultProps}
        onCloseSelectedDay={onClose}
        onRunMasterRefresh={onRefresh}
      />
    );

    fireEvent.click(screen.getByText("Close Day"));
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByText("Master Refresh Calculations"));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("respects disabled reasons and permissions", () => {
    render(
      <UniversalDayControlBar
        {...defaultProps}
        permissions={{
          canCloseSelectedDay: false,
          closeDisabledReason: "Day is locked",
          canReopenSelectedDay: false,
          reopenDisabledReason: "Cannot reopen",
          canRunMasterRefresh: false,
          masterRefreshDisabledReason: "Only owner can run refresh"
        }}
      />
    );

    const closeBtn = screen.getByText("Close Day");
    expect(closeBtn.hasAttribute("disabled")).toBe(true);
    expect(closeBtn.getAttribute("title")).toBe("Day is locked");

    const refreshBtn = screen.getByText("Master Refresh Calculations");
    expect(refreshBtn.hasAttribute("disabled")).toBe(true);
    expect(refreshBtn.getAttribute("title")).toBe("Only owner can run refresh");
  });
});
