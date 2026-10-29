import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, type Storage, textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { createConversationHistory } from 'conversationalist';
import { stopWhen } from '../conditions/index';
import { createActiveRun } from '../create-run';
import { type CombinedOperativeEventMap, RunCompletedEvent, RunErrorEvent } from '../events';
import { withTwoPhaseStart } from '../test/durable-engine';
import type { RunOptions } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine, type RegistryAgnosticEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

/**
 * COR-1587: a durable run that fails after it committed a step settles as `error` from what it
 * committed. Its `run.completed` carries the committed step, its usage, and the transcript the
 * checkpoint holds, because a terminal save of the seed transcript would drop the committed rows
 * (and any follow-up the step delivered) from the session for good.
 */

const WRITES = new Set(['put', 'delete', 'batch', 'conditionalBatch']);

function keysOf(name: string, args: readonly unknown[]): string[] {
  if (name === 'put' || name === 'delete') return [String(args[0])];
  const operations = (name === 'batch' ? args[0] : args[1]) as Array<{ key: string }> | undefined;
  return (operations ?? []).map((operation) => operation.key);
}

/** A memory storage that, once told to, refuses every write whose key starts with a prefix. */
function refusingStorage() {
  const storage = new MemoryStorage();
  let refusedPrefix: string | undefined;
  const proxy = new Proxy(storage, {
    get(target, property, receiver) {
      const member: unknown = Reflect.get(target, property, receiver);
      if (typeof member !== 'function') return member;
      const name = String(property);
      const call = (...args: unknown[]) =>
        (member as (...rest: unknown[]) => unknown).apply(target, args);
      if (!WRITES.has(name)) return call.bind(null);
      return async (...args: unknown[]) => {
        if (
          refusedPrefix !== undefined &&
          keysOf(name, args).some((key) => key.startsWith(refusedPrefix!))
        ) {
          throw new Error('This storage write is refused.');
        }
        return call(...args);
      };
    },
  });
  return {
    storage: proxy as unknown as Storage,
    refuseWritesUnder(prefix: string) {
      refusedPrefix = prefix;
    },
  };
}

const noopTool = createTool({
  name: 'noop',
  description: 'does nothing',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});

