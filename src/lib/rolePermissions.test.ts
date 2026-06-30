import { describe, expect, it } from "vitest";
import { roleCan } from "./firestoreService";
import { roleCanJazzLoad } from "../modules/jazzLoad/services/jazzLoadFirestore";
import { roleCanStock } from "../modules/stock/services/stockFirestore";
import { MASTER_REFRESH_ACCESS } from "../shared/services/masterRefreshPermissions";
import type { UserRole } from "../types/ledger";

const roles: UserRole[] = ["owner", "admin", "viewer"];

describe("role permission helpers", () => {
  it("keeps Expense owner-only controls restricted to owner", () => {
    const matrix = Object.fromEntries(
      roles.map((role) => [
        role,
        {
          daily: roleCan(role, "daily"),
          catalogs: roleCan(role, "catalogs"),
          users: roleCan(role, "users"),
          ownerControls: roleCan(role, "ownerControls"),
          importBackup: roleCan(role, "importBackup"),
          masterRefresh: roleCan(role, MASTER_REFRESH_ACCESS),
          read: roleCan(role, "read")
        }
      ])
    );

    expect(matrix.owner).toEqual({
      daily: true,
      catalogs: true,
      users: true,
      ownerControls: true,
      importBackup: true,
      masterRefresh: true,
      read: true
    });
    expect(matrix.admin).toEqual({
      daily: true,
      catalogs: false,
      users: false,
      ownerControls: false,
      importBackup: false,
      masterRefresh: true,
      read: true
    });
    expect(matrix.viewer).toEqual({
      daily: false,
      catalogs: false,
      users: false,
      ownerControls: false,
      importBackup: false,
      masterRefresh: false,
      read: true
    });
  });

  it("keeps Jazz Load settings, backup, and month controls owner-only", () => {
    expect(roleCanJazzLoad("owner", "settings")).toBe(true);
    expect(roleCanJazzLoad("owner", "backup")).toBe(true);
    expect(roleCanJazzLoad("owner", "monthControls")).toBe(true);

    expect(roleCanJazzLoad("admin", "daily")).toBe(true);
    expect(roleCanJazzLoad("admin", "settings")).toBe(false);
    expect(roleCanJazzLoad("admin", "backup")).toBe(false);
    expect(roleCanJazzLoad("admin", "monthControls")).toBe(false);

    expect(roleCanJazzLoad("viewer", "read")).toBe(true);
    expect(roleCanJazzLoad("viewer", "daily")).toBe(false);
  });

  it("allows Jazz Load master refresh only for owner/admin", () => {
    expect(roleCanJazzLoad("owner", MASTER_REFRESH_ACCESS)).toBe(true);
    expect(roleCanJazzLoad("admin", MASTER_REFRESH_ACCESS)).toBe(true);
    expect(roleCanJazzLoad("viewer", MASTER_REFRESH_ACCESS)).toBe(false);
  });

  it("keeps Stock settings, backup, and month controls owner-only", () => {
    expect(roleCanStock("owner", "settings")).toBe(true);
    expect(roleCanStock("owner", "backup")).toBe(true);
    expect(roleCanStock("owner", "monthControls")).toBe(true);

    expect(roleCanStock("admin", "daily")).toBe(true);
    expect(roleCanStock("admin", "settings")).toBe(false);
    expect(roleCanStock("admin", "backup")).toBe(false);
    expect(roleCanStock("admin", "monthControls")).toBe(false);

    expect(roleCanStock("viewer", "read")).toBe(true);
    expect(roleCanStock("viewer", "daily")).toBe(false);
  });

  it("allows Stock master refresh only for owner/admin", () => {
    expect(roleCanStock("owner", MASTER_REFRESH_ACCESS)).toBe(true);
    expect(roleCanStock("admin", MASTER_REFRESH_ACCESS)).toBe(true);
    expect(roleCanStock("viewer", MASTER_REFRESH_ACCESS)).toBe(false);
  });
});
