/**
 * Phase 5.1: Operational Transaction Validation Schemas
 *
 * Zod validation schemas for request bodies, params, and queries across all 10
 * operational tables. Enforces accounting domain invariants, clientMutationId
 * idempotency, and baseRevision optimistic concurrency control.
 */
import { z } from "zod";

export const UuidParam = z.object({
  id: z.string().uuid({ message: "id must be a valid UUID" })
});

export const TransactionFilterQuery = z.object({
  day_id: z.string().uuid().optional(),
  period_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0)
});

export type TransactionFilter = z.infer<typeof TransactionFilterQuery>;

// Base concurrency and idempotency fields
const IdempotencyFields = {
  client_mutation_id: z.string().min(1).max(128).optional(),
  clientMutationId: z.string().min(1).max(128).optional()
};

const OptimisticLockFields = {
  base_revision: z.number().int().positive({ message: "base_revision must be a positive integer" }).optional(),
  baseRevision: z.number().int().positive({ message: "baseRevision must be a positive integer" }).optional()
};

function withOptimisticLock<T extends z.ZodRawShape>(shape: T) {
  return z.object({
    ...OptimisticLockFields,
    ...shape
  }).refine(
    (data) => data.base_revision !== undefined || data.baseRevision !== undefined,
    {
      message: "baseRevision (or base_revision) is required for update operations.",
      path: ["baseRevision"]
    }
  );
}

// ---------------------------------------------------------------------------
// 1. Expense Items
// ---------------------------------------------------------------------------
export const ExpenseItemCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  category_name_snapshot: z.string().max(100).optional(),
  item_name: z.string().min(1).max(150),
  description: z.string().max(1000).nullable().optional(),
  amount: z.number().positive({ message: "amount must be greater than 0" })
});

export const ExpenseItemUpdateSchema = withOptimisticLock({
  category_id: z.string().uuid().nullable().optional(),
  item_name: z.string().min(1).max(150).optional(),
  description: z.string().max(1000).nullable().optional(),
  amount: z.number().positive({ message: "amount must be greater than 0" }).optional()
});

export type ExpenseItemCreate = z.infer<typeof ExpenseItemCreateSchema>;
export type ExpenseItemUpdate = z.infer<typeof ExpenseItemUpdateSchema>;

// ---------------------------------------------------------------------------
// 2. Commission Items
// ---------------------------------------------------------------------------
export const CommissionItemCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  category_id: z.string().uuid().nullable().optional(),
  category_name_snapshot: z.string().max(100).optional(),
  amount: z.number().positive({ message: "amount must be greater than 0" })
});

export const CommissionItemUpdateSchema = withOptimisticLock({
  category_id: z.string().uuid().nullable().optional(),
  amount: z.number().positive({ message: "amount must be greater than 0" }).optional()
});

export type CommissionItemCreate = z.infer<typeof CommissionItemCreateSchema>;
export type CommissionItemUpdate = z.infer<typeof CommissionItemUpdateSchema>;

// ---------------------------------------------------------------------------
// 3. Credit Transactions
// ---------------------------------------------------------------------------
export const CreditTransactionCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  party_id: z.string().uuid(),
  loan_amount: z.number().min(0).default(0),
  receipt_amount: z.number().min(0).default(0),
  manual_adjustment: z.number().default(0),
  loan_description: z.string().max(1000).nullable().optional(),
  receive_description: z.string().max(1000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional()
}).refine(
  (data) => data.loan_amount > 0 || data.receipt_amount > 0 || data.manual_adjustment !== 0,
  { message: "Credit transaction must have at least one non-zero activity (loan, receipt, or adjustment)" }
);

export const CreditTransactionUpdateSchema = withOptimisticLock({
  party_id: z.string().uuid().optional(),
  loan_amount: z.number().min(0).optional(),
  receipt_amount: z.number().min(0).optional(),
  manual_adjustment: z.number().optional(),
  loan_description: z.string().max(1000).nullable().optional(),
  receive_description: z.string().max(1000).nullable().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type CreditTransactionCreate = z.infer<typeof CreditTransactionCreateSchema>;
export type CreditTransactionUpdate = z.infer<typeof CreditTransactionUpdateSchema>;

// ---------------------------------------------------------------------------
// 4. Owner Transactions
// ---------------------------------------------------------------------------
export const OwnerTransactionCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  description: z.string().min(1).max(1000),
  amount: z.number().refine((val) => val !== 0, { message: "amount cannot be 0" }),
  notes: z.string().max(1000).nullable().optional()
});

