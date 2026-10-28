import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // 1. Allow firebase_uid and email to be nullable in users table for local-only accounts
  await sql`
    ALTER TABLE users 
    ALTER COLUMN firebase_uid DROP NOT NULL;
  `.execute(db);

  await sql`
    ALTER TABLE users 
    ALTER COLUMN email DROP NOT NULL;
  `.execute(db);

  // 2. Add username and password_hash columns to users table
  await sql`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS username VARCHAR(64) UNIQUE;
  `.execute(db);

  await sql`
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS password_hash TEXT NULL;
  `.execute(db);

  // 3. Create user_sessions table for server-authoritative session tracking
  await sql`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ NULL,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
    );
  `.execute(db);

  // 4. Indexes for rapid session validation and cleanup
  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_sessions_token_hash 
    ON user_sessions (token_hash) 
    WHERE revoked_at IS NULL;
  `.execute(db);

  await sql`
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id 
    ON user_sessions (user_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS user_sessions CASCADE;`.execute(db);

  await sql`
    ALTER TABLE users 
    DROP COLUMN IF EXISTS password_hash;
  `.execute(db);

  await sql`
    ALTER TABLE users 
    DROP COLUMN IF EXISTS username;
  `.execute(db);

  await sql`
    ALTER TABLE users 
    ALTER COLUMN email SET NOT NULL;
  `.execute(db);

  await sql`
    ALTER TABLE users 
    ALTER COLUMN firebase_uid SET NOT NULL;
  `.execute(db);
}
