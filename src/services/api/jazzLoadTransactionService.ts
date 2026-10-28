/**
 * Phase 8B: Jazz Load Transaction Synchronization Service
 *
 * Synchronizes Jazz Load lifting, DO entries, and company payments with PostgreSQL REST APIs:
 * - Jazz Lifting (`/api/v1/transactions/jazz-load/lifting`)
 * - Jazz DO Entries (`/api/v1/transactions/jazz-load/do`)
 * - Jazz Company Payments (`/api/v1/transactions/jazz-company/payments`)
 *
 * Fetches updated server-authoritative projections upon completion.
 * NEVER writes to Firestore.
 */

import type {
  JazzLoadDay,
  JazzLoadDoProfile,
  JazzLoadDoEntry,
  JazzLoadRateConfig,
  JazzLoadCalculationRates
} from "../../modules/jazzLoad/types/jazzLoad.types";
import {
  calculateAmountWithRate,
  calculateDailyLifting,
  calculateDailySummary,
  snapshotResolvedRates
} from "../../modules/jazzLoad/services/jazzLoadCalculations";
import { dayDate, roundMoney } from "../../modules/jazzLoad/utils/jazzLoadFormatters";
import { ledgerApiClient, type DayProjectionsResponse } from "./ledgerApiClient";
import { getAccountingPeriodWithDays, resolveAccountingDayId } from "./periodDayService";

export interface SaveJazzLoadDayResult {
  success: boolean;
  dayId: string;
  projections: DayProjectionsResponse["projections"] | null;
  message: string;
}

export async function saveJazzLoadDayPostgres(
  periodKey: string,
  day: JazzLoadDay,
  doProfiles: JazzLoadDoProfile[]
): Promise<SaveJazzLoadDayResult> {
  const dayId = await resolveAccountingDayId(periodKey, day.dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${day.dayNo} not found for period ${periodKey}.`);
  }

  // 1. Sync Lifting
  const mlLifting = Number(day.lifting?.mlLifting ?? 0);
  const existingLiftingRes = await ledgerApiClient.jazzLifting.list(dayId);
  const existingLiftingList = existingLiftingRes.data || [];
  const existingLifting = existingLiftingList[0];

  if (mlLifting > 0) {
    if (existingLifting) {
      if (Number(existingLifting.ml_lifting_amount) !== mlLifting) {
        await ledgerApiClient.jazzLifting.update(existingLifting.id, {
          ml_lifting_amount: mlLifting
        });
      }
    } else {
      await ledgerApiClient.jazzLifting.create({
        day_id: dayId,
        ml_lifting_amount: mlLifting
      });
    }
  } else if (existingLifting) {
    await ledgerApiClient.jazzLifting.delete(existingLifting.id);
  }

  // 2. Sync DO Entries
  const existingDoRes = await ledgerApiClient.jazzDo.list(dayId);
  const existingDoList = existingDoRes.data || [];
  const existingDoMap = new Map(existingDoList.map((entry: any) => [entry.do_profile_id, entry]));

  const currentProfileIds = new Set<string>();
  for (const entry of day.doEntries || []) {
    // Resolve DO profile ID
    let profileId = entry.doProfileId;
    if (!profileId) {
      const matchedProfile = doProfiles.find((p) => p.name === entry.doName);
      profileId = matchedProfile?.id;
    }
    if (!profileId) continue;

    const issuanceBase = Number(entry.todayMlIssuance?.baseAmount ?? (entry as any).todayMlIssuanceBase ?? 0);
    const paymentBase = Number(entry.paymentReceived?.baseAmount ?? (entry as any).paymentReceivedBase ?? 0);
    if (issuanceBase === 0 && paymentBase === 0) continue;

    currentProfileIds.add(profileId);
    const existing = existingDoMap.get(profileId);

    if (existing) {
      const changed =
        Number(existing.issuance_base) !== issuanceBase ||
        Number(existing.payment_base) !== paymentBase;

      if (changed) {
        await ledgerApiClient.jazzDo.update(existing.id, {
          baseRevision: existing.revision ?? 1,
          do_profile_id: profileId,
          issuance_base: issuanceBase,
          payment_base: paymentBase
        });
      }
    } else {
      await ledgerApiClient.jazzDo.create({
        day_id: dayId,
        do_profile_id: profileId,
        issuance_base: issuanceBase,
        payment_base: paymentBase
      });
    }
  }

  // Delete removed DO entries
  for (const existing of existingDoList) {
    if (!currentProfileIds.has(existing.do_profile_id)) {
      await ledgerApiClient.jazzDo.delete(existing.id);
    }
  }

  // 3. Fetch latest server projections
  let projections: DayProjectionsResponse["projections"] | null = null;
  try {
    const projResponse = await ledgerApiClient.calculations.getDayProjections(dayId);
    projections = (projResponse as any)?.data?.projections ?? projResponse?.projections ?? null;
  } catch (err) {
    console.warn(`[jazzLoadTransactionService] Could not fetch projections for ${dayId}:`, err);
  }

  return {
    success: true,
    dayId,
    projections,
    message: `Jazz Load transactions for day ${day.dayNo} saved to PostgreSQL successfully.`
  };
}

export interface JazzCompanyPaymentInput {
  amount: number;
  paymentReference?: string | null;
  notes?: string | null;
  clientMutationId?: string;
}

export async function recordJazzCompanyPaymentPostgres(
  periodKey: string,
  dayNo: number,
  input: JazzCompanyPaymentInput
) {
  const dayId = await resolveAccountingDayId(periodKey, dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${dayNo} not found for period ${periodKey}.`);
  }
  const mutationId = input.clientMutationId ?? crypto.randomUUID();
  return ledgerApiClient.jazzCompanyPayments.create(
    {
      client_mutation_id: mutationId,
      day_id: dayId,
      amount: input.amount,
      payment_reference: input.paymentReference ?? null,
      notes: input.notes ?? null
    },
    mutationId
  );
}

