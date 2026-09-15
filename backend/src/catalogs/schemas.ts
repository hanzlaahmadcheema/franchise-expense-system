/**
 * Phase 4: Master Catalog Validation Schemas
 *
 * Zod schemas for request body, route param, and query validation
 * across all 7 master catalog resources.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const UuidParam = z.object({
  id: z.string().uuid({ message: "id must be a valid UUID" })
});

export const ActiveFilterQuery = z.object({
  includeInactive: z
    .string()
    .optional()
    .transform((v) => v === "true")
});

// ---------------------------------------------------------------------------
// Slug helper (used by categories, credit_parties, stock_products, stock_accounts)
// ---------------------------------------------------------------------------
const SlugField = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, { message: "slug must be lowercase alphanumeric with hyphens or underscores" });

// ---------------------------------------------------------------------------
// Expense Categories
// ---------------------------------------------------------------------------
export const ExpenseCategoryCreateSchema = z.object({
  slug: SlugField,
  name: z.string().min(1).max(100),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true)
});

export const ExpenseCategoryUpdateSchema = z.object({
  slug: SlugField.optional(),
  name: z.string().min(1).max(100).optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional()
});

export type ExpenseCategoryCreate = z.infer<typeof ExpenseCategoryCreateSchema>;
export type ExpenseCategoryUpdate = z.infer<typeof ExpenseCategoryUpdateSchema>;

// ---------------------------------------------------------------------------
// Commission Categories
// ---------------------------------------------------------------------------
export const CommissionCategoryCreateSchema = z.object({
  slug: SlugField,
  name: z.string().min(1).max(100),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true)
});

export const CommissionCategoryUpdateSchema = z.object({
  slug: SlugField.optional(),
  name: z.string().min(1).max(100).optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional()
});

export type CommissionCategoryCreate = z.infer<typeof CommissionCategoryCreateSchema>;
export type CommissionCategoryUpdate = z.infer<typeof CommissionCategoryUpdateSchema>;

// ---------------------------------------------------------------------------
// Credit Parties
// ---------------------------------------------------------------------------
const CreditPartyTypeEnum = z.enum(["dealer", "dso", "staff", "external", "other"]);

export const CreditPartyCreateSchema = z.object({
  slug: SlugField,
  name: z.string().min(1).max(100),
  type: CreditPartyTypeEnum.default("dealer"),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  notes: z.string().max(1000).nullable().optional()
});

export const CreditPartyUpdateSchema = z.object({
  slug: SlugField.optional(),
  name: z.string().min(1).max(100).optional(),
  type: CreditPartyTypeEnum.optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type CreditPartyCreate = z.infer<typeof CreditPartyCreateSchema>;
export type CreditPartyUpdate = z.infer<typeof CreditPartyUpdateSchema>;

// ---------------------------------------------------------------------------
// Jazz Load Rates
// ---------------------------------------------------------------------------
export const JazzLoadRateCreateSchema = z.object({
  name: z.string().min(1).max(100).default("Standard Rates"),
  ml_rate: z.number().min(0).max(99.9999),
  comm1_rate: z.number().min(0).max(99.9999),
  comm2_rate: z.number().min(0).max(99.9999).default(0),
  effective_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { message: "effective_from must be YYYY-MM-DD" }),
  is_active: z.boolean().default(true)
});

export const JazzLoadRateUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  is_active: z.boolean().optional()
  // NOTE: ml_rate, comm1_rate, comm2_rate, effective_from are immutable once created.
  // Correcting rates requires creating a new rate record (rate versioning).
  // This is enforced at the service layer, not schema layer, so the schema
  // intentionally omits those fields from updates.
});

export type JazzLoadRateCreate = z.infer<typeof JazzLoadRateCreateSchema>;
export type JazzLoadRateUpdate = z.infer<typeof JazzLoadRateUpdateSchema>;

// ---------------------------------------------------------------------------
// Jazz Load DO Profiles
// ---------------------------------------------------------------------------
export const JazzLoadDoProfileCreateSchema = z.object({
  do_name: z.string().min(1).max(100),
  do_line: z.string().max(32).nullable().optional(),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  notes: z.string().max(1000).nullable().optional()
});

export const JazzLoadDoProfileUpdateSchema = z.object({
  do_name: z.string().min(1).max(100).optional(),
  do_line: z.string().max(32).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type JazzLoadDoProfileCreate = z.infer<typeof JazzLoadDoProfileCreateSchema>;
export type JazzLoadDoProfileUpdate = z.infer<typeof JazzLoadDoProfileUpdateSchema>;

// ---------------------------------------------------------------------------
// Stock Products
// ---------------------------------------------------------------------------
export const StockProductCreateSchema = z.object({
  slug: SlugField,
  name: z.string().min(1).max(100),
  rate: z.number().min(0),
  payment_tracking_enabled: z.boolean().default(false),
  category: z.string().max(64).nullable().optional(),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  notes: z.string().max(1000).nullable().optional()
});

export const StockProductUpdateSchema = z.object({
  slug: SlugField.optional(),
  name: z.string().min(1).max(100).optional(),
  rate: z.number().min(0).optional(),
  payment_tracking_enabled: z.boolean().optional(),
  category: z.string().max(64).nullable().optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type StockProductCreate = z.infer<typeof StockProductCreateSchema>;
export type StockProductUpdate = z.infer<typeof StockProductUpdateSchema>;

// ---------------------------------------------------------------------------
// Stock Accounts
// ---------------------------------------------------------------------------
const StockAccountTypeEnum = z.enum(["DO", "CCR", "DSO", "STOCK", "OTHER"]);

export const StockAccountCreateSchema = z.object({
  slug: SlugField,
  name: z.string().min(1).max(100),
  type: StockAccountTypeEnum.default("CCR"),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  notes: z.string().max(1000).nullable().optional()
});

export const StockAccountUpdateSchema = z.object({
  slug: SlugField.optional(),
  name: z.string().min(1).max(100).optional(),
  type: StockAccountTypeEnum.optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional()
});

export type StockAccountCreate = z.infer<typeof StockAccountCreateSchema>;
export type StockAccountUpdate = z.infer<typeof StockAccountUpdateSchema>;
