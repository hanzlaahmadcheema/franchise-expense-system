import { describe, expect, it } from "vitest";
import {
  buildAuditLogDocument,
  buildAuditLogQueryConstraints,
  matchesAuditSearch,
  truncateAuditSummary
} from "./auditLogService";
import { limit, orderBy, where } from "firebase/firestore";

describe("auditLogService", () => {
  it("truncates long summaries", () => {
    const long = "x".repeat(600);
    expect(truncateAuditSummary(long).length).toBeLessThanOrEqual(500);
    expect(truncateAuditSummary("short")).toBe("short");
  });

  it("builds audit documents with required fields", () => {
    const log = buildAuditLogDocument(
      {
        module: "expense",
        action: "edit-day",
        summary: "Saved day 3",
        actorUid: "uid-1",
        actorEmail: "owner@example.com",
        monthId: "2026-05",
        dayNo: 3
      },
      "owner"
    );
    expect(log.actorRole).toBe("owner");
    expect(log.module).toBe("expense");
    expect(log.actorUid).toBe("uid-1");
  });

  it("builds query constraints for filters", () => {
    const constraints = buildAuditLogQueryConstraints({
      module: "auth",
      action: "role-change",
      actorUid: "uid-1",
      monthId: "2026-05",
      fromMs: 1,
      toMs: 2
    });
    expect(constraints).toHaveLength(7);
    expect(constraints[0]).toEqual(where("createdAt", ">=", 1));
    expect(constraints[1]).toEqual(where("createdAt", "<=", 2));
    expect(constraints[constraints.length - 1]).toEqual(orderBy("createdAt", "desc"));
  });

  it("matches client-side search text", () => {
    const log = buildAuditLogDocument(
      {
        module: "settings",
        action: "catalog-upsert",
        summary: "Updated expense category Fuel",
        actorUid: "uid-1",
        actorEmail: "owner@example.com"
      },
      "owner"
    );
    expect(matchesAuditSearch(log, "fuel")).toBe(true);
    expect(matchesAuditSearch(log, "missing")).toBe(false);
  });

  it("adds pagination limit separately from filter builder", () => {
    const constraints = buildAuditLogQueryConstraints({});
    expect(constraints.some((entry) => "type" in entry && entry.type === "limit")).toBe(false);
    const withLimit = [...constraints, limit(50)];
    expect(withLimit[withLimit.length - 1]).toEqual(limit(50));
  });
});
