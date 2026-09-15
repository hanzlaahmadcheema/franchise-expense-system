/**
 * Phase 7B: Period and Opening Seed Validation Schemas
 *
 * Enforces:
 * - Period key format YYYY-MM
 * - Financial seed decimal amounts and provenance metadata
 * - Catalog references and non-negative stock constraints
 * - Seed bundle structure supporting both camelCase and snake_case
 */

import { z } from "zod";

export const PeriodKeySchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period key must be in YYYY-MM format");

export const InitializePeriodSchema = z
  .object({
    periodKey: PeriodKeySchema
  })
  .strict();

export const DecimalAmountSchema = z
  .union([z.string(), z.number()])
  .transform((val) => (typeof val === "number" ? val.toFixed(2) : String(val).trim()))
  .refine((val) => /^-?\d+(\.\d{1,2})?$/.test(val), {
    message: "Must be a valid decimal amount with up to 2 decimal places"
  });

export const NonNegativeIntegerSchema = z
  .union([z.string(), z.number()])
  .transform((val) => (typeof val === "string" ? parseInt(val, 10) : val))
  .refine((val) => Number.isInteger(val) && val >= 0, {
    message: "Must be a non-negative integer"
  });

export const FinancialSeedInputSchema = z
  .object({
    openingCash: DecimalAmountSchema.optional(),
    opening_cash: DecimalAmountSchema.optional(),
    openingOwnerBalance: DecimalAmountSchema.optional(),
    opening_owner_balance: DecimalAmountSchema.optional(),
    openingJazzLifting: DecimalAmountSchema.optional(),
    opening_jazz_lifting: DecimalAmountSchema.optional(),
    openingJazzPayable: DecimalAmountSchema.optional(),
    opening_jazz_payable: DecimalAmountSchema.optional(),
    sourcePeriodKey: z.string().optional(),
    source_period_key: z.string().optional(),
    sourceDayNo: z.number().int().optional(),
    source_day_no: z.number().int().optional(),
    notes: z.string().nullable().optional()
  })
  .transform((data) => ({
    openingCash: data.openingCash ?? data.opening_cash ?? "0.00",
    openingOwnerBalance: data.openingOwnerBalance ?? data.opening_owner_balance ?? "0.00",
    openingJazzLifting: data.openingJazzLifting ?? data.opening_jazz_lifting ?? "0.00",
    openingJazzPayable: data.openingJazzPayable ?? data.opening_jazz_payable ?? "0.00",
    sourcePeriodKey: data.sourcePeriodKey ?? data.source_period_key ?? "2026-08",
    sourceDayNo: data.sourceDayNo ?? data.source_day_no ?? 31,
    notes: data.notes ?? null
  }));

export const CreditPartySeedItemSchema = z
  .object({
    partyId: z.string().uuid().optional(),
    party_id: z.string().uuid().optional(),
    openingBalance: DecimalAmountSchema.optional(),
    opening_balance: DecimalAmountSchema.optional(),
    sourcePeriodKey: z.string().optional(),
    source_period_key: z.string().optional(),
    sourceDayNo: z.number().int().optional(),
    source_day_no: z.number().int().optional()
  })
  .transform((data) => {
    const partyId = data.partyId ?? data.party_id;
    if (!partyId) throw new Error("partyId (or party_id) is required");
    return {
      partyId,
      openingBalance: data.openingBalance ?? data.opening_balance ?? "0.00",
      sourcePeriodKey: data.sourcePeriodKey ?? data.source_period_key ?? "2026-08",
      sourceDayNo: data.sourceDayNo ?? data.source_day_no ?? 31
    };
  });

