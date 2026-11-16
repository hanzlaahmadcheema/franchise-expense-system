import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import { recalculateFromDayInternal } from "../calculations/engine.js";

async function main() {
  console.log("================================================================================");
  console.log(" REMOVE ALL DUPLICATIONS & PROPAGATE AUTHORITATIVE RECALCULATIONS");
  console.log("================================================================================");

  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirstOrThrow();

  console.log(`Franchise: ${franchise.name} (${franchise.code}) [${franchise.id}]`);

  // Fetch all 4 periods
  const periods = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "in", ["2026-08", "2026-09", "2026-10", "2026-11"])
    .orderBy("period_key", "asc")
    .execute();

  const periodMap = new Map(periods.map((p) => [p.period_key, p]));
  const augPeriod = periodMap.get("2026-08")!;
  const septPeriod = periodMap.get("2026-09")!;
  const octPeriod = periodMap.get("2026-10")!;
  const novPeriod = periodMap.get("2026-11")!;

  // ---------------------------------------------------------------------------
  // STEP 1: FIX DUPLICATE STOCK ORDER ON NOVEMBER DAY 2
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 1] Checking duplicate stock order on November Day 2...");

  const duplicateStockOrders = await sql<{
    order_id: string;
    day_no: number;
    account_name: string;
    direction: string;
    created_at: string;
    rn: number;
  }>`
    WITH ranked AS (
      SELECT 
        o.id as order_id,
        d.day_no,
        o.account_name_snapshot as account_name,
        o.direction,
        o.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY o.franchise_id, o.day_id, o.account_id, o.direction 
          ORDER BY o.created_at ASC, o.id ASC
        ) as rn
      FROM stock_orders o
      JOIN accounting_days d ON d.id = o.day_id
      JOIN accounting_periods p ON p.id = d.period_id
      WHERE p.period_key = '2026-11' AND d.day_no = 2
    )
    SELECT order_id, day_no, account_name, direction, created_at, rn
    FROM ranked
    ORDER BY rn;
  `.execute(db);

  const stockOrdersToDelete = duplicateStockOrders.rows.filter((r) => r.rn > 1);
  if (stockOrdersToDelete.length > 0) {
    console.log(`Found ${stockOrdersToDelete.length} duplicate stock order(s) on Nov Day 2:`);
    for (const r of stockOrdersToDelete) {
      console.log(`  - Order ID: ${r.order_id} Account: ${r.account_name} Direction: ${r.direction} CreatedAt: ${r.created_at}`);
    }

    const orderIds = stockOrdersToDelete.map((r) => r.order_id);

    console.log("  Disabling ledger immutability triggers for stock orders and lines...");
    await sql`ALTER TABLE stock_order_lines DISABLE TRIGGER trg_stock_order_lines_immutability;`.execute(db);
    await sql`ALTER TABLE stock_orders DISABLE TRIGGER trg_stock_orders_immutability;`.execute(db);

    try {
      console.log("  Deleting duplicate stock order lines...");
      await db
        .deleteFrom("stock_order_lines")
        .where("stock_order_id", "in", orderIds)
        .execute();

      console.log("  Deleting duplicate stock orders...");
      await db
        .deleteFrom("stock_orders")
        .where("id", "in", orderIds)
        .execute();

      console.log(`  ✓ Successfully deleted duplicate stock order(s).`);
    } finally {
      console.log("  Re-enabling ledger immutability triggers for stock orders and lines...");
      await sql`ALTER TABLE stock_orders ENABLE TRIGGER trg_stock_orders_immutability;`.execute(db);
      await sql`ALTER TABLE stock_order_lines ENABLE TRIGGER trg_stock_order_lines_immutability;`.execute(db);
    }
  } else {
    console.log("  ✓ No duplicate stock orders found on November Day 2 (already clean).");
  }

  // ---------------------------------------------------------------------------
  // STEP 2: FIX DUPLICATE JAZZ COMPANY PAYABLE PAYMENT ON AUGUST DAY 1
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 2] Checking duplicate Jazz Company payable payment on August Day 1...");

  const duplicatePayablePayments = await sql<{
    payment_id: string;
    day_no: number;
    amount: string;
    created_at: string;
    rn: number;
  }>`
    WITH ranked AS (
      SELECT 
        jcp.id as payment_id,
        d.day_no,
        jcp.amount,
        jcp.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY jcp.franchise_id, jcp.day_id, jcp.amount 
          ORDER BY jcp.created_at ASC, jcp.id ASC
        ) as rn
      FROM jazz_company_payable_payments jcp
      JOIN accounting_days d ON d.id = jcp.day_id
      JOIN accounting_periods p ON p.id = d.period_id
      WHERE p.period_key = '2026-08' AND d.day_no = 1
    )
    SELECT payment_id, day_no, amount, created_at, rn
    FROM ranked
    ORDER BY rn;
  `.execute(db);

  const paymentsToDelete = duplicatePayablePayments.rows.filter((r) => r.rn > 1);
  if (paymentsToDelete.length > 0) {
    console.log(`Found ${paymentsToDelete.length} duplicate Jazz Company payable payment(s) on August Day 1:`);
    for (const r of paymentsToDelete) {
      console.log(`  - Payment ID: ${r.payment_id} Amount: ${r.amount} CreatedAt: ${r.created_at}`);
    }

    const paymentIds = paymentsToDelete.map((r) => r.payment_id);

    console.log("  Disabling ledger immutability trigger for jazz_company_payable_payments...");
    await sql`ALTER TABLE jazz_company_payable_payments DISABLE TRIGGER trg_jazz_payable_payments_immutability;`.execute(db);

    try {
      console.log("  Deleting duplicate payment record...");
      await db
        .deleteFrom("jazz_company_payable_payments")
        .where("id", "in", paymentIds)
        .execute();

      console.log(`  ✓ Successfully deleted duplicate Jazz Company payable payment.`);
    } finally {
      console.log("  Re-enabling ledger immutability trigger for jazz_company_payable_payments...");
      await sql`ALTER TABLE jazz_company_payable_payments ENABLE TRIGGER trg_jazz_payable_payments_immutability;`.execute(db);
    }
  } else {
    console.log("  ✓ No duplicate payable payments found on August Day 1 (already clean).");
  }

  // ---------------------------------------------------------------------------
  // STEP 3: RECALCULATE AUGUST 2026 FROM DAY 1
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 3] Recalculating August 2026 from Day 1...");

  const augDay1 = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", augPeriod.id)
    .where("day_no", "=", 1)
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    await recalculateFromDayInternal(trx, franchise.id, augDay1.id, {
      triggerSource: "rebuild",
      allowClosedDays: true
    });
  });
  console.log("  ✓ August 2026 recalculated.");

  // ---------------------------------------------------------------------------
  // STEP 4: UPDATE SEPTEMBER OPENING SEED & RECALCULATE SEPTEMBER 2026
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 4] Updating September 2026 opening seed & recalculating...");

  await db
    .updateTable("period_financial_seeds")
    .set({
      opening_jazz_payable: "0.00",
      updated_at: sql`clock_timestamp()`
    })
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", septPeriod.id)
    .execute();

  const septDay1 = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", septPeriod.id)
    .where("day_no", "=", 1)
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    await recalculateFromDayInternal(trx, franchise.id, septDay1.id, {
      triggerSource: "rebuild",
      allowClosedDays: true
    });
  });
  console.log("  ✓ September 2026 opening seed updated and period recalculated.");

  // ---------------------------------------------------------------------------
  // STEP 5: UPDATE OCTOBER OPENING SEED & RECALCULATE OCTOBER 2026
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 5] Updating October 2026 opening seed & recalculating...");

  await db
    .updateTable("period_financial_seeds")
    .set({
      opening_jazz_payable: "0.00",
      updated_at: sql`clock_timestamp()`
    })
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", octPeriod.id)
    .execute();

  const octDay1 = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", octPeriod.id)
    .where("day_no", "=", 1)
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    await recalculateFromDayInternal(trx, franchise.id, octDay1.id, {
      triggerSource: "rebuild",
      allowClosedDays: true
    });
  });
  console.log("  ✓ October 2026 opening seed updated and period recalculated.");

  // ---------------------------------------------------------------------------
  // STEP 6: UPDATE NOVEMBER OPENING SEED & RECALCULATE NOVEMBER 2026
  // ---------------------------------------------------------------------------
  console.log("\n[STEP 6] Updating November 2026 opening seed & recalculating...");

  await db
    .updateTable("period_financial_seeds")
    .set({
      opening_jazz_payable: "0.00",
      updated_at: sql`clock_timestamp()`
    })
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", novPeriod.id)
    .execute();

  const novDay1 = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", novPeriod.id)
    .where("day_no", "=", 1)
    .executeTakeFirstOrThrow();

  await db.transaction().execute(async (trx) => {
    await recalculateFromDayInternal(trx, franchise.id, novDay1.id, {
      triggerSource: "rebuild",
      allowClosedDays: true
    });
  });
  console.log("  ✓ November 2026 opening seed updated and period recalculated.");

  // ---------------------------------------------------------------------------
  // STEP 7: VERIFICATION ACROSS ALL MODULES
  // ---------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log(" VERIFICATION OF FINAL CLEAN STATE");
  console.log("================================================================================");

  // 7.1 Verify Stock Orders on November Day 2
  const novOrdersAfter = await sql<{
    account_name: string;
    product_name: string;
    quantity: number;
    unit_rate: string;
    line_amount: string;
  }>`
    SELECT 
      o.account_name_snapshot as account_name,
      p.name as product_name,
      sol.quantity,
      sol.unit_rate,
      sol.line_amount
    FROM stock_orders o
    JOIN stock_order_lines sol ON sol.stock_order_id = o.id
    JOIN stock_products p ON p.id = sol.product_id
    JOIN accounting_days d ON d.id = o.day_id
    JOIN accounting_periods per ON per.id = d.period_id
    WHERE per.period_key = '2026-11' AND d.day_no = 2
    ORDER BY p.name;
  `.execute(db);

  console.log("\n[Verification 1] November Day 2 Stock Orders & Lines (Expected: 1 order, 300 Retailer SIM + 100 Retail IMZI):");
  console.table(novOrdersAfter.rows);

  // 7.2 Verify November Day 2 DO Naveed Account Projection
  const naveedAccProj = await sql<{
    day_no: number;
    account_name: string;
    opening_due: string;
    stock_taken_amount: string;
    payment_received_amount: string;
    closing_due: string;
  }>`
    SELECT 
      d.day_no,
      a.name as account_name,
      sap.opening_due,
      sap.stock_taken_amount,
      sap.payment_received_amount,
      sap.closing_due
    FROM stock_account_day_projections sap
    JOIN stock_accounts a ON a.id = sap.account_id
    JOIN accounting_days d ON d.id = sap.day_id
    JOIN accounting_periods per ON per.id = d.period_id
    WHERE per.period_key = '2026-11' AND d.day_no BETWEEN 1 AND 5 AND a.name LIKE '%Naveed%'
    ORDER BY d.day_no;
  `.execute(db);

  console.log("\n[Verification 2] DO Naveed Bangla Projections (Nov Days 1-5, Expected: stock_taken on Day 2 = 112,000, closing = 303,240):");
  console.table(naveedAccProj.rows);

  // 7.3 Verify November Day 2 Product Projections
  const novProdProj = await sql<{
    day_no: number;
    product_name: string;
    opening_qty: number;
    stock_out_qty: number;
    closing_qty: number;
  }>`
    SELECT 
      d.day_no,
      p.name as product_name,
      spp.opening_qty,
      spp.stock_out_qty,
      spp.closing_qty
    FROM stock_product_day_projections spp
    JOIN stock_products p ON p.id = spp.product_id
    JOIN accounting_days d ON d.id = spp.day_id
    JOIN accounting_periods per ON per.id = d.period_id
    WHERE per.period_key = '2026-11' AND d.day_no = 2 AND spp.stock_out_qty > 0
    ORDER BY p.name;
  `.execute(db);

  console.log("\n[Verification 3] Nov Day 2 Product Deductions (Expected: Retailer SIM stock_out = 300, Retail IMZI stock_out = 100):");
  console.table(novProdProj.rows);

  // 7.4 Verify Jazz Company Payable across all months
  const payableProjections = await sql<{
    period_key: string;
    day_no: number;
    opening_jazz_payable: string;
    closing_jazz_payable: string;
  }>`
    SELECT 
      per.period_key,
      d.day_no,
      p.opening_jazz_payable,
      p.closing_jazz_payable
    FROM day_financial_projections p
    JOIN accounting_days d ON d.id = p.day_id
    JOIN accounting_periods per ON per.id = d.period_id
    WHERE per.period_key IN ('2026-08', '2026-09', '2026-10', '2026-11')
      AND (p.opening_jazz_payable <> '0.00' OR p.closing_jazz_payable <> '0.00')
    ORDER BY per.period_key, d.day_no;
  `.execute(db);

  console.log(`\n[Verification 4] Non-zero Jazz Company Payable Days across all periods (Expected: 0 rows):`);
  if (payableProjections.rows.length === 0) {
    console.log("  ✓ 0 non-zero days found! All payable balances are perfectly settled at 0.00 across all 4 months.");
  } else {
    console.table(payableProjections.rows);
  }

  // 7.5 Verify Seeds
  const finSeedsAfter = await sql<{
    period_key: string;
    opening_jazz_payable: string;
    opening_jazz_lifting: string;
  }>`
    SELECT per.period_key, s.opening_jazz_payable, s.opening_jazz_lifting
    FROM period_financial_seeds s
    JOIN accounting_periods per ON per.id = s.period_id
    ORDER BY per.period_key;
  `.execute(db);

  console.log("\n[Verification 5] Period Financial Seeds (Expected: opening_jazz_payable = 0.00 for all periods):");
  console.table(finSeedsAfter.rows);

  await closeDatabase();
  console.log("\n================================================================================");
  console.log(" ALL DUPLICATIONS REMOVED AND LEDGERS RECALCULATED SUCCESSFULLY!");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
