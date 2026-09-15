/**
 * Phase 5.1: Client Mutation Idempotency Helper
 *
 * Implements server-side idempotency for financial mutations.
 * Guarantees:
 * - Duplicate submissions with the same key return the original response
 * - Same key with materially different payload returns 409 IDEMPOTENCY_KEY_REUSED
 * - Atomic persistence with financial transaction
 * - Tenant isolation (keys scoped by franchise_id)
 */
import crypto from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/types.js";
import { IdempotencyConflictError } from "./errors.js";

function canonicalize(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
  const result: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    // Exclude client mutation identifier itself from the payload hash
    if (key === "client_mutation_id" || key === "clientMutationId") continue;
    result[key] = canonicalize((obj as Record<string, unknown>)[key]);
  }
  return result;
}

export function computePayloadHash(payload: unknown): string {
  const canonical = canonicalize(payload);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export interface IdempotencyCheckResult {
  isDuplicate: boolean;
  statusCode?: number;
  body?: unknown;
}

export async function checkIdempotency(
  dbOrTrx: Kysely<Database> | Transaction<Database>,
  franchiseId: string,
  clientMutationId: string,
  payloadHash: string
): Promise<IdempotencyCheckResult> {
  const existing = await dbOrTrx
    .selectFrom("mutation_idempotency")
    .selectAll()
    .where("franchise_id", "=", franchiseId)
    .where("client_mutation_id", "=", clientMutationId)
    .executeTakeFirst();

  if (!existing) {
    return { isDuplicate: false };
  }

  if (existing.request_hash !== payloadHash) {
    throw new IdempotencyConflictError("Idempotency key has already been used with a different request payload.");
  }

  return {
    isDuplicate: true,
    statusCode: existing.response_status,
    body: typeof existing.response_body === "string" ? JSON.parse(existing.response_body) : existing.response_body
  };
}

export async function saveIdempotencyRecord(
  trx: Transaction<Database>,
  params: {
    franchiseId: string;
    clientMutationId: string;
    userId: string | null;
    endpoint: string;
    payloadHash: string;
    responseStatus: number;
    responseBody: unknown;
  }
): Promise<void> {
  await trx
    .insertInto("mutation_idempotency")
    .values({
      franchise_id: params.franchiseId,
      client_mutation_id: params.clientMutationId,
      user_id: params.userId,
      endpoint: params.endpoint,
      request_hash: params.payloadHash,
      response_status: params.responseStatus,
      response_body: JSON.stringify(params.responseBody)
    })
    .execute();
}
