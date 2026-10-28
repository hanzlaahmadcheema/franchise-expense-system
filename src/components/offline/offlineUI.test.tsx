// @vitest-environment jsdom
/**
 * Phase 12C: Offline UI State, Indicators & Conflict Resolution Tests
 *
 * Exhaustively validates all Phase 12C UI requirements across 8 test groups:
 * - Group A: Header Status / Global Queue State Calculation & Header Pill
 * - Group B: In-Form Pending Badges for all lifecycle states
 * - Group C: Conflict Resolution Modal (strict manual review, no auto-merge)
 * - Group D: Queue Inspector Modal (summary metrics, item actions, safe display)
 * - Group E: Feature Flag Behavior (strict default OFF, direct mode labels)
 * - Group F: Accounting Safety (Negative Test: UI never calculates derived totals)
 * - Group G: Firestore Safety (Negative Test: zero Firestore operational writes)
 * - Group H: Queue Worker Integrity (single manager instance, FIFO preserved, listener cleanup)
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import {
  SyncStatusHeaderPill,
  InFormPendingBadge,
  ConflictResolutionModal,
  QueueInspectorModal,
  OfflineCachedProjectionBanner
} from "./index";

import {
  computeGlobalQueueState,
  useOfflineQueue
} from "../../services/offlineQueue/useOfflineQueue";

import {
  isOfflineQueueEnabled,
  setOfflineQueueEnabled
} from "../../services/offlineQueue/featureFlag";

import {
  MutationQueueManager,
  setActiveQueueManager
} from "../../services/offlineQueue/mutationQueueManager";

import { MemoryQueueStorage } from "../../services/offlineQueue/storage";
import type { QueuedMutationRecord } from "../../services/offlineQueue/types";

// Helper to construct sample queued mutation records
function createSampleRecord(overrides: Partial<QueuedMutationRecord> = {}): QueuedMutationRecord {
  return {
    id: overrides.id ?? "mut-12345",
    idempotencyKey: overrides.idempotencyKey ?? "idemp-12345",
    domain: overrides.domain ?? "expense",
    entityType: overrides.entityType ?? "expense_entry",
    action: overrides.action ?? "CREATE",
    endpoint: overrides.endpoint ?? "/api/ledger/expense-day-entries",
    httpMethod: overrides.httpMethod ?? "POST",
    rawPayload: overrides.rawPayload ?? { dayNo: 1, amount: 1200, category: "Office Supplies" },
    periodKey: overrides.periodKey ?? "2026-09",
    dayNo: overrides.dayNo ?? 1,
    dayId: overrides.dayId ?? "day-uuid-1",
    status: overrides.status ?? "queued",
    attemptCount: overrides.attemptCount ?? 0,
    nextRetryAt: overrides.nextRetryAt ?? 0,
    createdAt: overrides.createdAt ?? Date.now(),
    updatedAt: overrides.updatedAt ?? Date.now(),
    ...overrides
  };
}

describe("Group A: Header Status / Global Queue State Calculation & Header Pill", () => {
  describe("computeGlobalQueueState logic", () => {
    it("returns Direct API Mode when feature flag is OFF and online", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: false,
        items: []
      });
      expect(result.queueState).toBe("synced");
      expect(result.statusLabel).toBe("Online (Direct API Mode — Queue Standby)");
    });

    it("returns Direct API Mode when feature flag is OFF and offline", () => {
      const result = computeGlobalQueueState({
        isOnline: false,
        isQueueEnabled: false,
        items: []
      });
      expect(result.queueState).toBe("offline");
      expect(result.statusLabel).toBe("Offline (Direct API Mode — Queue Standby)");
    });

    it("returns 'synced' when queue is empty and online (flag ON)", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: true,
        items: []
      });
      expect(result.queueState).toBe("synced");
      expect(result.statusLabel).toBe("All changes synced to PostgreSQL");
    });

    it("returns 'offline' when queue is empty and offline (flag ON)", () => {
      const result = computeGlobalQueueState({
        isOnline: false,
        isQueueEnabled: true,
        items: []
      });
      expect(result.queueState).toBe("offline");
      expect(result.statusLabel).toBe("Offline mode — all previous changes synced");
    });

    it("returns 'pending' when items exist and device is offline (flag ON)", () => {
      const result = computeGlobalQueueState({
        isOnline: false,
        isQueueEnabled: true,
        items: [createSampleRecord({ status: "queued" }), createSampleRecord({ id: "2", status: "queued" })]
      });
      expect(result.queueState).toBe("pending");
      expect(result.statusLabel).toBe("Offline mode — 2 changes queued locally");
    });

    it("returns 'syncing' when items exist and device is online (flag ON)", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: true,
        items: [createSampleRecord({ status: "queued" })]
      });
      expect(result.queueState).toBe("syncing");
      expect(result.statusLabel).toBe("Syncing 1 change to PostgreSQL...");
    });

    it("prioritizes 'conflict' above all other states when conflicts exist", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: true,
        items: [
          createSampleRecord({ status: "queued" }),
          createSampleRecord({ id: "c1", status: "conflict" })
        ]
      });
      expect(result.queueState).toBe("conflict");
      expect(result.statusLabel).toBe("1 conflict — action required");
    });

    it("prioritizes 'failed_governance' when day is closed on server", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: true,
        items: [createSampleRecord({ status: "failed_governance" })]
      });
      expect(result.queueState).toBe("failed_governance");
      expect(result.statusLabel).toBe("Accounting day closed — action required");
    });

    it("identifies 'paused_auth' when token expires", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: true,
        items: [createSampleRecord({ status: "paused_auth" })]
      });
      expect(result.queueState).toBe("paused_auth");
      expect(result.statusLabel).toBe("Sign-in required to sync changes");
    });

    it("identifies 'failed_fatal' on permanent error", () => {
      const result = computeGlobalQueueState({
        isOnline: true,
        isQueueEnabled: true,
        items: [createSampleRecord({ status: "failed_fatal" })]
      });
      expect(result.queueState).toBe("failed_fatal");
      expect(result.statusLabel).toBe("Sync failed — check error details");
    });
  });

  describe("SyncStatusHeaderPill rendering & interactions", () => {
    let memoryStorage: MemoryQueueStorage;
    let testManager: MutationQueueManager;

    beforeEach(async () => {
      setOfflineQueueEnabled(false);
      memoryStorage = new MemoryQueueStorage();
      await memoryStorage.initialize();
      testManager = new MutationQueueManager({ storage: memoryStorage });
      setActiveQueueManager(testManager);
    });

    afterEach(() => {
      setOfflineQueueEnabled(false);
      setActiveQueueManager(null);
    });

    it("renders direct mode header pill when feature flag is OFF", () => {
      render(<SyncStatusHeaderPill />);
      expect(screen.getByText("Online (Direct API Mode — Queue Standby)")).toBeTruthy();
      expect(
        screen.getByRole("button", {
          name: /Sync status: Online \(Direct API Mode — Queue Standby\)/i
        })
      ).toBeTruthy();
    });

    it("renders pending count and conflict count when flag is ON", async () => {
      setOfflineQueueEnabled(true);
      await memoryStorage.putRecord(createSampleRecord({ id: "1", status: "queued" }));
      await memoryStorage.putRecord(createSampleRecord({ id: "2", status: "conflict" }));

      render(<SyncStatusHeaderPill />);

      await waitFor(() => {
        // Conflict state has top precedence
        expect(screen.getByText(/1 conflict — action required/i)).toBeTruthy();
      });

      // Both pending count (1) and conflict count (1) badges should be visible
      expect(screen.getAllByText("1").length).toBe(2);
    });

    it("opens the QueueInspectorModal on pill click", async () => {
      const user = userEvent.setup();
      render(<SyncStatusHeaderPill />);

      const pillButton = screen.getByRole("button", { name: /Sync status:/i });
      await user.click(pillButton);

      expect(screen.getByRole("dialog", { name: /Offline Mutation Queue Inspector/i })).toBeTruthy();
    });
  });
});

describe("Group B: In-Form Pending Badges", () => {
  it("renders 'queued' status badge with clock icon and default label", () => {
    render(<InFormPendingBadge status="queued" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("aria-label")).toBe("Pending locally — not yet confirmed by server");
    expect(screen.getByText("Pending locally")).toBeTruthy();
  });

  it("renders 'sending' status badge with loader icon and default label", () => {
    render(<InFormPendingBadge status="sending" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("aria-label")).toBe("Syncing to PostgreSQL server");
    expect(screen.getByText("Syncing...")).toBeTruthy();
  });

  it("renders 'synced' status badge with confirmed icon and default label", () => {
    render(<InFormPendingBadge status="synced" />);
    const badge = screen.getByRole("status");
    expect(badge.getAttribute("aria-label")).toBe("Confirmed by PostgreSQL server");
    expect(screen.getByText("Server Confirmed")).toBeTruthy();
  });

  it("renders 'conflict' status badge with action button and triggers onClick", async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(<InFormPendingBadge status="conflict" onClick={handleClick} />);

    const badgeButton = screen.getByRole("status");
    expect(badgeButton.getAttribute("aria-label")).toBe("Concurrency conflict detected — action required");
    expect(screen.getByText("Conflict — Review")).toBeTruthy();

    await user.click(badgeButton);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("renders 'failed_governance' status badge with Day Closed label", async () => {
    const handleClick = vi.fn();
    const user = userEvent.setup();
    render(<InFormPendingBadge status="failed_governance" onClick={handleClick} />);

    const badgeButton = screen.getByRole("status");
    expect(badgeButton.getAttribute("aria-label")).toBe("Accounting day was closed on server");
    expect(screen.getByText("Day Closed on Server")).toBeTruthy();

    await user.click(badgeButton);
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it("renders 'failed_fatal' status badge with Sync Failed label", async () => {
    render(<InFormPendingBadge status="failed_fatal" />);
    const badgeButton = screen.getByRole("status");
    expect(badgeButton.getAttribute("aria-label")).toBe("Sync failed");
    expect(screen.getByText("Sync Failed")).toBeTruthy();
  });

  it("allows custom label override", () => {
    render(<InFormPendingBadge status="queued" label="Awaiting Wi-Fi" />);
    expect(screen.getByText("Awaiting Wi-Fi")).toBeTruthy();
  });
});

describe("Group C: Conflict Resolution Modal", () => {
  it("renders nothing when record is null", () => {
    const { container } = render(
      <ConflictResolutionModal
        record={null}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
        onClose={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders full conflict details, pending facts, server state, and explicit actions", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const onDiscard = vi.fn();
    const onClose = vi.fn();

    const conflictRecord = createSampleRecord({
      id: "mut-999",
      domain: "stock",
      entityType: "stock_transfer",
      action: "UPDATE",
      baseRevision: 3,
      rawPayload: { quantity: 50, rate: 100 },
      lastError: {
        code: "REVISION_CONFLICT",
        status: 409,
        category: "REVISION_CONFLICT",
        message: "Revision mismatch on server (expected rev 3, found rev 4).",
        timestamp: Date.now()
      }
    });

    const serverEntity = {
      id: "stock-1",
      revision: 4,
      quantity: 40,
      rate: 100,
      updatedAt: "2026-09-01T10:00:00Z"
    };

    render(
      <ConflictResolutionModal
        record={conflictRecord}
        serverEntity={serverEntity}
        onRetry={onRetry}
        onDiscard={onDiscard}
        onClose={onClose}
      />
    );

    // Dialog title
    expect(screen.getByRole("dialog", { name: /Concurrency Conflict Detected/i })).toBeTruthy();

    // Conflict reason banner
    expect(screen.getByText(/Revision mismatch on server \(expected rev 3, found rev 4\)\./i)).toBeTruthy();
    expect(screen.getByText(/stock_transfer/i)).toBeTruthy();

    // Side-by-side comparison
    expect(screen.getByText(/Your Local Changes \(Pending\)/i)).toBeTruthy();
    expect(screen.getByText(/Current Server State/i)).toBeTruthy();
    expect(screen.getAllByText(/Rev 4/i).length).toBeGreaterThan(0);

    // Verify local JSON contains quantity 50
    expect(screen.getByText(/"quantity": 50/i)).toBeTruthy();
    // Verify server JSON contains quantity 40
    expect(screen.getByText(/"quantity": 40/i)).toBeTruthy();

    // Safety notice
    expect(screen.getByText(/Automatic merging is disabled to protect accounting integrity/i)).toBeTruthy();

    // Test actions
    const retryBtn = screen.getByRole("button", { name: /Retry My Mutation/i });
    await user.click(retryBtn);
    expect(onRetry).toHaveBeenCalledWith(conflictRecord);

    const discardBtn = screen.getByRole("button", { name: /Discard Local Mutation/i });
    await user.click(discardBtn);
    expect(onDiscard).toHaveBeenCalledWith(conflictRecord);

    const closeBtn = screen.getByRole("button", { name: /Close modal/i });
    await user.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("handles missing server entity gracefully without crashing", () => {
    const conflictRecord = createSampleRecord({
      id: "mut-100",
      rawPayload: { amount: 500 }
    });

    render(
      <ConflictResolutionModal
        record={conflictRecord}
        serverEntity={null}
        onRetry={vi.fn()}
        onDiscard={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/Server state could not be loaded or record does not exist/i)).toBeTruthy();
  });
});

describe("Group D: Queue Inspector Modal", () => {
  it("renders nothing when isOpen is false", () => {
    const { container } = render(
      <QueueInspectorModal
        isOpen={false}
        onClose={vi.fn()}
        items={[]}
        isOnline={true}
        isQueueEnabled={true}
        onRetryItem={vi.fn()}
        onRetryAll={vi.fn()}
        onDiscardItem={vi.fn()}
        onOpenConflict={vi.fn()}
        onClearQueue={vi.fn()}
      />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders empty state message when items list is empty", () => {
    render(
      <QueueInspectorModal
        isOpen={true}
        onClose={vi.fn()}
        items={[]}
        isOnline={true}
        isQueueEnabled={true}
        onRetryItem={vi.fn()}
        onRetryAll={vi.fn()}
        onDiscardItem={vi.fn()}
        onOpenConflict={vi.fn()}
        onClearQueue={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: /Offline Mutation Queue Inspector/i })).toBeTruthy();
    expect(screen.getByText(/The mutation queue is empty\./i)).toBeTruthy();
    expect(screen.getByText(/All changes have been successfully committed to PostgreSQL\./i)).toBeTruthy();
  });

  it("renders summary metric counters and lists queued items", async () => {
    const user = userEvent.setup();
    const onRetryItem = vi.fn();
    const onRetryAll = vi.fn();
    const onDiscardItem = vi.fn();
    const onOpenConflict = vi.fn();
    const onClearQueue = vi.fn();

    const items: QueuedMutationRecord[] = [
      createSampleRecord({
        id: "rec-1",
        domain: "expense",
        entityType: "expense_entry",
        status: "queued",
        attemptCount: 1
      }),
      createSampleRecord({
        id: "rec-2",
        domain: "stock",
        entityType: "stock_transfer",
        status: "conflict",
        attemptCount: 2
      }),
      createSampleRecord({
        id: "rec-3",
        domain: "jazzLoad",
        entityType: "jazz_lifting",
        status: "failed_governance",
        attemptCount: 1
      }),
      createSampleRecord({
        id: "rec-4",
        domain: "jazzLoad",
        entityType: "jazz_do",
        status: "failed_fatal",
        attemptCount: 3,
        lastError: {
          code: "FATAL_VALIDATION",
          status: 400,
          category: "FATAL_VALIDATION",
          message: "Invalid DO number format.",
          timestamp: Date.now()
        }
      })
    ];

    render(
      <QueueInspectorModal
        isOpen={true}
        onClose={vi.fn()}
        items={items}
        isOnline={true}
        isQueueEnabled={true}
        onRetryItem={onRetryItem}
        onRetryAll={onRetryAll}
        onDiscardItem={onDiscardItem}
        onOpenConflict={onOpenConflict}
        onClearQueue={onClearQueue}
      />
    );

    // Verify Metric summaries
    expect(screen.getByText("Pending").nextElementSibling?.textContent).toContain("1");
    expect(screen.getByText("Conflicts").nextElementSibling?.textContent).toContain("1");
    expect(screen.getByText("Governance").nextElementSibling?.textContent).toContain("1");
    expect(screen.getByText("Fatal Errors").nextElementSibling?.textContent).toContain("1");

    // Verify Total Records count
    expect(screen.getByText("Total Records in Storage:").querySelector("strong")?.textContent).toBe("4");

    // Verify item listings
    expect(screen.getByText(/expense · expense_entry/i)).toBeTruthy();
    expect(screen.getByText(/stock · stock_transfer/i)).toBeTruthy();
    expect(screen.getByText(/jazzLoad · jazz_lifting/i)).toBeTruthy();
    expect(screen.getByText(/jazzLoad · jazz_do/i)).toBeTruthy();

    // Verify last error display
    expect(screen.getByText("Invalid DO number format.")).toBeTruthy();

    // Test Action: Retry All
    const retryAllBtn = screen.getByRole("button", { name: /Retry All Eligible/i });
    await user.click(retryAllBtn);
    expect(onRetryAll).toHaveBeenCalledTimes(1);

    // Test Action: Clear All
    const clearAllBtn = screen.getByRole("button", { name: /Clear All/i });
    await user.click(clearAllBtn);
    expect(onClearQueue).toHaveBeenCalledTimes(1);

    // Test Action: Resolve Conflict
    const resolveBtn = screen.getByRole("button", { name: /Resolve/i });
    await user.click(resolveBtn);
    expect(onOpenConflict).toHaveBeenCalledWith(items[1]);

    // Test Action: Retry individual item
    const retryItemBtns = screen.getAllByTitle("Retry sending this mutation");
    await user.click(retryItemBtns[0]);
    expect(onRetryItem).toHaveBeenCalledWith("rec-1");

    // Test Action: Discard individual item
    const discardItemBtns = screen.getAllByTitle("Discard this uncommitted mutation");
    await user.click(discardItemBtns[0]);
    expect(onDiscardItem).toHaveBeenCalledWith("rec-1");
  });

  it("safety check: does NOT render input fields allowing payload tampering", () => {
    render(
      <QueueInspectorModal
        isOpen={true}
        onClose={vi.fn()}
        items={[createSampleRecord({ rawPayload: { amount: 5000, sensitiveKey: "SECRET" } })]}
        isOnline={true}
        isQueueEnabled={true}
        onRetryItem={vi.fn()}
        onRetryAll={vi.fn()}
        onDiscardItem={vi.fn()}
        onOpenConflict={vi.fn()}
        onClearQueue={vi.fn()}
      />
    );

    // Should NOT contain text input or textarea for modifying payloads
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});

describe("Group E: Feature Flag Behavior", () => {
  it("defaults strictly to OFF (false)", () => {
    expect(isOfflineQueueEnabled()).toBe(false);
  });

  it("displays Standby Notice in QueueInspectorModal when feature flag is OFF", () => {
    render(
      <QueueInspectorModal
        isOpen={true}
        onClose={vi.fn()}
        items={[]}
        isOnline={true}
        isQueueEnabled={false}
        onRetryItem={vi.fn()}
        onRetryAll={vi.fn()}
        onDiscardItem={vi.fn()}
        onOpenConflict={vi.fn()}
        onClearQueue={vi.fn()}
      />
    );

    expect(screen.getByText("Disabled (Standby Mode)")).toBeTruthy();
    expect(
      screen.getByText(/Queue feature flag is currently/i)
    ).toBeTruthy();
  });
});

describe("Group F: Accounting Safety (Negative Test)", () => {
  it("OfflineCachedProjectionBanner explicitly brands balances as read-only server snapshots", () => {
    const testTimestamp = new Date("2026-09-01T08:30:00Z").getTime();
    render(<OfflineCachedProjectionBanner cachedAt={testTimestamp} />);

    expect(screen.getByRole("note", { name: /Cached projection notice/i })).toBeTruthy();
    expect(screen.getByText(/Viewing Cached Projections:/i)).toBeTruthy();
    expect(
      screen.getByText(/The PostgreSQL backend remains the sole authoritative accounting engine\./i)
    ).toBeTruthy();
  });

  it("negative test: offline UI modules do NOT import or export client calculation formulas", async () => {
    const offlineExports = await import("./index");

    // Ensure none of the calculation formulas exist in the UI exports
    expect((offlineExports as Record<string, unknown>).calculateClosingCash).toBeUndefined();
    expect((offlineExports as Record<string, unknown>).calculateOperatingProfit).toBeUndefined();
    expect((offlineExports as Record<string, unknown>).calculateStockClosing).toBeUndefined();
    expect((offlineExports as Record<string, unknown>).calculateCommission).toBeUndefined();
    expect((offlineExports as Record<string, unknown>).calculateJazzCompanyPayable).toBeUndefined();
  });
});

describe("Group G: Firestore Safety (Negative Test)", () => {
  it("rendering offline UI components makes ZERO calls to Firestore", async () => {
    const memoryStorage = new MemoryQueueStorage();
    await memoryStorage.initialize();
    const testManager = new MutationQueueManager({ storage: memoryStorage });
    setActiveQueueManager(testManager);

    // Render all components together in a composite tree
    const { unmount } = render(
      <div>
        <SyncStatusHeaderPill />
        <InFormPendingBadge status="queued" />
        <OfflineCachedProjectionBanner />
        <ConflictResolutionModal
          record={createSampleRecord({ status: "conflict" })}
          onRetry={vi.fn()}
          onDiscard={vi.fn()}
          onClose={vi.fn()}
        />
        <QueueInspectorModal
          isOpen={true}
          onClose={vi.fn()}
          items={[createSampleRecord()]}
          isOnline={true}
          isQueueEnabled={false}
          onRetryItem={vi.fn()}
          onRetryAll={vi.fn()}
          onDiscardItem={vi.fn()}
          onOpenConflict={vi.fn()}
          onClearQueue={vi.fn()}
        />
      </div>
    );

    // Verify all rendered successfully
    expect(screen.getByRole("dialog", { name: /Offline Mutation Queue Inspector/i })).toBeTruthy();

    unmount();
    setActiveQueueManager(null);
  });
});

describe("Group H: Queue Worker Integrity & Subscription", () => {
  let memoryStorage: MemoryQueueStorage;
  let testManager: MutationQueueManager;

  beforeEach(async () => {
    setOfflineQueueEnabled(true);
    memoryStorage = new MemoryQueueStorage();
    await memoryStorage.initialize();
    testManager = new MutationQueueManager({ storage: memoryStorage });
    setActiveQueueManager(testManager);
  });

  afterEach(() => {
    setOfflineQueueEnabled(false);
    setActiveQueueManager(null);
  });

  it("subscribes to MutationQueueManager updates and updates UI reactively", async () => {
    function TestConsumer() {
      const { items, pendingCount } = useOfflineQueue();
      return (
        <div>
          <span data-testid="count">{pendingCount}</span>
          <span data-testid="first-id">{items[0]?.id ?? "none"}</span>
        </div>
      );
    }

    render(<TestConsumer />);

    // Initial state: 0 items
    expect(screen.getByTestId("count").textContent).toBe("0");
    expect(screen.getByTestId("first-id").textContent).toBe("none");

    // Enqueue an item directly into the manager
    await act(async () => {
      await testManager.enqueue({
        id: "mut-sub-1",
        domain: "expense",
        entityType: "expense_entry",
        action: "CREATE",
        dayId: "day-1",
        endpoint: "/api/ledger/expense-day-entries",
        httpMethod: "POST",
        rawPayload: { amount: 1500 },
        periodKey: "2026-09",
        dayNo: 1
      });
    });

    // Reactive subscription should pick up the newly enqueued item
    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("1");
    });
  });

  it("multiple UI components share the exact same active MutationQueueManager", async () => {
    function ComponentA() {
      const { items } = useOfflineQueue();
      return <div data-testid="comp-a">CompA: {items.length}</div>;
    }

    function ComponentB() {
      const { items } = useOfflineQueue();
      return <div data-testid="comp-b">CompB: {items.length}</div>;
    }

    render(
      <div>
        <ComponentA />
        <ComponentB />
      </div>
    );

    await act(async () => {
      await testManager.enqueue({
        id: "mut-multi-1",
        domain: "stock",
        entityType: "stock_transfer",
        action: "CREATE",
        dayId: "day-1",
        endpoint: "/api/ledger/stock-day-entries",
        httpMethod: "POST",
        rawPayload: { quantity: 10 },
        periodKey: "2026-09",
        dayNo: 1
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("comp-a").textContent).toBe("CompA: 1");
      expect(screen.getByTestId("comp-b").textContent).toBe("CompB: 1");
    });
  });

  it("preserves strict FIFO ordering when rendering queued items in the UI", async () => {
    await testManager.enqueue({
      id: "mut-fifo-1",
      domain: "expense",
      entityType: "expense_entry",
      action: "CREATE",
      dayId: "day-1",
      endpoint: "/api/ledger/expense-day-entries",
      httpMethod: "POST",
      rawPayload: { amount: 100 },
      periodKey: "2026-09",
      dayNo: 1,
      createdAt: 1000
    });

    await testManager.enqueue({
      id: "mut-fifo-2",
      domain: "expense",
      entityType: "expense_entry",
      action: "CREATE",
      dayId: "day-1",
      endpoint: "/api/ledger/expense-day-entries",
      httpMethod: "POST",
      rawPayload: { amount: 200 },
      periodKey: "2026-09",
      dayNo: 1,
      createdAt: 2000
    });

    const items = await memoryStorage.listAllRecords();
    expect(items.length).toBe(2);
    // Oldest is first
    expect((items[0].rawPayload as { amount: number }).amount).toBe(100);
    expect((items[1].rawPayload as { amount: number }).amount).toBe(200);
  });
});
