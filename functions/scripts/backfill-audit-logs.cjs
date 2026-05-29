/**
 * One-off backfill: copy legacy month/jazz/settings audit docs into auditLogs.
 *
 * Usage (from functions/):
 *   GOOGLE_APPLICATION_CREDENTIALS=... node scripts/backfill-audit-logs.cjs
 */
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

function newId(createdAt) {
  return `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
}

function mapExpenseAction(action) {
  if (action === "role-change") return { module: "auth", action };
  return { module: "expense", action };
}

async function backfillCollection(query, mapper) {
  const snap = await query.get();
  let written = 0;
  let skipped = 0;
  for (const docSnap of snap.docs) {
    const payload = mapper(docSnap);
    if (!payload) {
      skipped += 1;
      continue;
    }
    const existing = await db
      .collection("auditLogs")
      .where("sourcePath", "==", payload.sourcePath)
      .limit(1)
      .get();
    if (!existing.empty) {
      skipped += 1;
      continue;
    }
    await db.collection("auditLogs").doc(payload.id).set(payload);
    written += 1;
  }
  return { written, skipped, total: snap.size };
}

async function main() {
  const monthSnap = await db.collection("months").get();
  let expenseWritten = 0;
  let expenseSkipped = 0;
  for (const monthDoc of monthSnap.docs) {
    const auditSnap = await monthDoc.ref.collection("audit").get();
    for (const auditDoc of auditSnap.docs) {
      const data = auditDoc.data();
      const createdAt = Number(data.createdAt ?? Date.now());
      const sourcePath = `months/${monthDoc.id}/audit/${auditDoc.id}`;
      const mapped = mapExpenseAction(String(data.action ?? "unknown"));
      const payload = {
        id: newId(createdAt),
        createdAt,
        module: mapped.module,
        action: mapped.action,
        summary: String(data.detail ?? data.action ?? "Legacy audit event"),
        actorUid: String(data.actorUid ?? "unknown"),
        actorEmail: data.actorEmail ?? null,
        actorRole: "viewer",
        monthId: monthDoc.id,
        sourcePath
      };
      const existing = await db.collection("auditLogs").where("sourcePath", "==", sourcePath).limit(1).get();
      if (!existing.empty) {
        expenseSkipped += 1;
        continue;
      }
      await db.collection("auditLogs").doc(payload.id).set(payload);
      expenseWritten += 1;
    }
  }

  const jazzMonthSnap = await db.collection("jazzLoadMonths").get();
  let jazzWritten = 0;
  let jazzSkipped = 0;
  for (const monthDoc of jazzMonthSnap.docs) {
    const auditSnap = await monthDoc.ref.collection("audit").get();
    for (const auditDoc of auditSnap.docs) {
      const data = auditDoc.data();
      const createdAt = Number(data.createdAt ?? Date.now());
      const sourcePath = `jazzLoadMonths/${monthDoc.id}/audit/${auditDoc.id}`;
      const existing = await db.collection("auditLogs").where("sourcePath", "==", sourcePath).limit(1).get();
      if (!existing.empty) {
        jazzSkipped += 1;
        continue;
      }
      const action = String(data.action ?? "save-day");
      const payload = {
        id: newId(createdAt),
        createdAt,
        module: "jazzLoad",
        action: action === "assign-do-line" ? "do-assignment" : action,
        summary: `${action} on ${data.targetType ?? "record"} ${data.targetId ?? ""}`.trim(),
        actorUid: String(data.userId ?? data.actorUid ?? "unknown"),
        actorEmail: data.userEmail ?? data.actorEmail ?? null,
        actorRole: data.userRole === "staff" ? "admin" : (data.userRole ?? "viewer"),
        monthId: monthDoc.id,
        sourcePath
      };
      await db.collection("auditLogs").doc(payload.id).set(payload);
      jazzWritten += 1;
    }
  }

  const settingsAudit = await backfillCollection(db.collection("jazzLoadSettings").doc("audit").collection("items"), (docSnap) => {
    const data = docSnap.data();
    const createdAt = Number(data.createdAt ?? Date.now());
    const sourcePath = `jazzLoadSettings/audit/items/${docSnap.id}`;
    const actionName = String(data.action ?? "jazz-do-change");
    const unifiedAction = actionName.includes("rate") || actionName.includes("commission")
      ? "jazz-rate-change"
      : "jazz-do-change";
    return {
      id: newId(createdAt),
      createdAt,
      module: "settings",
      action: unifiedAction,
      summary: `${actionName} on ${data.targetType ?? "settings"} ${data.targetId ?? ""}`.trim(),
      actorUid: String(data.userId ?? "unknown"),
      actorEmail: data.userEmail ?? null,
      actorRole: data.userRole === "staff" ? "admin" : (data.userRole ?? "viewer"),
      targetType: data.targetType,
      targetId: data.targetId,
      sourcePath
    };
  });

  console.log(
    JSON.stringify(
      {
        expense: { written: expenseWritten, skipped: expenseSkipped },
        jazzLoad: { written: jazzWritten, skipped: jazzSkipped },
        settings: settingsAudit
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
