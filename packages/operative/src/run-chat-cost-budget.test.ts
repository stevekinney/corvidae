/**
 * COR-1915 — a run's chat budget: a run that begins with its chat's earlier runs already at
 * `perChatUsd` ends `budget-exceeded` naming `perChatUsd` before any model call, a run under the
 * limit is not affected, and a toolbox `budget` refusal ends the run `budget-exceeded`.
 */
import { createTestToolbox, createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import type { RunCostBudget } from './cost-budget';
import { validateRunCostBudget } from './cost-budget';
import { executeLoop } from './loop';
import type { GenerateResponse, RunOptions, TokenUsage } from './types';

const nextTool = createTool({
  name: 'next',
  description: 'continue to another step',
  input: z.object({}),
  execute: async () => 'ok',
});

const PRICING = {
  customPricing: { cheap: { promptCostPerMillionTokens: 1, completionCostPerMillionTokens: 2 } },
};
/** A request that costs $0.10 on `cheap`. */
const STEP_USAGE: TokenUsage = { prompt: 100_000, completion: 0, total: 100_000 };

function counting(steps: number): { generate: RunOptions['generate']; calls: () => number } {
  let call = 0;
  return {
    calls: () => call,
    generate: async (): Promise<GenerateResponse> => {
      call += 1;
      const last = call >= steps;
      return {
        content: last ? 'done' : '',
        toolCalls: last ? [] : [{ name: 'next', arguments: {} }],
        usage: STEP_USAGE,
      };
    },
  };
}

function options(
  generate: RunOptions['generate'],
  costBudget: RunCostBudget,
  toolbox: RunOptions['toolbox'] = createTestToolbox([nextTool]),
): RunOptions {
  return {
    generate,
    toolbox,
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    costEstimation: { model: 'cheap', pricing: PRICING },
    costBudget,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe('a run in a chat that has spent perChatUsd', () => {
  it('ends budget-exceeded, naming perChatUsd, before any model call', async () => {
    const script = counting(3);
    const result = await executeLoop(
      options(script.generate, { perRunUsd: 5, perChatUsd: 1, priorChatSpendUsd: 1.5 }),
    );
    expect(result.finishReason).toBe('budget-exceeded');
    expect(messageOf(result.error)).toContain('perChatUsd');
    expect(script.calls()).toBe(0);
  });

  it('stops at exactly the limit, as perRunUsd does', async () => {
    const script = counting(3);
    const result = await executeLoop(
      options(script.generate, { perRunUsd: 5, perChatUsd: 1, priorChatSpendUsd: 1 }),
    );
    expect(result.finishReason).toBe('budget-exceeded');
    expect(script.calls()).toBe(0);
  });

  it('runs a chat under the limit to its end, and lets a run cross the limit while it runs', async () => {
    const script = counting(3);
    const result = await executeLoop(
      options(script.generate, { perRunUsd: 5, perChatUsd: 0.15, priorChatSpendUsd: 0.1 }),
    );
    expect(result.finishReason).not.toBe('budget-exceeded');
    expect(script.calls()).toBe(3);
  });

  it('counts a missing prior spend as nothing', async () => {
    const script = counting(1);
    const result = await executeLoop(options(script.generate, { perRunUsd: 5, perChatUsd: 1 }));
    expect(result.finishReason).not.toBe('budget-exceeded');
  });

  it('is refused when perChatUsd or the prior spend cannot be a dollar amount', () => {
    expect(validateRunCostBudget({ perRunUsd: 1, perChatUsd: 0 })).toContain('perChatUsd');
    expect(validateRunCostBudget({ perRunUsd: 1, perChatUsd: Number.NaN })).toContain('perChatUsd');
    expect(validateRunCostBudget({ perRunUsd: 1, perChatUsd: 1, priorChatSpendUsd: -1 })).toContain(
      'priorChatSpendUsd',
    );
    expect(
      validateRunCostBudget({ perRunUsd: 1, perChatUsd: 2, priorChatSpendUsd: 1 }),
    ).toBeUndefined();
  });
});

describe('a toolbox budget refusal', () => {
  it('ends the run budget-exceeded with a message that names the limit, though the toolbox collects errors', async () => {
    const script = counting(6);
    const toolbox = createToolbox([nextTool], { budget: { maxCalls: 1 } });
    const result = await executeLoop(options(script.generate, { perRunUsd: 50 }, toolbox));
    expect(result.finishReason).toBe('budget-exceeded');
    expect(messageOf(result.error)).toContain('max calls 1');
    // The first call passed the budget; the second was refused, and the run did not go on.
    expect(script.calls()).toBe(2);
  });
});
