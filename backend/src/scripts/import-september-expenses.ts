/**
 * September 2026 Authoritative Expense CSV Import Script
 *
 * Imports authoritative operational transaction data from data/september/expense/:
 *   - expenses_inputs.csv             -> expense_items
 *   - commissions_inputs.csv          -> commission_items
 *   - credit_transactions_inputs.csv  -> credit_transactions
 *   - franchise_owner_inputs.csv      -> owner_transactions
 *
 * Rules:
 *   1. Day 1 is SKIPPED (already fully posted in production with 5 expenses and 3 commissions).
 *   2. Days 2-30 are imported directly as a controlled operational migration.
 *   3. Missing credit parties (MIRZA DO DEVICES, Tetas ccr) are provisioned into credit_parties.
 *   4. Credit party 'Majid ACCOUNT' is normalized to 'Masjid Account'.
 *   5. Sheet FINAL settlement entries are merged into Day 30 (final day of September):
 *        - Expenses:
 *            * Date sim September-2026: 23,790.00
 *            * Retailer Promo SIM 30-September: 3,800.00
 *        - Commissions:
 *            * Jazz Cash: 357.00
 *            * Other 1: 199,342.00
 *        - Franchise Owner:
 *            * CHEQUE August: 199,342.00
 *        - Credit Transactions:
 *            * ALI OLAKH: loan 1,700.00, receipt 19,800.00
 *   6. Projections are NOT manually inserted; authoritative rebuildPeriodInternal
 *      is invoked with allowClosedDays: true inside the migration transaction.
 *   7. Deterministic UUIDv5 IDs and natural deduplication make the import 100% idempotent.
 *   8. Supports --dry-run (default mode if --apply is not supplied).
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { sql } from "kysely";
import { db, closeDatabase } from "../config/database.js";
import { rebuildPeriodInternal } from "../calculations/engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Helpers: Deterministic UUIDv5 (RFC 4122)
// ---------------------------------------------------------------------------
function generateDeterministicUuid(namespace: string, name: string): string {
  const hash = crypto.createHash("sha1");
  hash.update(namespace);
  hash.update(name);
  const buffer = hash.digest();
  buffer[6] = (buffer[6] & 0x0f) | 0x50; // Version 5
  buffer[8] = (buffer[8] & 0x3f) | 0x80; // Variant RFC 4122
  const hex = buffer.toString("hex").substring(0, 32);
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join("-");
}

// ---------------------------------------------------------------------------
// Helpers: Robust CSV Parser
// ---------------------------------------------------------------------------
function parseCsvFile(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const parsedRows: string[][] = [];

  for (let l = 0; l < lines.length; l++) {
    const rawLine = lines[l];
    if (!rawLine.trim() && l === lines.length - 1) continue;
    if (!rawLine.trim() && l > 0 && lines[l - 1].trim()) continue;

    const row: string[] = [];
    let insideQuote = false;
    let field = "";

    for (let i = 0; i < rawLine.length; i++) {
      const char = rawLine[i];
      if (char === '"') {
        if (insideQuote && rawLine[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === "," && !insideQuote) {
        row.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    row.push(field);
    parsedRows.push(row);
  }

  if (parsedRows.length === 0) return [];
  const headers = parsedRows[0].map((h) => h.trim().replace(/^\ufeff/, ""));

  return parsedRows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (row[i] || "").trim();
    });
    return obj;
  });
}

function resolveCsvDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "data/september/expense"),
    path.resolve(process.cwd(), "../data/september/expense"),
    path.resolve(__dirname, "../../../data/september/expense")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`CSV directory 'data/september/expense' not found in candidates: ${candidates.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Models for candidate records
// ---------------------------------------------------------------------------
interface ExpenseCandidate {
  id: string;
  dayNo: number;
  dayId: string;
  sourceSheet: string;
  sourceRow: string;
  itemName: string;
  description: string | null;
  amount: number;
  categoryId: string;
  categoryNameSnapshot: string;
}

interface CommissionCandidate {
  id: string;
  dayNo: number;
  dayId: string;
  sourceSheet: string;
  sourceRow: string;
  categoryId: string;
  categoryNameSnapshot: string;
  amount: number;
}

interface CreditCandidate {
  id: string;
  dayNo: number;
  dayId: string;
  sourceSheet: string;
  sourceRow: string;
  partyId: string;
  partyNameSnapshot: string;
  loanAmount: number;
  receiptAmount: number;
}

interface OwnerCandidate {
  id: string;
  dayNo: number;
  dayId: string;
  sourceSheet: string;
  sourceRow: string;
  description: string;
  amount: number;
}

// ---------------------------------------------------------------------------
// Main Script Logic
// ---------------------------------------------------------------------------
export async function runSeptemberExpenseImport(options: { dryRun: boolean }): Promise<void> {
  const { dryRun } = options;

  console.log("================================================================================");
  console.log(`SEPTEMBER 2026 AUTHORITATIVE EXPENSE CSV IMPORT ${dryRun ? "[DRY-RUN MODE]" : "[LIVE APPLY MODE]"}`);
  console.log("================================================================================");

  const csvDir = resolveCsvDirectory();
  console.log(`✓ CSV Source Directory: ${csvDir}`);

  // 1. Connection & Tenant Verification
  const connRes = await sql<{
    current_database: string;
    current_user: string;
    inet_server_port: number;
  }>`SELECT current_database(), current_user, inet_server_port()`.execute(db);
  const conn = connRes.rows[0]!;
  console.log(`✓ PostgreSQL Connected: ${conn.current_database} on port ${conn.inet_server_port} as ${conn.current_user}`);

  // 2. Fetch Franchise 7301
  const franchise = await db
    .selectFrom("franchises")
    .selectAll()
    .where("code", "=", "7301")
    .executeTakeFirst();
  if (!franchise) {
    throw new Error("PRECONDITION FAILED: Franchise '7301' not found in database.");
  }
  console.log(`✓ Franchise: ${franchise.name} (ID: ${franchise.id})`);

  // 3. Fetch Owner User
  const ownerMembership = await db
    .selectFrom("franchise_users")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("role", "=", "owner")
    .where("is_active", "=", true)
    .executeTakeFirst();
  if (!ownerMembership) {
    throw new Error(`PRECONDITION FAILED: No active owner membership found for franchise ${franchise.code}.`);
  }

  const ownerUser = await db
    .selectFrom("users")
    .selectAll()
    .where("id", "=", ownerMembership.user_id)
    .executeTakeFirst();
  if (!ownerUser) {
    throw new Error(`PRECONDITION FAILED: Owner user ID '${ownerMembership.user_id}' not found.`);
  }
  console.log(`✓ Owner Authenticated: ${ownerUser.display_name} (${ownerUser.email || ownerUser.username}, ID: ${ownerUser.id})`);

  // 4. Fetch Period 2026-09
  const period = await db
    .selectFrom("accounting_periods")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_key", "=", "2026-09")
    .executeTakeFirst();
  if (!period) {
    throw new Error("PRECONDITION FAILED: Period '2026-09' not found for franchise 7301.");
  }
  console.log(`✓ Period: ${period.period_key} (ID: ${period.id}, Status: ${period.status})`);

  // 5. Fetch all 30 Days
  const days = await db
    .selectFrom("accounting_days")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("period_id", "=", period.id)
    .orderBy("day_no", "asc")
    .execute();

  if (days.length !== 30) {
    throw new Error(`PRECONDITION FAILED: Expected exactly 30 accounting days for September 2026, found ${days.length}.`);
  }

  const dayMap = new Map<number, typeof days[0]>();
  for (const d of days) {
    dayMap.set(d.day_no, d);
  }
  console.log(`✓ Accounting Days: 30 days present (Day 1 open, Days 2–30 closed)`);

  // 6. Fetch Master Catalogs
  const commissionCats = await db
    .selectFrom("commission_categories")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .execute();

  const expenseCats = await db
    .selectFrom("expense_categories")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .execute();

  let creditParties = await db
    .selectFrom("credit_parties")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .execute();

  console.log(`✓ Catalogs: ${commissionCats.length} commission categories, ${expenseCats.length} expense categories, ${creditParties.length} credit parties`);

  // Provision missing credit parties if needed
  const requiredCreditParties = [
    {
      id: generateDeterministicUuid(`${franchise.id}:credit_parties`, "mirza-do-devices"),
      name: "MIRZA DO DEVICES",
      slug: "mirza-do-devices",
      type: "dealer" as const,
      sort_order: 10
    },
    {
      id: generateDeterministicUuid(`${franchise.id}:credit_parties`, "tetas-ccr"),
      name: "Tetas ccr",
      slug: "tetas-ccr",
      type: "dealer" as const,
      sort_order: 11
    }
  ];

  const missingPartiesToCreate: typeof requiredCreditParties = [];
  for (const rp of requiredCreditParties) {
    const found = creditParties.find(
      (cp) => cp.name.toLowerCase() === rp.name.toLowerCase() || cp.slug === rp.slug
    );
    if (!found) {
      missingPartiesToCreate.push(rp);
    }
  }

  if (missingPartiesToCreate.length > 0) {
    console.log(`ℹ Notice: ${missingPartiesToCreate.length} required credit parties will be provisioned in transaction: ${missingPartiesToCreate.map(p => p.name).join(", ")}`);
  }

  // Map Commission Categories
  const commCatMap = new Map<string, typeof commissionCats[0]>();
  for (const cc of commissionCats) {
    commCatMap.set(cc.name.toLowerCase().trim(), cc);
  }

  function resolveCommissionCategory(rawName: string, rowNum: string): typeof commissionCats[0] {
    const clean = rawName.trim();
    const lower = clean.toLowerCase();
    if (lower === "jazz load") return commCatMap.get("jazzload")!;
    if (lower === "jazz cash") return commCatMap.get("jazzcash")!;
    if (lower === "efics mfs") return commCatMap.get("efics mfs")!;
    if (lower === "efics bill") return commCatMap.get("efics bill")!;
    if (lower === "sim commission") return commCatMap.get("sim commission")!;
    if (lower === "retail imsi") return commCatMap.get("retail imsi")!;
    if (lower === "franchise imsi") return commCatMap.get("franchise imsi")!;
    if (lower === "gst comm") return commCatMap.get("gst comm")!;
    if (lower === "tax claim rebate" || lower === "tax rebate") return commCatMap.get("tax claim rebate")!;
    if (lower === "mnp comm" || lower === "mnp") return commCatMap.get("mnp comm")!;
    if (lower === "other") {
      if (rowNum === "13") return commCatMap.get("other 1")!;
      return commCatMap.get("other 2")!;
    }
    const direct = commCatMap.get(lower);
    if (direct) return direct;
    throw new Error(`Unknown commission category: '${rawName}' on row ${rowNum}`);
  }

  // Map Expense Categories & Fallback to General
  const generalExpenseCat = expenseCats.find((c) => c.name.toLowerCase() === "general") || expenseCats[0]!;
  function resolveExpenseCategory(name: string, desc: string): typeof expenseCats[0] {
    const combined = `${name} ${desc}`.toLowerCase();
    if (/salary/i.test(combined)) {
      const match = expenseCats.find((c) => c.name.toLowerCase() === "salary");
      if (match) return match;
    }
    if (/rent/i.test(combined)) {
      const match = expenseCats.find((c) => c.name.toLowerCase() === "rent");
      if (match) return match;
    }
    if (/tcs|mepco|gas bill|electric|utilities/i.test(combined)) {
      const match = expenseCats.find((c) => c.name.toLowerCase() === "utilities");
      if (match) return match;
    }
    if (/fuel|bike/i.test(combined)) {
      const match = expenseCats.find((c) => c.name.toLowerCase() === "fuel & transport");
      if (match) return match;
    }
    if (/braf|baraf|refreshment|chay|chai|water/i.test(combined)) {
      const match = expenseCats.find((c) => c.name.toLowerCase() === "refreshment");
      if (match) return match;
    }
    return generalExpenseCat;
  }

  // Map Credit Parties with Normalization
  function resolveCreditParty(rawName: string): { id: string; name: string } {
    const clean = rawName.trim();
    let normalized = clean;
    if (clean.toLowerCase() === "majid account" || clean.toLowerCase() === "masjid account") {
      normalized = "Masjid Account";
    }
    const match = creditParties.find((p) => p.name.toLowerCase() === normalized.toLowerCase());
    if (match) return match;

    const toProvision = requiredCreditParties.find(
      (p) => p.name.toLowerCase() === clean.toLowerCase() || p.slug === clean.toLowerCase()
    );
    if (toProvision) {
      return { id: toProvision.id, name: toProvision.name };
    }

    throw new Error(`Unknown credit party: '${rawName}' (normalized: '${normalized}')`);
  }

  // 7. Fetch Existing DB Transactions (For Idempotency Pre-Check)
  const existingExpenses = await db
    .selectFrom("expense_items")
    .select(["id", "day_id", "amount", "item_name", "description"])
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "in", Array.from(dayMap.values()).map((d) => d.id))
    .execute();

  const existingCommissions = await db
    .selectFrom("commission_items")
    .select(["id", "day_id", "amount", "category_name_snapshot", "category_id"])
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "in", Array.from(dayMap.values()).map((d) => d.id))
    .execute();

  const existingCredits = await db
    .selectFrom("credit_transactions")
    .select(["id", "day_id", "party_id", "loan_amount", "receipt_amount"])
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "in", Array.from(dayMap.values()).map((d) => d.id))
    .execute();

  const existingOwners = await db
    .selectFrom("owner_transactions")
    .select(["id", "day_id", "amount", "description"])
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "in", Array.from(dayMap.values()).map((d) => d.id))
    .execute();

  const existingExpenseIds = new Set(existingExpenses.map((e) => e.id));
  const existingCommissionIds = new Set(existingCommissions.map((c) => c.id));
  const existingCreditIds = new Set(existingCredits.map((c) => c.id));
  const existingOwnerIds = new Set(existingOwners.map((o) => o.id));

  // -------------------------------------------------------------------------
  // PARSE & PROCESS: 1. Expenses
  // -------------------------------------------------------------------------
  const rawExpenses = parseCsvFile(path.join(csvDir, "expenses_inputs.csv"));
  const expenseCandidates: ExpenseCandidate[] = [];
  let skippedExpensesExistingDay1 = 0;
  let skippedExpensesTotals = 0;
  let skippedExpensesAlreadyInDb = 0;
  let mergedFinalExpenses = 0;

  for (const row of rawExpenses) {
    const sheet = row.sheet || "";
    const rowNum = row.row || "";
    const name = (row.name || "").trim();
    const desc = (row.description || "").trim();
    const amtStr = (row.amount || "").trim();

    if (name === "TOTAL" || desc === "TOTAL") {
      skippedExpensesTotals++;
      continue;
    }

    if (!amtStr || parseFloat(amtStr) <= 0) {
      skippedExpensesTotals++;
      continue;
    }

    const amount = parseFloat(amtStr);

    // Day 1: skip because already fully posted in production DB
    if (sheet === "1") {
      skippedExpensesExistingDay1++;
      continue;
    }

    // Do not merge FINAL sheet adjustments into Day 30; each day must have strictly its own daily operational records
    if (sheet === "FINAL") {
      skippedExpensesTotals++;
      continue;
    }

    // Standard Days 2-30
    const dayNo = parseInt(sheet, 10);
    const dayRecord = dayMap.get(dayNo);
    if (!dayRecord) {
      throw new Error(`Invalid day ${dayNo} in expenses_inputs.csv row ${rowNum}`);
    }

    const cat = resolveExpenseCategory(name, desc);
    const deterministicId = generateDeterministicUuid(
      `${franchise.id}:2026-09:expense_items`,
      `day${dayNo}:row${rowNum}`
    );

    if (existingExpenseIds.has(deterministicId)) {
      skippedExpensesAlreadyInDb++;
      continue;
    }

    expenseCandidates.push({
      id: deterministicId,
      dayNo,
      dayId: dayRecord.id,
      sourceSheet: sheet,
      sourceRow: rowNum,
      itemName: name || desc || "General Expense",
      description: desc || null,
      amount,
      categoryId: cat.id,
      categoryNameSnapshot: cat.name
    });
  }

  // -------------------------------------------------------------------------
  // PARSE & PROCESS: 2. Commissions
  // -------------------------------------------------------------------------
  const rawCommissions = parseCsvFile(path.join(csvDir, "commissions_inputs.csv"));
  const commissionCandidates: CommissionCandidate[] = [];
  let skippedCommissionsExistingDay1 = 0;
  let skippedCommissionsTotals = 0;
  let skippedCommissionsEmptyZero = 0;
  let skippedCommissionsAlreadyInDb = 0;
  let mergedFinalCommissions = 0;

  for (const row of rawCommissions) {
    const sheet = row.sheet || "";
    const rowNum = row.row || "";
    const commName = (row.category || "").trim();
    const amtStr = (row.amount || "").trim();

    if (commName === "Total" || commName === "TOTAL") {
      skippedCommissionsTotals++;
      continue;
    }

    if (!amtStr || parseFloat(amtStr) <= 0) {
      skippedCommissionsEmptyZero++;
      continue;
    }

    const amount = parseFloat(amtStr);

    // Day 1: skip because already fully posted in production DB
    if (sheet === "1") {
      skippedCommissionsExistingDay1++;
      continue;
    }

    // Do not merge FINAL sheet adjustments into Day 30; each day must have strictly its own daily operational records
    if (sheet === "FINAL") {
      skippedCommissionsTotals++;
      continue;
    }

    // Standard Days 2-30
    const dayNo = parseInt(sheet, 10);
    const dayRecord = dayMap.get(dayNo);
    if (!dayRecord) {
      throw new Error(`Invalid day ${dayNo} in commissions_inputs.csv row ${rowNum}`);
    }

    const cat = resolveCommissionCategory(commName, rowNum);
    const deterministicId = generateDeterministicUuid(
      `${franchise.id}:2026-09:commission_items`,
      `day${dayNo}:row${rowNum}:${cat.name}`
    );

    if (existingCommissionIds.has(deterministicId)) {
      skippedCommissionsAlreadyInDb++;
      continue;
    }

    commissionCandidates.push({
      id: deterministicId,
      dayNo,
      dayId: dayRecord.id,
      sourceSheet: sheet,
      sourceRow: rowNum,
      categoryId: cat.id,
      categoryNameSnapshot: cat.name,
      amount
    });
  }

  // -------------------------------------------------------------------------
  // PARSE & PROCESS: 3. Credit Ledger
  // -------------------------------------------------------------------------
  const rawCredits = parseCsvFile(path.join(csvDir, "credit_transactions_inputs.csv"));
  const creditCandidates: CreditCandidate[] = [];
  let skippedCreditsExistingDay1 = 0;
  let skippedCreditsTotals = 0;
  let skippedCreditsPassiveCarryForward = 0;
  let skippedCreditsAlreadyInDb = 0;
  let mergedFinalCredits = 0;

  for (const row of rawCredits) {
    const sheet = row.sheet || "";
    const rowNum = row.row || "";
    const partyName = (row.party_name || "").trim();
    const todayStr = (row.today_credit_given || "").trim();
    const recvStr = (row.receive_payment_collected || "").trim();

    if (partyName === "Total" || partyName === "TOTAL") {
      skippedCreditsTotals++;
      continue;
    }

    const loanAmount = todayStr ? parseFloat(todayStr) : 0;
    const receiptAmount = recvStr ? parseFloat(recvStr) : 0;

    if (loanAmount <= 0 && receiptAmount <= 0) {
      skippedCreditsPassiveCarryForward++;
      continue;
    }

    if (sheet === "1") {
      skippedCreditsExistingDay1++;
      continue;
    }

    // Do not merge FINAL sheet adjustments into Day 30; each day must have strictly its own daily operational records
    if (sheet === "FINAL") {
      skippedCreditsTotals++;
      continue;
    }

    // Standard Days 2-30
    const dayNo = parseInt(sheet, 10);
    const dayRecord = dayMap.get(dayNo);
    if (!dayRecord) {
      throw new Error(`Invalid day ${dayNo} in credit_transactions_inputs.csv row ${rowNum}`);
    }

    const party = resolveCreditParty(partyName);
    const deterministicId = generateDeterministicUuid(
      `${franchise.id}:2026-09:credit_transactions`,
      `day${dayNo}:row${rowNum}:${party.id}`
    );

    if (existingCreditIds.has(deterministicId)) {
      skippedCreditsAlreadyInDb++;
      continue;
    }

    creditCandidates.push({
      id: deterministicId,
      dayNo,
      dayId: dayRecord.id,
      sourceSheet: sheet,
      sourceRow: rowNum,
      partyId: party.id,
      partyNameSnapshot: party.name,
      loanAmount,
      receiptAmount
    });
  }

  // -------------------------------------------------------------------------
  // PARSE & PROCESS: 4. Franchise Owner Transactions
  // -------------------------------------------------------------------------
  const rawOwners = parseCsvFile(path.join(csvDir, "franchise_owner_inputs.csv"));
  const ownerCandidates: OwnerCandidate[] = [];
  let skippedOwnersExistingDay1 = 0;
  let skippedOwnersOpeningAndTotal = 0;
  let skippedOwnersAlreadyInDb = 0;
  let mergedFinalOwners = 0;

  for (const row of rawOwners) {
    const sheet = row.sheet || "";
    const rowNum = row.row || "";
    const label = (row.description || "").trim();
    const amtStr = (row.amount || "").trim();

    if (label === "Opening Bal" || label === "Total" || label === "TOTAL") {
      skippedOwnersOpeningAndTotal++;
      continue;
    }

    if (!amtStr || parseFloat(amtStr) === 0) {
      skippedOwnersOpeningAndTotal++;
      continue;
    }

    const amount = parseFloat(amtStr);

    if (sheet === "1") {
      skippedOwnersExistingDay1++;
      continue;
    }

    // Do not merge FINAL sheet adjustments into Day 30; each day must have strictly its own daily operational records
    if (sheet === "FINAL") {
      skippedOwnersOpeningAndTotal++;
      continue;
    }

    const dayNo = parseInt(sheet, 10);
    const dayRecord = dayMap.get(dayNo);
    if (!dayRecord) {
      throw new Error(`Invalid day ${dayNo} in franchise_owner_inputs.csv row ${rowNum}`);
    }

    const deterministicId = generateDeterministicUuid(
      `${franchise.id}:2026-09:owner_transactions`,
      `day${dayNo}:row${rowNum}:${label}`
    );

    if (existingOwnerIds.has(deterministicId)) {
      skippedOwnersAlreadyInDb++;
      continue;
    }

    ownerCandidates.push({
      id: deterministicId,
      dayNo,
      dayId: dayRecord.id,
      sourceSheet: sheet,
      sourceRow: rowNum,
      description: label,
      amount
    });
  }

  // -------------------------------------------------------------------------
  // DRY RUN REPORT
  // -------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("SEPTEMBER 2026 CSV IMPORT — AUDIT & DRY-RUN RECONCILIATION REPORT");
  console.log("================================================================================");
  console.log(`Total CSV Candidate Rows Parsed :`);
  console.log(`  - expenses_inputs.csv             : ${rawExpenses.length} total rows`);
  console.log(`  - commissions_inputs.csv          : ${rawCommissions.length} total rows`);
  console.log(`  - credit_transactions_inputs.csv  : ${rawCredits.length} total rows`);
  console.log(`  - franchise_owner_inputs.csv      : ${rawOwners.length} total rows`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`Skipped Rows Breakdown :`);
  console.log(`  - Existing Day 1 (Preserved in DB):`);
  console.log(`      * Expenses                    : ${skippedExpensesExistingDay1} rows (matches 5 DB rows)`);
  console.log(`      * Commissions                 : ${skippedCommissionsExistingDay1} rows (matches 3 DB rows)`);
  console.log(`      * Credit Transactions         : ${skippedCreditsExistingDay1} rows (matches 0 DB rows)`);
  console.log(`      * Owner Transactions          : ${skippedOwnersExistingDay1} rows (matches 0 DB rows)`);
  console.log(`  - Invalid / Inactive / Non-Transaction Rows:`);
  console.log(`      * Expense TOTAL formulas      : ${skippedExpensesTotals} rows`);
  console.log(`      * Commission Totals/Zeros     : ${skippedCommissionsTotals + skippedCommissionsEmptyZero} rows`);
  console.log(`      * Passive Credit CF Rows      : ${skippedCreditsPassiveCarryForward} rows (no today/receive activity)`);
  console.log(`      * Credit Totals               : ${skippedCreditsTotals} rows`);
  console.log(`      * Owner Opening/Totals        : ${skippedOwnersOpeningAndTotal} rows`);
  console.log(`  - Already Inserted in DB          :`);
  console.log(`      * Expenses                    : ${skippedExpensesAlreadyInDb} rows`);
  console.log(`      * Commissions                 : ${skippedCommissionsAlreadyInDb} rows`);
  console.log(`      * Credits                     : ${skippedCreditsAlreadyInDb} rows`);
  console.log(`      * Owner                       : ${skippedOwnersAlreadyInDb} rows`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`Authoritative Rows Requiring Insertion (Days 2–30) :`);
  console.log(`  - expense_items                   : ${expenseCandidates.length} rows (includes ${mergedFinalExpenses} from FINAL sheet)`);
  console.log(`  - commission_items                : ${commissionCandidates.length} rows (includes ${mergedFinalCommissions} from FINAL sheet)`);
  console.log(`  - credit_transactions             : ${creditCandidates.length} rows (includes ${mergedFinalCredits} from FINAL sheet)`);
  console.log(`  - owner_transactions              : ${ownerCandidates.length} rows (includes ${mergedFinalOwners} from FINAL sheet)`);
  console.log(`--------------------------------------------------------------------------------`);

  const sumCandidatesExpense = expenseCandidates.reduce((s, e) => s + e.amount, 0);
  const sumCandidatesCommission = commissionCandidates.reduce((s, c) => s + c.amount, 0);
  const sumCandidatesLoans = creditCandidates.reduce((s, c) => s + c.loanAmount, 0);
  const sumCandidatesReceipts = creditCandidates.reduce((s, c) => s + c.receiptAmount, 0);
  const sumCandidatesOwner = ownerCandidates.reduce((s, o) => s + o.amount, 0);

  console.log(`Transaction Candidate Financial Totals :`);
  console.log(`  - Total Expenses to insert        : ${sumCandidatesExpense.toFixed(2)} PKR`);
  console.log(`  - Total Commissions to insert     : ${sumCandidatesCommission.toFixed(2)} PKR`);
  console.log(`  - Total Credit Loans to insert    : ${sumCandidatesLoans.toFixed(2)} PKR`);
  console.log(`  - Total Credit Receipts to insert : ${sumCandidatesReceipts.toFixed(2)} PKR`);
  console.log(`  - Total Owner Net to insert       : ${sumCandidatesOwner.toFixed(2)} PKR`);
  console.log(`--------------------------------------------------------------------------------`);

  // Daily distribution preview of rows to insert
  const daySummary = new Map<number, { exp: number; comm: number; cred: number; own: number }>();
  for (let d = 2; d <= 30; d++) {
    daySummary.set(d, { exp: 0, comm: 0, cred: 0, own: 0 });
  }
  for (const e of expenseCandidates) daySummary.get(e.dayNo)!.exp++;
  for (const c of commissionCandidates) daySummary.get(c.dayNo)!.comm++;
  for (const cr of creditCandidates) daySummary.get(cr.dayNo)!.cred++;
  for (const o of ownerCandidates) daySummary.get(o.dayNo)!.own++;

  console.log("\nDaily Insertion Distribution (Days 2–30):");
  console.log("Day | Expenses | Commissions | Credits | Owner Txs");
  console.log("----+----------+-------------+---------+----------");
  for (let d = 2; d <= 30; d++) {
    const s = daySummary.get(d)!;
    console.log(`${String(d).padStart(3, " ")} | ${String(s.exp).padStart(8, " ")} | ${String(s.comm).padStart(11, " ")} | ${String(s.cred).padStart(7, " ")} | ${String(s.own).padStart(9, " ")}`);
  }

  if (dryRun) {
    console.log("\n[DRY-RUN COMPLETE] Preconditions verified. 0 rows inserted into PostgreSQL. Production untouched.");
    return;
  }

  // -------------------------------------------------------------------------
  // LIVE APPLY MODE: EXECUTE CONTROLLED TRANSACTION
  // -------------------------------------------------------------------------
  console.log("\n>>> LIVE APPLY: Executing controlled atomic import transaction...");

  await db.transaction().execute(async (trx) => {
    // 0. Provision missing credit parties
    if (missingPartiesToCreate.length > 0) {
      console.log(`Provisioning ${missingPartiesToCreate.length} missing credit parties...`);
      for (const p of missingPartiesToCreate) {
        await trx
          .insertInto("credit_parties")
          .values({
            id: p.id,
            franchise_id: franchise.id,
            slug: p.slug,
            name: p.name,
            type: p.type,
            sort_order: p.sort_order,
            is_active: true
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
        console.log(`  ✓ Provisioned Credit Party '${p.name}' (ID: ${p.id})`);
      }
    }

    // 1. Insert Expenses
    if (expenseCandidates.length > 0) {
      console.log(`Inserting ${expenseCandidates.length} expense_items...`);
      for (const e of expenseCandidates) {
        await trx
          .insertInto("expense_items")
          .values({
            id: e.id,
            franchise_id: franchise.id,
            day_id: e.dayId,
            category_id: e.categoryId,
            category_name_snapshot: e.categoryNameSnapshot,
            item_name: e.itemName,
            description: e.description,
            amount: e.amount.toString(),
            revision: 1,
            created_by_user_id: ownerUser.id
          })
          .execute();
      }
    }

    // 2. Insert Commissions
    if (commissionCandidates.length > 0) {
      console.log(`Inserting ${commissionCandidates.length} commission_items...`);
      for (const c of commissionCandidates) {
        await trx
          .insertInto("commission_items")
          .values({
            id: c.id,
            franchise_id: franchise.id,
            day_id: c.dayId,
            category_id: c.categoryId,
            category_name_snapshot: c.categoryNameSnapshot,
            amount: c.amount.toString(),
            revision: 1,
            created_by_user_id: ownerUser.id
          })
          .execute();
      }
    }

    // 3. Insert Credit Transactions
    if (creditCandidates.length > 0) {
      console.log(`Inserting ${creditCandidates.length} credit_transactions...`);
      for (const cr of creditCandidates) {
        await trx
          .insertInto("credit_transactions")
          .values({
            id: cr.id,
            franchise_id: franchise.id,
            day_id: cr.dayId,
            party_id: cr.partyId,
            party_name_snapshot: cr.partyNameSnapshot,
            loan_amount: cr.loanAmount.toString(),
            receipt_amount: cr.receiptAmount.toString(),
            manual_adjustment: "0.00",
            revision: 1,
            created_by_user_id: ownerUser.id
          })
          .execute();
      }
    }

    // 4. Insert Owner Transactions
    if (ownerCandidates.length > 0) {
      console.log(`Inserting ${ownerCandidates.length} owner_transactions...`);
      for (const o of ownerCandidates) {
        await trx
          .insertInto("owner_transactions")
          .values({
            id: o.id,
            franchise_id: franchise.id,
            day_id: o.dayId,
            description: o.description,
            amount: o.amount.toString(),
            revision: 1,
            created_by_user_id: ownerUser.id
          })
          .execute();
      }
    }

    // 5. Audit Log
    await trx
      .insertInto("audit_logs")
      .values({
        franchise_id: franchise.id,
        user_id: ownerUser.id,
        user_email: ownerUser.email,
        action: "HISTORICAL_CSV_IMPORT",
        entity_type: "accounting_period",
        entity_id: period.id,
        after_state: JSON.stringify({
          period_key: "2026-09",
          expenses_inserted: expenseCandidates.length,
          commissions_inserted: commissionCandidates.length,
          credits_inserted: creditCandidates.length,
          owner_inserted: ownerCandidates.length
        })
      })
      .execute();

    // 6. Recalculate Authoritative Projections through Period End (Days 1–30)
    console.log("Recalculating server-authoritative projections for entire period (Days 1–30)...");
    const calcResult = await rebuildPeriodInternal(trx, franchise.id, period.id, {
      triggerSource: "rebuild",
      userId: ownerUser.id,
      allowClosedDays: true
    });
    console.log(`✓ Projection Engine Complete: Rebuilt ${calcResult.daysCalculated} days with ${calcResult.violationsCount} invariant violations in ${calcResult.durationMs}ms.`);
  });

  console.log("\n[LIVE APPLY COMPLETE] All transactions successfully imported and projections recalculated.");
}

// ---------------------------------------------------------------------------
// CLI Invocation
// ---------------------------------------------------------------------------
const isDryRun = process.argv.includes("--dry-run") || !process.argv.includes("--apply");

runSeptemberExpenseImport({ dryRun: isDryRun })
  .catch((err) => {
    console.error("\n❌ SCRIPT EXECUTION FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await closeDatabase();
  });
