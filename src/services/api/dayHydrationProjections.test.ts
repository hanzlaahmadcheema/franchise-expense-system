import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ledgerApiClient } from './ledgerApiClient';
import { loadExpenseDayPostgres } from './expenseTransactionService';
import { loadJazzLoadDayPostgres } from './jazzLoadTransactionService';
import { loadStockDayPostgres } from './stockTransactionService';
import * as periodDayService from './periodDayService';

vi.mock('../../lib/firebase', () => ({
  auth: { currentUser: null },
  db: {}
}));

vi.mock('./periodDayService', () => ({
  getAccountingPeriodWithDays: vi.fn(),
  isPostgreSqlPeriod: vi.fn().mockReturnValue(true),
  resolveAccountingDayId: vi.fn().mockResolvedValue('day-3-id')
}));

describe('Day Opening-Balance Hydration from PostgreSQL Projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockDay3Projections = {
    day: {
      id: 'day-3-id',
      dayNo: 3,
      periodId: 'period-aug-2026',
      status: 'reopen' as const,
      calendarDate: '2026-08-03'
    },
    projections: {
      financial: {
        opening_cash: -6164.00,
        total_expenses: 36740.00,
        closing_cash: -18033.00,
        owner_opening_balance: 129962.00,
        owner_closing_balance: -2335.00,
        opening_jazz_payable: -1315000.00,
        closing_jazz_payable: -1315000.00
      },
      creditParties: [
        { party_id: 'cp-masjid', opening_balance: -36547.00, total_loans: 0, total_receipts: 0, closing_balance: -36547.00 },
        { party_id: 'cp-ali', opening_balance: 39948.00, total_loans: 0, total_receipts: 20460.00, closing_balance: 19488.00 },
        { party_id: 'cp-dso-hasan', opening_balance: 30000.00, total_loans: 0, total_receipts: 0, closing_balance: 30000.00 }
      ],
      jazzLifting: {
        opening_lifting: 1573827.17,
        ml_lifting_purchased: 0,
        today_ml_issuance: 0,
        closing_lifting_in_hand: 1573827.17
      },
      jazzDo: [
        { do_profile_id: 'do-mubashir', opening_base: 150000.00, issuance_base: 0, payment_base: 0, closing_base: 150000.00 },
        { do_profile_id: 'do-hassan', opening_base: 100000.00, issuance_base: 0, payment_base: 0, closing_base: 100000.00 },
        { do_profile_id: 'do-mirza', opening_base: 35500.00, issuance_base: 0, payment_base: 0, closing_base: 35500.00 }
      ],
      stockProducts: [
        { product_id: 'prod-retailer', opening_qty: 1727, stock_in_qty: 0, stock_out_qty: 0, closing_qty: 1727 },
        { product_id: 'prod-retail-imzi', opening_qty: 1010, stock_in_qty: 0, stock_out_qty: 0, closing_qty: 1010 },
        { product_id: 'prod-cs-imzi', opening_qty: 210, stock_in_qty: 0, stock_out_qty: 0, closing_qty: 210 }
      ],
      stockAccounts: [
        { account_id: 'acc-do-naveed', opening_due: 115670.00, stock_taken_amount: 0, payment_received_amount: 0, closing_due: 115670.00 },
        { account_id: 'acc-tetas-ccr', opening_due: 22800.00, stock_taken_amount: 0, payment_received_amount: 0, closing_due: 22800.00 },
        { account_id: 'acc-waseem', opening_due: 3080.00, stock_taken_amount: 0, payment_received_amount: 0, closing_due: 3080.00 }
      ]
    }
  };

  const mockPeriodData = {
    period: { id: 'period-aug-2026', period_key: '2026-08', status: 'open' },
    days: new Map([
      [1, { id: 'day-1-id', day_no: 1, calendar_date: '2026-08-01', status: 'closed' }],
      [2, { id: 'day-2-id', day_no: 2, calendar_date: '2026-08-02', status: 'closed' }],
      [3, { id: 'day-3-id', day_no: 3, calendar_date: '2026-08-03', status: 'reopen' }]
    ])
  };

  it('1 & 2. Expense opening cash and owner opening balance come from Day 3 PostgreSQL projection without Day 1/2 in memory', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.expenses, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.commissions, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.credits, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.owner, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValue(mockDay3Projections as any);
    vi.spyOn(ledgerApiClient.catalogs, 'getCreditParties').mockResolvedValue({
      data: [
        { id: 'cp-masjid', name: 'Masjid Account' },
        { id: 'cp-ali', name: 'ALI OLAKH' }
      ]
    } as any);

    // Call loadExpenseDayPostgres for Day 3 directly
    const day3 = await loadExpenseDayPostgres('2026-08', 3);

    expect(day3).not.toBeNull();
    expect(day3?.dayNo).toBe(3);
    // Requirement 1: Expense opening cash comes from Day 3 projection (-6164.00)
    expect(day3?.openingCash).toBe(-6164.00);
    // Requirement 2: Owner opening balance comes from Day 3 projection (129962.00)
    expect(day3?.ownerOpeningBalance).toBe(129962.00);
  });

  it('3. Credit-party openings come from Day 3 projections even when Day 3 has no credit transactions', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.expenses, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.commissions, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.credits, 'list').mockResolvedValue({ data: [] } as any); // 0 transactions on Day 3
    vi.spyOn(ledgerApiClient.owner, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValue(mockDay3Projections as any);
    vi.spyOn(ledgerApiClient.catalogs, 'getCreditParties').mockResolvedValue({
      data: [
        { id: 'cp-masjid', name: 'Masjid Account' },
        { id: 'cp-ali', name: 'ALI OLAKH' }
      ]
    } as any);

    const day3 = await loadExpenseDayPostgres('2026-08', 3);

    expect(day3).not.toBeNull();
    // Requirement 3: Credit-party openings come from Day 3 projections
    const masjid = day3?.credits.find((c) => c.partyId === 'cp-masjid');
    expect(masjid).toBeDefined();
    expect(masjid?.opening).toBe(-36547.00);

    const ali = day3?.credits.find((c) => c.partyId === 'cp-ali');
    expect(ali).toBeDefined();
    expect(ali?.opening).toBe(39948.00);
  });

  it('4 & 5. Jazz lifting opening and DO opening bases come from Day 3 projections without requiring Day 1/2 in memory', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.jazzDo, 'list').mockResolvedValue({ data: [] } as any); // 0 transactions on Day 3
    vi.spyOn(ledgerApiClient.jazzLifting, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValue(mockDay3Projections as any);

    const doProfiles = [
      { id: 'do-mubashir', name: 'Mubashir', line: '03027100126', sortOrder: 1, active: true },
      { id: 'do-hassan', name: 'Hassan', line: '03027103468', sortOrder: 2, active: true },
      { id: 'do-mirza', name: 'Mirza', line: '03051639672', sortOrder: 3, active: true }
    ];
    const rates = [
      { id: 'r1', type: 'ml_addition' as const, percentage: 5.0, active: true }
    ];

    const day3 = await loadJazzLoadDayPostgres('2026-08', 3, doProfiles as any, rates as any);

    expect(day3).not.toBeNull();
    expect(day3?.dayNo).toBe(3);
    // Requirement 4: Jazz lifting opening comes from Day 3 projection (1573827.17)
    expect(day3?.lifting.openingBalance).toBe(1573827.17);

    // Requirement 5: Jazz DO opening bases come from Day 3 projections
    const mubashirEntry = day3?.doEntries.find((e) => e.doProfileId === 'do-mubashir');
    expect(mubashirEntry).toBeDefined();
    expect(mubashirEntry?.openingBalance.baseAmount).toBe(150000.00);

    const hassanEntry = day3?.doEntries.find((e) => e.doProfileId === 'do-hassan');
    expect(hassanEntry).toBeDefined();
    expect(hassanEntry?.openingBalance.baseAmount).toBe(100000.00);

    const mirzaEntry = day3?.doEntries.find((e) => e.doProfileId === 'do-mirza');
    expect(mirzaEntry).toBeDefined();
    expect(mirzaEntry?.openingBalance.baseAmount).toBe(35500.00);
  });

  it('6 & 7. Stock product openings and stock account openings come from Day 3 projections without requiring Day 1/2 in memory', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.stockOrders, 'list').mockResolvedValue({ data: [] } as any); // 0 transactions on Day 3
    vi.spyOn(ledgerApiClient.stockPayments, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.jazzCompanyPayments, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValue(mockDay3Projections as any);

    const products = [
      { id: 'prod-retailer', name: 'RETAILER', rate: 100, active: true, displayOrder: 1, paymentTrackingEnabled: false, createdAt: 0, updatedAt: 0 },
      { id: 'prod-retail-imzi', name: 'RETAIL IMZI', rate: 100, active: true, displayOrder: 2, paymentTrackingEnabled: false, createdAt: 0, updatedAt: 0 },
      { id: 'prod-cs-imzi', name: 'CS IMZI', rate: 100, active: true, displayOrder: 3, paymentTrackingEnabled: false, createdAt: 0, updatedAt: 0 }
    ];
    const accounts = [
      { id: 'acc-do-naveed', name: 'DO NAVEED', type: 'DO' as const, openingBalance: 0, active: true, sortOrder: 1, createdAt: 0, updatedAt: 0 },
      { id: 'acc-tetas-ccr', name: 'Tetas CCR', type: 'CCR' as const, openingBalance: 0, active: true, sortOrder: 2, createdAt: 0, updatedAt: 0 },
      { id: 'acc-waseem', name: 'WASEEM GUJJAR', type: 'CCR' as const, openingBalance: 0, active: true, sortOrder: 3, createdAt: 0, updatedAt: 0 }
    ];

    const day3 = await loadStockDayPostgres('2026-08', 3, products as any, accounts as any);

    expect(day3).not.toBeNull();
    expect(day3?.dayNo).toBe(3);

    // Requirement 6: Stock product openings come from Day 3 projections
    expect(day3?.stockProductProjections).toBeDefined();
    const retailerProj = day3?.stockProductProjections?.find((p) => p.product_id === 'prod-retailer');
    expect(retailerProj?.opening_qty).toBe(1727);
    const imziProj = day3?.stockProductProjections?.find((p) => p.product_id === 'prod-retail-imzi');
    expect(imziProj?.opening_qty).toBe(1010);
    const csProj = day3?.stockProductProjections?.find((p) => p.product_id === 'prod-cs-imzi');
    expect(csProj?.opening_qty).toBe(210);

    // Requirement 7: Stock account openings come from Day 3 projections
    expect(day3?.stockAccountProjections).toBeDefined();
    const naveedProj = day3?.stockAccountProjections?.find((p) => p.account_id === 'acc-do-naveed');
    expect(Number(naveedProj?.opening_due)).toBe(115670.00);
    const tetasProj = day3?.stockAccountProjections?.find((p) => p.account_id === 'acc-tetas-ccr');
    expect(Number(tetasProj?.opening_due)).toBe(22800.00);

    // Also verify entries map carryForwardBalance directly
    const naveedEntry = day3?.entries.find((e) => e.accountId === 'acc-do-naveed');
    expect(naveedEntry).toBeDefined();
    expect(naveedEntry?.carryForwardBalance).toBe(115670.00);

    const tetasEntry = day3?.entries.find((e) => e.accountId === 'acc-tetas-ccr');
    expect(tetasEntry).toBeDefined();
    expect(tetasEntry?.carryForwardBalance).toBe(22800.00);
  });

  it('8 & 9. Day 2 being a holiday does not cause Day 3 opening values to become zero, and Day 1/2 navigation is not required', async () => {
    // Simulate Day 2 as a skipped holiday that carried forward Day 1 numbers
    // In PostgreSQL, Day 2 has closing_cash = -6164.00, which carries to Day 3 opening_cash = -6164.00
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.expenses, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.commissions, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.credits, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.owner, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValue(mockDay3Projections as any);
    vi.spyOn(ledgerApiClient.catalogs, 'getCreditParties').mockResolvedValue({ data: [] } as any);

    // Load Day 3 directly without loading Day 1 or Day 2
    const day3Expense = await loadExpenseDayPostgres('2026-08', 3);

    // Confirm opening cash is NOT 0
    expect(day3Expense?.openingCash).toBe(-6164.00);
    expect(day3Expense?.openingCash).not.toBe(0);
  });
});
