import express, { type Request, type Response } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { checkDatabaseConnection } from "./config/database.js";
import { requireAuth } from "./auth/authMiddleware.js";
import { requireFranchise } from "./auth/tenantMiddleware.js";
import { requireRole } from "./auth/rbacMiddleware.js";
import { catalogRouter } from "./catalogs/routes.js";

export const app = express();

// Standard middleware
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true
  })
);
app.use(express.json());

/**
 * GET /health
 * 
 * Diagnostic health endpoint verifying:
 * 1. HTTP server availability
 * 2. Database round-trip connectivity via SELECT 1
 * 
 * Security: Sanitized response that never exposes database credentials or connection strings.
 */
app.get("/health", async (_req: Request, res: Response) => {
  const dbHealth = await checkDatabaseConnection();

  if (dbHealth.ok) {
    res.status(200).json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: {
        status: "connected",
        latencyMs: dbHealth.latencyMs
      },
      environment: env.NODE_ENV
    });
  } else {
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      database: {
        status: "disconnected",
        error: dbHealth.error ?? "Connection check failed"
      },
      environment: env.NODE_ENV
    });
  }
});

/**
 * Verification Handler for /auth/me
 */
function handleAuthMe(req: Request, res: Response) {
  if (!req.auth) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "No authentication context found."
    });
    return;
  }

  res.status(200).json({
    user: {
      id: req.auth.user.id,
      firebaseUid: req.auth.user.firebaseUid,
      email: req.auth.user.email,
      displayName: req.auth.user.displayName
    },
    franchise: req.auth.franchise
      ? {
          id: req.auth.franchise.id,
          code: req.auth.franchise.code,
          name: req.auth.franchise.name,
          brandName: req.auth.franchise.brandName,
          role: req.auth.franchise.role
        }
      : undefined,
    availableFranchises: req.auth.availableFranchises
  });
}

// Protected verification endpoints (supporting both root and versioned paths)
app.get("/auth/me", requireAuth, requireFranchise, handleAuthMe);
app.get("/api/v1/auth/me", requireAuth, requireFranchise, handleAuthMe);

// Verification test endpoints for RBAC role enforcement
app.get("/auth/test-role/owner", requireAuth, requireFranchise, requireRole("owner"), (_req: Request, res: Response) => {
  res.status(200).json({ allowed: true, requiredRole: "owner" });
});

app.get("/auth/test-role/admin", requireAuth, requireFranchise, requireRole("admin"), (_req: Request, res: Response) => {
  res.status(200).json({ allowed: true, requiredRole: "admin" });
});

app.get("/auth/test-role/viewer", requireAuth, requireFranchise, requireRole("viewer"), (_req: Request, res: Response) => {
  res.status(200).json({ allowed: true, requiredRole: "viewer" });
});

// Phase 4: Master Catalog & Rate Management API
app.use("/api/v1/catalogs", catalogRouter);

// Fallback 404 handler for undefined API routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: "Requested API endpoint does not exist."
  });
});
