import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment
} from "@firebase/rules-unit-testing";
import { deleteField, doc, getDoc, setDoc, writeBatch } from "firebase/firestore";

const describeIfEmulator = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

describeIfEmulator("ledgerV2 Firestore rules", () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: "franchise-ledger-v2-rules-test",
      firestore: {
        rules: readFileSync("firestore.rules", "utf8")
      }
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    const today = new Date();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users", "owner"), { uid: "owner", role: "owner", active: true });
      await setDoc(doc(db, "users", "admin"), { uid: "admin", role: "admin", active: true });
      await setDoc(doc(db, "users", "viewer"), { uid: "viewer", role: "viewer", active: true });
      await setDoc(doc(db, "months", "2026-05"), { id: "2026-05", status: "open" });
      await setDoc(doc(db, "months", "2026-05", "days", "1"), {
        dayNo: 1,
        entryYear: today.getFullYear(),
        entryMonth: today.getMonth() + 1,
        entryDay: today.getDate(),
        lockedAt: null
      });
      await setDoc(doc(db, "months", "2026-05", "days", "2"), {
        dayNo: 2,
        entryYear: 2026,
        entryMonth: 5,
        entryDay: 2,
        lockedAt: Date.now()
      });
      await setDoc(doc(db, "months", "2026-05", "days", "31"), {
        dayNo: 31,
        entryYear: 2099,
        entryMonth: 12,
        entryDay: 31,
        lockedAt: null
      });
      await setDoc(doc(db, "months", "2026-06"), { id: "2026-06", status: "open" });
      await setDoc(doc(db, "months", "2026-06", "days", "1"), {
        dayNo: 1,
        entryYear: 2026,
        entryMonth: 6,
        entryDay: 1,
        lockedAt: Date.now()
      });
      await setDoc(doc(db, "months", "2026-06", "days", String(today.getDate())), {
        dayNo: today.getDate(),
        entryYear: today.getFullYear(),
        entryMonth: today.getMonth() + 1,
        entryDay: today.getDate(),
        lockedAt: null
      });
      const liveDayId = String(today.getDate());
      await setDoc(doc(db, "jazzLoadMonths", "2026-05"), { id: "2026-05", status: "open" });
      await setDoc(doc(db, "jazzLoadMonths", "2026-05", "days", liveDayId), {
        id: liveDayId,
        monthId: "2026-05",
        dayNo: today.getDate(),
        status: "open"
      });
      await setDoc(doc(db, "stockMonths", "2026-05"), { id: "2026-05", status: "open" });
      await setDoc(doc(db, "stockMonths", "2026-05", "days", liveDayId), {
        id: liveDayId,
        monthId: "2026-05",
        dayNo: today.getDate(),
        entryYear: today.getFullYear(),
        entryMonth: today.getMonth() + 1,
        entryDay: today.getDate(),
        status: "open"
      });
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  function authedDb(uid: "owner" | "admin" | "viewer") {
    return testEnv.authenticatedContext(uid, { email: `${uid}@example.com` }).firestore();
  }

  function stageExpenseSaveBatch(
    uid: "owner" | "admin",
    monthId = "2026-06",
    dayNo = new Date().getDate()
  ) {
    const today = new Date();
    const db = authedDb(uid);
    const batch = writeBatch(db);
    batch.set(doc(db, "months", monthId), {
      id: monthId,
      label: monthId,
      openingBalance: 0,
      status: "open",
      updatedAt: Date.now()
    }, { merge: true });
    batch.set(doc(db, "months", monthId, "days", String(dayNo)), {
      dayNo,
      entryYear: today.getFullYear(),
      entryMonth: today.getMonth() + 1,
      entryDay: today.getDate(),
      lockedAt: null,
      updatedAt: Date.now()
    }, { merge: true });
    batch.set(doc(db, "months", monthId, "days", String(dayNo), "expenses", "rent"), {
      id: "rent",
      name: "Rent",
      amount: 100
    });
    batch.set(doc(db, "months", monthId, "days", String(dayNo), "credits", "usman"), {
      id: "usman",
      partyName: "Usman Cheema",
      opening: 2000,
      loan: 9000,
      receive: 0
    });
    batch.set(doc(db, "months", monthId, "summary", "home"), {
      monthlyExpenseTotal: 100,
      creditBalanceTotal: 11000
    }, { merge: true });
    batch.set(doc(db, "months", monthId, "audit", `${uid}-save`), {
      id: `${uid}-save`,
      createdAt: Date.now(),
      action: "edit-day",
      detail: "Saved day",
      actorUid: uid
    });
    batch.set(doc(db, "auditLogs", `${uid}-save`), {
      id: `${uid}-save`,
      createdAt: Date.now(),
      module: "expense",
      action: "edit-day",
      summary: "Saved day",
      actorUid: uid,
      actorEmail: `${uid}@example.com`,
      actorRole: uid
    });
    return batch.commit();
  }

  function stageExpenseMasterRefreshBatch(uid: "owner" | "admin", monthId = "2026-06", dayNo = 1) {
    const db = authedDb(uid);
    const recalculatedAt = Date.now();
    const batch = writeBatch(db);
    batch.set(doc(db, "months", monthId), {
      id: monthId,
      label: monthId,
      openingBalance: 0,
      status: "open",
      updatedAt: recalculatedAt
    }, { merge: true });
    batch.set(doc(db, "months", monthId, "days", String(dayNo)), {
      dayNo,
      entryYear: 2026,
      entryMonth: 6,
      entryDay: dayNo,
      lockedAt: Date.now(),
      recalculatedAt,
      recalculatedBy: uid,
      recalculatedByRole: uid,
      recalculationSource: "master-refresh-local-fallback",
      updatedAt: recalculatedAt
    }, { merge: true });
    batch.set(doc(db, "months", monthId, "days", String(dayNo), "credits", "usman"), {
      id: "usman",
      partyName: "Usman Cheema",
      opening: 2000,
      loan: 9000,
      receive: 0,
      balance: 11000
    });
    batch.set(doc(db, "months", monthId, "summary", "home"), {
      creditBalanceTotal: 11000,
      ownerBalanceTotal: 0
    }, { merge: true });
    return batch.commit();
  }

  it("allows owners to enable shadow mode but blocks hard v2 cutover without a reviewed report", async () => {
    const db = authedDb("owner");
    await assertSucceeds(setDoc(doc(db, "settings", "ledger", "config", "main"), {
      expenseReadMode: "v2-shadow",
      jazzLoadReadMode: "v1",
      stockReadMode: "v1"
    }));
    await assertFails(setDoc(doc(db, "settings", "ledger", "config", "main"), {
      expenseReadMode: "v2",
      jazzLoadReadMode: "v1",
      stockReadMode: "v1"
    }));
    await assertSucceeds(setDoc(doc(db, "settings", "ledger", "config", "main"), {
      expenseReadMode: "v2",
      jazzLoadReadMode: "v1",
      stockReadMode: "v1",
      verifiedReportId: "ledger-v2-2026-05-reviewed"
    }));
  });

  it("blocks viewers from writing raw entries", async () => {
    const db = authedDb("viewer");
    await assertFails(setDoc(doc(db, "ledgerV2", "expense", "months", "2026-05", "days", "1", "rawEntries", "credit-usman"), {
      raw: { loan: 9000 }
    }));
  });

  it("allows owner and admin Expense current-day saves for June 2026", async () => {
    await assertSucceeds(stageExpenseSaveBatch("owner"));
    await assertSucceeds(stageExpenseSaveBatch("admin"));
  });

  it("allows owner and admin Expense Master Refresh recalculation repairs for June 2026", async () => {
    await assertSucceeds(stageExpenseMasterRefreshBatch("owner"));
    await assertSucceeds(stageExpenseMasterRefreshBatch("admin"));
  });

  it("blocks viewer Expense saves and Master Refresh recalculation repairs", async () => {
    const today = new Date();
    const viewerDb = authedDb("viewer");
    await assertFails(setDoc(doc(viewerDb, "months", "2026-06", "days", String(today.getDate())), {
      dayNo: today.getDate(),
      entryYear: today.getFullYear(),
      entryMonth: today.getMonth() + 1,
      entryDay: today.getDate(),
      lockedAt: null
    }, { merge: true }));
    const recalculatedAt = Date.now();
    await assertFails(setDoc(doc(viewerDb, "months", "2026-06", "days", "1"), {
      dayNo: 1,
      entryYear: 2026,
      entryMonth: 6,
      entryDay: 1,
      recalculatedAt,
      recalculatedBy: "viewer",
      recalculatedByRole: "viewer",
      recalculationSource: "master-refresh-local-fallback"
    }, { merge: true }));
  });

  it("allows owner Expense v2 raw writes for editable paths", async () => {
    const ownerDb = authedDb("owner");
    await assertSucceeds(setDoc(doc(ownerDb, "ledgerV2", "expense", "months", "2026-05", "days", "1", "rawEntries", "credit-usman"), {
      raw: { loan: 9000 }
    }));
  });

  it("allows admin Jazz Load v2 raw writes for editable paths", async () => {
    const today = new Date();
    const liveDayId = String(today.getDate());
    const adminDb = authedDb("admin");
    await assertSucceeds(setDoc(doc(adminDb, "ledgerV2", "jazzLoad", "months", "2026-05", "days", liveDayId, "rawEntries", "do-main"), {
      monthId: "2026-05",
      dayNo: today.getDate(),
      raw: { todayMlIssuanceBase: 1000 }
    }));
  });

  it("allows admin Stock v2 raw writes for editable paths", async () => {
    const today = new Date();
    const liveDayId = String(today.getDate());
    const adminDb = authedDb("admin");
    await assertSucceeds(setDoc(doc(adminDb, "ledgerV2", "stock", "months", "2026-05", "days", liveDayId, "rawEntries", "stock-out-main"), {
      monthId: "2026-05",
      dayNo: today.getDate(),
      raw: { quantity: 10 }
    }));
  });

  it("blocks admin and viewer settings writes while allowing owner settings writes", async () => {
    const ownerDb = authedDb("owner");
    const adminDb = authedDb("admin");
    const viewerDb = authedDb("viewer");

    await assertSucceeds(setDoc(doc(ownerDb, "settings", "expenseCategories", "items", "rent"), {
      id: "rent",
      name: "Rent",
      active: true
    }));
    await assertFails(setDoc(doc(adminDb, "settings", "expenseCategories", "items", "rent-admin"), {
      id: "rent-admin",
      name: "Rent Admin",
      active: true
    }));
    await assertFails(setDoc(doc(adminDb, "jazzLoadSettings", "doNames", "items", "admin-do"), {
      id: "admin-do",
      name: "Admin DO",
      active: true
    }));
    await assertFails(setDoc(doc(adminDb, "stockSettings", "products", "items", "admin-product"), {
      id: "admin-product",
      name: "Admin Product",
      active: true
    }));
    await assertFails(setDoc(doc(adminDb, "settings", "ledger", "config", "main"), {
      expenseReadMode: "v2",
      jazzLoadReadMode: "v1",
      stockReadMode: "v1",
      verifiedReportId: "admin-should-not-cut-over"
    }));
    await assertFails(setDoc(doc(viewerDb, "settings", "creditParties", "items", "viewer-party"), {
      id: "viewer-party",
      name: "Viewer Party",
      active: true
    }));
  });

  it("blocks admin previous-day reopen but allows owner previous-day reopen", async () => {
    const ownerDb = authedDb("owner");
    const adminDb = authedDb("admin");
    const reopenedAt = Date.now();

    await assertFails(setDoc(doc(adminDb, "months", "2026-05", "days", "2"), {
      dayNo: 2,
      entryYear: 2026,
      entryMonth: 5,
      entryDay: 2,
      lockedAt: Date.now(),
      reopenedAt,
      reopenedByRole: "admin"
    }, { merge: true }));

    await assertSucceeds(setDoc(doc(ownerDb, "months", "2026-05", "days", "2"), {
      dayNo: 2,
      entryYear: 2026,
      entryMonth: 5,
      entryDay: 2,
      lockedAt: Date.now(),
      reopenedAt,
      reopenedByRole: "owner"
    }, { merge: true }));
  });

  it("allows admin to edit an owner-reopened previous Expense day while preserving close/reopen metadata", async () => {
    const ownerDb = authedDb("owner");
    const adminDb = authedDb("admin");
    const viewerDb = authedDb("viewer");
    const reopenedAt = Date.now();

    await assertFails(setDoc(doc(adminDb, "months", "2026-05", "days", "2", "expenses", "admin-before-reopen"), {
      id: "admin-before-reopen",
      name: "Repair",
      amount: 50
    }));

    await assertSucceeds(setDoc(doc(ownerDb, "months", "2026-05", "days", "2"), {
      dayNo: 2,
      entryYear: 2026,
      entryMonth: 5,
      entryDay: 2,
      reopenedAt,
      reopenedByRole: "owner"
    }, { merge: true }));

    const batch = writeBatch(adminDb);
    batch.set(doc(adminDb, "months", "2026-05", "days", "2"), {
      dayNo: 2,
      entryYear: 2026,
      entryMonth: 5,
      entryDay: 2,
      reopenedAt,
      reopenedByRole: "owner",
      updatedAt: Date.now()
    }, { merge: true });
    batch.set(doc(adminDb, "months", "2026-05", "days", "2", "expenses", "admin-repair"), {
      id: "admin-repair",
      name: "Repair",
      amount: 50
    }, { merge: true });
    batch.set(doc(adminDb, "ledgerV2", "expense", "months", "2026-05", "days", "2", "rawEntries", "admin-repair"), {
      raw: { amount: 50 }
    }, { merge: true });
    await assertSucceeds(batch.commit());

    await assertFails(setDoc(doc(viewerDb, "months", "2026-05", "days", "2", "expenses", "viewer-repair"), {
      id: "viewer-repair",
      name: "Viewer Repair",
      amount: 50
    }));
  });

  it("allows admin to close the current Expense day while syncing child rows", async () => {
    const today = new Date();
    const liveDayId = String(today.getDate());
    const adminDb = authedDb("admin");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "months", "2026-05", "days", liveDayId), {
        dayNo: today.getDate(),
        entryYear: today.getFullYear(),
        entryMonth: today.getMonth() + 1,
        entryDay: today.getDate(),
        lockedAt: null
      });
      await setDoc(doc(db, "months", "2026-05", "days", liveDayId, "commissions", "jazzload"), {
        id: "jazzload",
        categoryId: "jazzload",
        amount: 7366
      });
    });

    const lockedAt = Date.now();
    const batch = writeBatch(adminDb);
    batch.set(doc(adminDb, "months", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      entryYear: today.getFullYear(),
      entryMonth: today.getMonth() + 1,
      entryDay: today.getDate(),
      lockedAt,
      lockedBy: "admin",
      lockedByRole: "admin"
    }, { merge: true });
    batch.set(doc(adminDb, "months", "2026-05", "days", liveDayId, "commissions", "jazzload"), {
      id: "jazzload",
      categoryId: "jazzload",
      amount: 7366
    }, { merge: true });

    await assertSucceeds(batch.commit());
  });

  it.each(["owner", "admin"] as const)("allows %s to close the current Jazz Load day and keeps it closed", async (uid) => {
    const today = new Date();
    const liveDayId = String(today.getDate());
    const db = authedDb(uid);
    const lockedAt = Date.now();

    await assertSucceeds(setDoc(doc(db, "jazzLoadMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      status: "closed",
      lockedAt,
      lockedBy: uid,
      lockedByRole: uid,
      closedAt: lockedAt,
      closedBy: uid,
      reopenedUntilAt: deleteField(),
      reopenedAt: deleteField(),
      reopenedBy: deleteField(),
      reopenedByRole: deleteField()
    }, { merge: true }));

    await assertFails(setDoc(doc(db, "jazzLoadMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      status: "open",
      updatedAt: Date.now()
    }, { merge: true }));

    const snapshot = await getDoc(doc(db, "jazzLoadMonths", "2026-05", "days", liveDayId));
    expect(snapshot.data()?.status).toBe("closed");
  });

  it.each(["owner", "admin"] as const)("allows %s to close the current Stock day and blocks stale autosave", async (uid) => {
    const today = new Date();
    const liveDayId = String(today.getDate());
    const db = authedDb(uid);
    const lockedAt = Date.now();

    await assertSucceeds(setDoc(doc(db, "stockMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      entryYear: today.getFullYear(),
      entryMonth: today.getMonth() + 1,
      entryDay: today.getDate(),
      status: "closed",
      lockedAt,
      lockedBy: uid,
      lockedByRole: uid,
      closedAt: lockedAt,
      closedBy: uid,
      reopenedUntilAt: deleteField(),
      reopenedAt: deleteField(),
      reopenedBy: deleteField(),
      reopenedByRole: deleteField()
    }, { merge: true }));

    await assertFails(setDoc(doc(db, "stockMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      entryYear: today.getFullYear(),
      entryMonth: today.getMonth() + 1,
      entryDay: today.getDate(),
      status: "open",
      updatedAt: Date.now()
    }, { merge: true }));
  });

  it("blocks viewer close and requires an explicit valid reopen", async () => {
    const today = new Date();
    const liveDayId = String(today.getDate());
    const viewerDb = authedDb("viewer");
    const adminDb = authedDb("admin");
    const lockedAt = Date.now();

    await assertFails(setDoc(doc(viewerDb, "jazzLoadMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      status: "closed",
      lockedAt,
      lockedBy: "viewer",
      lockedByRole: "viewer"
    }, { merge: true }));

    await assertSucceeds(setDoc(doc(adminDb, "jazzLoadMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      status: "closed",
      lockedAt,
      lockedBy: "admin",
      lockedByRole: "admin",
      closedAt: lockedAt,
      closedBy: "admin"
    }, { merge: true }));

    const reopenedAt = lockedAt + 1;
    await assertSucceeds(setDoc(doc(adminDb, "jazzLoadMonths", "2026-05", "days", liveDayId), {
      dayNo: today.getDate(),
      status: "open",
      lockedAt: deleteField(),
      lockedBy: deleteField(),
      lockedByRole: deleteField(),
      closedAt: deleteField(),
      closedBy: deleteField(),
      reopenedAt,
      reopenedBy: "admin",
      reopenedByRole: "admin",
      reopenedUntilAt: deleteField()
    }, { merge: true }));
  });

  it("blocks admin previous-day v2 raw writes", async () => {
    const adminDb = authedDb("admin");
    await assertFails(setDoc(doc(adminDb, "ledgerV2", "jazzLoad", "months", "2026-05", "days", "1", "rawEntries", "past-do"), {
      monthId: "2026-05",
      dayNo: 1,
      raw: { todayMlIssuanceBase: 1000 }
    }));
    await assertFails(setDoc(doc(adminDb, "ledgerV2", "stock", "months", "2026-05", "days", "1", "rawEntries", "past-stock"), {
      monthId: "2026-05",
      dayNo: 1,
      raw: { quantity: 10 }
    }));
  });

  it("blocks client writes to calculated projections", async () => {
    const db = authedDb("owner");
    await assertFails(setDoc(doc(db, "ledgerV2", "expense", "months", "2026-05", "days", "1", "projections", "credit-usman"), {
      calculated: { opening: 2000, closing: 11000 }
    }));
  });

  it("blocks future and closed day raw writes", async () => {
    const db = authedDb("owner");
    await assertFails(setDoc(doc(db, "ledgerV2", "expense", "months", "2026-05", "days", "31", "rawEntries", "future"), {
      raw: { loan: 1 }
    }));
    await assertFails(setDoc(doc(db, "ledgerV2", "expense", "months", "2026-05", "days", "2", "rawEntries", "closed"), {
      raw: { loan: 1 }
    }));
  });
});
