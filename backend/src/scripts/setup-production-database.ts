import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";

const { Client } = pg;

async function setupProductionDatabase() {
  console.log("=== Phase 2: Setting up Local Production PostgreSQL Database ===");

  // 1. Generate strong password
  const password = crypto.randomBytes(24).toString("hex");

  // 2. Execute SQL via psql as postgres superuser
  const psqlCmd = (sqlText: string, dbName: string = "postgres") => {
    return execFileSync(
      "sudo",
      ["-n", "-u", "postgres", "psql", "-p", "5432", "-d", dbName, "-P", "pager=off", "-v", "ON_ERROR_STOP=1", "-c", sqlText],
      { encoding: "utf8" }
    );
  };

  // Check if role exists
  const roleCheck = psqlCmd("SELECT 1 FROM pg_roles WHERE rolname = 'franchise_prod';");
  if (!roleCheck.includes("1")) {
    console.log("Creating PostgreSQL role 'franchise_prod'...");
    psqlCmd(`CREATE ROLE franchise_prod WITH LOGIN PASSWORD '${password}';`);
  } else {
    console.log("Role 'franchise_prod' already exists. Updating password...");
    psqlCmd(`ALTER ROLE franchise_prod WITH PASSWORD '${password}';`);
  }

  // Check if database exists
  const dbCheck = psqlCmd("SELECT 1 FROM pg_database WHERE datname = 'franchise_prod_db';");
  if (!dbCheck.includes("1")) {
    console.log("Creating PostgreSQL database 'franchise_prod_db' with owner 'franchise_prod'...");
    psqlCmd("CREATE DATABASE franchise_prod_db OWNER franchise_prod;");
  } else {
    console.log("Database 'franchise_prod_db' already exists.");
    psqlCmd("ALTER DATABASE franchise_prod_db OWNER TO franchise_prod;");
  }

  // Grant privileges
  psqlCmd("GRANT ALL PRIVILEGES ON DATABASE franchise_prod_db TO franchise_prod;");
  psqlCmd("GRANT ALL ON SCHEMA public TO franchise_prod;", "franchise_prod_db");
  psqlCmd("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO franchise_prod;", "franchise_prod_db");
  psqlCmd("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO franchise_prod;", "franchise_prod_db");

  // 3. Write backend/.env.production
  const envProdPath = path.resolve(process.cwd(), ".env.production");
  const connectionString = `postgresql://franchise_prod:${password}@localhost:5432/franchise_prod_db`;

  const envContent = [
    `# Production Environment Configuration (Local Production Database)`,
    `PORT=4000`,
    `NODE_ENV=production`,
    `CORS_ORIGIN=http://localhost:5173`,
    `DATABASE_URL=${connectionString}`,
    `DATABASE_POOL_MIN=2`,
    `DATABASE_POOL_MAX=10`,
    `DATABASE_SSL=false`,
    ``
  ].join("\n");

  fs.writeFileSync(envProdPath, envContent, { mode: 0o600 });
  console.log(`Created isolated ${envProdPath} (mode 0600).`);

  // 4. Test connection using franchise_prod credentials
  console.log("Testing connection as 'franchise_prod' to 'franchise_prod_db'...");
  const client = new Client({
    connectionString
  });

  try {
    await client.connect();
    const res = await client.query("SELECT current_user, current_database(), version()");
    console.log("Connection successful!");
    console.log("Connected user:", res.rows[0].current_user);
    console.log("Connected database:", res.rows[0].current_database);
  } finally {
    await client.end();
  }

  console.log("=== Production Database Setup COMPLETE ===");
}

setupProductionDatabase().catch((err) => {
  console.error("FATAL: Failed to setup production database:", err);
  process.exit(1);
});
