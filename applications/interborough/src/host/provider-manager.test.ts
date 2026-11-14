import type { WorkspaceIdentity } from '@lostgradient/weft';
import {
  createHostMutationContext,
  createLocalHostMutationContext,
} from './host-mutation-context.ts';
/**
 * The provider manager against a home it does not own: a remote home refuses every write for the
 * reason `deployment`, and a write that fails leaves what the host serves as it was. The home is
 * a record of what was written, so a test can say that nothing was.
 */
import { SecretProviderError, type Bungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate } from '@lostgradient/bureau';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { contributedFixtures, vendorRows } from './provider-fixtures.test-support.ts';
import {
  createProviderManager,
  ProviderInputError,
  ProviderWriteLockedError,
  type ProviderAuditEntry,
} from './provider-manager.ts';
import { HOST_CATALOG_ROUTE, providerRoutes } from './provider-routes.ts';
import { fakeProvider, STUB_PROVIDER_REJECTED_KEY_MARKER } from './stub-provider.ts';
import { fixtureSecretProvider } from './tool-source-memory-home.test-support.ts';

const KEY = 'fixture-key-manager-5d21';

type FakeHome = Pick<
  Bungalow,
  | 'mode'
  | 'workspaceId'
  | 'configurationLocation'
  | 'readConfiguration'
  | 'writeConfiguration'
  | 'secretProvider'
  | 'configurationWriteCapability'
> & {
  readonly writes: string[];
  configuration: string | undefined;
  readonly secrets: Map<string, string>;
  unreadable: boolean;
};

function fakeHome(
  mode: 'local' | 'remote',
  options: {
    readonly failConfiguration?: boolean;
    readonly unknownConfiguration?: boolean;
    readonly failRestore?: boolean;
    readonly failEverySecret?: boolean;
    /** The first write of a secret reaches the disk and then throws, as a failed directory sync does. */
    readonly throwAfterStoring?: boolean;
    /** After the first secret write, reading a secret throws. */
    readonly failRead?: boolean;
  } = {},
): FakeHome {
  const secrets = new Map([['anthropic-api-key', 'fixture-existing-key']]);
  const providerState = {
    secrets,
    secretWrites: 0,
    secretWritesBeforeFailing:
      options.failEverySecret === true
        ? 0
        : options.throwAfterStoring === true
          ? 1
          : Number.POSITIVE_INFINITY,
  };
  const home: FakeHome = {
    mode,
    workspaceId: 'provider-manager-fixture',
    configurationWriteCapability: mode === 'local' ? 'writable' : 'read-only',
    configurationLocation: 's3://state/configuration.json',
    writes: [],
    configuration: JSON.stringify({
      plugins: { anthropic: { configuration: { models: ['sonnet'] } } },
    }),
    secrets,
    unreadable: false,
    readConfiguration: async () => ({
      text: home.configuration,
      revision: home.configuration === undefined ? null : Bun.hash(home.configuration).toString(),
    }),
    writeConfiguration: async (text, condition) => {
      if (
        condition.expectedRevision !==
        (home.configuration === undefined ? null : Bun.hash(home.configuration).toString())
      )
        return { outcome: 'conflict' };
      home.writes.push('configuration');
      if (options.failConfiguration === true) return { outcome: 'unavailable' };
      if (options.unknownConfiguration === true) return { outcome: 'unknown' };
      home.configuration = text;
      return { outcome: 'committed' };
    },
    secretProvider: fixtureSecretProvider(
      'provider-manager-fixture',
      providerState,
      mode === 'local',
    ),
  };
  return home;
}

async function managerFor(
  home: FakeHome,
  audits: ProviderAuditEntry[] = [],
  resolver: typeof resolveProviderGenerate = resolveProviderGenerate,
) {
  const manager = createProviderManager({
    bungalow: home,
    warn: () => undefined,
    resolveProviderGenerate: resolver,
    audit: async (entry) => {
      audits.push(entry);
    },
  });
  await manager.adopt(contributedFixtures());
  const revisions: number[] = [];
  manager.attach((rows) => {
    // The rows a run can use: a provider without a key keeps its rows, `unavailable` (COR-2143).
    revisions.push(rows.filter((row) => row.availability !== 'unavailable').length);
    return Promise.resolve(revisions.length);
  });
  return { manager, revisions, audits, home };
}

