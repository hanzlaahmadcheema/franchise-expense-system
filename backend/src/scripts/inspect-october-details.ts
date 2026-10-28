import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import fs from "fs";
import path from "path";

async function main() {
  const octPeriodId = "332a26af-54a3-4b65-8c49-258952e2d2c3";

  console.log("=== OCTOBER 2026 DAYS STATUS ===");
  const days = await sql<any>`
    SELECT day_no, status, id
    FROM accounting_days
    WHERE period_id = ${octPeriodId}
    ORDER BY day_no ASC;
  `.execute(db);
  console.table(days.rows);

  console.log("\n=== OCTOBER 2026 SEEDS ===");
  const finSeeds = await sql<any>`SELECT * FROM period_financial_seeds WHERE period_id = ${octPeriodId}`.execute(db);
  console.log("Financial Seeds:", finSeeds.rows[0]);

  const stockProdSeeds = await sql<any>`SELECT * FROM period_stock_product_seeds WHERE period_id = ${octPeriodId}`.execute(db);
  console.log(`Stock Product Seeds: ${stockProdSeeds.rows.length}`);

  const stockAccSeeds = await sql<any>`SELECT * FROM period_stock_account_seeds WHERE period_id = ${octPeriodId}`.execute(db);
  console.log(`Stock Account Seeds: ${stockAccSeeds.rows.length}`);

  const cpSeeds = await sql<any>`SELECT * FROM period_credit_party_seeds WHERE period_id = ${octPeriodId}`.execute(db);
  console.log(`Credit Party Seeds: ${cpSeeds.rows.length}`);

  const doSeeds = await sql<any>`SELECT * FROM period_jazz_do_seeds WHERE period_id = ${octPeriodId}`.execute(db);
  console.log(`Jazz DO Seeds: ${doSeeds.rows.length}`);

  console.log("\n=== EXISTING TRANSACTIONS IN OCTOBER 2026 ===");
  const dayIds = days.rows.map((d: any) => d.id);
  const exps = await sql<any>`SELECT COUNT(*) as count FROM expense_items WHERE day_id IN (${sql.join(dayIds)})`.execute(db);
  const comms = await sql<any>`SELECT COUNT(*) as count FROM commission_items WHERE day_id IN (${sql.join(dayIds)})`.execute(db);
  const creds = await sql<any>`SELECT COUNT(*) as count FROM credit_transactions WHERE day_id IN (${sql.join(dayIds)})`.execute(db);
  const owners = await sql<any>`SELECT COUNT(*) as count FROM owner_transactions WHERE day_id IN (${sql.join(dayIds)})`.execute(db);
  const lifting = await sql<any>`SELECT COUNT(*) as count FROM jazz_load_lifting_records WHERE day_id IN (${sql.join(dayIds)})`.execute(db);
  const doEntries = await sql<any>`SELECT COUNT(*) as count FROM jazz_load_do_entries WHERE day_id IN (${sql.join(dayIds)})`.execute(db);

  console.log(`Expenses Count: ${exps.rows[0].count}`);
  console.log(`Commissions Count: ${comms.rows[0].count}`);
  console.log(`Credits Count: ${creds.rows[0].count}`);
  console.log(`Owner Count: ${owners.rows[0].count}`);
  console.log(`Lifting Count: ${lifting.rows[0].count}`);
  console.log(`DO Entries Count: ${doEntries.rows[0].count}`);
}

main().catch(console.error).finally(() => closeDatabase());
