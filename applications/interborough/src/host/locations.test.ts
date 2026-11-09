import type { Bungalow } from '@lostgradient/bungalow';
import { createManualRuntimeServices } from '@lostgradient/bureau';
import type { DefinitionSource } from '@lostgradient/bureau/sources';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixtureSecretProvider } from './tool-source-memory-home.test-support.ts';

import { MemoryStorage, storageStat } from '@lostgradient/storage';
import {
  REMOTE_POLL_INTERVAL_MILLISECONDS,
  claimWorkspaceBinding,
  createAgentSource,
  createHostStorage,
  createPluginAgentSource,
  createPluginSkillSource,
  createPluginWorkflowSource,
  createWorkflowSource,
  describeContent,
  disposeHostStorage,
  hostPathsReport,
  hostWriteLocks,
  redactDatabase,
  type LocalDirectoryOptions,
} from './locations.ts';

describe('the locations the host reports', () => {
  test('a sqlite database is its path, and a directory is its path', () => {
    expect(redactDatabase({ kind: 'sqlite', path: '/home/database.sqlite' })).toEqual({
      kind: 'sqlite',
      path: '/home/database.sqlite',
    });
    expect(describeContent({ kind: 'directory', path: '/home/agents' })).toBe('/home/agents');
  });

  test('a postgres database is its host and database name, never its credential', () => {
    const redacted = redactDatabase({
      kind: 'postgres',
      url: 'postgresql://app:p%40ssw0rd@db.example.com:5432/interborough?sslmode=require&password=x',
    });
    expect(redacted).toEqual({ kind: 'postgres', location: 'db.example.com:5432/interborough' });
    expect(JSON.stringify(redacted)).not.toContain('ssw0rd');
    expect(JSON.stringify(redacted)).not.toContain('app');
  });

  test('s3 content is s3://<bucket>/<prefix>', () => {
    expect(describeContent({ kind: 's3', bucket: 'state', prefix: 'prod/agents/' })).toBe(
      's3://state/prod/agents/',
    );
    expect(describeContent({ kind: 's3', bucket: 'state', prefix: 'agents/' })).toBe(
      's3://state/agents/',
    );
  });
});

describe('the backend report', () => {
  const URL_WITH_CREDENTIALS =
    'postgresql://app-user:s3cret-p%40ss@db.example.com:5432/interborough?sslmode=require&password=s3cret-p%40ss';
  const home = {
    mode: 'remote' as const,
    workspaceId: 'locations-fixture',
    configurationWriteCapability: 'read-only' as const,
    secretProvider: fixtureSecretProvider('locations-fixture', { secrets: new Map() }, false),
    database: { kind: 'postgres' as const, url: URL_WITH_CREDENTIALS },
    configurationLocation: 's3://state/prod/configuration.json',
  };

  test('names the mode, the database server, and the content, and no credential', () => {
    const report = hostPathsReport(
      home,
      {
        agents: { kind: 's3', bucket: 'state', prefix: 'prod/agents/' },
        workflows: { kind: 's3', bucket: 'state', prefix: 'prod/workflows/' },
      },
      [{ name: 'anthropic', secretKey: 'anthropic-api-key' }],
      'https://agents.example.com/bureau/a2a/.well-known/agent-card.json',
    );
    expect(report).toEqual({
      mode: 'remote',
      database: { kind: 'postgres', location: 'db.example.com:5432/interborough' },
      agentDirectory: 's3://state/prod/agents/',
      workflowDirectory: 's3://state/prod/workflows/',
      configurationFile: 's3://state/prod/configuration.json',
      locked: { configuration: 'deployment', providerKeys: 'deployment' },
      providers: [
        { name: 'anthropic', secretFile: 'workspace:locations-fixture/anthropic-api-key' },
      ],
      a2aDirectoryUrl: 'https://agents.example.com/bureau/a2a/.well-known/agent-card.json',
    });
    const text = JSON.stringify(report);
    for (const secret of ['app-user', 's3cret', 'p%40ss', 'sslmode']) {
      expect(text).not.toContain(secret);
    }
  });

  test('a local home reports its SQLite file and directories', () => {
    expect(
      hostPathsReport(
        {
          ...home,
          mode: 'local',
          workspaceId: 'locations-fixture',
          configurationWriteCapability: 'writable' as const,
          secretProvider: fixtureSecretProvider('locations-fixture', { secrets: new Map() }, true),
          database: { kind: 'sqlite', path: '/home/database.sqlite' },
          configurationLocation: '/home/configuration.json',
        },
        {
          agents: { kind: 'directory', path: '/home/agents' },
          workflows: { kind: 'directory', path: '/home/workflows' },
        },
        [],
        'http://127.0.0.1:4310/bureau/a2a/.well-known/agent-card.json',
      ),
    ).toMatchObject({
      mode: 'local',
      database: { kind: 'sqlite', path: '/home/database.sqlite' },
      agentDirectory: '/home/agents',
      locked: {},
    });
  });
});

