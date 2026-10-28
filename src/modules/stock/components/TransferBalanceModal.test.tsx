// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { TransferBalanceModal, formatAccountBalance } from "./TransferBalanceModal";
import { ledgerApiClient } from "../../../services/api/ledgerApiClient";
import type { StockAccountProfile } from "../types/stock.types";

vi.mock("../../../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    stockTransfers: {
      create: vi.fn(),
      list: vi.fn(),
      reverse: vi.fn()
    }
  }
}));

describe("TransferBalanceModal Component", () => {
  const mockAccounts: StockAccountProfile[] = [
    {
      id: "acct-a",
      name: "Person A",
      type: "DO",
      displayOrder: 1,
      openingBalance: 0,
      active: true,
      createdBy: "test-user",
      createdAt: 1725148800000,
      updatedAt: 1725148800000
    },
    {
      id: "acct-b",
      name: "Person B",
      type: "DO",
      displayOrder: 2,
      openingBalance: 0,
      active: true,
      createdBy: "test-user",
      createdAt: 1725148800000,
      updatedAt: 1725148800000
    },
    {
      id: "acct-c",
      name: "Person C",
      type: "CCR",
      displayOrder: 3,
      openingBalance: 0,
      active: true,
      createdBy: "test-user",
      createdAt: 1725148800000,
      updatedAt: 1725148800000
    }
  ];

  // Balances:
  // Person A has -20,000 due (Credit of 20,000)
  // Person B has 0 due (Nil)
  // Person C has +12,000 due (Debt of 12,000)
  const mockBalances: Record<string, number> = {
    "acct-a": -20000,
    "acct-b": 0,
    "acct-c": 12000
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. formatAccountBalance correctly formats credit, debt, and zero balances", () => {
    const cred = formatAccountBalance(-20000);
    expect(cred.isCredit).toBe(true);
    expect(cred.isDebt).toBe(false);
    expect(cred.amountStr).toContain("20,000 Credit");

    const debt = formatAccountBalance(12000);
    expect(debt.isDebt).toBe(true);
    expect(debt.isCredit).toBe(false);
    expect(debt.amountStr).toContain("12,000 Due");

    const zero = formatAccountBalance(0);
    expect(zero.isZero).toBe(true);
    expect(zero.amountStr).toContain("Rs. 0 (Nil)");
  });

  it("2. does not render when isOpen is false", () => {
    const { container } = render(
      <TransferBalanceModal
        isOpen={false}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("3. renders dialog with correct title, select elements, and invariant notice", () => {
    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Transfer Balance Between People")).toBeDefined();
    expect(screen.getByText("Strict Accounting Invariants Enforced")).toBeDefined();
    expect(screen.getByText("Zero change to physical stock quantities")).toBeDefined();
    expect(screen.getByText("Zero change to Jazz HQ company payable")).toBeDefined();
    expect(screen.getByText("Zero cash movement (no payment / receipt)")).toBeDefined();
  });

  it("4. Max button populates full transferable credit and updates preview", async () => {
    const user = userEvent.setup();

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
      />
    );

    // Select Person A as source
    const sourceSelect = screen.getByLabelText(/Source Person/i);
    await user.selectOptions(sourceSelect, "acct-a");

    // Expect Person A balance shown: Rs. 20,000 Credit
    expect(screen.getByText(/20,000 Credit/i)).toBeDefined();

    // Select Person B as destination
    const destSelect = screen.getByLabelText(/Destination Person/i);
    await user.selectOptions(destSelect, "acct-b");

    // Click Max button
    const maxBtn = screen.getByRole("button", { name: /Max/i });
    await user.click(maxBtn);

    const amountInput = screen.getByLabelText(/Transfer Amount/i) as HTMLInputElement;
    expect(amountInput.value).toBe("20000");

    // Real-time preview check
    expect(screen.getByText("Resulting Balances Preview")).toBeDefined();
    expect(screen.getByText(/Invariant preserved/i)).toBeDefined();
  });

  it("5. validates transfer to an indebted person (Person C with 12,000 debt)", async () => {
    const user = userEvent.setup();

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
      />
    );

    // Select Person A as source
    await user.selectOptions(screen.getByLabelText(/Source Person/i), "acct-a");
    // Select Person C as destination
    await user.selectOptions(screen.getByLabelText(/Destination Person/i), "acct-c");

    // Enter transfer of 20,000 credit
    const amountInput = screen.getByLabelText(/Transfer Amount/i);
    await user.type(amountInput, "20000");

    // Person C should receive 20,000 credit against 12,000 debt -> resulting in 8,000 credit (-8,000 due)
    // Verify preview exists
    expect(screen.getByText("Resulting Balances Preview")).toBeDefined();
    expect(screen.getByText(/8,000 Credit/i)).toBeDefined();
  });

  it("6. validates form requirements and prevents invalid submissions", async () => {
    const user = userEvent.setup();

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
      />
    );

    const submitBtn = screen.getByRole("button", { name: /Confirm & Transfer Balance/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Select source & dest
    await user.selectOptions(screen.getByLabelText(/Source Person/i), "acct-a");
    await user.selectOptions(screen.getByLabelText(/Destination Person/i), "acct-b");

    // Enter excessive amount (25,000 > 20,000 credit)
    const amountInput = screen.getByLabelText(/Transfer Amount/i);
    await user.type(amountInput, "25000");

    // Add reason and check confirm
    await user.type(screen.getByLabelText(/Reason/i), "Settlement of personal balance");
    await user.click(screen.getByLabelText(/I explicitly confirm/i));

    // Still disabled because 25,000 exceeds available 20,000
    expect(submitBtn.disabled).toBe(true);

    // Fix amount to 20,000
    await user.clear(amountInput);
    await user.type(amountInput, "20000");

    // Now submit should be enabled
    expect(submitBtn.disabled).toBe(false);
  });

  it("7. executes transfer API call and invokes onSuccess and onClose", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const mockResponse = {
      data: {
        transfer: {
          id: "trans-123",
          franchise_id: "f1",
          day_id: "day-1",
          source_account_id: "acct-a",
          destination_account_id: "acct-b",
          amount: 20000,
          transfer_type: "credit",
          reason: "Staff handover settlement",
          status: "completed",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        sourceAccountProjection: { closing_due: 0 },
        destinationAccountProjection: { closing_due: -20000 }
      }
    };

    (ledgerApiClient.stockTransfers.create as any).mockResolvedValueOnce(mockResponse);

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={onClose}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={onSuccess}
      />
    );

    await user.selectOptions(screen.getByLabelText(/Source Person/i), "acct-a");
    await user.selectOptions(screen.getByLabelText(/Destination Person/i), "acct-b");
    await user.type(screen.getByLabelText(/Transfer Amount/i), "20000");
    await user.type(screen.getByLabelText(/Reason/i), "Staff handover settlement");
    await user.click(screen.getByLabelText(/I explicitly confirm/i));

    const submitBtn = screen.getByRole("button", { name: /Confirm & Transfer Balance/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(ledgerApiClient.stockTransfers.create).toHaveBeenCalledWith(
        expect.objectContaining({
          day_id: "day-1",
          source_account_id: "acct-a",
          destination_account_id: "acct-b",
          amount: 20000,
          transfer_type: "credit",
          reason: "Staff handover settlement"
        })
      );
    });

    expect(onSuccess).toHaveBeenCalledWith(mockResponse.data);
    expect(onClose).toHaveBeenCalled();
  });

  it("8. handles API failure and displays error message clearly", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    (ledgerApiClient.stockTransfers.create as any).mockRejectedValueOnce(
      new Error("Transfer amount exceeds source available credit balance.")
    );

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={onClose}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={onSuccess}
      />
    );

    await user.selectOptions(screen.getByLabelText(/Source Person/i), "acct-a");
    await user.selectOptions(screen.getByLabelText(/Destination Person/i), "acct-b");
    await user.type(screen.getByLabelText(/Transfer Amount/i), "10000");
    await user.type(screen.getByLabelText(/Reason/i), "Handover note");
    await user.click(screen.getByLabelText(/I explicitly confirm/i));

    const submitBtn = screen.getByRole("button", { name: /Confirm & Transfer Balance/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("Transfer Rejected")).toBeDefined();
      expect(screen.getByText(/Transfer amount exceeds source available credit balance/i)).toBeDefined();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("9. tab navigation: switches between New Transfer and Transfer History & Reversals", async () => {
    const user = userEvent.setup();
    (ledgerApiClient.stockTransfers.list as any).mockResolvedValueOnce({
      data: []
    });

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
      />
    );

    // Initial tab is New Transfer
    expect(screen.getByText("Confirm & Transfer Balance")).toBeDefined();

    // Click on Transfer History & Reversals tab
    const historyTabBtn = screen.getByRole("button", { name: /Transfer History & Reversals/i });
    await user.click(historyTabBtn);

    // Should switch view and load transfers
    await waitFor(() => {
      expect(ledgerApiClient.stockTransfers.list).toHaveBeenCalledWith({ day_id: "day-1" });
    });
  });

  it("10. history tab: displays transfers and allows opening the reversal dialog", async () => {
    const user = userEvent.setup();
    const mockTransfers = [
      {
        id: "transfer-test-1",
        franchise_id: "f1",
        day_id: "day-1",
        source_account_id: "acct-a",
        destination_account_id: "acct-b",
        amount: 8000,
        transfer_type: "credit",
        reason: "Handover payment",
        status: "completed",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }
    ];

    (ledgerApiClient.stockTransfers.list as any).mockResolvedValue({
      data: mockTransfers
    });

    render(
      <TransferBalanceModal
        isOpen={true}
        onClose={vi.fn()}
        dayId="day-1"
        accounts={mockAccounts}
        accountBalances={mockBalances}
        onSuccess={vi.fn()}
        initialTab="history"
      />
    );

    // Directly in history view
    await waitFor(() => {
      expect(screen.getByText("Rs. 8,000")).toBeDefined();
      expect(screen.getByText("Handover payment")).toBeDefined();
    });

    // Find and click the Reverse button
    const reverseBtn = screen.getByRole("button", { name: /Reverse/i });
    await user.click(reverseBtn);

    // Reversal confirmation dialog should open
    await waitFor(() => {
      expect(screen.getByText("Reverse Balance Transfer")).toBeDefined();
      expect(screen.getByText("Outstanding Debt Risk")).toBeDefined();
    });
  });
});
