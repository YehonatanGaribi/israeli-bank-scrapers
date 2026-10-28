import moment from 'moment';
import { type Page } from 'puppeteer';
import { TransactionStatuses, TransactionTypes, type Transaction } from '../transactions';
import { type IsracardDesktopLimits } from './isracard';
import { decode, field, flag, integer, neutralCode, payload, record, suffix } from './desktop-response';
import { isracardWebRequest, nativeIsracardCards, type IsracardWireResponse } from './isracard-web-transport';

type Value = Record<string, unknown>;
type WebTransaction = Omit<Transaction, 'originalAmount' | 'originalCurrency'> &
  Partial<Pick<Transaction, 'originalAmount' | 'originalCurrency'>> & { settlement?: 'immediate' };
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
  'responseBody',
  'responseData',
  'responseResult',
  'responseSuccess',
  'responseError',
  'immediateChargeDate',
  'billingAmountCurrencySymbol',
  'reviewChecks',
] as const;
const reviewChecks = [
  'unposted',
  'bankPartial',
  'revolving',
  'missingChargeDate',
  'wrongMonth',
  'futureCharge',
  'missingPurchaseDate',
  'dateOrder',
  'invalidAmount',
  'invalidCurrency',
  'invalidReference',
  'invalidDescription',
  'invalidInstallments',
  'posted',
  'immediate',
  'currencyAssumedILS',
  'explicitForeignCurrency',
  'conflictingDuplicate',
  'accountUnsupported',
  'invalidOriginalAmount',
  'outsideRange',
] as const;
type ReviewCheck = (typeof reviewChecks)[number];
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
  | 'unsupported'
  | 'html'
  | 'jsonString'
  | 'neutralCode'
  | 'nonzeroCode'
  | 'ambiguous'
  | ReviewCheck;
