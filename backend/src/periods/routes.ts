/**
 * Phase 7B: Period and Opening Seed REST Routes
 *
 * Mounted at `/api/v1/periods`.
 * Enforces:
 * - requireAuth & requireFranchise
 * - Tenant isolation: franchiseId strictly from req.auth.franchise.id
 * - Role-Based Access Control:
 *   - Viewer: Read periods, days, seeds, validation
 *   - Admin: Stage seeds, trigger seed validation
 *   - Owner: Initialize period, verify seeds, activate Day 1, seed correction
 */

import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../auth/authMiddleware.js";
import { requireFranchise } from "../auth/tenantMiddleware.js";
import { requireRole } from "../auth/rbacMiddleware.js";
import { InvariantViolationError } from "../calculations/invariants.js";
import { PeriodError } from "./errors.js";
import {
  InitializePeriodSchema,
  SeedBundleSchema
} from "./schemas.js";
import {
  initializePeriod,
  getPeriod,
  listPeriods,
  stageSeeds,
  validateSeeds,
  verifySeeds,
  activatePeriod,
  getSeeds,
  type PeriodServiceUser
} from "./service.js";

export const periodRouter = Router();

// Apply auth and tenant middleware to all period routes
periodRouter.use(requireAuth);
periodRouter.use(requireFranchise);

const UuidParam = z.string().uuid();

function getFranchiseId(req: Request): string {
  const fid = req.auth?.franchise?.id;
  if (!fid) {
    throw new Error("Missing authenticated franchise context.");
  }
  return fid;
}

function getServiceUser(req: Request): PeriodServiceUser {
  return {
    id: req.auth?.user?.id ?? null,
    email: req.auth?.user?.email ?? null,
    role: req.auth?.franchise?.role ?? "viewer"
  };
}

function handlePeriodError(res: Response, endpoint: string, err: unknown) {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Invalid input parameters.",
      details: err.errors
    });
    return;
  }

  if (err instanceof PeriodError) {
    res.status(err.statusCode).json({
      error: err.code,
      message: err.message.replace(`[${err.code}] `, ""),
      code: err.code,
      ...err.details
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
  console.error(`[${endpoint}] Unexpected error:`, message);
  res.status(500).json({
    error: "INTERNAL_ERROR",
    endpoint,
    message
  });
}

/**
 * POST /api/v1/periods/initialize
 * Owner-only: Atomically creates monthly accounting period and provisions 30 closed calendar days.
 */
periodRouter.post(
  "/initialize",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const user = getServiceUser(req);
      const parsedBody = InitializePeriodSchema.parse(req.body);

      const result = await initializePeriod(franchiseId, parsedBody.periodKey, user);

      const status = result.created ? 201 : 200;
      res.status(status).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/initialize", err);
    }
  }
);

/**
 * GET /api/v1/periods
 * Viewer/Admin/Owner: List all periods for the authenticated franchise.
 */
periodRouter.get(
  "/",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periods = await listPeriods(franchiseId);
      res.status(200).json({ periods });
    } catch (err) {
      handlePeriodError(res, "GET /api/v1/periods", err);
    }
  }
);

/**
 * GET /api/v1/periods/:periodId
 * Viewer/Admin/Owner: Fetch accounting period and its provisioned days.
 */
periodRouter.get(
  "/:periodId",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);

      const result = await getPeriod(franchiseId, periodId);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "GET /api/v1/periods/:periodId", err);
    }
  }
);

/**
 * GET /api/v1/periods/:periodId/seeds
 * Viewer/Admin/Owner: View current opening seeds and verification status.
 */
periodRouter.get(
  "/:periodId/seeds",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);

      const result = await getSeeds(franchiseId, periodId);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "GET /api/v1/periods/:periodId/seeds", err);
    }
  }
);

/**
 * PUT /api/v1/periods/:periodId/seeds
 * Admin/Owner: Stage or update opening seed bundle.
 * Resets is_verified = false.
 */
periodRouter.put(
  "/:periodId/seeds",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);
      const bundle = SeedBundleSchema.parse(req.body);

      const result = await stageSeeds(franchiseId, periodId, bundle, user);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "PUT /api/v1/periods/:periodId/seeds", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/validate-seeds
 * Admin/Owner: Run full validation on staged opening state.
 */
periodRouter.post(
  "/:periodId/validate-seeds",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);

      const result = await validateSeeds(franchiseId, periodId);

      if (!result.isValid) {
        res.status(422).json({
          error: "SEED_VALIDATION_FAILED",
          message: `Opening seed validation failed: ${result.errors.join("; ")}`,
          isValid: false,
          errors: result.errors,
          warnings: result.warnings
        });
        return;
      }

      res.status(200).json({
        message: "All opening seeds are valid and catalog completeness verified.",
        isValid: true,
        errors: [],
        warnings: result.warnings
      });
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/validate-seeds", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/verify-seeds
 * Owner-only: Runs validation, executes Day 1 baseline calculation, proves Opening == Closing,
 * and marks is_verified = true.
 */
periodRouter.post(
  "/:periodId/verify-seeds",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);

      const result = await verifySeeds(franchiseId, periodId, user);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/verify-seeds", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/activate
 * Owner-only: Activates Day 1 (status -> open). Days 2..30 strictly remain closed.
 */
periodRouter.post(
  "/:periodId/activate",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);

      const result = await activatePeriod(franchiseId, periodId, user);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/activate", err);
    }
  }
);
