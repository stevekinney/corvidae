import { describe, expect, test } from 'bun:test';

import { canonicalizeOrigin, createOriginPolicy } from './origin-policy.ts';

describe('canonicalizeOrigin', () => {
  test.each([
    ['https://example.com', 'https://example.com'],
    ['https://EXAMPLE.com', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['http://example.com:80/', 'http://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['  https://example.com  ', 'https://example.com'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ])('%s is %s', (input, expected) => {
    expect(canonicalizeOrigin(input)).toBe(expected);
  });

  test.each([
    '',
    '   ',
    'null',
    'NULL',
    'not a url',
    'file:///etc/passwd',
    'ftp://example.com',
    'chrome-extension://abc',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?query=1',
    'https://example.com#fragment',
    '*',
  ])('%j is not an origin', (input) => {
    expect(canonicalizeOrigin(input)).toBeUndefined();
  });
});

describe('createOriginPolicy', () => {
  const allowed = createOriginPolicy(['https://terminal.example', 'http://localhost:3000']);

  test('admits an allowlisted origin, whatever its case or default port', () => {
    expect(allowed('https://terminal.example')).toBe(true);
    expect(allowed('HTTPS://Terminal.Example:443')).toBe(true);
    expect(allowed('http://localhost:3000')).toBe(true);
  });

  test('denies an origin that is not listed, including one that only shares a prefix or suffix', () => {
    expect(allowed('https://evil.example')).toBe(false);
    expect(allowed('https://terminal.example.evil.example')).toBe(false);
    expect(allowed('https://evilterminal.example')).toBe(false);
    expect(allowed('http://terminal.example')).toBe(false);
    expect(allowed('http://localhost:3001')).toBe(false);
  });

  test('denies a missing, null or unparseable Origin', () => {
    expect(allowed(null)).toBe(false);
    expect(allowed('null')).toBe(false);
    expect(allowed('')).toBe(false);
    expect(allowed('garbage')).toBe(false);
  });

  test.each([
    ['an empty allowlist', []],
    ['a wildcard', ['*']],
    ['the literal null', ['null']],
    ['a value that is not an origin', ['terminal.example']],
    ['an origin with a path', ['https://terminal.example/app']],
  ])('refuses to build from %s', (_name, list) => {
    expect(() => createOriginPolicy(list)).toThrow(RangeError);
  });
});
