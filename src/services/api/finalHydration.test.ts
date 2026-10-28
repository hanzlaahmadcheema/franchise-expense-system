import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ledgerApiClient } from './ledgerApiClient';
import { loadExpenseDayPostgres, saveExpenseDayPostgres } from './expenseTransactionService';
import * as periodDayService from './periodDayService';
import { computeMonth, computeDay } from '../../lib/formulaEngine';

vi.mock('../../lib/firebase', () => ({
  auth: { currentUser: null },
  db: {}
}));

vi.mock('./periodDayService', () => ({
  getAccountingPeriodWithDays: vi.fn(),
  isPostgreSqlPeriod: vi.fn().mockReturnValue(true),
  resolveAccountingDayId: vi.fn()
}));

describe('FINAL Month-End Balance Hydration & Entry Persistence Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPeriodData = {
    period: {
      id: 'period-aug-2026',
      period_key: '2026-08',
      label: 'August 2026',
      status: 'open',
      final_settlement_status: 'PENDING_SETTLEMENT',
      updated_at: '2026-08-31T23:59:59Z'
    },
    days: new Map([
      [1, { id: 'day-1-id', day_no: 1, calendar_date: '2026-08-01', status: 'closed' }],
      [15, { id: 'day-15-id', day_no: 15, calendar_date: '2026-08-15', status: 'closed' }],
      [31, { id: 'day-31-id', day_no: 31, calendar_date: '2026-08-31', status: 'closed' }]
    ])
  };

  // Authoritative Day 31 / FINAL snapshot from PostgreSQL
  const mockFinalProjections = {
    period: {
      id: 'period-aug-2026',
      periodKey: '2026-08',
      label: 'August 2026',
      status: 'open',
      finalSettlementStatus: 'PENDING_SETTLEMENT'
    },
    boundary: 'FINAL',
    finalDay: {
      id: 'day-31-id',
      dayNo: 31,
      calendarDate: '2026-08-31',
      status: 'closed'
    },
    closingBalances: {
      financial: {
        closingCash: '-20000.00',
        closingOwnerBalance: '15000.00',
        operatingProfit: '20000.00',
        totalIssues: '100000.00',
        totalExpenses: '80000.00',
        closingCommissionReceivable: '20000.00'
      },
      creditParties: [
        {
          partyId: 'cp-alpha',
          partyName: 'Alpha Dealer',
          closingBalance: '12000.00',
          openingBalance: '10000.00',
          totalLoans: '2000.00',
          totalReceipts: '0.00'
        },
        {
          partyId: 'cp-beta',
          partyName: 'Beta Store',
          closingBalance: '-5000.00',
          openingBalance: '-5000.00',
          totalLoans: '0.00',
          totalReceipts: '0.00'
        }
      ]
    },
    finalSettlements: {
      entries: [
        {
          id: 'settlement-comm-1',
          periodId: 'period-aug-2026',
          sourcePeriodKey: '2026-08',
          settlementDate: '2026-09-01',
          balanceDomain: 'COMMISSION_RECEIVABLE',
          settlementType: 'COMMISSION_SETTLEMENT',
          targetEntityId: 'cat-jazz-load',
          targetEntityName: 'Jazz Load Commission',
          amount: '20000.00',
          notes: 'September recovery of August commission',
          status: 'ACTIVE'
        }
      ],
      domainSummaries: [
        {
          balanceDomain: 'COMMISSION_RECEIVABLE',
          label: 'August Commission Receivable',
          operationalClosingBalance: '20000.00',
          settledAmount: '20000.00',
          remainingOutstanding: '0.00',
          isResolved: true,
          status: 'SETTLED'
        }
      ],
      allResolved: true,
      totalSettled: '20000.00',
      totalOutstanding: '0.00',
      settlementStatus: 'SETTLED'
    }
  };

  it('1. Cold FINAL load: hydrates opening cash, owner balance, and credit parties directly from PostgreSQL snapshot', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    const getFinalSpy = vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);

    // Load FINAL (Day 32) without any prior in-memory days 1-31
    const finalDay = await loadExpenseDayPostgres('2026-08', 32);

    expect(getFinalSpy).toHaveBeenCalledWith('period-aug-2026');
    expect(finalDay).not.toBeNull();
    expect(finalDay?.dayNo).toBe(32);
    expect(finalDay?.label).toBe('FINAL');
    // Cash matches Day 31 closing projection (-20,000)
    expect(finalDay?.openingCash).toBe(-20000);
    // Owner balance matches Day 31 closing projection (15,000)
    expect(finalDay?.ownerOpeningBalance).toBe(15000);
    // Credit parties match authoritative Day 31 closings
    expect(finalDay?.credits).toHaveLength(2);
    expect(finalDay?.credits[0].opening).toBe(12000);
    expect(finalDay?.credits[0].partyName).toBe('Alpha Dealer');
    expect(finalDay?.credits[1].opening).toBe(-5000);
    expect(finalDay?.credits[1].partyName).toBe('Beta Store');
    // Commissions mapped from recorded settlements
    expect(finalDay?.commissions).toHaveLength(1);
    expect(finalDay?.commissions[0].amount).toBe(20000);
    expect(finalDay?.commissions[0].category).toBe('Jazz Load Commission');
    // FINAL is editable when period is open and not verified
    expect(finalDay?.status).toBe('open');
    expect(finalDay?.lockedAt).toBeUndefined();
  });

  it('2. FINAL refresh: returns identical authoritative values on repeated load', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);

    const firstLoad = await loadExpenseDayPostgres('2026-08', 32);
    const refreshedLoad = await loadExpenseDayPostgres('2026-08', 32);

    expect(firstLoad?.openingCash).toBe(refreshedLoad?.openingCash);
    expect(firstLoad?.ownerOpeningBalance).toBe(refreshedLoad?.ownerOpeningBalance);
    expect(firstLoad?.credits).toEqual(refreshedLoad?.credits);
    expect(firstLoad?.commissions).toEqual(refreshedLoad?.commissions);
  });

  it('3 & 4. Navigate away (Day 15) and return to FINAL: client-side rolling calculation does NOT corrupt FINAL', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);

    // Simulate Day 15 loaded in React state with arbitrary expenses
    const day15Record = {
      dayNo: 15,
      date: '2026-08-15',
      status: 'closed' as const,
      expenses: [{ id: 'e15', name: 'Fuel', description: '', amount: 5300, category: 'General' }],
      commissions: [],
      credits: [],
      ownerBalances: []
    };

    // Load FINAL
    const finalDay = await loadExpenseDayPostgres('2026-08', 32);
    expect(finalDay).not.toBeNull();

    // Run computeMonth with Day 15 and Day 32 (FINAL)
    const monthComputed = computeMonth(
      [day15Record, finalDay!],
      10000, // arbitrary Day 1 opening balance
      '2026-08',
      5000
    );

    const computedFinalDay = monthComputed.days.find((d) => d.dayNo === 32);
    expect(computedFinalDay).toBeDefined();
    // Authoritative Day 32 opening cash (-20,000) was preserved by formulaEngine, NOT overwritten by Day 15 chained return balance
    expect(computedFinalDay?.openingBalance).toBe(-20000);
    expect(computedFinalDay?.ownerOpeningBalance).toBe(15000);
    // Net result on FINAL: opening (-20,000) + commission settlement (20,000) = 0!
    expect(computedFinalDay?.returnBalance).toBe(0);
  });

  it('5. Cash matches Day 31 closing projection strictly without fallback to -53, -37, or 0', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue({
      ...mockFinalProjections,
      closingBalances: {
        ...mockFinalProjections.closingBalances,
        financial: {
          ...mockFinalProjections.closingBalances.financial,
          closingCash: '-74820.50'
        }
      }
    } as any);

    const finalDay = await loadExpenseDayPostgres('2026-08', 32);
    expect(finalDay?.openingCash).toBe(-74820.5);
  });

  it('6. Owner balance matches Day 31/FINAL authoritative owner projection strictly', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue({
      ...mockFinalProjections,
      closingBalances: {
        ...mockFinalProjections.closingBalances,
        financial: {
          ...mockFinalProjections.closingBalances.financial,
          closingOwnerBalance: '88350.25'
        }
      }
    } as any);

    const finalDay = await loadExpenseDayPostgres('2026-08', 32);
    expect(finalDay?.ownerOpeningBalance).toBe(88350.25);
  });

  it('7. Credit balances match FINAL projection with distinct closing positions', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);

    const finalDay = await loadExpenseDayPostgres('2026-08', 32);
    expect(finalDay?.credits).toHaveLength(2);
    const alpha = finalDay?.credits.find((c) => c.partyId === 'cp-alpha');
    const beta = finalDay?.credits.find((c) => c.partyId === 'cp-beta');
    expect(alpha?.opening).toBe(12000);
    expect(beta?.opening).toBe(-5000);
  });

  it('8. Saving Day 32 input writes to final_settlement_entries, NOT operational days or Day 31 items', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);
    vi.spyOn(ledgerApiClient.periods, 'listFinalSettlements').mockResolvedValue({ data: [] } as any);
    const createSettlementSpy = vi.spyOn(ledgerApiClient.periods, 'createFinalSettlement').mockResolvedValue({
      data: { id: 'new-fse-1' },
      finalSettlements: {},
      message: 'Created'
    } as any);

    // Save Day 32 input with a commission and credit receive
    const saveResult = await saveExpenseDayPostgres('2026-08', {
      dayNo: 32,
      date: '2026-08-FINAL',
      expenses: [],
      commissions: [{ id: 'new-c', category: 'Jazz Load Commission', amount: 20000 }],
      credits: [{ id: 'c-alpha', partyId: 'cp-alpha', partyName: 'Alpha Dealer', opening: 12000, loan: 0, receive: 12000, receiveDescription: 'Full recovery' }],
      ownerBalances: []
    });

    expect(saveResult.success).toBe(true);
    expect(saveResult.dayId).toBe('final');
    // Ensure createFinalSettlement was called with true transaction semantics (NOT forced into CASH_SETTLEMENT or COMMISSION_RECEIVABLE)
    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'COMMISSION',
      settlementType: 'COMMISSION',
      amount: 20000
    }));
    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'CREDIT_PARTY_BALANCE',
      settlementType: 'CREDIT_RECEIVE',
      targetEntityId: 'cp-alpha',
      amount: 12000
    }));
    // Proves Day 31 operational transactions and accounting_days were NOT touched
    expect(periodDayService.resolveAccountingDayId).not.toHaveBeenCalled();
  });

  it('9. Expense on Day 32: preserves category, categoryId, name, description, amount (does NOT map to CASH_SETTLEMENT)', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);
    vi.spyOn(ledgerApiClient.periods, 'listFinalSettlements').mockResolvedValue({ data: [] } as any);
    const createSettlementSpy = vi.spyOn(ledgerApiClient.periods, 'createFinalSettlement').mockResolvedValue({
      data: { id: 'exp-fse-1' },
      finalSettlements: {},
      message: 'Created'
    } as any);

    const validCatId = '11111111-1111-1111-1111-111111111111';
    await saveExpenseDayPostgres('2026-08', {
      dayNo: 32,
      date: '2026-08-FINAL',
      expenses: [
        {
          id: 'temp-exp-1',
          categoryId: validCatId,
          category: 'Utilities',
          name: 'Electricity Bill',
          description: 'August electricity final payment',
          amount: 15400
        }
      ],
      commissions: [],
      credits: [],
      ownerBalances: []
    });

    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'EXPENSE',
      settlementType: 'EXPENSE',
      targetEntityId: validCatId,
      targetEntityName: 'Utilities',
      sourceReference: 'Electricity Bill',
      notes: 'August electricity final payment',
      amount: 15400
    }));
  });

  it('10. Franchise Owner on Day 32: preserves signed direction (OWNER_DRAWING vs OWNER_INJECTION)', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);
    vi.spyOn(ledgerApiClient.periods, 'listFinalSettlements').mockResolvedValue({ data: [] } as any);
    const createSettlementSpy = vi.spyOn(ledgerApiClient.periods, 'createFinalSettlement').mockResolvedValue({
      data: { id: 'owner-fse-1' },
      finalSettlements: {},
      message: 'Created'
    } as any);

    await saveExpenseDayPostgres('2026-08', {
      dayNo: 32,
      date: '2026-08-FINAL',
      expenses: [],
      commissions: [],
      credits: [],
      ownerBalances: [
        {
          id: 'temp-owner-1',
          description: 'Owner Cash Withdrawal',
          amount: 50000,
          expense: 50000,
          received: 0
        },
        {
          id: 'temp-owner-2',
          description: 'Owner Capital Injection',
          amount: -30000,
          expense: 0,
          received: 30000
        }
      ]
    });

    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'OWNER_BALANCE',
      settlementType: 'OWNER_DRAWING',
      sourceReference: 'Owner Cash Withdrawal',
      amount: 50000
    }));

    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'OWNER_BALANCE',
      settlementType: 'OWNER_INJECTION',
      sourceReference: 'Owner Capital Injection',
      amount: 30000
    }));
  });

  it('11. Credit Parties dual-direction: loan and receive coexist for the same party without either being discarded', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue(mockFinalProjections as any);
    vi.spyOn(ledgerApiClient.periods, 'listFinalSettlements').mockResolvedValue({ data: [] } as any);
    const createSettlementSpy = vi.spyOn(ledgerApiClient.periods, 'createFinalSettlement').mockResolvedValue({
      data: { id: 'credit-fse-1' },
      finalSettlements: {},
      message: 'Created'
    } as any);

    await saveExpenseDayPostgres('2026-08', {
      dayNo: 32,
      date: '2026-08-FINAL',
      expenses: [],
      commissions: [],
      credits: [
        {
          id: 'credit-dual-alpha',
          partyId: 'cp-alpha',
          partyName: 'Alpha Dealer',
          opening: 12000,
          loan: 8000,
          loanDescription: 'Emergency stock credit advance',
          receive: 5000,
          receiveDescription: 'Cash recovery on bank deposit'
        }
      ],
      ownerBalances: []
    });

    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'CREDIT_PARTY_BALANCE',
      settlementType: 'CREDIT_LOAN',
      targetEntityId: 'cp-alpha',
      targetEntityName: 'Alpha Dealer',
      amount: 8000,
      sourceReference: 'Emergency stock credit advance'
    }));

    expect(createSettlementSpy).toHaveBeenCalledWith('period-aug-2026', expect.objectContaining({
      balanceDomain: 'CREDIT_PARTY_BALANCE',
      settlementType: 'CREDIT_RECEIVE',
      targetEntityId: 'cp-alpha',
      targetEntityName: 'Alpha Dealer',
      amount: 5000,
      sourceReference: 'Cash recovery on bank deposit'
    }));
  });

  it('12. Day 32 reload reconstructs exact transaction semantics and dual-direction credit rows', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValue(mockPeriodData as any);
    vi.spyOn(ledgerApiClient.calculations, 'getPeriodFinalProjections').mockResolvedValue({
      ...mockFinalProjections,
      operationalBalances: {
        financial: {
          closingCash: '50000.00',
          closingOwnerBalance: '25000.00'
        },
        creditParties: [
          {
            partyId: 'cp-alpha',
            partyName: 'Alpha Dealer',
            closingBalance: '12000.00'
          }
        ]
      },
      finalSettlements: {
        entries: [
          {
            id: 'exp-1',
            balanceDomain: 'EXPENSE',
            settlementType: 'EXPENSE',
            targetEntityId: '11111111-1111-1111-1111-111111111111',
            targetEntityName: 'Utilities',
            sourceReference: 'Electricity Bill',
            notes: 'Electricity August invoice',
            amount: '3500.00',
            status: 'ACTIVE'
          },
          {
            id: 'comm-1',
            balanceDomain: 'COMMISSION',
            settlementType: 'COMMISSION',
            targetEntityId: '22222222-2222-2222-2222-222222222222',
            targetEntityName: 'Special Incentive',
            amount: '4200.00',
            status: 'ACTIVE'
          },
          {
            id: 'owner-drawing-1',
            balanceDomain: 'OWNER_BALANCE',
            settlementType: 'OWNER_DRAWING',
            sourceReference: 'Owner Drawing',
            notes: 'Personal drawing',
            amount: '10000.00',
            status: 'ACTIVE'
          },
          {
            id: 'owner-inj-1',
            balanceDomain: 'OWNER_BALANCE',
            settlementType: 'OWNER_INJECTION',
            sourceReference: 'Partner Injection',
            notes: 'Equity contribution',
            amount: '15000.00',
            status: 'ACTIVE'
          },
          {
            id: 'cp-loan-1',
            balanceDomain: 'CREDIT_PARTY_BALANCE',
            settlementType: 'CREDIT_LOAN',
            targetEntityId: 'cp-alpha',
            targetEntityName: 'Alpha Dealer',
            amount: '8000.00',
            sourceReference: 'Extra loan advance',
            notes: 'Extra loan advance',
            status: 'ACTIVE'
          },
          {
            id: 'cp-recv-1',
            balanceDomain: 'CREDIT_PARTY_BALANCE',
            settlementType: 'CREDIT_RECEIVE',
            targetEntityId: 'cp-alpha',
            targetEntityName: 'Alpha Dealer',
            amount: '5000.00',
            sourceReference: 'Partial repayment',
            notes: 'Partial repayment',
            status: 'ACTIVE'
          }
        ]
      }
    } as any);

    const reloaded = await loadExpenseDayPostgres('2026-08', 32);
    expect(reloaded).not.toBeNull();

    // Opening balances hydrated from operationalBalances (Day 31 closing)
    expect(reloaded?.openingCash).toBe(50000);
    expect(reloaded?.ownerOpeningBalance).toBe(25000);

    // Expenses: preserves category, categoryId, name, description, amount
    expect(reloaded?.expenses).toHaveLength(1);
    expect(reloaded?.expenses[0]).toEqual({
      id: 'exp-1',
      categoryId: '11111111-1111-1111-1111-111111111111',
      category: 'Utilities',
      name: 'Electricity Bill',
      description: 'Electricity August invoice',
      amount: 3500
    });

    // Commissions: preserves category, categoryId, amount
    expect(reloaded?.commissions).toHaveLength(1);
    expect(reloaded?.commissions[0]).toEqual({
      id: 'comm-1',
      categoryId: '22222222-2222-2222-2222-222222222222',
      category: 'Special Incentive',
      amount: 4200
    });

    // Owner transactions: preserves drawings (+10000) and injections (-15000)
    expect(reloaded?.ownerBalances).toHaveLength(2);
    expect(reloaded?.ownerBalances[0]).toEqual({
      id: 'owner-drawing-1',
      description: 'Owner Drawing',
      amount: 10000,
      expense: 10000,
      received: 0
    });
    expect(reloaded?.ownerBalances[1]).toEqual({
      id: 'owner-inj-1',
      description: 'Partner Injection',
      amount: -15000,
      expense: 0,
      received: 15000
    });

    // Credit parties: dual-direction combined into the single party row with loan and receive
    expect(reloaded?.credits).toHaveLength(1);
    expect(reloaded?.credits[0]).toEqual({
      id: 'final-credit-cp-alpha',
      partyId: 'cp-alpha',
      partyName: 'Alpha Dealer',
      opening: 12000,
      loan: 8000,
      loanDescription: 'Extra loan advance',
      receive: 5000,
      receiveDescription: 'Partial repayment'
    });
  });
});