async function failureOf(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('provider admission across hosts', () => {
  test('refreshes committed credentials for old functions without changing an admitted call', async () => {
    const home = fakeHome('local');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const observed: string[] = [];
    const resolver: typeof resolveProviderGenerate = (_definitions, configuration) => {
      const key = configuration.apiKey ?? '';
      return async () => {
        observed.push(key);
        if (observed.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return { content: key, toolCalls: [] };
      };
    };
    const writer = await managerFor(home);
    const observer = await managerFor(home, [], resolver);
    const generate = observer.manager.generateFor({ provider: 'anthropic', model: 'sonnet' });
    const first = createAgent({ name: 'first', generate }).run('First').result();
    await entered.promise;
    try {
      await writer.manager.connect({ provider: 'anthropic', apiKey: KEY });
      await createAgent({ name: 'second', generate }).run('Second').result();
      expect(observed).toEqual(['fixture-existing-key', KEY]);
      const standing = await observer.manager.snapshot();
      const committed = await home.readConfiguration();
      expect(standing.appliedConfigurationRevision).toBe(committed.revision);
    } finally {
      release.resolve();
      await first;
    }
  });
});

test('a missing committed version denies new provider calls without falling back to a legacy key', async () => {
  const home = fakeHome('local');
  const writer = await managerFor(home);
  await writer.manager.connect({ provider: 'anthropic', apiKey: KEY });
  let unavailable = false;
  let dispatched = 0;
  const observerHome = {
    ...home,
    secretProvider: {
      ...home.secretProvider,
      readVersion: async (reference: string) => {
        if (unavailable) throw new SecretProviderError('unavailable', 'Fixture version revoked');
        return home.secretProvider.readVersion(reference);
      },
    },
  };
  const { manager } = await managerFor(observerHome, [], () => async () => {
    dispatched += 1;
    return { content: 'done', toolCalls: [] };
  });
  const generate = manager.generateFor({ provider: 'anthropic', model: 'sonnet' });
  unavailable = true;
  const result = await createAgent({ name: 'denied', generate }).run('No fallback').result();
  expect(result.finishReason).not.toBe('stop-condition');
  expect(dispatched).toBe(0);
});

/** A host holding a decision-only provider, and `alongside` it, that records the key each decision model is built with. */
async function decisionOnlyManager(
  home: FakeHome,
  builtWith: string[],
  alongside: ReturnType<typeof contributedFixtures> = [],
) {
  const [seed] = vendorRows();
  if (seed === undefined) throw new Error('Expected the seed catalog to hold rows.');
  const manager = createProviderManager({
    bungalow: home,
    warn: () => undefined,
    resolveProviderGenerate: () => {
      throw new Error('a decision-only provider has no generate');
    },
  });
  await manager.adopt([
    ...alongside,
    {
      plugin: 'typesafe',
      name: 'typesafe',
      definition: {
        name: 'typesafe',
        decide: (configuration) => {
          builtWith.push(String(configuration.apiKey));
          return {
            name: 'jev',
            kinds: new Set(['boolean']),
            decide: async () => ({ value: true, provider: 'typesafe', model: 'jev' }),
          };
        },
      },
      configuration: {},
      rows: [
        {
          ...seed,
          provider: 'typesafe',
          model: 'jev',
          aliases: [],
          decisions: { kinds: ['boolean'], only: true },
        },
      ],
      secretKey: 'typesafe-api-key',
    },
  ]);
  manager.attach((rows) => Promise.resolve(rows.length));
  return manager;
}

const BOOLEAN_QUESTION = { kind: 'boolean', question: 'Is it so?' } as const;

describe('the provider snapshot of a decision-only provider', () => {
  test('lists neither the provider nor its rows, with or without its key, and still lists the others', async () => {
    const home = fakeHome('local');
    const manager = await decisionOnlyManager(home, [], contributedFixtures(['anthropic']));

    const waiting = await manager.snapshot();
    await manager.connect({ provider: 'typesafe', apiKey: KEY });
    const keyed = await manager.snapshot();

    for (const snapshot of [waiting, keyed]) {
      expect(snapshot.providers.map((provider) => provider.name)).toEqual(['anthropic']);
      expect(snapshot.models.some((model) => model.provider === 'typesafe')).toBe(false);
      expect(snapshot.models.some((model) => model.provider === 'anthropic')).toBe(true);
    }
    // The host still holds the row, so the decisions it answers can be reached.
    expect(manager.current().rows.some((row) => row.model === 'jev')).toBe(true);
  });
});

describe('a native decision across hosts', () => {
  test('is asked with the key another host committed, on every call', async () => {
    const home = fakeHome('local');
    const builtWith: string[] = [];
    const writer = await decisionOnlyManager(home, builtWith);
    await writer.connect({ provider: 'typesafe', apiKey: 'OLD-KEY' });
    const observer = await decisionOnlyManager(home, builtWith);
    builtWith.length = 0;
    const model = observer.decideFor({ provider: 'typesafe', model: 'jev' });
    // Nothing is built with the key this host holds.
    expect(builtWith).toEqual([]);

    await writer.connect({ provider: 'typesafe', apiKey: 'NEW-KEY' });
    builtWith.length = 0;
    await model.decide(BOOLEAN_QUESTION);
    await model.decideBatch?.({ questions: new Map([['q', BOOLEAN_QUESTION]]) });

    expect(builtWith).toEqual(['NEW-KEY', 'NEW-KEY']);
  });

  test('is refused once the committed version of its key is revoked, never asked with the held key', async () => {
    const home = fakeHome('local');
    const builtWith: string[] = [];
    const writer = await decisionOnlyManager(home, builtWith);
    await writer.connect({ provider: 'typesafe', apiKey: 'COMMITTED-KEY' });
    let unavailable = false;
    const observer = await decisionOnlyManager(
      {
        ...home,
        secretProvider: {
          ...home.secretProvider,
          readVersion: async (reference: string) => {
            if (unavailable)
              throw new SecretProviderError('unavailable', 'Fixture version revoked');
            return home.secretProvider.readVersion(reference);
          },
        },
      },
      builtWith,
    );
    builtWith.length = 0;
    const model = observer.decideFor({ provider: 'typesafe', model: 'jev' });

    unavailable = true;

    expect(await failureOf(model.decide(BOOLEAN_QUESTION))).toBeInstanceOf(SecretProviderError);
    expect(builtWith).toEqual([]);
  });
});

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
      routes: providerRoutes(manager, () => undefined, {
        mutation: () => createLocalHostMutationContext(home),
      }),
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

describe('configuration audit metadata', () => {
  test('records committed provider connection and catalog changes without request values', async () => {
    const home = fakeHome('local');
    home.secrets.delete('openai-api-key');
    const initialConfiguration = home.configuration;
    if (initialConfiguration === undefined) throw new Error('expected initial configuration');
    const audits: ProviderAuditEntry[] = [];
    const { manager } = await managerFor(home, audits);

    await manager.connect({ provider: 'openai', apiKey: KEY });
    const connectedConfiguration = home.configuration;
    if (connectedConfiguration === undefined) throw new Error('expected connected configuration');
    await manager.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]);
    const catalogConfiguration = home.configuration;
    if (catalogConfiguration === undefined) throw new Error('expected catalog configuration');

    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      runId: 'provider:openai',
      type: 'provider.connected',
      principal: 'anonymous:local',
      detail: {
        provider: 'openai',
        outcome: 'committed',
        hash: createHash('sha256').update(connectedConfiguration).digest('hex'),
        previousRevision: Bun.hash(initialConfiguration).toString(),
      },
    });
    expect(audits[1]).toMatchObject({
      runId: 'provider:anthropic',
      type: 'provider.configured',
      principal: 'anonymous:local',
      detail: {
        provider: 'anthropic',
        outcome: 'committed',
        changedKeys: ['catalog'],
        hash: createHash('sha256').update(catalogConfiguration).digest('hex'),
        previousRevision: Bun.hash(connectedConfiguration).toString(),
      },
    });
    expect(JSON.stringify(audits)).not.toContain(KEY);
  });

  test('does not audit catalog conflicts or uncertain configuration writes', async () => {
    const conflictHome = fakeHome('local');
    const conflictAudits: ProviderAuditEntry[] = [];
    const { manager: conflictManager } = await managerFor(conflictHome, conflictAudits);
    const conflict = await failureOf(
      conflictManager.editCatalog(
        [{ provider: 'anthropic', model: 'sonnet', off: true }],
        [{ provider: 'anthropic', model: 'different', off: false }],
      ),
    );
    expect(conflict).toBeInstanceOf(Error);
    expect(conflictAudits).toEqual([]);

    const uncertainAudits: ProviderAuditEntry[] = [];
    const { manager: uncertainManager } = await managerFor(
      fakeHome('local', { unknownConfiguration: true }),
      uncertainAudits,
    );
    const uncertain = await failureOf(
      uncertainManager.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]),
    );
    expect(uncertain).toBeInstanceOf(Error);
    expect(uncertainAudits).toEqual([]);
  });
});

