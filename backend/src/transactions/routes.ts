/**
 * Phase 5: Operational Ledger Transaction Routes
 *
 * REST endpoints mounted at `/api/v1/transactions`.
 * All routes enforce:
 * - requireAuth & requireFranchise (Phase 3)
 * - Server-resolved tenant scoping (`req.auth.franchise.id`)
 * - Strict RBAC: Viewer for read, Admin/Owner for mutation
 * - Robust error handling with sanitized PostgreSQL mapping
 */
import { Router, type Request, type Response } from "express";
import { requireAuth } from "../auth/authMiddleware.js";
import { requireFranchise } from "../auth/tenantMiddleware.js";
import { requireRole } from "../auth/rbacMiddleware.js";
import {
  UuidParam,
  TransactionFilterQuery,
  ExpenseItemCreateSchema,
  ExpenseItemUpdateSchema,
  CommissionItemCreateSchema,
  CommissionItemUpdateSchema,
  CreditTransactionCreateSchema,
  CreditTransactionUpdateSchema,
  OwnerTransactionCreateSchema,
  OwnerTransactionUpdateSchema,
  JazzLiftingCreateSchema,
  JazzLiftingUpdateSchema,
  JazzDoEntryCreateSchema,
  JazzDoEntryUpdateSchema,
  StockOrderCreateSchema,
  StockOrderUpdateSchema,
  StockAccountPaymentCreateSchema,
  StockAccountPaymentUpdateSchema,
  JazzPayablePaymentCreateSchema,
  JazzPayablePaymentUpdateSchema
} from "./schemas.js";
import {
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  listCommissions,
  getCommission,
  createCommission,
  updateCommission,
  deleteCommission,
  listCredits,
  getCredit,
  createCredit,
  updateCredit,
  deleteCredit,
  listOwnerTransactions,
  getOwnerTransaction,
  createOwnerTransaction,
  updateOwnerTransaction,
  deleteOwnerTransaction,
  listJazzLifting,
  getJazzLifting,
  createJazzLifting,
  updateJazzLifting,
  deleteJazzLifting,
  listJazzDoEntries,
  getJazzDoEntry,
  createJazzDoEntry,
  updateJazzDoEntry,
  deleteJazzDoEntry,
  listStockOrders,
  getStockOrder,
  createStockOrder,
  updateStockOrder,
  deleteStockOrder,
  listStockAccountPayments,
  getStockAccountPayment,
  createStockAccountPayment,
  updateStockAccountPayment,
  deleteStockAccountPayment,
  listJazzPayablePayments,
  getJazzPayablePayment,
  createJazzPayablePayment,
  updateJazzPayablePayment,
  deleteJazzPayablePayment,
  type MutationContext
} from "./service.js";
import {
  handleTransactionError,
  sendNotFound
} from "./errors.js";

export const transactionRouter = Router();

// Middleware chains
const authChain = [requireAuth, requireFranchise];
const readOnlyMin = [...authChain, requireRole("viewer")];
const mutateMin = [...authChain, requireRole("admin")];

function getFranchiseId(req: Request): string {
  return req.auth!.franchise!.id;
}

function getMutationContext(req: Request): MutationContext {
  return {
    franchiseId: req.auth!.franchise!.id,
    userId: req.auth!.user.id,
    userEmail: req.auth!.user.email,
    ipAddress: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null
  };
}

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

// ===========================================================================
// 1. EXPENSE ITEMS
// ===========================================================================

transactionRouter.get("/expenses", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listExpenses(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /expenses", err);
  }
});

transactionRouter.get("/expenses/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getExpense(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Expense item");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /expenses/:id", err);
  }
});

transactionRouter.post("/expenses", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = ExpenseItemCreateSchema.parse(req.body);
    const row = await createExpense(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /expenses", err);
  }
});

transactionRouter.patch("/expenses/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = ExpenseItemUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateExpense(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /expenses/:id", err);
  }
});

transactionRouter.delete("/expenses/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteExpense(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /expenses/:id", err);
  }
});

// ===========================================================================
// 2. COMMISSION ITEMS
// ===========================================================================

transactionRouter.get("/commissions", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listCommissions(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /commissions", err);
  }
});

transactionRouter.get("/commissions/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getCommission(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Commission item");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /commissions/:id", err);
  }
});

transactionRouter.post("/commissions", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = CommissionItemCreateSchema.parse(req.body);
    const row = await createCommission(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /commissions", err);
  }
});

transactionRouter.patch("/commissions/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = CommissionItemUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateCommission(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /commissions/:id", err);
  }
});

transactionRouter.delete("/commissions/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteCommission(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /commissions/:id", err);
  }
});

// ===========================================================================
// 3. CREDIT TRANSACTIONS
// ===========================================================================

transactionRouter.get("/credits", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listCredits(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /credits", err);
  }
});

transactionRouter.get("/credits/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getCredit(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Credit transaction");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /credits/:id", err);
  }
});

transactionRouter.post("/credits", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = CreditTransactionCreateSchema.parse(req.body);
    const row = await createCredit(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /credits", err);
  }
});

transactionRouter.patch("/credits/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = CreditTransactionUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateCredit(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /credits/:id", err);
  }
});

transactionRouter.delete("/credits/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteCredit(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /credits/:id", err);
  }
});

// ===========================================================================
// 4. OWNER TRANSACTIONS
// ===========================================================================

transactionRouter.get("/owner", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listOwnerTransactions(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /owner", err);
  }
});

transactionRouter.get("/owner/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getOwnerTransaction(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Owner transaction");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /owner/:id", err);
  }
});

