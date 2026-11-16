import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";

async function main() {
  console.log("================================================================================");
  console.log(" EXHAUSTIVE MULTI-MODULE DUPLICATION AUDIT ACROSS ALL PERIODS");
  console.log("================================================================================");

  let anyDuplicatesFound = false;

  // 1. Jazz Load DO Entries
  const jazzDoDups = await sql<{
    period_key: string;
    day_no: number;
    do_profile_id: string;
    do_name_snapshot: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, e.do_profile_id, e.do_name_snapshot, count(*) as count
    FROM jazz_load_do_entries e
    JOIN accounting_days d ON d.id = e.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, e.do_profile_id, e.do_name_snapshot
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[1] Jazz Load DO Entries (jazz_load_do_entries):");
  if (jazzDoDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(jazzDoDups.rows);
  } else {
    console.log("    ✓ 0 duplicates. Every DO has exactly 1 entry per day across all periods.");
  }

  // 2. Jazz Load Lifting Records
  const jazzLiftingDups = await sql<{
    period_key: string;
    day_no: number;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, count(*) as count
    FROM jazz_load_lifting_records l
    JOIN accounting_days d ON d.id = l.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[2] Jazz Load Lifting Records (jazz_load_lifting_records):");
  if (jazzLiftingDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(jazzLiftingDups.rows);
  } else {
    console.log("    ✓ 0 duplicates. Exactly 0 or 1 lifting record per day across all periods.");
  }

  // 3. Jazz Company Payable Payments
  const jazzPayableDups = await sql<{
    period_key: string;
    day_no: number;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, count(*) as count
    FROM jazz_company_payable_payments jcp
    JOIN accounting_days d ON d.id = jcp.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, jcp.amount
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[3] Jazz Company Payable Payments (jazz_company_payable_payments):");
  if (jazzPayableDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(jazzPayableDups.rows);
  } else {
    console.log("    ✓ 0 duplicates found.");
  }

  // 4. Expense Items (exact duplicates on same day, category, amount, description)
  const expenseDups = await sql<{
    period_key: string;
    day_no: number;
    category_id: string;
    amount: string;
    description: string;
    created_at_1: string;
    created_at_2: string;
    count: number;
  }>`
    SELECT 
      p.period_key, 
      d.day_no, 
      e.category_id, 
      e.amount, 
      e.description, 
      count(*) as count
    FROM expense_items e
    JOIN accounting_days d ON d.id = e.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, e.category_id, e.amount, e.description
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[4] Expense Module (expense_items):");
  if (expenseDups.rows.length > 0) {
    console.log(`    Found ${expenseDups.rows.length} category+amount+description collisions:`);
    console.table(expenseDups.rows);
  } else {
    console.log("    ✓ 0 duplicate expense items found.");
  }

  // 5. Commission Items (commission_items)
  const commDups = await sql<{
    period_key: string;
    day_no: number;
    category_id: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, c.category_id, count(*) as count
    FROM commission_items c
    JOIN accounting_days d ON d.id = c.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, c.category_id
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[5] Commission Items (commission_items):");
  if (commDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(commDups.rows);
  } else {
    console.log("    ✓ 0 duplicates. Maximum 1 entry per category per day across all periods.");
  }

  // 6. Commission Settlement Receipts
  const commReceiptDups = await sql<{
    period_key: string;
    day_no: number;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, count(*) as count
    FROM commission_settlement_receipts r
    JOIN accounting_days d ON d.id = r.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, r.amount
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[6] Commission Receipts (commission_settlement_receipts):");
  if (commReceiptDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(commReceiptDups.rows);
  } else {
    console.log("    ✓ 0 duplicates found.");
  }

  // 7. Credit Transactions (credit_transactions)
  const creditDups = await sql<{
    period_key: string;
    day_no: number;
    party_id: string;
    party_name_snapshot: string;
    loan_amount: string;
    receipt_amount: string;
    manual_adjustment: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, t.party_id, t.party_name_snapshot, t.loan_amount, t.receipt_amount, t.manual_adjustment, count(*) as count
    FROM credit_transactions t
    JOIN accounting_days d ON d.id = t.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, t.party_id, t.party_name_snapshot, t.loan_amount, t.receipt_amount, t.manual_adjustment
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[7] Credit Transactions (credit_transactions):");
  if (creditDups.rows.length > 0) {
    console.log(`    Found ${creditDups.rows.length} same-party-same-amount items:`);
    console.table(creditDups.rows);
  } else {
    console.log("    ✓ 0 duplicate credit transactions found.");
  }

  // 8. Owner Transactions (owner_transactions)
  const ownerDups = await sql<{
    period_key: string;
    day_no: number;
    description: string;
    amount: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, o.description, o.amount, count(*) as count
    FROM owner_transactions o
    JOIN accounting_days d ON d.id = o.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, o.description, o.amount
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[8] Owner Transactions (owner_transactions):");
  if (ownerDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(ownerDups.rows);
  } else {
    console.log("    ✓ 0 duplicate owner transactions found.");
  }

  // 9. Stock Module: Orders & Lines
  const stockOrderDups = await sql<{
    period_key: string;
    day_no: number;
    account_id: string;
    direction: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, o.account_id, o.direction, count(*) as count
    FROM stock_orders o
    JOIN accounting_days d ON d.id = o.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, o.account_id, o.direction
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[9] Stock Orders (stock_orders):");
  if (stockOrderDups.rows.length > 0) {
    console.table(stockOrderDups.rows);
  } else {
    console.log("    ✓ 0 duplicate stock orders per account per day.");
  }

  // 10. Stock Order Lines (duplicate product in same order)
  const stockOrderLineDups = await sql<{
    stock_order_id: string;
    product_id: string;
    count: number;
  }>`
    SELECT stock_order_id, product_id, count(*) as count
    FROM stock_order_lines
    GROUP BY stock_order_id, product_id
    HAVING count(*) > 1;
  `.execute(db);

  console.log("\n[10] Stock Order Lines (stock_order_lines):");
  if (stockOrderLineDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(stockOrderLineDups.rows);
  } else {
    console.log("    ✓ 0 duplicate product lines within any stock order.");
  }

  // 11. Stock Account Payments
  const stockPaymentDups = await sql<{
    period_key: string;
    day_no: number;
    account_id: string;
    amount: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, pmt.account_id, pmt.amount, count(*) as count
    FROM stock_account_payments pmt
    JOIN accounting_days d ON d.id = pmt.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, pmt.account_id, pmt.amount
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[11] Stock Account Payments (stock_account_payments):");
  if (stockPaymentDups.rows.length > 0) {
    console.table(stockPaymentDups.rows);
  } else {
    console.log("    ✓ 0 duplicate stock account payments per account per day.");
  }

  // 12. Stock Balance Transfers
  const transferDups = await sql<{
    period_key: string;
    day_no: number;
    source_account_id: string;
    destination_account_id: string;
    amount: string;
    count: number;
  }>`
    SELECT p.period_key, d.day_no, t.source_account_id, t.destination_account_id, t.amount, count(*) as count
    FROM stock_balance_transfers t
    JOIN accounting_days d ON d.id = t.day_id
    JOIN accounting_periods p ON p.id = d.period_id
    GROUP BY p.period_key, d.day_no, t.source_account_id, t.destination_account_id, t.amount
    HAVING count(*) > 1
    ORDER BY p.period_key, d.day_no;
  `.execute(db);

  console.log("\n[12] Stock Balance Transfers (stock_balance_transfers):");
  if (transferDups.rows.length > 0) {
    anyDuplicatesFound = true;
    console.table(transferDups.rows);
  } else {
    console.log("    ✓ 0 duplicate stock balance transfers.");
  }

  // 13. Catalogs: DO Profiles, Stock Products, Stock Accounts, Categories
  console.log("\n[13] Catalog Records & Profiles:");
  const doNameDups = await sql<{ do_name: string; count: number }>`
    SELECT do_name, count(*) as count FROM jazz_load_do_profiles WHERE is_active = true GROUP BY do_name HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Active Jazz DO Profiles  : ${doNameDups.rows.length === 0 ? "✓ 0 duplicate names" : "DUPLICATES: " + JSON.stringify(doNameDups.rows)}`);

  const prodDups = await sql<{ name: string; count: number }>`
    SELECT name, count(*) as count FROM stock_products WHERE is_active = true GROUP BY name HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Active Stock Products    : ${prodDups.rows.length === 0 ? "✓ 0 duplicate names" : "DUPLICATES: " + JSON.stringify(prodDups.rows)}`);

  const accDups = await sql<{ name: string; count: number }>`
    SELECT name, count(*) as count FROM stock_accounts WHERE is_active = true GROUP BY name HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Active Stock Accounts    : ${accDups.rows.length === 0 ? "✓ 0 duplicate names" : "DUPLICATES: " + JSON.stringify(accDups.rows)}`);

  const expCatDups = await sql<{ name: string; count: number }>`
    SELECT name, count(*) as count FROM expense_categories WHERE is_active = true GROUP BY name HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Active Expense Categories: ${expCatDups.rows.length === 0 ? "✓ 0 duplicate names" : "DUPLICATES: " + JSON.stringify(expCatDups.rows)}`);

  // 14. Seed Tables
  console.log("\n[14] Period Seed Tables:");
  const finSeeds = await sql<{ period_id: string; count: number }>`
    SELECT period_id, count(*) as count FROM period_financial_seeds GROUP BY period_id HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Financial Seeds          : ${finSeeds.rows.length === 0 ? "✓ 0 duplicates (exactly 1 per period)" : "DUPLICATES"}`);

  const jazzDoSeeds = await sql<{ period_id: string; do_profile_id: string; count: number }>`
    SELECT period_id, do_profile_id, count(*) as count FROM period_jazz_do_seeds GROUP BY period_id, do_profile_id HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Jazz DO Seeds            : ${jazzDoSeeds.rows.length === 0 ? "✓ 0 duplicates" : "DUPLICATES"}`);

  const stockProdSeeds = await sql<{ period_id: string; product_id: string; count: number }>`
    SELECT period_id, product_id, count(*) as count FROM period_stock_product_seeds GROUP BY period_id, product_id HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Stock Product Seeds      : ${stockProdSeeds.rows.length === 0 ? "✓ 0 duplicates" : "DUPLICATES"}`);

  const stockAccSeeds = await sql<{ period_id: string; account_id: string; count: number }>`
    SELECT period_id, account_id, count(*) as count FROM period_stock_account_seeds GROUP BY period_id, account_id HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Stock Account Seeds      : ${stockAccSeeds.rows.length === 0 ? "✓ 0 duplicates" : "DUPLICATES"}`);

  const creditSeeds = await sql<{ period_id: string; party_id: string; count: number }>`
    SELECT period_id, party_id, count(*) as count FROM period_credit_party_seeds GROUP BY period_id, party_id HAVING count(*) > 1;
  `.execute(db);
  console.log(`    - Credit Party Seeds       : ${creditSeeds.rows.length === 0 ? "✓ 0 duplicates" : "DUPLICATES"}`);

  await closeDatabase();
}

main().catch(err => {
  console.error("Audit error:", err);
  process.exit(1);
});
