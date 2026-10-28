/**
 * Phase 12C: Offline Queue React Subscription Hook
 *
 * Provides a single, unified, reactive subscription to MutationQueueManager state:
 * - Reactive queue count and status calculation
 * - Window online/offline status
 * - Feature flag status (defaults to OFF)
 * - Safe retry and discard actions
 *
 * Guarantees a single authoritative MutationQueueManager instance (no duplicate workers).
 */

import { useEffect, useState, useCallback } from "react";
import { isOfflineQueueEnabled } from "./featureFlag";
import { getActiveQueueManager } from "./mutationQueueManager";
import type { QueuedMutationRecord } from "./types";

export type GlobalQueueState =
  | "synced"
  | "offline"
  | "pending"
  | "syncing"
  | "conflict"
  | "failed_governance"
  | "failed_fatal"
  | "paused_auth";

export interface UseOfflineQueueResult {
  queueState: GlobalQueueState;
  statusLabel: string;
  isOnline: boolean;
  isQueueEnabled: boolean;
  items: QueuedMutationRecord[];
  pendingCount: number;
  conflictCount: number;
  governanceCount: number;
  fatalCount: number;
  pausedAuthCount: number;
  retryItem: (id: string, updatedPayload?: Record<string, unknown>, updatedBaseRevision?: number) => Promise<void>;
  retryAll: () => Promise<void>;
  discardItem: (id: string) => Promise<void>;
  clearQueue: () => Promise<void>;
  drainQueue: () => Promise<void>;
}

export function computeGlobalQueueState(params: {
  isOnline: boolean;
  isQueueEnabled: boolean;
  items: QueuedMutationRecord[];
}): { queueState: GlobalQueueState; statusLabel: string } {
  const { isOnline, isQueueEnabled, items } = params;

  const pendingItems = items.filter((i) => i.status === "queued" || i.status === "sending");
  const conflictItems = items.filter((i) => i.status === "conflict");
  const governanceItems = items.filter((i) => i.status === "failed_governance");
  const fatalItems = items.filter((i) => i.status === "failed_fatal");
  const pausedAuthItems = items.filter((i) => i.status === "paused_auth");

  // If feature flag is OFF, offline queue mutations are inactive
  if (!isQueueEnabled) {
    if (!isOnline) {
      return {
        queueState: "offline",
        statusLabel: "Offline (Direct API Mode — Queue Standby)"
      };
    }
    return {
      queueState: "synced",
      statusLabel: "Online (Direct API Mode — Queue Standby)"
    };
  }

  // Feature flag is ON: Evaluate queue states with strict precedence
  if (conflictItems.length > 0) {
    const count = conflictItems.length;
    return {
      queueState: "conflict",
      statusLabel: `${count} conflict${count > 1 ? "s" : ""} — action required`
    };
  }

  if (governanceItems.length > 0) {
    return {
      queueState: "failed_governance",
      statusLabel: "Accounting day closed — action required"
    };
  }

  if (pausedAuthItems.length > 0) {
    return {
      queueState: "paused_auth",
      statusLabel: "Sign-in required to sync changes"
    };
  }

  if (fatalItems.length > 0) {
    return {
      queueState: "failed_fatal",
      statusLabel: "Sync failed — check error details"
    };
  }

  if (pendingItems.length > 0) {
    const count = pendingItems.length;
    if (isOnline) {
      return {
        queueState: "syncing",
        statusLabel: `Syncing ${count} change${count > 1 ? "s" : ""} to PostgreSQL...`
      };
    }
    return {
      queueState: "pending",
      statusLabel: `Offline mode — ${count} change${count > 1 ? "s" : ""} queued locally`
    };
  }

  if (!isOnline) {
    return {
      queueState: "offline",
      statusLabel: "Offline mode — all previous changes synced"
    };
  }

  return {
    queueState: "synced",
    statusLabel: "All changes synced to PostgreSQL"
  };
}

export function useOfflineQueue(): UseOfflineQueueResult {
  const manager = getActiveQueueManager();
  const [items, setItems] = useState<QueuedMutationRecord[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const isQueueEnabled = isOfflineQueueEnabled();

  const refreshItems = useCallback(async () => {
    try {
      const all = await manager.listAll();
      setItems(all);
    } catch {
      // Storage read error
    }
  }, [manager]);

  useEffect(() => {
    void refreshItems();

    // Subscribe to internal queue events
    const unsubscribe = manager.subscribe(() => {
      void refreshItems();
    });

    const handleOnline = () => {
      setIsOnline(true);
      void refreshItems();
    };

    const handleOffline = () => {
      setIsOnline(false);
      void refreshItems();
    };

    if (typeof window !== "undefined") {
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
    }

    return () => {
      unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      }
    };
  }, [manager, refreshItems]);

  const { queueState, statusLabel } = computeGlobalQueueState({
    isOnline,
    isQueueEnabled,
    items
  });

  const pendingCount = items.filter((i) => i.status === "queued" || i.status === "sending").length;
  const conflictCount = items.filter((i) => i.status === "conflict").length;
  const governanceCount = items.filter((i) => i.status === "failed_governance").length;
  const fatalCount = items.filter((i) => i.status === "failed_fatal").length;
  const pausedAuthCount = items.filter((i) => i.status === "paused_auth").length;

  const retryItem = useCallback(
    async (id: string, updatedPayload?: Record<string, unknown>, updatedBaseRevision?: number) => {
      await manager.retryItem(id, updatedPayload, updatedBaseRevision);
      await refreshItems();
    },
    [manager, refreshItems]
  );

  const retryAll = useCallback(async () => {
    await manager.retryAllEligible();
    await refreshItems();
  }, [manager, refreshItems]);

  const discardItem = useCallback(
    async (id: string) => {
      await manager.discardItem(id);
      await refreshItems();
    },
    [manager, refreshItems]
  );

  const clearQueue = useCallback(async () => {
    await manager.clearQueue();
    await refreshItems();
  }, [manager, refreshItems]);

  const drainQueue = useCallback(async () => {
    await manager.drainQueue();
    await refreshItems();
  }, [manager, refreshItems]);

  return {
    queueState,
    statusLabel,
    isOnline,
    isQueueEnabled,
    items,
    pendingCount,
    conflictCount,
    governanceCount,
    fatalCount,
    pausedAuthCount,
    retryItem,
    retryAll,
    discardItem,
    clearQueue,
    drainQueue
  };
}
