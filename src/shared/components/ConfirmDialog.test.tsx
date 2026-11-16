// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import React, { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog Accessibility & Focus Behavior (F-01)", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("does not render when isOpen is false", () => {
    render(
      <ConfirmDialog
        isOpen={false}
        title="Close Day 26"
        message="Are you sure you want to close Day 26?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves focus into the dialog on opening, prioritizing Cancel button", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open Close-Day Modal";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    render(
      <ConfirmDialog
        isOpen={true}
        title="Close Day 26"
        message="Are you sure you want to close Day 26?"
        cancelText="Cancel"
        confirmText="Confirm Close"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it("traps focus: Tab key wraps from last focusable element to first focusable element", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Close Day 26"
        message="Are you sure?"
        cancelText="Cancel"
        confirmText="Confirm Action"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const closeXBtn = screen.getByRole("button", { name: "Close dialog" });
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    const confirmBtn = screen.getByRole("button", { name: "Confirm Action" });

    // Focus last element (Confirm button)
    confirmBtn.focus();
    expect(document.activeElement).toBe(confirmBtn);

    // Press Tab on last element -> wraps to closeXBtn (first element in DOM order)
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(closeXBtn);
  });

  it("traps focus: Shift+Tab key wraps from first focusable element to last focusable element", () => {
    render(
      <ConfirmDialog
        isOpen={true}
        title="Close Day 26"
        message="Are you sure?"
        cancelText="Cancel"
        confirmText="Confirm Action"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const closeXBtn = screen.getByRole("button", { name: "Close dialog" });
    const confirmBtn = screen.getByRole("button", { name: "Confirm Action" });

    // Focus first element (Close X button)
    closeXBtn.focus();
    expect(document.activeElement).toBe(closeXBtn);

    // Press Shift+Tab on first element -> wraps to confirmBtn (last element in DOM order)
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);
  });

  it("restores focus to the invoking element when closed via Cancel button", () => {
    function TestHost() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <div>
          <button id="trigger-btn" onClick={() => setIsOpen(true)}>
            Open Dialog
          </button>
          <ConfirmDialog
            isOpen={isOpen}
            title="Confirm Action"
            message="Please confirm."
            onConfirm={vi.fn()}
            onCancel={() => setIsOpen(false)}
          />
        </div>
      );
    }

    render(<TestHost />);
    const trigger = screen.getByRole("button", { name: "Open Dialog" });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    // Open modal
    fireEvent.click(trigger);
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancelBtn);

    // Click cancel
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to the invoking element when dismissed via Escape key", () => {
    function TestHost() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <div>
          <button id="trigger-btn-esc" onClick={() => setIsOpen(true)}>
            Trigger Esc
          </button>
          <ConfirmDialog
            isOpen={isOpen}
            title="Confirm Escape"
            message="Press Escape."
            onConfirm={vi.fn()}
            onCancel={() => setIsOpen(false)}
          />
        </div>
      );
    }

    render(<TestHost />);
    const trigger = screen.getByRole("button", { name: "Trigger Esc" });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("Escape key dismisses dialog but NEVER triggers onConfirm", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Reopen Day"
        message="Reopen this day?"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleCancel).toHaveBeenCalledTimes(1);
    expect(handleConfirm).not.toHaveBeenCalled();
  });

  it("backdrop click dismisses dialog but NEVER triggers onConfirm", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Reopen Day"
        message="Reopen this day?"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );

    const dialogOverlay = screen.getByRole("dialog");
    fireEvent.click(dialogOverlay);

    expect(handleCancel).toHaveBeenCalledTimes(1);
    expect(handleConfirm).not.toHaveBeenCalled();
  });

  it("respects disableEscapeDismiss and disableBackdropDismiss props", () => {
    const handleCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Critical Action"
        message="Mandatory explicit resolution required."
        disableEscapeDismiss={true}
        disableBackdropDismiss={true}
        onConfirm={vi.fn()}
        onCancel={handleCancel}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleCancel).not.toHaveBeenCalled();

    const dialogOverlay = screen.getByRole("dialog");
    fireEvent.click(dialogOverlay);
    expect(handleCancel).not.toHaveBeenCalled();
  });

  it("loading state blocks Escape dismissal, backdrop clicks, and duplicate confirmation", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Locking Day"
        message="Running ledger calculations..."
        loading={true}
        loadingText="Locking..."
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );

    // Escape is ignored
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handleCancel).not.toHaveBeenCalled();

    // Backdrop click is ignored
    const dialogOverlay = screen.getByRole("dialog");
    fireEvent.click(dialogOverlay);
    expect(handleCancel).not.toHaveBeenCalled();

    // Cancel button is disabled
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    expect((cancelBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(cancelBtn);
    expect(handleCancel).not.toHaveBeenCalled();

    // Confirm button is disabled / loading
    const confirmBtn = screen.getByRole("button", { name: "Locking..." });
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirmBtn);
    expect(handleConfirm).not.toHaveBeenCalled();
  });

  it("single-action guarantee: onConfirm fires at most once per confirmation click", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Single Action Confirm"
        message="Click once."
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );

    const confirmBtn = screen.getByRole("button", { name: "Confirm" });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);
    expect(handleConfirm).toHaveBeenCalledTimes(1);
    expect(handleCancel).not.toHaveBeenCalled();
  });

  it("single-action guarantee: onCancel fires at most once per cancellation click", () => {
    const handleConfirm = vi.fn();
    const handleCancel = vi.fn();

    render(
      <ConfirmDialog
        isOpen={true}
        title="Single Action Cancel"
        message="Click cancel."
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    );

    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);
    fireEvent.click(cancelBtn);
    expect(handleCancel).toHaveBeenCalledTimes(1);
    expect(handleConfirm).not.toHaveBeenCalled();
  });
});
