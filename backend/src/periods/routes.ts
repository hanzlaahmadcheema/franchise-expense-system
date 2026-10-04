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
  SeedBundleSchema,
  CloseDaySchema,
  OpenDaySchema,
  ReopenDaySchema,
  ClosePeriodSchema,
  RolloverSchema,
  SeedCorrectionSchema,
  CreateFinalSettlementSchema,
  UpdateFinalSettlementSchema
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
  closeAccountingDay,
  openNextAccountingDay,
  reopenAccountingDay,
  verifyPeriodFinalSettlement,
  closeAccountingPeriod,
  initializeNextPeriodFromClosedPeriod,
  rolloverPeriod,
  getSeedDelta,
  applySeedCorrection,
  listPeriodFinalSettlements,
  createPeriodFinalSettlement,
  updatePeriodFinalSettlement,
  deletePeriodFinalSettlement,
  type PeriodServiceUser
} from "./service.js";

export const periodRouter: Router = Router();

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

function getClientMutationId(req: Request): string | undefined {
  return (
    (req.headers["x-client-mutation-id"] as string) ||
    (req.body?.clientMutationId as string) ||
    (req.body?.client_mutation_id as string) ||
    undefined
  );
}

/**
 * POST /api/v1/periods/:periodId/days/:dayNo/close
 * Admin/Owner: Closes an active accounting day with baseline recalculation & audit.
 */
periodRouter.post(
  "/:periodId/days/:dayNo/close",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const dayNoRaw = Array.isArray(req.params.dayNo) ? req.params.dayNo[0] : req.params.dayNo;
      const dayNo = parseInt(dayNoRaw, 10);
      if (isNaN(dayNo) || dayNo < 1 || dayNo > 32) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: "Invalid day number." });
        return;
      }
      const user = getServiceUser(req);
      const parsedBody = CloseDaySchema.parse(req.body ?? {});
      const clientMutationId = getClientMutationId(req);

      const result = await closeAccountingDay(
        franchiseId,
        periodId,
        dayNo,
        parsedBody.notes ?? null,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/days/:dayNo/close", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/days/:dayNo/open
 * Admin/Owner: Opens next accounting day. Strictly enforces sequential progression (Day N-1 must be closed).
 */
periodRouter.post(
  "/:periodId/days/:dayNo/open",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const dayNoRaw = Array.isArray(req.params.dayNo) ? req.params.dayNo[0] : req.params.dayNo;
      const dayNo = parseInt(dayNoRaw, 10);
      if (isNaN(dayNo) || dayNo < 1 || dayNo > 32) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: "Invalid day number." });
        return;
      }
      const user = getServiceUser(req);
      const parsedBody = OpenDaySchema.parse(req.body ?? {});
      const clientMutationId = getClientMutationId(req);

      const result = await openNextAccountingDay(
        franchiseId,
        periodId,
        dayNo,
        parsedBody.notes ?? null,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/days/:dayNo/open", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/days/:dayNo/reopen
 * Owner-only: Reopens a closed day for governed correction.
 */
periodRouter.post(
  "/:periodId/days/:dayNo/reopen",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const dayNoRaw = Array.isArray(req.params.dayNo) ? req.params.dayNo[0] : req.params.dayNo;
      const dayNo = parseInt(dayNoRaw, 10);
      if (isNaN(dayNo) || dayNo < 1 || dayNo > 32) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: "Invalid day number." });
        return;
      }
      const user = getServiceUser(req);
      const parsedBody = ReopenDaySchema.parse(req.body);

      const result = await reopenAccountingDay(franchiseId, periodId, dayNo, parsedBody.reason, user);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/days/:dayNo/reopen", err);
    }
  }
);

/**
 * GET /api/v1/periods/:periodId/final-settlements
 * List all final settlement entries and domain summaries for a period.
 */
periodRouter.get(
  "/:periodId/final-settlements",
  requireRole("viewer"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const result = await listPeriodFinalSettlements(franchiseId, periodId);
      res.status(200).json({ data: result });
    } catch (err) {
      handlePeriodError(res, "GET /api/v1/periods/:periodId/final-settlements", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/final-settlements
 * Add a new final settlement record to a period's FINAL closing state.
 */
periodRouter.post(
  "/:periodId/final-settlements",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);
      const parsedBody = CreateFinalSettlementSchema.parse(req.body);
      const clientMutationId = getClientMutationId(req);

      const result = await createPeriodFinalSettlement(
        franchiseId,
        periodId,
        parsedBody,
        user,
        clientMutationId
      );
      res.status(201).json({
        data: result.entry,
        finalSettlements: result.finalSettlements,
        message: "Final settlement record added successfully."
      });
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/final-settlements", err);
    }
  }
);

/**
 * PUT /api/v1/periods/:periodId/final-settlements/:settlementId
 * Update an existing final settlement record before period/FINAL verification.
 */
