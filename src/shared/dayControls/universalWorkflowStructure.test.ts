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

  it("keeps daily entry saves on autosave instead of module save buttons", () => {
    const dailyEntry = source("src/components/DailyEntryForm.tsx");
    const jazz = source("src/modules/jazzLoad/components/JazzLoadModule.tsx");
    const stock = source("src/modules/stock/components/StockLedgerModule.tsx");

    expect(`${dailyEntry}\n${jazz}\n${stock}`).not.toContain("Save Now");
    expect(stock).not.toContain("Save Daily Stock Record");
  });
});
