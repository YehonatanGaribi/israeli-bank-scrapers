import moment from 'moment';
import { type Page } from 'puppeteer';
import IsracardAmexBaseScraper from './base-isracard-amex';
import { type ScraperOptions, type ScraperScrapingResult } from './interface';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../transactions';
import { fetchIsracardWebTransactions, type IsracardWebResult } from './isracard-web';
export { IsracardWebError } from './isracard-web';

const BASE_URL = 'https://digital.isracard.co.il';
const COMPANY_CODE = '11';
const unavailable = () => new Error('PROVIDER_UNAVAILABLE');
type Value = Record<string, unknown>;
function object(value: unknown): value is Value {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function day(value: unknown, format = 'DD/MM/YYYY'): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = moment.utc(value, format, true);
  return parsed.isValid() ? parsed.format('YYYY-MM-DD') : undefined;
}
function currency(value: unknown): string | undefined {
  if (value === 'NIS' || value === 'ש"ח' || value === 'ILS') return 'ILS';
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : undefined;
}
function amount(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && /^-?(0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(String(value))
  );
}

export interface IsracardDesktopLimits {
  /** Billing/settlement date window, inclusive. No historical date clamping. */
  from: string;
  to: string;
  maxAccounts: number;
  maxRows: number;
}

export class IsracardScraper extends IsracardAmexBaseScraper {
  constructor(options: ScraperOptions) {
    super(options, BASE_URL, COMPANY_CODE);
  }

  /** Attach without the legacy initializer's network logging callbacks. */
  initializeDesktopPage(page: Page): void {
    this.page = page;
  }

  /** Current manually signed-in web site. Keep the legacy collector intact. */
  async fetchDesktopWebTransactions(limits: IsracardDesktopLimits): Promise<IsracardWebResult> {
    return fetchIsracardWebTransactions(this.page, limits);
  }

