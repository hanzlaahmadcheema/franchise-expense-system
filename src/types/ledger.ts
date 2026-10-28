export const COMMISSION_CATEGORIES = [
  "JazzCash",
  "JazzLoad",
  "Efics MFS",
  "Efics BILL",
  "SIM Commission",
  "Retail IMSI",
  "Franchise IMSI",
  "GST Comm",
  "Tax Claim Rebate",
  "MNP Comm",
  "Other 1",
  "Other 2"
] as const;

export type CommissionCategory = string;

export type UserRole = "owner" | "admin" | "viewer";

export interface LedgerUser {
  uid: string;
  email?: string | null;
  displayName?: string | null;
}

export type MonthStatus = "open" | "closed";
export type CalendarDayStatus = "open" | "closed" | "reopen";

export type NotificationSettings = {
  enabled: boolean;
  sendOnDayClose: boolean;
  sendOnMonthClose: boolean;
  sendOnImport: boolean;
  sendOnRecalculate: boolean;
  sendOnRoleChange: boolean;
  updatedAt?: number;
};

export type ImportWarning = {
  level: "info" | "warning" | "error";
  message: string;
  sheetName?: string;
};

export type ExpenseItem = {
  id: string;
  name: string;
  description: string;
  amount: number;
  categoryId?: string;
  category?: string;
};

export type CommissionItem = {
  id: string;
  categoryId?: string;
  category: CommissionCategory;
  amount: number;
};

export type CreditRow = {
  id: string;
  partyId?: string;
  partyName: string;
  description?: string;
  loanDescription?: string;
  receiveDescription?: string;
  opening: number;
  loan: number;
  receive: number;
  balance?: number;
  today?: number;
};

export type OwnerBalanceRow = {
  id: string;
  description: string;
  amount: number;
  expense?: number;
  received?: number;
  opening?: number;
  balance?: number;
  label?: string;
};

export type DailyLedgerInput = {
  dayNo: number;
  date?: string;
  label?: string;
  notes?: string;
  importType?: "expense" | "full";
  entryYear?: number;
  entryMonth?: number;
  entryDay?: number;
  status?: CalendarDayStatus;
  manualOverride?: boolean;
  lockedAt?: number;
  lockedBy?: string;
  lockedByRole?: UserRole;
  closedAt?: number;
  closedBy?: string;
  reopenedUntilAt?: number;
  reopenedAt?: number;
  reopenedBy?: string;
  reopenedByRole?: UserRole;
  recalculatedAt?: number;
  recalculatedBy?: string;
  recalculatedByRole?: UserRole;
  recalculationSource?: string;
  updatedAt?: number;
  openingCash?: number;
  ownerOpeningBalance?: number;
  loadError?: string;
  expenses: ExpenseItem[];
  commissions: CommissionItem[];
  credits: CreditRow[];
  ownerBalances: OwnerBalanceRow[];
};

export type DailyLedgerComputed = {
  dayNo: number;
  date?: string;
  label?: string;
  notes?: string;
  openingBalance: number;
  ownerOpeningBalance?: number;
  issueBalance: number;
  totalBalance: number;
  expenseTotal: number;
  returnBalance: number;
  commissionTotal: number;
  ownerBalanceTotal: number;
  ownerBalances: OwnerBalanceRow[];
  creditRows: CreditRow[];
  creditTotals: {
    opening: number;
    today: number;
    receive: number;
    balance: number;
  };
};

export type MonthComputed = {
  monthId?: string;
  openingBalance: number;
  days: DailyLedgerComputed[];
  homeSummary: {
    monthlyIssueTotal: number;
    monthlyExpenseTotal: number;
    monthlyReturnBalance: number;
    ownerBalanceTotal: number;
    creditBalanceTotal: number;
    expenseByCategory: Array<{
      category: string;
      amount: number;
    }>;
    creditPartyBalances: Array<{
      partyName: string;
      balance: number;
      activeDays: number;
    }>;
    dayRows: Array<{
      dayNo: number;
      date?: string;
      label?: string;
      openingBalance: number;
      issueBalance: number;
      totalBalance: number;
      expenseTotal: number;
      returnBalance: number;
      creditBalance: number;
    }>;
    commissionMatrix: Array<{
      dayNo: number;
      byCategory: Record<string, number>;
      rowTotal: number;
    }>;
  };
};

export type ExpenseCarryForwardCreditBalance = {
  partyId?: string;
  partyName: string;
  balance: number;
};

export type ExpenseCarryForwardSeed = {
  sourceMonthId: string;
  sourceDayNo: number;
  openingBalance: number;
  ownerOpeningBalance: number;
  creditBalances: ExpenseCarryForwardCreditBalance[];
  isGenesis?: boolean;
};

