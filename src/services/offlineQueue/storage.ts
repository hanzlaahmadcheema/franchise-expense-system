/**
 * Phase 12A: Mutation Queue Storage Engines
 *
 * Implements:
 * 1. IndexedDBQueueStorage - Production durable storage in `franchise_offline_ledger_v1`
 * 2. MemoryQueueStorage - In-memory store for unit tests and environments without IDB
 */

import type {
  IQueueStorage,
  MutationQueueStatus,
  QueuedMutationRecord
} from "./types";

export const IDB_DATABASE_NAME = "franchise_offline_ledger_v1";
export const IDB_DATABASE_VERSION = 1;
export const IDB_MUTATION_STORE_NAME = "mutation_queue";

/**
 * Production IndexedDB implementation of IQueueStorage.
 */
export class IndexedDBQueueStorage implements IQueueStorage {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly dbVersion: number;
  private readonly customIdbFactory?: IDBFactory;

  constructor(options?: { dbName?: string; dbVersion?: number; idbFactory?: IDBFactory }) {
    this.dbName = options?.dbName ?? IDB_DATABASE_NAME;
    this.dbVersion = options?.dbVersion ?? IDB_DATABASE_VERSION;
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
      const request = factory.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_MUTATION_STORE_NAME)) {
          const store = db.createObjectStore(IDB_MUTATION_STORE_NAME, {
            keyPath: "id"
          });
          // Indexes for query and FIFO ordering
          store.createIndex("idx_status", "status", { unique: false });
          store.createIndex("idx_createdAt", "createdAt", { unique: false });
          store.createIndex("idx_nextRetryAt", "nextRetryAt", { unique: false });
          store.createIndex("idx_dayId", "dayId", { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onerror = () => {
        reject(request.error ?? new Error("Failed to open IndexedDB database."));
      };

      request.onblocked = () => {
        console.warn("[IndexedDBQueueStorage] Database upgrade blocked by another connection.");
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
    if (!this.db) {
      throw new Error("IndexedDBQueueStorage is not initialized. Call initialize() first.");
    }
    return this.db;
  }

  async putRecord(record: QueuedMutationRecord): Promise<void> {
    const db = this.ensureDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_MUTATION_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_MUTATION_STORE_NAME);
      const request = store.put(record);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Failed to put record in IndexedDB."));
    });
  }

  async getRecord(id: string): Promise<QueuedMutationRecord | null> {
    const db = this.ensureDb();
    return new Promise<QueuedMutationRecord | null>((resolve, reject) => {
      const tx = db.transaction(IDB_MUTATION_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_MUTATION_STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error(`Failed to get record ${id} from IndexedDB.`));
    });
  }

  async deleteRecord(id: string): Promise<void> {
    const db = this.ensureDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_MUTATION_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_MUTATION_STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error(`Failed to delete record ${id} from IndexedDB.`));
    });
  }

  async listAllRecords(): Promise<QueuedMutationRecord[]> {
    const db = this.ensureDb();
    return new Promise<QueuedMutationRecord[]>((resolve, reject) => {
      const tx = db.transaction(IDB_MUTATION_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_MUTATION_STORE_NAME);
      const index = store.index("idx_createdAt");
      const request = index.getAll();

      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => reject(request.error ?? new Error("Failed to list all records from IndexedDB."));
    });
  }

  async listRecordsByStatus(status: MutationQueueStatus): Promise<QueuedMutationRecord[]> {
    const db = this.ensureDb();
    return new Promise<QueuedMutationRecord[]>((resolve, reject) => {
      const tx = db.transaction(IDB_MUTATION_STORE_NAME, "readonly");
      const store = tx.objectStore(IDB_MUTATION_STORE_NAME);
      const index = store.index("idx_status");
      const request = index.getAll(status);

      request.onsuccess = () => {
        const records = (request.result ?? []) as QueuedMutationRecord[];
        // Sort strictly by createdAt ascending for FIFO order
        records.sort((a, b) => a.createdAt - b.createdAt);
        resolve(records);
      };
      request.onerror = () => reject(request.error ?? new Error(`Failed to list records by status ${status}.`));
    });
  }

  async peekNextEligible(now: number = Date.now()): Promise<QueuedMutationRecord | null> {
    const queuedRecords = await this.listRecordsByStatus("queued");
    // Find the first record (FIFO) where nextRetryAt <= now
    const eligible = queuedRecords.find((r) => r.nextRetryAt <= now);
    return eligible ?? null;
  }

  async clearAll(): Promise<void> {
    const db = this.ensureDb();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_MUTATION_STORE_NAME, "readwrite");
      const store = tx.objectStore(IDB_MUTATION_STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error ?? new Error("Failed to clear IndexedDB store."));
    });
  }
}

/**
 * In-Memory storage implementation of IQueueStorage.
 * Used for Vitest unit testing, node environments, or environments where IDB is unavailable.
 */
export class MemoryQueueStorage implements IQueueStorage {
  private records = new Map<string, QueuedMutationRecord>();
  private initialized = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async close(): Promise<void> {
    this.initialized = false;
  }

  private checkInit(): void {
    if (!this.initialized) {
      throw new Error("MemoryQueueStorage is not initialized. Call initialize() first.");
    }
  }

  async putRecord(record: QueuedMutationRecord): Promise<void> {
    this.checkInit();
    // Clone to prevent accidental external mutation
    this.records.set(record.id, JSON.parse(JSON.stringify(record)));
  }

  async getRecord(id: string): Promise<QueuedMutationRecord | null> {
    this.checkInit();
    const found = this.records.get(id);
    return found ? JSON.parse(JSON.stringify(found)) : null;
  }

  async deleteRecord(id: string): Promise<void> {
    this.checkInit();
    this.records.delete(id);
  }

  async listAllRecords(): Promise<QueuedMutationRecord[]> {
    this.checkInit();
    const list = Array.from(this.records.values());
    list.sort((a, b) => a.createdAt - b.createdAt);
    return JSON.parse(JSON.stringify(list));
  }

  async listRecordsByStatus(status: MutationQueueStatus): Promise<QueuedMutationRecord[]> {
    this.checkInit();
    const list = Array.from(this.records.values()).filter((r) => r.status === status);
    list.sort((a, b) => a.createdAt - b.createdAt);
    return JSON.parse(JSON.stringify(list));
  }

  async peekNextEligible(now: number = Date.now()): Promise<QueuedMutationRecord | null> {
    this.checkInit();
    const queued = await this.listRecordsByStatus("queued");
    const eligible = queued.find((r) => r.nextRetryAt <= now);
    return eligible ?? null;
  }

  async clearAll(): Promise<void> {
    this.checkInit();
    this.records.clear();
  }
}
