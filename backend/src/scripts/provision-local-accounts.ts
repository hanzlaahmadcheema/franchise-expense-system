import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { db, closeDatabase } from "../config/database.js";
import { hashPassword } from "../auth/password.js";
import { sql } from "kysely";

async function promptSecret(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(promptText);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function main() {
  console.log("\n=======================================================");
  console.log("   FRANCHISE EXPENSE SYSTEM — LOCAL AUTH PROVISIONING  ");
  console.log("=======================================================\n");

  // Check if passwords are provided via env, otherwise prompt interactively
  let ownerPassword = process.env.BOOTSTRAP_OWNER_PASSWORD;
  let adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;

  if (!ownerPassword) {
    ownerPassword = await promptSecret("Enter password for 'owner' account: ");
  }
  if (!ownerPassword || ownerPassword.length < 6) {
    console.error("ERROR: Owner password must be at least 6 characters.");
    process.exit(1);
  }

  if (!adminPassword) {
    adminPassword = await promptSecret("Enter password for 'admin' account: ");
  }
  if (!adminPassword || adminPassword.length < 6) {
    console.error("ERROR: Admin password must be at least 6 characters.");
    process.exit(1);
  }

  console.log("\nHashing passwords using scrypt (memory-hard)...");
  const ownerHash = await hashPassword(ownerPassword);
  const adminHash = await hashPassword(adminPassword);

  try {
    // 1. Resolve active franchise
    const franchiseRes = await sql<{ id: string; code: string; name: string }>`
      SELECT id, code, name FROM franchises WHERE is_active = TRUE LIMIT 1;
    `.execute(db);

    const franchise = franchiseRes.rows[0];
    if (!franchise) {
      throw new Error("No active franchise found in database.");
    }
    console.log(`✓ Resolved Franchise: ${franchise.name} (${franchise.code}) [${franchise.id}]`);

    // 2. Provision or update Owner account (preserving existing owner UUID if present)
    const existingOwnerRes = await sql<{ id: string }>`
      SELECT id FROM users WHERE username = 'owner' OR email = 'hanzlaahmad100@gmail.com' LIMIT 1;
    `.execute(db);

    let ownerId: string;
    if (existingOwnerRes.rows.length > 0) {
      ownerId = existingOwnerRes.rows[0].id;
      await sql`
        UPDATE users
        SET username = 'owner',
            password_hash = ${ownerHash},
            is_active = TRUE,
            updated_at = NOW()
        WHERE id = ${ownerId};
      `.execute(db);
      console.log(`✓ Updated existing Owner account: id=${ownerId}, username=owner`);
    } else {
      const newOwner = await sql<{ id: string }>`
        INSERT INTO users (username, display_name, password_hash, is_active)
        VALUES ('owner', 'Franchise Owner', ${ownerHash}, TRUE)
        RETURNING id;
      `.execute(db);
      ownerId = newOwner.rows[0].id;
      console.log(`✓ Created new Owner account: id=${ownerId}, username=owner`);
    }

    // Ensure Owner franchise membership
    await sql`
      INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
      VALUES (${franchise.id}, ${ownerId}, 'owner', TRUE)
      ON CONFLICT (franchise_id, user_id) 
      DO UPDATE SET role = 'owner', is_active = TRUE, updated_at = NOW();
    `.execute(db);
    console.log(`✓ Owner role verified for franchise.`);

    // 3. Provision or update Admin account
    const existingAdminRes = await sql<{ id: string }>`
      SELECT id FROM users WHERE username = 'admin' LIMIT 1;
    `.execute(db);

    let adminId: string;
    if (existingAdminRes.rows.length > 0) {
      adminId = existingAdminRes.rows[0].id;
      await sql`
        UPDATE users
        SET password_hash = ${adminHash},
            is_active = TRUE,
            updated_at = NOW()
        WHERE id = ${adminId};
      `.execute(db);
      console.log(`✓ Updated existing Admin account: id=${adminId}, username=admin`);
    } else {
      const newAdmin = await sql<{ id: string }>`
        INSERT INTO users (username, display_name, password_hash, is_active)
        VALUES ('admin', 'Administrator', ${adminHash}, TRUE)
        RETURNING id;
      `.execute(db);
      adminId = newAdmin.rows[0].id;
      console.log(`✓ Created new Admin account: id=${adminId}, username=admin`);
    }

    // Ensure Admin franchise membership
    await sql`
      INSERT INTO franchise_users (franchise_id, user_id, role, is_active)
      VALUES (${franchise.id}, ${adminId}, 'admin', TRUE)
      ON CONFLICT (franchise_id, user_id) 
      DO UPDATE SET role = 'admin', is_active = TRUE, updated_at = NOW();
    `.execute(db);
    console.log(`✓ Admin role verified for franchise.`);

    console.log("\n=======================================================");
    console.log("   LOCAL ACCOUNTS PROVISIONED SUCCESSFULLY            ");
    console.log("   - owner (role: owner)                              ");
    console.log("   - admin (role: admin)                              ");
    console.log("=======================================================\n");
  } finally {
    await closeDatabase();
  }
}

main().catch((err) => {
  console.error("\n[Provisioning Error]", err instanceof Error ? err.message : err);
  process.exit(1);
});