describe('the storage for a database location', () => {
  test('a sqlite location opens the file, and the host releases it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-locations-'));
    try {
      const storage = createHostStorage({
        kind: 'sqlite',
        path: join(directory, 'database.sqlite'),
      });
      await storage.put('key', new TextEncoder().encode('value'));
      const stored = await storage.get('key');
      expect(stored === null ? null : new TextDecoder().decode(stored)).toBe('value');
      await disposeHostStorage(storage);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('a sqlite location records each key\u2019s write time from the clock the host gives it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interborough-locations-'));
    try {
      const written = Date.UTC(2026, 10, 2, 16, 44);
      const storage = createHostStorage(
        { kind: 'sqlite', path: join(directory, 'database.sqlite') },
        () => written,
      );
      await storage.put('key', new TextEncoder().encode('value'));
      expect(await storageStat(storage, 'key')).toEqual({ updatedAt: written });
      await disposeHostStorage(storage);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('claims one canonical binding and refuses a different prefix or workspace', async () => {
    using storage = new MemoryStorage();
    await claimWorkspaceBinding(storage, 'prod/', 'workspace-a');
    await claimWorkspaceBinding(storage, 'prod/', 'workspace-a');
    expect(
      await throwingRejectionOf(claimWorkspaceBinding(storage, 'other/', 'workspace-b')),
    ).toThrow('already bound');
  });
});

describe('the agent layer of a plugin’s shipped content', () => {
  test('is the read-only layer of the content’s agents folder for a file: URL', () => {
    const layer = createPluginAgentSource('shipper', new URL('file:///plugins/shipper/content/'));
    expect(layer).toMatchObject({ kind: 'agent', plugin: 'shipper' });
  });

  test('is nothing for content that is not a file: URL', () => {
    expect(
      createPluginAgentSource('shipper', new URL('https://example.com/content/')),
    ).toBeUndefined();
  });
});

describe('the workflow layer of a plugin’s shipped content', () => {
  test('is the read-only layer of the content’s workflows folder for a file: URL', () => {
    const layer = createPluginWorkflowSource(
      'shipper',
      new URL('file:///plugins/shipper/content/'),
    );
    expect(layer).toMatchObject({ kind: 'workflow', plugin: 'shipper' });
  });

  test('is nothing for content that is not a file: URL', () => {
    expect(
      createPluginWorkflowSource('shipper', new URL('https://example.com/content/')),
    ).toBeUndefined();
  });
});

describe('the skill source of a plugin’s shipped content', () => {
  test('is a plugin source over the content’s skills folder, which no configured id can equal', () => {
    expect(
      createPluginSkillSource('shipper', new URL('file:///plugins/shipper/content/')),
    ).toMatchObject({
      id: 'plugin:shipper',
      kind: 'plugin',
      location: '/plugins/shipper/content/skills',
      plugin: 'shipper',
    });
  });

  test('is nothing for content that is not a file: URL', () => {
    expect(
      createPluginSkillSource('shipper', new URL('https://example.com/content/')),
    ).toBeUndefined();
  });
});

