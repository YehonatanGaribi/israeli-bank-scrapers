import { createPrivateKey, X509Certificate } from 'node:crypto';
import { getOneZeroClientCertificate } from './one-zero-client-cert';

describe('pinned ONE ZERO client identity', () => {
  afterEach(() => jest.restoreAllMocks());

  test('has matching material and client authentication usage within its validity period', () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-23T12:00:00Z'));
    const material = getOneZeroClientCertificate();
    const certificate = new X509Certificate(material.cert);
    expect(Object.isFrozen(material)).toBe(true);
    expect(certificate.checkPrivateKey(createPrivateKey(material.key))).toBe(true);
    expect(certificate.ca).toBe(false);
    expect(certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2')).toBe(true);
  });

  test('unusable times fail with a fixed error and no material', () => {
    for (const time of [Date.parse('2026-08-05T16:24:59Z'), Date.parse('2027-08-05T16:25:00Z'), NaN]) {
      jest.spyOn(Date, 'now').mockReturnValue(time);
      expect(() => getOneZeroClientCertificate()).toThrow('ONE_ZERO_CLIENT_CERTIFICATE_UNAVAILABLE');
      jest.restoreAllMocks();
    }
  });
});
