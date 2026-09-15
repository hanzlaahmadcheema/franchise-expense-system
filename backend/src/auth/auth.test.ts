import http from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "../app.js";
import { db, closeDatabase } from "../config/database.js";
import { setTokenVerifierForTesting } from "./firebaseAdmin.js";
import { sql } from "kysely";

interface TestContext {
  baseUrl: string;
  server: http.Server;
  franchise1Id: string;
  franchise2Id: string;
  ownerUserId: string;
  adminUserId: string;
  viewerUserId: string;
  inactiveUserId: string;
  multiFranchiseUserId: string;
}

async function setupTestData(): Promise<Omit<TestContext, "baseUrl" | "server">> {
  // Clean up any previous test records
  await sql`DELETE FROM franchises WHERE code IN ('TEST-AUTH-F1', 'TEST-AUTH-F2');`.execute(db);
  await sql`DELETE FROM users WHERE firebase_uid LIKE 'test-fb-%';`.execute(db);

  // 1. Create 2 test franchises
  const f1 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-AUTH-F1', 'Auth Test Franchise 1', 'Brand One')
    RETURNING id;
  `.execute(db);
  const franchise1Id = f1.rows[0].id;

  const f2 = await sql<{ id: string }>`
    INSERT INTO franchises (code, name, brand_name)
    VALUES ('TEST-AUTH-F2', 'Auth Test Franchise 2', 'Brand Two')
    RETURNING id;
  `.execute(db);
  const franchise2Id = f2.rows[0].id;

  // 2. Create Users
  // User 1: Owner in Franchise 1
  const u1 = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-fb-owner', 'owner@example.com', 'Test Owner', true)
    RETURNING id;
  `.execute(db);
  const ownerUserId = u1.rows[0].id;
  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchise1Id}, ${ownerUserId}, 'owner', true);
  `.execute(db);

  // User 2: Admin in Franchise 1
  const u2 = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-fb-admin', 'admin@example.com', 'Test Admin', true)
    RETURNING id;
  `.execute(db);
  const adminUserId = u2.rows[0].id;
  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchise1Id}, ${adminUserId}, 'admin', true);
  `.execute(db);

  // User 3: Viewer in Franchise 1
  const u3 = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-fb-viewer', 'viewer@example.com', 'Test Viewer', true)
    RETURNING id;
  `.execute(db);
  const viewerUserId = u3.rows[0].id;
  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchise1Id}, ${viewerUserId}, 'viewer', true);
  `.execute(db);

  // User 4: Inactive User
  const u4 = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-fb-inactive', 'inactive@example.com', 'Inactive User', false)
    RETURNING id;
  `.execute(db);
  const inactiveUserId = u4.rows[0].id;
  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchise1Id}, ${inactiveUserId}, 'viewer', true);
  `.execute(db);

  // User 5: User in MULTIPLE franchises (Owner in F1, Admin in F2)
  const u5 = await sql<{ id: string }>`
    INSERT INTO users (firebase_uid, email, display_name, is_active)
    VALUES ('test-fb-multi', 'multi@example.com', 'Multi-Franchise User', true)
    RETURNING id;
  `.execute(db);
  const multiFranchiseUserId = u5.rows[0].id;
  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchise1Id}, ${multiFranchiseUserId}, 'owner', true);
  `.execute(db);
  await sql`
    INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
    VALUES (${franchise2Id}, ${multiFranchiseUserId}, 'admin', true);
  `.execute(db);

  return {
    franchise1Id,
    franchise2Id,
    ownerUserId,
    adminUserId,
    viewerUserId,
    inactiveUserId,
    multiFranchiseUserId
  };
}

async function cleanupTestData() {
  await sql`DELETE FROM franchises WHERE code IN ('TEST-AUTH-F1', 'TEST-AUTH-F2');`.execute(db);
  await sql`DELETE FROM users WHERE firebase_uid LIKE 'test-fb-%';`.execute(db);
}

