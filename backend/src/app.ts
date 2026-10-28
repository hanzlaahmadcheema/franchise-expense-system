import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { checkDatabaseConnection } from "./config/database.js";
import { requireAuth } from "./auth/authMiddleware.js";
import { requireFranchise } from "./auth/tenantMiddleware.js";
import { requireRole } from "./auth/rbacMiddleware.js";
import { catalogRouter } from "./catalogs/routes.js";
import { transactionRouter } from "./transactions/routes.js";
import { calculationRouter } from "./calculations/routes.js";
import { periodRouter } from "./periods/routes.js";
import { authRouter } from "./auth/routes.js";

export const app: Express = express();

// Standard middleware with Tailscale and local network support
app.use(
  cors({
    origin: (requestOrigin, callback) => {
      // Allow requests with no origin (e.g. mobile apps, curl, server-to-server)
      if (!requestOrigin) return callback(null, true);

      try {
        const parsed = new URL(requestOrigin);
        // Allow localhost and 127.0.0.1
        if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
          return callback(null, true);
        }
        // Allow Tailscale MagicDNS (*.ts.net) and Tailscale CGNAT IPs (100.64.0.0/10)
        if (parsed.hostname.endsWith(".ts.net") || parsed.hostname.startsWith("100.")) {
          return callback(null, true);
        }
        // Allow local LAN hostnames and IPs
        if (
          parsed.hostname === "cheemae" ||
          parsed.hostname.startsWith("192.168.") ||
          parsed.hostname.startsWith("10.") ||
          parsed.hostname.startsWith("172.")
        ) {
          return callback(null, true);
        }
        // Match configured CORS_ORIGIN
        if (env.CORS_ORIGIN && (requestOrigin === env.CORS_ORIGIN || parsed.origin === env.CORS_ORIGIN)) {
          return callback(null, true);
        }
      } catch {
        // Fallback for non-standard origin formats
      }

      // Safe fallback for internal/tailscale operations
      return callback(null, true);
    },
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
      username: req.auth.user.username,
      firebaseUid: req.auth.user.firebaseUid,
      email: req.auth.user.email,
      displayName: req.auth.user.displayName,
      role: req.auth.franchise?.role ?? "viewer"
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

// Local Authentication API (Login, Logout, Me)
app.use("/api/v1/auth", authRouter);

// Phase 4: Master Catalog & Rate Management API
app.use("/api/v1/catalogs", catalogRouter);

// Phase 5: Operational Ledger Transactions API
app.use("/api/v1/transactions", transactionRouter);

// Phase 6: Server-Authoritative Calculation & Projection Engine API
app.use("/api/v1/calculations", calculationRouter);

// Phase 7B: Period Initialization & Opening Seed Governance API
app.use("/api/v1/periods", periodRouter);

// Fallback 404 handler for undefined API routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: "Requested API endpoint does not exist."
  });
});
