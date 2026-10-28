import { describe, expect, it, vi, beforeEach } from "vitest";
import { saveExpenseDayPostgres } from "./expenseTransactionService";
import { ledgerApiClient } from "./ledgerApiClient";
import * as periodDayService from "./periodDayService";

// Mock ledgerApiClient
vi.mock("./ledgerApiClient", () => {
  return {
    ledgerApiClient: {
      expenses: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      },
      commissions: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: {} }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        delete: vi.fn().mockResolvedValue({ data: {} })
      },
      credits: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: {} }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        delete: vi.fn().mockResolvedValue({ data: {} })
      },
      owner: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ data: {} }),
        update: vi.fn().mockResolvedValue({ data: {} }),
        delete: vi.fn().mockResolvedValue({ data: {} })
      },
      calculations: {
        getDayProjections: vi.fn().mockResolvedValue({ projections: null })
      },
      catalogs: {
        getCreditParties: vi.fn().mockResolvedValue({ data: [] })
      }
    }
  };
});

describe("Expense Entry Persistence Behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(periodDayService, "resolveAccountingDayId").mockResolvedValue("day-uuid-1");
    vi.spyOn(periodDayService, "getAccountingPeriodWithDays").mockResolvedValue({
      period: { id: "period-uuid-1", period_key: "2026-08", status: "open" } as any,
      days: new Map([[1, { id: "day-uuid-1", day_no: 1, status: "open" } as any]]),
      fetchedAt: Date.now()
    });
  });

  it("1. Two expenses with identical names are both saved as separate transactions and remain intact", async () => {
    // Initial state: no expenses in DB yet
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });
    vi.mocked(ledgerApiClient.expenses.create).mockImplementation(async (payload: any) => ({
      data: { id: `created-${Math.random()}`, ...payload, revision: 1 }
    }));

    const input = {
      dayNo: 1,
      expenses: [
        { id: "client-1", category: "Refreshment", name: "Tea", description: "Morning tea", amount: 120 },
        { id: "client-2", category: "Refreshment", name: "Tea", description: "Evening tea", amount: 150 }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", input);

    expect(res.success).toBe(true);
    // Both entries must trigger expenses.create independently
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(2);
    expect(ledgerApiClient.expenses.update).not.toHaveBeenCalled();
    expect(ledgerApiClient.expenses.delete).not.toHaveBeenCalled();

    const call1 = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0][0];
    const call2 = vi.mocked(ledgerApiClient.expenses.create).mock.calls[1][0];

    expect(call1.item_name).toBe("Tea");
    expect(call1.amount).toBe(120);
    expect(call1.description).toBe("Morning tea");

    expect(call2.item_name).toBe("Tea");
    expect(call2.amount).toBe(150);
    expect(call2.description).toBe("Evening tea");
  });

  it("2. Blank name with valid description creates a transaction", async () => {
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValue({
      data: { id: "db-exp-desc-only", revision: 1 }
    });

    const input = {
      dayNo: 1,
      expenses: [
        { id: "client-desc-only", category: "Utilities", name: "", description: "Office electricity bill", amount: 4500 }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", input);

    expect(res.success).toBe(true);
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(1);

    const createPayload = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0][0];
    expect(createPayload.item_name).toBe("");
    expect(createPayload.description).toBe("Office electricity bill");
    expect(createPayload.amount).toBe(4500);
  });

  it("3. Blank name with valid amount creates a transaction", async () => {
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValue({
      data: { id: "db-exp-amount-only", revision: 1 }
    });

    const input = {
      dayNo: 1,
      expenses: [
        { id: "client-amount-only", category: "General", name: "   ", description: "", amount: 800 }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", input);

    expect(res.success).toBe(true);
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(1);

    const createPayload = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0][0];
    expect(createPayload.item_name).toBe("");
    expect(createPayload.description).toBeNull();
    expect(createPayload.amount).toBe(800);
  });

  it("4. Existing expense is untouched when another expense with identical name is created", async () => {
    const existingRow = {
      id: "db-exp-1",
      revision: 1,
      day_id: "day-uuid-1",
      category_id: null,
      category_name_snapshot: "Refreshment",
      item_name: "Tea",
      description: "Original tea",
      amount: "100.00"
    };

    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [existingRow] });
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValue({
      data: { id: "db-exp-2", revision: 1 }
    });

    const input = {
      dayNo: 1,
      expenses: [
        // Existing expense with matched DB id
        { id: "db-exp-1", category: "Refreshment", name: "Tea", description: "Original tea", amount: 100 },
        // Newly added expense with same name
        { id: "client-temp-new", category: "Refreshment", name: "Tea", description: "New tea", amount: 200 }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", input);

    expect(res.success).toBe(true);
    // Existing must NOT be updated because nothing changed
    expect(ledgerApiClient.expenses.update).not.toHaveBeenCalled();
    // Existing must NOT be deleted
    expect(ledgerApiClient.expenses.delete).not.toHaveBeenCalled();
    // New expense must be created
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(1);

    const createPayload = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0][0];
    expect(createPayload.item_name).toBe("Tea");
    expect(createPayload.amount).toBe(200);
    expect(createPayload.description).toBe("New tea");
  });

  it("5. Updating an expense operates strictly by transaction ID", async () => {
    const existingRow1 = {
      id: "db-exp-1",
      revision: 2,
      day_id: "day-uuid-1",
      category_id: null,
      category_name_snapshot: "General",
      item_name: "Paper",
      description: null,
      amount: "50.00"
    };
    const existingRow2 = {
      id: "db-exp-2",
      revision: 1,
      day_id: "day-uuid-1",
      category_id: null,
      category_name_snapshot: "General",
      item_name: "Paper",
      description: null,
      amount: "70.00"
    };

    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [existingRow1, existingRow2] });

    const input = {
      dayNo: 1,
      expenses: [
        // Update second expense amount to 90
        { id: "db-exp-1", category: "General", name: "Paper", description: "", amount: 50 },
        { id: "db-exp-2", category: "General", name: "Paper", description: "", amount: 90 }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", input);

    expect(res.success).toBe(true);
    // Only db-exp-2 should be updated
    expect(ledgerApiClient.expenses.update).toHaveBeenCalledTimes(1);
    expect(ledgerApiClient.expenses.update).toHaveBeenCalledWith("db-exp-2", {
      baseRevision: 1,
      category_id: null,
      amount: 90,
      item_name: "Paper",
      description: null
    });
    expect(ledgerApiClient.expenses.create).not.toHaveBeenCalled();
    expect(ledgerApiClient.expenses.delete).not.toHaveBeenCalled();
  });

  it("6. Deleting one expense with duplicate name deletes only its ID and keeps the other", async () => {
    const existingRow1 = {
      id: "db-exp-1",
      revision: 1,
      day_id: "day-uuid-1",
      category_id: null,
      category_name_snapshot: "Refreshment",
      item_name: "Tea",
      description: null,
      amount: "100.00"
    };
    const existingRow2 = {
      id: "db-exp-2",
      revision: 1,
      day_id: "day-uuid-1",
      category_id: null,
      category_name_snapshot: "Refreshment",
      item_name: "Tea",
      description: null,
      amount: "150.00"
    };

    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [existingRow1, existingRow2] });

    // User removed db-exp-1 from UI, only db-exp-2 remains
    const input = {
      dayNo: 1,
      expenses: [
        { id: "db-exp-2", category: "Refreshment", name: "Tea", description: "", amount: 150 }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", input);

    expect(res.success).toBe(true);
    expect(ledgerApiClient.expenses.delete).toHaveBeenCalledTimes(1);
    expect(ledgerApiClient.expenses.delete).toHaveBeenCalledWith("db-exp-1");
    expect(ledgerApiClient.expenses.update).not.toHaveBeenCalled();
    expect(ledgerApiClient.expenses.create).not.toHaveBeenCalled();
  });
});
