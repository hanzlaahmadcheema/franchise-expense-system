import type {
  ActiveJazzLoadRates,
  JazzLoadAppliedRateSnapshot,
  CalculatedMoney,
  JazzLoadCommissionResult,
  JazzLoadCommissionRule,
  JazzLoadDailyLifting,
  JazzLoadDailyLiftingInput,
  JazzLoadDailySummary,
  JazzLoadDay,
  JazzLoadDoEntry,
  JazzLoadDoEntryDraft,
  JazzLoadMonthlySummary,
  JazzLoadRateConfig,
  ValidationResult
} from "../types/jazzLoad.types";
import { daysInMonth, normalizeDoKey, roundMoney } from "../utils/jazzLoadFormatters";

function sum(values: number[]) {
  return roundMoney(values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0));
}

function doNameIdentityKey(input: Pick<JazzLoadDoEntryDraft, "doNameId" | "doName">) {
  const name = input.doName.trim();
  if (!input.doNameId && !name) return "";
  return input.doNameId ?? normalizeDoKey(name);
}

export function calculateAmountWithRate(
  baseAmount: number,
  rate: JazzLoadRateConfig,
  calculatedAt = Date.now()
): CalculatedMoney {
  const base = roundMoney(baseAmount);
  return {
    baseAmount: base,
    calculatedAmount: roundMoney(base + (base * rate.percentage) / 100),
    appliedRateId: rate.id,
    appliedRateName: rate.name,
    appliedRatePercentage: rate.percentage,
    calculatedAt
  };
}

export function snapshotRate(rate: JazzLoadRateConfig, appliedAt = Date.now()): JazzLoadAppliedRateSnapshot {
  return {
    rateId: rate.id,
    rateName: rate.name,
    rateType: rate.type,
    percentage: rate.percentage,
    appliedAt
  };
}

export function calculateCommission(
  baseAmount: number,
  rule: JazzLoadCommissionRule | null
): JazzLoadCommissionResult | undefined {
  if (!rule || !rule.active) return undefined;
  const base = roundMoney(baseAmount);
  return {
    baseAmount: base,
    commissionAmount: roundMoney((base * rule.percentage) / 100),
    appliedRateId: rule.id,
    appliedRateName: rule.name,
    appliedRatePercentage: rule.percentage
  };
}

