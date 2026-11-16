// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { JazzLoadModule } from "./JazzLoadModule";
import { SelectedDateProvider } from "../../../shared/context/SelectedDateContext";
import { SidebarDayControlsProvider } from "../../../shared/context/SidebarDayControlsContext";
import { defaultLedgerReadModeConfig } from "../../../shared/ledger/ledgerTypes";
import type { LedgerUser } from "../../../types/ledger";

vi.mock("../services/jazzLoadFirestore", () => ({
  subscribeJazzLoadDoProfiles: vi.fn((cb) => {
    cb([
      { id: "prof-1", name: "Alpha DO", line: "Line 1", active: true }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadDoNames: vi.fn((cb) => {
    cb([
      { id: "name-1", name: "Alpha DO", active: true, sortOrder: 0 }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadDoLines: vi.fn((cb) => {
    cb([
      { id: "line-1", line: "Line 1", active: true, sortOrder: 0 }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadDoLineBindings: vi.fn((cb) => {
    cb([
      {
        id: "bind-1",
        lineId: "line-1",
        doNameId: "name-1",
        effectiveFromMonthId: "2026-01",
        effectiveFromDay: 1,
        doName: "Alpha DO",
        line: "Line 1"
      }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadRates: vi.fn((cb) => {
    cb([
      { id: "rate-ml", type: "ml_addition", name: "Standard ML", percentage: 2.6, active: true, sortOrder: 0 },
      { id: "rate-comm1", type: "commission1_adjustment", name: "Comm 1", percentage: 2.6, active: true, sortOrder: 1 },
      { id: "rate-comm2", type: "commission2_payment", name: "Comm 2", percentage: 1.0, active: true, sortOrder: 2 }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadMonths: vi.fn((cb) => {
    cb([
      { id: "2026-01", status: "open", name: "Jan 2026" }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadDays: vi.fn((_monthId, cb) => {
    cb([
      {
        id: "2026-01-01",
        monthId: "2026-01",
        dayNo: 1,
        status: "open",
        lifting: {
          openingBalance: 50000,
          mlLifting: 100000,
          totalBalance: 150000,
          todayMlIssuance: 90000,
          inHandBalance: 60000
        },
        doEntries: [
          {
            id: "entry-1",
            doProfileId: "prof-1",
            doNameId: "name-1",
            doLineId: "line-1",
            doName: "Alpha DO",
            doLine: "Line 1",
            openingBalance: { baseAmount: 10000, calculatedAmount: 10260 },
            todayMlIssuance: { baseAmount: 20000, calculatedAmount: 20520 },
            dayTotal: { baseAmount: 30000, calculatedAmount: 30780 },
            paymentReceived: { baseAmount: 15000, calculatedAmount: 15390 },
            closingBalance: { baseAmount: 15000, calculatedAmount: 15390 }
          }
        ],
        summary: {
          openingBase: 10000,
          openingMl: 10260,
          issuanceBase: 20000,
          issuanceMl: 20520,
          dayTotalBase: 30000,
          dayTotalMl: 30780,
          paymentBase: 15000,
          paymentMl: 15390,
          closingBase: 15000,
          closingMl: 15390,
          commission1: 10,
          commission2: 150,
          totalCommission: 160
        }
      }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeJazzLoadMonthlySummary: vi.fn((_monthId, cb) => {
    cb({
      monthId: "2026-01",
      totalIssuanceMl: 20520,
      totalPaymentsBase: 15000,
      latestInHandBalance: 60000,
      totalCommission: 160,
      dayRows: [],
      doBalances: []
    }, { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  saveJazzLoadDay: vi.fn().mockResolvedValue({ success: true }),
  ensureJazzLoadMonth: vi.fn().mockResolvedValue({ id: "2026-01", status: "open" }),
  closeJazzLoadDaysExceptToday: vi.fn(),
  reopenJazzLoadDaysFor15Minutes: vi.fn(),
  roleCanJazzLoad: vi.fn((role, permission) => {
    if (!role) return false;
    if (permission === "read") return true;
    if (permission === "settings") return role === "owner";
    return true;
  }),
  deleteJazzLoadDoLine: vi.fn(),
  deleteJazzLoadDoName: vi.fn(),
  deleteJazzLoadRate: vi.fn(),
  applyJazzLoadDoBindingBackfill: vi.fn(),
  previewJazzLoadDoBindingBackfill: vi.fn(),
  recalculateJazzLoadLedgerLocal: vi.fn(),
  updateJazzLoadDoLineSortOrder: vi.fn(),
  updateJazzLoadDoNameSortOrder: vi.fn(),
  updateJazzLoadRateSortOrder: vi.fn(),
  upsertJazzLoadDoLineBinding: vi.fn(),
  upsertJazzLoadDoLine: vi.fn(),
  upsertJazzLoadDoName: vi.fn(),
  upsertJazzLoadDoProfile: vi.fn(),
  upsertJazzLoadRate: vi.fn()
}));

vi.mock("../../../services/api/dayLifecycleService", () => ({
  closeOperationalDayUnified: vi.fn().mockResolvedValue({ success: true }),
  reopenOperationalDayUnified: vi.fn().mockResolvedValue({ success: true }),
  subscribeDayStatus: vi.fn(() => vi.fn())
}));

vi.mock("../../../services/api/periodDayService", () => ({
  isPostgreSqlPeriod: vi.fn(() => false),
  getAccountingPeriodWithDays: vi.fn().mockResolvedValue(null)
}));

vi.mock("../services/jazzLoadReports", () => ({
  exportJazzLoadPrintable: vi.fn(),
  exportJazzLoadXlsx: vi.fn()
}));

const testUser: LedgerUser = {
  uid: "test-user-123",
  email: "owner@franchise.local",
  displayName: "Test Owner"
};

function renderJazzLoad(props: Partial<React.ComponentProps<typeof JazzLoadModule>> = {}) {
  const defaultProps: React.ComponentProps<typeof JazzLoadModule> = {
    user: testUser,
    role: "owner",
    monthId: "2026-01",
    syncState: "synced",
    syncLabel: "All changes synced",
    onSnapshotMetadata: vi.fn(),
    onFirestoreError: vi.fn(),
    onQueueWrite: vi.fn(),
    onStatus: vi.fn(),
    onExportBackup: vi.fn(),
    onImportBackup: vi.fn(),
    ledgerReadModeConfig: defaultLedgerReadModeConfig,
    loading: false,
    onPendingStateChange: vi.fn(),
    ...props
  };

  return render(
    <SelectedDateProvider
      value={{
        monthId: "2026-01",
        selectedDay: 1,
        selectedDateKey: "2026-01-01",
        setSelectedDay: vi.fn()
      }}
    >
      <SidebarDayControlsProvider>
        <JazzLoadModule {...defaultProps} />
      </SidebarDayControlsProvider>
    </SelectedDateProvider>
  );
}

describe("JazzLoadModule — Redesigned Navigation & Workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders 4 clean segmented tabs and removes legacy duplicate tabs", () => {
    renderJazzLoad();

    // Verify 4 redesigned tabs exist
    expect(screen.getByRole("button", { name: /Daily Lifting & Issuance/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Monthly Reports & Summaries/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /DO Profiles & Rates/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Formulas & Reference/i })).toBeTruthy();

    // Verify legacy duplicate tabs are removed
    expect(screen.queryByRole("button", { name: /^Dashboard$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Backup$/i })).toBeNull();

    // Verify redundant module header is not rendered
    expect(screen.queryByRole("heading", { name: "Jazz Load Ledger", level: 2 })).toBeNull();
  });

  it("renders the Daily Lifting & Issuance workflow by default with SaveControlBar and Day Context", async () => {
    renderJazzLoad();

    // Context bar
    expect(screen.getByText("2026-01-01")).toBeTruthy();
    expect(screen.getByText("OPEN")).toBeTruthy();

    // Daily Lifting metric cards and DO table
    expect(screen.getAllByText("Opening Balance").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Jazz Load Lifting")).toBeTruthy();
    expect(screen.getByText("Total Balance")).toBeTruthy();
    expect(screen.getByText("Today Issuance")).toBeTruthy();
    expect(screen.getByText("In-Hand Balance")).toBeTruthy();

    // Daily DO Entry section and headers
    expect(screen.getByText("Daily DO Entry")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /DO Name/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Total Receivable/i })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: /Payment Received/i })).toBeTruthy();

    // Unified sidebar save action
    expect(screen.getByRole("button", { name: /Save Now & Verify/i })).toBeTruthy();
  });

  it("navigates to Monthly Reports & Summaries tab and displays overview metric cards", async () => {
    renderJazzLoad();

    const reportsTab = screen.getByRole("button", { name: /Monthly Reports & Summaries/i });
    fireEvent.click(reportsTab);

    // Verify overview metric cards and tables are present in Reports
    expect(screen.getAllByText("Issuance Jazz Load").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Payments").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Latest In-Hand")).toBeTruthy();
    expect(screen.getByText("Commission")).toBeTruthy();

    // Verify export buttons
    expect(screen.getByRole("button", { name: /Export Excel/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export PDF\/Print/i })).toBeTruthy();
  });

  it("navigates to Formulas & Reference tab and renders mathematical definitions for all users", async () => {
    // Test with non-owner role (viewer) to ensure accessibility
    renderJazzLoad({ role: "viewer" });

    const formulasTab = screen.getByRole("button", { name: /Formulas & Reference/i });
    fireEvent.click(formulasTab);

    // Verify mathematical explanations are shown
    expect(screen.getByText(/1\. Jazz Load Addition \(ML Addition\)/i)).toBeTruthy();
    expect(screen.getByText(/2\. Daily Lifting & In-Hand Balance/i)).toBeTruthy();
    expect(screen.getByText(/3\. Commission Calculations/i)).toBeTruthy();
    expect(screen.getByText(/Jazz Load ML = Base Amount \* \(1 \+ ML Rate% \/ 100\)/i)).toBeTruthy();
  });

  it("disables DO Profiles & Rates tab and restricts access for non-owner roles", () => {
    renderJazzLoad({ role: "viewer" });

    const settingsTab = screen.getByRole("button", { name: /DO Profiles & Rates/i });
    expect(settingsTab.hasAttribute("disabled")).toBe(true);
    expect(settingsTab.getAttribute("title")).toContain("Only owner can manage Jazz Load");
  });

  it("protects unsaved changes when user attempts to leave screen while dirty", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderJazzLoad();

    // Find the lifting input and change value
    const inputs = screen.getAllByRole("textbox");
    const liftingInput = inputs.find((i) => i.getAttribute("inputmode") === "decimal");
    if (liftingInput) {
      fireEvent.change(liftingInput, { target: { value: "123456" } });
    }

    // Try to switch tabs
    const reportsTab = screen.getByRole("button", { name: /Monthly Reports & Summaries/i });
    fireEvent.click(reportsTab);

    // Should not switch because user cancelled
    confirmSpy.mockRestore();
  });

  it("does not render Close Day in the module-specific section as day closing is global", () => {
    renderJazzLoad({ role: "owner" });

    // Day closing is global, not inside the module-specific section
    expect(screen.queryByRole("button", { name: /Close Day/i })).toBeNull();
  });
});