describe('the provider snapshot of a keyless provider (COR-2414)', () => {
  test('reports a provider that declares no secret as connected, apart from whether a key is saved', async () => {
    const home = fakeHome('local');
    const manager = createProviderManager({
      bungalow: home,
      warn: () => undefined,
      resolveProviderGenerate,
      audit: async () => undefined,
    });
    await manager.adopt([
      ...contributedFixtures(['anthropic', 'openai']),
      ...contributedFixtures(['gemini']).map((provider) => ({ ...provider, secretKey: undefined })),
    ]);
    manager.attach((rows) => Promise.resolve(rows.length));

    const { providers } = await manager.snapshot();
    const byName = Object.fromEntries(providers.map((provider) => [provider.name, provider]));

    // The keyless provider has no saved key and is connected; the keyed one is connected by its key.
    expect(byName['gemini']).toMatchObject({ hasKey: false, connected: true });
    expect(byName['anthropic']).toMatchObject({ hasKey: true, connected: true });
    // A provider that needs a key it lacks is not connected.
    expect(byName['openai']).toMatchObject({ hasKey: false, connected: false });
  });
});

describe('disconnecting a provider', () => {
  test('a remote home refuses it for the reason `deployment`, writing nothing', async () => {
    const home = fakeHome('remote');
    const { manager, revisions } = await managerFor(home);

    const failure = await failureOf(manager.disconnect('anthropic'));

    expect(failure).toBeInstanceOf(ProviderWriteLockedError);
    expect(home.writes).toEqual([]);
    expect(revisions).toEqual([]);
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
  });

  test('empties the key, leaves the configuration alone, and stops serving the provider', async () => {
    const home = fakeHome('local');
    const { manager, revisions } = await managerFor(home);
    const before = home.configuration;

    await manager.disconnect('anthropic');

    expect(home.writes).toEqual(['configuration']);
    expect(home.configuration).not.toBe(before);
    expect(manager.current().apiKeys.has('anthropic')).toBe(false);
    // The rows stay, so "needs a key" is told from "no such model", and none can be called.
    expect(manager.current().rows.length).toBeGreaterThan(0);
    expect(
      manager
        .current()
        .rows.filter((row) => row.provider === 'anthropic')
        .every((row) => row.availability === 'unavailable'),
    ).toBe(true);
    expect(revisions).toHaveLength(1);
  });

  test('takes its models out of the snapshot the pages list, though the catalog keeps the rows (COR-2143)', async () => {
    const home = fakeHome('local');
    const { manager } = await managerFor(home);
    const before = await manager.snapshot();
    expect(before.models.some((row) => row.provider === 'anthropic')).toBe(true);

    await manager.disconnect('anthropic');

    // The rows stay in the catalog, `unavailable`; the Models page would draw each as "Not allowed".
    expect(manager.current().rows.some((row) => row.provider === 'anthropic')).toBe(true);
    const snapshot = await manager.snapshot();
    expect(snapshot.models.some((row) => row.provider === 'anthropic')).toBe(false);
    expect(snapshot.providers.find((entry) => entry.name === 'anthropic')?.hasKey).toBe(false);
  });

  test('a configuration publication failure keeps the provider active', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager, revisions } = await managerFor(home);

    const failure = await failureOf(manager.disconnect('anthropic'));

    expect(failure).toBeInstanceOf(Error);
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
    expect(revisions).toHaveLength(0);
  });

  test('a write that throws after replacing the file is judged by the disk: the key is gone', async () => {
    const home = fakeHome('local', { throwAfterStoring: true });
    const { manager } = await managerFor(home);

    await manager.disconnect('anthropic');

    expect(manager.current().apiKeys.has('anthropic')).toBe(false);
  });

  test('refuses a provider no plugin contributes, writing nothing', async () => {
    const home = fakeHome('local');
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.disconnect('voyage'));

    expect(failure).toMatchObject({ field: 'provider' });
    expect(home.writes).toEqual([]);
  });

  test('answers DELETE with 403 and the reason for a remote home', async () => {
    const home = fakeHome('remote');
    const { manager } = await managerFor(home);
    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(manager, () => undefined, {
        mutation: () => createLocalHostMutationContext(home),
      }),
    });

    const response = await fetch(new URL('/host/providers/anthropic', server.url), {
      method: 'DELETE',
      body: '{}',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'locked', reason: 'deployment' });
  });
});

