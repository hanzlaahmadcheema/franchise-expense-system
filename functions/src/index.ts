import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { buildExpenseCarryForwardSeed, computeMonth } from "./formulaEngine";
import { sendAuditNotification } from "./notifications";

initializeApp();
const db = getFirestore();
const LEDGER_CALC_VERSION = 2;
const MASTER_REFRESH_BATCH_LIMIT = 425;
const callableOptions = {
  cors: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://franchise-expense-system.web.app",
    "https://franchise-expense-system.firebaseapp.com"
  ]
};

type RefreshWriteTarget = {
  set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options?: FirebaseFirestore.SetOptions
  ): void;
  delete(ref: FirebaseFirestore.DocumentReference): void;
};

type QueuedWrite =
  | {
      type: "set";
      ref: FirebaseFirestore.DocumentReference;
      data: FirebaseFirestore.DocumentData;
      options?: FirebaseFirestore.SetOptions;
    }
  | {
      type: "delete";
      ref: FirebaseFirestore.DocumentReference;
    };

class ChunkedBatchWriter implements RefreshWriteTarget {
  private writes: QueuedWrite[] = [];

  constructor(
    readonly label: string,
    private readonly maxWritesPerCommit = MASTER_REFRESH_BATCH_LIMIT
  ) {}

  get size() {
    return this.writes.length;
  }

  set(
    ref: FirebaseFirestore.DocumentReference,
    data: FirebaseFirestore.DocumentData,
    options?: FirebaseFirestore.SetOptions
  ) {
    this.writes.push({ type: "set", ref, data, options });
  }

  delete(ref: FirebaseFirestore.DocumentReference) {
    this.writes.push({ type: "delete", ref });
  }

  async commit() {
    let commitCount = 0;
    for (let index = 0; index < this.writes.length; index += this.maxWritesPerCommit) {
      const chunk = this.writes.slice(index, index + this.maxWritesPerCommit);
      const batch = db.batch();
      for (const write of chunk) {
        if (write.type === "delete") {
          batch.delete(write.ref);
        } else if (write.options) {
          batch.set(write.ref, write.data, write.options);
        } else {
          batch.set(write.ref, write.data);
        }
      }
      commitCount += 1;
      console.log(`[masterRefresh] ${this.label}: committing batch ${commitCount} with ${chunk.length} writes`);
      await batch.commit();
    }
    console.log(`[masterRefresh] ${this.label}: committed ${this.writes.length} writes across ${commitCount} commit(s)`);
    return { writes: this.writes.length, commits: commitCount };
  }
}

async function commitRefreshWriters(label: string, writers: ChunkedBatchWriter[]) {
  let totalWrites = 0;
  let totalCommits = 0;
  for (const writer of writers) {
    console.log(`[masterRefresh] ${label}: ${writer.label} queued ${writer.size} write(s) before commit`);
    const stats = await writer.commit();
    totalWrites += stats.writes;
    totalCommits += stats.commits;
  }
  console.log(`[masterRefresh] ${label}: committed ${totalWrites} write(s) across ${totalCommits} commit(s)`);
}

function cleanForFirestore(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cleanForFirestore(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, cleanForFirestore(entryValue)])
    );
  }
  return value;
}

function creditKey(row: Record<string, unknown>) {
  const partyId = String(row.partyId ?? "").trim();
  if (partyId) return `id:${partyId}`;
  return `name:${String(row.partyName ?? "").trim().toLowerCase()}`;
}

