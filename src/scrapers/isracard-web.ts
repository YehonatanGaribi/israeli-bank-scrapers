import moment from 'moment';
import { type Page } from 'puppeteer';
import { TransactionStatuses, TransactionTypes, type Transaction } from '../transactions';
import { type IsracardDesktopLimits } from './isracard';

const ROOT = 'https://web.isracard.co.il';
const API = `${ROOT}/ocp/transactions/DigitalV3.Transactions`;
type Value = Record<string, unknown>;
type WebTransaction = Omit<Transaction, 'originalAmount' | 'originalCurrency'> &
  Partial<Pick<Transaction, 'originalAmount' | 'originalCurrency'>>;
export interface IsracardWebResult {
  success: true;
  accounts: Array<{ accountNumber: string; txns: WebTransaction[] }>;
}
const fields = [
  'cardSuffix',
  'companyCode',
  'isActive',
  'isPartner',
  'serviceType',
  'billingDate',
  'seqVoucherNumber',
  'purchaseDate',
  'billingAmount',
  'billingAmountCurrency',
  'businessName',
  'numberOfInstallment',
  'currentInstallmentNum',
  'originalCurrency',
  'originalAmount',
  'isMonthlyPayment',
] as const;
const stages = [
  'cardListRequest',
  'cardListValidation',
  'billingRequest',
  'billingValidation',
  'transactionsRequest',
  'transactionsResponse',
  'transactionsValidation',
  'transactionDates',
  'transactionAmounts',
  'transactionMetadata',
  'transactionReference',
] as const;
type Stage = (typeof stages)[number];
type Kind =
  | 'missing'
  | 'null'
  | 'boolean'
  | 'safeInteger'
  | 'decimalNumber'
  | 'unsafeNumber'
  | 'integerString'
  | 'decimalString'
  | 'emptyString'
  | 'text'
  | 'date'
  | 'object'
  | 'array'
  | 'unsupported';
type Profile = Array<{ field: (typeof fields)[number]; kinds: Kind[] }>;
function object(value: unknown): value is Value {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function day(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(value)) return undefined;
  const parsed = moment.utc(value, ['DD/MM/YYYY', 'D/M/YYYY'], true);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : undefined;
}
function kind(value: unknown, field: (typeof fields)[number]): Kind {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number')
    return Number.isSafeInteger(value)
      ? 'safeInteger'
      : Number.isFinite(value) && !Number.isInteger(value)
        ? 'decimalNumber'
        : 'unsafeNumber';
  if (typeof value === 'string') {
    if (!value.length) return 'emptyString';
    if (['purchaseDate', 'billingDate'].includes(field) && day(value)) return 'date';
    if (/^-?\d+$/.test(value)) return 'integerString';
    if (/^-?\d+\.\d+$/.test(value)) return 'decimalString';
    return 'text';
  }
  return Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : 'unsupported';
}
function profile(values: Value[]): Profile {
  return fields.map(field => ({ field, kinds: [...new Set(values.map(value => kind(value[field], field)))].sort() }));
}
/** Fixed diagnostic only. Source values, errors and bank response text stay local. */
export class IsracardWebError extends Error {
  readonly diagnostic: Readonly<{
    stage: Stage;
    reason: 'UNAVAILABLE';
    httpStatus: number | null;
    compatibility?: Profile;
  }>;
  constructor(stage: Stage, httpStatus: number | null = null, values?: Value[]) {
    super('PROVIDER_UNAVAILABLE');
    const safeStage = (stages as readonly string[]).includes(stage) ? stage : 'transactionsValidation';
    this.diagnostic = Object.freeze({
      stage: safeStage,
      reason: 'UNAVAILABLE',
      httpStatus,
      ...(httpStatus === 200 && values ? { compatibility: profile(values) } : {}),
    });
  }
}
function minor(text: string): bigint | undefined {
  const match = /^(-?)(0|[1-9]\d{0,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const result = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] ? -result : result;
}
function amount(value: unknown): number | undefined {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) >= 2 ** 45)) return undefined;
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
  if (text === undefined) return undefined;
  const cents = minor(text),
    limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (cents === undefined || cents < -limit || cents > limit) return undefined;
  const result = Number(text);
  return minor(String(result)) === cents ? result : undefined;
}
function integer(value: unknown): number | undefined {
  const result = typeof value === 'string' && /^\d{1,4}$/.test(value) ? Number(value) : value;
  return typeof result === 'number' && Number.isSafeInteger(result) && result >= 0 && result <= 9999
    ? result
    : undefined;
}
function currency(value: unknown): string | undefined {
  // Codes come from the site's TransactionCurrencyCode enum; never exchange rates.
  if (value === 0 || value === '0' || value === 'ILS' || value === 'NIS') return 'ILS';
  if (value === 19 || value === '19' || value === 'USD') return 'USD';
  if (value === 100 || value === '100' || value === 'EUR') return 'EUR';
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : undefined;
}
function pending(billingDate: string): WebTransaction {
  return {
    type: TransactionTypes.Normal,
    date: `${billingDate}T00:00:00.000Z`,
    processedDate: `${billingDate}T00:00:00.000Z`,
    chargedAmount: 0,
    description: '',
    status: TransactionStatuses.Pending,
  };
}

