// @vitest-environment jsdom
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { LedgerTable, type LedgerColumn } from "./LedgerTable";

interface SampleItem {
  id: string;
  category: string;
  amount: number;
}

const sampleColumns: LedgerColumn<SampleItem>[] = [
  { key: "category", header: "Category", align: "left" },
  {
    key: "amount",
    header: "Amount (PKR)",
    isNumeric: true,
    render: (item) => item.amount.toLocaleString(),
    footerRender: (items) =>
      items.reduce((sum, item) => sum + item.amount, 0).toLocaleString(),
  },
];

const sampleData: SampleItem[] = [
  { id: "1", category: "Tea & Refreshment", amount: 880 },
  { id: "2", category: "Shop Rent", amount: 45000 },
];

describe("LedgerTable Component", () => {
  it("renders table headers and rows with numeric alignment", () => {
    render(
      <LedgerTable
        columns={sampleColumns}
        data={sampleData}
        rowKey={(item) => item.id}
      />
    );

    expect(screen.getByText("Category")).toBeTruthy();
    expect(screen.getByText("Amount (PKR)")).toBeTruthy();
    expect(screen.getByText("Tea & Refreshment")).toBeTruthy();
    expect(screen.getByText("880")).toBeTruthy();
    expect(screen.getByText("Shop Rent")).toBeTruthy();
    expect(screen.getByText("45,000")).toBeTruthy();
  });

  it("renders empty state when data is empty", () => {
    render(
      <LedgerTable
        columns={sampleColumns}
        data={[]}
        emptyText="No entries for this day."
      />
    );

    expect(screen.getByText("No entries for this day.")).toBeTruthy();
  });

  it("renders loading state when loading is true", () => {
    render(
      <LedgerTable
        columns={sampleColumns}
        data={sampleData}
        loading={true}
        loadingText="Fetching ledger data..."
      />
    );

    expect(screen.getByText("Fetching ledger data...")).toBeTruthy();
  });

  it("renders totals footer row with correct summary calculation", () => {
    render(
      <LedgerTable
        columns={sampleColumns}
        data={sampleData}
        hasTotalsRow={true}
      />
    );

    expect(screen.getByText("45,880")).toBeTruthy();
  });

  it("fires onRowClick handler when row is clicked", () => {
    const handleRowClick = vi.fn();
    render(
      <LedgerTable
        columns={sampleColumns}
        data={sampleData}
        onRowClick={handleRowClick}
      />
    );

    fireEvent.click(screen.getByText("Tea & Refreshment"));
    expect(handleRowClick).toHaveBeenCalledWith(sampleData[0], 0);
  });
});
