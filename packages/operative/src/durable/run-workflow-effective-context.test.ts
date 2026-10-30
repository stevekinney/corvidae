import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import {
  Engine,
  type WorkflowServicesResolution,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { type Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import { createContextCompactor } from '../create-context-compactor';
import {
  composeEffectiveContextRecord,
  type EffectiveContextRecord,
  rebuildEffectiveContexts,
} from '../effective-context-record';
import type { ContextManagementOptions, GenerateContext, GenerateResponse } from '../types';
import { type CheckpointStore, createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps, StepRecord } from './types';

/**
 * COR-1810 — a durable run stores each step's effective context (what the model saw) with the
 * step's checkpoint record, and `bureau.tasks.inspect` rebuilds it from the run's records. The
 * conversation is not append-only between steps: compaction replaces older rows with a summary, a
 * hook can redact a row in place, and a regenerated or forked run can leave a longer run's records
 * behind. Each test records what `generate` was actually handed at every step, independent of the
 * stored records, and requires every rebuilt record to equal it, or to say it is `truncated` and
 * hold only the newest of those messages. A wrong list marked complete is the one outcome no test
 * accepts.
 */
const lookup = createTool({
  name: 'lookup',
  description: 'Looks something up',
  input: z.object({}),
  execute: async () => 'found something fairly long to grow the conversation quickly',
});

/** An epoch with nothing in it: the oracle reads only the messages a record composes. */
const ORACLE_EPOCH = {
  sources: [],
  baselineDigest: '',
  firstConsumedBy: { runId: 'oracle', step: 0, attempt: 0 },
} as const;

/** Each message the model was handed, as `id#role#digest`, from the record code's own flattening. */
function keysOf(record: Pick<EffectiveContextRecord, 'messages'>): string[] {
  return record.messages.map((message) => `${message.id}#${message.role}#${message.digest}`);
}

function observe(conversation: Conversation): string[] {
  return keysOf(
    composeEffectiveContextRecord(ORACLE_EPOCH, conversation, Number.POSITIVE_INFINITY),
  );
}

type Generate = (context: GenerateContext) => Promise<GenerateResponse>;

interface RunPlan {
  readonly generate: Generate;
  readonly contextManagement?: ContextManagementOptions | undefined;
  readonly prompt?: string | undefined;
}

function makeServices(plan: RunPlan, seen: Map<number, string[]>): DurableRunDeps {
  const toolbox = createToolbox([lookup]) as unknown as DurableRunDeps['toolbox'];
  return {
    toolbox,
    options: {
      generate: async (context) => {
        seen.set(context.step, observe(context.conversation));
        return plan.generate(context);
      },
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      ...(plan.contextManagement === undefined
        ? {}
        : { contextManagement: plan.contextManagement }),
    },
  };
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

async function runToCompletion(runId: string, maximumSteps: number, plan: RunPlan) {
  const storage = new MemoryStorage();
  const seen = new Map<number, string[]>();
  const { engine, checkpointStore } = await buildEngine(storage);
  try {
    const handle = await engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: plan.prompt ?? 'Loop', maximumSteps },
      { id: runId, services: makeServices(plan, seen) },
    );
    await handle.result();
    return { seen, steps: await checkpointStore.loadSteps(runId) };
  } finally {
    engine[Symbol.dispose]();
  }
}

/** Every step's rebuilt record, each paired with what its `generate` was handed. */
function rebuildAgainst(steps: readonly StepRecord[], seen: ReadonlyMap<number, string[]>) {
  const rebuilt = rebuildEffectiveContexts(steps.map((step) => step.effectiveContext));
  return steps.map((step, index) => ({
    step: step.step,
    record: rebuilt[index],
    observed: seen.get(step.step),
  }));
}

/** A rebuilt record either equals what the model saw or is marked truncated and holds its newest messages. */
function expectFaithful(entry: ReturnType<typeof rebuildAgainst>[number]): void {
  const { record, observed } = entry;
  expect(record).toBeDefined();
  expect(observed).toBeDefined();
  expect(record!.messageCount).toBe(observed!.length);
  const kept = keysOf(record!);
  if (record!.truncated) {
    expect(kept).toEqual(observed!.slice(observed!.length - kept.length));
  } else {
    expect(kept).toEqual(observed!);
  }
}

const callLookup = (step: number): GenerateResponse => ({
  content: `calling lookup at step ${step} `.repeat(3),
  toolCalls: [{ name: 'lookup', arguments: {} }],
});

afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable effective-context records across a non-append-only conversation', () => {
  it('rebuilds every step of a compacting run as exactly what the model saw', async () => {
    let compactions = 0;
    const compact = createContextCompactor({
      summarize: async () => 'SUMMARY',
      retainRecentMessages: 4,
    });
    const { seen, steps } = await runToCompletion('context-compacting', 10, {
      prompt: 'Please look things up many times, with a long prompt '.repeat(5),
      generate: async ({ step }) =>
        step < 7 ? callLookup(step) : { content: 'Done.', toolCalls: [] },
      contextManagement: {
        maxTokens: 40,
        onCompact: async (conversation, context) => {
          compactions += 1;
          await compact(conversation, context);
        },
      },
    });

    expect(steps).toHaveLength(8);
    expect(compactions).toBeGreaterThan(1);
    for (const entry of rebuildAgainst(steps, seen)) {
      expectFaithful(entry);
      // Nothing here is near the cap, so nothing may be left out.
      expect(entry.record!.truncated).toBe(false);
    }
  });

  it('rebuilds every step after a row earlier in the conversation is redacted in place', async () => {
    const { seen, steps } = await runToCompletion('context-redacted', 8, {
      generate: async ({ step, conversation }) => {
        // A memory withdrawal rewrites an earlier row under its own id, as Bureau's recall hook does.
        if (step === 3) conversation.redactMessageAtPosition(0, 'withdrawn');
        return step < 6 ? callLookup(step) : { content: 'Done.', toolCalls: [] };
      },
    });

    expect(steps).toHaveLength(7);
    // The redaction reached the conversation the next step was handed.
    expect(seen.get(4)![0]).not.toBe(seen.get(3)![0]);
    for (const entry of rebuildAgainst(steps, seen)) {
      expectFaithful(entry);
      expect(entry.record!.truncated).toBe(false);
    }
  });

  it('never rebuilds a longer run’s leftover records onto a shorter regenerated run as complete', async () => {
    const runId = 'context-regenerated';
    const original = await runToCompletion(runId, 10, {
      prompt: 'The original question',
      generate: async ({ step }) =>
        step < 7 ? callLookup(step) : { content: 'Done.', toolCalls: [] },
    });
    // The regenerated run reuses the run id, so its rows carry the same ids with other content.
    const regenerated = await runToCompletion(runId, 10, {
      prompt: 'A different question',
      generate: async ({ step }) =>
        step < 2 ? callLookup(step) : { content: 'Done.', toolCalls: [] },
    });
    expect(regenerated.steps).toHaveLength(3);
    expect(original.steps).toHaveLength(8);

    // The checkpoint holds the regenerated run's steps over the original's, and the original's beyond them.
    const records = [...regenerated.steps, ...original.steps.slice(regenerated.steps.length)];
    const seen = new Map(original.seen);
    for (const [step, observed] of regenerated.seen) seen.set(step, observed);
    const entries = rebuildAgainst(records, seen);
    for (const entry of entries) expectFaithful(entry);
    for (const entry of entries.slice(0, regenerated.steps.length)) {
      expect(entry.record!.truncated).toBe(false);
    }
  });

  it('rebuilds every step of a run recovered on a fresh engine mid-run', async () => {
    const storage = new MemoryStorage();
    const runId = 'context-recovered';
    const seen = new Map<number, string[]>();
    const a = await buildEngine(storage);
    const handle = await a.engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: 'Loop', maximumSteps: 10 },
      {
        id: runId,
        services: makeServices(
          {
            generate: async ({ step }) =>
              step < 4 ? callLookup(step) : new Promise<never>(() => {}),
          },
          seen,
        ),
      },
    );
    void handle.result().catch(() => {});
    await a.waitForCursorSave(4);
    a.engine[Symbol.dispose]();

    const b = await buildEngine(storage, () => ({
      status: 'available',
      services: makeServices(
        {
          generate: async ({ step }) =>
            step < 6 ? callLookup(step) : { content: 'Done.', toolCalls: [] },
        },
        seen,
      ),
    }));
    try {
      const [recovered] = await b.engine.recoverAll();
      await recovered!.result();
      const steps = await b.checkpointStore.loadSteps(runId);
      expect(steps).toHaveLength(7);
      // The conversation only grew, so the recovered steps still extend the steps before the crash.
      expect(steps.map((step) => step.effectiveContext?.kind)).toEqual([
        'full',
        ...Array.from({ length: 6 }, () => 'delta' as const),
      ]);
      for (const entry of rebuildAgainst(steps, seen)) {
        expectFaithful(entry);
        expect(entry.record!.truncated).toBe(false);
      }
    } finally {
      b.engine[Symbol.dispose]();
    }
  });
});
