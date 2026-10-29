import { describe, expect, it } from 'bun:test';

import { closeIfOpen, FixtureScope } from '@lostgradient/storage/testing';
import { availableAdapterSpecs } from './sqlite-adapter-specs.test-support.ts';

describe('Turso adapter spec', () => {
  it('reports a successful no-op checkpoint, since libSQL manages its own', async () => {
    const spec = availableAdapterSpecs().find((candidate) => candidate.name === 'TursoStorage');
    expect(spec).toBeDefined();
    const scope = new FixtureScope();
    const adapter = await spec!.open(`${scope.makeTempDirectory('turso')}/checkpoint.db`);

    try {
      const checkpoint = await adapter.checkpoint();
      expect(checkpoint.truncated).toBe(true);
    } finally {
      await closeIfOpen(adapter);
      scope.cleanup();
    }
  });
});
