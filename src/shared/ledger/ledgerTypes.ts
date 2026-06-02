import type { UserRole } from "../../types/ledger";

export const LEDGER_CALC_VERSION = 2;

export type LedgerModule = "expense" | "jazzLoad" | "stock" | "system";

export type LedgerReadableModule = Exclude<LedgerModule, "system">;

export type LedgerReadMode = "v1" | "v2-shadow" | "v2";

export type LedgerReadModeConfig = {
  expenseReadMode: LedgerReadMode;
  jazzLoadReadMode: LedgerReadMode;
  stockReadMode: LedgerReadMode;
  verifiedReportId?: string;
  shadowReportId?: string;
  monthId?: string;
  status?: "shadow_verified" | "shadow_pending" | "disabled";
  hardV2Allowed?: boolean;
  enabledForRoles?: UserRole[];
  actor?: string;
  applyReportPath?: string;
  shadowReportPath?: string;
  shadowMetrics?: {
    v1VsV2Diffs: number;
    storedV2VsRecomputedV2Diffs: number;
    invariantFailures: number;
    day30DuplicateCreditRawEntriesBefore: number;
    day30DuplicateCreditRawEntriesAfter: number;
  };
  createdAt?: number;
  updatedAt?: number;
  updatedBy?: string;
};

export const defaultLedgerReadModeConfig: LedgerReadModeConfig = {
  expenseReadMode: "v1",
  jazzLoadReadMode: "v1",
  stockReadMode: "v1"
};

export type LedgerEntrySource = "user" | "import" | "migration" | "repair" | "compat";

export type LedgerCalcStatus = "pending" | "preview" | "verified" | "mismatch" | "failed";

export type LedgerAuditAction =
  | "RAW_ENTRY_SAVED"
  | "FORWARD_RECALC_STARTED"
  | "FORWARD_RECALC_COMPLETED"
  | "FORWARD_RECALC_FAILED"
  | "BALANCE_MISMATCH_DETECTED"
  | "BALANCE_MISMATCH_REPAIRED"
  | "DAY_CLOSED"
  | "DAY_REOPENED"
  | "ALL_DAYS_REOPENED"
  | "PREVIOUS_DAYS_CLOSED"
  | "MASTER_REFRESH_STARTED"
  | "MASTER_REFRESH_COMPLETED"
  | "MASTER_REFRESH_FAILED"
  | "MIGRATION_STARTED"
  | "MIGRATION_COMPLETED"
  | "MIGRATION_FAILED"
  | "BACKUP_CREATED";

export type LedgerActor = {
  actorUid: string;
  actorEmail: string | null;
  actorRole: UserRole;
};

export type LedgerMeta = {
  updatedAt: number;
  updatedBy: string;
  recalculatedAt?: number;
  calculationVersion?: number;
  calcRunId?: string;
  status?: LedgerCalcStatus;
};

export type RawCalculatedRecord<Raw, Calculated> = {
  raw: Raw;
  calculated?: Calculated;
  meta: LedgerMeta;
};

export type LedgerInvariantType =
  | "DAY_OPENING_MISMATCH"
  | "MONTH_OPENING_MISMATCH"
  | "CLOSING_FORMULA_MISMATCH"
  | "COMPATIBILITY_MISMATCH"
  | "SUMMARY_TOTAL_MISMATCH"
  | "INVALID_RAW_VALUE";

export type LedgerInvariantIssue = {
  id: string;
  type: LedgerInvariantType;
  module: LedgerModule;
  severity: "warning" | "error";
  message: string;
  monthId?: string;
  dayNo?: number;
  targetType?: string;
  targetId?: string;
  expected?: number | string;
  actual?: number | string;
  sourcePath?: string;
};

export type LedgerCalcRun = {
  id: string;
  module: LedgerModule;
  monthId: string;
  startDay: number;
  endDay: number;
  status: "started" | "completed" | "failed";
  calculationVersion: number;
  actorUid: string;
  actorEmail: string | null;
  actorRole: UserRole;
  rowsRead: number;
  rowsWritten: number;
  invariantIssueCount: number;
  createdAt: number;
  completedAt?: number;
  error?: string;
};

export type LedgerMismatchReport = {
  id: string;
  module: LedgerModule;
  monthId: string;
  calcRunId: string;
  status: "open" | "repaired" | "ignored";
  issues: LedgerInvariantIssue[];
  createdAt: number;
  repairedAt?: number;
};
