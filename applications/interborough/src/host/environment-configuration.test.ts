import { describe, expect, test } from 'bun:test';

import { DEFAULT_PORT, resolvePort } from './environment-configuration.ts';

describe('resolvePort', () => {
  test('uses the default port when the variable is absent or empty', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(resolvePort({ INTERBOROUGH_PORT: '' })).toBe(DEFAULT_PORT);
  });

  test('reads a whole-number port, including 0 for an ephemeral one', () => {
    expect(resolvePort({ INTERBOROUGH_PORT: '8080' })).toBe(8080);
    expect(resolvePort({ INTERBOROUGH_PORT: '0' })).toBe(0);
    expect(resolvePort({ INTERBOROUGH_PORT: '65535' })).toBe(65_535);
  });

  test.each(['65536', '-1', '80.5', 'abc', ' 80', '1e3', '123456'])(
    'refuses %p rather than falling back to the default',
    (value) => {
      expect(() => resolvePort({ INTERBOROUGH_PORT: value })).toThrow('INTERBOROUGH_PORT');
    },
  );
});
