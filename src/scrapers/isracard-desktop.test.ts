/* Synthetic page only; no bank requests or credential values. */
/* eslint-disable @typescript-eslint/require-await */
import { type BrowserContext, type Page } from 'puppeteer';
import { CompanyTypes } from '../definitions';
import { IsracardScraper } from './isracard';

const limits = { from: '2026-10-01', to: '2026-10-22', maxAccounts: 20, maxRows: 5000 };
const row = {
  dealSumType: '0',
  voucherNumberRatz: '000001234',
  fullPurchaseDate: '01/10/2026',
  fullPaymentDate: '10/10/2026',
  fullSupplierNameHeb: 'Synthetic shop',
  dealSum: 12.34,
  paymentSum: 12.34,
  currencyId: 'ILS',
  currentPaymentCurrency: 'ILS',
};
const dashboard = {
  Header: { Status: '1' },
  DashboardMonthBean: { cardsCharges: [{ cardIndex: '1', cardNumber: '1234', billingDate: '10/10/2026' }] },
};
function fixture(rows: unknown[] = [row], cards: unknown = dashboard, override?: unknown) {
  const page = {
    setCacheEnabled: jest.fn(async () => undefined),
    setDefaultTimeout: jest.fn(),
    setViewport: jest.fn(async () => undefined),
    on: jest.fn(),
    evaluate: jest.fn(async (_fn: unknown, url: string) => {
      if (new URL(url).searchParams.get('reqName') === 'DashboardMonth') return cards;
      if (override !== undefined) return override;
      return {
        Header: { Status: '1' },
        CardsTransactionsListBean: { Index1: { CurrentCardTransactions: [{ txnIsrael: rows, txnAbroad: [] }] } },
      };
    }),
  };
  const scraper = new IsracardScraper({
    companyId: CompanyTypes.isracard,
    startDate: new Date(limits.from),
    browserContext: { newPage: async () => page as unknown as Page } as unknown as BrowserContext,
    includeRawTransaction: false,
  });
  scraper.initializeDesktopPage(page as unknown as Page);
  return { scraper, page };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-23T12:00:00Z'));
});
afterEach(() => jest.useRealTimers());

test('desktop reads only bounded monthly data and preserves voucher zeroes, actual payment and installments', async () => {
  const { scraper, page } = fixture([
    row,
    { ...row, voucherNumberRatz: '000001235', moreInfo: 'תשלום 2 מתוך 4' },
    { ...row, voucherNumberRatz: '000001236', paymentSum: -5, dealSum: -5 },
  ]);

  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts?.[0].txns).toMatchObject([
    { identifier: '000001234', chargedAmount: -12.34, processedDate: '2026-10-10T00:00:00.000Z', status: 'completed' },
    { identifier: '000001235', installments: { number: 2, total: 4 }, chargedAmount: -12.34, status: 'completed' },
    { identifier: '000001236', chargedAmount: 5 },
  ]);
  expect(result.accounts?.[0].txns[1].date).toBe('2026-10-01T00:00:00.000Z');
  const urls = page.evaluate.mock.calls.map(call => new URL(call[1]));
  expect(urls.map(url => url.searchParams.get('reqName'))).toEqual(['DashboardMonth', 'CardsTransactionsList']);
  expect(
    urls.every(
      url => url.origin === 'https://digital.isracard.co.il' && url.pathname === '/services/ProxyRequestHandler.ashx',
    ),
  ).toBe(true);
  expect(page.on).not.toHaveBeenCalled();
  expect(page.setCacheEnabled).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/rawTransaction|balance|moreInfo|category/);
});

test('missing own payment, same-day/future settlement, zero/missing references and malformed source rows stay pending', async () => {
  const rows = [
    { ...row, fullPaymentDate: undefined },
    { ...row, fullPaymentDate: '23/10/2026' },
    { ...row, fullPaymentDate: '31/10/2026' },
    { ...row, voucherNumberRatz: '000000000' },
    { ...row, fullPurchaseDate: '30/02/2026' },
    { ...row, paymentSum: '12.34' },
    { ...row, moreInfo: 'תשלום 5 מתוך 4' },
    { ...row, currencyId: undefined },
    null,
  ];
  const { scraper } = fixture(rows);
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts?.[0].txns.map(item => item.status)).toEqual(rows.map(() => 'pending'));
  expect(JSON.stringify(result)).not.toContain('30/02/2026');
});

