import { MemoryStorage } from '@lostgradient/storage';
import { workflow, yieldToPortableEventLoop } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createRunEngine } from './create-run-engine';

// Drain Weft's deferred inline-launch queue between tests so a pending launch from one durable run
// cannot starve a later one under full `bun test` concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

const MAX_NESTING_DEPTH = 3;

/**
 * COR-1698: a probe `agentRun` that starts itself as a child until `hops` child hops have been taken,
 * then returns the hop count it reached. `hops` counts child workflows below the root run.
 */
const nestingWorkflow = workflow({ name: 'agentRun' }).execute(async function* (
  ctx,
  input: { level: number; hops: number },
) {
  if (input.level < input.hops) {
    return yield* ctx.startChild<number>('agentRun', {
      level: input.level + 1,
      hops: input.hops,
    });
  }
  return input.level;
});

async function startNested(hops: number) {
  const { engine } = await createRunEngine({
    storage: new MemoryStorage(),
    runWorkflow: nestingWorkflow,
    maxNestingDepth: MAX_NESTING_DEPTH,
  });
  const handle = await engine.start('agentRun', { level: 0, hops });
  return { engine, handle };
}

describe('createRunEngine maxNestingDepth (COR-1698)', () => {
  it('lets a workflow nested exactly maxNestingDepth child hops deep complete', async () => {
    const { engine, handle } = await startNested(MAX_NESTING_DEPTH);
    try {
      expect(await handle.result()).toBe(MAX_NESTING_DEPTH);
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('fails a workflow nested one hop past maxNestingDepth with the nesting-depth error', async () => {
    const { engine, handle } = await startNested(MAX_NESTING_DEPTH + 1);
    try {
      let rejection: unknown;
      try {
        await handle.result();
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain('nesting depth exceeded');
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