export type MonthRecord = {
  id: string;
  label: string;
  openingBalance: number;
  ownerOpeningBalance?: number;
  status: MonthStatus;
  importedFileName?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type CatalogItem = {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
  createdAt?: number;
  updatedAt?: number;
};

export type UserProfile = {
  uid: string;
  email?: string | null;
  role: UserRole;
  active: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type AuthorizedEmail = {
  id: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt?: number;
  updatedAt?: number;
};

export type WorkbookImportPreview = {
  monthId: string;
  fileName: string;
  importType: "expense" | "full";
  openingBalance: number;
  workbookTotals?: {
    monthlyIssueTotal: number;
    monthlyExpenseTotal: number;
  };
  days: DailyLedgerInput[];
  computed: MonthComputed;
  warnings: ImportWarning[];
};

export type AuditEvent = {
  id: string;
  action: "import" | "edit-day" | "lock-day" | "recalculate" | "export" | "close-month" | "reopen-month" | "role-change" | "reopen-day" | "manual-day" | "manual-month";
  actorUid?: string;
  actorEmail?: string | null;
  createdAt: number;
  detail: string;
};

export type AuditLogModule = "expense" | "jazzLoad" | "stock" | "auth" | "settings" | "system";

export type SystemAuditLog = {
  id: string;
  createdAt: number;
  module: AuditLogModule;
  action: string;
  summary: string;
  actorUid: string;
  actorEmail: string | null;
  actorRole: UserRole;
  monthId?: string;
  dayNo?: number;
  date?: string;
  targetType?: string;
  targetId?: string;
  sourcePath?: string;
  before?: unknown;
  after?: unknown;
};

export type AuditLogFilters = {
  fromMs?: number;
  toMs?: number;
  module?: AuditLogModule;
  action?: string;
  actorUid?: string;
  monthId?: string;
  search?: string;
};

export const AUDIT_LOG_ACTIONS: Record<AuditLogModule, readonly string[]> = {
  expense: [
    "edit-day",
    "lock-day",
    "reopen-day",
    "reopen-window-close",
    "import",
    "recalculate",
    "master-refresh-started",
    "master-refresh-completed",
    "master-refresh-failed",
    "RAW_ENTRY_SAVED",
    "FORWARD_RECALC_STARTED",
    "FORWARD_RECALC_COMPLETED",
    "FORWARD_RECALC_FAILED",
    "BALANCE_MISMATCH_DETECTED",
    "BALANCE_MISMATCH_REPAIRED",
    "DAY_CLOSED",
    "DAY_REOPENED",
    "ALL_DAYS_REOPENED",
    "PREVIOUS_DAYS_CLOSED",
    "MASTER_REFRESH_STARTED",
    "MASTER_REFRESH_COMPLETED",
    "MASTER_REFRESH_FAILED",
    "MIGRATION_STARTED",
    "MIGRATION_COMPLETED",
    "MIGRATION_FAILED",
    "BACKUP_CREATED",
    "auto-save-success",
    "auto-save-failed",
    "close-month",
    "reopen-month",
    "backup-restore",
    "export-report",
    "manual-email"
  ],
  jazzLoad: [
    "save-day",
    "close-day",
    "reopen-day",
    "close-month",
    "reopen-month",
    "do-assignment",
    "backup-restore",
    "master-refresh-started",
    "master-refresh-completed",
    "master-refresh-failed",
    "RAW_ENTRY_SAVED",
    "FORWARD_RECALC_STARTED",
    "FORWARD_RECALC_COMPLETED",
    "FORWARD_RECALC_FAILED",
    "BALANCE_MISMATCH_DETECTED",
    "BALANCE_MISMATCH_REPAIRED",
    "DAY_CLOSED",
    "DAY_REOPENED",
    "ALL_DAYS_REOPENED",
    "PREVIOUS_DAYS_CLOSED",
    "MASTER_REFRESH_STARTED",
    "MASTER_REFRESH_COMPLETED",
    "MASTER_REFRESH_FAILED",
    "auto-save-success",
    "auto-save-failed"
  ],
  stock: [
    "save-day",
    "close-day",
    "reopen-day",
    "close-month",
    "reopen-month",
    "backup-restore",
    "master-refresh-started",
    "master-refresh-completed",
    "master-refresh-failed",
    "RAW_ENTRY_SAVED",
    "FORWARD_RECALC_STARTED",
    "FORWARD_RECALC_COMPLETED",
    "FORWARD_RECALC_FAILED",
    "BALANCE_MISMATCH_DETECTED",
    "BALANCE_MISMATCH_REPAIRED",
    "DAY_CLOSED",
    "DAY_REOPENED",
    "ALL_DAYS_REOPENED",
    "PREVIOUS_DAYS_CLOSED",
    "MASTER_REFRESH_STARTED",
    "MASTER_REFRESH_COMPLETED",
    "MASTER_REFRESH_FAILED",
    "auto-save-success",
    "auto-save-failed"
  ],
  settings: [
    "catalog-upsert",
    "catalog-delete",
    "notification-update",
    "jazz-rate-change",
    "jazz-do-change",
    "stock-settings-change"
  ],
  auth: [
    "role-change",
    "user-delete",
    "authorized-email-upsert",
    "authorized-email-delete",
    "user-bootstrap"
  ],
  system: [
    "recalculate",
    "manual-email",
    "export-report",
    "master-refresh-started",
    "master-refresh-completed",
    "master-refresh-failed",
    "MIGRATION_STARTED",
    "MIGRATION_COMPLETED",
    "MIGRATION_FAILED",
    "BACKUP_CREATED",
    "BALANCE_MISMATCH_DETECTED",
    "BALANCE_MISMATCH_REPAIRED"
  ]
};
