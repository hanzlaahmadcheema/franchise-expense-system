/**
 * Phase 12A: Mutation Error Classification & Read-Back Verification
 *
 * Classifies HTTP and network errors into deterministic categories.
 * Implements deterministic read-back verification for PATCH and DELETE operations
 * to distinguish lost responses from genuine revision conflicts.
 */

import type {
  MutationErrorCategory,
  MutationQueueError,
  QueuedMutationRecord
} from "./types";

export interface ErrorClassificationResult {
  category: MutationErrorCategory;
  statusCode: number;
  errorCode: string;
  message: string;
  isRetriable: boolean;
}

/**
 * Classifies any thrown error into a normalized classification result.
 */
export function classifyError(error: unknown): ErrorClassificationResult {
  let status = 0;
  let code = "UNKNOWN_ERROR";
  let message = "An unknown error occurred.";

  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown>;
    if (typeof err.status === "number") status = err.status;
    if (typeof err.code === "string") code = err.code;
    if (typeof err.message === "string") message = err.message;
    if (typeof err.name === "string" && !code) code = err.name;
  } else if (typeof error === "string") {
    message = error;
  }

  // 1. Transient Network Failures
  const lowerMsg = message.toLowerCase();
  const isNetworkString =
    lowerMsg.includes("network error") ||
    lowerMsg.includes("failed to fetch") ||
    lowerMsg.includes("networkrequestfailed") ||
    lowerMsg.includes("connection reset") ||
    lowerMsg.includes("connection refused") ||
    lowerMsg.includes("timeout");

  if (
    status === 0 ||
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    code === "NETWORK_ERROR" ||
    isNetworkString
  ) {
    return {
      category: "TRANSIENT_NETWORK",
      statusCode: status,
      errorCode: code === "UNKNOWN_ERROR" ? "NETWORK_ERROR" : code,
      message,
      isRetriable: true
    };
  }

  // 2. Authentication Expiry (401)
  if (status === 401 || code === "UNAUTHORIZED" || code === "TOKEN_EXPIRED" || code === "TOKEN_INVALID") {
    return {
      category: "AUTH_EXPIRED",
      statusCode: 401,
      errorCode: code,
      message,
      isRetriable: false // Worker pauses until auth is refreshed
    };
  }

  // 3. Accounting Day / Governance Blocker (422)
  if (status === 422 || code === "DAY_CLOSED" || lowerMsg.includes("closed accounting day")) {
    return {
      category: "GOVERNANCE_BLOCKED",
      statusCode: 422,
      errorCode: "DAY_CLOSED",
      message,
      isRetriable: false
    };
  }

  // 4. Concurrency / Revision Conflict (409)
  if (status === 409 || code === "REVISION_CONFLICT" || code === "IDEMPOTENCY_KEY_REUSED") {
    return {
      category: "REVISION_CONFLICT",
      statusCode: 409,
      errorCode: code,
      message,
      isRetriable: false
    };
  }

  // 5. Fatal Client Errors (400, 403, 404, etc.)
  if (status >= 400 && status < 500) {
    return {
      category: "FATAL_VALIDATION",
      statusCode: status,
      errorCode: code,
      message,
      isRetriable: false
    };
  }

  // 6. Generic Server Failures (500)
  return {
    category: "TRANSIENT_NETWORK", // Treat 500 as transient server glitch eligible for backoff
    statusCode: status || 500,
    errorCode: code,
    message,
    isRetriable: true
  };
}

export function toMutationQueueError(error: unknown): MutationQueueError {
  const result = classifyError(error);
  return {
    message: result.message,
    code: result.errorCode,
    status: result.statusCode,
    category: result.category,
    timestamp: Date.now()
  };
}

export interface ReadBackVerificationResult {
  /** True if deterministic read-back proves the mutation has already taken effect */
  isAlreadyApplied: boolean;
  /** True if a genuine conflict occurred with different server data */
  isConflict: boolean;
  /** Explanatory description for UI and audit logs */
  reason: string;
}

/**
 * Deterministically checks whether a PATCH or DELETE mutation that returned 409
 * or failed with lost response was actually committed before the failure.
 *
 * Scenarios:
 * A. Request never committed -> false, isConflict: true
 * B. Request committed but response was lost -> true, isConflict: false (Safe to mark synced)
 * C. Genuine concurrent modification -> false, isConflict: true (Surface manual conflict)
 */
export function verifyPatchDeleteReadBack(
  record: QueuedMutationRecord,
  serverEntity: unknown | null
): ReadBackVerificationResult {
  if (record.action === "DELETE") {
    // If entity is null/undefined or not found on server, the DELETE was already applied!
    if (serverEntity === null || serverEntity === undefined) {
      return {
        isAlreadyApplied: true,
        isConflict: false,
        reason: "Entity no longer exists on server. Delete operation was previously committed."
      };
    }
    // If entity still exists, the delete was NOT applied
    return {
      isAlreadyApplied: false,
      isConflict: true,
      reason: "Entity still exists on server. Delete operation was not committed."
    };
  }

  if (record.action === "UPDATE") {
    if (serverEntity === null || typeof serverEntity !== "object") {
      return {
        isAlreadyApplied: false,
        isConflict: true,
        reason: "Entity not found on server during read-back verification."
      };
    }

    const serverObj = serverEntity as Record<string, unknown>;
    const serverRevision = Number(serverObj.revision ?? serverObj.baseRevision ?? 0);
    const expectedRevision = record.baseRevision !== undefined ? record.baseRevision + 1 : undefined;

    // If server revision matches baseRevision + 1, verify that payload fields match
    if (expectedRevision !== undefined && serverRevision === expectedRevision) {
      let fieldsMatch = true;
      for (const [key, expectedVal] of Object.entries(record.rawPayload)) {
        // Skip revision markers in payload comparison
        if (key === "base_revision" || key === "baseRevision") continue;
        
        const serverVal = serverObj[key];
        // Compare with loose equality for numbers/strings (e.g. 10.00 vs 10)
        if (typeof expectedVal === "number" && typeof serverVal === "number") {
          if (Math.abs(expectedVal - serverVal) > 0.0001) {
            fieldsMatch = false;
            break;
          }
        } else if (serverVal !== expectedVal) {
          fieldsMatch = false;
          break;
        }
      }

      if (fieldsMatch) {
        return {
          isAlreadyApplied: true,
          isConflict: false,
          reason: "Server entity matches payload and is at expected revision. Update was previously committed."
        };
      }
    }

    // Revision is different, or fields do not match -> Genuine concurrent conflict
    return {
      isAlreadyApplied: false,
      isConflict: true,
      reason: `Server record revision is ${serverRevision} (expected ${expectedRevision ?? "unknown"}). Concurrent modification detected.`
    };
  }

  // CREATE mutations use server-side idempotency table, not read-back
  return {
    isAlreadyApplied: false,
    isConflict: false,
    reason: "Read-back not applicable for CREATE mutations."
  };
}
