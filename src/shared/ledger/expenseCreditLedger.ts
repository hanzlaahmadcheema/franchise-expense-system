import type { CreditRow } from "../../types/ledger";
import {
  LEDGER_CALC_VERSION,
  type LedgerEntrySource,
  type LedgerInvariantIssue
} from "./ledgerTypes";

type LegacyCreditInput = Partial<CreditRow> & Record<string, unknown>;

export type ExpenseCreditRaw = {
  partyId: string;
  partyNameSnapshot: string;
  loan: number;
  receive: number;
  manualAdjustment: number;
  notes?: string;
  loanDescription?: string;
  receiveDescription?: string;
  source: LedgerEntrySource;
  inferredFromLegacy?: boolean;
  legacyOpeningSeed?: number;
  legacySourcePath?: string;
};

export type ExpenseCreditRawEntry = {
  id: string;
  monthId: string;
  dayNo: number;
  raw: ExpenseCreditRaw;
  meta: {
    updatedAt: number;
    updatedBy: string;
    revision?: number;
    createdAt?: number | string;
  };
  createdAt?: number | string;
  updatedAt?: number | string;
};

export type ExpenseCreditProjection = {
  id: string;
  partyId: string;
  partyName: string;
  rawEntryId?: string;
  dayNo: number;
  calculated: {
    opening: number;
    loan: number;
    receive: number;
    manualAdjustment: number;
    delta: number;
    closing: number;
    calculatedFromDay: number;
    previousDayRef?: string;
  };
  meta: {
    calculatedAt: number;
    calculationVersion: number;
    calcRunId: string;
    rowHash: string;
  };
};

export type ExpenseCreditProjectedDay = {
  dayNo: number;
  rawEntries: ExpenseCreditRawEntry[];
  projections: ExpenseCreditProjection[];
  summary: {
    opening: number;
    loan: number;
    receive: number;
    manualAdjustment: number;
    delta: number;
    closing: number;
  };
};

export type LegacyCreditConflict = {
  dayNo: number;
  partyKey: string;
  type: "embedded-subcollection-mismatch" | "duplicate-party-row" | "invalid-raw-value";
  embedded?: LegacyCreditInput;
  subcollection?: LegacyCreditInput;
  message: string;
};

export type NormalizedExpenseCreditDay = {
  dayNo: number;
  rawEntries: ExpenseCreditRawEntry[];
  seedOpenings: Map<string, { partyId: string; partyName: string; opening: number }>;
  conflicts: LegacyCreditConflict[];
};

export type ProjectExpenseCreditMonthInput = {
  monthId: string;
  days: Array<{
    dayNo: number;
    rawEntries: ExpenseCreditRawEntry[];
    seedOpenings?: Map<string, { partyId: string; partyName: string; opening: number }>;
  }>;
  calcRunId: string;
  calculatedAt?: number;
};

type RawEntryChoice = {
  entry: ExpenseCreditRawEntry;
  originalIndex: number;
};

function normalizeName(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown) {
  return normalizeName(value).toLowerCase();
}

export function creditPartyKey(input: { partyId?: unknown; partyName?: unknown; partyNameSnapshot?: unknown }) {
  const partyId = normalizeName(input.partyId);
  if (partyId) return `id:${partyId}`;
  return `name:${normalizeKey(input.partyNameSnapshot ?? input.partyName)}`;
}

export function parseLedgerAmountStrict(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }
  return null;
}

function amount(value: unknown) {
  return parseLedgerAmountStrict(value) ?? 0;
}

function normalizedAmount(value: unknown): number | null {
  return parseLedgerAmountStrict(value);
}

function rawEntryIdentity(input: ExpenseCreditRawEntry, fallback: { monthId: string; dayNo: number }) {
  const loan = normalizedAmount(input.raw.loan);
  const receive = normalizedAmount(input.raw.receive);
  const manualAdjustment = normalizedAmount(input.raw.manualAdjustment);
  const partyId = normalizeKey(input.raw.partyId);
  const partyName = normalizeKey(input.raw.partyNameSnapshot);
  const partyKey = partyId ? `id:${partyId}` : partyName ? `name:${partyName}` : "";
  if (!partyKey || loan === null || receive === null || manualAdjustment === null) return null;
  return [
    input.monthId || fallback.monthId,
    input.dayNo || fallback.dayNo,
    partyKey,
    loan,
    receive,
    manualAdjustment
  ].join("|");
}

