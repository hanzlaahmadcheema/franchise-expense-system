/**
 * Phase 8B: PostgreSQL Ledger REST API Client
 *
 * Provides type-safe access to backend `/api/v1` REST endpoints:
 * - Operational Transactions (all 9 domain types)
 * - Accounting Periods & Days
 * - Server-Authoritative Calculations & Projections
 * - Master Catalogs
 *
 * Enforces client mutation idempotency and baseRevision concurrency tracking.
 */

import { auth } from "../../lib/firebase";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(message: string, status: number, code: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface RequestOptions extends RequestInit {
  idempotencyKey?: string;
  franchiseId?: string;
}

const BASE_URL = "";

let authTokenProvider: (() => Promise<string | null>) | null = null;

export function setAuthTokenProvider(provider: (() => Promise<string | null>) | null): void {
  authTokenProvider = provider;
}

export async function getAuthToken(): Promise<string | null> {
  try {
    if (authTokenProvider) {
      const token = await authTokenProvider();
      if (token) return token;
    }
    if (typeof window !== "undefined") {
      const localToken = localStorage.getItem("franchise_local_session_token");
      if (localToken) return localToken;
    }
    if (!auth) return null;
    if (typeof (auth as any).authStateReady === "function") {
      await (auth as any).authStateReady();
    }
    const user = auth.currentUser;
    if (!user) return null;
    return await user.getIdToken();
  } catch {
    return null;
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<T> {
  const { idempotencyKey, franchiseId, headers: customHeaders, ...restOptions } = options;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(customHeaders as Record<string, string>)
  };

  if (restOptions.body && typeof restOptions.body === "string") {
    headers["Content-Type"] = "application/json";
  }

  const token = await getAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (idempotencyKey) {
    headers["X-Client-Mutation-Id"] = idempotencyKey;
    headers["Idempotency-Key"] = idempotencyKey;
  }

  if (franchiseId) {
    headers["X-Franchise-Id"] = franchiseId;
  }

  const url = `${BASE_URL}${endpoint}`;
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...restOptions, headers });
  } catch (netErr) {
    throw new ApiError(
      netErr instanceof Error ? netErr.message : "Network error connecting to API server",
      0,
      "NETWORK_ERROR"
    );
  }

  let data: any;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    data = await response.text();
  }

  if (!response.ok) {
    const errorMessage =
      (typeof data === "object" && data && (data.message || data.error)) ||
      `Request failed with status ${response.status}`;
    const errorCode =
      (typeof data === "object" && data && (data.code || data.error)) ||
      `HTTP_${response.status}`;
    throw new ApiError(errorMessage, response.status, errorCode, data?.details);
  }

  return data as T;
}

// ---------------------------------------------------------------------------
// Transaction Types & Endpoints
// ---------------------------------------------------------------------------

export interface ExpenseItemPayload {
  client_mutation_id?: string;
  day_id: string;
  category_id?: string | null;
  category_name_snapshot?: string;
  item_name: string;
  description?: string | null;
  amount: number;
}

export interface ExpenseItemUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  category_id?: string | null;
  item_name?: string;
  description?: string | null;
  amount?: number;
}

export interface CommissionItemPayload {
  client_mutation_id?: string;
  day_id: string;
  category_id?: string | null;
  category_name_snapshot?: string;
  amount: number;
}

export interface CommissionItemUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  category_id?: string | null;
  amount?: number;
}

export interface CreditTransactionPayload {
  client_mutation_id?: string;
  day_id: string;
  party_id: string;
  loan_amount?: number;
  receipt_amount?: number;
  manual_adjustment?: number;
  loan_description?: string | null;
  receive_description?: string | null;
  notes?: string | null;
}

export interface CreditTransactionUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  party_id?: string;
  loan_amount?: number;
  receipt_amount?: number;
  manual_adjustment?: number;
  loan_description?: string | null;
  receive_description?: string | null;
  notes?: string | null;
}

export interface OwnerTransactionPayload {
  client_mutation_id?: string;
  day_id: string;
  description: string;
  amount: number;
  notes?: string | null;
}

export interface OwnerTransactionUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  description?: string;
  amount?: number;
  notes?: string | null;
}

export interface StockOrderLineInput {
  product_id: string;
  quantity: number;
  unit_rate?: number;
}

