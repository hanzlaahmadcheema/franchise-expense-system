import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import fs from "fs";
import path from "path";

async function main() {
  console.log("=== CHECKING PERIODS & PRECONDITIONS FOR OCTOBER 2026 ===");

  const periods = await sql<any>`
    SELECT id, period_key, status, final_settlement_status, created_at, updated_at
    FROM accounting_periods
    ORDER BY period_key ASC;
  `.execute(db);
  console.log("Periods in DB:");
  console.table(periods.rows);

  const septPeriod = periods.rows.find((p: any) => p.period_key === "2026-09");
  if (septPeriod) {
    const septDays = await sql<any>`
      SELECT day_no, status, closed_at FROM accounting_days
      WHERE period_id = ${septPeriod.id}
      ORDER BY day_no ASC;
    `.execute(db);
    console.log(`September 2026 days count: ${septDays.rows.length}`);
    const openDays = septDays.rows.filter((d: any) => d.status === "open" || d.status === "reopen");
    console.log("September Open/Reopened days:", openDays);
  }

  const octPeriod = periods.rows.find((p: any) => p.period_key === "2026-10");
  if (octPeriod) {
    console.log("October 2026 ALREADY EXISTS in DB:", octPeriod);
    const octDays = await sql<any>`
      SELECT day_no, status FROM accounting_days
      WHERE period_id = ${octPeriod.id}
      ORDER BY day_no ASC;
    `.execute(db);
    console.log(`October days count: ${octDays.rows.length}`);
  } else {
    console.log("October 2026 does NOT exist in DB yet.");
  }
}

main().catch(console.error).finally(() => closeDatabase());
