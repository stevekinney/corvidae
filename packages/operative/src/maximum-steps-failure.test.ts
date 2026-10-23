import { HookRegistry } from '@lostgradient/lifecycle';
import { createTool, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';
import { z } from 'zod';

import { createActiveRun } from './create-run';
import { MaximumStepsExceededError } from './errors';
import type { OperativeHookMap } from './hooks';
import { createStore } from './store/store';
import type { RunOptions } from './types';

/**
 * COR-1627: a run that stops at its step limit is a failure like every other: it announces itself
 * with `run.error` before `run.completed`, and the run record reads `error`.
 */

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => ({ ok: true }),
});

/** A run whose model never stops, so it ends at `maximumSteps`. */
function neverStopping(
  overrides: Pick<
    RunOptions,
    'hooks' | 'maximumSteps' | 'onMaximumSteps' | 'stopWhen' | 'runId'
  > = {},
): RunOptions {
  return {
    generate: async ({ step }) => ({
      content: `step ${step}`,
      toolCalls: [{ name: 'next', arguments: {} }],
    }),
    toolbox: createToolbox([nextTool]),
    conversation: createConversationHistory(),
    maximumSteps: 2,
    ...overrides,
  };
}

function runErrorHooks(errors: unknown[]): RunOptions['hooks'] {
  const hooks = new HookRegistry<OperativeHookMap>();
  hooks.on('onRunError', async ({ error }) => {
    errors.push(error);
  });
  return hooks;
}

type Observed = { type: string; step?: number; error?: unknown };

function observe(activeRun: ReturnType<typeof createActiveRun>): Observed[] {
  const observed: Observed[] = [];
  activeRun.addEventListener('run.error', (event) => {
    observed.push({ type: 'run.error', step: event.step, error: event.error });
  });
  activeRun.addEventListener('run.completed', (event) => {
    observed.push({ type: 'run.completed', error: event.error });
  });
  return observed;
}

describe('a run that stops at its step limit', () => {
  it('fires run.error, then run.completed, each once, and runs onRunError once', async () => {
    const hookErrors: unknown[] = [];
    const activeRun = createActiveRun(
      neverStopping({
        hooks: runErrorHooks(hookErrors),
      }),
    );
    const observed = observe(activeRun);

    const result = await activeRun.result;
    await activeRun.closed();

    expect(result.finishReason).toBe('maximum-steps');
    expect(observed.map(({ type }) => type)).toEqual(['run.error', 'run.completed']);
    const [announced, completed] = observed;
    expect(announced?.error).toBeInstanceOf(MaximumStepsExceededError);
    expect(announced?.error).toMatchObject({ kind: 'policy', code: 'MAXIMUM_STEPS' });
    // The step is the count of steps the run recorded.
    expect(announced?.step).toBe(result.steps.length);
    expect(announced?.step).toBe(2);
    // The same error rides on the completion and the result.
    expect(completed?.error).toBe(announced?.error);
    expect(result.error).toBe(announced?.error as MaximumStepsExceededError);
    expect(hookErrors).toEqual([announced?.error]);
  });

  it('keeps the onMaximumSteps answer on run.completed, after the run.error', async () => {
    const activeRun = createActiveRun(
      neverStopping({ onMaximumSteps: async () => 'Out of steps; here is what I have.' }),
    );
    const observed = observe(activeRun);

    const result = await activeRun.result;

    expect(observed.map(({ type }) => type)).toEqual(['run.error', 'run.completed']);
    expect(result.finishReason).toBe('maximum-steps');
    expect(result.content).toBe('Out of steps; here is what I have.');
    expect(result.error).toBeInstanceOf(MaximumStepsExceededError);
  });

  it('is an error in the run store, with its finish reason and the step-limit error', async () => {
    const store = createStore();
    const activeRun = createActiveRun(neverStopping({ runId: 'step-limit-run' }));
    store.register(activeRun, activeRun.runId);

    const result = await activeRun.result;

    const record = store.getRun('step-limit-run');
    expect(record?.status).toBe('error');
    expect(record?.finishReason).toBe('maximum-steps');
    expect(record?.error).toBe(result.error);
    expect(record?.error).toBeInstanceOf(MaximumStepsExceededError);
  });

  it('still completes a run that a stop condition ends, with no run.error', async () => {
    const activeRun = createActiveRun(
      neverStopping({ stopWhen: () => true, maximumSteps: 5, runId: 'stopped-run' }),
    );
    const observed = observe(activeRun);

    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(observed.map(({ type }) => type)).toEqual(['run.completed']);
  });
});

describe('a run that throws a step-limit error of its own (COR-1627)', () => {
  // The in-process rows of the durable loop's outcome matrix (`run-workflow-outcomes.test.ts`):
  // a thrown `MaximumStepsExceededError` ends through `makeErrorResult` as `maximum-steps`, with
  // the step's own `run.error` and the limit the error named, not the count of steps the run ran.
  const thrown = () => new MaximumStepsExceededError(9);
  const rows: ReadonlyArray<{ name: string; options: () => RunOptions; steps: number }> = [
    {
      name: 'generate throws it',
      options: () => ({
        ...neverStopping({ maximumSteps: 5 }),
        generate: async () => {
          throw thrown();
        },
      }),
      steps: 0,
    },
    {
      name: 'an afterToolExecution hook throws it',
      options: () => {
        const hooks = new HookRegistry<OperativeHookMap>();
        hooks.on('afterToolExecution', async () => {
          throw thrown();
        });
        return neverStopping({ maximumSteps: 5, hooks });
      },
      steps: 0,
    },
  ];

  for (const row of rows) {
    it(`ends as maximum-steps with that error, once, when ${row.name}`, async () => {
      const hookErrors: unknown[] = [];
      const options = row.options();
      const hooks = options.hooks ?? new HookRegistry<OperativeHookMap>();
      hooks.on('onRunError', async ({ error }) => {
        hookErrors.push(error);
      });
      const activeRun = createActiveRun({ ...options, hooks });
      const observed = observe(activeRun);

      const result = await activeRun.result;
      await activeRun.closed();

      expect(result.finishReason).toBe('maximum-steps');
      expect(result.steps).toHaveLength(row.steps);
      expect(observed.map(({ type }) => type)).toEqual(['run.error', 'run.completed']);
      const announced = observed[0]?.error;
      expect(announced).toBeInstanceOf(MaximumStepsExceededError);
      expect((announced as Error).message).toBe('Agent run exceeded maximumSteps (9).');
      expect(result.error).toBe(announced);
      expect(hookErrors).toEqual([announced]);
    });
  }
});
