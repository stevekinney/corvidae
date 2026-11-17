import { describe, expect, it } from 'bun:test';

import {
  createConstantTimeApiKeyEntry,
  createConstantTimeApiKeyMatcher,
  digestApiKey,
  findConstantTimeApiKeyMatch,
  findConstantTimeDigestMatch,
  type ConstantTimeApiKeyEntry,
} from './constant-time-api-key.ts';

describe('constant-time API key matching', () => {
  it('accepts valid keys and rejects invalid keys without depending on raw key length', async () => {
    const matcher = await createConstantTimeApiKeyMatcher(['alpha-key', 'beta-key-longer']);

    expect(await matcher.matches('alpha-key')).toBe(true);
    expect(await matcher.matches('beta-key-longer')).toBe(true);
    expect(await matcher.matches('a')).toBe(false);
    expect(await matcher.matches('beta-key-longer-but-wrong')).toBe(false);
  });

  it('returns the matched entry after scanning fixed-length digests', async () => {
    const registrations = [
      { key: 'first-key', value: { subject: 'first' } },
      { key: 'second-key', value: { subject: 'second' } },
      { key: 'third-key', value: { subject: 'third' } },
    ];
    const matcher = await createConstantTimeApiKeyMatcher(registrations);

    const second = await findConstantTimeApiKeyMatch('second-key', matcher.entries);
    expect(second?.value).toEqual({ subject: 'second' });
    expect(await findConstantTimeApiKeyMatch('missing-key', matcher.entries)).toBeNull();
  });

  it('digests a key to 32 bytes whatever its length, as SHA-256 of its UTF-8 bytes', async () => {
    const empty = await digestApiKey('');
    expect(empty.length).toBe(32);
    const long = await digestApiKey('x'.repeat(10_000));
    expect(long.length).toBe(32);
    // SHA-256 of the empty string.
    expect(Buffer.from(empty).toString('hex')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(Buffer.from(await digestApiKey('é')).toString('hex')).toBe(
      Buffer.from(await crypto.subtle.digest('SHA-256', new Uint8Array([0xc3, 0xa9]))).toString(
        'hex',
      ),
    );
  });
});

/** Wrap a digest so every indexed read of it is counted. */
function countingDigest(digest: Uint8Array, counter: { reads: number }): Uint8Array {
  return new Proxy(digest, {
    get(target, property) {
      if (typeof property === 'string' && /^\d+$/.test(property)) counter.reads += 1;
      return Reflect.get(target, property, target);
    },
  });
}

describe('findConstantTimeDigestMatch', () => {
  const keys = ['first-key', 'second-key', 'third-key'];
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly presented: string;
    readonly matches: string | null;
  }> = [
    { name: 'a first-entry match', presented: 'first-key', matches: 'first-key' },
    { name: 'a last-entry match', presented: 'third-key', matches: 'third-key' },
    { name: 'no match', presented: 'unknown-key', matches: null },
  ];

  for (const { name, presented, matches } of cases) {
    it(`reads every byte of every entry for ${name}`, async () => {
      const counter = { reads: 0 };
      const entries: ConstantTimeApiKeyEntry<string>[] = [];
      for (const key of keys) {
        const entry = await createConstantTimeApiKeyEntry(key, key);
        entries.push({ digest: countingDigest(entry.digest, counter), value: key });
      }

      const match = findConstantTimeDigestMatch(await digestApiKey(presented), entries);

      expect(match?.value ?? null).toBe(matches);
      expect(counter.reads).toBe(96);
    });
  }
});
