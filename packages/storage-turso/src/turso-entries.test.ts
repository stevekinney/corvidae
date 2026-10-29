/**
 * The two package entries differ only in the libSQL driver they load. The native entry builds its
 * client from `@libsql/client`, the web entry from `@libsql/client/web`, and the adapter they share
 * never asks which runtime it is on. The driver-deferral gate in `turso-driver-deferred.test.ts`
 * proves each entry imports its driver lazily.
 */

import type { Client, Config } from '@libsql/client';
import { describe, expect, it } from 'bun:test';

import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import * as nativeEntry from './index.ts';
import { TursoClientStorage, type TursoDriverLoader } from './turso-storage.ts';
import * as webEntry from './web.ts';

const decoder = new TextDecoder();

describe('the native entry', () => {
  it('builds its client from @libsql/client, which opens local files', async () => {
    const storage = new nativeEntry.TursoStorage({ url: 'file::memory:' });
    try {
      await storage.put('a', new TextEncoder().encode('native'));
      expect(decoder.decode((await storage.get('a')) ?? new Uint8Array())).toBe('native');
    } finally {
      storage[Symbol.dispose]();
    }
  });
});

describe('the web entry', () => {
  it('exports the adapter and nothing else at runtime', () => {
    expect(Object.keys(webEntry)).toEqual(['TursoStorage']);
    expect(webEntry.TursoStorage).toBeFunction();
    expect(webEntry.TursoStorage).not.toBe(nativeEntry.TursoStorage);
  });

  it('builds its client from @libsql/client/web, which cannot open local files', async () => {
    const storage = new webEntry.TursoStorage({ url: 'file::memory:' });
    try {
      // The native driver opens `file:` URLs; the web client supports only network schemes, and its
      // refusal names itself, which shows which driver this entry loaded.
      const refusal = await throwingRejectionOf(storage.get('a'));
      expect(refusal).toThrow('The client that uses Web standard APIs supports only');
    } finally {
      storage[Symbol.dispose]();
    }
  });

  it('reports the same capabilities as the native entry for the same URL', () => {
    const options = { url: 'libsql://example.turso.io', authToken: 'token' };
    const native = new nativeEntry.TursoStorage(options);
    const web = new webEntry.TursoStorage(options);
    try {
      expect(web.capabilities()).toEqual(native.capabilities());
      expect(web.capabilities().persistence).toBe('remote');
    } finally {
      native[Symbol.dispose]();
      web[Symbol.dispose]();
    }
  });
});

/** A client that answers every read as a miss, recording that it was closed. */
function createRecordingClient(): { client: Client; closed: () => boolean } {
  let closed = false;
  const client = {
    executeMultiple: async () => {},
    execute: async () => ({ rows: [], rowsAffected: 0 }),
    close: () => {
      closed = true;
    },
  } as unknown as Client;
  return { client, closed: () => closed };
}

describe('the adapter both entries share', () => {
  it('imports the driver on the first operation, once, and hands it the configuration', async () => {
    const configurations: Config[] = [];
    let loads = 0;
    const recording = createRecordingClient();
    const loader: TursoDriverLoader = async () => {
      loads += 1;
      return {
        createClient: (configuration) => {
          configurations.push(configuration);
          return recording.client;
        },
      };
    };

    const storage = new TursoClientStorage(
      { url: 'libsql://x.turso.io', authToken: 'secret' },
      loader,
    );
    expect(loads).toBe(0);

    expect(await storage.get('a')).toBeNull();
    expect(await storage.has('a')).toBe(false);
    expect(loads).toBe(1);
    expect(configurations).toEqual([{ url: 'libsql://x.turso.io', authToken: 'secret' }]);

    storage[Symbol.dispose]();
    await waitUntil(recording.closed);
  });

  it('retries the driver import after a failed one instead of memoizing the failure', async () => {
    const recording = createRecordingClient();
    let loads = 0;
    const loader: TursoDriverLoader = async () => {
      loads += 1;
      if (loads === 1) throw new Error('driver not installed yet');
      return { createClient: () => recording.client };
    };
    const storage = new TursoClientStorage({ url: 'libsql://x.turso.io' }, loader);

    expect(await throwingRejectionOf(storage.get('a'))).toThrow('driver not installed yet');
    expect(await storage.get('a')).toBeNull();
    expect(loads).toBe(2);
    storage[Symbol.dispose]();
  });

  it('refuses further use once disposed, without importing the driver', async () => {
    let loads = 0;
    const storage = new TursoClientStorage({ url: 'libsql://x.turso.io' }, async () => {
      loads += 1;
      return { createClient: () => createRecordingClient().client };
    });
    storage[Symbol.dispose]();

    expect(await throwingRejectionOf(storage.get('a'))).toThrow('has been disposed');
    expect(loads).toBe(0);
  });
});
