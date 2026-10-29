/**
 * COR-1781 — a construction step after the guarded block still stops what construction started.
 * `createBureau` used to guard only the steps up to the workflow runtime; one that failed later
 * (the run machinery, or the boot tail once the Bureau object exists) left the durable engine
 * running and the caller's storage in use.
 */
import { join } from 'node:path';

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { createBureau } from './create-bureau';
import * as runtimeCompositionModule from './runtime-composition';
import * as scheduledFireReviewStateModule from './scheduled-fire-review-state';
import { createConstructionWindowFixtures } from './testing/construction-window.test-support';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import * as taskRegistryModule from './task-registry';

const fixtures = createConstructionWindowFixtures();
const restores: Array<() => void> = [];
const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const restore of restores.splice(0)) restore();
  for (const dispose of disposals.splice(0)) await dispose();
  await fixtures.dispose();
});

/**
 * Builds a durable Bureau over fresh SQLite storage while `explode` makes one step throw, and
 * records which parts of the composition were stopped.
 */
async function buildWhileAStepThrows(explode: () => void) {
  const root = await fixtures.scratchDirectory('bureau-construction-teardown-');
  const storage = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
  disposals.push(() => storage.dispose());
  const stopped: string[] = [];
  const createComposition = runtimeCompositionModule.createRuntimeComposition;
  const compositionSpy = spyOn(
    runtimeCompositionModule,
    'createRuntimeComposition',
  ).mockImplementation(async (...args) => {
    const composition = await createComposition(...args);
    const engine = composition.durable?.engine;
    if (engine === undefined) throw new Error('Expected a durable engine.');
    const shutdown = engine.shutdown.bind(engine);
    spyOn(engine, 'shutdown').mockImplementation(async () => {
      stopped.push('engine shut down');
      return shutdown();
    });
    // `bureau.shutdown()` disposes the engine; the composition's own shutdown calls `shutdown`.
    const dispose = engine[Symbol.asyncDispose].bind(engine);
    spyOn(engine, Symbol.asyncDispose).mockImplementation(async () => {
      stopped.push('engine disposed');
      return dispose();
    });
    const stopUsingStorage = composition.stopUsingStorage.bind(composition);
    spyOn(composition, 'stopUsingStorage').mockImplementation(() => {
      stopped.push('storage fenced');
      stopUsingStorage();
    });
    return composition;
  });
  restores.push(() => compositionSpy.mockRestore());
  explode();

  const outcome = await createBureau<AgentDefinitions>({
    agents: {},
    storage: storage.storage,
    durable: true,
    maintenance: 'manual',
  }).then(
    () => 'built' as const,
    (error: unknown) => error,
  );
  return { outcome, stopped };
}

describe('a construction step after the guarded block that throws (COR-1781)', () => {
  it('shuts the engine down and fences the storage when the run machinery fails', async () => {
    const { outcome, stopped } = await buildWhileAStepThrows(() => {
      const spy = spyOn(taskRegistryModule, 'createTaskRegistry').mockImplementation(() => {
        throw new Error('task registry exploded');
      });
      restores.push(() => spy.mockRestore());
    });

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('task registry exploded');
    expect(stopped).toContain('engine shut down');
    expect(stopped.at(-1)).toBe('storage fenced');
  });

  it('shuts the Bureau down when a step after the Bureau object exists fails', async () => {
    const { outcome, stopped } = await buildWhileAStepThrows(() => {
      const spy = spyOn(
        scheduledFireReviewStateModule,
        'trackScheduledFireReviewState',
      ).mockImplementation(() => {
        throw new Error('review state exploded');
      });
      restores.push(() => spy.mockRestore());
    });

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toBe('review state exploded');
    expect(stopped).toContain('engine disposed');
    expect(stopped).toContain('storage fenced');
  });
});