periodRouter.put(
  "/:periodId/final-settlements/:settlementId",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const settlementId = UuidParam.parse(req.params.settlementId);
      const user = getServiceUser(req);
      const parsedBody = UpdateFinalSettlementSchema.parse(req.body);

      const result = await updatePeriodFinalSettlement(
        franchiseId,
        periodId,
        settlementId,
        parsedBody,
        user
      );
      res.status(200).json({
        data: result.entry,
        finalSettlements: result.finalSettlements,
        message: "Final settlement record updated successfully."
      });
    } catch (err) {
      handlePeriodError(res, "PUT /api/v1/periods/:periodId/final-settlements/:settlementId", err);
    }
  }
);

/**
 * DELETE /api/v1/periods/:periodId/final-settlements/:settlementId
 * Delete a final settlement record before period/FINAL verification.
 */
periodRouter.delete(
  "/:periodId/final-settlements/:settlementId",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const settlementId = UuidParam.parse(req.params.settlementId);
      const user = getServiceUser(req);

      const result = await deletePeriodFinalSettlement(
        franchiseId,
        periodId,
        settlementId,
        user
      );
      res.status(200).json({
        deleted: true,
        id: result.id,
        finalSettlements: result.finalSettlements,
        message: "Final settlement record deleted successfully."
      });
    } catch (err) {
      handlePeriodError(res, "DELETE /api/v1/periods/:periodId/final-settlements/:settlementId", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/final/verify
 * Verify month-end FINAL settlement (Owner Only).
 */
periodRouter.post(
  "/:periodId/final/verify",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);
      const body = z
        .object({
          allowOutstanding: z.boolean().optional(),
          notes: z.string().optional()
        })
        .parse(req.body ?? {});

      const result = await verifyPeriodFinalSettlement(
        franchiseId,
        periodId,
        user,
        body
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/final/verify", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/close
 * Owner-only: Closes an accounting period once all calendar days are closed.
 */
periodRouter.post(
  "/:periodId/close",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);
      const parsedBody = ClosePeriodSchema.parse(req.body ?? {});
      const clientMutationId = getClientMutationId(req);

      const result = await closeAccountingPeriod(
        franchiseId,
        periodId,
        parsedBody.notes ?? null,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/close", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/initialize-next
 * Owner-only: Governed initialization and activation of successor accounting period from a closed period.
 */
periodRouter.post(
  "/:periodId/initialize-next",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);
      const clientMutationId = getClientMutationId(req);

      const result = await initializeNextPeriodFromClosedPeriod(
        franchiseId,
        periodId,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/initialize-next", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/rollover
 * Owner-only: Stages rollover to the next calendar period and extracts carry-forward seeds.
 */
periodRouter.post(
  "/:periodId/rollover",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const user = getServiceUser(req);
      const previousPeriodId = String(req.params.periodId);
      const clientMutationId = getClientMutationId(req);

      const result = await rolloverPeriod(
        franchiseId,
        previousPeriodId,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/rollover", err);
    }
  }
);

/**
 * POST /api/v1/periods/rollover
 * Owner-only: Stages rollover to the next calendar period and extracts carry-forward seeds.
 */
periodRouter.post(
  "/rollover",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const user = getServiceUser(req);
      const parsedBody = RolloverSchema.parse(req.body);
      const clientMutationId = getClientMutationId(req);

      const result = await rolloverPeriod(
        franchiseId,
        parsedBody.previousPeriodId,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/rollover", err);
    }
  }
);

/**
 * GET /api/v1/periods/:periodId/seed-delta
 * Owner-only: Computes delta between current staged seeds and source period closing state.
 */
periodRouter.get(
  "/:periodId/seed-delta",
  requireRole("admin"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);

      const result = await getSeedDelta(franchiseId, periodId);
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "GET /api/v1/periods/:periodId/seed-delta", err);
    }
  }
);

/**
 * POST /api/v1/periods/:periodId/seed-correction
 * Owner-only: Applies explicit governed seed correction and triggers recalculation.
 */
periodRouter.post(
  "/:periodId/seed-correction",
  requireRole("owner"),
  async (req: Request, res: Response) => {
    try {
      const franchiseId = getFranchiseId(req);
      const periodId = UuidParam.parse(req.params.periodId);
      const user = getServiceUser(req);
      const parsedBody = SeedCorrectionSchema.parse(req.body);
      const clientMutationId = getClientMutationId(req);

      const result = await applySeedCorrection(
        franchiseId,
        periodId,
        parsedBody.reason,
        parsedBody.seeds,
        user,
        clientMutationId
      );
      res.status(200).json(result);
    } catch (err) {
      handlePeriodError(res, "POST /api/v1/periods/:periodId/seed-correction", err);
    }
  }
);