function rawEntryHasMigrationProvenance(entry: ExpenseCreditRawEntry) {
  return (
    entry.raw.source === "migration" ||
    "legacyOpeningSeed" in entry.raw ||
    Boolean(entry.raw.legacySourcePath) ||
    Boolean(entry.raw.inferredFromLegacy)
  );
}

function timestampValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function rawEntryRecency(entry: ExpenseCreditRawEntry) {
  return Math.max(
    timestampValue(entry.meta?.updatedAt),
    timestampValue(entry.updatedAt),
    timestampValue(entry.meta?.createdAt),
    timestampValue(entry.createdAt)
  );
}

function chooseRawEntry(left: RawEntryChoice, right: RawEntryChoice) {
  const leftMigration = rawEntryHasMigrationProvenance(left.entry);
  const rightMigration = rawEntryHasMigrationProvenance(right.entry);
  if (leftMigration !== rightMigration) return leftMigration ? left : right;

  const leftRecency = rawEntryRecency(left.entry);
  const rightRecency = rawEntryRecency(right.entry);
  if (leftRecency !== rightRecency) return leftRecency > rightRecency ? left : right;

  return left.originalIndex > right.originalIndex ? left : right;
}

export function dedupeExpenseCreditRawEntries(
  rawEntries: ExpenseCreditRawEntry[],
  fallback: { monthId: string; dayNo: number }
) {
  const grouped = new Map<string, RawEntryChoice>();
  const passThrough: RawEntryChoice[] = [];

  rawEntries.forEach((entry, originalIndex) => {
    const identity = rawEntryIdentity(entry, fallback);
    const choice = { entry, originalIndex };
    if (!identity) {
      passThrough.push(choice);
      return;
    }
    const existing = grouped.get(identity);
    grouped.set(identity, existing ? chooseRawEntry(existing, choice) : choice);
  });

  return [...grouped.values(), ...passThrough]
    .sort((a, b) => a.originalIndex - b.originalIndex)
    .map((choice) => choice.entry);
}

function explicitClosing(row: LegacyCreditInput): number | null {
  for (const key of ["closingBalance", "balance", "calculatedBalance", "holdingBalance"]) {
    const value = parseLedgerAmountStrict(row[key]);
    if (value !== null && row[key] !== undefined && row[key] !== null && row[key] !== "") return value;
  }
  return null;
}

function rowManualActivity(row: LegacyCreditInput) {
  const loan = parseLedgerAmountStrict(row.loan ?? row.today);
  const receive = parseLedgerAmountStrict(row.receive);
  const manualAdjustment = parseLedgerAmountStrict(row.manualAdjustment);
  const invalid = loan === null || receive === null || manualAdjustment === null;
  return {
    loan: loan ?? 0,
    receive: receive ?? 0,
    manualAdjustment: manualAdjustment ?? 0,
    invalid
  };
}

function rowDescriptions(row: LegacyCreditInput, manual: ReturnType<typeof rowManualActivity>) {
  const hasCanonicalDescription =
    row.loanDescription !== undefined || row.receiveDescription !== undefined;
  const legacyDescription = normalizeName(row.description ?? row.notes);
  if (!hasCanonicalDescription && legacyDescription) {
    if (manual.loan !== 0 && manual.receive === 0) {
      return { loanDescription: legacyDescription, receiveDescription: undefined };
    }
    if (manual.receive !== 0 && manual.loan === 0) {
      return { loanDescription: undefined, receiveDescription: legacyDescription };
    }
  }
  return {
    loanDescription: normalizeName(row.loanDescription) || undefined,
    receiveDescription: normalizeName(row.receiveDescription) || undefined
  };
}

function sourceScore(row: LegacyCreditInput) {
  const manual = rowManualActivity(row);
  const opening = parseLedgerAmountStrict(row.opening);
  const closing = explicitClosing(row);
  let score = 0;
  if (normalizeName(row.partyId)) score += 2;
  if (normalizeName(row.partyName)) score += 1;
  if (manual.loan !== 0) score += 3;
  if (manual.receive !== 0) score += 3;
  if (manual.manualAdjustment !== 0) score += 2;
  if (opening !== null && opening !== 0) score += 1;
  if (closing !== null && closing !== 0) score += 1;
  if (typeof row.updatedAt === "number") score += 1;
  return score;
}

