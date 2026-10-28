/**
 * Phase 8B / Phase 13: Period and Day Lookup Service
 *
 * Provides resolution between monthId (e.g. "2026-09"), dayNo (e.g. 1),
 * and the PostgreSQL accounting_period / accounting_day UUIDs.
 * 
 * Accurately distinguishes between:
 * - INITIALIZED (period and days exist in PostgreSQL)
 * - UNINITIALIZED (API succeeded, but period is genuinely not in PostgreSQL)
 * - AUTH_REQUIRED (401 Unauthorized / missing session)
 * - UNAUTHORIZED (403 Forbidden / insufficient role)
 * - SERVER_ERROR (500 Internal error)
 * - NETWORK_ERROR (backend unreachable / offline)
 */

import { ledgerApiClient, ApiError, type AccountingDayRecord, type AccountingPeriodRecord } from "./ledgerApiClient";
import { getMetadataCache } from "../offlineQueue/metadataCache";

interface PeriodCacheEntry {
  period: AccountingPeriodRecord;
  days: Map<number, AccountingDayRecord>;
  fetchedAt: number;
}

const periodCache = new Map<string, PeriodCacheEntry>();
const inFlightRequests = new Map<string, Promise<PeriodLookupResult>>();
const CACHE_TTL_MS = 60_000; // 1 minute TTL

export type PeriodRoutingStatus =
  | "INITIALIZED"
  | "UNINITIALIZED"
  | "AUTH_REQUIRED"
  | "UNAUTHORIZED"
  | "SERVER_ERROR"
  | "NETWORK_ERROR";

export interface PeriodLookupResult {
  entry: PeriodCacheEntry | null;
  error?: Error | null;
  status: PeriodRoutingStatus;
}

export function clearPeriodCache(): void {
  periodCache.clear();
  inFlightRequests.clear();
}

export async function getAccountingPeriodWithDaysWithStatus(
  periodKey: string,
  forceRefresh = false
): Promise<PeriodLookupResult> {
  const cached = periodCache.get(periodKey);
  const now = Date.now();
  if (!forceRefresh && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return { entry: cached, status: "INITIALIZED" };
  }

  if (!forceRefresh && inFlightRequests.has(periodKey)) {
    return inFlightRequests.get(periodKey)!;
  }

  const fetchPromise = (async (): Promise<PeriodLookupResult> => {
    try {
      const listRes = await ledgerApiClient.periods.list();
      for (const p of listRes.periods || []) {
        registerInitializedPeriod(p.period_key);
        registerPostgreSqlPeriod(p.period_key);
      }
      const targetPeriod = listRes.periods.find((p) => p.period_key === periodKey);
      if (!targetPeriod) {
        return { entry: null, status: "UNINITIALIZED" };
      }

      const details = await ledgerApiClient.periods.get(targetPeriod.id);
      const dayMap = new Map<number, AccountingDayRecord>();
      for (const d of details.days) {
        dayMap.set(d.day_no, d);
      }

      const entry: PeriodCacheEntry = {
        period: details.period,
        days: dayMap,
        fetchedAt: now
      };
      periodCache.set(periodKey, entry);

      // Asynchronously update durable metadata cache
      try {
        const daysRecord: Record<number, any> = {};
        for (const d of details.days) {
          daysRecord[d.day_no] = d;
        }
        void getMetadataCache().setPeriodMetadata({
          periodKey,
          period: details.period,
          days: daysRecord,
          cachedAt: now
        }).catch(() => {});
      } catch {
        // Non-blocking metadata caching
      }

      return { entry, status: "INITIALIZED" };
    } catch (err) {
      // Offline Fallback: Attempt to resolve period and days from durable metadata cache
      try {
        const cachedMetadata = await getMetadataCache().getPeriodMetadata(periodKey);
        if (cachedMetadata) {
          const dayMap = new Map<number, AccountingDayRecord>();
          for (const [dayNoStr, day] of Object.entries(cachedMetadata.days)) {
            dayMap.set(Number(dayNoStr), day as unknown as AccountingDayRecord);
          }
          const fallbackEntry: PeriodCacheEntry = {
            period: cachedMetadata.period,
            days: dayMap,
            fetchedAt: cachedMetadata.cachedAt
          };
          periodCache.set(periodKey, fallbackEntry);
          return { entry: fallbackEntry, status: "INITIALIZED" };
        }
      } catch (cacheErr) {
        console.warn(`[periodDayService] Failed to read metadata cache for ${periodKey}:`, cacheErr);
      }

      console.warn(`[periodDayService] Failed to load period ${periodKey}:`, err);

      let status: PeriodRoutingStatus = "NETWORK_ERROR";
      if (err instanceof ApiError) {
        if (err.status === 401) status = "AUTH_REQUIRED";
        else if (err.status === 403) status = "UNAUTHORIZED";
        else if (err.status >= 500) status = "SERVER_ERROR";
      }

      return {
        entry: null,
        error: err instanceof Error ? err : new Error(String(err)),
        status
      };
    } finally {
      inFlightRequests.delete(periodKey);
    }
  })();

  inFlightRequests.set(periodKey, fetchPromise);
  return fetchPromise;
}