export async function updateJazzCompanyPaymentPostgres(
  paymentId: string,
  baseRevision: number,
  input: {
    amount?: number;
    paymentReference?: string | null;
    notes?: string | null;
  }
) {
  return ledgerApiClient.jazzCompanyPayments.update(paymentId, {
    baseRevision,
    amount: input.amount,
    payment_reference: input.paymentReference ?? null,
    notes: input.notes ?? null
  });
}

export async function deleteJazzCompanyPaymentPostgres(paymentId: string) {
  return ledgerApiClient.jazzCompanyPayments.delete(paymentId);
}

export async function listJazzCompanyPaymentsPostgres(
  periodKey: string,
  dayNo: number
) {
  const dayId = await resolveAccountingDayId(periodKey, dayNo);
  if (!dayId) {
    throw new Error(`Accounting day ${dayNo} not found for period ${periodKey}.`);
  }
  return ledgerApiClient.jazzCompanyPayments.list(dayId);
}

function activeRatesFromConfig(rates?: JazzLoadRateConfig[]): JazzLoadCalculationRates {
  const ml = rates?.find((r) => r.type === "ml_addition" && r.active);
  const c1 = rates?.find((r) => r.type === "commission1_adjustment" && r.active);
  const c2 = rates?.find((r) => r.type === "commission2_payment" && r.active);
  return {
    mlRate: ml
      ? { id: ml.id, name: ml.name || "ML Rate", type: "ml_addition", percentage: ml.percentage, active: true }
      : { id: "default_ml", name: "Default ML", type: "ml_addition", percentage: 2.4, active: true },
    commission1Rate: c1
      ? { id: c1.id, name: c1.name || "Comm1 Rate", type: "commission1_adjustment", percentage: c1.percentage, active: true }
      : null,
    commission2Rate: c2
      ? { id: c2.id, name: c2.name || "Comm2 Rate", type: "commission2_payment", percentage: c2.percentage, active: true }
      : null
  };
}

