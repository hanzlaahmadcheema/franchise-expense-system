import { describe, it, expect } from "vitest";
import {
  parseRoute,
  buildRoutePath,
  normalizeViewSlug,
  type RouteState
} from "./useAppRouter";

describe("useAppRouter URL System", () => {
  describe("normalizeViewSlug", () => {
    it("handles canonical view names", () => {
      expect(normalizeViewSlug("dashboard")).toBe("dashboard");
      expect(normalizeViewSlug("stock-ledger")).toBe("stock-ledger");
      expect(normalizeViewSlug("jazz-load")).toBe("jazz-load");
      expect(normalizeViewSlug("expense")).toBe("expense");
      expect(normalizeViewSlug("dealers")).toBe("dealers");
      expect(normalizeViewSlug("users")).toBe("users");
      expect(normalizeViewSlug("backup")).toBe("backup");
      expect(normalizeViewSlug("audit-logs")).toBe("audit-logs");
      expect(normalizeViewSlug("import")).toBe("import");
    });

    it("handles friendly aliases", () => {
      expect(normalizeViewSlug("home")).toBe("dashboard");
      expect(normalizeViewSlug("stock")).toBe("stock-ledger");
      expect(normalizeViewSlug("stockledger")).toBe("stock-ledger");
      expect(normalizeViewSlug("jazz")).toBe("jazz-load");
      expect(normalizeViewSlug("load")).toBe("jazz-load");
      expect(normalizeViewSlug("jazzload")).toBe("jazz-load");
      expect(normalizeViewSlug("expenses")).toBe("expense");
      expect(normalizeViewSlug("dealer")).toBe("dealers");
      expect(normalizeViewSlug("dos")).toBe("dealers");
      expect(normalizeViewSlug("do")).toBe("dealers");
      expect(normalizeViewSlug("audit")).toBe("audit-logs");
    });

    it("returns null for unknown view names", () => {
      expect(normalizeViewSlug("unknown")).toBeNull();
      expect(normalizeViewSlug("")).toBeNull();
    });
  });

  describe("parseRoute", () => {
    it("returns empty object for root path", () => {
      expect(parseRoute("/")).toEqual({});
      expect(parseRoute("")).toEqual({});
    });

    it("parses simple admin routes", () => {
      expect(parseRoute("/dealers")).toEqual({ view: "dealers" });
      expect(parseRoute("/users")).toEqual({ view: "users" });
      expect(parseRoute("/backup")).toEqual({ view: "backup" });
      expect(parseRoute("/audit-logs")).toEqual({ view: "audit-logs" });
      expect(parseRoute("/import")).toEqual({ view: "import" });
    });

    it("parses dashboard with month", () => {
      expect(parseRoute("/dashboard/2026-11")).toEqual({
        view: "dashboard",
        monthId: "2026-11"
      });
    });

    it("parses daily stock ledger route", () => {
      expect(parseRoute("/stock-ledger/2026-11/day-02")).toEqual({
        view: "stock-ledger",
        monthId: "2026-11",
        selectedDay: 2,
        stockSection: "daily"
      });

      // Flexible day formats
      expect(parseRoute("/stock/2026-10/day-31")).toEqual({
        view: "stock-ledger",
        monthId: "2026-10",
        selectedDay: 31,
        stockSection: "daily"
      });

      expect(parseRoute("/stock-ledger/2026-11/day-5")).toEqual({
        view: "stock-ledger",
        monthId: "2026-11",
        selectedDay: 5,
        stockSection: "daily"
      });
    });

    it("parses stock ledger section routes", () => {
      expect(parseRoute("/stock-ledger/2026-11/reports")).toEqual({
        view: "stock-ledger",
        monthId: "2026-11",
        stockSection: "reportsHub"
      });

      expect(parseRoute("/stock/2026-11/stock-in")).toEqual({
        view: "stock-ledger",
        monthId: "2026-11",
        stockSection: "stockIn"
      });

      expect(parseRoute("/stock-ledger/2026-11/balances")).toEqual({
        view: "stock-ledger",
        monthId: "2026-11",
        stockSection: "balances"
      });

      expect(parseRoute("/stock-ledger/2026-11/settings")).toEqual({
        view: "stock-ledger",
        monthId: "2026-11",
        stockSection: "settings"
      });
    });

    it("parses jazz load routes", () => {
      expect(parseRoute("/jazz-load/2026-11/day-02")).toEqual({
        view: "jazz-load",
        monthId: "2026-11",
        selectedDay: 2,
        jazzLoadSection: "daily"
      });

      expect(parseRoute("/jazz-load/2026-11/reports")).toEqual({
        view: "jazz-load",
        monthId: "2026-11",
        jazzLoadSection: "reports"
      });

      expect(parseRoute("/load/2026-11/formulas")).toEqual({
        view: "jazz-load",
        monthId: "2026-11",
        jazzLoadSection: "formulas"
      });
    });

    it("parses expense routes", () => {
      expect(parseRoute("/expense/2026-11/day-02")).toEqual({
        view: "expense",
        monthId: "2026-11",
        selectedDay: 2,
        expenseSection: "daily-entry"
      });

      expect(parseRoute("/expense/2026-11/records")).toEqual({
        view: "expense",
        monthId: "2026-11",
        expenseSection: "previous-records"
      });

      expect(parseRoute("/expense/2026-11/settings")).toEqual({
        view: "expense",
        monthId: "2026-11",
        expenseSection: "settings"
      });
    });
  });

  describe("buildRoutePath", () => {
    const baseState: RouteState = {
      view: "dashboard",
      monthId: "2026-11",
      selectedDay: 2,
      expenseSection: "daily-entry",
      jazzLoadSection: "daily",
      stockSection: "daily"
    };

    it("builds dashboard path", () => {
      expect(buildRoutePath(baseState)).toBe("/dashboard/2026-11");
    });

    it("builds stock ledger paths", () => {
      expect(buildRoutePath({ ...baseState, view: "stock-ledger", stockSection: "daily", selectedDay: 2 })).toBe(
        "/stock-ledger/2026-11/day-02"
      );

      expect(buildRoutePath({ ...baseState, view: "stock-ledger", stockSection: "reportsHub" })).toBe(
        "/stock-ledger/2026-11/reports"
      );

      expect(buildRoutePath({ ...baseState, view: "stock-ledger", stockSection: "stockIn" })).toBe(
        "/stock-ledger/2026-11/stock-in"
      );
    });

    it("builds jazz load paths", () => {
      expect(buildRoutePath({ ...baseState, view: "jazz-load", jazzLoadSection: "daily", selectedDay: 15 })).toBe(
        "/jazz-load/2026-11/day-15"
      );

      expect(buildRoutePath({ ...baseState, view: "jazz-load", jazzLoadSection: "reports" })).toBe(
        "/jazz-load/2026-11/reports"
      );
    });

    it("builds expense paths", () => {
      expect(buildRoutePath({ ...baseState, view: "expense", expenseSection: "daily-entry", selectedDay: 7 })).toBe(
        "/expense/2026-11/day-07"
      );

      expect(buildRoutePath({ ...baseState, view: "expense", expenseSection: "previous-records" })).toBe(
        "/expense/2026-11/records"
      );
    });

    it("builds admin paths", () => {
      expect(buildRoutePath({ ...baseState, view: "dealers" })).toBe("/dealers");
      expect(buildRoutePath({ ...baseState, view: "users" })).toBe("/users");
      expect(buildRoutePath({ ...baseState, view: "backup" })).toBe("/backup");
      expect(buildRoutePath({ ...baseState, view: "audit-logs" })).toBe("/audit-logs");
      expect(buildRoutePath({ ...baseState, view: "import" })).toBe("/import");
    });
  });
});