describe('a stored catalog edit for a provider no loaded plugin contributes', () => {
  const dormant = { provider: 'voyage', model: 'voyage-3', off: true };

  test('waits, ignored, and does not stop another provider from connecting', async () => {
    const home = fakeHome('local');
    home.configuration = JSON.stringify({ catalog: [dormant] });
    const { manager } = await managerFor(home);

    await manager.connect({ provider: 'anthropic', apiKey: KEY });
    await manager.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]);

    expect(manager.current().apiKeys.get('anthropic')).toBe(KEY);
    const snapshot = await manager.snapshot();
    expect(snapshot.catalog).toEqual([{ provider: 'anthropic', model: 'sonnet', off: true }]);
    // A replacement of the edits leaves the dormant one in the file for its plugin.
    expect(JSON.parse(home.configuration ?? '{}').catalog).toEqual([
      { provider: 'anthropic', model: 'sonnet', off: true },
      dormant,
    ]);
  });

  test('is kept out of the snapshot, and a new edit may not name its provider', async () => {
    const home = fakeHome('local');
    home.configuration = JSON.stringify({ catalog: [dormant] });
    const { manager } = await managerFor(home);

    const snapshot = await manager.snapshot();
    expect(snapshot.catalog).toEqual([]);
    const failure = await failureOf(manager.editCatalog([dormant]));
    expect(String(failure)).toContain('catalog[0].provider');
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
    // Preparation is retained but not activated when publication fails.
    expect(manager.current().rows.map((row) => row.model)).toEqual(models);
    expect([...manager.current().apiKeys.keys()]).toEqual(['anthropic']);
  });

  test('a rotation whose configuration write fails puts the previous key back and keeps using it', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
    expect(String(failure).includes(KEY)).toBe(false);
  });

  test('says so, truthfully, when the previous key cannot be put back either', async () => {
    const home = fakeHome('local', { failConfiguration: true, failRestore: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'unavailable' });
    // The host serves what the disk holds, which is the new key.
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
    // A fresh home, since the fake counts writes per secret.
    const routed = await managerFor(
      fakeHome('local', { failConfiguration: true, failRestore: true }),
    );
    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(routed.manager, () => undefined, {
        mutation: () => createLocalHostMutationContext(routed.home),
      }),
    });
    const response = await fetch(new URL('/host/providers/anthropic', server.url), {
      method: 'PUT',
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ error: 'failed', reason: 'unavailable' });
    expect(text.includes(KEY)).toBe(false);
  });

  test('a key that cannot be written at all is a plain failure: disk and host stay on the old key', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager, revisions } = await managerFor(home);
    const before = home.configuration;
    const loadedBefore = manager.current();

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure).includes(KEY)).toBe(false);
    expect(home.writes).toEqual(['configuration']);
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
    expect(home.configuration).toBe(before);
    expect(manager.current().apiKeys).toEqual(loadedBefore.apiKeys);
    expect(revisions).toEqual([1]);

    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(manager, () => undefined, {
        mutation: () => createLocalHostMutationContext(home),
      }),
    });
    const response = await fetch(new URL('/host/providers/anthropic', server.url), {
      method: 'PUT',
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).error).toBe('failed');
    expect(text.includes('is in use')).toBe(false);
  });

  test('a key write that throws after replacing the file is judged by the disk: the change goes on', async () => {
    const home = fakeHome('local', { throwAfterStoring: true });
    const { manager } = await managerFor(home);

    await manager.connect({ provider: 'anthropic', apiKey: KEY });

    expect(manager.current().apiKeys.get('anthropic')).toBe(KEY);
    expect(home.writes).toEqual(['configuration']);
  });

  test('a key write that throws after replacing the file undoes it when the configuration then fails', async () => {
    const home = fakeHome('local', { throwAfterStoring: true, failConfiguration: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
  });

  test('a key write that throws when the disk cannot be read back reports the failure and keeps what it loaded', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure).includes(KEY)).toBe(false);
    // The disk cannot be read, so the host cannot reload it and keeps the key it loaded.
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
  });

  test('a new provider whose configuration cannot be written does not activate its version', async () => {
    const home = fakeHome('local', { failConfiguration: true });
    const { manager } = await managerFor(home);

    const failure = await failureOf(manager.connect({ provider: 'openai', apiKey: KEY }));

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ code: 'unavailable' });
    expect(String(failure).includes(KEY)).toBe(false);
    expect(home.secrets.get('openai-api-key')).toBeUndefined();
    expect(manager.current().apiKeys.has('openai')).toBe(false);
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
      manager.connect({ provider: 'openai', apiKey: KEY, models: ['gpt-4.1'] }),
      manager.connect({ provider: 'gemini', apiKey: KEY, models: ['pro'] }),
    ]);

    expect(Object.keys(JSON.parse(home.configuration ?? '{}').plugins).toSorted()).toEqual([
      'anthropic',
      'gemini',
      'openai',
    ]);
  });
});

