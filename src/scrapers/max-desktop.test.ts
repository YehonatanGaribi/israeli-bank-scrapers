/* Synthetic browser methods deliberately perform no bank I/O. */
import { type Page } from 'puppeteer';
import { CompanyTypes } from '../definitions';
import { MaxDesktopError, MaxScraper, type MaxDesktopStage } from './max';

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
  responses.forEach(response => evaluate.mockResolvedValueOnce({ ok: true, httpStatus: 200, data: response }));
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
      ok: true,
      httpStatus: 200,
      data: { result: { transactions: [] } },
    });
    expect(fetchSpy.mock.calls[0][1]).toMatchObject({ credentials: 'include', redirect: 'error' });
    for (const [response, stage, httpStatus] of [
      [new Response('private response', { status: 403 }), 'transactionsRequest', 403],
      [new Response('{}', { headers: { 'content-type': 'text/html' } }), 'transactionsResponse', 200],
      [
        new Response('private response body', { headers: { 'content-type': 'application/json' } }),
        'transactionsResponse',
        200,
      ],
    ] as const) {
      fetchSpy.mockResolvedValueOnce(response);
      await expect(fetchInPage('https://onlinelcapi.max.co.il/test', 4)).resolves.toEqual({
        ok: false,
        stage,
        reason: 'UNAVAILABLE',
        httpStatus,
      });
    }
    fetchSpy.mockClear();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: { origin: 'https://evil.example', pathname: '/homepage/personal' },
    });
    await expect(fetchInPage('https://onlinelcapi.max.co.il/test', 100)).resolves.toEqual({
      ok: false,
      stage: 'transactionsRequest',
      reason: 'UNAVAILABLE',
      httpStatus: null,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test('Max desktop skips documented summary rows while budgeting every raw row and rejecting invalid row shapes', async () => {
  const summaries = [
    {},
    { planName: undefined },
    { planName: null },
    { planName: '' },
    { planName: false },
    { planName: 0 },
  ];
  const { scraper } = fixture([{ result: { transactions: [summaries[0], row, ...summaries.slice(1)] } }]);
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts).toHaveLength(1);
  expect(result.accounts[0].txns).toHaveLength(1);
  expect(result.accounts[0].txns[0].identifier).toBe('stable-reference');

  const bounded = fixture([{ result: { transactions: [row, {}] } }]);
  await expect(bounded.scraper.fetchDesktopTransactions({ ...limits, maxRows: 1 })).rejects.toThrow(
    'PROVIDER_UNAVAILABLE',
  );
  const cumulative = fixture([{ result: { transactions: [{}] } }, { result: { transactions: [{}, row] } }]);
  await expect(
    cumulative.scraper.fetchDesktopTransactions({ ...limits, to: '2026-11-01', maxRows: 2 }),
  ).rejects.toThrow('PROVIDER_UNAVAILABLE');
  for (const invalid of [null, [], '', 0, false]) {
    const invalidRows = fixture([{ result: { transactions: [invalid, row] } }]);
    await expect(invalidRows.scraper.fetchDesktopTransactions(limits)).rejects.toThrow('PROVIDER_UNAVAILABLE');
  }
});

test.each([
  [{ purchaseDate: 'private invalid date' }, 'transactionPurchaseDate'],
  [{ purchaseDate: '2026-99-99' }, 'transactionPurchaseDate'],
  [{ paymentDate: '2026-09-01' }, 'transactionDateOrder'],
  [{ actualPaymentAmount: 'private invalid amount' }, 'transactionAmounts'],
  [{ originalAmount: Infinity }, 'transactionAmounts'],
  [{ originalCurrency: 'private invalid currency' }, 'transactionAmounts'],
  [{ shortCardNumber: 'private invalid card' }, 'transactionMetadata'],
  [{ planName: 'private unknown plan', planTypeId: 99 }, 'transactionMetadata'],
  [{ comments: null }, 'transactionMetadata'],
  [{ planName: 'תשלומים', planTypeId: 2, comments: 'private invalid installments' }, 'transactionMetadata'],
  [{ dealData: { arn: 'private invalid reference' } }, 'transactionReference'],
] as const)(
  'Max desktop classifies invalid transaction fields with only fixed diagnostics: %s',
  async (patch, stage) => {
    const { scraper } = fixture([{ result: { transactions: [{ ...row, ...patch }] } }]);
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject({
      message: 'PROVIDER_UNAVAILABLE',
      stage,
      reason: 'UNAVAILABLE',
      httpStatus: 200,
      diagnostic: { stage, reason: 'UNAVAILABLE', httpStatus: 200 },
    });
    try {
      await fixture([{ result: { transactions: [{ ...row, ...patch }] } }]).scraper.fetchDesktopTransactions(limits);
    } catch (error) {
      expect(error).toBeInstanceOf(MaxDesktopError);
      expect(JSON.stringify(error)).not.toMatch(/private|Secret|Synthetic|stable-reference|1234/);
      expect(error).not.toHaveProperty('cause');
    }
  },
);

test('Max desktop validates the untrusted browser diagnostic envelope without reflecting arbitrary fields', async () => {
  for (const envelope of [
    null,
    [],
    {},
    { ok: true, httpStatus: '200', data: {} },
    { ok: true, httpStatus: 200, data: {}, secret: 'private response' },
    { ok: false, stage: 'private stage', reason: 'UNAVAILABLE', httpStatus: 503 },
    { ok: false, stage: 'transactionsRequest', reason: 'private reason', httpStatus: 503 },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: '503' },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: 99 },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: 600 },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: 503.5 },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: Infinity },
    { ok: false, stage: 'transactionsResponse', reason: 'UNAVAILABLE', httpStatus: 503 },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: 200 },
    { ok: false, stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: 503, cause: 'private response' },
  ]) {
    const { scraper, evaluate } = fixture();
    evaluate.mockReset().mockResolvedValue(envelope);
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject({
      message: 'PROVIDER_UNAVAILABLE',
      diagnostic: { stage: 'transactionsResponse', reason: 'UNAVAILABLE', httpStatus: null },
    });
  }
  for (const data of [null, [], {}, { result: [] }, { result: {} }, { result: { transactions: 'private payload' } }]) {
    await expect(fixture([data]).scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject({
      diagnostic: { stage: 'transactionsResponse', reason: 'UNAVAILABLE', httpStatus: 200 },
    });
  }
});