export const OwnerTransactionUpdateSchema = withOptimisticLock({
  description: z.string().min(1).max(1000).optional(),
  amount: z.number().refine((val) => val !== 0, { message: "amount cannot be 0" }).optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type OwnerTransactionCreate = z.infer<typeof OwnerTransactionCreateSchema>;
export type OwnerTransactionUpdate = z.infer<typeof OwnerTransactionUpdateSchema>;

// ---------------------------------------------------------------------------
// 5. Jazz Load Lifting Records
// ---------------------------------------------------------------------------
export const JazzLiftingCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  ml_lifting_amount: z.number().min(0, { message: "ml_lifting_amount must be greater than or equal to 0" }),
  notes: z.string().max(1000).nullable().optional()
});

export const JazzLiftingUpdateSchema = z.object({
  ml_lifting_amount: z.number().min(0, { message: "ml_lifting_amount must be greater than or equal to 0" }).optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type JazzLiftingCreate = z.infer<typeof JazzLiftingCreateSchema>;
export type JazzLiftingUpdate = z.infer<typeof JazzLiftingUpdateSchema>;

// ---------------------------------------------------------------------------
// 6. Jazz Load DO Entries
// ---------------------------------------------------------------------------
// Note: applied_ml_rate_percentage is strictly server-derived from jazz_load_rates.
// Clients cannot inject it on CREATE or alter it on UPDATE.
export const JazzDoEntryCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  do_profile_id: z.string().uuid(),
  issuance_base: z.number().min(0).default(0),
  payment_base: z.number().min(0).default(0),
  notes: z.string().max(1000).nullable().optional()
}).refine(
  (data) => data.issuance_base > 0 || data.payment_base > 0,
  { message: "Jazz Load DO entry must have positive issuance_base or payment_base" }
);

export const JazzDoEntryUpdateSchema = withOptimisticLock({
  do_profile_id: z.string().uuid().optional(),
  issuance_base: z.number().min(0).optional(),
  payment_base: z.number().min(0).optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type JazzDoEntryCreate = z.infer<typeof JazzDoEntryCreateSchema>;
export type JazzDoEntryUpdate = z.infer<typeof JazzDoEntryUpdateSchema>;

// ---------------------------------------------------------------------------
// 7 & 8. Stock Orders & Lines
// ---------------------------------------------------------------------------
export const StockOrderLineInputSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive({ message: "quantity must be a positive integer" }),
  unit_rate: z.number().min(0, { message: "unit_rate must be non-negative" }).optional()
});

export const StockOrderCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  direction: z.enum(["inbound", "outbound"]),
  account_id: z.string().uuid().nullable().optional(),
  supplier_name: z.string().max(100).nullable().optional(),
  invoice_reference: z.string().max(64).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  lines: z.array(StockOrderLineInputSchema).min(1, { message: "Stock order must have at least one line item" })
});

export const StockOrderUpdateSchema = withOptimisticLock({
  direction: z.enum(["inbound", "outbound"]).optional(),
  account_id: z.string().uuid().nullable().optional(),
  supplier_name: z.string().max(100).nullable().optional(),
  invoice_reference: z.string().max(64).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  lines: z.array(StockOrderLineInputSchema).min(1).optional()
});

export type StockOrderLineInput = z.infer<typeof StockOrderLineInputSchema>;
export type StockOrderCreate = z.infer<typeof StockOrderCreateSchema>;
export type StockOrderUpdate = z.infer<typeof StockOrderUpdateSchema>;

// ---------------------------------------------------------------------------
// 9. Stock Account Payments
// ---------------------------------------------------------------------------
export const StockAccountPaymentCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  account_id: z.string().uuid(),
  amount: z.number().positive({ message: "amount must be greater than 0" }),
  payment_method: z.string().max(32).default("cash"),
  notes: z.string().max(1000).nullable().optional()
});

export const StockAccountPaymentUpdateSchema = withOptimisticLock({
  account_id: z.string().uuid().optional(),
  amount: z.number().positive({ message: "amount must be greater than 0" }).optional(),
  payment_method: z.string().max(32).optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type StockAccountPaymentCreate = z.infer<typeof StockAccountPaymentCreateSchema>;
export type StockAccountPaymentUpdate = z.infer<typeof StockAccountPaymentUpdateSchema>;

// ---------------------------------------------------------------------------
// 10. Jazz Company Payable Payments
// ---------------------------------------------------------------------------
export const JazzPayablePaymentCreateSchema = z.object({
  ...IdempotencyFields,
  day_id: z.string().uuid(),
  amount: z.number().positive({ message: "amount must be greater than 0" }),
  payment_reference: z.string().max(128).nullable().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export const JazzPayablePaymentUpdateSchema = withOptimisticLock({
  amount: z.number().positive({ message: "amount must be greater than 0" }).optional(),
  payment_reference: z.string().max(128).nullable().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type JazzPayablePaymentCreate = z.infer<typeof JazzPayablePaymentCreateSchema>;
export type JazzPayablePaymentUpdate = z.infer<typeof JazzPayablePaymentUpdateSchema>;
