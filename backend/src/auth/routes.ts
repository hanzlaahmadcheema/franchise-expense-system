import { Router, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { sql } from "kysely";
import { db } from "../config/database.js";
import { verifyPassword } from "./password.js";
import { createSession, revokeSession } from "./sessionService.js";
import { requireAuth } from "./authMiddleware.js";
import { requireFranchise } from "./tenantMiddleware.js";
import type { UserRole } from "./types.js";

export const authRouter: Router = Router();

const LoginSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(64),
  password: z.string().min(1, "Password is required")
});

interface UserAuthRow {
  id: string;
  username: string;
  email: string | null;
  display_name: string | null;
  password_hash: string | null;
  is_active: boolean;
}

interface FranchiseMemberRow {
  franchise_id: string;
  code: string;
  name: string;
  brand_name: string;
  role: UserRole;
}

// Dummy hash used for constant-time comparison when username is not found (mitigates timing attacks)
const DUMMY_SCRYPT_HASH =
  "scrypt$00000000000000000000000000000000$00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

/**
 * POST /api/v1/auth/login
 * Local username/password login endpoint.
 */
authRouter.post("/login", async (req: Request, res: Response) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);

    const userResult = await sql<UserAuthRow>`
      SELECT id, username, email, display_name, password_hash, is_active
      FROM users
      WHERE LOWER(username) = LOWER(${username})
         OR LOWER(email) = LOWER(${username})
      LIMIT 1;
    `.execute(db);

    const user = userResult.rows[0];

    // Mitigate timing attacks by always performing a verification
    const hashToVerify = user?.password_hash || DUMMY_SCRYPT_HASH;
    const isValidPassword = await verifyPassword(password, hashToVerify);

    if (!user || !user.password_hash || !isValidPassword) {
      res.status(401).json({
        error: "INVALID_CREDENTIALS",
        message: "Invalid username or password."
      });
      return;
    }

    if (!user.is_active) {
      res.status(403).json({
        error: "USER_DEACTIVATED",
        message: "Account is inactive. Please contact an administrator."
      });
      return;
    }

    // Resolve user's active franchise membership
    const franchiseResult = await sql<FranchiseMemberRow>`
      SELECT 
        fu.franchise_id,
        fu.role,
        f.code,
        f.name,
        f.brand_name
      FROM franchise_users fu
      JOIN franchises f ON f.id = fu.franchise_id
      WHERE fu.user_id = ${user.id}
        AND fu.is_active = TRUE
        AND f.is_active = TRUE
      LIMIT 1;
    `.execute(db);

    const primaryFranchise = franchiseResult.rows[0];
    if (!primaryFranchise) {
      res.status(403).json({
        error: "NO_ACTIVE_FRANCHISE",
        message: "User does not have an active franchise assignment."
      });
      return;
    }

    // Create server-authoritative session
    const { token, expiresAt } = await createSession(user.id);

    res.status(200).json({
      token,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        role: primaryFranchise.role
      },
      franchise: {
        id: primaryFranchise.franchise_id,
        code: primaryFranchise.code,
        name: primaryFranchise.name,
        brandName: primaryFranchise.brand_name,
        role: primaryFranchise.role
      }
    });
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Invalid login credentials format.",
        details: err.errors
      });
      return;
    }

    console.error("[Login Error]", err instanceof Error ? err.message : err);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "An unexpected error occurred during login."
    });
  }
});

/**
 * POST /api/v1/auth/logout
 * Revokes the session associated with the bearer token.
 */
authRouter.post("/logout", requireAuth, async (req: Request, res: Response) => {
  const token = req.auth?.token;
  if (token) {
    await revokeSession(token);
  }

  res.status(200).json({
    success: true,
    message: "Logged out successfully."
  });
});

/**
 * GET /api/v1/auth/me
 * Returns current authenticated user and franchise context.
 */
authRouter.get("/me", requireAuth, requireFranchise, (req: Request, res: Response) => {
  const auth = req.auth!;
  res.status(200).json({
    user: {
      id: auth.user.id,
      username: auth.user.username,
      email: auth.user.email,
      displayName: auth.user.displayName,
      role: auth.franchise?.role ?? "viewer"
    },
    franchise: auth.franchise,
    availableFranchises: auth.availableFranchises
  });
});
