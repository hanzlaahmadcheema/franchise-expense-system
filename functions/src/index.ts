import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { computeMonth } from "./formulaEngine";

initializeApp();
const db = getFirestore();

export const recalculateMonth = onCall(async (request) => {
  const monthId = String(request.data?.monthId ?? "");
  if (!monthId) throw new HttpsError("invalid-argument", "monthId is required");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in is required");

  const monthRef = db.collection("months").doc(monthId);
  const monthSnap = await monthRef.get();
  const openingBalance = Number(monthSnap.data()?.openingBalance ?? 0);

  const dayDocs = await monthRef.collection("days").get();
  const days = [];
  for (const dayDoc of dayDocs.docs) {
    const base = dayDoc.data();
    const dayNo = Number(base.dayNo ?? dayDoc.id);
    const [expensesSnap, commissionsSnap, creditsSnap, ownerSnap] = await Promise.all([
      dayDoc.ref.collection("expenses").get(),
      dayDoc.ref.collection("commissions").get(),
      dayDoc.ref.collection("credits").get(),
      dayDoc.ref.collection("ownerBalances").get()
    ]);
    days.push({
      dayNo,
      date: base.date,
      notes: base.notes,
      expenses: expensesSnap.docs.map((d) => d.data() as { amount: number }),
      commissions: commissionsSnap.docs.map((d) => d.data() as { amount: number; category: string }),
      credits: creditsSnap.docs.map((d) => d.data() as { opening: number; today: number; receive: number; partyName: string }),
      ownerBalances: ownerSnap.docs.map((d) => d.data() as { label: string; amount: number })
    });
  }

  const computed = computeMonth(days, openingBalance, monthId);
  const batch = db.batch();
  for (const day of computed.days) {
    batch.set(monthRef.collection("days").doc(String(day.dayNo)), day, { merge: true });
  }
  batch.set(monthRef.collection("summary").doc("home"), computed.homeSummary, { merge: true });
  batch.set(monthRef, { updatedAt: Date.now() }, { merge: true });
  batch.set(monthRef.collection("audit").doc(), {
    action: "recalculate",
    actorUid: request.auth.uid,
    actorEmail: request.auth.token.email ?? null,
    createdAt: Date.now(),
    detail: "Recalculated month"
  });
  await batch.commit();
  return { ok: true };
});

export const getMonthDashboard = onCall(async (request) => {
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

export const exportMonth = onCall(async (request) => {
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
