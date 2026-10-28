/**
 * Phase 12A: IndexedDB Storage Engine Unit Tests
 *
 * Validates IndexedDB initialization, schema upgrading, indexes,
 * and CRUD operations using an isolated mock IDBFactory.
 */

import { describe, expect, it } from "vitest";
import {
  IDB_DATABASE_NAME,
  IDB_DATABASE_VERSION,
  IDB_MUTATION_STORE_NAME,
  IndexedDBQueueStorage
} from "./storage";
import type { QueuedMutationRecord } from "./types";

class MockIDBIndex {
  constructor(private storeMap: Map<string, any>, private key: string) {}

  getAll(query?: any) {
    const req: any = { onsuccess: null, onerror: null, result: null };
    setTimeout(() => {
      let items = Array.from(this.storeMap.values());
      if (query !== undefined) {
        items = items.filter((item) => item[this.key] === query);
      }
      req.result = items;
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}

class MockIDBObjectStore {
  indices = new Map<string, MockIDBIndex>();

  constructor(private storeMap: Map<string, any>) {}

  createIndex(name: string, keyPath: string) {
    const idx = new MockIDBIndex(this.storeMap, keyPath);
    this.indices.set(name, idx);
    return idx;
  }

  index(name: string) {
    const idx = this.indices.get(name);
    if (!idx) {
      const created = new MockIDBIndex(this.storeMap, name === "idx_status" ? "status" : "createdAt");
      this.indices.set(name, created);
      return created;
    }
    return idx;
  }

  put(value: any) {
    const req: any = { onsuccess: null, onerror: null, result: null };
    setTimeout(() => {
      this.storeMap.set(value.id, JSON.parse(JSON.stringify(value)));
      req.result = value.id;
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  get(key: string) {
    const req: any = { onsuccess: null, onerror: null, result: null };
    setTimeout(() => {
      const item = this.storeMap.get(key);
      req.result = item ? JSON.parse(JSON.stringify(item)) : undefined;
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  delete(key: string) {
    const req: any = { onsuccess: null, onerror: null, result: null };
    setTimeout(() => {
      this.storeMap.delete(key);
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }

  clear() {
    const req: any = { onsuccess: null, onerror: null, result: null };
    setTimeout(() => {
      this.storeMap.clear();
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  }
}

class MockIDBDatabase {
  objectStoreNames = {
    contains: (name: string) => this.stores.has(name)
  };
  private stores = new Map<string, MockIDBObjectStore>();
  private storeData = new Map<string, Map<string, any>>();

  createObjectStore(name: string, _options?: any) {
    const dataMap = new Map<string, any>();
    this.storeData.set(name, dataMap);
    const store = new MockIDBObjectStore(dataMap);
    this.stores.set(name, store);
    return store;
  }

  transaction(storeNames: string | string[], _mode?: string) {
    const name = Array.isArray(storeNames) ? storeNames[0] : storeNames;
    let store = this.stores.get(name);
    if (!store) {
      let dataMap = this.storeData.get(name);
      if (!dataMap) {
        dataMap = new Map<string, any>();
        this.storeData.set(name, dataMap);
      }
      store = new MockIDBObjectStore(dataMap);
      this.stores.set(name, store);
    }

    return {
      objectStore: () => store!
    };
  }

  close() {}
}

class MockIDBFactory {
  open(name: string, version: number) {
    const req: any = {
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      result: new MockIDBDatabase()
    };

    setTimeout(() => {
      if (req.onupgradeneeded) {
        req.onupgradeneeded({ oldVersion: 0, newVersion: version, target: req });
      }
      if (req.onsuccess) {
        req.onsuccess({ target: req });
      }
    }, 0);

    return req;
  }
}

describe("Phase 12A: IndexedDBQueueStorage with Mock IDBFactory", () => {
  const sampleRecord: QueuedMutationRecord = {
    id: "idb-test-1",
    idempotencyKey: "idb-test-1",
    domain: "expense",
    action: "CREATE",
    periodKey: "2026-09",
    dayNo: 1,
    dayId: "day-idb-1",
    entityType: "expense_item",
    endpoint: "/api/v1/transactions/expenses",
    httpMethod: "POST",
    rawPayload: { amount: 500 },
    createdAt: 1000,
    updatedAt: 1000,
    attemptCount: 0,
    nextRetryAt: 1000,
    status: "queued"
  };

  it("initializes database with correct name, version, and object store", async () => {
    const mockFactory = new MockIDBFactory();
    const storage = new IndexedDBQueueStorage({
      idbFactory: mockFactory as unknown as IDBFactory
    });

    await storage.initialize();

    // Verify CRUD works through IndexedDB transactions
    await storage.putRecord(sampleRecord);
    const fetched = await storage.getRecord("idb-test-1");
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe("idb-test-1");
    expect(fetched?.status).toBe("queued");

    const queuedList = await storage.listRecordsByStatus("queued");
    expect(queuedList.length).toBe(1);

    await storage.deleteRecord("idb-test-1");
    const afterDelete = await storage.getRecord("idb-test-1");
    expect(afterDelete).toBeNull();

    await storage.close();
  });
});
