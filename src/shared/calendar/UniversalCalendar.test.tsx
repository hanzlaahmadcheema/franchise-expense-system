// @vitest-environment jsdom
import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { UniversalCalendar } from "./UniversalCalendar";
import type { UniversalDaySnapshot } from "../types/dayControl.types";

describe("UniversalCalendar Component", () => {
  const mockDays: UniversalDaySnapshot[] = [
    { moduleKey: "stock", monthId: "2026-11", dayNo: 1, status: "open", dateLabel: "2026-11-01", saved: true },
    { moduleKey: "stock", monthId: "2026-11", dayNo: 2, status: "reopen", dateLabel: "2026-11-02", saved: true },
    { moduleKey: "stock", monthId: "2026-11", dayNo: 3, status: "closed", dateLabel: "2026-11-03", saved: true }
  ];

  it("lists days of the week at top with Sunday at last (Mon -> Sun)", () => {
    render(
      <UniversalCalendar
        moduleKey="stock"
        monthId="2026-11"
        selectedDay={1}
        now={new Date(2026, 10, 15)}
        days={mockDays}
        onSelect={vi.fn()}
      />
    );

    // Weekday headers: Mon..Sun
    const monHeaders = screen.getAllByText("Mon");
    const sunHeaders = screen.getAllByText("Sun");
    expect(monHeaders.length).toBeGreaterThan(0);
    expect(sunHeaders.length).toBeGreaterThan(0);
  });

  it("applies correct status colors: open green, re-open orange/yellow, close disabled", () => {
    render(
      <UniversalCalendar
        moduleKey="stock"
        monthId="2026-11"
        selectedDay={1}
        now={new Date(2026, 10, 15)}
        days={mockDays}
        onSelect={vi.fn()}
        variant="default"
      />
    );

    const openDay = screen.getByTitle(/2026-11-01 - Open/i);
    expect(openDay.className).toContain("border-emerald-400");

    const reopenDay = screen.getByTitle(/2026-11-02 - Reopen/i);
    expect(reopenDay.className).toContain("border-amber-500");

    const closedDay = screen.getByTitle(/2026-11-03 - Closed/i);
    expect(closedDay.className).toContain("text-slate-500");
  });

  it("provides an Expand button that opens centered modal pop-up with full calendar", () => {
    const onSelect = vi.fn();
    render(
      <UniversalCalendar
        moduleKey="stock"
        monthId="2026-11"
        selectedDay={1}
        now={new Date(2026, 10, 15)}
        days={mockDays}
        onSelect={onSelect}
      />
    );

    // Before clicking expand, modal is not open
    expect(screen.queryByRole("dialog", { name: "Expanded Operational Calendar" })).toBeNull();

    // Click Expand button
    const expandBtn = screen.getByRole("button", { name: /Expand Calendar into Center Pop-up/i });
    fireEvent.click(expandBtn);

    // Centered modal is now open
    const modal = screen.getByRole("dialog", { name: "Expanded Operational Calendar" });
    expect(modal).toBeTruthy();
    expect(modal.className).toContain("fixed");
    expect(modal.className).toContain("items-center");
    expect(modal.className).toContain("justify-center");

    // Click Day 2 inside modal
    const modalDay2 = within(modal).getByTitle(/2026-11-02 - Reopen/i);
    fireEvent.click(modalDay2);

    expect(onSelect).toHaveBeenCalledWith(2);
    // Modal closes after selection
    expect(screen.queryByRole("dialog", { name: "Expanded Operational Calendar" })).toBeNull();
  });

  it("closes centered expanded modal on Escape key", () => {
    render(
      <UniversalCalendar
        moduleKey="stock"
        monthId="2026-11"
        selectedDay={1}
        now={new Date(2026, 10, 15)}
        days={mockDays}
        onSelect={vi.fn()}
      />
    );

    const expandBtn = screen.getByRole("button", { name: /Expand Calendar into Center Pop-up/i });
    fireEvent.click(expandBtn);

    expect(screen.getByRole("dialog", { name: "Expanded Operational Calendar" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Expanded Operational Calendar" })).toBeNull();
  });
});
