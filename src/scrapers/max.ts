import moment, { type Moment } from 'moment';
import { type Page } from 'puppeteer';
import { DOLLAR_CURRENCY, EURO_CURRENCY, SHEKEL_CURRENCY } from '../constants';
import getAllMonthMoments from '../helpers/dates';
import { getDebug } from '../helpers/debug';
import { clickButton, elementPresentOnPage, waitUntilElementFound } from '../helpers/elements-interactions';
import { fetchGetWithinPage } from '../helpers/fetch';
import { waitForRedirect } from '../helpers/navigation';
import {
  filterOldTransactions,
  fixInstallments,
  sortTransactionsByDate,
  getRawTransaction,
} from '../helpers/transactions';
import { sleep } from '../helpers/waiting';
import { TransactionStatuses, TransactionTypes, type Transaction, type TransactionsAccount } from '../transactions';
import {
  BaseScraperWithBrowser,
  LoginResults,
  type LoginOptions,
  type PossibleLoginResults,
} from './base-scraper-with-browser';
import { type ScraperOptions } from './interface';

const debug = getDebug('max');

export interface ScrapedTransaction {
  shortCardNumber: string;
  paymentDate?: string;
  purchaseDate: string;
  actualPaymentAmount: string;
  paymentCurrency: number | null;
  originalCurrency: string;
  originalAmount: number;
  planName: string;
  planTypeId: number;
  comments: string;
  merchantName: string;
  categoryId: number;
  fundsTransferComment?: string;
  fundsTransferReceiverOrTransfer?: string;
  dealData?: {
    arn: string;
  };
}

const BASE_API_ACTIONS_URL = 'https://onlinelcapi.max.co.il';
const BASE_WELCOME_URL = 'https://www.max.co.il';
const HOME_PAGE_DATA_URL = `${BASE_WELCOME_URL}/api/registered/getHomePageData`;

const LOGIN_URL = `${BASE_WELCOME_URL}/login`;
const PASSWORD_EXPIRED_URL = `${BASE_WELCOME_URL}/renew-password`;
const SUCCESS_URL = `${BASE_WELCOME_URL}/homepage/personal`;

enum MaxPlanName {
  Normal = 'רגילה',
  ImmediateCharge = 'חיוב עסקות מיידי',
  InternetShopping = 'אינטרנט/חו"ל',
  Installments = 'תשלומים',
  MonthlyCharge = 'חיוב חודשי',
  OneMonthPostponed = 'דחוי חודש',
  MonthlyPostponed = 'דחוי לחיוב החודשי',
  MonthlyPayment = 'תשלום חודשי',
  FuturePurchaseFinancing = 'מימון לרכישה עתידית',
  MonthlyPostponedInstallments = 'דחוי חודש תשלומים',
  ThirtyDaysPlus = 'עסקת 30 פלוס',
  TwoMonthsPostponed = 'דחוי חודשיים',
  TwoMonthsPostponed2 = "דחוי 2 ח' תשלומים",
  MonthlyChargePlusInterest = 'חודשי + ריבית',
  Credit = 'קרדיט',
  CreditOutsideTheLimit = 'קרדיט-מחוץ למסגרת',
  AccumulatingBasket = 'סל מצטבר',
  PostponedTransactionInstallments = 'פריסת העסקה הדחויה',
  ReplacementCard = 'כרטיס חליפי',
  EarlyRepayment = 'פרעון מוקדם',
  MonthlyCardFee = 'דמי כרטיס',
  CurrencyPocket = 'חיוב ארנק מטח',
  MonthlyChargeDistribution = 'חלוקת חיוב חודשי',
}

const INVALID_DETAILS_SELECTOR = '#popupWrongDetails';
const LOGIN_ERROR_SELECTOR = '#popupCardHoldersLoginError';

interface HomePageCard {
  Last4Digits: string;
  CreditLimit: number | null;
  OpenToBuy: number | null;
  CycleSummary: Array<{
    Date: string;
    CurrencySymbol: string;
  }>;
}

