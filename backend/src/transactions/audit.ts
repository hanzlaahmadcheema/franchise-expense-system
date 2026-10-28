/**
 * Phase 5: Transaction Audit Logging Helper
 *
 * Records financial and ledger state mutations into the `audit_logs` table
 * within the active database transaction.
 */
import type { Transaction } from "kysely";
import type { Database } from "../db/types.js";

export interface RecordAuditParams {
  franchiseId: string;
  userId: string | null;
  userEmail: string | null;
  action: "CREATE" | "UPDATE" | "DELETE" | "REVERSE";
  entityType: string;
  entityId: string;
  beforeState?: unknown;
  afterState?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export async function recordAuditLog(
  trx: Transaction<Database>,
  params: RecordAuditParams
): Promise<void> {
  await trx
    .insertInto("audit_logs")
    .values({
      franchise_id: params.franchiseId,
      user_id: params.userId,
      user_email: params.userEmail,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      before_state: params.beforeState ? JSON.stringify(params.beforeState) : null,
      after_state: params.afterState ? JSON.stringify(params.afterState) : null,
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null
    })
    .execute();
}
