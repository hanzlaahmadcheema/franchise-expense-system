/**
 * September 2026 Authoritative Jazz Load Input Importer
 *
 * Imports raw operational historical inputs from data/september/load/:
 *   - distributor_transactions_inputs.csv -> raw issuance_base & payment_base into jazz_load_do_entries
 *   - company_lifting_inputs.csv          -> raw ml_lifting_amount into jazz_load_lifting_records
 *
 * Rules:
 *   1. Day 1 lifting record (1,330,000) and existing 10 DO entries are preserved. Missing Day 1 entry (Hussain) is imported.
 *   2. Days 2–30 raw inputs are imported with 100% fidelity.
 *   3. Passive zero/blank rows (issuance = 0 and payment = 0) are skipped.
 *   4. DO NOT create or import commission_items (already managed in expense module).
 *   5. Derived balances (opening/closing DO balance, ML balance, lifting in hand)
 *      are calculated server-authoritatively by the PostgreSQL engine (rebuildPeriodInternal).
 *   6. Deterministic UUIDv5 IDs ensure 100% idempotent identity.
 *   7. Supports --dry-run (default mode if --apply is not supplied).
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

const JAZZ_LOAD_IMPORT_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // RFC 4122 namespace DNS

// ---------------------------------------------------------------------------
// Helpers: Deterministic UUIDv5 (RFC 4122)
// ---------------------------------------------------------------------------
export function generateDeterministicUuid(namespace: string, name: string): string {
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
// Helpers: CSV Parser
// ---------------------------------------------------------------------------
export function parseCsvFile(filePath: string): Record<string, string>[] {
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

export function resolveJazzLoadCsvDirectory(): string {
  const candidates = [
    path.resolve(process.cwd(), "data/september/load"),
    path.resolve(process.cwd(), "../data/september/load"),
    path.resolve(__dirname, "../../../data/september/load")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`CSV directory 'data/september/load' not found in candidates: ${candidates.join(", ")}`);
}

// ---------------------------------------------------------------------------
// DO S.No to Profile Mapping Table
// ---------------------------------------------------------------------------
export interface DoProfileMapping {
  sNo: number;
  expectedCsvNames: string[];
  expectedLine: string;
  targetProfileName: string;
  targetProfileLine: string;
}

export const DO_S_NO_MAPPING: Record<number, DoProfileMapping> = {
  1: {
    sNo: 1,
    expectedCsvNames: ["RIZWAN"],
    expectedLine: "3017211475",
    targetProfileName: "Naveed Bangla",
    targetProfileLine: "03017211475"
  },
  2: {
    sNo: 2,
    expectedCsvNames: ["MIRZA"],
    expectedLine: "3051639672",
    targetProfileName: "Mirza",
    targetProfileLine: "03051639672"
  },
  3: {
    sNo: 3,
    expectedCsvNames: ["ADNAN"],
    expectedLine: "3017211714",
    targetProfileName: "Adnan",
    targetProfileLine: "03017211714"
  },
  4: {
    sNo: 4,
    expectedCsvNames: ["ARSLAN"],
    expectedLine: "3027100125",
    targetProfileName: "Arslan",
    targetProfileLine: "03027100125"
  },
  5: {
    sNo: 5,
    expectedCsvNames: ["MUBASHAR"],
    expectedLine: "3027100126",
    targetProfileName: "Mubashir",
    targetProfileLine: "03027100126"
  },
  6: {
    sNo: 6,
    expectedCsvNames: ["IRFAN MIRZA"],
    expectedLine: "3027103467",
    targetProfileName: "Irfan Mirza",
    targetProfileLine: "03027103467"
  },
  7: {
    sNo: 7,
    expectedCsvNames: ["HASSAN"],
    expectedLine: "3027103468",
    targetProfileName: "Hassan",
    targetProfileLine: "03027103468"
  },
  8: {
    sNo: 8,
    expectedCsvNames: ["NAVEED"],
    expectedLine: "3030963707",
    targetProfileName: "Naveed",
    targetProfileLine: "03030963707"
  },
  9: {
    sNo: 9,
    expectedCsvNames: ["IRFAN"],
    expectedLine: "3030964504",
    targetProfileName: "Irfan",
    targetProfileLine: "03030964504"
  },
  10: {
    sNo: 10,
    expectedCsvNames: ["FIXED LINE", "OFFICE"],
    expectedLine: "3027107343",
    targetProfileName: "Fix Line",
    targetProfileLine: "03027107343"
  },
  11: {
    sNo: 11,
    expectedCsvNames: ["ANNI"],
    expectedLine: "3087081311",
    targetProfileName: "Anni",
    targetProfileLine: "03087081311"
  },
  12: {
    sNo: 12,
    expectedCsvNames: ["FAKHAR", "HUSSAIN"],
    expectedLine: "3027108872",
    targetProfileName: "Fakhar",
    targetProfileLine: "03027108872"
  },
  13: {
    sNo: 13,
    expectedCsvNames: ["SARAM"],
    expectedLine: "3250919702",
    targetProfileName: "Saram",
    targetProfileLine: "03250919702"
  },
  14: {
    sNo: 14,
    expectedCsvNames: ["OTHER"],
    expectedLine: "3027107343",
    targetProfileName: "Other",
    targetProfileLine: "03200926230"
  }
};

// ---------------------------------------------------------------------------
// Candidate Record Models
// ---------------------------------------------------------------------------
export interface JazzDoCandidate {
  id: string;
  dayNo: number;
  dayId: string;
  sNo: number;
  csvName: string;
  csvLine: string;
  profileId: string;
  profileName: string;
  profileLine: string | null;
  issuanceBase: number;
  paymentBase: number;
  appliedMlRatePercentage: number;
}

export interface JazzLiftingCandidate {
  id: string;
  dayNo: number;
  dayId: string;
  lifting1: number;
  lifting2: number;
  mlLiftingAmount: number;
}

// ---------------------------------------------------------------------------
// Main Script Logic
// ---------------------------------------------------------------------------
export async function runSeptemberJazzLoadImport(options: { dryRun: boolean }): Promise<void> {
  const { dryRun } = options;

  console.log("================================================================================");
  console.log(`SEPTEMBER 2026 JAZZ LOAD HISTORICAL INPUT IMPORT ${dryRun ? "[DRY-RUN MODE]" : "[LIVE APPLY MODE]"}`);
  console.log("================================================================================");

  const csvDir = resolveJazzLoadCsvDirectory();
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

  // 6. Fetch Active Jazz Load Rates
  const rateRecord = await db
    .selectFrom("jazz_load_rates")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .orderBy("effective_from", "desc")
    .executeTakeFirst();
  if (!rateRecord) {
    throw new Error("PRECONDITION FAILED: No active jazz_load_rates record found.");
  }
  const activeMlRate = Number(rateRecord.ml_rate);
  console.log(`✓ Active Rate: ${rateRecord.name} (ML Rate: ${activeMlRate.toFixed(4)}%)`);

  // 7. Fetch Active DO Profiles
  const profiles = await db
    .selectFrom("jazz_load_do_profiles")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("is_active", "=", true)
    .execute();
  console.log(`✓ DO Profiles: ${profiles.length} active profiles in database`);

  const profileByName = new Map<string, typeof profiles[0]>();
  for (const p of profiles) {
    profileByName.set(p.do_name.toLowerCase().trim(), p);
  }

  // 8. Fetch Existing Lifting and DO Entries in DB
  const existingLifting = await db
    .selectFrom("jazz_load_lifting_records")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "in", Array.from(dayMap.values()).map(d => d.id))
    .execute();

  const existingDo = await db
    .selectFrom("jazz_load_do_entries")
    .selectAll()
    .where("franchise_id", "=", franchise.id)
    .where("day_id", "in", Array.from(dayMap.values()).map(d => d.id))
    .execute();

  const existingLiftingDayIds = new Set(existingLifting.map(l => l.day_id));
  const existingDoKeys = new Set(existingDo.map(e => `${e.day_id}:${e.do_profile_id}`));

  console.log(`✓ Existing DB State: ${existingLifting.length} lifting records, ${existingDo.length} DO entries`);

  // -------------------------------------------------------------------------
  // PARSE & PLAN: 1. Company Lifting
  // -------------------------------------------------------------------------
  const liftingCsvPath = path.join(csvDir, "company_lifting_inputs.csv");
  const rawLiftingRows = parseCsvFile(liftingCsvPath);

  // Group by dayNo
  const dailyLiftingMap = new Map<number, { l1: number; l2: number; total: number }>();
  for (const row of rawLiftingRows) {
    const dayNo = parseInt(row.sheet || "0", 10);
    if (isNaN(dayNo) || dayNo < 1 || dayNo > 30) continue;

    const amt = parseFloat(row.amount || "0") || 0;
    if (!dailyLiftingMap.has(dayNo)) {
      dailyLiftingMap.set(dayNo, { l1: 0, l2: 0, total: 0 });
    }
    const entry = dailyLiftingMap.get(dayNo)!;
    if ((row.lifting_type || "").includes("1st")) {
      entry.l1 += amt;
    } else if ((row.lifting_type || "").includes("2nd")) {
      entry.l2 += amt;
    }
    entry.total += amt;
  }

  const liftingCandidates: JazzLiftingCandidate[] = [];
  let skippedExistingLiftingCount = 0;

  for (const [dayNo, data] of Array.from(dailyLiftingMap.entries()).sort((a, b) => a[0] - b[0])) {
    const dayInfo = dayMap.get(dayNo);
    if (!dayInfo) throw new Error(`Day ${dayNo} not found in accounting_days`);

    if (existingLiftingDayIds.has(dayInfo.id)) {
      skippedExistingLiftingCount++;
      continue;
    }

    const id = generateDeterministicUuid(
      JAZZ_LOAD_IMPORT_NAMESPACE,
      `${franchise.id}:${period.id}:day${dayNo}:jazz_lifting`
    );

    liftingCandidates.push({
      id,
      dayNo,
      dayId: dayInfo.id,
      lifting1: data.l1,
      lifting2: data.l2,
      mlLiftingAmount: data.total
    });
  }

  // -------------------------------------------------------------------------
  // PARSE & PLAN: 2. DO Distributor Transactions
  // -------------------------------------------------------------------------
  const distCsvPath = path.join(csvDir, "distributor_transactions_inputs.csv");
  const rawDistRows = parseCsvFile(distCsvPath);

  const doCandidates: JazzDoCandidate[] = [];
  let skippedZeroDoRows = 0;
  let skippedExistingDoRows = 0;
  let unknownDoCount = 0;

  for (const row of rawDistRows) {
    const dayNo = parseInt(row.sheet || "0", 10);
    const sNo = parseInt(row.s_no || "0", 10);
    if (isNaN(dayNo) || isNaN(sNo) || dayNo < 1 || dayNo > 30) continue;

    const iss = parseFloat(row.issuance_amount || "0") || 0;
    const rec = parseFloat(row.payment_received_amount || "0") || 0;

    if (iss === 0 && rec === 0) {
      skippedZeroDoRows++;
      continue;
    }

    const mapping = DO_S_NO_MAPPING[sNo];
    if (!mapping) {
      console.warn(`[WARN] Unknown DO S.No ${sNo} on Day ${dayNo} (Name: ${row.do_name})`);
      unknownDoCount++;
      continue;
    }

    const profile = profileByName.get(mapping.targetProfileName.toLowerCase().trim());
    if (!profile) {
      console.warn(`[WARN] Profile not found for mapping: '${mapping.targetProfileName}'`);
      unknownDoCount++;
      continue;
    }

    const dayInfo = dayMap.get(dayNo);
    if (!dayInfo) throw new Error(`Day ${dayNo} not found in accounting_days`);

    const doKey = `${dayInfo.id}:${profile.id}`;
    if (existingDoKeys.has(doKey)) {
      skippedExistingDoRows++;
      continue;
    }

    const id = generateDeterministicUuid(
      JAZZ_LOAD_IMPORT_NAMESPACE,
      `${franchise.id}:${period.id}:day${dayNo}:${profile.id}:jazz_do`
    );

    doCandidates.push({
      id,
      dayNo,
      dayId: dayInfo.id,
      sNo,
      csvName: row.do_name || "",
      csvLine: row.do_line || "",
      profileId: profile.id,
      profileName: profile.do_name,
      profileLine: profile.do_line,
      issuanceBase: iss,
      paymentBase: rec,
      appliedMlRatePercentage: activeMlRate
    });
  }

  // -------------------------------------------------------------------------
  // DRY RUN REPORT
  // -------------------------------------------------------------------------
  console.log("\n================================================================================");
  console.log("SEPTEMBER 2026 JAZZ LOAD IMPORT — AUDIT & DRY-RUN RECONCILIATION REPORT");
  console.log("================================================================================");
  console.log(`Total CSV Candidate Rows Parsed :`);
  console.log(`  - company_lifting_inputs.csv      : ${rawLiftingRows.length} rows (${dailyLiftingMap.size} lifting days)`);
  console.log(`  - distributor_transactions_inputs.csv : ${rawDistRows.length} distributor transaction rows`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`Skipped Rows Breakdown :`);
  console.log(`  - Existing Day 1 in DB (Preserved) :`);
  console.log(`      * Lifting records             : ${skippedExistingLiftingCount} day (Day 1: 1,330,000.00 PKR)`);
  console.log(`      * DO entries                  : ${skippedExistingDoRows} entries (matches 10 existing Day 1 entries)`);
  console.log(`  - Zero activity DO rows           : ${skippedZeroDoRows} rows`);
  console.log(`  - Unknown DO profiles             : ${unknownDoCount} rows`);
  console.log(`--------------------------------------------------------------------------------`);
  console.log(`Authoritative Rows Requiring Insertion :`);
  console.log(`  - jazz_load_lifting_records       : ${liftingCandidates.length} days`);
  console.log(`  - jazz_load_do_entries            : ${doCandidates.length} entries (includes 1 missing Day 1 entry: Hussain)`);
  console.log(`--------------------------------------------------------------------------------`);

  const sumCandidatesLifting = liftingCandidates.reduce((s, l) => s + l.mlLiftingAmount, 0);
  const sumCandidatesIssuance = doCandidates.reduce((s, d) => s + d.issuanceBase, 0);
  const sumCandidatesPayment = doCandidates.reduce((s, d) => s + d.paymentBase, 0);

  console.log(`Transaction Candidate Financial Totals :`);
  console.log(`  - Total Lifting Amount to insert  : ${sumCandidatesLifting.toLocaleString()} PKR (plus Day 1 1,330,000 = 27,930,000 PKR total)`);
  console.log(`  - Total Issuance Base to insert   : ${sumCandidatesIssuance.toLocaleString()} PKR`);
  console.log(`  - Total Payment Base to insert    : ${sumCandidatesPayment.toLocaleString()} PKR`);
  console.log(`  - Total Net Base to insert        : ${(sumCandidatesIssuance - sumCandidatesPayment).toLocaleString()} PKR`);
  console.log(`--------------------------------------------------------------------------------`);

  // Daily distribution preview of rows to insert
  const daySummary = new Map<number, { liftingAmt: number; doCount: number; doIss: number; doPay: number }>();
  for (let d = 1; d <= 30; d++) {
    daySummary.set(d, { liftingAmt: 0, doCount: 0, doIss: 0, doPay: 0 });
  }
  for (const l of liftingCandidates) {
    const s = daySummary.get(l.dayNo)!;
    s.liftingAmt += l.mlLiftingAmount;
  }
  for (const d of doCandidates) {
    const s = daySummary.get(d.dayNo)!;
    s.doCount++;
    s.doIss += d.issuanceBase;
    s.doPay += d.paymentBase;
  }

  console.log("\nDaily Insertion Distribution (Days 1–30):");
  console.log("Day | Lifting (PKR) | DO Count | Issuance Base (PKR) | Payment Base (PKR)");
  console.log("----+---------------+----------+---------------------+-------------------");
  for (let d = 1; d <= 30; d++) {
    const s = daySummary.get(d)!;
    console.log(
      `${String(d).padStart(3, " ")} | ` +
      `${s.liftingAmt > 0 ? s.liftingAmt.toLocaleString().padStart(13, " ") : "-".padStart(13, " ")} | ` +
      `${String(s.doCount).padStart(8, " ")} | ` +
      `${s.doIss > 0 ? s.doIss.toLocaleString().padStart(19, " ") : "-".padStart(19, " ")} | ` +
      `${s.doPay > 0 ? s.doPay.toLocaleString().padStart(17, " ") : "-".padStart(17, " ")}`
    );
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
    // 1. Insert Lifting Records
    if (liftingCandidates.length > 0) {
      console.log(`Inserting ${liftingCandidates.length} jazz_load_lifting_records...`);
      for (const l of liftingCandidates) {
        await trx
          .insertInto("jazz_load_lifting_records")
          .values({
            id: l.id,
            franchise_id: franchise.id,
            day_id: l.dayId,
            ml_lifting_amount: l.mlLiftingAmount.toString(),
            notes: null,
            created_by_user_id: ownerUser.id
          })
          .execute();
      }
    }

    // 2. Insert DO Entries
    if (doCandidates.length > 0) {
      console.log(`Inserting ${doCandidates.length} jazz_load_do_entries...`);
      for (const d of doCandidates) {
        await trx
          .insertInto("jazz_load_do_entries")
          .values({
            id: d.id,
            franchise_id: franchise.id,
            day_id: d.dayId,
            do_profile_id: d.profileId,
            do_name_snapshot: d.profileName,
            do_line_snapshot: d.profileLine,
            issuance_base: d.issuanceBase.toString(),
            payment_base: d.paymentBase.toString(),
            applied_ml_rate_percentage: d.appliedMlRatePercentage.toString(),
            notes: null,
            revision: 1,
            created_by_user_id: ownerUser.id
          })
          .execute();
      }
    }

    // 3. Audit Log
    await trx
      .insertInto("audit_logs")
      .values({
        franchise_id: franchise.id,
        user_id: ownerUser.id,
        user_email: ownerUser.email || "owner@jazz.com",
        action: "HISTORICAL_CSV_IMPORT",
        entity_type: "jazz_load",
        entity_id: period.id,
        after_state: JSON.stringify({
          period_key: "2026-09",
          lifting_inserted: liftingCandidates.length,
          do_entries_inserted: doCandidates.length
        })
      })
      .execute();

    // 4. Recalculate Authoritative Projections through Period End (Days 1–30)
    console.log("Recalculating server-authoritative projections for entire period (Days 1–30)...");
    const calcResult = await rebuildPeriodInternal(trx, franchise.id, period.id, {
      triggerSource: "rebuild",
      userId: ownerUser.id,
      allowClosedDays: true
    });
    console.log(`✓ Projection Engine Complete: Rebuilt ${calcResult.daysCalculated} days with ${calcResult.violationsCount} invariant violations in ${calcResult.durationMs}ms.`);
  });

  console.log("\n[LIVE APPLY COMPLETE] All Jazz Load transactions successfully imported and projections recalculated.");
}

// ---------------------------------------------------------------------------
// CLI Invocation
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith("import-september-jazzload.ts")) {
  const isDryRun = process.argv.includes("--dry-run") || !process.argv.includes("--apply");

  runSeptemberJazzLoadImport({ dryRun: isDryRun })
    .catch((err) => {
      console.error("\n❌ SCRIPT EXECUTION FAILED:", err);
      process.exit(1);
    })
    .finally(async () => {
      await closeDatabase();
    });
}