function hasRawDifference(left: LegacyCreditInput, right: LegacyCreditInput) {
  const leftManual = rowManualActivity(left);
  const rightManual = rowManualActivity(right);
  return (
    leftManual.loan !== rightManual.loan ||
    leftManual.receive !== rightManual.receive ||
    leftManual.manualAdjustment !== rightManual.manualAdjustment ||
    amount(left.opening) !== amount(right.opening) ||
    (explicitClosing(left) ?? amount(left.opening) + leftManual.loan - leftManual.receive + leftManual.manualAdjustment) !==
      (explicitClosing(right) ?? amount(right.opening) + rightManual.loan - rightManual.receive + rightManual.manualAdjustment)
  );
}

function rowToRawEntry(input: {
  monthId: string;
  dayNo: number;
  row: LegacyCreditInput;
  sourcePath: string;
  source: LedgerEntrySource;
  actorUid: string;
  timestamp: number;
}) {
  const partyName = normalizeName(input.row.partyName) || normalizeName(input.row.partyNameSnapshot) || "Unknown party";
  const partyId = normalizeName(input.row.partyId) || partyName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const manual = rowManualActivity(input.row);
  const opening = parseLedgerAmountStrict(input.row.opening) ?? 0;
  const closing = explicitClosing(input.row);
  const hasManualActivity = manual.loan !== 0 || manual.receive !== 0 || manual.manualAdjustment !== 0;
  const inferredFromLegacy = !hasManualActivity && closing !== null && closing !== opening;
  const manualAdjustment = inferredFromLegacy ? closing - opening : manual.manualAdjustment;
  const rowId = normalizeName(input.row.id) || `${input.dayNo}-credit-${partyId}`;
  const descriptions = rowDescriptions(input.row, manual);

  return {
    id: rowId,
    monthId: input.monthId,
    dayNo: input.dayNo,
    raw: {
      partyId,
      partyNameSnapshot: partyName,
      loan: manual.loan,
      receive: manual.receive,
      manualAdjustment,
      notes: normalizeName(input.row.description) || normalizeName(input.row.notes) || undefined,
      loanDescription: descriptions.loanDescription,
      receiveDescription: descriptions.receiveDescription,
      source: input.source,
      inferredFromLegacy,
      legacyOpeningSeed: opening,
      legacySourcePath: input.sourcePath
    },
    meta: {
      updatedAt: typeof input.row.updatedAt === "number" ? input.row.updatedAt : input.timestamp,
      updatedBy: input.actorUid,
      revision: 1
    }
  } satisfies ExpenseCreditRawEntry;
}

function safeLegacyRows(rows: unknown): LegacyCreditInput[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is LegacyCreditInput => Boolean(row && typeof row === "object"));
}

export function normalizeLegacyExpenseCreditDay(input: {
  monthId: string;
  dayNo: number;
  embeddedCredits: unknown;
  subcollectionCredits: unknown;
  actorUid: string;
  timestamp?: number;
}): NormalizedExpenseCreditDay {
  const timestamp = input.timestamp ?? Date.now();
  const conflicts: LegacyCreditConflict[] = [];
  const byKey = new Map<string, { row: LegacyCreditInput; sourcePath: string; source: "embedded" | "subcollection" }>();
  const seedOpenings = new Map<string, { partyId: string; partyName: string; opening: number }>();

  const addRow = (row: LegacyCreditInput, source: "embedded" | "subcollection") => {
    const partyKey = creditPartyKey(row);
    if (partyKey === "name:") return;
    const sourcePath =
      source === "embedded"
        ? `months/${input.monthId}/days/${input.dayNo}.credits`
        : `months/${input.monthId}/days/${input.dayNo}/credits/${normalizeName(row.id) || partyKey}`;
    const existing = byKey.get(partyKey);
    const manual = rowManualActivity(row);
    if (manual.invalid) {
      conflicts.push({
        dayNo: input.dayNo,
        partyKey,
        type: "invalid-raw-value",
        message: `Invalid credit amount in ${sourcePath}`
      });
    }
    if (!existing) {
      byKey.set(partyKey, { row, sourcePath, source });
      return;
    }
    if (hasRawDifference(existing.row, row)) {
      conflicts.push({
        dayNo: input.dayNo,
        partyKey,
        type: "embedded-subcollection-mismatch",
        embedded: source === "embedded" ? row : existing.row,
        subcollection: source === "subcollection" ? row : existing.row,
        message: `Embedded and subcollection credit rows disagree for ${partyKey} on day ${input.dayNo}`
      });
    }
    const next = sourceScore(row) > sourceScore(existing.row) ? { row, sourcePath, source } : existing;
    byKey.set(partyKey, next);
  };

  safeLegacyRows(input.embeddedCredits).forEach((row) => addRow(row, "embedded"));
  safeLegacyRows(input.subcollectionCredits).forEach((row) => addRow(row, "subcollection"));

  const rawEntries = [...byKey.entries()].map(([partyKey, chosen]) => {
    const entry = rowToRawEntry({
      monthId: input.monthId,
      dayNo: input.dayNo,
      row: chosen.row,
      sourcePath: chosen.sourcePath,
      source: "migration",
      actorUid: input.actorUid,
      timestamp
    });
    seedOpenings.set(partyKey, {
      partyId: entry.raw.partyId,
      partyName: entry.raw.partyNameSnapshot,
      opening: entry.raw.legacyOpeningSeed ?? 0
    });
    return entry;
  });

  return { dayNo: input.dayNo, rawEntries, seedOpenings, conflicts };
}

