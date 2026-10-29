import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import {
  Engine,
  type WorkflowServicesResolution,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { GenerateFunction } from '../types';
import { type CheckpointStore, createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import { normalizeAgentRunWorkflowResult } from './run-workflow-result';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

/**
 * COR-1376 — a step whose input is the previous step's output records its
 * conversation as a delta from that input. A recovered run rebuilds each
 * delta's base by replaying the recorded results before it, so these tests
 * crash a run several steps in, after deltas have been recorded, and recover
 * it on a fresh engine. A step after a continuation message (which replay
 * appends again with fresh ids) must have recorded its snapshot whole; if it
 * had recorded a delta, replay would reject it for a mismatched base.
 */
const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

const SIGNAL_NAME = 'human-response';

function makeServices(generate: GenerateFunction): DurableRunDeps {
  const holder: { deps?: DurableRunDeps } = {};
  const humanInputTool = createTool({
    name: 'requestHumanInput',
    description: 'Park waiting for human input',
    input: z.object({ signalName: z.string() }),
    execute: async ({ signalName }) => {
      if (holder.deps) holder.deps.pendingHumanWait = { signalName };
      return 'parked';
    },
  });
  const toolbox = createToolbox([nextTool, humanInputTool]) as unknown as DurableRunDeps['toolbox'];
  const deps: DurableRunDeps = {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
    },
  };
  holder.deps = deps;
  return deps;
}

/** Resolves once a run's `target`-th cursor save (one per completed step) lands. */
function countCursorSaves(checkpointStore: CheckpointStore) {
  let count = 0;
  const waiters: Array<{ target: number; resolve: () => void }> = [];
  const wrapped: CheckpointStore = {
    ...checkpointStore,
    saveCursor: async (runId, cursor) => {
      await checkpointStore.saveCursor(runId, cursor);
      count += 1;
      for (const waiter of waiters.filter((candidate) => count >= candidate.target)) {
        waiter.resolve();
      }
    },
  };
  const waitForCursorSave = (target: number) =>
    count >= target
      ? Promise.resolve()
      : new Promise<void>((resolve) => waiters.push({ target, resolve }));
  return { checkpointStore: wrapped, waitForCursorSave };
}

async function buildEngine(storage: MemoryStorage, resolve?: () => WorkflowServicesResolution) {
  const { checkpointStore, waitForCursorSave } = countCursorSaves(
    createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false })),
  );
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover: false,
    ...(resolve ? { resolveWorkflowServices: resolve } : {}),
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  return { engine, checkpointStore, waitForCursorSave };
}

const hang = () => new Promise<never>(() => {});
const continueStep = (step: number) => ({
  content: `A step ${step}`,
  toolCalls: [{ name: 'next', arguments: {} }],
});

afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable agentRun conversation deltas across recovery', () => {
  it('recovers a run crashed after several delta steps and completes its transcript', async () => {
    const storage = new MemoryStorage();
    const runId = 'delta-replay-steps';
    const a = await buildEngine(storage);
    const handle = await a.engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: 'Loop', maximumSteps: 10 },
      {
        id: runId,
        services: makeServices(async ({ step }) => (step < 4 ? continueStep(step) : hang())),
      },
    );
    void handle.result().catch(() => {});
    await a.waitForCursorSave(4);
    a.engine[Symbol.dispose]();

    const recoveredSteps: number[] = [];
    const b = await buildEngine(storage, () => ({
      status: 'available',
      services: makeServices(async ({ step }) => {
        recoveredSteps.push(step);
        return { content: `recovered step ${step}`, toolCalls: [] };
      }),
    }));
    try {
      const [recovered] = await b.engine.recoverAll();
      const result = normalizeAgentRunWorkflowResult(await recovered!.result());
      expect(result.finishReason).toBe('stop-condition');
      expect(result.steps).toBe(5);
      expect(recoveredSteps).toEqual([4]);

      const transcript = await b.checkpointStore.loadConversation(runId, { strict: true });
      // Restoring verifies the transcript's digest against its content.
      const restored = Conversation.from(transcript!);
      const contents = restored.getMessages().map((message) => message.content);
      expect(
        contents.filter((content) => typeof content === 'string' && content.startsWith('A step ')),
      ).toEqual(['A step 0', 'A step 1', 'A step 2', 'A step 3']);
      expect(contents.at(-1)).toBe('recovered step 4');
    } finally {
      b.engine[Symbol.dispose]();
    }
  });

  it('recovers a run crashed several steps after a signal continuation', async () => {
    const storage = new MemoryStorage();
    const runId = 'delta-replay-continuation';
    const a = await buildEngine(storage);
    const handle = await a.engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: 'Loop', maximumSteps: 10 },
      {
        id: runId,
        services: makeServices(async ({ step }) => {
          if (step === 0) {
            return {
              content: '',
              toolCalls: [{ name: 'requestHumanInput', arguments: { signalName: SIGNAL_NAME } }],
            };
          }
          return step < 4 ? continueStep(step) : hang();
        }),
      },
    );
    void handle.result().catch(() => {});
    await a.waitForCursorSave(1);
    await a.engine.signal(runId, SIGNAL_NAME, { approved: true });
    // Steps 1 to 3 run after the continuation message: step 1 records its
    // snapshot whole, steps 2 and 3 record deltas.
    await a.waitForCursorSave(4);
    a.engine[Symbol.dispose]();

    const b = await buildEngine(storage, () => ({
      status: 'available',
      services: makeServices(async ({ step }) => ({
        content: `recovered step ${step}`,
        toolCalls: [],
      })),
    }));
    try {
      const [recovered] = await b.engine.recoverAll();
      const result = normalizeAgentRunWorkflowResult(await recovered!.result());
      expect(result.finishReason).toBe('stop-condition');
      expect(result.humanWaitSignal).toBe(SIGNAL_NAME);
      expect(result.steps).toBe(5);

      const transcript = await b.checkpointStore.loadConversation(runId, { strict: true });
      const contents = Conversation.from(transcript!)
        .getMessages()
        .map((message) => message.content);
      expect(
        contents.filter((content) => typeof content === 'string' && content.startsWith('A step ')),
      ).toEqual(['A step 1', 'A step 2', 'A step 3']);
      expect(contents.at(-1)).toBe('recovered step 4');
    } finally {
      b.engine[Symbol.dispose]();
    }
  });
});
