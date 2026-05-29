export type SyncState = "offline" | "syncing" | "synced" | "error";

export function syncStatusLabel(syncState: SyncState) {
  if (syncState === "offline") return "Offline mode - changes saved locally";
  if (syncState === "syncing") return "Syncing changes...";
  if (syncState === "error") return "Firestore permission/error";
  return "All changes synced";
}

export function nextSyncState({
  online,
  hasPendingWrites,
  hasError = false
}: {
  online: boolean;
  hasPendingWrites: boolean;
  hasError?: boolean;
}): SyncState {
  if (hasError) return "error";
  if (!online) return "offline";
  return hasPendingWrites ? "syncing" : "synced";
}