test('Max desktop errors expose immutable finite diagnostics and no raw cause', () => {
  const error = new MaxDesktopError('transactionsRequest', 503);
  expect(error.message).toBe('PROVIDER_UNAVAILABLE');
  expect(error.diagnostic).toEqual({ stage: 'transactionsRequest', reason: 'UNAVAILABLE', httpStatus: 503 });
  expect(Object.isFrozen(error)).toBe(true);
  expect(Object.isFrozen(error.diagnostic)).toBe(true);
  for (const invalid of [NaN, Infinity, 503.5, 0, 600]) {
    expect(new MaxDesktopError('transactionsRequest', invalid).httpStatus).toBeNull();
  }
  expect(new MaxDesktopError('private stage' as MaxDesktopStage).stage).toBe('transactionsValidation');
});

test('Max desktop executes the bounded browser fetch and preserves only actual HTTP statuses and fixed stages', async () => {
  const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'https://www.max.co.il', pathname: '/homepage/personal' },
  });
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  const { scraper, evaluate } = fixture();
  evaluate
    .mockReset()
    .mockImplementation((fn: (url: string, maxBytes: number) => Promise<unknown>, url: string, maxBytes: number) =>
      fn(url, maxBytes),
    );
  const expected = (stage: MaxDesktopStage, httpStatus: number | null) => ({
    message: 'PROVIDER_UNAVAILABLE',
    diagnostic: { stage, reason: 'UNAVAILABLE', httpStatus },
  });
  try {
    const denied = new Response('private bank response containing credentials', { status: 503 });
    const deniedReader = jest.spyOn(denied.body!, 'getReader');
    fetchSpy.mockResolvedValueOnce(denied);
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject(expected('transactionsRequest', 503));
    expect(deniedReader).not.toHaveBeenCalled();

    fetchSpy.mockRejectedValueOnce(new Error('private network error with credentials'));
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject(expected('transactionsRequest', null));

    for (const response of [
      new Response('private html', { headers: { 'content-type': 'text/html' } }),
      new Response('private invalid json containing credentials', { headers: { 'content-type': 'application/json' } }),
      new Response(null, { headers: { 'content-type': 'application/json' } }),
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('private stream error'));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
      new Response(JSON.stringify({ private: 'invalid envelope' }), {
        headers: { 'content-type': 'application/json' },
      }),
    ]) {
      fetchSpy.mockResolvedValueOnce(response);
      await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject(
        expected('transactionsResponse', 200),
      );
    }
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { transactions: [row] } }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(scraper.fetchDesktopTransactions(limits)).resolves.toMatchObject({ success: true });
    evaluate.mockReset().mockRejectedValue(new Error('private page evaluation error with credentials'));
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject(expected('transactionsRequest', null));
  } finally {
    fetchSpy.mockRestore();
    if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  }
});