export async function getAccountingPeriodWithDays(
  periodKey: string,
  forceRefresh = false
): Promise<PeriodCacheEntry | null> {
  const result = await getAccountingPeriodWithDaysWithStatus(periodKey, forceRefresh);
  return result.entry;
}

export async function resolveAccountingDay(
  periodKey: string,
  dayNo: number
): Promise<AccountingDayRecord | null> {
  const periodData = await getAccountingPeriodWithDays(periodKey);
  if (!periodData) return null;
  return periodData.days.get(dayNo) ?? null;
}

export async function resolveAccountingDayId(
  periodKey: string,
  dayNo: number
): Promise<string | null> {
  const day = await resolveAccountingDay(periodKey, dayNo);
  return day ? day.id : null;
}

export const POSTGRESQL_GENESIS_PERIOD = "2026-08";

export function isGenesisPeriod(periodKey: string): boolean {
  return periodKey === POSTGRESQL_GENESIS_PERIOD;
}

/**
 * Genesis Boundary Rule:
 * For the genesis period (2026-08), previousPeriod = null (NONE).
 * Normal rollover rule begins only for periods after the genesis period:
 * 2026-08 close -> 2026-09
 * 2026-09 close -> 2026-10
 */
export function getPreviousPeriodKey(periodKey: string): string | null {
  if (isGenesisPeriod(periodKey) || periodKey < POSTGRESQL_GENESIS_PERIOD) {
    return null;
  }
  const [yearText, monthText] = periodKey.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return null;
  }
  const prevMonth = month === 1 ? 12 : month - 1;
  const prevYear = month === 1 ? year - 1 : year;
  const prevKey = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
  return prevKey >= POSTGRESQL_GENESIS_PERIOD ? prevKey : null;
}

const knownPostgreSqlPeriods = new Set<string>(["2026-08"]);
const initializedPgPeriods = new Set<string>(["2026-08"]);

export function isPeriodKnownInitialized(periodKey: string): boolean {
  if (initializedPgPeriods.has(periodKey)) return true;
  return isPostgreSqlPeriod(periodKey);
}

export function registerInitializedPeriod(periodKey: string): void {
  initializedPgPeriods.add(periodKey);
}

export function registerPostgreSqlPeriod(periodKey: string): void {
  knownPostgreSqlPeriods.add(periodKey);
}

export function isPostgreSqlPeriod(periodKey: string): boolean {
  if (knownPostgreSqlPeriods.has(periodKey)) return true;
  if (/^\d{4}-\d{2}$/.test(periodKey)) {
    return periodKey >= "2026-08";
  }
  return false;
}

export async function resolvePeriodRouting(periodKey: string): Promise<{
  isPostgreSql: boolean;
  status: PeriodRoutingStatus;
  period: AccountingPeriodRecord | null;
  error?: Error | null;
}> {
  const isPg = isPostgreSqlPeriod(periodKey);
  if (!isPg) {
    return {
      isPostgreSql: false,
      status: "UNINITIALIZED",
      period: null
    };
  }

  const lookup = await getAccountingPeriodWithDaysWithStatus(periodKey);
  if (!lookup.entry) {
    return {
      isPostgreSql: true,
      status: lookup.status,
      period: null,
      error: lookup.error
    };
  }

  registerPostgreSqlPeriod(periodKey);
  registerInitializedPeriod(periodKey);
  return {
    isPostgreSql: true,
    status: "INITIALIZED",
    period: lookup.entry.period
  };
}

export function getNextPeriodKey(currentPeriodKey: string): { nextPeriodKey: string; daysInNextMonth: number } {
  const parts = currentPeriodKey.split("-");
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);

  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 12) {
    nextMonth = 1;
    nextYear += 1;
  }

  const nextPeriodKey = `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
  const daysInNextMonth = new Date(nextYear, nextMonth, 0).getDate();

  return { nextPeriodKey, daysInNextMonth };
}
