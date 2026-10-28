/**
 * Phase 12B: IndexedDB and Memory Metadata Cache Implementations
 *
 * Implements persistent storage of:
 * - Period and Day metadata (for offline dayId resolution)
 * - Master catalogs (products, accounts, DO profiles, categories)
 * - Projections cache (READ-ONLY mirror of server-materialized projections)
 * - Entity snapshots (for baseRevision concurrency and read-back verification)
 */

import type {
  CachedCatalogData,
  CachedDayProjections,
  CachedEntitySnapshot,
  CachedPeriodMetadata,
  IMetadataCache,
  MasterCatalogType
} from "./metadataTypes";
import { IDB_DATABASE_NAME } from "./storage";

export const IDB_PERIOD_STORE = "period_metadata_cache";
export const IDB_CATALOG_STORE = "master_catalog_cache";
export const IDB_PROJECTIONS_STORE = "projections_cache";
export const IDB_ENTITY_STORE = "entity_snapshot_cache";

/**
 * Production IndexedDB implementation of IMetadataCache.
 */
export class IndexedDBMetadataCache implements IMetadataCache {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly customIdbFactory?: IDBFactory;

  constructor(options?: { dbName?: string; idbFactory?: IDBFactory }) {
    this.dbName = options?.dbName ?? IDB_DATABASE_NAME;
    this.customIdbFactory = options?.idbFactory;
  }

  private getIdbFactory(): IDBFactory {
    if (this.customIdbFactory) return this.customIdbFactory;
    if (typeof window !== "undefined" && window.indexedDB) return window.indexedDB;
    if (typeof indexedDB !== "undefined") return indexedDB;
    throw new Error("IndexedDB is not supported in the current runtime environment.");
  }