interface HomePageDataResult {
  Result?: {
    UserCards?: {
      Cards?: HomePageCard[];
    };
  };
}

const categories = new Map<number, string>();

function redirectOrDialog(page: Page) {
  return Promise.race([
    waitForRedirect(page, 20000, false, [BASE_WELCOME_URL, `${BASE_WELCOME_URL}/`]),
    waitUntilElementFound(page, INVALID_DETAILS_SELECTOR, true),
    waitUntilElementFound(page, LOGIN_ERROR_SELECTOR, true),
  ]);
}

function getTransactionsUrl(monthMoment: Moment) {
  const month = monthMoment.month() + 1;
  const year = monthMoment.year();
  const date = `${year}-${month}-01`;

  /**
   * url explanation:
   * userIndex: -1 for all account owners
   * cardIndex: -1 for all cards under the account
   * all other query params are static, beside the date which changes for request per month
   */
  const url = new URL(`${BASE_API_ACTIONS_URL}/api/registered/transactionDetails/getTransactionsAndGraphs`);
  url.searchParams.set(
    'filterData',
    `{"userIndex":-1,"cardIndex":-1,"monthView":true,"date":"${date}","dates":{"startDate":"0","endDate":"0"},"bankAccount":{"bankAccountIndex":-1,"cards":null}}`,
  );
  url.searchParams.set('firstCallCardIndex', '-1');
  return url.toString();
}

interface FetchCategoryResult {
  result?: Array<{
    id: number;
    name: string;
  }>;
}

async function loadHomePageData(page: Page): Promise<Map<string, HomePageCard>> {
  debug('Loading home page data for card balances');
  const res = await fetchGetWithinPage<HomePageDataResult>(page, HOME_PAGE_DATA_URL);
  const cardMap = new Map<string, HomePageCard>();
  if (res?.Result?.UserCards?.Cards) {
    for (const card of res.Result.UserCards.Cards) {
      cardMap.set(card.Last4Digits, card);
    }
  }
  return cardMap;
}

function getCardBalance(card: HomePageCard): number | undefined {
  if (card.CreditLimit == null || card.OpenToBuy == null) return undefined;
  const balance = -(card.CreditLimit - card.OpenToBuy);
  return Math.round(balance * 100) / 100;
}

function getCardBalanceDate(card: HomePageCard): string | undefined {
  const shekelEntry = card.CycleSummary?.find(entry => entry.CurrencySymbol.includes('₪'));
  return shekelEntry ? shekelEntry.Date : undefined;
}

async function loadCategories(page: Page) {
  debug('Loading categories');
  const res = await fetchGetWithinPage<FetchCategoryResult>(page, `${BASE_API_ACTIONS_URL}/api/contents/getCategories`);
  if (res && Array.isArray(res.result)) {
    debug(`${res.result.length} categories loaded`);
    res.result?.forEach(({ id, name }) => categories.set(id, name));
  }
}

function getTransactionType(planName: string, planTypeId: number) {
  const cleanedUpTxnTypeStr = planName.replace('\t', ' ').trim() as MaxPlanName;
  switch (cleanedUpTxnTypeStr) {
    case MaxPlanName.ImmediateCharge:
    case MaxPlanName.Normal:
    case MaxPlanName.MonthlyCharge:
    case MaxPlanName.OneMonthPostponed:
    case MaxPlanName.MonthlyPostponed:
    case MaxPlanName.FuturePurchaseFinancing:
    case MaxPlanName.MonthlyPayment:
    case MaxPlanName.MonthlyPostponedInstallments:
    case MaxPlanName.ThirtyDaysPlus:
    case MaxPlanName.TwoMonthsPostponed:
    case MaxPlanName.TwoMonthsPostponed2:
    case MaxPlanName.AccumulatingBasket:
    case MaxPlanName.InternetShopping:
    case MaxPlanName.MonthlyChargePlusInterest:
    case MaxPlanName.PostponedTransactionInstallments:
    case MaxPlanName.ReplacementCard:
    case MaxPlanName.EarlyRepayment:
    case MaxPlanName.MonthlyCardFee:
    case MaxPlanName.CurrencyPocket:
    case MaxPlanName.MonthlyChargeDistribution:
      return TransactionTypes.Normal;
    case MaxPlanName.Installments:
    case MaxPlanName.Credit:
    case MaxPlanName.CreditOutsideTheLimit:
      return TransactionTypes.Installments;
    default:
      switch (planTypeId) {
        case 2:
        case 3:
          return TransactionTypes.Installments;
        case 5:
          return TransactionTypes.Normal;
        default:
          throw new Error(`Unknown transaction type ${cleanedUpTxnTypeStr as string}`);
      }
  }
}

