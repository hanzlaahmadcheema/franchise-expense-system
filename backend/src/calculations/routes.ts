/**
 * Phase 6B: Calculation & Projection REST Routes
 *
 * Mounted at `/api/v1/calculations`.
 * Enforces:
 * - requireAuth & requireFranchise
 * - Tenant isolation: franchiseId strictly from req.auth.franchise.id
 * - Strict RBAC:
 *   - Read projections & runs: viewer, admin, owner
 *   - Trigger recalculation & rebuilds: admin, owner
 */

import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../auth/authMiddleware.js";
import { requireFranchise } from "../auth/tenantMiddleware.js";
import { requireRole } from "../auth/rbacMiddleware.js";
import { InvariantViolationError } from "./invariants.js";
import {
  rebuildDay,
  recalculateFromDay,
  rebuildPeriod,
  getDayProjections,
  getPeriodInvariants,
  listCalculationRuns
} from "./service.js";

export const calculationRouter = Router();

// Apply auth and tenant middleware to all calculation routes
calculationRouter.use(requireAuth);
calculationRouter.use(requireFranchise);

const UuidParam = z.string().uuid();

function getFranchiseId(req: Request): string {
  const fid = req.auth?.franchise?.id;
  if (!fid) {
    throw new Error("Missing authenticated franchise context.");
  }
  return fid;
}

function getUserId(req: Request): string | null {
  return req.auth?.user?.id ?? null;
}

function handleCalculationError(res: Response, endpoint: string, err: unknown) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Invalid input parameters.",
      details: err.errors
    });
    return;
  }

  if (err instanceof InvariantViolationError) {
    res.status(422).json({
      error: "INVARIANT_VIOLATION",
      code: err.code,
      message: err.message,
      details: err.details
    });
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({
    error: "CALCULATION_ERROR",
    endpoint,
    message
  });
}

/**
 * POST /api/v1/calculations/rebuild-day/:dayId
 * Rebuild single day projections.
 */
calculationRouter.post(
  "/rebuild-day/:dayId",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const dayId = UuidParam.parse(req.params.dayId);
      const userId = getUserId(req);

      const result = await rebuildDay(franchiseId, dayId, {
        triggerSource: "rebuild",
        userId
      });

      res.status(200).json({
        message: "Day calculation completed successfully.",
        data: result
      });
    } catch (err) {
      handleCalculationError(res, "POST /rebuild-day/:dayId", err);
    }
  }
);

/**
 * POST /api/v1/calculations/rebuild-from-day/:dayId
 * Historical correction / cascade from day forward through period end.
 */
calculationRouter.post(
  "/rebuild-from-day/:dayId",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const dayId = UuidParam.parse(req.params.dayId);
      const userId = getUserId(req);

      const result = await recalculateFromDay(franchiseId, dayId, {
        triggerSource: "rebuild",
        userId
      });

      res.status(200).json({
        message: "Forward cascade recalculation completed successfully.",
        data: result
      });
    } catch (err) {
      handleCalculationError(res, "POST /rebuild-from-day/:dayId", err);
    }
  }
);

/**
 * POST /api/v1/calculations/rebuild-period/:periodId
 * Full period rebuild from Day 1 to period end.
 */
calculationRouter.post(
  "/rebuild-period/:periodId",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const userId = getUserId(req);

      const result = await rebuildPeriod(franchiseId, periodId, {
        triggerSource: "rebuild",
        userId
      });

      res.status(200).json({
        message: "Full period rebuild completed successfully.",
        data: result
      });
    } catch (err) {
      handleCalculationError(res, "POST /rebuild-period/:periodId", err);
    }
  }
);

/**
 * GET /api/v1/calculations/projections/day/:dayId
 * Get all 6 projected domain records for a specific day.
 */
calculationRouter.get(
  "/projections/day/:dayId",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const dayId = UuidParam.parse(req.params.dayId);

      const projections = await getDayProjections(franchiseId, dayId);
      if (!projections) {
        res.status(404).json({
          error: "NOT_FOUND",
          message: "Accounting day not found."
        });
        return;
      }

      res.status(200).json({ data: projections });
    } catch (err) {
      handleCalculationError(res, "GET /projections/day/:dayId", err);
    }
  }
);

/**
 * GET /api/v1/calculations/invariants/:periodId
 * List invariant violations for an accounting period.
 */
calculationRouter.get(
  "/invariants/:periodId",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);

      const violations = await getPeriodInvariants(franchiseId, periodId);
      res.status(200).json({ data: violations });
    } catch (err) {
      handleCalculationError(res, "GET /invariants/:periodId", err);
    }
  }
);

/**
 * GET /api/v1/calculations/runs
 * Audit log of calculation runs.
 */
calculationRouter.get(
  "/runs",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);

      const runs = await listCalculationRuns(franchiseId, limit, offset);
      res.status(200).json({ data: runs });
    } catch (err) {
      handleCalculationError(res, "GET /runs", err);
    }
  }
);
