import type { UserRole } from "../../../types/ledger";

export type JazzLoadMonthStatus = "open" | "closed";
export type JazzLoadDayStatus = "open" | "closed";
export type JazzLoadRateType = "ml_addition" | "commission1_adjustment" | "commission2_payment" | "commission" | "adjustment" | "custom";
export type JazzLoadCommissionRuleType = "payment_based" | "issuance_based" | "adjustment_based" | "custom";
export type JazzLoadCommissionAppliesTo = "paymentReceived" | "todayMlIssuance" | "closingBalance" | "custom";

export type CalculatedMoney = {
  baseAmount: number;
  calculatedAmount: number;
  appliedRateId: string;
  appliedRateName: string;
  appliedRatePercentage: number;
  calculatedAt: number;
};

export type JazzLoadRateConfig = {
  id: string;
  name: string;
  type: JazzLoadRateType;
  percentage: number;
  active: boolean;
  description?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadCommissionRule = {
  id: string;
  name: string;
  type: JazzLoadCommissionRuleType;
  percentage: number;
  active: boolean;
  appliesTo: JazzLoadCommissionAppliesTo;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadCommissionResult = {
  baseAmount: number;
  commissionAmount: number;
  appliedRateId: string;
  appliedRateName: string;
  appliedRatePercentage: number;
};

export type JazzLoadAppliedRateSnapshot = {
  rateId: string;
  rateName: string;
  rateType: JazzLoadRateType;
  percentage: number;
  appliedAt: number;
};

export type JazzLoadDoProfile = {
  id: string;
  name: string;
  line?: string;
  active: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadDoName = {
  id: string;
  name: string;
  active: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadDoLine = {
  id: string;
  line: string;
  sortOrder?: number;
  active: boolean;
  notes?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadDoAssignment = {
  id: string;
  date: string;
  monthId: string;
  dayNo: number;
  doNameId: string;
  doName: string;
  doLineId: string;
  doLine: string;
  doLineSortOrder?: number;
  active: boolean;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadDoEntryDraft = {
  id: string;
  doProfileId?: string;
  doNameId?: string;
  doLineId?: string;
  assignmentId?: string;
  doLineSortOrder?: number;
  doName: string;
  doLine?: string;
  openingBase?: number;
  todayMlIssuanceBase: number;
  paymentReceivedBase: number;
  notes?: string;
};

export type JazzLoadDoEntry = {
  id: string;
  doProfileId?: string;
  doNameId?: string;
  doLineId?: string;
  assignmentId?: string;
  doLineSortOrder?: number;
  doName: string;
  doLine?: string;
  openingBalance: CalculatedMoney;
  todayMlIssuance: CalculatedMoney;
  dayTotal: CalculatedMoney;
  paymentReceived: CalculatedMoney;
  closingBalance: CalculatedMoney;
  commission?: JazzLoadCommissionResult;
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
};

export type JazzLoadDailyLiftingInput = {
  openingBalance: number;
  mlLifting: number;
};

export type JazzLoadDailyLifting = JazzLoadDailyLiftingInput & {
  totalBalance: number;
  todayMlIssuance: number;
  inHandBalance: number;
};

export type JazzLoadDailySummary = {
  openingBase: number;
  openingMl: number;
  issuanceBase: number;
  issuanceMl: number;
  dayTotalBase: number;
  dayTotalMl: number;
  paymentBase: number;
  paymentMl: number;
  closingBase: number;
  closingMl: number;
  commission1: number;
  commission1MlDeduction: number;
  commission1AdjustedPayment: number;
  commission1Rate?: JazzLoadAppliedRateSnapshot;
  commission2: number;
  commission2Rate?: JazzLoadAppliedRateSnapshot;
  totalCommission: number;
  outstandingDoCount: number;
};

export type JazzLoadDay = {
  id: string;
  monthId: string;
  dayNo: number;
  date: string;
  status: JazzLoadDayStatus;
  doEntries: JazzLoadDoEntry[];
  lifting: JazzLoadDailyLifting;
  summary: JazzLoadDailySummary;
  appliedRates?: {
    mlRate?: JazzLoadAppliedRateSnapshot;
    commission1Rate?: JazzLoadAppliedRateSnapshot;
    commission2Rate?: JazzLoadAppliedRateSnapshot;
  };
  notes?: string;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closedBy?: string;
  lockedAt?: number;
  lockedBy?: string;
  lockedByRole?: UserRole;
  reopenedAt?: number;
  reopenedBy?: string;
  reopenedByRole?: UserRole;
  reopenedUntilAt?: number;
};

export type JazzLoadMonth = {
  id: string;
  label: string;
  status: JazzLoadMonthStatus;
  openingBalance?: number;
  closingBalance?: number;
  totalMlIssuance?: number;
  totalPayments?: number;
  totalLifting?: number;
  totalCommission?: number;
  createdBy: string;
  updatedBy?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  closedBy?: string;
};

export type JazzLoadMonthlySummary = {
  monthId: string;
  totalOpeningBase: number;
  totalIssuanceBase: number;
  totalIssuanceMl: number;
  totalPaymentsBase: number;
  totalPaymentsMl: number;
  totalClosingBase: number;
  totalClosingMl: number;
  totalLifting: number;
  latestInHandBalance: number;
  totalCommission: number;
  dayRows: Array<{
    dayNo: number;
    issuanceBase: number;
    issuanceMl: number;
    paymentBase: number;
    paymentMl: number;
    closingBase: number;
    lifting: number;
    inHandBalance: number;
    commission1: number;
    commission2: number;
    commission: number;
  }>;
  doBalances: Array<{
    doProfileId?: string;
    doNameId?: string;
    doLineId?: string;
    doName: string;
    doLine?: string;
    doLineSortOrder?: number;
    openingBase: number;
    issuanceBase: number;
    paymentBase: number;
    closingBase: number;
    closingMl: number;
    activeDays: number;
  }>;
  missingDays: number[];
  updatedAt: number;
};

export type ActiveJazzLoadRates = {
  mlRate: JazzLoadRateConfig | null;
  commission1Rate: JazzLoadRateConfig | null;
  commission2Rate: JazzLoadRateConfig | null;
  commissionRule?: JazzLoadCommissionRule | null;
};

export type JazzLoadAuditEvent = {
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

export type ValidationResult = {
  valid: boolean;
  errors: string[];
};

export type JazzLoadBackup = {
  months: JazzLoadMonth[];
  days: JazzLoadDay[];
  rates: JazzLoadRateConfig[];
  commissionRules: JazzLoadCommissionRule[];
  doProfiles: JazzLoadDoProfile[];
  doNames?: JazzLoadDoName[];
  doLines?: JazzLoadDoLine[];
  doAssignments?: JazzLoadDoAssignment[];
};
