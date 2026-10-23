import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';

/** Shared ONE ZERO application identity, not a customer's credential.
 * Adapted from eshaham/israeli-bank-scrapers PR #1172, reviewed commit
 * d046dbc3b5822a9716c66763fa7d3cf14a3adcd7 (MIT repository; see LICENSE).
 * Upstream source SHA256: 7d570d92fdbad0362fa9f032ffc1ea87e15cb0374c33f0eb84af579aef14fef6.
 * The author attributes this material to the bank's Android application. That
 * provenance and permission for reuse have not been independently established.
 * Never use it as a server trust root or expose it to bank pages/renderer APIs.
 */
const material: Readonly<{ cert: string; key: string }> = Object.freeze({
  cert: '\n-----BEGIN CERTIFICATE-----\nMIIESzCCAzOgAwIBAgIUP1unLlYE9CRqWSZRSGYLvhRwzQIwDQYJKoZIhvcNAQEL\nBQAwgagxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpDYWxpZm9ybmlhMRYwFAYDVQQH\nEw1TYW4gRnJhbmNpc2NvMRkwFwYDVQQKExBDbG91ZGZsYXJlLCBJbmMuMRswGQYD\nVQQLExJ3d3cuY2xvdWRmbGFyZS5jb20xNDAyBgNVBAMTK01hbmFnZWQgQ0EgYzY0\nMmM5MjRkNmM1M2IyY2QwZTQwMTYyM2VmMzc0ZTgwHhcNMjYwODA1MTYyNTAwWhcN\nMjcwODA1MTYyNTAwWjBYMQswCQYDVQQGEwJJTDERMA8GA1UECBMIVGVsIEF2aXYx\nETAPBgNVBAcTCFRlbCBBdml2MREwDwYDVQQKEwhPbmUgWmVybzEQMA4GA1UEAxMH\nT25lWmVybzCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKDtJasjinUb\nM8wyAwOztOJZoEs25Wbq4uZaZdW7ZMGonzW7lL3LQ2Tak/73w0bZntZIM2giuZOC\n1UHvYO2Zlz6Bkxurw4bU5x8HC6paN7cJdWel65QqjpYoo+5DNEP9nTUG4qVFnnJA\nIVMigpLxzlssd2pOk9paNv05pRVCfmzt/48fVnKdqHGHLN8mGAxCWdCzusLlbW/A\nvOF8afzSi1kPkpGRF4qO4AuKOm4sdIAtwI88j9jXEkHKqQf4+wHySQVtE/JL1bS0\nZAS3WyMlQ3c4JVjNQIZAPEOY2vwVEqbfkPE7yk2Pu32iVmZwirrLCX8y4KfeDYVf\nQ9HvLErMgDMCAwEAAaOBuzCBuDATBgNVHSUEDDAKBggrBgEFBQcDAjAMBgNVHRMB\nAf8EAjAAMB0GA1UdDgQWBBRJASGZpkX0hn97gmQMUC1maJTbvzAfBgNVHSMEGDAW\ngBRb2bm+RbDKax55a6XU8NEsj6csZTBTBgNVHR8ETDBKMEigRqBEhkJodHRwOi8v\nY3JsLmNsb3VkZmxhcmUuY29tLzk1OWJiMDg1LWFhYzQtNGZmNS1hY2ViLWQ0MjAy\nMmE2N2ZkYS5jcmwwDQYJKoZIhvcNAQELBQADggEBAIWsMrp6rJhc+xHWpTiEMcRO\nL5Is5OiKy5PlZP2oBa5K5/Dk9Q6C13sV8nW6Vjdp+l27YRlCwxUf1f7ke0G8GqkA\nvba+9Kvfx4+i4/FzTGZwq/ngstqw90muh0EHQm2wced19Wi0FdMal5CzjBzKsyMD\n1d0ccDTOqOJKXimSXFUCfXO0/P5hw5+3+ph7dN2BlTLVQTvEK0KwEs6BM0F/kvy3\n7gVz9ipSRdGtfOLQvaA2IPyLnXv+5Q16e8qHKPXmJ7tuGzbM2VpPhXjI28n9xi8g\n8AOfZA/xx3wOXuMk9CnOsnFAB/kbmDvwUDBJrcIRu+GptQ9Ebdfd2OztH91iN88=\n-----END CERTIFICATE-----\n\n',
  key: '\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAoO0lqyOKdRszzDIDA7O04lmgSzblZuri5lpl1btkwaifNbuU\nvctDZNqT/vfDRtme1kgzaCK5k4LVQe9g7ZmXPoGTG6vDhtTnHwcLqlo3twl1Z6Xr\nlCqOliij7kM0Q/2dNQbipUWeckAhUyKCkvHOWyx3ak6T2lo2/TmlFUJ+bO3/jx9W\ncp2ocYcs3yYYDEJZ0LO6wuVtb8C84Xxp/NKLWQ+SkZEXio7gC4o6bix0gC3AjzyP\n2NcSQcqpB/j7AfJJBW0T8kvVtLRkBLdbIyVDdzglWM1AhkA8Q5ja/BUSpt+Q8TvK\nTY+7faJWZnCKussJfzLgp94NhV9D0e8sSsyAMwIDAQABAoIBABZ+RJHw4XfQOeOP\nE1LKJJIFewfoVWpBkejRYS3dso31tsM47pJqEzJz8X8QPIWZAhWWI/FTS+MYGhzM\nNnJ00b9qjG2wCsq8KXiccH9QJZIk9U8WfEt1I1b5DpN4EJnMR36o8WGueHYkYUQQ\ngnXC7K1bwBk7gHkNu7qV+xgcojUxWhEZW7An/ZsaMOOhSvr+ML1w50TstnLVx8SQ\nSGWFaun6gr3T0ld13Y5ffrT7fapiZ2ROmDT0wxkXisaxRuSbWCWLs0dH4IPpz/X2\nWbazFvRL8fzckHekEl7WZpL1jPlC1+FP9txwrtba1FXC8ynplGhgRhE/tejVbvWn\nz1trIBECgYEA3A7yDyPQ6iJrZrgCoC7Z7+ZcqyzufIm1dtuHY8TFziIdgUEqLiLg\nUbdtjL7uq98HKxoeu9Um3SjZkjkrQDl2IHjj1uqd1DlEntyzQufaiTVG+pPwzzji\nuSrQ8/MJvtu4iKNM49laQ9d9ZPgikm3nO+X0/fMLKXIMSD6EXZ7e9/kCgYEAuzXH\nz3olA8Dwyty699yOLVGhnKCv8j5NYNel8iZDJfTnvpnzc0t8vtGLTrMLvcCgPdWb\nbKSruaItyI9mkl3HP5lBjQ9qpD+5Z1FnzsvA1ukhcQXUrtDzXuPPUyQq5kazOigi\nmLbAyrp9RuTFf+Hjup1jAT8lniDsr3TI7ljpvIsCgYBTvixHrq2WLDsLAAOfybSO\nIvApBBRNuGoiLTC8uuk7pKftxEq0+/i5oEBES3SwW1NzB6GigV8k0qLZjn/zFOrr\nOJYb93TQimqeugZN88WqaWf1e88sTM2bAbw62cZfp2X2OY7NNq2vG5ZQkk01xDU3\nCi/NZGxe/VPHOmNM7WSUoQKBgC3FRVfVni0fw/9lHhUxiFVOKvwXUU0hrFtr/feJ\nIUurZ+lyzFG4+APTSYLxRYKcENFtYzWZwR5+p0DsxoAsi2ViO+OYDFOh/NtkzMOD\nj1872mA+s7QWBBqEChFiu1ZXnMQwQd0ieVpXY/+sORk+CiZ7ClSosrLJi/SN0f5s\nIKFnAoGBAJp6Pk6ZbEfJKqU6xVbNOSXNX0OX/GEylYH5zz3V14lGnjooP7VgS9sT\nyTM58Abypbp18nSt/BczcO6cYBO0i8aOXwCJ4Mklsta51p1beVxmnytZhqhDTa6i\n3iZz+LQgAu7JH+G1xLcNsxilhQh0ivjnIRn+O+KSkS6lXlD+GIT2\n-----END RSA PRIVATE KEY-----\n\n',
});

/** Validate every connection attempt so expiration stops use without silently
 * changing identity or weakening normal server TLS verification. No material or
 * raw crypto errors are included in failures or declarations.
 */
export function getOneZeroClientCertificate(): Readonly<{ cert: string; key: string }> {
  try {
    const certificate = new X509Certificate(material.cert);
    const now = Date.now();
    if (
      !Number.isFinite(now) ||
      now < Date.parse(certificate.validFrom) ||
      now >= Date.parse(certificate.validTo) ||
      certificate.ca ||
      !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.2') ||
      createHash('sha256').update(certificate.raw).digest('hex') !==
        '4597998ea0dd2be7c7e3f62a865674f4fb4384a8724545c76533fc54fc641162' ||
      !certificate.checkPrivateKey(createPrivateKey(material.key))
    )
      throw new Error();
    return material;
  } catch {
    throw new Error('ONE_ZERO_CLIENT_CERTIFICATE_UNAVAILABLE');
  }
}
