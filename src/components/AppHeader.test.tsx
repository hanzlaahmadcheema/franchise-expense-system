// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AppHeader, type AppHeaderProps } from "./AppHeader";
import React, { useState } from "react";

describe("AppHeader Component", () => {
  const defaultProps: AppHeaderProps = {
    franchiseName: "Jazz Franchise - 7301",
    monthId: "2026-10",
    monthChoices: [
      ["2026-08", "closed"],
      ["2026-09", "closed"],
      ["2026-10", "open"]
    ],
    currentMonthStatus: "open",
    isMonthCloseRequired: false,
    onMonthChange: vi.fn(),
    selectedDay: 26,
    selectedDayStatus: "open",
    isDayView: true,
    onDaySelect: vi.fn(),
    totalDaysInMonth: 31,
    daysState: [
      { dayNo: 26, status: "open" },
      { dayNo: 25, status: "closed" }
    ],
    syncState: "synced",
    syncLabel: "All changes synced",
    theme: "dark",
    onToggleTheme: vi.fn(),
    userEmail: "owner@franchise.local",
    displayName: "Owner User",
    role: "owner",
    onSignOut: vi.fn(),
    mobileMenuOpen: false,
    onToggleMobileMenu: vi.fn(),
    sidebarOpen: true,
    onToggleSidebar: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders brand identity, active month selector, day indicator, sync status, and user profile", () => {
    render(<AppHeader {...defaultProps} />);

    expect(screen.getByText("Jazz Franchise - 7301")).toBeTruthy();
    expect(screen.getByText("v2.0")).toBeTruthy();
    expect(screen.getByTitle("Active Month")).toBeTruthy();
    expect(screen.getByText(/Day 26/)).toBeTruthy();
    expect(screen.getByTitle("All changes synced")).toBeTruthy();
    expect(screen.getByText("Owner User")).toBeTruthy();
    expect(screen.getAllByText("owner").length).toBeGreaterThan(0);
  });

  it("DEF-02: month select and day popover contain narrow-screen constraint classes", () => {
    render(<AppHeader {...defaultProps} />);

    const monthSelect = screen.getByTitle("Active Month");
    // Verifies max-w constraints on narrow screens
    expect(monthSelect.className).toContain("max-w-[95px]");
    expect(monthSelect.className).toContain("sm:max-w-none");

    const dayBtn = screen.getByTitle("Click to quickly switch days");
    fireEvent.click(dayBtn);

    const dialog = screen.getByRole("dialog", { name: "Day selection calendar" });
    expect(dialog).toBeTruthy();
    // Verifies viewport clamping: fixed positioning on mobile, max-width calc(100vw-1rem)
    expect(dialog.className).toContain("fixed");
    expect(dialog.className).toContain("sm:absolute");
    expect(dialog.className).toContain("w-[min(calc(100vw-1rem),16rem)]");
  });

  it("opens Day switcher popover and selects a day", async () => {
    const onDaySelect = vi.fn();
    render(<AppHeader {...defaultProps} onDaySelect={onDaySelect} />);

    const dayBtn = screen.getByTitle("Click to quickly switch days");
    fireEvent.click(dayBtn);

    // Popover is open
    const day10Btn = screen.getByTitle("Day 10 (open)");
    expect(day10Btn).toBeTruthy();

    fireEvent.click(day10Btn);
    expect(onDaySelect).toHaveBeenCalledWith(10);
  });

  it("DEF-03: closes Day popover on Escape and restores focus to Day button", () => {
    render(<AppHeader {...defaultProps} />);

    const dayBtn = screen.getByTitle("Click to quickly switch days");
    dayBtn.focus();
    fireEvent.click(dayBtn);

    expect(screen.getByRole("dialog", { name: "Day selection calendar" })).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape" });

    // Popover should be closed
    expect(screen.queryByRole("dialog", { name: "Day selection calendar" })).toBeNull();
    // Focus should be restored to dayBtn
    expect(document.activeElement).toBe(dayBtn);
  });

  it("DEF-03: closes User menu on Escape and restores focus to User button", () => {
    render(<AppHeader {...defaultProps} />);

    const userBtn = screen.getByText("Owner User").closest("button");
    expect(userBtn).toBeTruthy();
    userBtn?.focus();
    fireEvent.click(userBtn!);

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Sign Out")).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape" });

    // Menu should be closed
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(userBtn);
  });

  it("DEF-01: Header day switch respects pending draft confirmation guard", () => {
    // Harness component modeling App.tsx handleSelectDayProtected
    function TestAppShell() {
      const [selectedDay, setSelectedDay] = useState(26);
      const [status, setStatus] = useState("");
      const [hasPendingDayChanges, setHasPendingDayChanges] = useState(true);

      function confirmLeavePendingChanges() {
        return window.confirm("There are unsaved daily-entry changes. Leave this screen anyway?");
      }

      function handleSelectDayProtected(nextDay: number) {
        if (hasPendingDayChanges && nextDay !== selectedDay && !confirmLeavePendingChanges()) {
          setStatus("Stayed on the current day because changes are still pending save.");
          return;
        }
        setSelectedDay(nextDay);
      }

      return (
        <div>
          <div data-testid="status">{status}</div>
          <div data-testid="selected-day">{selectedDay}</div>
          <button data-testid="toggle-pending" onClick={() => setHasPendingDayChanges((p) => !p)}>
            Toggle Pending
          </button>
          <AppHeader
            {...defaultProps}
            selectedDay={selectedDay}
            onDaySelect={handleSelectDayProtected}
          />
        </div>
      );
    }

    render(<TestAppShell />);
    expect(screen.getByTestId("selected-day").textContent).toBe("26");

    // Case 1: hasPendingDayChanges = true, user CANCELS confirmation
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    const dayBtn = screen.getByTitle("Click to quickly switch days");
    fireEvent.click(dayBtn);

    const day10Btn = screen.getByTitle("Day 10 (open)");
    fireEvent.click(day10Btn);

    expect(confirmSpy).toHaveBeenCalled();
    // Selected day remains unchanged at 26
    expect(screen.getByTestId("selected-day").textContent).toBe("26");
    expect(screen.getByTestId("status").textContent).toContain("Stayed on the current day");

    // Case 2: hasPendingDayChanges = true, user CONFIRMS
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTitle("Click to quickly switch days"));
    fireEvent.click(screen.getByTitle("Day 10 (open)"));

    expect(screen.getByTestId("selected-day").textContent).toBe("10");

    // Case 3: hasPendingDayChanges = false, day switches immediately without confirm
    confirmSpy.mockClear();
    fireEvent.click(screen.getByTestId("toggle-pending")); // set to false

    fireEvent.click(screen.getByTitle("Click to quickly switch days"));
    fireEvent.click(screen.getByTitle("Day 5 (open)"));

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId("selected-day").textContent).toBe("5");
  });

  it("DEF-03: closes mobile drawer on Escape and restores focus to mobile menu trigger button", () => {
    function MobileDrawerShell() {
      const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
      const mobileMenuTriggerRef = React.useRef<HTMLButtonElement | null>(null);

      React.useEffect(() => {
        if (!mobileMenuOpen) return;

        function handleKeyDown(event: KeyboardEvent) {
          if (event.key === "Escape") {
            event.preventDefault();
            setMobileMenuOpen(false);
            mobileMenuTriggerRef.current?.focus();
          }
        }

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
      }, [mobileMenuOpen]);

      return (
        <div>
          <AppHeader
            {...defaultProps}
            mobileMenuOpen={mobileMenuOpen}
            onToggleMobileMenu={() => setMobileMenuOpen((open) => !open)}
            mobileMenuTriggerRef={mobileMenuTriggerRef}
          />
          {mobileMenuOpen && (
            <section
              role="dialog"
              aria-modal="true"
              aria-label="Mobile Navigation Drawer"
              data-testid="mobile-drawer"
            >
              <button>Nav Item 1</button>
            </section>
          )}
        </div>
      );
    }

    render(<MobileDrawerShell />);

    const menuTrigger = screen.getByTitle("Open menu");
    menuTrigger.focus();
    fireEvent.click(menuTrigger);

    expect(screen.getByTestId("mobile-drawer")).toBeTruthy();

    // Press Escape
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByTestId("mobile-drawer")).toBeNull();
    expect(document.activeElement).toBe(menuTrigger);
  });

  it("renders unified primary navigation tabs and handles module switching", () => {
    const onNavigate = vi.fn();
    render(
      <AppHeader
        {...defaultProps}
        currentView="expense"
        onNavigate={onNavigate}
      />
    );

    // Primary navigation should contain the 4 module links
    const dashboardBtn = screen.getByTitle("Dashboard");
    const expenseBtn = screen.getByTitle("Expense");
    const jazzLoadBtn = screen.getByTitle("Jazz Load");
    const stockBtn = screen.getByTitle("Stock Ledger");

    expect(dashboardBtn).toBeTruthy();
    expect(expenseBtn).toBeTruthy();
    expect(jazzLoadBtn).toBeTruthy();
    expect(stockBtn).toBeTruthy();

    // Active view indicator
    expect(expenseBtn.getAttribute("aria-current")).toBe("page");
    expect(dashboardBtn.getAttribute("aria-current")).toBeNull();

    // Clicking a tab triggers onNavigate
    fireEvent.click(jazzLoadBtn);
    expect(onNavigate).toHaveBeenCalledWith("jazz-load");

    fireEvent.click(dashboardBtn);
    expect(onNavigate).toHaveBeenCalledWith("dashboard");
  });

  it("renders Expense dropdown with Daily Entry, Monthly Summary & Ledger, and Settings", () => {
    const onSelectExpenseSection = vi.fn();
    const onNavigate = vi.fn();
    render(
      <AppHeader
        {...defaultProps}
        currentView="expense"
        expenseSection="daily-entry"
        onNavigate={onNavigate}
        onSelectExpenseSection={onSelectExpenseSection}
        canManageExpenseSettings={true}
      />
    );

    // Open dropdown via options button
    const optionsBtn = screen.getByTitle("Expense options");
    fireEvent.click(optionsBtn);

    // Check dropdown options
    const dailyEntryItem = screen.getByRole("menuitem", { name: /Daily Entry/i });
    const monthlySummaryItem = screen.getByRole("menuitem", { name: /Monthly Summary & Ledger/i });
    const settingsItem = screen.getByRole("menuitem", { name: /Settings/i });

    expect(dailyEntryItem).toBeTruthy();
    expect(monthlySummaryItem).toBeTruthy();
    expect(settingsItem).toBeTruthy();

    // Clicking Monthly Summary & Ledger selects the section
    fireEvent.click(monthlySummaryItem);
    expect(onSelectExpenseSection).toHaveBeenCalledWith("previous-records");
  });

  it("renders secondary administrative items inside User menu when authorized", () => {
    const onOpenUsers = vi.fn();
    const onOpenAuditLogs = vi.fn();
    const onOpenImport = vi.fn();
    const onOpenBackup = vi.fn();
    const onTriggerMasterRefresh = vi.fn();

    render(
      <AppHeader
        {...defaultProps}
        canManageUsers
        onOpenUsers={onOpenUsers}
        canViewAuditLogs
        onOpenAuditLogs={onOpenAuditLogs}
        canUseExcelImport
        onOpenImport={onOpenImport}
        canUseBackup
        onOpenBackup={onOpenBackup}
        canRunMasterRefresh
        onTriggerMasterRefresh={onTriggerMasterRefresh}
      />
    );

    // Open User menu
    const userBtn = screen.getByText("Owner User").closest("button");
    fireEvent.click(userBtn!);

    expect(screen.getByText("System & Administration")).toBeTruthy();

    // Click Users & Permissions
    const usersBtn = screen.getByText("Users & Permissions");
    fireEvent.click(usersBtn);
    expect(onOpenUsers).toHaveBeenCalled();

    // Re-open User menu and test Audit Logs
    fireEvent.click(userBtn!);
    const auditBtn = screen.getByText("Audit Logs");
    fireEvent.click(auditBtn);
    expect(onOpenAuditLogs).toHaveBeenCalled();

    // Re-open User menu and test Master Refresh
    fireEvent.click(userBtn!);
    const refreshBtn = screen.getByText("Recalculate Balances (Master Refresh)");
    fireEvent.click(refreshBtn);
    expect(onTriggerMasterRefresh).toHaveBeenCalled();
  });

  it("hides secondary administrative items when user is unauthorized", () => {
    render(
      <AppHeader
        {...defaultProps}
        canManageUsers={false}
        canViewAuditLogs={false}
        canUseExcelImport={false}
        canUseBackup={false}
        canRunMasterRefresh={false}
      />
    );

    // Open User menu
    const userBtn = screen.getByText("Owner User").closest("button");
    fireEvent.click(userBtn!);

    // System & Administration header and items should not be present
    expect(screen.queryByText("System & Administration")).toBeNull();
    expect(screen.queryByText("Users & Permissions")).toBeNull();
    expect(screen.queryByText("Audit Logs")).toBeNull();
    expect(screen.queryByText("Excel Import")).toBeNull();
    expect(screen.queryByText("System Backup & Restore")).toBeNull();
    expect(screen.queryByText("Recalculate Balances (Master Refresh)")).toBeNull();
    // Sign out is always present
    expect(screen.getByText("Sign Out")).toBeTruthy();
  });

  it("top-bar navigation respects pending draft confirmation guard", () => {
    function AppShellNavigation() {
      const [currentView, setCurrentView] = useState("expense");
      const [status, setStatus] = useState("");
      const [hasPendingDayChanges, setHasPendingDayChanges] = useState(true);

      function confirmLeavePendingChanges() {
        return window.confirm("There are unsaved daily-entry changes. Leave this screen anyway?");
      }

      function navigateTo(nextView: string) {
        if (hasPendingDayChanges && nextView !== currentView && !confirmLeavePendingChanges()) {
          setStatus("Stayed on the current screen because changes are still pending save.");
          return;
        }
        setCurrentView(nextView);
      }

      return (
        <div>
          <div data-testid="status">{status}</div>
          <div data-testid="current-view">{currentView}</div>
          <button data-testid="toggle-pending" onClick={() => setHasPendingDayChanges((p) => !p)}>
            Toggle Pending
          </button>
          <AppHeader
            {...defaultProps}
            currentView={currentView}
            onNavigate={navigateTo}
          />
        </div>
      );
    }

    render(<AppShellNavigation />);
    expect(screen.getByTestId("current-view").textContent).toBe("expense");

    // Case 1: Cancel confirmation -> stays on expense
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByTitle("Jazz Load"));

    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId("current-view").textContent).toBe("expense");
    expect(screen.getByTestId("status").textContent).toContain("Stayed on the current screen");

    // Case 2: Confirm -> switches to Jazz Load
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByTitle("Jazz Load"));

    expect(screen.getByTestId("current-view").textContent).toBe("jazz-load");
  });

  it("renders universal Close Day and Refresh in the top navbar", () => {
    const onCloseSelectedDay = vi.fn();
    const onTriggerMasterRefresh = vi.fn();

    render(
      <AppHeader
        {...defaultProps}
        selectedDay={26}
        selectedDayStatus="open"
        isDayView={true}
        canCloseSelectedDay={true}
        onCloseSelectedDay={onCloseSelectedDay}
        canRunMasterRefresh={true}
        onTriggerMasterRefresh={onTriggerMasterRefresh}
      />
    );

    // Universal Close Day button is rendered
    const closeBtn = screen.getByRole("button", { name: /Close Day/i });
    expect(closeBtn).toBeTruthy();
    fireEvent.click(closeBtn);
    expect(onCloseSelectedDay).toHaveBeenCalled();

    // Universal Refresh button is rendered
    const refreshBtn = screen.getByRole("button", { name: /Refresh/i });
    expect(refreshBtn).toBeTruthy();
    fireEvent.click(refreshBtn);
    expect(onTriggerMasterRefresh).toHaveBeenCalled();
  });

  it("renders universal Reopen Day in the top navbar when day is closed", () => {
    const onReopenSelectedDay = vi.fn();

    render(
      <AppHeader
        {...defaultProps}
        selectedDay={25}
        selectedDayStatus="closed"
        isDayView={true}
        canReopenSelectedDay={true}
        onReopenSelectedDay={onReopenSelectedDay}
      />
    );

    const reopenBtn = screen.getByRole("button", { name: /Reopen Day/i });
    expect(reopenBtn).toBeTruthy();
    fireEvent.click(reopenBtn);
    expect(onReopenSelectedDay).toHaveBeenCalled();
  });

  it("renders universal Close Month and Reopen Month in the top navbar and user menu", () => {
    const onToggleMonth = vi.fn();
    const onInitializeNextMonth = vi.fn();

    // 1. When month is open -> renders Close Month button
    const { rerender } = render(
      <AppHeader
        {...defaultProps}
        currentMonthStatus="open"
        monthToggleLabel="Close Month"
        canToggleMonth={true}
        onToggleMonth={onToggleMonth}
        canInitializeNextMonth={true}
        onInitializeNextMonth={onInitializeNextMonth}
        nextMonthLabel="November 2026"
      />
    );

    const closeMonthBtn = screen.getByRole("button", { name: /Close Month/i });
    expect(closeMonthBtn).toBeTruthy();
    fireEvent.click(closeMonthBtn);
    expect(onToggleMonth).toHaveBeenCalledTimes(1);

    // 2. Select option for + Open Next Month
    const monthSelect = screen.getByTitle("Active Month");
    fireEvent.change(monthSelect, { target: { value: "__init_next__" } });
    expect(onInitializeNextMonth).toHaveBeenCalledTimes(1);

    // 3. When month is closed -> renders Reopen Month button
    rerender(
      <AppHeader
        {...defaultProps}
        monthId="2026-09"
        currentMonthStatus="closed"
        monthToggleLabel="Reopen Month"
        canToggleMonth={true}
        onToggleMonth={onToggleMonth}
      />
    );

    const reopenMonthBtn = screen.getByRole("button", { name: /Reopen Month/i });
    expect(reopenMonthBtn).toBeTruthy();
    fireEvent.click(reopenMonthBtn);
    expect(onToggleMonth).toHaveBeenCalledTimes(2);

    // 4. Verify User Menu contains month action
    const userBtn = screen.getByText("Owner User").closest("button");
    fireEvent.click(userBtn!);
    const userMenuReopen = screen.getByRole("menuitem", { name: /Reopen Month \(Sep 2026\)/i });
    expect(userMenuReopen).toBeTruthy();
    fireEvent.click(userMenuReopen);
    expect(onToggleMonth).toHaveBeenCalledTimes(3);
  });

  it("renders Dealers navigation item and triggers onNavigate", () => {
    const onNavigate = vi.fn();
    render(<AppHeader {...defaultProps} onNavigate={onNavigate} currentView="dashboard" />);

    const dealersBtn = screen.getByRole("button", { name: "Dealers" });
    expect(dealersBtn).toBeTruthy();

    fireEvent.click(dealersBtn);
    expect(onNavigate).toHaveBeenCalledWith("dealers");
  });
});