function getInstallmentsInfo(comments: string) {
  if (!comments) {
    return undefined;
  }
  const matches = comments.match(/\d+/g);
  if (!matches || matches.length < 2) {
    return undefined;
  }

  return {
    number: parseInt(matches[0], 10),
    total: parseInt(matches[1], 10),
  };
}

function getChargedCurrency(currencyId: number | null) {
  switch (currencyId) {
    case 376:
      return SHEKEL_CURRENCY;
    case 840:
      return DOLLAR_CURRENCY;
    case 978:
      return EURO_CURRENCY;
    default:
      return undefined;
  }
}

export function getMemo({
  comments,
  fundsTransferReceiverOrTransfer,
  fundsTransferComment,
}: Pick<ScrapedTransaction, 'comments' | 'fundsTransferReceiverOrTransfer' | 'fundsTransferComment'>) {
  if (fundsTransferReceiverOrTransfer) {
    const memo = comments ? `${comments} ${fundsTransferReceiverOrTransfer}` : fundsTransferReceiverOrTransfer;
    return fundsTransferComment ? `${memo}: ${fundsTransferComment}` : memo;
  }

  return comments;
}

function mapTransaction(rawTransaction: ScrapedTransaction, options?: ScraperOptions): Transaction {
  const isPending = rawTransaction.paymentDate === null;
  const processedDate = moment(isPending ? rawTransaction.purchaseDate : rawTransaction.paymentDate).toISOString();
  const status = isPending ? TransactionStatuses.Pending : TransactionStatuses.Completed;

  const installments = getInstallmentsInfo(rawTransaction.comments);
  const identifier = installments
    ? `${rawTransaction.dealData?.arn}_${installments.number}`
    : rawTransaction.dealData?.arn;

  const result: Transaction = {
    type: getTransactionType(rawTransaction.planName, rawTransaction.planTypeId),
    date: moment(rawTransaction.purchaseDate).toISOString(),
    processedDate,
    originalAmount: -rawTransaction.originalAmount,
    originalCurrency: rawTransaction.originalCurrency,
    chargedAmount: -rawTransaction.actualPaymentAmount,
    chargedCurrency: getChargedCurrency(rawTransaction.paymentCurrency),
    description: rawTransaction.merchantName.trim(),
    memo: getMemo(rawTransaction),
    category: categories.get(rawTransaction?.categoryId),
    installments,
    identifier,
    status,
  };

  if (options?.includeRawTransaction) {
    result.rawTransaction = getRawTransaction(rawTransaction);
  }

  return result;
}
interface ScrapedTransactionsResult {
  result?: {
    transactions: ScrapedTransaction[];
  };
}

async function fetchTransactionsForMonth(page: Page, monthMoment: Moment, options?: ScraperOptions) {
  const url = getTransactionsUrl(monthMoment);

  const data = await fetchGetWithinPage<ScrapedTransactionsResult>(page, url);
  const transactionsByAccount: Record<string, Transaction[]> = {};

  if (!data || !data.result) return transactionsByAccount;

  data.result.transactions
    // Filter out non-transactions without a plan type, e.g. summary rows
    .filter(transaction => !!transaction.planName)
    .forEach((transaction: ScrapedTransaction) => {
      if (!transactionsByAccount[transaction.shortCardNumber]) {
        transactionsByAccount[transaction.shortCardNumber] = [];
      }

      const mappedTransaction = mapTransaction(transaction, options);
      transactionsByAccount[transaction.shortCardNumber].push(mappedTransaction);
    });

  return transactionsByAccount;
}

