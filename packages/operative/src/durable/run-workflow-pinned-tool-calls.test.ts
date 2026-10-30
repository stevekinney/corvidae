import { HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { Engine, yieldToPortableEventLoop } from '@lostgradient/weft';
import { type AnyToolbox, createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { OperativeHookMap } from '../hooks';
import { createCheckpointStore } from './checkpoint-store';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps } from './types';

/**
 * COR-1872 — a durable step records each tool call with the id of the tool it ran, resolved in the
 * toolbox the step ran against: a `selectTools` hook's replacement, not the run's base toolbox.
 */
function chargeTool(version: string) {
  return createTool({
    namespace: 'billing',
    name: 'charge-card',
    version,
    description: 'Charge a payment card',
    input: z.object({}),
    execute: async () => `charged at ${version}`,
  });
}

async function recordedToolCalls(services: DurableRunDeps, runId: string) {
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
      { runId, sessionId: runId, agentName: '', prompt: 'Charge', maximumSteps: 2 },
      { id: runId, services },
    );
    await handle.result();
    const steps = await checkpointStore.loadSteps(runId);
    return steps.flatMap((step) => step.toolCalls);
  } finally {
    engine[Symbol.dispose]();
  }
}

function servicesFor(
  baseToolbox: AnyToolbox,
  hooks?: HookRegistry<OperativeHookMap>,
): DurableRunDeps {
  return {
    toolbox: baseToolbox,
    options: {
      generate: async ({ step }) =>
        step === 0
          ? { content: '', toolCalls: [{ id: 'charge', name: 'charge-card', arguments: {} }] }
          : { content: 'done', toolCalls: [] },
      toolbox: baseToolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      ...(hooks === undefined ? {} : { hooks }),
    },
  };
}

afterEach(async () => {
  await yieldToPortableEventLoop();
});

describe('durable step records pin each tool call', () => {
  it('stores namespace:name@version for the tool the call ran', async () => {
    const calls = await recordedToolCalls(
      servicesFor(createToolbox([chargeTool('1.0.0')])),
      'pinned-base',
    );

    expect(calls).toEqual([
      expect.objectContaining({ id: 'charge', toolId: 'billing:charge-card@1.0.0' }),
    ]);
  });

  it('pins against the toolbox a selectTools hook chose for the step', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const selected = createToolbox([chargeTool('2.0.0')]);
    hooks.on('selectTools', async () => selected);

    const calls = await recordedToolCalls(
      servicesFor(createToolbox([chargeTool('1.0.0')]), hooks),
      'pinned-selected',
    );

    expect(calls).toEqual([
      expect.objectContaining({ id: 'charge', toolId: 'billing:charge-card@2.0.0' }),
    ]);
  });

  it('records no pin for a name no tool answers', async () => {
    const calls = await recordedToolCalls(servicesFor(createToolbox([])), 'pinned-missing');

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('toolId');
  });
});
