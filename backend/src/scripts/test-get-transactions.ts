import { createSession } from "../auth/sessionService.js";
import { db } from "../config/database.js";

async function main() {
  const user = await db.selectFrom("users").selectAll().where("username", "=", "owner").executeTakeFirst();
  if (!user) {
    console.error("Owner user not found");
    process.exit(1);
  }
  const session = await createSession(user.id);
  const token = session.token;
  console.log("Session token created for owner:", token.substring(0, 10) + "...");

  const dayId = "5fd6bee1-7f5a-4e14-8843-c43bea594eb9"; // August 2026 Day 1
  const endpoints = [
    { name: "credits", path: `/api/v1/transactions/credits?day_id=${dayId}` },
    { name: "expenses", path: `/api/v1/transactions/expenses?day_id=${dayId}` },
    { name: "commissions", path: `/api/v1/transactions/commissions?day_id=${dayId}` },
    { name: "owner", path: `/api/v1/transactions/owner?day_id=${dayId}` }
  ];

  for (const ep of endpoints) {
    const res = await fetch(`http://localhost:4000${ep.path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const json = await res.json();
    console.log(`\n=== GET ${ep.name} (status ${res.status}) ===`);
    console.log(JSON.stringify(json, null, 2));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
