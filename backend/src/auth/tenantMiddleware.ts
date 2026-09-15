import type { Request, Response, NextFunction } from "express";
import { db } from "../config/database.js";
import { sql } from "kysely";
import type { UserFranchiseMembership, UserRole } from "./types.js";

interface MembershipRow {
  id: string;
  role: UserRole;
  code: string;
  name: string;
  brand_name: string;
}

/**
 * requireFranchise Middleware
 * 
 * Enforces:
 * 1. User is authenticated (req.auth exists)
 * 2. User has active membership in at least one franchise
 * 3. Deterministic resolution of franchise context:
 *    - If X-Franchise-Id / X-Franchise-Code header is provided: verifies membership
 *    - If no header provided and exactly 1 membership: automatically selects it
 *    - If no header provided and multiple memberships: rejects with 400 FRANCHISE_CONTEXT_REQUIRED
 */
export async function requireFranchise(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.auth || !req.auth.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Authentication context is required before resolving franchise."
    });
    return;
  }

  const userId = req.auth.user.id;

  try {
    const result = await sql<MembershipRow>`
      SELECT 
        fu.franchise_id AS id,
        fu.role,
        f.code,
        f.name,
        f.brand_name
      FROM franchise_users fu
      JOIN franchises f ON f.id = fu.franchise_id
      WHERE fu.user_id = ${userId}
        AND fu.is_active = TRUE
        AND f.is_active = TRUE;
    `.execute(db);

    const memberships: UserFranchiseMembership[] = result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      brandName: row.brand_name,
      role: row.role
    }));

    req.auth.availableFranchises = memberships;

    if (memberships.length === 0) {
      res.status(403).json({
        error: "NO_FRANCHISE_MEMBERSHIP",
        message: "User does not have active membership in any franchise."
      });
      return;
    }

    // Check if client requested a specific franchise
    const requestedId = (req.headers["x-franchise-id"] as string | undefined)?.trim();
    const requestedCode = (req.headers["x-franchise-code"] as string | undefined)?.trim();
    const queryFranchiseId = typeof req.query.franchiseId === "string" ? req.query.franchiseId.trim() : undefined;

    const requestedIdentifier = requestedId || requestedCode || queryFranchiseId;

    if (requestedIdentifier) {
      const match = memberships.find(
        (m) => m.id.toLowerCase() === requestedIdentifier.toLowerCase() ||
               m.code.toLowerCase() === requestedIdentifier.toLowerCase()
      );

      if (!match) {
        res.status(403).json({
          error: "FRANCHISE_ACCESS_DENIED",
          message: "User is not authorized for the requested franchise."
        });
        return;
      }

      req.auth.franchise = match;
      next();
      return;
    }

    // No specific franchise requested:
    // If exactly 1 membership exists, auto-select it
    if (memberships.length === 1) {
      req.auth.franchise = memberships[0];
      next();
      return;
    }

    // Multiple memberships exist but none requested: require client to choose
    res.status(400).json({
      error: "FRANCHISE_CONTEXT_REQUIRED",
      message: "User belongs to multiple franchises. Please specify 'X-Franchise-Id' header.",
      availableFranchises: memberships
    });
  } catch (err) {
    console.error("[Tenant Middleware Database Error]", err instanceof Error ? err.message : err);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to resolve franchise membership."
    });
  }
}
