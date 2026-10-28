/**
 * Phase 12A: Core Offline Mutation Queue Types
 *
 * Defines the core contracts for the offline-first mutation queue:
 * - Queue record structure
 * - Queue lifecycle states
 * - Error classifications
 * - Storage engine interface
 * - Transport and worker contracts
 */

export type MutationQueueStatus =
  | "queued"
  | "sending"
  | "synced"
  | "conflict"
  | "failed_governance"
  | "failed_fatal"
  | "paused_auth";

export type MutationDomain = "expense" | "stock" | "jazzLoad";

export type MutationAction = "CREATE" | "UPDATE" | "DELETE";

export type MutationErrorCategory =
  | "TRANSIENT_NETWORK"
  | "AUTH_EXPIRED"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_REPLAY"
  | "GOVERNANCE_BLOCKED"
  | "FATAL_VALIDATION";

export interface MutationQueueError {
  message: string;
  code: string;
  status: number;
  category: MutationErrorCategory;
  timestamp: number;
  details?: unknown;
}

export interface QueuedMutationRecord {
  /** Stable client mutation identifier (UUID v4) */
  id: string;
  /** Stable idempotency key sent in X-Client-Mutation-Id and Idempotency-Key headers */
  idempotencyKey: string;
  /** Accounting domain */
  domain: MutationDomain;
  /** Mutation action */
  action: MutationAction;
  /** Accounting period key, e.g. "2026-09" */
  periodKey: string;
  /** Accounting day number, e.g. 1 */
  dayNo: number;
  /** PostgreSQL accounting day UUID */
  dayId: string;
  /** Target entity type, e.g. "expense_item", "stock_order", etc. */
  entityType: string;
  /** Existing entity UUID if update/delete */
  entityId?: string;
  /** Target REST endpoint path, e.g. "/api/v1/transactions/expenses" */
  endpoint: string;
  /** HTTP method */
  httpMethod: "POST" | "PATCH" | "DELETE";
  /** Raw operational facts (NOT derived calculations) */
  rawPayload: Record<string, unknown>;
  /** Optimistic concurrency revision for updates */
  baseRevision?: number;
  /** Timestamp when mutation was enqueued */
  createdAt: number;
  /** Timestamp when mutation was last modified */
  updatedAt: number;
  /** Number of transmission attempts */
  attemptCount: number;
  /** Earliest timestamp for next retry attempt */
  nextRetryAt: number;
  /** Last error encountered during execution */
  lastError?: MutationQueueError;
  /** Current state of the queued record */
  status: MutationQueueStatus;
  /** Optional metadata for client context */
  metadata?: Record<string, unknown>;
}

export interface MutationTransportResponse {
  statusCode: number;
  data?: unknown;
  headers?: Record<string, string>;
}

/** Function that dispatches a mutation to the backend REST API */
export type MutationTransportFn = (
  record: QueuedMutationRecord
) => Promise<MutationTransportResponse>;

/** Function that queries the backend to determine current entity state for conflict resolution */
export type MutationReadBackFn = (
  record: QueuedMutationRecord
) => Promise<unknown | null>;

/**
 * Abstract storage interface for the mutation queue.
 * Allows switching between IndexedDB in browsers and MemoryQueueStorage in unit tests.
 */
export interface IQueueStorage {
  initialize(): Promise<void>;
  close(): Promise<void>;
  putRecord(record: QueuedMutationRecord): Promise<void>;
  getRecord(id: string): Promise<QueuedMutationRecord | null>;
  deleteRecord(id: string): Promise<void>;
  listAllRecords(): Promise<QueuedMutationRecord[]>;
  listRecordsByStatus(status: MutationQueueStatus): Promise<QueuedMutationRecord[]>;
  peekNextEligible(now?: number): Promise<QueuedMutationRecord | null>;
  clearAll(): Promise<void>;
}

export type QueueEventType =
  | "enqueued"
  | "sending"
  | "synced"
  | "requeued"
  | "conflict"
  | "governance_blocked"
  | "fatal_error"
  | "auth_expired"
  | "drained"
  | "cleared";

export interface QueueEvent {
  type: QueueEventType;
  record?: QueuedMutationRecord;
  error?: MutationQueueError;
  timestamp: number;
}

export type QueueEventListener = (event: QueueEvent) => void;
