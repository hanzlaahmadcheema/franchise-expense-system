import { describe, expect, it } from "vitest";
import { defaultLedgerReadModeConfig, type LedgerReadModeConfig } from "./ledgerTypes";
import { resolveLedgerUiReadDecision } from "./ledgerReadMode";

function config(overrides: Partial<LedgerReadModeConfig> = {}): LedgerReadModeConfig {
  return {
    ...defaultLedgerReadModeConfig,
    ...overrides
  };
}

describe("resolveLedgerUiReadDecision", () => {
  it("keeps v1 as the UI read source", () => {
    const decision = resolveLedgerUiReadDecision({
      config: config(),
      module: "expense",
      role: "owner",
      monthId: "2026-06"
    });

    expect(decision.readSource).toBe("v1");
    expect(decision.isShadow).toBe(false);
    expect(decision.isCutoverBlocked).toBe(false);
  });

  it("keeps v2-shadow on v1 reads while marking shadow active", () => {
    const decision = resolveLedgerUiReadDecision({
      config: config({ expenseReadMode: "v2-shadow" }),
      module: "expense",
      role: "admin",
      monthId: "2026-06"
    });

    expect(decision.readSource).toBe("v1");
    expect(decision.isShadow).toBe(true);
    expect(decision.isCutoverBlocked).toBe(false);
  });

  it("blocks hard v2 without a reviewed report id", () => {
    const decision = resolveLedgerUiReadDecision({
      config: config({ stockReadMode: "v2" }),
      module: "stock",
      role: "owner",
      monthId: "2026-06"
    });

    expect(decision.readSource).toBe("v1");
    expect(decision.isCutoverBlocked).toBe(true);
  });

  it("allows hard v2 only for the configured module, role, month, and report", () => {
    const nextConfig = config({
      expenseReadMode: "v2",
      jazzLoadReadMode: "v1",
      stockReadMode: "v1",
      verifiedReportId: "reviewed-report",
      monthId: "2026-06",
      enabledForRoles: ["owner", "admin"]
    });

    expect(resolveLedgerUiReadDecision({ config: nextConfig, module: "expense", role: "owner", monthId: "2026-06" }).readSource).toBe("v2");
    expect(resolveLedgerUiReadDecision({ config: nextConfig, module: "jazzLoad", role: "owner", monthId: "2026-06" }).readSource).toBe("v1");
    expect(resolveLedgerUiReadDecision({ config: nextConfig, module: "expense", role: "viewer", monthId: "2026-06" }).isCutoverBlocked).toBe(true);
    expect(resolveLedgerUiReadDecision({ config: nextConfig, module: "expense", role: "owner", monthId: "2026-07" }).isCutoverBlocked).toBe(true);
  });
});