/** Human-authenticated new-site page only. All requests stay on that page's
 * origin; no login, browser launch, response logging or balances are exposed. */
export async function fetchIsracardWebTransactions(
  page: Page,
  limits: IsracardDesktopLimits,
): Promise<IsracardWebResult> {
  const { from, to, maxAccounts, maxRows } = limits;
  const start = moment.utc(from, 'YYYY-MM-DD', true),
    end = moment.utc(to, 'YYYY-MM-DD', true);
  if (
    !start.isValid() ||
    !end.isValid() ||
    start.format('YYYY-MM-DD') !== from ||
    end.format('YYYY-MM-DD') !== to ||
    from > to ||
    to > moment.utc().format('YYYY-MM-DD') ||
    !Number.isSafeInteger(maxAccounts) ||
    maxAccounts < 1 ||
    maxAccounts > 20 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > 5000 ||
    end.clone().startOf('month').diff(start.clone().startOf('month'), 'months') >= 12
  )
    throw new IsracardWebError('transactionsValidation');
  const request = async (path: string, body: Value, stage: Stage): Promise<Value> => {
    const response: unknown = await page
      .evaluate(
        async (address, payload) => {
          if (
            location.origin !== 'https://web.isracard.co.il' ||
            !/^\/(?:statuspage|transactions)\/?$/i.test(location.pathname) ||
            new URL(address).origin !== location.origin ||
            !/^\/ocp\/transactions\/DigitalV3\.Transactions\/(?:GetCardList|GetMonthlyBilling|GetTransactionsList)$/.test(
              new URL(address).pathname,
            )
          )
            return { ok: false, httpStatus: null };
          const stop = new AbortController(),
            timeout = setTimeout(() => stop.abort(), 15000);
          let status: number | null = null;
          try {
            const headers: Record<string, string> = {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              TraceIdentifier: crypto.randomUUID(),
            };
            // Mirror the site's ordinary same-origin Axios CSRF header. The token
            // is read and used only inside the bank page and never leaves it.
            const csrf = document.cookie
              .split(';')
              .map(part => part.trim())
              .find(part => part.startsWith('XSRF-TOKEN='));
            if (csrf) headers['X-XSRF-TOKEN'] = decodeURIComponent(csrf.slice('XSRF-TOKEN='.length));
            const result = await fetch(address, {
              method: 'POST',
              headers,
              credentials: 'same-origin',
              redirect: 'error',
              body: JSON.stringify(payload),
              signal: stop.signal,
            });
            status = result.status;
            if (!result.ok || !result.body) return { ok: false, httpStatus: status };
            const reader = result.body.getReader(),
              chunks: Uint8Array[] = [];
            let bytes = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 2000000) {
                await reader.cancel();
                return { ok: false, httpStatus: status };
              }
              chunks.push(part.value);
            }
            const buffer = new Uint8Array(bytes);
            let offset = 0;
            for (const chunk of chunks) {
              buffer.set(chunk, offset);
              offset += chunk.byteLength;
            }
            return { ok: true, httpStatus: status, data: JSON.parse(new TextDecoder().decode(buffer)) as unknown };
          } catch {
            return { ok: false, httpStatus: status };
          } finally {
            clearTimeout(timeout);
          }
        },
        `${API}/${path}`,
        body,
      )
      .catch(() => {
        throw new IsracardWebError(stage);
      });
    if (!object(response) || response.ok !== true || response.httpStatus !== 200 || !object(response.data)) {
      const status =
        object(response) &&
        Number.isInteger(response.httpStatus) &&
        Number(response.httpStatus) >= 100 &&
        Number(response.httpStatus) <= 599
          ? Number(response.httpStatus)
          : null;
      throw new IsracardWebError(stage, status);
    }
    if (response.data.isSuccess !== true || response.data.errorCode != null || !object(response.data.data))
      throw new IsracardWebError(stage, 200);
    return response.data.data;
  };
  const cardsData = await request('GetCardList', { companyCode: '11', cardSuffixLength: 4 }, 'cardListRequest');
  if (!Array.isArray(cardsData.cardsList) || cardsData.cardsList.length > maxAccounts)
    throw new IsracardWebError('cardListValidation', 200);
  const cards: Value[] = [],
    seen = new Set<string>();
  for (const value of cardsData.cardsList) {
    if (
      !object(value) ||
      typeof value.cardSuffix !== 'string' ||
      !/^\d{4}$/.test(value.cardSuffix) ||
      integer(value.companyCode) !== 11 ||
      typeof value.isActive !== 'boolean' ||
      typeof value.isPartner !== 'boolean' ||
      integer(value.serviceType) === undefined ||
      seen.has(value.cardSuffix)
    )
      throw new IsracardWebError('cardListValidation', 200, object(value) ? [value] : []);
    seen.add(value.cardSuffix);
    cards.push(value);
  }
  const accounts = cards.map(card => ({ accountNumber: card.cardSuffix as string, txns: [] as WebTransaction[] }));
  const months = end.clone().startOf('month').diff(start.clone().startOf('month'), 'months') + 1;
  const today = moment.utc().format('YYYY-MM-DD');
  let scanned = 0;
  for (let offset = 0; offset < months; offset++) {
    const month = start.clone().startOf('month').add(offset, 'months');
    for (const [index, card] of cards.entries()) {
      const cardData = {
        cardStatus: card.isActive ? 0 : 1,
        cardSuffix: card.cardSuffix,
        companyCode: 11,
        serviceType: integer(card.serviceType)!,
        isPartner: card.isPartner,
      };
      const monthly = await request(
        'GetMonthlyBilling',
        { cards: [cardData], billingDate: month.format('MM/YYYY') },
        'billingRequest',
      );
      const billed = object(monthly.cards) ? monthly.cards[card.cardSuffix as string] : undefined;
      const billingDate = object(billed) ? day(billed.billingDate) : undefined;
      if (!billingDate || billingDate.slice(0, 7) !== month.format('YYYY-MM'))
        throw new IsracardWebError('billingValidation', 200, [
          { ...card, billingDate: object(billed) ? billed.billingDate : undefined },
        ]);
      if (billingDate < from || billingDate > to) continue;
      const data = await request(
        'GetTransactionsList',
        {
          card4Number: card.cardSuffix,
          isNextBillingDate: false,
          cardStatus: cardData.cardStatus,
          billingMonth: month.format('DD/MM/YYYY'),
          companyCode: 11,
          isPartner: card.isPartner,
        },
        'transactionsRequest',
      );
      if (!['approvals', 'israelAbroadVouchers', 'currentTransactionsList'].some(key => Object.hasOwn(data, key)))
        throw new IsracardWebError('transactionsValidation', 200);
      if (
        ['approvals', 'israelAbroadVouchers', 'currentTransactionsList'].some(
          key => data[key] != null && !object(data[key]),
        )
      )
        throw new IsracardWebError('transactionsValidation', 200);
      const group = object(data.israelAbroadVouchers) ? data.israelAbroadVouchers : undefined;
      if (group?.vouchers != null && !object(group.vouchers)) throw new IsracardWebError('transactionsValidation', 200);
      const vouchers = group && object(group.vouchers) ? group.vouchers : undefined;
      const total = vouchers && object(vouchers.totalForStatement) ? vouchers.totalForStatement : undefined;
      const list = vouchers?.israelAbroadVouchersList;
      if (list !== undefined && list !== null && !Array.isArray(list))
        throw new IsracardWebError('transactionsValidation', 200);
      const rows: unknown[] = Array.isArray(list) ? list : [];
      const meta = {
        ...card,
        billingDate: object(billed) ? billed.billingDate : undefined,
        isMonthlyPayment: total?.isMonthlyPayment,
      };
      if (rows.length && typeof total?.isMonthlyPayment !== 'boolean')
        throw new IsracardWebError('transactionsValidation', 200, [meta]);
      const addPending = (rows: unknown) => {
        if (rows == null) return;
        if (!Array.isArray(rows) || (scanned += rows.length) > maxRows)
          throw new IsracardWebError('transactionsValidation', 200);
        accounts[index].txns.push(...rows.map(() => pending(billingDate)));
      };
      addPending(object(data.approvals) ? data.approvals.approvedTransactions : undefined);
      addPending(vouchers?.informativeOnlyVouchers);
      if (group?.outOfStatementChargeDateVouchers != null) {
        if (!Array.isArray(group.outOfStatementChargeDateVouchers))
          throw new IsracardWebError('transactionsValidation', 200);
        for (const outside of group.outOfStatementChargeDateVouchers) {
          if (!object(outside) || !Array.isArray(outside.immediateVouchersCurrencyDate))
            throw new IsracardWebError('transactionsValidation', 200);
          addPending(outside.immediateVouchersCurrencyDate);
        }
      }
      if ((scanned += rows.length) > maxRows) throw new IsracardWebError('transactionsValidation', 200);
      const shapes = rows.filter(object).map(row => ({ ...meta, ...row }));
      for (const row of rows) {
        if (!object(row)) throw new IsracardWebError('transactionsValidation', 200, shapes);
        if (
          total?.isMonthlyPayment === true ||
          billingDate >= today ||
          [
            'status',
            'transactionStatus',
            'isPending',
            'isFuture',
            'isCancelled',
            'pending',
            'cancelled',
            'isAuthorization',
          ].some(key => row[key] !== undefined)
        ) {
          accounts[index].txns.push(pending(billingDate));
          continue;
        }
        const purchase = day(row.purchaseDate);
        if (!purchase || purchase > billingDate) throw new IsracardWebError('transactionDates', 200, shapes);
        const charged = amount(row.billingAmount),
          chargedCurrency = currency(row.billingAmountCurrency);
        if (charged === undefined || charged === 0 || !chargedCurrency)
          throw new IsracardWebError('transactionAmounts', 200, shapes);
        const reference =
          typeof row.seqVoucherNumber === 'string'
            ? row.seqVoucherNumber
            : typeof row.seqVoucherNumber === 'number' && Number.isSafeInteger(row.seqVoucherNumber)
              ? String(row.seqVoucherNumber)
              : '';
        if (!/^\d{1,64}$/.test(reference) || /^0+$/.test(reference))
          throw new IsracardWebError('transactionReference', 200, shapes);
        if (typeof row.businessName !== 'string' || !row.businessName.trim() || row.businessName.length > 4000)
          throw new IsracardWebError('transactionMetadata', 200, shapes);
        const part = row.currentInstallmentNum == null ? 0 : integer(row.currentInstallmentNum);
        const count = row.numberOfInstallment == null ? 0 : integer(row.numberOfInstallment);
        if (part === undefined || count === undefined || part > count || count > 1200 || (part === 0) !== (count === 0))
          throw new IsracardWebError('transactionMetadata', 200, shapes);
        const originalCurrency = currency(row.originalCurrency),
          originalAmount = amount(row.originalAmount);
        const transaction: WebTransaction = {
          type: count > 1 ? TransactionTypes.Installments : TransactionTypes.Normal,
          identifier: reference,
          date: `${purchase}T00:00:00.000Z`,
          processedDate: `${billingDate}T00:00:00.000Z`,
          chargedAmount: -charged,
          chargedCurrency,
          description: row.businessName,
          status: TransactionStatuses.Completed,
          ...(count > 1 ? { installments: { number: part, total: count } } : {}),
          ...(originalCurrency && originalAmount !== undefined
            ? { originalCurrency, originalAmount: -originalAmount }
            : {}),
        };
        accounts[index].txns.push(transaction);
      }
    }
  }
  return { success: true, accounts };
}
