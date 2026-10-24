/* Synthetic callbacks intentionally return already-resolved promises. */
/* eslint-disable @typescript-eslint/require-await */
import https from 'node:https';
import { type IncomingMessage } from 'node:http';
import { type AddressInfo, type Socket } from 'node:net';
import { type TLSSocket } from 'node:tls';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createOneZeroHttpsClient } from './one-zero-https';
import OneZeroScraper, { ONE_ZERO_ENDPOINTS } from '../scrapers/one-zero';
import { CompanyTypes } from '../definitions';
import * as scopedTransport from './one-zero-https';

const secret = 'SYNTHETIC_ONE_ZERO_CANARY';
const execute = promisify(execFile);
async function identity() {
  const directory = await mkdtemp(join(tmpdir(), 'one-zero-mtls-'));
  const run = async (args: string[]) => {
    try {
      await execute('openssl', args, { cwd: directory, timeout: 15_000, maxBuffer: 16_384 });
    } catch {
      throw new Error('SYNTHETIC_TLS_SETUP_FAILED');
    }
  };
  try {
    await run([
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      'ca.key',
      '-out',
      'ca.pem',
      '-days',
      '1',
      '-subj',
      '/CN=Synthetic test CA',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
    ]);
    for (const kind of ['server', 'client']) {
      await writeFile(
        join(directory, `${kind}.ext`),
        kind === 'server'
          ? 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:identity.tfd-bank.com,DNS:mobile.tfd-bank.com\n'
          : 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n',
        { mode: 0o600 },
      );
      await run([
        'req',
        '-new',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        `${kind}.key`,
        '-out',
        `${kind}.csr`,
        '-subj',
        `/CN=Synthetic ${kind}`,
      ]);
      await run([
        'x509',
        '-req',
        '-in',
        `${kind}.csr`,
        '-CA',
        'ca.pem',
        '-CAkey',
        'ca.key',
        '-CAcreateserial',
        '-out',
        `${kind}.pem`,
        '-days',
        '1',
        '-extfile',
        `${kind}.ext`,
      ]);
    }
    const [ca, serverKey, serverCert, clientKey, clientCert] = await Promise.all(
      ['ca.pem', 'server.key', 'server.pem', 'client.key', 'client.pem'].map(name => readFile(join(directory, name))),
    );
    return { ca, serverKey, serverCert, clientKey, clientCert };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('ONE ZERO scoped fallback performs mutual TLS and rejects unsafe or incomplete responses with fixed errors', async () => {
  const material = await identity();
  let mode = 'ok';
  const seen: Array<{
    path: string | undefined;
    host: string | undefined;
    body: string;
    authorized: boolean;
    bearer: string | undefined;
  }> = [];
  const sockets = new Set<Socket>();
  const server = https.createServer(
    {
      key: material.serverKey,
      cert: material.serverCert,
      ca: material.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => {
      let body = '';
      req.on('data', chunk => {
        body += String(chunk);
      });
      req.on('end', () => {
        seen.push({
          path: req.url,
          host: req.headers.host,
          body,
          authorized: (req.socket as TLSSocket).authorized,
          bearer: req.headers.authorization,
        });
        if (mode === 'stall') return;
        if (mode === 'redirect') {
          res.writeHead(302, { Location: 'https://unapproved.invalid' });
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json; charset="utf-8"');
        if (mode === 'status') {
          res.statusCode = 403;
          res.end(JSON.stringify({ secret }));
          return;
        }
        if (mode === 'compressed') {
          res.setHeader('Content-Encoding', 'gzip');
          res.end('{}');
          return;
        }
        if (mode === 'large') {
          res.end(JSON.stringify({ text: 'x'.repeat(1_000_000) }));
          return;
        }
        if (mode === 'chunked') {
          res.setHeader('Transfer-Encoding', 'chunked');
          for (let i = 0; i < 62; i++) res.write(' '.repeat(16_384));
          res.end('{}');
          return;
        }
        if (mode === 'truncated') {
          res.setHeader('Content-Length', '200');
          res.flushHeaders();
          res.write('{}');
          setImmediate(() => res.socket?.end());
          return;
        }
        if (mode === 'utf8') {
          res.end(Buffer.from([0xff]));
          return;
        }
        if (mode === 'json') {
          res.end(secret);
          return;
        }
        if (mode === 'html') {
          res.setHeader('Content-Type', 'text/html');
          res.end(secret);
          return;
        }
        if (mode === 'headers') {
          res.setHeader('X-Oversize', 'x'.repeat(17_000));
          res.end('{}');
          return;
        }
        if (mode === 'dribble') {
          const timer = setInterval(() => res.write(' '), 10);
          res.once('close', () => clearInterval(timer));
          return;
        }
        res.end('{"accepted":true}');
      });
    },
  );
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => undefined);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const original = https.request;
  const calls: Array<{ url: string; options: https.RequestOptions }> = [];
  const spy = jest.spyOn(https, 'request').mockImplementation(((
    url: string,
    options: https.RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => {
    calls.push({ url, options });
    // Only this synthetic test redirects the already-validated fixed bank URL.
    return original(
      url,
      {
        ...options,
        hostname: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        servername: new URL(url).hostname,
        headers: { ...options.headers, Host: new URL(url).hostname },
      },
      callback,
    );
  }) as typeof https.request);
  const clientCertificate = { cert: material.clientCert, key: material.clientKey };
  const client = createOneZeroHttpsClient({ ca: material.ca, clientCertificate, timeoutMs: 2_000 });
  const failure = { message: 'PROVIDER_REQUEST_FAILED' };
  try {
    for (const url of new Set(Object.values(ONE_ZERO_ENDPOINTS))) {
      const authorization = url === ONE_ZERO_ENDPOINTS.customer ? `Bearer ${secret}` : undefined;
      await expect(client.request(url, { secret }, authorization)).resolves.toEqual({ accepted: true });
      expect(seen.at(-1)?.authorized).toBe(true);
      expect(seen.at(-1)?.path).toBe(new URL(url).pathname);
      expect(seen.at(-1)?.host).toBe(new URL(url).hostname);
      expect(seen.at(-1)?.bearer).toBe(authorization);
      expect(calls.at(-1)?.options).toMatchObject({
        method: 'POST',
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        maxHeaderSize: 16_384,
      });
    }
    const before = calls.length;
    for (const url of [
      'https://unapproved.invalid',
      `${ONE_ZERO_ENDPOINTS.deviceToken}?extra=1`,
      'http://identity.tfd-bank.com/v1/devices/token',
    ])
      await expect(client.request(url, { secret })).rejects.toMatchObject(failure);
    await expect(client.request(ONE_ZERO_ENDPOINTS.deviceToken, { text: 'x'.repeat(65_536) })).rejects.toMatchObject(
      failure,
    );
    await expect(
      client.request(ONE_ZERO_ENDPOINTS.customer, {}, `Bearer ${secret}\r\nOther: bad`),
    ).rejects.toMatchObject(failure);
    await expect(client.request(ONE_ZERO_ENDPOINTS.customer, {})).rejects.toMatchObject(failure);
    await expect(client.request(ONE_ZERO_ENDPOINTS.deviceToken, {}, `Bearer ${secret}`)).rejects.toMatchObject(failure);
    expect(calls).toHaveLength(before);
    for (mode of [
      'redirect',
      'status',
      'compressed',
      'large',
      'chunked',
      'truncated',
      'utf8',
      'json',
      'html',
      'headers',
    ]) {
      const count = calls.length;
      try {
        await client.request(ONE_ZERO_ENDPOINTS.deviceToken, { secret });
        throw new Error('EXPECTED_FAILURE');
      } catch (error) {
        expect(error).toMatchObject(failure);
        expect(String(error)).not.toContain(secret);
        expect(Object.hasOwn(error as object, 'cause')).toBe(false);
      }
      expect(calls).toHaveLength(count + 1);
    }
    mode = 'ok';
    for (const configuration of [
      { ca: material.ca, clientCertificate: { cert: '', key: '' } },
      { ca: material.ca, clientCertificate: { cert: material.clientCert, key: material.serverKey } },
      { clientCertificate },
    ]) {
      const count = seen.length;
      await expect(
        createOneZeroHttpsClient({ ...configuration, timeoutMs: 500 }).request(ONE_ZERO_ENDPOINTS.deviceToken, {
          secret,
        }),
      ).rejects.toMatchObject(failure);
      expect(seen).toHaveLength(count);
    }
    for (mode of ['stall', 'dribble']) {
      const started = Date.now();
      await expect(
        createOneZeroHttpsClient({ ca: material.ca, clientCertificate, timeoutMs: 100 }).request(
          ONE_ZERO_ENDPOINTS.deviceToken,
          { secret },
        ),
      ).rejects.toMatchObject(failure);
      expect(Date.now() - started).toBeLessThan(1_000);
    }
  } finally {
    spy.mockRestore();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 30_000);

test('ordinary ONE ZERO login and GraphQL fetching use only the scoped client-authenticated helper', async () => {
  const spy = jest.spyOn(scopedTransport, 'fetchOneZeroPost').mockImplementation(async (url, body) => {
    const field = new Map<string, string>([
      [ONE_ZERO_ENDPOINTS.deviceToken, 'deviceToken'],
      [ONE_ZERO_ENDPOINTS.prepareOtp, 'otpContext'],
      [ONE_ZERO_ENDPOINTS.verifyOtp, 'otpToken'],
      [ONE_ZERO_ENDPOINTS.idToken, 'idToken'],
      [ONE_ZERO_ENDPOINTS.sessionToken, 'accessToken'],
    ]).get(url);
    if (field) return { resultData: { [field]: `${field}_${secret}` } };
    const query = (body as { query: string }).query;
    if (query.includes('movements('))
      return { data: { movements: { movements: [], pagination: { hasMore: false, cursor: null } } } };
    return {
      data: {
        customer: [
          {
            portfolios: [
              {
                portfolioId: 'synthetic-portfolio',
                portfolioNum: 'synthetic',
                accounts: [{ accountId: 'synthetic-account' }],
              },
            ],
          },
        ],
      },
    };
  });
  const scraper = new OneZeroScraper({ companyId: CompanyTypes.oneZero, startDate: new Date('2026-10-01') });
  try {
    await expect(
      scraper.login({
        email: 'synthetic@example.invalid',
        password: secret,
        phoneNumber: '+972501234567',
        otpCodeRetriever: async () => '123456',
      }),
    ).resolves.toEqual({ success: true });
    await expect(scraper.fetchData()).resolves.toMatchObject({ success: true, accounts: [{ txns: [] }] });
    expect(spy.mock.calls.map(call => call[0])).toEqual([
      ONE_ZERO_ENDPOINTS.deviceToken,
      ONE_ZERO_ENDPOINTS.prepareOtp,
      ONE_ZERO_ENDPOINTS.verifyOtp,
      ONE_ZERO_ENDPOINTS.idToken,
      ONE_ZERO_ENDPOINTS.sessionToken,
      ONE_ZERO_ENDPOINTS.customer,
      ONE_ZERO_ENDPOINTS.movements,
    ]);
    expect(spy.mock.calls.slice(0, 5).every(call => call[2] === undefined)).toBe(true);
    expect(spy.mock.calls.slice(5).every(call => call[2] === `Bearer accessToken_${secret}`)).toBe(true);
  } finally {
    scraper.dispose();
    spy.mockRestore();
  }
});