describe('configuration revision conflicts', () => {
  test('preserves a competing writer and requires a fresh explicit retry', async () => {
    const home = fakeHome('local');
    const { manager } = await managerFor(home);
    const write = home.writeConfiguration;
    const competing = JSON.stringify({ retainedByOtherWriter: true });
    let attempts = 0;
    home.writeConfiguration = async (text, condition) => {
      attempts += 1;
      home.configuration = competing;
      return write(text, condition);
    };
    const failure = await failureOf(
      manager.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]),
    );
    expect(failure).toMatchObject({ code: 'conflict' });
    expect(home.configuration).toBe(competing);
    expect(attempts).toBe(1);
    home.writeConfiguration = write;
    await manager.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]);
    expect(JSON.parse(home.configuration ?? '{}')).toMatchObject({ retainedByOtherWriter: true });
  });

  test('does not restore the prior credential after an unknown configuration commit', async () => {
    const home = fakeHome('local');
    const { manager } = await managerFor(home);
    home.writeConfiguration = async (text) => {
      home.configuration = text;
      return { outcome: 'unknown' };
    };
    const failure = await failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }));
    expect(failure).toBeUndefined();
    expect(home.configuration).toContain('secretBindings');
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
    expect(home.writes.filter((entry) => entry === 'secret anthropic-api-key')).toHaveLength(0);
  });
});

