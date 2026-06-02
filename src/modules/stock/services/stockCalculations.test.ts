import { describe, expect, it } from "vitest";
import {
  buildStockEntry,
  calculateDueBalance,
  calculateMonthlySummary,
  calculateProductDueBalance,
  calculateJazzPayableLedger,
  calculateJazzCompanyBalance,
  calculateCurrentStock,
  recalculateStockMonthEntries,
  resolveStockAccountOpeningDue,
  resolveStockCarryForwardBalance
} from "./stockCalculations";
import type { StockAccountProfile, StockDayRecord, StockMonthlySummary, StockProduct } from "../types/stock.types";

const product: StockProduct = {
  id: "sim",
  name: "SIM",
  rate: 120,
  active: true,
  displayOrder: 1,
  paymentTrackingEnabled: true,
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1
};

const productNoPayment: StockProduct = {
  ...product,
  id: "device",
  name: "Device",
  paymentTrackingEnabled: false
};

const account: StockAccountProfile = {
  id: "ccr-a",
  name: "CCR A",
  type: "CCR",
  active: true,
  displayOrder: 1,
  createdBy: "u1",
  createdAt: 1,
  updatedAt: 1
};

describe("stock calculations", () => {
  it("stores product rate snapshots and calculates account due balance", () => {
    const entry = buildStockEntry({
      id: "ccr-a",
      date: "May 29, 2026",
      monthId: "2026-05",
      dayNo: 29,
      account,
      draft: {
        accountId: account.id,
        productQuantities: { sim: 3 },
        paymentReceived: 200
      },
      products: [product],
      carryForwardBalance: 50,
      createdBy: "u1",
      timestamp: 10
    });

    expect(entry.products[0]).toMatchObject({
      productName: "SIM",
      rate: 120,
      quantity: 3,
      amount: 360,
      paymentReceived: 0,
      dueBalance: 0
    });
    expect(entry.totalAmount).toBe(360);
    expect(entry.totalPaymentReceived).toBe(200);
    expect(entry.dueBalance).toBe(210);
  });

  it("snapshots rate at save time so later settings changes do not rewrite old rows", () => {
    const saved = buildStockEntry({
      id: "ccr-a",
      date: "May 29, 2026",
      monthId: "2026-05",
      dayNo: 29,
      account,
      draft: {
        accountId: account.id,
        productQuantities: { sim: 2 },
        paymentReceived: 0
      },
      products: [{ ...product, rate: 120 }],
      carryForwardBalance: 0,
      createdBy: "u1",
      timestamp: 10
    });

    const afterRateChange = buildStockEntry({
      id: "ccr-a",
      date: "May 30, 2026",
      monthId: "2026-05",
      dayNo: 30,
      account,
      draft: {
        accountId: account.id,
        productQuantities: { sim: 2 },
        paymentReceived: 0
      },
      products: [{ ...product, rate: 999 }],
      carryForwardBalance: 0,
      createdBy: "u1",
      timestamp: 20
    });

    expect(saved.products[0]).toMatchObject({ rate: 120, amount: 240 });
    expect(afterRateChange.products[0]).toMatchObject({ rate: 999, amount: 1998 });
  });

  it("omits payment fields for products without payment tracking", () => {
    expect(calculateProductDueBalance(500, 100)).toBe(400);
    const entry = buildStockEntry({
      id: "ccr-a",
      date: "May 29, 2026",
      monthId: "2026-05",
      dayNo: 29,
      account,
      draft: {
        accountId: account.id,
        productQuantities: { device: 1, sim: 1 },
        paymentReceived: 100
      },
      products: [product, productNoPayment],
      carryForwardBalance: 0,
      createdBy: "u1"
    });

    const deviceRow = entry.products.find((row) => row.productId === "device");
    expect(deviceRow).toMatchObject({ paymentReceived: 0, dueBalance: 0, paymentTrackingEnabled: false });
    expect(entry.totalPaymentReceived).toBe(100);
  });

  it("keeps due formula centralized", () => {
    expect(calculateDueBalance({ carryForwardBalance: 100, totalAmount: 500, totalPaymentReceived: 350 })).toBe(250);
  });

  it("locks stock carry-forward to previous closing sources before account opening", () => {
    expect(resolveStockCarryForwardBalance({
      previousEntryDueBalance: 450,
      previousMonthDueBalance: 300,
      accountOpeningBalance: 100
    })).toBe(450);

    expect(resolveStockCarryForwardBalance({
      previousMonthDueBalance: 300,
      accountOpeningBalance: 100
    })).toBe(300);

    expect(resolveStockCarryForwardBalance({
      accountOpeningBalance: 100
    })).toBe(100);
  });

  it("uses previous monthly account due as the locked opening due", () => {
    const previousSummary: StockMonthlySummary = {
      monthId: "2026-05",
      totalQty: 0,
      totalAmount: 0,
      totalPaymentReceived: 0,
      totalDueBalance: 850,
      productTotals: [],
      accountTotals: [{
        accountId: account.id,
        accountName: account.name,
        accountType: account.type,
        totalQty: 0,
        totalAmount: 0,
        totalPaymentReceived: 0,
        dueBalance: 850,
        activeDays: 1
      }],
      paymentTotals: [],
      dayRows: [],
      missingDays: [],
      updatedAt: 1
    };

    expect(resolveStockAccountOpeningDue({ ...account, openingBalance: 100 }, previousSummary)).toBe(850);
    expect(resolveStockAccountOpeningDue({ ...account, id: "new-account", openingBalance: 100 }, previousSummary)).toBe(100);
  });

  it("builds account, product, payment, day and missing-day summaries", () => {
    const entry = buildStockEntry({
      id: "ccr-a",
      date: "May 1, 2026",
      monthId: "2026-05",
      dayNo: 1,
      account,
      draft: {
        accountId: account.id,
        productQuantities: { sim: 2 },
        paymentReceived: 100
      },
      products: [product],
      carryForwardBalance: 0,
      createdBy: "u1",
      timestamp: 10
    });
    const day: StockDayRecord = {
      id: "1",
      date: "May 1, 2026",
      monthId: "2026-05",
      dayNo: 1,
      status: "open",
      entries: [entry],
      summary: {
        accountCount: 1,
        totalQty: entry.totalQty,
        totalAmount: entry.totalAmount,
        totalPaymentReceived: entry.totalPaymentReceived,
        totalDueBalance: entry.dueBalance
      },
      createdBy: "u1",
      createdAt: 10,
      updatedAt: 10
    };

    const summary = calculateMonthlySummary("2026-05", [day]);
    expect(summary.totalQty).toBe(2);
    expect(summary.productTotals[0]).toMatchObject({ productName: "SIM", quantity: 2, amount: 240 });
    expect(summary.paymentTotals[0]).toMatchObject({ productName: "Account Recovery Payments", amount: 100 });
    expect(summary.accountTotals[0]).toMatchObject({ accountName: "CCR A", dueBalance: 140 });
    expect(summary.missingDays).toContain(2);
  });

  it("rebuilds the next day carry-forward from the previous day closing balance", () => {
    const carryAccount: StockAccountProfile = {
      ...account,
      openingBalance: 25
    };
    const day1Entry = buildStockEntry({
      id: carryAccount.id,
      date: "May 1, 2026",
      monthId: "2026-05",
      dayNo: 1,
      account: carryAccount,
      draft: {
        accountId: carryAccount.id,
        productQuantities: { sim: 2 },
        paymentReceived: 0
      },
      products: [product],
      carryForwardBalance: 25,
      createdBy: "u1",
      timestamp: 10
    });
    const day2Entry = buildStockEntry({
      id: carryAccount.id,
      date: "May 2, 2026",
      monthId: "2026-05",
      dayNo: 2,
      account: carryAccount,
      draft: {
        accountId: carryAccount.id,
        productQuantities: { sim: 1 },
        paymentReceived: 0
      },
      products: [product],
      carryForwardBalance: 0,
      createdBy: "u1",
      timestamp: 20
    });

    const days: StockDayRecord[] = [
      {
        id: "1",
        date: "May 1, 2026",
        monthId: "2026-05",
        dayNo: 1,
        status: "open",
        entries: [day1Entry],
        summary: {
          accountCount: 1,
          totalQty: day1Entry.totalQty,
          totalAmount: day1Entry.totalAmount,
          totalPaymentReceived: day1Entry.totalPaymentReceived,
          totalDueBalance: day1Entry.dueBalance
        },
        createdBy: "u1",
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: "2",
        date: "May 2, 2026",
        monthId: "2026-05",
        dayNo: 2,
        status: "open",
        entries: [day2Entry],
        summary: {
          accountCount: 1,
          totalQty: day2Entry.totalQty,
          totalAmount: day2Entry.totalAmount,
          totalPaymentReceived: day2Entry.totalPaymentReceived,
          totalDueBalance: day2Entry.dueBalance
        },
        createdBy: "u1",
        createdAt: 20,
        updatedAt: 20
      }
    ];

    const recalculated = recalculateStockMonthEntries(days, [carryAccount]);
    expect(recalculated[0].entries[0].carryForwardBalance).toBe(25);
    expect(recalculated[0].entries[0].dueBalance).toBe(265);
    expect(recalculated[1].entries[0].carryForwardBalance).toBe(265);
    expect(recalculated[1].entries[0].dueBalance).toBe(385);
  });

  it("preserves the first saved opening balance when recalculating a month", () => {
    const openingAccount: StockAccountProfile = {
      ...account,
      openingBalance: 0
    };
    const day1Entry = buildStockEntry({
      id: openingAccount.id,
      date: "May 1, 2026",
      monthId: "2026-05",
      dayNo: 1,
      account: openingAccount,
      draft: {
        accountId: openingAccount.id,
        productQuantities: { sim: 1 },
        paymentReceived: 0
      },
      products: [product],
      carryForwardBalance: 57432,
      createdBy: "u1",
      timestamp: 10
    });
    const day2Entry = buildStockEntry({
      id: openingAccount.id,
      date: "May 2, 2026",
      monthId: "2026-05",
      dayNo: 2,
      account: openingAccount,
      draft: {
        accountId: openingAccount.id,
        productQuantities: { sim: 100 },
        paymentReceived: 0
      },
      products: [product],
      carryForwardBalance: 0,
      createdBy: "u1",
      timestamp: 20
    });

    const days: StockDayRecord[] = [
      {
        id: "1",
        date: "May 1, 2026",
        monthId: "2026-05",
        dayNo: 1,
        status: "open",
        entries: [day1Entry],
        summary: {
          accountCount: 1,
          totalQty: day1Entry.totalQty,
          totalAmount: day1Entry.totalAmount,
          totalPaymentReceived: day1Entry.totalPaymentReceived,
          totalDueBalance: day1Entry.dueBalance
        },
        createdBy: "u1",
        createdAt: 10,
        updatedAt: 10
      },
      {
        id: "2",
        date: "May 2, 2026",
        monthId: "2026-05",
        dayNo: 2,
        status: "open",
        entries: [day2Entry],
        summary: {
          accountCount: 1,
          totalQty: day2Entry.totalQty,
          totalAmount: day2Entry.totalAmount,
          totalPaymentReceived: day2Entry.totalPaymentReceived,
          totalDueBalance: day2Entry.dueBalance
        },
        createdBy: "u1",
        createdAt: 20,
        updatedAt: 20
      }
    ];

    const recalculated = recalculateStockMonthEntries(days, [openingAccount]);
    expect(recalculated[0].entries[0].carryForwardBalance).toBe(57432);
    expect(recalculated[0].entries[0].dueBalance).toBe(57552);
    expect(recalculated[1].entries[0].carryForwardBalance).toBe(57552);
  });

  it("seeds a new month account due from previous monthly summary before first saved opening", () => {
    const openingAccount: StockAccountProfile = {
      ...account,
      openingBalance: 0
    };
    const day1Entry = buildStockEntry({
      id: openingAccount.id,
      date: "June 1, 2026",
      monthId: "2026-06",
      dayNo: 1,
      account: openingAccount,
      draft: {
        accountId: openingAccount.id,
        productQuantities: { sim: 1 },
        paymentReceived: 20
      },
      products: [product],
      carryForwardBalance: 0,
      createdBy: "u1",
      timestamp: 10
    });
    const day: StockDayRecord = {
      id: "1",
      date: "June 1, 2026",
      monthId: "2026-06",
      dayNo: 1,
      status: "open",
      entries: [day1Entry],
      summary: {
        accountCount: 1,
        totalQty: day1Entry.totalQty,
        totalAmount: day1Entry.totalAmount,
        totalPaymentReceived: day1Entry.totalPaymentReceived,
        totalDueBalance: day1Entry.dueBalance
      },
      createdBy: "u1",
      createdAt: 10,
      updatedAt: 10
    };
    const previousSummary = {
      monthId: "2026-05",
      totalQty: 0,
      totalAmount: 0,
      totalPaymentReceived: 0,
      totalDueBalance: 500,
      productTotals: [],
      accountTotals: [{
        accountId: openingAccount.id,
        accountName: openingAccount.name,
        accountType: openingAccount.type,
        totalQty: 0,
        totalAmount: 0,
        totalPaymentReceived: 0,
        dueBalance: 500,
        activeDays: 1
      }],
      paymentTotals: [],
      dayRows: [],
      missingDays: [],
      updatedAt: 1
    };

    const recalculated = recalculateStockMonthEntries([day], [openingAccount], previousSummary);

    expect(recalculated[0].entries[0].carryForwardBalance).toBe(500);
    expect(recalculated[0].entries[0].dueBalance).toBe(600);
    expect(recalculated[0].entries[0].totalAmount).toBe(120);
    expect(recalculated[0].entries[0].totalPaymentReceived).toBe(20);
  });

  describe("Jazz Stock In & Current Balance calculations", () => {
    it("calculates Jazz running payable correctly", () => {
      const records = [
        {
          id: "r1",
          date: "2026-05-01",
          monthId: "2026-05",
          sourceName: "Jazz Company" as const,
          stockInMode: "credit" as const,
          products: [],
          totalQty: 10,
          totalAmount: 1000,
          paidAmount: 200,
          jazzPayableAmount: 800,
          createdBy: "u1",
          createdAt: 100,
          updatedAt: 100
        },
        {
          id: "r2",
          date: "2026-05-02",
          monthId: "2026-05",
          sourceName: "Jazz Company" as const,
          stockInMode: "cash" as const,
          products: [],
          totalQty: 5,
          totalAmount: 500,
          paidAmount: 500,
          jazzPayableAmount: 0,
          createdBy: "u1",
          createdAt: 200,
          updatedAt: 200
        }
      ];

      const ledger = calculateJazzPayableLedger(100, records);
      expect(ledger).toHaveLength(2);
      expect(ledger[0]).toMatchObject({
        prevPayable: 100,
        changePayable: 800,
        runningPayable: 900
      });
      expect(ledger[1]).toMatchObject({
        prevPayable: 900,
        changePayable: 0,
        runningPayable: 900
      });
    });

    it("calculates the persisted Jazz Company balance independently from customer dues", () => {
      const balance = calculateJazzCompanyBalance(250, [
        {
          id: "r1",
          date: "2026-05-01",
          monthId: "2026-05",
          sourceName: "Jazz Company" as const,
          stockInMode: "credit" as const,
          products: [],
          totalQty: 10,
          totalAmount: 1000,
          paidAmount: 200,
          jazzPayableAmount: 800,
          createdBy: "u1",
          createdAt: 100,
          updatedAt: 100
        }
      ], 999);

      expect(balance).toEqual({
        openingPayable: 250,
        totalStockInAmount: 1000,
        totalPaidAmount: 200,
        currentPayable: 1050,
        updatedAt: 999
      });
    });

    it("calculates current stock balance correctly", () => {
      const products = [product, productNoPayment];
      const openingStock = { sim: 10, device: 5 };
      const stockInRecords = [
        {
          id: "in-1",
          date: "2026-05-01",
          monthId: "2026-05",
          sourceName: "Jazz Company" as const,
          stockInMode: "credit" as const,
          products: [
            { productId: "sim", productName: "SIM", rate: 120, quantity: 20, amount: 2400 },
            { productId: "device", productName: "Device", rate: 500, quantity: 5, amount: 2500 }
          ],
          totalQty: 25,
          totalAmount: 4900,
          paidAmount: 0,
          jazzPayableAmount: 4900,
          createdBy: "u1",
          createdAt: 100,
          updatedAt: 100
        }
      ];

      const outEntry = buildStockEntry({
        id: "ccr-a",
        date: "May 29, 2026",
        monthId: "2026-05",
        dayNo: 29,
        account,
        draft: {
          accountId: account.id,
          productQuantities: { sim: 15, device: 2 },
          productPayments: {}
        },
        products,
        carryForwardBalance: 0,
        createdBy: "u1"
      });

      const day: StockDayRecord = {
        id: "29",
        date: "2026-05-29",
        monthId: "2026-05",
        dayNo: 29,
        status: "open",
        entries: [outEntry],
        summary: {
          accountCount: 1,
          totalQty: outEntry.totalQty,
          totalAmount: outEntry.totalAmount,
          totalPaymentReceived: outEntry.totalPaymentReceived,
          totalDueBalance: outEntry.dueBalance
        },
        createdBy: "u1",
        createdAt: 10,
        updatedAt: 10
      };

      const balances = calculateCurrentStock(products, openingStock, stockInRecords, [day]);
      expect(balances).toHaveLength(2);
      const simBal = balances.find((b) => b.productId === "sim");
      const devBal = balances.find((b) => b.productId === "device");

      expect(simBal).toMatchObject({
        openingStock: 10,
        totalStockIn: 20,
        totalStockOut: 15,
        currentStock: 15
      });
      expect(devBal).toMatchObject({
        openingStock: 5,
        totalStockIn: 5,
        totalStockOut: 2,
        currentStock: 8
      });
    });
  });
});
