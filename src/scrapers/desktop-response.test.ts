import { decode, field, payload, flag, suffix } from './desktop-response';
test('bounded decoding finds known payloads across wrappers without guessing conflicting responses', () => {
  const value = { cardsList: [{ cardSuffix: '1234' }] },
    matches = (x: unknown) => !!field(x, 'cardsList');
  expect(payload({ D: JSON.stringify({ Response: { Data: value, IsSuccess: 1, ErrorCode: 0 } }) }, matches)).toEqual(
    value,
  );
  expect(() => payload({ data: value, result: value }, matches)).toThrow('BANK_RESPONSE_AMBIGUOUS');
  expect(() => payload({ isSuccess: false, data: value }, matches)).toThrow('BANK_APPLICATION_REJECTED');
  expect(decode('not json')).toBe('not json');
  expect(field({ Purchase_Date: '2026-10-01' }, 'purchaseDate')).toBe('2026-10-01');
});
test('flags and four-digit identities tolerate only explicit equivalent formats', () => {
  expect(flag('false')).toBe(false);
  expect(flag('1')).toBe(true);
  expect(flag('maybe')).toBeUndefined();
  expect(suffix(12)).toBe('0012');
  expect(suffix('****1234')).toBe('1234');
  expect(suffix('account 1234')).toBeUndefined();
  expect(suffix(12345)).toBeUndefined();
});
