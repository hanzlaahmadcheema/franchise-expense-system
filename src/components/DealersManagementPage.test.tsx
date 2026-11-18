// @vitest-environment jsdom
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React from "react";
import { DealersManagementPage } from "./DealersManagementPage";
import { ledgerApiClient } from "../services/api/ledgerApiClient";

vi.mock("../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    catalogs: {
      getJazzLoadDoProfiles: vi.fn(),
      getStockAccounts: vi.fn(),
      createJazzLoadDoProfile: vi.fn(),
      createStockAccount: vi.fn(),
      updateJazzLoadDoProfile: vi.fn(),
      updateStockAccount: vi.fn()
    }
  }
}));

describe("DealersManagementPage Component", () => {
  const mockJazzProfiles = [
    {
      id: "jazz-1",
      franchise_id: "7301",
      do_name: "DO Tariq",
      do_line: "03001234567",
      sort_order: 1,
      is_active: true
    },
    {
      id: "jazz-2",
      franchise_id: "7301",
      do_name: "DO Bilal",
      do_line: "03007654321",
      sort_order: 2,
      is_active: true
    }
  ];

  const mockStockAccounts = [
    {
      id: "stock-1",
      franchise_id: "7301",
      slug: "do-tariq",
      name: "DO Tariq",
      type: "DO",
      sort_order: 1,
      is_active: true,
      notes: "Line: 03001234567"
    },
    {
      id: "stock-2",
      franchise_id: "7301",
      slug: "do-bilal",
      name: "DO Bilal",
      type: "DO",
      sort_order: 2,
      is_active: true,
      notes: "Line: 03007654321"
    },
    {
      id: "stock-3",
      franchise_id: "7301",
      slug: "ccr-counter-1",
      name: "Store CCR 1",
      type: "CCR",
      sort_order: 3,
      is_active: true,
      notes: null
    }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ledgerApiClient.catalogs.getJazzLoadDoProfiles).mockResolvedValue({
      data: [...mockJazzProfiles]
    } as any);
    vi.mocked(ledgerApiClient.catalogs.getStockAccounts).mockResolvedValue({
      data: [...mockStockAccounts]
    } as any);
  });

  it("loads and displays unified directory with KPI statistics", async () => {
    render(<DealersManagementPage role="owner" />);

    expect(screen.getByText(/Central Dealers & DO Directory/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("Tariq")).toBeTruthy();
      expect(screen.getByText("Bilal")).toBeTruthy();
      expect(screen.getByText("Store CCR 1")).toBeTruthy();
    });

    // Check KPI cards
    expect(screen.getAllByText("3").length).toBeGreaterThan(0); // Total Accounts
    expect(screen.getByText("03001234567")).toBeTruthy();
    expect(screen.getByText("03007654321")).toBeTruthy();
  });

  it("filters dealers by text search", async () => {
    render(<DealersManagementPage role="owner" />);

    await waitFor(() => {
      expect(screen.getByText("Tariq")).toBeTruthy();
    });

    const searchInput = screen.getByPlaceholderText(/Search by dealer name or line/i);
    fireEvent.change(searchInput, { target: { value: "Bilal" } });

    expect(screen.queryByText("Tariq")).toBeNull();
    expect(screen.getByText("Bilal")).toBeTruthy();
  });

  it("registers a new dealer across both modules", async () => {
    vi.mocked(ledgerApiClient.catalogs.createJazzLoadDoProfile).mockResolvedValue({
      data: { id: "jazz-new" }
    } as any);
    vi.mocked(ledgerApiClient.catalogs.createStockAccount).mockResolvedValue({
      data: { id: "stock-new" }
    } as any);

    const onStatus = vi.fn();
    render(<DealersManagementPage role="owner" onStatusChange={onStatus} />);

    await waitFor(() => {
      expect(screen.getByText("Tariq")).toBeTruthy();
    });

    const nameInput = screen.getByPlaceholderText(/e\.g\. Naveed Bangla/i);
    const lineInput = screen.getByPlaceholderText(/e\.g\. 03001234567/i);
    const addBtn = screen.getByRole("button", { name: /Register Dealer/i });

    fireEvent.change(nameInput, { target: { value: "DO Usman" } });
    fireEvent.change(lineInput, { target: { value: "03009998877" } });
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(ledgerApiClient.catalogs.createJazzLoadDoProfile).toHaveBeenCalledWith(
        expect.objectContaining({
          do_name: "Usman",
          do_line: "03009998877"
        })
      );
      expect(ledgerApiClient.catalogs.createStockAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Usman",
          type: "DO",
          notes: "Line: 03009998877"
        })
      );
    });

    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("Usman"));
  });

  it("reconciles and cross-syncs missing profiles across modules", async () => {
    // Jazz has an extra DO not in stock
    vi.mocked(ledgerApiClient.catalogs.getJazzLoadDoProfiles).mockResolvedValue({
      data: [
        ...mockJazzProfiles,
        {
          id: "jazz-extra",
          franchise_id: "7301",
          do_name: "DO Extra",
          do_line: "03005554433",
          sort_order: 4,
          is_active: true
        }
      ]
    } as any);

    vi.mocked(ledgerApiClient.catalogs.createStockAccount).mockResolvedValue({
      data: { id: "stock-extra" }
    } as any);

    const onStatus = vi.fn();
    render(<DealersManagementPage role="owner" onStatusChange={onStatus} />);

    await waitFor(() => {
      expect(screen.getByText("Tariq")).toBeTruthy();
    });

    const reconcileBtn = screen.getByRole("button", { name: /Cross-Module Reconcile/i });
    fireEvent.click(reconcileBtn);

    await waitFor(() => {
      expect(ledgerApiClient.catalogs.createStockAccount).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Extra",
          type: "DO",
          notes: "Line: 03005554433"
        })
      );
    });

    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining("Reconciliation complete"));
  });

  it("deduplicates variations (Mubashir/Mubashar, Irfan Mirza/Mirza Irfan, Fix Line, Titus/Fakhar) and enforces canonical roles", async () => {
    vi.mocked(ledgerApiClient.catalogs.getJazzLoadDoProfiles).mockResolvedValue({
      data: [
        { id: "jazz-mubashir", do_name: "Mubashir", do_line: "03027100126", sort_order: 4, is_active: true },
        { id: "jazz-irfan-mirza", do_name: "Irfan Mirza", do_line: "03027103467", sort_order: 5, is_active: true },
        { id: "jazz-fix-line", do_name: "Fix Line", do_line: "03027107343", sort_order: 10, is_active: true },
        { id: "jazz-other", do_name: "Other", do_line: "03200926230", sort_order: 11, is_active: true },
        { id: "jazz-fakhar", do_name: "Fakhar", do_line: "03027108872", sort_order: 12, is_active: true },
        { id: "jazz-anni", do_name: "Any", do_line: "03087081311", sort_order: 13, is_active: true }
      ]
    } as any);

    vi.mocked(ledgerApiClient.catalogs.getStockAccounts).mockResolvedValue({
      data: [
        { id: "stock-mubashar", name: "DO MUBASHAR", type: "DO", sort_order: 4, is_active: true, notes: "Line: 03027100126" },
        { id: "stock-mirza-irfan", name: "Do Mirza irfan", type: "DO", sort_order: 5, is_active: true, notes: "Line: 03027103467" },
        { id: "stock-office-line", name: "Office Line", type: "OFFICE", sort_order: 10, is_active: true, notes: "Line: 03027107343" },
        { id: "stock-tetas", name: "Titus", type: "CCR", sort_order: 12, is_active: true, notes: "Line: 03027108872" },
        { id: "stock-anni", name: "ANNI CCR", type: "CCR", sort_order: 13, is_active: true, notes: "Line: 03087081311" },
        { id: "stock-waseem", name: "WASEEM GUJJAR", type: "DSO", sort_order: 15, is_active: true, notes: null },
        { id: "stock-free-sim", name: "FREE SIM CCR", type: "CCR", sort_order: 18, is_active: true, notes: null }
      ]
    } as any);

    render(<DealersManagementPage role="owner" />);

    await waitFor(() => {
      // Mubashir merged into 1 row
      expect(screen.getAllByText("Mubashir").length).toBe(1);
      // Irfan Mirza merged into 1 row
      expect(screen.getAllByText("Irfan Mirza").length).toBe(1);
      // Office Line 1
      expect(screen.getByText("Office Line 1")).toBeTruthy();
      // Office Line 2
      expect(screen.getByText("Office Line 2")).toBeTruthy();
      // Fakhar (Titus) as CCR
      expect(screen.getByText("Fakhar (Titus)")).toBeTruthy();
      // Anni as CCR
      expect(screen.getByText("Anni")).toBeTruthy();
      // Free SIM as STOCK
      expect(screen.getByText("Free SIM")).toBeTruthy();
      // Waseem Gujjar is discarded
      expect(screen.queryByText(/Waseem Gujjar/i)).toBeNull();
    });
  });
});
