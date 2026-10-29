import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createHostStorage,
  describeContent,
  disposeHostStorage,
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