export interface StockOrderPayload {
  client_mutation_id?: string;
  day_id: string;
  direction: "inbound" | "outbound";
  account_id?: string | null;
  supplier_name?: string | null;
  invoice_reference?: string | null;
  notes?: string | null;
  lines: StockOrderLineInput[];
}

export interface StockOrderUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  direction?: "inbound" | "outbound";
  account_id?: string | null;
  supplier_name?: string | null;
  invoice_reference?: string | null;
  notes?: string | null;
  lines?: StockOrderLineInput[];
}

export interface StockAccountPaymentPayload {
  client_mutation_id?: string;
  day_id: string;
  account_id: string;
  amount: number;
  payment_method?: string;
  notes?: string | null;
}

export interface StockAccountPaymentUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  account_id?: string;
  amount?: number;
  payment_method?: string;
  notes?: string | null;
}

export interface JazzLiftingPayload {
  client_mutation_id?: string;
  day_id: string;
  ml_lifting_amount: number;
  notes?: string | null;
}

export interface JazzLiftingUpdatePayload {
  ml_lifting_amount?: number;
  notes?: string | null;
}

export interface JazzDoEntryPayload {
  client_mutation_id?: string;
  day_id: string;
  do_profile_id: string;
  issuance_base?: number;
  payment_base?: number;
  notes?: string | null;
}

export interface JazzDoEntryUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  do_profile_id?: string;
  issuance_base?: number;
  payment_base?: number;
  notes?: string | null;
}

export interface JazzPayablePaymentPayload {
  client_mutation_id?: string;
  day_id: string;
  amount: number;
  payment_reference?: string | null;
  notes?: string | null;
}

export interface JazzPayablePaymentUpdatePayload {
  base_revision?: number;
  baseRevision?: number;
  amount?: number;
  payment_reference?: string | null;
  notes?: string | null;
}

// ---------------------------------------------------------------------------
// Projection & Calculation Types
// ---------------------------------------------------------------------------

export interface DayFinancialProjection {
  day_id: string;
  franchise_id: string;
  opening_cash: string | number;
  total_commissions: string | number;
  total_expenses: string | number;
  net_cash_flow: string | number;
  closing_cash: string | number;
  owner_opening_balance: string | number;
  owner_net_movement: string | number;
  owner_closing_balance: string | number;
  jazz_lifting_opening: string | number;
  jazz_lifting_closing: string | number;
  jazz_payable_opening: string | number;
  jazz_payable_closing: string | number;
}

export interface CreditPartyDayProjection {
  day_id: string;
  party_id: string;
  opening_balance: string | number;
  loan_amount: string | number;
  receipt_amount: string | number;
  closing_balance: string | number;
}

export interface StockProductDayProjection {
  day_id: string;
  product_id: string;
  opening_qty: number;
  received_qty?: number;
  sold_qty?: number;
  stock_in_qty?: number;
  stock_out_qty?: number;
  closing_qty: number;
}

export interface StockAccountDayProjection {
  day_id: string;
  account_id: string;
  opening_due: string | number;
  purchases_amount: string | number;
  payments_amount: string | number;
  closing_due: string | number;
}

export interface JazzLiftingDayProjection {
  day_id: string;
  opening_balance?: string | number;
  opening_lifting?: string | number;
  lifting_amount?: string | number;
  ml_lifting_purchased?: string | number;
  issued_do_amount?: string | number;
  today_ml_issuance?: string | number;
  closing_balance?: string | number;
  closing_lifting_in_hand?: string | number;
}

export interface JazzLoadDoDayProjection {
  day_id: string;
  do_profile_id: string;
  opening_base?: string | number;
  opening_balance_base?: string | number;
  opening_balance_ml?: string | number;
  issuance_base?: string | number;
  issuance_ml?: string | number;
  payment_base?: string | number;
  closing_base?: string | number;
  closing_balance_base?: string | number;
  closing_balance_ml?: string | number;
}

export interface DayProjectionsResponse {
  day: {
    id: string;
    dayNo: number;
    periodId: string;
    status: "open" | "closed" | "reopen";
    calendarDate: string;
  };
  projections: {
    financial: DayFinancialProjection | null;
    creditParties: CreditPartyDayProjection[];
    stockProducts: StockProductDayProjection[];
    stockAccounts: StockAccountDayProjection[];
    jazzLifting: JazzLiftingDayProjection | null;
    jazzDo: JazzLoadDoDayProjection[];
  };
}

