#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const CALC_VERSION = 2;

function parseArgs(argv) {
  const args = {
    mode: "dry-run",
    month: "",
    project: "",
    account: "",
    outputReport: "",
    backupFile: "",
    apply: false,
    confirmApplyV2: false
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--month") {
      args.month = next ?? "";
      i += 1;
    } else if (arg === "--project") {
      args.project = next ?? "";
      i += 1;
    } else if (arg === "--account") {
      args.account = next ?? "";
      i += 1;
    } else if (arg === "--output-report") {
      args.outputReport = next ?? "";
      i += 1;
    } else if (arg === "--backup-file") {
      args.backupFile = next ?? "";
      i += 1;
    } else if (arg === "--dry-run") {
      args.mode = "dry-run";
      args.apply = false;
    } else if (arg === "--apply") {
      args.mode = "apply";
      args.apply = true;
    } else if (arg === "--confirm-apply-v2") {
      args.confirmApplyV2 = true;
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
  node scripts/ledger-v2-migration.mjs --month 2026-05 --dry-run --output-report tmp/report.json --backup-file tmp/backup.json

Safe defaults:
  --dry-run reads Firestore and writes local report/backup files only.
  --apply writes only ledgerV2 paths and requires --confirm-apply-v2.

Options:
  --month YYYY-MM
  --project firebase-project-id
  --account firebase-cli-account-email
  --output-report path
  --backup-file path
  --dry-run
  --apply --confirm-apply-v2`);
}

function loadFirebaseTools(modulePath) {
  const attempts = [
    () => require(`firebase-tools/lib/${modulePath}`),
    () => {
      const prefix = dirname(dirname(process.execPath));
      return require(join(prefix, "lib/node_modules/firebase-tools/lib", modulePath));
    },
    () => {
      const root = process.env.FIREBASE_TOOLS_ROOT;
      if (!root) throw new Error("FIREBASE_TOOLS_ROOT is not set.");
      return require(join(root, "lib", modulePath));
    }
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new Error(`Could not load firebase-tools internal module ${modulePath}. Install firebase-tools or set FIREBASE_TOOLS_ROOT. ${errors.join(" | ")}`);
}

function readDefaultProject() {
  const rcPath = resolve(process.cwd(), ".firebaserc");
  if (!existsSync(rcPath)) return "";
  const parsed = JSON.parse(readFileSync(rcPath, "utf8"));
  return parsed.projects?.default ?? "";
}

function decodeValue(value) {
  if (!value || typeof value !== "object") return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("nullValue" in value) return null;
  if ("timestampValue" in value) return value.timestampValue;
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  return undefined;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") return { mapValue: { fields: encodeFields(value) } };
  return { nullValue: null };
}

function encodeFields(data) {
  return Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, encodeValue(value)])
  );
}

function parseLedgerAmount(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function partyKey(row) {
  const partyId = String(row.partyId ?? "").trim();
  if (partyId) return `id:${partyId}`;
  return `name:${String(row.partyName ?? "").trim().toLowerCase()}`;
}

function rawMovement(row) {
  return {
    loan: parseLedgerAmount(row.loan ?? row.today),
    receive: parseLedgerAmount(row.receive),
    manualAdjustment: parseLedgerAmount(row.manualAdjustment)
  };
}

function closing(row) {
  for (const key of ["closingBalance", "balance", "calculatedBalance", "holdingBalance"]) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== "") {
      return parseLedgerAmount(row[key]);
    }
  }
  const movement = rawMovement(row);
  const opening = parseLedgerAmount(row.opening);
  if (opening === null || movement.loan === null || movement.receive === null || movement.manualAdjustment === null) return null;
  return opening + movement.loan - movement.receive + movement.manualAdjustment;
}

function rowsDiffer(left, right) {
  const l = rawMovement(left);
  const r = rawMovement(right);
  return (
    l.loan !== r.loan ||
    l.receive !== r.receive ||
    l.manualAdjustment !== r.manualAdjustment ||
    parseLedgerAmount(left.opening) !== parseLedgerAmount(right.opening) ||
    closing(left) !== closing(right)
  );
}

function sourceScore(row) {
  const movement = rawMovement(row);
  let score = 0;
  if (row.partyId) score += 2;
  if (row.partyName) score += 1;
  if (movement.loan) score += 3;
  if (movement.receive) score += 3;
  if (movement.manualAdjustment) score += 2;
  if (parseLedgerAmount(row.opening)) score += 1;
  if (closing(row)) score += 1;
  if (typeof row.updatedAt === "number") score += 1;
  return score;
}

function normalizeDay(monthId, dayNo, embeddedCredits, subcollectionCredits, timestamp) {
  const rows = new Map();
  const conflicts = [];
  const add = (row, source) => {
    const key = partyKey(row);
    if (key === "name:") return;
    const existing = rows.get(key);
    if (existing && rowsDiffer(existing.row, row)) {
      conflicts.push({
        dayNo,
        partyKey: key,
        type: "embedded-subcollection-mismatch",
        message: `Embedded and subcollection credit rows disagree for ${key} on day ${dayNo}`
      });
    }
    if (!existing || sourceScore(row) > sourceScore(existing.row)) {
      rows.set(key, { row, source });
    }
  };
  (Array.isArray(embeddedCredits) ? embeddedCredits : []).forEach((row) => add(row, "embedded"));
  (Array.isArray(subcollectionCredits) ? subcollectionCredits : []).forEach((row) => add(row, "subcollection"));

  const seedOpenings = new Map();
  const rawEntries = [...rows.entries()].map(([key, { row, source }]) => {
    const opening = parseLedgerAmount(row.opening) ?? 0;
    const movement = rawMovement(row);
    const explicitClosing = closing(row);
    const hasMovement = Boolean(movement.loan || movement.receive || movement.manualAdjustment);
    const inferredFromLegacy = !hasMovement && explicitClosing !== null && explicitClosing !== opening;
    const partyName = String(row.partyName ?? row.partyNameSnapshot ?? "Unknown party").trim();
    const partyId = String(row.partyId ?? partyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")).trim();
    seedOpenings.set(key, { partyId, partyName, opening });
    return {
      id: String(row.id ?? `${dayNo}-credit-${partyId}`),
      monthId,
      dayNo,
      raw: {
        partyId,
        partyNameSnapshot: partyName,
        loan: movement.loan ?? 0,
        receive: movement.receive ?? 0,
        manualAdjustment: inferredFromLegacy ? explicitClosing - opening : movement.manualAdjustment ?? 0,
        source: "migration",
        inferredFromLegacy,
        legacyOpeningSeed: opening,
        legacySourcePath:
          source === "embedded"
            ? `months/${monthId}/days/${dayNo}.credits`
            : `months/${monthId}/days/${dayNo}/credits/${row.id ?? partyId}`
      },
      meta: {
        updatedAt: typeof row.updatedAt === "number" ? row.updatedAt : timestamp,
        updatedBy: "migration-dry-run",
        revision: 1
      }
    };
  });
  return { dayNo, rawEntries, seedOpenings, conflicts };
}

function projectDays(monthId, normalizedDays, calcRunId, timestamp) {
  const running = new Map();
  return normalizedDays.sort((a, b) => a.dayNo - b.dayNo).map((day) => {
    for (const [key, seed] of day.seedOpenings) {
      if (!running.has(key) && seed.opening !== 0) running.set(key, { ...seed, closing: seed.opening, previousDayNo: day.dayNo - 1 });
    }
    const rawByKey = new Map(day.rawEntries.map((entry) => [partyKey({ partyId: entry.raw.partyId, partyName: entry.raw.partyNameSnapshot }), entry]));
    const keys = new Set([...running.keys(), ...rawByKey.keys()]);
    const projections = [];
    for (const key of keys) {
      const raw = rawByKey.get(key);
      const previous = running.get(key);
      const partyId = raw?.raw.partyId ?? previous?.partyId ?? key.replace(/^(id|name):/, "");
      const partyName = raw?.raw.partyNameSnapshot ?? previous?.partyName ?? partyId;
      const opening = previous?.closing ?? raw?.raw.legacyOpeningSeed ?? 0;
      const loan = raw?.raw.loan ?? 0;
      const receive = raw?.raw.receive ?? 0;
      const manualAdjustment = raw?.raw.manualAdjustment ?? 0;
      const delta = loan - receive + manualAdjustment;
      const nextClosing = opening + delta;
      if (nextClosing === 0 && !raw) {
        running.delete(key);
        continue;
      }
      const id = `${day.dayNo}-credit-balance-${partyId}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
      projections.push({
        id,
        partyId,
        partyName,
        rawEntryId: raw?.id,
        dayNo: day.dayNo,
        calculated: {
          opening,
          loan,
          receive,
          manualAdjustment,
          delta,
          closing: nextClosing,
          calculatedFromDay: day.dayNo
        },
        meta: {
          calculatedAt: timestamp,
          calculationVersion: CALC_VERSION,
          calcRunId,
          rowHash: [day.dayNo, partyId, opening, loan, receive, manualAdjustment, nextClosing].join("|")
        }
      });
      if (nextClosing === 0) running.delete(key);
      else running.set(key, { partyId, partyName, closing: nextClosing, previousDayNo: day.dayNo });
    }
    return { ...day, projections };
  });
}

