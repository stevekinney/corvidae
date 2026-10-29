import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';
import type { Storage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { afterEach, describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import {
  createLmdbStorageFixture,
  createMemoryStorageFixture,
  createSqliteStorageFixture,
  undisposedStorageFixtures,
  type BureauStorageFixture,
} from './storage-fixtures';

/** Whether `storage` has been closed: every operation on a closed adapter throws or rejects. */
async function isClosed(storage: Storage): Promise<boolean> {
  try {
    await storage.get('closed-probe');
    return false;
  } catch {
    return true;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

interface VerbStorage {
  get(key: string): unknown;
  count(): unknown;
  scan(): unknown;
  keys(): unknown;
  query(): unknown;
}

describe('createMemoryStorageFixture', () => {
  // Every memory fixture a test here creates is disposed after it, so the registry preload
  // sees none left over; `dispose()` is idempotent, so a test that disposes its own is fine.
  const created: BureauStorageFixture[] = [];
  const memoryFixture = (...args: Parameters<typeof createMemoryStorageFixture>) => {
    const fixture = createMemoryStorageFixture(...args);
    created.push(fixture);
    return fixture;
  };
  afterEach(async () => {
    for (const fixture of created.splice(0)) await fixture.dispose();
  });

  it('returns an owned Storage instance with no path', async () => {
    const fixture = memoryFixture();

    // AB-322: `storage` is a real `Storage` instance this fixture constructed itself (wrapped with
    // handle accounting) — `get`/`put`/`delete` are callable directly.
    expect(typeof (fixture.storage as { get?: unknown }).get).toBe('function');
    expect(typeof (fixture.storage as { put?: unknown }).put).toBe('function');
    expect(fixture.kind).toBe('memory');
    expect(fixture.path).toBeUndefined();
    expect(fixture.owned).toBe(true);
    await fixture.dispose();
  });

  it('is one store: storage, open(), and reopen() all return the same instance', async () => {
    await using fixture = memoryFixture();

    await fixture.storage.put('k', new Uint8Array([1]));

    expect(fixture.open()).toBe(fixture.storage);
    expect(await fixture.reopen()).toBe(fixture.storage);
    expect(await fixture.storage.get('k')).toEqual(new Uint8Array([1]));
  });

  it('is idempotent to dispose repeatedly', async () => {
    const fixture = memoryFixture();

    await fixture.dispose();
    await fixture.dispose();
  });

  it('openHandles() is empty before any call and after every call settles', async () => {
    const fixture = memoryFixture();
    const storage = fixture.storage as {
      get(key: string): Promise<Uint8Array | null>;
      put(key: string, value: Uint8Array): Promise<void>;
    };

    expect(fixture.openHandles()).toEqual([]);

    await storage.put('key', new Uint8Array([1]));
    expect(fixture.openHandles()).toEqual([]);

    await storage.get('key');
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() names a call started but not yet finished, through a caller-supplied wrapStorage', async () => {
    let releaseGet!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });

    const fixture = memoryFixture({
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property !== 'get') return Reflect.get(target, property, receiver);
            return async (key: string) => {
              await blocked;
              return target.get(key);
            };
          },
        }),
    });
    const storage = fixture.storage as { get(key: string): Promise<Uint8Array | null> };

    const getPromise = storage.get('key');
    expect(fixture.openHandles()).toEqual(['get#1']);

    releaseGet();
    await getPromise;
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears a call that REJECTS too, not only one that resolves', async () => {
    const fixture = memoryFixture({
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property !== 'get') return Reflect.get(target, property, receiver);
            return async (): Promise<Uint8Array | null> => {
              throw new Error('deliberate failure');
            };
          },
        }),
    });
    const storage = fixture.storage as { get(key: string): Promise<Uint8Array | null> };

    let caught: unknown;
    try {
      await storage.get('key');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('deliberate failure');
    expect(fixture.openHandles()).toEqual([]);
  });

  /** A fixture whose `verb` is replaced by `replacement`, through `wrapStorage`. */
  function fixtureWithVerb(verb: string, replacement: (...args: unknown[]) => unknown) {
    const fixture = memoryFixture({
      wrapStorage: (storage) =>
        new Proxy(storage, {
          get(target, property, receiver) {
            if (property !== verb) return Reflect.get(target, property, receiver);
            return replacement;
          },
        }),
    });
    return { fixture, storage: fixture.storage as unknown as VerbStorage };
  }

  /** A thenable that is not a native Promise and settles only when told to. */
  function manualThenable() {
    let onFulfilled: ((value: unknown) => void) | undefined;
    let onRejected: ((reason: unknown) => void) | undefined;
    const thenable = {
      then(resolve?: (value: unknown) => void, reject?: (reason: unknown) => void) {
        onFulfilled = resolve;
        onRejected = reject;
      },
    };
    return {
      thenable,
      resolve: (value: unknown) => onFulfilled?.(value),
      reject: (reason: unknown) => onRejected?.(reason),
    };
  }

  it('openHandles() keeps a non-native thenable open until it resolves', () => {
    const manual = manualThenable();
    expect(manual.thenable instanceof Promise).toBe(false);
    const { fixture, storage } = fixtureWithVerb('get', () => manual.thenable);

    storage.get('key');
    expect(fixture.openHandles()).toEqual(['get#1']);

    manual.resolve(null);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() keeps a non-native thenable open until it rejects', () => {
    const manual = manualThenable();
    const { fixture, storage } = fixtureWithVerb('get', () => manual.thenable);

    storage.get('key');
    expect(fixture.openHandles()).toEqual(['get#1']);

    manual.reject(new Error('deliberate failure'));
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() closes a self-returning single-slot thenable when it settles, never assimilating its then() return value', async () => {
    // A fluent thenable: `then()` stores the one callback pair it is given and
    // returns itself. Assimilating that return value (for example through
    // `Promise.resolve(...)`) calls `then()` a second time with different
    // callbacks, which overwrites the registered `close` so it never runs.
    let onFulfilled: ((value: unknown) => void) | undefined;
    const thenable = {
      then(resolve?: (value: unknown) => void) {
        onFulfilled = resolve;
        return thenable;
      },
    };
    const { fixture, storage } = fixtureWithVerb('get', () => thenable);

    storage.get('key');
    // Two microtask turns: enough for an assimilation job to have re-entered `then()`.
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.openHandles()).toEqual(['get#1']);

    onFulfilled?.(null);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() stays open while a thenable returns an independently rejected promise from then()', async () => {
    // Only the original thenable's own settlement ends the call's lifetime. A
    // promise that `then()` happens to return is a different value and must
    // not close the handle when it rejects.
    let onFulfilled: ((value: unknown) => void) | undefined;
    const independent = Promise.reject(new Error('independent failure'));
    independent.catch(() => {});
    const thenable = {
      then(resolve?: (value: unknown) => void) {
        onFulfilled = resolve;
        return independent;
      },
    };
    const { fixture, storage } = fixtureWithVerb('get', () => thenable);

    storage.get('key');
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.openHandles()).toEqual(['get#1']);

    onFulfilled?.(null);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() still closes a genuinely synchronous return immediately', () => {
    const { fixture, storage } = fixtureWithVerb('count', () => 3);

    expect(storage.count()).toBe(3);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() closes immediately for a synchronous non-thenable object return', () => {
    const { fixture, storage } = fixtureWithVerb('count', () => ({ n: 1 }));

    expect(storage.count()).toEqual({ n: 1 });
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() closes and still returns the value when a thenable throws in then()', () => {
    const thenable = {
      then() {
        throw new Error('boom');
      },
    };
    const { fixture, storage } = fixtureWithVerb('get', () => thenable);

    expect(storage.get('key')).toBe(thenable);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() tracks a frozen AsyncIterable without a Proxy invariant error', async () => {
    const iterable = Object.freeze({
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            index += 1;
            return index <= 2
              ? { done: false as const, value: index }
              : { done: true as const, value: undefined };
          },
        };
      },
    });
    const { fixture, storage } = fixtureWithVerb('scan', () => iterable);

    const seen: number[] = [];
    for await (const value of storage.scan() as AsyncIterable<number>) {
      seen.push(value);
      expect(fixture.openHandles()).toEqual(['scan#1']);
    }
    expect(seen).toEqual([1, 2]);
    expect(fixture.openHandles()).toEqual([]);
  });

  function manualIterable() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next() {
            await gate;
            index += 1;
            return index <= 2
              ? { done: false as const, value: index }
              : { done: true as const, value: undefined };
          },
          async return() {
            return { done: true as const, value: undefined };
          },
          async throw(error?: unknown) {
            throw error;
          },
        };
      },
    };
    return { iterable, release };
  }

  it('openHandles() keeps an AsyncIterable open until iteration is exhausted', async () => {
    const { iterable, release } = manualIterable();
    const { fixture, storage } = fixtureWithVerb('scan', () => iterable);

    const seen: number[] = [];
    const iteration = (async () => {
      for await (const value of storage.scan() as AsyncIterable<number>) seen.push(value);
    })();
    expect(fixture.openHandles()).toEqual(['scan#1']);

    release();
    await iteration;
    expect(seen).toEqual([1, 2]);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() keeps an AsyncIterable open until the consumer breaks out (return())', async () => {
    const { iterable, release } = manualIterable();
    release();
    const { fixture, storage } = fixtureWithVerb('keys', () => iterable);

    for await (const value of storage.keys() as AsyncIterable<number>) {
      expect(value).toBe(1);
      expect(fixture.openHandles()).toEqual(['keys#1']);
      break;
    }
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears an AsyncIterable whose iteration throws', async () => {
    const failing: AsyncIterable<number> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error('deliberate failure');
        },
      }),
    };
    const { fixture, storage } = fixtureWithVerb('query', () => failing);

    const iterator = (storage.query() as AsyncIterable<number>)[Symbol.asyncIterator]();
    expect(fixture.openHandles()).toEqual(['query#1']);
    expect(await throwingRejectionOf(iterator.next())).toThrow('deliberate failure');
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears an AsyncIterable when the consumer calls throw()', async () => {
    const { iterable, release } = manualIterable();
    release();
    const { fixture, storage } = fixtureWithVerb('scan', () => iterable);

    const iterator = (storage.scan() as AsyncIterable<number>)[Symbol.asyncIterator]();
    await iterator.next();
    expect(fixture.openHandles()).toEqual(['scan#1']);
    expect(await throwingRejectionOf(iterator.throw?.(new Error('stop')))).toThrow('stop');
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() tracks next()/return() called directly on an iterator-shaped result', async () => {
    async function* generate(): AsyncGenerator<number> {
      yield 1;
      yield 2;
    }
    const { fixture, storage } = fixtureWithVerb('scan', () => generate());

    const iterator = storage.scan() as AsyncGenerator<number>;
    expect(fixture.openHandles()).toEqual(['scan#1']);
    const first = await iterator.next();
    expect(first.value).toBe(1);
    expect(fixture.openHandles()).toEqual(['scan#1']);
    await iterator.return(undefined);
    expect(fixture.openHandles()).toEqual([]);
  });

  it('openHandles() clears an iterator-shaped result when throw() is called directly', async () => {
    async function* generate(): AsyncGenerator<number> {
      yield 1;
      yield 2;
    }
    const { fixture, storage } = fixtureWithVerb('keys', () => generate());

    const iterator = storage.keys() as AsyncGenerator<number>;
    await iterator.next();
    expect(fixture.openHandles()).toEqual(['keys#1']);
    expect(await throwingRejectionOf(iterator.throw(new Error('stop')))).toThrow('stop');
    expect(fixture.openHandles()).toEqual([]);
  });
});