function projectionId(dayNo: number, partyId: string) {
  return `${dayNo}-credit-balance-${partyId}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function hashProjection(input: {
  dayNo: number;
  partyId: string;
  opening: number;
  loan: number;
  receive: number;
  manualAdjustment: number;
  closing: number;
}) {
  return [
    input.dayNo,
    input.partyId,
    input.opening,
    input.loan,
    input.receive,
    input.manualAdjustment,
    input.closing
  ].join("|");
}

function summarize(projections: ExpenseCreditProjection[]): ExpenseCreditProjectedDay["summary"] {
  return projections.reduce(
    (acc, row) => ({
      opening: acc.opening + row.calculated.opening,
      loan: acc.loan + row.calculated.loan,
      receive: acc.receive + row.calculated.receive,
      manualAdjustment: acc.manualAdjustment + row.calculated.manualAdjustment,
      delta: acc.delta + row.calculated.delta,
      closing: acc.closing + row.calculated.closing
    }),
    { opening: 0, loan: 0, receive: 0, manualAdjustment: 0, delta: 0, closing: 0 }
  );
}

export function projectExpenseCreditMonth({
  monthId,
  days,
  calcRunId,
  calculatedAt = Date.now()
}: ProjectExpenseCreditMonthInput): ExpenseCreditProjectedDay[] {
  const running = new Map<string, { partyId: string; partyName: string; closing: number; previousDayNo: number }>();
  const sortedDays = [...days].sort((a, b) => a.dayNo - b.dayNo);

  return sortedDays.map((day) => {
    const rawEntries = dedupeExpenseCreditRawEntries(day.rawEntries, { monthId, dayNo: day.dayNo });
    const rawByKey = new Map(rawEntries.map((entry) => [creditPartyKey(entry.raw), entry]));
    for (const [key, seed] of day.seedOpenings?.entries() ?? []) {
      if (!running.has(key) && seed.opening !== 0) {
        running.set(key, { partyId: seed.partyId, partyName: seed.partyName, closing: seed.opening, previousDayNo: day.dayNo - 1 });
      }
    }

    const keys = new Set([...running.keys(), ...rawByKey.keys()]);
    const projections: ExpenseCreditProjection[] = [];
    for (const key of keys) {
      const rawEntry = rawByKey.get(key);
      const previous = running.get(key);
      const partyId = rawEntry?.raw.partyId ?? previous?.partyId ?? key.replace(/^(id|name):/, "");
      const partyName = rawEntry?.raw.partyNameSnapshot ?? previous?.partyName ?? partyId;
      const opening = previous?.closing ?? rawEntry?.raw.legacyOpeningSeed ?? 0;
      const loan = rawEntry?.raw.loan ?? 0;
      const receive = rawEntry?.raw.receive ?? 0;
      const manualAdjustment = rawEntry?.raw.manualAdjustment ?? 0;
      const delta = loan - receive + manualAdjustment;
      const closing = opening + delta;
      if (closing === 0 && !rawEntry) {
        running.delete(key);
        continue;
      }
      const projection: ExpenseCreditProjection = {
        id: projectionId(day.dayNo, partyId),
        partyId,
        partyName,
        rawEntryId: rawEntry?.id,
        dayNo: day.dayNo,
        calculated: {
          opening,
          loan,
          receive,
          manualAdjustment,
          delta,
          closing,
          calculatedFromDay: day.dayNo,
          previousDayRef:
            previous && previous.previousDayNo > 0
              ? `ledgerV2/expense/months/${monthId}/days/${previous.previousDayNo}/projections/${projectionId(previous.previousDayNo, partyId)}`
              : undefined
        },
        meta: {
          calculatedAt,
          calculationVersion: LEDGER_CALC_VERSION,
          calcRunId,
          rowHash: hashProjection({ dayNo: day.dayNo, partyId, opening, loan, receive, manualAdjustment, closing })
        }
      };
      projections.push(projection);
      if (closing === 0) {
        running.delete(key);
      } else {
        running.set(key, { partyId, partyName, closing, previousDayNo: day.dayNo });
      }
    }

    projections.sort((a, b) => a.partyName.localeCompare(b.partyName, undefined, { numeric: true, sensitivity: "base" }));
    return {
      dayNo: day.dayNo,
      rawEntries,
      projections,
      summary: summarize(projections)
    };
  });
}

export function projectionToLegacyCreditRows(day: ExpenseCreditProjectedDay): CreditRow[] {
  const rawById = new Map(day.rawEntries.map((entry) => [entry.id, entry]));
  const rawByParty = new Map(day.rawEntries.map((entry) => [creditPartyKey(entry.raw), entry]));

  return day.projections.map((row) => {
    const rawEntry = (row.rawEntryId ? rawById.get(row.rawEntryId) : undefined) ??
      rawByParty.get(creditPartyKey(row));
    return {
      id: row.rawEntryId ?? `${day.dayNo}-credit-carry-${row.partyId}`,
      partyId: row.partyId,
      partyName: row.partyName,
      ...(rawEntry?.raw.notes !== undefined ? { description: rawEntry.raw.notes } : {}),
      ...(rawEntry?.raw.loanDescription !== undefined ? { loanDescription: rawEntry.raw.loanDescription } : {}),
      ...(rawEntry?.raw.receiveDescription !== undefined ? { receiveDescription: rawEntry.raw.receiveDescription } : {}),
      opening: row.calculated.opening,
      loan: row.calculated.loan,
      today: row.calculated.loan,
      receive: row.calculated.receive,
      balance: row.calculated.closing
    };
  });
}

export function checkExpenseCreditInvariants(input: {
  monthId: string;
  projectedDays: ExpenseCreditProjectedDay[];
}): LedgerInvariantIssue[] {
  const issues: LedgerInvariantIssue[] = [];
  const previousClosingByParty = new Map<string, { closing: number; dayNo: number; partyName: string }>();

  for (const day of [...input.projectedDays].sort((a, b) => a.dayNo - b.dayNo)) {
    for (const row of day.projections) {
      const key = creditPartyKey(row);
      const expectedClosing = row.calculated.opening + row.calculated.loan - row.calculated.receive + row.calculated.manualAdjustment;
      if (row.calculated.closing !== expectedClosing) {
        issues.push({
          id: `${input.monthId}-${day.dayNo}-${row.partyId}-closing-formula`,
          type: "CLOSING_FORMULA_MISMATCH",
          module: "expense",
          severity: "error",
          monthId: input.monthId,
          dayNo: day.dayNo,
          targetType: "creditParty",
          targetId: row.partyId,
          message: `${row.partyName} closing does not equal opening plus raw movement.`,
          expected: expectedClosing,
          actual: row.calculated.closing
        });
      }
      const previous = previousClosingByParty.get(key);
      if (previous && row.calculated.opening !== previous.closing) {
        issues.push({
          id: `${input.monthId}-${day.dayNo}-${row.partyId}-opening-chain`,
          type: "DAY_OPENING_MISMATCH",
          module: "expense",
          severity: "error",
          monthId: input.monthId,
          dayNo: day.dayNo,
          targetType: "creditParty",
          targetId: row.partyId,
          message: `${row.partyName} opening does not equal previous day closing.`,
          expected: previous.closing,
          actual: row.calculated.opening,
          sourcePath: `ledgerV2/expense/months/${input.monthId}/days/${previous.dayNo}/projections/${projectionId(previous.dayNo, row.partyId)}`
        });
      }
      previousClosingByParty.set(key, { closing: row.calculated.closing, dayNo: day.dayNo, partyName: row.partyName });
    }
  }

  return issues;
}
