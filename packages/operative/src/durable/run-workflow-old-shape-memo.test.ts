/**
 * COR-713 — an in-flight durable run written before the cursor and step records carried parts
 * cannot be resumed. Weft replays a step's memo from its recorded result without re-running it, so
 * the write-side assertion in the checkpoint store never executes for an old memo; the workflow
 * itself must refuse one, with the typed error rather than a TypeError from reading its parts.
 */
import {
  activity,
  Engine,
  MemoryStorage,
  textValueStore,
  workflow,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { appendAgentInput } from '../agent-input';
import { noToolCalls } from '../conditions/predicates';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import type { AgentRunWorkflowInput } from './run-workflow-input';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

const nextTool = createTool({
  name: 'next',
  description: 'Continue',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});

const versionlessAccumulators = {
  totalUsage: { prompt: 0, completion: 0, total: 0 },
  lastContent: 'step 0',
  schemaAttempts: 0,
  lastAppliedConfigVersion: 0,
};

/** The step memo an older build recorded: no record version, no parts, no part accumulators. */
function oldStepMemo(outcome: 'continue' | 'abort', withRecord: boolean) {
  return {
    outcome: { kind: outcome },
    record: withRecord
      ? {
          step: 0,
          content: 'step 0',
          toolCalls: [],
          results: [],
          final: false,
        }
      : null,
    conversationSnapshot: new Conversation(createConversationHistory()).snapshot(),
    nextAccumulators: versionlessAccumulators,
  };
}

function servicesFor(runId: string): DurableRunDeps {
  const toolbox = createToolbox([nextTool]);
  return {
    toolbox,
    options: {
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      runId,
    },
  };
}

/**
 * The workflow throws {@link UnsupportedCheckpointRecordVersionError}; Weft records a workflow
 * failure as its message, so the class itself does not cross the engine boundary and the refusal
 * is read from the failure's message.
 */
function refusal(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function resumeOldHistory(runId: string, memo: ReturnType<typeof oldStepMemo>) {
  const storage = new MemoryStorage();
  const store = createCheckpointStore(textValueStore(storage, { disposeUnderlyingStorage: false }));
  const { promise: parked, resolve: reached } = Promise.withResolvers<void>();
  const activities = createStorageActivities(store);
  // The older build's activities wrote what the older records held; here they only record that
  // they ran, so the run's history holds their results exactly as a real one would.
  const legacyActivities = {
    saveConversation: activities.saveConversation,
    recordStep: activity({
      name: 'recordStep',
      idempotent: true,
      execute: async (_input: { runId: string; record: unknown }) => undefined,
    }),
    saveCursor: activity({
      name: 'saveCursor',
      idempotent: true,
      execute: async (_input: { runId: string; cursor: unknown }) => undefined,
    }),
  };
  const legacy = workflow({ name: 'agentRun' })
    .activities(legacyActivities)
    .execute(async function* (ctx, input: AgentRunWorkflowInput) {
      const seeded = new Conversation(createConversationHistory());
      appendAgentInput(seeded, input.prompt ?? '');
      yield* ctx.run('saveConversation', { runId: ctx.workflowId, snapshot: seeded.snapshot() });
      yield* ctx.memo('step-0', async () => memo);
      // The older build committed the step it memoized; the recorded results replay on resume.
      yield* ctx.run('saveConversation', { runId: ctx.workflowId, snapshot: seeded.snapshot() });
      if (memo.record !== null) {
        yield* ctx.run('recordStep', { runId: ctx.workflowId, record: memo.record });
      }
      yield* ctx.run('saveCursor', { runId: ctx.workflowId, cursor: {} });
      yield* ctx.memo('step-1', () => {
        reached();
        return new Promise<never>(() => {});
      });
      return undefined;
    });
  const engineA = await Engine.create({
    storage,
    recover: false,
    workflows: { agentRun: legacy },
    activities: legacyActivities,
  });
  const handle = await engineA.start(
    'agentRun',
    { runId, sessionId: runId, agentName: '', prompt: 'Start' },
    { id: runId, services: servicesFor(runId) },
  );
  void handle.result().catch(() => {});
  await parked;
  await yieldToPortableEventLoop();
  engineA[Symbol.dispose]();

  const currentActivities = createStorageActivities(store);
  const engineB = await Engine.create({
    storage,
    recover: false,
    resolveWorkflowServices: async () => ({
      status: 'available' as const,
      services: servicesFor(runId),
    }),
    workflows: { agentRun: createRunWorkflow(store) },
    activities: currentActivities,
  });
  try {
    const handles = await engineB.recoverAll();
    expect(handles.length).toBe(1);
    return await handles[0]!.result().then(
      () => undefined,
      (error: unknown) => error,
    );
  } finally {
    engineB[Symbol.dispose]();
  }
}

describe('resuming a durable run recorded before records carried parts (COR-713)', () => {
  it('fails with the typed error, not a TypeError, when a completed step memo has no parts', async () => {
    const error = await resumeOldHistory('old-shape-step', oldStepMemo('continue', true));
    expect(refusal(error)).toMatch(/Unsupported durable (step|cursor) record version \(none\)/);
  });

  it('fails with the typed error when a zero-step run whose prior attempt aborted is resumed', async () => {
    const error = await resumeOldHistory('old-shape-zero-step', oldStepMemo('abort', false));
    expect(refusal(error)).toMatch(/Unsupported durable (step|cursor) record version \(none\)/);
  });
});
