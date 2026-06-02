import { getFirestore, FieldValue } from "firebase-admin/firestore";
import nodemailer from "nodemailer";
import * as XLSX from "xlsx";
import PDFDocument from "pdfkit";
import { computeMonth } from "./formulaEngine";

type AuditEvent = {
  action?: string;
  actorEmail?: string | null;
  actorUid?: string | null;
  createdAt?: number;
  detail?: string;
};

type NotificationSettings = {
  enabled: boolean;
  sendOnDayClose: boolean;
  sendOnMonthClose: boolean;
  sendOnImport: boolean;
  sendOnRecalculate: boolean;
  sendOnRoleChange: boolean;
};

type NotificationResult =
  | { status: "sent"; smtpMessageId: string | null }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

const defaultSettings: NotificationSettings = {
  enabled: true,
  sendOnDayClose: true,
  sendOnMonthClose: true,
  sendOnImport: false,
  sendOnRecalculate: false,
  sendOnRoleChange: false
};

const actionConfigKey: Record<string, keyof NotificationSettings | null> = {
  "lock-day": "sendOnDayClose",
  "close-month": "sendOnMonthClose",
  import: "sendOnImport",
  recalculate: "sendOnRecalculate",
  "role-change": "sendOnRoleChange",
  "manual-day": "enabled",
  "manual-month": "enabled"
};

function db() {
  return getFirestore();
}

function currency(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(Number.isFinite(value) ? value : 0);
}

function monthLabel(monthId: string) {
  const [yearText, monthText] = monthId.split("-");
  const date = new Date(Number(yearText), Number(monthText) - 1, 1);
  if (Number.isNaN(date.getTime())) return monthId;
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
}

