// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Alert } from "./Alert";

describe("Alert Component", () => {
  it("renders with title, message, and variant styling", () => {
    const { rerender } = render(
      <Alert
        variant="warning"
        title="Unsaved Changes"
        message="You have unsaved changes in Day 26."
      />
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Unsaved Changes");
    expect(alert.textContent).toContain("You have unsaved changes in Day 26.");
    expect(alert.className).toContain("bg-amber-500/10");

    rerender(
      <Alert
        variant="error"
        title="Validation Error"
        message="Negative quantity not allowed."
      />
    );
    expect(screen.getByRole("alert").className).toContain("bg-rose-500/10");
  });

  it("handles dismiss click", () => {
    const handleClose = vi.fn();
    render(
      <Alert
        variant="info"
        title="Notice"
        message="System update scheduled."
        onClose={handleClose}
      />
    );

    const dismissBtn = screen.getByRole("button", { name: "Dismiss alert" });
    fireEvent.click(dismissBtn);
    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});
