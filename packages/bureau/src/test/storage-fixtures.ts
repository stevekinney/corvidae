/**
 * Isolated storage fixtures for the Bureau test harness (AB-261, COR-1767).
 *
 * Bureau never disposes a storage it was given (`BureauOptions.storage` accepts only a `Storage`
 * instance), so a test that hands Bureau a store also owns closing it. A fixture is that owner:
 * it opens the handles a test passes to `createBureau`, closes every one of them on `dispose()`,
 * and removes the files it allocated.
 *
 * Creating a fixture opens nothing. `storage` opens the handle on first access, so a crash test
 * can create a fixture, pass its `path` to a child process that writes and is killed, and open
 * its own handle only after the child is gone. `reopen()` closes that handle and opens a new one
 * on the same store, for a second Bureau after the first has shut down. `open()` adds a further
 * handle for a test that runs two Bureaus at once; LMDB refuses it, because its single writer must
 * not be shared within one process.
 *
 * A caller-supplied path is never deleted: `owned` is `false` for it, and `dispose()` then only
 * closes the handles the fixture opened.
 *
 * Every fixture is registered on `globalThis` under
 * `Symbol.for('@lostgradient/bureau/storage-fixtures')` when it is created and unregistered when
 * it is disposed. Bureau's test preload (`storage-fixture-preload.ts`) fails the run, naming the
 * creating test file, if any fixture is still registered once the tests finish.
 *
 * `openHandles()` (AB-322) is public call accounting for the memory fixture: the labels of every
 * storage call it has seen start and not finish. The SQLite and LMDB fixtures return `[]`.
 */

import type { RuntimeServices } from '@lostgradient/lifecycle';
import { type Storage, MemoryStorage } from '@lostgradient/storage';
import { BunSQLiteStorage, LMDBStorage } from '@lostgradient/weft';
import { createTemporaryPath, removeTemporaryPath } from './temporary-path';

/** The backend a {@link BureauStorageFixture} opens. */
type BureauStorageFixtureKind = 'memory' | 'sqlite' | 'lmdb';

/**
 * One isolated storage backend for a single test. Pass `storage` to `BureauOptions.storage`.
 * `path` is present only for the persistent (SQLite and LMDB) backends. `owned: true` means this
 * fixture allocated `path` itself and `dispose()` removes it; `owned: false` means the caller
 * supplied `path` and `dispose()` leaves it alone.
 */
export interface BureauStorageFixture {
  /** The backend this fixture opens. */
  readonly kind: BureauStorageFixtureKind;
  readonly path?: string;
  readonly owned: boolean;
  /**
   * The fixture's current handle, opened on first access and returned unchanged until
   * {@link reopen}. Creating the fixture opens nothing.
   */
  readonly storage: Storage;
  /**
   * An additional handle on the same store, for a test that runs two Bureaus on it at once. The
   * fixture closes it on `dispose()`. Memory returns the same instance; LMDB throws, because its
   * single writer must not be shared within one process.
   */
  open(): Storage;
  /**
   * Closes the current handle and opens a new one on the same store (a new adapter on the same
   * `path` for SQLite and LMDB, the same instance for memory), and returns it. Call it only after
   * the Bureau using the current handle has shut down.
   */
  reopen(): Promise<Storage>;
  /**
   * Labels of every storage call this fixture's own accounting has seen START but not yet FINISH
   * (AB-322) — public handle accounting a test (or `assertBureauQuiescent`'s
   * `openStorageResources` row) can read directly. Always `[]` for `createSqliteStorageFixture`
   * and `createLmdbStorageFixture`.
   */
  openHandles(): readonly string[];
  /** Closes every handle this fixture opened, then removes its files when it is `owned`. */
  dispose(): Promise<void>;
  /** The same as {@link dispose}, for `await using`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** A SQLite or LMDB {@link BureauStorageFixture}, whose store always has a `path`. */
export interface PersistentBureauStorageFixture extends BureauStorageFixture {
  readonly kind: 'sqlite' | 'lmdb';
  readonly path: string;
}

/** The verbs {@link wrapStorageWithHandleAccounting} tracks — every async `Storage` method. `capabilities()`/`scoped()` are synchronous and excluded: nothing awaits them, so there is no "in flight" window to account for. */
const ACCOUNTED_STORAGE_VERBS = [
  'get',
  'put',
  'delete',
  'scan',
  'batch',
  'conditionalBatch',
  'has',
  'deletePrefix',
  'deleteRange',
  'keys',
  'count',
  'query',
] as const;

/**
 * Arranges for `close` to run when `result`'s lifetime ends: a thenable
 * (native or not) settling either way, or an `AsyncIterable` finishing by
 * exhaustion, `return()`, `throw()`, or a rejected `next()`. A value that is
 * neither never left the call "in flight", so it closes immediately.
 */
function trackLifetime(result: unknown, close: () => void): unknown {
  if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
    close();
    return result;
  }
  if (typeof (result as { then?: unknown }).then === 'function') {
    try {
      // Registered synchronously, and attached only to the original thenable:
      // whatever `then()` returns is a different value (a fluent thenable may
      // return itself) and must never be assimilated or observed, or its
      // settlement, a second `then()` call, or its rejection would replace or
      // pre-empt the original's.
      void (result as PromiseLike<unknown>).then(close, close);
    } catch {
      // A `then` that throws synchronously must not escape the verb call or
      // leak the handle; awaiting the value surfaces the failure as usual.
      close();
    }
    return result;
  }
  if (typeof (result as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] !== 'function') {
    close();
    return result;
  }
  // A fresh wrapper object (never a Proxy over `result`, whose get-trap
  // invariants break on frozen iterables). Unwrapped properties fall through
  // the prototype chain.
  const source = result as AsyncIterable<unknown> & Partial<AsyncIterator<unknown>>;
  const wrapper = Object.create(source) as Record<PropertyKey, unknown>;
  Object.defineProperty(wrapper, Symbol.asyncIterator, {
    value: () => trackIterator(source[Symbol.asyncIterator](), close),
    configurable: true,
    writable: true,
  });
  for (const method of ['next', 'return', 'throw'] as const) {
    if (typeof source[method] !== 'function') continue;
    Object.defineProperty(wrapper, method, {
      value: trackIteratorMethod(source as AsyncIterator<unknown>, method, close),
      configurable: true,
      writable: true,
    });
  }
  return wrapper;
}