function extractDayNo(event: AuditEvent) {
  const match = String(event.detail ?? "").match(/\bday\s+(\d{1,2})\b/i);
  return match ? Number(match[1]) : undefined;
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadSettings(): Promise<NotificationSettings> {
  const snap = await db().doc("settings/notifications/config/default").get();
  return { ...defaultSettings, ...(snap.exists ? snap.data() : {}) } as NotificationSettings;
}

async function loadOwnerRecipients() {
  const snap = await db().collection("authorizedEmails").where("role", "==", "owner").where("active", "==", true).get();
  return snap.docs.map((doc) => String(doc.data().email ?? doc.id)).filter((email) => email.includes("@"));
}

async function loadMonthReport(monthId: string) {
  const monthRef = db().collection("months").doc(monthId);
  const [monthSnap, daySnap] = await Promise.all([
    monthRef.get(),
    monthRef.collection("days").orderBy("dayNo", "asc").get()
  ]);
  const month = monthSnap.data() ?? {};
  const ownerOpeningBalance = Number(month.ownerOpeningBalance ?? 0);
  const days = [];
  for (const dayDoc of daySnap.docs) {
    const base = dayDoc.data();
    const [expensesSnap, commissionsSnap, creditsSnap, ownerSnap] = await Promise.all([
      dayDoc.ref.collection("expenses").get(),
      dayDoc.ref.collection("commissions").get(),
      dayDoc.ref.collection("credits").get(),
      dayDoc.ref.collection("ownerBalances").get()
    ]);
    days.push({
      ...base,
      dayNo: Number(base.dayNo ?? dayDoc.id),
      expenses: expensesSnap.docs.map((doc) => doc.data()),
      commissions: commissionsSnap.docs.map((doc) => doc.data()),
      credits: creditsSnap.docs.map((doc) => doc.data()),
      ownerBalances: ownerSnap.docs.map((doc) => doc.data())
    });
  }
  return {
    month,
    computed: computeMonth(days as Parameters<typeof computeMonth>[0], Number(month.openingBalance ?? 0), monthId, ownerOpeningBalance)
  };
}

function buildWorkbook(monthId: string, report: Awaited<ReturnType<typeof loadMonthReport>>, focusDay?: number) {
  const workbook = XLSX.utils.book_new();
  const { computed } = report;
  const dayRows = focusDay ? computed.homeSummary.dayRows.filter((row) => row.dayNo === focusDay) : computed.homeSummary.dayRows;
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Month", monthLabel(monthId)],
      ["Opening Balance", computed.openingBalance],
      ["Monthly Issue Total", computed.homeSummary.monthlyIssueTotal],
      ["Monthly Expense Total", computed.homeSummary.monthlyExpenseTotal],
      ["Final Balance", computed.homeSummary.monthlyReturnBalance],
      ["Owner Balance Total", computed.homeSummary.ownerBalanceTotal],
      ["Credit Balance Total", computed.homeSummary.creditBalanceTotal],
      [],
      ["Day", "Date", "Opening", "Issue", "Total", "Expense", "Balance", "Credit Balance"],
      ...dayRows.map((row) => [
        row.label ?? row.dayNo,
        row.date ?? "",
        row.openingBalance,
        row.issueBalance,
        row.totalBalance,
        row.expenseTotal,
        row.returnBalance,
        row.creditBalance
      ])
    ]),
    "Dashboard"
  );
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(computed.homeSummary.expenseByCategory), "Expenses");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(computed.homeSummary.creditPartyBalances), "Credit Parties");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(computed.homeSummary.commissionMatrix), "Commissions");
  return XLSX.write(workbook, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

function buildPdf(monthId: string, report: Awaited<ReturnType<typeof loadMonthReport>>, event: AuditEvent, focusDay?: number) {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: 42, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const { computed } = report;
    const rows = focusDay ? computed.homeSummary.dayRows.filter((row) => row.dayNo === focusDay) : computed.homeSummary.dayRows;
    doc.fontSize(18).text("Jazz Franchise 7301", { continued: false });
    doc.fontSize(13).fillColor("#334155").text(`${monthLabel(monthId)} Activity Report`);
    doc.moveDown();
    doc.fillColor("#111827").fontSize(10).text(`Activity: ${event.detail ?? event.action ?? "Ledger activity"}`);
    doc.text(`Actor: ${event.actorEmail ?? event.actorUid ?? "Unknown"}`);
    doc.text(`Timestamp: ${event.createdAt ? new Date(event.createdAt).toISOString() : new Date().toISOString()}`);
    doc.moveDown();
    doc.fontSize(12).text("Key Totals", { underline: true });
    [
      ["Opening Balance", computed.openingBalance],
      ["Monthly Issue Total", computed.homeSummary.monthlyIssueTotal],
      ["Monthly Expense Total", computed.homeSummary.monthlyExpenseTotal],
      ["Final Balance", computed.homeSummary.monthlyReturnBalance],
      ["Owner Balance Total", computed.homeSummary.ownerBalanceTotal],
      ["Credit Balance Total", computed.homeSummary.creditBalanceTotal]
    ].forEach(([label, value]) => doc.fontSize(10).text(`${label}: ${currency(Number(value))}`));
    doc.moveDown();
    doc.fontSize(12).text(focusDay ? `Day ${focusDay} Snapshot` : "Month Day Rows", { underline: true });
    rows.slice(0, 34).forEach((row) => {
      doc.fontSize(9).text(
        `${row.label ?? `Day ${row.dayNo}`}: opening ${currency(row.openingBalance)}, issue ${currency(row.issueBalance)}, expense ${currency(row.expenseTotal)}, balance ${currency(row.returnBalance)}, credit ${currency(row.creditBalance)}`
      );
    });
    doc.end();
  });
}

function renderHtml(monthId: string, report: Awaited<ReturnType<typeof loadMonthReport>>, event: AuditEvent, focusDay?: number) {
  const { computed } = report;
  const title =
    event.action === "manual-day" && focusDay
      ? `Day ${focusDay} Report`
      : event.action === "manual-month"
        ? `${monthLabel(monthId)} Report`
        : focusDay
          ? `Day ${focusDay} Closed`
          : event.action === "close-month"
            ? `${monthLabel(monthId)} Month Closed`
            : "Ledger Activity";
  const actor = event.actorEmail ?? event.actorUid ?? "Unknown";
  const detail = event.detail ?? "Ledger activity was recorded.";
  const cards = [
    ["Issue", computed.homeSummary.monthlyIssueTotal],
    ["Expense", computed.homeSummary.monthlyExpenseTotal],
    ["Final Balance", computed.homeSummary.monthlyReturnBalance],
    ["Credit Balance", computed.homeSummary.creditBalanceTotal]
  ];
  return `
    <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
      <div style="max-width:720px;margin:auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        <div style="background:#064e3b;color:#fff;padding:18px 22px">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em">Jazz Franchise 7301</div>
          <h1 style="margin:6px 0 0;font-size:22px">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:22px">
          <p style="margin-top:0">${escapeHtml(detail)}</p>
          <p><strong>Month:</strong> ${escapeHtml(monthLabel(monthId))}${focusDay ? ` · <strong>Day:</strong> ${focusDay}` : ""}</p>
          <p><strong>Actor:</strong> ${escapeHtml(actor)}<br/><strong>Time:</strong> ${escapeHtml(event.createdAt ? new Date(event.createdAt).toLocaleString("en") : new Date().toLocaleString("en"))}</p>
          <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:18px 0">
            ${cards.map(([label, value]) => `<div style="border:1px solid #e2e8f0;border-radius:8px;padding:12px"><div style="font-size:12px;color:#64748b">${label}</div><div style="font-size:20px;font-weight:700">${currency(Number(value))}</div></div>`).join("")}
          </div>
          <p style="color:#475569">Excel and PDF reports are attached to this notification.</p>
        </div>
      </div>
    </div>
  `;
}

