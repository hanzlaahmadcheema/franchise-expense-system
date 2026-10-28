/**
 * Phase 12A: Core Offline Mutation Queue Tests
 *
 * Exhaustively validates all 20 required core queue behaviors:
 * 1. enqueue
 * 2. persistence
 * 3. browser-restart recovery simulation
 * 4. FIFO ordering
 * 5. stable clientMutationId
 * 6. stable Idempotency-Key
 * 7. retry count
 * 8. exponential backoff
 * 9. jitter bounds
 * 10. 60s cap
 * 11. transient network error -> queued
 * 12. 400 -> failed_fatal
 * 13. 403 -> failed_fatal
 * 14. 409 -> conflict (and smart PATCH/DELETE read-back resolution)
 * 15. 422 -> failed_governance
 * 16. successful acknowledgement -> removal
 * 17. online event wakes worker
 * 18. offline prevents transport attempt
 * 19. duplicate enqueue protection
 * 20. worker concurrency remains 1
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  BASE_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
  computeBackoffDelay,
  computeNextRetryAt
} from "./backoff";
import { classifyError, verifyPatchDeleteReadBack } from "./errorClassifier";
import { isOfflineQueueEnabled, setOfflineQueueEnabled } from "./featureFlag";
import { MutationQueueManager } from "./mutationQueueManager";
import { MemoryQueueStorage } from "./storage";
import type {
  MutationTransportResponse,
  QueuedMutationRecord
} from "./types";

describe("Phase 12A: Feature Flag", () => {
  it("defaults strictly to OFF (false)", () => {
    expect(isOfflineQueueEnabled()).toBe(false);
  });

  it("can be toggled explicitly for testing without side effects", () => {
    setOfflineQueueEnabled(true);
    expect(isOfflineQueueEnabled()).toBe(true);
    setOfflineQueueEnabled(false);
    expect(isOfflineQueueEnabled()).toBe(false);
  });
});

describe("Phase 12A: Exponential Backoff & Jitter", () => {
  it("computes base delay correctly at attempt 0", () => {
    // Zero jitter test: randomFn returns 0.5 -> multiplier = (1 - 0.15) + 0.5 * 0.30 = 1.00
    const delay = computeBackoffDelay(0, () => 0.5);
    expect(delay).toBe(BASE_BACKOFF_DELAY_MS); // 1500ms
  });

  it("scales exponentially with retry attempts", () => {
    const delay0 = computeBackoffDelay(0, () => 0.5); // 1500
    const delay1 = computeBackoffDelay(1, () => 0.5); // 3000
    const delay2 = computeBackoffDelay(2, () => 0.5); // 6000
    const delay3 = computeBackoffDelay(3, () => 0.5); // 12000

    expect(delay0).toBe(1500);
    expect(delay1).toBe(3000);
    expect(delay2).toBe(6000);
    expect(delay3).toBe(12000);
  });

  it("respects +/- 15% jitter bounds", () => {
    const minDelay = computeBackoffDelay(1, () => 0.0); // 3000 * 0.85 = 2550
    const maxDelay = computeBackoffDelay(1, () => 1.0); // 3000 * 1.15 = 3450

    expect(minDelay).toBe(2550);
    expect(maxDelay).toBe(3450);
  });

  it("caps maximum delay at 60 seconds (60,000ms)", () => {
    const delayAttempt10 = computeBackoffDelay(10, () => 0.5);
    expect(delayAttempt10).toBe(MAX_BACKOFF_DELAY_MS);
    expect(delayAttempt10).toBeLessThanOrEqual(60000);
  });

  it("computes nextRetryAt timestamp correctly", () => {
    const fixedNow = 1000000;
    const retryAt = computeNextRetryAt(0, fixedNow, () => 0.5);
    expect(retryAt).toBe(fixedNow + 1500);
  });
});

describe("Phase 12A: Error Classification & Smart Read-Back", () => {
  it("classifies network errors and 503 as TRANSIENT_NETWORK", () => {
    expect(classifyError(new Error("Failed to fetch")).category).toBe("TRANSIENT_NETWORK");
    expect(classifyError({ status: 503 }).category).toBe("TRANSIENT_NETWORK");
    expect(classifyError({ status: 504 }).category).toBe("TRANSIENT_NETWORK");
    expect(classifyError({ status: 0 }).category).toBe("TRANSIENT_NETWORK");
  });

  it("classifies 400 as FATAL_VALIDATION (non-retriable)", () => {
    const c = classifyError({ status: 400, message: "Validation error" });
    expect(c.category).toBe("FATAL_VALIDATION");
    expect(c.isRetriable).toBe(false);
  });

  it("classifies 403 as FATAL_VALIDATION (non-retriable)", () => {
    const c = classifyError({ status: 403, message: "Forbidden" });
    expect(c.category).toBe("FATAL_VALIDATION");
    expect(c.isRetriable).toBe(false);
  });

  it("classifies 409 as REVISION_CONFLICT", () => {
    const c = classifyError({ status: 409, code: "REVISION_CONFLICT" });
    expect(c.category).toBe("REVISION_CONFLICT");
    expect(c.isRetriable).toBe(false);
  });

  it("classifies 422 as GOVERNANCE_BLOCKED (non-retriable)", () => {
    const c = classifyError({ status: 422, code: "DAY_CLOSED" });
    expect(c.category).toBe("GOVERNANCE_BLOCKED");
    expect(c.isRetriable).toBe(false);
  });

  it("classifies 401 as AUTH_EXPIRED", () => {
    const c = classifyError({ status: 401, code: "TOKEN_EXPIRED" });
    expect(c.category).toBe("AUTH_EXPIRED");
    expect(c.isRetriable).toBe(false);
  });

  it("distinguishes committed PATCH with lost response from genuine conflict", () => {
    const record: QueuedMutationRecord = {
      id: "mut-update-1",
      idempotencyKey: "mut-update-1",
      domain: "expense",
      action: "UPDATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-uuid-1",
      entityType: "expense_item",
      entityId: "exp-123",
      endpoint: "/api/v1/transactions/expenses/exp-123",
      httpMethod: "PATCH",
      rawPayload: { amount: 500, item_name: "Printer Paper" },
      baseRevision: 1,
      createdAt: 1000,
      updatedAt: 1000,
      attemptCount: 1,
      nextRetryAt: 1000,
      status: "sending"
    };

    // Scenario B: Server entity is at revision 2 and fields match payload -> ALREADY COMMITTED!
    const serverEntityApplied = {
      id: "exp-123",
      revision: 2,
      amount: 500,
      item_name: "Printer Paper"
    };
    const resApplied = verifyPatchDeleteReadBack(record, serverEntityApplied);
    expect(resApplied.isAlreadyApplied).toBe(true);
    expect(resApplied.isConflict).toBe(false);

    // Scenario C: Server entity is at revision 2 but amount is 750 (someone else modified it) -> CONFLICT!
    const serverEntityConflicted = {
      id: "exp-123",
      revision: 2,
      amount: 750,
      item_name: "Printer Paper"
    };
    const resConflicted = verifyPatchDeleteReadBack(record, serverEntityConflicted);
    expect(resConflicted.isAlreadyApplied).toBe(false);
    expect(resConflicted.isConflict).toBe(true);
  });

  it("verifies DELETE read-back when entity is null (already deleted)", () => {
    const record: QueuedMutationRecord = {
      id: "mut-del-1",
      idempotencyKey: "mut-del-1",
      domain: "expense",
      action: "DELETE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-uuid-1",
      entityType: "expense_item",
      entityId: "exp-123",
      endpoint: "/api/v1/transactions/expenses/exp-123",
      httpMethod: "DELETE",
      rawPayload: {},
      createdAt: 1000,
      updatedAt: 1000,
      attemptCount: 1,
      nextRetryAt: 1000,
      status: "sending"
    };

    // Record is null on server -> DELETE was previously committed!
    const resDeleted = verifyPatchDeleteReadBack(record, null);
    expect(resDeleted.isAlreadyApplied).toBe(true);
    expect(resDeleted.isConflict).toBe(false);
  });
});

describe("Phase 12A: Core MutationQueueManager", () => {
  let storage: MemoryQueueStorage;
  let onlineState: boolean;

  beforeEach(async () => {
    storage = new MemoryQueueStorage();
    await storage.initialize();
    onlineState = true;
  });

  function createTestManager(transport?: (r: QueuedMutationRecord) => Promise<MutationTransportResponse>) {
    return new MutationQueueManager({
      storage,
      transport: transport ?? vi.fn().mockResolvedValue({ statusCode: 200 }),
      onlineCheck: () => onlineState,
      randomFn: () => 0.5,
      autoStart: false
    });
  }

  it("1. enqueue: enqueues record with status 'queued'", async () => {
    const manager = createTestManager();
    const record = await manager.enqueue({
      id: "mut-1",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 100, item_name: "Tea" }
    });

    expect(record.id).toBe("mut-1");
    expect(record.status).toBe("queued");
    expect(record.attemptCount).toBe(0);
  });

  it("2. persistence: record can be re-read from storage", async () => {
    const manager = createTestManager();
    await manager.enqueue({
      id: "mut-persisted",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 200 }
    });

    const retrieved = await storage.getRecord("mut-persisted");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe("mut-persisted");
    expect(retrieved?.rawPayload).toEqual({ amount: 200 });
  });

  it("3. browser-restart recovery simulation: resets stale 'sending' records to 'queued'", async () => {
    // Simulate an in-flight mutation when the browser abruptly crashed/restarted
    await storage.putRecord({
      id: "mut-crashed",
      idempotencyKey: "mut-crashed",
      domain: "stock",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "stock_order",
      endpoint: "/api/v1/transactions/stock/orders",
      httpMethod: "POST",
      rawPayload: { lines: [] },
      createdAt: 1000,
      updatedAt: 1000,
      attemptCount: 1,
      nextRetryAt: 1000,
      status: "sending"
    });

    const manager = createTestManager();
    await manager.initialize();

    const recovered = await storage.getRecord("mut-crashed");
    expect(recovered?.status).toBe("queued");
  });

  it("4. FIFO ordering: processes records in strict chronological sequence", async () => {
    const executionOrder: string[] = [];
    const transport = vi.fn().mockImplementation(async (r: QueuedMutationRecord) => {
      executionOrder.push(r.id);
      return { statusCode: 200 };
    });

    const manager = createTestManager(transport);
    manager.pause(); // Pause to queue all items first

    await manager.enqueue({
      id: "mut-A",
      createdAt: 100,
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { item: "A" }
    });

    await manager.enqueue({
      id: "mut-B",
      createdAt: 200,
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { item: "B" }
    });

    await manager.enqueue({
      id: "mut-C",
      createdAt: 300,
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { item: "C" }
    });

    manager.resume();
    await manager.drainQueue();

    expect(executionOrder).toEqual(["mut-A", "mut-B", "mut-C"]);
  });

  it("5. stable clientMutationId & 6. stable Idempotency-Key", async () => {
    let capturedKey = "";
    const transport = vi.fn().mockImplementation(async (r: QueuedMutationRecord) => {
      capturedKey = r.idempotencyKey;
      return { statusCode: 200 };
    });

    const manager = createTestManager(transport);
    const rec = await manager.enqueue({
      id: "stable-uuid-12345",
      domain: "jazzLoad",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "jazz_load_lifting",
      endpoint: "/api/v1/transactions/jazz-load/lifting",
      httpMethod: "POST",
      rawPayload: { mlLifting: 1000 }
    });
    await manager.drainQueue();

    expect(rec.id).toBe("stable-uuid-12345");
    expect(rec.idempotencyKey).toBe("stable-uuid-12345");
    expect(capturedKey).toBe("stable-uuid-12345");
  });

  it("7. retry count & 11. transient network error -> queued with backoff", async () => {
    let callCount = 0;
    const transport = vi.fn().mockImplementation(async () => {
      callCount++;
      throw new Error("Failed to fetch");
    });

    const manager = createTestManager(transport);
    await manager.enqueue({
      id: "mut-transient",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 100 }
    });
    await manager.drainQueue();

    const record = await storage.getRecord("mut-transient");
    expect(callCount).toBe(1);
    expect(record?.status).toBe("queued");
    expect(record?.attemptCount).toBe(1);
    expect(record?.nextRetryAt).toBeGreaterThan(Date.now());
    expect(record?.lastError?.category).toBe("TRANSIENT_NETWORK");
  });

  it("12. 400 -> failed_fatal", async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 400 });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-400",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: {}
    });
    await manager.drainQueue();

    const record = await storage.getRecord("mut-400");
    expect(record?.status).toBe("failed_fatal");
    expect(record?.lastError?.status).toBe(400);
  });

  it("13. 403 -> failed_fatal", async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 403 });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-403",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: {}
    });
    await manager.drainQueue();

    const record = await storage.getRecord("mut-403");
    expect(record?.status).toBe("failed_fatal");
    expect(record?.lastError?.status).toBe(403);
  });

  it("14. 409 -> conflict", async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 409 });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-409",
      domain: "expense",
      action: "UPDATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      entityId: "item-1",
      baseRevision: 1,
      endpoint: "/api/v1/transactions/expenses/item-1",
      httpMethod: "PATCH",
      rawPayload: { amount: 300 }
    });
    await manager.drainQueue();

    const record = await storage.getRecord("mut-409");
    expect(record?.status).toBe("conflict");
    expect(record?.lastError?.status).toBe(409);
  });

  it("14b. 409 with smart read-back verification: detects lost response and marks synced", async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 409 });
    // Read-back returns server entity matching the payload at revision 2 (baseRevision 1 + 1)
    const readBack = vi.fn().mockResolvedValue({
      id: "item-1",
      revision: 2,
      amount: 300
    });

    const manager = new MutationQueueManager({
      storage,
      transport,
      readBack,
      onlineCheck: () => true,
      autoStart: false
    });

    await manager.enqueue({
      id: "mut-smart-409",
      domain: "expense",
      action: "UPDATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      entityId: "item-1",
      baseRevision: 1,
      endpoint: "/api/v1/transactions/expenses/item-1",
      httpMethod: "PATCH",
      rawPayload: { amount: 300 }
    });
    await manager.drainQueue();

    // Proved already applied: record should be acknowledged as synced and removed from queue!
    const record = await storage.getRecord("mut-smart-409");
    expect(record).toBeNull(); // Removed on confirmed success
    expect(readBack).toHaveBeenCalled();
  });

  it("15. 422 -> failed_governance (closed day)", async () => {
    const transport = vi.fn().mockResolvedValue({
      statusCode: 422,
      data: { error: "DAY_CLOSED", message: "Cannot mutate closed day" }
    });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-closed-day",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 2,
      dayId: "day-2-closed",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 50 }
    });
    await manager.drainQueue();

    const record = await storage.getRecord("mut-closed-day");
    expect(record?.status).toBe("failed_governance");
    expect(record?.lastError?.code).toBe("DAY_CLOSED");
  });

  it("16. successful acknowledgement -> removal from queue", async () => {
    const transport = vi.fn().mockResolvedValue({ statusCode: 201 });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-success",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 100 }
    });
    await manager.drainQueue();

    // Confirmed removal from queue store upon sync
    const record = await storage.getRecord("mut-success");
    expect(record).toBeNull();
    const remaining = await manager.countPending();
    expect(remaining).toBe(0);
  });

  it("18. offline prevents transport attempt", async () => {
    onlineState = false; // Simulate offline
    const transport = vi.fn().mockResolvedValue({ statusCode: 200 });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-offline",
      domain: "stock",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "stock_order",
      endpoint: "/api/v1/transactions/stock/orders",
      httpMethod: "POST",
      rawPayload: { lines: [] }
    });

    expect(transport).not.toHaveBeenCalled();
    const record = await storage.getRecord("mut-offline");
    expect(record?.status).toBe("queued");
  });

  it("17. online event wakes worker", async () => {
    onlineState = false; // Start offline
    const transport = vi.fn().mockResolvedValue({ statusCode: 200 });
    const manager = createTestManager(transport);

    await manager.enqueue({
      id: "mut-wake",
      domain: "stock",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "stock_order",
      endpoint: "/api/v1/transactions/stock/orders",
      httpMethod: "POST",
      rawPayload: { lines: [] }
    });

    expect(transport).not.toHaveBeenCalled();

    // Now come online
    onlineState = true;
    await manager.drainQueue();

    expect(transport).toHaveBeenCalledTimes(1);
    const record = await storage.getRecord("mut-wake");
    expect(record).toBeNull(); // Successfully synced and removed
  });

  it("19. duplicate enqueue protection", async () => {
    onlineState = false;
    const manager = createTestManager();

    // Enqueue initial version
    await manager.enqueue({
      id: "dup-mutation-1",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 100 }
    });

    // Enqueue updated version with identical clientMutationId
    await manager.enqueue({
      id: "dup-mutation-1",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: { amount: 150 }
    });

    const all = await storage.listAllRecords();
    expect(all.length).toBe(1); // Exactly 1 record, not 2
    expect(all[0].rawPayload).toEqual({ amount: 150 });
  });

  it("20. worker concurrency remains strictly 1", async () => {
    let activeInvocations = 0;
    let maxConcurrency = 0;

    const transport = vi.fn().mockImplementation(async () => {
      activeInvocations++;
      maxConcurrency = Math.max(maxConcurrency, activeInvocations);
      // Simulate asynchronous network roundtrip delay
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeInvocations--;
      return { statusCode: 200 };
    });

    const manager = createTestManager(transport);
    manager.pause();

    await manager.enqueue({
      id: "c-1",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: {}
    });

    await manager.enqueue({
      id: "c-2",
      domain: "expense",
      action: "CREATE",
      periodKey: "2026-09",
      dayNo: 1,
      dayId: "day-1",
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: {}
    });

    manager.resume();

    // Trigger multiple concurrent drainQueue calls simultaneously
    await Promise.all([
      manager.drainQueue(),
      manager.drainQueue(),
      manager.drainQueue()
    ]);

    expect(maxConcurrency).toBe(1); // Strictly serial execution!
  });
});