function addResult(allResults: Record<string, Transaction[]>, result: Record<string, Transaction[]>) {
  const clonedResults: Record<string, Transaction[]> = { ...allResults };
  Object.keys(result).forEach(accountNumber => {
    if (!clonedResults[accountNumber]) {
      clonedResults[accountNumber] = [];
    }
    clonedResults[accountNumber].push(...result[accountNumber]);
  });
  return clonedResults;
}

function prepareTransactions(
  txns: Transaction[],
  startMoment: moment.Moment,
  combineInstallments: boolean,
  enableTransactionsFilterByDate: boolean,
) {
  let clonedTxns = Array.from(txns);
  if (!combineInstallments) {
    clonedTxns = fixInstallments(clonedTxns);
  }
  clonedTxns = sortTransactionsByDate(clonedTxns);
  clonedTxns = enableTransactionsFilterByDate
    ? filterOldTransactions(clonedTxns, startMoment, combineInstallments || false)
    : clonedTxns;
  return clonedTxns;
}

async function fetchTransactions(page: Page, options: ScraperOptions) {
  const futureMonthsToScrape = options.futureMonthsToScrape ?? 1;
  const defaultStartMoment = moment().subtract(1, 'years');
  const startMomentLimit = moment().subtract(4, 'years');
  const startDate = options.startDate || defaultStartMoment.toDate();
  const startMoment = moment.max(startMomentLimit, moment(startDate));
  const allMonths = getAllMonthMoments(startMoment, futureMonthsToScrape);

  await loadCategories(page);
  const homePageCards = await loadHomePageData(page);

  let allResults: Record<string, Transaction[]> = {};
  for (let i = 0; i < allMonths.length; i += 1) {
    const result = await fetchTransactionsForMonth(page, allMonths[i], options);
    allResults = addResult(allResults, result);
  }

  Object.keys(allResults).forEach(accountNumber => {
    let txns = allResults[accountNumber];
    txns = prepareTransactions(
      txns,
      startMoment,
      options.combineInstallments || false,
      options.outputData?.enableTransactionsFilterByDate ?? true,
    );
    allResults[accountNumber] = txns;
  });

  return { allResults, homePageCards };
}

function getPossibleLoginResults(page: Page): PossibleLoginResults {
  const urls: PossibleLoginResults = {};
  urls[LoginResults.Success] = [SUCCESS_URL];
  urls[LoginResults.ChangePassword] = [PASSWORD_EXPIRED_URL];
  urls[LoginResults.InvalidPassword] = [
    async () => {
      return elementPresentOnPage(page, INVALID_DETAILS_SELECTOR);
    },
  ];
  urls[LoginResults.UnknownError] = [
    async () => {
      return elementPresentOnPage(page, LOGIN_ERROR_SELECTOR);
    },
  ];
  return urls;
}

function createLoginFields(credentials: ScraperSpecificCredentials) {
  return [
    { selector: '#user-name', value: credentials.username },
    { selector: '#password', value: credentials.password },
  ];
}

type ScraperSpecificCredentials = { username: string; password: string };

export interface MaxDesktopTransactionLimits {
  from: string;
  to: string;
  maxAccounts: number;
  maxRows: number;
}

const MAX_DESKTOP_STAGES = [
  'transactionsRequest',
  'transactionsResponse',
  'transactionsValidation',
  'transactionDates',
  'transactionAmounts',
  'transactionMetadata',
  'transactionReference',
] as const;

export type MaxDesktopStage =
  | 'transactionsRequest'
  | 'transactionsResponse'
  | 'transactionsValidation'
  | 'transactionDates'
  | 'transactionAmounts'
  | 'transactionMetadata'
  | 'transactionReference';

export interface MaxDesktopDiagnostic {
  readonly stage: MaxDesktopStage;
  readonly reason: 'UNAVAILABLE';
  readonly httpStatus: number | null;
}

