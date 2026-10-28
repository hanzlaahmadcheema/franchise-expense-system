import fs from "fs";
import path from "path";

function inspectCsv(filePath: string) {
  if (!fs.existsSync(filePath)) {
    console.log(`[NOT FOUND] ${filePath}`);
    return;
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n");
  console.log(`\n--- ${path.basename(filePath)} (${lines.length} lines) ---`);
  console.log("Header:", lines[0]);
  console.log("First 3 rows:\n" + lines.slice(1, 4).join("\n"));
  if (lines.length > 5) {
    console.log("Last 2 rows:\n" + lines.slice(-2).join("\n"));
  }
}

console.log("=== INSPECTING DATA/OCTOBER/EXPENSE ===");
inspectCsv("data/october/expense/day1_opening_balances.csv");
inspectCsv("data/october/expense/expenses_inputs.csv");
inspectCsv("data/october/expense/commissions_inputs.csv");
inspectCsv("data/october/expense/credit_transactions_inputs.csv");
inspectCsv("data/october/expense/franchise_owner_inputs.csv");

console.log("\n=== INSPECTING DATA/OCTOBER/LOAD ===");
inspectCsv("data/october/load/opening_balance_input.csv");
inspectCsv("data/october/load/company_lifting_inputs.csv");
inspectCsv("data/october/load/distributor_transactions_inputs.csv");
