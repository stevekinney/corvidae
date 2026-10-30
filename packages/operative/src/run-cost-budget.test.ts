/**
 * COR-1914 — a run's `costBudget`: it ends a run that has spent `perRunUsd` as `budget-exceeded`
 * with an error naming the limit, announces each `warnAt` fraction once, keeps counting across a
 * durable recovery, prices a step at the model it ran on, and is refused where it could not be
 * enforced.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createTestToolbox, createTool } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation, createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import type { RunCostBudget } from './cost-budget';
import { crossedThresholds, totalAccumulatedCost, validateRunCostBudget } from './cost-budget';
import { createAgent } from './create-agent';
import { startDurableRunResult } from './durable/active-run-result-entrypoints';
import { createCheckpointStore } from './durable/checkpoint-store';
import { createRunEngine } from './durable/create-run-engine';
import { createRunWorkflow } from './durable/run-workflow';
import type { SteeringDesiredState } from './durable/types';
import { BudgetThresholdEvent } from './events';
import { buildStepDeps, createRunState, executeLoop } from './loop';
import { projectRunEvent } from './run-event-feed';
import { type EventDispatcher, runStep } from './run-step';
import type {
  GenerateResponse,
  RunOptions,
  RunOptionsBase,
  SteeringGate,
  TokenUsage,
} from './types';

const nextTool = createTool({
  name: 'next',
  description: 'continue to another step',
  input: z.object({}),
  execute: async () => 'ok',
});

/** One dollar per million tokens in, two out. */
const PRICING = {
  customPricing: {
    cheap: { promptCostPerMillionTokens: 1, completionCostPerMillionTokens: 2 },
    pricey: { promptCostPerMillionTokens: 10, completionCostPerMillionTokens: 20 },
  },
};
/** A request that costs $0.10 on `cheap`. */
const STEP_USAGE: TokenUsage = { prompt: 100_000, completion: 0, total: 100_000 };

/** A generate that asks for another step `steps - 1` times, then answers. */
function scripted(steps: number): RunOptions['generate'] {
  let call = 0;
  return async (): Promise<GenerateResponse> => {
    call += 1;
    const last = call >= steps;
    return {
      content: last ? 'done' : '',
      toolCalls: last ? [] : [{ name: 'next', arguments: {} }],
      usage: STEP_USAGE,
    };
  };
}

function recorder(): EventDispatcher & { events: Event[] } {
  const events: Event[] = [];
  return {
    events,
    dispatch(event) {
      events.push(event);
      return true;
    },
  };
}

function thresholds(events: readonly Event[]): Array<{ step: number | undefined; at: number }> {
  return events
    .filter((event): event is BudgetThresholdEvent => event instanceof BudgetThresholdEvent)
    .map((event) => ({ step: event.step, at: event.threshold }));
}

const BUDGET: RunCostBudget = { perRunUsd: 0.45, warnAt: [0.5, 0.9] };

