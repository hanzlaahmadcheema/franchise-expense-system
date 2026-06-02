import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError, type CallableRequest } from "firebase-functions/v2/https";
import { buildExpenseCarryForwardSeed, computeMonth } from "./formulaEngine";
import { sendAuditNotification } from "./notifications";

initializeApp();
const db = getFirestore();
const LEDGER_CALC_VERSION = 2;
const callableOptions = {
  cors: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://franchise-expense-system.web.app",
    "https://franchise-expense-system.firebaseapp.com"
  ]
};

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
  batch: FirebaseFirestore.WriteBatch,
  id: string,
  data: Record<string, unknown>
) {
  batch.set(db.collection("auditLogs").doc(id), cleanForFirestore({ id, ...data }) as FirebaseFirestore.DocumentData);
}

async function stageExpenseLedgerV2Projection(input: {
  batch: FirebaseFirestore.WriteBatch;
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
    input.batch.set(monthV2Ref.collection("mismatchReports").doc(reportId), cleanForFirestore({
      id: reportId,
      module: "expense",
      monthId: input.monthId,
      calcRunId: input.calcRunId,
      status: "open",
      issues,
      createdAt: input.timestamp
    }) as FirebaseFirestore.DocumentData, { merge: true });
    stageUnifiedAudit(input.batch, `${input.calcRunId}-mismatch-audit`, {
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

async function replaceCollectionDocs(
  batch: FirebaseFirestore.WriteBatch,
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

async function stageJazzLoadLedgerV2Projection(input: {
  batch: FirebaseFirestore.WriteBatch;
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
  batch: FirebaseFirestore.WriteBatch;
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
  batch: FirebaseFirestore.WriteBatch;
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
    const reportId = `${input.calcRunId}-mismatch`;
    input.batch.set(monthV2Ref.collection("mismatchReports").doc(reportId), cleanForFirestore({
      id: reportId,
      module: input.module,
      monthId: input.monthId,
      calcRunId: input.calcRunId,
      status: "open",
      issues: input.issues,
      createdAt: input.timestamp
    }) as FirebaseFirestore.DocumentData, { merge: true });
    stageUnifiedAudit(input.batch, `${input.calcRunId}-mismatch-audit`, {
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
  const batch = db.batch();
  const inputByDay = new Map(days.map((day) => [day.dayNo, day]));
  for (const day of computed.days) {
    const original = inputByDay.get(day.dayNo);
    const dayRef = monthRef.collection("days").doc(String(day.dayNo));
    const repairedCredits = day.creditRows;
    batch.set(
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
      if (!nextCreditIds.has(creditDoc.id)) batch.delete(creditDoc.ref);
    }
    for (const credit of repairedCredits) {
      if (!credit.id) continue;
      batch.set(dayRef.collection("credits").doc(credit.id), credit, { merge: true });
    }
  }
  batch.set(monthRef.collection("summary").doc("home"), computed.homeSummary, { merge: true });
  batch.set(monthRef, {
    openingBalance: effectiveOpeningBalance,
    ownerOpeningBalance: effectiveOwnerOpeningBalance,
    updatedAt: Date.now()
  }, { merge: true });
  const createdAt = Date.now();
  const legacyAuditRef = monthRef.collection("audit").doc();
  batch.set(legacyAuditRef, {
    action: "recalculate",
    actorUid: actor.actorUid,
    actorEmail: actor.actorEmail,
    createdAt,
    detail: "Recalculated month"
  });

  const auditLogId = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
  const calcRunId = `expense-recalc-${auditLogId}`;
  stageUnifiedAudit(batch, `${calcRunId}-started`, {
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
    batch,
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
  stageUnifiedAudit(batch, `${calcRunId}-completed`, {
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
  batch.set(db.collection("auditLogs").doc(auditLogId), {
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

  await batch.commit();
  return { ok: true };
});

export const recalculateJazzLoadLedgerV2 = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  const actor = await requireOwnerOrAdmin(request, "recalculate Jazz Load ledger projections");
  const monthRef = db.collection("jazzLoadMonths").doc(monthId);
  const [monthSnap, daysSnap, summarySnap] = await Promise.all([
    monthRef.get(),
    monthRef.collection("days").get(),
    monthRef.collection("summary").doc("monthly").get()
  ]);
  if (!monthSnap.exists) throw new HttpsError("not-found", `Jazz Load month ${monthId} does not exist.`);

  const days: Array<Record<string, unknown>> = [];
  for (const dayDoc of daysSnap.docs) {
    const base = dayDoc.data();
    const doEntriesSnap = Array.isArray(base.doEntries) ? null : await dayDoc.ref.collection("doEntries").get();
    days.push({
      ...base,
      id: dayDoc.id,
      dayNo: numberValue(base.dayNo, numberValue(dayDoc.id)),
      doEntries: Array.isArray(base.doEntries)
        ? base.doEntries
        : doEntriesSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? []
    });
  }

  const timestamp = Date.now();
  const calcRunId = `jazzload-recalc-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const batch = db.batch();
  stageUnifiedAudit(batch, `${calcRunId}-started`, {
    createdAt: timestamp,
    module: "jazzLoad",
    action: "FORWARD_RECALC_STARTED",
    summary: `Started Jazz Load v2 projection recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/jazzLoad/months/${monthId}/calcRuns/${calcRunId}`
  });
  const issues = await stageJazzLoadLedgerV2Projection({
    batch,
    monthId,
    month: monthSnap.data() ?? {},
    days,
    summary: summarySnap.exists ? summarySnap.data() ?? {} : null,
    calcRunId,
    ...actor,
    timestamp
  });
  stageUnifiedAudit(batch, `${calcRunId}-completed`, {
    createdAt: timestamp,
    module: "jazzLoad",
    action: issues.length ? "FORWARD_RECALC_FAILED" : "FORWARD_RECALC_COMPLETED",
    summary: issues.length
      ? `Jazz Load v2 projection found ${issues.length} mismatch${issues.length === 1 ? "" : "es"} in ${monthId}`
      : `Completed Jazz Load v2 projection recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/jazzLoad/months/${monthId}/calcRuns/${calcRunId}`,
    after: {
      invariantIssueCount: issues.length,
      dayCount: days.length
    }
  });
  await batch.commit();
  return { ok: true, calcRunId, invariantIssueCount: issues.length };
});

export const recalculateStockLedgerV2 = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  const actor = await requireOwnerOrAdmin(request, "recalculate Stock ledger projections");
  const monthRef = db.collection("stockMonths").doc(monthId);
  const [monthSnap, daysSnap, summarySnap] = await Promise.all([
    monthRef.get(),
    monthRef.collection("days").get(),
    monthRef.collection("summary").doc("monthly").get()
  ]);
  if (!monthSnap.exists) throw new HttpsError("not-found", `Stock month ${monthId} does not exist.`);

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
      : entriesSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? [];
    days.push({
      ...base,
      id: dayDoc.id,
      dayNo: numberValue(base.dayNo, numberValue(dayDoc.id)),
      entries,
      stockOut: Array.isArray(base.stockOut)
        ? base.stockOut
        : stockOutSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? entries,
      stockIn: Array.isArray(base.stockIn)
        ? base.stockIn
        : stockInSnap?.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() })) ?? []
    });
  }

  const timestamp = Date.now();
  const calcRunId = `stock-recalc-${timestamp}-${Math.random().toString(36).slice(2, 8)}`;
  const batch = db.batch();
  stageUnifiedAudit(batch, `${calcRunId}-started`, {
    createdAt: timestamp,
    module: "stock",
    action: "FORWARD_RECALC_STARTED",
    summary: `Started Stock v2 projection recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/stock/months/${monthId}/calcRuns/${calcRunId}`
  });
  const issues = await stageStockLedgerV2Projection({
    batch,
    monthId,
    month: monthSnap.data() ?? {},
    days,
    summary: summarySnap.exists ? summarySnap.data() ?? {} : null,
    calcRunId,
    ...actor,
    timestamp
  });
  stageUnifiedAudit(batch, `${calcRunId}-completed`, {
    createdAt: timestamp,
    module: "stock",
    action: issues.length ? "FORWARD_RECALC_FAILED" : "FORWARD_RECALC_COMPLETED",
    summary: issues.length
      ? `Stock v2 projection found ${issues.length} mismatch${issues.length === 1 ? "" : "es"} in ${monthId}`
      : `Completed Stock v2 projection recalculation for ${monthId}`,
    ...actor,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `ledgerV2/stock/months/${monthId}/calcRuns/${calcRunId}`,
    after: {
      invariantIssueCount: issues.length,
      dayCount: days.length
    }
  });
  await batch.commit();
  return { ok: true, calcRunId, invariantIssueCount: issues.length };
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
