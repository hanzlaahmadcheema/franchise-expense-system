import { app } from "./app.js";
import { env } from "./config/env.js";
import { closeDatabase, checkDatabaseConnection } from "./config/database.js";

const server = app.listen(env.PORT, async () => {
  console.log(`[Backend Server] Running on http://localhost:${env.PORT}`);
  console.log(`[Backend Server] Environment: ${env.NODE_ENV}`);

  // Initial non-blocking connectivity check log
  const dbCheck = await checkDatabaseConnection();
  if (dbCheck.ok) {
    console.log(`[Backend Server] Database connection established (latency: ${dbCheck.latencyMs}ms).`);
  } else {
    console.warn(`[Backend Server] Warning: Database check failed at startup: ${dbCheck.error}`);
  }
});

// Graceful shutdown handling
let isShuttingDown = false;

async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`\n[Backend Server] Received ${signal}. Shutting down gracefully...`);

  server.close(async (err) => {
    if (err) {
      console.error("[Backend Server] Error during HTTP server close:", err);
    }
    try {
      await closeDatabase();
      console.log("[Backend Server] Database connections closed cleanly.");
      process.exit(0);
    } catch (dbErr) {
      console.error("[Backend Server] Error during database close:", dbErr);
      process.exit(1);
    }
  });

  // Force exit if shutdown hangs beyond 10 seconds
  setTimeout(() => {
    console.error("[Backend Server] Graceful shutdown timed out. Forcing termination.");
    process.exit(1);
  }, 10000).unref();
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
