// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DailyEntryForm } from "./DailyEntryForm";

describe("DailyEntryForm close-day locking", () => {
  it("makes editable inputs read-only immediately when the selected day closes", () => {
    render(
      <DailyEntryForm
        dayNo={7}
        entryYear={2026}
        entryMonth={6}
        entryDay={7}
        openingBalance={0}
        ownerOpeningBalance={0}
        previousOwnerClosingBalance={0}
        dateLabel="2026-06-07"
        expenseCategories={[]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{
          dayNo: 7,
          lockedAt: Date.now(),
          expenses: [],
          commissions: [],
          credits: [],
          ownerBalances: []
        }}
        disabled
        locked
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect((screen.getByLabelText("Notes") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getAllByText("Day closed").length).toBeGreaterThan(0);
  });

  it("shows progress until a verified save completes without mentioning Firestore", async () => {
    let confirmSave: (() => void) | undefined;
    const onSave = vi.fn(() => new Promise<void>((resolve) => {
      confirmSave = resolve;
    }));
    render(
      <DailyEntryForm
        dayNo={7}
        entryYear={2026}
        entryMonth={6}
        entryDay={7}
        openingBalance={0}
        ownerOpeningBalance={0}
        previousOwnerClosingBalance={0}
        dateLabel="2026-06-07"
        expenseCategories={[]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{ dayNo: 7, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await userEvent.click(screen.getByRole("button", { name: "Save Now & Verify" }));
    expect(screen.getByText("Saving Expense Day")).toBeTruthy();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ dayNo: 7 }), { awaitRemote: true });

    confirmSave?.();
    expect(await screen.findByText("Save Confirmed")).toBeTruthy();
    expect(screen.getByText(/Day 7 was saved successfully/)).toBeTruthy();
    expect(screen.queryByText(/Firestore confirmed the write/)).toBeNull();
  });

  it("includes separate credit party descriptions in the saved day payload", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <DailyEntryForm
        dayNo={7}
        entryYear={2026}
        entryMonth={6}
        entryDay={7}
        openingBalance={0}
        ownerOpeningBalance={0}
        previousOwnerClosingBalance={0}
        dateLabel="2026-06-07"
        expenseCategories={[]}
        commissionCategories={[]}
        creditParties={[{ id: "party-a", name: "Party A", active: true, sortOrder: 0 }]}
        initial={{ dayNo: 7, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await userEvent.type(screen.getByPlaceholderText("Loan reason or reference"), "Advance for shop work");
    await userEvent.type(screen.getByPlaceholderText("Receive reason or reference"), "Partial return");
    await userEvent.type(screen.getByLabelText("Loan"), "500");
    await userEvent.type(screen.getByLabelText("Receive"), "100");
    const enabledAddEntry = screen.getAllByRole("button", { name: "Add Entry" }).find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabledAddEntry).toBeTruthy();
    await userEvent.click(enabledAddEntry as HTMLButtonElement);
    expect(screen.getAllByDisplayValue("Advance for shop work").length).toBeGreaterThan(0);
    expect(screen.getAllByDisplayValue("Partial return").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Save Now & Verify" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        credits: [
          expect.objectContaining({
            partyId: "party-a",
            partyName: "Party A",
            loanDescription: "Advance for shop work",
            receiveDescription: "Partial return",
            loan: 500,
            receive: 100
          })
        ]
      }),
      { awaitRemote: true }
    );
  });

  it("does not report pending changes during passive seed/previousDay rehydration", () => {
    const onPendingStateChange = vi.fn();
    const { rerender } = render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={15000}
        ownerOpeningBalance={6500}
        previousOwnerClosingBalance={6500}
        dateLabel="2026-08-01"
        expenseCategories={[]}
        commissionCategories={[]}
        creditParties={[{ id: "p1", name: "Party 1", active: true, sortOrder: 1 }]}
        initial={{ dayNo: 1, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
        onPendingStateChange={onPendingStateChange}
      />
    );

    expect(onPendingStateChange).toHaveBeenLastCalledWith(false);

    rerender(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={15000}
        ownerOpeningBalance={6500}
        previousOwnerClosingBalance={6500}
        dateLabel="2026-08-01"
        expenseCategories={[]}
        commissionCategories={[]}
        creditParties={[{ id: "p1", name: "Party 1", active: true, sortOrder: 1 }]}
        previousDay={{
          dayNo: 0,
          date: "2026-07-31",
          expenses: [],
          commissions: [],
          credits: [
            { id: "c1", partyId: "p1", partyName: "Party 1", opening: 5000, loan: 0, receive: 0, balance: 5000 }
          ],
          ownerBalances: []
        } as any}
        initial={{ dayNo: 1, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
        onPendingStateChange={onPendingStateChange}
      />
    );

    expect(onPendingStateChange).toHaveBeenLastCalledWith(false);
    expect(onPendingStateChange).not.toHaveBeenCalledWith(true);
  });

  it("reports pending changes when user modifies an input, and clears on unmount", async () => {
    const onPendingStateChange = vi.fn();
    const { unmount } = render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={15000}
        ownerOpeningBalance={6500}
        previousOwnerClosingBalance={6500}
        dateLabel="2026-08-01"
        expenseCategories={[]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{ dayNo: 1, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
        onPendingStateChange={onPendingStateChange}
      />
    );

    expect(onPendingStateChange).toHaveBeenLastCalledWith(false);

    await userEvent.type(screen.getByLabelText("Notes"), "Test daily note");
    expect(onPendingStateChange).toHaveBeenCalledWith(true);

    unmount();
    expect(onPendingStateChange).toHaveBeenLastCalledWith(false);
  });
});
