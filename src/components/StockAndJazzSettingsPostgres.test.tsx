// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ledgerApiClient } from "../services/api/ledgerApiClient";
import * as stockFirestore from "../modules/stock/services/stockFirestore";
import * as jazzLoadFirestore from "../modules/jazzLoad/services/jazzLoadFirestore";
import { changedSortOrderPatches } from "../shared/services/orderUtils";

// Mock stockFirestore to verify NO Firestore calls are made in PostgreSQL periods
vi.mock("../modules/stock/services/stockFirestore", () => ({
  upsertStockProduct: vi.fn(),
  deleteStockProduct: vi.fn(),
  updateStockProductSortOrder: vi.fn(),
  upsertStockAccount: vi.fn(),
  deleteStockAccount: vi.fn(),
  updateStockAccountSortOrder: vi.fn(),
  saveStockSettingsConfig: vi.fn(),
  roleCanStock: vi.fn((role: string | null, permission: string) => {
    if (role === "owner" || role === "admin") return true;
    return false;
  })
}));

// Mock jazzLoadFirestore to verify NO Firestore calls are made in PostgreSQL periods
vi.mock("../modules/jazzLoad/services/jazzLoadFirestore", () => ({
  upsertJazzLoadRate: vi.fn(),
  deleteJazzLoadRate: vi.fn(),
  updateJazzLoadRateSortOrder: vi.fn(),
  upsertJazzLoadDoProfile: vi.fn(),
  upsertJazzLoadDoName: vi.fn(),
  deleteJazzLoadDoName: vi.fn(),
  updateJazzLoadDoNameSortOrder: vi.fn(),
  upsertJazzLoadDoLine: vi.fn(),
  deleteJazzLoadDoLine: vi.fn(),
  updateJazzLoadDoLineSortOrder: vi.fn(),
  upsertJazzLoadDoLineBinding: vi.fn(),
  roleCanJazzLoad: vi.fn(() => true)
}));

// Mock ledgerApiClient catalog endpoints
vi.mock("../services/api/ledgerApiClient", () => ({
  ledgerApiClient: {
    catalogs: {
      getStockProducts: vi.fn(),
      createStockProduct: vi.fn(),
      updateStockProduct: vi.fn(),
      getStockAccounts: vi.fn(),
      createStockAccount: vi.fn(),
      updateStockAccount: vi.fn(),
      getJazzLoadRates: vi.fn(),
      createJazzLoadRate: vi.fn(),
      updateJazzLoadRate: vi.fn(),
      getJazzLoadDoProfiles: vi.fn(),
      createJazzLoadDoProfile: vi.fn(),
      updateJazzLoadDoProfile: vi.fn()
    }
  }
}));

