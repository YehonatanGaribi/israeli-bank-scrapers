import moment from 'moment/moment';
import { getDebug } from '../helpers/debug';
import { fetchOneZeroPost } from '../helpers/one-zero-https';
import { getRawTransaction } from '../helpers/transactions';
import {
  type Transaction as ScrapingTransaction,
  TransactionStatuses,
  TransactionTypes,
  type TransactionsAccount,
} from '../transactions';
import { BaseScraper } from './base-scraper';
import { ScraperErrorTypes, createGenericError } from './errors';
import {
  type ScraperGetLongTermTwoFactorTokenResult,
  type ScraperLoginResult,
  type ScraperScrapingResult,
  type ScraperTwoFactorAuthTriggerResult,
  type ScraperOptions,
} from './interface';
import { GET_CUSTOMER, GET_MOVEMENTS } from './one-zero-queries';

const HEBREW_WORDS_REGEX = /[\u0590-\u05FF][\u0590-\u05FF"'\-_ /\\]*[\u0590-\u05FF]/g;

const debug = getDebug('one-zero');

type Account = {
  accountId: string;
};

type Portfolio = {
  accounts: Array<Account>;
  portfolioId: string;
  portfolioNum: string;
};

type Customer = {
  customerId: string;
  portfolios?: Array<Portfolio> | null;
};

export type Category = {
  categoryId: number;
  dataSource: string;
  subCategoryId?: number | null;
};

export type Recurrence = {
  dataSource: string;
  isRecurrent: boolean;
};

type TransactionEnrichment = {
  categories?: Category[] | null;
  recurrences?: Recurrence[] | null;
};

type Transaction = {
  enrichment?: TransactionEnrichment | null;
  // TODO: Get installments information here
  // transactionDetails: TransactionDetails;
};

type Movement = {
  accountId: string;
  bankCurrencyAmount: string;
  bookingDate: string;
  conversionRate: string;
  creditDebit: string;
  description: string;
  isReversed: boolean;
  movementAmount: string;
  movementCurrency: string;
  movementId: string;
  movementReversedId?: string | null;
  movementTimestamp: string;
  movementType: string;
  portfolioId: string;
  runningBalance: string;
  transaction?: Transaction | null;
  valueDate: string;
};

type QueryPagination = { hasMore: boolean; cursor: string };

const IDENTITY_SERVER_URL = 'https://identity.tfd-bank.com/v1/';

const GRAPHQL_API_URL = 'https://mobile.tfd-bank.com/mobile-graph/graphql';

export const ONE_ZERO_ENDPOINTS = Object.freeze({
  deviceToken: `${IDENTITY_SERVER_URL}devices/token`,
  prepareOtp: `${IDENTITY_SERVER_URL}otp/prepare`,
  verifyOtp: `${IDENTITY_SERVER_URL}otp/verify`,
  idToken: `${IDENTITY_SERVER_URL}getIdToken`,
  sessionToken: `${IDENTITY_SERVER_URL}sessions/token`,
  customer: GRAPHQL_API_URL,
  movements: GRAPHQL_API_URL,
});
export type OneZeroOperation = keyof typeof ONE_ZERO_ENDPOINTS;
export interface OneZeroRuntime {
  signal: AbortSignal;
  request(
    operation: OneZeroOperation,
    body: unknown,
    authorization: string | undefined,
    signal: AbortSignal,
  ): Promise<unknown>;
}
export interface OneZeroDesktopData {
  customer: unknown;
  pages: Array<{ portfolioId: string; accountId: string; response: unknown }>;
}
// Desktop projection deliberately excludes names, identity numbers, balances,
// IBANs and portfolio numbers. The ordinary upstream query is retained separately.
export const DESKTOP_CUSTOMER_QUERY =
  'query GetCustomer { customer { customerId portfolios { portfolioId accounts { accountId currency } } } }';
export const DESKTOP_MOVEMENTS_QUERY = `query GetMovements($portfolioId: String!, $accountId: String!, $pagination: PaginationInput!, $language: BffLanguage!) {
  movements(portfolioId: $portfolioId, accountId: $accountId, pagination: $pagination, language: $language) {
    movements { accountId portfolioId movementId movementAmount movementCurrency creditDebit description bookingDate valueDate isReversed movementReversedId
      transaction { baseTransaction { originalAmount { instrumentAmount instrumentSymbol } } }
    }
    pagination { cursor hasMore }
  }
}`;
const invalid = () => new Error('PROVIDER_UNAVAILABLE');
function record(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}

type ScraperSpecificCredentials = { email: string; password: string } & (
  | {
      otpCodeRetriever: () => Promise<string>;
      phoneNumber: string;
    }
  | {
      otpLongTermToken: string;
    }
);

export default class OneZeroScraper extends BaseScraper<ScraperSpecificCredentials> {
  private otpContext?: string;

  private accessToken?: string;

  private disposed = false;

  private preparedDeviceToken?: string;

  private preparationGeneration = 0;

  private preparing = false;

  private authenticating = false;

  private triggering = false;

  constructor(
    options: ScraperOptions,
    private readonly runtime?: OneZeroRuntime,
  ) {
    super(options);
  }

  private clearPreparedConnection() {
    this.preparationGeneration++;
    this.preparedDeviceToken = undefined;
  }

  /** Anonymous worker-only availability check before collecting login fields.
   * The device token never leaves this instance and is consumed by one OTP flow.
   */
  async prepareDesktopConnection(): Promise<void> {
    if (
      !this.runtime ||
      this.disposed ||
      this.runtime.signal.aborted ||
      this.preparing ||
      this.authenticating ||
      this.triggering ||
      this.preparedDeviceToken !== undefined
    ) {
      this.clearPreparedConnection();
      throw invalid();
    }
    const generation = ++this.preparationGeneration;
    this.preparing = true;
    try {
      const response = await this.post('deviceToken', { extClientId: 'mobile', os: 'Android' });
      if (this.disposed || this.runtime.signal.aborted || generation !== this.preparationGeneration) throw invalid();
      this.preparedDeviceToken = response.resultData.deviceToken;
    } catch {
      this.clearPreparedConnection();
      throw invalid();
    } finally {
      this.preparing = false;
    }
  }

  private async post(operation: OneZeroOperation, body: Record<string, unknown>, authorization?: string): Promise<any> {
    if (this.disposed || this.runtime?.signal.aborted) throw invalid();
    try {
      const result = this.runtime
        ? await this.runtime.request(operation, body, authorization, this.runtime.signal)
        : await fetchOneZeroPost(ONE_ZERO_ENDPOINTS[operation], body, authorization);
      if (this.disposed || this.runtime?.signal.aborted) throw invalid();
      const tokenName = (
        {
          deviceToken: 'deviceToken',
          prepareOtp: 'otpContext',
          verifyOtp: 'otpToken',
          idToken: 'idToken',
          sessionToken: 'accessToken',
        } as Partial<Record<OneZeroOperation, string>>
      )[operation];
      if (tokenName) {
        const token: unknown = record(result) && record(result.resultData) ? result.resultData[tokenName] : undefined;
        if (typeof token !== 'string' || !token.length || token.length > 16_384 || /[\r\n\u0000]/.test(token))
          throw invalid();
      }
      return result;
    } catch {
      throw invalid();
    }
  }

  private async graph(
    operation: 'customer' | 'movements',
    query: string,
    variables: Record<string, unknown>,
  ): Promise<any> {
    if (!this.accessToken) throw invalid();
    const response = await this.post(
      operation,
      { operationName: null, query, variables },
      `Bearer ${this.accessToken}`,
    );
    if (
      !record(response) ||
      (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length)) ||
      !record(response.data)
    )
      throw invalid();
    return response.data;
  }

  async triggerTwoFactorAuth(phoneNumber: string): Promise<ScraperTwoFactorAuthTriggerResult> {
    if (this.disposed || this.runtime?.signal.aborted || this.preparing || this.triggering) {
      this.clearPreparedConnection();
      throw invalid();
    }
    this.triggering = true;
    try {
      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        return createGenericError(
          'A full international phone number starting with + and a three digit country code is required',
        );
      }

      let deviceToken = this.preparedDeviceToken;
      this.clearPreparedConnection();
      if (deviceToken === undefined) {
        debug('Fetching device token');
        const deviceTokenResponse = await this.post('deviceToken', { extClientId: 'mobile', os: 'Android' });
        deviceToken = deviceTokenResponse.resultData.deviceToken;
      }

      debug('Sending fresh OTP');

      const otpPrepareResponse = await this.post('prepareOtp', {
        factorValue: phoneNumber,
        deviceToken,
        otpChannel: 'SMS_OTP',
      });

      const {
        resultData: { otpContext },
      } = otpPrepareResponse;

      this.otpContext = otpContext;

      return {
        success: true,
      };
    } finally {
      this.preparedDeviceToken = undefined;
      this.triggering = false;
    }
  }

  public getLongTermTwoFactorToken(_otpCode: string): Promise<ScraperGetLongTermTwoFactorTokenResult> {
    void _otpCode;
    return Promise.resolve(createGenericError('PERSISTENT_TOKEN_DISABLED'));
  }

  private async verifyFreshOtp(otpCode: string): Promise<ScraperGetLongTermTwoFactorTokenResult> {
    if (!this.otpContext) {
      return createGenericError('triggerOtp was not called before calling getPermenantOtpToken()');
    }

    debug('Requesting OTP token');
    if (!/^\d{4,10}$/.test(otpCode)) throw invalid();
    const otpVerifyResponse = await this.post('verifyOtp', {
      otpContext: this.otpContext,
      otpCode,
    });

    const {
      resultData: { otpToken },
    } = otpVerifyResponse;
    this.otpContext = undefined;
    return { success: true, longTermTwoFactorAuthToken: otpToken };
  }

  private async resolveOtpToken(
    credentials: ScraperSpecificCredentials,
  ): Promise<ScraperGetLongTermTwoFactorTokenResult> {
    if ('otpLongTermToken' in credentials) {
      return createGenericError('PERSISTENT_TOKEN_DISABLED');
    }

    if (!credentials.otpCodeRetriever) {
      return {
        success: false,
        errorType: ScraperErrorTypes.TwoFactorRetrieverMissing,
        errorMessage: 'otpCodeRetriever is required when otpPermanentToken is not provided',
      };
    }

    if (!credentials.phoneNumber) {
      return createGenericError('phoneNumber is required when providing a otpCodeRetriever callback');
    }

    debug('Triggering user supplied otpCodeRetriever callback');
    const triggerResult = await this.triggerTwoFactorAuth(credentials.phoneNumber);

    if (triggerResult.success === false) {
      return triggerResult;
    }

    const otpCode = await credentials.otpCodeRetriever();

    const otpTokenResult = await this.verifyFreshOtp(otpCode);
    if (!otpTokenResult.success) {
      return otpTokenResult;
    }

    return { success: true, longTermTwoFactorAuthToken: otpTokenResult.longTermTwoFactorAuthToken };
  }

  async login(credentials: ScraperSpecificCredentials): Promise<ScraperLoginResult> {
    if (this.disposed || this.runtime?.signal.aborted || this.preparing || this.authenticating || this.triggering) {
      this.clearPreparedConnection();
      throw invalid();
    }
    this.authenticating = true;
    let success = false;
    try {
      this.accessToken = undefined;
      this.otpContext = undefined;
      const otpTokenResult = await this.resolveOtpToken(credentials);
      if (!otpTokenResult.success) {
        return otpTokenResult;
      }

      debug('Requesting id token');
      const getIdTokenResponse = await this.post('idToken', {
        otpSmsToken: otpTokenResult.longTermTwoFactorAuthToken,
        email: credentials.email,
        pass: credentials.password,
        pinCode: '',
      });

      const {
        resultData: { idToken },
      } = getIdTokenResponse;

      debug('Requesting session token');

      const getSessionTokenResponse = await this.post('sessionToken', {
        idToken,
        pass: credentials.password,
      });

      const {
        resultData: { accessToken },
      } = getSessionTokenResponse;

      this.accessToken = accessToken;
      success = true;

      return {
        success: true,
      };
    } finally {
      this.clearPreparedConnection();
      if (!success) {
        this.otpContext = undefined;
        this.accessToken = undefined;
      }
      this.authenticating = false;
    }
  }

  private async fetchPortfolioMovements(portfolio: Portfolio, startDate: Date): Promise<TransactionsAccount> {
    // TODO: Find out if we need the other accounts, there seems to always be one
    const account = portfolio.accounts[0];
    let cursor = null;
    const movements = [];

    while (!movements.length || new Date(movements[0].movementTimestamp) >= startDate) {
      debug('Fetching transactions');
      const {
        movements: { movements: newMovements, pagination },
      }: { movements: { movements: Movement[]; pagination: QueryPagination } } = await this.graph(
        'movements',
        GET_MOVEMENTS,
        {
          portfolioId: portfolio.portfolioId,
          accountId: account.accountId,
          language: 'HEBREW',
          pagination: {
            cursor,
            limit: 50,
          },
        },
      );

      movements.unshift(...newMovements);
      cursor = pagination.cursor;
      if (!pagination.hasMore) {
        break;
      }
    }

    movements.sort((x, y) => new Date(x.movementTimestamp).valueOf() - new Date(y.movementTimestamp).valueOf());

    const matchingMovements = movements.filter(movement => new Date(movement.movementTimestamp) >= startDate);
    return {
      accountNumber: portfolio.portfolioNum,
      balance: !movements.length ? 0 : parseFloat(movements[movements.length - 1].runningBalance),
      txns: matchingMovements.map((movement): ScrapingTransaction => {
        const hasInstallments = movement.transaction?.enrichment?.recurrences?.some(x => x.isRecurrent);
        const modifier = movement.creditDebit === 'DEBIT' ? -1 : 1;
        const result: ScrapingTransaction = {
          identifier: movement.movementId,
          date: movement.valueDate,
          chargedAmount: +movement.movementAmount * modifier,
          chargedCurrency: movement.movementCurrency,
          originalAmount: +movement.movementAmount * modifier,
          originalCurrency: movement.movementCurrency,
          description: this.sanitizeHebrew(movement.description),
          processedDate: movement.movementTimestamp,
          status: TransactionStatuses.Completed,
          type: hasInstallments ? TransactionTypes.Installments : TransactionTypes.Normal,
        };

        if (this.options?.includeRawTransaction) {
          result.rawTransaction = getRawTransaction(movement);
        }

        return result;
      }),
    };
  }

  /**
   * one zero hebrew strings are reversed with a unicode control character that forces display in LTR order
   * We need to remove the unicode control character, and then reverse hebrew substrings inside the string
   */
  private sanitizeHebrew(text: string) {
    if (!text.includes('\u202d')) {
      return text.trim();
    }

    const plainString = text.replace(/\u202d/gi, '').trim();
    const hebrewSubStringsRanges = [...plainString.matchAll(HEBREW_WORDS_REGEX)];
    const rangesToReverse = hebrewSubStringsRanges.map(str => ({ start: str.index!, end: str.index! + str[0].length }));
    const out = [];
    let index = 0;

    for (const { start, end } of rangesToReverse) {
      out.push(...plainString.substring(index, start));
      index += start - index;
      const reversed = [...plainString.substring(start, end)].reverse();
      out.push(...reversed);
      index += end - start;
    }

    out.push(...plainString.substring(index, plainString.length));

    return out.join('');
  }

  async fetchData(): Promise<ScraperScrapingResult> {
    if (!this.accessToken) {
      return createGenericError('login() was not called');
    }

    const defaultStartMoment = moment().subtract(1, 'years').add(1, 'day');
    const startDate = this.options.startDate || defaultStartMoment.toDate();
    const startMoment = moment.max(defaultStartMoment, moment(startDate));

    debug('Fetching account list');
    const result: { customer: Customer[] } = await this.graph('customer', GET_CUSTOMER, {});
    const portfolios = result.customer.flatMap(customer => customer.portfolios || []);

    return {
      success: true,
      accounts: await Promise.all(
        portfolios.map(portfolio => this.fetchPortfolioMovements(portfolio, startMoment.toDate())),
      ),
    };
  }

  /** Main desktop consumer calls this inside its confined worker, then normalizes
   * before crossing any process boundary. Raw values never leave that worker.
   * Bounds and cursor checks replace upstream's ordering-dependent pagination.
   */
  async fetchDesktopData(): Promise<OneZeroDesktopData> {
    if (!this.runtime || !this.accessToken || this.disposed) throw invalid();
    const { customer } = await this.graph('customer', DESKTOP_CUSTOMER_QUERY, {});
    if (!Array.isArray(customer) || customer.length > 20) throw invalid();
    const pages: OneZeroDesktopData['pages'] = [];
    const accounts = new Map<string, { portfolioId: string; accountId: string; currency: string }>();
    let scanned = 0;
    for (const person of customer) {
      if (!record(person) || !id(person.customerId) || (person.portfolios != null && !Array.isArray(person.portfolios)))
        throw invalid();
      const portfolios: unknown[] = person.portfolios ?? [];
      if (portfolios.length > 20) throw invalid();
      for (const portfolio of portfolios) {
        if (
          !record(portfolio) ||
          !id(portfolio.portfolioId) ||
          !Array.isArray(portfolio.accounts) ||
          portfolio.accounts.length > 20
        )
          throw invalid();
        for (const account of portfolio.accounts) {
          if (
            !record(account) ||
            !id(account.accountId) ||
            typeof account.currency !== 'string' ||
            !/^[A-Z]{3}$/.test(account.currency)
          )
            throw invalid();
          const key = JSON.stringify([portfolio.portfolioId, account.accountId]);
          if (accounts.has(key)) {
            if (accounts.get(key)!.currency !== account.currency) throw invalid();
            continue;
          }
          accounts.set(key, {
            portfolioId: portfolio.portfolioId,
            accountId: account.accountId,
            currency: account.currency,
          });
          if (accounts.size > 20) throw invalid();
        }
      }
    }
    for (const account of accounts.values()) {
      let cursor: string | null = null;
      const cursors = new Set<string>();
      for (;;) {
        if (pages.length >= 100) throw invalid();
        const response: unknown = await this.graph('movements', DESKTOP_MOVEMENTS_QUERY, {
          portfolioId: account.portfolioId,
          accountId: account.accountId,
          language: 'HEBREW',
          pagination: { cursor, limit: 50 },
        });
        if (
          !record(response) ||
          !record(response.movements) ||
          !Array.isArray(response.movements.movements) ||
          response.movements.movements.length > 50 ||
          !record(response.movements.pagination) ||
          typeof response.movements.pagination.hasMore !== 'boolean'
        )
          throw invalid();
        scanned += response.movements.movements.length;
        if (scanned > 5_000) throw invalid();
        pages.push({ portfolioId: account.portfolioId, accountId: account.accountId, response });
        const { pagination } = response.movements;
        if (!pagination.hasMore) break;
        if (!id(pagination.cursor) || cursors.has(pagination.cursor) || !response.movements.movements.length)
          throw invalid();
        cursors.add(pagination.cursor);
        cursor = pagination.cursor;
      }
    }
    return { customer, pages };
  }

  dispose() {
    this.disposed = true;
    this.clearPreparedConnection();
    this.otpContext = undefined;
    this.accessToken = undefined;
  }

  protected async terminate(success: boolean) {
    this.dispose();
    await super.terminate(success);
  }
}

// Named export is stable for ESM hosts consuming this CommonJS TypeScript source.
export { OneZeroScraper };