export async function loadJazzLoadDayPostgres(
  periodKey: string,
  dayNo: number,
  doProfiles: JazzLoadDoProfile[] = [],
  rates?: JazzLoadRateConfig[],
  cachedPeriodData?: any
): Promise<JazzLoadDay | null> {
  const periodData = cachedPeriodData ?? (await getAccountingPeriodWithDays(periodKey).catch(() => null));
  const dayRec = periodData?.days?.get(dayNo);
  const dayId = dayRec?.id ?? (await resolveAccountingDayId(periodKey, dayNo));
  if (!dayId) return null;

  const [doRes, liftingRes, projRes] = await Promise.all([
    ledgerApiClient.jazzDo.list(dayId).catch(() => ({ data: [] })),
    ledgerApiClient.jazzLifting.list(dayId).catch(() => ({ data: [] })),
    ledgerApiClient.calculations.getDayProjections(dayId).catch(() => ({ projections: null }))
  ]);

  const status = (dayRec?.status ?? "closed") as JazzLoadDay["status"];
  const isClosed = status === "closed";
  const closedTimestamp = isClosed && dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : undefined;
  const reopenedTimestamp = dayRec?.reopened_at ? new Date(dayRec.reopened_at).getTime() : undefined;

  const calcRates = activeRatesFromConfig(rates);
  const mlRate = calcRates.mlRate!;

  const dayProjections = (projRes as any)?.data?.projections ?? (projRes as any)?.projections ?? null;

  const processedProfileIds = new Set<string>();
  const doEntries: JazzLoadDoEntry[] = (doRes.data || []).map((entry: any) => {
    processedProfileIds.add(entry.do_profile_id);
    const profile = doProfiles.find((p) => p.id === entry.do_profile_id);
    const issuanceBase = Number(entry.issuance_base ?? 0);
    const paymentBase = Number(entry.payment_base ?? 0);
    const appliedRatePercentage = Number(entry.applied_ml_rate_percentage ?? mlRate.percentage);
    const rateConfig = { ...mlRate, percentage: appliedRatePercentage };

    const proj = dayProjections?.jazzDo?.find((p: any) => p.do_profile_id === entry.do_profile_id);
    const openingBase = Number((proj as any)?.opening_base ?? (proj as any)?.opening_balance_base ?? 0);
    const dayTotalBase = roundMoney(openingBase + issuanceBase);
    const closingBase = roundMoney(dayTotalBase - paymentBase);

    return {
      id: entry.id,
      doProfileId: entry.do_profile_id,
      doNameId: entry.do_profile_id,
      doLineId: entry.do_profile_id,
      doName: entry.do_name_snapshot || profile?.name || "",
      doLine: entry.do_line_snapshot || profile?.line || "",
      doLineSortOrder: (profile as any)?.sortOrder ?? (profile as any)?.sort_order,
      openingBalance: calculateAmountWithRate(openingBase, rateConfig),
      todayMlIssuance: calculateAmountWithRate(issuanceBase, rateConfig),
      dayTotal: calculateAmountWithRate(dayTotalBase, rateConfig),
      paymentReceived: calculateAmountWithRate(paymentBase, rateConfig),
      closingBalance: calculateAmountWithRate(closingBase, rateConfig),
      notes: entry.notes || undefined,
      createdBy: entry.created_by_user_id || "system",
      createdAt: entry.created_at ? new Date(entry.created_at).getTime() : Date.now(),
      updatedAt: entry.updated_at ? new Date(entry.updated_at).getTime() : Date.now()
    };
  });

  for (const profile of doProfiles) {
    if (!processedProfileIds.has(profile.id)) {
      processedProfileIds.add(profile.id);
      const proj = dayProjections?.jazzDo?.find((p: any) => p.do_profile_id === profile.id);
      const openingBase = Number((proj as any)?.opening_base ?? (proj as any)?.opening_balance_base ?? 0);
      const rateConfig = mlRate;

      doEntries.push({
        id: `${dayId}-${profile.id}`,
        doProfileId: profile.id,
        doNameId: profile.id,
        doLineId: profile.id,
        doName: profile.name,
        doLine: profile.line,
        doLineSortOrder: (profile as any)?.sortOrder ?? (profile as any)?.sort_order,
        openingBalance: calculateAmountWithRate(openingBase, rateConfig),
        todayMlIssuance: calculateAmountWithRate(0, rateConfig),
        dayTotal: calculateAmountWithRate(openingBase, rateConfig),
        paymentReceived: calculateAmountWithRate(0, rateConfig),
        closingBalance: calculateAmountWithRate(openingBase, rateConfig),
        createdBy: "system",
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
  }

  const existingLifting = (liftingRes.data || [])[0];
  const mlLifting = Number(existingLifting?.ml_lifting_amount ?? 0);
  const openingLifting = Number(
    (dayProjections?.jazzLifting as any)?.opening_lifting ??
    (dayProjections?.jazzLifting as any)?.opening_balance ??
    0
  );
  const totalMlIssuance = doEntries.reduce((sum, e) => sum + e.todayMlIssuance.calculatedAmount, 0);
  const lifting = calculateDailyLifting({ openingBalance: openingLifting, mlLifting }, totalMlIssuance);

  const summary = calculateDailySummary({ doEntries }, calcRates);

  let latestUpdated = dayRec?.closed_at
    ? new Date(dayRec.closed_at).getTime()
    : Date.now();

  const txTimestamps = [
    ...(doRes.data || []),
    ...(liftingRes.data || [])
  ]
    .map((t: any) => (t.updated_at ? new Date(t.updated_at).getTime() : 0))
    .filter((ts) => ts > 0);

  if (txTimestamps.length > 0) {
    latestUpdated = Math.max(latestUpdated, ...txTimestamps);
  }

  return {
    id: `${periodKey}-${String(dayNo).padStart(2, "0")}`,
    monthId: periodKey,
    dayNo,
    date: dayDate(periodKey, dayNo),
    status,
    manualOverride: isClosed,
    doEntries,
    lifting,
    summary,
    appliedRates: snapshotResolvedRates(calcRates, latestUpdated),
    notes: dayRec?.notes || undefined,
    createdBy: "system",
    createdAt: dayRec?.closed_at ? new Date(dayRec.closed_at).getTime() : Date.now(),
    updatedAt: latestUpdated,
    closedAt: closedTimestamp,
    lockedAt: isClosed ? (closedTimestamp ?? Date.now()) : undefined,
    reopenedAt: reopenedTimestamp
  };
}

export async function loadJazzLoadMonthPostgres(
  periodKey: string,
  doProfiles: JazzLoadDoProfile[] = [],
  rates?: JazzLoadRateConfig[]
): Promise<JazzLoadDay[]> {
  const periodData = await getAccountingPeriodWithDays(periodKey).catch(() => null);
  if (!periodData) return [];
  const dayCount = periodData.days?.size || new Date(Number(periodKey.split("-")[0]), Number(periodKey.split("-")[1]), 0).getDate();
  const dayPromises: Promise<JazzLoadDay | null>[] = [];
  for (let d = 1; d <= dayCount; d++) {
    dayPromises.push(
      loadJazzLoadDayPostgres(periodKey, d, doProfiles, rates, periodData).catch((err) => {
        console.warn(`[jazzLoadTransactionService] Failed to load day ${d} for month ${periodKey}:`, err);
        return null;
      })
    );
  }
  const loadedDays = await Promise.all(dayPromises);
  return loadedDays.filter((d): d is JazzLoadDay => Boolean(d)).sort((a, b) => a.dayNo - b.dayNo);
}


