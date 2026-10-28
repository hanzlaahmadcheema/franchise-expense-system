import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Populate process.env from backend/.env.production if not already set
if (!process.env.DATABASE_URL) {
  try {
    const envPath = path.resolve(process.cwd(), "backend/.env.production");
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const idx = trimmed.indexOf("=");
          if (idx !== -1) {
            const key = trimmed.slice(0, idx).trim();
            const val = trimmed.slice(idx + 1).trim();
            if (!process.env[key]) {
              process.env[key] = val;
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn("Could not load backend/.env.production:", err);
  }
}

import { setAuthTokenProvider, ledgerApiClient } from "./ledgerApiClient";
import { loadStockMonthPostgres } from "./stockTransactionService";
import { isPeriodKnownInitialized } from "./periodDayService";
import { calculateMonthlySummary } from "../../modules/stock/services/stockCalculations";

describe("stockClosedDayHydration", () => {
  let server: any;

  beforeAll(async () => {
    const { app } = await import("../../../backend/src/app");
    const http = await import("node:http");
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      let url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("/api/v1")) {
        url = `http://localhost:${port}${url}`;
      }
      return originalFetch(url, init);
    };

    const { db } = await import("../../../backend/src/config/database");
    const { createSession } = await import("../../../backend/src/auth/sessionService");

    const user = await db.selectFrom("users").where("username", "=", "owner").selectAll().executeTakeFirst();
    if (!user) throw new Error("No owner user found");
    const session = await createSession(user.id);
    setAuthTokenProvider(async () => session.token);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("recognizes operational PostgreSQL periods as initialized immediately", () => {
    expect(isPeriodKnownInitialized("2026-08")).toBe(true);
    expect(isPeriodKnownInitialized("2026-09")).toBe(true);
    expect(isPeriodKnownInitialized("2026-10")).toBe(true);
    expect(isPeriodKnownInitialized("2025-12")).toBe(false);
    expect(isPeriodKnownInitialized("invalid-key")).toBe(false);
  });

  it("loads full month stock days in parallel so closed days have complete month summary context", async () => {
    const [productsRes, accountsRes] = await Promise.all([
      ledgerApiClient.catalogs.getStockProducts(),
      ledgerApiClient.catalogs.getStockAccounts()
    ]);

    const products = (productsRes.data || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      rate: Number(p.rate ?? 0),
      active: p.is_active,
      displayOrder: Number(p.sort_order ?? 0),
      sortOrder: p.sort_order,
      category: "sim",
      paymentTrackingEnabled: true,
      createdBy: "system",
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));

    const accounts = (accountsRes.data || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      slug: a.slug,
      type: a.type,
      openingBalance: Number(a.opening_balance ?? 0),
      active: a.is_active,
      displayOrder: Number(a.sort_order ?? 0),
      sortOrder: a.sort_order,
      createdBy: "system",
      createdAt: Date.now(),
      updatedAt: Date.now()
    }));

    // 1. Load full month via loadStockMonthPostgres
    const monthDays = await loadStockMonthPostgres("2026-10", products, accounts);
    expect(monthDays.length).toBe(31);

    // Verify ordering
    for (let i = 0; i < 31; i++) {
      expect(monthDays[i].dayNo).toBe(i + 1);
    }

    // Day 26 has 1 inbound order (stockIn) and 13 outbound issuance entries
    const day26 = monthDays.find((d) => d.dayNo === 26);
    expect(day26).toBeDefined();
    expect((day26?.stockIn || []).length).toBeGreaterThanOrEqual(1);
    const day26ActiveEntries = (day26?.entries || []).filter((e) => e.totalQty > 0 || e.totalPaymentReceived > 0);
    expect(day26ActiveEntries.length).toBe(14);

    // Day 1 has zero outbound activity
    const day1 = monthDays.find((d) => d.dayNo === 1);
    expect(day1).toBeDefined();
    const day1ActiveEntries = (day1?.entries || []).filter((e) => e.totalQty > 0 || e.totalPaymentReceived > 0);
    expect(day1ActiveEntries.length).toBe(0);

    // 2. Verify calculateMonthlySummary produces full monthly figures from monthDays
    const summary = calculateMonthlySummary("2026-10", monthDays);
    expect(summary.totalQty).toBeGreaterThan(0);
    expect(summary.totalAmount).toBeGreaterThan(0);
    expect(summary.totalPaymentReceived).toBeGreaterThan(0);
    expect(summary.accountTotals.length).toBeGreaterThan(0);

    // 3. Verify dealer master rows can be resolved across monthDays even when user is positioned on Day 1
    const testAccountId = day26ActiveEntries[0]?.accountId;
    expect(testAccountId).toBeDefined();

    // Emulate visibleSelectedDealerMasterDayRows filtering
    const dealerDayRows = monthDays.flatMap((day) => {
      const entry = day.entries.find((e) => e.accountId === testAccountId);
      if (!entry || (entry.totalQty === 0 && entry.totalPaymentReceived === 0)) return [];
      return [{ dayNo: day.dayNo, totalQty: entry.totalQty, totalAmount: entry.totalAmount }];
    });

    // Dealer has transactions in the month dataset even though Day 1 itself had no outbound entries
    expect(dealerDayRows.length).toBeGreaterThan(0);
    expect(dealerDayRows.some((row) => row.dayNo === 26)).toBe(true);
  });
});