transactionRouter.post("/owner", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = OwnerTransactionCreateSchema.parse(req.body);
    const row = await createOwnerTransaction(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /owner", err);
  }
});

transactionRouter.patch("/owner/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = OwnerTransactionUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateOwnerTransaction(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /owner/:id", err);
  }
});

transactionRouter.delete("/owner/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteOwnerTransaction(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /owner/:id", err);
  }
});

// ===========================================================================
// 5. JAZZ LOAD LIFTING
// ===========================================================================

transactionRouter.get("/jazz-load/lifting", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listJazzLifting(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /jazz-load/lifting", err);
  }
});

transactionRouter.get("/jazz-load/lifting/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getJazzLifting(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Jazz Load lifting record");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /jazz-load/lifting/:id", err);
  }
});

transactionRouter.post("/jazz-load/lifting", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = JazzLiftingCreateSchema.parse(req.body);
    const row = await createJazzLifting(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /jazz-load/lifting", err);
  }
});

transactionRouter.patch("/jazz-load/lifting/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = JazzLiftingUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateJazzLifting(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /jazz-load/lifting/:id", err);
  }
});

transactionRouter.delete("/jazz-load/lifting/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteJazzLifting(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /jazz-load/lifting/:id", err);
  }
});

// ===========================================================================
// 6. JAZZ LOAD DO ENTRIES
// ===========================================================================

transactionRouter.get("/jazz-load/do", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listJazzDoEntries(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /jazz-load/do", err);
  }
});

transactionRouter.get("/jazz-load/do/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getJazzDoEntry(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Jazz Load DO entry");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /jazz-load/do/:id", err);
  }
});

transactionRouter.post("/jazz-load/do", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = JazzDoEntryCreateSchema.parse(req.body);
    const row = await createJazzDoEntry(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /jazz-load/do", err);
  }
});

transactionRouter.patch("/jazz-load/do/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = JazzDoEntryUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateJazzDoEntry(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /jazz-load/do/:id", err);
  }
});

transactionRouter.delete("/jazz-load/do/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteJazzDoEntry(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /jazz-load/do/:id", err);
  }
});

// ===========================================================================
// 7 & 8. STOCK ORDERS
// ===========================================================================

transactionRouter.get("/stock/orders", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listStockOrders(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /stock/orders", err);
  }
});

transactionRouter.get("/stock/orders/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getStockOrder(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Stock order");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /stock/orders/:id", err);
  }
});

transactionRouter.post("/stock/orders", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = StockOrderCreateSchema.parse(req.body);
    const row = await createStockOrder(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /stock/orders", err);
  }
});

transactionRouter.patch("/stock/orders/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = StockOrderUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateStockOrder(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /stock/orders/:id", err);
  }
});

transactionRouter.delete("/stock/orders/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteStockOrder(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /stock/orders/:id", err);
  }
});

// ===========================================================================
// 9. STOCK ACCOUNT PAYMENTS
// ===========================================================================

transactionRouter.get("/stock/account-payments", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listStockAccountPayments(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /stock/account-payments", err);
  }
});

transactionRouter.get("/stock/account-payments/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getStockAccountPayment(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Stock account payment");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /stock/account-payments/:id", err);
  }
});

transactionRouter.post("/stock/account-payments", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = StockAccountPaymentCreateSchema.parse(req.body);
    const row = await createStockAccountPayment(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /stock/account-payments", err);
  }
});

transactionRouter.patch("/stock/account-payments/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = StockAccountPaymentUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateStockAccountPayment(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /stock/account-payments/:id", err);
  }
});

transactionRouter.delete("/stock/account-payments/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteStockAccountPayment(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /stock/account-payments/:id", err);
  }
});

// ===========================================================================
// 10. JAZZ COMPANY PAYABLE PAYMENTS
// ===========================================================================

transactionRouter.get("/jazz-company/payments", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const filter = TransactionFilterQuery.parse(req.query);
    const rows = await listJazzPayablePayments(getFranchiseId(req), filter);
    res.json({ data: rows });
  } catch (err) {
    handleTransactionError(res, "GET /jazz-company/payments", err);
  }
});

transactionRouter.get("/jazz-company/payments/:id", readOnlyMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const row = await getJazzPayablePayment(getFranchiseId(req), id);
    if (!row) return void sendNotFound(res, "Jazz Company payable payment");
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "GET /jazz-company/payments/:id", err);
  }
});

transactionRouter.post("/jazz-company/payments", mutateMin, async (req: Request, res: Response) => {
  try {
    const body = JazzPayablePaymentCreateSchema.parse(req.body);
    const row = await createJazzPayablePayment(getMutationContext(req), body);
    res.status(201).json({ data: row });
  } catch (err) {
    handleTransactionError(res, "POST /jazz-company/payments", err);
  }
});

transactionRouter.patch("/jazz-company/payments/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const body = JazzPayablePaymentUpdateSchema.parse(req.body);
    if (guardEmptyUpdate(res, body as Record<string, unknown>)) return;
    const row = await updateJazzPayablePayment(getMutationContext(req), id, body);
    res.json({ data: row });
  } catch (err) {
    handleTransactionError(res, "PATCH /jazz-company/payments/:id", err);
  }
});

transactionRouter.delete("/jazz-company/payments/:id", mutateMin, async (req: Request, res: Response) => {
  try {
    const { id } = UuidParam.parse(req.params);
    const result = await deleteJazzPayablePayment(getMutationContext(req), id);
    res.json(result);
  } catch (err) {
    handleTransactionError(res, "DELETE /jazz-company/payments/:id", err);
  }
});