describe('workspace provider mutation authority', () => {
  const administrator: WorkspaceIdentity = {
    version: 1,
    workspaceId: 'provider-manager-fixture',
    actorId: 'administrator',
    actorKind: 'user',
    owner: 'owner-administrator',
    membershipRevision: '1',
    capabilities: ['workspace:use', 'workspace:manage'],
  };

  test('remote configuration and credential capabilities are independent', async () => {
    const original = fakeHome('local');
    const home = { ...original, mode: 'remote' as const };
    const { manager } = await managerFor(home);
    const originalSnapshot = await home.readConfiguration();
    const mutation = createHostMutationContext(
      administrator,
      { operationId: 'remote-provider', expectedRevision: originalSnapshot.revision },
      async () => administrator,
    );
    await manager.connect({ provider: 'anthropic', apiKey: KEY }, mutation);
    const writableSnapshot = await manager.snapshot();
    expect(writableSnapshot.credentialLockReason).toBeUndefined();
    const readOnly = {
      ...home,
      secretProvider: {
        ...home.secretProvider,
        capabilities: { read: true as const, prepare: false, transitions: false },
      },
    };
    const { manager: observer } = await managerFor(readOnly);
    const observerSnapshot = await observer.snapshot();
    expect(observerSnapshot.credentialLockReason).toBe('deployment');
    expect(observerSnapshot.lockReason).toBeUndefined();
    await observer.editCatalog([{ provider: 'anthropic', model: 'sonnet', off: true }]);
    expect(
      await failureOf(observer.connect({ provider: 'anthropic', apiKey: 'refused' })),
    ).toMatchObject({ code: 'read-only' });
  });
  test('attributes writes and observes repeated operation IDs without another publication', async () => {
    const home = fakeHome('local');
    const { manager, audits } = await managerFor(home);
    const snapshot = await home.readConfiguration();
    const mutation = createHostMutationContext(
      administrator,
      { operationId: 'connect-one', expectedRevision: snapshot.revision },
      async () => administrator,
    );
    await manager.connect({ provider: 'anthropic', apiKey: KEY }, mutation);
    const writes = home.writes.length;
    await manager.connect({ provider: 'anthropic', apiKey: KEY }, mutation);
    expect(home.writes.length).toBe(writes);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      principal: administrator.owner,
      detail: {
        actorId: administrator.actorId,
        workspaceId: administrator.workspaceId,
        membershipRevision: '1',
      },
    });
  });

  test('two hosts using one configuration revision cannot overwrite the winning credential', async () => {
    const home = fakeHome('local');
    const first = await managerFor(home);
    const second = await managerFor(home);
    const snapshot = await home.readConfiguration();
    const context = (id: string) =>
      createHostMutationContext(
        administrator,
        { operationId: id, expectedRevision: snapshot.revision },
        async () => administrator,
      );
    await first.manager.connect({ provider: 'anthropic', apiKey: 'winner' }, context('first'));
    expect(
      await failureOf(
        second.manager.connect({ provider: 'anthropic', apiKey: 'loser' }, context('second')),
      ),
    ).toMatchObject({ code: 'conflict' });
    expect(second.manager.current().apiKeys.get('anthropic')).toBe('winner');
  });

  test('one operation ID binds the model allowlist as well as the credential', async () => {
    const home = fakeHome('local');
    const first = await managerFor(home);
    const second = await managerFor(home);
    const snapshot = await home.readConfiguration();
    const mutation = createHostMutationContext(
      administrator,
      { operationId: 'same-request', expectedRevision: snapshot.revision },
      async () => administrator,
    );
    const results = await Promise.allSettled([
      first.manager.connect({ provider: 'anthropic', apiKey: KEY, models: ['sonnet'] }, mutation),
      second.manager.connect({ provider: 'anthropic', apiKey: KEY, models: null }, mutation),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection?.status === 'rejected' ? rejection.reason : undefined).toMatchObject({
      code: 'conflict',
    });
    const writes = home.writes.length;
    expect(
      await first.manager
        .connect(
          {
            provider: 'anthropic',
            apiKey: KEY,
            models: results[0]?.status === 'fulfilled' ? null : ['sonnet'],
          },
          mutation,
        )
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
    ).toMatchObject({ code: 'conflict' });
    expect(home.writes.length).toBe(writes);
  });

  test('revalidates after secret preparation before committing configuration', async () => {
    const home = fakeHome('local');
    const prepared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = home.secretProvider;
    const guardedHome = {
      ...home,
      secretProvider: {
        ...original,
        async prepare(input: Parameters<typeof original.prepare>[0]) {
          const result = await original.prepare(input);
          prepared.resolve();
          await release.promise;
          return result;
        },
      },
    };
    const { manager } = await managerFor(guardedHome);
    let current: WorkspaceIdentity | undefined = administrator;
    const snapshot = await home.readConfiguration();
    const mutation = createHostMutationContext(
      administrator,
      { operationId: 'revoked', expectedRevision: snapshot.revision },
      async () => current,
    );
    const result = failureOf(manager.connect({ provider: 'anthropic', apiKey: KEY }, mutation));
    await prepared.promise;
    current = undefined;
    release.resolve();
    expect(await result).toMatchObject({ code: 'forbidden' });
    expect(home.writes).toEqual([]);
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
  });
});