type Profile = Array<{ field: (typeof fields)[number]; kinds: Kind[] }>;
export interface IsracardWebResult {
  success: true;
  accounts: Array<{ accountNumber: string; txns: WebTransaction[] }>;
  compatibility: Profile;
}
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
export class IsracardWebError extends Error {
  readonly diagnostic: Readonly<{
    stage: Stage;
    reason: 'UNAVAILABLE';
    httpStatus: number | null;
    compatibility?: Profile;
  }>;
  constructor(stage: Stage, httpStatus: number | null = null, compatibility?: Profile) {
    super('PROVIDER_UNAVAILABLE');
    this.diagnostic = Object.freeze({
      stage: (stages as readonly string[]).includes(stage) ? stage : 'transactionsValidation',
      reason: 'UNAVAILABLE',
      httpStatus,
      ...(httpStatus === 200 && compatibility ? { compatibility } : {}),
    });
  }
}
function day(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (
    /^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.test(
      text,
    )
  ) {
    const parsed = moment.utc(text.slice(0, 10), 'YYYY-MM-DD', true);
    return parsed.isValid() ? parsed.format('YYYY-MM-DD') : undefined;
  }
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(text)) return undefined;
  const parsed = moment.utc(text, ['DD/MM/YYYY', 'D/M/YYYY'], true);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : undefined;
}
function kind(value: unknown, name: (typeof fields)[number]): Kind {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (name === 'responseError') return neutralCode(value) ? 'neutralCode' : 'nonzeroCode';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number')
    return Number.isSafeInteger(value)
      ? 'safeInteger'
      : Number.isFinite(value) && !Number.isInteger(value)
        ? 'decimalNumber'
        : 'unsafeNumber';
  if (typeof value === 'string') {
    if (!value.length) return 'emptyString';
    if (name === 'responseBody' && /^\s*</.test(value)) return 'html';
    if (['responseBody', 'responseData', 'responseResult'].includes(name) && decode(value) !== value)
      return 'jsonString';
    if (['billingDate', 'purchaseDate'].includes(name) && day(value)) return 'date';
    if (/^-?\d+$/.test(value)) return 'integerString';
    if (/^-?\d+\.\d+$/.test(value)) return 'decimalString';
    return 'text';
  }
  return Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : 'unsupported';
}
function makeProfile() {
  const entries = fields.map(name => ({ field: name, kinds: new Set<Kind>() }));
  return {
    note(values: Value) {
      for (const entry of entries)
        if (Object.prototype.hasOwnProperty.call(values, entry.field))
          entry.kinds.add(kind(values[entry.field], entry.field));
    },
    ambiguous() {
      entries[0].kinds.add('ambiguous');
    },
    check(...values: ReviewCheck[]) {
      for (const value of values)
        if ((reviewChecks as readonly string[]).includes(value)) entries[entries.length - 1].kinds.add(value);
    },
    snapshot(): Profile {
      return entries.map(entry => ({ field: entry.field, kinds: [...entry.kinds].sort() }));
    },
  };
}
function minor(text: string): bigint | undefined {
  const m = /^(-?)(0|[1-9]\d{0,13})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return undefined;
  const n = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -n : n;
}
function amount(value: unknown): number | undefined {
  if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) >= 2 ** 45)) return undefined;
  let text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : undefined;
  if (text === undefined) return undefined;
  if (/^\(\d+(?:\.\d{1,2})?\)$/.test(text)) text = `-${text.slice(1, -1)}`;
  if (/^\d+(?:\.\d{1,2})?-$/.test(text)) text = `-${text.slice(0, -1)}`;
  if (/^-?\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) text = text.replace(/,/g, '');
  const cents = minor(text),
    limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (cents === undefined || cents < -limit || cents > limit) return undefined;
  const result = Number(text);
  return minor(String(result)) === cents ? result : undefined;
}
function currency(input: unknown): string | undefined {
  const value = typeof input === 'string' ? input.trim().toUpperCase() : input;
  if (value === 0 || value === '0' || value === 'ILS' || value === 'NIS' || value === '₪' || value === 'ש"ח')
    return 'ILS';
  if (value === 'ש״ח' || value === 'שח') return 'ILS';
  if (value === 19 || value === '19' || value === 'USD' || value === '$' || value === 'US$') return 'USD';
  if (value === 100 || value === '100' || value === 'EUR' || value === '€') return 'EUR';
  if (value === '£') return 'GBP';
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : undefined;
}
const absent = (value: unknown) => value == null || (typeof value === 'string' && value.trim() === '');
function billedCurrency(code: unknown, symbol: unknown): { currency?: string; assumed: boolean } {
  const explicit = [code, symbol].filter(value => !absent(value));
  if (!explicit.length) return { currency: 'ILS', assumed: true };
  const known = new Set(explicit.map(currency).filter((value): value is string => value !== undefined));
  return { currency: known.size === 1 ? [...known][0] : undefined, assumed: false };
}
function pending(date: string): WebTransaction {
  return {
    type: TransactionTypes.Normal,
    date: `${date}T00:00:00.000Z`,
    processedDate: `${date}T00:00:00.000Z`,
    chargedAmount: 0,
    description: '',
    status: TransactionStatuses.Pending,
  };
}
function canonical(row: unknown): Value {
  return {
    cardSuffix: field(row, 'cardSuffix', 'card4Number', 'last4', 'lastFourDigits'),
    companyCode: field(row, 'companyCode'),
    isActive: field(row, 'isActive', 'active'),
    isPartner: field(row, 'isPartner'),
    serviceType: field(row, 'serviceType'),
    billingDate: field(row, 'billingDate', 'chargeDate', 'paymentDate', 'actualChargeDate'),
    seqVoucherNumber: field(row, 'seqVoucherNumber', 'voucherNumber', 'voucherNumberRatz', 'identifier'),
    purchaseDate: field(row, 'purchaseDate', 'fullPurchaseDate'),
    billingAmount: field(row, 'billingAmount', 'paymentSum', 'actualPaymentAmount'),
    billingAmountCurrency: field(row, 'billingAmountCurrency', 'chargedCurrency', 'paymentCurrency', 'currencyId'),
    billingAmountCurrencySymbol: field(row, 'billingAmountCurrencySymbol', 'currencySymbol'),
    businessName: field(row, 'businessName', 'merchantName', 'fullSupplierNameHeb', 'description'),
    numberOfInstallment: field(row, 'numberOfInstallment', 'totalInstallments'),
    currentInstallmentNum: field(row, 'currentInstallmentNum', 'installmentNumber'),
    originalCurrency: field(row, 'originalCurrency'),
    originalAmount: field(row, 'originalAmount'),
    isMonthlyPayment: field(row, 'isMonthlyPayment'),
  };
}
function cardRows(data: unknown): unknown[] | undefined {
  if (Array.isArray(data)) return data;
  const value = decode(field(data, 'cardsList', 'cardList', 'cards'));
  if (Array.isArray(value)) return value;
  if (record(value))
    return Object.entries(value).map(([id, row]) =>
      record(row) && canonical(row).cardSuffix == null && /^\d{4}$/.test(id) ? { ...row, cardSuffix: id } : row,
    );
  return undefined;
}
function billingRecord(data: unknown, id: string): unknown {
  const cards = decode(field(data, 'cards', 'cardsList', 'cardList'));
  if (record(cards) && Object.prototype.hasOwnProperty.call(cards, id)) return cards[id];
  const values = Array.isArray(cards) ? cards : record(cards) ? Object.values(cards) : [];
  const matches = values.filter(row => suffix(canonical(row).cardSuffix) === id);
  if (matches.length === 1) return matches[0];
  if (values.length === 1 && canonical(values[0]).cardSuffix == null) return values[0];
  return field(data, 'billingDate', 'chargeDate', 'paymentDate') !== undefined ? data : undefined;
}
interface Snapshot {
  data?: unknown;
  errors: unknown[];
}
interface Card {
  id: string;
  raw: Value;
  request: Value;
}
interface Block {
  card: Card;
  month: string;
  billing: Snapshot;
  transactions: Snapshot;
}
/** Acquire a bounded current-site session first. Optional/wrapper differences
 * are tolerated; only independently verified financial records can be posted. */
