/**
 * Regression tests for LMDB ranges that cover non-ASCII keys.
 *
 * `ordered-binary@1.6.1` builds its Bun string decoder with `new Function`, and
 * that decoder referenced `finishUtf8`, which is not in scope there. Every
 * range read that decoded a non-ASCII key (`scan`, `keys`, and the
 * `deletePrefix`/`deleteRange` operations built on `keys`) threw
 * `ReferenceError: finishUtf8 is not defined` under Bun, while `put`, `get`,
 * and `count` kept working. The fix is the dependency version, so these tests
 * pin the behaviour against whatever `ordered-binary` the lockfile resolves.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createDiskBackedTestFixture } from '../testing/storage-backends.test-support.ts';
import { storageDeletePrefix, storageKeys } from './interface.ts';
import { LMDBStorage } from './lmdb.ts';

/** Accented Latin (two UTF-8 bytes), CJK (three), and an astral emoji (four). */
const accentedLatinKey = 'p:café';
const cjkKey = 'p:日本語';
const astralKey = 'p:😀';
const asciiKey = 'p:cafe';
const otherPrefixKey = 'q:café';

/** Every key written by the fixture, in the UTF-8 byte order LMDB iterates. */
const allKeysInOrder = [asciiKey, accentedLatinKey, cjkKey, astralKey, otherPrefixKey];
const prefixedKeysInOrder = [asciiKey, accentedLatinKey, cjkKey, astralKey];

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iterable) results.push(item);
  return results;
}