test.each([
  ['2026-09-20T00:00:00', '2026-10-02T00:00:00'],
  ['2026-09-20T12:34:56.1234567', '2026-10-02T23:59:59.0000000'],
  ['2026-09-20T12:34:56.1', '2026-10-02T23:59:59.123456789'],
  ['2026-09-20T23:30:00-03:00', '2026-10-02T00:30:00+03:00'],
  ['2026-09-20T23:30:00.1234567-12:00', '2026-10-02T00:30:00.1234567+14:00'],
  ['2026-09-20', '2026-10-02'],
])('Max desktop preserves written calendar dates for strict ISO forms: %s / %s', async (purchaseDate, paymentDate) => {
  const { scraper } = fixture([{ result: { transactions: [{ ...row, purchaseDate, paymentDate }] } }]);
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts[0].txns[0]).toMatchObject({
    date: '2026-09-20T00:00:00.000Z',
    processedDate: '2026-10-02T00:00:00.000Z',
  });
});

test('Max desktop accepts leap days and timezone-less DST gap times without interpreting the host timezone', async () => {
  for (const [purchaseDate, paymentDate, day] of [
    ['2024-02-29T23:59:59.1234567', '2024-02-29T23:59:59', '2024-02-29'],
    ['2026-03-08T02:30:00', '2026-03-08T02:30:00.0000000', '2026-03-08'],
  ]) {
    const { scraper } = fixture([{ result: { transactions: [{ ...row, purchaseDate, paymentDate }] } }]);
    const result = await scraper.fetchDesktopTransactions({ ...limits, from: day, to: day });
    expect(result.accounts[0].txns[0]).toMatchObject({
      date: `${day}T00:00:00.000Z`,
      processedDate: `${day}T00:00:00.000Z`,
    });
  }
});

test.each([
  '2026-02-29T00:00:00',
  '2026-04-31T00:00:00.1234567',
  '2026-00-10T00:00:00',
  '2026-13-01T00:00:00',
  '2026-10-00T00:00:00',
  '2026-10-02T24:00:00',
  '2026-10-02T23:60:00',
  '2026-10-02T23:59:60',
  '2026-10-02T12:00:00+24:00',
  '2026-10-02T12:00:00-02:60',
  '2026-10-02T12:00:00+3:00',
  '2026-10-02T12:00:00.1234567890',
  '2026-10-02T12:00:00.',
  '2026-10-02T12:00',
  '2026-10-02 12:00:00',
  '02/10/2026',
  '2026-10-02Z',
  '2026-10-02T12:00:00Z private',
  '2026-10-02T12:00:00Z\n',
  '2026-10-02T12:00:00\r',
  1790899200000,
])('Max desktop rejects invalid or ambiguous purchase/payment dates: %s', async value => {
  for (const field of ['purchaseDate', 'paymentDate'] as const) {
    const { scraper } = fixture([{ result: { transactions: [{ ...row, [field]: value }] } }]);
    await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject({
      message: 'PROVIDER_UNAVAILABLE',
      diagnostic: {
        stage: field === 'purchaseDate' ? 'transactionPurchaseDate' : 'transactionPaymentDate',
        reason: 'UNAVAILABLE',
        httpStatus: 200,
      },
    });
  }
});

