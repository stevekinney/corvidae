import { describe, expect, test } from 'bun:test';

import { resolve } from 'node:path';

import {
  DEFAULT_BUILD_DIRECTORY,
  DEFAULT_PORT,
  PUBLIC_ORIGIN_VARIABLE,
  RENAMED_PUBLIC_ORIGIN_VARIABLE,
  resolveBuildDirectory,
  resolvePort,
  resolvePublicOrigin,
} from './environment-configuration.ts';

describe('resolvePublicOrigin (COR-2169)', () => {
  test('is named INTERBOROUGH_PUBLIC_ORIGIN, and is read as an https origin', () => {
    expect(PUBLIC_ORIGIN_VARIABLE).toBe('INTERBOROUGH_PUBLIC_ORIGIN');
    expect(
      resolvePublicOrigin({ INTERBOROUGH_PUBLIC_ORIGIN: 'https://hooks.example.test' }),
    ).toEqual(new URL('https://hooks.example.test'));
    expect(resolvePublicOrigin({})).toBeUndefined();
    expect(resolvePublicOrigin({ INTERBOROUGH_PUBLIC_ORIGIN: '' })).toBeUndefined();
  });

  test.each(['http://hooks.example.test', 'https://hooks.example.test/path', 'not a url'])(
    'refuses %p, naming the variable and never echoing the value',
    (value) => {
      let message = '';
      try {
        resolvePublicOrigin({ INTERBOROUGH_PUBLIC_ORIGIN: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('INTERBOROUGH_PUBLIC_ORIGIN');
      expect(message).not.toContain(value);
    },
  );

  test('refuses the old name with a renamed-to message, whatever the new name holds, and never echoes it', () => {
    expect(RENAMED_PUBLIC_ORIGIN_VARIABLE).toBe('INTERBOROUGH_A2A_PUBLIC_ORIGIN');
    const secret = 'https://user:password-canary@hooks.example.test';
    for (const environment of [
      { INTERBOROUGH_A2A_PUBLIC_ORIGIN: secret },
      {
        INTERBOROUGH_A2A_PUBLIC_ORIGIN: secret,
        INTERBOROUGH_PUBLIC_ORIGIN: 'https://ok.example.test',
      },
    ]) {
      let message = '';
      try {
        resolvePublicOrigin(environment);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(
        'INTERBOROUGH_A2A_PUBLIC_ORIGIN was renamed to INTERBOROUGH_PUBLIC_ORIGIN',
      );
      expect(message).not.toContain('password-canary');
    }
    // An empty old variable says nothing, as an empty new one does.
    expect(resolvePublicOrigin({ INTERBOROUGH_A2A_PUBLIC_ORIGIN: '' })).toBeUndefined();
  });
});

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
