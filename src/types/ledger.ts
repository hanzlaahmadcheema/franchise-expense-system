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

export type MonthStatus = "open" | "closed";

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
  lockedAt?: number;
  lockedBy?: string;
  lockedByRole?: UserRole;
  reopenedUntilAt?: number;
  reopenedAt?: number;
  reopenedBy?: string;
  reopenedByRole?: UserRole;
  updatedAt?: number;
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
  targetType?: string;
  targetId?: string;
  sourcePath?: string;
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
    "backup-restore"
  ],
  stock: [
    "save-day",
    "close-day",
    "reopen-day",
    "close-month",
    "reopen-month",
    "backup-restore"
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
  system: ["recalculate", "manual-email", "export-report"]
};