describe('testing a key', () => {
  async function testingManager(home: FakeHome) {
    const provider = fakeProvider('ok');
    const manager = createProviderManager({
      bungalow: home,
      warn: () => undefined,
      resolveProviderGenerate: provider.resolver,
    });
    await manager.adopt(contributedFixtures());
    manager.attach((rows) => Promise.resolve(rows.length));
    return { manager, provider };
  }

  test('says an accepted key works and how many models it would add, storing nothing', async () => {
    const home = fakeHome('local');
    home.secrets.clear();
    const { manager, provider } = await testingManager(home);

    const result = await manager.testKey({ provider: 'anthropic', apiKey: KEY });

    expect(result).toEqual({ ok: true, models: 1 });
    // The candidate key was the one the request used, one token was asked for, and nothing was kept.
    expect(provider.handed.map((handed) => Reflect.get(handed, 'apiKey'))).toEqual([KEY]);
    expect(home.writes).toEqual([]);
    expect(home.secrets.size).toBe(0);
    expect(manager.current().apiKeys.has('anthropic')).toBe(false);
  });

  test('says a refused key was refused, with the status and no message, storing nothing', async () => {
    const home = fakeHome('local');
    const { manager } = await testingManager(home);
    const refused = `${KEY}-${STUB_PROVIDER_REJECTED_KEY_MARKER}`;

    const result = await manager.testKey({ provider: 'anthropic', apiKey: refused });

    expect(result).toEqual({ ok: false, status: 401 });
    expect(JSON.stringify(result).includes(refused)).toBe(false);
    expect(home.writes).toEqual([]);
    expect(home.secrets.get('anthropic-api-key')).toBe('fixture-existing-key');
    expect(manager.current().apiKeys.get('anthropic')).toBe('fixture-existing-key');
  });

  test('reaches a client for every provider the host offers, accepting and refusing alike', async () => {
    const { manager } = await testingManager(fakeHome('local'));

    for (const provider of ['anthropic', 'openai', 'gemini']) {
      const accepted = await manager.testKey({ provider, apiKey: KEY });
      const refused = await manager.testKey({
        provider,
        apiKey: `${KEY}-${STUB_PROVIDER_REJECTED_KEY_MARKER}`,
      });
      expect(accepted, provider).toMatchObject({ ok: true });
      expect(refused, provider).toEqual({ ok: false, status: 401 });
    }
  });

  test('tests the key of a decision-only provider with one decision, since it has no generate to probe with (COR-2157)', async () => {
    const [seed] = vendorRows();
    if (seed === undefined) throw new Error('Expected the seed catalog to hold rows.');
    const asked: { readonly apiKey: unknown; readonly kind: string }[] = [];
    const home = fakeHome('local');
    const manager = createProviderManager({
      bungalow: home,
      warn: () => undefined,
      resolveProviderGenerate: () => {
        throw new Error('a decision-only provider has no generate to reach');
      },
    });
    await manager.adopt([
      {
        plugin: 'typesafe',
        name: 'typesafe',
        definition: {
          name: 'typesafe',
          decide: (configuration) => ({
            name: 'jev',
            kinds: new Set(['boolean']),
            decide: async (request) => {
              asked.push({ apiKey: configuration.apiKey, kind: request.kind });
              if (configuration.apiKey === `${KEY}-refused`) throw new Error('refused');
              return { value: true, provider: 'typesafe', model: 'jev' };
            },
          }),
        },
        configuration: {},
        rows: [
          {
            ...seed,
            provider: 'typesafe',
            model: 'jev',
            aliases: [],
            decisions: { kinds: ['boolean'], only: true },
          },
        ],
        secretKey: 'typesafe-api-key',
      },
    ]);
    manager.attach((rows) => Promise.resolve(rows.length));

    expect(await manager.testKey({ provider: 'typesafe', apiKey: KEY })).toEqual({
      ok: true,
      models: 1,
    });
    expect(await manager.testKey({ provider: 'typesafe', apiKey: `${KEY}-refused` })).toEqual({
      ok: false,
    });
    expect(asked).toEqual([
      { apiKey: KEY, kind: 'boolean' },
      { apiKey: `${KEY}-refused`, kind: 'boolean' },
    ]);
    expect(home.writes).toEqual([]);
  });

  test('tests a key even when the host cannot save one, since testing writes nothing', async () => {
    const { manager } = await testingManager(fakeHome('remote'));

    expect(await manager.testKey({ provider: 'anthropic', apiKey: KEY })).toMatchObject({
      ok: true,
    });
  });

  test('refuses a request it cannot use, naming the field and never the key', async () => {
    const { manager } = await testingManager(fakeHome('local'));

    const empty = await failureOf(manager.testKey({ provider: 'anthropic', apiKey: '  ' }));
    const unknown = await failureOf(manager.testKey({ provider: 'voyage', apiKey: KEY }));

    expect(empty).toBeInstanceOf(ProviderInputError);
    expect(empty).toMatchObject({ field: 'apiKey' });
    expect(unknown).toMatchObject({ field: 'provider' });
    expect(String(unknown).includes(KEY)).toBe(false);
  });

  test('rethrows when the caller stopped it, so a cancel is not reported as a refused key', async () => {
    const controller = new AbortController();
    controller.abort();
    const abortingManager = createProviderManager({
      bungalow: fakeHome('local'),
      warn: () => undefined,
      resolveProviderGenerate: () => () =>
        Promise.reject(new DOMException('Stopped', 'AbortError')),
    });
    await abortingManager.adopt(contributedFixtures());

    const failure = await failureOf(
      abortingManager.testKey({ provider: 'anthropic', apiKey: KEY }, controller.signal),
    );

    expect(failure).toBeInstanceOf(DOMException);
  });

  test('answers POST with the result as JSON, and never repeats the key', async () => {
    const home = fakeHome('local');
    const { manager } = await testingManager(home);
    using server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      routes: providerRoutes(manager, () => undefined, {
        mutation: () => createLocalHostMutationContext(home),
      }),
    });
    const post = (apiKey: string) =>
      fetch(new URL('/host/providers/anthropic/test', server.url), {
        method: 'POST',
        body: JSON.stringify({ apiKey }),
      });

    const accepted = await post(KEY);
    const refused = await post(`${KEY}-${STUB_PROVIDER_REJECTED_KEY_MARKER}`);
    const invalid = await fetch(new URL('/host/providers/anthropic/test', server.url), {
      method: 'POST',
      body: JSON.stringify({}),
    });

    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, models: 1 });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toEqual({ ok: false, status: 401 });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: 'invalid', field: 'apiKey' });
  });
});
