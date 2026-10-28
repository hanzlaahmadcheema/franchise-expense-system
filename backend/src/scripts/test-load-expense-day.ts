import { createSession } from "../auth/sessionService.js";
import { db } from "../config/database.js";

async function testLoad() {
  const user = await db.selectFrom("users").selectAll().where("username", "=", "owner").executeTakeFirst();
  const session = await createSession(user!.id);
  const token = session.token;
  console.log("Token:", token.substring(0, 10) + "...");

  (global as any).localStorage = {
    getItem: (k: string) => (k === "franchise_local_session_token" ? token : null),
    setItem: () => {},
    removeItem: () => {}
  };

  // Import frontend service
  const { loadExpenseDayPostgres } = await import("../../../src/services/api/expenseTransactionService.js");
  const dayData = await loadExpenseDayPostgres("2026-08", 1);
  console.log("\n=== loadExpenseDayPostgres('2026-08', 1) Result ===");
  console.log(JSON.stringify(dayData, null, 2));

  process.exit(0);
}

testLoad().catch((err) => {
  console.error(err);
  process.exit(1);
});