test('Max desktop keeps purchase before settlement validation on written calendar days', async () => {
  const { scraper } = fixture([
    {
      result: {
        transactions: [{ ...row, purchaseDate: '2026-10-03T00:30:00+14:00', paymentDate: '2026-10-02T23:30:00-12:00' }],
      },
    },
  ]);
  await expect(scraper.fetchDesktopTransactions(limits)).rejects.toMatchObject({
    message: 'PROVIDER_UNAVAILABLE',
    diagnostic: { stage: 'transactionDateOrder', reason: 'UNAVAILABLE', httpStatus: 200 },
  });
  expect(new MaxDesktopError('transactionDates', 200).stage).toBe('transactionDates');
});

const compatibilityFields = [
  'purchaseDate',
  'paymentDate',
  'actualPaymentAmount',
  'paymentCurrency',
  'originalCurrency',
  'originalAmount',
  'shortCardNumber',
  'planName',
  'planTypeId',
  'comments',
  'merchantName',
  'dealData',
  'arn',
] as const;

async function compatibilityFailure(rows: unknown[]) {
  try {
    await fixture([{ result: { transactions: rows } }]).scraper.fetchDesktopTransactions(limits);
  } catch (error) {
    if (error instanceof MaxDesktopError) return error;
  }
  throw new Error('Expected synthetic compatibility failure');
}

test('Max desktop reports every consumed field across the complete month before its first invalid row', async () => {
  const canary = 'PRIVATE_SYNTHETIC_CANARY_NOT_FOR_DIAGNOSTICS';
  const error = await compatibilityFailure([
    { ...row, actualPaymentAmount: 12.345, comments: '', privateUnknownKey: canary },
    {
      ...row,
      purchaseDate: '2026-09-21T00:00:00.0000000',
      paymentDate: null,
      actualPaymentAmount: '45.67',
      paymentCurrency: '376',
      originalCurrency: null,
      originalAmount: '45.67',
      shortCardNumber: 1234,
      planName: true,
      planTypeId: '5',
      comments: null,
      merchantName: { canary },
      dealData: { arn: 9876, canary },
    },
    { planName: '', purchaseDate: false, actualPaymentAmount: false, comments: canary },
    { planName: null, paymentCurrency: false },
  ]);
  expect(error.diagnostic).toEqual({
    stage: 'transactionAmounts',
    reason: 'UNAVAILABLE',
    httpStatus: 200,
    compatibility: [
      { field: 'purchaseDate', kinds: ['localTimestamp', 'zonedTimestamp'] },
      { field: 'paymentDate', kinds: ['null', 'zonedTimestamp'] },
      { field: 'actualPaymentAmount', kinds: ['decimalNumber', 'decimalString'] },
      { field: 'paymentCurrency', kinds: ['integerString', 'safeInteger'] },
      { field: 'originalCurrency', kinds: ['null', 'text'] },
      { field: 'originalAmount', kinds: ['decimalNumber', 'decimalString'] },
      { field: 'shortCardNumber', kinds: ['integerString', 'safeInteger'] },
      { field: 'planName', kinds: ['boolean', 'text'] },
      { field: 'planTypeId', kinds: ['integerString', 'safeInteger'] },
      { field: 'comments', kinds: ['emptyString', 'null'] },
      { field: 'merchantName', kinds: ['object', 'text'] },
      { field: 'dealData', kinds: ['object'] },
      { field: 'arn', kinds: ['safeInteger', 'text'] },
    ],
  });
  const encoded = JSON.stringify(error);
  expect(encoded).not.toMatch(
    /PRIVATE_SYNTHETIC|privateUnknownKey|Synthetic shop|1234|12\.34|45\.67|stable-reference|9876|376|canary/,
  );
  expect(error).not.toHaveProperty('cause');
  expect(encoded.length).toBeLessThan(8192);
});

