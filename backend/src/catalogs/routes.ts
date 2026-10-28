/**
 * Phase 4: Master Catalog Routes
 *
 * All routes sit behind requireAuth + requireFranchise (Phase 3 middleware).
 * franchiseId is always extracted from req.auth.franchise.id — never from
 * client-provided request data, headers, or query parameters.
 *
 * RBAC:
 *  - GET endpoints: viewer and above
 *  - POST / PATCH endpoints: admin and above
 *
 * Route groups:
 *  /api/v1/catalogs/expense-categories
 *  /api/v1/catalogs/commission-categories
 *  /api/v1/catalogs/credit-parties
 *  /api/v1/catalogs/jazz-load-rates
 *  /api/v1/catalogs/jazz-load-do-profiles
 *  /api/v1/catalogs/stock-products
 *  /api/v1/catalogs/stock-accounts
 */
import { Router, type Request, type Response } from "express";
import { ZodError } from "zod";

import { requireAuth } from "../auth/authMiddleware.js";
import { requireFranchise } from "../auth/tenantMiddleware.js";
import { requireRole } from "../auth/rbacMiddleware.js";

import {
  UuidParam,
  ActiveFilterQuery,
  ExpenseCategoryCreateSchema,
  ExpenseCategoryUpdateSchema,
  CommissionCategoryCreateSchema,
  CommissionCategoryUpdateSchema,
  CreditPartyCreateSchema,
  CreditPartyUpdateSchema,
  JazzLoadRateCreateSchema,
  JazzLoadRateUpdateSchema,
  JazzLoadDoProfileCreateSchema,
  JazzLoadDoProfileUpdateSchema,
  StockProductCreateSchema,
  StockProductUpdateSchema,
  StockAccountCreateSchema,
  StockAccountUpdateSchema
} from "./schemas.js";

import {
  listExpenseCategories,
  getExpenseCategory,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
  listCommissionCategories,
  getCommissionCategory,
  createCommissionCategory,
  updateCommissionCategory,
  deleteCommissionCategory,
  listCreditParties,
  getCreditParty,
  createCreditParty,
  updateCreditParty,
  deleteCreditParty,
  listJazzLoadRates,
  getJazzLoadRate,
  createJazzLoadRate,
  updateJazzLoadRate,
  listJazzLoadDoProfiles,
  getJazzLoadDoProfile,
  createJazzLoadDoProfile,
  updateJazzLoadDoProfile,
  listStockProducts,
  getStockProduct,
  createStockProduct,
  updateStockProduct,
  listStockAccounts,
  getStockAccount,
  createStockAccount,
  updateStockAccount
} from "./service.js";

import {
  sendValidationError,
  sendDuplicateError,
  sendNotFound,
  sendInternalError,
  isUniqueViolation
} from "./errors.js";

// Auth chain applied to all catalog routes
const authChain = [requireAuth, requireFranchise];
const readOnlyMin = [...authChain, requireRole("viewer")];
const mutateMin = [...authChain, requireRole("admin")];

export const catalogRouter: Router = Router();

// ---------------------------------------------------------------------------
// Helper: extract authenticated franchise_id from resolved tenant context
// (never from client data)
// ---------------------------------------------------------------------------
function getFranchiseId(req: Request): string {
  // requireFranchise guarantees req.auth.franchise is set at this point
  return req.auth!.franchise!.id;
}

// ---------------------------------------------------------------------------
// Helper: return 400 if parsed PATCH body has no fields to update
// ---------------------------------------------------------------------------
function guardEmptyUpdate(res: Response, body: Record<string, unknown>): boolean {
  if (Object.keys(body).length === 0) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Request body must contain at least one updatable field."
    });
    return true;
  }
  return false;
}


// ---------------------------------------------------------------------------
// Expense Categories
// ---------------------------------------------------------------------------

catalogRouter.get("/expense-categories", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listExpenseCategories(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /expense-categories", err);
  }
});

catalogRouter.get("/expense-categories/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getExpenseCategory(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Expense category");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /expense-categories/:id", err);
  }
});

catalogRouter.post("/expense-categories", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = ExpenseCategoryCreateSchema.parse(req.body);
    const row = await createExpenseCategory(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "POST /expense-categories", err);
  }
});

catalogRouter.patch("/expense-categories/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = ExpenseCategoryUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateExpenseCategory(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Expense category");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "PATCH /expense-categories/:id", err);
  }
});

catalogRouter.delete("/expense-categories/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await deleteExpenseCategory(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Expense category");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "DELETE /expense-categories/:id", err);
  }
});

// ---------------------------------------------------------------------------
// Commission Categories
// ---------------------------------------------------------------------------

catalogRouter.get("/commission-categories", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listCommissionCategories(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /commission-categories", err);
  }
});

catalogRouter.get("/commission-categories/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getCommissionCategory(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Commission category");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /commission-categories/:id", err);
  }
});

