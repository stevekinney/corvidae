import { describe, expect, test } from 'bun:test';

import { generateUlid, isUlid } from './ulid.ts';

const ten = (byte: number) => (bytes: Uint8Array) => bytes.fill(byte);

describe('generateUlid', () => {
  test('encodes the timestamp in the first ten characters, as the ULID specification does', () => {
    expect(generateUlid(1469918176385, ten(0)).slice(0, 10)).toBe('01ARYZ6S41');
    expect(generateUlid(0, ten(0))).toBe('0'.repeat(26));
  });

  test('encodes the largest timestamp and the largest random value without loss', () => {
    expect(generateUlid(2 ** 48 - 1, ten(0xff))).toBe('7ZZZZZZZZZ' + 'Z'.repeat(16));
  });

  test('spends all eighty random bits across sixteen characters', () => {
    const ramp = (bytes: Uint8Array) => bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 00000000 00000001 00000010 ... read five bits at a time.
    expect(generateUlid(0, ramp).slice(10)).toBe('000G40R40M30E209');
  });

  test('draws its random bytes from crypto by default and produces distinct values', () => {
    const first = generateUlid();
    const second = generateUlid();
    expect(isUlid(first)).toBe(true);
    expect(first).not.toBe(second);
  });

  test('sorts by creation time', () => {
    expect(generateUlid(1000, ten(0xff)) < generateUlid(1001, ten(0))).toBe(true);
  });

  test('rejects a timestamp outside 48 bits', () => {
    expect(() => generateUlid(-1)).toThrow(RangeError);
    expect(() => generateUlid(2 ** 48)).toThrow(RangeError);
    expect(() => generateUlid(1.5)).toThrow(RangeError);
  });
});

describe('isUlid', () => {
  test('accepts 26 Crockford characters whose timestamp fits in 48 bits', () => {
    expect(isUlid('01ARYZ6S41TSV4RRFFQ69G5FAV')).toBe(true);
  });

  test.each([
    '',
    '01ARYZ6S41TSV4RRFFQ69G5FA',
    '81ARYZ6S41TSV4RRFFQ69G5FAV',
    '01ARYZ6S41TSV4RRFFQ69G5FAI',
    '01aryz6s41tsv4rrffq69g5fav',
  ])('rejects %p', (value) => {
    expect(isUlid(value)).toBe(false);
  });
});
