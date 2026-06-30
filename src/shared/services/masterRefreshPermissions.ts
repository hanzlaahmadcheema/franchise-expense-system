import type { UserRole } from "../../types/ledger";

export const MASTER_REFRESH_ACCESS = "masterRefresh";

export function canRunMasterRefresh(role: UserRole | null) {
  return role === "owner" || role === "admin";
}

export function assertMasterRefreshAccess(role: UserRole | null, label = "Master Refresh") {
  if (!canRunMasterRefresh(role)) {
    throw new Error(`${label} requires owner/admin access.`);
  }
}