export async function fetchIsracardWebTransactions(
  page: Page,
  limits: IsracardDesktopLimits,
): Promise<IsracardWebResult> {
  const { from, to, maxAccounts, maxRows } = limits,
    start = moment.utc(from, 'YYYY-MM-DD', true),
    end = moment.utc(to, 'YYYY-MM-DD', true);
  if (
    !start.isValid() ||
    !end.isValid() ||
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
  const summary = makeProfile();
  let retained = 0;
  const unpack = (wire: IsracardWireResponse, stage: Stage, matches: (item: unknown) => boolean): Snapshot => {
    const errors: unknown[] = [];
    const size =
      wire.data === undefined ? 0 : typeof wire.data === 'string' ? wire.data.length : JSON.stringify(wire.data).length;
    retained += size;
    if (size > 2_000_000 || retained > 16_000_000) throw new IsracardWebError('transactionsResponse', wire.httpStatus);
    summary.note({ responseBody: wire.data });
    let node = wire.data;
    for (let depth = 0; depth < 6; depth++) {
      node = decode(node);
      if (!record(node)) break;
      const code = field(node, 'errorCode', 'error');
      if (code !== undefined) errors.push(code);
      summary.note({
        responseData: field(node, 'data', 'body', 'payload', 'd'),
        responseResult: field(node, 'result', 'response'),
        responseSuccess: field(node, 'isSuccess', 'success'),
        responseError: code,
      });
      const child = field(node, 'data', 'result', 'response', 'body', 'payload', 'd');
      if (child === undefined) break;
      node = child;
    }
    if (!wire.ok || wire.httpStatus !== 200) {
      if (wire.httpStatus === 401 || wire.httpStatus === 403 || stage === 'cardListRequest')
        throw new IsracardWebError(stage, wire.httpStatus, wire.httpStatus === 200 ? summary.snapshot() : undefined);
      return { errors };
    }
    try {
      return { data: payload(wire.data, matches), errors };
    } catch {
      return { errors };
    }
  };
  const native = await nativeIsracardCards(page);
  const cardsWire =
    native ?? (await isracardWebRequest(page, 'GetCardList', { companyCode: '11', cardSuffixLength: 4 }));
  const cardsSnapshot = unpack(cardsWire, 'cardListRequest', item => cardRows(item) !== undefined);
  const rows = cardRows(cardsSnapshot.data);
  if (!rows || rows.length > maxAccounts) throw new IsracardWebError('cardListRequest', 200, summary.snapshot());
  const candidates: Card[] = [],
    duplicates = new Set<string>(),
    ids = new Set<string>();
  for (const row of rows) {
    const raw = canonical(row);
    summary.note(raw);
    const id = suffix(raw.cardSuffix),
      company = raw.companyCode == null || raw.companyCode === '' ? 11 : integer(raw.companyCode);
    if (!id || company !== 11) continue;
    if (ids.has(id)) {
      duplicates.add(id);
      summary.ambiguous();
    }
    ids.add(id);
    const partner = flag(raw.isPartner),
      service = integer(raw.serviceType);
    candidates.push({
      id,
      raw,
      request: {
        cardStatus: (flag(raw.isActive) ?? false) ? 0 : 1,
        cardSuffix: id,
        companyCode: 11,
        serviceType: service ?? null,
        ...(partner !== undefined ? { isPartner: partner } : {}),
      },
    });
  }
  const cards = candidates.filter(card => !duplicates.has(card.id));
  if (rows.length && !cards.length) throw new IsracardWebError('cardListValidation', 200, summary.snapshot());
  const blocks: Block[] = [],
    months = end.clone().startOf('month').diff(start.clone().startOf('month'), 'months') + 2;
  // A statement view can contain charges processed in the previous month.
  // Read one view beyond the requested end month (at most 13 views for a
  // 12-month range), then retain only actual charge dates inside from/to.
  // Gather the period before mapping so one review/report covers the session.
  for (let offset = 0; offset < months; offset++)
    for (const card of cards) {
      const month = start.clone().startOf('month').add(offset, 'months');
      const billing = unpack(
        await isracardWebRequest(page, 'GetMonthlyBilling', {
          cards: [card.request],
          billingDate: month.format('MM/YYYY'),
        }),
        'billingRequest',
        item =>
          record(item) &&
          (field(item, 'cards', 'cardsList', 'cardList') !== undefined ||
            field(item, 'billingDate', 'chargeDate', 'paymentDate') !== undefined),
      );
      const transactions = unpack(
        await isracardWebRequest(page, 'GetTransactionsList', {
          card4Number: card.id,
          isNextBillingDate: false,
          cardStatus: card.request.cardStatus,
          billingMonth: month.format('DD/MM/YYYY'),
          companyCode: 11,
          ...(card.request.isPartner !== undefined ? { isPartner: card.request.isPartner } : {}),
        }),
        'transactionsRequest',
        item =>
          Array.isArray(item) ||
          (record(item) &&
            [
              'israelAbroadVouchers',
              'vouchers',
              'postedTransactions',
              'transactions',
              'approvals',
              'currentTransactionsList',
            ].some(name => field(item, name) !== undefined)),
      );
      blocks.push({ card, month: month.format('YYYY-MM'), billing, transactions });
    }
  const accounts = cards.map(card => ({ accountNumber: card.id, txns: [] as WebTransaction[] }));
  const today = moment.utc().format('YYYY-MM-DD');
  let scanned = 0;
  for (const block of blocks) {
    const account = accounts.find(item => item.accountNumber === block.card.id)!;
    const bill = billingRecord(block.billing.data, block.card.id),
      rawDate = canonical(bill).billingDate,
      billingDate = day(rawDate);
    const data = block.transactions.data,
      group = field(data, 'israelAbroadVouchers'),
      vouchers = field(group, 'vouchers') ?? field(data, 'vouchers') ?? group;
    const total = field(vouchers, 'totalForStatement'),
      monthly = field(total, 'isMonthlyPayment');
    let posted = decode(
      field(vouchers, 'israelAbroadVouchersList', 'vouchersList', 'postedTransactions') ??
        field(data, 'postedTransactions'),
    );
    let explicitPosted = true;
    if (posted == null) {
      posted = Array.isArray(data) ? data : decode(field(data, 'transactions', 'transactionsList'));
      explicitPosted = false;
    }
    const base = { ...block.card.raw, billingDate: rawDate, isMonthlyPayment: monthly };
    summary.note(base);
    const markPending = (items: unknown) => {
      if (!Array.isArray(items)) return;
      if ((scanned += items.length) > maxRows)
        throw new IsracardWebError('transactionsValidation', 200, summary.snapshot());
      if (items.length) summary.check('unposted');
      for (const item of items) {
        summary.note({ ...base, ...canonical(item), billingDate: rawDate, isMonthlyPayment: monthly });
        if (billingDate && billingDate >= from && billingDate <= to) account.txns.push(pending(billingDate));
      }
    };
    markPending(field(field(data, 'approvals'), 'approvedTransactions'));
    markPending(field(vouchers, 'informativeOnlyVouchers'));
    const movements: Array<{
      row: unknown;
      immediate: boolean;
      chargeDate?: unknown;
      code?: unknown;
      symbol?: unknown;
    }> = [];
    const outside = decode(field(group, 'outOfStatementChargeDateVouchers'));
    if (Array.isArray(outside))
      for (const item of outside) {
        const rows = decode(field(item, 'immediateVouchersCurrencyDate'));
        if (!Array.isArray(rows)) continue;
        const header = field(item, 'totalVouchersCurrencyDate');
        for (const row of rows)
          movements.push({
            row,
            immediate: true,
            chargeDate: field(header, 'dateImmediateVouchers'),
            code: field(header, 'currencyImmediateVouchers'),
            symbol: field(header, 'currencySymbolImmediateVouchers'),
          });
      }
    // Immediate charge groups supply the actual processing date. A monthly list
    // may repeat the same voucher; never post it again on the statement date.
    const voucherKey = (value: unknown) => {
      const raw = canonical(value),
        reference =
          typeof raw.seqVoucherNumber === 'string' || typeof raw.seqVoucherNumber === 'number'
            ? String(raw.seqVoucherNumber)
            : '';
      return /^\d{1,64}$/.test(reference) && !/^0+$/.test(reference)
        ? JSON.stringify([
            reference,
            absent(raw.currentInstallmentNum) ? 0 : integer(raw.currentInstallmentNum),
            absent(raw.numberOfInstallment) ? 0 : integer(raw.numberOfInstallment),
          ])
        : undefined;
    };
    const immediateKeys = new Set(movements.map(item => voucherKey(item.row)).filter(Boolean));
    if (Array.isArray(posted))
      for (const row of posted) {
        if (!immediateKeys.has(voucherKey(row))) movements.push({ row, immediate: false });
      }
    if ((scanned += movements.length) > maxRows)
      throw new IsracardWebError('transactionsValidation', 200, summary.snapshot());
    const blockedResponse = [...block.billing.errors, ...block.transactions.errors].some(code =>
      ['11', '13', '22', '500'].includes(String(code)),
    );
    for (const movement of movements) {
      const { row, immediate } = movement,
        raw = canonical(row);
      const rawPayment = immediate ? movement.chargeDate : absent(raw.billingDate) ? rawDate : raw.billingDate;
      const purchase = day(raw.purchaseDate),
        payment = day(rawPayment);
      let code = raw.billingAmountCurrency,
        symbol = raw.billingAmountCurrencySymbol;
      if (absent(code) && absent(symbol) && immediate) {
        code = movement.code;
        symbol = movement.symbol;
      }
      summary.note({
        ...base,
        ...raw,
        billingDate: rawPayment,
        ...(immediate ? { immediateChargeDate: movement.chargeDate } : {}),
        billingAmountCurrency: code,
        billingAmountCurrencySymbol: symbol,
      });
      const billed = billedCurrency(code, symbol),
        chargedCurrency = billed.currency,
        charged = amount(raw.billingAmount);
      if (billed.assumed) summary.check('currencyAssumedILS');
      if (chargedCurrency && chargedCurrency !== 'ILS') summary.check('explicitForeignCurrency');
      const status = field(row, 'status', 'transactionStatus'),
        completed =
          typeof status === 'string' && ['completed', 'posted', 'settled', 'final'].includes(status.toLowerCase());
      const reference =
        typeof raw.seqVoucherNumber === 'string'
          ? raw.seqVoucherNumber.trim()
          : typeof raw.seqVoucherNumber === 'number' && Number.isSafeInteger(raw.seqVoucherNumber)
            ? String(raw.seqVoucherNumber)
            : '';
      const part = absent(raw.currentInstallmentNum) ? 0 : integer(raw.currentInstallmentNum),
        count = absent(raw.numberOfInstallment) ? 0 : integer(raw.numberOfInstallment);
      const checks: ReviewCheck[] = [];
      if (blockedResponse) checks.push('bankPartial');
      if (!immediate && (flag(monthly) === true || (!absent(monthly) && flag(monthly) === undefined)))
        checks.push('revolving');
      if (
        (!immediate && !explicitPosted && !completed) ||
        (status != null && !completed) ||
        ['isPending', 'isFuture', 'isCancelled', 'pending', 'cancelled', 'isAuthorization'].some(
          name => flag(field(row, name)) === true,
        )
      )
        checks.push('unposted');
      if (!payment || (!immediate && !billingDate)) checks.push('missingChargeDate');
      if (
        !immediate &&
        ((billingDate && billingDate.slice(0, 7) !== block.month) || (payment && payment.slice(0, 7) !== block.month))
      )
        checks.push('wrongMonth');
      if (
        (payment && (payment > today || (!immediate && payment === today))) ||
        (!immediate && billingDate && billingDate >= today)
      )
        checks.push('futureCharge');
      if (!purchase) checks.push('missingPurchaseDate');
      if (purchase && payment && purchase > payment) checks.push('dateOrder');
      if (charged === undefined || charged === 0) checks.push('invalidAmount');
      if (!chargedCurrency) checks.push('invalidCurrency');
      if (!/^\d{1,64}$/.test(reference) || /^0+$/.test(reference)) checks.push('invalidReference');
      if (
        !record(row) ||
        typeof raw.businessName !== 'string' ||
        !raw.businessName.trim() ||
        raw.businessName.length > 4000
      )
        checks.push('invalidDescription');
      if (part === undefined || count === undefined || part > count || count > 1200 || (part === 0) !== (count === 0))
        checks.push('invalidInstallments');
      summary.check(...checks);
      if (
        checks.length ||
        !purchase ||
        !payment ||
        charged === undefined ||
        !chargedCurrency ||
        part === undefined ||
        count === undefined
      ) {
        const date = payment ?? billingDate ?? (`${block.month}-01` < from ? from : `${block.month}-01`);
        if (date >= from && date <= to) account.txns.push(pending(date));
        continue;
      }
      if (payment < from || payment > to) continue;
      summary.check('posted', ...(immediate ? ['immediate' as const] : []));
      const originalCurrency = currency(raw.originalCurrency),
        originalAmount = amount(raw.originalAmount);
      account.txns.push({
        type: count > 1 ? TransactionTypes.Installments : TransactionTypes.Normal,
        identifier: reference,
        date: `${purchase}T00:00:00.000Z`,
        processedDate: `${payment}T00:00:00.000Z`,
        chargedAmount: -charged,
        chargedCurrency,
        description: raw.businessName as string,
        status: TransactionStatuses.Completed,
        ...(immediate ? { settlement: 'immediate' as const } : {}),
        ...(count > 1 ? { installments: { number: part, total: count } } : {}),
        ...(originalCurrency && originalAmount !== undefined
          ? { originalCurrency, originalAmount: -originalAmount }
          : {}),
      });
    }
  }
  for (const account of accounts) {
    const unique: WebTransaction[] = [],
      seen = new Map<string, WebTransaction | null>();
    for (const transaction of account.txns) {
      if (transaction.status !== TransactionStatuses.Completed) {
        unique.push(transaction);
        continue;
      }
      const key = JSON.stringify([transaction.identifier, transaction.processedDate, transaction.installments]);
      const existing = seen.get(key);
      if (existing === undefined) {
        seen.set(key, transaction);
        unique.push(transaction);
        continue;
      }
      if (existing && JSON.stringify(existing) === JSON.stringify(transaction)) continue;
      summary.check('conflictingDuplicate');
      if (existing) {
        unique.splice(unique.indexOf(existing), 1);
        unique.push(pending(transaction.processedDate.slice(0, 10)));
      }
      seen.set(key, null);
    }
    account.txns = unique;
  }
  return { success: true, accounts, compatibility: summary.snapshot() };
}