test('Max desktop compatibility types remain finite, deduplicated and independent of input values or row order', async () => {
  const types = [
    undefined,
    null,
    false,
    7,
    12.34,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '123',
    '12.34',
    '',
    'PRIVATE_SYNTHETIC_TEXT',
    {},
    [],
    Symbol('PRIVATE_SYNTHETIC_SYMBOL'),
  ];
  const rows = types.map(comments => ({ ...row, actualPaymentAmount: 12.345, comments }));
  const forward = await compatibilityFailure(rows);
  const reverse = await compatibilityFailure([...rows].reverse());
  expect(forward.diagnostic.compatibility).toEqual(reverse.diagnostic.compatibility);
  expect(forward.diagnostic.compatibility?.find(entry => entry.field === 'comments')?.kinds).toEqual([
    'array',
    'boolean',
    'decimalNumber',
    'decimalString',
    'emptyString',
    'integerString',
    'missing',
    'null',
    'object',
    'safeInteger',
    'text',
    'unsafeNumber',
    'unsupported',
  ]);
  expect(JSON.stringify(forward)).not.toMatch(/PRIVATE_SYNTHETIC|12\.34|123|9007199254740992/);

  const dates = await compatibilityFailure([
    { ...row, purchaseDate: '2026-09-20', paymentDate: '2026-10-02T00:00:00.1234567', actualPaymentAmount: 12.34 },
    { ...row, purchaseDate: '2026-02-30', paymentDate: '2026-10-02T24:00:00' },
    { planName: 'PRIVATE_SYNTHETIC_PLAN', dealData: [] },
  ]);
  expect(dates.diagnostic.compatibility?.find(entry => entry.field === 'purchaseDate')?.kinds).toEqual([
    'date',
    'missing',
    'text',
  ]);
  expect(dates.diagnostic.compatibility?.find(entry => entry.field === 'paymentDate')?.kinds).toEqual([
    'localTimestamp',
    'missing',
    'text',
  ]);
  expect(dates.diagnostic.compatibility?.find(entry => entry.field === 'dealData')?.kinds).toEqual(['array', 'object']);
  expect(dates.diagnostic.compatibility?.find(entry => entry.field === 'arn')?.kinds).toEqual(['missing', 'text']);
});

test('Max desktop includes safe aggregate on malformed rows and card limits, with no eligible rows exposing empty kinds', async () => {
  const malformed = await compatibilityFailure([null, row]);
  expect(malformed.stage).toBe('transactionsValidation');
  expect(malformed.diagnostic.compatibility?.map(entry => entry.field)).toEqual(compatibilityFields);
  expect(malformed.diagnostic.compatibility?.every(entry => entry.kinds.length === 1)).toBe(true);
  const empty = await compatibilityFailure([null, { planName: '' }]);
  expect(empty.diagnostic.compatibility).toEqual(compatibilityFields.map(field => ({ field, kinds: [] })));
  const { scraper } = fixture([{ result: { transactions: [row, { ...row, shortCardNumber: '5678' }] } }]);
  await expect(scraper.fetchDesktopTransactions({ ...limits, maxAccounts: 1 })).rejects.toMatchObject({
    diagnostic: { stage: 'transactionsValidation', compatibility: malformed.diagnostic.compatibility },
  });
});

