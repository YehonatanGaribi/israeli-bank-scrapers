/* Synthetic callbacks intentionally return already-resolved promises. */
/* eslint-disable @typescript-eslint/require-await */
import OneZeroScraper, { type OneZeroOperation, type OneZeroRuntime } from './one-zero';
import { CompanyTypes } from '../definitions';
import { BaseScraper } from './base-scraper';
import { fetchGraphql, fetchPost, fetchGetWithinPage, fetchPostWithinPage } from '../helpers/fetch';
import { type Page } from 'puppeteer';
import { BaseScraperWithBrowser } from './base-scraper-with-browser';

const secret = 'SYNTHETIC_SECRET_NEVER_REAL';
const options = { companyId: CompanyTypes.oneZero, startDate: new Date('2026-10-01') };
const credentials = {
  email: 'fake@example.invalid',
  password: secret,
  phoneNumber: '+972501234567',
  otpCodeRetriever: jest.fn(async () => '123456'),
};
function fixture() {
  const calls: Array<{ operation: OneZeroOperation; body: any; authorization?: string }> = [];
  const signal = new AbortController();
  let cursorLoop = false;
  const runtime: OneZeroRuntime = {
    signal: signal.signal,
    request: async (operation, body, authorization) => {
      calls.push({ operation, body, authorization });
      const token = (
        {
          deviceToken: 'deviceToken',
          prepareOtp: 'otpContext',
          verifyOtp: 'otpToken',
          idToken: 'idToken',
          sessionToken: 'accessToken',
        } as Partial<Record<OneZeroOperation, string>>
      )[operation];
      if (token) return { resultData: { [token]: `${token}_${secret}` } };
      if (operation === 'customer')
        return {
          data: {
            customer: [
              {
                customerId: 'person',
                portfolios: [
                  {
                    portfolioId: 'portfolio',
                    accounts: [
                      { accountId: 'ils', currency: 'ILS' },
                      { accountId: 'fx', currency: 'USD' },
                    ],
                  },
                ],
              },
            ],
          },
        };
      return {
        data: {
          movements: {
            movements: [{ accountId: (body as any).variables.accountId }],
            pagination: { hasMore: cursorLoop, cursor: 'same' },
          },
        },
      };
    },
  };
  return {
    calls,
    signal,
    runtime,
    loop: () => {
      cursorLoop = true;
    },
  };
}

test('patched original ONE ZERO authenticates freshly and never returns or accepts reusable OTP tokens', async () => {
  const f = fixture(),
    scraper = new OneZeroScraper(options, f.runtime);
  expect(await scraper.login(credentials)).toEqual({ success: true });
  expect(f.calls.map(call => call.operation)).toEqual([
    'deviceToken',
    'prepareOtp',
    'verifyOtp',
    'idToken',
    'sessionToken',
  ]);
  expect(f.calls[2].body).toEqual({ otpContext: `otpContext_${secret}`, otpCode: '123456' });
  expect(f.calls[3].body.pass).toBe(secret);
  expect(await scraper.getLongTermTwoFactorToken('123456')).toMatchObject({
    success: false,
    errorMessage: 'PERSISTENT_TOKEN_DISABLED',
  });
  await scraper.login(credentials);
  expect(f.calls.filter(call => call.operation === 'prepareOtp')).toHaveLength(2);
  expect(await scraper.login({ email: credentials.email, password: secret, otpLongTermToken: secret })).toMatchObject({
    success: false,
    errorMessage: 'PERSISTENT_TOKEN_DISABLED',
  });
  scraper.dispose();
  await expect(scraper.fetchDesktopData()).rejects.toThrow('PROVIDER_UNAVAILABLE');
});

