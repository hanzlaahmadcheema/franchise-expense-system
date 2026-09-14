import express, { type Request, type Response } from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { checkDatabaseConnection } from "./config/database.js";

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

// Fallback 404 handler for undefined API routes
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: "Not Found",
    message: "Requested API endpoint does not exist."
  });
});
