/* Synthetic page only. No credentials, real bank sessions or raw response logs. */
/* eslint-disable @typescript-eslint/require-await */
import { type Page } from 'puppeteer';
import { TransactionStatuses } from '../transactions';
import { fetchIsracardWebTransactions, IsracardWebError } from './isracard-web';
const limits = { from: '2026-10-01', to: '2026-10-22', maxAccounts: 20, maxRows: 5000 };
const card = { cardSuffix: '1234', companyCode: '11', isActive: true, isPartner: false, serviceType: '1' };
const row = {
  seqVoucherNumber: '000001234',
  purchaseDate: '01/10/2026',
  billingAmount: 12.34,
  billingAmountCurrency: 0,
  businessName: 'SYNTHETIC_PRIVATE_SHOP',
  numberOfInstallment: 0,
  currentInstallmentNum: 0,
};
type Options = {
  cards?: unknown;
  bill?: string;
  monthly?: unknown;
  status?: number;
  data?: unknown;
  wrap?: (value: unknown, operation: string) => unknown;
};
function fixture(rows: unknown[] = [row], options: Options = {}) {
  const page = {
    evaluate: jest.fn(async (_fn: unknown, url: string, body: unknown) => {
      if (options.status) return { ok: false, httpStatus: options.status };
      const name = new URL(url).pathname.split('/').pop()!;
      const id = (body as { cards?: Array<{ cardSuffix: string }> }).cards?.[0].cardSuffix ?? '1234';
      const data =
        name === 'GetCardList'
          ? { cardsList: options.cards ?? [card] }
          : name === 'GetMonthlyBilling'
            ? { cards: { [id]: { billingDate: options.bill ?? '20/10/2026' } } }
            : (options.data ?? {
                approvals: { approvedTransactions: [{}] },
                israelAbroadVouchers: {
                  vouchers: {
                    totalForStatement: { isMonthlyPayment: options.monthly ?? false },
                    israelAbroadVouchersList: rows,
                    informativeOnlyVouchers: [],
                  },
                },
              });
      return {
        ok: true,
        httpStatus: 200,
        data: options.wrap ? options.wrap(data, name) : JSON.stringify({ isSuccess: true, errorCode: 0, data }),
      };
    }),
  };
  return { page, run: () => fetchIsracardWebTransactions(page as unknown as Page, limits) };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-10-23T12:00:00Z'));
});
afterEach(() => jest.useRealTimers());
test('collects the period before mapping actual dates, refunds, installments and unavailable original details', async () => {
  const f = fixture([
    row,
    { ...row, seqVoucherNumber: '2', billingAmount: -5 },
    { ...row, seqVoucherNumber: '3', numberOfInstallment: 4, currentInstallmentNum: 2 },
  ]);
  const result = await f.run(),
    posted = result.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed);
  expect(posted).toMatchObject([
    { identifier: '000001234', chargedAmount: -12.34, processedDate: '2026-10-20T00:00:00.000Z' },
    { chargedAmount: 5 },
    { installments: { number: 2, total: 4 } },
  ]);
  expect(posted[0]).not.toHaveProperty('originalAmount');
  expect(posted[0]).not.toHaveProperty('originalCurrency');
  expect(f.page.evaluate.mock.calls.map(c => new URL(c[1]).pathname.split('/').pop())).toEqual([
    'GetCardList',
    'GetMonthlyBilling',
    'GetTransactionsList',
  ]);
  expect(f.page.evaluate.mock.calls.every(c => new URL(c[1]).origin === 'https://web.isracard.co.il')).toBe(true);
  expect(f.page.evaluate.mock.calls[1][2]).toMatchObject({ billingDate: '10/2026' });
  expect(f.page.evaluate.mock.calls[2][2]).toMatchObject({ billingMonth: '01/10/2026', isNextBillingDate: false });
  expect(result.compatibility).toHaveLength(24);
  expect(JSON.stringify(result.compatibility)).not.toMatch(/SYNTHETIC_PRIVATE_SHOP|000001234|12\.34/);
});
test('accepts encoded/direct/Pascal-case wrappers, success primitives and neutral error codes for every endpoint', async () => {
  for (const wrap of [
    (data: unknown) => data,
    (data: unknown) => JSON.stringify(JSON.stringify({ IsSuccess: 1, ErrorCode: '0', Data: data })),
    (data: unknown) => ({ Response: { Result: JSON.stringify({ Success: 'true', Data: data }) } }),
  ]) {
    const r = await fixture([row], { wrap }).run();
    expect(r.accounts[0].txns.some(t => t.status === TransactionStatuses.Completed)).toBe(true);
  }
  const cardVariant = { CardSuffix: '****1234', CompanyCode: 11, IsActive: 1 };
  const r = await fixture(
    [
      {
        SeqVoucherNumber: '0012',
        PurchaseDate: '2026-10-01T00:00:00.0000000',
        BillingAmount: '1,234.50',
        BillingAmountCurrency: 'ILS',
        BusinessName: 'Synthetic shop',
      },
    ],
    { cards: [cardVariant], bill: '2026-10-20' },
  ).run();
  expect(r.accounts[0].txns.find(t => t.status === TransactionStatuses.Completed)?.chargedAmount).toBe(-1234.5);
});
test('bad rows are quarantined without blocking other verified records or losing the session profile', async () => {
  const patches = [
    { billingAmount: 12.345 },
    { seqVoucherNumber: 9007199254740992 },
    { purchaseDate: '30/02/2026' },
    { currentInstallmentNum: 5, numberOfInstallment: 4 },
    { billingAmountCurrency: 'UNKNOWN_PRIVATE_CURRENCY' },
  ];
  const f = fixture([row, ...patches.map((p, i) => ({ ...row, seqVoucherNumber: String(i + 2), ...p }))]);
  const r = await f.run();
  expect(f.page.evaluate).toHaveBeenCalledTimes(3);
  expect(r.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed)).toHaveLength(1);
  expect(r.accounts[0].txns.filter(t => t.status === TransactionStatuses.Pending)).toHaveLength(patches.length + 1);
  expect(JSON.stringify(r.compatibility)).not.toMatch(/SYNTHETIC_PRIVATE|UNKNOWN_PRIVATE|9007199254740992|12\.345/);
});
test('optional flags are tolerated while actual pending/revolving and critical bank failures remain unimportable', async () => {
  const r = await fixture([
    { ...row, isPending: false, isCancelled: null },
    { ...row, seqVoucherNumber: '2', isPending: true },
  ]).run();
  expect(r.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed)).toHaveLength(1);
  for (const opts of [
    { monthly: true },
    {
      wrap: (data: unknown, name: string) => ({
        isSuccess: true,
        errorCode: name === 'GetTransactionsList' ? '11' : 0,
        data,
      }),
    },
  ])
    expect(
      (await fixture([row], opts).run()).accounts[0].txns.every(t => t.status === TransactionStatuses.Pending),
    ).toBe(true);
  const explicitFalse = fixture([row], { wrap: data => ({ isSuccess: false, data }) });
  await expect(explicitFalse.run()).rejects.toMatchObject({
    diagnostic: { stage: 'cardListRequest', httpStatus: 200 },
  });
  expect(explicitFalse.page.evaluate).toHaveBeenCalledTimes(1);
});
test('ambiguous account suffixes are never assigned to another card and HTML responses reveal only safe types', async () => {
  await expect(fixture([row], { cards: [card, card] }).run()).rejects.toMatchObject({
    diagnostic: { stage: 'cardListValidation' },
  });
  const r = await fixture([row], { cards: [card, card, { ...card, cardSuffix: '5678' }] }).run();
  expect(r.accounts.map(a => a.accountNumber)).toEqual(['5678']);
  expect(r.compatibility[0].kinds).toContain('ambiguous');
  try {
    await fixture([row], { wrap: () => '<html>SYNTHETIC_PRIVATE_LOGIN</html>' }).run();
    throw new Error('must fail');
  } catch (error) {
    expect(error).toBeInstanceOf(IsracardWebError);
    const d = (error as IsracardWebError).diagnostic;
    expect(d.compatibility?.find(e => e.field === 'responseBody')?.kinds).toEqual(['html']);
    expect(JSON.stringify(d)).not.toContain('SYNTHETIC_PRIVATE_LOGIN');
  }
});
test('currency labels never imply exchange conversions, and verified original details remain optional', async () => {
  const r = await fixture([
    { ...row, billingAmount: '12.30', originalCurrency: 19 },
    { ...row, seqVoucherNumber: '2', billingAmountCurrency: 19 },
    { ...row, seqVoucherNumber: '3', originalCurrency: 19, originalAmount: '3.21' },
  ]).run();
  const rows = r.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed);
  expect(rows[0]).not.toHaveProperty('originalCurrency');
  expect(rows[1].chargedCurrency).toBe('USD');
  expect(rows[2]).toMatchObject({ originalCurrency: 'USD', originalAmount: -3.21 });
});
test('same-day, missing settlement and unlabelled generic transaction arrays cannot become posted transactions', async () => {
  const f = fixture([row], { bill: '23/10/2026' });
  const same = await fetchIsracardWebTransactions(f.page as unknown as Page, { ...limits, to: '2026-10-23' });
  expect(same.accounts[0].txns.every(t => t.status === TransactionStatuses.Pending)).toBe(true);
  for (const opts of [{ bill: 'not-a-date' }, { data: { transactions: [row] } }]) {
    const f = fixture([row], opts);
    const r = await f.run();
    expect(f.page.evaluate).toHaveBeenCalledTimes(3);
    expect(r.accounts[0].txns.every(t => t.status === TransactionStatuses.Pending)).toBe(true);
  }
});
test('HTTP and row limits still stop collection without leaking source values', async () => {
  await expect(fixture([row], { status: 403 }).run()).rejects.toMatchObject({
    diagnostic: { stage: 'cardListRequest', httpStatus: 403 },
  });
  const f = fixture([row, row]);
  await expect(
    fetchIsracardWebTransactions(f.page as unknown as Page, { ...limits, maxRows: 2 }),
  ).rejects.toBeInstanceOf(IsracardWebError);
});