describe('the fixture registry', () => {
  it('holds a fixture from creation until it is disposed, naming the file that created it', async () => {
    const fixture = createSqliteStorageFixture();
    const before = undisposedStorageFixtures();

    expect(before.some((entry) => entry.includes('storage-fixtures.test.ts'))).toBe(true);

    await fixture.dispose();

    expect(undisposedStorageFixtures()).toHaveLength(before.length - 1);
  });
});

describe('createSqliteStorageFixture', () => {
  it('allocates a unique path in a fresh temporary directory, named from the runtime identifier sequence', async () => {
    const runtime = createManualRuntimeServices();

    const first = createSqliteStorageFixture({ runtime });
    const second = createSqliteStorageFixture({ runtime });

    expect(first.path).toBeDefined();
    expect(second.path).toBeDefined();
    expect(first.path).not.toBe(second.path);
    expect(first.path).toContain('storage-fixture-1');
    expect(second.path).toContain('storage-fixture-2');
    expect(first.kind).toBe('sqlite');
    expect(first.owned).toBe(true);
    expect(dirname(first.path)).not.toBe(dirname(second.path));

    await first.dispose();
    await second.dispose();
  });

  it('gives two independent runtimes distinct paths despite each identifier sequence starting at 1', async () => {
    const runtimeA = createManualRuntimeServices();
    const runtimeB = createManualRuntimeServices();

    const fixtureA = createSqliteStorageFixture({ runtime: runtimeA });
    const fixtureB = createSqliteStorageFixture({ runtime: runtimeB });

    expect(fixtureA.path).not.toBe(fixtureB.path);

    await fixtureA.dispose();
    await fixtureB.dispose();
  });

  it('deletes only a path it allocated itself', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });
    const path = fixture.path;

    await writeFile(path, '');
    await writeFile(`${path}-wal`, '');
    await writeFile(`${path}-shm`, '');
    expect(await pathExists(path)).toBe(true);

    await fixture.dispose();

    expect(await pathExists(path)).toBe(false);
    expect(await pathExists(`${path}-wal`)).toBe(false);
    expect(await pathExists(`${path}-shm`)).toBe(false);
    expect(await pathExists(dirname(path))).toBe(false);
  });

  it('is idempotent: disposing an owned fixture twice does not throw', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });

    await fixture.dispose();
    await fixture.dispose();
  });

  it('never deletes a caller-supplied path, and closes the handles it opened there', async () => {
    const runtime = createManualRuntimeServices();
    const callerPath = createTemporaryPath('bureau-caller-owned-sqlite', '.sqlite');

    try {
      const fixture = createSqliteStorageFixture({ runtime, path: callerPath });

      expect(fixture.owned).toBe(false);
      expect(fixture.path).toBe(callerPath);
      const handle = fixture.storage;
      await handle.put('k', new Uint8Array([1]));

      await fixture.dispose();

      expect(await pathExists(callerPath)).toBe(true);
      expect(await isClosed(handle)).toBe(true);
    } finally {
      removeTemporaryPath(callerPath);
    }
  });

  it('opens nothing until storage is first read, then returns that handle until reopen()', async () => {
    await using fixture = createSqliteStorageFixture();

    expect(await pathExists(fixture.path)).toBe(false);
    const first = fixture.storage;
    expect(await pathExists(fixture.path)).toBe(true);
    expect(fixture.storage).toBe(first);
    expect(first).toBeInstanceOf(BunSQLiteStorage);
  });

  it('reopen() closes the previous handle and returns a new one on the same store', async () => {
    await using fixture = createSqliteStorageFixture();
    const first = fixture.storage;
    await first.put('k', new Uint8Array([7]));

    const second = await fixture.reopen();

    expect(second).not.toBe(first);
    expect(fixture.storage).toBe(second);
    expect(await isClosed(first)).toBe(true);
    expect(await second.get('k')).toEqual(new Uint8Array([7]));
  });

  it('open() adds a handle on the same store, and dispose() closes every handle', async () => {
    const fixture = createSqliteStorageFixture();
    const first = fixture.storage;
    const additional = fixture.open();
    await first.put('k', new Uint8Array([3]));

    expect(additional).not.toBe(first);
    expect(await additional.get('k')).toEqual(new Uint8Array([3]));

    await fixture.dispose();

    expect(await isClosed(first)).toBe(true);
    expect(await isClosed(additional)).toBe(true);
    expect(() => fixture.open()).toThrow(/disposed/);
  });

  it('openHandles() always returns empty — only the memory fixture accounts for calls (see the module doc)', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createSqliteStorageFixture({ runtime });

    expect(fixture.openHandles()).toEqual([]);

    await fixture.dispose();
  });
});

