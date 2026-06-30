import type {
  ActiveJazzLoadRates,
  JazzLoadAppliedRateSnapshot,
  JazzLoadAppliedRates,
  JazzLoadCalculationRate,
  JazzLoadCalculationRates,
  CalculatedMoney,
  JazzLoadCommissionResult,
  JazzLoadCommissionRule,
  JazzLoadDailyLifting,
  JazzLoadDailyLiftingInput,
  JazzLoadDailySummary,
  JazzLoadDay,
  JazzLoadDoLineBinding,
  JazzLoadDoEntry,
  JazzLoadDoEntryDraft,
  JazzLoadMonthlySummary,
  JazzLoadRateConfig,
  JazzLoadRateSnapshotSource,
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

function rateId(rate: JazzLoadCalculationRate) {
  return rate.rateId ?? rate.id ?? "";
}

function rateName(rate: JazzLoadCalculationRate) {
  return rate.rateName ?? rate.name ?? "";
}

function rateType(rate: JazzLoadCalculationRate, fallback: JazzLoadRateConfig["type"]) {
  return rate.rateType ?? rate.type ?? fallback;
}

export function hasUsableJazzLoadRate(rate: JazzLoadCalculationRate | null | undefined): rate is JazzLoadCalculationRate {
  return Boolean(rate && rate.active !== false && Number.isFinite(rate.percentage));
}

function normalizeRateSnapshot(
  rate: JazzLoadCalculationRate | null | undefined,
  fallbackType: JazzLoadRateConfig["type"],
  fallbackAppliedAt = Date.now()
): JazzLoadAppliedRateSnapshot | undefined {
  if (!hasUsableJazzLoadRate(rate)) return undefined;
  return {
    rateId: rateId(rate),
    rateName: rateName(rate),
    rateType: rateType(rate, fallbackType),
    percentage: rate.percentage,
    appliedAt: rate.appliedAt ?? fallbackAppliedAt
  };
}

function snapshotFromCalculatedMoney(
  money: CalculatedMoney | undefined,
  fallbackType: JazzLoadRateConfig["type"]
): JazzLoadAppliedRateSnapshot | undefined {
  if (!money || !Number.isFinite(money.appliedRatePercentage)) return undefined;
  return {
    rateId: money.appliedRateId,
    rateName: money.appliedRateName,
    rateType: fallbackType,
    percentage: money.appliedRatePercentage,
    appliedAt: money.calculatedAt
  };
}

function legacyMlRateFromRows(dayRecord: Pick<JazzLoadDay, "doEntries"> | null | undefined) {
  const moneyFields = ["todayMlIssuance", "paymentReceived", "openingBalance", "closingBalance", "dayTotal"] as const;
  for (const entry of dayRecord?.doEntries ?? []) {
    for (const field of moneyFields) {
      const snapshot = snapshotFromCalculatedMoney(entry[field], "ml_addition");
      if (snapshot) return snapshot;
    }
  }
  return undefined;
}

function activeRateSnapshot(
  activeRates: ActiveJazzLoadRates,
  key: keyof ActiveJazzLoadRates,
  fallbackType: JazzLoadRateConfig["type"],
  warnings: string[],
  resolvedAt: number
) {
  const snapshot = normalizeRateSnapshot(activeRates[key] as JazzLoadCalculationRate | null, fallbackType, resolvedAt);
  if (!snapshot) warnings.push(`No historical ${fallbackType} snapshot was found; active settings fallback was unavailable.`);
  return snapshot;
}

function completeRates(rates: JazzLoadCalculationRates) {
  return hasUsableJazzLoadRate(rates.mlRate) &&
    hasUsableJazzLoadRate(rates.commission1Rate) &&
    hasUsableJazzLoadRate(rates.commission2Rate);
}

function bindingDateValue(monthId: string, dayNo: number) {
  const [yearText, monthText] = monthId.split("-");
  return (Number(yearText) || 0) * 10000 + (Number(monthText) || 0) * 100 + dayNo;
}

export function resolveDoLineBindingForDate(
  bindings: JazzLoadDoLineBinding[],
  doLineId: string | undefined,
  monthId: string,
  dayNo: number
) {
  if (!doLineId) return undefined;
  const selected = bindingDateValue(monthId, dayNo);
  return bindings
    .filter((binding) => binding.doLineId === doLineId)
    .filter((binding) => bindingDateValue(binding.effectiveFromMonthId, binding.effectiveFromDay) <= selected)
    .sort((left, right) =>
      bindingDateValue(right.effectiveFromMonthId, right.effectiveFromDay) -
      bindingDateValue(left.effectiveFromMonthId, left.effectiveFromDay)
    )[0];
}

export function snapshotResolvedRates(
  rates: JazzLoadCalculationRates,
  appliedAt = Date.now()
): JazzLoadAppliedRates {
  return {
    mlRate: normalizeRateSnapshot(rates.mlRate, "ml_addition", appliedAt),
    commission1Rate: normalizeRateSnapshot(rates.commission1Rate, "commission1_adjustment", appliedAt),
    commission2Rate: normalizeRateSnapshot(rates.commission2Rate, "commission2_payment", appliedAt)
  };
}

export function resolveJazzLoadRatesForDay(params: {
  dayRecord?: JazzLoadDay | null;
  activeRates: ActiveJazzLoadRates;
  mode: "new-day" | "existing-day" | "master-refresh";
  resolvedAt?: number;
}): {
  rates: JazzLoadCalculationRates;
  source: JazzLoadRateSnapshotSource;
  warnings: string[];
} {
  const { dayRecord, activeRates, mode } = params;
  const resolvedAt = params.resolvedAt ?? Date.now();
  const warnings: string[] = [];
  const activeSettingsRates = (): JazzLoadCalculationRates => ({
    mlRate: activeRateSnapshot(activeRates, "mlRate", "ml_addition", warnings, resolvedAt) ?? null,
    commission1Rate: activeRateSnapshot(activeRates, "commission1Rate", "commission1_adjustment", warnings, resolvedAt) ?? null,
    commission2Rate: activeRateSnapshot(activeRates, "commission2Rate", "commission2_payment", warnings, resolvedAt) ?? null
  });

  if (mode === "new-day" || !dayRecord) {
    return { rates: activeSettingsRates(), source: "active-settings", warnings };
  }

  const savedDayRates: JazzLoadCalculationRates = {
    mlRate: normalizeRateSnapshot(dayRecord.appliedRates?.mlRate, "ml_addition", resolvedAt) ?? null,
    commission1Rate: normalizeRateSnapshot(dayRecord.appliedRates?.commission1Rate, "commission1_adjustment", resolvedAt) ?? null,
    commission2Rate: normalizeRateSnapshot(dayRecord.appliedRates?.commission2Rate, "commission2_payment", resolvedAt) ?? null
  };
  if (completeRates(savedDayRates)) {
    return { rates: savedDayRates, source: "saved-day", warnings };
  }

  const legacyRowMlRate = legacyMlRateFromRows(dayRecord);
  const summaryCommission1Rate = normalizeRateSnapshot(dayRecord.summary?.commission1Rate, "commission1_adjustment", resolvedAt);
  const summaryCommission2Rate = normalizeRateSnapshot(dayRecord.summary?.commission2Rate, "commission2_payment", resolvedAt);
  const activeFallback = activeSettingsRates();
  const rates: JazzLoadCalculationRates = {
    mlRate: savedDayRates.mlRate ?? legacyRowMlRate ?? activeFallback.mlRate,
    commission1Rate: savedDayRates.commission1Rate ?? summaryCommission1Rate ?? activeFallback.commission1Rate,
    commission2Rate: savedDayRates.commission2Rate ?? summaryCommission2Rate ?? activeFallback.commission2Rate
  };

  if (legacyRowMlRate) {
    if (!savedDayRates.mlRate) warnings.push("Recovered Jazz Load ML rate from legacy row-level applied rate metadata.");
    return { rates, source: "legacy-row", warnings };
  }
  if (summaryCommission1Rate || summaryCommission2Rate) {
    warnings.push("Recovered Jazz Load commission rates from legacy daily summary metadata.");
    if (!savedDayRates.mlRate) warnings.push("No ML snapshot was found on this legacy day; active ML settings were used as fallback.");
    return { rates, source: "legacy-summary", warnings };
  }

  warnings.push("No Jazz Load rate snapshot was found for this saved day; active settings were used as fallback.");
  return { rates, source: "active-settings", warnings };
}

export function calculateAmountWithRate(
  baseAmount: number,
  rate: JazzLoadCalculationRate,
  calculatedAt = Date.now()
): CalculatedMoney {
  const base = roundMoney(baseAmount);
  return {
    baseAmount: base,
    calculatedAmount: roundMoney(base + (base * rate.percentage) / 100),
    appliedRateId: rateId(rate),
    appliedRateName: rateName(rate),
    appliedRatePercentage: rate.percentage,
    calculatedAt
  };
}

export function snapshotRate(rate: JazzLoadCalculationRate, appliedAt = Date.now()): JazzLoadAppliedRateSnapshot {
  const snapshot = normalizeRateSnapshot(rate, "custom", appliedAt);
  if (!snapshot) {
    return {
      rateId: rateId(rate),
      rateName: rateName(rate),
      rateType: rateType(rate, "custom"),
      percentage: 0,
      appliedAt
    };
  }
  return snapshot;
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
  activeRates: JazzLoadCalculationRates,
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
    bindingEffectiveFromMonthId: input.bindingEffectiveFromMonthId,
    bindingEffectiveFromDay: input.bindingEffectiveFromDay,
    bindingUpdatedAt: input.bindingUpdatedAt,
    bindingUpdatedBy: input.bindingUpdatedBy,
    bindingBackfillId: input.bindingBackfillId,
    bindingBackfillMode: input.bindingBackfillMode,
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
  activeRates: Pick<JazzLoadCalculationRates, "commission1Rate" | "commission2Rate">,
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
  activeRates?: Pick<JazzLoadCalculationRates, "commission1Rate" | "commission2Rate">,
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

type DailySummaryClosingSeed = Pick<JazzLoadDailySummary, "closingBase" | "closingMl">;

export function calculateChainedDailySummary(
  day: Pick<JazzLoadDay, "doEntries">,
  activeRates: Pick<JazzLoadCalculationRates, "commission1Rate" | "commission2Rate"> | undefined,
  appliedAt: number,
  previousClosing?: DailySummaryClosingSeed
): JazzLoadDailySummary {
  const summary = calculateDailySummary(day, activeRates, appliedAt);
  if (!previousClosing) return summary;

  const openingBase = roundMoney(previousClosing.closingBase);
  const openingMl = roundMoney(previousClosing.closingMl);
  const dayTotalBase = roundMoney(openingBase + summary.issuanceBase);
  const dayTotalMl = roundMoney(openingMl + summary.issuanceMl);

  return {
    ...summary,
    openingBase,
    openingMl,
    dayTotalBase,
    dayTotalMl,
    closingBase: roundMoney(dayTotalBase - summary.paymentBase),
    closingMl: roundMoney(dayTotalMl - summary.paymentMl)
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
  activeRates: JazzLoadCalculationRates
): ValidationResult {
  const errors: string[] = [];
  if (!hasUsableJazzLoadRate(activeRates.mlRate)) errors.push("No active Jazz Load Addition Rate configured.");
  if (!hasUsableJazzLoadRate(activeRates.commission1Rate)) errors.push("No active Commission 1 Adjustment Rate configured.");
  if (!hasUsableJazzLoadRate(activeRates.commission2Rate)) errors.push("No active Commission 2 Payment Rate configured.");
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