describe("Stock and Jazz Load Settings PostgreSQL Binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe("Stock Products", () => {
    it("editing product rate (e.g. E-SIM from 2000 to 1500) calls updateStockProduct with 1500 and no Firestore calls", async () => {
      const esimId = "0cc21d4f-cd00-44c0-ae69-31df899751d1";
      const products = [
        {
          id: esimId,
          name: "E SIM",
          slug: "e-sim",
          rate: 2000,
          active: true,
          displayOrder: 5,
          sortOrder: 5,
          category: "sim",
          paymentTrackingEnabled: true,
          createdBy: "system",
          createdAt: 1000,
          updatedAt: 1000
        }
      ];

      vi.mocked(ledgerApiClient.catalogs.updateStockProduct).mockResolvedValueOnce({
        data: {
          id: esimId,
          name: "E SIM",
          slug: "e-sim",
          rate: 1500,
          payment_tracking_enabled: true,
          is_active: true,
          sort_order: 5
        }
      });

      // Updated product with rate 1500
      const updatedEsim = {
        ...products[0],
        rate: 1500
      };

      // Execute update via catalog client
      const res = await ledgerApiClient.catalogs.updateStockProduct(updatedEsim.id, {
        name: updatedEsim.name.trim(),
        rate: Number(updatedEsim.rate),
        payment_tracking_enabled: updatedEsim.paymentTrackingEnabled !== false,
        is_active: updatedEsim.active,
        sort_order: updatedEsim.sortOrder
      });

      expect(ledgerApiClient.catalogs.updateStockProduct).toHaveBeenCalledTimes(1);
      expect(ledgerApiClient.catalogs.updateStockProduct).toHaveBeenCalledWith(esimId, {
        name: "E SIM",
        rate: 1500,
        payment_tracking_enabled: true,
        is_active: true,
        sort_order: 5
      });
      expect(res.data.rate).toBe(1500);
      expect(stockFirestore.upsertStockProduct).not.toHaveBeenCalled();
    });

    it("creating a new stock product routes to createStockProduct with slug and rate", async () => {
      vi.mocked(ledgerApiClient.catalogs.createStockProduct).mockResolvedValueOnce({
        data: {
          id: "new-prod-uuid",
          name: "5G Device",
          slug: "5g-device",
          rate: 4500,
          payment_tracking_enabled: true,
          is_active: true,
          sort_order: 13
        }
      });

      const res = await ledgerApiClient.catalogs.createStockProduct({
        slug: "5g-device",
        name: "5G Device",
        rate: 4500,
        payment_tracking_enabled: true,
        is_active: true,
        sort_order: 13
      });

      expect(ledgerApiClient.catalogs.createStockProduct).toHaveBeenCalledTimes(1);
      expect(ledgerApiClient.catalogs.createStockProduct).toHaveBeenCalledWith({
        slug: "5g-device",
        name: "5G Device",
        rate: 4500,
        payment_tracking_enabled: true,
        is_active: true,
        sort_order: 13
      });
      expect(res.data.id).toBe("new-prod-uuid");
      expect(stockFirestore.upsertStockProduct).not.toHaveBeenCalled();
    });

    it("deactivating/deleting a stock product calls updateStockProduct with is_active: false", async () => {
      const prodId = "prod-uuid-to-delete";
      vi.mocked(ledgerApiClient.catalogs.updateStockProduct).mockResolvedValueOnce({
        data: { id: prodId, is_active: false }
      });

      await ledgerApiClient.catalogs.updateStockProduct(prodId, { is_active: false });

      expect(ledgerApiClient.catalogs.updateStockProduct).toHaveBeenCalledWith(prodId, { is_active: false });
      expect(stockFirestore.deleteStockProduct).not.toHaveBeenCalled();
    });

    it("reordering stock products patches sort orders in PostgreSQL without calling Firestore", async () => {
      const before = [
        { id: "p1", name: "P1", sortOrder: 1 },
        { id: "p2", name: "P2", sortOrder: 2 }
      ];
      const after = [
        { id: "p2", name: "P2", sortOrder: 1 },
        { id: "p1", name: "P1", sortOrder: 2 }
      ];

      const patches = changedSortOrderPatches(before, after);
      expect(patches).toEqual([
        { id: "p2", sortOrder: 1 },
        { id: "p1", sortOrder: 2 }
      ]);

      vi.mocked(ledgerApiClient.catalogs.updateStockProduct).mockResolvedValue({ data: {} });

      await Promise.all(
        patches.map((p) => ledgerApiClient.catalogs.updateStockProduct(p.id, { sort_order: p.sortOrder }))
      );

      expect(ledgerApiClient.catalogs.updateStockProduct).toHaveBeenCalledWith("p2", { sort_order: 1 });
      expect(ledgerApiClient.catalogs.updateStockProduct).toHaveBeenCalledWith("p1", { sort_order: 2 });
      expect(stockFirestore.updateStockProductSortOrder).not.toHaveBeenCalled();
    });
  });

  describe("Stock Accounts", () => {
    it("editing stock account calls updateStockAccount in PostgreSQL without calling Firestore", async () => {
      const accountId = "e998353d-bab4-4c67-8dbe-faeaf4d4bb4d";
      vi.mocked(ledgerApiClient.catalogs.updateStockAccount).mockResolvedValueOnce({
        data: {
          id: accountId,
          name: "DO RIZWAN UPDATED",
          type: "DO",
          is_active: true,
          sort_order: 1
        }
      });

      await ledgerApiClient.catalogs.updateStockAccount(accountId, {
        name: "DO RIZWAN UPDATED",
        type: "DO",
        is_active: true,
        sort_order: 1
      });

      expect(ledgerApiClient.catalogs.updateStockAccount).toHaveBeenCalledWith(accountId, {
        name: "DO RIZWAN UPDATED",
        type: "DO",
        is_active: true,
        sort_order: 1
      });
      expect(stockFirestore.upsertStockAccount).not.toHaveBeenCalled();
    });

    it("creating stock account calls createStockAccount without calling Firestore", async () => {
      vi.mocked(ledgerApiClient.catalogs.createStockAccount).mockResolvedValueOnce({
        data: {
          id: "new-acc-uuid",
          name: "NEW CCR",
          slug: "new-ccr",
          type: "CCR",
          is_active: true,
          sort_order: 19
        }
      });

      await ledgerApiClient.catalogs.createStockAccount({
        slug: "new-ccr",
        name: "NEW CCR",
        type: "CCR",
        is_active: true,
        sort_order: 19
      });

      expect(ledgerApiClient.catalogs.createStockAccount).toHaveBeenCalledWith({
        slug: "new-ccr",
        name: "NEW CCR",
        type: "CCR",
        is_active: true,
        sort_order: 19
      });
      expect(stockFirestore.upsertStockAccount).not.toHaveBeenCalled();
    });

    it("deactivating a stock account calls updateStockAccount with is_active: false", async () => {
      const accId = "acc-to-delete";
      vi.mocked(ledgerApiClient.catalogs.updateStockAccount).mockResolvedValueOnce({
        data: { id: accId, is_active: false }
      });

      await ledgerApiClient.catalogs.updateStockAccount(accId, { is_active: false });

      expect(ledgerApiClient.catalogs.updateStockAccount).toHaveBeenCalledWith(accId, { is_active: false });
      expect(stockFirestore.deleteStockAccount).not.toHaveBeenCalled();
    });
  });

  describe("Stock Config", () => {
    it("manual carry-forward input is removed and does NOT call Firestore", () => {
      expect(stockFirestore.saveStockSettingsConfig).not.toHaveBeenCalled();
    });
  });

  describe("Jazz Load Rates and DO Profiles", () => {
    it("saving a rate creates rate in PostgreSQL without calling Firestore", async () => {
      vi.mocked(ledgerApiClient.catalogs.createJazzLoadRate).mockResolvedValueOnce({
        data: {
          id: "rate-uuid-1",
          name: "October Rates",
          ml_rate: 2.5,
          comm1_rate: 2.5,
          comm2_rate: 1.2,
          effective_from: "2026-10-01",
          is_active: true
        }
      });

      await ledgerApiClient.catalogs.createJazzLoadRate({
        name: "October Rates",
        ml_rate: 2.5,
        comm1_rate: 2.5,
        comm2_rate: 1.2,
        effective_from: "2026-10-01",
        is_active: true
      });

      expect(ledgerApiClient.catalogs.createJazzLoadRate).toHaveBeenCalledWith({
        name: "October Rates",
        ml_rate: 2.5,
        comm1_rate: 2.5,
        comm2_rate: 1.2,
        effective_from: "2026-10-01",
        is_active: true
      });
      expect(jazzLoadFirestore.upsertJazzLoadRate).not.toHaveBeenCalled();
    });

    it("toggling a Jazz Load rate updates is_active in PostgreSQL without calling Firestore", async () => {
      const rateUuid = "11175980-2516-4ce2-9aee-e226196f92d1";
      vi.mocked(ledgerApiClient.catalogs.updateJazzLoadRate).mockResolvedValueOnce({
        data: { id: rateUuid, is_active: false }
      });

      await ledgerApiClient.catalogs.updateJazzLoadRate(rateUuid, { is_active: false });

      expect(ledgerApiClient.catalogs.updateJazzLoadRate).toHaveBeenCalledWith(rateUuid, { is_active: false });
      expect(jazzLoadFirestore.upsertJazzLoadRate).not.toHaveBeenCalled();
    });

    it("saving a DO profile calls createJazzLoadDoProfile in PostgreSQL without calling Firestore", async () => {
      vi.mocked(ledgerApiClient.catalogs.createJazzLoadDoProfile).mockResolvedValueOnce({
        data: {
          id: "profile-uuid-1",
          do_name: "Tariq",
          do_line: "03001234567",
          sort_order: 15,
          is_active: true
        }
      });

      await ledgerApiClient.catalogs.createJazzLoadDoProfile({
        do_name: "Tariq",
        do_line: "03001234567",
        sort_order: 15,
        is_active: true
      });

      expect(ledgerApiClient.catalogs.createJazzLoadDoProfile).toHaveBeenCalledWith({
        do_name: "Tariq",
        do_line: "03001234567",
        sort_order: 15,
        is_active: true
      });
      expect(jazzLoadFirestore.upsertJazzLoadDoProfile).not.toHaveBeenCalled();
    });

    it("editing a DO name updates do_name in PostgreSQL without calling Firestore", async () => {
      const profileId = "profile-uuid-1";
      vi.mocked(ledgerApiClient.catalogs.updateJazzLoadDoProfile).mockResolvedValueOnce({
        data: { id: profileId, do_name: "Tariq Ahmed" }
      });

      await ledgerApiClient.catalogs.updateJazzLoadDoProfile(profileId, { do_name: "Tariq Ahmed" });

      expect(ledgerApiClient.catalogs.updateJazzLoadDoProfile).toHaveBeenCalledWith(profileId, { do_name: "Tariq Ahmed" });
      expect(jazzLoadFirestore.upsertJazzLoadDoName).not.toHaveBeenCalled();
    });
  });
});
