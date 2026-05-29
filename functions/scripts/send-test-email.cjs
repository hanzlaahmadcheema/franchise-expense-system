#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

const root = path.resolve(__dirname, "..");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadEnvFile(path.join(root, ".env.franchise-expense-system"));
  loadEnvFile(path.join(root, ".env"));

  const user = process.env.GMAIL_SMTP_USER;
  const appPassword = process.env.GMAIL_SMTP_APP_PASSWORD;
  const to = "raza.olakh@gmail.com";
  const verifyOnly = process.argv.includes("--verify-only");

  if (!user || !appPassword) {
    throw new Error("GMAIL_SMTP_USER and GMAIL_SMTP_APP_PASSWORD are required.");
  }
  if (!to) {
    throw new Error("Recipient is required. Pass --to email@example.com.");
  }

  const transport = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user,
      pass: appPassword
    }
  });

  await transport.verify();
  console.log(`SMTP login verified for ${user}.`);

  if (verifyOnly) return;

  const response = await transport.sendMail({
    from: user,
    to,
    subject: "Franchise Gmail SMTP Test",
    html: `
      <div style="font-family:Arial,sans-serif">
        <h2>Franchise Gmail SMTP Test</h2>
        <p>This message was sent by <code>functions/scripts/send-test-email.cjs</code>.</p>
        <p>If this arrived, Gmail SMTP credentials and outbound network access are working outside Firebase Functions.</p>
      </div>
    `,
    attachments: [
      {
        filename: "smtp-test.txt",
        content: `SMTP test sent at ${new Date().toISOString()}\n`
      }
    ]
  });

  console.log(`Email sent to ${to}.`);
  console.log(`SMTP message id: ${response.messageId ?? "not returned"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
