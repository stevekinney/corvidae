import { describe, expect, test } from 'bun:test';

import { contentDirectoryPath, sqliteDatabasePath } from './locations.ts';

describe('the locations the host can use', () => {
  test('a sqlite database is its path, and a directory is its path', () => {
    expect(sqliteDatabasePath({ kind: 'sqlite', path: '/home/database.sqlite' })).toBe(
      '/home/database.sqlite',
    );
    expect(contentDirectoryPath({ kind: 'directory', path: '/home/agents' })).toBe('/home/agents');
  });

  test('a postgres database stops the start, naming the kind', () => {
    expect(() => sqliteDatabasePath({ kind: 'postgres', url: 'postgres://example/db' })).toThrow(
      'postgres',
    );
  });

  test('s3 content stops the start, naming the kind', () => {
    expect(() => contentDirectoryPath({ kind: 's3', bucket: 'bucket', prefix: 'agents/' })).toThrow(
      's3',
    );
  });
});
