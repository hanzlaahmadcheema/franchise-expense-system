export const COMMISSION_CATEGORIES = [
  "Jazz Load",
  "Jazz Cash",
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

export type CommissionCategory = (typeof COMMISSION_CATEGORIES)[number];

export type UserRole = "owner" | "staff";

export type MonthStatus = "open" | "closed";

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
  category?: string;
};

export type CommissionItem = {
  id: string;
  category: CommissionCategory;
  amount: number;
};

export type CreditRow = {
  id: string;
  partyName: string;
  opening: number;
  today: number;
  receive: number;
  balance?: number;
};

export type OwnerBalanceRow = {
  id: string;
  label: string;
  amount: number;
};

export type DailyLedgerInput = {
  dayNo: number;
  date?: string;
  label?: string;
  notes?: string;
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
      byCategory: Record<CommissionCategory, number>;
      rowTotal: number;
    }>;
  };
};

export type MonthRecord = {
  id: string;
  label: string;
  openingBalance: number;
  status: MonthStatus;
  importedFileName?: string;
  createdAt?: number;
  updatedAt?: number;
};

export type WorkbookImportPreview = {
  monthId: string;
  fileName: string;
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
  action: "import" | "edit-day" | "recalculate" | "export" | "close-month" | "reopen-month";
  actorUid?: string;
  actorEmail?: string | null;
  createdAt: number;
  detail: string;
};
