import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("universal daily workflow structure", () => {
  it("keeps daily calendars centralized in UniversalCalendar", () => {
    const app = source("src/App.tsx");
    const jazz = source("src/modules/jazzLoad/components/JazzLoadModule.tsx");
    const stock = source("src/modules/stock/components/StockLedgerModule.tsx");

    expect(app).not.toMatch(/function\s+DayCalendar/);
    expect(jazz).not.toMatch(/function\s+JazzLoadCalendar/);
    expect(stock).not.toMatch(/function\s+StockCalendar/);
    expect(`${app}\n${jazz}\n${stock}`).not.toMatch(/<(DayCalendar|JazzLoadCalendar|StockCalendar)\b/);
  });

  it("keeps autosave and provides an explicit verified fallback in every daily module", () => {
    const dailyEntry = source("src/components/DailyEntryForm.tsx");
    const jazz = source("src/modules/jazzLoad/components/JazzLoadModule.tsx");
    const stock = source("src/modules/stock/components/StockLedgerModule.tsx");

    expect(dailyEntry).toContain("Save Now & Verify");
    expect(jazz).toContain("Save Now & Verify");
    expect(stock).toContain("Save Now & Verify");
    expect(`${dailyEntry}\n${jazz}\n${stock}`).toContain("SaveProgressDialog");
    expect(stock).not.toContain("Save Daily Stock Record");
  });
});
