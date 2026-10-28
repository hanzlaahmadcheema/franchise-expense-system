/**
 * Phase 12A: Core Offline Mutation Queue Manager
 *
 * Implements the core synchronization worker:
 * - Durable FIFO execution
 * - Strict single-worker concurrency (concurrency = 1)
 * - Exponential backoff with jitter on transient failures
 * - Deterministic error classification
 * - Smart read-back verification on 409 revision conflicts for PATCH/DELETE
 * - Browser restart recovery (sending -> queued reset)
 * - Online/offline event detection and reactive wakeup
 * - Event emitter for UI status integration
 */

import { computeNextRetryAt } from "./backoff";
import {
  classifyError,
  toMutationQueueError,
  verifyPatchDeleteReadBack
} from "./errorClassifier";
import { IndexedDBQueueStorage } from "./storage";
import { createUnifiedTransport, createUnifiedReadBack } from "./adapters/unifiedTransport";
import type {
  IQueueStorage,
  MutationReadBackFn,
  MutationTransportFn,
  MutationTransportResponse,
  QueueEvent,
  QueueEventListener,
  QueuedMutationRecord
} from "./types";

export interface MutationQueueManagerOptions {
  storage?: IQueueStorage;
  transport?: MutationTransportFn;
  readBack?: MutationReadBackFn;
  autoStart?: boolean;
  onlineCheck?: () => boolean;
  randomFn?: () => number;
}

export class MutationQueueManager {
  private readonly storage: IQueueStorage;
  private transportFn?: MutationTransportFn;
  private readBackFn?: MutationReadBackFn;
  private readonly onlineCheck: () => boolean;
  private readonly randomFn: () => number;

  private isProcessing = false;
  private isPaused = false;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<QueueEventListener>();

  private onlineListener?: () => void;
  private offlineListener?: () => void;