  async initialize(): Promise<void> {
    if (this.db) return;

    const factory = this.getIdbFactory();
    return new Promise<void>((resolve, reject) => {
      // Version 2 introduces metadata cache stores alongside mutation_queue
      const request = factory.open(this.dbName, 2);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains("mutation_queue")) {
          const store = db.createObjectStore("mutation_queue", { keyPath: "id" });
          store.createIndex("idx_status", "status", { unique: false });
          store.createIndex("idx_createdAt", "createdAt", { unique: false });
          store.createIndex("idx_nextRetryAt", "nextRetryAt", { unique: false });
          store.createIndex("idx_dayId", "dayId", { unique: false });
        }
        if (!db.objectStoreNames.contains(IDB_PERIOD_STORE)) {
          db.createObjectStore(IDB_PERIOD_STORE, { keyPath: "periodKey" });
        }
        if (!db.objectStoreNames.contains(IDB_CATALOG_STORE)) {
          db.createObjectStore(IDB_CATALOG_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(IDB_PROJECTIONS_STORE)) {
          db.createObjectStore(IDB_PROJECTIONS_STORE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(IDB_ENTITY_STORE)) {
          const entityStore = db.createObjectStore(IDB_ENTITY_STORE, { keyPath: "key" });
          entityStore.createIndex("idx_day_entity", ["dayId", "entityType"], { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error ?? new Error("Failed to open IndexedDB metadata cache."));
      };
    });
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureDb(): IDBDatabase {
    if (!this.db) throw new Error("IndexedDBMetadataCache is not initialized. Call initialize() first.");
    return this.db;
  }

  // --- Period / Day Metadata ---

  async getPeriodMetadata(periodKey: string): Promise<CachedPeriodMetadata | null> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_PERIOD_STORE, "readonly");
      const req = tx.objectStore(IDB_PERIOD_STORE).get(periodKey);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async setPeriodMetadata(metadata: CachedPeriodMetadata): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_PERIOD_STORE, "readwrite");
      const req = tx.objectStore(IDB_PERIOD_STORE).put(metadata);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Master Catalogs ---

  async getCatalog<T = unknown>(franchiseId: string, catalogType: MasterCatalogType): Promise<T[] | null> {
    const db = this.ensureDb();
    const key = `${franchiseId}:${catalogType}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_CATALOG_STORE, "readonly");
      const req = tx.objectStore(IDB_CATALOG_STORE).get(key);
      req.onsuccess = () => {
        const result = req.result as CachedCatalogData<T> | undefined;
        resolve(result?.items ?? null);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async setCatalog<T = unknown>(franchiseId: string, catalogType: MasterCatalogType, items: T[]): Promise<void> {
    const db = this.ensureDb();
    const key = `${franchiseId}:${catalogType}`;
    const entry: CachedCatalogData<T> = {
      key,
      franchiseId,
      catalogType,
      items,
      cachedAt: Date.now()
    };
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_CATALOG_STORE, "readwrite");
      const req = tx.objectStore(IDB_CATALOG_STORE).put(entry);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Day Projections (Read Cache Only) ---

  async getDayProjections(
    franchiseId: string,
    periodKey: string,
    dayNo: number
  ): Promise<CachedDayProjections | null> {
    const db = this.ensureDb();
    const key = `${franchiseId}:${periodKey}:${dayNo}`;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_PROJECTIONS_STORE, "readonly");
      const req = tx.objectStore(IDB_PROJECTIONS_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async setDayProjections(projections: CachedDayProjections): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_PROJECTIONS_STORE, "readwrite");
      const req = tx.objectStore(IDB_PROJECTIONS_STORE).put(projections);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Entity Snapshots ---

  async getEntitySnapshot(key: string): Promise<CachedEntitySnapshot | null> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_ENTITY_STORE, "readonly");
      const req = tx.objectStore(IDB_ENTITY_STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async setEntitySnapshot(snapshot: CachedEntitySnapshot): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_ENTITY_STORE, "readwrite");
      const req = tx.objectStore(IDB_ENTITY_STORE).put(snapshot);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async listSnapshotsForDay(dayId: string, entityType?: string): Promise<CachedEntitySnapshot[]> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_ENTITY_STORE, "readonly");
      const store = tx.objectStore(IDB_ENTITY_STORE);
      const req = store.getAll();
      req.onsuccess = () => {
        let items = (req.result ?? []) as CachedEntitySnapshot[];
        items = items.filter((i) => i.dayId === dayId);
        if (entityType) {
          items = items.filter((i) => i.entityType === entityType);
        }
        resolve(items);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteEntitySnapshot(key: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_ENTITY_STORE, "readwrite");
      const req = tx.objectStore(IDB_ENTITY_STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async clearAll(): Promise<void> {
    const db = this.ensureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        [IDB_PERIOD_STORE, IDB_CATALOG_STORE, IDB_PROJECTIONS_STORE, IDB_ENTITY_STORE],
        "readwrite"
      );
      tx.objectStore(IDB_PERIOD_STORE).clear();
      tx.objectStore(IDB_CATALOG_STORE).clear();
      tx.objectStore(IDB_PROJECTIONS_STORE).clear();
      tx.objectStore(IDB_ENTITY_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

/**
 * In-Memory implementation of IMetadataCache for unit tests and non-browser environments.
 */
export class MemoryMetadataCache implements IMetadataCache {
  private periods = new Map<string, CachedPeriodMetadata>();
  private catalogs = new Map<string, CachedCatalogData<any>>();
  private projections = new Map<string, CachedDayProjections>();
  private snapshots = new Map<string, CachedEntitySnapshot>();

  async initialize(): Promise<void> {}
  async close(): Promise<void> {}

  async getPeriodMetadata(periodKey: string): Promise<CachedPeriodMetadata | null> {
    const p = this.periods.get(periodKey);
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }

  async setPeriodMetadata(metadata: CachedPeriodMetadata): Promise<void> {
    this.periods.set(metadata.periodKey, JSON.parse(JSON.stringify(metadata)));
  }

  async getCatalog<T = unknown>(franchiseId: string, catalogType: MasterCatalogType): Promise<T[] | null> {
    const key = `${franchiseId}:${catalogType}`;
    const c = this.catalogs.get(key);
    return c ? JSON.parse(JSON.stringify(c.items)) : null;
  }

  async setCatalog<T = unknown>(franchiseId: string, catalogType: MasterCatalogType, items: T[]): Promise<void> {
    const key = `${franchiseId}:${catalogType}`;
    this.catalogs.set(key, {
      key,
      franchiseId,
      catalogType,
      items: JSON.parse(JSON.stringify(items)),
      cachedAt: Date.now()
    });
  }

  async getDayProjections(
    franchiseId: string,
    periodKey: string,
    dayNo: number
  ): Promise<CachedDayProjections | null> {
    const key = `${franchiseId}:${periodKey}:${dayNo}`;
    const p = this.projections.get(key);
    return p ? JSON.parse(JSON.stringify(p)) : null;
  }

  async setDayProjections(projections: CachedDayProjections): Promise<void> {
    this.projections.set(projections.key, JSON.parse(JSON.stringify(projections)));
  }

  async getEntitySnapshot(key: string): Promise<CachedEntitySnapshot | null> {
    const s = this.snapshots.get(key);
    return s ? JSON.parse(JSON.stringify(s)) : null;
  }

  async setEntitySnapshot(snapshot: CachedEntitySnapshot): Promise<void> {
    this.snapshots.set(snapshot.key, JSON.parse(JSON.stringify(snapshot)));
  }

  async listSnapshotsForDay(dayId: string, entityType?: string): Promise<CachedEntitySnapshot[]> {
    let list = Array.from(this.snapshots.values()).filter((s) => s.dayId === dayId);
    if (entityType) {
      list = list.filter((s) => s.entityType === entityType);
    }
    return JSON.parse(JSON.stringify(list));
  }

  async deleteEntitySnapshot(key: string): Promise<void> {
    this.snapshots.delete(key);
  }

  async clearAll(): Promise<void> {
    this.periods.clear();
    this.catalogs.clear();
    this.projections.clear();
    this.snapshots.clear();
  }
}

let activeMetadataCache: IMetadataCache = new MemoryMetadataCache();

export function getMetadataCache(): IMetadataCache {
  return activeMetadataCache;
}

export function setMetadataCache(cache: IMetadataCache): void {
  activeMetadataCache = cache;
}