export interface AccountingPeriodRecord {
  id: string;
  franchise_id: string;
  period_key: string;
  year_num: number;
  month_num: number;
  label: string;
  status: "open" | "closed";
  final_settlement_status?: "PENDING" | "VERIFIED" | string;
  final_verified_at?: string | null;
  final_verified_by_user_id?: string | null;
  final_notes?: string | null;
  closed_at?: string | null;
  closed_by_user_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface AccountingDayRecord {
  id: string;
  franchise_id: string;
  period_id: string;
  day_no: number;
  day_type: "calendar" | "settlement";
  calendar_date: string;
  label: string;
  status: "open" | "closed" | "reopen";
  closed_at: string | null;
  reopened_at: string | null;
  notes: string | null;
}

export interface PeriodWithDaysResponse {
  period: AccountingPeriodRecord;
  days: AccountingDayRecord[];
}

// ---------------------------------------------------------------------------
// REST API Client Object
// ---------------------------------------------------------------------------

export const ledgerApiClient = {
  // Expenses
  expenses: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/expenses?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: ExpenseItemPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/expenses`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: ExpenseItemUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/expenses/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/expenses/${id}`, {
        method: "DELETE"
      })
  },

  // Commissions
  commissions: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/commissions?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: CommissionItemPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/commissions`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: CommissionItemUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/commissions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/commissions/${id}`, {
        method: "DELETE"
      })
  },

  // Credits
  credits: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/credits?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: CreditTransactionPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/credits`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: CreditTransactionUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/credits/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/credits/${id}`, {
        method: "DELETE"
      })
  },

  // Owner Transactions
  owner: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/owner?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: OwnerTransactionPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/owner`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: OwnerTransactionUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/owner/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/owner/${id}`, {
        method: "DELETE"
      })
  },

  // Stock Orders
  stockOrders: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/stock/orders?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: StockOrderPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/stock/orders`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: StockOrderUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/stock/orders/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/stock/orders/${id}`, {
        method: "DELETE"
      })
  },

  // Stock Account Payments
  stockPayments: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/stock/account-payments?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: StockAccountPaymentPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/stock/account-payments`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: StockAccountPaymentUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/stock/account-payments/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/stock/account-payments/${id}`, {
        method: "DELETE"
      })
  },

  // Jazz Lifting
  jazzLifting: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/jazz-load/lifting?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: JazzLiftingPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/jazz-load/lifting`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: JazzLiftingUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/jazz-load/lifting/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/jazz-load/lifting/${id}`, {
        method: "DELETE"
      })
  },

  // Jazz DO Entries
  jazzDo: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/jazz-load/do?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: JazzDoEntryPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/jazz-load/do`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: JazzDoEntryUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/jazz-load/do/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/jazz-load/do/${id}`, {
        method: "DELETE"
      })
  },

  // Jazz Company Payable Payments
  jazzCompanyPayments: {
    list: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/jazz-company/payments?day_id=${encodeURIComponent(dayId)}`),
    create: (payload: JazzPayablePaymentPayload, idempotencyKey?: string) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/jazz-company/payments`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    update: (id: string, payload: JazzPayablePaymentUpdatePayload) =>
      apiRequest<{ data: any }>(`/api/v1/transactions/jazz-company/payments/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    delete: (id: string) =>
      apiRequest<{ success: boolean }>(`/api/v1/transactions/jazz-company/payments/${id}`, {
        method: "DELETE"
      })
  },

  // Commission Settlement Receipts
  commissionSettlements: {
    listByDay: (dayId: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/commission-settlements?day_id=${encodeURIComponent(dayId)}`),
    listBySourcePeriod: (sourcePeriodKey: string) =>
      apiRequest<{ data: any[] }>(`/api/v1/transactions/commission-settlements?source_period_key=${encodeURIComponent(sourcePeriodKey)}`),
    create: (payload: {
      dayId: string;
      sourcePeriodKey: string;
      amount: number;
      categoryId?: string | null;
      categoryNameSnapshot?: string;
      notes?: string | null;
    }, idempotencyKey?: string) =>
      apiRequest<{ data: any; message: string }>(`/api/v1/transactions/commission-settlements`, {
        method: "POST",
        body: JSON.stringify(payload),
        idempotencyKey: idempotencyKey ?? crypto.randomUUID()
      }),
    delete: (id: string) =>
      apiRequest<{ deleted: boolean; id: string }>(`/api/v1/transactions/commission-settlements/${id}`, {
        method: "DELETE"
      })
  },

  // Calculations / Projections
  calculations: {
    getDayProjections: async (dayId: string): Promise<DayProjectionsResponse> => {
      const res = await apiRequest<DayProjectionsResponse | { data: DayProjectionsResponse }>(
        `/api/v1/calculations/projections/day/${dayId}`
      );
      if (res && typeof res === "object" && "data" in res && (res as any).data && typeof (res as any).data === "object") {
        return (res as any).data as DayProjectionsResponse;
      }
      return res as DayProjectionsResponse;
    },
    getPeriodFinalProjections: async (periodId: string): Promise<any> => {
      const res = await apiRequest<any>(
        `/api/v1/calculations/projections/period/${periodId}/final`
      );
      if (res && typeof res === "object" && "data" in res && (res as any).data && typeof (res as any).data === "object") {
        return (res as any).data;
      }
      return res;
    },
    getPeriodCommissionSummary: async (periodId: string): Promise<any> => {
      const res = await apiRequest<any>(
        `/api/v1/calculations/projections/period/${periodId}/commission-summary`
      );
      if (res && typeof res === "object" && "data" in res && (res as any).data && typeof (res as any).data === "object") {
        return (res as any).data;
      }
      return res;
    },
    rebuildDay: (dayId: string) =>
      apiRequest<{ message: string; data: any }>(`/api/v1/calculations/rebuild-day/${dayId}`, {
        method: "POST"
      })
  },

  // Periods & Days
  periods: {
    list: () =>
      apiRequest<{ periods: AccountingPeriodRecord[] }>(`/api/v1/periods`),
    get: (periodId: string) =>
      apiRequest<PeriodWithDaysResponse>(`/api/v1/periods/${periodId}`),
    getSeeds: (periodId: string) =>
      apiRequest<{
        periodId?: string;
        isVerified?: boolean;
        verifiedAt?: string | null;
        verifiedByUserId?: string | null;
        seeds: any;
      }>(`/api/v1/periods/${periodId}/seeds`),
    closeDay: (periodId: string, dayNo: number, notes?: string | null) =>
      apiRequest<{ message: string; day: AccountingDayRecord }>(
        `/api/v1/periods/${periodId}/days/${dayNo}/close`,
        {
          method: "POST",
          body: JSON.stringify({ notes: notes ?? null })
        }
      ),
    openNextDay: (periodId: string, dayNo: number, notes?: string | null) =>
      apiRequest<{ message: string; day: AccountingDayRecord }>(
        `/api/v1/periods/${periodId}/days/${dayNo}/open`,
        {
          method: "POST",
          body: JSON.stringify({ notes: notes ?? null })
        }
      ),
    reopenDay: (periodId: string, dayNo: number, reason: string) =>
      apiRequest<{ message: string; day: AccountingDayRecord }>(
        `/api/v1/periods/${periodId}/days/${dayNo}/reopen`,
        {
          method: "POST",
          body: JSON.stringify({ reason })
        }
      ),
    verifyFinalSettlement: (periodId: string, payload?: { allowOutstanding?: boolean; notes?: string }) =>
      apiRequest<{ verified: boolean; periodId: string; status: string; verifiedAt: string }>(
        `/api/v1/periods/${periodId}/final/verify`,
        {
          method: "POST",
          body: JSON.stringify(payload ?? {})
        }
      ),
    listFinalSettlements: (periodId: string) =>
      apiRequest<{ data: any }>(`/api/v1/periods/${periodId}/final-settlements`),
    createFinalSettlement: (periodId: string, payload: any, idempotencyKey?: string) =>
      apiRequest<{ data: any; finalSettlements: any; message: string }>(
        `/api/v1/periods/${periodId}/final-settlements`,
        {
          method: "POST",
          body: JSON.stringify(payload),
          idempotencyKey: idempotencyKey ?? crypto.randomUUID()
        }
      ),
    updateFinalSettlement: (periodId: string, settlementId: string, payload: any) =>
      apiRequest<{ data: any; finalSettlements: any; message: string }>(
        `/api/v1/periods/${periodId}/final-settlements/${settlementId}`,
        {
          method: "PUT",
          body: JSON.stringify(payload)
        }
      ),
    deleteFinalSettlement: (periodId: string, settlementId: string) =>
      apiRequest<{ deleted: boolean; id: string; finalSettlements: any; message: string }>(
        `/api/v1/periods/${periodId}/final-settlements/${settlementId}`,
        {
          method: "DELETE"
        }
      ),
    closePeriod: (periodId: string, notes?: string | null) =>
      apiRequest<{
        message?: string;
        closed: boolean;
        period: AccountingPeriodRecord;
        targetPeriod?: { id: string; periodKey: string; daysCount: number };
        targetDayNo?: number;
        activatedDay?: { id: string; dayNo: number; status: string; calendarDate?: string };
      }>(
        `/api/v1/periods/${periodId}/close`,
        {
          method: "POST",
          body: JSON.stringify({ notes: notes ?? null })
        }
      ),
    initializeNextPeriod: (periodId: string) =>
      apiRequest<{
        initialized: boolean;
        alreadyInitialized?: boolean;
        sourcePeriod: { id: string; periodKey: string; status: string };
        targetPeriod: { id: string; periodKey: string; status: string; daysCount: number };
        targetDayNo: number;
        activatedDay: { id: string; dayNo: number; status: string; calendarDate?: string };
      }>(
        `/api/v1/periods/${periodId}/initialize-next`,
        {
          method: "POST"
        }
      ),
    rollover: (periodId: string, notes?: string | null) =>
      apiRequest<{
        message: string;
        rolloverAlreadyComplete: boolean;
        sourcePeriod: { id: string; periodKey: string; status: string };
        targetPeriod: { id: string; periodKey: string; status: string; daysCount: number; isVerified: boolean };
      }>(`/api/v1/periods/${periodId}/rollover`, {
        method: "POST",
        body: JSON.stringify({ notes: notes ?? null })
      }),
    getSeedDelta: (periodId: string) =>
      apiRequest<{
        targetPeriodKey: string;
        sourcePeriodKey: string;
        hasDelta: boolean;
        hasExistingTransactions: boolean;
        deltas: any;
      }>(`/api/v1/periods/${periodId}/seed-delta`),
    applySeedCorrection: (periodId: string, payload: { reason: string; seeds: any }) =>
      apiRequest<{
        message: string;
        correctionApplied: boolean;
        targetPeriodKey: string;
        sourcePeriodKey: string;
        isVerified: boolean;
        affectedDaysRebuilt?: number;
      }>(`/api/v1/periods/${periodId}/seed-correction`, {
        method: "POST",
        body: JSON.stringify(payload)
      })
  },

  // Master Catalogs
  catalogs: {
    getExpenseCategories: (includeInactive = true) =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/expense-categories${includeInactive ? "?includeInactive=true" : ""}`),
    createExpenseCategory: (payload: { slug: string; name: string; sort_order?: number; is_active?: boolean }) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/expense-categories`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    updateExpenseCategory: (id: string, payload: { name?: string; slug?: string; sort_order?: number; is_active?: boolean }) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/expense-categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    deleteExpenseCategory: (id: string) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/expense-categories/${id}`, {
        method: "DELETE"
      }),
    getCommissionCategories: (includeInactive = true) =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/commission-categories${includeInactive ? "?includeInactive=true" : ""}`),
    createCommissionCategory: (payload: { slug: string; name: string; sort_order?: number; is_active?: boolean }) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/commission-categories`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    updateCommissionCategory: (id: string, payload: { name?: string; slug?: string; sort_order?: number; is_active?: boolean }) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/commission-categories/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    deleteCommissionCategory: (id: string) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/commission-categories/${id}`, {
        method: "DELETE"
      }),
    getCreditParties: (includeInactive = true) =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/credit-parties${includeInactive ? "?includeInactive=true" : ""}`),
    createCreditParty: (payload: { slug?: string; name: string; type?: string; sort_order?: number; is_active?: boolean; notes?: string | null }) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/credit-parties`, {
        method: "POST",
        body: JSON.stringify(payload)
      }),
    updateCreditParty: (id: string, payload: { slug?: string; name?: string; type?: string; sort_order?: number; is_active?: boolean; notes?: string | null }) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/credit-parties/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      }),
    deleteCreditParty: (id: string) =>
      apiRequest<{ data: any }>(`/api/v1/catalogs/credit-parties/${id}`, {
        method: "DELETE"
      }),
    getStockProducts: () =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/stock-products`),
    getStockAccounts: () =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/stock-accounts`),
    getJazzLoadDoProfiles: () =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/jazz-load-do-profiles`),
    getJazzLoadRates: () =>
      apiRequest<{ data: any[] }>(`/api/v1/catalogs/jazz-load-rates`)
  }
};
