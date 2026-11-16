// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { Button } from "./Button";

describe("Button Component", () => {
  it("renders with children and default primary styling", () => {
    render(<Button>Submit</Button>);
    const button = screen.getByRole("button", { name: "Submit" });
    expect(button).toBeTruthy();
    expect(button.className).toContain("bg-emerald-500");
  });

  it("renders secondary and destructive variants", () => {
    const { rerender } = render(<Button variant="secondary">Cancel</Button>);
    let button = screen.getByRole("button", { name: "Cancel" });
    expect(button.className).toContain("bg-slate-900");

    rerender(<Button variant="destructive">Delete Record</Button>);
    button = screen.getByRole("button", { name: "Delete Record" });
    expect(button.className).toContain("text-rose-300");
  });

  it("handles loading state and disables user interaction", () => {
    const handleClick = vi.fn();
    render(
      <Button loading loadingText="Saving..." onClick={handleClick}>
        Save
      </Button>
    );

    const button = screen.getByRole("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.textContent).toContain("Saving...");

    fireEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("handles disabled state", () => {
    const handleClick = vi.fn();
    render(
      <Button disabled onClick={handleClick}>
        Disabled Action
      </Button>
    );

    const button = screen.getByRole("button", { name: "Disabled Action" });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it("triggers onClick when active", () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click Me</Button>);

    const button = screen.getByRole("button", { name: "Click Me" });
    fireEvent.click(button);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