/** Only fixed diagnostics may cross the desktop worker boundary. */
export class MaxDesktopError extends Error {
  readonly stage: MaxDesktopStage;
  readonly reason = 'UNAVAILABLE' as const;
  readonly httpStatus: number | null;
  readonly diagnostic: MaxDesktopDiagnostic;

  constructor(stage: MaxDesktopStage, httpStatus: number | null = null) {
    super('PROVIDER_UNAVAILABLE');
    this.name = 'MaxDesktopError';
    this.stage = MAX_DESKTOP_STAGES.includes(stage) ? stage : 'transactionsValidation';
    this.httpStatus =
      typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
        ? httpStatus
        : null;
    this.diagnostic = Object.freeze({ stage: this.stage, reason: this.reason, httpStatus: this.httpStatus });
    Object.freeze(this);
  }
}

function desktopResponse(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MaxDesktopError('transactionsResponse');
  const response = value as Record<string, unknown>;
  const keys = Object.keys(response).sort().join(',');
  if (response.ok === true && keys === 'data,httpStatus,ok' && response.httpStatus === 200) return response.data;
  if (
    response.ok === false &&
    keys === 'httpStatus,ok,reason,stage' &&
    response.reason === 'UNAVAILABLE' &&
    ((response.stage === 'transactionsRequest' &&
      (response.httpStatus === null ||
        (typeof response.httpStatus === 'number' &&
          Number.isInteger(response.httpStatus) &&
          response.httpStatus >= 100 &&
          response.httpStatus <= 599 &&
          response.httpStatus !== 200))) ||
      (response.stage === 'transactionsResponse' && response.httpStatus === 200))
  )
    throw new MaxDesktopError(response.stage, typeof response.httpStatus === 'number' ? response.httpStatus : null);
  throw new MaxDesktopError('transactionsResponse');
}

function desktopDay(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(
      value,
    )
  )
    return undefined;
  const day = value.slice(0, 10);
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === day &&
    Number.isFinite(Date.parse(value))
    ? day
    : undefined;
}

export function getMaxMinimumStartDate(): Date {
  const now = moment.utc().subtract(4, 'years');
  return now.startOf('day').toDate();
}

function desktopTransaction(value: unknown): { accountNumber: string; transaction: Transaction } {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MaxDesktopError('transactionsValidation', 200);
  const row = value as ScrapedTransaction;
  const purchaseDay = desktopDay(row.purchaseDate);
  const pending = row.paymentDate == null;
  const paymentDay = pending ? purchaseDay : desktopDay(row.paymentDate);
  if (!purchaseDay || !paymentDay || purchaseDay > paymentDay) throw new MaxDesktopError('transactionDates', 200);
  if (
    typeof row.actualPaymentAmount !== 'string' ||
    !/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(row.actualPaymentAmount) ||
    !Number.isFinite(row.originalAmount) ||
    typeof row.originalCurrency !== 'string' ||
    !/^[A-Z]{3}$/.test(row.originalCurrency) ||
    !(row.paymentCurrency === null || row.paymentCurrency === undefined || Number.isSafeInteger(row.paymentCurrency))
  )
    throw new MaxDesktopError('transactionAmounts', 200);
  if (
    typeof row.shortCardNumber !== 'string' ||
    !/^\d{4}$/.test(row.shortCardNumber) ||
    typeof row.planName !== 'string' ||
    row.planName.length > 200 ||
    !Number.isSafeInteger(row.planTypeId) ||
    typeof row.comments !== 'string' ||
    row.comments.length > 1000 ||
    typeof row.merchantName !== 'string' ||
    row.merchantName.length > 4000
  )
    throw new MaxDesktopError('transactionMetadata', 200);
  let type: TransactionTypes;
  try {
    type = getTransactionType(row.planName, row.planTypeId);
  } catch {
    throw new MaxDesktopError('transactionMetadata', 200);
  }
  const installments = type === TransactionTypes.Installments ? getInstallmentsInfo(row.comments) : undefined;
  if (
    type === TransactionTypes.Installments &&
    (!installments || installments.number < 1 || installments.total > 1200 || installments.number > installments.total)
  )
    throw new MaxDesktopError('transactionMetadata', 200);
  const arn = row.dealData?.arn;
  if (arn !== undefined && (typeof arn !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(arn)))
    throw new MaxDesktopError('transactionReference', 200);
  return {
    accountNumber: row.shortCardNumber,
    transaction: {
      type,
      date: `${purchaseDay}T00:00:00.000Z`,
      processedDate: `${paymentDay}T00:00:00.000Z`,
      originalAmount: -row.originalAmount,
      originalCurrency: row.originalCurrency,
      chargedAmount: -Number(row.actualPaymentAmount),
      chargedCurrency: getChargedCurrency(row.paymentCurrency),
      description: row.merchantName.trim(),
      // A billing date today or in the future does not establish settlement.
      status:
        pending || paymentDay >= moment.utc().format('YYYY-MM-DD')
          ? TransactionStatuses.Pending
          : TransactionStatuses.Completed,
      ...(installments ? { installments } : {}),
      ...(arn ? { identifier: installments ? `${arn}_${installments.number}` : arn } : {}),
    },
  };
}

