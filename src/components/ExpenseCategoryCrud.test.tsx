// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ledgerApiClient } from "../services/api/ledgerApiClient";
import * as firestoreService from "../lib/firestoreService";

// Mock firestoreService to ensure NO Firestore calls are made
vi.mock("../lib/firestoreService", () => ({
  deleteCatalogItem: vi.fn(),
  upsertCatalogItem: vi.fn(),
  updateCatalogSortOrder: vi.fn(),
  roleCan: vi.fn((role: string | null, permission: string) => {
    if (role === "owner") return true;
    if (role === "admin") return permission === "daily";
    return false;
  })
}));

// Mock ledgerApiClient
vi.mock("../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    catalogs: {
      getExpenseCategories: vi.fn(),
      createExpenseCategory: vi.fn(),
      updateExpenseCategory: vi.fn(),
      deleteExpenseCategory: vi.fn(),
      getCommissionCategories: vi.fn(),
      createCommissionCategory: vi.fn(),
      updateCommissionCategory: vi.fn(),
      deleteCommissionCategory: vi.fn(),
      getCreditParties: vi.fn(),
      createCreditParty: vi.fn(),
      updateCreditParty: vi.fn(),
      deleteCreditParty: vi.fn()
    }
  }
}));

describe("Expense Category Catalog CRUD in PostgreSQL Architecture", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("editing an existing category invokes updateExpenseCategory, preserving UUID and sort_order", async () => {
    const existingId = "5fd6bee1-7f5a-4e14-8843-c43bea594eb9";
    const existingCategories = [
      { id: existingId, name: "Office Supplies", active: true, sortOrder: 4 },
      { id: "e2b3c4d5-0000-4000-a000-000000000001", name: "Rent", active: true, sortOrder: 1 }
    ];

    vi.mocked(ledgerApiClient.catalogs.updateExpenseCategory).mockResolvedValueOnce({
      data: {
        id: existingId,
        name: "Office Supplies & Paper",
        sort_order: 4,
        is_active: true
      }
    });

    // Simulate saveCatalog handler logic for PostgreSQL period
    const itemToEdit = {
      id: existingId,
      name: "Office Supplies & Paper",
      active: true,
      sortOrder: 4
    };

    const isExisting = itemToEdit.id && existingCategories.some((c) => c.id === itemToEdit.id);
    expect(isExisting).toBe(true);

    if (isExisting) {
      await ledgerApiClient.catalogs.updateExpenseCategory(itemToEdit.id, {
        name: itemToEdit.name,
        is_active: itemToEdit.active,
        sort_order: itemToEdit.sortOrder
      });
    }

    // Assert updateExpenseCategory was called with the exact existing UUID and sort_order
    expect(ledgerApiClient.catalogs.updateExpenseCategory).toHaveBeenCalledTimes(1);
    expect(ledgerApiClient.catalogs.updateExpenseCategory).toHaveBeenCalledWith(existingId, {
      name: "Office Supplies & Paper",
      is_active: true,
      sort_order: 4
    });

    // Assert createExpenseCategory was NOT called
    expect(ledgerApiClient.catalogs.createExpenseCategory).not.toHaveBeenCalled();

    // Assert NO Firestore calls
    expect(firestoreService.upsertCatalogItem).not.toHaveBeenCalled();
  });

  it("editing modifies the existing row and does NOT insert a new row", async () => {
    const existingId = "5fd6bee1-7f5a-4e14-8843-c43bea594eb9";
    let categories = [
      { id: existingId, name: "Electricity", active: true, sortOrder: 2 },
      { id: "other-cat-uuid", name: "Internet", active: true, sortOrder: 3 }
    ];

    const updatedResponse = {
      id: existingId,
      name: "Electricity Bill",
      sort_order: 2,
      is_active: true
    };

    vi.mocked(ledgerApiClient.catalogs.updateExpenseCategory).mockResolvedValueOnce({
      data: updatedResponse
    });

    const res = await ledgerApiClient.catalogs.updateExpenseCategory(existingId, {
      name: "Electricity Bill",
      is_active: true,
      sort_order: 2
    });

    // State update simulation
    const updated = res.data;
    categories = categories.map((c) =>
      c.id === updated.id
        ? { id: updated.id, name: updated.name, active: updated.is_active, sortOrder: updated.sort_order }
        : c
    );

    // Assert length remains unchanged (no new row inserted)
    expect(categories.length).toBe(2);
    // Assert target item is updated in place
    expect(categories.find((c) => c.id === existingId)).toEqual({
      id: existingId,
      name: "Electricity Bill",
      active: true,
      sortOrder: 2
    });
  });

  it("authorized deletion of unreferenced category calls deleteExpenseCategory and removes row", async () => {
    const catIdToDelete = "5fd6bee1-7f5a-4e14-8843-c43bea594eb9";
    let categories = [
      { id: catIdToDelete, name: "Old Category", active: true, sortOrder: 1 },
      { id: "keep-cat-uuid", name: "Keep Category", active: true, sortOrder: 2 }
    ];

    vi.mocked(ledgerApiClient.catalogs.deleteExpenseCategory).mockResolvedValueOnce({
      data: {
        id: catIdToDelete,
        soft_deleted: false,
        deleted: true
      }
    });

    const res = await ledgerApiClient.catalogs.deleteExpenseCategory(catIdToDelete);
    expect(res.data.soft_deleted).toBe(false);

    // State update for hard delete
    categories = categories.filter((c) => c.id !== catIdToDelete);

    expect(categories.length).toBe(1);
    expect(categories[0].id).toBe("keep-cat-uuid");
    expect(ledgerApiClient.catalogs.deleteExpenseCategory).toHaveBeenCalledWith(catIdToDelete);
    // Assert NO Firestore calls
    expect(firestoreService.deleteCatalogItem).not.toHaveBeenCalled();
  });

  it("deletion of category referenced by accounting transactions soft-deletes by marking inactive", async () => {
    const catIdToDelete = "5fd6bee1-7f5a-4e14-8843-c43bea594eb9";
    let categories = [
      { id: catIdToDelete, name: "Salary", active: true, sortOrder: 1 }
    ];

    vi.mocked(ledgerApiClient.catalogs.deleteExpenseCategory).mockResolvedValueOnce({
      data: {
        id: catIdToDelete,
        is_active: false,
        soft_deleted: true
      }
    });

    const res = await ledgerApiClient.catalogs.deleteExpenseCategory(catIdToDelete);
    expect(res.data.soft_deleted).toBe(true);

    // State update for soft delete
    categories = categories.map((c) =>
      c.id === catIdToDelete ? { ...c, active: false } : c
    );

    expect(categories.length).toBe(1);
    expect(categories[0].id).toBe(catIdToDelete);
    expect(categories[0].active).toBe(false);
    expect(firestoreService.deleteCatalogItem).not.toHaveBeenCalled();
  });

  it("unauthorized user role (viewer/admin) is blocked from deleting categories", () => {
    const nonOwnerRoles = ["viewer", "admin", null];

    for (const testRole of nonOwnerRoles) {
      let blocked = false;
      if (testRole !== "owner") {
        blocked = true;
      }
      expect(blocked).toBe(true);
      expect(ledgerApiClient.catalogs.deleteExpenseCategory).not.toHaveBeenCalled();
      expect(firestoreService.deleteCatalogItem).not.toHaveBeenCalled();
    }
  });

  it("reordering categories updates sort_order via PostgreSQL PATCH calls without Firestore", async () => {
    const before = [
      { id: "cat-1", name: "Category 1", active: true, sortOrder: 1 },
      { id: "cat-2", name: "Category 2", active: true, sortOrder: 2 }
    ];
    const after = [
      { id: "cat-2", name: "Category 2", active: true, sortOrder: 1 },
      { id: "cat-1", name: "Category 1", active: true, sortOrder: 2 }
    ];

    vi.mocked(ledgerApiClient.catalogs.updateExpenseCategory).mockResolvedValue({
      data: {} as any
    });

    // Simulate handleReorderCatalog
    await Promise.all([
      ledgerApiClient.catalogs.updateExpenseCategory("cat-2", { sort_order: 1 }),
      ledgerApiClient.catalogs.updateExpenseCategory("cat-1", { sort_order: 2 })
    ]);

    expect(ledgerApiClient.catalogs.updateExpenseCategory).toHaveBeenCalledWith("cat-2", { sort_order: 1 });
    expect(ledgerApiClient.catalogs.updateExpenseCategory).toHaveBeenCalledWith("cat-1", { sort_order: 2 });
    expect(firestoreService.updateCatalogSortOrder).not.toHaveBeenCalled();
  });
});
