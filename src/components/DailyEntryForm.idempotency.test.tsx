// @vitest-environment jsdom
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { DailyEntryForm } from "./DailyEntryForm";
import type { DailyLedgerInput, CatalogItem } from "../types/ledger";

const testCategory: CatalogItem = {
  id: "cat-uuid-general",
  name: "General",
  active: true,
  sortOrder: 1
};

describe("DailyEntryForm Idempotency & Rapid-Click Protection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. Synchronous rapid double-click on 'Save Now & Verify' initiates exactly ONE in-flight onSave invocation", async () => {
    let finishSave: (() => void) | undefined;
    const onSave = vi.fn(() => new Promise<void>((resolve) => {
      finishSave = resolve;
    }));

    render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[testCategory]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{
          dayNo: 1,
          expenses: [{ id: "exp-1", name: "Tea", description: "", amount: 100 }],
          commissions: [],
          credits: [],
          ownerBalances: []
        }}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const saveBtn = screen.getByRole("button", { name: "Save Now & Verify" });

    // Fire two click events synchronously in the exact same event tick
    fireEvent.click(saveBtn);
    fireEvent.click(saveBtn);

    // Synchronous guard must have blocked the second invocation immediately
    expect(onSave).toHaveBeenCalledTimes(1);

    // Resolve the first save
    await act(async () => {
      finishSave?.();
    });

    expect(await screen.findByText("Save Confirmed")).toBeTruthy();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("2. Adding an expense attaches a stable idempotencyKey to the draft payload", async () => {
    let capturedPayload: DailyLedgerInput | undefined;
    const onSave = vi.fn(async (payload: DailyLedgerInput) => {
      capturedPayload = payload;
    });

    render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[testCategory]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{ dayNo: 1, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const expensePanel = screen.getByRole("heading", { name: "Expense" }).closest("section")!;
    await userEvent.type(within(expensePanel).getByLabelText("Name"), "Morning Coffee");
    await userEvent.type(within(expensePanel).getByLabelText("Amount"), "250");
    await userEvent.click(within(expensePanel).getByRole("button", { name: "Add Entry" }));

    // Click Save Now & Verify
    await userEvent.click(screen.getByRole("button", { name: "Save Now & Verify" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(capturedPayload).toBeDefined();
    expect(capturedPayload!.expenses).toHaveLength(1);

    const savedExpense = capturedPayload!.expenses[0];
    expect(savedExpense.name).toBe("Morning Coffee");
    expect(savedExpense.amount).toBe(250);
    expect(savedExpense.idempotencyKey).toBeDefined();
    expect(typeof savedExpense.idempotencyKey).toBe("string");
    expect(savedExpense.idempotencyKey!.length).toBeGreaterThan(0);
  });

  it("3. Adding two distinct expenses generates two distinct idempotency keys", async () => {
    let capturedPayload: DailyLedgerInput | undefined;
    const onSave = vi.fn(async (payload: DailyLedgerInput) => {
      capturedPayload = payload;
    });

    render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[testCategory]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{ dayNo: 1, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const expensePanel = screen.getByRole("heading", { name: "Expense" }).closest("section")!;

    // Entry 1
    await userEvent.type(within(expensePanel).getByLabelText("Name"), "Tea 1");
    await userEvent.type(within(expensePanel).getByLabelText("Amount"), "100");
    await userEvent.click(within(expensePanel).getByRole("button", { name: "Add Entry" }));

    // Entry 2
    await userEvent.type(within(expensePanel).getByLabelText("Name"), "Tea 2");
    await userEvent.type(within(expensePanel).getByLabelText("Amount"), "150");
    await userEvent.click(within(expensePanel).getByRole("button", { name: "Add Entry" }));

    // Save
    await userEvent.click(screen.getByRole("button", { name: "Save Now & Verify" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(capturedPayload!.expenses).toHaveLength(2);

    const [item1, item2] = capturedPayload!.expenses;
    expect(item1.idempotencyKey).toBeDefined();
    expect(item2.idempotencyKey).toBeDefined();
    expect(item1.idempotencyKey).not.toBe(item2.idempotencyKey);
  });

  it("4. Failed save preserves drafts and allows deliberate retry with identical idempotency keys", async () => {
    const payloads: DailyLedgerInput[] = [];
    let shouldFail = true;

    const onSave = vi.fn(async (payload: DailyLedgerInput) => {
      payloads.push(payload);
      if (shouldFail) {
        throw new Error("Network timeout contacting PostgreSQL API");
      }
    });

    render(
      <DailyEntryForm
        dayNo={1}
        entryYear={2026}
        entryMonth={8}
        entryDay={1}
        openingBalance={1000}
        ownerOpeningBalance={500}
        previousOwnerClosingBalance={500}
        dateLabel="2026-08-01"
        expenseCategories={[testCategory]}
        commissionCategories={[]}
        creditParties={[]}
        initial={{ dayNo: 1, expenses: [], commissions: [], credits: [], ownerBalances: [] }}
        onSave={onSave}
        onCloseDay={vi.fn().mockResolvedValue(undefined)}
      />
    );

    const expensePanel = screen.getByRole("heading", { name: "Expense" }).closest("section")!;

    // Add entry
    await userEvent.type(within(expensePanel).getByLabelText("Name"), "Delivery Van Fuel");
    await userEvent.type(within(expensePanel).getByLabelText("Amount"), "5000");
    await userEvent.click(within(expensePanel).getByRole("button", { name: "Add Entry" }));

    // Attempt 1: Fails
    const saveBtn = screen.getByRole("button", { name: "Save Now & Verify" });
    await userEvent.click(saveBtn);

    expect(await screen.findByText("Save Failed")).toBeTruthy();
    expect(screen.getByText("Network timeout contacting PostgreSQL API")).toBeTruthy();
    expect(payloads).toHaveLength(1);

    const initialKey = payloads[0].expenses[0].idempotencyKey;
    expect(initialKey).toBeDefined();

    // Draft is preserved in UI
    expect(screen.getAllByText("Delivery Van Fuel").length).toBeGreaterThan(0);
    expect(screen.getAllByText("5,000").length).toBeGreaterThan(0);

    // Attempt 2: Deliberate retry succeeds
    shouldFail = false;
    await userEvent.click(saveBtn);

    expect(await screen.findByText("Save Confirmed")).toBeTruthy();
    expect(payloads).toHaveLength(2);

    const retryKey = payloads[1].expenses[0].idempotencyKey;
    expect(retryKey).toBe(initialKey);
  });
});
