import { describe, expect, test } from 'bun:test';

import {
  CHUNK_RELOAD_KEY,
  clearChunkReloadGuard,
  isMissingChunkError,
  reloadOnceForMissingChunk,
} from './chunk-reload.ts';

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
    has: (key: string) => items.has(key),
  };
}

const CHROMIUM = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost/assets/agent-list-3f2a1b.js',
);

describe('isMissingChunkError', () => {
  test('knows how Chromium, Firefox, and Safari word a dynamic import that cannot fetch', () => {
    expect(isMissingChunkError(CHROMIUM)).toBe(true);
    expect(isMissingChunkError(new TypeError('error loading dynamically imported module'))).toBe(
      true,
    );
    expect(isMissingChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  test('leaves an error the module throws, or one that is not an Error, alone', () => {
    expect(isMissingChunkError(new Error('x is not a function'))).toBe(false);
    expect(isMissingChunkError('Failed to fetch')).toBe(false);
    expect(isMissingChunkError(undefined)).toBe(false);
  });
});

describe('reloadOnceForMissingChunk', () => {
  test('reloads and sets the guard on the first missing chunk', () => {
    const storage = memoryStorage();
    let reloads = 0;
    const reloaded = reloadOnceForMissingChunk(CHROMIUM, {
      storage,
      online: true,
      reload: () => (reloads += 1),
    });
    expect(reloaded).toBe(true);
    expect(reloads).toBe(1);
    expect(storage.has(CHUNK_RELOAD_KEY)).toBe(true);
  });

  test('does not reload a second time in a row, so a reload that does not help cannot loop', () => {
    const storage = memoryStorage();
    let reloads = 0;
    const environment = { storage, online: true, reload: () => (reloads += 1) };
    expect(reloadOnceForMissingChunk(CHROMIUM, environment)).toBe(true);
    expect(reloadOnceForMissingChunk(CHROMIUM, environment)).toBe(false);
    expect(reloads).toBe(1);
  });

  test('reloads again once a route has loaded and lifted the guard', () => {
    const storage = memoryStorage();
    let reloads = 0;
    const environment = { storage, online: true, reload: () => (reloads += 1) };
    reloadOnceForMissingChunk(CHROMIUM, environment);
    clearChunkReloadGuard({ storage });
    expect(storage.has(CHUNK_RELOAD_KEY)).toBe(false);
    expect(reloadOnceForMissingChunk(CHROMIUM, environment)).toBe(true);
    expect(reloads).toBe(2);
  });

  test('does not reload for another error, offline, or with nowhere to keep the guard', () => {
    let reloads = 0;
    const reload = () => (reloads += 1);
    expect(
      reloadOnceForMissingChunk(new Error('boom'), {
        storage: memoryStorage(),
        online: true,
        reload,
      }),
    ).toBe(false);
    expect(
      reloadOnceForMissingChunk(CHROMIUM, { storage: memoryStorage(), online: false, reload }),
    ).toBe(false);
    expect(reloadOnceForMissingChunk(CHROMIUM, { storage: undefined, online: true, reload })).toBe(
      false,
    );
    expect(reloads).toBe(0);
  });

  test('does not reload when the guard cannot be written', () => {
    let reloads = 0;
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(
      reloadOnceForMissingChunk(CHROMIUM, {
        storage: failing,
        online: true,
        reload: () => (reloads += 1),
      }),
    ).toBe(false);
    expect(reloads).toBe(0);
  });

  test('does not reload when the browser will not let the page read sessionStorage', () => {
    let reloads = 0;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    try {
      expect(
        reloadOnceForMissingChunk(CHROMIUM, { online: true, reload: () => (reloads += 1) }),
      ).toBe(false);
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, 'sessionStorage');
      else Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    }
    expect(reloads).toBe(0);
  });
});
