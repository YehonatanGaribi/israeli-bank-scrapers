/* Synthetic page only; never credentials, real bank sessions or raw logs. */
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
function fixture(
  rows: unknown[] = [row],
  options: {
    cards?: unknown;
    bill?: string;
    monthly?: unknown;
    status?: number;
    data?: unknown;
    partial?: boolean;
  } = {},
) {
  const page = {
    evaluate: jest.fn(async (_fn: unknown, url: string, body: unknown) => {
      void body;
      if (options.status) return { ok: false, httpStatus: options.status };
      const path = new URL(url).pathname;
      const data = path.endsWith('/GetCardList')
        ? { cardsList: options.cards ?? [card] }
        : path.endsWith('/GetMonthlyBilling')
          ? { cards: { '1234': { billingDate: options.bill ?? '20/10/2026' } } }
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
        data: { isSuccess: true, errorCode: options.partial ? 'PARTIAL_PRIVATE_ERROR' : null, data },
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
test('new site uses exact local endpoints, actual billing dates, refunds and installment metadata', async () => {
  const f = fixture([
    row,
    { ...row, seqVoucherNumber: '000001235', billingAmount: -5 },
    { ...row, seqVoucherNumber: '000001236', numberOfInstallment: 4, currentInstallmentNum: 2 },
  ]);
  const result = await f.run();
  expect(result.accounts[0].accountNumber).toBe('1234');
  const posted = result.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed);
  expect(posted).toMatchObject([
    {
      identifier: '000001234',
      chargedAmount: -12.34,
      chargedCurrency: 'ILS',
      processedDate: '2026-10-20T00:00:00.000Z',
    },
    { chargedAmount: 5 },
    { installments: { number: 2, total: 4 } },
  ]);
  expect(posted[0]).not.toHaveProperty('originalAmount');
  expect(posted[0]).not.toHaveProperty('originalCurrency');
  expect(result.accounts[0].txns.filter(t => t.status === TransactionStatuses.Pending)).toHaveLength(1);
  expect(f.page.evaluate.mock.calls.map(c => new URL(c[1]).pathname)).toEqual([
    '/ocp/transactions/DigitalV3.Transactions/GetCardList',
    '/ocp/transactions/DigitalV3.Transactions/GetMonthlyBilling',
    '/ocp/transactions/DigitalV3.Transactions/GetTransactionsList',
  ]);
  expect(f.page.evaluate.mock.calls.every(c => new URL(c[1]).origin === 'https://web.isracard.co.il')).toBe(true);
  expect(f.page.evaluate.mock.calls[1][2]).toEqual({
    cards: [{ cardStatus: 0, cardSuffix: '1234', companyCode: 11, serviceType: 1, isPartner: false }],
    billingDate: '10/2026',
  });
  expect(f.page.evaluate.mock.calls[2][2]).toEqual({
    card4Number: '1234',
    isNextBillingDate: false,
    cardStatus: 0,
    billingMonth: '01/10/2026',
    companyCode: 11,
    isPartner: false,
  });
});
test('bank currency codes are not exchange conversions and original details are copied only when supplied', async () => {
  const r = await fixture([
    { ...row, billingAmount: '12.30', originalCurrency: 19 },
    { ...row, seqVoucherNumber: '2', billingAmountCurrency: 19 },
    { ...row, seqVoucherNumber: '3', originalCurrency: 19, originalAmount: '3.21' },
  ]).run();
  const rows = r.accounts[0].txns.filter(t => t.status === TransactionStatuses.Completed);
  expect(rows[0].chargedAmount).toBe(-12.3);
  expect(rows[0]).not.toHaveProperty('originalCurrency');
  expect(rows[1].chargedCurrency).toBe('USD');
  expect(rows[2]).toMatchObject({ originalCurrency: 'USD', originalAmount: -3.21 });
});
test('revolving payment and same-day billing stay pending; dates outside requested billing window are not fetched', async () => {
  const sameDay = fixture([row], { bill: '23/10/2026' });
  const sameDayResult = await fetchIsracardWebTransactions(sameDay.page as unknown as Page, {
    ...limits,
    to: '2026-10-23',
  });
  expect(sameDayResult.accounts[0].txns.every(t => t.status === TransactionStatuses.Pending)).toBe(true);
  for (const opts of [{ monthly: true }, { bill: '23/10/2026' }]) {
    const f = fixture([row], opts);
    if (opts.bill) {
      const r = await f.run();
      expect(r.accounts[0].txns).toEqual([]);
      expect(f.page.evaluate).toHaveBeenCalledTimes(2);
    } else expect((await f.run()).accounts[0].txns.every(t => t.status === TransactionStatuses.Pending)).toBe(true);
  }
});
test('ambiguous account suffixes, malformed groups and partial responses fail closed', async () => {
  for (const opts of [
    { cards: [card, card] },
    { data: { unknown: 'PRIVATE_VALUE' } },
    { data: { israelAbroadVouchers: 'PRIVATE_VALUE' } },
    { partial: true },
    { bill: '20/09/2026' },
  ])
    await expect(fixture([row], opts).run()).rejects.toBeInstanceOf(IsracardWebError);
});
test('unrecognized posted values return only fixed shape diagnostics', async () => {
  for (const patch of [
    { billingAmount: 12.345 },
    { seqVoucherNumber: 9007199254740992 },
    { purchaseDate: '30/02/2026' },
    { currentInstallmentNum: 5, numberOfInstallment: 4 },
    { billingAmountCurrency: 'UNKNOWN_PRIVATE_CURRENCY' },
  ]) {
    try {
      await fixture([{ ...row, ...patch }]).run();
      throw new Error('must fail');
    } catch (error) {
      expect(error).toBeInstanceOf(IsracardWebError);
      const report = JSON.stringify((error as IsracardWebError).diagnostic);
      expect(report).not.toMatch(/SYNTHETIC_PRIVATE_SHOP|000001234|UNKNOWN_PRIVATE_CURRENCY|12\.345/);
      expect((error as IsracardWebError).diagnostic.compatibility).toHaveLength(16);
    }
  }
});
test('HTTP failure reports a bounded status and budgets cover pending and posted rows', async () => {
  await expect(fixture([row], { status: 403 }).run()).rejects.toMatchObject({
    diagnostic: { stage: 'cardListRequest', httpStatus: 403 },
  });
  const f = fixture([row, row]);
  await expect(
    fetchIsracardWebTransactions(f.page as unknown as Page, { ...limits, maxRows: 2 }),
  ).rejects.toBeInstanceOf(IsracardWebError);
});