describe('a durable run that fails after a committed step', () => {
  it('settles as error from the checkpoint: its step, usage, transcript, and the step it failed at', async () => {
    const refusing = refusingStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(refusing.storage, { disposeUnderlyingStorage: false }),
    );
    const { engine } = await createRunEngine({
      storage: refusing.storage,
      runWorkflow: createRunWorkflow(checkpointStore),
      recover: false,
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    let reachedStepOne!: () => void;
    const reached = new Promise<void>((resolve) => (reachedStepOne = resolve));
    const options: RunOptions = {
      generate: async ({ step }) => {
        if (step === 0) {
          return {
            content: 'Calling the tool.',
            toolCalls: [{ name: 'noop', arguments: {} }],
            usage: { prompt: 10, completion: 5, total: 15 },
          };
        }
        reachedStepOne();
        await hold;
        return { content: 'Answer.', toolCalls: [], usage: { prompt: 1, completion: 1, total: 2 } };
      },
      toolbox: createToolbox([noopTool]),
      conversation: createConversationHistory(),
      stopWhen: stopWhen.noToolCalls(),
    };
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const errorSteps: number[] = [];
    const completions: Array<{ steps: number; usage: number }> = [];
    emitter.addEventListener(RunErrorEvent.type, (event) => errorSteps.push(event.step));
    emitter.addEventListener(RunCompletedEvent.type, (event) =>
      completions.push({ steps: event.steps.length, usage: event.usage.total }),
    );

    try {
      const activeRun = createActiveRun(options, {
        engine,
        checkpointStore,
        runId: 'failed-after-step',
        prompt: 'Go.',
        emitter,
      });
      await reached;
      // Step 0 is committed; refuse the writes that would commit step 1.
      refusing.refuseWritesUnder('durable-run:');
      release();

      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      expect(result.steps).toHaveLength(1);
      expect(result.usage.total).toBe(15);
      expect(result.conversation.getMessages().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool-call',
        'tool-result',
      ]);
      expect(errorSteps).toEqual([1]);
      expect(completions).toEqual([{ steps: 1, usage: 15 }]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('settles a timeout after a committed step from the checkpoint too', async () => {
    const storage = new MemoryStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(storage, { disposeUnderlyingStorage: false }),
    );
    // A history this short is breached by the run's own events once step 0 is committed, which
    // the engine reports as a `WorkflowTimeoutError`.
    const { engine } = await createRunEngine({
      storage,
      runWorkflow: createRunWorkflow(checkpointStore),
      recover: false,
      history: { maxEvents: 6 },
    });
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const errorSteps: number[] = [];
    emitter.addEventListener(RunErrorEvent.type, (event) => errorSteps.push(event.step));

    try {
      const result = await createActiveRun(
        {
          generate: async ({ step }) =>
            step === 0
              ? {
                  content: 'Calling the tool.',
                  toolCalls: [{ name: 'noop', arguments: {} }],
                  usage: { prompt: 10, completion: 5, total: 15 },
                }
              : {
                  content: 'Answer.',
                  toolCalls: [],
                  usage: { prompt: 1, completion: 1, total: 2 },
                },
          toolbox: createToolbox([noopTool]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { engine, checkpointStore, runId: 'timed-out-after-step', prompt: 'Go.', emitter },
      ).result;

      expect(result.finishReason).toBe('error');
      expect((result.error as Error).message).toContain('history circuit breaker');
      expect(result.steps).toHaveLength(1);
      expect(result.usage.total).toBe(15);
      // The breaker ends the run at step 1's checkpoint, and Weft settles the run only after that
      // step's activity has landed (COR-1597), so the reply it wrote is in the transcript.
      expect(result.conversation.getMessages().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool-call',
        'tool-result',
        'assistant',
      ]);
      expect(errorSteps).toEqual([1]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('keeps a committed transcript whose step record never landed', async () => {
    // A step commits its transcript, and the follow-up it delivered, in one write before its step
    // record. A failure between the two leaves a transcript with no step, and settling from the
    // launch conversation would drop the reply and the delivered input for good.
    const refusing = refusingStorage();
    const checkpointStore = createCheckpointStore(
      textValueStore(refusing.storage, { disposeUnderlyingStorage: false }),
    );
    const { engine } = await createRunEngine({
      storage: refusing.storage,
      runWorkflow: createRunWorkflow(checkpointStore),
      recover: false,
    });
    refusing.refuseWritesUnder('durable-run:transcript-without-step:step:');

    try {
      const result = await createActiveRun(
        {
          generate: async () => ({ content: 'The reply.', toolCalls: [] }),
          toolbox: createToolbox([noopTool]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { engine, checkpointStore, runId: 'transcript-without-step', prompt: 'Go.' },
      ).result;

      expect(result.finishReason).toBe('error');
      expect(result.steps).toHaveLength(0);
      expect(result.conversation.getMessages().map((message) => message.role)).toEqual([
        'user',
        'assistant',
      ]);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('settles from the launch conversation, and warns once, when the checkpoint cannot be read', async () => {
    const engine = withTwoPhaseStart({
      start: async () => ({ result: () => Promise.reject(new Error('the activity failed')) }),
    }) as unknown as RegistryAgnosticEngine;
    const checkpointStore = {
      loadCheckpoint: async () => {
        throw new Error('the checkpoint store is unavailable');
      },
    } as never;
    const warnings: string[] = [];
    const warn = spyOn(console, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
    try {
      const result = await createActiveRun(
        {
          generate: async () => ({ content: 'unused', toolCalls: [] }),
          toolbox: createToolbox([]),
          conversation: createConversationHistory(),
          stopWhen: stopWhen.noToolCalls(),
        },
        { engine, checkpointStore, runId: 'unreadable-checkpoint', prompt: 'Go.' },
      ).result;

      // The run still ends: failing the settle would leave it `running` with no terminal event.
      expect(result.finishReason).toBe('error');
      expect((result.error as Error).message).toContain('the activity failed');
      expect(result.steps).toHaveLength(0);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"unreadable-checkpoint"');
      expect(warnings[0]).toContain('the checkpoint store is unavailable');
    } finally {
      warn.mockRestore();
    }
  });
});
