/* Synthetic browser methods intentionally resolve without real I/O. */
/* eslint-disable @typescript-eslint/require-await */
import { type BrowserContext, type Page } from 'puppeteer';
import { CompanyTypes } from '../../definitions';
import { LeumiScraper } from './leumi';

const filtered =
  'https://hb2.bankleumi.co.il/ChannelWCF/Broker.svc/ProcessRequest?moduleName=UC_SO_27_GetBusinessAccountTrx';
const transaction = {
  DateUTC: '2026-10-20T12:00:00Z',
  Description: 'Synthetic purchase',
  ReferenceNumberLong: 'ref-1',
  Amount: -12.34,
};
function fixture(
  accountIds: unknown = ['12-345678'],
  responses: unknown[] = [{ TodayTransactionsItems: [transaction], HistoryTransactionsItems: [transaction] }],
) {
  let next = 0;
  const page = {
    setCacheEnabled: jest.fn(async () => undefined),
    setDefaultTimeout: jest.fn(),
    setViewport: jest.fn(async () => undefined),
    on: jest.fn(),
    goto: jest.fn(async (url: string) => {
      void url;
      return { ok: () => true };
    }),
    evaluate: jest.fn(async () => accountIds),
    waitForSelector: jest.fn(async () => undefined),
    $eval: jest.fn(async () => undefined),
    type: jest.fn(async (selector: string, value: string) => {
      void selector;
      void value;
    }),
    focus: jest.fn(async () => undefined),
    $$: jest.fn(async () => [{ click: async () => undefined }]),
    waitForResponse: jest.fn(async (predicate: (response: unknown) => boolean) => {
      const response = {
        url: () => filtered,
        request: () => ({ method: () => 'POST' }),
        json: async () => ({ jsonResp: JSON.stringify(responses[next++]) }),
      };
      expect(predicate(response)).toBe(true);
      return response;
    }),
  };
  const scraper = new LeumiScraper({
    companyId: CompanyTypes.leumi,
    startDate: new Date('2026-10-01T00:00:00Z'),
    browserContext: { newPage: async () => page as unknown as Page } as unknown as BrowserContext,
    includeRawTransaction: false,
  });
  return { page, scraper };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('desktop hook reuses original history/pending parser and never requests savings, forex or credentials', async () => {
  const { page, scraper } = fixture();
  await scraper.initialize();
  const pending = scraper.fetchDesktopTransactions({ maxAccounts: 20, maxRows: 5000 });
  await jest.runAllTimersAsync();
  const result = await pending;
  expect(result.success).toBe(true);
  expect(result.accounts).toHaveLength(1);
  expect(result.accounts?.[0].txns.map(row => row.status)).toEqual(['pending', 'completed']);
  expect(result.accounts?.[0].txns[1]).toMatchObject({
    identifier: 'ref-1',
    chargedAmount: -12.34,
    originalCurrency: 'ILS',
  });
  expect(page.goto.mock.calls).toHaveLength(1);
  expect(page.goto.mock.calls[0][0]).toBe(
    'https://hb2.bankleumi.co.il/eBanking/SO/SPA.aspx#/ts/BusinessAccountTrx?WidgetPar=1',
  );
  expect(page.type.mock.calls).toEqual([['input[formcontrolname="txtInputFrom"]', '01.10.26']]);
});

test('desktop hook rejects empty, malformed, duplicate and excessive account lists before account selection', async () => {
  for (const ids of [
    [],
    null,
    [''],
    ['abc'],
    ['12-34', '12-34'],
    ['12/34', '12&/34'],
    ["12'34"],
    Array(21).fill('12-34'),
  ]) {
    const { page, scraper } = fixture(ids);
    await scraper.initialize();
    const rejected = expect(scraper.fetchDesktopTransactions({ maxAccounts: 20, maxRows: 5000 })).rejects.toThrow();
    await jest.runAllTimersAsync();
    await rejected;
    expect(page.$$).not.toHaveBeenCalled();
    expect(page.waitForResponse).not.toHaveBeenCalled();
  }
});

test('desktop hook counts cumulative raw Today and History rows before mapping each account', async () => {
  const { scraper } = fixture(
    ['12-34', '56-78'],
    [
      { TodayTransactionsItems: [transaction], HistoryTransactionsItems: [transaction] },
      { TodayTransactionsItems: [], HistoryTransactionsItems: [transaction, transaction] },
    ],
  );
  await scraper.initialize();
  const rejected = expect(scraper.fetchDesktopTransactions({ maxAccounts: 20, maxRows: 3 })).rejects.toThrow(
    'PROVIDER_UNAVAILABLE',
  );
  await jest.runAllTimersAsync();
  await rejected;
});

test('desktop hook rejects malformed transaction envelopes and invalid hard limits', async () => {
  for (const response of [null, {}, { TodayTransactionsItems: [], HistoryTransactionsItems: 'raw secret' }]) {
    const { scraper } = fixture(['12-34'], [response]);
    await scraper.initialize();
    const rejected = expect(scraper.fetchDesktopTransactions({ maxAccounts: 20, maxRows: 5000 })).rejects.toThrow(
      'PROVIDER_UNAVAILABLE',
    );
    await jest.runAllTimersAsync();
    await rejected;
  }
  for (const limits of [
    { maxAccounts: 21, maxRows: 5000 },
    { maxAccounts: 1, maxRows: 5001 },
    { maxAccounts: 0, maxRows: 1 },
  ]) {
    const { scraper } = fixture();
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toThrow('PROVIDER_UNAVAILABLE');
  }
});

test('desktop hook refuses unsupported history ranges before bank navigation', async () => {
  const { page, scraper } = fixture();
  scraper.options.startDate = new Date('2000-01-01T00:00:00Z');
  await scraper.initialize();
  await expect(scraper.fetchDesktopTransactions({ maxAccounts: 20, maxRows: 5000 })).rejects.toThrow(
    'DATE_RANGE_UNSUPPORTED',
  );
  expect(page.goto).not.toHaveBeenCalled();
  expect(page.waitForResponse).not.toHaveBeenCalled();
});
