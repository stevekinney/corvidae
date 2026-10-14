/**
 * COR-1497 — a run's terminal `costEstimate` is the sum of every request priced on its own usage,
 * so a long-prompt tier applies to exactly the requests that crossed it.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { estimateCost } from './cost-estimation';
import { startDurableRunResult } from './durable/active-run-result-entrypoints';
import { createCheckpointStore } from './durable/checkpoint-store';
import { createRunEngine } from './durable/create-run-engine';
import { readDurableRunResult } from './durable/read-run-result';
import { createRunWorkflow } from './durable/run-workflow';
import { executeLoop } from './loop';
import type { GenerateResponse, RunOptions, TokenUsage } from './types';

const nextTool = createTool({
  name: 'next',
  description: 'continue to another step',
  input: z.object({}),
  execute: async () => 'ok',
});

const longPrompt: TokenUsage = { prompt: 150_000, completion: 1_000, total: 151_000 };
const shortPrompt: TokenUsage = { prompt: 20_000, completion: 2_000, total: 22_000 };

function scripted(usages: TokenUsage[]): RunOptions['generate'] {
  let call = 0;
  return async (): Promise<GenerateResponse> => {
    const usage = usages[call++]!;
    const last = call === usages.length;
    return {
      content: last ? 'done' : '',
      toolCalls: last ? [] : [{ name: 'next', arguments: {} }],
      usage,
    };
  };
}

function sumOfRequests(usages: TokenUsage[], model: string): number {
  return usages.reduce((sum, usage) => sum + estimateCost(usage, model).totalCost, 0);
}

describe('RunResult.costEstimate', () => {
  it('prices a long-prompt and a short-prompt Haiku 5.5 request each at its own tier', async () => {
    const model = 'claude-haiku-5-5';
    const result = await executeLoop({
      generate: scripted([longPrompt, shortPrompt]),
      toolbox: createTestToolbox([nextTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      costEstimation: { model },
    });

    const expected = sumOfRequests([longPrompt, shortPrompt], model);
    // 150k prompt at the long-context $0.5 + 1k completion at $2.5, then 20k at $0.1 + 2k at $0.5.
    expect(expected).toBeCloseTo(0.075 + 0.0025 + 0.002 + 0.001, 10);
    expect(result.costEstimate?.totalCost).toBeCloseTo(expected, 10);
    expect(result.costEstimate?.promptCost).toBeCloseTo(0.075 + 0.002, 10);
    expect(result.costEstimate?.completionCost).toBeCloseTo(0.0025 + 0.001, 10);
    expect(result.costEstimate?.usage).toEqual(result.usage);
    expect(result.usage.prompt).toBe(170_000);
  });

  it('leaves a model with no long-context tier unchanged', async () => {
    const model = 'claude-haiku-4-5';
    const result = await executeLoop({
      generate: scripted([longPrompt, shortPrompt]),
      toolbox: createTestToolbox([nextTool]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      costEstimation: { model },
    });

    const aggregate = estimateCost(result.usage, model, undefined, 'aggregate');
    expect(result.costEstimate?.totalCost).toBeCloseTo(aggregate.totalCost, 10);
    expect(result.costEstimate?.promptCost).toBeCloseTo(aggregate.promptCost, 10);
  });

  it('reports no estimate without costEstimation', async () => {
    const result = await executeLoop({
      generate: scripted([longPrompt]),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
    });
    expect(result.costEstimate).toBeUndefined();
  });
});

describe('durable run costEstimate', () => {
  it('keeps the accumulated per-request cost across a checkpoint round trip', async () => {
    const model = 'claude-haiku-5-5';
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
      const options: RunOptions = {
        generate: scripted([longPrompt, shortPrompt]),
        toolbox: createTestToolbox([nextTool]),
        conversation: createConversationHistory(),
        stopWhen: noToolCalls(),
        costEstimation: { model },
      };
      await startDurableRunResult(
        { engine, checkpointStore },
        { runId: 'tiered', sessionId: 'tiered', options, prompt: 'go' },
      );
      const expected = sumOfRequests([longPrompt, shortPrompt], model);

      const checkpoint = await checkpointStore.loadCheckpoint('tiered');
      expect(checkpoint.cursor.cost).toBeDefined();

      const reading = await readDurableRunResult({ engine, checkpointStore }, 'tiered', {
        runtime: createDefaultRuntimeServices(),
        costEstimation: { model },
      });
      expect(reading.status).toBe('completed');
      if (reading.status !== 'completed') return;
      expect(reading.result.costEstimate?.totalCost).toBeCloseTo(expected, 10);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});
