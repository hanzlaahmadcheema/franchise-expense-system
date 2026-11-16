// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { SaveControlBar } from "./SaveControlBar";

describe("SaveControlBar Component", () => {
  it("renders Pristine state with disabled save button per AC-2.2", () => {
    const handleSave = vi.fn();
    render(
      <SaveControlBar
        status="idle"
        isDirty={false}
        onSave={handleSave}
      />
    );

    expect(screen.getByText(/All entries verified with server/)).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save Entry" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders Unsaved Changes (amber dirty) state with active Save button per AC-2.2", () => {
    const handleSave = vi.fn();
    render(
      <SaveControlBar
        status="dirty"
        isDirty={true}
        onSave={handleSave}
      />
    );

    expect(screen.getByText("Unsaved entries in draft")).toBeTruthy();
    expect(screen.queryByText(/Ctrl\+S/i)).toBeNull();
    const saveButton = screen.getByRole("button", { name: "Save Entry" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
    expect(saveButton.getAttribute("title")).not.toContain("Ctrl+S");

    fireEvent.click(saveButton);
    expect(handleSave).toHaveBeenCalledTimes(1);
  });

  it("renders In-Flight saving state with loading indicator per AC-2.2", () => {
    const handleSave = vi.fn();
    render(
      <SaveControlBar
        status="saving"
        isDirty={true}
        onSave={handleSave}
      />
    );

    expect(screen.getByText(/Posting to PostgreSQL ledger/)).toBeTruthy();
    const saveButton = screen.getByRole("button");
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton.textContent).toContain("Saving...");
  });

  it("renders Server Confirmed state only after HTTP 200 per AC-2.2", () => {
    const handleSave = vi.fn();
    render(
      <SaveControlBar
        status="saved"
        isDirty={false}
        onSave={handleSave}
      />
    );

    expect(screen.getByText(/Saved & verified \(HTTP 200\)/)).toBeTruthy();
    const saveButton = screen.getByRole("button", { name: "Save Entry" });
    expect((saveButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders error state with Retry Save button", () => {
    const handleSave = vi.fn();
    render(
      <SaveControlBar
        status="error"
        isDirty={true}
        errorMessage="Database lock timeout on Day 26"
        onSave={handleSave}
      />
    );

    expect(screen.getByText("Database lock timeout on Day 26")).toBeTruthy();
    const retryBtn = screen.getByRole("button", { name: "Retry Save" });
    expect((retryBtn as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(retryBtn);
    expect(handleSave).toHaveBeenCalledTimes(1);
  });

  it("renders read-only notice when day is closed", () => {
    const handleSave = vi.fn();
    render(
      <SaveControlBar
        status="idle"
        isDirty={false}
        disabled={true}
        readOnlyNotice="Day 26 is closed. Modification locked."
        onSave={handleSave}
      />
    );

    expect(screen.getByText("Day 26 is closed. Modification locked.")).toBeTruthy();
    const saveBtn = screen.getByRole("button", { name: "Save Entry" });
    expect((saveBtn as HTMLButtonElement).disabled).toBe(true);
  });
});
