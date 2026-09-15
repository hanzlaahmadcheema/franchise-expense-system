import type { Request, Response, NextFunction } from "express";
import { verifyFirebaseIdToken } from "./firebaseAdmin.js";
import { db } from "../config/database.js";
import { sql } from "kysely";

export interface UserRow {
  id: string;
  firebase_uid: string;
  email: string;
  display_name: string | null;
  is_active: boolean;
}

/**
 * requireAuth Middleware
 * 
 * Enforces:
 * 1. Presence of Authorization: Bearer <token>
 * 2. Independent verification of Firebase ID token
 * 3. Existence of matching application user in the database
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
    // Resolve application user by Firebase UID
    const userResult = await sql<UserRow>`
      SELECT id, firebase_uid, email, display_name, is_active
      FROM users
      WHERE firebase_uid = ${decoded.uid}
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

    if (!userRow.is_active) {
      res.status(403).json({
        error: "USER_DEACTIVATED",
        message: "User account is inactive. Please contact your administrator."
      });
      return;
    }

    req.auth = {
      firebaseUid: decoded.uid,
      user: {
        id: userRow.id,
        firebaseUid: userRow.firebase_uid,
        email: userRow.email,
        displayName: userRow.display_name,
        isActive: userRow.is_active
      }
    };

    next();
  } catch (dbErr) {
    console.error("[Auth Middleware Database Error]", dbErr instanceof Error ? dbErr.message : dbErr);
    res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to resolve authenticated user identity."
    });
  }
}
