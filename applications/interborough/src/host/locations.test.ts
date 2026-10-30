import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHostStorage,
  describeContent,
  disposeHostStorage,
  hostPathsReport,
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
    database: { kind: 'postgres' as const, url: URL_WITH_CREDENTIALS },
    configurationLocation: 's3://state/prod/configuration.json',
    secretLocation: (key: string) =>
      `INTERBOROUGH_SECRET_${key.toUpperCase().replaceAll('-', '_')}`,
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
      providers: [{ name: 'anthropic', secretFile: 'INTERBOROUGH_SECRET_ANTHROPIC_API_KEY' }],
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
});