function subjectFor(monthId: string, event: AuditEvent, focusDay?: number) {
  if (event.action === "manual-day" && focusDay) return `Day ${focusDay} Report - Jazz Franchise 7301`;
  if (event.action === "manual-month") return `${monthLabel(monthId)} Report - Jazz Franchise 7301`;
  if (event.action === "lock-day" && focusDay) return `Day ${focusDay} Closed - Jazz Franchise 7301`;
  if (event.action === "close-month") return `${monthLabel(monthId)} Month Closed - Jazz Franchise 7301`;
  return `${monthLabel(monthId)} Ledger Activity - Jazz Franchise 7301`;
}

export async function sendAuditNotification(
  monthId: string,
  auditId: string,
  event: AuditEvent,
  deliveryConfig?: { user?: string; appPassword?: string }
): Promise<NotificationResult> {
  const action = String(event.action ?? "");
  const settingKey = actionConfigKey[action];
  if (!settingKey) return { status: "skipped", reason: "unsupported-action" };

  const logRef = db().collection("notificationLogs").doc(`${monthId}_${auditId}`);
  const createResult = await logRef.create({
    monthId,
    auditId,
    action,
    status: "started",
    createdAt: FieldValue.serverTimestamp()
  }).catch((error: { code?: number | string }) => {
    if (error.code === 6 || error.code === "already-exists") return null;
    throw error;
  });
  if (!createResult) return { status: "skipped", reason: "duplicate" };

  try {
    const settings = await loadSettings();
    if (!settings.enabled || !settings[settingKey]) {
      await logRef.set({ status: "skipped", reason: "disabled", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { status: "skipped", reason: "disabled" };
    }

    const recipients = await loadOwnerRecipients();
    if (recipients.length === 0) {
      await logRef.set({ status: "skipped", reason: "no-active-owner-recipients", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return { status: "skipped", reason: "no-active-owner-recipients" };
    }

    const user = deliveryConfig?.user ?? process.env.GMAIL_SMTP_USER;
    const appPassword = deliveryConfig?.appPassword ?? process.env.GMAIL_SMTP_APP_PASSWORD;
    if (!user || !appPassword) throw new Error("GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD are required.");

    const report = await loadMonthReport(monthId);
    const focusDay = action === "lock-day" ? extractDayNo(event) : undefined;
    const [xlsx, pdf] = await Promise.all([
      Promise.resolve(buildWorkbook(monthId, report, focusDay)),
      buildPdf(monthId, report, event, focusDay)
    ]);
    const transport = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        user,
        pass: appPassword
      }
    });
    const response = await transport.sendMail({
      from: user,
      to: recipients,
      subject: subjectFor(monthId, event, focusDay),
      html: renderHtml(monthId, report, event, focusDay),
      attachments: [
        { filename: `${monthId}${focusDay ? `-day-${focusDay}` : ""}-report.xlsx`, content: xlsx },
        { filename: `${monthId}${focusDay ? `-day-${focusDay}` : ""}-report.pdf`, content: pdf }
      ]
    });
    await logRef.set({
      status: "sent",
      recipients,
      smtpMessageId: response.messageId ?? null,
      sentAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { status: "sent", smtpMessageId: response.messageId ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await logRef.set({
      status: "failed",
      error: message,
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return { status: "failed", error: message };
  }
}
