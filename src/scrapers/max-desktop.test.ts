/* Synthetic browser methods deliberately perform no bank I/O. */
import { type Page } from 'puppeteer';
import { CompanyTypes } from '../definitions';
import { MaxScraper } from './max';

const row = {
  shortCardNumber: '1234',
  purchaseDate: '2026-09-20T00:00:00Z',
  paymentDate: '2026-10-02T00:00:00Z',
  actualPaymentAmount: '12.34',
  paymentCurrency: 376,
  originalCurrency: 'ILS',
  originalAmount: 12.34,
  planName: 'רגילה',
  planTypeId: 5,
  comments: 'Secret memo 123456789',
  merchantName: 'Synthetic shop',
  categoryId: 1,
  dealData: { arn: 'stable-reference' },
  secret: 'never returned',
};
const limits = { from: '2026-10-01', to: '2026-10-22', maxAccounts: 20, maxRows: 5000 };
function fixture(responses: unknown[] = [{ result: { transactions: [row] } }]) {
  const evaluate = jest.fn();
  responses.forEach(response => evaluate.mockResolvedValueOnce(response));
  const scraper = new MaxScraper({
    companyId: CompanyTypes.max,
    startDate: new Date('2026-10-01T00:00:00Z'),
    includeRawTransaction: true,
  });
  scraper.initializeDesktopPage({ evaluate } as unknown as Page);
  return { scraper, evaluate };
}

test('Max desktop reuses only the requested transactions endpoint and preserves actual settlement and purchase dates', async () => {
  const { scraper, evaluate } = fixture();
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts[0]).toEqual({
    accountNumber: '1234',
    txns: [
      {
        type: 'normal',
        identifier: 'stable-reference',
        date: '2026-09-20T00:00:00.000Z',
        processedDate: '2026-10-02T00:00:00.000Z',
        originalAmount: -12.34,
        originalCurrency: 'ILS',
        chargedAmount: -12.34,
        chargedCurrency: 'ILS',
        description: 'Synthetic shop',
        status: 'completed',
      },
    ],
  });
  expect(evaluate).toHaveBeenCalledTimes(1);
  const url = new URL(evaluate.mock.calls[0][1]);
  expect(url.origin + url.pathname).toBe(
    'https://onlinelcapi.max.co.il/api/registered/transactionDetails/getTransactionsAndGraphs',
  );
  expect(JSON.parse(url.searchParams.get('filterData')!).date).toBe('2026-10-01');
  expect(JSON.stringify(result)).not.toMatch(/Secret memo|never returned|category|balance|rawTransaction/);
});

test('Max desktop marks absent settlement pending and never fabricates an ARN for installments', async () => {
  const pending = {
    ...row,
    paymentDate: undefined,
    purchaseDate: '2026-10-03',
    dealData: undefined,
    planName: 'תשלומים',
    planTypeId: 2,
    comments: 'תשלום 2 מתוך 3',
  };
  const { scraper } = fixture([{ result: { transactions: [pending, { ...pending, paymentDate: null }] } }]);
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts[0].txns).toHaveLength(2);
  for (const transaction of result.accounts[0].txns) {
    expect(transaction.status).toBe('pending');
    expect(transaction.identifier).toBeUndefined();
    expect(transaction.installments).toEqual({ number: 2, total: 3 });
    expect(transaction.date).toBe('2026-10-03T00:00:00.000Z');
  }
});

test('Max desktop bounds months, rows, cards, malformed dates and raw errors with fixed failures', async () => {
  for (const patch of [{ from: '2000-01-01' }, { to: '2031-10-01' }, { from: '2026-02-30' }, { maxRows: 5001 }]) {
    const { scraper, evaluate } = fixture();
    await expect(scraper.fetchDesktopTransactions({ ...limits, ...patch })).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(evaluate).not.toHaveBeenCalled();
  }
  for (const patch of [
    { purchaseDate: undefined },
    { paymentDate: '2026-02-30' },
    { actualPaymentAmount: '12.345' },
    { shortCardNumber: '12345678' },
    { planName: 'secret unknown plan', planTypeId: 99 },
    { dealData: { arn: 'raw secret' } },
  ]) {
    const { scraper } = fixture([{ result: { transactions: [{ ...row, ...patch }] } }]);
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
  }
  const { scraper } = fixture([{ result: { transactions: [row, row] } }]);
  await expect(scraper.fetchDesktopTransactions({ ...limits, maxRows: 1 })).rejects.toThrow('PROVIDER_UNAVAILABLE');
  const cards = fixture([{ result: { transactions: [row, { ...row, shortCardNumber: '5678' }] } }]);
  await expect(cards.scraper.fetchDesktopTransactions({ ...limits, maxAccounts: 1 })).rejects.toThrow(
    'PROVIDER_UNAVAILABLE',
  );
  const errors = fixture();
  errors.evaluate.mockReset().mockRejectedValue(new Error('private response containing credentials'));
  await expect(errors.scraper.fetchDesktopTransactions(limits)).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
});

test('Max desktop requests bounded month range only, retaining installment identities without date shifting', async () => {
  const installment = { ...row, planName: 'תשלומים', planTypeId: 2, comments: 'תשלום 2 מתוך 3' };
  const { scraper, evaluate } = fixture([
    { result: { transactions: [installment] } },
    { result: { transactions: [] } },
  ]);
  const result = await scraper.fetchDesktopTransactions({ ...limits, to: '2026-11-01' });
  expect(evaluate).toHaveBeenCalledTimes(2);
  expect(result.accounts[0].txns[0].identifier).toBe('stable-reference_2');
  expect(result.accounts[0].txns[0].date).toBe('2026-09-20T00:00:00.000Z');
  expect(result.accounts[0].txns[0].processedDate).toBe('2026-10-02T00:00:00.000Z');
});

test('Max desktop confines fetch to exact authenticated origin, JSON responses, no redirects and a bounded stream', async () => {
  const { scraper, evaluate } = fixture();
  await scraper.fetchDesktopTransactions(limits);
  const fetchInPage = evaluate.mock.calls[0][0] as (url: string, maxBytes: number) => Promise<unknown>;
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://www.max.co.il', pathname: '/homepage/personal' },
  });
  try {
    fetchSpy.mockResolvedValue(
      new Response('{"result":{"transactions":[]}}', { headers: { 'content-type': 'application/json' } }),
    );
    await expect(fetchInPage('https://onlinelcapi.max.co.il/test', 100)).resolves.toEqual({
      result: { transactions: [] },
    });
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ credentials: 'include', redirect: 'error' });
    for (const response of [
      new Response('private response', { status: 403 }),
      new Response('{}', { headers: { 'content-type': 'text/html' } }),
      new Response('private response body', { headers: { 'content-type': 'application/json' } }),
    ]) {
      fetchSpy.mockResolvedValueOnce(response);
      await expect(fetchInPage('https://onlinelcapi.max.co.il/test', 4)).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
    }
    fetchSpy.mockClear();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://evil.example', pathname: '/homepage/personal' },
    });
    await expect(fetchInPage('https://onlinelcapi.max.co.il/test', 100)).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});
