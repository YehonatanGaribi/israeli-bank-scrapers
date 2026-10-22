import { type Page } from 'puppeteer';

const JSON_CONTENT_TYPE = 'application/json';

function getJsonHeaders() {
  return {
    Accept: JSON_CONTENT_TYPE,
    'Content-Type': JSON_CONTENT_TYPE,
  };
}

function assertAutomationNotBlocked(status: number, responseText: string | null) {
  if (status === 429 || (responseText && /block automation|bot detection/i.test(responseText))) {
    throw new Error('PROVIDER_AUTOMATION_BLOCKED');
  }
}

export async function fetchGet<TResult>(url: string, extraHeaders: Record<string, any>): Promise<TResult> {
  let headers = getJsonHeaders();
  if (extraHeaders) {
    headers = Object.assign(headers, extraHeaders);
  }
  const request = {
    method: 'GET',
    headers,
    redirect: 'error' as const,
  };
  try {
    const fetchResult = await fetch(url, request);
    if (fetchResult.status !== 200) throw new Error();
    return await fetchResult.json();
  } catch {
    throw new Error('PROVIDER_REQUEST_FAILED');
  }
}

export async function fetchPost<TResult = any>(
  url: string,
  data: Record<string, any>,
  extraHeaders: Record<string, any> = {},
): Promise<TResult> {
  const request = {
    method: 'POST',
    headers: { ...getJsonHeaders(), ...extraHeaders },
    body: JSON.stringify(data),
    redirect: 'error' as const,
  };
  try {
    const result = await fetch(url, request);
    if (!result.ok) throw new Error();
    return await result.json();
  } catch {
    throw new Error('PROVIDER_REQUEST_FAILED');
  }
}

export async function fetchGraphql<TResult>(
  url: string,
  query: string,
  variables: Record<string, unknown> = {},
  extraHeaders: Record<string, any> = {},
): Promise<TResult> {
  const result = await fetchPost(url, { operationName: null, query, variables }, extraHeaders);
  if (result.errors?.length) {
    throw new Error('PROVIDER_GRAPHQL_FAILED');
  }
  return result.data as Promise<TResult>;
}

export async function fetchGetWithinPage<TResult>(
  page: Page,
  url: string,
  ignoreErrors = false,
): Promise<TResult | null> {
  const [result, status] = await page
    .evaluate(async innerUrl => {
      let response: Response | undefined;
      try {
        response = await fetch(innerUrl, { credentials: 'include' });
        if (response.status === 204) {
          return [null, response.status] as const;
        }
        return [await response.text(), response.status] as const;
      } catch (e) {
        throw new Error('PROVIDER_REQUEST_FAILED');
      }
    }, url)
    .catch(() => {
      throw new Error('PROVIDER_REQUEST_FAILED');
    });

  if (!ignoreErrors) {
    assertAutomationNotBlocked(status, result);
  }

  if (result !== null) {
    try {
      return JSON.parse(result);
    } catch (e) {
      if (!ignoreErrors) {
        throw new Error('PROVIDER_RESPONSE_INVALID');
      }
    }
  }
  return null;
}

export async function fetchPostWithinPage<TResult>(
  page: Page,
  url: string,
  data: Record<string, any>,
  extraHeaders: Record<string, any> = {},
  ignoreErrors = false,
): Promise<TResult | null> {
  const [resultText, status] = await page
    .evaluate(
      async (innerUrl: string, innerData: Record<string, any>, innerExtraHeaders: Record<string, any>) => {
        const response = await fetch(innerUrl, {
          method: 'POST',
          body: JSON.stringify(innerData),
          credentials: 'include',

          headers: Object.assign(
            { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            innerExtraHeaders,
          ),
        });
        if (response.status === 204) {
          return [null, response.status] as const;
        }
        return [await response.text(), response.status] as const;
      },
      url,
      data,
      extraHeaders,
    )
    .catch(() => {
      throw new Error('PROVIDER_REQUEST_FAILED');
    });

  if (!ignoreErrors) {
    assertAutomationNotBlocked(status, resultText);
  }

  try {
    if (resultText !== null) {
      return JSON.parse(resultText);
    }
  } catch (e) {
    if (!ignoreErrors) {
      throw new Error('PROVIDER_RESPONSE_INVALID');
    }
  }
  return null;
}