function trackIteratorMethod(
  iterator: AsyncIterator<unknown>,
  method: 'next' | 'return' | 'throw',
  close: () => void,
): (...args: unknown[]) => Promise<IteratorResult<unknown>> {
  return async (...args) => {
    const fn = iterator[method] as
      ((...callArgs: unknown[]) => Promise<IteratorResult<unknown>>) | undefined;
    if (fn === undefined) {
      // An absent `return`/`throw` still ends the consumer's use of it.
      close();
      return { done: true, value: undefined };
    }
    try {
      const step = await fn.apply(iterator, args);
      if (method !== 'next' || step.done === true) close();
      return step;
    } catch (error) {
      close();
      throw error;
    }
  };
}

function trackIterator(
  iterator: AsyncIterator<unknown>,
  close: () => void,
): AsyncIterator<unknown> {
  return {
    next: trackIteratorMethod(iterator, 'next', close),
    return: trackIteratorMethod(iterator, 'return', close),
    throw: trackIteratorMethod(iterator, 'throw', close),
  };
}

/**
 * Wraps `storage` with public call accounting: every call to one of
 * {@link ACCOUNTED_STORAGE_VERBS} is recorded the instant it is INVOKED
 * (before whatever it delegates to has any chance to resolve or block) and
 * removed once its returned value's lifetime ends (a `Promise` or other
 * thenable settling, or an `AsyncIterable` finishing). `openHandles()`
 * reads the current set — synchronously, no polling — so a caller that
 * wraps `storage` again underneath (e.g. `createFaultEngine(...).wrapStorage`,
 * to block a specific call deterministically) sees that call recorded as
 * open for exactly as long as the block holds, because this wrapper's own
 * call to the layer beneath it does not settle until the block releases.
 */
function wrapStorageWithHandleAccounting(storage: Storage): {
  readonly storage: Storage;
  openHandles(): readonly string[];
} {
  const open = new Map<string, true>();
  let sequence = 0;

  const handler: ProxyHandler<Storage> = {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      const isAccountedVerb =
        typeof property === 'string' &&
        (ACCOUNTED_STORAGE_VERBS as readonly string[]).includes(property) &&
        typeof value === 'function';
      if (!isAccountedVerb) {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      const verb = property;
      return (...args: unknown[]) => {
        sequence += 1;
        const label = `${verb}#${sequence}`;
        open.set(label, true);
        const result: unknown = Reflect.apply(
          value as (...callArgs: unknown[]) => unknown,
          target,
          args,
        );
        return trackLifetime(result, () => open.delete(label));
      };
    },
  };

  return {
    storage: new Proxy(storage, handler),
    openHandles: () => [...open.keys()],
  };
}

