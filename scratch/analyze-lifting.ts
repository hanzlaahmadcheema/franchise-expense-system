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

const liftingCsv = "/home/hanzlaahmad/PersonalProjects/Franchise/data/september/load/company_lifting_inputs.csv";
const rows = parseCsv(liftingCsv);

const dailyLifting = new Map<number, { date: string; l1: number; l2: number; total: number }>();
for (const r of rows) {
  const dayNo = parseInt(r.sheet, 10);
  const amt = parseFloat(r.amount) || 0;
  if (!dailyLifting.has(dayNo)) {
    dailyLifting.set(dayNo, { date: r.date, l1: 0, l2: 0, total: 0 });
  }
  const entry = dailyLifting.get(dayNo)!;
  if (r.lifting_type.includes("1st")) {
    entry.l1 += amt;
  } else if (r.lifting_type.includes("2nd")) {
    entry.l2 += amt;
  }
  entry.total += amt;
}

console.log(`Lifting Days Count: ${dailyLifting.size}`);
let grandTotalLifting = 0;
for (const [day, data] of Array.from(dailyLifting.entries()).sort((a, b) => a[0] - b[0])) {
  console.log(`Day ${String(day).padStart(2)} (${data.date}): 1st=${data.l1.toLocaleString().padStart(10)} | 2nd=${data.l2.toLocaleString().padStart(10)} | Total=${data.total.toLocaleString().padStart(10)}`);
  grandTotalLifting += data.total;
}
console.log(`Grand Total Company Lifting: ${grandTotalLifting.toLocaleString()} PKR`);
