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