/** The `globalThis` key of the registry of fixtures created and not yet disposed. */
const REGISTRY_KEY = Symbol.for('@lostgradient/bureau/storage-fixtures');

/** One fixture in the registry, with the place that created it. */
interface StorageFixtureRegistration {
  readonly fixture: BureauStorageFixture;
  /** The creating test file's frame, or the nearest frame outside this module. */
  readonly createdBy: string;
}

/**
 * The registry lives on `globalThis` rather than in this module, so the preload and every test
 * file in a worker share one `Set` even when the runner evaluates this module once per file.
 */
function registry(): Set<StorageFixtureRegistration> {
  const holder = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: Set<StorageFixtureRegistration>;
  };
  holder[REGISTRY_KEY] ??= new Set();
  return holder[REGISTRY_KEY];
}

/** Picks the creating test file's frame out of a stack, skipping this module's own frames. */
function creatingFrame(stack: string): string {
  const frames = stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^at /, ''))
    .filter((frame) => !frame.includes('storage-fixtures.ts'));
  return (
    frames.find((frame) => /\.test\.tsx?(:|\)|$)/.test(frame)) ?? frames[0] ?? 'an unknown caller'
  );
}

function register(fixture: BureauStorageFixture): () => void {
  const registration: StorageFixtureRegistration = {
    fixture,
    createdBy: creatingFrame(new Error('storage fixture created').stack ?? ''),
  };
  registry().add(registration);
  return () => registry().delete(registration);
}

/**
 * Where each storage fixture still registered was created: the fixtures some test created and
 * never disposed. Bureau's test preload fails the run when this is not empty once the tests in a
 * worker have finished.
 */
export function undisposedStorageFixtures(): readonly string[] {
  return [...registry()].map(
    ({ fixture, createdBy }) => `${fixture.kind} fixture created at ${createdBy}`,
  );
}

/** Options shared by the two persistent-backend fixture factories. */
export interface CreatePersistentStorageFixtureOptions {
  /**
   * The runtime whose `identifiers.next('storage-fixture')` sequence labels the allocated path
   * when `path` is omitted. Optional: the path lives in a fresh `mkdtemp` directory, so the label
   * only helps a reader find it.
   */
  readonly runtime?: RuntimeServices;
  /**
   * A caller-supplied path. When present, this fixture never allocates or deletes anything —
   * `owned` is `false` and `dispose()` only closes the handles it opened. When omitted, a fresh
   * path is allocated under the OS temp directory and `owned` is `true`.
   */
  readonly path?: string;
}

/** LMDB fixture options, including the durability mode exercised by the test. */
export interface CreateLmdbStorageFixtureOptions extends CreatePersistentStorageFixtureOptions {
  /** Defaults to Weft's production `full` durability. */
  readonly durability?: 'full' | 'relaxed';
}

function allocateFixturePath(
  kind: 'sqlite' | 'lmdb',
  runtime: RuntimeServices | undefined,
): string {
  const label =
    runtime === undefined
      ? `bureau-${kind}-fixture`
      : `bureau-${kind}-fixture-${runtime.identifiers.next('storage-fixture')}`;
  // A fresh `mkdtemp` directory per fixture: the runtime's identifier sequence restarts at 1 for
  // every `ManualRuntimeServices`, and a process id repeats across runs, so neither can name a path.
  return createTemporaryPath(label, kind === 'sqlite' ? '.sqlite' : '');
}

/** A handle a persistent fixture opened, with the way to close it. */
interface OpenedHandle {
  readonly storage: Storage;
  close(): Promise<void>;
}

