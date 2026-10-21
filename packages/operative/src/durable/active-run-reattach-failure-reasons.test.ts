import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  AgentRunError,
  BudgetExceededError,
  ElicitationDeniedError,
  GuardrailTripwireError,
} from '../errors';
import {
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
  RunTripwireEvent,
  type CombinedOperativeEventMap,
} from '../events';
import type { FinishReason } from '../types';
import { reattachDurableActiveRun } from './active-run-reattach';
import { createCheckpointStore } from './checkpoint-store';
import type { RegistryAgnosticEngine } from './create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from './run-workflow-result';

/**
 * COR-1598: a run recovered after a crash announces a failure the way a run that failed in this
 * process does, `run.error` and then `run.completed`, for every reason that ends in a failure.
 * The step's own `run.error` fired in the process that died, so the recovering process has only
 * the stored summary to go on.
 */

const emptyCheckpointStore = createCheckpointStore(
  textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
);

type Observed = {
  readonly type: string;
  readonly reconstructed?: unknown;
  readonly errorName?: string | undefined;
};

function observeLifecycle(emitter: CompletableEventTarget<CombinedOperativeEventMap>) {
  const observed: Observed[] = [];
  emitter.addEventListener(RunErrorEvent.type, (event) => {
    observed.push({
      type: RunErrorEvent.type,
      // The key itself, so a flag that is present but `undefined` is told from an absent one.
      reconstructed: Object.hasOwn(event, 'reconstructed') ? event.reconstructed : 'absent',
      errorName: event.error.constructor.name,
    });
  });
  emitter.addEventListener(RunTripwireEvent.type, () => {
    observed.push({ type: RunTripwireEvent.type });
  });
  emitter.addEventListener(RunCompletedEvent.type, () => {
    observed.push({ type: RunCompletedEvent.type });
  });
  emitter.addEventListener(RunAbortedEvent.type, () => {
    observed.push({ type: RunAbortedEvent.type });
  });
  return observed;
}

type FailureCase = {
  readonly finishReason: Extract<
    FinishReason,
    'error' | 'budget-exceeded' | 'tripwire' | 'elicitation-denied'
  >;
  readonly summary: Record<string, unknown>;
  readonly errorClass: string;
  /** What the step that failed in the dead process would have dispatched. */
  readonly stepError: () => AgentRunError;
  readonly lifecycle: readonly string[];
};

function summaryFor(runId: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
    runId,
    steps: 1,
    content: '',
    parts: [],
    ...fields,
  };
}

const tripwireDetail = {
  guardrailName: 'no-secrets',
  category: 'secrets',
  phase: 'input' as const,
  confidence: 0.9,
};

const failureCases: readonly FailureCase[] = [
  {
    finishReason: 'error',
    summary: summaryFor('reattach-error', {
      finishReason: 'error',
      errorMessage: 'the model refused',
    }),
    errorClass: 'AgentRunError',
    stepError: () => new AgentRunError('the model refused', { kind: 'generate', code: 'UNKNOWN' }),
    lifecycle: ['run.error', 'run.completed'],
  },
  {
    finishReason: 'budget-exceeded',
    summary: summaryFor('reattach-budget-exceeded', {
      finishReason: 'budget-exceeded',
      errorMessage: 'token limit reached',
    }),
    errorClass: 'BudgetExceededError',
    stepError: () => new BudgetExceededError('token limit reached'),
    lifecycle: ['run.error', 'run.completed'],
  },
  {
    finishReason: 'tripwire',
    summary: summaryFor('reattach-tripwire', {
      finishReason: 'tripwire',
      errorMessage: 'guardrail tripped',
      tripwire: tripwireDetail,
    }),
    errorClass: 'GuardrailTripwireError',
    stepError: () => new GuardrailTripwireError('guardrail tripped', tripwireDetail),
    lifecycle: ['run.error', 'run.tripwire', 'run.completed'],
  },
  {
    finishReason: 'elicitation-denied',
    summary: summaryFor('reattach-elicitation-denied', {
      finishReason: 'elicitation-denied',
      errorMessage: 'the user declined',
    }),
    errorClass: 'ElicitationDeniedError',
    stepError: () => new ElicitationDeniedError('the user declined'),
    lifecycle: ['run.error', 'run.completed'],
  },
];

function reattach(
  summary: Record<string, unknown>,
  emitter: CompletableEventTarget<CombinedOperativeEventMap>,
  beforeResolve?: () => void,
) {
  const runId = String(summary['runId']);
  return reattachDurableActiveRun(
    { engine: {} as RegistryAgnosticEngine, checkpointStore: emptyCheckpointStore },
    {
      runId,
      handle: {
        id: runId,
        result: () => {
          beforeResolve?.();
          return Promise.resolve(summary);
        },
      },
      emitter,
    },
  ).result;
}

describe('a reattached run whose summary carries a failure finish reason', () => {
  for (const { finishReason, summary, errorClass, lifecycle } of failureCases) {
    it(`announces run.error before run.completed for ${finishReason}`, async () => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const observed = observeLifecycle(emitter);

      const result = await reattach(summary, emitter);

      expect(result.finishReason).toBe(finishReason);
      expect(observed.map(({ type }) => type)).toEqual([...lifecycle]);
      // The announcement is a reconstruction: its step is a count of recorded steps.
      expect(observed[0]).toEqual({
        type: RunErrorEvent.type,
        reconstructed: true,
        errorName: errorClass,
      });
    });

    it(`keeps a run.error this process already saw and does not repeat it for ${finishReason}`, async () => {
      const failure = failureCases.find((candidate) => candidate.finishReason === finishReason)!;
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const observed = observeLifecycle(emitter);

      await reattach(summary, emitter, () => {
        emitter.dispatch(new RunErrorEvent(1, failure.stepError(), 'generate'));
      });

      expect(observed.map(({ type }) => type)).toEqual([...lifecycle]);
      // The step's own event, which carries a real step, is the one that stays.
      expect(observed[0]).toMatchObject({ type: RunErrorEvent.type, reconstructed: 'absent' });
    });
  }

  it('announces no run.error for a run that stopped without failing', async () => {
    for (const finishReason of ['stop-condition', 'maximum-steps'] as const) {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const observed = observeLifecycle(emitter);

      const result = await reattach(
        summaryFor(`reattach-${finishReason}`, { finishReason, content: 'Done.' }),
        emitter,
      );

      expect([finishReason, result.finishReason]).toEqual([finishReason, finishReason]);
      expect([finishReason, observed.map(({ type }) => type)]).toEqual([
        finishReason,
        ['run.completed'],
      ]);
    }
  });
});