  constructor(options?: MutationQueueManagerOptions) {
    this.storage = options?.storage ?? new IndexedDBQueueStorage();
    this.transportFn = options?.transport;
    this.readBackFn = options?.readBack;
    this.randomFn = options?.randomFn ?? Math.random;

    this.onlineCheck =
      options?.onlineCheck ??
      (() => (typeof navigator !== "undefined" ? navigator.onLine : true));

    if (options?.autoStart !== false) {
      this.attachNetworkListeners();
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle & Initialization
  // ---------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.storage.initialize();
    await this.recoverStaleSendingRecords();
    this.attachNetworkListeners();
  }

  async close(): Promise<void> {
    this.stopWorker();
    this.detachNetworkListeners();
    await this.storage.close();
  }

  setTransport(transport: MutationTransportFn): void {
    this.transportFn = transport;
  }

  setReadBack(readBack: MutationReadBackFn): void {
    this.readBackFn = readBack;
  }

  /**
   * Browser Restart Recovery:
   * Any mutation left in `sending` state due to an abrupt browser close / crash
   * is safely reset to `queued` so it can be evaluated or retried.
   */
  async recoverStaleSendingRecords(): Promise<void> {
    const sendingRecords = await this.storage.listRecordsByStatus("sending");
    for (const record of sendingRecords) {
      record.status = "queued";
      record.updatedAt = Date.now();
      await this.storage.putRecord(record);
      this.emit({ type: "requeued", record, timestamp: Date.now() });
    }
  }

  // ---------------------------------------------------------------------------
  // Network Listeners
  // ---------------------------------------------------------------------------

  private attachNetworkListeners(): void {
    if (typeof window === "undefined" || this.onlineListener) return;

    this.onlineListener = () => {
      this.resume();
      void this.drainQueue();
    };

    this.offlineListener = () => {
      // Pause worker loop when network disconnects
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
    };

    window.addEventListener("online", this.onlineListener);
    window.addEventListener("offline", this.offlineListener);
  }

  private detachNetworkListeners(): void {
    if (typeof window === "undefined") return;
    if (this.onlineListener) {
      window.removeEventListener("online", this.onlineListener);
      this.onlineListener = undefined;
    }
    if (this.offlineListener) {
      window.removeEventListener("offline", this.offlineListener);
      this.offlineListener = undefined;
    }
  }

  isOnline(): boolean {
    return this.onlineCheck();
  }

  // ---------------------------------------------------------------------------
  // Event Subscription
  // ---------------------------------------------------------------------------

  subscribe(listener: QueueEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: QueueEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[MutationQueueManager] Event listener threw error:", err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Enqueue & Mutation Management
  // ---------------------------------------------------------------------------

  /**
   * Enqueues a new mutation record.
   * If a record with the same clientMutationId already exists:
   * - If already synced: returns existing record without re-enqueueing.
   * - If queued or sending: updates raw payload without duplicating entry.
   */
  async enqueue(
    input: Omit<
      QueuedMutationRecord,
      "idempotencyKey" | "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
    > & {
      idempotencyKey?: string;
      createdAt?: number;
    }
  ): Promise<QueuedMutationRecord> {
    const existing = await this.storage.getRecord(input.id);
    const now = Date.now();

    if (existing) {
      if (existing.status === "synced") {
        return existing;
      }
      // Update in-flight payload while maintaining stable mutation identity
      existing.rawPayload = input.rawPayload;
      existing.updatedAt = now;
      if (input.baseRevision !== undefined) {
        existing.baseRevision = input.baseRevision;
      }
      await this.storage.putRecord(existing);
      this.emit({ type: "enqueued", record: existing, timestamp: now });
      void this.drainQueue();
      return existing;
    }

    const record: QueuedMutationRecord = {
      ...input,
      idempotencyKey: input.idempotencyKey ?? input.id, // Stable idempotency key
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      attemptCount: 0,
      nextRetryAt: now,
      status: "queued"
    };

    await this.storage.putRecord(record);
    this.emit({ type: "enqueued", record, timestamp: now });

    // Trigger worker if online
    if (this.isOnline()) {
      void this.drainQueue();
    }

    return record;
  }

  async getRecord(id: string): Promise<QueuedMutationRecord | null> {
    return this.storage.getRecord(id);
  }

  async listAll(): Promise<QueuedMutationRecord[]> {
    return this.storage.listAllRecords();
  }

  async listByStatus(status: QueuedMutationRecord["status"]): Promise<QueuedMutationRecord[]> {
    return this.storage.listRecordsByStatus(status);
  }

  async countPending(): Promise<number> {
    const queued = await this.storage.listRecordsByStatus("queued");
    const sending = await this.storage.listRecordsByStatus("sending");
    return queued.length + sending.length;
  }

  // ---------------------------------------------------------------------------
  // Worker Execution Loop (Single Serial Worker)
  // ---------------------------------------------------------------------------

  pause(): void {
    this.isPaused = true;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
  }

  resume(): void {
    this.isPaused = false;
  }

  getIsPaused(): boolean {
    return this.isPaused;
  }

  stopWorker(): void {
    this.pause();
  }

  private activeDrainPromise: Promise<void> | null = null;

  /**
   * Main FIFO worker drain loop.
   * Ensures STRICT CONCURRENCY = 1 via memory lock `isProcessing`.
   */
  async drainQueue(): Promise<void> {
    if (!this.isOnline() || this.isPaused) {
      return;
    }

    if (this.activeDrainPromise) {
      return this.activeDrainPromise;
    }

    this.activeDrainPromise = this.runDrainLoop().finally(() => {
      this.activeDrainPromise = null;
    });

    return this.activeDrainPromise;
  }

  private async runDrainLoop(): Promise<void> {
    this.isProcessing = true;

    try {
      while (!this.isPaused && this.isOnline()) {
        const record = await this.storage.peekNextEligible(Date.now());
        if (!record) {
          // Check if there are future-scheduled retries
          const queued = await this.storage.listRecordsByStatus("queued");
          if (queued.length > 0) {
            // Find minimum nextRetryAt among queued items
            const minRetryAt = Math.min(...queued.map((r) => r.nextRetryAt));
            const waitDelay = Math.max(minRetryAt - Date.now(), 50);
            this.scheduleNextDrain(waitDelay);
          } else {
            this.emit({ type: "drained", timestamp: Date.now() });
          }
          break;
        }

        const shouldContinue = await this.processRecord(record);
        if (!shouldContinue) {
          break;
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  private scheduleNextDrain(delayMs: number): void {
    if (this.timerId) clearTimeout(this.timerId);
    this.timerId = setTimeout(() => {
      this.timerId = null;
      void this.drainQueue();
    }, delayMs);
  }

  /**
   * Processes a single queued record.
   * Returns true if worker can safely proceed to the next item in the queue.
   */
  private async processRecord(record: QueuedMutationRecord): Promise<boolean> {
    if (!this.transportFn) {
      console.warn("[MutationQueueManager] Transport function not configured. Skipping drain.");
      return false;
    }

    // 1. Mark status as sending
    record.status = "sending";
    record.attemptCount += 1;
    record.updatedAt = Date.now();
    await this.storage.putRecord(record);
    this.emit({ type: "sending", record, timestamp: Date.now() });

    try {
      // 2. Dispatch via transport
      const response: MutationTransportResponse = await this.transportFn(record);

      // 3. Success acknowledgement (HTTP 200/201)
      if (response.statusCode >= 200 && response.statusCode < 300) {
        await this.handleSuccess(record);
        return true;
      }

      // Handle non-2xx status returned as response object
      return await this.handleErrorResponse(record, {
        status: response.statusCode,
        message: `HTTP ${response.statusCode}`,
        code: `HTTP_${response.statusCode}`
      });
    } catch (err: unknown) {
      return await this.handleErrorResponse(record, err);
    }
  }

  private async handleSuccess(record: QueuedMutationRecord): Promise<void> {
    record.status = "synced";
    record.updatedAt = Date.now();
    this.emit({ type: "synced", record, timestamp: Date.now() });

    // Approved requirement: Synced queue items are deleted after confirmed acknowledgement
    await this.storage.deleteRecord(record.id);
  }

  private async handleErrorResponse(
    record: QueuedMutationRecord,
    error: unknown
  ): Promise<boolean> {
    const classification = classifyError(error);
    const queueError = toMutationQueueError(error);
    record.lastError = queueError;
    record.updatedAt = Date.now();

    // Case 1: Transient Network Failure -> Requeue with Exponential Backoff
    if (classification.category === "TRANSIENT_NETWORK") {
      record.status = "queued";
      record.nextRetryAt = computeNextRetryAt(
        record.attemptCount,
        Date.now(),
        this.randomFn
      );
      await this.storage.putRecord(record);
      this.emit({ type: "requeued", record, error: queueError, timestamp: Date.now() });

      // Halt current loop; schedule wakeup at nextRetryAt
      const delay = Math.max(record.nextRetryAt - Date.now(), 50);
      this.scheduleNextDrain(delay);
      return false;
    }

    // Case 2: Concurrency / Revision Conflict (409)
    if (classification.category === "REVISION_CONFLICT") {
      // PATCH/DELETE REQUIREMENT: Do not guess. Check if already applied via read-back.
      if (
        (record.action === "UPDATE" || record.action === "DELETE") &&
        this.readBackFn
      ) {
        try {
          const serverEntity = await this.readBackFn(record);
          const verification = verifyPatchDeleteReadBack(record, serverEntity);

          if (verification.isAlreadyApplied) {
            // Scenario B: request committed but response was lost! Acknowledge as synced.
            await this.handleSuccess(record);
            return true;
          }
        } catch (readBackErr) {
          console.warn("[MutationQueueManager] Read-back verification failed:", readBackErr);
        }
      }

      // Genuine conflict or unverified -> Surface explicit conflict state
      record.status = "conflict";
      await this.storage.putRecord(record);
      this.emit({ type: "conflict", record, error: queueError, timestamp: Date.now() });
      
      // Stop worker for dependent work
      this.pause();
      return false;
    }

    // Case 3: Governance / Closed Day (422)
    if (classification.category === "GOVERNANCE_BLOCKED") {
      record.status = "failed_governance";
      await this.storage.putRecord(record);
      this.emit({ type: "governance_blocked", record, error: queueError, timestamp: Date.now() });
      this.pause();
      return false;
    }

    // Case 4: Auth Expiry (401)
    if (classification.category === "AUTH_EXPIRED") {
      record.status = "paused_auth";
      await this.storage.putRecord(record);
      this.emit({ type: "auth_expired", record, error: queueError, timestamp: Date.now() });
      this.pause();
      return false;
    }

    // Case 5: Fatal Validation (400, 403, 404, etc.)
    record.status = "failed_fatal";
    await this.storage.putRecord(record);
    this.emit({ type: "fatal_error", record, error: queueError, timestamp: Date.now() });
    
    // Stop worker to prevent cascading failures
    this.pause();
    return false;
  }

  // ---------------------------------------------------------------------------
  // Manual Actions / Resolvers
  // ---------------------------------------------------------------------------

  /**
   * Manually re-queues an item that was in conflict or governance failure
   * (e.g. after the user resolved the conflict or owner reopened the day).
   */
  async retryItem(id: string, updatedPayload?: Record<string, unknown>, updatedBaseRevision?: number): Promise<void> {
    const record = await this.storage.getRecord(id);
    if (!record) throw new Error(`Mutation record ${id} not found.`);

    if (updatedPayload) {
      record.rawPayload = updatedPayload;
    }
    if (updatedBaseRevision !== undefined) {
      record.baseRevision = updatedBaseRevision;
    }

    record.status = "queued";
    record.nextRetryAt = Date.now();
    record.updatedAt = Date.now();
    await this.storage.putRecord(record);

    this.resume();
    void this.drainQueue();
  }

  /**
   * Discards a failed or conflicting mutation from the queue.
   */
  async discardItem(id: string): Promise<void> {
    await this.storage.deleteRecord(id);
    this.emit({ type: "cleared", timestamp: Date.now() });
    this.resume();
    void this.drainQueue();
  }

  /**
   * Retries all items in conflict, governance, or fatal failure by resetting them to queued.
   */
  async retryAllEligible(): Promise<void> {
    const all = await this.storage.listAllRecords();
    let count = 0;
    const now = Date.now();
    for (const record of all) {
      if (
        record.status === "conflict" ||
        record.status === "failed_governance" ||
        record.status === "failed_fatal" ||
        record.status === "paused_auth" ||
        record.status === "queued"
      ) {
        record.status = "queued";
        record.nextRetryAt = now;
        record.updatedAt = now;
        await this.storage.putRecord(record);
        count++;
      }
    }
    if (count > 0) {
      this.resume();
      void this.drainQueue();
    }
  }

  async clearQueue(): Promise<void> {
    await this.storage.clearAll();
    this.emit({ type: "cleared", timestamp: Date.now() });
  }
}

let activeQueueManager: MutationQueueManager | null = null;

export function getActiveQueueManager(): MutationQueueManager {
  if (!activeQueueManager) {
    activeQueueManager = new MutationQueueManager({
      transport: createUnifiedTransport(),
      readBack: createUnifiedReadBack()
    });
  }
  return activeQueueManager;
}

export function setActiveQueueManager(manager: MutationQueueManager | null): void {
  activeQueueManager = manager;
}

