/**
 * The provider manager against a home it does not own: a remote home refuses every write for the
 * reason `deployment`, and a write that fails leaves what the host serves as it was. The home is
 * a record of what was written, so a test can say that nothing was.
 */
import type { Bungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';

import {
  createProviderManager,
  ProviderPartialChangeError,
  ProviderWriteLockedError,
} from './provider-manager.ts';
import { HOST_CATALOG_ROUTE, providerRoutes } from './provider-routes.ts';

const KEY = 'fixture-key-manager-5d21';

type FakeHome = Pick<
  Bungalow,
  | 'mode'
  | 'configurationLocation'
  | 'readConfiguration'
  | 'writeConfiguration'
  | 'readSecret'
  | 'writeSecret'
> & {
  readonly writes: string[];
  configuration: string | undefined;
  readonly secrets: Map<string, string>;
};

function fakeHome(
  mode: 'local' | 'remote',
  options: {
    readonly failConfiguration?: boolean;
    readonly failRestore?: boolean;
    readonly failEverySecret?: boolean;
  } = {},
): FakeHome {
  const home: FakeHome = {
    mode,
    configurationLocation: 's3://state/configuration.json',
    writes: [],
    configuration: JSON.stringify({ providers: { anthropic: { models: ['sonnet'] } } }),
    secrets: new Map([['anthropic-api-key', 'fixture-existing-key']]),
    readConfiguration: () => Promise.resolve(home.configuration),
    writeConfiguration: (text) => {
      home.writes.push('configuration');
      if (options.failConfiguration === true) throw new Error('The disk is full.');
      home.configuration = text;
    },
    readSecret: (key) => home.secrets.get(key),
    writeSecret: (key, value) => {
      home.writes.push(`secret ${key}`);
      if (options.failEverySecret === true) throw new Error('The disk is full.');
      // The second write of one secret is the restore.
      if (
        options.failRestore === true &&
        home.writes.filter((write) => write === `secret ${key}`).length > 1
      ) {
        throw new Error('The disk is full.');
      }
      home.secrets.set(key, value);
    },
  };
  return home;
}

async function managerFor(home: FakeHome) {
  const manager = await createProviderManager({
    bungalow: home,
    warn: () => undefined,
    resolveProviderGenerate,
  });
  const revisions: number[] = [];
  manager.attach((rows) => {
    revisions.push(rows.length);
    return Promise.resolve(revisions.length);
  });
  return { manager, revisions };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('a remote home', () => {
  test('refuses to connect a provider or edit the catalog, writing nothing and reporting `deployment`', async () => {
    const home = fakeHome('remote');
    const { manager, revisions } = await managerFor(home);
    const before = home.configuration;

    const connect = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));
    const edit = await failureOf(
      manager.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]),
    );

    for (const failure of [connect, edit]) {
      expect(failure).toBeInstanceOf(ProviderWriteLockedError);
      expect((failure as ProviderWriteLockedError).reason).toBe('deployment');
      expect(String(failure).includes(KEY)).toBe(false);
    }
    expect(home.writes).toEqual([]);
    expect(home.configuration).toBe(before);
    expect(revisions).toEqual([]);
    expect(manager.lockReason()).toBe('deployment');
    const snapshot = await manager.snapshot();
    expect(snapshot.lockReason).toBe('deployment');
  });

  test('still reloads, since reading is not a write', async () => {
    const home = fakeHome('remote');
    const { manager, revisions } = await managerFor(home);

    await manager.reload();

    expect(revisions).toHaveLength(1);
  });

  test('answers a write over HTTP with 403, the reason, and no key', async () => {
    const home = fakeHome('remote');
    const { manager } = await managerFor(home);
    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(manager, () => undefined),
    });
    const connect = await fetch(new URL('/host/providers/anthropic', server.url), {
      method: 'PUT',
      body: JSON.stringify({ apiKey: KEY }),
    });
    const catalog = await fetch(new URL(HOST_CATALOG_ROUTE, server.url), {
      method: 'PUT',
      body: JSON.stringify({ edits: [] }),
    });

    for (const response of [connect, catalog]) {
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ error: 'locked', reason: 'deployment' });
      expect(text.includes(KEY)).toBe(false);
    }
    expect(home.writes).toEqual([]);
  });
});

