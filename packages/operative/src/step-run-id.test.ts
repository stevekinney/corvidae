/**
 * COR-2129 — a step's `StepResult` names the run it belongs to, on every step: a step that answers
 * with text and a step that only calls tools (no committed row, so no `messageId` to parse it from),
 * in a run held in memory, in a durable run, and in the result a durable run is read back as. The
 * field is not stored: a step record is written without it and reads back with the run's id.
 */
import { createDefaultRuntimeServices, HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls, stopWhen } from './conditions/index';
import { startDurableRunResult } from './durable/active-run-result-entrypoints';
import { createCheckpointStore } from './durable/checkpoint-store';
import { createRunEngine } from './durable/create-run-engine';
import { readDurableRunResult } from './durable/read-run-result';
import { createRunWorkflow } from './durable/run-workflow';
import type { OperativeHookMap } from './hooks';
import { executeLoop } from './loop';
import type { GenerateResponse, RunOptions, StepResult } from './types';

const ping = createTool({
  name: 'ping',
  description: 'Answers',
  input: z.object({}),
  execute: async () => 'pong',
});

/** A model that only calls `ping` on its first step and answers on its second. */
function toolThenText(): () => Promise<GenerateResponse> {
  let calls = 0;
  return async () =>
    calls++ === 0
      ? { content: '', toolCalls: [{ id: 'call-1', name: 'ping', arguments: {} }] }
      : { content: 'done', toolCalls: [] };
}

describe('StepResult.runId', () => {
  it('names the run on a tool-call-only step and on the answering step of an in-memory run', async () => {
    const seen: StepResult[] = [];
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onStep', async (step) => {
      seen.push(step);
    });

    const result = await executeLoop({
      generate: toolThenText(),
      toolbox: createToolbox([ping]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      runId: 'run-memory',
      hooks,
    });

    expect(result.steps.map((step) => step.runId)).toEqual(['run-memory', 'run-memory']);
    // The tool-call-only step committed no row, which is why `messageId` could not carry the id.
    expect(result.steps[0]?.messageId).toBeUndefined();
    expect(seen.map((step) => [step.step, step.runId])).toEqual([
      [0, 'run-memory'],
      [1, 'run-memory'],
    ]);
  });

  it('is absent for a run with no run id', async () => {
    const result = await executeLoop({
      generate: toolThenText(),
      toolbox: createToolbox([ping]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });

    for (const step of result.steps) expect('runId' in step).toBe(false);
  });

  it('names the run on a durable run’s steps and on the result read back, though the record stores none', async () => {
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
      const context = { engine, checkpointStore };
      const seen: StepResult[] = [];
      const hooks = new HookRegistry<OperativeHookMap>();
      hooks.on('onStep', async (step) => {
        seen.push(step);
      });
      const options: RunOptions = {
        generate: toolThenText(),
        toolbox: createToolbox([ping]),
        conversation: createConversationHistory(),
        stopWhen: stopWhen.noToolCalls(),
        hooks,
      };

      const original = await startDurableRunResult(context, {
        runId: 'run-durable',
        sessionId: 'run-durable',
        options,
        prompt: 'go',
      });
      expect(original.steps.map((step) => step.runId)).toEqual(['run-durable', 'run-durable']);
      expect(seen.map((step) => step.runId)).toEqual(['run-durable', 'run-durable']);

      const checkpoint = await checkpointStore.loadCheckpoint('run-durable', { strict: true });
      for (const record of checkpoint.steps) expect('runId' in record).toBe(false);

      const reading = await readDurableRunResult(context, 'run-durable', {
        runtime: createDefaultRuntimeServices(),
      });
      expect(reading.status).toBe('completed');
      if (reading.status !== 'completed') return;
      expect(reading.result.steps.map((step) => step.runId)).toEqual([
        'run-durable',
        'run-durable',
      ]);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