test('Max desktop sanitizes and freezes a copied compatibility profile and omits it from request/response errors', () => {
  const valid = compatibilityFields.map(field => ({ field, kinds: ['text'] }));
  const error = new MaxDesktopError('transactionAmounts', 200, valid);
  expect(error.diagnostic.compatibility).toEqual(valid);
  expect(Object.isFrozen(error.diagnostic.compatibility)).toBe(true);
  expect(Object.isFrozen(error.diagnostic.compatibility![0])).toBe(true);
  expect(Object.isFrozen(error.diagnostic.compatibility![0].kinds)).toBe(true);
  valid[0].kinds[0] = 'PRIVATE_MUTATION_CANARY';
  expect(error.diagnostic.compatibility![0].kinds).toEqual(['text']);
  const profile = compatibilityFields.map(field => ({ field, kinds: ['text'] }));
  for (const malformed of [
    null,
    {},
    [],
    profile.slice(1),
    [...profile, profile[0]],
    [...profile].reverse(),
    profile.map((entry, index) => (index ? entry : { ...entry, field: 'PRIVATE_FIELD_CANARY' })),
    profile.map((entry, index) => (index ? entry : { ...entry, kinds: ['PRIVATE_KIND_CANARY'] })),
    profile.map((entry, index) => (index ? entry : { ...entry, kinds: ['text', 'text'] })),
    profile.map((entry, index) => (index ? entry : { ...entry, kinds: ['text', 'null'] })),
    profile.map((entry, index) => (index ? entry : { ...entry, kinds: 'text' })),
    profile.map((entry, index) => (index ? entry : { ...entry, value: 'PRIVATE_VALUE_CANARY' })),
    profile.map((entry, index) =>
      index
        ? entry
        : {
            ...entry,
            get kinds() {
              throw new Error('PRIVATE_GETTER_CANARY');
            },
          },
    ),
  ]) {
    const sanitized = new MaxDesktopError('transactionAmounts', 200, malformed);
    expect(sanitized.diagnostic).not.toHaveProperty('compatibility');
    expect(JSON.stringify(sanitized)).not.toMatch(/PRIVATE_/);
  }
  for (const stage of ['transactionsRequest', 'transactionsResponse'] as const) {
    expect(new MaxDesktopError(stage, 200, profile).diagnostic).not.toHaveProperty('compatibility');
  }
  expect(new MaxDesktopError('transactionAmounts', null, profile).diagnostic).not.toHaveProperty('compatibility');
});

test('Max desktop compatibility diagnostics stay within the failure budget at the maximum finite profile size', () => {
  const kinds = [
    'array',
    'boolean',
    'date',
    'decimalNumber',
    'decimalString',
    'emptyString',
    'integerString',
    'localTimestamp',
    'missing',
    'null',
    'object',
    'safeInteger',
    'text',
    'unsafeNumber',
    'unsupported',
    'zonedTimestamp',
  ];
  const maximum = compatibilityFields.map(field => ({ field, kinds }));
  const error = new MaxDesktopError('transactionsValidation', 200, maximum);
  expect(error.diagnostic.compatibility).toHaveLength(13);
  expect(JSON.stringify(error).length).toBeLessThan(8192);
});

