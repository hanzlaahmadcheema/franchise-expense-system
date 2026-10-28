/**
 * Phase 12B: Stock Domain Mutation Adapter
 *
 * Implements typed serializers, REST transport dispatch, and deterministic read-back for:
 * 5. Stock Inbound Orders (`stock_order_inbound`)
 * 6. Stock Outbound Orders (`stock_order_outbound`)
 * 7. Stock Account Payments (`stock_account_payment`)
 *
 * ABSOLUTE ACCOUNTING RULE:
 * This adapter handles raw user facts ONLY. It never calculates stock physical
 * inventory, closing balances, or account closing dues.
 */

import { ledgerApiClient } from "../../api/ledgerApiClient";
import type {
  MutationTransportResponse,
  QueuedMutationRecord
} from "../types";

export interface StockOrderLineParam {
  productId: string;
  quantity: number;
  unitRate: number;
}

export interface CreateStockInParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  supplierName?: string;
  notes?: string | null;
  lines: StockOrderLineParam[];
}

export interface CreateStockOutParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  accountId: string;
  notes?: string | null;
  lines: StockOrderLineParam[];
}

export interface UpdateStockOutParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  accountId: string;
  notes?: string | null;
  lines: StockOrderLineParam[];
}

export interface CreateStockPaymentParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  accountId: string;
  amount: number;
  paymentMethod?: string;
  notes?: string | null;
}

export interface UpdateStockPaymentParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  accountId: string;
  amount: number;
  notes?: string | null;
}

export class StockAdapter {
  // ---------------------------------------------------------------------------
  // 5. STOCK IN SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateStockIn(params: CreateStockInParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "stock",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_order_inbound",
      endpoint: "/api/v1/transactions/stock/orders",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        direction: "inbound",
        supplier_name: params.supplierName ?? "Jazz Company",
        notes: params.notes ?? null,
        lines: params.lines.map((l) => ({
          product_id: l.productId,
          quantity: Math.round(Number(l.quantity)),
          unit_rate: Number(l.unitRate)
        }))
      }
    };
  }

  // ---------------------------------------------------------------------------
  // 6. STOCK OUT SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateStockOut(params: CreateStockOutParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "stock",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_order_outbound",
      endpoint: "/api/v1/transactions/stock/orders",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        direction: "outbound",
        account_id: params.accountId,
        notes: params.notes ?? null,
        lines: params.lines.map((l) => ({
          product_id: l.productId,
          quantity: Math.round(Number(l.quantity)),
          unit_rate: Number(l.unitRate)
        }))
      }
    };
  }

  serializeUpdateStockOut(params: UpdateStockOutParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "stock",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_order_outbound",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/stock/orders/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        direction: "outbound",
        account_id: params.accountId,
        notes: params.notes ?? null,
        lines: params.lines.map((l) => ({
          product_id: l.productId,
          quantity: Math.round(Number(l.quantity)),
          unit_rate: Number(l.unitRate)
        }))
      }
    };
  }

  serializeDeleteStockOut(params: {
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
      domain: "stock",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_order_outbound",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/stock/orders/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // 7. STOCK ACCOUNT PAYMENTS SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateStockPayment(params: CreateStockPaymentParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "stock",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_account_payment",
      endpoint: "/api/v1/transactions/stock/account-payments",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        account_id: params.accountId,
        amount: Number(params.amount),
        payment_method: params.paymentMethod ?? "cash",
        notes: params.notes ?? null
      }
    };
  }

  serializeUpdateStockPayment(params: UpdateStockPaymentParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "stock",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_account_payment",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/stock/account-payments/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        account_id: params.accountId,
        amount: Number(params.amount),
        notes: params.notes ?? null
      }
    };
  }

  serializeDeleteStockPayment(params: {
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
      domain: "stock",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "stock_account_payment",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/stock/account-payments/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // TRANSPORT EXECUTION
  // ---------------------------------------------------------------------------

  async execute(record: QueuedMutationRecord): Promise<MutationTransportResponse> {
    if (record.entityType === "stock_order_inbound" || record.entityType === "stock_order_outbound") {
      if (record.action === "CREATE") {
        const res = await ledgerApiClient.stockOrders.create(record.rawPayload as any, record.idempotencyKey);
        return { statusCode: 201, data: res.data };
      }
      if (record.action === "UPDATE") {
        const res = await ledgerApiClient.stockOrders.update(record.entityId!, record.rawPayload as any);
        return { statusCode: 200, data: res.data };
      }
      if (record.action === "DELETE") {
        const res = await ledgerApiClient.stockOrders.delete(record.entityId!);
        return { statusCode: 200, data: res };
      }
    }

    if (record.entityType === "stock_account_payment") {
      if (record.action === "CREATE") {
        const res = await ledgerApiClient.stockPayments.create(record.rawPayload as any, record.idempotencyKey);
        return { statusCode: 201, data: res.data };
      }
      if (record.action === "UPDATE") {
        const res = await ledgerApiClient.stockPayments.update(record.entityId!, record.rawPayload as any);
        return { statusCode: 200, data: res.data };
      }
      if (record.action === "DELETE") {
        const res = await ledgerApiClient.stockPayments.delete(record.entityId!);
        return { statusCode: 200, data: res };
      }
    }

    throw new Error(`Unsupported stock mutation: ${record.entityType} ${record.action}`);
  }

  // ---------------------------------------------------------------------------
  // READ-BACK FOR CONFLICT VERIFICATION
  // ---------------------------------------------------------------------------

  async readBack(record: QueuedMutationRecord): Promise<unknown | null> {
    try {
      if (!record.entityId) return null;
      if (record.entityType.startsWith("stock_order")) {
        const list = await ledgerApiClient.stockOrders.list(record.dayId);
        return list.data.find((item: any) => item.id === record.entityId) ?? null;
      }
      if (record.entityType === "stock_account_payment") {
        const list = await ledgerApiClient.stockPayments.list(record.dayId);
        return list.data.find((item: any) => item.id === record.entityId) ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }
}