function checkInvariants(monthId, projectedDays) {
  const issues = [];
  const previous = new Map();
  for (const day of projectedDays) {
    for (const row of day.projections) {
      const key = partyKey(row);
      const expectedClosing = row.calculated.opening + row.calculated.loan - row.calculated.receive + row.calculated.manualAdjustment;
      if (expectedClosing !== row.calculated.closing) {
        issues.push({ type: "CLOSING_FORMULA_MISMATCH", monthId, dayNo: day.dayNo, partyId: row.partyId, expected: expectedClosing, actual: row.calculated.closing });
      }
      const prev = previous.get(key);
      if (prev && row.calculated.opening !== prev.closing) {
        issues.push({ type: "DAY_OPENING_MISMATCH", monthId, dayNo: day.dayNo, partyId: row.partyId, expected: prev.closing, actual: row.calculated.opening });
      }
      previous.set(key, { closing: row.calculated.closing, dayNo: day.dayNo });
    }
  }
  return issues;
}

class FirestoreRest {
  constructor(projectId, client) {
    this.projectId = projectId;
    this.client = client;
    this.base = `/v1/projects/${projectId}/databases/(default)/documents`;
  }

  fullName(path) {
    return `projects/${this.projectId}/databases/(default)/documents/${path}`;
  }

