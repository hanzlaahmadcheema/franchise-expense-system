import crypto from "node:crypto";
import { sql } from "kysely";
import { db } from "../config/database.js";
import type { UserRow } from "./authMiddleware.js";

const SESSION_TOKEN_BYTES = 32;
const DEFAULT_SESSION_TTL_DAYS = 30;

export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a new server-side session for the given user.
 * Returns the raw token (to return to client) and expiration timestamp.
 * Stored in database only as SHA-256 hash.
 */
export async function createSession(
  userId: string,
  ttlDays = DEFAULT_SESSION_TTL_DAYS
): Promise<{ token: string; expiresAt: Date; sessionId: string }> {
  const rawToken = crypto.randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const result = await sql<{ id: string }>`
    INSERT INTO user_sessions (user_id, token_hash, expires_at)
    VALUES (${userId}, ${tokenHash}, ${expiresAt.toISOString()})
    RETURNING id;
  `.execute(db);

  const sessionId = result.rows[0]?.id;
  if (!sessionId) {
    throw new Error("Failed to generate user session.");
  }

  return {
    token: rawToken,
    expiresAt,
    sessionId
  };
}

/**
 * Validates a session token.
 * Verifies that the session exists, is unexpired, and has not been revoked.
 * Returns the authenticated user row and session ID, or null.
 */
export async function validateSession(
  token: string
): Promise<{ user: UserRow; sessionId: string } | null> {
  if (!token || typeof token !== "string" || token.length !== SESSION_TOKEN_BYTES * 2) {
    return null;
  }

  const tokenHash = hashSessionToken(token);

  try {
    const result = await sql<UserRow & { session_id: string }>`
      SELECT 
        u.id, 
        u.firebase_uid, 
        u.username,
        u.email, 
        u.display_name, 
        u.is_active,
        s.id AS session_id
      FROM user_sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${tokenHash}
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND u.is_active = TRUE
      LIMIT 1;
    `.execute(db);

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];

    // Asynchronously bump last_seen_at without blocking auth critical path
    void sql`
      UPDATE user_sessions 
      SET last_seen_at = NOW() 
      WHERE id = ${row.session_id};
    `.execute(db).catch(() => {});

    return {
      user: {
        id: row.id,
        firebase_uid: row.firebase_uid,
        username: row.username,
        email: row.email,
        display_name: row.display_name,
        is_active: row.is_active
      },
      sessionId: row.session_id
    };
  } catch (err) {
    console.error("[Session Validation Error]", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Revokes a session token immediately.
 */
export async function revokeSession(token: string): Promise<boolean> {
  if (!token || typeof token !== "string") {
    return false;
  }

  const tokenHash = hashSessionToken(token);

  const result = await sql`
    UPDATE user_sessions
    SET revoked_at = NOW()
    WHERE token_hash = ${tokenHash}
      AND revoked_at IS NULL;
  `.execute(db);

  return (result.numAffectedRows ?? 0n) > 0n;
}

/**
 * Revokes all active sessions for a user (e.g. password change).
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await sql`
    UPDATE user_sessions
    SET revoked_at = NOW()
    WHERE user_id = ${userId}
      AND revoked_at IS NULL;
  `.execute(db);
}
