/**
 * Phase 6B: Pure Calculation Evaluators
 *
 * Deterministic mathematical functions for all financial and operational domains.
 * All functions are pure, side-effect free, and use standard IEEE-754 epsilon rounding
 * to prevent floating-point drift.
 */

import type {
  DayFinancialProjectionData,
  CreditPartyProjectionData,
  StockProductProjectionData,
  StockAccountProjectionData,
  JazzLiftingProjectionData,
  JazzDoProjectionData
} from "./types.js";

/**
 * High-precision rounding to 2 decimal places.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * High-precision rounding to 4 decimal places for rates.
 */
export function round4(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

/**
 * 1. Evaluate Operating Cash, Operating Profit, Owner Balance, and Jazz Payable.
 *
 * Rules:
 * - Operating Cash: closing = opening + issues - expenses.
 * - Owner Injections/Draws DO NOT alter operating register cash.
 * - Operating Profit: operatingProfit = totalIssues - totalExpenses.
 * - Owner Balance: closing = opening + netMovement.
 * - Jazz Company Payable: closing = opening + inboundStockAmount - payablePayments.
 */
export function evaluateFinancialState(params: {
  openingCash: number;
  totalIssues: number;
  totalExpenses: number;
  ownerOpeningBalance: number;
  ownerNetMovement: number;
  openingJazzPayable: number;
  inboundStockAmount: number;
  jazzPayablePayments: number;
}): DayFinancialProjectionData {
  const openingCash = round2(params.openingCash);
  const totalIssues = round2(params.totalIssues);
  const totalExpenses = round2(params.totalExpenses);
  const closingCash = round2(openingCash + totalIssues - totalExpenses);
  const operatingProfit = round2(totalIssues - totalExpenses);

  const ownerOpeningBalance = round2(params.ownerOpeningBalance);
  const ownerNetMovement = round2(params.ownerNetMovement);
  const ownerClosingBalance = round2(ownerOpeningBalance + ownerNetMovement);

  const openingJazzPayable = round2(params.openingJazzPayable);
  const inboundStockAmount = round2(params.inboundStockAmount);
  const jazzPayablePayments = round2(params.jazzPayablePayments);
  const closingJazzPayable = round2(openingJazzPayable + inboundStockAmount - jazzPayablePayments);

  return {
    openingCash,
    totalIssues,
    totalExpenses,
    closingCash,
    operatingProfit,
    ownerOpeningBalance,
    ownerClosingBalance,
    openingJazzPayable,
    closingJazzPayable
  };
}

/**
 * 2. Evaluate Credit Party Balance.
 *
 * Formula: closing = opening + loans - receipts + adjustments.
 * Pruning: If opening == 0, loans == 0, receipts == 0, adjustments == 0 -> pruned (returns null).
 */
export function evaluateCreditParty(params: {
  partyId: string;
  openingBalance: number;
  totalLoans: number;
  totalReceipts: number;
  manualAdjustments: number;
}): CreditPartyProjectionData | null {
  const openingBalance = round2(params.openingBalance);
  const totalLoans = round2(params.totalLoans);
  const totalReceipts = round2(params.totalReceipts);
  const manualAdjustments = round2(params.manualAdjustments);

  // Pruning check: zero prior balance and zero today activity
  if (
    openingBalance === 0 &&
    totalLoans === 0 &&
    totalReceipts === 0 &&
    manualAdjustments === 0
  ) {
    return null;
  }

  const closingBalance = round2(
    openingBalance + totalLoans - totalReceipts + manualAdjustments
  );

  return {
    partyId: params.partyId,
    openingBalance,
    totalLoans,
    totalReceipts,
    manualAdjustments,
    closingBalance
  };
}

/**
 * 3. Evaluate Stock Product Quantity.
 *
 * Formula: closingQty = openingQty + stockInQty - stockOutQty.
 * Note: Integer quantities. Negative stock is tolerated with an invariant warning.
 */
export function evaluateStockProduct(params: {
  productId: string;
  openingQty: number;
  stockInQty: number;
  stockOutQty: number;
}): StockProductProjectionData {
  const openingQty = Math.round(params.openingQty);
  const stockInQty = Math.round(params.stockInQty);
  const stockOutQty = Math.round(params.stockOutQty);
  const closingQty = openingQty + stockInQty - stockOutQty;

  return {
    productId: params.productId,
    openingQty,
    stockInQty,
    stockOutQty,
    closingQty
  };
}

/**
 * 4. Evaluate Stock Account Due (Dealer Due / CCR Account).
 *
 * Formula: closingDue = openingDue + stockTakenAmount - paymentReceivedAmount.
 */
export function evaluateStockAccount(params: {
  accountId: string;
  openingDue: number;
  stockTakenAmount: number;
  paymentReceivedAmount: number;
}): StockAccountProjectionData {
  const openingDue = round2(params.openingDue);
  const stockTakenAmount = round2(params.stockTakenAmount);
  const paymentReceivedAmount = round2(params.paymentReceivedAmount);
  const closingDue = round2(openingDue + stockTakenAmount - paymentReceivedAmount);

  return {
    accountId: params.accountId,
    openingDue,
    stockTakenAmount,
    paymentReceivedAmount,
    closingDue
  };
}

/**
 * 5. Evaluate Jazz Lifting In-Hand Balance.
 *
 * Formula: closingLiftingInHand = openingLifting + mlLiftingPurchased - todayMlIssuance.
 */
export function evaluateJazzLifting(params: {
  openingLifting: number;
  mlLiftingPurchased: number;
  todayMlIssuance: number;
}): JazzLiftingProjectionData {
  const openingLifting = round2(params.openingLifting);
  const mlLiftingPurchased = round2(params.mlLiftingPurchased);
  const todayMlIssuance = round2(params.todayMlIssuance);
  const closingLiftingInHand = round2(
    openingLifting + mlLiftingPurchased - todayMlIssuance
  );

  return {
    openingLifting,
    mlLiftingPurchased,
    todayMlIssuance,
    closingLiftingInHand
  };
}

/**
 * 6. Evaluate Jazz DO Profile Running Balance.
 *
 * Formulas:
 * - closingBase = openingBase + issuanceBase - paymentBase
 * - openingMl = openingBase * (1 + appliedRate / 100)
 * - closingMl = closingBase * (1 + appliedRate / 100)
 */
export function evaluateJazzDo(params: {
  doProfileId: string;
  openingBase: number;
  issuanceBase: number;
  paymentBase: number;
  appliedMlRatePercentage: number;
}): JazzDoProjectionData {
  const openingBase = round2(params.openingBase);
  const issuanceBase = round2(params.issuanceBase);
  const paymentBase = round2(params.paymentBase);
  const appliedMlRatePercentage = round4(params.appliedMlRatePercentage);

  const closingBase = round2(openingBase + issuanceBase - paymentBase);
  const rateFactor = 1 + appliedMlRatePercentage / 100;
  const openingMl = round2(openingBase * rateFactor);
  const closingMl = round2(closingBase * rateFactor);

  return {
    doProfileId: params.doProfileId,
    openingBase,
    issuanceBase,
    paymentBase,
    closingBase,
    openingMl,
    closingMl,
    appliedMlRatePercentage
  };
}

/**
 * Two-tier Jazz Load Commission formula helper (for reporting/analytics).
 */
export function calculateJazzLoadCommissions(params: {
  paymentBase: number;
  paymentMl: number;
  comm1RatePercentage: number;
  comm2RatePercentage: number;
}): { commission1: number; commission2: number; totalCommission: number } {
  const paymentBase = round2(params.paymentBase);
  const paymentMl = round2(params.paymentMl);
  const comm1Rate = params.comm1RatePercentage;
  const comm2Rate = params.comm2RatePercentage;

  const commission1 = round2(paymentBase - paymentMl * (1 - comm1Rate / 100));
  const commission2 = round2(paymentBase * (comm2Rate / 100));
  const totalCommission = round2(commission1 + commission2);

  return { commission1, commission2, totalCommission };
}