describe('createLmdbStorageFixture', () => {
  it('allocates a unique directory path derived from the runtime identifier sequence', async () => {
    const runtime = createManualRuntimeServices();

    const first = createLmdbStorageFixture({ runtime });
    const second = createLmdbStorageFixture({ runtime });

    expect(first.path).not.toBe(second.path);
    expect(first.kind).toBe('lmdb');
    expect(first.storage.capabilities().persistence).toBe('local');
    expect(first.owned).toBe(true);

    await first.dispose();
    await second.dispose();
  });

  it('allows an isolation test to select relaxed durability explicitly', async () => {
    const fixture = createLmdbStorageFixture({
      runtime: createManualRuntimeServices(),
      durability: 'relaxed',
    });

    // A relaxed-durability LMDB store reports itself as ephemeral (Weft's LMDB adapter).
    expect(fixture.storage.capabilities().persistence).toBe('ephemeral');

    await fixture.dispose();
  });

  it('deletes only a directory it allocated itself', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createLmdbStorageFixture({ runtime });
    const path = fixture.path;

    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'data.mdb'), '');
    expect(await pathExists(path)).toBe(true);

    await fixture.dispose();

    expect(await pathExists(path)).toBe(false);
  });

  it('never deletes a caller-supplied directory', async () => {
    const runtime = createManualRuntimeServices();
    const callerPath = createTemporaryPath('bureau-caller-owned-lmdb');
    await mkdir(callerPath, { recursive: true });

    try {
      const fixture = createLmdbStorageFixture({ runtime, path: callerPath });

      expect(fixture.owned).toBe(false);

      await fixture.dispose();

      expect(await pathExists(callerPath)).toBe(true);
    } finally {
      removeTemporaryPath(callerPath);
    }
  });

  it('is idempotent: disposing an owned fixture twice does not throw', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createLmdbStorageFixture({ runtime });

    await fixture.dispose();
    await fixture.dispose();
  });

  it('refuses open(): one LMDB handle at a time, so reopen() closes the previous one first', async () => {
    await using fixture = createLmdbStorageFixture();
    const first = fixture.storage;
    await first.put('k', new Uint8Array([9]));

    expect(() => fixture.open()).toThrow(/one handle at a time/);
    const second = await fixture.reopen();

    expect(second).not.toBe(first);
    expect(await isClosed(first)).toBe(true);
    expect(await second.get('k')).toEqual(new Uint8Array([9]));
  });

  it('openHandles() always returns empty — only the memory fixture accounts for calls (see the module doc)', async () => {
    const runtime = createManualRuntimeServices();
    const fixture = createLmdbStorageFixture({ runtime });

    expect(fixture.openHandles()).toEqual([]);

    await fixture.dispose();
  });
});