  /** Existing human-authenticated page only. Never invoke login, anti-bot
   * overrides, balances, extra details or the ordinary installment rewriting.
   * CurrentCardTransactions is organized by billing month. A past billing date
   * is the closed-billing evidence; same-day/future billing remains pending.
   */
  async fetchDesktopTransactions(limits: IsracardDesktopLimits): Promise<ScraperScrapingResult> {
    try {
      const { from, to, maxAccounts, maxRows } = limits;
      if (
        day(from, 'YYYY-MM-DD') !== from ||
        day(to, 'YYYY-MM-DD') !== to ||
        from > to ||
        !Number.isSafeInteger(maxAccounts) ||
        maxAccounts < 1 ||
        maxAccounts > 20 ||
        !Number.isSafeInteger(maxRows) ||
        maxRows < 1 ||
        maxRows > 5000
      )
        throw unavailable();
      const start = moment.utc(from).startOf('month');
      const end = moment.utc(to).startOf('month');
      const months = end.diff(start, 'months') + 1;
      // Explicit bound instead of the ordinary scraper's silent 12-month clamp.
      if (months > 12 || to > moment.utc().format('YYYY-MM-DD')) throw unavailable();
      const today = moment.utc().format('YYYY-MM-DD');
      const accounts = new Map<string, TransactionsAccount>();
      let scanned = 0;
      const get = async (params: Record<string, string>): Promise<Value> => {
        const url = new URL(`${BASE_URL}/services/ProxyRequestHandler.ashx`);
        Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
        const response: unknown = await this.page.evaluate(async innerUrl => {
          const stop = new AbortController();
          const timeout = setTimeout(() => stop.abort(), 15000);
          try {
            if (
              location.origin !== 'https://digital.isracard.co.il' ||
              !/^\/personalarea\/(?:cardlist|dashboard)\/?$/i.test(location.pathname)
            )
              throw new Error();
            const result = await fetch(innerUrl, { credentials: 'include', redirect: 'error', signal: stop.signal });
            if (!result.ok || !result.body) throw new Error();
            const reader = result.body.getReader();
            const chunks: Uint8Array[] = [];
            let bytes = 0;
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 2_000_000) {
                await reader.cancel();
                throw new Error();
              }
              chunks.push(part.value);
            }
            const buffer = new Uint8Array(bytes);
            let offset = 0;
            chunks.forEach(chunk => {
              buffer.set(chunk, offset);
              offset += chunk.byteLength;
            });
            return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
          } catch {
            throw new Error('PROVIDER_UNAVAILABLE');
          } finally {
            clearTimeout(timeout);
          }
        }, url.toString());
        if (!object(response) || !object(response.Header) || response.Header.Status !== '1') throw unavailable();
        return response;
      };
      for (let offset = 0; offset < months; offset += 1) {
        const month = start.clone().add(offset, 'months');
        const dashboard = await get({
          reqName: 'DashboardMonth',
          actionCode: '0',
          billingDate: month.format('YYYY-MM-DD'),
          format: 'Json',
        });
        if (
          !object(dashboard.DashboardMonthBean) ||
          !Array.isArray(dashboard.DashboardMonthBean.cardsCharges) ||
          dashboard.DashboardMonthBean.cardsCharges.length > maxAccounts
        )
          throw unavailable();
        const cards = dashboard.DashboardMonthBean.cardsCharges;
        const indexes = new Set<string>(),
          cardIds = new Set<string>();
        for (const card of cards) {
          if (
            !object(card) ||
            typeof card.cardIndex !== 'string' ||
            !/^\d{1,4}$/.test(card.cardIndex) ||
            typeof card.cardNumber !== 'string' ||
            !/^\d{4,19}$/.test(card.cardNumber) ||
            !day(card.billingDate) ||
            day(card.billingDate)!.slice(0, 7) !== month.format('YYYY-MM') ||
            indexes.has(card.cardIndex) ||
            cardIds.has(card.cardNumber)
          )
            throw unavailable();
          indexes.add(card.cardIndex);
          cardIds.add(card.cardNumber);
          if (!accounts.has(card.cardNumber))
            accounts.set(card.cardNumber, { accountNumber: card.cardNumber, txns: [] });
          if (accounts.size > maxAccounts) throw unavailable();
        }
        if (cards.length === 0) continue;
        const result = await get({
          reqName: 'CardsTransactionsList',
          month: month.format('MM'),
          year: month.format('YYYY'),
          requiredDate: 'N',
        });
        if (!object(result.CardsTransactionsListBean)) throw unavailable();
        // An unmapped card must never be silently lost or assigned another card's suffix.
        if (Object.keys(result.CardsTransactionsListBean).some(key => !indexes.has(key.replace(/^Index/, ''))))
          throw unavailable();
        for (const rawCard of cards) {
          const card = rawCard as Value;
          const group = result.CardsTransactionsListBean[`Index${card.cardIndex as string}`];
          if (
            !object(group) ||
            !Array.isArray(group.CurrentCardTransactions) ||
            group.CurrentCardTransactions.length > maxRows
          )
            throw unavailable();
          const billingDate = day(card.billingDate)!;
          for (const raw of group.CurrentCardTransactions) {
            if (!object(raw)) throw unavailable();
            for (const [key, outbound] of [
              ['txnIsrael', false],
              ['txnAbroad', true],
            ] as const) {
              const rows = raw[key];
              if (rows === undefined) continue;
              if (!Array.isArray(rows) || (scanned += rows.length) > maxRows) throw unavailable();
              for (const item of rows) {
                const mapped = this.desktopTransaction(item, outbound, billingDate, today);
                accounts.get(card.cardNumber as string)!.txns.push(mapped);
              }
            }
          }
        }
      }
      return { success: true, accounts: [...accounts.values()] };
    } catch {
      throw unavailable();
    }
  }

  private desktopTransaction(value: unknown, outbound: boolean, billingDate: string, today: string): Transaction {
    // A minimal pending sentinel counts malformed/unknown rows without returning
    // arbitrary source fields, raw errors, balances or provider metadata.
    const pending: Transaction = {
      type: TransactionTypes.Normal,
      date: `${billingDate}T00:00:00.000Z`,
      processedDate: `${billingDate}T00:00:00.000Z`,
      originalAmount: 0,
      originalCurrency: 'ILS',
      chargedAmount: 0,
      description: '',
      status: TransactionStatuses.Pending,
    };
    if (
      !object(value) ||
      [
        'status',
        'transactionStatus',
        'dealStatus',
        'isPending',
        'isFuture',
        'isCancelled',
        'pending',
        'cancelled',
        'isAuthorization',
      ].some(key => value[key] !== undefined)
    )
      return pending;
    const purchase = day(outbound ? value.fullPurchaseDateOutbound : value.fullPurchaseDate);
    const payment = day(value.fullPaymentDate);
    const reference = outbound ? value.voucherNumberRatzOutbound : value.voucherNumberRatz;
    const charged = outbound ? value.paymentSumOutbound : value.paymentSum;
    // dealSumOutbound is an amount in the provider response, not a boolean.
    const original = outbound ? value.dealSumOutbound : value.dealSum;
    const chargedCurrency = currency(value.currencyId);
    const originalCurrency = currency(value.currentPaymentCurrency) ?? chargedCurrency;
    const description = outbound ? value.fullSupplierNameOutbound : value.fullSupplierNameHeb;
    if (
      !purchase ||
      !payment ||
      purchase > payment ||
      payment.slice(0, 7) !== billingDate.slice(0, 7) ||
      typeof reference !== 'string' ||
      !/^\d{1,64}$/.test(reference) ||
      /^0+$/.test(reference) ||
      typeof value.dealSumType !== 'string' ||
      value.dealSumType === '1' ||
      !amount(charged) ||
      !amount(original) ||
      !chargedCurrency ||
      !originalCurrency ||
      typeof description !== 'string' ||
      description.length > 4000 ||
      (value.moreInfo !== undefined && typeof value.moreInfo !== 'string')
    )
      return pending;
    let installments: Transaction['installments'];
    if (typeof value.moreInfo === 'string' && value.moreInfo.includes('תשלום')) {
      const match = value.moreInfo.trim().match(/^תשלום\s+(\d{1,4})\s+(?:מתוך|מ-)\s*(\d{1,4})$/);
      if (!match) return pending;
      installments = { number: Number(match[1]), total: Number(match[2]) };
      if (installments.number < 1 || installments.total > 1200 || installments.number > installments.total)
        return pending;
    }
    return {
      type: installments ? TransactionTypes.Installments : TransactionTypes.Normal,
      identifier: reference,
      date: `${purchase}T00:00:00.000Z`,
      processedDate: `${payment}T00:00:00.000Z`,
      originalAmount: -original,
      originalCurrency,
      chargedAmount: -charged,
      chargedCurrency,
      description,
      ...(installments ? { installments } : {}),
      status:
        billingDate < today && payment < today && purchase < today
          ? TransactionStatuses.Completed
          : TransactionStatuses.Pending,
    };
  }
}

export default IsracardScraper;
