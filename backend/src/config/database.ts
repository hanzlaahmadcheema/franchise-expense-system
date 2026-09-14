import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { env } from "./env.js";
import type { Database } from "../db/types.js";

const { Pool } = pg;

function resolveSslConfig(databaseUrl: string, explicitSsl?: boolean): pg.ConnectionConfig["ssl"] {
  // If explicitly configured, honor it
  if (explicitSsl !== undefined) {
    return explicitSsl ? { rejectUnauthorized: false } : false;
  }

  // Check connection string parameters or host
  const isLocalhost = databaseUrl.includes("localhost") || databaseUrl.includes("127.0.0.1");
  const isSupabase = databaseUrl.includes("supabase.co") || databaseUrl.includes("supabase.net") || databaseUrl.includes("pooler.supabase.com");
  const hasSslQuery = databaseUrl.includes("sslmode=require") || databaseUrl.includes("ssl=true");

  if (isSupabase || hasSslQuery || (!isLocalhost && env.NODE_ENV === "production")) {
    return { rejectUnauthorized: false };
  }

  return false;
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  min: env.DATABASE_POOL_MIN,
  max: env.DATABASE_POOL_MAX,
  ssl: resolveSslConfig(env.DATABASE_URL, env.DATABASE_SSL)
});

// Pool-level error logging to prevent unhandled background disconnections
pool.on("error", (err) => {
  console.error("[Database Pool Error]", err.message);
});

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool
  })
});

/**
 * Executes a round-trip ping query against PostgreSQL.
 * Used by the /health endpoint and startup diagnostics.
 */
export async function checkDatabaseConnection(): Promise<{
  ok: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = performance.now();
  try {
    const result = await sql<{ ping: number }>`SELECT 1 AS ping`.execute(db);
    const latencyMs = Math.round((performance.now() - start) * 10) / 10;
    const ok = result.rows.length > 0 && result.rows[0].ping === 1;
    return { ok, latencyMs };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Database connection failed"
    };
  }
}

/**
 * Gracefully shuts down the database pool.
 */
export async function closeDatabase(): Promise<void> {
  await db.destroy();
}
