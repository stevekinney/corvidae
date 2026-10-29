/**
 * COR-1376 — wall time of one long durable `agentRun`.
 *
 * Builds the engine the way `buildEngine` and `makeServices` do in
 * `src/durable/run-workflow.test.ts` (an in-memory Weft storage, a checkpoint
 * store over its text-value surface, and a toolbox with one no-op tool that
 * keeps the run going), runs `maximumSteps` steps, and prints the wall time.
 *
 * It is a measurement, not a test: nothing here gates `bun run test`. Profile it
 * with `bun --cpu-prof --cpu-prof-dir=<dir> scripts/benchmarks/durable-snapshot-save.ts`
 * from `packages/operative`. Pass a step count as the first argument (default 200).
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { Engine } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../../src/conditions/predicates';
import { createCheckpointStore } from '../../src/durable/checkpoint-store';
import { createRunWorkflow } from '../../src/durable/run-workflow';
import { createStorageActivities } from '../../src/durable/storage-activities';
import type { DurableRunDeps } from '../../src/durable/types';

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

async function measure(maximumSteps: number): Promise<{ steps: number; milliseconds: number }> {
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
    const runId = `profile-${maximumSteps}`;
    const started = performance.now();
    const handle = await engine.start(
      'agentRun',
      { runId, sessionId: runId, agentName: '', prompt: 'Loop', maximumSteps },
      { id: runId, services: makeServices() },
    );
    const result = await handle.result();
    return { steps: result.steps, milliseconds: performance.now() - started };
  } finally {
    engine[Symbol.dispose]();
  }
}

const requested = Number(Bun.argv[2] ?? 200);
const { steps, milliseconds } = await measure(requested);
console.log(JSON.stringify({ steps, milliseconds: Math.round(milliseconds) }));
