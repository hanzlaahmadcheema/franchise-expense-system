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
    expect(screen.getByText("Day closed")).toBeTruthy();
    expect(screen.getAllByText("Autosave off").length).toBeGreaterThan(0);
  });

  it("shows progress until a verified Firestore save completes", async () => {
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
    expect(screen.getByText(/Firestore confirmed the write/)).toBeTruthy();
  });

  it("includes credit party descriptions in the saved day payload", async () => {
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

    await userEvent.type(screen.getByPlaceholderText("Reason, detail, reference"), "Advance for shop work");
    await userEvent.type(screen.getByLabelText("Loan"), "500");
    await userEvent.type(screen.getByLabelText("Receive"), "100");
    const enabledAddEntry = screen.getAllByRole("button", { name: "Add Entry" }).find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabledAddEntry).toBeTruthy();
    await userEvent.click(enabledAddEntry as HTMLButtonElement);
    expect(screen.getAllByText("Advance for shop work").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "Save Now & Verify" }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        credits: [
          expect.objectContaining({
            partyId: "party-a",
            partyName: "Party A",
            description: "Advance for shop work",
            loan: 500,
            receive: 100
          })
        ]
      }),
      { awaitRemote: true }
    );
  });
});
