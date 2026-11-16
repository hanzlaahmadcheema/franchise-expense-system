// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { LoadingState, ErrorState, EmptyState } from "./States";

describe("State Feedback Components", () => {
  it("renders LoadingState with custom title and description", () => {
    render(
      <LoadingState
        title="Loading Day 26 transactions"
        description="Connecting to ledger..."
      />
    );

    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText("Loading Day 26 transactions")).toBeTruthy();
    expect(screen.getByText("Connecting to ledger...")).toBeTruthy();
  });

  it("renders ErrorState with retry button and triggers callback", () => {
    const handleRetry = vi.fn();
    render(
      <ErrorState
        title="Database Timeout"
        description="Could not fetch transactions."
        onRetry={handleRetry}
        retryText="Retry Connection"
      />
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Database Timeout")).toBeTruthy();
    expect(screen.getByText("Could not fetch transactions.")).toBeTruthy();

    const retryBtn = screen.getByRole("button", { name: "Retry Connection" });
    fireEvent.click(retryBtn);
    expect(handleRetry).toHaveBeenCalledTimes(1);
  });

  it("renders EmptyState with action button and triggers callback", () => {
    const handleAction = vi.fn();
    render(
      <EmptyState
        title="No Outbound Stock Orders"
        description="Select a dealer above to begin."
        onAction={handleAction}
        actionLabel="Create First Order"
      />
    );

    expect(screen.getByText("No Outbound Stock Orders")).toBeTruthy();
    expect(screen.getByText("Select a dealer above to begin.")).toBeTruthy();

    const actionBtn = screen.getByRole("button", { name: "Create First Order" });
    fireEvent.click(actionBtn);
    expect(handleAction).toHaveBeenCalledTimes(1);
  });
});