test('desktop path uses every account, minimal queries and private bearer transport', async () => {
  const f = fixture(),
    scraper = new OneZeroScraper(options, f.runtime);
  await scraper.login(credentials);
  const raw = await scraper.fetchDesktopData();
  expect(raw.pages.map(page => page.accountId)).toEqual(['ils', 'fx']);
  const reads = f.calls.filter(call => ['customer', 'movements'].includes(call.operation));
  expect(reads.every(call => call.authorization === `Bearer accessToken_${secret}`)).toBe(true);
  expect(reads[0].body.query).not.toMatch(/idNumber|FirstName|LastName|dateOfBirth|portfolioNum|iban|balance/i);
  expect(reads[1].body.query).not.toMatch(/counterParty|runningBalance|referenceNumber|imageUrl/);
  scraper.dispose();
});

test('repeated cursors, bad tokens, GraphQL errors and cancellation fail without partial data or raw errors', async () => {
  const f = fixture(),
    scraper = new OneZeroScraper(options, f.runtime);
  await scraper.login(credentials);
  f.loop();
  await expect(scraper.fetchDesktopData()).rejects.toThrow('PROVIDER_UNAVAILABLE');
  scraper.dispose();
  for (const response of [{ resultData: { deviceToken: '\r\n' } }, { errors: [{ message: secret }] }]) {
    const broken = new OneZeroScraper(options, { signal: new AbortController().signal, request: async () => response });
    await expect(broken.login(credentials)).rejects.toThrow('PROVIDER_UNAVAILABLE');
    broken.dispose();
  }
  f.signal.abort();
  await expect(new OneZeroScraper(options, f.runtime).login(credentials)).rejects.toThrow('PROVIDER_UNAVAILABLE');
});

test('HTTP helpers discard raw request failures and GraphQL error messages at source', async () => {
  const original = global.fetch;
  try {
    global.fetch = jest.fn(async () => {
      throw new Error(secret);
    });
    await expect(fetchPost('https://example.invalid', { password: secret })).rejects.toThrow('PROVIDER_REQUEST_FAILED');
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ errors: [{ message: secret }] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    await expect(fetchGraphql('https://example.invalid', 'query{}')).rejects.toThrow('PROVIDER_GRAPHQL_FAILED');
  } finally {
    global.fetch = original;
  }
  const page = { evaluate: jest.fn(() => Promise.reject(new Error(secret))) } as unknown as Page;
  await expect(fetchGetWithinPage(page, 'https://example.invalid')).rejects.toThrow('PROVIDER_REQUEST_FAILED');
  await expect(fetchPostWithinPage(page, 'https://example.invalid', { password: secret })).rejects.toThrow(
    'PROVIDER_REQUEST_FAILED',
  );
});

test('base scraper terminates after initialization failure and never forwards caught raw exceptions', async () => {
  let terminated = false;
  class Probe extends BaseScraper<{ username: string; password: string }> {
    async initialize() {
      throw new Error(secret);
    }
    protected async terminate() {
      terminated = true;
    }
  }
  const result = await new Probe(options).scrape({ username: 'fake', password: secret });
  expect(terminated).toBe(true);
  expect(result).toMatchObject({ success: false, errorMessage: 'PROVIDER_UNAVAILABLE' });
  expect(JSON.stringify(result)).not.toContain(secret);
});

test('failure screenshot option cannot capture a banking page in this fork', async () => {
  const screenshot = jest.fn();
  const browser = new BaseScraperWithBrowser({
    ...options,
    storeFailureScreenShotPath: '/synthetic-never-written.png',
  });
  (browser as unknown as { page: { screenshot: typeof screenshot } }).page = { screenshot };
  await browser.terminate(false);
  expect(screenshot).not.toHaveBeenCalled();
});

test('desktop preparation owns the anonymous request and its private token is consumed once by login', async () => {
  const f = fixture();
  const scraper = new OneZeroScraper(options, f.runtime);
  expect(await scraper.prepareDesktopConnection()).toBeUndefined();
  expect(f.calls).toEqual([
    { operation: 'deviceToken', body: { extClientId: 'mobile', os: 'Android' }, authorization: undefined },
  ]);
  await expect(scraper.login(credentials)).resolves.toEqual({ success: true });
  expect(f.calls.map(call => call.operation)).toEqual([
    'deviceToken',
    'prepareOtp',
    'verifyOtp',
    'idToken',
    'sessionToken',
  ]);
  expect(f.calls[1].body.deviceToken).toBe(`deviceToken_${secret}`);
  await expect(scraper.login(credentials)).resolves.toEqual({ success: true });
  expect(f.calls.filter(call => call.operation === 'deviceToken')).toHaveLength(2);
  scraper.dispose();
  const fresh = fixture();
  const next = new OneZeroScraper(options, fresh.runtime);
  await next.prepareDesktopConnection();
  expect(fresh.calls.map(call => call.operation)).toEqual(['deviceToken']);
  next.dispose();
});

