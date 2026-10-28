/**
 * Phase 12B: Expense Domain Mutation Adapter
 *
 * Implements typed serializers, REST transport dispatch, and deterministic read-back for:
 * 1. Expense Items (`expense_item`)
 * 2. Commission Items (`commission_item`)
 * 3. Credit Party Transactions (`credit_transaction`)
 * 4. Owner Transactions (`owner_transaction`)
 *
 * ABSOLUTE ACCOUNTING RULE:
 * This adapter handles raw user facts ONLY. It never calculates cash balances,
 * operating profit, or credit party totals.
 */

import { ledgerApiClient } from "../../api/ledgerApiClient";
import type {
  MutationTransportResponse,
  QueuedMutationRecord
} from "../types";

export interface CreateExpenseParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  categoryId?: string | null;
  categoryNameSnapshot?: string;
  itemName: string;
  description?: string | null;
  amount: number;
}

export interface UpdateExpenseParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  categoryId?: string | null;
  itemName?: string;
  description?: string | null;
  amount?: number;
}

export interface CreateCommissionParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  categoryId?: string | null;
  categoryNameSnapshot?: string;
  amount: number;
}

export interface UpdateCommissionParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  categoryId?: string | null;
  amount?: number;
}

export interface CreateCreditParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  partyId: string;
  loanAmount?: number;
  receiptAmount?: number;
  manualAdjustment?: number;
  loanDescription?: string | null;
  receiveDescription?: string | null;
  notes?: string | null;
}

export interface UpdateCreditParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  partyId?: string;
  loanAmount?: number;
  receiptAmount?: number;
  manualAdjustment?: number;
  loanDescription?: string | null;
  receiveDescription?: string | null;
}

export interface CreateOwnerParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  description: string;
  amount: number;
}

export interface UpdateOwnerParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  description?: string;
  amount?: number;
}

export class ExpenseAdapter {
  // ---------------------------------------------------------------------------
  // 1. EXPENSE ITEMS SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateExpense(params: CreateExpenseParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "expense_item",
      endpoint: "/api/v1/transactions/expenses",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        category_id: params.categoryId ?? null,
        category_name_snapshot: params.categoryNameSnapshot,
        item_name: params.itemName.trim(),
        description: params.description ?? null,
        amount: Number(params.amount)
      }
    };
  }

  serializeUpdateExpense(params: UpdateExpenseParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "expense_item",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/expenses/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        category_id: params.categoryId ?? null,
        item_name: params.itemName?.trim(),
        description: params.description ?? null,
        amount: params.amount !== undefined ? Number(params.amount) : undefined
      }
    };
  }

  serializeDeleteExpense(params: {
    id?: string;
    entityId: string;
    dayId: string;
    dayNo: number;
    periodKey: string;
  }): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "expense_item",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/expenses/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // 2. COMMISSION ITEMS SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateCommission(params: CreateCommissionParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "commission_item",
      endpoint: "/api/v1/transactions/commissions",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        category_id: params.categoryId ?? null,
        category_name_snapshot: params.categoryNameSnapshot,
        amount: Number(params.amount)
      }
    };
  }

  serializeUpdateCommission(params: UpdateCommissionParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "commission_item",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/commissions/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        category_id: params.categoryId ?? null,
        amount: params.amount !== undefined ? Number(params.amount) : undefined
      }
    };
  }

  serializeDeleteCommission(params: {
    id?: string;
    entityId: string;
    dayId: string;
    dayNo: number;
    periodKey: string;
  }): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "commission_item",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/commissions/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // 3. CREDIT PARTY TRANSACTIONS SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateCredit(params: CreateCreditParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "credit_transaction",
      endpoint: "/api/v1/transactions/credits",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        party_id: params.partyId,
        loan_amount: Number(params.loanAmount ?? 0),
        receipt_amount: Number(params.receiptAmount ?? 0),
        manual_adjustment: Number(params.manualAdjustment ?? 0),
        loan_description: params.loanDescription ?? null,
        receive_description: params.receiveDescription ?? null,
        notes: params.notes ?? null
      }
    };
  }

  serializeUpdateCredit(params: UpdateCreditParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "credit_transaction",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/credits/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        party_id: params.partyId,
        loan_amount: params.loanAmount !== undefined ? Number(params.loanAmount) : undefined,
        receipt_amount: params.receiptAmount !== undefined ? Number(params.receiptAmount) : undefined,
        manual_adjustment: params.manualAdjustment !== undefined ? Number(params.manualAdjustment) : undefined,
        loan_description: params.loanDescription ?? null,
        receive_description: params.receiveDescription ?? null
      }
    };
  }

  serializeDeleteCredit(params: {
    id?: string;
    entityId: string;
    dayId: string;
    dayNo: number;
    periodKey: string;
  }): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "credit_transaction",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/credits/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // 4. OWNER TRANSACTIONS SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateOwner(params: CreateOwnerParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "owner_transaction",
      endpoint: "/api/v1/transactions/owner",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        description: params.description.trim(),
        amount: Number(params.amount)
      }
    };
  }

  serializeUpdateOwner(params: UpdateOwnerParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "owner_transaction",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/owner/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        description: params.description?.trim(),
        amount: params.amount !== undefined ? Number(params.amount) : undefined
      }
    };
  }

  serializeDeleteOwner(params: {
    id?: string;
    entityId: string;
    dayId: string;
    dayNo: number;
    periodKey: string;
  }): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "expense",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "owner_transaction",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/owner/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // TRANSPORT EXECUTION
  // ---------------------------------------------------------------------------

  async execute(record: QueuedMutationRecord): Promise<MutationTransportResponse> {
    switch (record.entityType) {
      case "expense_item": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.expenses.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "UPDATE") {
          const res = await ledgerApiClient.expenses.update(record.entityId!, record.rawPayload as any);
          return { statusCode: 200, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.expenses.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
      case "commission_item": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.commissions.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "UPDATE") {
          const res = await ledgerApiClient.commissions.update(record.entityId!, record.rawPayload as any);
          return { statusCode: 200, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.commissions.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
      case "credit_transaction": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.credits.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "UPDATE") {
          const res = await ledgerApiClient.credits.update(record.entityId!, record.rawPayload as any);
          return { statusCode: 200, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.credits.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
      case "owner_transaction": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.owner.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "UPDATE") {
          const res = await ledgerApiClient.owner.update(record.entityId!, record.rawPayload as any);
          return { statusCode: 200, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.owner.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
    }
    throw new Error(`Unsupported expense mutation: ${record.entityType} ${record.action}`);
  }

  // ---------------------------------------------------------------------------
  // READ-BACK FOR CONFLICT VERIFICATION
  // ---------------------------------------------------------------------------

  async readBack(record: QueuedMutationRecord): Promise<unknown | null> {
    try {
      if (!record.entityId) return null;
      switch (record.entityType) {
        case "expense_item": {
          const list = await ledgerApiClient.expenses.list(record.dayId);
          return list.data.find((item: any) => item.id === record.entityId) ?? null;
        }
        case "commission_item": {
          const list = await ledgerApiClient.commissions.list(record.dayId);
          return list.data.find((item: any) => item.id === record.entityId) ?? null;
        }
        case "credit_transaction": {
          const list = await ledgerApiClient.credits.list(record.dayId);
          return list.data.find((item: any) => item.id === record.entityId) ?? null;
        }
        case "owner_transaction": {
          const list = await ledgerApiClient.owner.list(record.dayId);
          return list.data.find((item: any) => item.id === record.entityId) ?? null;
        }
      }
    } catch {
      return null;
    }
    return null;
  }
}