describe('LMDBStorage with non-ASCII keys', () => {
  const fixtureCleanups: Array<() => void> = [];
  const openStorages: LMDBStorage[] = [];

  async function createPopulatedStorage(): Promise<LMDBStorage> {
    const fixture = createDiskBackedTestFixture({
      prefix: 'lmdb-non-ascii-keys-test',
      recursive: true,
    });
    fixtureCleanups.push(fixture.cleanup);
    const storage = new LMDBStorage(fixture.path);
    openStorages.push(storage);
    for (const key of allKeysInOrder) {
      await storage.put(key, encode(`value:${key}`));
    }
    return storage;
  }

  afterEach(async () => {
    for (const storage of openStorages) await storage.close();
    openStorages.length = 0;
    for (const cleanup of fixtureCleanups) cleanup();
    fixtureCleanups.length = 0;
  });

  it('reads and counts non-ASCII keys through the point and count paths', async () => {
    const storage = await createPopulatedStorage();

    for (const key of allKeysInOrder) {
      expect(await storage.has(key)).toBe(true);
      expect(new TextDecoder().decode((await storage.get(key)) ?? new Uint8Array())).toBe(
        `value:${key}`,
      );
    }
    expect(await storage.count('p:')).toBe(prefixedKeysInOrder.length);
  });

  it('scan yields exactly the prefixed entries, values included, in byte order', async () => {
    const storage = await createPopulatedStorage();

    const entries = await collect(storage.scan('p:'));

    expect(entries.map(([key]) => key)).toEqual(prefixedKeysInOrder);
    expect(entries.map(([, value]) => new TextDecoder().decode(value))).toEqual(
      prefixedKeysInOrder.map((key) => `value:${key}`),
    );
  });

  it('scan reverses and honours limit across non-ASCII keys', async () => {
    const storage = await createPopulatedStorage();

    const reversed = await collect(storage.scan('p:', { reverse: true }));
    expect(reversed.map(([key]) => key)).toEqual(prefixedKeysInOrder.toReversed());

    const limited = await collect(storage.scan('p:', { reverse: true, limit: 2 }));
    expect(limited.map(([key]) => key)).toEqual([astralKey, cjkKey]);
  });

  it('keys iterates both directions with limit and scan bounds', async () => {
    const storage = await createPopulatedStorage();

    expect(await collect(storage.keys('p:'))).toEqual(prefixedKeysInOrder);
    expect(await collect(storage.keys('p:', { limit: 2 }))).toEqual([asciiKey, accentedLatinKey]);
    expect(await collect(storage.keys('p:', { reverse: true }))).toEqual(
      prefixedKeysInOrder.toReversed(),
    );
    expect(await collect(storage.keys('p:', { reverse: true, limit: 3 }))).toEqual([
      astralKey,
      cjkKey,
      accentedLatinKey,
    ]);
    expect(await collect(storage.keys('p:', { gt: accentedLatinKey, lt: astralKey }))).toEqual([
      cjkKey,
    ]);
    expect(await collect(storage.keys('q:'))).toEqual([otherPrefixKey]);
  });

  it('keys and scan accept a prefix that itself ends in a non-ASCII character', async () => {
    const storage = await createPopulatedStorage();
    await storage.put('日本語:one', encode('1'));
    await storage.put('日本語:two', encode('2'));

    expect(await collect(storage.keys('日本語:'))).toEqual(['日本語:one', '日本語:two']);
    const reversedEntries = await collect(storage.scan('日本語:', { reverse: true }));
    expect(reversedEntries.map(([key]) => key)).toEqual(['日本語:two', '日本語:one']);
    expect(await storage.count('日本語:')).toBe(2);
  });

  it('deletePrefix removes exactly the prefixed keys and reports their count', async () => {
    const storage = await createPopulatedStorage();

    expect(await storage.deletePrefix('p:')).toBe(prefixedKeysInOrder.length);

    expect(await collect(storage.keys('p:'))).toEqual([]);
    expect(await collect(storage.keys('q:'))).toEqual([otherPrefixKey]);
    expect(await storage.count('p:')).toBe(0);
  });

  it('deleteRange removes exactly the bounded keys, honouring limit', async () => {
    const storage = await createPopulatedStorage();

    expect(await storage.deleteRange('p:', { gte: accentedLatinKey, lte: cjkKey })).toBe(2);
    expect(await collect(storage.keys('p:'))).toEqual([asciiKey, astralKey]);

    expect(await storage.deleteRange('p:', { gt: asciiKey, limit: 1 })).toBe(1);
    expect(await collect(storage.keys('p:'))).toEqual([asciiKey]);
    expect(await collect(storage.keys('q:'))).toEqual([otherPrefixKey]);
  });

  it('works through a scoped view of the same storage', async () => {
    const storage = await createPopulatedStorage();
    const scoped = storage.scoped('p:');

    expect(await collect(storageKeys(scoped, ''))).toEqual(
      prefixedKeysInOrder.map((key) => key.slice('p:'.length)),
    );
    expect(await storageDeletePrefix(scoped, '')).toBe(prefixedKeysInOrder.length);
    expect(await collect(storage.keys(''))).toEqual([otherPrefixKey]);
  });

  it('an empty prefix has no upper bound, so keys past U+00FF are not cut off', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'lmdb-empty-prefix-test',
      recursive: true,
    });
    fixtureCleanups.push(fixture.cleanup);
    const storage = new LMDBStorage(fixture.path);
    openStorages.push(storage);
    const keys = ['a', 'é', '日', '😀'];
    for (const key of keys) await storage.put(key, encode(`value:${key}`));

    expect(await collect(storage.keys(''))).toEqual(keys);
    expect(await collect(storage.keys('', { reverse: true }))).toEqual(keys.toReversed());
    expect(await collect(storage.keys('', { reverse: true, limit: 2 }))).toEqual(['😀', '日']);
    expect(await storage.count('')).toBe(keys.length);
    const forwardEntries = await collect(storage.scan(''));
    expect(forwardEntries.map(([key]) => key)).toEqual(keys);
    const reverseEntries = await collect(storage.scan('', { reverse: true }));
    expect(reverseEntries.map(([key]) => key)).toEqual(keys.toReversed());

    expect(await storage.deleteRange('', { gte: 'é', lte: '日' })).toBe(2);
    expect(await collect(storage.keys(''))).toEqual(['a', '😀']);
    expect(await storage.deletePrefix('')).toBe(2);
    expect(await storage.count('')).toBe(0);
  });
});
