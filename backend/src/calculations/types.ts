/**
 * Phase 6B: Server-Authoritative Calculation & Projection Engine Types
 */

export interface NumericAmount {
  toString(): string;
}

export interface InvariantViolationItem {
  invariantCode: string;
  severity: "critical" | "error" | "warning";
  message: string;
  details?: Record<string, unknown>;
  dayId?: string;
  periodId: string;
}

export interface DayFinancialProjectionData {
  openingCash: number;
  totalIssues: number;
  totalExpenses: number;
  closingCash: number;
  operatingProfit: number;
  ownerOpeningBalance: number;
  ownerClosingBalance: number;
  openingJazzPayable: number;
  closingJazzPayable: number;
  commissionSettlementReceipts?: number;
  openingCommissionReceivable?: number;
  closingCommissionReceivable?: number;
}

export interface CreditPartyProjectionData {
  partyId: string;
  openingBalance: number;
  totalLoans: number;
  totalReceipts: number;
  manualAdjustments: number;
  closingBalance: number;
}

export interface StockProductProjectionData {
  productId: string;
  openingQty: number;
  stockInQty: number;
  stockOutQty: number;
  closingQty: number;
}

export interface StockAccountProjectionData {
  accountId: string;
  openingDue: number;
  stockTakenAmount: number;
  paymentReceivedAmount: number;
  transfersOutAmount?: number;
  transfersInAmount?: number;
  closingDue: number;
}

export interface JazzLiftingProjectionData {
  openingLifting: number;
  mlLiftingPurchased: number;
  todayMlIssuance: number;
  closingLiftingInHand: number;
}

export interface JazzDoProjectionData {
  doProfileId: string;
  openingBase: number;
  issuanceBase: number;
  paymentBase: number;
  closingBase: number;
  openingMl: number;
  closingMl: number;
  appliedMlRatePercentage: number;
}

export interface DayCalculationResult {
  dayId: string;
  dayNo: number;
  periodId: string;
  financial: DayFinancialProjectionData;
  creditParties: CreditPartyProjectionData[];
  stockProducts: StockProductProjectionData[];
  stockAccounts: StockAccountProjectionData[];
  jazzLifting: JazzLiftingProjectionData;
  jazzDo: JazzDoProjectionData[];
  violations: InvariantViolationItem[];
}

export interface CalculationRunOptions {
  triggerSource: string;
  userId?: string | null;
  allowClosedDays?: boolean;
}

export interface CalculationRunResult {
  calcRunId: string;
  periodId: string;
  fromDayNo: number;
  toDayNo: number;
  daysCalculated: number;
  durationMs: number;
  violationsCount: number;
  violations: InvariantViolationItem[];
}

export interface PeriodFinalFinancialClosing {
  closingCash: string;
  closingOwnerBalance: string;
  closingJazzPayable: string;
  operatingProfit: string;
  totalIssues: string;
  totalExpenses: string;
  commissionSettlementReceipts?: string;
  openingCommissionReceivable?: string;
  closingCommissionReceivable?: string;
}

export interface PeriodFinalCreditPartyClosing {
  partyId: string;
  partyName: string;
  closingBalance: string;
  openingBalance: string;
  totalLoans: string;
  totalReceipts: string;
  manualAdjustments: string;
}

export interface PeriodFinalJazzLiftingClosing {
  openingLifting: string;
  mlLiftingPurchased: string;
  todayMlIssuance: string;
  closingLiftingInHand: string;
}

export interface PeriodFinalJazzDoClosing {
  doProfileId: string;
  doName: string;
  doLine: string | null;
  openingBase: string;
  issuanceBase: string;
  paymentBase: string;
  closingBase: string;
  openingMl: string;
  closingMl: string;
  appliedMlRatePercentage: string;
}

export interface PeriodFinalStockProductClosing {
  productId: string;
  productName: string;
  openingQty: number;
  stockInQty: number;
  stockOutQty: number;
  closingQty: number;
  status: "active" | "skipped";
}

export interface PeriodFinalStockAccountClosing {
  accountId: string;
  accountName: string;
  openingDue: string;
  stockTakenAmount: string;
  paymentReceivedAmount: string;
  closingDue: string;
}

export interface PeriodFinalCommissionSettlement {
  totalCommissionEarned: string;
  commissionSettledDuringPeriod: string;
  totalCommissionSettledAllTime: string;
  outstandingCommissionReceivable: string;
  settlementStatus: "PENDING_SETTLEMENT" | "SETTLED" | "VERIFIED" | "CLOSED";
  verifiedAt: string | null;
  verifiedByUserId: string | null;
}

export type FinalSettlementBalanceDomain =
  | "COMMISSION_RECEIVABLE"
  | "CASH_SETTLEMENT"
  | "OWNER_BALANCE"
  | "CREDIT_PARTY_BALANCE"
  | "OTHER"
  | "EXPENSE"
  | "COMMISSION";

export interface FinalSettlementEntryData {
  id: string;
  franchiseId: string;
  periodId: string;
  sourcePeriodKey: string;
  settlementDate: string;
  balanceDomain: FinalSettlementBalanceDomain;
  settlementType: string;
  targetEntityId: string | null;
  targetEntityName: string | null;
  amount: string;
  sourceReference: string | null;
  notes: string | null;
  status: "ACTIVE" | "REVERSED";
  targetDayId: string | null;
  revision: number;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinalSettlementDomainSummary {
  balanceDomain: FinalSettlementBalanceDomain;
  label: string;
  targetEntityId?: string | null;
  targetEntityName?: string | null;
  operationalClosingBalance: string;
  settledAmount: string;
  remainingOutstanding: string;
  isResolved: boolean;
  status: "SETTLED" | "PARTIALLY_SETTLED" | "UNSETTLED";
}

export interface PeriodFinalSettlementsLayer {
  entries: FinalSettlementEntryData[];
  domainSummaries: FinalSettlementDomainSummary[];
  totalOutstanding: string;
  allResolved: boolean;
}

export interface PeriodFinalClosingProjection {
  period: {
    id: string;
    periodKey: string;
    yearNum: number;
    monthNum: number;
    label: string;
    status: "open" | "closed";
    finalSettlementStatus?: "PENDING_SETTLEMENT" | "SETTLED" | "VERIFIED" | "CLOSED";
  };
  boundary: "FINAL";
  finalDay: {
    id: string;
    dayNo: number;
    calendarDate: string;
    status: "open" | "closed" | "reopen";
  };
  operationalBalances?: {
    financial: PeriodFinalFinancialClosing;
    creditParties: PeriodFinalCreditPartyClosing[];
  };
  closingBalances: {
    financial: PeriodFinalFinancialClosing;
    jazzLifting: PeriodFinalJazzLiftingClosing | null;
    creditParties: PeriodFinalCreditPartyClosing[];
    stockProducts: PeriodFinalStockProductClosing[];
    stockAccounts: PeriodFinalStockAccountClosing[];
    jazzDoProfiles: PeriodFinalJazzDoClosing[];
    commissionSettlement?: PeriodFinalCommissionSettlement;
  };
  commissionSettlement: PeriodFinalCommissionSettlement;
  finalSettlements: PeriodFinalSettlementsLayer;
  seedBundle: import("../periods/schemas.js").SeedBundleInput;
}