describe('a write that fails', () => {
  test('keeps serving the previous configuration, and the error does not hold the key', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager } = await managerFor(home);
    const before = home.configuration;
    const models = manager.current().rows.map((row) => row.model);

    const failure = await failureOf(manager.connect({ provider: 'openai', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure).includes(KEY)).toBe(false);
    expect(home.configuration).toBe(before);
    // The key reached the disk before the configuration failed, and was put back: an empty value
    // reads as no key, and the provider is not listed either way.
    expect(home.secrets.get('openai-api-key')).toBe('');
    expect(manager.current().rows.map((row) => row.model)).toEqual(models);
    expect([...manager.current().apiKeys.keys()]).toEqual(['anthropic']);
  });

  test('a rotation whose configuration write fails puts the previous key back and keeps using it', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProviderPartialChangeError);
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
    expect(String(failure).includes(KEY)).toBe(false);
  });

  test('says so, truthfully, when the previous key cannot be put back either', async () => {
    const home = fakeHome('local', { failConfiguration: true, failRestore: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(ProviderPartialChangeError);
    expect((failure as ProviderPartialChangeError).inUse).toBe(true);
    expect(String(failure)).toContain('is in use');
    // The host serves what the disk holds, which is the new key.
    expect(manager.current().apiKeys.get('anthropic')).toBe(KEY);
    // A fresh home, since the fake counts writes per secret.
    const routed = await managerFor(
      fakeHome('local', { failConfiguration: true, failRestore: true }),
    );
    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(routed.manager, () => undefined),
    });
    const response = await fetch(new URL('/host/providers/anthropic', server.url), {
      method: 'PUT',
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({
      error: 'partial',
      provider: 'anthropic',
      inUse: true,
    });
    expect(text.includes(KEY)).toBe(false);
  });

  test('a key that cannot be written at all is a plain failure: disk and host stay on the old key', async () => {
    const home = fakeHome('local', { failEverySecret: true });
    const { manager, revisions } = await managerFor(home);
    const before = home.configuration;
    const loadedBefore = manager.current();

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ProviderPartialChangeError);
    expect(String(failure).includes(KEY)).toBe(false);
    // Only the first write was tried: there was nothing to undo.
    expect(home.writes).toEqual(['secret anthropic-api-key']);
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
    expect(home.configuration).toBe(before);
    expect(manager.current()).toBe(loadedBefore);
    expect(revisions).toEqual([]);

    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(manager, () => undefined),
    });
    const response = await fetch(new URL('/host/providers/anthropic', server.url), {
      method: 'PUT',
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text).error).toBe('failed');
    expect(text.includes('is in use')).toBe(false);
  });

  test('a new provider whose configuration cannot be written is stored but not in use, and the message says so', async () => {
    const home = fakeHome('local', { failConfiguration: true, failRestore: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'openai', apiKey: KEY }));

    expect(failure).toBeInstanceOf(ProviderPartialChangeError);
    expect((failure as ProviderPartialChangeError).inUse).toBe(false);
    expect(String(failure)).toContain('not in use');
    expect(String(failure).includes(KEY)).toBe(false);
    // The key is on the disk, and the host does not call the provider with it.
    expect(home.secrets.get('openai-api-key')).toBe(KEY);
    expect(manager.current().apiKeys.has('openai')).toBe(false);
    expect([...manager.current().apiKeys.keys()]).toEqual(['anthropic']);
  });

  test('a change after close is refused', async () => {
    const home = fakeHome('local');
    const { manager } = await managerFor(home);
    manager.close();

    const failure = await failureOf(manager.connect({ provider: 'openai', apiKey: KEY }));

    expect(String(failure)).toContain('shutting down');
    expect(home.writes).toEqual([]);
  });

  test('writes never interleave: two connects both land', async () => {
    const home = fakeHome('local');
    const { manager } = await managerFor(home);

    await Promise.all([
      manager.connect({ provider: 'openai', apiKey: KEY }),
      manager.connect({ provider: 'gemini', apiKey: KEY }),
    ]);

    expect(Object.keys(JSON.parse(home.configuration ?? '{}').providers).toSorted()).toEqual([
      'anthropic',
      'gemini',
      'openai',
    ]);
  });
});
