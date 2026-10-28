import type { Request, Response, NextFunction } from "express";
import { verifyFirebaseIdToken, isFirebaseAdminInitialized } from "./firebaseAdmin.js";
import { validateSession } from "./sessionService.js";
import { db } from "../config/database.js";
import { sql } from "kysely";

export interface UserRow {
  id: string;
  firebase_uid: string | null;
  username?: string | null;
  email: string | null;
  display_name: string | null;
  is_active: boolean;
}

/**
 * requireAuth Middleware
 * 
 * Enforces:
 * 1. Presence of Authorization: Bearer <token>
 * 2. Primary: Validation of local database-backed session token
 * 3. Secondary / Fallback: Firebase ID token verification (for migration/test parity)
 * 4. Active status of the application user
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Missing Authorization header."
    });
    return;
  }

  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0]?.toLowerCase() !== "bearer" || !parts[1]) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Malformed Authorization header. Format must be 'Bearer <token>'."
    });
    return;
  }

  const token = parts[1];

  // 1. Primary Authentication Path: Local Database-Backed Session
  try {
    const sessionAuth = await validateSession(token);
    if (sessionAuth) {
      const user = sessionAuth.user;
      if (!user.is_active) {
        res.status(403).json({
          error: "USER_DEACTIVATED",
          message: "User account is inactive. Please contact your administrator."
        });
        return;
      }

      req.auth = {
        firebaseUid: user.firebase_uid,
        token,
        user: {
          id: user.id,
          firebaseUid: user.firebase_uid,
          username: user.username,
          email: user.email,
          displayName: user.display_name,
          isActive: user.is_active
        }
      };

      next();
      return;
    }
  } catch (sessionErr) {
    console.error("[Auth Middleware Session Validation Error]", sessionErr instanceof Error ? sessionErr.message : sessionErr);
  }

  // 2. Secondary / Fallback Authentication Path: Firebase ID Token
  if (isFirebaseAdminInitialized()) {
    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(token);
    } catch (err: unknown) {
      const code = err instanceof Error ? err.message : "TOKEN_INVALID";
      if (code === "FIREBASE_ADMIN_NOT_CONFIGURED") {
        res.status(500).json({
          error: "AUTH_CONFIGURATION_ERROR",
          message: "Server authentication provider is not configured."
        });
        return;
      }

      res.status(401).json({
        error: code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "INVALID_TOKEN",
        message: code === "TOKEN_EXPIRED" ? "Authentication token has expired." : "Authentication token is invalid."
      });
      return;
    }

    try {
      const userResult = await sql<UserRow>`
        SELECT id, firebase_uid, username, email, display_name, is_active
        FROM users
        WHERE firebase_uid = ${decoded.uid}
           OR (email IS NOT NULL AND LOWER(email) = LOWER(${decoded.email || ""}))
        LIMIT 1;
      `.execute(db);

      if (userResult.rows.length === 0) {
        res.status(403).json({
          error: "USER_NOT_REGISTERED",
          message: "Authenticated identity has no registered application user profile."
        });
        return;
      }

      const userRow = userResult.rows[0];

      // Reconcile firebase_uid if it changed
      if (userRow.firebase_uid !== decoded.uid) {
        await sql`
          UPDATE users
          SET firebase_uid = ${decoded.uid}, updated_at = NOW()
          WHERE id = ${userRow.id};
        `.execute(db);
      }

      if (!userRow.is_active) {
        res.status(403).json({
          error: "USER_DEACTIVATED",
          message: "User account is inactive. Please contact your administrator."
        });
        return;
      }

      req.auth = {
        firebaseUid: decoded.uid,
        token,
        user: {
          id: userRow.id,
          firebaseUid: userRow.firebase_uid,
          username: userRow.username,
          email: userRow.email,
          displayName: userRow.display_name,
          isActive: userRow.is_active
        }
      };

      next();
      return;
    } catch (dbErr) {
      console.error("[Auth Middleware Database Error]", dbErr instanceof Error ? dbErr.message : dbErr);
      res.status(500).json({
        error: "INTERNAL_ERROR",
        message: "Failed to resolve authenticated user identity."
      });
      return;
    }
  }

  // If Firebase Admin is not initialized and token is not a valid local session:
  res.status(401).json({
    error: "INVALID_TOKEN",
    message: "Authentication token is invalid or expired."
  });
}