  async getDoc(path) {
    try {
      const res = await this.client.get(`${this.base}/${path}`);
      return { id: path.split("/").at(-1), path, data: decodeFields(res.body.fields ?? {}), raw: res.body };
    } catch (err) {
      if (String(err?.message ?? "").includes("NOT_FOUND") || String(err?.status ?? "") === "404") return null;
      throw err;
    }
  }

  async listDocs(collectionPath) {
    const docs = [];
    let pageToken = "";
    do {
      const suffix = pageToken ? `?pageSize=300&pageToken=${encodeURIComponent(pageToken)}` : "?pageSize=300";
      const res = await this.client.get(`${this.base}/${collectionPath}${suffix}`);
      for (const doc of res.body.documents ?? []) {
        const name = doc.name;
        const path = name.split("/documents/")[1];
        docs.push({ id: path.split("/").at(-1), path, data: decodeFields(doc.fields ?? {}), raw: doc });
      }
      pageToken = res.body.nextPageToken ?? "";
    } while (pageToken);
    return docs;
  }

  async commit(updates) {
    const writes = updates.map(({ path, data }) => ({
      update: {
        name: this.fullName(path),
        fields: encodeFields(data)
      }
    }));
    for (let index = 0; index < writes.length; index += 400) {
      await this.client.post(`/v1/projects/${this.projectId}/databases/(default)/documents:commit`, {
        writes: writes.slice(index, index + 400)
      });
    }
  }
}

async function readMonthForAudit(rest, monthId) {
  const [monthDoc, dayDocs, summaryDocs, auditDocs] = await Promise.all([
    rest.getDoc(`months/${monthId}`),
    rest.listDocs(`months/${monthId}/days`),
    rest.listDocs(`months/${monthId}/summary`).catch(() => []),
    rest.listDocs(`months/${monthId}/audit`).catch(() => [])
  ]);
  const days = [];
  for (const day of dayDocs) {
    const [expenses, commissions, credits, ownerBalances] = await Promise.all([
      rest.listDocs(`${day.path}/expenses`).catch(() => []),
      rest.listDocs(`${day.path}/commissions`).catch(() => []),
      rest.listDocs(`${day.path}/credits`).catch(() => []),
      rest.listDocs(`${day.path}/ownerBalances`).catch(() => [])
    ]);
    days.push({
      ...day,
      subcollections: {
        expenses,
        commissions,
        credits,
        ownerBalances
      }
    });
  }
  return { month: monthDoc, days: days.sort((a, b) => Number(a.id) - Number(b.id)), summaryDocs, auditDocs };
}

