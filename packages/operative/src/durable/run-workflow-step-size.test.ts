import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { Engine, KEYS, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import { rebuildEffectiveContexts } from '../effective-context-record';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

/**
 * COR-1376 — Weft encodes each step memo's result into the checkpoint, hashes
 * it into the workflow's event log, and stores every operation's input and
 * output in the workflow's timeline. When the step memo's result and the
 * `saveConversation` input carried the whole conversation snapshot, every step
 * re-encoded, re-hashed, and re-stored the conversation, so a run's total cost
 * grew with the square of its length. This asserts the size of what a step
 * writes, not how long it takes: the largest event-log entry and timeline
 * record of a long run are no larger than those of a short one.
 */
const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

function makeServices(): DurableRunDeps {
  const toolbox = createToolbox([nextTool]);
  return {
    toolbox,
    options: {
      generate: async ({ step }) => ({
        content: `step ${step}`,
        toolCalls: [{ name: 'next', arguments: {} }],
      }),
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
    },
  };
}

async function largestValue(storage: MemoryStorage, prefix: string): Promise<number> {
  let largest = 0;
  for await (const [, bytes] of storage.scan(prefix)) {
    largest = Math.max(largest, bytes.byteLength);
  }
  return largest;
}

async function largestPerStepWrites(runId: string, maximumSteps: number) {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const activities = createStorageActivities(checkpointStore);
  const engine = await Engine.create({
    storage,
    recover: false,
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
  try {
    const handle = await engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: 'Loop', maximumSteps },
      { id: runId, services: makeServices() },
    );
    const result = await handle.result();
    return {
      result,
      eventLogEntry: await largestValue(storage, KEYS.eventPrefix(runId)),
      timelineRecord: await largestValue(storage, KEYS.timelinePrefix(runId)),
      conversation: await checkpointStore.loadConversation(runId),
      steps: await checkpointStore.loadSteps(runId),
    };
  } finally {
    engine[Symbol.dispose]();
  }
}

afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable agentRun per-step persistence', () => {
  it('writes event-log entries and timeline records whose size does not grow with the conversation', async () => {
    const short = await largestPerStepWrites('entry-size-short', 10);
    const long = await largestPerStepWrites('entry-size-long', 40);

    expect(long.result.steps).toBe(40);
    // The transcript itself still holds every message, four times as many.
    expect(long.conversation?.messages.length).toBeGreaterThan(
      (short.conversation?.messages.length ?? 0) * 3,
    );
    // Each step's persisted result does not.
    expect(long.eventLogEntry).toBeLessThan(short.eventLogEntry * 1.5);
    expect(long.timelineRecord).toBeLessThan(short.timelineRecord * 1.5);
  });

  it('stores each step’s effective context as a delta whose size does not grow with the conversation', async () => {
    const short = await largestPerStepWrites('context-size-short', 10);
    const long = await largestPerStepWrites('context-size-long', 40);
    const largestContext = (run: typeof short): number =>
      Math.max(...run.steps.map((step) => JSON.stringify(step.effectiveContext ?? null).length));

    expect(long.steps.every((step) => step.effectiveContext !== undefined)).toBe(true);
    expect(largestContext(short)).toBeGreaterThan(0);
    expect(largestContext(long)).toBeLessThan(largestContext(short) * 1.5);
    // After the first step each delta holds the rows the previous step committed, not the history.
    for (const step of long.steps.slice(1)) {
      expect(step.effectiveContext?.messages.length).toBeLessThanOrEqual(3);
    }
  });

  it('rebuilds every step’s whole effective context from the stored deltas', async () => {
    const run = await largestPerStepWrites('context-rebuild', 12);
    const rebuilt = rebuildEffectiveContexts(run.steps.map((step) => step.effectiveContext));
    const conversation = run.conversation!.messages.map((message) => message.id);

    expect(rebuilt).toHaveLength(12);
    rebuilt.forEach((record, index) => {
      expect(record?.truncated).toBe(false);
      expect(record?.messages).toHaveLength(record!.messageCount);
      // Each step saw the conversation as it stood before it: a prefix of the final transcript.
      expect(record?.messages.map((message) => message.id)).toEqual(
        conversation.slice(0, record!.messageCount),
      );
      if (index > 0) expect(record!.messageCount).toBeGreaterThan(rebuilt[index - 1]!.messageCount);
    });
  });
});