/** An error's message, whatever the run result types the error as. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function options(
  overrides: Partial<RunOptionsBase> = {},
  steered?: { readonly steering: SteeringGate; readonly runId: string },
): RunOptions {
  return {
    generate: scripted(8),
    toolbox: createTestToolbox([nextTool]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    costEstimation: { model: 'cheap', pricing: PRICING },
    costBudget: BUDGET,
    ...overrides,
    ...steered,
  } as RunOptions;
}

describe('a run over its cost budget', () => {
  it('finishes budget-exceeded with an error that names perRunUsd, on the step that spent it', async () => {
    const result = await executeLoop(options());

    expect(result.finishReason).toBe('budget-exceeded');
    // $0.10 a step against $0.45: the fifth step takes the run to $0.50.
    expect(result.steps).toHaveLength(5);
    expect(messageOf(result.error)).toContain('perRunUsd');
    expect(messageOf(result.error)).toContain('0.45');
    expect(result.costEstimate?.totalCost).toBeCloseTo(0.5, 10);
  });

  it('runs on to its own finish when it stays under the budget', async () => {
    const result = await executeLoop(options({ generate: scripted(3) }));

    expect(result.finishReason).toBe('stop-condition');
    expect(result.error).toBeUndefined();
  });

  it('has no limit without a costBudget', async () => {
    const result = await executeLoop(options({ costBudget: undefined, generate: scripted(8) }));
    expect(result.finishReason).toBe('stop-condition');
  });
});

describe('warnAt', () => {
  it('announces each fraction once, on the step that crossed it, and before the run ends', async () => {
    const events = recorder();
    await executeLoop(options(), events);

    // 0.5 of $0.45 is $0.225, passed by the third step ($0.30); 0.9 is $0.405, by the fifth ($0.50).
    expect(thresholds(events.events)).toEqual([
      { step: 2, at: 0.5 },
      { step: 4, at: 0.9 },
    ]);
    const names = events.events.map((event) => event.type);
    expect(names.lastIndexOf('budget.threshold')).toBeLessThan(names.lastIndexOf('run.error'));
  });

  it('announces several fractions that one step crossed together, lowest first', async () => {
    const events = recorder();
    await executeLoop(
      options({ costBudget: { perRunUsd: 0.5, warnAt: [0.15, 0.1, 0.05] }, generate: scripted(2) }),
      events,
    );
    expect(thresholds(events.events).map((entry) => entry.at)).toEqual([0.05, 0.1, 0.15]);
  });

  it('announces nothing when the budget lists none', async () => {
    const events = recorder();
    await executeLoop(options({ costBudget: { perRunUsd: 0.45 } }), events);
    expect(thresholds(events.events)).toEqual([]);
  });

  it('publishes on the run event feed with no request content', () => {
    const projected = projectRunEvent(
      new BudgetThresholdEvent(
        { threshold: 0.5, currentCost: 0.3, budget: 0.45, model: 'cheap' },
        2,
      ),
    );
    expect(projected).toEqual({
      kind: 'budget.threshold',
      payload: { step: 2, threshold: 0.5, currentCost: 0.3, budget: 0.45, model: 'cheap' },
    });
  });
});

describe('a recovered run', () => {
  function stepDeps(budget: RunCostBudget) {
    return buildStepDeps(options({ costBudget: budget, generate: scripted(1) }));
  }

  it('starts from the cost its cursor kept: a fraction it already crossed is not announced again', async () => {
    const events = recorder();
    const runState = createRunState();
    // What the cursor holds after three steps ($0.30), the 0.5 fraction ($0.225) already behind it.
    runState.totalUsage = { prompt: 300_000, completion: 0, total: 300_000 };
    runState.cost = { promptCost: 0.3, completionCost: 0, cacheWriteCost: 0, cacheReadCost: 0 };

    const outcome = await runStep(stepDeps(BUDGET), runState, new Conversation(), 3, events);

    // The fourth step takes it to $0.40: nothing crossed, so nothing is said.
    expect(thresholds(events.events)).toEqual([]);
    expect(outcome.kind).not.toBe('error');
    expect(totalAccumulatedCost(runState.cost)).toBeCloseTo(0.4, 10);
  });

  it('announces the fraction the first step after the recovery crosses', async () => {
    const events = recorder();
    const runState = createRunState();
    runState.totalUsage = { prompt: 300_000, completion: 0, total: 300_000 };
    runState.cost = { promptCost: 0.3, completionCost: 0, cacheWriteCost: 0, cacheReadCost: 0 };

    await runStep(
      stepDeps({ perRunUsd: 0.45, warnAt: [0.5, 0.8] }),
      runState,
      new Conversation(),
      3,
      events,
    );
    expect(thresholds(events.events)).toEqual([{ step: 3, at: 0.8 }]);
  });

  it('does not lose the spend before the recovery: it ends on the first step that passes the budget', async () => {
    const runState = createRunState();
    runState.totalUsage = { prompt: 400_000, completion: 0, total: 400_000 };
    runState.cost = { promptCost: 0.4, completionCost: 0, cacheWriteCost: 0, cacheReadCost: 0 };

    const outcome = await runStep(stepDeps(BUDGET), runState, new Conversation(), 4, recorder());

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') return;
    expect(messageOf(outcome.error)).toContain('perRunUsd');
  });

  it('is enforced on a durable run, whose cursor keeps the cost', async () => {
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
      const result = await startDurableRunResult(
        { engine, checkpointStore },
        {
          runId: 'budgeted',
          sessionId: 'budgeted',
          options: options({ conversation: createConversationHistory() }),
          prompt: 'go',
        },
      );

      expect(result.finishReason).toBe('budget-exceeded');
      expect(messageOf(result.error)).toContain('perRunUsd');
      const checkpoint = await checkpointStore.loadCheckpoint('budgeted');
      expect(totalAccumulatedCost(checkpoint.cursor.cost)).toBeCloseTo(0.5, 10);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('a step on a switched model', () => {
  function gate(model: string | undefined): SteeringGate {
    const state: SteeringDesiredState = { paused: false, configVersion: 1, model };
    return {
      sessionId: 'session',
      getDesiredState: () => state,
      awaitResume: async () => {},
    };
  }

  it('is priced at that model’s rate, so the budget counts what was spent', async () => {
    // $0.10 a step on `cheap` and $1.00 on `pricey`: one pricey step passes a $0.45 budget.
    const result = await executeLoop(options({}, { steering: gate('pricey'), runId: 'run-1' }));
    expect(result.finishReason).toBe('budget-exceeded');
    expect(result.steps).toHaveLength(1);
    expect(result.costEstimate?.totalCost).toBeCloseTo(1, 10);
  });

  it('is priced at the agent’s model when the switched model has no price', async () => {
    const result = await executeLoop(options({}, { steering: gate('unpriced'), runId: 'run-1' }));
    expect(result.steps).toHaveLength(5);
  });
});

describe('what a budget needs', () => {
  const generate = scripted(1);

  it('createAgent refuses a budget with no costEstimation', () => {
    expect(() => createAgent({ generate, costBudget: BUDGET })).toThrow('costEstimation');
  });

  it('createAgent refuses a budget whose model has no price', () => {
    expect(() =>
      createAgent({ generate, costBudget: BUDGET, costEstimation: { model: 'no-such-model' } }),
    ).toThrow('costEstimation');
  });

  it('createAgent accepts a budget with a priced model', () => {
    expect(() =>
      createAgent({
        generate,
        costBudget: BUDGET,
        costEstimation: { model: 'cheap', pricing: PRICING },
      }),
    ).not.toThrow();
  });

  it('createAgent refuses a budget that is not a positive amount or a fraction list', () => {
    const costEstimation = { model: 'cheap', pricing: PRICING };
    for (const costBudget of [
      { perRunUsd: 0 },
      { perRunUsd: -1 },
      { perRunUsd: Number.NaN },
      { perRunUsd: Number.POSITIVE_INFINITY },
      { perRunUsd: 1, warnAt: [0] },
      { perRunUsd: 1, warnAt: [1] },
      { perRunUsd: 1, warnAt: [1.5] },
      { perRunUsd: 1, warnAt: Array.from({ length: 11 }, (_, index) => (index + 1) / 20) },
    ]) {
      expect(() => createAgent({ generate, costBudget, costEstimation })).toThrow('costBudget');
    }
  });
});

describe('crossedThresholds and validateRunCostBudget', () => {
  it('crosses a fraction in exactly one step’s range, and the budget itself is not a fraction', () => {
    const budget = { perRunUsd: 10, warnAt: [0.25, 0.5] };
    expect(crossedThresholds(budget, 0, 2)).toEqual([]);
    expect(crossedThresholds(budget, 2, 2.5)).toEqual([0.25]);
    expect(crossedThresholds(budget, 2.5, 5)).toEqual([0.5]);
    expect(crossedThresholds(budget, 5, 9)).toEqual([]);
    expect(crossedThresholds({ perRunUsd: 10 }, 0, 9)).toEqual([]);
  });

  it('accepts a good budget', () => {
    expect(validateRunCostBudget({ perRunUsd: 0.01, warnAt: [0.5, 0.9] })).toBeUndefined();
    expect(validateRunCostBudget({ perRunUsd: 1 })).toBeUndefined();
  });
});