for (const prepare of [false, true]) {
  for (const transitions of [false, true]) {
    for (const configurationWriteCapability of ['writable', 'read-only', 'unsupported'] as const) {
      test(`credential publication lock reflects prepare=${prepare}, transitions=${transitions}, configuration=${configurationWriteCapability}`, () => {
        const provider = fixtureSecretProvider('locations-fixture', { secrets: new Map() }, true);
        const report = hostWriteLocks({
          configurationWriteCapability,
          secretProvider: { ...provider, capabilities: { read: true, prepare, transitions } },
        });
        expect(report.providerKeys).toBe(
          prepare && transitions && configurationWriteCapability === 'writable'
            ? undefined
            : 'deployment',
        );
      });
    }
  }
}

describe('the watch mode of the local directory sources (COR-2291)', () => {
  /** A home with no bucket: a directory source never asks it for one. */
  const directoryHome = {} as Bungalow;
  const content = { kind: 'directory', path: '/never/created/by/this/test' } as const;
  const shipped = pathToFileURL('/plugins/shipper/content/');

  const factories: ReadonlyArray<{
    readonly name: string;
    readonly make: (options: LocalDirectoryOptions) => DefinitionSource | undefined;
  }> = [
    {
      name: 'the owner’s agents',
      make: (options) => createAgentSource(directoryHome, content, {}, options),
    },
    {
      name: 'the owner’s workflows',
      make: (options) => createWorkflowSource(directoryHome, content, options),
    },
    {
      name: 'a plugin’s agents',
      make: (options) => createPluginAgentSource('shipper', shipped, options),
    },
    {
      name: 'a plugin’s workflows',
      make: (options) => createPluginWorkflowSource('shipper', shipped, options),
    },
  ];

  /**
   * Watch `source` on a manual clock and report what it armed: the native watchers it asked for,
   * and the timers it holds while it watches. Then stop it, waiting for any scan in flight.
   */
  async function armed(
    make: (options: LocalDirectoryOptions) => DefinitionSource | undefined,
    watch: LocalDirectoryOptions['watch'],
  ) {
    const runtime = createManualRuntimeServices({ origin: '2026-11-09T00:00:00.000Z' });
    const nativeWatches: string[] = [];
    const diagnoses: string[] = [];
    const source = make({
      ...(watch === undefined ? {} : { watch }),
      watchFactory: (path) => {
        nativeWatches.push(path);
        return { on: () => undefined, close: () => undefined } as never;
      },
    });
    if (source === undefined) throw new Error('The factory built no source.');
    source.attach?.({ runtime, diagnose: (message) => diagnoses.push(message) });
    const stop = source.watch(() => undefined);
    const timers = runtime.pendingTimers().length;
    // A load waits for the scan the watch began, which arms the native watchers before it reads.
    await source.load();
    await stop();
    return { timers, nativeWatches, diagnoses, timersAfterStop: runtime.pendingTimers().length };
  }

  for (const { name, make } of factories) {
    test(`${name} poll without a native watcher under 'poll'`, async () => {
      const result = await armed(make, 'poll');
      expect(result.timers).toBe(1);
      expect(result.nativeWatches).toEqual([]);
      expect(result.timersAfterStop).toBe(0);
      expect(result.diagnoses).toEqual([]);
    });

    test(`${name} watch natively, with the rescan behind it, by default`, async () => {
      const result = await armed(make, undefined);
      expect(result.timers).toBe(1);
      expect(result.nativeWatches.length).toBeGreaterThan(0);
      expect(result.timersAfterStop).toBe(0);
    });

    test(`${name} arm nothing under false`, async () => {
      const result = await armed(make, false);
      expect(result.timers).toBe(0);
      expect(result.nativeWatches).toEqual([]);
    });
  }

  test('a remote source keeps polling its bucket on its own interval whatever the directory mode is', () => {
    const home = {
      s3Client: () =>
        new Bun.S3Client({
          accessKeyId: 'test',
          secretAccessKey: 'test',
          bucket: 'state',
          endpoint: 'http://127.0.0.1:9',
        }),
    } as unknown as Bungalow;
    const remote = { kind: 's3', bucket: 'state', prefix: 'agents/' } as const;
    for (const watch of [false, 'poll'] as const) {
      expect(createAgentSource(home, remote, {}, { watch }).referencePollMilliseconds).toBe(
        REMOTE_POLL_INTERVAL_MILLISECONDS,
      );
      expect(createWorkflowSource(home, remote, { watch }).kind).toBe('workflow');
    }
  });
});
