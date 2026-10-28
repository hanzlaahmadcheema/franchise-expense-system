/**
 * Phase 6B: Invariant Rules & Violations Evaluator
 *
 * Implements the financial and operational invariants.
 * Distinguishes strictly between:
 * - Critical Errors: Hard math or state breaches that abort calculation and rollback the transaction.
 * - Warnings: Operational alerts (negative stock, negative lifting, overdraft) logged to `invariant_violations`
 *   without halting calculations.
 */

import { round2 } from "./evaluators.js";
import type {
  DayFinancialProjectionData,
  CreditPartyProjectionData,
  StockProductProjectionData,
  StockAccountProjectionData,
  JazzLiftingProjectionData,
  JazzDoProjectionData,
  InvariantViolationItem
} from "./types.js";

export class InvariantViolationError extends Error {
  public readonly code: string;
  public readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(`[${code}] ${message}`);
    this.name = "InvariantViolationError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Validate Day Financial State Invariants
 */
export function validateFinancialInvariants(
  dayId: string,
  periodId: string,
  data: DayFinancialProjectionData
): InvariantViolationItem[] {
  const warnings: InvariantViolationItem[] = [];

  // Critical: Closing Cash Math
  const settlementReceipts = data.commissionSettlementReceipts ?? 0;
  const expectedCash = round2(data.openingCash + data.totalIssues + settlementReceipts - data.totalExpenses);
  if (round2(data.closingCash) !== expectedCash) {
    throw new InvariantViolationError(
      "INV_CASH_CLOSING_MATH",
      `Closing cash math mismatch: expected ${expectedCash}, got ${data.closingCash}`,
      { dayId, periodId, data, expectedCash }
    );
  }

  // Warning: Negative Cash (Register deficit/overdraft)
  if (data.closingCash < 0) {
    warnings.push({
      invariantCode: "INV_CASH_NEGATIVE",
      severity: "warning",
      message: `Operational cash register is negative (${data.closingCash}) on day ${dayId}`,
      details: { dayId, closingCash: data.closingCash },
      dayId,
      periodId
    });
  }

  return warnings;
}

/**
 * Validate Credit Party Invariants
 */
export function validateCreditPartyInvariants(
  dayId: string,
  periodId: string,
  data: CreditPartyProjectionData
): InvariantViolationItem[] {
  const expectedClosing = round2(
    data.openingBalance + data.totalLoans - data.totalReceipts + data.manualAdjustments
  );

  if (round2(data.closingBalance) !== expectedClosing) {
    throw new InvariantViolationError(
      "INV_CREDIT_CLOSING_MATH",
      `Credit party ${data.partyId} closing balance mismatch: expected ${expectedClosing}, got ${data.closingBalance}`,
      { dayId, periodId, partyId: data.partyId, expectedClosing, data }
    );
  }

  return [];
}

/**
 * Validate Stock Product Invariants
 */
export function validateStockProductInvariants(
  dayId: string,
  periodId: string,
  data: StockProductProjectionData
): InvariantViolationItem[] {
  const warnings: InvariantViolationItem[] = [];

  // Critical: Quantity Math
  const expectedQty = data.openingQty + data.stockInQty - data.stockOutQty;
  if (data.closingQty !== expectedQty) {
    throw new InvariantViolationError(
      "INV_STOCK_QTY_MATH",
      `Stock product ${data.productId} quantity mismatch: expected ${expectedQty}, got ${data.closingQty}`,
      { dayId, periodId, productId: data.productId, expectedQty, data }
    );
  }

  // Warning: Negative Stock Quantity (Permitted operationally to prevent warehouse block, logged as invariant violation)
  if (data.closingQty < 0) {
    warnings.push({
      invariantCode: "INV_STOCK_QTY_NEGATIVE",
      severity: "warning",
      message: `Stock product ${data.productId} has negative closing inventory (${data.closingQty})`,
      details: { dayId, productId: data.productId, closingQty: data.closingQty },
      dayId,
      periodId
    });
  }

  return warnings;
}

/**
 * Validate Stock Account (Dealer Due) Invariants
 */
export function validateStockAccountInvariants(
  dayId: string,
  periodId: string,
  data: StockAccountProjectionData
): InvariantViolationItem[] {
  const expectedDue = round2(
    data.openingDue +
      data.stockTakenAmount -
      data.paymentReceivedAmount +
      (data.transfersOutAmount ?? 0) -
      (data.transfersInAmount ?? 0)
  );

  if (round2(data.closingDue) !== expectedDue) {
    throw new InvariantViolationError(
      "INV_STOCK_DUE_MATH",
      `Stock account ${data.accountId} due mismatch: expected ${expectedDue}, got ${data.closingDue}`,
      { dayId, periodId, accountId: data.accountId, expectedDue, data }
    );
  }

  return [];
}

/**
 * Validate Jazz Lifting Invariants
 */
export function validateJazzLiftingInvariants(
  dayId: string,
  periodId: string,
  data: JazzLiftingProjectionData
): InvariantViolationItem[] {
  const warnings: InvariantViolationItem[] = [];

  // Critical: Lifting Math
  const expectedLifting = round2(
    data.openingLifting + data.mlLiftingPurchased - data.todayMlIssuance
  );

  if (round2(data.closingLiftingInHand) !== expectedLifting) {
    throw new InvariantViolationError(
      "INV_LIFTING_MATH",
      `Jazz lifting in-hand mismatch: expected ${expectedLifting}, got ${data.closingLiftingInHand}`,
      { dayId, periodId, expectedLifting, data }
    );
  }

  // Warning: Negative Lifting In Hand
  if (data.closingLiftingInHand < 0) {
    warnings.push({
      invariantCode: "INV_LIFTING_NEGATIVE",
      severity: "warning",
      message: `Jazz lifting in-hand balance is negative (${data.closingLiftingInHand}) on day ${dayId}`,
      details: { dayId, closingLiftingInHand: data.closingLiftingInHand },
      dayId,
      periodId
    });
  }

  return warnings;
}

/**
 * Validate Jazz DO Profile Invariants
 */
export function validateJazzDoInvariants(
  dayId: string,
  periodId: string,
  data: JazzDoProjectionData
): InvariantViolationItem[] {
  const expectedBase = round2(
    data.openingBase + data.issuanceBase - data.paymentBase
  );

  if (round2(data.closingBase) !== expectedBase) {
    throw new InvariantViolationError(
      "INV_JAZZ_DO_MATH",
      `Jazz DO ${data.doProfileId} closing base mismatch: expected ${expectedBase}, got ${data.closingBase}`,
      { dayId, periodId, doProfileId: data.doProfileId, expectedBase, data }
    );
  }

  return [];
}

/**
 * Validate Day-to-Day Opening Chain
 */
export function validateOpeningChain(
  dayNo: number,
  expectedOpening: number,
  actualOpening: number,
  entityName: string,
  entityId?: string
) {
  if (round2(expectedOpening) !== round2(actualOpening)) {
    throw new InvariantViolationError(
      "INV_DAY_OPENING_CHAIN",
      `Opening chain broken for ${entityName} ${entityId ?? ""} on day ${dayNo}: expected ${expectedOpening}, got ${actualOpening}`,
      { dayNo, entityName, entityId, expectedOpening, actualOpening }
    );
  }
}