test('foreign purchases retain explicit actual ILS settlement without treating outbound amount as boolean', async () => {
  const { scraper, page } = fixture();
  page.evaluate.mockImplementation(async (_fn: unknown, url: string) =>
    new URL(url).searchParams.get('reqName') === 'DashboardMonth'
      ? dashboard
      : {
          Header: { Status: '1' },
          CardsTransactionsListBean: {
            Index1: {
              CurrentCardTransactions: [
                {
                  txnAbroad: [
                    {
                      ...row,
                      voucherNumberRatzOutbound: '000999',
                      fullPurchaseDateOutbound: '01/10/2026',
                      fullSupplierNameOutbound: 'Abroad shop',
                      dealSumOutbound: 5,
                      paymentSumOutbound: 20,
                      currentPaymentCurrency: 'USD',
                    },
                  ],
                },
              ],
            },
          },
        },
  );
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts?.[0].txns[0]).toMatchObject({
    originalAmount: -5,
    originalCurrency: 'USD',
    chargedAmount: -20,
    chargedCurrency: 'ILS',
  });
});

test('malformed, duplicate and ambiguous card envelopes fail closed with a fixed error', async () => {
  for (const cards of [
    null,
    {},
    {
      Header: { Status: '1' },
      DashboardMonthBean: {
        cardsCharges: [
          dashboard.DashboardMonthBean.cardsCharges[0],
          { ...dashboard.DashboardMonthBean.cardsCharges[0], cardIndex: '2' },
        ],
      },
    },
  ]) {
    const { scraper } = fixture([row], cards);
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toThrow('PROVIDER_UNAVAILABLE');
  }
  const { scraper } = fixture([row], dashboard, { Header: { Status: '1' }, CardsTransactionsListBean: { Index2: {} } });
  await expect(scraper.fetchDesktopTransactions(limits)).rejects.toThrow('PROVIDER_UNAVAILABLE');
});

test('hard limits and explicit date bounds never silently shorten a range', async () => {
  for (const value of [
    { ...limits, maxAccounts: 21 },
    { ...limits, maxRows: 5001 },
    { ...limits, from: '2025-09-01' },
    { ...limits, to: '2026-02-30' },
    { ...limits, to: '2026-10-24' },
  ]) {
    const { scraper, page } = fixture();
    await expect(scraper.fetchDesktopTransactions(value)).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(page.evaluate).not.toHaveBeenCalled();
  }
  const { scraper } = fixture([row, row]);
  await expect(scraper.fetchDesktopTransactions({ ...limits, maxRows: 1 })).rejects.toThrow('PROVIDER_UNAVAILABLE');
});

test('a rejected page operation never exposes the original provider exception', async () => {
  const { scraper, page } = fixture();
  page.evaluate.mockRejectedValue(new Error('sensitive source diagnostics'));
  const result = await scraper.fetchDesktopTransactions(limits).catch((error: Error) => error.message);
  expect(result).toBe('PROVIDER_UNAVAILABLE');
});

test('in-page fetch enforces exact authenticated origin/path, redirect refusal and streamed response bounds', async () => {
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const mockedFetch = jest.spyOn(globalThis, 'fetch');
  try {
    const { scraper, page } = fixture();
    page.evaluate.mockImplementation(async (fn: unknown, url: string) =>
      (fn as (value: string) => Promise<unknown>)(url),
    );
    for (const location of [
      { origin: 'https://other.example', pathname: '/personalarea/cardlist/' },
      { origin: 'https://digital.isracard.co.il', pathname: '/personalarea/Login' },
    ]) {
      Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
      await expect(scraper.fetchDesktopTransactions(limits)).rejects.toThrow('PROVIDER_UNAVAILABLE');
      expect(mockedFetch).not.toHaveBeenCalled();
    }
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://digital.isracard.co.il', pathname: '/personalarea/cardlist/' },
    });
    mockedFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2_000_001));
            controller.close();
          },
        }),
      ),
    );
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(mockedFetch).toHaveBeenCalledWith(
      expect.stringContaining('reqName=DashboardMonth'),
      expect.objectContaining({ credentials: 'include', redirect: 'error', signal: expect.any(AbortSignal) }),
    );
  } finally {
    mockedFetch.mockRestore();
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
