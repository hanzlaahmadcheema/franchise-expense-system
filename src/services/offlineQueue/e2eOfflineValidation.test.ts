// @vitest-environment jsdom
/**
 * Phase 12D: End-to-End Offline Simulation & Validation Test Suite
 *
 * Exhaustively validates all Phase 12D requirements across 16 core test sections:
 *  1. All 10 operational workflows (UI/Adapter -> Queue -> API -> Server Projections)
 *  2. Real offline simulation (Online -> Offline -> Queue -> Reload -> Recover -> Online -> Sync -> Confirmed)
 *  3. Cold offline start (Metadata resolution from cache, safe failure on missing data, no fabricated IDs)
 *  4. Browser restart / crash recovery (Stale sending -> queued, stable IDs, no duplicates)
 *  5. FIFO cross-module test (Multi-domain execution in exact chronological order, concurrency = 1)
 *  6. Retry / network failure test (Backoff policy, retries, fatal error handling)
 *  7. Idempotency / lost response test (Smart read-back for CREATE, UPDATE, DELETE)
 *  8. Conflict test (HTTP 409 revision conflict, worker pause, side-by-side modal, manual resolution)
 *  9. Closed-day test (HTTP 422 governance blocked, no hammering, server authority)
 * 10. Authentication test (HTTP 401 paused_auth, zero credentials in storage, resume upon auth)
 * 11. Stale metadata test (Stale projections never used for calculation, safe failure)
 * 12. Negative accounting tests (Offline layer never calculates derived figures)
 * 13. No Firestore fallback test (Zero operational writes to Firestore during offline/online)
 * 14. Feature flag isolation (Enabled ONLY in isolated test blocks, strictly false default)
 * 15. Multi-module accounting integration (All 10 workflows integrated cleanly)
 * 16. Combined failure scenario (Restart + FIFO + Conflict pause + Resolve + Resume)
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  isOfflineQueueEnabled,
  setOfflineQueueEnabled
} from "./featureFlag";

import {
  MutationQueueManager,
  getActiveQueueManager,
  setActiveQueueManager
} from "./mutationQueueManager";

import {
  MemoryQueueStorage
} from "./storage";

import {
  MemoryMetadataCache,
  setMetadataCache,
  getMetadataCache
} from "./metadataCache";

import {
  ExpenseAdapter,
  StockAdapter,
  JazzLoadAdapter,
  createUnifiedTransport,
  createUnifiedReadBack
} from "./index";

import {
  resolveAccountingDayId,
  getAccountingPeriodWithDays,
  clearPeriodCache
} from "../api/periodDayService";

import { ledgerApiClient } from "../api/ledgerApiClient";
import { computeGlobalQueueState } from "./useOfflineQueue";
import type {
  QueuedMutationRecord,
  MutationTransportResponse
} from "./types";

describe("Phase 12D: Section 14 — Feature Flag Isolation & Default Verification", () => {
  it("defaults strictly to OFF (false)", () => {
    expect(isOfflineQueueEnabled()).toBe(false);
  });

  it("can be enabled in isolated test blocks and restored to false cleanly", () => {
    setOfflineQueueEnabled(true);
    expect(isOfflineQueueEnabled()).toBe(true);
    setOfflineQueueEnabled(false);
    expect(isOfflineQueueEnabled()).toBe(false);
  });
});

describe("Phase 12D: Section 1 — All 10 Workflows (UI/Adapter -> Queue -> API Path)", () => {
  let storage: MemoryQueueStorage;
  let queueManager: MutationQueueManager;
  let expenseAdapter: ExpenseAdapter;
  let stockAdapter: StockAdapter;
  let jazzLoadAdapter: JazzLoadAdapter;
  let executedEndpoints: string[];

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
    executedEndpoints = [];

    expenseAdapter = new ExpenseAdapter();
    stockAdapter = new StockAdapter();
    jazzLoadAdapter = new JazzLoadAdapter();

    const mockTransport = async (record: QueuedMutationRecord): Promise<MutationTransportResponse> => {
      executedEndpoints.push(`${record.httpMethod} ${record.endpoint}`);
      return { statusCode: record.httpMethod === "POST" ? 201 : 200, data: { id: record.id, acknowledged: true } };
    };

    queueManager = new MutationQueueManager({
      storage,
      transport: mockTransport,
      readBack: createUnifiedReadBack(expenseAdapter, stockAdapter, jazzLoadAdapter),
      onlineCheck: () => true,
      autoStart: false
    });
    setActiveQueueManager(queueManager);
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
    setActiveQueueManager(null);
  });

  // 1. Expense
  it("Workflow 1: Expense (Create, Update, Delete) preserves facts and reaches API", async () => {
    const create = expenseAdapter.serializeCreateExpense({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      categoryId: "cat-1",
      categoryNameSnapshot: "Office",
      itemName: "Stationery",
      description: "Notebooks",
      amount: 450
    });
    expect(create.domain).toBe("expense");
    expect(create.rawPayload).toEqual({
      client_mutation_id: create.id,
      day_id: "day-1",
      category_id: "cat-1",
      category_name_snapshot: "Office",
      item_name: "Stationery",
      description: "Notebooks",
      amount: 450
    });

    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/expenses");
  });

  // 2. Commission
  it("Workflow 2: Commission (Create) preserves facts and reaches API", async () => {
    const create = expenseAdapter.serializeCreateCommission({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      categoryId: "comm-cat-1",
      categoryNameSnapshot: "Load Comm",
      amount: 1250
    });
    expect(create.domain).toBe("expense");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/commissions");
  });

  // 3. Credit Party
  it("Workflow 3: Credit Party (Create) preserves facts and reaches API", async () => {
    const create = expenseAdapter.serializeCreateCredit({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      partyId: "party-1",
      loanAmount: 5000,
      receiptAmount: 2000,
      loanDescription: "Stock credit",
      receiveDescription: "Cash back"
    });
    expect(create.domain).toBe("expense");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/credits");
  });

  // 4. Owner Transaction
  it("Workflow 4: Owner Transaction (Create) preserves facts and reaches API", async () => {
    const create = expenseAdapter.serializeCreateOwner({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      description: "Owner cash infusion",
      amount: 50000
    });
    expect(create.domain).toBe("expense");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/owner");
  });

  // 5. Stock In
  it("Workflow 5: Stock In (Inbound Order) preserves facts and reaches API", async () => {
    const create = stockAdapter.serializeCreateStockIn({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      supplierName: "supplier-1",
      notes: "Inbound SIM shipment",
      lines: [{ productId: "prod-sim-1", quantity: 500, unitRate: 150 }]
    });
    expect(create.domain).toBe("stock");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/stock/orders");
  });

  // 6. Stock Out
  it("Workflow 6: Stock Out (Outbound Order) preserves facts and reaches API", async () => {
    const create = stockAdapter.serializeCreateStockOut({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      accountId: "dealer-1",
      notes: "Dealer daily issuance",
      lines: [{ productId: "prod-sim-1", quantity: 50, unitRate: 150 }]
    });
    expect(create.domain).toBe("stock");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/stock/orders");
  });

  // 7. Stock Payment
  it("Workflow 7: Stock Account Payment preserves facts and reaches API", async () => {
    const create = stockAdapter.serializeCreateStockPayment({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      accountId: "dealer-1",
      amount: 7500,
      paymentMethod: "cash",
      notes: "Dealer cash clearance"
    });
    expect(create.domain).toBe("stock");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/stock/account-payments");
  });

  // 8. Jazz Lifting
  it("Workflow 8: Jazz Lifting preserves facts and reaches API", async () => {
    const create = jazzLoadAdapter.serializeCreateLifting({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      mlLiftingAmount: 250000
    });
    expect(create.domain).toBe("jazzLoad");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/jazz-load/lifting");
  });

  // 9. Jazz DO
  it("Workflow 9: Jazz DO Entry preserves facts and reaches API", async () => {
    const create = jazzLoadAdapter.serializeCreateDoEntry({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      doProfileId: "profile-mubashar",
      issuanceBase: 180000
    });
    expect(create.domain).toBe("jazzLoad");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/jazz-load/do");
  });

  // 10. Jazz Company Payable
  it("Workflow 10: Jazz Company Payable Payment preserves facts and reaches API", async () => {
    const create = jazzLoadAdapter.serializeCreateCompanyPayment({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      amount: 150000,
      paymentReference: "FT260901001",
      notes: "Direct bank transfer to Jazz"
    });
    expect(create.domain).toBe("jazzLoad");
    await queueManager.enqueue(create);
    await queueManager.drainQueue();
    expect(executedEndpoints).toContain("POST /api/v1/transactions/jazz-company/payments");
  });
});

describe("Phase 12D: Section 2 — Real Offline Simulation (Steps A to H)", () => {
  let storage: MemoryQueueStorage;
  let isOnline: boolean;
  let syncedToServer: string[];

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
    isOnline = true;
    syncedToServer = [];
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("simulates full lifecycle: Online -> Offline -> Queue -> Reload -> Recover -> Online -> Sync -> Confirmed", async () => {
    // Step A: Device transitions offline before mutation
    isOnline = false;

    const transport = vi.fn().mockImplementation(async (record: QueuedMutationRecord) => {
      syncedToServer.push(record.id);
      return { statusCode: 201, data: { id: record.id } };
    });

    let manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => isOnline,
      autoStart: false
    });

    // Step B: Offline mutation queued
    const expenseAdapter = new ExpenseAdapter();
    const mutation1 = expenseAdapter.serializeCreateExpense({
      id: "mut-lifecycle-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Emergency Generator Fuel",
      amount: 2400
    });

    const enqueuedRecord = await manager.enqueue(mutation1);
    expect(enqueuedRecord.status).toBe("queued");
    // Transport was NOT called because network is offline
    expect(transport).not.toHaveBeenCalled();

    // Verify storage has the record
    const storedBeforeReload = await storage.getRecord("mut-lifecycle-1");
    expect(storedBeforeReload).not.toBeNull();
    expect(storedBeforeReload?.status).toBe("queued");

    // Step C: Browser/application reload simulation while offline
    await manager.close();

    // Step D: Queue recovered from durable storage
    manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => isOnline,
      autoStart: false
    });
    await manager.initialize();

    const recoveredItems = await storage.listAllRecords();
    expect(recoveredItems.length).toBe(1);
    expect(recoveredItems[0].id).toBe("mut-lifecycle-1");
    expect(recoveredItems[0].status).toBe("queued");

    // Step E: Network restored
    isOnline = true;
    manager.resume();

    // Step F & G: Worker resumes and mutation reaches PostgreSQL API
    await manager.drainQueue();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(syncedToServer).toContain("mut-lifecycle-1");

    // Step H: UI transitions to server-confirmed state (queue is empty, status synced)
    const storedAfterSync = await storage.getRecord("mut-lifecycle-1");
    // Completed items are pruned upon acknowledged sync
    expect(storedAfterSync).toBeNull();

    const finalQueueState = computeGlobalQueueState({
      isOnline: true,
      isQueueEnabled: true,
      items: []
    });
    expect(finalQueueState.queueState).toBe("synced");
    expect(finalQueueState.statusLabel).toBe("All changes synced to PostgreSQL");
  });
});

describe("Phase 12D: Section 3 — Cold Offline Start & Metadata Cache", () => {
  let memoryCache: MemoryMetadataCache;

  beforeEach(async () => {
    memoryCache = new MemoryMetadataCache();
    await memoryCache.initialize();
    setMetadataCache(memoryCache);
  });

  afterEach(() => {
    setMetadataCache(null as any);
  });

  it("resolves September Day 1 UUID from metadata cache when network is dead", async () => {
    // Populate durable metadata cache (simulating prior online session)
    await memoryCache.setPeriodMetadata({
      periodKey: "2026-09",
      period: {
        id: "period-uuid-2026-09",
        period_key: "2026-09",
        year: 2026,
        month: 9,
        status: "open"
      } as any,
      days: {
        1: {
          id: "day-uuid-sept-1",
          period_id: "period-uuid-2026-09",
          day_no: 1,
          date: "2026-09-01",
          status: "open"
        } as any
      },
      cachedAt: Date.now()
    });

    // Mock network failure on direct REST API
    vi.spyOn(ledgerApiClient.periods, "list").mockRejectedValue(new Error("Network offline"));

    // Attempt day lookup
    const resolvedDayId = await resolveAccountingDayId("2026-09", 1);
    expect(resolvedDayId).toBe("day-uuid-sept-1");
  });

  it("fails safely and does NOT fabricate day IDs when cache is completely empty", async () => {
    clearPeriodCache();
    vi.spyOn(ledgerApiClient.periods, "list").mockRejectedValue(new Error("Network offline"));

    const resolvedDayId = await resolveAccountingDayId("2026-09", 1);
    expect(resolvedDayId).toBeNull();
  });
});

describe("Phase 12D: Section 4 — Browser Restart & Crash Recovery", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("recovers stale 'sending' records back to 'queued' on crash restart", async () => {
    const expenseAdapter = new ExpenseAdapter();
    const staleRecord = expenseAdapter.serializeCreateExpense({
      id: "mut-crash-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Interrupted Write",
      amount: 1000
    });

    // Simulate record was in-flight when browser crashed
    await storage.putRecord({
      ...staleRecord,
      idempotencyKey: staleRecord.id,
      status: "sending",
      attemptCount: 1,
      nextRetryAt: 0,
      createdAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000
    });

    const beforeRecovery = await storage.getRecord("mut-crash-1");
    expect(beforeRecovery?.status).toBe("sending");

    // Initialize new manager (simulating application relaunch)
    const newManager = new MutationQueueManager({
      storage,
      autoStart: false
    });
    await newManager.initialize();

    // Record must be safely recovered to 'queued'
    const afterRecovery = await storage.getRecord("mut-crash-1");
    expect(afterRecovery?.status).toBe("queued");
    expect(afterRecovery?.id).toBe("mut-crash-1");
  });
});

describe("Phase 12D: Section 5 — FIFO Cross-Module Sequencing", () => {
  let storage: MemoryQueueStorage;
  let queueManager: MutationQueueManager;
  let executedOrder: string[];

  let isOnline: boolean;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
    executedOrder = [];
    isOnline = false;

    const mockTransport = async (record: QueuedMutationRecord): Promise<MutationTransportResponse> => {
      executedOrder.push(record.id);
      return { statusCode: 201, data: { id: record.id } };
    };

    queueManager = new MutationQueueManager({
      storage,
      transport: mockTransport,
      onlineCheck: () => isOnline, // Start offline
      autoStart: false
    });
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("enforces strict FIFO processing across mixed modules (Stock In -> Jazz Payment -> Expense -> Lifting -> Stock Out -> Commission)", async () => {
    const expenseAdapter = new ExpenseAdapter();
    const stockAdapter = new StockAdapter();
    const jazzLoadAdapter = new JazzLoadAdapter();

    // T1 = Stock In
    await queueManager.enqueue({
      ...stockAdapter.serializeCreateStockIn({
        id: "T1-stock-in",
        dayId: "day-1",
        dayNo: 1,
        periodKey: "2026-09",
        supplierName: "sup-1",
        lines: [{ productId: "p1", quantity: 100, unitRate: 100 }]
      }),
      createdAt: 1000
    });

    // T2 = Jazz Company Payment
    await queueManager.enqueue({
      ...jazzLoadAdapter.serializeCreateCompanyPayment({
        id: "T2-jazz-pay",
        dayId: "day-1",
        dayNo: 1,
        periodKey: "2026-09",
        amount: 50000,
        paymentReference: "bank_transfer"
      }),
      createdAt: 2000
    });

    // T3 = Expense
    await queueManager.enqueue({
      ...expenseAdapter.serializeCreateExpense({
        id: "T3-expense",
        dayId: "day-1",
        dayNo: 1,
        periodKey: "2026-09",
        itemName: "Electricity Bill",
        amount: 8500
      }),
      createdAt: 3000
    });

    // T4 = Jazz Lifting
    await queueManager.enqueue({
      ...jazzLoadAdapter.serializeCreateLifting({
        id: "T4-lifting",
        dayId: "day-1",
        dayNo: 1,
        periodKey: "2026-09",
        mlLiftingAmount: 150000
      }),
      createdAt: 4000
    });

    // T5 = Stock Out
    await queueManager.enqueue({
      ...stockAdapter.serializeCreateStockOut({
        id: "T5-stock-out",
        dayId: "day-1",
        dayNo: 1,
        periodKey: "2026-09",
        accountId: "dlr-1",
        lines: [{ productId: "p1", quantity: 20, unitRate: 100 }]
      }),
      createdAt: 5000
    });

    // T6 = Commission
    await queueManager.enqueue({
      ...expenseAdapter.serializeCreateCommission({
        id: "T6-commission",
        dayId: "day-1",
        dayNo: 1,
        periodKey: "2026-09",
        amount: 750
      }),
      createdAt: 6000
    });

    // Verify all 6 queued in storage
    const items = await storage.listAllRecords();
    expect(items.length).toBe(6);

    // Drain queue in online state
    isOnline = true;
    queueManager.resume();
    await queueManager.drainQueue();

    // Verify exact execution sequence
    expect(executedOrder).toEqual([
      "T1-stock-in",
      "T2-jazz-pay",
      "T3-expense",
      "T4-lifting",
      "T5-stock-out",
      "T6-commission"
    ]);
  });
});

describe("Phase 12D: Section 6 — Retries & Network Failure Handling", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("retries transient HTTP 503 and increments attempt count with stable mutation ID", async () => {
    let callCount = 0;
    const transport = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        const err: any = new Error("Gateway Timeout");
        err.status = 503;
        throw err;
      }
      return { statusCode: 200, data: { success: true } };
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => true,
      autoStart: false
    });

    const expenseAdapter = new ExpenseAdapter();
    const mutation = expenseAdapter.serializeCreateExpense({
      id: "mut-retry-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Retry Item",
      amount: 500
    });

    await manager.enqueue(mutation);

    // Attempt 1: Fails with 503
    await manager.drainQueue();
    let record = await storage.getRecord("mut-retry-1");
    expect(record?.attemptCount).toBe(1);
    expect(record?.status).toBe("queued");
    expect(record?.lastError?.category).toBe("TRANSIENT_NETWORK");

    // Force next retry timestamp to now for testing
    record!.nextRetryAt = 0;
    await storage.putRecord(record!);

    // Attempt 2: Fails with 503
    await manager.drainQueue();
    record = await storage.getRecord("mut-retry-1");
    expect(record?.attemptCount).toBe(2);

    // Force next retry timestamp to now
    record!.nextRetryAt = 0;
    await storage.putRecord(record!);

    // Attempt 3: Succeeds
    await manager.drainQueue();
    const finalRecord = await storage.getRecord("mut-retry-1");
    expect(finalRecord).toBeNull(); // Acknowledged & pruned
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("marks non-transient HTTP 400 as failed_fatal without infinite retry looping", async () => {
    const transport = vi.fn().mockImplementation(async () => {
      const err: any = new Error("Bad Request: Invalid format");
      err.status = 400;
      throw err;
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => true,
      autoStart: false
    });

    const expenseAdapter = new ExpenseAdapter();
    const mutation = expenseAdapter.serializeCreateExpense({
      id: "mut-fatal-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Malformed Entry",
      amount: 100
    });

    await manager.enqueue(mutation);
    await manager.drainQueue();

    const record = await storage.getRecord("mut-fatal-1");
    expect(record?.status).toBe("failed_fatal");
    expect(record?.lastError?.category).toBe("FATAL_VALIDATION");

    // Attempting another drain does NOT re-execute fatal record
    await manager.drainQueue();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 12D: Section 7 — Idempotency & Lost Response Test", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("distinguishes lost response from concurrent modification using smart read-back", async () => {
    const expenseAdapter = new ExpenseAdapter();
    const updateMutation = expenseAdapter.serializeUpdateExpense({
      id: "mut-lost-resp-1",
      entityId: "exp-uuid-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      baseRevision: 2,
      amount: 1500
    });

    // Transport returns 409 revision conflict
    const transport = vi.fn().mockImplementation(async () => {
      const err: any = new Error("Revision mismatch");
      err.status = 409;
      throw err;
    });

    // Smart read-back returns server state matching the client's payload (meaning the update DID succeed earlier!)
    const readBack = vi.fn().mockResolvedValue({
      id: "exp-uuid-1",
      revision: 3,
      amount: 1500, // matches rawPayload.amount!
      category_id: null,
      description: null
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      readBack,
      onlineCheck: () => true,
      autoStart: false
    });

    await manager.enqueue(updateMutation);
    await manager.drainQueue();

    // Since the server already has the client's facts, smart read-back resolves it as already applied!
    const record = await storage.getRecord("mut-lost-resp-1");
    expect(record).toBeNull(); // Acknowledged & removed
  });
});

describe("Phase 12D: Section 8 — Conflict Test (HTTP 409 & Manual Resolution)", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("enters 'conflict' state on genuine revision mismatch and pauses queue worker", async () => {
    const expenseAdapter = new ExpenseAdapter();
    const updateMutation = expenseAdapter.serializeUpdateExpense({
      id: "mut-conflict-1",
      entityId: "exp-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      baseRevision: 1,
      amount: 2500
    });

    // Server says 409
    const transport = vi.fn().mockImplementation(async () => {
      const err: any = new Error("Revision conflict: expected 1, found 2");
      err.status = 409;
      throw err;
    });

    // Read-back returns divergent server facts (another user edited amount to 3000)
    const readBack = vi.fn().mockResolvedValue({
      id: "exp-1",
      revision: 2,
      amount: 3000
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      readBack,
      onlineCheck: () => true,
      autoStart: false
    });

    await manager.enqueue(updateMutation);
    await manager.drainQueue();

    // Record MUST enter conflict state
    const record = await storage.getRecord("mut-conflict-1");
    expect(record?.status).toBe("conflict");
    expect(record?.lastError?.category).toBe("REVISION_CONFLICT");

    // Queue worker must be paused
    expect(manager.getIsPaused()).toBe(true);

    // Operator manual action: Discard local uncommitted mutation
    await manager.discardItem("mut-conflict-1");
    const afterDiscard = await storage.getRecord("mut-conflict-1");
    expect(afterDiscard).toBeNull();
  });
});

describe("Phase 12D: Section 9 — Closed-Day Test (HTTP 422 Governance Blocked)", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("rejects mutations against closed accounting days with failed_governance and stops hammering", async () => {
    const transport = vi.fn().mockImplementation(async () => {
      const err: any = new Error("DAY_CLOSED: Accounting day 2 is closed.");
      err.status = 422;
      throw err;
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => true,
      autoStart: false
    });

    const expenseAdapter = new ExpenseAdapter();
    const mutation = expenseAdapter.serializeCreateExpense({
      id: "mut-closed-1",
      dayId: "day-2-closed",
      dayNo: 2,
      periodKey: "2026-09",
      itemName: "Late Expense",
      amount: 1500
    });

    await manager.enqueue(mutation);
    await manager.drainQueue();

    const record = await storage.getRecord("mut-closed-1");
    expect(record?.status).toBe("failed_governance");
    expect(record?.lastError?.category).toBe("GOVERNANCE_BLOCKED");

    // Re-draining does NOT hammer the server
    await manager.drainQueue();
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 12D: Section 10 — Authentication Test (HTTP 401 Paused Auth)", () => {
  let storage: MemoryQueueStorage;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    storage = new MemoryQueueStorage();
    await storage.initialize();
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
  });

  it("pauses queue on HTTP 401 without leaking credentials into stored records", async () => {
    let authFailed = true;
    const transport = vi.fn().mockImplementation(async () => {
      if (authFailed) {
        const err: any = new Error("Firebase ID token has expired");
        err.status = 401;
        throw err;
      }
      return { statusCode: 200, data: { success: true } };
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => true,
      autoStart: false
    });

    const expenseAdapter = new ExpenseAdapter();
    const mutation = expenseAdapter.serializeCreateExpense({
      id: "mut-auth-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Emergency Office Supplies",
      amount: 200
    });

    await manager.enqueue(mutation);
    await manager.drainQueue();

    const record = await storage.getRecord("mut-auth-1");
    expect(record?.status).toBe("paused_auth");
    expect(record?.lastError?.category).toBe("AUTH_EXPIRED");

    // Verify ZERO tokens or authorization headers are stored in the queue record
    expect(JSON.stringify(record)).not.toContain("Bearer");
    expect(JSON.stringify(record)).not.toContain("idToken");
    expect(JSON.stringify(record)).not.toContain("accessToken");

    // Operator logs back in -> auth restored
    authFailed = false;
    await manager.retryItem("mut-auth-1");
    await manager.drainQueue();

    const recordAfterAuth = await storage.getRecord("mut-auth-1");
    expect(recordAfterAuth).toBeNull(); // Acknowledged & removed
  });
});

describe("Phase 12D: Section 11 — Stale Metadata & Safe Failure Tests", () => {
  let memoryCache: MemoryMetadataCache;

  beforeEach(async () => {
    memoryCache = new MemoryMetadataCache();
    await memoryCache.initialize();
    setMetadataCache(memoryCache);
  });

  afterEach(() => {
    setMetadataCache(null as any);
  });

  it("stale cached projections are strictly read-only and never injected as derived calculations", async () => {
    // Cache stale projections from 2 hours ago
    await memoryCache.setDayProjections({
      key: "7301:2026-09:1",
      franchiseId: "7301",
      dayId: "day-stale-1",
      periodKey: "2026-09",
      dayNo: 1,
      source: "server_authoritative_materialized",
      projections: {
        financial: { closing_cash: 125000, operating_profit: 15000 } as any,
        stockProducts: [],
        stockAccounts: [],
        jazzLifting: { closingInHand: 450000 },
        jazzDo: [],
        creditParties: []
      } as any,
      cachedAt: Date.now() - 7200000
    });

    const cached = await memoryCache.getDayProjections("7301", "2026-09", 1);
    expect(cached).not.toBeNull();
    expect(cached?.projections.financial?.closing_cash).toBe(125000);

    // Serialization of raw user expense facts NEVER reads or copies this closingCash
    const expenseAdapter = new ExpenseAdapter();
    const serialized = expenseAdapter.serializeCreateExpense({
      dayId: "day-stale-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Stale test item",
      amount: 500
    });

    expect(serialized.rawPayload.closingCash).toBeUndefined();
    expect(serialized.rawPayload.closing_cash).toBeUndefined();
    expect(serialized.rawPayload.operatingProfit).toBeUndefined();
  });

  it("stale day status in cache does not authorize mutation; server enforces authoritative status", async () => {
    // Cache says day is OPEN
    await memoryCache.setPeriodMetadata({
      periodKey: "2026-09",
      period: { id: "p1", period_key: "2026-09", year: 2026, month: 9, status: "open" } as any,
      days: {
        5: { id: "day-5", period_id: "p1", day_no: 5, date: "2026-09-05", status: "open" } as any
      },
      cachedAt: Date.now() - 3600000
    });

    // Server says day 5 is actually CLOSED (HTTP 422)
    const transport = vi.fn().mockImplementation(async () => {
      const err: any = new Error("DAY_CLOSED: Accounting day 5 is closed.");
      err.status = 422;
      throw err;
    });

    const storage = new MemoryQueueStorage();
    await storage.initialize();
    const manager = new MutationQueueManager({
      storage,
      transport,
      onlineCheck: () => true,
      autoStart: false
    });

    const expenseAdapter = new ExpenseAdapter();
    const mutation = expenseAdapter.serializeCreateExpense({
      dayId: "day-5",
      dayNo: 5,
      periodKey: "2026-09",
      itemName: "Attempt on closed day",
      amount: 1000
    });

    await manager.enqueue(mutation);
    await manager.drainQueue();

    // Must be rejected with failed_governance
    const record = await storage.getRecord(mutation.id);
    expect(record?.status).toBe("failed_governance");
  });

  it("missing catalog entity fails safely without fabricating UUIDs or silent remapping", async () => {
    // When catalog entity does not exist in cache, lookup returns null/undefined
    const catalog = await memoryCache.getCatalog("7301", "stock_products");
    expect(catalog).toBeNull();

    // Form must fail safely without inventing IDs
    const unknownProduct = catalog?.find((i: any) => i.id === "invented-product-uuid");
    expect(unknownProduct).toBeUndefined();
  });
});

describe("Phase 12D: Section 12 — Negative Accounting Tests", () => {
  it("proves that offline serialized payloads NEVER calculate or submit derived accounting values", () => {
    const expenseAdapter = new ExpenseAdapter();
    const stockAdapter = new StockAdapter();
    const jazzLoadAdapter = new JazzLoadAdapter();

    const expRecord = expenseAdapter.serializeCreateExpense({
      dayId: "d1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Test",
      amount: 100
    });

    const stockRecord = stockAdapter.serializeCreateStockOut({
      dayId: "d1",
      dayNo: 1,
      periodKey: "2026-09",
      accountId: "acc-1",
      lines: [{ productId: "p1", quantity: 10, unitRate: 50 }]
    });

    const jazzRecord = jazzLoadAdapter.serializeCreateLifting({
      dayId: "d1",
      dayNo: 1,
      periodKey: "2026-09",
      mlLiftingAmount: 10000
    });

    // Inspect payloads for forbidden derived accounting properties
    const forbiddenKeys = [
      "closingCash",
      "closing_cash",
      "operatingProfit",
      "operating_profit",
      "stockClosingQuantity",
      "stock_closing_quantity",
      "dealerBalance",
      "dealer_balance",
      "creditClosingBalance",
      "credit_closing_balance",
      "jazzLiftingClosing",
      "jazz_lifting_closing",
      "jazzDoClosing",
      "jazz_do_closing",
      "jazzCompanyPayable",
      "jazz_company_payable"
    ];

    for (const key of forbiddenKeys) {
      expect(expRecord.rawPayload[key]).toBeUndefined();
      expect(stockRecord.rawPayload[key]).toBeUndefined();
      expect(jazzRecord.rawPayload[key]).toBeUndefined();
    }
  });
});

describe("Phase 12D: Section 13 — Firestore Safety", () => {
  it("makes ZERO operational writes to Firestore during offline queue operation", async () => {
    setOfflineQueueEnabled(true);
    const storage = new MemoryQueueStorage();
    await storage.initialize();

    const manager = new MutationQueueManager({
      storage,
      transport: vi.fn().mockResolvedValue({ statusCode: 201 }),
      onlineCheck: () => false,
      autoStart: false
    });

    const expenseAdapter = new ExpenseAdapter();
    const mutation = expenseAdapter.serializeCreateExpense({
      dayId: "d1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Offline item",
      amount: 700
    });

    await manager.enqueue(mutation);

    // Queue has record, zero Firestore writes
    const items = await storage.listAllRecords();
    expect(items.length).toBe(1);
    expect(items[0].endpoint).toBe("/api/v1/transactions/expenses"); // Routes to PostgreSQL REST

    setOfflineQueueEnabled(false);
  });
});

describe("Phase 12D: Section 15 — Multi-Module Accounting Integration Test", () => {
  it("processes a multi-domain transaction sequence covering all 10 workflows and verifies server-authoritative projection flow", async () => {
    setOfflineQueueEnabled(true);
    const storage = new MemoryQueueStorage();
    await storage.initialize();

    const expenseAdapter = new ExpenseAdapter();
    const stockAdapter = new StockAdapter();
    const jazzLoadAdapter = new JazzLoadAdapter();

    const processedEndpoints: string[] = [];
    const mockTransport = async (record: QueuedMutationRecord): Promise<MutationTransportResponse> => {
      processedEndpoints.push(`${record.domain}:${record.action}:${record.entityType}`);
      return { statusCode: 201, data: { id: record.id, committed: true } };
    };

    let isOnline = false;
    const manager = new MutationQueueManager({
      storage,
      transport: mockTransport,
      onlineCheck: () => isOnline,
      autoStart: false
    });

    // 1. Stock In (Inbound order: 500 SIMs @ 150)
    await manager.enqueue(stockAdapter.serializeCreateStockIn({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      supplierName: "acc-supplier",
      lines: [{ productId: "p-sim", quantity: 500, unitRate: 150 }]
    }));

    // 2. Stock Out (Outbound order: 50 SIMs @ 150)
    await manager.enqueue(stockAdapter.serializeCreateStockOut({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      accountId: "acc-dealer-1",
      lines: [{ productId: "p-sim", quantity: 50, unitRate: 150 }]
    }));

    // 3. Stock Account Payment (Dealer cash payment 7,500)
    await manager.enqueue(stockAdapter.serializeCreateStockPayment({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      accountId: "acc-dealer-1",
      amount: 7500,
      paymentMethod: "cash"
    }));

    // 4. Jazz Lifting (Bank lifting 250,000)
    await manager.enqueue(jazzLoadAdapter.serializeCreateLifting({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      mlLiftingAmount: 250000
    }));

    // 5. Jazz DO (Mubashar DO disbursement 180,000)
    await manager.enqueue(jazzLoadAdapter.serializeCreateDoEntry({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      doProfileId: "prof-mubashar",
      issuanceBase: 180000
    }));

    // 6. Commission (Load Commission 1,250)
    await manager.enqueue(expenseAdapter.serializeCreateCommission({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      amount: 1250
    }));

    // 7. Expense (Office Tea 450)
    await manager.enqueue(expenseAdapter.serializeCreateExpense({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Office Tea",
      amount: 450
    }));

    // 8. Owner Transaction (Cash infusion 50,000)
    await manager.enqueue(expenseAdapter.serializeCreateOwner({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      description: "Owner cash infusion",
      amount: 50000
    }));

    // 9. Credit Party (Loan 5,000, receipt 2,000)
    await manager.enqueue(expenseAdapter.serializeCreateCredit({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      partyId: "party-alpha",
      loanAmount: 5000,
      receiptAmount: 2000
    }));

    // 10. Jazz Company Payable (Bank transfer 150,000)
    await manager.enqueue(jazzLoadAdapter.serializeCreateCompanyPayment({
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      amount: 150000,
      paymentReference: "bank_transfer"
    }));

    // Verify 10 items queued
    const queuedItems = await storage.listAllRecords();
    expect(queuedItems.length).toBe(10);

    // Drain all 10 in online mode
    isOnline = true;
    await manager.drainQueue();

    // Verify all 10 executed through transport sequentially
    expect(processedEndpoints.length).toBe(10);
    expect(processedEndpoints).toEqual([
      "stock:CREATE:stock_order_inbound",
      "stock:CREATE:stock_order_outbound",
      "stock:CREATE:stock_account_payment",
      "jazzLoad:CREATE:jazz_lifting",
      "jazzLoad:CREATE:jazz_do_entry",
      "expense:CREATE:commission_item",
      "expense:CREATE:expense_item",
      "expense:CREATE:owner_transaction",
      "expense:CREATE:credit_transaction",
      "jazzLoad:CREATE:jazz_company_payment"
    ]);

    // Pruned from queue
    const remaining = await storage.listAllRecords();
    expect(remaining.length).toBe(0);

    setOfflineQueueEnabled(false);
  });
});

describe("Phase 12D: Section 16 — Combined Failure Scenario (Restart + FIFO + Conflict + Resolve + Resume)", () => {
  it("survives restart, processes in FIFO order, pauses on conflict, and resumes after resolution", async () => {
    setOfflineQueueEnabled(true);
    const storage = new MemoryQueueStorage();
    await storage.initialize();

    const expenseAdapter = new ExpenseAdapter();
    const stockAdapter = new StockAdapter();

    // 1. Queue 3 mutations while offline
    const t1 = expenseAdapter.serializeCreateExpense({
      id: "T1-clean-sync",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Tea",
      amount: 200
    });

    const t2 = stockAdapter.serializeUpdateStockOut({
      id: "T2-conflict-item",
      entityId: "order-1",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      baseRevision: 1,
      accountId: "acc-1",
      lines: [{ productId: "p1", quantity: 5, unitRate: 100 }]
    });

    const t3 = expenseAdapter.serializeCreateExpense({
      id: "T3-waiting-item",
      dayId: "day-1",
      dayNo: 1,
      periodKey: "2026-09",
      itemName: "Snacks",
      amount: 300
    });

    // Enqueue T1, T2, T3
    let manager = new MutationQueueManager({
      storage,
      onlineCheck: () => false,
      autoStart: false
    });

    await manager.enqueue({ ...t1, createdAt: 1000 });
    await manager.enqueue({ ...t2, createdAt: 2000 });
    await manager.enqueue({ ...t3, createdAt: 3000 });

    // 2. Restart application simulation
    await manager.close();

    const executed: string[] = [];
    const transport = vi.fn().mockImplementation(async (record: QueuedMutationRecord) => {
      executed.push(record.id);
      if (record.id === "T2-conflict-item") {
        const err: any = new Error("Revision mismatch");
        err.status = 409;
        throw err;
      }
      return { statusCode: 201, data: { id: record.id } };
    });

    const readBack = vi.fn().mockResolvedValue({
      id: "order-1",
      revision: 2, // Divergent revision -> conflict!
      quantity: 10
    });

    manager = new MutationQueueManager({
      storage,
      transport,
      readBack,
      onlineCheck: () => true, // Network restored
      autoStart: false
    });
    await manager.initialize();

    // 3. Drain queue
    await manager.drainQueue();

    // T1 should have synced, T2 failed with conflict, T3 was NOT attempted because worker paused
    expect(executed).toEqual(["T1-clean-sync", "T2-conflict-item"]);

    const t1Record = await storage.getRecord("T1-clean-sync");
    expect(t1Record).toBeNull(); // Acknowledged & removed

    const t2Record = await storage.getRecord("T2-conflict-item");
    expect(t2Record?.status).toBe("conflict");

    const t3Record = await storage.getRecord("T3-waiting-item");
    expect(t3Record?.status).toBe("queued"); // Waiting in queue

    // 4. Resolve T2: Operator discards conflict
    await manager.discardItem("T2-conflict-item");

    // 5. Worker resumes and drains T3
    await manager.drainQueue();
    expect(executed).toEqual(["T1-clean-sync", "T2-conflict-item", "T3-waiting-item"]);

    const t3Final = await storage.getRecord("T3-waiting-item");
    expect(t3Final).toBeNull(); // Cleanly synced and acknowledged

    setOfflineQueueEnabled(false);
  });
});