async function runAuthTests() {
  console.log("=== STARTING PHASE 3 AUTH & TENANCY TEST SUITE ===");

  const data = await setupTestData();
  const server = http.createServer(app);

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`[Test Server] Listening on ${baseUrl}`);

  // Configure Mock Token Verifier
  setTokenVerifierForTesting(async (token: string) => {
    if (token === "valid-token-owner") return { uid: "test-fb-owner", email: "owner@example.com" };
    if (token === "valid-token-admin") return { uid: "test-fb-admin", email: "admin@example.com" };
    if (token === "valid-token-viewer") return { uid: "test-fb-viewer", email: "viewer@example.com" };
    if (token === "valid-token-inactive") return { uid: "test-fb-inactive", email: "inactive@example.com" };
    if (token === "valid-token-multi") return { uid: "test-fb-multi", email: "multi@example.com" };
    if (token === "valid-token-unregistered") return { uid: "test-fb-unregistered", email: "ghost@example.com" };
    if (token === "expired-token") throw new Error("TOKEN_EXPIRED");
    throw new Error("TOKEN_INVALID");
  });

  try {
    // 1. Health check still works
    console.log("Test 1: Health endpoint responds with 200 OK");
    const healthRes = await fetch(`${baseUrl}/health`);
    if (healthRes.status !== 200) throw new Error(`Health check expected 200, got ${healthRes.status}`);
    const healthJson = (await healthRes.json()) as any;
    if (healthJson.database.status !== "connected") throw new Error("Database not connected in health check");
    console.log("   ✓ Health check passes.");

    // 2. Missing Authorization header rejected
    console.log("Test 2: Missing Authorization header rejected with 401");
    const noAuthRes = await fetch(`${baseUrl}/auth/me`);
    if (noAuthRes.status !== 401) throw new Error(`Expected 401, got ${noAuthRes.status}`);
    const noAuthJson = (await noAuthRes.json()) as any;
    if (noAuthJson.error !== "UNAUTHORIZED") throw new Error("Unexpected error code");
    console.log("   ✓ Missing auth rejected.");

    // 3. Malformed Authorization header rejected
    console.log("Test 3: Malformed Authorization header rejected with 401");
    const badAuthRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Basic invalid-format" }
    });
    if (badAuthRes.status !== 401) throw new Error(`Expected 401, got ${badAuthRes.status}`);
    console.log("   ✓ Malformed header rejected.");

    // 4. Invalid token rejected
    console.log("Test 4: Invalid token rejected with 401");
    const invalidTokenRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Bearer bad-token" }
    });
    if (invalidTokenRes.status !== 401) throw new Error(`Expected 401, got ${invalidTokenRes.status}`);
    const invalidTokenJson = (await invalidTokenRes.json()) as any;
    if (invalidTokenJson.error !== "INVALID_TOKEN") throw new Error("Expected INVALID_TOKEN");
    console.log("   ✓ Invalid token rejected.");

    // 5. Expired token rejected
    console.log("Test 5: Expired token rejected with 401");
    const expiredTokenRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Bearer expired-token" }
    });
    if (expiredTokenRes.status !== 401) throw new Error(`Expected 401, got ${expiredTokenRes.status}`);
    const expiredTokenJson = (await expiredTokenRes.json()) as any;
    if (expiredTokenJson.error !== "TOKEN_EXPIRED") throw new Error("Expected TOKEN_EXPIRED");
    console.log("   ✓ Expired token rejected.");

    // 6. Unknown/Unregistered Firebase UID rejected
    console.log("Test 6: Unregistered Firebase UID rejected with 403 USER_NOT_REGISTERED");
    const unregisteredRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Bearer valid-token-unregistered" }
    });
    if (unregisteredRes.status !== 403) throw new Error(`Expected 403, got ${unregisteredRes.status}`);
    const unregisteredJson = (await unregisteredRes.json()) as any;
    if (unregisteredJson.error !== "USER_NOT_REGISTERED") throw new Error("Expected USER_NOT_REGISTERED");
    console.log("   ✓ Unregistered user rejected.");

    // 7. Deactivated user rejected
    console.log("Test 7: Deactivated user rejected with 403 USER_DEACTIVATED");
    const inactiveRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Bearer valid-token-inactive" }
    });
    if (inactiveRes.status !== 403) throw new Error(`Expected 403, got ${inactiveRes.status}`);
    const inactiveJson = (await inactiveRes.json()) as any;
    if (inactiveJson.error !== "USER_DEACTIVATED") throw new Error("Expected USER_DEACTIVATED");
    console.log("   ✓ Inactive user rejected.");

    // 8. Single-membership user auto-resolves franchise context
    console.log("Test 8: User with single franchise auto-resolves franchise context (200 OK)");
    const ownerRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Bearer valid-token-owner" }
    });
    if (ownerRes.status !== 200) throw new Error(`Expected 200, got ${ownerRes.status}`);
    const ownerJson = (await ownerRes.json()) as any;
    if (ownerJson.user.email !== "owner@example.com") throw new Error("User email mismatch");
    if (ownerJson.franchise.id !== data.franchise1Id) throw new Error("Franchise ID mismatch");
    if (ownerJson.franchise.role !== "owner") throw new Error("Role mismatch");
    console.log("   ✓ Single franchise auto-resolved successfully:", ownerJson.franchise.name);

    // 9. Multiple franchise user without header returns 400 FRANCHISE_CONTEXT_REQUIRED
    console.log("Test 9: Multiple-franchise user without header returns 400 FRANCHISE_CONTEXT_REQUIRED");
    const multiNoHeaderRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: "Bearer valid-token-multi" }
    });
    if (multiNoHeaderRes.status !== 400) throw new Error(`Expected 400, got ${multiNoHeaderRes.status}`);
    const multiNoHeaderJson = (await multiNoHeaderRes.json()) as any;
    if (multiNoHeaderJson.error !== "FRANCHISE_CONTEXT_REQUIRED") throw new Error("Expected FRANCHISE_CONTEXT_REQUIRED");
    if (multiNoHeaderJson.availableFranchises.length !== 2) throw new Error("Expected 2 available franchises");
    console.log("   ✓ Multiple-franchise user prompted for franchise context.");

    // 10. Multiple franchise user with X-Franchise-Id succeeds for F1
    console.log("Test 10: Multiple-franchise user specifying X-Franchise-Id (F1) resolves F1 role (owner)");
    const multiF1Res = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        Authorization: "Bearer valid-token-multi",
        "X-Franchise-Id": data.franchise1Id
      }
    });
    if (multiF1Res.status !== 200) throw new Error(`Expected 200, got ${multiF1Res.status}`);
    const multiF1Json = (await multiF1Res.json()) as any;
    if (multiF1Json.franchise.id !== data.franchise1Id || multiF1Json.franchise.role !== "owner") {
      throw new Error("Failed to resolve F1 context");
    }
    console.log("   ✓ Explicit F1 selection resolved (role: owner).");

    // 11. Multiple franchise user with X-Franchise-Id succeeds for F2
    console.log("Test 11: Multiple-franchise user specifying X-Franchise-Id (F2) resolves F2 role (admin)");
    const multiF2Res = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        Authorization: "Bearer valid-token-multi",
        "X-Franchise-Id": data.franchise2Id
      }
    });
    if (multiF2Res.status !== 200) throw new Error(`Expected 200, got ${multiF2Res.status}`);
    const multiF2Json = (await multiF2Res.json()) as any;
    if (multiF2Json.franchise.id !== data.franchise2Id || multiF2Json.franchise.role !== "admin") {
      throw new Error("Failed to resolve F2 context");
    }
    console.log("   ✓ Explicit F2 selection resolved (role: admin).");

    // 12. Arbitrary/unauthorized franchise ID rejected with 403
    console.log("Test 12: User attempting to access unauthorized franchise rejected with 403");
    const unauthorizedFranchiseRes = await fetch(`${baseUrl}/auth/me`, {
      headers: {
        Authorization: "Bearer valid-token-admin", // Admin only belongs to F1
        "X-Franchise-Id": data.franchise2Id        // Requests F2
      }
    });
    if (unauthorizedFranchiseRes.status !== 403) throw new Error(`Expected 403, got ${unauthorizedFranchiseRes.status}`);
    const unauthorizedFranchiseJson = (await unauthorizedFranchiseRes.json()) as any;
    if (unauthorizedFranchiseJson.error !== "FRANCHISE_ACCESS_DENIED") throw new Error("Expected FRANCHISE_ACCESS_DENIED");
    console.log("   ✓ Unauthorized franchise request strictly blocked.");

    // 13. RBAC Hierarchy: Owner satisfies Owner, Admin, Viewer
    console.log("Test 13: RBAC Hierarchy - Owner satisfies owner, admin, viewer routes");
    const ownerOnOwner = await fetch(`${baseUrl}/auth/test-role/owner`, { headers: { Authorization: "Bearer valid-token-owner" } });
    const ownerOnAdmin = await fetch(`${baseUrl}/auth/test-role/admin`, { headers: { Authorization: "Bearer valid-token-owner" } });
    const ownerOnViewer = await fetch(`${baseUrl}/auth/test-role/viewer`, { headers: { Authorization: "Bearer valid-token-owner" } });
    if (ownerOnOwner.status !== 200 || ownerOnAdmin.status !== 200 || ownerOnViewer.status !== 200) {
      throw new Error("Owner failed hierarchy check");
    }
    console.log("   ✓ Owner satisfies all role levels.");

    // 14. RBAC Hierarchy: Admin satisfies Admin and Viewer, but fails Owner
    console.log("Test 14: RBAC Hierarchy - Admin satisfies admin and viewer, rejected on owner route (403)");
    const adminOnViewer = await fetch(`${baseUrl}/auth/test-role/viewer`, { headers: { Authorization: "Bearer valid-token-admin" } });
    const adminOnAdmin = await fetch(`${baseUrl}/auth/test-role/admin`, { headers: { Authorization: "Bearer valid-token-admin" } });
    const adminOnOwner = await fetch(`${baseUrl}/auth/test-role/owner`, { headers: { Authorization: "Bearer valid-token-admin" } });
    if (adminOnViewer.status !== 200 || adminOnAdmin.status !== 200) throw new Error("Admin failed admin/viewer check");
    if (adminOnOwner.status !== 403) throw new Error(`Expected 403 for admin on owner route, got ${adminOnOwner.status}`);
    const adminOnOwnerJson = (await adminOnOwner.json()) as any;
    if (adminOnOwnerJson.error !== "INSUFFICIENT_ROLE") throw new Error("Expected INSUFFICIENT_ROLE");
    console.log("   ✓ Admin satisfies admin/viewer, blocked on owner.");

    // 15. RBAC Hierarchy: Viewer satisfies Viewer, but fails Admin and Owner
    console.log("Test 15: RBAC Hierarchy - Viewer satisfies viewer, rejected on admin and owner routes (403)");
    const viewerOnViewer = await fetch(`${baseUrl}/auth/test-role/viewer`, { headers: { Authorization: "Bearer valid-token-viewer" } });
    const viewerOnAdmin = await fetch(`${baseUrl}/auth/test-role/admin`, { headers: { Authorization: "Bearer valid-token-viewer" } });
    const viewerOnOwner = await fetch(`${baseUrl}/auth/test-role/owner`, { headers: { Authorization: "Bearer valid-token-viewer" } });
    if (viewerOnViewer.status !== 200) throw new Error("Viewer failed viewer check");
    if (viewerOnAdmin.status !== 403 || viewerOnOwner.status !== 403) throw new Error("Viewer was not blocked on admin/owner route");
    console.log("   ✓ Viewer satisfies viewer, blocked on admin and owner.");

    // 16. Security check: No sensitive secrets leaked in responses
    console.log("Test 16: Security sanitization check");
    const jsonStr = JSON.stringify(ownerJson);
    if (jsonStr.includes("password") || jsonStr.includes("private_key") || jsonStr.includes("credential")) {
      throw new Error("Security leak detected in /auth/me response!");
    }
    console.log("   ✓ Response contains only sanitized user and franchise identity.");

    console.log("\n=== ALL PHASE 3 TESTS PASSED (16/16) ===");
  } finally {
    server.close();
    setTokenVerifierForTesting(null);
    await cleanupTestData();
    await closeDatabase();
    console.log("[Test Clean] Temporary test data 100% removed from database.");
  }
}

runAuthTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
