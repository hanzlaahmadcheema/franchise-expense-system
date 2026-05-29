import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { computeMonth } from "./formulaEngine";
import { sendAuditNotification } from "./notifications";

initializeApp();
const db = getFirestore();
const callableOptions = {
  cors: [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://franchise-expense-system.web.app",
    "https://franchise-expense-system.firebaseapp.com"
  ]
};

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

export const recalculateMonth = onCall(callableOptions, async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required");

  const monthRef = db.collection("months").doc(monthId);
  const monthSnap = await monthRef.get();
  const openingBalance = Number(monthSnap.data()?.openingBalance ?? 0);
  const ownerOpeningBalance = Number(monthSnap.data()?.ownerOpeningBalance ?? 0);

  const dayDocs = await monthRef.collection("days").get();
  const days = [];
  for (const dayDoc of dayDocs.docs) {
    const base = dayDoc.data();
    const dayNo = Number(base.dayNo ?? dayDoc.id);
    const [expensesSnap, commissionsSnap, creditsSnap, ownerSnap] = await Promise.all([
      Array.isArray(base.expenses) ? Promise.resolve(null) : dayDoc.ref.collection("expenses").get(),
      Array.isArray(base.commissions) ? Promise.resolve(null) : dayDoc.ref.collection("commissions").get(),
      Array.isArray(base.credits) ? Promise.resolve(null) : dayDoc.ref.collection("credits").get(),
      Array.isArray(base.ownerBalances) ? Promise.resolve(null) : dayDoc.ref.collection("ownerBalances").get()
    ]);
    days.push({
      dayNo,
      date: base.date,
      label: base.label,
      notes: base.notes,
      expenses: Array.isArray(base.expenses) ? base.expenses : expensesSnap?.docs.map((d) => d.data() as { amount: number }) ?? [],
      commissions: Array.isArray(base.commissions) ? base.commissions : commissionsSnap?.docs.map((d) => d.data() as { amount: number; category: string }) ?? [],
      credits: Array.isArray(base.credits) ? base.credits : creditsSnap?.docs.map((d) => d.data() as { opening: number; today: number; receive: number; partyName: string }) ?? [],
      ownerBalances: Array.isArray(base.ownerBalances) ? base.ownerBalances : ownerSnap?.docs.map((d) => d.data() as { label: string; amount: number }) ?? []
    });
  }

  const computed = computeMonth(days, openingBalance, monthId, ownerOpeningBalance);
  const batch = db.batch();
  for (const day of computed.days) {
    batch.set(monthRef.collection("days").doc(String(day.dayNo)), day, { merge: true });
  }
  batch.set(monthRef.collection("summary").doc("home"), computed.homeSummary, { merge: true });
  batch.set(monthRef, { updatedAt: Date.now() }, { merge: true });
  const createdAt = Date.now();
  const legacyAuditRef = monthRef.collection("audit").doc();
  batch.set(legacyAuditRef, {
    action: "recalculate",
    actorUid: request.auth.uid,
    actorEmail: request.auth.token.email ?? null,
    createdAt,
    detail: "Recalculated month"
  });

  const userSnap = await db.collection("users").doc(request.auth.uid).get();
  const userData = userSnap.data() as { role?: string } | undefined;
  const actorRole = userData?.role === "staff" ? "admin" : (userData?.role ?? "viewer");
  const auditLogId = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
  batch.set(db.collection("auditLogs").doc(auditLogId), {
    id: auditLogId,
    createdAt,
    module: "expense",
    action: "recalculate",
    summary: `Recalculated month ${monthId}`,
    actorUid: request.auth.uid,
    actorEmail: request.auth.token.email ?? null,
    actorRole,
    monthId,
    targetType: "month",
    targetId: monthId,
    sourcePath: `months/${monthId}/audit/${legacyAuditRef.id}`
  });

  await batch.commit();
  return { ok: true };
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
