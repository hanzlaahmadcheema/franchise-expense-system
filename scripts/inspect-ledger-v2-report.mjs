#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function parseArgs(argv) {
  const args = {
    report: "tmp/ledger-v2-2026-05-report.json",
    backup: "tmp/ledger-v2-2026-05-backup.json",
    output: "",
    party: "Usman Cheema",
    month: "2026-05",
    strict: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--report") {
      args.report = next ?? "";
      i += 1;
    } else if (arg === "--backup") {
      args.backup = next ?? "";
      i += 1;
    } else if (arg === "--output") {
      args.output = next ?? "";
      i += 1;
    } else if (arg === "--party") {
      args.party = next ?? "";
      i += 1;
    } else if (arg === "--month") {
      args.month = next ?? "";
      i += 1;
    } else if (arg === "--strict") {
      args.strict = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/inspect-ledger-v2-report.mjs --report tmp/ledger-v2-2026-05-report.json --backup tmp/ledger-v2-2026-05-backup.json --output tmp/ledger-v2-2026-05-inspection.json --strict

Reads local dry-run artifacts only. It does not access Firestore.`);
}

function readJson(path) {
  const resolved = resolve(path);
  if (!existsSync(resolved)) throw new Error(`Missing file: ${path}`);
  return JSON.parse(readFileSync(resolved, "utf8"));
}

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase();
}

function pathForDay(path, dayNo) {
  return path.includes(`/days/${dayNo}/`);
}

function projectionRows(report, dayNo) {
  return (report.proposedWrites ?? [])
    .filter((write) => pathForDay(String(write.path ?? ""), dayNo) && String(write.path ?? "").includes("/projections/"))
    .map((write) => write.data)
    .sort((a, b) => String(a.partyName ?? "").localeCompare(String(b.partyName ?? "")));
}

function rawRows(report, dayNo) {
  return (report.proposedWrites ?? [])
    .filter((write) => pathForDay(String(write.path ?? ""), dayNo) && String(write.path ?? "").includes("/rawEntries/"))
    .map((write) => write.data)
    .sort((a, b) => String(a.raw?.partyNameSnapshot ?? "").localeCompare(String(b.raw?.partyNameSnapshot ?? "")));
}

function findParty(rows, partyName) {
  const wanted = normalizeName(partyName);
  return rows.find((row) =>
    normalizeName(row.partyName).includes(wanted) ||
    normalizeName(row.raw?.partyNameSnapshot).includes(wanted)
  ) ?? null;
}

function summarizeDay(report, dayNo, partyName) {
  const projections = projectionRows(report, dayNo);
  const raw = rawRows(report, dayNo);
  const targetProjection = findParty(projections, partyName);
  const targetRaw = findParty(raw, partyName);
  return {
    dayNo,
    projectionCount: projections.length,
    rawEntryCount: raw.length,
    nonZeroProjectionCount: projections.filter((row) => Number(row.calculated?.closing ?? 0) !== 0).length,
    targetProjection,
    targetRaw,
    closingTotal: projections.reduce((sum, row) => sum + Number(row.calculated?.closing ?? 0), 0)
  };
}

function inspectBackup(backup) {
  const days = backup.expense?.days ?? [];
  return [28, 29, 30, 31].map((dayNo) => {
    const day = days.find((item) => Number(item.data?.dayNo ?? item.id) === dayNo);
    const embeddedCredits = Array.isArray(day?.data?.credits) ? day.data.credits.length : 0;
    const subcollectionCredits = Array.isArray(day?.subcollections?.credits) ? day.subcollections.credits.length : 0;
    return {
      dayNo,
      exists: Boolean(day),
      embeddedCredits,
      subcollectionCredits
    };
  });
}

function buildInspection(report, backup, args) {
  const daySummaries = [28, 29, 30, 31].map((dayNo) => summarizeDay(report, dayNo, args.party));
  const day28 = daySummaries.find((day) => day.dayNo === 28);
  const day29 = daySummaries.find((day) => day.dayNo === 29);
  const day30 = daySummaries.find((day) => day.dayNo === 30);
  const day31 = daySummaries.find((day) => day.dayNo === 31);
  const day30Projection = day30?.targetProjection;
  const day30Raw = day30?.targetRaw;
  const checks = [
    {
      id: "dry-run-mode",
      passed: report.mode === "dry-run" && Number(report.rowsWritten ?? -1) === 0,
      detail: `mode=${report.mode}, rowsWritten=${report.rowsWritten}`
    },
    {
      id: "backup-created",
      passed: Boolean(report.backupFile) && existsSync(resolve(args.backup)),
      detail: `backupFile=${report.backupFile ?? ""}`
    },
    {
      id: "day-29-rebuilt-from-day-28",
      passed: Boolean(day28?.targetProjection && day29?.targetProjection) &&
        Number(day29?.targetProjection?.calculated?.opening ?? Number.NaN) === Number(day28?.targetProjection?.calculated?.closing ?? Number.NaN),
      detail: `day28Closing=${day28?.targetProjection?.calculated?.closing ?? null}, day29Opening=${day29?.targetProjection?.calculated?.opening ?? null}`
    },
    {
      id: "day-30-loan-preserved",
      passed: Number(day30Raw?.raw?.loan ?? Number.NaN) === 9000 ||
        Number(day30Projection?.calculated?.loan ?? Number.NaN) === 9000,
      detail: `rawLoan=${day30Raw?.raw?.loan ?? null}, projectedLoan=${day30Projection?.calculated?.loan ?? null}`
    },
    {
      id: "day-30-opening-2000",
      passed: Number(day30Projection?.calculated?.opening ?? Number.NaN) === 2000,
      detail: `day30Opening=${day30Projection?.calculated?.opening ?? null}`
    },
    {
      id: "day-30-closing-11000",
      passed: Number(day30Projection?.calculated?.closing ?? Number.NaN) === 11000,
      detail: `day30Closing=${day30Projection?.calculated?.closing ?? null}`
    },
    {
      id: "day-31-carries-day-30",
      passed: Boolean(day30Projection && day31?.targetProjection) &&
        Number(day31?.targetProjection?.calculated?.opening ?? Number.NaN) === Number(day30Projection?.calculated?.closing ?? Number.NaN),
      detail: `day30Closing=${day30Projection?.calculated?.closing ?? null}, day31Opening=${day31?.targetProjection?.calculated?.opening ?? null}`
    }
  ];

  return {
    inspectedAt: Date.now(),
    monthId: args.month,
    reportPath: args.report,
    backupPath: args.backup,
    party: args.party,
    dryRun: {
      mode: report.mode,
      rowsWritten: report.rowsWritten,
      proposedWrites: Array.isArray(report.proposedWrites) ? report.proposedWrites.length : 0,
      conflicts: Array.isArray(report.conflicts) ? report.conflicts.length : 0,
      invariantFailures: Array.isArray(report.invariantFailures) ? report.invariantFailures.length : 0,
      missingDays: report.missingDays ?? [],
      emptyCreditDays: report.emptyCreditDays ?? []
    },
    backup: {
      exportedAt: backup.exportedAt,
      projectId: backup.projectId,
      days28To31: inspectBackup(backup)
    },
    days28To31: daySummaries,
    checks,
    passed: checks.every((check) => check.passed)
  };
}

function main() {
  const args = parseArgs(process.argv);
  const report = readJson(args.report);
  const backup = readJson(args.backup);
  const inspection = buildInspection(report, backup, args);

  if (args.output) {
    mkdirSync(dirname(resolve(args.output)), { recursive: true });
    writeFileSync(resolve(args.output), JSON.stringify(inspection, null, 2));
  }

  console.log(JSON.stringify({
    monthId: inspection.monthId,
    party: inspection.party,
    passed: inspection.passed,
    checks: inspection.checks,
    output: args.output || null
  }, null, 2));

  if (args.strict && !inspection.passed) {
    process.exitCode = 1;
  }
}

main();
