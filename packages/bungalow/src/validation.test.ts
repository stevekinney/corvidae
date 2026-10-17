import { describe, expect, test } from 'bun:test';

import { BungalowInputError } from './errors.ts';
import { assertBungalowName, assertDirectoryName, assertSecretKey } from './validation.ts';

describe('assertBungalowName', () => {
  test.each(['a', 'interborough', 'agent-bureau', 'a1', 'a-1-b'])('accepts %p', (name) => {
    expect(() => assertBungalowName(name)).not.toThrow();
  });

  test.each(['', '../x', 'Interborough', '1abc', '-abc', 'a_b', 'a b', 'a/b', 'a.b', 'ab\n'])(
    'rejects %p with a typed error',
    (name) => {
      expect(() => assertBungalowName(name)).toThrow(BungalowInputError);
    },
  );
});

describe('assertSecretKey', () => {
  test.each(['a', '1', 'api-key', '0-token', 'a1-b2'])('accepts %p', (key) => {
    expect(() => assertSecretKey(key)).not.toThrow();
  });

  test.each(['', '../x', '-key', 'Key', 'a_b', 'a.b', 'a/b', '.hidden', 'key\n'])(
    'rejects %p with a typed error',
    (key) => {
      expect(() => assertSecretKey(key)).toThrow(BungalowInputError);
    },
  );

  test('does not echo the rejected key', () => {
    expect(() => assertSecretKey('Sentinel-Value')).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('Sentinel-Value') }),
    );
  });
});

describe('assertDirectoryName', () => {
  test.each(['agents', 'workflows', '0'])('accepts %p', (name) => {
    expect(() => assertDirectoryName(name)).not.toThrow();
  });

  test.each(['../x', 'Agents', '', 'a/b'])('rejects %p', (name) => {
    expect(() => assertDirectoryName(name)).toThrow(BungalowInputError);
  });

  test.each(['secrets', 'logs', 'lock', 'deployment-id'])(
    'rejects the entry Bungalow owns: %p',
    (name) => {
      expect(() => assertDirectoryName(name)).toThrow(BungalowInputError);
    },
  );
});
