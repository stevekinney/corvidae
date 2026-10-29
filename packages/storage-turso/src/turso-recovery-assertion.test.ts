import { describe, expect, it } from 'bun:test';

import { assertDurableStorageForRecovery } from '@lostgradient/storage';
import {
  createDiskBackedTestFixture,
  sqliteDatabaseSidecarSuffixes,
} from '@lostgradient/storage/testing';
import { TursoStorage } from './turso.ts';

describe('assertDurableStorageForRecovery', () => {
  it('rejects file-backed TursoStorage because read-after-write is session-scoped', () => {
    const fixture = createDiskBackedTestFixture({
      prefix: 'durable-assertion-turso',
      suffix: '.db',
      sidecarSuffixes: sqliteDatabaseSidecarSuffixes,
    });
    const storage = new TursoStorage({ url: `file:${fixture.path}` });

    try {
      expect(() => assertDurableStorageForRecovery(storage)).toThrow(
        /readAfterWrite must be "linearizable"/,
      );
    } finally {
      storage[Symbol.dispose]();
      fixture.cleanup();
    }
  });
});
