import { describe, expect, it } from "vitest";
import { nextSyncState, syncStatusLabel } from "./syncStatus";

describe("sync status helpers", () => {
  it("shows offline local-save status before pending write status", () => {
    const state = nextSyncState({ online: false, hasPendingWrites: true });

    expect(state).toBe("offline");
    expect(syncStatusLabel(state)).toBe("Offline mode - changes saved locally");
  });

  it("shows syncing while online writes are pending", () => {
    const state = nextSyncState({ online: true, hasPendingWrites: true });

    expect(state).toBe("syncing");
    expect(syncStatusLabel(state)).toBe("Syncing changes...");
  });

  it("shows synced when online writes are clear", () => {
    const state = nextSyncState({ online: true, hasPendingWrites: false });

    expect(state).toBe("synced");
    expect(syncStatusLabel(state)).toBe("All changes synced");
  });

  it("surfaces Firestore permission or snapshot errors", () => {
    const state = nextSyncState({ online: true, hasPendingWrites: false, hasError: true });

    expect(state).toBe("error");
    expect(syncStatusLabel(state)).toBe("Firestore permission/error");
  });
});