export function calculateDoRow(
  input: JazzLoadDoEntryDraft,
  activeRates: ActiveJazzLoadRates,
  metadata: { createdBy: string; previous?: JazzLoadDoEntry; timestamp?: number }
): JazzLoadDoEntry {
  if (!activeRates.mlRate) {
    throw new Error("No active Jazz Load rate configured.");
  }
  const timestamp = metadata.timestamp ?? Date.now();
  const openingBase = roundMoney(input.openingBase ?? metadata.previous?.closingBalance.baseAmount ?? 0);
  const issuanceBase = roundMoney(input.todayMlIssuanceBase);
  const dayTotalBase = roundMoney(openingBase + issuanceBase);
  const paymentBase = roundMoney(input.paymentReceivedBase);
  const closingBase = roundMoney(dayTotalBase - paymentBase);

  return {
    id: input.id,
    doProfileId: input.doProfileId,
    doNameId: input.doNameId,
    doLineId: input.doLineId,
    assignmentId: input.assignmentId,
    doLineSortOrder: input.doLineSortOrder,
    doName: input.doName.trim(),
    doLine: input.doLine?.trim() || undefined,
    openingBalance: calculateAmountWithRate(openingBase, activeRates.mlRate, timestamp),
    todayMlIssuance: calculateAmountWithRate(issuanceBase, activeRates.mlRate, timestamp),
    dayTotal: calculateAmountWithRate(dayTotalBase, activeRates.mlRate, timestamp),
    paymentReceived: calculateAmountWithRate(paymentBase, activeRates.mlRate, timestamp),
    closingBalance: calculateAmountWithRate(closingBase, activeRates.mlRate, timestamp),
    notes: input.notes?.trim() || undefined,
    createdBy: metadata.previous?.createdBy ?? metadata.createdBy,
    updatedBy: metadata.previous ? metadata.createdBy : undefined,
    createdAt: metadata.previous?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

export function calculateDailyLifting(
  input: JazzLoadDailyLiftingInput,
  todayMlIssuance: number
): JazzLoadDailyLifting {
  const openingBalance = roundMoney(input.openingBalance);
  const mlLifting = roundMoney(input.mlLifting);
  const totalBalance = roundMoney(openingBalance + mlLifting);
  return {
    openingBalance,
    mlLifting,
    totalBalance,
    todayMlIssuance: roundMoney(todayMlIssuance),
    inHandBalance: roundMoney(totalBalance - todayMlIssuance)
  };
}

export function calculateDailyCommissionSummary(
  paymentBaseTotal: number,
  paymentMlTotal: number,
  activeRates: Pick<ActiveJazzLoadRates, "commission1Rate" | "commission2Rate">,
  appliedAt = Date.now()
) {
  const paymentBase = roundMoney(paymentBaseTotal);
  const paymentMl = roundMoney(paymentMlTotal);
  const commission1MlDeduction = activeRates.commission1Rate
    ? roundMoney((paymentMl * activeRates.commission1Rate.percentage) / 100)
    : 0;
  const commission1AdjustedPayment = activeRates.commission1Rate
    ? roundMoney(paymentMl - commission1MlDeduction)
    : paymentMl;
  const commission1 = activeRates.commission1Rate
    ? roundMoney(paymentBase - commission1AdjustedPayment)
    : 0;
  const commission2 = activeRates.commission2Rate
    ? roundMoney((paymentBase * activeRates.commission2Rate.percentage) / 100)
    : 0;

  return {
    commission1,
    commission1MlDeduction,
    commission1AdjustedPayment,
    commission1Rate: activeRates.commission1Rate ? snapshotRate(activeRates.commission1Rate, appliedAt) : undefined,
    commission2,
    commission2Rate: activeRates.commission2Rate ? snapshotRate(activeRates.commission2Rate, appliedAt) : undefined,
    totalCommission: roundMoney(commission1 + commission2)
  };
}

export function calculateDailySummary(
  day: Pick<JazzLoadDay, "doEntries">,
  activeRates?: Pick<ActiveJazzLoadRates, "commission1Rate" | "commission2Rate">,
  appliedAt = Date.now()
): JazzLoadDailySummary {
  const entries = day.doEntries;
  const paymentBase = sum(entries.map((entry) => entry.paymentReceived.baseAmount));
  const paymentMl = sum(entries.map((entry) => entry.paymentReceived.calculatedAmount));
  const commissionSummary = activeRates
    ? calculateDailyCommissionSummary(paymentBase, paymentMl, activeRates, appliedAt)
    : {
        commission1: 0,
        commission1MlDeduction: 0,
        commission1AdjustedPayment: paymentMl,
        commission2: 0,
        totalCommission: sum(entries.map((entry) => entry.commission?.commissionAmount ?? 0))
      };
  return {
    openingBase: sum(entries.map((entry) => entry.openingBalance.baseAmount)),
    openingMl: sum(entries.map((entry) => entry.openingBalance.calculatedAmount)),
    issuanceBase: sum(entries.map((entry) => entry.todayMlIssuance.baseAmount)),
    issuanceMl: sum(entries.map((entry) => entry.todayMlIssuance.calculatedAmount)),
    dayTotalBase: sum(entries.map((entry) => entry.dayTotal.baseAmount)),
    dayTotalMl: sum(entries.map((entry) => entry.dayTotal.calculatedAmount)),
    paymentBase,
    paymentMl,
    closingBase: sum(entries.map((entry) => entry.closingBalance.baseAmount)),
    closingMl: sum(entries.map((entry) => entry.closingBalance.calculatedAmount)),
    ...commissionSummary,
    outstandingDoCount: entries.filter((entry) => entry.closingBalance.baseAmount > 0).length
  };
}

export function calculateMonthlySummary(monthId: string, days: JazzLoadDay[]): JazzLoadMonthlySummary {
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);
  const doMap = new Map<string, JazzLoadMonthlySummary["doBalances"][number]>();

  for (const day of sortedDays) {
    for (const entry of day.doEntries) {
      const key = doNameIdentityKey(entry) || entry.doLineId || entry.doProfileId || normalizeDoKey(entry.doName, entry.doLine);
      const current = doMap.get(key) ?? {
        doProfileId: entry.doProfileId,
        doNameId: entry.doNameId,
        doLineId: entry.doLineId,
        doName: entry.doName,
        doLine: entry.doLine,
        doLineSortOrder: entry.doLineSortOrder,
        openingBase: roundMoney(entry.openingBalance.baseAmount),
        issuanceBase: 0,
        paymentBase: 0,
        closingBase: roundMoney(entry.closingBalance.baseAmount),
        closingMl: roundMoney(entry.closingBalance.calculatedAmount),
        activeDays: 0
      };
      current.issuanceBase = roundMoney(current.issuanceBase + entry.todayMlIssuance.baseAmount);
      current.paymentBase = roundMoney(current.paymentBase + entry.paymentReceived.baseAmount);
      current.closingBase = roundMoney(entry.closingBalance.baseAmount);
      current.closingMl = roundMoney(entry.closingBalance.calculatedAmount);
      current.doNameId = entry.doNameId ?? current.doNameId;
      current.doLineId = entry.doLineId ?? current.doLineId;
      current.doName = entry.doName || current.doName;
      current.doLine = entry.doLine || current.doLine;
      current.doLineSortOrder = entry.doLineSortOrder ?? current.doLineSortOrder;
      current.activeDays += 1;
      doMap.set(key, current);
    }
  }

  const enteredDays = new Set(sortedDays.map((day) => day.dayNo));
  return {
    monthId,
    totalOpeningBase: roundMoney(sortedDays[0]?.summary.openingBase ?? 0),
    totalIssuanceBase: sum(sortedDays.map((day) => day.summary.issuanceBase)),
    totalIssuanceMl: sum(sortedDays.map((day) => day.summary.issuanceMl)),
    totalPaymentsBase: sum(sortedDays.map((day) => day.summary.paymentBase)),
    totalPaymentsMl: sum(sortedDays.map((day) => day.summary.paymentMl)),
    totalClosingBase: roundMoney(sortedDays.at(-1)?.summary.closingBase ?? 0),
    totalClosingMl: roundMoney(sortedDays.at(-1)?.summary.closingMl ?? 0),
    totalLifting: sum(sortedDays.map((day) => day.lifting.mlLifting)),
    latestInHandBalance: roundMoney(sortedDays.at(-1)?.lifting.inHandBalance ?? 0),
    totalCommission: sum(sortedDays.map((day) => day.summary.totalCommission)),
    dayRows: sortedDays.map((day) => ({
      dayNo: day.dayNo,
      issuanceBase: day.summary.issuanceBase,
      issuanceMl: day.summary.issuanceMl,
      paymentBase: day.summary.paymentBase,
      paymentMl: day.summary.paymentMl,
      closingBase: day.summary.closingBase,
      lifting: day.lifting.mlLifting,
      inHandBalance: day.lifting.inHandBalance,
      commission1: day.summary.commission1,
      commission2: day.summary.commission2,
      commission: day.summary.totalCommission
    })),
    doBalances: [...doMap.values()].sort((a, b) => {
      const orderA = a.doLineSortOrder ?? Number.POSITIVE_INFINITY;
      const orderB = b.doLineSortOrder ?? Number.POSITIVE_INFINITY;
      if (orderA !== orderB) return orderA - orderB;
      const lineOrder = (a.doLine ?? a.doName).localeCompare(b.doLine ?? b.doName, undefined, {
        numeric: true,
        sensitivity: "base"
      });
      if (lineOrder !== 0) return lineOrder;
      return a.doName.localeCompare(b.doName, undefined, { numeric: true, sensitivity: "base" });
    }),
    missingDays: Array.from({ length: daysInMonth(monthId) }, (_, index) => index + 1).filter((dayNo) => !enteredDays.has(dayNo)),
    updatedAt: Date.now()
  };
}

export function previousEntryForDraftAcrossDays(
  days: JazzLoadDay[],
  selectedDay: number,
  draft: Pick<JazzLoadDoEntryDraft, "doProfileId" | "doNameId" | "doName" | "doLineId" | "doLine">
) {
  for (let dayNo = selectedDay - 1; dayNo >= 1; dayNo -= 1) {
    const day = days.find((item) => item.dayNo === dayNo);
    if (!day) continue;

    const exactNameMatch = day.doEntries.find((entry) => {
      if (draft.doNameId && entry.doNameId === draft.doNameId) return true;
      if (draft.doName && normalizeDoKey(entry.doName) === normalizeDoKey(draft.doName)) return true;
      if (draft.doProfileId && entry.doProfileId === draft.doProfileId) return true;
      return false;
    });
    if (exactNameMatch) return exactNameMatch;

    const lineMatch = day.doEntries.find((entry) => {
      if (draft.doLineId && entry.doLineId === draft.doLineId) return true;
      if (draft.doLine && normalizeDoKey(entry.doLine ?? "") === normalizeDoKey(draft.doLine)) return true;
      return false;
    });
    if (lineMatch) return lineMatch;
  }
  return undefined;
}

export function latestEntryForDraft(
  days: JazzLoadDay[],
  draft: Pick<JazzLoadDoEntryDraft, "doProfileId" | "doNameId" | "doName" | "doLineId" | "doLine">
) {
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    const match = day.doEntries.find((entry) => {
      if (draft.doNameId && entry.doNameId === draft.doNameId) return true;
      if (draft.doName && normalizeDoKey(entry.doName) === normalizeDoKey(draft.doName)) return true;
      if (draft.doProfileId && entry.doProfileId === draft.doProfileId) return true;
      if (draft.doLineId && entry.doLineId === draft.doLineId) return true;
      if (draft.doLine && normalizeDoKey(entry.doLine ?? "") === normalizeDoKey(draft.doLine)) return true;
      return false;
    });
    if (match) return match;
  }
  return undefined;
}

