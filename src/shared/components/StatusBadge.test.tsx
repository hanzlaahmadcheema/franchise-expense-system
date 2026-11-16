// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import React from "react";
import { StatusBadge } from "./StatusBadge";

describe("StatusBadge Component", () => {
  it("renders explicit text label paired with color per AC-2.3", () => {
    const { rerender } = render(<StatusBadge status="open" />);
    let badge = screen.getByRole("status");
    expect(badge.textContent).toContain("OPEN");
    expect(badge.className).toContain("text-emerald-400");

    rerender(<StatusBadge status="closed" />);
    badge = screen.getByRole("status");
    expect(badge.textContent).toContain("CLOSED");
    expect(badge.className).toContain("text-rose-400");

    rerender(<StatusBadge status="reopened" />);
    badge = screen.getByRole("status");
    expect(badge.textContent).toContain("REOPENED");
    expect(badge.className).toContain("text-blue-400");
  });

  it("supports custom text override", () => {
    render(<StatusBadge status="open" label="ACTIVE DAY" />);
    const badge = screen.getByRole("status");
    expect(badge.textContent).toContain("ACTIVE DAY");
  });

  it("renders sync states correctly", () => {
    const { rerender } = render(<StatusBadge status="synced" />);
    let badge = screen.getByRole("status");
    expect(badge.textContent).toContain("SYNCED");

    rerender(<StatusBadge status="syncing" />);
    badge = screen.getByRole("status");
    expect(badge.textContent).toContain("SYNCING");
  });
});
