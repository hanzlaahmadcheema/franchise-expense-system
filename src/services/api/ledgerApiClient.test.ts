// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError, apiRequest, ledgerApiClient } from "./ledgerApiClient";
import { isPostgreSqlPeriod, resolveAccountingDayId, getAccountingPeriodWithDays } from "./periodDayService";
import { saveExpenseDayPostgres } from "./expenseTransactionService";
import { saveStockDayPostgres } from "./stockTransactionService";
import { saveJazzLoadDayPostgres } from "./jazzLoadTransactionService";

describe("ledgerApiClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("ApiError constructs properly with status, code, and details", () => {
    const err = new ApiError("Day is closed", 422, "DAY_CLOSED", { day_id: "test-day" });
    expect(err.message).toBe("Day is closed");
    expect(err.status).toBe(422);
    expect(err.code).toBe("DAY_CLOSED");
    expect(err.details).toEqual({ day_id: "test-day" });
    expect(err.name).toBe("ApiError");
  });

  it("apiRequest attaches Content-Type and Accept headers", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ data: [] })
    });
    globalThis.fetch = mockFetch as any;

    const result = await apiRequest<{ data: any[] }>("/api/v1/transactions/expenses?day_id=test-123");
    expect(result).toEqual({ data: [] });
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/transactions/expenses?day_id=test-123",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/json"
        })
      })
    );
  });

  it("apiRequest sets X-Client-Mutation-Id when idempotencyKey provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ data: { id: "exp-1" } })
    });
    globalThis.fetch = mockFetch as any;

    await apiRequest("/api/v1/transactions/expenses", {
      method: "POST",
      body: JSON.stringify({ amount: 100 }),
      idempotencyKey: "idem-uuid-123"
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/v1/transactions/expenses",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
          "X-Client-Mutation-Id": "idem-uuid-123",
          "Idempotency-Key": "idem-uuid-123"
        })
      })
    );
  });

  it("apiRequest throws structured ApiError on non-ok responses", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        error: "DAY_CLOSED",
        code: "DAY_CLOSED",
        message: "Cannot modify closed day."
      })
    });
    globalThis.fetch = mockFetch as any;

    await expect(apiRequest("/api/v1/transactions/expenses", { method: "POST" })).rejects.toThrow(
      "Cannot modify closed day."
    );
  });
});

describe("periodDayService", () => {
  it("identifies periods >= 2026-08 as PostgreSQL periods and prior as false", () => {
    expect(isPostgreSqlPeriod("2026-08")).toBe(true);
    expect(isPostgreSqlPeriod("2026-09")).toBe(true);
    expect(isPostgreSqlPeriod("2026-10")).toBe(true);
    expect(isPostgreSqlPeriod("2026-07")).toBe(false);
  });

  it("resolves day ID via periods list and detail endpoints", async () => {
    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          periods: [
            { id: "period-sep-uuid", period_key: "2026-09", year_num: 2026, month_num: 9 }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          period: { id: "period-sep-uuid", period_key: "2026-09" },
          days: [
            { id: "day-1-uuid", day_no: 1, calendar_date: "2026-09-01", status: "open" },
            { id: "day-2-uuid", day_no: 2, calendar_date: "2026-09-02", status: "closed" }
          ]
        })
      });
    globalThis.fetch = mockFetch as any;

    const day1Id = await resolveAccountingDayId("2026-09", 1);
    expect(day1Id).toBe("day-1-uuid");

    const day2Id = await resolveAccountingDayId("2026-09", 2);
    expect(day2Id).toBe("day-2-uuid");

    globalThis.fetch = originalFetch;
  });
});

describe("expenseTransactionService", () => {
  it("synchronizes expenses, commissions, credits, owner transactions via REST and fetches projections", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; body?: any }> = [];

    const mockFetch = vi.fn(async (url: string, options: any = {}) => {
      const method = options.method || "GET";
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, method, body });

      if (url.includes("/api/v1/periods")) {
        if (url === "/api/v1/periods") {
          return {
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({
              periods: [{ id: "period-sep", period_key: "2026-09" }]
            })
          };
        }
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            period: { id: "period-sep", period_key: "2026-09" },
            days: [{ id: "day-1-uuid", day_no: 1, status: "open" }]
          })
        };
      }

      if (url.includes("/api/v1/transactions/expenses") && method === "GET") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: [] }) };
      }
      if (url.includes("/api/v1/transactions/expenses") && method === "POST") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: { id: "exp-created" } }) };
      }

      if (url.includes("/api/v1/transactions/commissions") && method === "GET") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: [] }) };
      }
      if (url.includes("/api/v1/transactions/commissions") && method === "POST") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: { id: "comm-created" } }) };
      }

      if (url.includes("/api/v1/transactions/credits") && method === "GET") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: [] }) };
      }
      if (url.includes("/api/v1/transactions/credits") && method === "POST") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: { id: "cred-created" } }) };
      }

      if (url.includes("/api/v1/transactions/owner") && method === "GET") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: [] }) };
      }
      if (url.includes("/api/v1/transactions/owner") && method === "POST") {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ data: { id: "owner-created" } }) };
      }

      if (url.includes("/api/v1/calculations/projections/day/")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            day: { id: "day-1-uuid", dayNo: 1, status: "open" },
            projections: {
              financial: { closing_cash: "15000.00" },
              creditParties: [],
              stockProducts: [],
              stockAccounts: [],
              jazzLifting: null,
              jazzDo: []
            }
          })
        };
      }

      return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({}) };
    });

    globalThis.fetch = mockFetch as any;

    const result = await saveExpenseDayPostgres("2026-09", {
      dayNo: 1,
      expenses: [{ id: "e1", category: "Salary", name: "Staff Salary", description: "", amount: 500 }],
      commissions: [{ id: "c1", category: "Jazz Cash", amount: 250 }],
      credits: [{ id: "cr1", partyId: "party-uuid-1", partyName: "Party 1", opening: 1000, loan: 200, receive: 50 }],
      ownerBalances: [{ id: "o1", description: "Cash to Owner", amount: 300 }]
    });

    expect(result.success).toBe(true);
    expect(result.dayId).toBe("day-1-uuid");
    expect(result.projections?.financial?.closing_cash).toBe("15000.00");

    // Verify REST API calls were made
    expect(calls.some((c) => c.url.includes("/expenses") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/commissions") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/credits") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/owner") && c.method === "POST")).toBe(true);
    expect(calls.some((c) => c.url.includes("/calculations/projections/day/day-1-uuid"))).toBe(true);

    globalThis.fetch = originalFetch;
  });
});