function debitData(rows: unknown[], date: unknown = '21/10/2026', extra: Record<string, unknown> = {}) {
  return {
    israelAbroadVouchers: {
      vouchers: { totalForStatement: { isMonthlyPayment: false }, israelAbroadVouchersList: [] as unknown[] },
      outOfStatementChargeDateVouchers: [
        { totalVouchersCurrencyDate: { dateImmediateVouchers: date, ...extra }, immediateVouchersCurrencyDate: rows },
      ],
    },
  };
}
test('seventeen debit vouchers use actual immediate processing dates rather than a future monthly statement', async () => {
  const rows = Array.from({ length: 17 }, (_, i) => ({
    ...row,
    seqVoucherNumber: String(i + 1),
    numberOfInstallment: null,
    currentInstallmentNum: null,
  }));
  const r = await fixture([], { bill: '20/11/2026', data: debitData(rows) }).run();
  expect(r.accounts[0].txns).toHaveLength(17);
  expect(
    r.accounts[0].txns.every(
      t => t.status === TransactionStatuses.Completed && t.processedDate === '2026-10-21T00:00:00.000Z',
    ),
  ).toBe(true);
  expect(r.accounts[0].txns[0]).toMatchObject({ settlement: 'immediate', chargedCurrency: 'ILS' });
  expect(r.compatibility.find(e => e.field === 'reviewChecks')?.kinds).toEqual(['immediate', 'posted']);
});
test('explicit code or currency symbol wins; absent currency defaults to ILS and unknown or conflicting explicit currency never does', async () => {
  const cases = [
    { billingAmountCurrency: undefined, billingAmountCurrencySymbol: '₪' },
    { billingAmountCurrency: null },
    { billingAmountCurrency: undefined, billingAmountCurrencySymbol: '$' },
    { billingAmountCurrency: 100, billingAmountCurrencySymbol: '€' },
    { billingAmountCurrency: 19, billingAmountCurrencySymbol: '₪' },
    { billingAmountCurrency: 999 },
    { billingAmountCurrency: 999, billingAmountCurrencySymbol: '₪' },
  ];
  const r = await fixture(cases.map((c, i) => ({ ...row, seqVoucherNumber: String(i + 1), ...c }))).run();
  const posted = r.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed);
  expect(posted.map(t => t.chargedCurrency)).toEqual(['ILS', 'ILS', 'USD', 'EUR', 'ILS']);
  expect(r.compatibility.find(e => e.field === 'reviewChecks')?.kinds).toEqual(
    expect.arrayContaining(['currencyAssumedILS', 'invalidCurrency', 'explicitForeignCurrency']),
  );
  const foreign = await fixture([], {
    data: debitData([{ ...row, billingAmountCurrency: undefined }], undefined, {
      currencySymbolImmediateVouchers: '$',
    }),
  }).run();
  expect(foreign.accounts[0].txns[0].chargedCurrency).toBe('USD');
});
test('immediate groups admit todays actual charges but never approvals, missing dates or future processing', async () => {
  const f = fixture([], { bill: '20/11/2026', data: debitData([row], '23/10/2026') });
  const r = await fetchIsracardWebTransactions(f.page as unknown as Page, { ...limits, to: '2026-10-23' });
  expect(r.accounts[0].txns[0]).toMatchObject({
    status: TransactionStatuses.Completed,
    settlement: 'immediate',
    processedDate: '2026-10-23T00:00:00.000Z',
  });
  for (const date of ['bad-date', null, '24/10/2026']) {
    const r = await fixture([], { data: debitData([row], date) }).run();
    expect(r.accounts[0].txns.every(t => t.status === TransactionStatuses.Pending)).toBe(true);
    expect(r.compatibility.find(e => e.field === 'reviewChecks')?.kinds).toContain(
      date === '24/10/2026' ? 'futureCharge' : 'missingChargeDate',
    );
  }
});
test('immediate vouchers repeated in a monthly list or response are not imported twice and totals are not transactions', async () => {
  const data = debitData([row, row]);
  data.israelAbroadVouchers.vouchers.israelAbroadVouchersList = [row] as unknown[];
  const r = await fixture([], { data }).run();
  expect(r.accounts[0].txns).toHaveLength(1);
  expect(r.accounts[0].txns[0].processedDate).toBe('2026-10-21T00:00:00.000Z');
  const conflict = await fixture([], { data: debitData([row, { ...row, billingAmount: 99 }]) }).run();
  expect(conflict.accounts[0].txns.every(t => t.status === TransactionStatuses.Pending)).toBe(true);
  expect(conflict.compatibility.find(e => e.field === 'reviewChecks')?.kinds).toContain('conflictingDuplicate');
});