function previousMonthId(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  let year = Number(yearText);
  let month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  month -= 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

function stageUnifiedAudit(
  batch: RefreshWriteTarget,
  id: string,
  data: Record<string, unknown>
) {
  batch.set(db.collection("auditLogs").doc(id), cleanForFirestore({ id, ...data }) as FirebaseFirestore.DocumentData);
}

async function stageExpenseLedgerV2Projection(input: {
  batch: RefreshWriteTarget;
  auditBatch: RefreshWriteTarget;
  monthId: string;
  sourceDays: Array<Record<string, unknown>>;
  computedDays: Array<Record<string, unknown>>;
  homeSummary: Record<string, unknown>;
  calcRunId: string;
  actorUid: string;
  actorEmail: string | null;
  actorRole: string;
  timestamp: number;
}) {
  const monthV2Ref = db.collection("ledgerV2").doc("expense").collection("months").doc(input.monthId);
  input.batch.set(monthV2Ref, {
    id: input.monthId,
    module: "expense",
    status: "verified",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId: input.calcRunId,
    updatedAt: input.timestamp
  }, { merge: true });

  const issues: Array<Record<string, unknown>> = [];
  const previousCreditClosing = new Map<string, { closing: number; dayNo: number }>();
  let previousReturnBalance: number | null = null;

  for (const day of input.computedDays.sort((a, b) => Number(a.dayNo) - Number(b.dayNo))) {
    const dayNo = Number(day.dayNo);
    const sourceDay = input.sourceDays.find((item) => Number(item.dayNo) === dayNo) ?? {};
    const dayV2Ref = monthV2Ref.collection("days").doc(String(dayNo));
    const creditRows = Array.isArray(day.creditRows) ? day.creditRows as Array<Record<string, unknown>> : [];
    const rawCredits = Array.isArray(sourceDay.credits) ? sourceDay.credits as Array<Record<string, unknown>> : [];
    const rawExpenses = Array.isArray(sourceDay.expenses) ? sourceDay.expenses as Array<Record<string, unknown>> : [];
    const rawCommissions = Array.isArray(sourceDay.commissions) ? sourceDay.commissions as Array<Record<string, unknown>> : [];
    const rawOwnerBalances = Array.isArray(sourceDay.ownerBalances) ? sourceDay.ownerBalances as Array<Record<string, unknown>> : [];

    if (previousReturnBalance !== null && Number(day.openingBalance ?? 0) !== previousReturnBalance) {
      issues.push({
        type: "DAY_OPENING_MISMATCH",
        module: "expense",
        monthId: input.monthId,
        dayNo,
        expected: previousReturnBalance,
        actual: Number(day.openingBalance ?? 0),
        message: `Expense day ${dayNo} opening does not equal previous day closing.`
      });
    }
    previousReturnBalance = Number(day.returnBalance ?? previousReturnBalance ?? 0);

    input.batch.set(dayV2Ref, {
      dayNo,
      module: "expense",
      status: issues.some((issue) => issue.dayNo === dayNo) ? "mismatch" : "verified",
      calculationVersion: LEDGER_CALC_VERSION,
      calcRunId: input.calcRunId,
      recalculatedAt: input.timestamp,
      summary: {
        openingBalance: Number(day.openingBalance ?? 0),
        closingBalance: Number(day.returnBalance ?? 0),
        issueBalance: Number(day.issueBalance ?? 0),
        expenseTotal: Number(day.expenseTotal ?? 0),
        ownerBalanceTotal: Number(day.ownerBalanceTotal ?? 0),
        creditOpeningTotal: Number((day.creditTotals as Record<string, unknown> | undefined)?.opening ?? 0),
        creditClosingTotal: Number((day.creditTotals as Record<string, unknown> | undefined)?.balance ?? 0)
      }
    }, { merge: true });

    const rawEntriesRef = dayV2Ref.collection("rawEntries");
    const rawEntriesSnap = await rawEntriesRef.get();
    const nextRawIds = new Set<string>();
    const stageRaw = (id: string, type: string, raw: Record<string, unknown>) => {
      nextRawIds.add(id);
      input.batch.set(rawEntriesRef.doc(id), cleanForFirestore({
        id,
        module: "expense",
        type,
        monthId: input.monthId,
        dayNo,
        raw,
        calculated: null,
        meta: {
          updatedAt: input.timestamp,
          updatedBy: input.actorUid,
          status: "verified",
          calculationVersion: LEDGER_CALC_VERSION,
          calcRunId: input.calcRunId
        }
      }) as FirebaseFirestore.DocumentData, { merge: true });
    };
    rawExpenses.forEach((row) => stageRaw(`expense-${row.id}`, "expense", row));
    rawCommissions.forEach((row) => stageRaw(`commission-${row.id}`, "commission", row));
    rawCredits.forEach((row) => stageRaw(`credit-${row.id}`, "credit", {
      partyId: row.partyId,
      partyNameSnapshot: row.partyName,
      loan: Number(row.loan ?? row.today ?? 0),
      receive: Number(row.receive ?? 0),
      manualAdjustment: Number(row.manualAdjustment ?? 0),
      source: "user"
    }));
    rawOwnerBalances.forEach((row) => stageRaw(`owner-${row.id}`, "ownerBalance", row));
    rawEntriesSnap.docs.forEach((docSnap) => {
      if (!nextRawIds.has(docSnap.id)) input.batch.delete(docSnap.ref);
    });

    const projectionRef = dayV2Ref.collection("projections");
    const existingProjectionSnap = await projectionRef.get();
    const nextProjectionIds = new Set<string>();
    creditRows.forEach((row) => {
      const partyId = String(row.partyId ?? String(row.partyName ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      const projectionId = `${dayNo}-credit-balance-${partyId}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
      nextProjectionIds.add(projectionId);
      const opening = Number(row.opening ?? 0);
      const loan = Number(row.loan ?? row.today ?? 0);
      const receive = Number(row.receive ?? 0);
      const closing = Number(row.balance ?? opening + loan - receive);
      const key = creditKey(row);
      const previous = previousCreditClosing.get(key);
      if (previous && opening !== previous.closing) {
        issues.push({
          type: "DAY_OPENING_MISMATCH",
          module: "expense",
          monthId: input.monthId,
          dayNo,
          targetType: "creditParty",
          targetId: partyId,
          expected: previous.closing,
          actual: opening,
          message: `${row.partyName ?? partyId} opening does not equal previous day closing.`
        });
      }
      input.batch.set(projectionRef.doc(projectionId), cleanForFirestore({
        id: projectionId,
        partyId,
        partyName: row.partyName ?? partyId,
        rawEntryId: row.id ? `credit-${row.id}` : undefined,
        dayNo,
        calculated: {
          opening,
          loan,
          receive,
          manualAdjustment: Number(row.manualAdjustment ?? 0),
          delta: loan - receive + Number(row.manualAdjustment ?? 0),
          closing,
          calculatedFromDay: dayNo
        },
        meta: {
          calculatedAt: input.timestamp,
          calculationVersion: LEDGER_CALC_VERSION,
          calcRunId: input.calcRunId,
          rowHash: [dayNo, partyId, opening, loan, receive, closing].join("|")
        }
      }) as FirebaseFirestore.DocumentData, { merge: true });
      if (closing === 0) previousCreditClosing.delete(key);
      else previousCreditClosing.set(key, { closing, dayNo });
    });
    existingProjectionSnap.docs.forEach((docSnap) => {
      if (!nextProjectionIds.has(docSnap.id)) input.batch.delete(docSnap.ref);
    });
  }

  input.batch.set(monthV2Ref.collection("summary").doc("home"), cleanForFirestore({
    ...input.homeSummary,
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId: input.calcRunId,
    recalculatedAt: input.timestamp
  }) as FirebaseFirestore.DocumentData, { merge: true });

  input.batch.set(monthV2Ref.collection("calcRuns").doc(input.calcRunId), {
    id: input.calcRunId,
    module: "expense",
    monthId: input.monthId,
    startDay: Number(input.computedDays[0]?.dayNo ?? 1),
    endDay: Number(input.computedDays[input.computedDays.length - 1]?.dayNo ?? 31),
    status: issues.length ? "failed" : "completed",
    calculationVersion: LEDGER_CALC_VERSION,
    actorUid: input.actorUid,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    rowsRead: input.sourceDays.length,
    rowsWritten: input.computedDays.length,
    invariantIssueCount: issues.length,
    createdAt: input.timestamp,
    completedAt: input.timestamp
  }, { merge: true });

  if (issues.length > 0) {
    const reportId = `${input.calcRunId}-mismatch`;
    input.auditBatch.set(monthV2Ref.collection("mismatchReports").doc(reportId), cleanForFirestore({
      id: reportId,
      module: "expense",
      monthId: input.monthId,
      calcRunId: input.calcRunId,
      status: "open",
      issues,
      createdAt: input.timestamp
    }) as FirebaseFirestore.DocumentData, { merge: true });
    stageUnifiedAudit(input.auditBatch, `${input.calcRunId}-mismatch-audit`, {
      createdAt: input.timestamp,
      module: "expense",
      action: "BALANCE_MISMATCH_DETECTED",
      summary: `Detected ${issues.length} Expense balance mismatch${issues.length === 1 ? "" : "es"} in ${input.monthId}`,
      actorUid: input.actorUid,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      monthId: input.monthId,
      targetType: "month",
      targetId: input.monthId,
      sourcePath: `ledgerV2/expense/months/${input.monthId}/mismatchReports/${reportId}`,
      after: { issueCount: issues.length }
    });
  }
  return issues;
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function stableId(value: unknown, fallback = "unknown") {
  const normalized = String(value ?? fallback).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return normalized || fallback;
}

function moneyBase(value: unknown) {
  if (value && typeof value === "object" && "baseAmount" in value) {
    return numberValue((value as Record<string, unknown>).baseAmount);
  }
  return numberValue(value);
}

function moneyCalculated(value: unknown) {
  if (value && typeof value === "object" && "calculatedAmount" in value) {
    return numberValue((value as Record<string, unknown>).calculatedAmount);
  }
  return numberValue(value);
}

function jazzDoKey(entry: Record<string, unknown>) {
  const doLineId = String(entry.doLineId ?? "").trim();
  if (doLineId) return `line:${doLineId}`;
  const doProfileId = String(entry.doProfileId ?? "").trim();
  if (doProfileId) return `profile:${doProfileId}`;
  return `name:${String(entry.doName ?? "").trim().toLowerCase()}|${String(entry.doLine ?? "").trim().toLowerCase()}`;
}

function stockProductKey(product: Record<string, unknown>) {
  return String(product.productId ?? stableId(product.productName)).trim();
}

function numberMap(value: unknown) {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [key, numberValue(entryValue)])
  );
}

async function replaceCollectionDocs(
  batch: RefreshWriteTarget,
  collectionRef: FirebaseFirestore.CollectionReference,
  nextDocs: Array<{ id: string; data: Record<string, unknown> }>
) {
  const existingSnap = await collectionRef.get();
  const nextIds = new Set(nextDocs.map((item) => item.id));
  existingSnap.docs.forEach((docSnap) => {
    if (!nextIds.has(docSnap.id)) batch.delete(docSnap.ref);
  });
  nextDocs.forEach((item) => {
    batch.set(collectionRef.doc(item.id), cleanForFirestore({ id: item.id, ...item.data }) as FirebaseFirestore.DocumentData, { merge: true });
  });
}

async function requireOwnerOrAdmin(request: CallableRequest, action: string) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required");
  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.data() as { role?: string; active?: boolean } | undefined;
  const actorRole = userData?.role === "staff" ? "admin" : (userData?.role ?? "viewer");
  if (!userData?.active || (actorRole !== "owner" && actorRole !== "admin")) {
    throw new HttpsError("permission-denied", `Owner or admin access is required to ${action}.`);
  }
  return {
    actorUid: request.auth.uid,
    actorEmail: request.auth.token.email ?? null,
    actorRole
  };
}

function sumLedger(values: number[]) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function monthDayCount(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month)) return 31;
  return new Date(year, month, 0).getDate();
}

function monthDate(monthId: string, dayNo: number) {
  return `${monthId}-${String(dayNo).padStart(2, "0")}`;
}

function monthDateFields(monthId: string, dayNo: number) {
  const [yearText, monthText] = monthId.split("-");
  return {
    entryYear: Number(yearText) || undefined,
    entryMonth: Number(monthText) || undefined,
    entryDay: dayNo
  };
}

function activeRateForBackend(
  rates: Array<Record<string, unknown>>,
  primaryType: string,
  legacyTypes: string[] = []
) {
  return rates.find((rate) => rate.active === true && rate.type === primaryType) ??
    rates.find((rate) => rate.active === true && legacyTypes.includes(String(rate.type))) ??
    null;
}

function calculatedMoney(baseAmount: number, rate: Record<string, unknown>, calculatedAt: number) {
  const base = numberValue(baseAmount);
  const percentage = numberValue(rate.percentage);
  return {
    baseAmount: base,
    calculatedAmount: numberValue(base + (base * percentage) / 100),
    appliedRateId: rate.id,
    appliedRateName: rate.name,
    appliedRatePercentage: percentage,
    calculatedAt
  };
}

function snapshotJazzRate(rate: Record<string, unknown>, appliedAt: number) {
  return {
    rateId: rate.id,
    rateName: rate.name,
    rateType: rate.type,
    percentage: numberValue(rate.percentage),
    appliedAt
  };
}

function jazzDoBalanceKey(entry: Record<string, unknown>) {
  const doNameId = String(entry.doNameId ?? "").trim();
  if (doNameId) return `nameId:${doNameId}`;
  const doName = String(entry.doName ?? "").trim().toLowerCase();
  if (doName) return `name:${doName}`;
  const doLineId = String(entry.doLineId ?? "").trim();
  if (doLineId) return `line:${doLineId}`;
  const doProfileId = String(entry.doProfileId ?? "").trim();
  if (doProfileId) return `profile:${doProfileId}`;
  return `entry:${stableId(entry.id ?? `${entry.doLine ?? ""}`)}`;
}

function matchingPreviousJazzEntry(
  previousDays: Array<Record<string, unknown>>,
  entry: Record<string, unknown>
) {
  for (let dayIndex = previousDays.length - 1; dayIndex >= 0; dayIndex -= 1) {
    const priorEntries = Array.isArray(previousDays[dayIndex].doEntries)
      ? previousDays[dayIndex].doEntries as Array<Record<string, unknown>>
      : [];
    const match = priorEntries.find((prior) => {
      const entryDoNameId = String(entry.doNameId ?? "").trim();
      const priorDoNameId = String(prior.doNameId ?? "").trim();
      if (entryDoNameId && priorDoNameId === entryDoNameId) return true;
      const entryDoLineId = String(entry.doLineId ?? "").trim();
      const priorDoLineId = String(prior.doLineId ?? "").trim();
      if (entryDoLineId && priorDoLineId === entryDoLineId) return true;
      const entryDoProfileId = String(entry.doProfileId ?? "").trim();
      const priorDoProfileId = String(prior.doProfileId ?? "").trim();
      if (entryDoProfileId && priorDoProfileId === entryDoProfileId) return true;
      return String(prior.doName ?? "").trim().toLowerCase() === String(entry.doName ?? "").trim().toLowerCase() &&
        String(prior.doLine ?? "").trim().toLowerCase() === String(entry.doLine ?? "").trim().toLowerCase();
    });
    if (match) return match;
  }
  return undefined;
}

function calculateJazzDoEntryBackend(
  entry: Record<string, unknown>,
  previous: Record<string, unknown> | undefined,
  activeRates: { mlRate: Record<string, unknown>; commission1Rate: Record<string, unknown> | null; commission2Rate: Record<string, unknown> | null },
  actorUid: string,
  timestamp: number
) {
  const openingBase = previous ? moneyBase(previous.closingBalance) : moneyBase(entry.openingBalance);
  const issuanceBase = moneyBase(entry.todayMlIssuance);
  const paymentBase = moneyBase(entry.paymentReceived);
  const dayTotalBase = numberValue(openingBase + issuanceBase);
  const closingBase = numberValue(dayTotalBase - paymentBase);
  return {
    ...entry,
    id: String(entry.id ?? stableId(`${entry.doName ?? ""}-${entry.doLine ?? ""}`)),
    openingBalance: calculatedMoney(openingBase, activeRates.mlRate, timestamp),
    todayMlIssuance: calculatedMoney(issuanceBase, activeRates.mlRate, timestamp),
    dayTotal: calculatedMoney(dayTotalBase, activeRates.mlRate, timestamp),
    paymentReceived: calculatedMoney(paymentBase, activeRates.mlRate, timestamp),
    closingBalance: calculatedMoney(closingBase, activeRates.mlRate, timestamp),
    createdBy: entry.createdBy ?? actorUid,
    updatedBy: actorUid,
    createdAt: entry.createdAt ?? timestamp,
    updatedAt: timestamp
  };
}

function calculateJazzDailySummaryBackend(
  entries: Array<Record<string, unknown>>,
  activeRates: { commission1Rate: Record<string, unknown> | null; commission2Rate: Record<string, unknown> | null },
  timestamp: number
) {
  const paymentBase = numberValue(sumLedger(entries.map((entry) => moneyBase(entry.paymentReceived))));
  const paymentMl = numberValue(sumLedger(entries.map((entry) => moneyCalculated(entry.paymentReceived))));
  const commission1MlDeduction = activeRates.commission1Rate
    ? numberValue((paymentMl * numberValue(activeRates.commission1Rate.percentage)) / 100)
    : 0;
  const commission1AdjustedPayment = activeRates.commission1Rate ? numberValue(paymentMl - commission1MlDeduction) : paymentMl;
  const commission1 = activeRates.commission1Rate ? numberValue(paymentBase - commission1AdjustedPayment) : 0;
  const commission2 = activeRates.commission2Rate
    ? numberValue((paymentBase * numberValue(activeRates.commission2Rate.percentage)) / 100)
    : 0;
  return {
    openingBase: numberValue(sumLedger(entries.map((entry) => moneyBase(entry.openingBalance)))),
    openingMl: numberValue(sumLedger(entries.map((entry) => moneyCalculated(entry.openingBalance)))),
    issuanceBase: numberValue(sumLedger(entries.map((entry) => moneyBase(entry.todayMlIssuance)))),
    issuanceMl: numberValue(sumLedger(entries.map((entry) => moneyCalculated(entry.todayMlIssuance)))),
    dayTotalBase: numberValue(sumLedger(entries.map((entry) => moneyBase(entry.dayTotal)))),
    dayTotalMl: numberValue(sumLedger(entries.map((entry) => moneyCalculated(entry.dayTotal)))),
    paymentBase,
    paymentMl,
    closingBase: numberValue(sumLedger(entries.map((entry) => moneyBase(entry.closingBalance)))),
    closingMl: numberValue(sumLedger(entries.map((entry) => moneyCalculated(entry.closingBalance)))),
    commission1,
    commission1MlDeduction,
    commission1AdjustedPayment,
    commission1Rate: activeRates.commission1Rate ? snapshotJazzRate(activeRates.commission1Rate, timestamp) : undefined,
    commission2,
    commission2Rate: activeRates.commission2Rate ? snapshotJazzRate(activeRates.commission2Rate, timestamp) : undefined,
    totalCommission: numberValue(commission1 + commission2),
    outstandingDoCount: entries.filter((entry) => moneyBase(entry.closingBalance) > 0).length
  };
}

function calculateChainedJazzDailySummaryBackend(
  entries: Array<Record<string, unknown>>,
  activeRates: { commission1Rate: Record<string, unknown> | null; commission2Rate: Record<string, unknown> | null },
  timestamp: number,
  previousClosing?: { closingBase: number; closingMl: number }
) {
  const summary = calculateJazzDailySummaryBackend(entries, activeRates, timestamp);
  if (!previousClosing) return summary;

  const openingBase = numberValue(previousClosing.closingBase);
  const openingMl = numberValue(previousClosing.closingMl);
  const dayTotalBase = numberValue(openingBase + numberValue(summary.issuanceBase));
  const dayTotalMl = numberValue(openingMl + numberValue(summary.issuanceMl));

  return {
    ...summary,
    openingBase,
    openingMl,
    dayTotalBase,
    dayTotalMl,
    closingBase: numberValue(dayTotalBase - numberValue(summary.paymentBase)),
    closingMl: numberValue(dayTotalMl - numberValue(summary.paymentMl))
  };
}

function calculateJazzLiftingBackend(openingBalance: number, mlLifting: number, issuanceMl: number) {
  const opening = numberValue(openingBalance);
  const lifting = numberValue(mlLifting);
  const total = numberValue(opening + lifting);
  return {
    openingBalance: opening,
    mlLifting: lifting,
    totalBalance: total,
    todayMlIssuance: numberValue(issuanceMl),
    inHandBalance: numberValue(total - issuanceMl)
  };
}

function calculateJazzMonthlySummaryBackend(monthId: string, days: Array<Record<string, unknown>>, timestamp: number) {
  const sortedDays = [...days].sort((a, b) => numberValue(a.dayNo) - numberValue(b.dayNo));
  const doMap = new Map<string, Record<string, unknown>>();
  for (const day of sortedDays) {
    const entries = Array.isArray(day.doEntries) ? day.doEntries as Array<Record<string, unknown>> : [];
    for (const entry of entries) {
      const key = jazzDoBalanceKey(entry);
      const current = doMap.get(key) ?? {
        doProfileId: entry.doProfileId,
        doNameId: entry.doNameId,
        doLineId: entry.doLineId,
        doName: entry.doName,
        doLine: entry.doLine,
        doLineSortOrder: entry.doLineSortOrder,
        openingBase: moneyBase(entry.openingBalance),
        issuanceBase: 0,
        paymentBase: 0,
        closingBase: moneyBase(entry.closingBalance),
        closingMl: moneyCalculated(entry.closingBalance),
        activeDays: 0
      };
      current.issuanceBase = numberValue(numberValue(current.issuanceBase) + moneyBase(entry.todayMlIssuance));
      current.paymentBase = numberValue(numberValue(current.paymentBase) + moneyBase(entry.paymentReceived));
      current.closingBase = moneyBase(entry.closingBalance);
      current.closingMl = moneyCalculated(entry.closingBalance);
      current.doNameId = entry.doNameId ?? current.doNameId;
      current.doLineId = entry.doLineId ?? current.doLineId;
      current.doName = entry.doName ?? current.doName;
      current.doLine = entry.doLine ?? current.doLine;
      current.doLineSortOrder = entry.doLineSortOrder ?? current.doLineSortOrder;
      current.activeDays = numberValue(current.activeDays) + 1;
      doMap.set(key, current);
    }
  }
  const enteredDays = new Set(sortedDays.map((day) => numberValue(day.dayNo)));
  return {
    monthId,
    totalOpeningBase: numberValue((sortedDays[0]?.summary as Record<string, unknown> | undefined)?.openingBase),
    totalIssuanceBase: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.issuanceBase)))),
    totalIssuanceMl: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.issuanceMl)))),
    totalPaymentsBase: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.paymentBase)))),
    totalPaymentsMl: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.paymentMl)))),
    totalClosingBase: numberValue((sortedDays.at(-1)?.summary as Record<string, unknown> | undefined)?.closingBase),
    totalClosingMl: numberValue((sortedDays.at(-1)?.summary as Record<string, unknown> | undefined)?.closingMl),
    totalLifting: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.lifting as Record<string, unknown> | undefined)?.mlLifting)))),
    latestInHandBalance: numberValue((sortedDays.at(-1)?.lifting as Record<string, unknown> | undefined)?.inHandBalance),
    totalCommission: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.totalCommission)))),
    dayRows: sortedDays.map((day) => {
      const summary = day.summary as Record<string, unknown> | undefined;
      const lifting = day.lifting as Record<string, unknown> | undefined;
      return {
        dayNo: numberValue(day.dayNo),
        issuanceBase: numberValue(summary?.issuanceBase),
        issuanceMl: numberValue(summary?.issuanceMl),
        paymentBase: numberValue(summary?.paymentBase),
        paymentMl: numberValue(summary?.paymentMl),
        closingBase: numberValue(summary?.closingBase),
        lifting: numberValue(lifting?.mlLifting),
        inHandBalance: numberValue(lifting?.inHandBalance),
        commission1: numberValue(summary?.commission1),
        commission2: numberValue(summary?.commission2),
        commission: numberValue(summary?.totalCommission)
      };
    }),
    doBalances: [...doMap.values()].sort((a, b) => {
      const orderA = a.doLineSortOrder === undefined ? Number.POSITIVE_INFINITY : numberValue(a.doLineSortOrder);
      const orderB = b.doLineSortOrder === undefined ? Number.POSITIVE_INFINITY : numberValue(b.doLineSortOrder);
      if (orderA !== orderB) return orderA - orderB;
      return String(a.doLine ?? a.doName ?? "").localeCompare(String(b.doLine ?? b.doName ?? ""), undefined, { numeric: true, sensitivity: "base" });
    }),
    missingDays: Array.from({ length: monthDayCount(monthId) }, (_, index) => index + 1).filter((dayNo) => !enteredDays.has(dayNo)),
    updatedAt: timestamp
  };
}

async function readJazzLoadMonthDays(monthRef: FirebaseFirestore.DocumentReference) {
  const daysSnap = await monthRef.collection("days").orderBy("dayNo", "asc").get();
  const days: Array<Record<string, unknown>> = [];
  for (const dayDoc of daysSnap.docs) {
    const base = dayDoc.data();
    const entriesSnap = Array.isArray(base.doEntries) ? null : await dayDoc.ref.collection("doEntries").get();
    days.push({
      ...base,
      id: dayDoc.id,
      dayNo: numberValue(base.dayNo, numberValue(dayDoc.id)),
      doEntries: Array.isArray(base.doEntries)
        ? base.doEntries
        : entriesSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? []
    });
  }
  return days;
}

function rechainJazzLoadDaysBackend(input: {
  monthId: string;
  days: Array<Record<string, unknown>>;
  previousMonthDays: Array<Record<string, unknown>>;
  previousMonthSummary?: Record<string, unknown> | null;
  activeRates: { mlRate: Record<string, unknown>; commission1Rate: Record<string, unknown> | null; commission2Rate: Record<string, unknown> | null };
  actorUid: string;
  timestamp: number;
}) {
  const recalculatedDays: Array<Record<string, unknown>> = [];
  const seedDays = [...input.previousMonthDays].sort((a, b) => numberValue(a.dayNo) - numberValue(b.dayNo));
  const sortedDays = [...input.days].sort((a, b) => numberValue(a.dayNo) - numberValue(b.dayNo));
  const finalSeedDay = seedDays.at(-1);
  let previousSummaryClosing = input.previousMonthSummary
    ? {
        closingBase: numberValue(input.previousMonthSummary.totalClosingBase),
        closingMl: numberValue(input.previousMonthSummary.totalClosingMl)
      }
    : finalSeedDay?.summary && typeof finalSeedDay.summary === "object"
      ? {
          closingBase: numberValue((finalSeedDay.summary as Record<string, unknown>).closingBase),
          closingMl: numberValue((finalSeedDay.summary as Record<string, unknown>).closingMl)
        }
      : undefined;
  const seedInHandBalance = input.previousMonthSummary
    ? numberValue(input.previousMonthSummary.latestInHandBalance)
    : finalSeedDay?.lifting && typeof finalSeedDay.lifting === "object"
      ? numberValue((finalSeedDay.lifting as Record<string, unknown>).inHandBalance)
      : undefined;

  for (const day of sortedDays) {
    const entries = Array.isArray(day.doEntries) ? day.doEntries as Array<Record<string, unknown>> : [];
    const previousDays = [...seedDays, ...recalculatedDays];
    const doEntries = entries.map((entry) => calculateJazzDoEntryBackend(
      entry,
      matchingPreviousJazzEntry(previousDays, entry),
      input.activeRates,
      input.actorUid,
      input.timestamp
    ));
    const summary = calculateChainedJazzDailySummaryBackend(doEntries, input.activeRates, input.timestamp, previousSummaryClosing);
    const previousDay = recalculatedDays.at(-1);
    const previousLifting = previousDay?.lifting as Record<string, unknown> | undefined;
    const lifting = day.lifting && typeof day.lifting === "object" ? day.lifting as Record<string, unknown> : {};
    recalculatedDays.push({
      ...day,
      monthId: input.monthId,
      dayNo: numberValue(day.dayNo),
      date: day.date ?? monthDate(input.monthId, numberValue(day.dayNo)),
      ...monthDateFields(input.monthId, numberValue(day.dayNo)),
      doEntries,
      summary,
      lifting: calculateJazzLiftingBackend(
        previousLifting ? numberValue(previousLifting.inHandBalance) : seedInHandBalance ?? numberValue(lifting.openingBalance),
        numberValue(lifting.mlLifting),
        numberValue(summary.issuanceMl)
      ),
      recalculatedAt: input.timestamp,
      updatedBy: input.actorUid,
      updatedAt: input.timestamp
    });
    previousSummaryClosing = {
      closingBase: numberValue(summary.closingBase),
      closingMl: numberValue(summary.closingMl)
    };
  }
  return recalculatedDays;
}

function normalizeStockProductLine(product: Record<string, unknown>) {
  const quantity = numberValue(product.quantity);
  const rate = numberValue(product.rate);
  return {
    ...product,
    quantity,
    rate,
    amount: rate ? numberValue(quantity * rate) : numberValue(product.amount),
    paymentTrackingEnabled: product.paymentTrackingEnabled === true,
    paymentReceived: 0,
    dueBalance: 0
  };
}

function calculateStockDailySummaryBackend(entries: Array<Record<string, unknown>>) {
  return {
    accountCount: entries.length,
    totalQty: numberValue(sumLedger(entries.map((entry) => numberValue(entry.totalQty)))),
    totalAmount: numberValue(sumLedger(entries.map((entry) => numberValue(entry.totalAmount)))),
    totalPaymentReceived: numberValue(sumLedger(entries.map((entry) => numberValue(entry.totalPaymentReceived)))),
    totalDueBalance: numberValue(sumLedger(entries.map((entry) => numberValue(entry.dueBalance))))
  };
}

function stockAccountOpeningSeed(
  accounts: Array<Record<string, unknown>>,
  previousSummary: Record<string, unknown> | null
) {
  const seed = new Map<string, number>();
  const previousAccounts = Array.isArray(previousSummary?.accountTotals)
    ? previousSummary.accountTotals as Array<Record<string, unknown>>
    : [];
  previousAccounts.forEach((account) => seed.set(String(account.accountId), numberValue(account.dueBalance)));
  accounts.forEach((account) => {
    const accountId = String(account.id ?? "");
    if (accountId && !seed.has(accountId)) seed.set(accountId, numberValue(account.openingBalance));
  });
  return seed;
}

function rechainStockDaysBackend(input: {
  monthId: string;
  days: Array<Record<string, unknown>>;
  accounts: Array<Record<string, unknown>>;
  previousSummary: Record<string, unknown> | null;
  actorUid: string;
  timestamp: number;
}) {
  const seedByAccount = stockAccountOpeningSeed(input.accounts, input.previousSummary);
  const runningByAccount = new Map(seedByAccount);
  return [...input.days].sort((a, b) => numberValue(a.dayNo) - numberValue(b.dayNo)).map((day) => {
    const entries = Array.isArray(day.entries)
      ? day.entries as Array<Record<string, unknown>>
      : Array.isArray(day.stockOut)
        ? day.stockOut as Array<Record<string, unknown>>
        : [];
    const nextEntries = [...entries].sort((a, b) => String(a.accountName ?? "").localeCompare(String(b.accountName ?? ""))).map((entry) => {
      const accountId = String(entry.accountId ?? stableId(entry.accountName));
      const products = (Array.isArray(entry.products) ? entry.products as Array<Record<string, unknown>> : []).map(normalizeStockProductLine);
      const totalQty = numberValue(sumLedger(products.map((product) => numberValue(product.quantity))));
      const totalAmount = numberValue(sumLedger(products.map((product) => numberValue(product.amount))));
      const totalPaymentReceived = numberValue(entry.totalPaymentReceived);
      const carryForwardBalance = numberValue(runningByAccount.get(accountId) ?? seedByAccount.get(accountId) ?? 0);
      const dueBalance = numberValue(carryForwardBalance + totalAmount - totalPaymentReceived);
      runningByAccount.set(accountId, dueBalance);
      return {
        ...entry,
        accountId,
        products,
        totalQty,
        totalAmount,
        totalPaymentReceived,
        carryForwardBalance,
        dueBalance,
        updatedBy: input.actorUid,
        updatedAt: input.timestamp
      };
    });
    const dayNo = numberValue(day.dayNo);
    const stockIn = (Array.isArray(day.stockIn) ? day.stockIn as Array<Record<string, unknown>> : []).map((record) => {
      const products = (Array.isArray(record.products) ? record.products as Array<Record<string, unknown>> : []).map(normalizeStockProductLine);
      return {
        ...record,
        products,
        totalQty: numberValue(sumLedger(products.map((product) => numberValue(product.quantity)))),
        totalAmount: numberValue(sumLedger(products.map((product) => numberValue(product.amount)))),
        paidAmount: numberValue(record.paidAmount)
      };
    });
    return {
      ...day,
      id: String(dayNo),
      monthId: input.monthId,
      dayNo,
      date: day.date ?? monthDate(input.monthId, dayNo),
      ...monthDateFields(input.monthId, dayNo),
      entries: nextEntries,
      stockOut: nextEntries,
      stockIn,
      summary: calculateStockDailySummaryBackend(nextEntries),
      recalculatedAt: input.timestamp,
      updatedBy: input.actorUid,
      updatedAt: input.timestamp
    };
  });
}

async function readStockMonthDays(monthRef: FirebaseFirestore.DocumentReference) {
  const daysSnap = await monthRef.collection("days").orderBy("dayNo", "asc").get();
  const days: Array<Record<string, unknown>> = [];
  for (const dayDoc of daysSnap.docs) {
    const base = dayDoc.data();
    const [entriesSnap, stockOutSnap, stockInSnap] = await Promise.all([
      Array.isArray(base.entries) ? Promise.resolve(null) : dayDoc.ref.collection("entries").get(),
      Array.isArray(base.stockOut) ? Promise.resolve(null) : dayDoc.ref.collection("stockOut").get(),
      Array.isArray(base.stockIn) ? Promise.resolve(null) : dayDoc.ref.collection("stockIn").get()
    ]);
    const entries = Array.isArray(base.entries)
      ? base.entries
      : entriesSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ??
        stockOutSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? [];
    days.push({
      ...base,
      id: dayDoc.id,
      dayNo: numberValue(base.dayNo, numberValue(dayDoc.id)),
      entries,
      stockOut: entries,
      stockIn: Array.isArray(base.stockIn)
        ? base.stockIn
        : stockInSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? []
    });
  }
  return days;
}

function calculateStockMonthlySummaryBackend(input: {
  monthId: string;
  days: Array<Record<string, unknown>>;
  products: Array<Record<string, unknown>>;
  openingStock: Record<string, number>;
  openingJazzPayable: number;
  timestamp: number;
}) {
  const sortedDays = [...input.days].sort((a, b) => numberValue(a.dayNo) - numberValue(b.dayNo));
  const productMap = new Map<string, Record<string, unknown>>();
  const accountMap = new Map<string, Record<string, unknown>>();
  const stockInMap = new Map<string, number>();
  const stockOutMap = new Map<string, number>();
  let totalStockInAmount = 0;
  let totalPaidAmount = 0;
  for (const day of sortedDays) {
    const entries = Array.isArray(day.entries) ? day.entries as Array<Record<string, unknown>> : [];
    for (const entry of entries) {
      const accountId = String(entry.accountId ?? stableId(entry.accountName));
      const account = accountMap.get(accountId) ?? {
        accountId,
        accountName: entry.accountName,
        accountType: entry.accountType,
        totalQty: 0,
        totalAmount: 0,
        totalPaymentReceived: 0,
        dueBalance: 0,
        activeDays: 0
      };
      account.totalQty = numberValue(numberValue(account.totalQty) + numberValue(entry.totalQty));
      account.totalAmount = numberValue(numberValue(account.totalAmount) + numberValue(entry.totalAmount));
      account.totalPaymentReceived = numberValue(numberValue(account.totalPaymentReceived) + numberValue(entry.totalPaymentReceived));
      account.dueBalance = numberValue(entry.dueBalance);
      account.activeDays = numberValue(account.activeDays) + 1;
      accountMap.set(accountId, account);
      for (const product of Array.isArray(entry.products) ? entry.products as Array<Record<string, unknown>> : []) {
        const productId = stockProductKey(product);
        const productName = product.productName ?? product.name ?? productId;
        const current = productMap.get(productId) ?? { productId, productName, quantity: 0, amount: 0 };
        current.quantity = numberValue(numberValue(current.quantity) + numberValue(product.quantity));
        current.amount = numberValue(numberValue(current.amount) + numberValue(product.amount));
        productMap.set(productId, current);
        stockOutMap.set(productId, numberValue((stockOutMap.get(productId) ?? 0) + numberValue(product.quantity)));
      }
    }
    const stockIn = Array.isArray(day.stockIn) ? day.stockIn as Array<Record<string, unknown>> : [];
    for (const record of stockIn) {
      totalStockInAmount = numberValue(totalStockInAmount + numberValue(record.totalAmount));
      totalPaidAmount = numberValue(totalPaidAmount + numberValue(record.paidAmount));
      for (const product of Array.isArray(record.products) ? record.products as Array<Record<string, unknown>> : []) {
        const productId = stockProductKey(product);
        stockInMap.set(productId, numberValue((stockInMap.get(productId) ?? 0) + numberValue(product.quantity)));
      }
    }
  }
  const closingStock: Record<string, number> = {};
  for (const product of input.products) {
    const productId = String(product.id ?? "");
    if (!productId) continue;
    closingStock[productId] = numberValue((input.openingStock[productId] ?? 0) + (stockInMap.get(productId) ?? 0) - (stockOutMap.get(productId) ?? 0));
  }
  const enteredDays = new Set(sortedDays.map((day) => numberValue(day.dayNo)));
  const totalRecoveryPayments = numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.totalPaymentReceived))));
  return {
    monthId: input.monthId,
    totalQty: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.totalQty)))),
    totalAmount: numberValue(sumLedger(sortedDays.map((day) => numberValue((day.summary as Record<string, unknown> | undefined)?.totalAmount)))),
    totalPaymentReceived: totalRecoveryPayments,
    totalDueBalance: numberValue(sumLedger([...accountMap.values()].map((account) => numberValue(account.dueBalance)))),
    productTotals: [...productMap.values()].sort((a, b) => String(a.productName ?? "").localeCompare(String(b.productName ?? ""))),
    accountTotals: [...accountMap.values()].sort((a, b) => numberValue(b.dueBalance) - numberValue(a.dueBalance)),
    paymentTotals: [{ productId: "account-recovery", productName: "Account Recovery Payments", amount: totalRecoveryPayments }],
    dayRows: sortedDays.map((day) => {
      const summary = day.summary as Record<string, unknown> | undefined;
      return {
        dayNo: numberValue(day.dayNo),
        date: day.date,
        accountCount: numberValue(summary?.accountCount),
        totalQty: numberValue(summary?.totalQty),
        totalAmount: numberValue(summary?.totalAmount),
        totalPaymentReceived: numberValue(summary?.totalPaymentReceived),
        totalDueBalance: numberValue(summary?.totalDueBalance),
        status: day.status
      };
    }),
    missingDays: Array.from({ length: monthDayCount(input.monthId) }, (_, index) => index + 1).filter((dayNo) => !enteredDays.has(dayNo)),
    openingStock: input.openingStock,
    closingStock,
    openingJazzPayable: numberValue(input.openingJazzPayable),
    closingJazzPayable: numberValue(input.openingJazzPayable + totalStockInAmount - totalPaidAmount),
    updatedAt: input.timestamp
  };
}

async function stageJazzLoadLedgerV2Projection(input: {
  batch: RefreshWriteTarget;
  auditBatch?: RefreshWriteTarget;
  monthId: string;
  month: Record<string, unknown>;
  days: Array<Record<string, unknown>>;
  summary: Record<string, unknown> | null;
  calcRunId: string;
  actorUid: string;
  actorEmail: string | null;
  actorRole: string;
  timestamp: number;
}) {
  const monthV2Ref = db.collection("ledgerV2").doc("jazzLoad").collection("months").doc(input.monthId);
  input.batch.set(monthV2Ref, {
    id: input.monthId,
    module: "jazzLoad",
    status: "verified",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId: input.calcRunId,
    updatedAt: input.timestamp
  }, { merge: true });

  const issues: Array<Record<string, unknown>> = [];
  const previousDoClosing = new Map<string, { closing: number; dayNo: number }>();
  let previousInHand: number | null = null;
  const sortedDays = [...input.days].sort((a, b) => Number(a.dayNo) - Number(b.dayNo));

  for (const day of sortedDays) {
    const dayNo = numberValue(day.dayNo);
    const dayV2Ref = monthV2Ref.collection("days").doc(String(dayNo));
    const doEntries = Array.isArray(day.doEntries) ? day.doEntries as Array<Record<string, unknown>> : [];
    const lifting = day.lifting && typeof day.lifting === "object" ? day.lifting as Record<string, unknown> : {};
    const liftingOpening = numberValue(lifting.openingBalance);
    const liftingMl = numberValue(lifting.mlLifting);
    const todayMlIssuance = numberValue(lifting.todayMlIssuance);
    const liftingInHand = numberValue(lifting.inHandBalance, liftingOpening + liftingMl - todayMlIssuance);

    if (previousInHand !== null && liftingOpening !== previousInHand) {
      issues.push({
        type: "DAY_OPENING_MISMATCH",
        module: "jazzLoad",
        monthId: input.monthId,
        dayNo,
        targetType: "dailyLifting",
        targetId: "inHandBalance",
        expected: previousInHand,
        actual: liftingOpening,
        message: `Jazz Load day ${dayNo} lifting opening does not equal previous day in-hand balance.`
      });
    }

    input.batch.set(dayV2Ref, {
      dayNo,
      module: "jazzLoad",
      status: "verified",
      calculationVersion: LEDGER_CALC_VERSION,
      calcRunId: input.calcRunId,
      recalculatedAt: input.timestamp,
      summary: day.summary ?? {}
    }, { merge: true });

    const rawDocs = [
      {
        id: "lifting-main",
        data: {
          module: "jazzLoad",
          type: "dailyLifting",
          monthId: input.monthId,
          dayNo,
          raw: {
            mlLifting: liftingMl,
            notes: day.notes
          },
          calculated: null,
          meta: {
            updatedAt: input.timestamp,
            updatedBy: input.actorUid,
            status: "verified",
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId
          }
        }
      },
      ...doEntries.map((entry) => ({
        id: `do-${String(entry.id ?? stableId(`${entry.doName}-${entry.doLine}`))}`,
        data: {
          module: "jazzLoad",
          type: "doEntry",
          monthId: input.monthId,
          dayNo,
          raw: {
            doProfileId: entry.doProfileId,
            doNameId: entry.doNameId,
            doLineId: entry.doLineId,
            assignmentId: entry.assignmentId,
            doName: entry.doName,
            doLine: entry.doLine,
            todayMlIssuanceBase: moneyBase(entry.todayMlIssuance),
            paymentReceivedBase: moneyBase(entry.paymentReceived),
            notes: entry.notes
          },
          calculated: null,
          meta: {
            updatedAt: input.timestamp,
            updatedBy: input.actorUid,
            status: "verified",
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId
          }
        }
      }))
    ];
    await replaceCollectionDocs(input.batch, dayV2Ref.collection("rawEntries"), rawDocs);

    const projectionDocs: Array<{ id: string; data: Record<string, unknown> }> = [
      {
        id: "daily-lifting-balance",
        data: {
          module: "jazzLoad",
          type: "dailyLiftingBalance",
          dayNo,
          calculated: {
            opening: liftingOpening,
            lifting: liftingMl,
            issuance: todayMlIssuance,
            closing: liftingInHand
          },
          meta: {
            calculatedAt: input.timestamp,
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId,
            rowHash: [dayNo, liftingOpening, liftingMl, todayMlIssuance, liftingInHand].join("|")
          }
        }
      }
    ];

    doEntries.forEach((entry) => {
      const key = jazzDoKey(entry);
      const opening = moneyBase(entry.openingBalance);
      const issuance = moneyBase(entry.todayMlIssuance);
      const payment = moneyBase(entry.paymentReceived);
      const closing = moneyBase(entry.closingBalance);
      const previous = previousDoClosing.get(key);
      if (previous && opening !== previous.closing) {
        issues.push({
          type: "DAY_OPENING_MISMATCH",
          module: "jazzLoad",
          monthId: input.monthId,
          dayNo,
          targetType: "doEntry",
          targetId: key,
          expected: previous.closing,
          actual: opening,
          message: `${entry.doName ?? key} opening does not equal previous Jazz Load closing.`
        });
      }
      const projectionId = `do-balance-${stableId(key)}`;
      projectionDocs.push({
        id: projectionId,
        data: {
          module: "jazzLoad",
          type: "doBalance",
          dayNo,
          doKey: key,
          doName: entry.doName,
          doLine: entry.doLine,
          rawEntryId: `do-${String(entry.id ?? stableId(`${entry.doName}-${entry.doLine}`))}`,
          calculated: {
            opening,
            issuance,
            payment,
            closing,
            openingMl: moneyCalculated(entry.openingBalance),
            issuanceMl: moneyCalculated(entry.todayMlIssuance),
            paymentMl: moneyCalculated(entry.paymentReceived),
            closingMl: moneyCalculated(entry.closingBalance)
          },
          meta: {
            calculatedAt: input.timestamp,
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId,
            rowHash: [dayNo, key, opening, issuance, payment, closing].join("|")
          }
        }
      });
      previousDoClosing.set(key, { closing, dayNo });
    });
    await replaceCollectionDocs(input.batch, dayV2Ref.collection("projections"), projectionDocs);
    previousInHand = liftingInHand;
  }

  input.batch.set(monthV2Ref.collection("summary").doc("home"), cleanForFirestore({
    ...(input.summary ?? {}),
    module: "jazzLoad",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId: input.calcRunId,
    recalculatedAt: input.timestamp
  }) as FirebaseFirestore.DocumentData, { merge: true });

  await stageLedgerV2CalcRunAndMismatch({
    batch: input.batch,
    auditBatch: input.auditBatch,
    module: "jazzLoad",
    monthId: input.monthId,
    calcRunId: input.calcRunId,
    actorUid: input.actorUid,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    timestamp: input.timestamp,
    rowsRead: sortedDays.length,
    rowsWritten: sortedDays.length,
    issues
  });
  return issues;
}

async function stageStockLedgerV2Projection(input: {
  batch: RefreshWriteTarget;
  auditBatch?: RefreshWriteTarget;
  monthId: string;
  month: Record<string, unknown>;
  days: Array<Record<string, unknown>>;
  summary: Record<string, unknown> | null;
  calcRunId: string;
  actorUid: string;
  actorEmail: string | null;
  actorRole: string;
  timestamp: number;
}) {
  const monthV2Ref = db.collection("ledgerV2").doc("stock").collection("months").doc(input.monthId);
  input.batch.set(monthV2Ref, {
    id: input.monthId,
    module: "stock",
    status: "verified",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId: input.calcRunId,
    updatedAt: input.timestamp
  }, { merge: true });

  const issues: Array<Record<string, unknown>> = [];
  const previousAccountDue = new Map<string, { closing: number; dayNo: number }>();
  const runningStock = new Map<string, number>();
  const openingStock = input.summary?.openingStock && typeof input.summary.openingStock === "object"
    ? input.summary.openingStock as Record<string, unknown>
    : {};
  Object.entries(openingStock).forEach(([productId, value]) => runningStock.set(productId, numberValue(value)));
  const sortedDays = [...input.days].sort((a, b) => Number(a.dayNo) - Number(b.dayNo));

  for (const day of sortedDays) {
    const dayNo = numberValue(day.dayNo);
    const dayV2Ref = monthV2Ref.collection("days").doc(String(dayNo));
    const stockOutEntries = Array.isArray(day.entries)
      ? day.entries as Array<Record<string, unknown>>
      : Array.isArray(day.stockOut)
        ? day.stockOut as Array<Record<string, unknown>>
        : [];
    const stockInEntries = Array.isArray(day.stockIn) ? day.stockIn as Array<Record<string, unknown>> : [];

    input.batch.set(dayV2Ref, {
      dayNo,
      module: "stock",
      status: "verified",
      calculationVersion: LEDGER_CALC_VERSION,
      calcRunId: input.calcRunId,
      recalculatedAt: input.timestamp,
      summary: day.summary ?? {}
    }, { merge: true });

    const rawDocs = [
      ...stockOutEntries.map((entry) => ({
        id: `stock-out-${String(entry.id ?? stableId(entry.accountName))}`,
        data: {
          module: "stock",
          type: "stockOut",
          monthId: input.monthId,
          dayNo,
          raw: {
            accountId: entry.accountId,
            accountName: entry.accountName,
            products: entry.products,
            totalPaymentReceived: entry.totalPaymentReceived,
            notes: entry.notes
          },
          calculated: null,
          meta: {
            updatedAt: input.timestamp,
            updatedBy: input.actorUid,
            status: "verified",
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId
          }
        }
      })),
      ...stockInEntries.map((entry) => ({
        id: `stock-in-${String(entry.id ?? stableId(entry.sourceName))}`,
        data: {
          module: "stock",
          type: "stockIn",
          monthId: input.monthId,
          dayNo,
          raw: {
            sourceName: entry.sourceName,
            stockInMode: entry.stockInMode,
            products: entry.products,
            paidAmount: entry.paidAmount,
            notes: entry.notes
          },
          calculated: null,
          meta: {
            updatedAt: input.timestamp,
            updatedBy: input.actorUid,
            status: "verified",
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId
          }
        }
      }))
    ];
    await replaceCollectionDocs(input.batch, dayV2Ref.collection("rawEntries"), rawDocs);

    const projectionDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
    const dayOpeningStock = new Map(runningStock);
    const productMovements = new Map<string, { productName?: unknown; stockIn: number; stockOut: number }>();
    const addProductMovement = (product: Record<string, unknown>, direction: "stockIn" | "stockOut") => {
      const productId = stockProductKey(product);
      const current = productMovements.get(productId) ?? { productName: product.productName, stockIn: 0, stockOut: 0 };
      current.productName = current.productName ?? product.productName;
      current[direction] += numberValue(product.quantity);
      productMovements.set(productId, current);
    };
    stockOutEntries.forEach((entry) => {
      const accountId = String(entry.accountId ?? stableId(entry.accountName));
      const opening = numberValue(entry.carryForwardBalance);
      const totalAmount = numberValue(entry.totalAmount);
      const payment = numberValue(entry.totalPaymentReceived);
      const closing = numberValue(entry.dueBalance, opening + totalAmount - payment);
      const previous = previousAccountDue.get(accountId);
      if (previous && opening !== previous.closing) {
        issues.push({
          type: "DAY_OPENING_MISMATCH",
          module: "stock",
          monthId: input.monthId,
          dayNo,
          targetType: "stockAccountDue",
          targetId: accountId,
          expected: previous.closing,
          actual: opening,
          message: `${entry.accountName ?? accountId} stock due opening does not equal previous closing.`
        });
      }
      projectionDocs.push({
        id: `account-due-${stableId(accountId)}`,
        data: {
          module: "stock",
          type: "accountDueBalance",
          dayNo,
          accountId,
          accountName: entry.accountName,
          rawEntryId: `stock-out-${String(entry.id ?? stableId(entry.accountName))}`,
          calculated: {
            opening,
            stockOutAmount: totalAmount,
            payment,
            closing
          },
          meta: {
            calculatedAt: input.timestamp,
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId,
            rowHash: [dayNo, accountId, opening, totalAmount, payment, closing].join("|")
          }
        }
      });
      previousAccountDue.set(accountId, { closing, dayNo });

      const products = Array.isArray(entry.products) ? entry.products as Array<Record<string, unknown>> : [];
      products.forEach((product) => {
        addProductMovement(product, "stockOut");
        const productId = stockProductKey(product);
        const current = runningStock.get(productId) ?? 0;
        runningStock.set(productId, current - numberValue(product.quantity));
      });
    });

    stockInEntries.forEach((entry) => {
      const products = Array.isArray(entry.products) ? entry.products as Array<Record<string, unknown>> : [];
      products.forEach((product) => {
        addProductMovement(product, "stockIn");
        const productId = stockProductKey(product);
        const current = runningStock.get(productId) ?? 0;
        runningStock.set(productId, current + numberValue(product.quantity));
      });
    });

    const productIds = new Set([...dayOpeningStock.keys(), ...runningStock.keys(), ...productMovements.keys()]);
    [...productIds].sort().forEach((productId) => {
      const opening = dayOpeningStock.get(productId) ?? 0;
      const movement = productMovements.get(productId) ?? { stockIn: 0, stockOut: 0 };
      const expectedClosing = opening + movement.stockIn - movement.stockOut;
      const closing = runningStock.get(productId) ?? 0;
      if (expectedClosing !== closing) {
        issues.push({
          type: "CLOSING_FORMULA_MISMATCH",
          module: "stock",
          monthId: input.monthId,
          dayNo,
          targetType: "productStockBalance",
          targetId: productId,
          expected: expectedClosing,
          actual: closing,
          message: `${productId} stock closing does not equal opening plus stock-in minus stock-out.`
        });
      }
      projectionDocs.push({
        id: `product-stock-${stableId(productId)}`,
        data: {
          module: "stock",
          type: "productStockBalance",
          dayNo,
          productId,
          productName: movement.productName,
          calculated: {
            opening,
            stockIn: movement.stockIn,
            stockOut: movement.stockOut,
            closing
          },
          meta: {
            calculatedAt: input.timestamp,
            calculationVersion: LEDGER_CALC_VERSION,
            calcRunId: input.calcRunId,
            rowHash: [dayNo, productId, opening, movement.stockIn, movement.stockOut, closing].join("|")
          }
        }
      });
    });
    await replaceCollectionDocs(input.batch, dayV2Ref.collection("projections"), projectionDocs);
  }

  input.batch.set(monthV2Ref.collection("summary").doc("home"), cleanForFirestore({
    ...(input.summary ?? {}),
    module: "stock",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId: input.calcRunId,
    recalculatedAt: input.timestamp
  }) as FirebaseFirestore.DocumentData, { merge: true });

  await stageLedgerV2CalcRunAndMismatch({
    batch: input.batch,
    auditBatch: input.auditBatch,
    module: "stock",
    monthId: input.monthId,
    calcRunId: input.calcRunId,
    actorUid: input.actorUid,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    timestamp: input.timestamp,
    rowsRead: sortedDays.length,
    rowsWritten: sortedDays.length,
    issues
  });
  return issues;
}

async function stageLedgerV2CalcRunAndMismatch(input: {
  batch: RefreshWriteTarget;
  auditBatch?: RefreshWriteTarget;
  module: "jazzLoad" | "stock";
  monthId: string;
  calcRunId: string;
  actorUid: string;
  actorEmail: string | null;
  actorRole: string;
  timestamp: number;
  rowsRead: number;
  rowsWritten: number;
  issues: Array<Record<string, unknown>>;
}) {
  const monthV2Ref = db.collection("ledgerV2").doc(input.module).collection("months").doc(input.monthId);
  input.batch.set(monthV2Ref.collection("calcRuns").doc(input.calcRunId), {
    id: input.calcRunId,
    module: input.module,
    monthId: input.monthId,
    startDay: 1,
    endDay: 31,
    status: input.issues.length ? "failed" : "completed",
    calculationVersion: LEDGER_CALC_VERSION,
    actorUid: input.actorUid,
    actorEmail: input.actorEmail,
    actorRole: input.actorRole,
    rowsRead: input.rowsRead,
    rowsWritten: input.rowsWritten,
    invariantIssueCount: input.issues.length,
    createdAt: input.timestamp,
    completedAt: input.timestamp
  }, { merge: true });

  if (input.issues.length > 0) {
    const mismatchBatch = input.auditBatch ?? input.batch;
    const reportId = `${input.calcRunId}-mismatch`;
    mismatchBatch.set(monthV2Ref.collection("mismatchReports").doc(reportId), cleanForFirestore({
      id: reportId,
      module: input.module,
      monthId: input.monthId,
      calcRunId: input.calcRunId,
      status: "open",
      issues: input.issues,
      createdAt: input.timestamp
    }) as FirebaseFirestore.DocumentData, { merge: true });
    stageUnifiedAudit(mismatchBatch, `${input.calcRunId}-mismatch-audit`, {
      createdAt: input.timestamp,
      module: input.module,
      action: "BALANCE_MISMATCH_DETECTED",
      summary: `Detected ${input.issues.length} ${input.module} balance mismatch${input.issues.length === 1 ? "" : "es"} in ${input.monthId}`,
      actorUid: input.actorUid,
      actorEmail: input.actorEmail,
      actorRole: input.actorRole,
      monthId: input.monthId,
      targetType: "month",
      targetId: input.monthId,
      sourcePath: `ledgerV2/${input.module}/months/${input.monthId}/mismatchReports/${reportId}`,
      after: { issueCount: input.issues.length }
    });
  }
}

export const sendActivityEmailOnAuditCreate = onDocumentCreated(
  {
    document: "months/{monthId}/audit/{auditId}"
  },
  async (event) => {
    const monthId = event.params.monthId;
    const auditId = event.params.auditId;
    const audit = event.data?.data();
    if (!audit) return;
    await sendAuditNotification(monthId, auditId, audit);
  }
);

async function readExpenseMonthDays(monthRef: FirebaseFirestore.DocumentReference) {
  const dayDocs = await monthRef.collection("days").get();
  const days = [];
  for (const dayDoc of dayDocs.docs) {
    const base = dayDoc.data();
    const dayNo = Number(base.dayNo ?? dayDoc.id);
    const mustCheckCreditsSubcollection = !Array.isArray(base.credits) || base.credits.length === 0;
    const [expensesSnap, commissionsSnap, creditsSnap, ownerSnap] = await Promise.all([
      Array.isArray(base.expenses) ? Promise.resolve(null) : dayDoc.ref.collection("expenses").get(),
      Array.isArray(base.commissions) ? Promise.resolve(null) : dayDoc.ref.collection("commissions").get(),
      mustCheckCreditsSubcollection ? dayDoc.ref.collection("credits").get() : Promise.resolve(null),
      Array.isArray(base.ownerBalances) ? Promise.resolve(null) : dayDoc.ref.collection("ownerBalances").get()
    ]);
    const subcollectionCredits = creditsSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as Record<string, unknown>)) ?? [];
    days.push({
      dayNo,
      date: base.date,
      label: base.label,
      notes: base.notes,
      expenses: Array.isArray(base.expenses) ? base.expenses : expensesSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as { id: string; amount: number })) ?? [],
      commissions: Array.isArray(base.commissions) ? base.commissions : commissionsSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as { id: string; amount: number; category: string })) ?? [],
      credits: Array.isArray(base.credits) && base.credits.length > 0 ? base.credits : subcollectionCredits,
      ownerBalances: Array.isArray(base.ownerBalances) ? base.ownerBalances : ownerSnap?.docs.map((d) => ({ id: d.id, ...d.data() } as { id: string; label: string; amount: number })) ?? []
    });
  }
  return days;
}

export const recalculateMonth = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  const actor = await requireOwnerOrAdmin(request, "recalculate Expense ledgers");

  const monthRef = db.collection("months").doc(monthId);
  const monthSnap = await monthRef.get();
  const openingBalance = Number(monthSnap.data()?.openingBalance ?? 0);
  const ownerOpeningBalance = Number(monthSnap.data()?.ownerOpeningBalance ?? 0);
  const days = await readExpenseMonthDays(monthRef);
  let carryForwardSeed: ReturnType<typeof buildExpenseCarryForwardSeed> = null;
  const previousId = previousMonthId(monthId);
  if (previousId) {
    const previousMonthRef = db.collection("months").doc(previousId);
    const previousMonthSnap = await previousMonthRef.get();
    const previousDays = await readExpenseMonthDays(previousMonthRef);
    if (previousMonthSnap.exists || previousDays.length > 0) {
      const previousData = previousMonthSnap.data() ?? {};
      const previousComputed = computeMonth(
        previousDays,
        Number(previousData.openingBalance ?? 0),
        previousId,
        Number(previousData.ownerOpeningBalance ?? 0)
      );
      carryForwardSeed = buildExpenseCarryForwardSeed(previousId, previousComputed);
    }
  }
  const effectiveOpeningBalance = carryForwardSeed?.openingBalance ?? openingBalance;
  const effectiveOwnerOpeningBalance = carryForwardSeed?.ownerOpeningBalance ?? ownerOpeningBalance;
  const computed = computeMonth(days, effectiveOpeningBalance, monthId, effectiveOwnerOpeningBalance, carryForwardSeed ?? undefined);
  const expenseBatch = new ChunkedBatchWriter(`expense:${monthId}:module`);
  const ledgerBatch = new ChunkedBatchWriter(`expense:${monthId}:ledgerV2`);
  const auditBatch = new ChunkedBatchWriter(`expense:${monthId}:audit-mismatch`);
  const inputByDay = new Map(days.map((day) => [day.dayNo, day]));
  for (const day of computed.days) {
    const original = inputByDay.get(day.dayNo);
    const dayRef = monthRef.collection("days").doc(String(day.dayNo));
    const repairedCredits = day.creditRows;
    expenseBatch.set(
      dayRef,
      {
        ...original,
        ...day,
        credits: repairedCredits,
        ownerBalances: day.ownerBalances
      },
      { merge: true }
    );
    const existingCreditsSnap = await dayRef.collection("credits").get();
    const nextCreditIds = new Set(repairedCredits.map((row: { id?: string }) => row.id).filter(Boolean));
    for (const creditDoc of existingCreditsSnap.docs) {
      if (!nextCreditIds.has(creditDoc.id)) expenseBatch.delete(creditDoc.ref);
    }
    for (const credit of repairedCredits) {
      if (!credit.id) continue;
      expenseBatch.set(dayRef.collection("credits").doc(credit.id), credit, { merge: true });
    }
  }
  expenseBatch.set(monthRef.collection("summary").doc("home"), computed.homeSummary, { merge: true });
  expenseBatch.set(monthRef, {
    openingBalance: effectiveOpeningBalance,
    ownerOpeningBalance: effectiveOwnerOpeningBalance,
    updatedAt: Date.now()
  }, { merge: true });
  const createdAt = Date.now();
  const legacyAuditRef = monthRef.collection("audit").doc();
  auditBatch.set(legacyAuditRef, {
    action: "recalculate",
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    createdAt,
    detail: "Recalculated month"
  });

  const auditLogId = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
  const calcRunId = `expense-recalc-${auditLogId}`;
  stageUnifiedAudit(auditBatch, `${calcRunId}-started`, {
    createdAt,
    module: "expense",
    action: "FORWARD_RECALC_STARTED",
    summary: `Started Expense forward recalculation for ${monthId}`,
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/expense/months/${monthId}/calcRuns/${calcRunId}`
  });
  const invariantIssues = await stageExpenseLedgerV2Projection({
    batch: ledgerBatch,
    auditBatch,
    monthId,
    sourceDays: days,
    computedDays: computed.days as unknown as Array<Record<string, unknown>>,
    homeSummary: computed.homeSummary as unknown as Record<string, unknown>,
    calcRunId,
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    timestamp: createdAt
  });
  stageUnifiedAudit(auditBatch, `${calcRunId}-completed`, {
    createdAt,
    module: "expense",
    action: invariantIssues.length > 0 ? "FORWARD_RECALC_FAILED" : "FORWARD_RECALC_COMPLETED",
    summary: invariantIssues.length > 0
      ? `Expense forward recalculation found ${invariantIssues.length} mismatch${invariantIssues.length === 1 ? "" : "es"} in ${monthId}`
      : `Completed Expense forward recalculation for ${monthId}`,
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/expense/months/${monthId}/calcRuns/${calcRunId}`,
    after: {
      invariantIssueCount: invariantIssues.length,
      dayCount: computed.days.length
    }
  });
  auditBatch.set(db.collection("auditLogs").doc(auditLogId), {
    id: auditLogId,
    createdAt,
    module: "expense",
    action: "recalculate",
    summary: `Recalculated month ${monthId}`,
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `months/${monthId}/audit/${legacyAuditRef.id}`
  });

  await commitRefreshWriters(`expense:${monthId}`, [ledgerBatch, expenseBatch, auditBatch]);
  return { ok: true };
});

export const recalculateJazzLoadLedgerV2 = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  const actor = await requireOwnerOrAdmin(request, "recalculate Jazz Load ledger");
  const monthRef = db.collection("jazzLoadMonths").doc(monthId);
  const [monthSnap, ratesSnap] = await Promise.all([
    monthRef.get(),
    db.collection("jazzLoadSettings").doc("rates").collection("items").get()
  ]);
  if (!monthSnap.exists) throw new HttpsError("not-found", `Jazz Load month ${monthId} does not exist.`);

  const rates = ratesSnap.docs.map((docSnap) => docSnap.data());
  const mlRate = activeRateForBackend(rates, "ml_addition");
  if (!mlRate) {
    throw new HttpsError("failed-precondition", "Active Jazz Load Addition Rate is required before recalculating.");
  }
  const activeRates = {
    mlRate,
    commission1Rate: activeRateForBackend(rates, "commission1_adjustment", ["adjustment"]),
    commission2Rate: activeRateForBackend(rates, "commission2_payment", ["commission"])
  };
  const days = await readJazzLoadMonthDays(monthRef);
  const previousId = previousMonthId(monthId);
  let previousMonthDays: Array<Record<string, unknown>> = [];
  let previousMonthSummary: Record<string, unknown> | null = null;
  if (previousId) {
    const previousMonthRef = db.collection("jazzLoadMonths").doc(previousId);
    const [previousDays, previousSummarySnap] = await Promise.all([
      readJazzLoadMonthDays(previousMonthRef),
      previousMonthRef.collection("summary").doc("monthly").get()
    ]);
    previousMonthDays = previousDays;
    previousMonthSummary = previousSummarySnap.exists ? previousSummarySnap.data() ?? null : null;
  }

  const timestamp = Date.now();
  const calcRunId = `jazzload-recalc-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const recalculatedDays = rechainJazzLoadDaysBackend({
    monthId,
    days,
    previousMonthDays,
    previousMonthSummary,
    activeRates,
    actorUid: actor.actorUid,
    timestamp
  });
  const summary = calculateJazzMonthlySummaryBackend(monthId, recalculatedDays, timestamp);
  const nextMonth = {
    ...monthSnap.data(),
    id: monthId,
    closingBalance: summary.totalClosingBase,
    totalMlIssuance: summary.totalIssuanceMl,
    totalPayments: summary.totalPaymentsBase,
    totalLifting: summary.totalLifting,
    totalCommission: summary.totalCommission,
    updatedBy: actor.actorUid,
    updatedAt: timestamp
  };
  const jazzBatch = new ChunkedBatchWriter(`jazzLoad:${monthId}:module`);
  const ledgerBatch = new ChunkedBatchWriter(`jazzLoad:${monthId}:ledgerV2`);
  const auditBatch = new ChunkedBatchWriter(`jazzLoad:${monthId}:audit-mismatch`);
  jazzBatch.set(monthRef, cleanForFirestore(nextMonth) as FirebaseFirestore.DocumentData, { merge: true });
  for (const day of recalculatedDays) {
    const dayNo = numberValue(day.dayNo);
    const dayRef = monthRef.collection("days").doc(String(dayNo));
    jazzBatch.set(dayRef, cleanForFirestore(day) as FirebaseFirestore.DocumentData, { merge: true });
  }
  jazzBatch.set(monthRef.collection("summary").doc("monthly"), cleanForFirestore(summary) as FirebaseFirestore.DocumentData, { merge: true });
  const legacyAuditRef = monthRef.collection("audit").doc();
  auditBatch.set(legacyAuditRef, cleanForFirestore({
    id: legacyAuditRef.id,
    action: "recalculate",
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    targetType: "month",
    targetId: monthId,
    createdAt: timestamp,
    detail: "Recalculated Jazz Load month from backend authoritative chain"
  }) as FirebaseFirestore.DocumentData);
  ledgerBatch.set(db.collection("ledgerV2").doc("jazzLoad").collection("months").doc(monthId), {
    id: monthId,
    module: "jazzLoad",
    status: "verified",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId,
    updatedAt: timestamp
  }, { merge: true });
  await stageLedgerV2CalcRunAndMismatch({
    batch: ledgerBatch,
    auditBatch,
    module: "jazzLoad",
    monthId,
    calcRunId,
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    timestamp,
    rowsRead: days.length,
    rowsWritten: recalculatedDays.length,
    issues: []
  });
  stageUnifiedAudit(auditBatch, `${calcRunId}-started`, {
    createdAt: timestamp,
    module: "jazzLoad",
    action: "FORWARD_RECALC_STARTED",
    summary: `Started Jazz Load authoritative recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/jazzLoad/months/${monthId}/calcRuns/${calcRunId}`
  });
  stageUnifiedAudit(auditBatch, `${calcRunId}-completed`, {
    createdAt: timestamp,
    module: "jazzLoad",
    action: "FORWARD_RECALC_COMPLETED",
    summary: `Completed Jazz Load authoritative recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/jazzLoad/months/${monthId}/calcRuns/${calcRunId}`,
    after: {
      invariantIssueCount: 0,
      dayCount: recalculatedDays.length
    }
  });
  await commitRefreshWriters(`jazzLoad:${monthId}`, [ledgerBatch, jazzBatch, auditBatch]);
  return { ok: true, calcRunId, invariantIssueCount: 0, dayCount: recalculatedDays.length };
});

export const recalculateStockLedgerV2 = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  const actor = await requireOwnerOrAdmin(request, "recalculate Stock ledger");
  const monthRef = db.collection("stockMonths").doc(monthId);
  const previousId = previousMonthId(monthId);
  const [monthSnap, productsSnap, accountsSnap, openingSnap, previousSummarySnap] = await Promise.all([
    monthRef.get(),
    db.collection("stockSettings").doc("products").collection("items").orderBy("displayOrder", "asc").get(),
    db.collection("stockSettings").doc("accounts").collection("items").orderBy("displayOrder", "asc").get(),
    db.collection("stockSettings").doc("opening").collection("items").doc("main").get(),
    previousId ? db.collection("stockMonths").doc(previousId).collection("summary").doc("monthly").get() : Promise.resolve(null)
  ]);
  if (!monthSnap.exists) throw new HttpsError("not-found", `Stock month ${monthId} does not exist.`);

  const timestamp = Date.now();
  const calcRunId = `stock-recalc-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const products = productsSnap.docs.map((docSnap) => docSnap.data());
  const accounts = accountsSnap.docs.map((docSnap) => docSnap.data());
  const previousSummary = previousSummarySnap?.exists ? previousSummarySnap.data() ?? null : null;
  const openingBalances = openingSnap.exists ? openingSnap.data() ?? {} : {};
  const openingStock = previousSummary ? numberMap(previousSummary.closingStock) : numberMap(openingBalances.openingStock);
  const openingJazzPayable = previousSummary ? numberValue(previousSummary.closingJazzPayable) : numberValue(openingBalances.jazzOpeningPayable);
  const days = await readStockMonthDays(monthRef);
  const recalculatedDays = rechainStockDaysBackend({
    monthId,
    days,
    accounts,
    previousSummary,
    actorUid: actor.actorUid,
    timestamp
  });
  const summary = calculateStockMonthlySummaryBackend({
    monthId,
    days: recalculatedDays,
    products,
    openingStock,
    openingJazzPayable,
    timestamp
  });
  const productMovementTotals = new Map<string, { stockIn: number; stockOut: number }>();
  let totalStockInAmount = 0;
  let totalPaidAmount = 0;
  for (const day of recalculatedDays) {
    const entries = Array.isArray(day.entries) ? day.entries as Array<Record<string, unknown>> : [];
    for (const entry of entries) {
      for (const product of Array.isArray(entry.products) ? entry.products as Array<Record<string, unknown>> : []) {
        const productId = stockProductKey(product);
        const current = productMovementTotals.get(productId) ?? { stockIn: 0, stockOut: 0 };
        current.stockOut = numberValue(current.stockOut + numberValue(product.quantity));
        productMovementTotals.set(productId, current);
      }
    }
    const stockIn = Array.isArray(day.stockIn) ? day.stockIn as Array<Record<string, unknown>> : [];
    for (const record of stockIn) {
      totalStockInAmount = numberValue(totalStockInAmount + numberValue(record.totalAmount));
      totalPaidAmount = numberValue(totalPaidAmount + numberValue(record.paidAmount));
      for (const product of Array.isArray(record.products) ? record.products as Array<Record<string, unknown>> : []) {
        const productId = stockProductKey(product);
        const current = productMovementTotals.get(productId) ?? { stockIn: 0, stockOut: 0 };
        current.stockIn = numberValue(current.stockIn + numberValue(product.quantity));
        productMovementTotals.set(productId, current);
      }
    }
  }
  const nextMonth = {
    ...monthSnap.data(),
    id: monthId,
    totalQty: summary.totalQty,
    totalAmount: summary.totalAmount,
    totalPaymentReceived: summary.totalPaymentReceived,
    totalDueBalance: summary.totalDueBalance,
    updatedBy: actor.actorUid,
    updatedAt: timestamp
  };
  const stockBatch = new ChunkedBatchWriter(`stock:${monthId}:module`);
  const ledgerBatch = new ChunkedBatchWriter(`stock:${monthId}:ledgerV2`);
  const auditBatch = new ChunkedBatchWriter(`stock:${monthId}:audit-mismatch`);
  stockBatch.set(monthRef, cleanForFirestore(nextMonth) as FirebaseFirestore.DocumentData, { merge: true });
  for (const day of recalculatedDays) {
    const dayNo = numberValue(day.dayNo);
    const dayRef = monthRef.collection("days").doc(String(dayNo));
    stockBatch.set(dayRef, cleanForFirestore(day) as FirebaseFirestore.DocumentData, { merge: true });
  }
  stockBatch.set(monthRef.collection("summary").doc("monthly"), cleanForFirestore(summary) as FirebaseFirestore.DocumentData, { merge: true });
  Object.entries(summary.closingStock as Record<string, number>).forEach(([productId, currentStock]) => {
    const product = products.find((item) => String(item.id) === productId);
    const movement = productMovementTotals.get(productId) ?? { stockIn: 0, stockOut: 0 };
    stockBatch.set(db.collection("stockBalances").doc("products").collection("items").doc(productId), cleanForFirestore({
      productId,
      productName: product?.name ?? productId,
      openingStock: openingStock[productId] ?? 0,
      totalStockIn: movement.stockIn,
      totalStockOut: movement.stockOut,
      currentStock,
      updatedAt: timestamp
    }) as FirebaseFirestore.DocumentData, { merge: true });
  });
  (summary.accountTotals as Array<Record<string, unknown>>).forEach((account) => {
    const accountId = String(account.accountId ?? "");
    if (!accountId) return;
    stockBatch.set(db.collection("stockBalances").doc("accounts").collection("items").doc(accountId), cleanForFirestore({ ...account, updatedAt: timestamp }) as FirebaseFirestore.DocumentData, { merge: true });
  });
  stockBatch.set(db.collection("stockBalances").doc("jazzCompany").collection("items").doc("main"), cleanForFirestore({
    openingPayable: summary.openingJazzPayable,
    totalStockInAmount,
    totalPaidAmount,
    currentPayable: summary.closingJazzPayable,
    updatedAt: timestamp
  }) as FirebaseFirestore.DocumentData, { merge: true });
  const legacyAuditRef = monthRef.collection("audit").doc();
  auditBatch.set(legacyAuditRef, cleanForFirestore({
    id: legacyAuditRef.id,
    action: "recalculate-month",
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    targetType: "month",
    targetId: monthId,
    createdAt: timestamp,
    detail: "Recalculated Stock month from backend authoritative chain"
  }) as FirebaseFirestore.DocumentData);
  ledgerBatch.set(db.collection("ledgerV2").doc("stock").collection("months").doc(monthId), {
    id: monthId,
    module: "stock",
    status: "verified",
    calculationVersion: LEDGER_CALC_VERSION,
    calcRunId,
    updatedAt: timestamp
  }, { merge: true });
  await stageLedgerV2CalcRunAndMismatch({
    batch: ledgerBatch,
    auditBatch,
    module: "stock",
    monthId,
    calcRunId,
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    actorRole: actor.actorRole,
    timestamp,
    rowsRead: days.length,
    rowsWritten: recalculatedDays.length,
    issues: []
  });
  stageUnifiedAudit(auditBatch, `${calcRunId}-started`, {
    createdAt: timestamp,
    module: "stock",
    action: "FORWARD_RECALC_STARTED",
    summary: `Started Stock authoritative recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/stock/months/${monthId}/calcRuns/${calcRunId}`
  });
  stageUnifiedAudit(auditBatch, `${calcRunId}-completed`, {
    createdAt: timestamp,
    module: "stock",
    action: "FORWARD_RECALC_COMPLETED",
    summary: `Completed Stock authoritative recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/stock/months/${monthId}/calcRuns/${calcRunId}`,
    after: {
      invariantIssueCount: 0,
      dayCount: recalculatedDays.length
    }
  });
  await commitRefreshWriters(`stock:${monthId}`, [ledgerBatch, stockBatch, auditBatch]);
  return { ok: true, calcRunId, invariantIssueCount: 0, dayCount: recalculatedDays.length };
});

export const sendManualActivityEmail = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  const dayNoValue = request.data?.dayNo;
  const dayNo = dayNoValue == null ? undefined : Number(dayNoValue);
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  if (dayNo !== undefined && (!Number.isInteger(dayNo) || dayNo < 1 || dayNo > 32)) {
    throw new HttpsError("invalid-argument", "dayNo must be between 1 and 32");
  }
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required");

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.data() as { role?: string; active?: boolean } | undefined;
  const role = userData?.role === "staff" ? "admin" : userData?.role;
  if (!userData?.active || (role !== "owner" && role !== "admin")) {
    throw new HttpsError("permission-denied", "Owner or admin access is required to send email reports.");
  }

  const createdAt = Date.now();
  const auditId = `manual-email-${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await sendAuditNotification(monthId, auditId, {
    action: dayNo === undefined ? "manual-month" : "manual-day",
    actorUid: request.auth.uid,
    actorEmail: request.auth.token.email ?? null,
    createdAt,
    detail: dayNo === undefined ? `Manual email report for ${monthId}` : `Manual email report for day ${dayNo}`
  });

  const manualAction = dayNo === undefined ? "manual-month" : "manual-day";
  const manualSummary =
    dayNo === undefined ? `Manual email report for ${monthId}` : `Manual email report for day ${dayNo} in ${monthId}`;
  await db.collection("auditLogs").doc(auditId).set({
    id: auditId,
    createdAt,
    module: "system",
    action: "manual-email",
    summary: manualSummary,
    actorUid: request.auth.uid,
    actorEmail: request.auth.token.email ?? null,
    actorRole: role ?? "viewer",
    monthId,
    ...(dayNo !== undefined ? { dayNo, targetType: "day", targetId: String(dayNo) } : { targetType: "month", targetId: monthId })
  });

  if (result.status === "sent") return { ok: true, auditId, smtpMessageId: result.smtpMessageId };
  if (result.status === "skipped") throw new HttpsError("failed-precondition", `Email report was skipped: ${result.reason}`);
  throw new HttpsError("internal", `Email report failed: ${result.error}`);
});

export const getMonthDashboard = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required");

  const monthRef = db.collection("months").doc(monthId);
  const [summarySnap, daySnap] = await Promise.all([
    monthRef.collection("summary").doc("home").get(),
    monthRef.collection("days").orderBy("dayNo", "asc").get()
  ]);
  return {
    days: daySnap.docs.map((doc) => doc.data()),
    homeSummary: summarySnap.exists ? summarySnap.data() : null
  };
});

export const exportMonth = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required");
  const format = String(request.data?.format ?? "json");

  const monthRef = db.collection("months").doc(monthId);
  const [monthSnap, daysSnap, summarySnap] = await Promise.all([
    monthRef.get(),
    monthRef.collection("days").orderBy("dayNo", "asc").get(),
    monthRef.collection("summary").doc("home").get()
  ]);

  const payload = {
    month: monthSnap.data() ?? {},
    days: daysSnap.docs.map((d) => d.data()),
    summary: summarySnap.data() ?? {}
  };

  if (format === "json") return payload;
  if (format === "csv") {
    const lines = ["dayNo,openingBalance,issueBalance,totalBalance,expenseTotal,returnBalance,creditBalance"];
    for (const d of payload.days as Array<Record<string, unknown>>) {
      lines.push(
        [
          d.dayNo,
          d.openingBalance,
          d.issueBalance,
          d.totalBalance,
          d.expenseTotal,
          d.returnBalance,
          (d.creditTotals as { balance?: number } | undefined)?.balance ?? 0
        ].join(",")
      );
    }
    return { csv: lines.join("\n") };
  }
  throw new HttpsError("invalid-argument", "Unsupported format");
});
