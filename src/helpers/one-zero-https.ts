import https from 'node:https';
import { getOneZeroClientCertificate } from '../scrapers/one-zero-client-cert';

// Deliberately independent of the scraper module to avoid an import cycle.
const URLS = new Set([
  'https://identity.tfd-bank.com/v1/devices/token',
  'https://identity.tfd-bank.com/v1/otp/prepare',
  'https://identity.tfd-bank.com/v1/otp/verify',
  'https://identity.tfd-bank.com/v1/getIdToken',
  'https://identity.tfd-bank.com/v1/sessions/token',
  'https://mobile.tfd-bank.com/mobile-graph/graphql',
]);
const GRAPHQL_URL = 'https://mobile.tfd-bank.com/mobile-graph/graphql';
const MAX_RESPONSE_BYTES = 1_000_000;
const unavailable = () => new Error('PROVIDER_REQUEST_FAILED');
interface ClientCertificate {
  readonly cert: string | Buffer;
  readonly key: string | Buffer;
}

/** ONE ZERO-only fallback. Synthetic trust/client material and a shorter deadline
 * are trusted in-process test seams, never scraper credentials or remote input.
 * The confined desktop runtime uses its own transport instead of this helper.
 */
export function createOneZeroHttpsClient({
  ca,
  clientCertificate,
  timeoutMs = 20_000,
}: { ca?: Buffer; clientCertificate?: ClientCertificate; timeoutMs?: number } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20_000) throw unavailable();
  return {
    async request(url: string, body: unknown, authorization?: string): Promise<unknown> {
      let payload: Buffer | undefined;
      let request: ReturnType<typeof https.request> | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunks: Buffer[] = [];
      try {
        if (typeof url !== 'string' || !URLS.has(url)) throw unavailable();
        if (
          url === GRAPHQL_URL
            ? typeof authorization !== 'string' || !/^Bearer [^\r\n\u0000]{1,16384}$/.test(authorization)
            : authorization !== undefined
        )
          throw unavailable();
        const encoded = JSON.stringify(body);
        if (typeof encoded !== 'string' || Buffer.byteLength(encoded) > 65_536) throw unavailable();
        payload = Buffer.from(encoded);
        const material = clientCertificate ?? getOneZeroClientCertificate();
        return await new Promise<unknown>((resolve, reject) => {
          let settled = false;
          let bytes = 0;
          const fail = () => {
            if (settled) return;
            settled = true;
            request?.destroy();
            reject(unavailable());
          };
          timer = setTimeout(fail, timeoutMs);
          request = https.request(
            url,
            {
              method: 'POST',
              agent: false,
              maxHeaderSize: 16_384,
              rejectUnauthorized: true,
              minVersion: 'TLSv1.2',
              cert: material.cert,
              key: material.key,
              ...(ca ? { ca } : {}),
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'Accept-Encoding': 'identity',
                'Content-Length': payload!.length,
                Connection: 'close',
                ...(authorization ? { Authorization: authorization } : {}),
              },
            },
            response => {
              const length = response.headers['content-length'];
              if (
                !response.statusCode ||
                response.statusCode < 200 ||
                response.statusCode >= 300 ||
                !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
                  response.headers['content-type'] ?? '',
                ) ||
                (response.headers['content-encoding'] !== undefined &&
                  response.headers['content-encoding'] !== 'identity') ||
                (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
              ) {
                response.destroy();
                fail();
                return;
              }
              response.on('error', fail);
              response.on('aborted', fail);
              response.on('close', () => {
                if (!response.complete) fail();
              });
              response.on('data', (chunk: Buffer) => {
                if (settled) return;
                bytes += chunk.length;
                if (bytes > MAX_RESPONSE_BYTES) {
                  response.destroy();
                  fail();
                  return;
                }
                chunks.push(chunk);
              });
              response.on('end', () => {
                if (settled) return;
                try {
                  if (!response.complete) throw unavailable();
                  const parsed: unknown = JSON.parse(
                    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
                  );
                  settled = true;
                  resolve(parsed);
                } catch {
                  fail();
                }
              });
            },
          );
          request.on('error', fail);
          request.end(payload);
        });
      } catch {
        throw unavailable();
      } finally {
        clearTimeout(timer);
        request?.destroy();
        payload?.fill(0);
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0;
      }
    },
  };
}

const client = createOneZeroHttpsClient();
export function fetchOneZeroPost(url: string, body: unknown, authorization?: string): Promise<unknown> {
  return client.request(url, body, authorization);
}
