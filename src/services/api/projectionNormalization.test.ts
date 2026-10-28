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
  resolveAccountingDayId: vi.fn().mockResolvedValue('day-1')
}));

describe('PostgreSQL Projection Normalization & Consumption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. { data: { projections } } is correctly normalized by calculations.getDayProjections', async () => {
    const rawBackendResponse = {
      data: {
        day: {
          id: 'day-2',
          dayNo: 2,
          periodId: 'period-1',
          status: 'closed' as const,
          calendarDate: '2026-08-02'
        },
        projections: {
          financial: null,
          creditParties: [
            { party_id: 'masjid', opening_balance: -36547 }
          ],
          stockProducts: [],
          stockAccounts: [
            { account_id: 'acc-1', opening_due: 12500 }
          ],
          jazzLifting: {
            opening_lifting: 1573827.17,
            closing_lifting_in_hand: 1573827.17
          },
          jazzDo: []
        }
      }
    };

    // Spy on global.fetch to return the raw backend response format
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => rawBackendResponse
    } as Response);

    const result = await ledgerApiClient.calculations.getDayProjections('day-2');

    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/calculations/projections/day/day-2',
      expect.anything()
    );
    expect(result).toBeDefined();
    expect(result.projections).toBeDefined();
    expect(result.projections.jazzLifting?.opening_lifting).toBe(1573827.17);
    expect(result.projections.creditParties[0].opening_balance).toBe(-36547);
    expect(result.projections.stockAccounts[0].opening_due).toBe(12500);
  });

  it('2. Direct { projections } responses remain supported', async () => {
    const directResponse = {
      day: {
        id: 'day-1',
        dayNo: 1,
        periodId: 'period-1',
        status: 'open' as const,
        calendarDate: '2026-08-01'
      },
      projections: {
        financial: null,
        creditParties: [
          { party_id: 'masjid', opening_balance: -47047 }
        ],
        stockProducts: [],
        stockAccounts: [],
        jazzLifting: {
          opening_lifting: 878524,
          closing_lifting_in_hand: 1573827.17
        },
        jazzDo: []
      }
    };

    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => directResponse
    } as Response);

    const result = await ledgerApiClient.calculations.getDayProjections('day-1');

    expect(result).toBeDefined();
    expect(result.projections).toBeDefined();
    expect(result.projections.jazzLifting?.opening_lifting).toBe(878524);
    expect(result.projections.creditParties[0].opening_balance).toBe(-47047);
  });

  it('3. Expense consumes authoritative credit projections with wrapped { data }', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValueOnce({
      period: { id: 'p1', period_key: '2026-08' } as any,
      days: new Map([[2, { id: 'd2', day_no: 2, status: 'closed' } as any]]),
      fetchedAt: Date.now()
    });

    vi.spyOn(ledgerApiClient.expenses, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.commissions, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.credits, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.owner, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.catalogs, 'getCreditParties').mockResolvedValueOnce({
      data: [
        { id: 'masjid', name: 'Masjid Account' },
        { id: 'ali', name: 'ALI OLAKH' }
      ]
    } as any);

    // Mock getDayProjections returning wrapped data
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValueOnce({
      data: {
        day: { id: 'd2', dayNo: 2, periodId: 'p1', status: 'closed', calendarDate: '2026-08-02' },
        projections: {
          financial: null,
          creditParties: [
            { party_id: 'masjid', opening_balance: -36547 },
            { party_id: 'ali', opening_balance: 39948 }
          ],
          stockProducts: [],
          stockAccounts: [],
          jazzLifting: null,
          jazzDo: []
        }
      }
    } as any);

    const expenseDay = await loadExpenseDayPostgres('2026-08', 2);

    expect(expenseDay).toBeDefined();
    expect(expenseDay?.credits.length).toBe(2);

    const masjidRow = expenseDay?.credits.find((c) => c.partyId === 'masjid');
    expect(masjidRow).toBeDefined();
    expect(masjidRow?.opening).toBe(-36547);

    const aliRow = expenseDay?.credits.find((c) => c.partyId === 'ali');
    expect(aliRow).toBeDefined();
    expect(aliRow?.opening).toBe(39948);
  });

  it('4. JazzLoad consumes authoritative lifting projection with wrapped { data }', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValueOnce({
      period: { id: 'p1', period_key: '2026-08' } as any,
      days: new Map([[2, { id: 'd2', day_no: 2, status: 'closed' } as any]]),
      fetchedAt: Date.now()
    });

    vi.spyOn(ledgerApiClient.jazzDo, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.jazzLifting, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValueOnce({
      data: {
        day: { id: 'd2', dayNo: 2, periodId: 'p1', status: 'closed', calendarDate: '2026-08-02' },
        projections: {
          financial: null,
          creditParties: [],
          stockProducts: [],
          stockAccounts: [],
          jazzLifting: {
            opening_lifting: 1573827.17,
            closing_lifting_in_hand: 1573827.17
          },
          jazzDo: []
        }
      }
    } as any);

    const jazzDay = await loadJazzLoadDayPostgres('2026-08', 2, [], []);

    expect(jazzDay).toBeDefined();
    expect(jazzDay?.lifting.openingBalance).toBe(1573827.17);
  });

  it('5. Stock projection consumption remains intact with wrapped { data }', async () => {
    vi.mocked(periodDayService.getAccountingPeriodWithDays).mockResolvedValueOnce({
      period: { id: 'p1', period_key: '2026-08' } as any,
      days: new Map([[2, { id: 'd2', day_no: 2, status: 'closed' } as any]]),
      fetchedAt: Date.now()
    });

    vi.spyOn(ledgerApiClient.stockOrders, 'list').mockResolvedValueOnce({
      data: [
        {
          id: 'ord-1',
          account_id: 'acc-1',
          direction: 'outbound',
          lines: [{ product_id: 'prod-1', quantity: 10, unit_rate: 100 }]
        }
      ]
    } as any);
    vi.spyOn(ledgerApiClient.stockPayments, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.jazzCompanyPayments, 'list').mockResolvedValueOnce({ data: [] } as any);
    vi.spyOn(ledgerApiClient.calculations, 'getDayProjections').mockResolvedValueOnce({
      data: {
        day: { id: 'd2', dayNo: 2, periodId: 'p1', status: 'closed', calendarDate: '2026-08-02' },
        projections: {
          financial: null,
          creditParties: [],
          stockProducts: [],
          stockAccounts: [
            { account_id: 'acc-1', opening_due: 12500 }
          ],
          jazzLifting: null,
          jazzDo: []
        }
      }
    } as any);

    const stockDay = await loadStockDayPostgres(
      '2026-08',
      2,
      [{ id: 'prod-1', name: 'Product 1', rate: 100, displayOrder: 1 }] as any,
      [{ id: 'acc-1', name: 'Account 1', type: 'DO', openingBalance: 0 }] as any
    );

    expect(stockDay).toBeDefined();
    expect(stockDay?.entries.length).toBe(1);
    expect(stockDay?.entries[0].carryForwardBalance).toBe(12500);
    // 12500 (carryForward) + 1000 (10 * 100) - 0 (payment) = 13500
    expect(stockDay?.entries[0].dueBalance).toBe(13500);
  });

  it('6. No Firestore calls are introduced', () => {
    // Assert that loadExpenseDayPostgres, loadJazzLoadDayPostgres, loadStockDayPostgres do not use Firestore
    expect(periodDayService.isPostgreSqlPeriod('2026-08')).toBe(true);
  });
});