function proposedWrites(monthId, projectedDays, calcRunId, timestamp) {
  const writes = [
    {
      path: `ledgerV2/expense/months/${monthId}`,
      data: {
        id: monthId,
        module: "expense",
        status: "open",
        calculationVersion: CALC_VERSION,
        calcRunId,
        updatedAt: timestamp
      }
    }
  ];
  for (const day of projectedDays) {
    writes.push({
      path: `ledgerV2/expense/months/${monthId}/days/${day.dayNo}`,
      data: {
        dayNo: day.dayNo,
        module: "expense",
        calculationVersion: CALC_VERSION,
        calcRunId,
        recalculatedAt: timestamp,
        creditClosingTotal: day.projections.reduce((sum, row) => sum + row.calculated.closing, 0),
        creditNonZeroCount: day.projections.filter((row) => row.calculated.closing !== 0).length
      }
    });
    for (const raw of day.rawEntries) {
      writes.push({ path: `ledgerV2/expense/months/${monthId}/days/${day.dayNo}/rawEntries/${raw.id}`, data: raw });
    }
    for (const projection of day.projections) {
      writes.push({ path: `ledgerV2/expense/months/${monthId}/days/${day.dayNo}/projections/${projection.id}`, data: projection });
    }
  }
  return writes;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.month) throw new Error("--month is required.");
  if (args.apply && !args.confirmApplyV2) throw new Error("--apply requires --confirm-apply-v2 and writes only ledgerV2 paths.");

  const projectId = args.project || readDefaultProject();
  if (!projectId) throw new Error("Project id is required. Pass --project or configure .firebaserc.");

  const auth = loadFirebaseTools("auth");
  const { requireAuth } = loadFirebaseTools("requireAuth");
  const apiv2 = loadFirebaseTools("apiv2");
  const options = { project: projectId, projectRoot: process.cwd() };
  const selectedAccount = auth.selectAccount(args.account || undefined, process.cwd());
  if (selectedAccount) auth.setActiveAccount(options, selectedAccount);
  await requireAuth(options);

  const rest = new FirestoreRest(projectId, new apiv2.Client({ urlPrefix: "https://firestore.googleapis.com", auth: true }));
  const timestamp = Date.now();
  const calcRunId = `migration-${args.month}-${timestamp}`;
  const backup = await readMonthForAudit(rest, args.month);

  if (args.backupFile) {
    mkdirSync(dirname(resolve(args.backupFile)), { recursive: true });
    writeFileSync(resolve(args.backupFile), JSON.stringify({ exportedAt: timestamp, projectId, monthId: args.month, expense: backup }, null, 2));
  }

  const normalizedDays = backup.days.map((day) =>
    normalizeDay(
      args.month,
      Number(day.data.dayNo ?? day.id),
      day.data.credits,
      day.subcollections.credits.map((doc) => ({ id: doc.id, ...doc.data })),
      timestamp
    )
  );
  const projectedDays = projectDays(args.month, normalizedDays, calcRunId, timestamp);
  const invariants = checkInvariants(args.month, projectedDays);
  const conflicts = normalizedDays.flatMap((day) => day.conflicts);
  const writes = proposedWrites(args.month, projectedDays, calcRunId, timestamp);
  const presentDays = new Set(backup.days.map((day) => Number(day.data.dayNo ?? day.id)));
  const missingDays = Array.from({ length: 31 }, (_, index) => index + 1).filter((dayNo) => !presentDays.has(dayNo));
  const emptyCreditDays = backup.days
    .filter((day) => !Array.isArray(day.data.credits) || day.data.credits.length === 0)
    .filter((day) => day.subcollections.credits.length === 0)
    .map((day) => Number(day.data.dayNo ?? day.id));

  if (args.apply) {
    await rest.commit(writes);
  }

  const report = {
    generatedAt: timestamp,
    projectId,
    monthId: args.month,
    mode: args.apply ? "apply" : "dry-run",
    calcVersion: CALC_VERSION,
    calcRunId,
    daysChecked: backup.days.length,
    missingDays,
    emptyCreditDays,
    conflicts,
    invariantFailures: invariants,
    proposedWrites: writes.map((write) => ({ path: write.path, data: write.data })),
    rowsWritten: args.apply ? writes.length : 0,
    backupFile: args.backupFile || null
  };

  if (args.outputReport) {
    mkdirSync(dirname(resolve(args.outputReport)), { recursive: true });
    writeFileSync(resolve(args.outputReport), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({
    monthId: report.monthId,
    mode: report.mode,
    daysChecked: report.daysChecked,
    missingDays: report.missingDays,
    conflicts: report.conflicts.length,
    invariantFailures: report.invariantFailures.length,
    proposedWrites: report.proposedWrites.length,
    rowsWritten: report.rowsWritten,
    outputReport: args.outputReport || null,
    backupFile: args.backupFile || null
  }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
