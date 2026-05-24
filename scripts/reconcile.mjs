import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const workbookPath = [
  path.resolve("sheets/Expence-April-2026.xlsx"),
  path.resolve("Expence-April-2026.xlsx")
].find((candidate) => fs.existsSync(candidate));
if (!workbookPath) {
  console.error("Workbook not found in sheets/ or project root.");
  process.exit(1);
}

const wb = XLSX.readFile(workbookPath, { cellFormula: true, cellNF: false, cellText: true });
const home = wb.Sheets["Home"];
if (!home) {
  console.error("Home sheet not found");
  process.exit(1);
}

function val(cell) {
  const c = home[cell];
  if (!c) return 0;
  const n = Number(c.v);
  return Number.isFinite(n) ? n : c.v;
}

const monthlyIssueTotal = val("C34");
const monthlyExpenseTotal = val("E34");

const report = {
  source: workbookPath,
  extracted: {
    monthlyIssueTotal,
    monthlyExpenseTotal
  },
  note: "Use this output to compare against Firebase dashboard summary."
};

console.log(JSON.stringify(report, null, 2));
