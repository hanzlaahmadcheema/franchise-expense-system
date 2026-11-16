import { describe, expect, it, vi, beforeEach } from "vitest";
import { saveExpenseDayPostgres } from "./expenseTransactionService";
import { ledgerApiClient } from "./ledgerApiClient";
import * as periodDayService from "./periodDayService";
import type { DailyLedgerInput } from "../../types/ledger";

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

describe("Online Expense Idempotency & Retry Guarantees", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(periodDayService, "resolveAccountingDayId").mockResolvedValue("day-uuid-1");
    vi.spyOn(periodDayService, "getAccountingPeriodWithDays").mockResolvedValue({
      period: { id: "period-uuid-1", period_key: "2026-08", status: "open" } as any,
      days: new Map([[1, { id: "day-uuid-1", day_no: 1, status: "open" } as any]]),
      fetchedAt: Date.now()
    });
  });

  it("1. Logical expense creation passes the draft idempotencyKey to expenses.create", async () => {
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValue({
      data: { id: "server-exp-uuid-1", revision: 1 }
    });

    const draftInput: DailyLedgerInput = {
      dayNo: 1,
      expenses: [
        {
          id: "draft-exp-1",
          idempotencyKey: "idem-key-stable-123",
          category: "Refreshment",
          name: "Tea",
          description: "Morning team tea",
          amount: 150
        }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", draftInput);

    expect(res.success).toBe(true);
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(1);

    const [payload, key] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0];
    expect(payload.item_name).toBe("Tea");
    expect(payload.amount).toBe(150);
    expect(key).toBe("idem-key-stable-123");
  });

  it("2. Retrying the same logical mutation after network timeout reuses the original idempotencyKey", async () => {
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });

    // First attempt fails with network timeout
    vi.mocked(ledgerApiClient.expenses.create).mockRejectedValueOnce(
      new Error("Network timeout: failed to fetch")
    );

    const draftInput: DailyLedgerInput = {
      dayNo: 1,
      expenses: [
        {
          id: "draft-exp-timeout",
          idempotencyKey: "idem-retry-stable-456",
          category: "Utilities",
          name: "Internet",
          description: "Monthly fiber line",
          amount: 3500
        }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    // First attempt throws
    await expect(saveExpenseDayPostgres("2026-08", draftInput)).rejects.toThrow("Network timeout: failed to fetch");

    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(1);
    const [, keyAttempt1] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0];
    expect(keyAttempt1).toBe("idem-retry-stable-456");

    // Second attempt (deliberate retry of the same draft) succeeds
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValueOnce({
      data: { id: "server-exp-uuid-2", revision: 1 }
    });

    const retryRes = await saveExpenseDayPostgres("2026-08", draftInput);

    expect(retryRes.success).toBe(true);
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(2);

    const [, keyAttempt2] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[1];
    expect(keyAttempt2).toBe("idem-retry-stable-456");
    expect(keyAttempt2).toBe(keyAttempt1);
  });

  it("3. Genuinely new expense creations receive different idempotency keys", async () => {
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });
    vi.mocked(ledgerApiClient.expenses.create).mockImplementation(async (payload: any, key?: string) => ({
      data: { id: `server-${key ?? "uuid"}`, revision: 1 }
    }));

    const draftInput: DailyLedgerInput = {
      dayNo: 1,
      expenses: [
        {
          id: "draft-exp-item-1",
          idempotencyKey: "key-item-alpha-111",
          category: "Refreshment",
          name: "Tea",
          description: "Morning tea",
          amount: 100
        },
        {
          id: "draft-exp-item-2",
          idempotencyKey: "key-item-beta-222",
          category: "Refreshment",
          name: "Tea",
          description: "Evening tea",
          amount: 100
        }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", draftInput);

    expect(res.success).toBe(true);
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledTimes(2);

    const [, key1] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0];
    const [, key2] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[1];

    expect(key1).toBe("key-item-alpha-111");
    expect(key2).toBe("key-item-beta-222");
    expect(key1).not.toBe(key2);
  });

  it("4. When an unassigned draft expense is saved, a stable idempotencyKey is assigned and reused on retry", async () => {
    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({ data: [] });
    vi.mocked(ledgerApiClient.expenses.create).mockRejectedValueOnce(
      new Error("Connection reset by peer")
    );

    const draftItem = {
      id: "client-unkeyed-1",
      category: "Maintenance",
      name: "Light bulb",
      description: "Counter light",
      amount: 250
    };

    const draftInput: DailyLedgerInput = {
      dayNo: 1,
      expenses: [draftItem],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    // First attempt fails
    await expect(saveExpenseDayPostgres("2026-08", draftInput)).rejects.toThrow("Connection reset by peer");

    // The service must have attached an idempotencyKey to the draft item object
    expect(draftItem).toHaveProperty("idempotencyKey");
    const generatedKey = (draftItem as any).idempotencyKey;
    expect(typeof generatedKey).toBe("string");
    expect(generatedKey.length).toBeGreaterThan(0);

    const [, keyCall1] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[0];
    expect(keyCall1).toBe(generatedKey);

    // Second attempt reuses that exact generated key
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValueOnce({
      data: { id: "server-bulb-uuid", revision: 1 }
    });

    await saveExpenseDayPostgres("2026-08", draftInput);

    const [, keyCall2] = vi.mocked(ledgerApiClient.expenses.create).mock.calls[1];
    expect(keyCall2).toBe(generatedKey);
  });

  it("5. Server deduplication on retry retains the created server record without unintended deletion", async () => {
    // Scenario: Request 1 actually succeeded on server, creating server row 'server-exp-committed-99'.
    // Client timed out and did not receive response.
    // On retry, ledgerApiClient.expenses.list() now includes that committed server row.
    const committedServerRow = {
      id: "server-exp-committed-99",
      day_id: "day-uuid-1",
      category_id: null,
      category_name_snapshot: "General",
      item_name: "Printer Paper",
      description: "A4 ream",
      amount: "800.00",
      revision: 1
    };

    vi.mocked(ledgerApiClient.expenses.list).mockResolvedValue({
      data: [committedServerRow]
    });

    // The backend idempotency check returns the committed response when the same key is received
    vi.mocked(ledgerApiClient.expenses.create).mockResolvedValue({
      data: committedServerRow
    });

    const draftInput: DailyLedgerInput = {
      dayNo: 1,
      expenses: [
        {
          id: "draft-client-paper-1",
          idempotencyKey: "idem-paper-committed-key",
          category: "General",
          name: "Printer Paper",
          description: "A4 ream",
          amount: 800
        }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    const res = await saveExpenseDayPostgres("2026-08", draftInput);

    expect(res.success).toBe(true);
    // create is called with the duplicate key, returning the cached record
    expect(ledgerApiClient.expenses.create).toHaveBeenCalledWith(
      expect.objectContaining({ item_name: "Printer Paper", amount: 800 }),
      "idem-paper-committed-key"
    );
    // Crucial: The committed server row must NOT be deleted!
    expect(ledgerApiClient.expenses.delete).not.toHaveBeenCalled();
    // And draftInput.expenses[0].id is reconciled with server ID
    expect(draftInput.expenses[0].id).toBe("server-exp-committed-99");
  });
});
