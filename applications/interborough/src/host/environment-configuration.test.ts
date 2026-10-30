import { describe, expect, test } from 'bun:test';

import { resolve } from 'node:path';

import {
  DEFAULT_BUILD_DIRECTORY,
  DEFAULT_PORT,
  resolveBuildDirectory,
  resolvePort,
} from './environment-configuration.ts';

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

describe('resolveBuildDirectory', () => {
  test('uses the fallback when the variable is absent or empty', () => {
    expect(resolveBuildDirectory({})).toBe(DEFAULT_BUILD_DIRECTORY);
    expect(resolveBuildDirectory({ INTERBOROUGH_BUILD_DIRECTORY: '' })).toBe(
      DEFAULT_BUILD_DIRECTORY,
    );
  });

  test('reads the named directory, resolving a relative one from the working directory', () => {
    expect(resolveBuildDirectory({ INTERBOROUGH_BUILD_DIRECTORY: '/somewhere/else' })).toBe(
      '/somewhere/else',
    );
    expect(resolveBuildDirectory({ INTERBOROUGH_BUILD_DIRECTORY: 'relative/build' })).toBe(
      resolve('relative/build'),
    );
  });
});
