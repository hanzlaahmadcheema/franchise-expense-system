import fs from "fs";
import path from "path";

function parseCsv(filePath: string): Record<string, string>[] {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const parsedRows: string[][] = [];

  for (let l = 0; l < lines.length; l++) {
    const rawLine = lines[l];
    if (!rawLine.trim() && l === lines.length - 1) continue;
    if (!rawLine.trim() && l > 0 && lines[l - 1].trim()) continue;

    const row: string[] = [];
    let insideQuote = false;
    let field = "";

    for (let i = 0; i < rawLine.length; i++) {
      const char = rawLine[i];
      if (char === '"') {
        if (insideQuote && rawLine[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          insideQuote = !insideQuote;
        }
      } else if (char === "," && !insideQuote) {
        row.push(field);
        field = "";
      } else {
        field += char;
      }
    }
    row.push(field);
    parsedRows.push(row);
  }

  if (parsedRows.length === 0) return [];
  const headers = parsedRows[0].map((h) => h.trim().replace(/^\ufeff/, ""));

  return parsedRows.slice(1).map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (row[i] || "").trim();
    });
    return obj;
  });
}

const csvPath = "/home/hanzlaahmad/PersonalProjects/Franchise/data/september/load/distributor_transactions_inputs.csv";
const rows = parseCsv(csvPath);

let totalIssuance = 0;
let totalPayment = 0;
let day1Iss = 0;
let day1Pay = 0;

const dailyStats = new Map<number, { count: number; iss: number; pay: number }>();
const doStats = new Map<string, { iss: number; pay: number; count: number }>();

for (const r of rows) {
  const dayNo = parseInt(r.sheet, 10);
  const iss = parseFloat(r.issuance_amount) || 0;
  const pay = parseFloat(r.payment_received_amount) || 0;

  totalIssuance += iss;
  totalPayment += pay;

  if (dayNo === 1) {
    day1Iss += iss;
    day1Pay += pay;
  }

  if (!dailyStats.has(dayNo)) dailyStats.set(dayNo, { count: 0, iss: 0, pay: 0 });
  const d = dailyStats.get(dayNo)!;
  d.count++;
  d.iss += iss;
  d.pay += pay;

  const doKey = `${r.s_no} - ${r.do_name}`;
  if (!doStats.has(doKey)) doStats.set(doKey, { count: 0, iss: 0, pay: 0 });
  const dos = doStats.get(doKey)!;
  dos.count++;
  dos.iss += iss;
  dos.pay += pay;
}

console.log("=== DISTRIBUTOR TRANSACTIONS SUMMARY ===");
console.log(`Total Rows: ${rows.length}`);
console.log(`Total Issuance Base: ${totalIssuance.toLocaleString()} PKR`);
console.log(`Total Payment Base: ${totalPayment.toLocaleString()} PKR`);
console.log(`Day 1: Issuance=${day1Iss.toLocaleString()}, Payment=${day1Pay.toLocaleString()}`);
console.log(`Days 2-30: Issuance=${(totalIssuance - day1Iss).toLocaleString()}, Payment=${(totalPayment - day1Pay).toLocaleString()}`);

console.log("\n--- BY DO PROFILE ---");
for (const [k, v] of Array.from(doStats.entries()).sort()) {
  console.log(`${k.padEnd(20)}: Count=${String(v.count).padStart(3)} | Issuance=${v.iss.toLocaleString().padStart(12)} | Payment=${v.pay.toLocaleString().padStart(12)} | Net=${(v.iss - v.pay).toLocaleString().padStart(12)}`);
}

console.log("\n--- DAILY DISTRIBUTION ---");
console.log("Day | Rows | Issuance     | Payment      | Net");
console.log("----+------+--------------+--------------+-------------");
for (const [day, v] of Array.from(dailyStats.entries()).sort((a, b) => a[0] - b[0])) {
  console.log(`${String(day).padStart(3)} | ${String(v.count).padStart(4)} | ${v.iss.toLocaleString().padStart(12)} | ${v.pay.toLocaleString().padStart(12)} | ${(v.iss - v.pay).toLocaleString().padStart(11)}`);
}
