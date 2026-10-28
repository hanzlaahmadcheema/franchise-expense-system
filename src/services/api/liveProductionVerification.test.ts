import { describe, it, expect, vi } from 'vitest';
import { loadExpenseDayPostgres } from './expenseTransactionService';
import { loadJazzLoadDayPostgres } from './jazzLoadTransactionService';
import { ledgerApiClient } from './ledgerApiClient';
import * as periodDayService from './periodDayService';

describe('Day 2 Production Projection Verification', () => {
  it('verifies Day 2 Expense projections unpack correctly and eliminate 10,500', async () => {
    // Simulate real backend API response from GET /api/v1/calculations/projections/day/ccf1c4a1-0e8d-4295-b955-9c348d2dc007
    const day2ProjectionsBackendResponse = {
      data: {
        day: {
          id: 'ccf1c4a1-0e8d-4295-b955-9c348d2dc007',
          dayNo: 2,
          periodId: 'f63be61b-1183-4f6a-ada5-87d267eeb4dc',
          status: 'closed' as const,
          calendarDate: '2026-08-02'
        },
        projections: {
          financial: {
            opening_cash: '-6164.00',
            closing_cash: '-6164.00',
            owner_opening_balance: '129962.00',
            owner_closing_balance: '129962.00'
          },
          creditParties: [
            { party_id: '151ac471-6c9c-4a7e-8e9f-70f65c72896b', opening_balance: '9000.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '9000.00' },
            { party_id: '1c99b0d3-843f-473b-8140-d888db378483', opening_balance: '30000.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '30000.00' },
            { party_id: '2daf0877-b9f7-4109-a2db-13739d81d30b', opening_balance: '5000.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '5000.00' },
            { party_id: '35cfa8a0-0c5b-4fba-ada0-2cedd38c56b9', opening_balance: '30000.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '30000.00' },
            { party_id: '66a484f7-90e5-46ce-8b49-7159f55814a6', opening_balance: '17703.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '17703.00' },
            { party_id: 'b56a06a2-9be0-42bb-b666-dd8d38be1f66', opening_balance: '8300.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '8300.00' },
            { party_id: 'b7a366c8-8a80-4855-bb76-236449bff582', opening_balance: '39948.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '39948.00' },
            { party_id: 'e547af19-1b39-4832-8db4-c9d5bbaf8c64', opening_balance: '-36547.00', total_loans: '0.00', total_receipts: '0.00', closing_balance: '-36547.00' }
          ],
          stockProducts: [],
          stockAccounts: [],
          jazzLifting: {
            id: '3ecf16c1-7252-44e0-8b7c-1bb5e572f439',
            opening_lifting: '1573827.17',
            ml_lifting_purchased: '0.00',
            today_ml_issuance: '0.00',
            closing_lifting_in_hand: '1573827.17'
          },
          jazzDo: []
        }
      }
    };

    // Spy on getAccountingPeriodWithDays
    const periodDataMock = {
      period: { id: 'f63be61b-1183-4f6a-ada5-87d267eeb4dc', period_key: '2026-08', status: 'open' } as any,
      days: new Map([
        [2, { id: 'ccf1c4a1-0e8d-4295-b955-9c348d2dc007', day_no: 2, status: 'closed', closed_at: '2026-09-19T15:55:14.515Z' } as any]
      ]),
      fetchedAt: Date.now()
    };

    vi.spyOn(periodDayService, 'getAccountingPeriodWithDays').mockResolvedValue(periodDataMock);
    vi.spyOn(ledgerApiClient.expenses, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.commissions, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.credits, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.owner, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.catalogs, 'getCreditParties').mockResolvedValue({
      data: [
        { id: '151ac471-6c9c-4a7e-8e9f-70f65c72896b', name: 'AKHTAR' },
        { id: '1c99b0d3-843f-473b-8140-d888db378483', name: 'NAVEED DO' },
        { id: '2daf0877-b9f7-4109-a2db-13739d81d30b', name: 'SARAM' },
        { id: '35cfa8a0-0c5b-4fba-ada0-2cedd38c56b9', name: 'DSO HASAN' },
        { id: '66a484f7-90e5-46ce-8b49-7159f55814a6', name: 'Usman cheema' },
        { id: 'b56a06a2-9be0-42bb-b666-dd8d38be1f66', name: 'IMRAN OLAKH' },
        { id: 'b7a366c8-8a80-4855-bb76-236449bff582', name: 'ALI OLAKH' },
        { id: 'e547af19-1b39-4832-8db4-c9d5bbaf8c64', name: 'Masjid Account' }
      ]
    } as any);

    // Spy on global.fetch so ledgerApiClient.calculations.getDayProjections receives the real wrapped backend format
    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('/api/v1/calculations/projections/day/ccf1c4a1-0e8d-4295-b955-9c348d2dc007')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => day2ProjectionsBackendResponse
        } as Response;
      }
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: [] })
      } as Response;
    });

    const day2Result = await loadExpenseDayPostgres('2026-08', 2);

    expect(day2Result).toBeDefined();
    // All 8 credit parties must be populated on Day 2
    expect(day2Result?.credits.length).toBe(8);

    // Masjid Account must show authoritative opening -36,547 (NOT the erroneous 10,500)
    const masjid = day2Result?.credits.find((c) => c.partyId === 'e547af19-1b39-4832-8db4-c9d5bbaf8c64');
    expect(masjid).toBeDefined();
    expect(masjid?.partyName).toBe('Masjid Account');
    expect(masjid?.opening).toBe(-36547);
    expect(masjid?.opening).not.toBe(10500);

    // Verify all other 7 credit parties have their projected opening seeds
    const ali = day2Result?.credits.find((c) => c.partyId === 'b7a366c8-8a80-4855-bb76-236449bff582');
    expect(ali?.opening).toBe(39948);

    const usman = day2Result?.credits.find((c) => c.partyId === '66a484f7-90e5-46ce-8b49-7159f55814a6');
    expect(usman?.opening).toBe(17703);

    const akhtar = day2Result?.credits.find((c) => c.partyId === '151ac471-6c9c-4a7e-8e9f-70f65c72896b');
    expect(akhtar?.opening).toBe(9000);

    const imran = day2Result?.credits.find((c) => c.partyId === 'b56a06a2-9be0-42bb-b666-dd8d38be1f66');
    expect(imran?.opening).toBe(8300);

    const dsoHasan = day2Result?.credits.find((c) => c.partyId === '35cfa8a0-0c5b-4fba-ada0-2cedd38c56b9');
    expect(dsoHasan?.opening).toBe(30000);

    const saram = day2Result?.credits.find((c) => c.partyId === '2daf0877-b9f7-4109-a2db-13739d81d30b');
    expect(saram?.opening).toBe(5000);

    const naveed = day2Result?.credits.find((c) => c.partyId === '1c99b0d3-843f-473b-8140-d888db378483');
    expect(naveed?.opening).toBe(30000);
  });

  it('verifies Day 2 JazzLoad opening lifting is 1,573,827.17 and eliminates 695,303.17', async () => {
    vi.spyOn(periodDayService, 'resolveAccountingDayId').mockResolvedValue('ccf1c4a1-0e8d-4295-b955-9c348d2dc007');
    vi.spyOn(ledgerApiClient.jazzDo, 'list').mockResolvedValue({ data: [] } as any);
    vi.spyOn(ledgerApiClient.jazzLifting, 'list').mockResolvedValue({ data: [] } as any);

    const day2ProjectionsBackendResponse = {
      data: {
        day: {
          id: 'ccf1c4a1-0e8d-4295-b955-9c348d2dc007',
          dayNo: 2,
          periodId: 'f63be61b-1183-4f6a-ada5-87d267eeb4dc',
          status: 'closed' as const,
          calendarDate: '2026-08-02'
        },
        projections: {
          financial: null,
          creditParties: [],
          stockProducts: [],
          stockAccounts: [],
          jazzLifting: {
            id: '3ecf16c1-7252-44e0-8b7c-1bb5e572f439',
            opening_lifting: '1573827.17',
            ml_lifting_purchased: '0.00',
            today_ml_issuance: '0.00',
            closing_lifting_in_hand: '1573827.17'
          },
          jazzDo: []
        }
      }
    };

    vi.spyOn(global, 'fetch').mockImplementation(async (url: any) => {
      if (String(url).includes('/api/v1/calculations/projections/day/')) {
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: async () => day2ProjectionsBackendResponse
        } as Response;
      }
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ data: [] })
      } as Response;
    });

    const jazzDay = await loadJazzLoadDayPostgres('2026-08', 2, [], []);

    expect(jazzDay).toBeDefined();
    // Authoritative lifting opening on Day 2 must be 1,573,827.17
    expect(jazzDay?.lifting.openingBalance).toBe(1573827.17);
    expect(jazzDay?.lifting.openingBalance).not.toBe(695303.17);
    expect(jazzDay?.lifting.openingBalance).not.toBe(0);
  });
});