function createPersistentStorageFixture(
  kind: 'sqlite' | 'lmdb',
  options: CreatePersistentStorageFixtureOptions,
  openAdapter: (path: string) => OpenedHandle,
): PersistentBureauStorageFixture {
  const owned = options.path === undefined;
  const path = options.path ?? allocateFixturePath(kind, options.runtime);
  const handles: OpenedHandle[] = [];
  let current: OpenedHandle | undefined;
  let disposed = false;

  const openHandle = (): OpenedHandle => {
    if (disposed) throw new Error(`The ${kind} storage fixture at ${path} is disposed.`);
    const handle = openAdapter(path);
    handles.push(handle);
    return handle;
  };

  const fixture: PersistentBureauStorageFixture = {
    kind,
    path,
    owned,
    get storage() {
      current ??= openHandle();
      return current.storage;
    },
    open() {
      if (kind === 'lmdb') {
        throw new Error(
          'An LMDB storage fixture opens one handle at a time: its single writer must not be shared within one process. Use reopen() after the Bureau on the current handle has shut down.',
        );
      }
      return openHandle().storage;
    },
    async reopen() {
      const previous = current;
      current = undefined;
      if (previous !== undefined) {
        handles.splice(handles.indexOf(previous), 1);
        await previous.close();
      }
      current = openHandle();
      return current.storage;
    },
    openHandles: () => [],
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        for (const handle of handles.splice(0).toReversed()) await handle.close();
      } finally {
        current = undefined;
        if (owned) removeTemporaryPath(path);
        unregister();
      }
    },
    [Symbol.asyncDispose]() {
      return fixture.dispose();
    },
  };
  const unregister = register(fixture);
  return fixture;
}

/** Options for {@link createMemoryStorageFixture}. */
export interface CreateMemoryStorageFixtureOptions {
  /**
   * Applied to the fixture's own freshly-constructed `MemoryStorage`
   * BEFORE this fixture's own handle-accounting wrapper wraps the result
   * (AB-322) — so a call this returns still-pending (e.g.
   * `createFaultEngine(...).wrapStorage`, blocking a specific call
   * deterministically) is correctly reported as still open by
   * `openHandles()` for exactly as long as it stays pending. Defaults to
   * the identity function.
   */
  wrapStorage?: (storage: Storage) => Storage;
}

/**
 * An in-memory `BureauStorageFixture`. Always `owned: true`. Its one `MemoryStorage` instance is
 * the store, so `storage`, `open()`, and `reopen()` all return it, wrapped with the public call
 * accounting `openHandles()` reads. `dispose()` disposes that instance.
 */
export function createMemoryStorageFixture(
  options: CreateMemoryStorageFixtureOptions = {},
): BureauStorageFixture {
  const rawStorage = new MemoryStorage();
  const wrapped = options.wrapStorage?.(rawStorage) ?? rawStorage;
  const { storage: accounted, openHandles } = wrapStorageWithHandleAccounting(wrapped);
  let disposed = false;

  const fixture: BureauStorageFixture = {
    kind: 'memory',
    owned: true,
    storage: accounted,
    open: () => accounted,
    reopen: async () => accounted,
    openHandles,
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        rawStorage[Symbol.dispose]();
      } finally {
        unregister();
      }
    },
    [Symbol.asyncDispose]() {
      return fixture.dispose();
    },
  };
  const unregister = register(fixture);
  return fixture;
}

/**
 * A SQLite-backed `BureauStorageFixture` over `BunSQLiteStorage`. When `options.path` is omitted,
 * a fresh, unique path under the OS temp directory is allocated (the file itself is created by the
 * first handle that opens it). `dispose()` closes every handle the fixture opened, then removes
 * the database file and its `-wal`/`-shm` sidecars when, and only when, this fixture allocated the
 * path itself.
 */
export function createSqliteStorageFixture(
  options: CreatePersistentStorageFixtureOptions = {},
): PersistentBureauStorageFixture {
  return createPersistentStorageFixture('sqlite', options, (path) => {
    const storage = new BunSQLiteStorage(path);
    return {
      storage,
      async close() {
        storage[Symbol.dispose]();
      },
    };
  });
}

/**
 * A LMDB-backed `BureauStorageFixture`. LMDB's store is a directory, not a file — when
 * `options.path` is omitted, a fresh, unique directory path under the OS temp directory is
 * allocated (created by the first handle that opens it). The fixture uses Weft's production
 * `full` durability unless a timing-independent test explicitly selects `relaxed`. It holds one
 * handle at a time: `open()` throws, and `reopen()` closes the current handle before it opens the
 * next. `dispose()` closes the handle, then removes the directory when, and only when, this
 * fixture allocated the path itself.
 */
export function createLmdbStorageFixture(
  options: CreateLmdbStorageFixtureOptions = {},
): PersistentBureauStorageFixture {
  const durability = options.durability ?? 'full';
  return createPersistentStorageFixture('lmdb', options, (path) => {
    const storage = new LMDBStorage(path, { durability });
    return { storage, close: () => storage.close() };
  });
}
