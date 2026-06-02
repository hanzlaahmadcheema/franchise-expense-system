import type { UserRole } from "../../../types/ledger";

export type StockMonthStatus = "open" | "closed";
export type StockDayStatus = "open" | "closed";
export type StockAccountType = "DO" | "CCR" | "DSO" | "STOCK" | "OTHER";

export type StockProduct = {
  id: string;
  name: string;
  rate: number;
  active: boolean;
  displayOrder: number;
  paymentTrackingEnabled: boolean;
  category?: string;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type StockAccountProfile = {
  id: string;
  name: string;
  type: StockAccountType;
  active: boolean;
  displayOrder: number;
  openingBalance?: number;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type StockProductSnapshot = {
  productId: string;
  productName: string;
  rate: number;
  quantity: number;
  amount: number;
  paymentTrackingEnabled: boolean;
  paymentReceived: number;
  dueBalance: number;
  displayOrder: number;
};

export type StockPaymentSnapshot = {
  categoryId: string;
  categoryName: string;
  amount: number;
  displayOrder: number;
};

export type StockBalanceSnapshot = {
  carryForwardBalance: number;
  totalAmount: number;
  totalPaymentReceived: number;
  dueBalance: number;
};

export type StockDailyAccountEntry = {
  id: string;
  date: string;
  monthId: string;
  dayNo: number;
  accountId: string;
  accountName: string;
  accountType: StockAccountType;
  products: StockProductSnapshot[];
  payments: StockPaymentSnapshot[];
  totalQty: number;
  totalAmount: number;
  totalPaymentReceived: number;
  carryForwardBalance: number;
  dueBalance: number;
  status: StockDayStatus;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closedBy?: string;
};

export type StockDailyAccountDraft = {
  accountId: string;
  productQuantities: Record<string, number>;
  productPayments?: Record<string, number>;
  paymentReceived?: number;
  carryForwardBalance?: number;
  notes?: string;
};

export type StockDailySummary = {
  accountCount: number;
  totalQty: number;
  totalAmount: number;
  totalPaymentReceived: number;
  totalDueBalance: number;
};

export type StockDayRecord = {
  id: string;
  date: string;
  monthId: string;
  dayNo: number;
  entryYear?: number;
  entryMonth?: number;
  entryDay?: number;
  status: StockDayStatus;
  entries: StockDailyAccountEntry[];
  stockOut?: StockDailyAccountEntry[];
  stockIn?: StockInRecord[];
  summary: StockDailySummary;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closedBy?: string;
  reopenedAt?: number;
  reopenedBy?: string;
  reopenedUntilAt?: number;
  recalculatedAt?: number;
};

export type StockMonth = {
  id: string;
  label: string;
  status: StockMonthStatus;
  totalQty?: number;
  totalAmount?: number;
  totalPaymentReceived?: number;
  totalDueBalance?: number;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closedBy?: string;
};

export type StockProductMonthlyTotal = {
  productId: string;
  productName: string;
  quantity: number;
  amount: number;
};

export type StockAccountMonthlyTotal = {
  accountId: string;
  accountName: string;
  accountType: StockAccountType;
  totalQty: number;
  totalAmount: number;
  totalPaymentReceived: number;
  dueBalance: number;
  activeDays: number;
};

export type StockPaymentMonthlyTotal = {
  productId: string;
  productName: string;
  amount: number;
};

export type StockMonthlySummary = {
  monthId: string;
  totalQty: number;
  totalAmount: number;
  totalPaymentReceived: number;
  totalDueBalance: number;
  openingStock?: Record<string, number>;
  closingStock?: Record<string, number>;
  openingJazzPayable?: number;
  closingJazzPayable?: number;
  productTotals: StockProductMonthlyTotal[];
  accountTotals: StockAccountMonthlyTotal[];
  paymentTotals: StockPaymentMonthlyTotal[];
  dayRows: Array<{
    dayNo: number;
    date: string;
    accountCount: number;
    totalQty: number;
    totalAmount: number;
    totalPaymentReceived: number;
    totalDueBalance: number;
    status: StockDayStatus;
  }>;
  missingDays: number[];
  updatedAt: number;
};

export type StockAuditEvent = {
  id: string;
  action: string;
  userId: string;
  userEmail?: string | null;
  userRole?: UserRole | null;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  createdAt: number;
};

export type StockValidationResult = {
  valid: boolean;
  errors: string[];
};

export type StockProductLine = {
  productId: string;
  productName: string;
  rate: number;
  quantity: number;
  amount: number;
};

export type StockInRecord = {
  id: string;
  date: string;
  monthId: string;
  sourceName: "Jazz Company";
  stockInMode: "cash" | "credit";
  products: StockProductLine[];
  totalQty: number;
  totalAmount: number;
  paidAmount: number;
  jazzPayableAmount: number;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type StockOpeningBalances = {
  openingStock: Record<string, number>;
  jazzOpeningPayable: number;
};

export type StockProductBalance = {
  productId: string;
  productName: string;
  openingStock: number;
  totalStockIn: number;
  totalStockOut: number;
  currentStock: number;
  updatedAt: number;
};

export type StockAccountBalance = {
  accountId: string;
  accountName: string;
  accountType: StockAccountType;
  totalQty: number;
  totalAmount: number;
  totalPaymentReceived: number;
  dueBalance: number;
  updatedAt: number;
};

export type StockJazzCompanyBalance = {
  openingPayable: number;
  totalStockInAmount: number;
  totalPaidAmount: number;
  currentPayable: number;
  updatedAt: number;
};