test('preparation failures are fixed, require a runtime, and never trigger OTP', async () => {
  await expect(new OneZeroScraper(options).prepareDesktopConnection()).rejects.toThrow('PROVIDER_UNAVAILABLE');
  for (const token of ['', '\r\n', 'x'.repeat(16_385), null]) {
    const calls: OneZeroOperation[] = [];
    const scraper = new OneZeroScraper(options, {
      signal: new AbortController().signal,
      request: async operation => {
        calls.push(operation);
        return { resultData: { deviceToken: token } };
      },
    });
    await expect(scraper.prepareDesktopConnection()).rejects.toThrow('PROVIDER_UNAVAILABLE');
    expect(calls).toEqual(['deviceToken']);
    scraper.dispose();
  }
  const request = jest.fn(async () => {
    throw new Error(secret);
  });
  const scraper = new OneZeroScraper(options, { signal: new AbortController().signal, request });
  await expect(scraper.prepareDesktopConnection()).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
  expect(request).toHaveBeenCalledTimes(1);
  scraper.dispose();
});

test('cancel, dispose and overlapping preparation cannot resurrect a late device token', async () => {
  for (const interrupt of ['cancel', 'dispose', 'prepare', 'login'] as const) {
    const f = fixture();
    const original = f.runtime.request.bind(f.runtime);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => {
      started = resolve;
    });
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });
    let deviceRequests = 0;
    f.runtime.request = async (operation, body, authorization, signal) => {
      if (operation === 'deviceToken' && ++deviceRequests === 1) {
        started();
        await blocked;
      }
      return original(operation, body, authorization, signal);
    };
    const scraper = new OneZeroScraper(options, f.runtime);
    const pending = scraper.prepareDesktopConnection();
    const rejected = expect(pending).rejects.toThrow('PROVIDER_UNAVAILABLE');
    await ready;
    if (interrupt === 'cancel') f.signal.abort();
    else if (interrupt === 'dispose') scraper.dispose();
    else if (interrupt === 'prepare')
      await expect(scraper.prepareDesktopConnection()).rejects.toThrow('PROVIDER_UNAVAILABLE');
    else await expect(scraper.login(credentials)).rejects.toThrow('PROVIDER_UNAVAILABLE');
    release();
    await rejected;
    expect(f.calls.map(call => call.operation)).toEqual(['deviceToken']);
    if (interrupt === 'prepare' || interrupt === 'login') {
      await expect(scraper.login(credentials)).resolves.toEqual({ success: true });
      expect(deviceRequests).toBe(2);
      expect(f.calls.map(call => call.operation)).toEqual([
        'deviceToken',
        'deviceToken',
        'prepareOtp',
        'verifyOtp',
        'idToken',
        'sessionToken',
      ]);
    } else {
      await expect(scraper.login(credentials)).rejects.toThrow('PROVIDER_UNAVAILABLE');
      expect(deviceRequests).toBe(1);
    }
    scraper.dispose();
  }
});

test('failed login clears an unused prepared token before a later attempt', async () => {
  const f = fixture();
  const scraper = new OneZeroScraper(options, f.runtime);
  await scraper.prepareDesktopConnection();
  await expect(
    scraper.login({ email: credentials.email, password: secret, otpLongTermToken: secret }),
  ).resolves.toMatchObject({ success: false });
  await expect(scraper.login(credentials)).resolves.toEqual({ success: true });
  expect(f.calls.filter(call => call.operation === 'deviceToken')).toHaveLength(2);
  scraper.dispose();
});
