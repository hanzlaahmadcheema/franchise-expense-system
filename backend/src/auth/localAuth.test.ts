import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { hashPassword } from "./password.js";
import { sql } from "kysely";

interface TestContext {
  baseUrl: string;
  server: http.Server;
  franchiseId: string;
  ownerId: string;
  adminId: string;
}

async function setupLocalAuthTestData(): Promise<Omit<TestContext, "baseUrl" | "server">> {
  // Cleanup test franchises and users
  await sql`DELETE FROM franchises WHERE code = 'LOCAL-AUTH-TEST';`.execute(db);
  await sql`DELETE FROM users WHERE username IN ('test-local-owner', 'test-local-admin');`.execute(db);

  // 1. Create Franchise
  const f = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('LOCAL-AUTH-TEST', 'Local Auth Test Franchise', 'Brand Local')
    RETURNING id;
  `.execute(db);
  const franchiseId = f.rows[0].id;

  // 2. Hash passwords
  const ownerHash = await hashPassword("OwnerPassword123!");
  const adminHash = await hashPassword("AdminPassword123!");

  // 3. Create Local Owner
  const u1 = await sql<{ id: string }>`
    INSERT INTO users (username, display_name, password_hash, is_active)
    VALUES ('test-local-owner', 'Local Owner User', ${ownerHash}, TRUE)
    RETURNING id;
  `.execute(db);
  const ownerId = u1.rows[0].id;

  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchiseId}, ${ownerId}, 'owner', TRUE);
  `.execute(db);

  // 4. Create Local Admin
  const u2 = await sql<{ id: string }>`
    INSERT INTO users (username, display_name, password_hash, is_active)
    VALUES ('test-local-admin', 'Local Admin User', ${adminHash}, TRUE)
    RETURNING id;
  `.execute(db);
  const adminId = u2.rows[0].id;

  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchiseId}, ${adminId}, 'admin', TRUE);
  `.execute(db);

  return { franchiseId, ownerId, adminId };
}

async function runLocalAuthTests() {
  console.log("\n=======================================================");
  console.log("   RUNNING LOCAL AUTHENTICATION INTEGRATION TESTS      ");
  console.log("=======================================================\n");

  const testData = await setupLocalAuthTestData();

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  let passed = 0;
  let failed = 0;

  async function assert(desc: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`✓ ${desc}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${desc}:`, err instanceof Error ? err.message : err);
      failed++;
    }
  }

  try {
    let ownerToken = "";
    let adminToken = "";

    // 1. Unauthenticated request to protected endpoint fails
    await assert("1. Unauthenticated request to /api/v1/auth/me returns 401 UNAUTHORIZED", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me`);
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
      const body = (await res.json()) as any;
      if (body.error !== "UNAUTHORIZED") throw new Error(`Expected UNAUTHORIZED, got ${body.error}`);
    });

    // 2. Unknown username fails login
    await assert("2. Unknown username fails with 401 INVALID_CREDENTIALS", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "nonexistent-user", password: "SomePassword123!" })
      });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
      const body = (await res.json()) as any;
      if (body.error !== "INVALID_CREDENTIALS") throw new Error(`Expected INVALID_CREDENTIALS, got ${body.error}`);
    });

    // 3. Wrong password fails login
    await assert("3. Wrong password fails with 401 INVALID_CREDENTIALS", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-local-owner", password: "WrongPassword!" })
      });
      if (res.status !== 401) throw new Error(`Expected 401, got ${res.status}`);
      const body = (await res.json()) as any;
      if (body.error !== "INVALID_CREDENTIALS") throw new Error(`Expected INVALID_CREDENTIALS, got ${body.error}`);
    });

    // 4. Owner login succeeds
    await assert("4. Owner login succeeds and returns session token without password hash", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-local-owner", password: "OwnerPassword123!" })
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = (await res.json()) as any;
      if (!body.token) throw new Error("Missing session token in response");
      if (body.user.role !== "owner") throw new Error(`Expected role owner, got ${body.user.role}`);
      if (body.password_hash || body.user.password_hash) throw new Error("CRITICAL: password_hash leaked in response!");
      ownerToken = body.token;
    });

    // 5. Admin login succeeds
    await assert("5. Admin login succeeds and returns session token with admin role", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "test-local-admin", password: "AdminPassword123!" })
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = (await res.json()) as any;
      if (!body.token) throw new Error("Missing session token in response");
      if (body.user.role !== "admin") throw new Error(`Expected role admin, got ${body.user.role}`);
      adminToken = body.token;
    });

    // 6. Active session token authorizes /api/v1/auth/me
    await assert("6. Active session token validates profile at /api/v1/auth/me", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = (await res.json()) as any;
      if (body.user.username !== "test-local-owner") throw new Error(`Expected username test-local-owner, got ${body.user.username}`);
      if (body.user.role !== "owner") throw new Error(`Expected role owner, got ${body.user.role}`);
    });

    // 7. Owner role authorization check
    await assert("7. Owner token succeeds on Owner-only endpoint", async () => {
      const res = await fetch(`${baseUrl}/auth/test-role/owner`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = (await res.json()) as any;
      if (!body.allowed) throw new Error("Expected allowed: true");
    });

    // 8. Admin role authorization check on Admin endpoint
    await assert("8. Admin token succeeds on Admin endpoint", async () => {
      const res = await fetch(`${baseUrl}/auth/test-role/admin`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      if (res.status !== 200) throw new Error(`Expected 200, got ${res.status}`);
      const body = (await res.json()) as any;
      if (!body.allowed) throw new Error("Expected allowed: true");
    });

    // 9. Admin role rejected on Owner-only endpoint (RBAC enforcement)
    await assert("9. Admin token is rejected with 403 on Owner-only endpoint", async () => {
      const res = await fetch(`${baseUrl}/auth/test-role/owner`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      if (res.status !== 403) throw new Error(`Expected 403, got ${res.status}`);
      const body = (await res.json()) as any;
      if (body.error !== "INSUFFICIENT_ROLE") throw new Error(`Expected INSUFFICIENT_ROLE, got ${body.error}`);
    });

    // 10. Logout invalidates session
    await assert("10. Logout invalidates session token", async () => {
      const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      if (logoutRes.status !== 200) throw new Error(`Expected 200, got ${logoutRes.status}`);

      // Attempt to reuse revoked token
      const reuseRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${ownerToken}` }
      });
      if (reuseRes.status !== 401) throw new Error(`Expected 401 after logout, got ${reuseRes.status}`);
    });

  } finally {
    server.close();
    // Cleanup test data
    await sql`DELETE FROM franchises WHERE code = 'LOCAL-AUTH-TEST';`.execute(db);
    await sql`DELETE FROM users WHERE username IN ('test-local-owner', 'test-local-admin');`.execute(db);
    await closeDatabase();
  }

  console.log(`\nLocal Auth Tests Completed: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runLocalAuthTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
