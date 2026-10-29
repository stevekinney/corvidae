import { describe, expect, it } from 'bun:test';

import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '@lostgradient/storage/testing';
import { describeConditionalBatch } from './conditional-batch.test-support.ts';
import { TursoStorage } from './turso.ts';

describe('TursoStorage persistence capabilities', () => {
  it('reports TursoStorage file::memory: as ephemeral, file URLs as local, and remote URLs as remote', () => {
    using inMemory = new TursoStorage({ url: 'file::memory:' });
    const fixture = createDiskBackedTestFixture({
      prefix: 'turso-persistence',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const local = new TursoStorage({ url: `file:${fixture.path}` });
    const remote = new TursoStorage({ url: 'libsql://example.turso.io' });

    try {
      expect(inMemory.capabilities().persistence).toBe('ephemeral');
      expect(local.capabilities().persistence).toBe('local');
      expect(remote.capabilities().persistence).toBe('remote');
    } finally {
      local[Symbol.dispose]();
      remote[Symbol.dispose]();
      fixture.cleanup();
    }
  });
});

describeConditionalBatch({
  name: 'TursoStorage',
  factory: () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'turso-conditional-batch',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const storage = new TursoStorage({ url: `file:${fixture.path}` });

    return {
      storage,
      cleanup: () => {
        storage[Symbol.dispose]();
        fixture.cleanup();
      },
    };
  },
});
