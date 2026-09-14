import * as path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Migrator, FileMigrationProvider, type MigrationResultSet } from "kysely";
import { db, closeDatabase } from "../config/database.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createMigrator(): Migrator {
  const migrationFolder = path.join(__dirname, "migrations");
  return new Migrator({
    db,
    provider: new FileMigrationProvider({
      fs,
      path,
      migrationFolder
    })
  });
}

function printMigrationResults(results: MigrationResultSet["results"]): void {
  if (!results || results.length === 0) {
    console.log("[Migrator] No migrations executed.");
    return;
  }

  for (const it of results) {
    if (it.status === "Success") {
      console.log(`[Migrator] Migration "${it.migrationName}" was executed successfully.`);
    } else if (it.status === "Error") {
      console.error(`[Migrator] FAILED to execute migration "${it.migrationName}".`);
    }
  }
}

export async function migrateLatest(): Promise<boolean> {
  console.log("[Migrator] Checking for pending migrations...");
  const migrator = createMigrator();
  const { error, results } = await migrator.migrateToLatest();

  printMigrationResults(results);

  if (error) {
    console.error("[Migrator] Migration error occurred:", error);
    return false;
  }

  if (!results || results.length === 0) {
    console.log("[Migrator] Schema is already up to date. Zero pending migrations.");
  } else {
    console.log("[Migrator] All pending migrations successfully applied.");
  }

  return true;
}

export async function migrateRollback(): Promise<boolean> {
  console.log("[Migrator] Attempting rollback of previous migration step...");
  const migrator = createMigrator();
  const { error, results } = await migrator.migrateDown();

  printMigrationResults(results);

  if (error) {
    console.error("[Migrator] Rollback error occurred:", error);
    return false;
  }

  if (!results || results.length === 0) {
    console.log("[Migrator] No executed migrations found to roll back.");
  } else {
    console.log("[Migrator] Successfully rolled back last migration batch.");
  }

  return true;
}

// CLI runner entrypoint
const command = process.argv[2];

if (command === "latest" || command === "rollback") {
  (async () => {
    try {
      let success = false;
      if (command === "latest") {
        success = await migrateLatest();
      } else if (command === "rollback") {
        success = await migrateRollback();
      }

      await closeDatabase();
      process.exit(success ? 0 : 1);
    } catch (err) {
      console.error("[Migrator Fatal Error]", err);
      await closeDatabase().catch(() => {});
      process.exit(1);
    }
  })();
}
