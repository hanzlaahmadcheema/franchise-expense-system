// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ReverseTransferModal } from "./ReverseTransferModal";
import { ledgerApiClient, type StockBalanceTransferRecord } from "../../../services/api/ledgerApiClient";
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

describe("ReverseTransferModal Component", () => {
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
    }
  ];

  const mockTransfer: StockBalanceTransferRecord = {
    id: "trans-abc-123",
    franchise_id: "f1",
    day_id: "day-1",
    source_account_id: "acct-a",
    destination_account_id: "acct-b",
    amount: 20000,
    transfer_type: "credit",
    reason: "Staff handover settlement",
    status: "completed",
    created_at: "2026-09-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z"
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. does not render when isOpen is false or transfer is null", () => {
    const { container: c1 } = render(
      <ReverseTransferModal
        isOpen={false}
        onClose={vi.fn()}
        transfer={mockTransfer}
        accounts={mockAccounts}
        onSuccess={vi.fn()}
      />
    );
    expect(c1.firstChild).toBeNull();

    const { container: c2 } = render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={null}
        accounts={mockAccounts}
        onSuccess={vi.fn()}
      />
    );
    expect(c2.firstChild).toBeNull();
  });

  it("2. displays original transfer details accurately", () => {
    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={mockTransfer}
        accounts={mockAccounts}
        currentDayId="day-1"
        onSuccess={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByText("Reverse Balance Transfer")).toBeDefined();
    // Source & Destination
    expect(screen.getByText("Person A")).toBeDefined();
    expect(screen.getAllByText("Person B").length).toBeGreaterThanOrEqual(1);
    // Amount
    expect(screen.getByText("Rs. 20,000")).toBeDefined();
    // Reason
    expect(screen.getByText("Staff handover settlement")).toBeDefined();
    // Status
    expect(screen.getByText("Completed")).toBeDefined();
  });

  it("3. displays accounting notices for compensating operation and debt risk", () => {
    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={mockTransfer}
        accounts={mockAccounts}
        onSuccess={vi.fn()}
      />
    );

    // Requirement 3: Compensating operation explanation
    expect(screen.getByText("Compensating Accounting Operation")).toBeDefined();
    expect(screen.getByText(/creates an explicit compensating accounting record/i)).toBeDefined();
    expect(screen.getByText(/accounting history is never altered or deleted/i)).toBeDefined();

    // Requirement 4: Debt risk on destination account
    expect(screen.getByText("Outstanding Debt Risk")).toBeDefined();
    expect(screen.getByText(/may legitimately leave their account with an outstanding debt/i)).toBeDefined();
  });

  it("4. handles cancellation without calling reversal API", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={onClose}
        transfer={mockTransfer}
        accounts={mockAccounts}
        onSuccess={vi.fn()}
      />
    );

    const cancelBtn = screen.getByRole("button", { name: /Cancel/i });
    await user.click(cancelBtn);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(ledgerApiClient.stockTransfers.reverse).not.toHaveBeenCalled();
  });

  it("5. validates form requirements and disables submit until validated", async () => {
    const user = userEvent.setup();

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={mockTransfer}
        accounts={mockAccounts}
        onSuccess={vi.fn()}
      />
    );

    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);

    // Enter short reason (< 3 chars)
    const reasonInput = screen.getByLabelText(/Reversal Reason/i);
    await user.type(reasonInput, "no");
    expect(submitBtn.disabled).toBe(true);

    // Enter valid reason
    await user.clear(reasonInput);
    await user.type(reasonInput, "Handover cancelled by franchise owner");
    expect(submitBtn.disabled).toBe(true); // Still waiting for confirmation checkbox

    // Check confirmation checkbox
    const confirmCheckbox = screen.getByRole("checkbox");
    await user.click(confirmCheckbox);

    // Now submit should be enabled
    expect(submitBtn.disabled).toBe(false);
  });

  it("6. executes successful reversal API call and triggers onSuccess and onClose", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const mockReversalResponse = {
      data: {
        original: { ...mockTransfer, status: "reversed" as const },
        reversal: {
          id: "trans-rev-999",
          franchise_id: "f1",
          day_id: "day-1",
          source_account_id: "acct-b",
          destination_account_id: "acct-a",
          amount: 20000,
          transfer_type: "credit",
          reason: "Reversal: Handover cancelled",
          status: "completed",
          reversal_of_id: mockTransfer.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }
      }
    };

    (ledgerApiClient.stockTransfers.reverse as any).mockResolvedValueOnce(mockReversalResponse);

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={onClose}
        transfer={mockTransfer}
        accounts={mockAccounts}
        currentDayId="day-1"
        onSuccess={onSuccess}
      />
    );

    await user.type(screen.getByLabelText(/Reversal Reason/i), "Handover cancelled");
    await user.click(screen.getByRole("checkbox"));

    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(ledgerApiClient.stockTransfers.reverse).toHaveBeenCalledWith(
        mockTransfer.id,
        {
          reason: "Handover cancelled",
          day_id: "day-1"
        }
      );
    });

    expect(onSuccess).toHaveBeenCalledWith(mockReversalResponse.data);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("7. enforces unauthorized access restrictions (canReverse = false)", () => {
    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={mockTransfer}
        accounts={mockAccounts}
        canReverse={false}
        onSuccess={vi.fn()}
      />
    );

    expect(screen.getByText(/Unauthorized: Only administrators and franchise owners can reverse balance transfers/i)).toBeDefined();
    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it("8. prevents duplicate submission while request is in-flight", async () => {
    const user = userEvent.setup();
    let resolvePromise: (val: any) => void;
    const pendingPromise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    (ledgerApiClient.stockTransfers.reverse as any).mockReturnValueOnce(pendingPromise);

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={mockTransfer}
        accounts={mockAccounts}
        currentDayId="day-1"
        onSuccess={vi.fn()}
      />
    );

    await user.type(screen.getByLabelText(/Reversal Reason/i), "Handover cancelled");
    await user.click(screen.getByRole("checkbox"));

    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i });
    await user.click(submitBtn);

    // Verify button shows loading and is disabled
    expect(screen.getByText(/Reversing Transfer…/i)).toBeDefined();
    expect((screen.getByRole("button", { name: /Reversing Transfer…/i }) as HTMLButtonElement).disabled).toBe(true);

    // Resolve the promise
    resolvePromise!({
      data: {
        original: { ...mockTransfer, status: "reversed" },
        reversal: { id: "rev-1" }
      }
    });

    await waitFor(() => {
      expect(ledgerApiClient.stockTransfers.reverse).toHaveBeenCalledTimes(1);
    });
  });

  it("9. handles HTTP 409 Conflict (already reversed) gracefully", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    const conflictError: any = new Error("Stock balance transfer is already reversed.");
    conflictError.status = 409;
    conflictError.code = "CONFLICT";

    (ledgerApiClient.stockTransfers.reverse as any).mockRejectedValueOnce(conflictError);

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={onClose}
        transfer={mockTransfer}
        accounts={mockAccounts}
        onSuccess={onSuccess}
      />
    );

    await user.type(screen.getByLabelText(/Reversal Reason/i), "Handover cancelled");
    await user.click(screen.getByRole("checkbox"));

    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Conflict \(HTTP 409\): This transfer has already been reversed/i)).toBeDefined();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("10. prevents reversing an already-reversed transfer record on mount", () => {
    const alreadyReversedTransfer: StockBalanceTransferRecord = {
      ...mockTransfer,
      status: "reversed"
    };

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={vi.fn()}
        transfer={alreadyReversedTransfer}
        accounts={mockAccounts}
        onSuccess={vi.fn()}
      />
    );

    expect(screen.getByText(/This transfer has already been reversed. No further reversal operations can be performed/i)).toBeDefined();
    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i }) as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  it("11. handles generic API failure with clear error message", async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    const onClose = vi.fn();

    (ledgerApiClient.stockTransfers.reverse as any).mockRejectedValueOnce(
      new Error("Database connection lost. Please retry.")
    );

    render(
      <ReverseTransferModal
        isOpen={true}
        onClose={onClose}
        transfer={mockTransfer}
        accounts={mockAccounts}
        onSuccess={onSuccess}
      />
    );

    await user.type(screen.getByLabelText(/Reversal Reason/i), "Handover cancelled");
    await user.click(screen.getByRole("checkbox"));

    const submitBtn = screen.getByRole("button", { name: /Confirm & Reverse Transfer/i });
    await user.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("Database connection lost. Please retry.")).toBeDefined();
    });

    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
