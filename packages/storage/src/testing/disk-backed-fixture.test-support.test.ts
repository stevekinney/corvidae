import { describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as nodeOperatingSystem from 'node:os';
import { join } from 'node:path';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from './disk-backed-fixture.test-support.ts';

describe('disk-backed test fixtures', () => {
  it('cleans up SQLite fixture files and sidecars', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-sqlite',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });

    await Bun.write(fixture.path, 'database');
    await Bun.write(`${fixture.path}-wal`, 'wal');
    await Bun.write(`${fixture.path}-shm`, 'shm');

    await fixture.cleanup();

    expect(existsSync(fixture.path)).toBe(false);
    expect(existsSync(`${fixture.path}-wal`)).toBe(false);
    expect(existsSync(`${fixture.path}-shm`)).toBe(false);
  });

  it('cleans up recursive LMDB fixture directories', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-lmdb',
      recursive: true,
    });
    const nestedDirectory = join(fixture.path, 'data.mdb');

    mkdirSync(nestedDirectory, { recursive: true });
    await Bun.write(join(nestedDirectory, 'lock'), 'lock');

    await fixture.cleanup();

    expect(existsSync(fixture.path)).toBe(false);
  });

  it('continues best-effort cleanup after a sidecar removal failure', async () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-best-effort',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const nonRecursiveSidecarDirectory = `${fixture.path}-wal`;

    try {
      mkdirSync(nonRecursiveSidecarDirectory, { recursive: true });
      await Bun.write(join(nonRecursiveSidecarDirectory, 'lock'), 'lock');
      await Bun.write(fixture.path, 'database');

      expect(() => fixture.cleanup()).not.toThrow();
      expect(existsSync(fixture.path)).toBe(false);
    } finally {
      rmSync(nonRecursiveSidecarDirectory, { force: true, recursive: true });
      fixture.cleanup();
    }
  });

  it('rejects path-like fixture fragments before cleanup can target them', () => {
    expect(() => createDiskBackedTestFixture({ prefix: '../outside' })).toThrow(
      'Fixture prefix must be a plain filename fragment',
    );

    expect(() =>
      createDiskBackedTestFixture({
        prefix: 'weft-storage-helper',
        suffix: '../outside',
      }),
    ).toThrow('Fixture suffix must be a plain filename fragment');

    expect(() =>
      createDiskBackedTestFixture({
        prefix: 'weft-storage-helper',
        sidecarSuffixes: ['/outside'],
      }),
    ).toThrow('Fixture sidecar suffix must be a plain filename fragment');
  });

  it('refuses to clean up once the fixture path is outside the temporary directory', () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'weft-storage-helper-moved',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const elsewhere = mkdtempSync(join(fixture.path, '..', 'weft-storage-helper-elsewhere-'));
    const temporaryDirectory = spyOn(nodeOperatingSystem, 'tmpdir').mockReturnValue(elsewhere);
    try {
      expect(() => fixture.cleanup()).toThrow(
        'Disk-backed test fixture path must stay inside the system temporary directory',
      );
    } finally {
      temporaryDirectory.mockRestore();
      rmSync(elsewhere, { force: true, recursive: true });
      fixture.cleanup();
    }
  });
});
