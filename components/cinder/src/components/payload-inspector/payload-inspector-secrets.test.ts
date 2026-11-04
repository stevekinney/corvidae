import { describe, expect, test } from 'bun:test';

import {
  SECRET_MASK,
  SecretValue,
  looksSecret,
  maskSecrets,
  readSecretPaths,
  writeSecretsAsText,
} from './payload-inspector-secrets.ts';

describe('maskSecrets', () => {
  test('hides exactly the paths it is given', () => {
    const masked = maskSecrets(
      { orderId: 4471, authorization: 'Bearer abc', headers: { apiKey: 'k', accept: 'json' } },
      ['authorization', 'headers.apiKey'],
    ) as Record<string, unknown>;
    expect(masked['orderId']).toBe(4471);
    expect(masked['authorization']).toBeInstanceOf(SecretValue);
    expect((masked['headers'] as Record<string, unknown>)['apiKey']).toBeInstanceOf(SecretValue);
    expect((masked['headers'] as Record<string, unknown>)['accept']).toBe('json');
  });

  test('with paths, a key-name guess does not apply', () => {
    const masked = maskSecrets({ token: 'visible', other: 'x' }, ['other']) as Record<
      string,
      unknown
    >;
    expect(masked['token']).toBe('visible');
    expect(masked['other']).toBeInstanceOf(SecretValue);
  });

  test('a star stands for any key or array position', () => {
    const masked = maskSecrets({ attachments: [{ token: 't', name: 'n' }, { token: 'u' }] }, [
      'attachments.*.token',
    ]) as { attachments: Record<string, unknown>[] };
    expect(masked.attachments[0]?.['token']).toBeInstanceOf(SecretValue);
    expect(masked.attachments[1]?.['token']).toBeInstanceOf(SecretValue);
    expect(masked.attachments[0]?.['name']).toBe('n');
  });

  test('without paths, a property whose name reads as a secret is hidden', () => {
    const masked = maskSecrets({
      orderId: 4471,
      Authorization: 'x',
      apiKey: 'y',
      access_token: 'z',
      password: 'p',
      monkey: 'banana',
      keywords: ['a'],
    }) as Record<string, unknown>;
    expect(masked['orderId']).toBe(4471);
    for (const name of ['Authorization', 'apiKey', 'access_token', 'password']) {
      expect(masked[name]).toBeInstanceOf(SecretValue);
    }
    expect(masked['monkey']).toBe('banana');
    expect(masked['keywords']).toEqual(['a']);
  });

  test('hides an object or array whole, and keeps a stored __proto__ key as a property', () => {
    const hidden = maskSecrets({ credentials: { user: 'u', pass: 'p' } }) as Record<
      string,
      unknown
    >;
    expect(hidden['credentials']).toBeInstanceOf(SecretValue);
    const hostile = maskSecrets(
      JSON.parse('{"__proto__": {"polluted": true}, "a": 1}'),
      [],
    ) as object;
    expect(Object.keys(hostile)).toEqual(['__proto__', 'a']);
    expect(Object.getPrototypeOf(hostile)).toBe(Object.prototype);
  });

  test('serializes a secret as bullets, so JSON and Copy never hold the stored value', () => {
    const masked = maskSecrets({ token: 'super-secret' });
    expect(JSON.stringify(masked)).toBe(`{"token":"${SECRET_MASK}"}`);
    expect(JSON.stringify(masked)).not.toContain('super-secret');
    expect(writeSecretsAsText(masked)).toEqual({ token: SECRET_MASK });
  });

  test('hides what is nested past the depth limit instead of walking it', () => {
    let deep: unknown = 'leaf';
    for (let index = 0; index < 300; index += 1) deep = { child: deep };
    expect(JSON.stringify(maskSecrets(deep, []))).not.toContain('leaf');
  });
});

describe('looksSecret', () => {
  test('reads whole words of the name', () => {
    expect(looksSecret('apiKey')).toBe(true);
    expect(looksSecret('client-secret')).toBe(true);
    expect(looksSecret('Authorization')).toBe(true);
    expect(looksSecret('keyboard')).toBe(false);
    expect(looksSecret('orderId')).toBe(false);
  });
});

describe('readSecretPaths', () => {
  test('finds writeOnly, password and x-secret properties, through items and branches', () => {
    const paths = readSecretPaths({
      type: 'object',
      properties: {
        name: { type: 'string' },
        authorization: { type: 'string', writeOnly: true },
        password: { type: 'string', format: 'password' },
        headers: { type: 'object', properties: { apiKey: { 'x-secret': true } } },
        accounts: { type: 'array', items: { properties: { token: { writeOnly: true } } } },
        mixed: { allOf: [{ properties: { pin: { writeOnly: true } } }] },
      },
    });
    expect(paths.toSorted()).toEqual(
      ['accounts.*.token', 'authorization', 'headers.apiKey', 'mixed.pin', 'password'].toSorted(),
    );
  });

  test('is empty for anything that is not a schema', () => {
    expect(readSecretPaths(undefined)).toEqual([]);
    expect(readSecretPaths('x')).toEqual([]);
    expect(readSecretPaths({ type: 'string', writeOnly: true })).toEqual([]);
  });
});
