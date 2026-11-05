import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureSecretProvider } from './tool-source-memory-home.test-support.ts';

import { MemoryStorage } from '@lostgradient/storage';
import {
  claimWorkspaceBinding,
  createHostStorage,
  createPluginAgentSource,
  createPluginSkillSource,
  createPluginWorkflowSource,
  describeContent,
  disposeHostStorage,
  hostPathsReport,
  hostWriteLocks,
  redactDatabase,
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
