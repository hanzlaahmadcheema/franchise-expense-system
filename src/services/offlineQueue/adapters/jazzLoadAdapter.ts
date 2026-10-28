/**
 * Phase 12B: Jazz Load Domain Mutation Adapter
 *
 * Implements typed serializers, REST transport dispatch, and deterministic read-back for:
 * 8. Jazz Lifting Records (`jazz_lifting`)
 * 9. Jazz DO Entries (`jazz_do_entry`)
 * 10. Jazz Company Payable Payments (`jazz_company_payment`)
 *
 * ABSOLUTE ACCOUNTING RULE:
 * This adapter handles raw user facts ONLY. It never calculates Jazz in-hand lifting,
 * commission amounts, Jazz DO closing balances, or Jazz Company payable balances.
 */

import { ledgerApiClient } from "../../api/ledgerApiClient";
import type {
  MutationTransportResponse,
  QueuedMutationRecord
} from "../types";

export interface CreateJazzLiftingParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  mlLiftingAmount: number;
}

export interface UpdateJazzLiftingParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  mlLiftingAmount: number;
}

export interface CreateJazzDoParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  doProfileId: string;
  issuanceBase?: number;
  paymentBase?: number;
}

export interface UpdateJazzDoParams {
  id?: string;
  entityId: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  baseRevision: number;
  doProfileId: string;
  issuanceBase?: number;
  paymentBase?: number;
}

export interface CreateJazzCompanyPaymentParams {
  id?: string;
  dayId: string;
  dayNo: number;
  periodKey: string;
  amount: number;
  paymentReference?: string | null;
  notes?: string | null;
}

export class JazzLoadAdapter {
  // ---------------------------------------------------------------------------
  // 8. JAZZ LIFTING SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateLifting(params: CreateJazzLiftingParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "jazzLoad",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_lifting",
      endpoint: "/api/v1/transactions/jazz-load/lifting",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        ml_lifting_amount: Number(params.mlLiftingAmount)
      }
    };
  }

  serializeUpdateLifting(params: UpdateJazzLiftingParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "jazzLoad",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_lifting",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/jazz-load/lifting/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        ml_lifting_amount: Number(params.mlLiftingAmount)
      }
    };
  }

  serializeDeleteLifting(params: {
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
      domain: "jazzLoad",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_lifting",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/jazz-load/lifting/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // 9. JAZZ DO ENTRIES SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateDoEntry(params: CreateJazzDoParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "jazzLoad",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_do_entry",
      endpoint: "/api/v1/transactions/jazz-load/do",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        do_profile_id: params.doProfileId,
        issuance_base: Number(params.issuanceBase ?? 0),
        payment_base: Number(params.paymentBase ?? 0)
      }
    };
  }

  serializeUpdateDoEntry(params: UpdateJazzDoParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "jazzLoad",
      action: "UPDATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_do_entry",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/jazz-load/do/${params.entityId}`,
      httpMethod: "PATCH",
      baseRevision: params.baseRevision,
      rawPayload: {
        base_revision: params.baseRevision,
        baseRevision: params.baseRevision,
        do_profile_id: params.doProfileId,
        issuance_base: params.issuanceBase !== undefined ? Number(params.issuanceBase) : undefined,
        payment_base: params.paymentBase !== undefined ? Number(params.paymentBase) : undefined
      }
    };
  }

  serializeDeleteDoEntry(params: {
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
      domain: "jazzLoad",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_do_entry",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/jazz-load/do/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // 10. JAZZ COMPANY PAYABLE PAYMENTS SERIALIZATION
  // ---------------------------------------------------------------------------

  serializeCreateCompanyPayment(params: CreateJazzCompanyPaymentParams): Omit<
    QueuedMutationRecord,
    "createdAt" | "updatedAt" | "attemptCount" | "nextRetryAt" | "status"
  > {
    const id = params.id ?? crypto.randomUUID();
    return {
      id,
      idempotencyKey: id,
      domain: "jazzLoad",
      action: "CREATE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_company_payment",
      endpoint: "/api/v1/transactions/jazz-company/payments",
      httpMethod: "POST",
      rawPayload: {
        client_mutation_id: id,
        day_id: params.dayId,
        amount: Number(params.amount),
        payment_reference: params.paymentReference ?? null,
        notes: params.notes ?? null
      }
    };
  }

  serializeDeleteCompanyPayment(params: {
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
      domain: "jazzLoad",
      action: "DELETE",
      periodKey: params.periodKey,
      dayNo: params.dayNo,
      dayId: params.dayId,
      entityType: "jazz_company_payment",
      entityId: params.entityId,
      endpoint: `/api/v1/transactions/jazz-company/payments/${params.entityId}`,
      httpMethod: "DELETE",
      rawPayload: {}
    };
  }

  // ---------------------------------------------------------------------------
  // TRANSPORT EXECUTION
  // ---------------------------------------------------------------------------

  async execute(record: QueuedMutationRecord): Promise<MutationTransportResponse> {
    switch (record.entityType) {
      case "jazz_lifting": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.jazzLifting.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "UPDATE") {
          const res = await ledgerApiClient.jazzLifting.update(record.entityId!, record.rawPayload as any);
          return { statusCode: 200, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.jazzLifting.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
      case "jazz_do_entry": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.jazzDo.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "UPDATE") {
          const res = await ledgerApiClient.jazzDo.update(record.entityId!, record.rawPayload as any);
          return { statusCode: 200, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.jazzDo.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
      case "jazz_company_payment": {
        if (record.action === "CREATE") {
          const res = await ledgerApiClient.jazzCompanyPayments.create(record.rawPayload as any, record.idempotencyKey);
          return { statusCode: 201, data: res.data };
        }
        if (record.action === "DELETE") {
          const res = await ledgerApiClient.jazzCompanyPayments.delete(record.entityId!);
          return { statusCode: 200, data: res };
        }
        break;
      }
    }

    throw new Error(`Unsupported jazzLoad mutation: ${record.entityType} ${record.action}`);
  }

  // ---------------------------------------------------------------------------
  // READ-BACK FOR CONFLICT VERIFICATION
  // ---------------------------------------------------------------------------

  async readBack(record: QueuedMutationRecord): Promise<unknown | null> {
    try {
      if (!record.entityId) return null;
      if (record.entityType === "jazz_lifting") {
        const list = await ledgerApiClient.jazzLifting.list(record.dayId);
        return list.data.find((item: any) => item.id === record.entityId) ?? null;
      }
      if (record.entityType === "jazz_do_entry") {
        const list = await ledgerApiClient.jazzDo.list(record.dayId);
        return list.data.find((item: any) => item.id === record.entityId) ?? null;
      }
      if (record.entityType === "jazz_company_payment") {
        const list = await ledgerApiClient.jazzCompanyPayments.list(record.dayId);
        return list.data.find((item: any) => item.id === record.entityId) ?? null;
      }
    } catch {
      return null;
    }
    return null;
  }
}
