import { type Page, type HTTPResponse } from 'puppeteer';

export interface IsracardWireResponse {
  ok: boolean;
  httpStatus: number | null;
  data?: unknown;
}
const ROOT = 'https://web.isracard.co.il';
const PREFIX = '/ocp/transactions/DigitalV3.Transactions/';
/** Observe the bank's own card-list request after its current Transactions page
 * initializes. Never observe authentication endpoints, headers or request bodies. */
export async function nativeIsracardCards(page: Page): Promise<IsracardWireResponse | undefined> {
  if (typeof page.goto !== 'function' || typeof page.on !== 'function' || typeof page.off !== 'function')
    return undefined;
  let finish!: (value: IsracardWireResponse | undefined) => void;
  let started = false;
  const response = new Promise<IsracardWireResponse | undefined>(resolve => {
    finish = resolve;
  });
  const timer = setTimeout(() => finish(undefined), 15000);
  const observe = (item: HTTPResponse) => {
    try {
      const address = new URL(item.url());
      if (
        started ||
        address.origin !== ROOT ||
        address.pathname !== `${PREFIX}GetCardList` ||
        item.request().method() !== 'POST'
      )
        return;
      started = true;
      void item.text().then(
        data =>
          finish(
            data.length <= 2_000_000
              ? { ok: item.ok(), httpStatus: item.status(), data }
              : { ok: false, httpStatus: item.status() },
          ),
        () => finish({ ok: false, httpStatus: item.status() }),
      );
    } catch {
      finish(undefined);
    }
  };
  page.on('response', observe);
  try {
    await page.goto(`${ROOT}/Transactions`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return await response;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    page.off('response', observe);
  }
}
/** Same-origin read-only RPC, using XHR as the site's Axios client does. Raw
 * response text is bounded and retained only in the confined worker's memory. */
export async function isracardWebRequest(
  page: Page,
  operation: string,
  body: Record<string, unknown>,
): Promise<IsracardWireResponse> {
  try {
    return await page.evaluate(
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
        return new Promise<{ ok: boolean; httpStatus: number | null; data?: string }>(resolve => {
          const xhr = new XMLHttpRequest();
          let done = false;
          const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            let status: number | null = null;
            try {
              status = xhr.status || null;
            } catch {}
            let data = '';
            try {
              data = xhr.responseText;
            } catch {}
            resolve(
              ok && data.length <= 2_000_000
                ? { ok: true, httpStatus: status, data }
                : { ok: false, httpStatus: status },
            );
          };
          try {
            xhr.open('POST', address, true);
            xhr.timeout = 15000;
            xhr.withCredentials = true;
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.setRequestHeader('TraceIdentifier', crypto.randomUUID());
            const csrf = document.cookie
              .split(';')
              .map(part => part.trim())
              .find(part => part.startsWith('XSRF-TOKEN='));
            if (csrf) xhr.setRequestHeader('X-XSRF-TOKEN', decodeURIComponent(csrf.slice('XSRF-TOKEN='.length)));
            xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300);
            xhr.onerror = () => finish(false);
            xhr.ontimeout = () => finish(false);
            xhr.onabort = () => finish(false);
            xhr.onprogress = event => {
              if (event.loaded > 2_000_000) {
                finish(false);
                xhr.abort();
              }
            };
            xhr.send(JSON.stringify(payload));
          } catch {
            finish(false);
          }
        });
      },
      ROOT + PREFIX + operation,
      body,
    );
  } catch {
    return { ok: false, httpStatus: null };
  }
}
