import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Operational Client Mutation Idempotency Table
  await sql`
    CREATE TABLE mutation_idempotency (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        franchise_id UUID NOT NULL REFERENCES franchises(id) ON DELETE CASCADE,
        client_mutation_id VARCHAR(128) NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        endpoint VARCHAR(128) NOT NULL,
        request_hash VARCHAR(64) NOT NULL,
        response_status INT NOT NULL,
        response_body JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CONSTRAINT uq_mutation_idempotency UNIQUE (franchise_id, client_mutation_id)
    );

    CREATE INDEX idx_mutation_idempotency_lookup 
    ON mutation_idempotency (franchise_id, client_mutation_id);
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS mutation_idempotency CASCADE;`.execute(db);
}