catalogRouter.post("/commission-categories", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = CommissionCategoryCreateSchema.parse(req.body);
    const row = await createCommissionCategory(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "POST /commission-categories", err);
  }
});

catalogRouter.patch("/commission-categories/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = CommissionCategoryUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateCommissionCategory(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Commission category");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "PATCH /commission-categories/:id", err);
  }
});

catalogRouter.delete("/commission-categories/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await deleteCommissionCategory(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Commission category");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "DELETE /commission-categories/:id", err);
  }
});

// ---------------------------------------------------------------------------
// Credit Parties
// ---------------------------------------------------------------------------

catalogRouter.get("/credit-parties", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listCreditParties(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /credit-parties", err);
  }
});

catalogRouter.get("/credit-parties/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getCreditParty(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Credit party");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /credit-parties/:id", err);
  }
});

catalogRouter.post("/credit-parties", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = CreditPartyCreateSchema.parse(req.body);
    const row = await createCreditParty(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "POST /credit-parties", err);
  }
});

catalogRouter.patch("/credit-parties/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = CreditPartyUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateCreditParty(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Credit party");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "PATCH /credit-parties/:id", err);
  }
});

catalogRouter.delete("/credit-parties/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await deleteCreditParty(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Credit party");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "DELETE /credit-parties/:id", err);
  }
});

// ---------------------------------------------------------------------------
// Jazz Load Rates
// ---------------------------------------------------------------------------

catalogRouter.get("/jazz-load-rates", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listJazzLoadRates(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /jazz-load-rates", err);
  }
});

catalogRouter.get("/jazz-load-rates/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getJazzLoadRate(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Jazz Load rate");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /jazz-load-rates/:id", err);
  }
});

catalogRouter.post("/jazz-load-rates", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = JazzLoadRateCreateSchema.parse(req.body);
    const row = await createJazzLoadRate(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "POST /jazz-load-rates", err);
  }
});

catalogRouter.patch("/jazz-load-rates/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = JazzLoadRateUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateJazzLoadRate(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Jazz Load rate");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "PATCH /jazz-load-rates/:id", err);
  }
});

// ---------------------------------------------------------------------------
// Jazz Load DO Profiles
// ---------------------------------------------------------------------------

catalogRouter.get("/jazz-load-do-profiles", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listJazzLoadDoProfiles(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /jazz-load-do-profiles", err);
  }
});

catalogRouter.get("/jazz-load-do-profiles/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getJazzLoadDoProfile(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Jazz Load DO profile");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /jazz-load-do-profiles/:id", err);
  }
});

catalogRouter.post("/jazz-load-do-profiles", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = JazzLoadDoProfileCreateSchema.parse(req.body);
    const row = await createJazzLoadDoProfile(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "do_name + do_line");
    sendInternalError(res, "POST /jazz-load-do-profiles", err);
  }
});

catalogRouter.patch("/jazz-load-do-profiles/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = JazzLoadDoProfileUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateJazzLoadDoProfile(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Jazz Load DO profile");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "do_name + do_line");
    sendInternalError(res, "PATCH /jazz-load-do-profiles/:id", err);
  }
});

// ---------------------------------------------------------------------------
// Stock Products
// ---------------------------------------------------------------------------

catalogRouter.get("/stock-products", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listStockProducts(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /stock-products", err);
  }
});

catalogRouter.get("/stock-products/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getStockProduct(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Stock product");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /stock-products/:id", err);
  }
});

catalogRouter.post("/stock-products", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = StockProductCreateSchema.parse(req.body);
    const row = await createStockProduct(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "POST /stock-products", err);
  }
});

catalogRouter.patch("/stock-products/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = StockProductUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateStockProduct(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Stock product");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "PATCH /stock-products/:id", err);
  }
});

// ---------------------------------------------------------------------------
// Stock Accounts
// ---------------------------------------------------------------------------

catalogRouter.get("/stock-accounts", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { includeInactive } = ActiveFilterQuery.parse(req.query);
    const rows = await listStockAccounts(getFranchiseId(req), includeInactive);
    res.json({ data: rows });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /stock-accounts", err);
  }
});

catalogRouter.get("/stock-accounts/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getStockAccount(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Stock account");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    sendInternalError(res, "GET /stock-accounts/:id", err);
  }
});

catalogRouter.post("/stock-accounts", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = StockAccountCreateSchema.parse(req.body);
    const row = await createStockAccount(getFranchiseId(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "POST /stock-accounts", err);
  }
});

catalogRouter.patch("/stock-accounts/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = StockAccountUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateStockAccount(getFranchiseId(req), id, body);
    if (!row) return void sendNotFound(res, "Stock account");
    res.json({ data: row });
  } catch (err) {
    if (err instanceof ZodError) return void sendValidationError(res, err);
    if (isUniqueViolation(err)) return void sendDuplicateError(res, "slug");
    sendInternalError(res, "PATCH /stock-accounts/:id", err);
  }
});
