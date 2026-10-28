import { describe, expect, it, spyOn } from 'bun:test';
import * as nodeFileSystem from 'node:fs';
import { existsSync } from 'node:fs';

import {
  availableAdapterSpecs,
  closeIfOpen,
  FixtureScope,
  type OpenedAdapter,
} from './adapter-spec.test-support.ts';

describe('closeIfOpen', () => {
  it('ignores a missing handle', async () => {
    expect(await closeIfOpen(undefined)).toBeUndefined();
  });

  it('swallows a failing close so it cannot mask the assertion that led to cleanup', async () => {
    const handle = {
      close: async () => {
        throw new Error('close failed');
      },
    } as unknown as OpenedAdapter;

    expect(await closeIfOpen(handle)).toBeUndefined();
  });
});

describe('FixtureScope', () => {
  it('removes the directories it made when the test passed', () => {
    const scope = new FixtureScope();
    const directory = scope.makeTempDirectory('removal');
    expect(existsSync(directory)).toBe(true);

    scope.cleanup();

    expect(existsSync(directory)).toBe(false);
  });

  it('keeps the directories of a failed test for inspection', () => {
    const scope = new FixtureScope();
    const directory = scope.makeTempDirectory('failed');
    scope.markFailed();

    scope.cleanup();

    expect(existsSync(directory)).toBe(true);
    nodeFileSystem.rmSync(directory, { recursive: true, force: true });
  });

  it('keeps cleaning the remaining directories when one cannot be removed', () => {
    const scope = new FixtureScope();
    const first = scope.makeTempDirectory('first');
    const second = scope.makeTempDirectory('second');
    const real = nodeFileSystem.rmSync;
    const removeSpy = spyOn(nodeFileSystem, 'rmSync').mockImplementation(
      (...args: Parameters<typeof real>) => {
        if (String(args[0]) === second) throw new Error('directory is busy');
        return real(...args);
      },
    );

    try {
      expect(() => scope.cleanup()).not.toThrow();
      expect(existsSync(first)).toBe(false);
    } finally {
      removeSpy.mockRestore();
      nodeFileSystem.rmSync(second, { recursive: true, force: true });
    }
  });
});

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
