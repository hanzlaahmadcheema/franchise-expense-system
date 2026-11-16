// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { StockLedgerModule } from "./StockLedgerModule";
import { SelectedDateProvider } from "../../../shared/context/SelectedDateContext";
import { SidebarDayControlsProvider } from "../../../shared/context/SidebarDayControlsContext";
import { defaultLedgerReadModeConfig } from "../../../shared/ledger/ledgerTypes";
import type { LedgerUser } from "../../../types/ledger";

vi.mock("../services/stockFirestore", () => ({
  subscribeStockProducts: vi.fn((cb) => {
    cb([
      { id: "prod-1", name: "Jazz Load Scratch Card", rate: 100, active: true, sortOrder: 0 },
      { id: "prod-2", name: "SIM Card 4G", rate: 250, active: true, sortOrder: 1 }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeStockAccounts: vi.fn((cb) => {
    cb([
      { id: "acc-1", name: "Employee Ali", type: "CCR", active: true, openingBalance: 5000, sortOrder: 0 },
      { id: "acc-2", name: "Dealer Bilal", type: "DO", active: true, openingBalance: 10000, sortOrder: 1 }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeStockMonths: vi.fn((cb) => {
    cb([
      { id: "2026-01", status: "open", name: "Jan 2026" }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeStockDays: vi.fn((_monthId, cb) => {
    cb([
      {
        id: "2026-01-01",
        monthId: "2026-01",
        dayNo: 1,
        status: "open",
        entries: [
          {
            id: "entry-1",
            accountId: "acc-1",
            accountName: "Employee Ali",
            products: [{ productId: "prod-1", productName: "Jazz Load Scratch Card", quantity: 50, rate: 100, amount: 5000 }],
            totalQty: 50,
            totalAmount: 5000,
            paymentReceived: 3000,
            carryForwardBalance: 5000,
            dueBalance: 7000
          }
        ],
        stockIn: [],
        summary: {
          totalQty: 50,
          totalAmount: 5000,
          totalPaymentReceived: 3000,
          totalDueBalance: 7000
        }
      }
    ], { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeStockMonthlySummary: vi.fn((_monthId, cb) => {
    cb({
      monthId: "2026-01",
      totalQty: 50,
      totalAmount: 5000,
      totalPaymentReceived: 3000,
      totalDueBalance: 7000,
      productTotals: [],
      accountTotals: [
        { accountId: "acc-1", accountName: "Employee Ali", accountType: "CCR", totalQty: 50, totalAmount: 5000, totalPaymentReceived: 3000, dueBalance: 7000, activeDays: 1 }
      ],
      paymentTotals: [],
      dayRows: [],
      missingDays: [],
      updatedAt: Date.now()
    }, { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeStockOpeningBalances: vi.fn((cb) => {
    cb({ openingStock: { "prod-1": 100, "prod-2": 50 }, jazzOpeningPayable: 0, stockAccountOpening: { "acc-1": 5000 } }, { source: "cache", hasPendingWrites: false });
    return vi.fn();
  }),
  subscribeStockSettingsConfig: vi.fn((cb) => {
    cb({ allowManualCarryForwardInput: false });
    return vi.fn();
  }),
  roleCanStock: vi.fn((role, perm) => {
    if (!role) return false;
    if (perm === "read") return true;
    if (role === "owner") return true;
    if (role === "admin") return perm === "daily" || perm === "settings";
    return false;
  }),
  listStockBackup: vi.fn(() => Promise.resolve({
    stockMonths: [{ id: "2026-01", status: "open" }],
    products: [{ id: "prod-1", name: "Jazz Load Scratch Card" }],
    accounts: [{ id: "acc-1", name: "Employee Ali" }]
  })),
  ensureStockMonth: vi.fn(() => Promise.resolve({ id: "2026-01", status: "open" })),
  ensureStockOpeningSeed: vi.fn(() => Promise.resolve()),
  recalculateStockLedgerLocal: vi.fn(() => ({})),
  saveStockDay: vi.fn(() => Promise.resolve()),
  updateStockDaysStatusBatch: vi.fn(() => Promise.resolve({ days: [], summary: null })),
  deleteStockAccount: vi.fn(() => Promise.resolve()),
  deleteStockProduct: vi.fn(() => Promise.resolve()),
  upsertStockAccount: vi.fn(() => Promise.resolve()),
  upsertStockProduct: vi.fn(() => Promise.resolve()),
  updateStockAccountSortOrder: vi.fn(() => Promise.resolve()),
  updateStockProductSortOrder: vi.fn(() => Promise.resolve())
}));

vi.mock("../services/stockReports", () => ({
  exportStockDayXlsx: vi.fn(),
  exportStockMonthlyXlsx: vi.fn(),
  exportStockPrintable: vi.fn()
}));

vi.mock("../../../services/api/dayLifecycleService", () => ({
  closeOperationalDayUnified: vi.fn(() => Promise.resolve()),
  reopenOperationalDayUnified: vi.fn(() => Promise.resolve()),
  subscribeDayStatus: vi.fn(() => vi.fn())
}));

vi.mock("../../../services/api/periodDayService", () => ({
  isPostgreSqlPeriod: vi.fn(() => false),
  resolveAccountingDayId: vi.fn(() => "2026-01-01"),
  getAccountingPeriodWithDays: vi.fn(() => Promise.resolve(null))
}));

vi.mock("../../../services/api/stockTransactionService", () => ({
  saveStockDayPostgres: vi.fn(() => Promise.resolve()),
  loadStockDayPostgres: vi.fn(() => Promise.resolve(null)),
  loadStockMonthPostgres: vi.fn(() => Promise.resolve(null)),
  deleteStockInPostgres: vi.fn(() => Promise.resolve())
}));

vi.mock("../../../lib/auditLogService", () => ({
  subscribeAuditLogs: vi.fn(() => vi.fn())
}));

describe("StockLedgerModule Redesign", () => {
  const mockUser: LedgerUser = {
    uid: "test-user-1",
    email: "owner@franchise.local",
    displayName: "Test Owner"
  };

  const defaultProps = {
    user: mockUser,
    role: "owner" as const,
    monthId: "2026-01",
    syncState: "synced" as const,
    syncLabel: "Cloud Synced",
    onSnapshotMetadata: vi.fn(),
    onFirestoreError: vi.fn(),
    onQueueWrite: vi.fn(),
    onStatus: vi.fn(),
    ledgerReadModeConfig: defaultLedgerReadModeConfig
  };

  function renderModule(role: "owner" | "admin" | "viewer" = "owner") {
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
          <StockLedgerModule {...defaultProps} role={role} />
        </SidebarDayControlsProvider>
      </SelectedDateProvider>
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the 4 primary unified navigation tabs", () => {
    renderModule("owner");

    expect(screen.getByRole("button", { name: /Daily Stock Issuance/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Stock Lifting/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Reports & Summaries/i })).toBeDefined();
    expect(screen.getByRole("button", { name: /Products & Accounts/i })).toBeDefined();
  });

  it("renders the focused Day Context Bar in Daily Stock Issuance", () => {
    renderModule("owner");

    // Date context
    expect(screen.getByText(/January 1, 2026/i)).toBeDefined();
    // Status badge
    expect(screen.getByText(/^open$/i)).toBeDefined();
    // Lifecycle action Close Day and Refresh are universal in AppHeader top navbar, not in module sidebar
    expect(screen.queryByRole("button", { name: /Close Day/i })).toBeNull();
    // Transfer balance buttons
    expect(screen.getByTestId("btn-transfer-balance")).toBeDefined();
    expect(screen.getByTestId("btn-transfer-history")).toBeDefined();
  });

  it("renders Save Now & Verify action in daily view", async () => {
    renderModule("owner");

    expect(await screen.findByRole("button", { name: /Save Now & Verify/i })).toBeDefined();
  });

  it("switches to Reports & Summaries and renders Executive KPIs and Stock Backup Export actions", async () => {
    renderModule("owner");

    const reportsTab = screen.getByRole("button", { name: /Reports & Summaries/i });
    fireEvent.click(reportsTab);

    // KPI Metric Cards in Reports
    expect(screen.getAllByText(/Stock Amount/i)[0]).toBeDefined();
    expect(screen.getAllByText(/Payment Received/i)[0]).toBeDefined();
    expect(screen.getAllByText(/Due Balance/i)[0]).toBeDefined();
    expect(screen.getAllByText(/Quantity/i)[0]).toBeDefined();

    // Export and Backup actions
    expect(screen.getByRole("button", { name: /Export Stock Excel/i })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /Print/i })[0]).toBeDefined();
    expect(screen.getByRole("button", { name: /Stock JSON Backup/i })).toBeDefined();
  });

  it("switches to Stock Lifting tab cleanly", () => {
    renderModule("owner");

    const stockInTab = screen.getByRole("button", { name: /Stock Lifting/i });
    fireEvent.click(stockInTab);

    expect(screen.getByText(/Stock Received from Jazz Company/i)).toBeDefined();
  });

  it("restricts Products & Accounts tab for viewer role", () => {
    renderModule("viewer");

    const settingsTab = screen.getByRole("button", { name: /Products & Accounts/i });
    expect(settingsTab.hasAttribute("disabled")).toBe(true);
  });

  it("renders unified Distribution Officers & Accounts Directory and Stock Products Catalog for owner role", () => {
    renderModule("owner");

    const settingsTab = screen.getByRole("button", { name: /Products & Accounts/i });
    expect(settingsTab.hasAttribute("disabled")).toBe(false);
    fireEvent.click(settingsTab);

    // Verify Distribution Officers & Accounts Directory
    expect(screen.getByText(/Distribution Officers & Accounts Directory/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Sync with Master DO Directory/i })).toBeDefined();
    expect(screen.getByPlaceholderText(/e\.g\. Naveed Bangla/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Add Account/i })).toBeDefined();

    // Verify Stock Products Catalog
    expect(screen.getByText(/Stock Products Catalog/i)).toBeDefined();
    expect(screen.getByPlaceholderText(/e\.g\. Prepaid SIM/i)).toBeDefined();
    expect(screen.getByRole("button", { name: /Add Product/i })).toBeDefined();
  });
});
