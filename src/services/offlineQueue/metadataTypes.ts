/**
 * Phase 12B: Offline Metadata Cache Contracts
 *
 * Defines the storage contracts for caching read-only metadata in IndexedDB:
 * - Period and Day routing metadata
 * - Master catalogs (products, accounts, credit parties, categories, DO profiles)
 * - Materialized server day projections (READ-ONLY snapshot, never authoritative)
 * - Entity snapshots for revision tracking and read-back conflict detection
 */

import type { AccountingDayRecord, AccountingPeriodRecord, DayProjectionsResponse } from "../api/ledgerApiClient";

export interface CachedDayRecord {
  id: string; // accounting_day UUID
  dayNo: number;
  periodId: string;
  status: "open" | "closed" | "reopen";
  calendarDate: string;
  label: string;
}

export interface CachedPeriodMetadata {
  periodKey: string; // e.g. "2026-09"
  period: AccountingPeriodRecord;
  days: Record<number, CachedDayRecord>;
  cachedAt: number;
}

export type MasterCatalogType =
  | "expense_categories"
  | "credit_parties"
  | "stock_products"
  | "stock_accounts"
  | "jazz_do_profiles";

export interface CachedCatalogData<T = unknown> {
  key: string; // e.g. "7301:stock_products"
  franchiseId: string;
  catalogType: MasterCatalogType;
  items: T[];
  cachedAt: number;
}

export interface CachedDayProjections {
  key: string; // e.g. "7301:2026-09:1"
  franchiseId: string;
  periodKey: string;
  dayNo: number;
  dayId: string;
  projections: DayProjectionsResponse["projections"];
  cachedAt: number;
  /** Explicitly marks this as a read-only mirror of server-materialized projections */
  source: "server_authoritative_materialized";
}

export interface CachedEntitySnapshot {
  key: string; // e.g. "dayId:expense_item:entityId"
  franchiseId: string;
  dayId: string;
  entityType: string;
  entityId: string;
  /** Natural lookup key if applicable (e.g. itemName, accountId, doProfileId) */
  naturalKey?: string;
  revision: number;
  rawPayload: Record<string, unknown>;
  cachedAt: number;
}

export interface IMetadataCache {
  initialize(): Promise<void>;
  close(): Promise<void>;

  // Period / Day Resolution
  getPeriodMetadata(periodKey: string): Promise<CachedPeriodMetadata | null>;
  setPeriodMetadata(metadata: CachedPeriodMetadata): Promise<void>;

  // Master Catalogs
  getCatalog<T = unknown>(franchiseId: string, catalogType: MasterCatalogType): Promise<T[] | null>;
  setCatalog<T = unknown>(franchiseId: string, catalogType: MasterCatalogType, items: T[]): Promise<void>;

  // Day Projections (Read Cache Only)
  getDayProjections(franchiseId: string, periodKey: string, dayNo: number): Promise<CachedDayProjections | null>;
  setDayProjections(projections: CachedDayProjections): Promise<void>;

  // Entity Snapshots
  getEntitySnapshot(key: string): Promise<CachedEntitySnapshot | null>;
  setEntitySnapshot(snapshot: CachedEntitySnapshot): Promise<void>;
  listSnapshotsForDay(dayId: string, entityType?: string): Promise<CachedEntitySnapshot[]>;
  deleteEntitySnapshot(key: string): Promise<void>;

  clearAll(): Promise<void>;
}