export const StockProductSeedItemSchema = z
  .object({
    productId: z.string().uuid().optional(),
    product_id: z.string().uuid().optional(),
    openingQuantity: NonNegativeIntegerSchema.optional(),
    opening_quantity: NonNegativeIntegerSchema.optional(),
    sourcePeriodKey: z.string().optional(),
    source_period_key: z.string().optional(),
    sourceDayNo: z.number().int().optional(),
    source_day_no: z.number().int().optional()
  })
  .transform((data) => {
    const productId = data.productId ?? data.product_id;
    if (!productId) throw new Error("productId (or product_id) is required");
    const openingQuantity =
      data.openingQuantity !== undefined ? data.openingQuantity : data.opening_quantity;
    if (openingQuantity === undefined) {
      throw new Error("openingQuantity (or opening_quantity) is required");
    }
    return {
      productId,
      openingQuantity,
      sourcePeriodKey: data.sourcePeriodKey ?? data.source_period_key ?? "2026-08",
      sourceDayNo: data.sourceDayNo ?? data.source_day_no ?? 31
    };
  });

export const StockAccountSeedItemSchema = z
  .object({
    accountId: z.string().uuid().optional(),
    account_id: z.string().uuid().optional(),
    openingReceivable: DecimalAmountSchema.optional(),
    opening_receivable: DecimalAmountSchema.optional(),
    sourcePeriodKey: z.string().optional(),
    source_period_key: z.string().optional(),
    sourceDayNo: z.number().int().optional(),
    source_day_no: z.number().int().optional()
  })
  .transform((data) => {
    const accountId = data.accountId ?? data.account_id;
    if (!accountId) throw new Error("accountId (or account_id) is required");
    return {
      accountId,
      openingReceivable: data.openingReceivable ?? data.opening_receivable ?? "0.00",
      sourcePeriodKey: data.sourcePeriodKey ?? data.source_period_key ?? "2026-08",
      sourceDayNo: data.sourceDayNo ?? data.source_day_no ?? 31
    };
  });

export const JazzDoSeedItemSchema = z
  .object({
    doProfileId: z.string().uuid().optional(),
    do_profile_id: z.string().uuid().optional(),
    openingBaseBalance: DecimalAmountSchema.optional(),
    opening_base_balance: DecimalAmountSchema.optional(),
    sourcePeriodKey: z.string().optional(),
    source_period_key: z.string().optional(),
    sourceDayNo: z.number().int().optional(),
    source_day_no: z.number().int().optional()
  })
  .transform((data) => {
    const doProfileId = data.doProfileId ?? data.do_profile_id;
    if (!doProfileId) throw new Error("doProfileId (or do_profile_id) is required");
    return {
      doProfileId,
      openingBaseBalance: data.openingBaseBalance ?? data.opening_base_balance ?? "0.00",
      sourcePeriodKey: data.sourcePeriodKey ?? data.source_period_key ?? "2026-08",
      sourceDayNo: data.sourceDayNo ?? data.source_day_no ?? 31
    };
  });

export const SeedBundleSchema = z
  .object({
    financial: FinancialSeedInputSchema,
    creditParties: z.array(CreditPartySeedItemSchema).optional().default([]),
    credit_parties: z.array(CreditPartySeedItemSchema).optional(),
    stockProducts: z.array(StockProductSeedItemSchema).optional().default([]),
    stock_products: z.array(StockProductSeedItemSchema).optional(),
    stockAccounts: z.array(StockAccountSeedItemSchema).optional().default([]),
    stock_accounts: z.array(StockAccountSeedItemSchema).optional(),
    jazzDoProfiles: z.array(JazzDoSeedItemSchema).optional().default([]),
    jazz_do_profiles: z.array(JazzDoSeedItemSchema).optional()
  })
  .transform((data) => ({
    financial: data.financial,
    creditParties: data.creditParties.length > 0 ? data.creditParties : (data.credit_parties ?? []),
    stockProducts: data.stockProducts.length > 0 ? data.stockProducts : (data.stock_products ?? []),
    stockAccounts: data.stockAccounts.length > 0 ? data.stockAccounts : (data.stock_accounts ?? []),
    jazzDoProfiles: data.jazzDoProfiles.length > 0 ? data.jazzDoProfiles : (data.jazz_do_profiles ?? [])
  }));

export type InitializePeriodInput = z.infer<typeof InitializePeriodSchema>;
export type SeedBundleInput = z.infer<typeof SeedBundleSchema>;
export type FinancialSeedInput = z.infer<typeof FinancialSeedInputSchema>;