test('Max desktop imports the whole numeric-amount profile with local dates, refunds and installment identifiers', async () => {
  const liveProfileRow = {
    ...row,
    purchaseDate: '2026-09-20T00:00:00.0000000',
    paymentDate: '2026-10-02T00:00:00',
    actualPaymentAmount: 12.34,
    comments: '',
    dealData: { arn: '000123456789' },
  };
  const { scraper } = fixture([
    {
      result: {
        transactions: [
          liveProfileRow,
          {
            ...liveProfileRow,
            actualPaymentAmount: -5,
            originalAmount: -5,
            comments: 'Synthetic refund',
            dealData: { arn: '000123456790' },
          },
          {
            ...liveProfileRow,
            actualPaymentAmount: 23.45,
            originalAmount: 70.35,
            planName: 'תשלומים',
            planTypeId: 2,
            comments: 'תשלום 2 מתוך 3',
            dealData: { arn: '000123456791' },
          },
        ],
      },
    },
  ]);
  const result = await scraper.fetchDesktopTransactions(limits);
  expect(result.accounts[0].txns).toEqual([
    {
      type: 'normal',
      date: '2026-09-20T00:00:00.000Z',
      processedDate: '2026-10-02T00:00:00.000Z',
      originalAmount: -12.34,
      originalCurrency: 'ILS',
      chargedAmount: -12.34,
      chargedCurrency: 'ILS',
      description: 'Synthetic shop',
      status: 'completed',
      identifier: '000123456789',
    },
    {
      type: 'normal',
      date: '2026-09-20T00:00:00.000Z',
      processedDate: '2026-10-02T00:00:00.000Z',
      originalAmount: 5,
      originalCurrency: 'ILS',
      chargedAmount: 5,
      chargedCurrency: 'ILS',
      description: 'Synthetic shop',
      status: 'completed',
      identifier: '000123456790',
    },
    {
      type: 'installments',
      date: '2026-09-20T00:00:00.000Z',
      processedDate: '2026-10-02T00:00:00.000Z',
      originalAmount: -70.35,
      originalCurrency: 'ILS',
      chargedAmount: -23.45,
      chargedCurrency: 'ILS',
      description: 'Synthetic shop',
      status: 'completed',
      installments: { number: 2, total: 3 },
      identifier: '000123456791_2',
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/Secret memo|Synthetic refund|rawTransaction|comments|compatibility/);
});

test.each([
  [0, -0],
  [-0, 0],
  [5, -5],
  [-5, 5],
  [12.34, -12.34],
  [-12.34, 12.34],
  [0.29, -0.29],
  [0.01, -0.01],
  [1.1, -1.1],
  ['0', -0],
  ['-0', 0],
  ['12.34', -12.34],
  ['-12.34', 12.34],
  ['0.01', -0.01],
  ['1.10', -1.1],
  ['90071992547409', -90071992547409],
  ['90071992547409.90', -90071992547409.9],
] as const)(
  'Max desktop preserves exact supported numeric/string amount signs: %s',
  async (actualPaymentAmount, expected) => {
    const { scraper } = fixture([{ result: { transactions: [{ ...row, actualPaymentAmount }] } }]);
    const result = await scraper.fetchDesktopTransactions(limits);
    expect(result.accounts[0].txns[0].chargedAmount).toBe(expected);
  },
);

test.each([
  NaN,
  Infinity,
  -Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  12.345,
  1.005,
  0.1 + 0.2,
  1e-7,
  '90071992547409.91',
  '-90071992547409.91',
  '90071992547409.92',
  '99999999999999.99',
  '100000000000000',
  '12.345',
  '1e2',
  '1E2',
  '1e-2',
  '+12.34',
  '012.34',
  '.29',
  '12.',
  '12,34',
  '1,234.56',
  ' 12.34',
  '12.34 ',
  '12.34\n',
  '',
  'NaN',
  'Infinity',
  undefined,
  null,
  true,
  false,
  {},
  [],
  new Number(12.34),
])('Max desktop rejects noncanonical, imprecise or unsafe amounts without rounding: %s', async actualPaymentAmount => {
  const error = await compatibilityFailure([{ ...row, actualPaymentAmount }]);
  expect(error.diagnostic).toMatchObject({ stage: 'transactionAmounts', reason: 'UNAVAILABLE', httpStatus: 200 });
  expect(error.message).toBe('PROVIDER_UNAVAILABLE');
});

test('Max desktop rejects large JSON numbers whose source cents may collapse before validation', async () => {
  for (const literal of [
    '90071992547409.91',
    '-90071992547409.91',
    '70368744177664.01',
    '35184372088832',
    '-35184372088832',
  ]) {
    const actualPaymentAmount: number = JSON.parse(literal);
    const error = await compatibilityFailure([{ ...row, actualPaymentAmount }]);
    expect(error.diagnostic.stage).toBe('transactionAmounts');
  }
  // Below the numeric guard, cent-valued source tokens remain distinct.
  for (const literal of ['35184372088831.99', '-35184372088831.99', '1000000.01']) {
    const actualPaymentAmount: number = JSON.parse(literal);
    const result = await fixture([
      { result: { transactions: [{ ...row, actualPaymentAmount }] } },
    ]).scraper.fetchDesktopTransactions(limits);
    expect(result.accounts[0].txns[0].chargedAmount).toBe(-actualPaymentAmount);
  }
});
