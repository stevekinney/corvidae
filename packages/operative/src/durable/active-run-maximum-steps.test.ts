import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { createActiveRun } from '../create-run';
import { MaximumStepsExceededError } from '../errors';
import { type CombinedOperativeEventMap, RunCompletedEvent, RunErrorEvent } from '../events';
import type { RunOptions } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

/**
 * COR-1627: a fresh durable run that stops at its step limit announces it with one live
 * `run.error` before its `run.completed`. The announcement is dispatched by the host after the
 * workflow settles, not inside the workflow body that replay re-runs, so a run replayed after a
 * crash does not announce it twice. The reattached announcement is covered by
 * `active-run-reattach-failure-reasons.test.ts`, and the replay across two Bureaus by Bureau's
 * `maximum-steps-failure.test.ts`.
 */

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => 'ok',
});

function neverStopping(
  overrides: Pick<RunOptions, 'onMaximumSteps' | 'stopWhen'> = {},
): RunOptions {
  return {
    generate: async ({ step }) => ({
      content: `step ${step}`,
      toolCalls: [{ name: 'next', arguments: {} }],
    }),
    toolbox: createToolbox([nextTool]),
    conversation: createConversationHistory(),
    maximumSteps: 2,
    ...overrides,
  };
}

async function withEngine<T>(
  body: (context: {
    engine: Awaited<ReturnType<typeof createRunEngine>>['engine'];
    checkpointStore: ReturnType<typeof createCheckpointStore>;
  }) => Promise<T>,
): Promise<T> {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  try {
    return await body({ engine, checkpointStore });
  } finally {
    engine[Symbol.dispose]();
  }
}

describe('a fresh durable run that stops at its step limit (COR-1627)', () => {
  it('fires one live run.error, then run.completed, with the step-limit error', async () => {
    await withEngine(async ({ engine, checkpointStore }) => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const observed: Array<{ type: string; step?: number; reconstructed?: unknown }> = [];
      emitter.addEventListener(RunErrorEvent.type, (event) => {
        observed.push({
          type: event.type,
          step: event.step,
          reconstructed: Object.hasOwn(event, 'reconstructed') ? event.reconstructed : 'absent',
        });
      });
      emitter.addEventListener(RunCompletedEvent.type, (event) => {
        observed.push({ type: event.type, step: event.steps.length });
      });

      const activeRun = createActiveRun(neverStopping(), {
        engine,
        checkpointStore,
        runId: 'durable-step-limit',
        prompt: 'Go.',
        emitter,
      });
      const result = await activeRun.result;

      expect(result.finishReason).toBe('maximum-steps');
      expect(result.error).toBeInstanceOf(MaximumStepsExceededError);
      // A live announcement carries no `reconstructed` key; its step is the count recorded.
      expect(observed).toEqual([
        { type: 'run.error', step: 2, reconstructed: 'absent' },
        { type: 'run.completed', step: 2 },
      ]);
    });
  });

  it('keeps the onMaximumSteps answer on run.completed and still announces once', async () => {
    await withEngine(async ({ engine, checkpointStore }) => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const types: string[] = [];
      emitter.addEventListener(RunErrorEvent.type, (event) => types.push(event.type));
      emitter.addEventListener(RunCompletedEvent.type, (event) => types.push(event.type));

      const activeRun = createActiveRun(
        neverStopping({ onMaximumSteps: async () => 'Out of steps.' }),
        {
          engine,
          checkpointStore,
          runId: 'durable-step-limit-answer',
          prompt: 'Go.',
          emitter,
        },
      );
      const result = await activeRun.result;

      expect(result.finishReason).toBe('maximum-steps');
      expect(result.content).toBe('Out of steps.');
      expect(types).toEqual(['run.error', 'run.completed']);
    });
  });

  it('announces nothing for a run that a stop condition ends', async () => {
    await withEngine(async ({ engine, checkpointStore }) => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const types: string[] = [];
      emitter.addEventListener(RunErrorEvent.type, (event) => types.push(event.type));
      emitter.addEventListener(RunCompletedEvent.type, (event) => types.push(event.type));

      const activeRun = createActiveRun(neverStopping({ stopWhen: () => true }), {
        engine,
        checkpointStore,
        runId: 'durable-stopped',
        prompt: 'Go.',
        emitter,
      });
      const result = await activeRun.result;

      expect(result.finishReason).toBe('stop-condition');
      expect(types).toEqual(['run.completed']);
    });
  });
});