export class MaxScraper extends BaseScraperWithBrowser<ScraperSpecificCredentials> {
  /** Attach only the already scoped temporary page. The normal initializer adds
   * request logging hooks and is deliberately unused by the desktop worker. */
  initializeDesktopPage(page: Page): void {
    this.page = page;
  }

  /** Manual login only; bounded billing months, no homepage, categories, balances,
   * installment date rewriting, memo or raw response returned to the caller. */
  async fetchDesktopTransactions(limits: MaxDesktopTransactionLimits) {
    try {
      if (
        !limits ||
        !desktopDay(limits.from) ||
        limits.from.length !== 10 ||
        !desktopDay(limits.to) ||
        limits.to.length !== 10 ||
        limits.from > limits.to ||
        new Date(`${limits.from}T00:00:00Z`) < getMaxMinimumStartDate() ||
        !Number.isSafeInteger(limits.maxAccounts) ||
        limits.maxAccounts < 1 ||
        limits.maxAccounts > 20 ||
        !Number.isSafeInteger(limits.maxRows) ||
        limits.maxRows < 1 ||
        limits.maxRows > 5000
      )
        throw new MaxDesktopError('transactionsValidation');
      const first = moment.utc(limits.from).startOf('month'),
        last = moment.utc(limits.to).startOf('month');
      const count = last.diff(first, 'months') + 1;
      if (count < 1 || count > 49) throw new MaxDesktopError('transactionsValidation');
      const accounts = new Map<string, Transaction[]>();
      let scanned = 0;
      for (let month = 0; month < count; month += 1) {
        let browserResult: unknown;
        try {
          browserResult = await this.page.evaluate(
            async (url, maxBytes) => {
              let stage: 'transactionsRequest' | 'transactionsResponse' = 'transactionsRequest';
              let httpStatus: number | null = null;
              try {
                if (location.origin !== 'https://www.max.co.il' || location.pathname !== '/homepage/personal')
                  throw new Error();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 15000);
                try {
                  const response = await fetch(url, {
                    credentials: 'include',
                    redirect: 'error',
                    signal: controller.signal,
                  });
                  httpStatus =
                    Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
                      ? response.status
                      : null;
                  if (httpStatus !== 200) throw new Error();
                  stage = 'transactionsResponse';
                  if (!/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body)
                    throw new Error();
                  const reader = response.body.getReader();
                  const decoder = new TextDecoder();
                  let text = '',
                    bytes = 0;
                  for (;;) {
                    const chunk = await reader.read();
                    if (chunk.done) break;
                    bytes += chunk.value.byteLength;
                    if (bytes > maxBytes) {
                      await reader.cancel();
                      throw new Error();
                    }
                    text += decoder.decode(chunk.value, { stream: true });
                  }
                  return { ok: true, httpStatus: 200, data: JSON.parse(text + decoder.decode()) as unknown };
                } finally {
                  clearTimeout(timer);
                }
              } catch {
                return { ok: false, stage, reason: 'UNAVAILABLE', httpStatus };
              }
            },
            getTransactionsUrl(first.clone().add(month, 'months')),
            2_000_000,
          );
        } catch {
          throw new MaxDesktopError('transactionsRequest');
        }
        const data = desktopResponse(browserResult);
        if (!data || typeof data !== 'object' || Array.isArray(data))
          throw new MaxDesktopError('transactionsResponse', 200);
        const envelope = (data as ScrapedTransactionsResult).result;
        if (
          !envelope ||
          typeof envelope !== 'object' ||
          Array.isArray(envelope) ||
          !Array.isArray(envelope.transactions)
        )
          throw new MaxDesktopError('transactionsResponse', 200);
        if ((scanned += envelope.transactions.length) > limits.maxRows)
          throw new MaxDesktopError('transactionsValidation', 200);
        for (const raw of envelope.transactions) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            throw new MaxDesktopError('transactionsValidation', 200);
          // The ordinary Max parser skips summary rows without a plan type.
          // They still count toward the raw response budget above.
          if (!raw.planName) continue;
          const { accountNumber, transaction } = desktopTransaction(raw);
          if (!accounts.has(accountNumber)) accounts.set(accountNumber, []);
          if (accounts.size > limits.maxAccounts) throw new MaxDesktopError('transactionsValidation', 200);
          // Billing-month queries can include adjacent dates. Preserve the actual
          // settlement date; never invoke fixInstallments or guess a charge date.
          const day = transaction.processedDate.slice(0, 10);
          if (day >= limits.from && day <= limits.to) accounts.get(accountNumber)!.push(transaction);
        }
      }
      return { success: true, accounts: Array.from(accounts, ([accountNumber, txns]) => ({ accountNumber, txns })) };
    } catch (error) {
      if (error instanceof MaxDesktopError) throw error;
      throw new MaxDesktopError('transactionsValidation');
    }
  }

  getLoginOptions(credentials: ScraperSpecificCredentials): LoginOptions {
    return {
      loginUrl: LOGIN_URL,
      fields: createLoginFields(credentials),
      submitButtonSelector: 'app-user-login-form .general-button.send-me-code',
      preAction: async () => {
        if (await elementPresentOnPage(this.page, '#closePopup')) {
          await clickButton(this.page, '#closePopup');
        }
        await clickButton(this.page, '.personal-area > a.go-to-personal-area');
        if (await elementPresentOnPage(this.page, '.login-link#private')) {
          await clickButton(this.page, '.login-link#private');
        }
        // Try twice in case it can't find it the first time
        try {
          await waitUntilElementFound(this.page, '#login-password-link', true, 10000);
        } catch {
          await sleep(1000);
          await waitUntilElementFound(this.page, '#login-password-link', true, 10000);
        }
        await clickButton(this.page, '#login-password-link');
        await waitUntilElementFound(this.page, '#login-password.tab-pane.active app-user-login-form', true);
      },
      checkReadiness: async () => {
        await waitUntilElementFound(this.page, '.personal-area > a.go-to-personal-area', true);
      },
      postAction: async () => redirectOrDialog(this.page),
      possibleResults: getPossibleLoginResults(this.page),
      waitUntil: 'domcontentloaded',
    };
  }

  async fetchData() {
    const { allResults, homePageCards } = await fetchTransactions(this.page, this.options);
    const accounts: TransactionsAccount[] = Object.keys(allResults).map(accountNumber => {
      const card = homePageCards.get(accountNumber);
      return {
        accountNumber,
        txns: allResults[accountNumber],
        balance: card ? getCardBalance(card) : undefined,
        balanceDate: card ? getCardBalanceDate(card) : undefined,
        cardFrame: card?.CreditLimit ?? undefined,
      };
    });

    return {
      success: true,
      accounts,
    };
  }
}

export default MaxScraper;
