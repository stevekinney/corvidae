import { MemoryStorage } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import {
  workflow,
  yieldToPortableEventLoop,
  type Engine,
  type WorkflowContext,
} from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createRunEngine } from './create-run-engine';

// Drain Weft's deferred inline-launch queue between tests so a pending launch from one durable run
// cannot starve a later one under full `bun test` concurrency.
afterEach(async () => {
  await yieldToPortableEventLoop();
});

/** Runs until it is sent `go`, recording that its first turn ran. */
function gated(name: string, started: Set<string>) {
  return workflow({ name }).execute(async function* (ctx: WorkflowContext) {
    started.add(ctx.workflowId);
    yield* ctx.waitForSignal('go');
    return ctx.workflowId;
  });
}

describe('createRunEngine maxConcurrentRuns', () => {
  it('caps the host’s workflow runs and never holds an agent run', async () => {
    const started = new Set<string>();
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: gated('agentRun', started),
      maxConcurrentRuns: 1,
    });
    try {
      // A host registers its own workflow types on the engine, as Bureau does its workflow files.
      (engine as unknown as Engine).register(gated('report', started));
      await engine.start('report', null, { id: 'report-1' });
      await engine.start('report', null, { id: 'report-2' });
      await engine.start('agentRun', null, { id: 'agent-1' });
      await engine.start('agentRun', null, { id: 'agent-2' });

      await waitUntil(() => ['report-1', 'agent-1', 'agent-2'].every((id) => started.has(id)), {
        message: 'the first report and both agent runs to start',
      });
      expect(started.has('report-2')).toBe(false);
      expect(engine.runConcurrency()).toEqual({
        max: 1,
        running: ['report-1'],
        waiting: ['report-2'],
      });
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });

  it('caps nothing when the option is omitted', async () => {
    const { engine } = await createRunEngine({
      storage: new MemoryStorage(),
      runWorkflow: gated('agentRun', new Set()),
    });
    try {
      expect(engine.runConcurrency()).toBeNull();
    } finally {
      await engine[Symbol.asyncDispose]();
    }
  });
});