export function previousEntryForDraft(
  previousDay: JazzLoadDay | undefined,
  draft: JazzLoadDoEntryDraft
) {
  if (!previousDay) return undefined;
  return previousDay.doEntries.find((entry) => {
    if (draft.doProfileId && entry.doProfileId === draft.doProfileId) return true;
    if (draft.doLineId && entry.doLineId === draft.doLineId) return true;
    return normalizeDoKey(entry.doName, entry.doLine) === normalizeDoKey(draft.doName, draft.doLine);
  });
}

export function validateJazzLoadDrafts(
  drafts: JazzLoadDoEntryDraft[],
  activeRates: ActiveJazzLoadRates
): ValidationResult {
  const errors: string[] = [];
  if (!activeRates.mlRate?.active) errors.push("No active Jazz Load Addition Rate configured.");
  if (!activeRates.commission1Rate?.active) errors.push("No active Commission 1 Adjustment Rate configured.");
  if (!activeRates.commission2Rate?.active) errors.push("No active Commission 2 Payment Rate configured.");
  const seen = new Set<string>();
  const seenNames = new Set<string>();
  for (const draft of drafts) {
    const label = draft.doName || draft.doLine || "DO row";
    if (!draft.doName.trim()) errors.push(`Missing DO assignment${draft.doLine ? ` for ${draft.doLine}` : ""}.`);
    const key = draft.doLineId ?? draft.doProfileId ?? normalizeDoKey(draft.doName, draft.doLine);
    if (seen.has(key)) errors.push(`Duplicate DO entry: ${label}.`);
    seen.add(key);
    const nameKey = doNameIdentityKey(draft);
    if (nameKey) {
      if (seenNames.has(nameKey)) errors.push(`Duplicate DO name assignment: ${label}.`);
      seenNames.add(nameKey);
    }
    for (const [field, value] of [
      ["opening", draft.openingBase ?? 0],
      ["issuance", draft.todayMlIssuanceBase],
      ["payment", draft.paymentReceivedBase]
    ] as const) {
      if (!Number.isFinite(value)) errors.push(`${label} ${field} must be a valid number.`);
      if (field !== "opening" && value < 0) errors.push(`${label} ${field} cannot be negative.`);
    }
  }
  return { valid: errors.length === 0, errors };
}
