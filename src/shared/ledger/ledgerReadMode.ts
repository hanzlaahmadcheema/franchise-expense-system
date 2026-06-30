import type { UserRole } from "../../types/ledger";
import type { LedgerReadModeConfig, LedgerReadableModule } from "./ledgerTypes";

export type LedgerUiReadSource = "v1" | "v2";

export type LedgerUiReadDecision = {
  module: LedgerReadableModule;
  mode: LedgerReadModeConfig[`${LedgerReadableModule}ReadMode`];
  readSource: LedgerUiReadSource;
  isShadow: boolean;
  isCutoverBlocked: boolean;
  reason?: string;
};

function modeForModule(config: LedgerReadModeConfig, module: LedgerReadableModule) {
  if (module === "expense") return config.expenseReadMode;
  if (module === "jazzLoad") return config.jazzLoadReadMode;
  return config.stockReadMode;
}

export function resolveLedgerUiReadDecision(input: {
  config: LedgerReadModeConfig;
  module: LedgerReadableModule;
  role: UserRole | null;
  monthId: string;
}): LedgerUiReadDecision {
  const mode = modeForModule(input.config, input.module);
  const allowedRoles = input.config.enabledForRoles ?? ["owner", "admin"];
  const monthAllowed = !input.config.monthId || input.config.monthId === input.monthId;
  const roleAllowed = Boolean(input.role && allowedRoles.includes(input.role));

  if (mode !== "v2") {
    return {
      module: input.module,
      mode,
      readSource: "v1",
      isShadow: mode === "v2-shadow",
      isCutoverBlocked: false
    };
  }

  if (!input.config.verifiedReportId) {
    return {
      module: input.module,
      mode,
      readSource: "v1",
      isShadow: false,
      isCutoverBlocked: true,
      reason: "ledgerV2 read cutover requires a reviewed verification report id."
    };
  }

  if (!monthAllowed) {
    return {
      module: input.module,
      mode,
      readSource: "v1",
      isShadow: false,
      isCutoverBlocked: true,
      reason: `ledgerV2 read cutover is configured for ${input.config.monthId}, not ${input.monthId}.`
    };
  }

  if (!roleAllowed) {
    return {
      module: input.module,
      mode,
      readSource: "v1",
      isShadow: false,
      isCutoverBlocked: true,
      reason: "Your role is not enabled for ledgerV2 UI reads."
    };
  }

  return {
    module: input.module,
    mode,
    readSource: "v2",
    isShadow: false,
    isCutoverBlocked: false
  };
}

export function assertLedgerV2UiReadAllowed(decision: LedgerUiReadDecision) {
  if (decision.mode === "v2" && decision.readSource !== "v2") {
    throw new Error(decision.reason ?? "ledgerV2 UI read cutover is blocked.");
  }
}
