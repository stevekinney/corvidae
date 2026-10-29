import { describe, expect, it } from 'bun:test';

import { closeIfOpen, FixtureScope } from '@lostgradient/storage/testing';
import { tursoSpec } from './turso-spec.test-support.ts';

describe('Turso adapter spec', () => {
  it('reports a successful no-op checkpoint, since libSQL manages its own', async () => {
    const scope = new FixtureScope();
    const adapter = await tursoSpec.open(`${scope.makeTempDirectory('turso')}/checkpoint.db`);

    try {
      const checkpoint = await adapter.checkpoint();
      expect(checkpoint.truncated).toBe(true);
    } finally {
      await closeIfOpen(adapter);
      scope.cleanup();
    }
  });
});
