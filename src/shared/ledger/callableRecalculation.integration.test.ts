import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  initializeTestEnvironment,
  type RulesTestEnvironment
} from "@firebase/rules-unit-testing";
import { initializeApp, deleteApp, type FirebaseApp } from "firebase/app";
import { createUserWithEmailAndPassword, connectAuthEmulator, getAuth, signOut } from "firebase/auth";
import { connectFunctionsEmulator, getFunctions, httpsCallable } from "firebase/functions";
import { collection, doc, getDocs, setDoc } from "firebase/firestore";

const hasCallableEmulators =
  Boolean(process.env.FIRESTORE_EMULATOR_HOST) &&
  Boolean(process.env.FIREBASE_AUTH_EMULATOR_HOST) &&
  Boolean(process.env.FUNCTIONS_EMULATOR_ORIGIN || process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST);
const describeIfCallableEmulators = hasCallableEmulators ? describe : describe.skip;
const projectId = "franchise-expense-system";

function functionsEmulatorAddress() {
  const raw = process.env.FUNCTIONS_EMULATOR_ORIGIN ||
    (process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ? `http://${process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST}` : "http://127.0.0.1:5001");
  const parsed = new URL(raw);
  return { host: parsed.hostname, port: Number(parsed.port || "5001") };
}

function authEmulatorUrl() {
  const raw = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099";
  return raw.startsWith("http") ? raw : `http://${raw}`;
}

describeIfCallableEmulators("ledgerV2 callable recalculation", () => {
  let testEnv: RulesTestEnvironment;
  let app: FirebaseApp;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({ projectId });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    app = initializeApp({ projectId, apiKey: "test-api-key" }, `callable-${Date.now()}-${Math.random()}`);
    const auth = getAuth(app);
    connectAuthEmulator(auth, authEmulatorUrl(), { disableWarnings: true });
    const { user } = await createUserWithEmailAndPassword(auth, `owner-${Date.now()}@example.com`, "password123");
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "users", user.uid), { uid: user.uid, role: "owner", active: true });
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  async function seedJazzLoadMonth() {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "jazzLoadMonths", "2026-05"), { id: "2026-05", status: "open" });
      await setDoc(doc(db, "jazzLoadMonths", "2026-05", "days", "1"), {
        id: "1",
        monthId: "2026-05",
        dayNo: 1,
        status: "open",
        lifting: { openingBalance: 0, mlLifting: 1000, todayMlIssuance: 100, inHandBalance: 900 },
        summary: {},
        doEntries: [
          {
            id: "do-usman",
            doName: "Usman Cheema",
            openingBalance: { baseAmount: 0, calculatedAmount: 0 },
            todayMlIssuance: { baseAmount: 100, calculatedAmount: 100 },
            paymentReceived: { baseAmount: 20, calculatedAmount: 20 },
            closingBalance: { baseAmount: 80, calculatedAmount: 80 }
          }
        ]
      });
      await setDoc(doc(db, "jazzLoadMonths", "2026-05", "days", "2"), {
        id: "2",
        monthId: "2026-05",
        dayNo: 2,
        status: "open",
        lifting: { openingBalance: 0, mlLifting: 0, todayMlIssuance: 50, inHandBalance: -50 },
        summary: {},
        doEntries: [
          {
            id: "do-usman",
            doName: "Usman Cheema",
            openingBalance: { baseAmount: 0, calculatedAmount: 0 },
            todayMlIssuance: { baseAmount: 50, calculatedAmount: 50 },
            paymentReceived: { baseAmount: 0, calculatedAmount: 0 },
            closingBalance: { baseAmount: 50, calculatedAmount: 50 }
          }
        ]
      });
      await setDoc(doc(db, "jazzLoadMonths", "2026-05", "summary", "monthly"), { monthId: "2026-05" });
    });
  }

  async function seedStockMonth() {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "stockMonths", "2026-05"), { id: "2026-05", status: "open" });
      await setDoc(doc(db, "stockMonths", "2026-05", "days", "1"), {
        id: "1",
        monthId: "2026-05",
        dayNo: 1,
        status: "open",
        summary: {},
        entries: [
          {
            id: "stock-usman",
            accountId: "usman",
            accountName: "Usman Cheema",
            carryForwardBalance: 0,
            totalAmount: 5000,
            totalPaymentReceived: 1000,
            dueBalance: 4000,
            products: [{ productId: "sim", productName: "SIM", quantity: 10 }]
          }
        ],
        stockIn: [
          {
            id: "jazz-stock",
            sourceName: "Jazz Company",
            stockInMode: "credit",
            products: [{ productId: "sim", productName: "SIM", quantity: 25 }],
            paidAmount: 0
          }
        ]
      });
      await setDoc(doc(db, "stockMonths", "2026-05", "days", "2"), {
        id: "2",
        monthId: "2026-05",
        dayNo: 2,
        status: "open",
        summary: {},
        entries: [
          {
            id: "stock-usman",
            accountId: "usman",
            accountName: "Usman Cheema",
            carryForwardBalance: 0,
            totalAmount: 1000,
            totalPaymentReceived: 0,
            dueBalance: 1000,
            products: [{ productId: "sim", productName: "SIM", quantity: 1 }]
          }
        ],
        stockIn: []
      });
      await setDoc(doc(db, "stockMonths", "2026-05", "summary", "monthly"), {
        monthId: "2026-05",
        openingStock: { sim: 0 }
      });
    });
  }

  function callable(name: string) {
    const functions = getFunctions(app);
    const { host, port } = functionsEmulatorAddress();
    connectFunctionsEmulator(functions, host, port);
    return httpsCallable(functions, name);
  }

  it("writes Jazz Load v2 projections and mismatch reports from the callable", async () => {
    await seedJazzLoadMonth();
    await callable("recalculateJazzLoadLedgerV2")({ monthId: "2026-05" });

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const projections = await getDocs(collection(db, "ledgerV2", "jazzLoad", "months", "2026-05", "days", "2", "projections"));
      const reports = await getDocs(collection(db, "ledgerV2", "jazzLoad", "months", "2026-05", "mismatchReports"));
      const calcRuns = await getDocs(collection(db, "ledgerV2", "jazzLoad", "months", "2026-05", "calcRuns"));
      expect(projections.docs.length).toBeGreaterThan(0);
      expect(reports.docs.length).toBeGreaterThan(0);
      expect(calcRuns.docs.length).toBe(1);
    });
  });

  it("writes Stock v2 projections and mismatch reports from the callable", async () => {
    await seedStockMonth();
    await callable("recalculateStockLedgerV2")({ monthId: "2026-05" });

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      const projections = await getDocs(collection(db, "ledgerV2", "stock", "months", "2026-05", "days", "2", "projections"));
      const reports = await getDocs(collection(db, "ledgerV2", "stock", "months", "2026-05", "mismatchReports"));
      const calcRuns = await getDocs(collection(db, "ledgerV2", "stock", "months", "2026-05", "calcRuns"));
      expect(projections.docs.length).toBeGreaterThan(0);
      expect(reports.docs.length).toBeGreaterThan(0);
      expect(calcRuns.docs.length).toBe(1);
    });
  });

  afterEach(async () => {
    await signOut(getAuth(app)).catch(() => undefined);
    await deleteApp(app);
  });
});
