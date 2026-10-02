import { sha256HexSync } from '@lostgradient/cryptography';
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore, yieldToPortableEventLoop } from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import { noToolCalls } from './conditions/predicates';
import { BudgetExceededError, GoalConfigurationError, VALIDATOR_ERROR_KINDS } from './errors';
import {
  GoalAttemptStartedEvent,
  GoalAttemptValidatedEvent,
  GoalFeedbackRecordedEvent,
} from './events';
import {
  createFixtureArtifact,
  createFixtureSource,
  FIXTURE_NOW,
  resolverFor,
} from './fresh-attempt/fixtures/artifact-fixture';
import type { FreshAttemptSourceResolver } from './fresh-attempt/validate';
import {
  canTransitionGoalRun,
  GOAL_RUN_TRANSITIONS,
  startGoal,
  type GoalRun,
  type GoalRunEvent,
  type GoalRunStatus,
  type GoalRunTerminalReason,
  type StartGoalOptions,
  type Validator,
  type ValidatorInput,
  type ValidatorOutcome,
} from './goal-run';
import { createSessionStore } from './session/create-session-store';
import { createSessionHandle } from './session/session-handle';
import type { GenerateContext, GenerateFunction, GenerateResponse, RunOptions } from './types';

afterEach(async () => {
  await yieldToPortableEventLoop();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function reply(total = 10, content = 'attempt output'): GenerateResponse {
  return { content, toolCalls: [], usage: { prompt: total, completion: 0, total } };
}

const instantGenerate: GenerateFunction = async () => reply();

/** A generate function that blocks until its signal aborts, then rejects like a provider would. */
function createBlockingGenerate(reached: Deferred<void>): GenerateFunction {
  return (context: GenerateContext) =>
    new Promise<GenerateResponse>((_resolve, reject) => {
      reached.resolve();
      context.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });
}

function createFixture(
  options: {
    generate?: GenerateFunction;
    maximumSteps?: number;
    resolveFreshAttemptSource?: FreshAttemptSourceResolver;
    toolbox?: RunOptions['toolbox'];
    costEstimation?: boolean;
  } = {},
) {
  const runtime: ManualRuntimeServices = createManualRuntimeServices({
    origin: new Date(FIXTURE_NOW).toISOString(),
  });
  const store = createSessionStore(textValueStore(new MemoryStorage()), { runtime });
  const session = createSessionHandle('goal-session', {
    store,
    agentName: 'goal-agent',
    runtime,
    runOptions: {
      generate: options.generate ?? instantGenerate,
      toolbox: options.toolbox ?? createToolbox([]),
      maximumSteps: options.maximumSteps ?? 5,
      stopWhen: noToolCalls(),
    },
    ...(options.resolveFreshAttemptSource
      ? { resolveFreshAttemptSource: options.resolveFreshAttemptSource }
      : {}),
  });
  return { runtime, store, session };
}

/** An outcome (or any malformed value), or a function receiving the call and its signal. */
type ScriptedStep = unknown;

interface ScriptedValidator extends Validator {
  readonly calls: ValidatorInput[];
  readonly signals: AbortSignal[];
}

/** Plays `steps` in order; the last step repeats. A function step receives the call. */
function scriptedValidator(
  steps: readonly ScriptedStep[],
  overrides: Partial<Pick<Validator, 'determinism'>> = {},
): ScriptedValidator {
  const calls: ValidatorInput[] = [];
  const signals: AbortSignal[] = [];
  return {
    identity: { name: '@test/validator', version: '1.0.0' },
    ...overrides,
    calls,
    signals,
    async validate(input, signal) {
      calls.push(input);
      signals.push(signal);
      const step = steps[Math.min(calls.length - 1, steps.length - 1)];
      return (typeof step === 'function' ? await step(input, signal) : step) as ValidatorOutcome;
    },
  };
}

const PASS: ValidatorOutcome = { kind: 'pass', evidence: [{ source: 'unit', detail: 'ok' }] };

function failing(retryable = true, feedback = 'try harder'): ValidatorOutcome {
  return { kind: 'fail', feedback, evidence: [{ source: 'unit', detail: 'nope' }], retryable };
}

function goalOptions(
  fixture: ReturnType<typeof createFixture>,
  validator: Validator,
  overrides: Partial<StartGoalOptions> = {},
): StartGoalOptions {
  return {
    identity: { name: '@test/goal', version: '1.0.0' },
    session: fixture.session,
    prompt: 'achieve the goal',
    validator,
    budget: { maximumAttempts: 3, maximumTotalSteps: 1000 },
    conversationPolicy: { kind: 'continue' },
    runtime: fixture.runtime,
    ...overrides,
  };
}

async function collect(run: GoalRun): Promise<GoalRunEvent[]> {
  const events: GoalRunEvent[] = [];
  for await (const event of run) events.push(event);
  return events;
}

const RETRY_ON_FAIL = { retryOn: ['validator-fail-retryable'] } as const;

function types(events: readonly GoalRunEvent[]): string[] {
  return events.map((event) => event.type);
}

async function statusOf(run: GoalRun): Promise<GoalRunStatus> {
  const result = await run.result();
  return result.status;
}

async function runToEnd(options: StartGoalOptions) {
  const run = startGoal(options);
  const events = collect(run);
  const result = await run.result();
  return { run, result, events: await events };
}

// ---------------------------------------------------------------------------
// AC1: configuration
// ---------------------------------------------------------------------------

describe('configuration', () => {
  function reasonOf(options: StartGoalOptions): string | undefined {
    try {
      startGoal(options);
    } catch (error) {
      return error instanceof GoalConfigurationError ? error.reason : 'other-error';
    }
    return undefined;
  }

  it('rejects a goal with no validator', () => {
    const fixture = createFixture();
    const options = { ...goalOptions(fixture, scriptedValidator([PASS])), validator: undefined };
    expect(reasonOf(options as unknown as StartGoalOptions)).toBe('missing-validator');
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])(
    'rejects maximumAttempts %p before anything runs',
    (maximumAttempts) => {
      const fixture = createFixture();
      const runSpy = spyOn(fixture.session, 'run');
      const options = goalOptions(fixture, scriptedValidator([PASS]), {
        budget: { maximumAttempts, maximumTotalSteps: 10 } as never,
      });
      expect(reasonOf(options)).toBe('invalid-maximum-attempts');
      expect(runSpy).not.toHaveBeenCalled();
    },
  );

  it('rejects a budget with maximumAttempts but no aggregate bound', () => {
    const fixture = createFixture();
    const options = goalOptions(fixture, scriptedValidator([PASS]), {
      budget: { maximumAttempts: 2 },
    });
    expect(reasonOf(options)).toBe('missing-aggregate-bound');
  });

  it.each([
    { maximumTotalDurationMs: 1000 },
    { maximumTotalSteps: 5 },
    { maximumTotalTokens: 500 },
    { maximumTotalCostUsd: 1 },
  ])('accepts exactly one aggregate bound: %p', async (bound) => {
    const fixture = createFixture();
    const run = startGoal(
      goalOptions(fixture, scriptedValidator([PASS]), {
        budget: { maximumAttempts: 1, ...bound },
      }),
    );
    run.abort();
    expect(await statusOf(run)).toBe('canceled');
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an aggregate bound of %p',
    (value) => {
      const fixture = createFixture();
      const options = goalOptions(fixture, scriptedValidator([PASS]), {
        budget: { maximumAttempts: 1, maximumTotalSteps: value },
      });
      expect(reasonOf(options)).toBe('invalid-aggregate-bound');
    },
  );

  it.each([undefined, -1, 1.5])('rejects fork-from-baseline with throughRun %p', (throughRun) => {
    const fixture = createFixture();
    const options = goalOptions(fixture, scriptedValidator([PASS]), {
      conversationPolicy: { kind: 'fork-from-baseline', throughRun } as never,
    });
    expect(reasonOf(options)).toBe('invalid-baseline');
  });

  it('rejects an unknown conversation policy', () => {
    const fixture = createFixture();
    const options = goalOptions(fixture, scriptedValidator([PASS]), {
      conversationPolicy: { kind: 'nonsense' } as never,
    });
    expect(reasonOf(options)).toBe('invalid-conversation-policy');
  });

  it.each([{ retryOn: [] }, { retryOn: ['validator-error'] }, { retryOn: 'validator-canceled' }])(
    'rejects retry policy %p',
    (retryPolicy) => {
      const fixture = createFixture();
      const options = goalOptions(fixture, scriptedValidator([PASS]), {
        retryPolicy: retryPolicy as never,
      });
      expect(reasonOf(options)).toBe('invalid-retry-policy');
    },
  );

  it('rejects fresh-from-artifact without instructions', async () => {
    const fixture = createFixture();
    const artifact = await createFixtureArtifact();
    const options = goalOptions(fixture, scriptedValidator([PASS]), {
      conversationPolicy: { kind: 'fresh-from-artifact', artifact },
    });
    expect(reasonOf(options)).toBe('missing-instructions');
  });

  it('emits no event and creates no run for a rejected configuration', () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const dispatched: Event[] = [];
    const emitter = { dispatchEvent: (event: Event) => dispatched.push(event) };
    expect(
      reasonOf(
        goalOptions(fixture, scriptedValidator([PASS]), {
          budget: { maximumAttempts: 0, maximumTotalSteps: 1 },
          emitter: emitter as never,
        }),
      ),
    ).toBe('invalid-maximum-attempts');
    expect(dispatched).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC2: the handle
// ---------------------------------------------------------------------------

describe('handle', () => {
  it('is not thenable', async () => {
    const fixture = createFixture();
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    expect('then' in run).toBe(false);
    const awaited: unknown = await run;
    expect(awaited).toBe(run);
    await run.result();
  });

  it('exposes identity, kind, status, history, usage, budget, and a cached result', async () => {
    const fixture = createFixture();
    const options = goalOptions(fixture, scriptedValidator([PASS]), { goalRunId: 'goal-fixed' });
    const run = startGoal(options);
    expect(run.goalRunId).toBe('goal-fixed');
    expect(run.identity).toEqual({ name: '@test/goal', version: '1.0.0' });
    expect(run.kind).toBe('goal-run');
    expect(run.result()).toBe(run.result());
    const result = await run.result();
    expect(run.result()).toBe(run.result());
    expect(run.status()).toBe('succeeded');
    expect(run.budget()).toEqual({ maximumAttempts: 3, maximumTotalSteps: 1000 });
    expect(run.usage()).toMatchObject({ attempts: 1, steps: 1, tokens: 10, costUsd: undefined });
    expect(result.usage).toEqual(run.usage());
    expect(run.currentAttempt()?.attemptId).toBe(run.attempts()[0]?.attemptId);
  });

  it('returns attempt history as a snapshot', async () => {
    const fixture = createFixture();
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    await run.result();
    const snapshot = run.attempts() as unknown as { status: string; usage: { steps: number } }[];
    snapshot.push({ status: 'forged', usage: { steps: 0 } });
    const first = run.attempts()[0] as unknown as { status: string; usage: { steps: number } };
    first.status = 'forged';
    first.usage.steps = 999;
    expect(run.attempts()).toHaveLength(1);
    expect(run.attempts()[0]?.status).toBe('passed');
    expect(run.attempts()[0]?.usage.steps).toBe(1);
  });

  it('lets a late second consumer replay the buffered events', async () => {
    const fixture = createFixture();
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    const first = await collect(run);
    await run.result();
    const second = await collect(run);
    expect(types(second)).toEqual(types(first));
    expect(types(first)[0]).toBe('goal.started');
  });

  it('stops an iterator that returns early without disturbing the goal', async () => {
    const fixture = createFixture();
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    for await (const event of run) {
      expect(event.type).toBe('goal.started');
      break;
    }
    expect(await statusOf(run)).toBe('succeeded');
  });

  it('disposes a non-terminal goal as a cancellation and ignores a terminal one', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    await reached.promise;
    run[Symbol.dispose]();
    expect(await statusOf(run)).toBe('canceled');

    const done = createFixture();
    const finished = startGoal(goalOptions(done, scriptedValidator([PASS])));
    await finished.result();
    finished[Symbol.dispose]();
    expect(finished.status()).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// AC3: validator contract
// ---------------------------------------------------------------------------

describe('validator contract', () => {
  it('lists exactly the five validator error kinds', () => {
    expect([...VALIDATOR_ERROR_KINDS]).toEqual([
      'load',
      'contract',
      'execute',
      'timeout',
      'output',
    ]);
  });

  it('records identity, timestamps from the runtime clock, and the outcome on the attempt', async () => {
    const fixture = createFixture();
    const validator = scriptedValidator([
      async () => {
        await fixture.runtime.advance(250);
        return PASS;
      },
    ]);
    const { run } = await runToEnd(goalOptions(fixture, validator));
    const validation = run.attempts()[0]?.validation;
    expect(validation?.identity).toEqual(validator.identity);
    expect(validation?.outcome).toEqual(PASS);
    expect(
      Date.parse(validation?.completedAt ?? '') - Date.parse(validation?.startedAt ?? ''),
    ).toBe(250);
  });

  it('retains fail feedback and evidence as structured data on the attempt', async () => {
    const fixture = createFixture();
    const outcome = failing(false, 'the file is missing');
    const { run } = await runToEnd(goalOptions(fixture, scriptedValidator([outcome])));
    expect(run.attempts()[0]?.validation?.outcome).toEqual(outcome);
    expect(run.attempts()[0]?.feedback).toBe('the file is missing');
    expect(run.lastFeedback()).toBe('the file is missing');
  });

  it('narrows exhaustively over the six outcome kinds', () => {
    const label = (outcome: ValidatorOutcome): string => {
      switch (outcome.kind) {
        case 'pass':
        case 'fail':
        case 'error':
        case 'unavailable':
        case 'canceled':
        case 'indeterminate':
          return outcome.kind;
        default: {
          const unreachable: never = outcome;
          return unreachable;
        }
      }
    };
    expect(label(PASS)).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe('scenarios', () => {
  it('succeeds on the first attempt', async () => {
    const fixture = createFixture();
    const { result, run, events } = await runToEnd(goalOptions(fixture, scriptedValidator([PASS])));
    expect(result).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
    expect(run.attempts()).toHaveLength(1);
    expect(run.attempts()[0]).toMatchObject({ status: 'passed', finishReason: 'stop-condition' });
    expect(types(events)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
  });

  it('fails once, retries under a declared policy, then succeeds', async () => {
    const fixture = createFixture();
    const validator = scriptedValidator([failing(true, 'first miss'), PASS]);
    const { result, run, events } = await runToEnd(
      goalOptions(fixture, validator, { retryPolicy: RETRY_ON_FAIL }),
    );
    expect(result.status).toBe('succeeded');
    expect(run.attempts()).toHaveLength(2);
    expect(run.attempts()[0]?.feedback).toBe('first miss');
    expect(types(events)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.feedback.recorded',
      'goal.retrying',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.succeeded',
    ]);
  });

  it('passes the prior attempts to the validator as a read-only history', async () => {
    const fixture = createFixture();
    const validator = scriptedValidator([failing(), PASS]);
    await runToEnd(goalOptions(fixture, validator, { retryPolicy: RETRY_ON_FAIL }));
    expect(validator.calls[0]?.history).toEqual([]);
    expect(validator.calls[1]?.history).toHaveLength(1);
    expect(validator.calls[1]?.attemptIndex).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC4: conversation policy
// ---------------------------------------------------------------------------

describe('conversation policy', () => {
  function textsOf(history: {
    ids: readonly string[];
    messages: Readonly<Record<string, { content: unknown } | undefined>>;
  }): string[] {
    return history.ids.map((id) => String(history.messages[id]?.content));
  }

  it('continue: retries run in the same session with the feedback appended', async () => {
    const fixture = createFixture();
    const forkSpy = spyOn(fixture.session, 'fork');
    const freshSpy = spyOn(fixture.session, 'startFreshAttempt');
    const validator = scriptedValidator([failing(true, 'FEEDBACK-ONE'), PASS]);
    const { run } = await runToEnd(goalOptions(fixture, validator, { retryPolicy: RETRY_ON_FAIL }));
    const sessionIds = run.attempts().map((attempt) => attempt.sessionId);
    expect(sessionIds).toEqual(['goal-session', 'goal-session']);
    const stored = await fixture.session.getSession();
    const transcript = textsOf(stored.conversationHistory);
    expect(transcript).toContain('achieve the goal');
    expect(transcript).toContain('FEEDBACK-ONE');
    expect(transcript.indexOf('FEEDBACK-ONE')).toBeGreaterThan(
      transcript.indexOf('achieve the goal'),
    );
    expect(forkSpy).not.toHaveBeenCalled();
    expect(freshSpy).not.toHaveBeenCalled();
  });

  it('fork-from-baseline: every retry forks from the goal-declared run, never the last attempt', async () => {
    const fixture = createFixture();
    await fixture.session.run('baseline turn').result();
    const forkSpy = spyOn(fixture.session, 'fork');
    const validator = scriptedValidator([failing(), failing(), PASS]);
    const { run } = await runToEnd(
      goalOptions(fixture, validator, {
        retryPolicy: RETRY_ON_FAIL,
        conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 },
      }),
    );
    expect(run.status()).toBe('succeeded');
    expect(forkSpy.mock.calls).toEqual([[{ throughRun: 0 }], [{ throughRun: 0 }]]);
    const ids = run.attempts().map((attempt) => attempt.sessionId);
    expect(ids[0]).toBe('goal-session');
    expect(new Set(ids).size).toBe(3);
  });

  it('fork-from-baseline: a baseline with no usable boundary ends the goal as a failure', async () => {
    const fixture = createFixture();
    const { result } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        conversationPolicy: { kind: 'fork-from-baseline', throughRun: 7 },
      }),
    );
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    expect(result.failureDetail).toContain('conversation policy');
  });

  it('fresh-from-artifact: the retry holds only the seeded messages, none of attempt one', async () => {
    const fixture = createFixture({
      resolveFreshAttemptSource: resolverFor(createFixtureSource()),
    });
    const artifact = await createFixtureArtifact();
    const validator = scriptedValidator([failing(true, 'LEAKED-FEEDBACK'), PASS]);
    const { run } = await runToEnd(
      goalOptions(fixture, validator, {
        retryPolicy: RETRY_ON_FAIL,
        instructions: 'You are the implementer.',
        conversationPolicy: { kind: 'fresh-from-artifact', artifact },
      }),
    );
    expect(run.status()).toBe('succeeded');
    const ids = run.attempts().map((attempt) => attempt.sessionId);
    expect(ids[1]).not.toBe(ids[0]);
    const stored = await fixture.store.load(ids[1] ?? '');
    const transcript = textsOf(stored?.conversationHistory ?? { ids: [], messages: {} });
    // Seeded system instructions and one artifact rendering, then this
    // attempt's own prompt and output. Attempt one's transcript and the
    // validator feedback appear nowhere.
    expect(transcript).toHaveLength(4);
    expect(transcript[0]).toBe('You are the implementer.');
    expect(transcript[1]).toContain('Fresh-attempt handoff');
    expect(transcript[2]).toBe('achieve the goal');
    expect(transcript.join('\n')).not.toContain('LEAKED-FEEDBACK');
    expect(fixture.session.id).not.toBe(ids[1]);
  });

  it('fresh-from-artifact: a rejected artifact is a terminal failure, not an unhandled rejection', async () => {
    const fixture = createFixture();
    const artifact = await createFixtureArtifact();
    const { result } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        instructions: 'You are the implementer.',
        conversationPolicy: { kind: 'fresh-from-artifact', artifact },
      }),
    );
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
  });
});

// ---------------------------------------------------------------------------
// AC5 and AC6: retry gating and terminal reasons
// ---------------------------------------------------------------------------

describe('retry policy', () => {
  it('never retries when no retry policy is declared', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const { result, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing(true)])),
    );
    expect(result).toMatchObject({
      status: 'failed',
      terminalReason: 'validator-fail-non-retryable',
    });
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(types(events)).not.toContain('goal.retrying');
  });

  it('terminates a retryable:false failure even when retrying is declared', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const { result } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing(false)]), { retryPolicy: RETRY_ON_FAIL }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      terminalReason: 'validator-fail-non-retryable',
    });
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  const unavailable: ValidatorOutcome = {
    kind: 'unavailable',
    reason: 'rate limited',
    error: { kind: 'execute', code: 'RATE_LIMITED', message: 'slow down' },
  };

  it.each([
    ['validator-unavailable', unavailable],
    ['validator-canceled', { kind: 'canceled' }],
  ] as const)('retries %p only when it is declared', async (reason, outcome) => {
    const declared = createFixture();
    const retried = await runToEnd(
      goalOptions(declared, scriptedValidator([outcome, PASS]), {
        retryPolicy: { retryOn: [reason] },
      }),
    );
    expect(retried.result.status).toBe('succeeded');
    expect(retried.run.attempts()).toHaveLength(2);

    const undeclared = createFixture();
    const stopped = await runToEnd(goalOptions(undeclared, scriptedValidator([outcome, PASS])));
    expect(stopped.result).toMatchObject({
      status: 'failed',
      terminalReason: 'validator-infrastructure-error',
    });
    expect(stopped.run.attempts()).toHaveLength(1);
  });

  it('resends the validator feedback after a fail, and the original prompt after a non-fail retry', async () => {
    const failed = createFixture();
    const failedSpy = spyOn(failed.session, 'run');
    await runToEnd(
      goalOptions(failed, scriptedValidator([failing(true, 'FIX THE THING'), PASS]), {
        retryPolicy: RETRY_ON_FAIL,
      }),
    );
    expect(failedSpy.mock.calls.map(([input]) => input)).toEqual([
      'achieve the goal',
      'FIX THE THING',
    ]);

    const unavailableFixture = createFixture();
    const unavailableSpy = spyOn(unavailableFixture.session, 'run');
    await runToEnd(
      goalOptions(unavailableFixture, scriptedValidator([unavailable, PASS]), {
        retryPolicy: { retryOn: ['validator-unavailable'] },
      }),
    );
    expect(unavailableSpy.mock.calls.map(([input]) => input)).toEqual([
      'achieve the goal',
      'achieve the goal',
    ]);
  });

  it('carries the validator error on a failed unavailable outcome', async () => {
    const fixture = createFixture();
    const { result } = await runToEnd(goalOptions(fixture, scriptedValidator([unavailable])));
    expect(result.validatorError).toEqual(unavailable.error);
    expect(result.failureDetail).toBe('rate limited');
  });

  it('never retries an indeterminate outcome, whatever the policy', async () => {
    const fixture = createFixture();
    const { result, run } = await runToEnd(
      goalOptions(fixture, scriptedValidator([{ kind: 'indeterminate', reason: 'flaky judge' }]), {
        retryPolicy: {
          retryOn: ['validator-fail-retryable', 'validator-unavailable', 'validator-canceled'],
        },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      terminalReason: 'validator-infrastructure-error',
      failureDetail: 'flaky judge',
    });
    expect(run.attempts()).toHaveLength(1);
  });

  it('never retries a validator error and attaches it to the result and the event', async () => {
    const fixture = createFixture();
    const error = { kind: 'execute', code: 'BOOM', message: 'validator crashed' } as const;
    const { result, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([{ kind: 'error', error }]), {
        retryPolicy: {
          retryOn: ['validator-fail-retryable', 'validator-unavailable', 'validator-canceled'],
        },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      terminalReason: 'validator-infrastructure-error',
      validatorError: error,
    });
    const failed = events.at(-1);
    expect(failed?.type).toBe('goal.failed');
    expect(failed && 'validatorError' in failed ? failed.validatorError : undefined).toEqual(error);
  });
});

describe('malformed validator output', () => {
  it.each([
    undefined,
    null,
    42,
    'pass',
    {},
    { kind: 'nope' },
    { kind: 'fail', evidence: [], retryable: true },
    { kind: 'fail', feedback: 7, evidence: [], retryable: true },
    { kind: 'fail', feedback: 'x', evidence: [] },
    { kind: 'pass', evidence: 'none' },
    { kind: 'error', error: { kind: 'unknown-kind', code: 'X', message: 'm' } },
    { kind: 'unavailable', error: { kind: 'execute', code: 'X', message: 'm' } },
    { kind: 'indeterminate' },
  ])('treats %p as an output error and never retries it', async (malformed) => {
    const fixture = createFixture();
    const { result, run } = await runToEnd(
      goalOptions(fixture, scriptedValidator([malformed]), {
        retryPolicy: {
          retryOn: ['validator-fail-retryable', 'validator-unavailable', 'validator-canceled'],
        },
      }),
    );
    expect(result).toMatchObject({
      status: 'failed',
      terminalReason: 'validator-infrastructure-error',
    });
    expect(result.validatorError?.kind).toBe('output');
    expect(run.attempts()).toHaveLength(1);
  });

  it.each([
    [
      'throws synchronously',
      () => {
        throw new Error('sync boom');
      },
    ],
    ['rejects', () => Promise.reject(new Error('async boom'))],
  ])('records a validator that %s as an execute error', async (_label, step) => {
    const fixture = createFixture();
    const { result, run } = await runToEnd(goalOptions(fixture, scriptedValidator([step])));
    expect(result.validatorError?.kind).toBe('execute');
    expect(result.validatorError?.message).toContain('boom');
    expect(run.attempts()).toHaveLength(1);
  });

  it('turns an elapsed validator timeout into a timeout error and clears its timer', async () => {
    const fixture = createFixture();
    const never = deferred<unknown>();
    const reached = deferred<void>();
    const validator = scriptedValidator([
      () => {
        reached.resolve();
        return never.promise;
      },
    ]);
    const run = startGoal(goalOptions(fixture, validator, { validatorTimeoutMs: 500 }));
    await reached.promise;
    await fixture.runtime.advance(500);
    const result = await run.result();
    expect(result.validatorError?.kind).toBe('timeout');
    expect(validator.signals[0]?.aborted).toBe(true);
    expect(fixture.runtime.pendingTimers()).toEqual([]);
    never.resolve(PASS);
    await yieldToPortableEventLoop();
    expect(run.status()).toBe('failed');
    expect(run.attempts()[0]?.validation?.outcome.kind).toBe('error');
  });

  it('clears the validator timeout on normal completion', async () => {
    const fixture = createFixture();
    await runToEnd(goalOptions(fixture, scriptedValidator([PASS]), { validatorTimeoutMs: 500 }));
    expect(fixture.runtime.pendingTimers()).toEqual([]);
  });
});

describe('terminal reasons', () => {
  it('exhausts on the attempt limit', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const { result, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        budget: { maximumAttempts: 2, maximumTotalSteps: 1000 },
      }),
    );
    expect(result).toMatchObject({ status: 'exhausted', terminalReason: 'attempt-limit-reached' });
    expect(runSpy).toHaveBeenCalledTimes(2);
    // goal.retrying promises a following attempt, so the exhausting attempt
    // never announces one.
    expect(types(events)).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.feedback.recorded',
      'goal.retrying',
      'goal.attempt.started',
      'goal.attempt.validated',
      'goal.feedback.recorded',
      'goal.exhausted',
    ]);
    expect(events.at(-1)).toMatchObject({ terminalReason: 'attempt-limit-reached' });
  });

  it.each([
    ['steps', { maximumTotalSteps: 1 }],
    ['tokens', { maximumTotalTokens: 10 }],
  ])(
    'exhausts on the aggregate %s bound, separately from the attempt limit',
    async (_name, bound) => {
      const fixture = createFixture();
      const runSpy = spyOn(fixture.session, 'run');
      const { result, events } = await runToEnd(
        goalOptions(fixture, scriptedValidator([failing()]), {
          retryPolicy: RETRY_ON_FAIL,
          budget: { maximumAttempts: 5, ...bound },
        }),
      );
      expect(result).toMatchObject({
        status: 'exhausted',
        terminalReason: 'aggregate-budget-exceeded',
      });
      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(types(events)).toEqual([
        'goal.started',
        'goal.attempt.started',
        'goal.attempt.validated',
        'goal.feedback.recorded',
        'goal.exhausted',
      ]);
      expect(events.at(-1)).toMatchObject({ terminalReason: 'aggregate-budget-exceeded' });
    },
  );

  it('exhausts on the aggregate cost bound when the session estimates cost', async () => {
    const fixture = createFixture({ generate: instantGenerate });
    const attemptCost = { totalCost: 0.6 };
    const original = fixture.session.run.bind(fixture.session);
    spyOn(fixture.session, 'run').mockImplementation((input) => {
      const agentRun = original(input);
      const result = agentRun.result.bind(agentRun);
      agentRun.result = async () => ({ ...(await result()), costEstimate: attemptCost as never });
      return agentRun;
    });
    const { result, run } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        budget: { maximumAttempts: 5, maximumTotalCostUsd: 1 },
      }),
    );
    expect(result).toMatchObject({
      status: 'exhausted',
      terminalReason: 'aggregate-budget-exceeded',
    });
    expect(run.attempts()).toHaveLength(2);
    expect(run.usage().costUsd).toBeCloseTo(1.2);
  });

  it('fails the attempt when a cost bound is set but no cost estimate is reported', async () => {
    const fixture = createFixture();
    const validator = scriptedValidator([PASS]);
    const { result } = await runToEnd(
      goalOptions(fixture, validator, { budget: { maximumAttempts: 2, maximumTotalCostUsd: 1 } }),
    );
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    expect(result.failureDetail).toContain('costEstimate');
    expect(validator.calls).toHaveLength(0);
  });

  it('exhausts on the aggregate duration bound mid-attempt', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const validator = scriptedValidator([PASS]);
    const run = startGoal(
      goalOptions(fixture, validator, {
        budget: { maximumAttempts: 3, maximumTotalDurationMs: 1000 },
      }),
    );
    await reached.promise;
    await fixture.runtime.advance(1000);
    const result = await run.result();
    expect(result).toMatchObject({
      status: 'exhausted',
      terminalReason: 'aggregate-budget-exceeded',
    });
    expect(result.usage.durationMs).toBe(1000);
    expect(validator.calls).toHaveLength(0);
    expect(run.attempts()[0]?.status).toBe('aborted');
  });

  it('exhausts when the duration bound elapses before the first attempt opens', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const run = startGoal(
      goalOptions(fixture, scriptedValidator([PASS]), {
        budget: { maximumAttempts: 3, maximumTotalDurationMs: 1000 },
      }),
    );
    expect(run.status()).toBe('pending');
    await fixture.runtime.advance(1000);
    const result = await run.result();
    expect(result).toMatchObject({
      status: 'exhausted',
      terminalReason: 'aggregate-budget-exceeded',
    });
    expect(run.attempts()).toEqual([]);
    expect(runSpy).not.toHaveBeenCalled();
    expect(types(await collect(run))).toEqual(['goal.started', 'goal.exhausted']);
  });

  it('exhausts between attempts once the duration is spent, without relying on the timer', async () => {
    const fixture = createFixture();
    const inertTimers = {
      ...fixture.runtime.timers,
      setTimeout: () => ({}),
      clearTimeout: () => {},
    };
    const runtime = { ...fixture.runtime, timers: inertTimers } as never;
    const validator = scriptedValidator([
      async () => {
        await fixture.runtime.advance(1000);
        return failing();
      },
    ]);
    const { result, run } = await runToEnd(
      goalOptions(fixture, validator, {
        runtime,
        retryPolicy: RETRY_ON_FAIL,
        budget: { maximumAttempts: 3, maximumTotalDurationMs: 1000 },
      }),
    );
    expect(result).toMatchObject({
      status: 'exhausted',
      terminalReason: 'aggregate-budget-exceeded',
    });
    expect(run.attempts()).toHaveLength(1);
  });

  it('clears the duration timer once the goal is terminal', async () => {
    const fixture = createFixture();
    await runToEnd(
      goalOptions(fixture, scriptedValidator([PASS]), {
        budget: { maximumAttempts: 1, maximumTotalDurationMs: 60_000 },
      }),
    );
    expect(fixture.runtime.pendingTimers()).toEqual([]);
  });

  it('reports the aggregate budget first when both limits are crossed on one attempt', async () => {
    const fixture = createFixture();
    const { result } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        budget: { maximumAttempts: 1, maximumTotalSteps: 1 },
      }),
    );
    expect(result.terminalReason).toBe('aggregate-budget-exceeded');
  });

  it('lets a validator pass win over an already-crossed budget', async () => {
    const fixture = createFixture();
    const { result } = await runToEnd(
      goalOptions(fixture, scriptedValidator([PASS]), {
        budget: { maximumAttempts: 1, maximumTotalSteps: 1 },
      }),
    );
    expect(result.terminalReason).toBe('validator-passed');
  });

  it('fails as unsupported-validation when determinism is required and not supplied', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const { result, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([PASS], { determinism: 'stochastic' }), {
        requireDeterministicValidation: true,
      }),
    );
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'unsupported-validation' });
    expect(types(events)).toEqual(['goal.started', 'goal.failed']);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('accepts a deterministic validator when determinism is required', async () => {
    const fixture = createFixture();
    const { result } = await runToEnd(
      goalOptions(fixture, scriptedValidator([PASS], { determinism: 'deterministic' }), {
        requireDeterministicValidation: true,
      }),
    );
    expect(result.status).toBe('succeeded');
  });
});

describe('state machine', () => {
  const STATUSES: readonly GoalRunStatus[] = [
    'pending',
    'running',
    'evaluating',
    'retrying',
    'succeeded',
    'exhausted',
    'failed',
    'canceled',
  ];
  const TERMINAL = ['succeeded', 'exhausted', 'failed', 'canceled'];
  const CONTRACT_EDGES = new Set([
    'pending>running',
    'running>evaluating',
    'evaluating>succeeded',
    'evaluating>retrying',
    'retrying>running',
    'evaluating>exhausted',
    'retrying>exhausted',
  ]);

  it('has no outgoing edge from a terminal status and every contract edge', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const allowed = canTransitionGoalRun(from, to);
        if (TERMINAL.includes(from)) expect(allowed).toBe(false);
        if (CONTRACT_EDGES.has(`${from}>${to}`)) expect(allowed).toBe(true);
        if (!TERMINAL.includes(from) && to === 'canceled') expect(allowed).toBe(true);
        if (to === 'pending') expect(allowed).toBe(false);
      }
    }
    expect(GOAL_RUN_TRANSITIONS.succeeded).toEqual([]);
  });

  const TERMINAL_SCENARIOS: readonly [GoalRunStatus, GoalRunTerminalReason][] = [
    ['succeeded', 'validator-passed'],
    ['exhausted', 'attempt-limit-reached'],
    ['failed', 'validator-fail-non-retryable'],
    ['canceled', 'goal-canceled'],
  ];

  async function reachTerminal(status: GoalRunStatus) {
    const fixture = createFixture();
    if (status === 'succeeded')
      return { fixture, run: startGoal(goalOptions(fixture, scriptedValidator([PASS]))) };
    if (status === 'exhausted') {
      return {
        fixture,
        run: startGoal(
          goalOptions(fixture, scriptedValidator([failing()]), {
            retryPolicy: RETRY_ON_FAIL,
            budget: { maximumAttempts: 1, maximumTotalSteps: 1000 },
          }),
        ),
      };
    }
    if (status === 'failed') {
      return { fixture, run: startGoal(goalOptions(fixture, scriptedValidator([failing(false)]))) };
    }
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    run.abort('stop');
    return { fixture, run };
  }

  it.each(TERMINAL_SCENARIOS)(
    'leaves a %s goal untouched by abort, abortAttempt, dispose, and later work',
    async (status, reason) => {
      const { fixture, run } = await reachTerminal(status);
      const result = await run.result();
      expect(run.status()).toBe(status);
      const before = {
        reason: run.terminalReason(),
        attempts: run.attempts(),
        events: await collect(run),
      };
      expect(before.reason).toBe(reason);

      run.abort('late');
      run.abortAttempt({}, 'late');
      run[Symbol.dispose]();
      await fixture.runtime.advance(10_000);
      await yieldToPortableEventLoop();

      expect(run.status()).toBe(status);
      expect(run.terminalReason()).toBe(reason);
      expect(run.attempts()).toEqual(before.attempts);
      const eventsAfter = await collect(run);
      expect(eventsAfter).toHaveLength(before.events.length);
      expect(await run.result()).toBe(result);
    },
  );
});

// ---------------------------------------------------------------------------
// AC7: inner finish reasons
// ---------------------------------------------------------------------------

describe('inner run finish reasons', () => {
  it('skips validation and fails the attempt when the inner run does not stop on its condition', async () => {
    const toolLoop: GenerateFunction = async () => ({
      content: 'again',
      toolCalls: [{ id: 'call-1', name: 'loop', arguments: {} }],
    });
    const looping = createFixture({
      generate: toolLoop,
      maximumSteps: 1,
      toolbox: createToolbox([
        createTool({
          name: 'loop',
          description: 'loops',
          input: z.object({}),
          execute: async () => 'ok',
        }),
      ]) as unknown as RunOptions['toolbox'],
    });
    const validator = scriptedValidator([PASS]);
    const { result, run, events } = await runToEnd(goalOptions(looping, validator));
    expect(run.attempts()[0]).toMatchObject({ finishReason: 'maximum-steps', status: 'failed' });
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    // The failed attempt still counts against the aggregate budget.
    expect(result.usage.steps).toBeGreaterThan(0);
    expect(result.usage.steps).toBe(run.attempts()[0]?.usage.steps ?? -1);
    expect(validator.calls).toHaveLength(0);
    expect(types(events)).not.toContain('goal.attempt.validated');
  });

  it('hands off to the validator only on a stop condition', async () => {
    const fixture = createFixture();
    const validator = scriptedValidator([PASS]);
    await runToEnd(goalOptions(fixture, validator));
    expect(validator.calls).toHaveLength(1);
    expect(validator.calls[0]?.result.finishReason).toBe('stop-condition');
  });

  it('surfaces a per-attempt budget as the inner run own budget-exceeded finish', async () => {
    const fixture = createFixture({
      generate: async () => {
        throw new BudgetExceededError('per-attempt budget spent');
      },
    });
    const validator = scriptedValidator([PASS]);
    const { result, run } = await runToEnd(goalOptions(fixture, validator));
    expect(run.attempts()[0]).toMatchObject({ finishReason: 'budget-exceeded', status: 'failed' });
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    expect(result.failureDetail).toContain('budget-exceeded');
    expect(validator.calls).toHaveLength(0);
  });

  it('adds no per-attempt budget field to the goal budget', async () => {
    const fixture = createFixture();
    const { run } = await runToEnd(goalOptions(fixture, scriptedValidator([PASS])));
    expect('maximumSteps' in (run.budget() as object)).toBe(false);
    expect(Object.keys(run.budget()).toSorted()).toEqual(['maximumAttempts', 'maximumTotalSteps']);
  });

  it('treats an inner run that cannot start as a failed attempt', async () => {
    const fixture = createFixture();
    spyOn(fixture.session, 'run').mockImplementation(() => {
      throw new Error('no run options');
    });
    const { result } = await runToEnd(goalOptions(fixture, scriptedValidator([PASS])));
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    expect(result.failureDetail).toContain('no run options');
  });
});

// ---------------------------------------------------------------------------
// AC8: abort
// ---------------------------------------------------------------------------

describe('abort', () => {
  it('cancels mid-generation without ever calling the validator', async () => {
    const reached = deferred<void>();
    const blocking = createBlockingGenerate(reached);
    let generationSignal: AbortSignal | undefined;
    const fixture = createFixture({
      generate: (context) => {
        generationSignal = context.signal;
        return blocking(context);
      },
    });
    const validator = scriptedValidator([PASS]);
    const run = startGoal(goalOptions(fixture, validator));
    await reached.promise;
    expect(generationSignal?.aborted).toBe(false);
    run.abort('operator stop');
    expect(generationSignal?.aborted).toBe(true);
    const result = await run.result();
    expect(result).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
    expect(validator.calls).toHaveLength(0);
    expect(run.attempts()[0]?.status).toBe('aborted');
    expect(types(await collect(run))).toEqual([
      'goal.started',
      'goal.attempt.started',
      'goal.cancellation-requested',
      'goal.canceled',
    ]);
  });

  it('opens the stream with goal.started even when canceled before any attempt', async () => {
    const fixture = createFixture();
    const run = startGoal(
      goalOptions(fixture, scriptedValidator([PASS]), { signal: AbortSignal.abort('early') }),
    );
    expect(types(await collect(run))).toEqual([
      'goal.started',
      'goal.cancellation-requested',
      'goal.canceled',
    ]);
  });

  it('opens the stream with goal.started when aborted before the first attempt opens', async () => {
    const fixture = createFixture();
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    expect(run.status()).toBe('pending');
    run.abort('right away');
    expect(types(await collect(run))).toEqual([
      'goal.started',
      'goal.cancellation-requested',
      'goal.canceled',
    ]);
  });

  it('cancels a tool that is awaiting its abort signal', async () => {
    const reached = deferred<void>();
    const toolAborted = deferred<boolean>();
    const waiting = createTool({
      name: 'wait',
      description: 'waits for abort',
      input: z.object({}),
      execute: async (_input: unknown, context: { signal?: AbortSignal }) => {
        reached.resolve();
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) resolve();
          context.signal?.addEventListener('abort', () => resolve());
        });
        toolAborted.resolve(context.signal?.aborted === true);
        return 'stopped';
      },
    });
    const fixture = createFixture({
      generate: async () => ({
        content: '',
        toolCalls: [{ id: 'c1', name: 'wait', arguments: {} }],
      }),
      toolbox: createToolbox([waiting]) as unknown as RunOptions['toolbox'],
    });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    await reached.promise;
    run.abort();
    expect(await statusOf(run)).toBe('canceled');
    expect(await toolAborted.promise).toBe(true);
  });

  it('cancels mid-validation and ignores a validator that ignores its signal and passes late', async () => {
    const fixture = createFixture();
    const reached = deferred<void>();
    const release = deferred<ValidatorOutcome>();
    const validator = scriptedValidator([
      () => {
        reached.resolve();
        return release.promise;
      },
    ]);
    const run = startGoal(goalOptions(fixture, validator));
    const events = collect(run);
    await reached.promise;
    run.abort('stop');
    const result = await run.result();
    expect(validator.signals[0]?.aborted).toBe(true);
    expect(result.status).toBe('canceled');
    expect(run.attempts()[0]?.status).toBe('aborted');

    release.resolve(PASS);
    await yieldToPortableEventLoop();
    expect(run.status()).toBe('canceled');
    expect(run.attempts()[0]?.validation).toBeUndefined();
    const seen = types(await events);
    expect(seen).not.toContain('goal.attempt.validated');
    expect(seen).not.toContain('goal.succeeded');
  });

  it('cancels during the retrying window and starts no further attempt', async () => {
    const fixture = createFixture();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const original = fixture.session.fork.bind(fixture.session);
    await fixture.session.run('baseline').result();
    spyOn(fixture.session, 'fork').mockImplementation(async (forkOptions) => {
      entered.resolve();
      await gate.promise;
      return original(forkOptions);
    });
    const runSpy = spyOn(fixture.session, 'run');
    const run = startGoal(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 },
      }),
    );
    const events = collect(run);
    await entered.promise;
    expect(run.status()).toBe('retrying');
    run.abort('stop');
    expect(await statusOf(run)).toBe('canceled');
    gate.resolve();
    await yieldToPortableEventLoop();
    expect(runSpy).toHaveBeenCalledTimes(1);
    const seen = types(await events);
    expect(seen.filter((type) => type === 'goal.attempt.started')).toHaveLength(1);
    expect(seen).toContain('goal.retrying');
  });

  it('honors an outer signal aborted during the run, with one cancellation request', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const outer = new AbortController();
    const run = startGoal(
      goalOptions(fixture, scriptedValidator([PASS]), { signal: outer.signal }),
    );
    await reached.promise;
    outer.abort('outer');
    run.abort('inner');
    expect(await statusOf(run)).toBe('canceled');
    const seen = types(await collect(run));
    expect(seen.filter((type) => type === 'goal.cancellation-requested')).toHaveLength(1);
    expect(seen.filter((type) => type === 'goal.canceled')).toHaveLength(1);
  });

  it('cancels without running an attempt when the outer signal is already aborted', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const run = startGoal(
      goalOptions(fixture, scriptedValidator([PASS]), { signal: AbortSignal.abort('early') }),
    );
    expect(await statusOf(run)).toBe('canceled');
    expect(runSpy).not.toHaveBeenCalled();
    expect(run.attempts()).toEqual([]);
  });

  it('is idempotent for the whole goal', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS]), { principal: 'steve' }));
    const events = collect(run);
    await reached.promise;
    run.abort('one');
    run.abort('two');
    await run.result();
    const seen = await events;
    expect(seen.filter((event) => event.type === 'goal.cancellation-requested')).toHaveLength(1);
    expect(seen.filter((event) => event.type === 'goal.canceled')).toHaveLength(1);
    const request = seen.find((event) => event.type === 'goal.cancellation-requested');
    expect(request && 'principal' in request ? request.principal : undefined).toBe('steve');
  });

  it('aborts a running attempt only when the target names it, and records it aborted', async () => {
    const reached = deferred<void>();
    const blocking = createBlockingGenerate(reached);
    let generationSignal: AbortSignal | undefined;
    const fixture = createFixture({
      generate: (context) => {
        generationSignal = context.signal;
        return blocking(context);
      },
    });
    const validator = scriptedValidator([PASS]);
    const run = startGoal(goalOptions(fixture, validator, { retryPolicy: RETRY_ON_FAIL }));
    await reached.promise;
    const attemptId = run.currentAttempt()?.attemptId;
    expect(attemptId).toBeDefined();

    run.abortAttempt({ attemptId: 'not-the-current-attempt' }, 'wrong target');
    await yieldToPortableEventLoop();
    expect(generationSignal?.aborted).toBe(false);
    expect(run.status()).toBe('running');

    run.abortAttempt({ attemptId }, 'one attempt');
    run.abortAttempt({ attemptId }, 'again');
    const result = await run.result();
    expect(generationSignal?.aborted).toBe(true);
    // A mid-run abort is not a stop condition: the attempt ends aborted, is
    // never validated, and (COR-638) goes straight to the attempt's failure.
    expect(run.attempts()[0]).toMatchObject({ finishReason: 'aborted', status: 'aborted' });
    expect(result).toMatchObject({ status: 'failed', terminalReason: 'attempt-run-failed' });
    expect(result.failureDetail).toContain('abortAttempt');
    expect(validator.calls).toHaveLength(0);
  });

  it.each([
    ['declared', { retryOn: ['validator-canceled'] } as const, 'succeeded'],
    ['not declared', undefined, 'failed'],
  ] as const)(
    'aborts one attempt mid-validation: the outcome is canceled and retry is %s',
    async (_label, retryPolicy, expected) => {
      const fixture = createFixture();
      const reached = deferred<void>();
      const validator = scriptedValidator([
        (_input: ValidatorInput, signal: AbortSignal) => {
          reached.resolve();
          return new Promise<never>(() => signal.addEventListener('abort', () => {}));
        },
        PASS,
      ]);
      const run = startGoal(goalOptions(fixture, validator, { retryPolicy }));
      await reached.promise;
      run.abortAttempt();
      const result = await run.result();
      expect(validator.signals[0]?.aborted).toBe(true);
      expect(result.status).toBe(expected);
      expect(run.attempts()[0]?.validation?.outcome).toEqual({ kind: 'canceled' });
    },
  );

  it('ignores a validator result that lands after an attempt abort already moved the goal on', async () => {
    const fixture = createFixture();
    const reached = deferred<void>();
    const late = deferred<ValidatorOutcome>();
    const validator = scriptedValidator([
      () => {
        reached.resolve();
        return late.promise;
      },
      PASS,
    ]);
    const run = startGoal(
      goalOptions(fixture, validator, { retryPolicy: { retryOn: ['validator-canceled'] } }),
    );
    const events = collect(run);
    await reached.promise;
    run.abortAttempt();
    const result = await run.result();
    expect(result.status).toBe('succeeded');
    const usageAfter = run.usage();
    const attemptsAfter = run.attempts();
    // A non-retryable failure landing late would end the goal if it were applied.
    late.resolve(failing(false));
    await yieldToPortableEventLoop();
    expect(run.status()).toBe('succeeded');
    expect(run.usage()).toEqual(usageAfter);
    expect(run.attempts()).toEqual(attemptsAfter);
    expect(run.attempts()[0]?.validation?.outcome).toEqual({ kind: 'canceled' });
    expect(run.attempts()[0]?.feedback).toBeUndefined();
    const seen = await events;
    expect(seen.filter((event) => event.type === 'goal.attempt.validated')).toHaveLength(2);
    expect(types(seen)).not.toContain('goal.feedback.recorded');
  });
});

// ---------------------------------------------------------------------------
// AC9: events
// ---------------------------------------------------------------------------

describe('events', () => {
  it('correlates every event to the goal and attempt-scoped ones to their attempt', async () => {
    const fixture = createFixture();
    const { run, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing(), PASS]), {
        retryPolicy: RETRY_ON_FAIL,
        goalRunId: 'goal-correlated',
      }),
    );
    expect(
      events.every((event) => 'goalRunId' in event && event.goalRunId === 'goal-correlated'),
    ).toBe(true);
    const attemptIds = run.attempts().map((attempt) => attempt.attemptId);
    const started = events.filter(
      (event): event is GoalAttemptStartedEvent => event instanceof GoalAttemptStartedEvent,
    );
    expect(started.map((event) => event.attemptId)).toEqual(attemptIds);
    expect(started.map((event) => event.runId)).toEqual(['goal-session:0', 'goal-session:1']);
    const validated = events.filter(
      (event): event is GoalAttemptValidatedEvent => event instanceof GoalAttemptValidatedEvent,
    );
    expect(validated.map((event) => [event.attemptId, event.outcomeKind])).toEqual([
      [attemptIds[0] ?? '', 'fail'],
      [attemptIds[1] ?? '', 'pass'],
    ]);
    const retrying = events.find((event) => event.type === 'goal.retrying');
    expect(retrying).toMatchObject({ priorAttemptId: attemptIds[0], nextAttemptId: attemptIds[1] });
  });

  it('never inlines evidence or raw feedback, carrying only a digest', async () => {
    const fixture = createFixture();
    const secretEvidence = {
      kind: 'fail',
      feedback: 'FEEDBACK-SENTINEL',
      retryable: false,
      evidence: [{ source: 'unit', detail: 'SECRET-SENTINEL' }],
    };
    const { run, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([secretEvidence])),
    );
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('SECRET-SENTINEL');
    expect(serialized).not.toContain('FEEDBACK-SENTINEL');
    const recorded = events.find(
      (event): event is GoalFeedbackRecordedEvent => event instanceof GoalFeedbackRecordedEvent,
    );
    expect(recorded?.feedbackDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(run.attempts())).toContain('SECRET-SENTINEL');
    expect(run.attempts()[0]?.feedback).toBe('FEEDBACK-SENTINEL');
  });

  it('carries the terminal reason and the exact feedback digest from a real run', async () => {
    const fixture = createFixture();
    const { events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing(false, 'try harder')])),
    );
    const recorded = events.find(
      (event): event is GoalFeedbackRecordedEvent => event instanceof GoalFeedbackRecordedEvent,
    );
    expect(recorded?.feedbackDigest).toBe(sha256HexSync('try harder'));
    expect(events.at(-1)).toMatchObject({
      type: 'goal.failed',
      terminalReason: 'validator-fail-non-retryable',
    });
  });

  it('reports the real run id of the wrapped run even when another run reserves first', async () => {
    const fixture = createFixture();
    const other = fixture.session.run('concurrent work');
    const { run, events } = await runToEnd(goalOptions(fixture, scriptedValidator([PASS])));
    await other.result();
    const started = events.find(
      (event): event is GoalAttemptStartedEvent => event instanceof GoalAttemptStartedEvent,
    );
    expect(started?.runId).toBeDefined();
    expect(started?.runId).toBe(run.attempts()[0]?.runId);
    const stored = await fixture.session.getSession();
    expect(stored.runs.map((reference) => reference.runId)).toContain(started?.runId ?? '');
  });

  it('keeps a validator error cause off the live event while the result retains it', async () => {
    const fixture = createFixture();
    const error = {
      kind: 'execute',
      code: 'BOOM',
      message: 'validator crashed',
      cause: { secret: 'CAUSE-SENTINEL' },
    } as const;
    const { result, events } = await runToEnd(
      goalOptions(fixture, scriptedValidator([{ kind: 'error', error }])),
    );
    expect(JSON.stringify(events)).not.toContain('CAUSE-SENTINEL');
    const failed = events.at(-1);
    expect(failed && 'validatorError' in failed ? failed.validatorError : undefined).toEqual({
      kind: 'execute',
      code: 'BOOM',
      message: 'validator crashed',
    });
    expect(result.validatorError?.cause).toEqual({ secret: 'CAUSE-SENTINEL' });
  });

  it('dispatches attempt.validated after leaving evaluating and before the terminal event', async () => {
    const fixture = createFixture();
    const observed: { type: string; status: GoalRunStatus }[] = [];
    let current: GoalRun | undefined;
    const emitter = {
      dispatchEvent: (event: Event) => {
        observed.push({ type: event.type, status: current?.status() ?? 'pending' });
        return true;
      },
    };
    current = startGoal(
      goalOptions(fixture, scriptedValidator([PASS]), { emitter: emitter as never }),
    );
    await current.result();
    const validated = observed.find((entry) => entry.type === 'goal.attempt.validated');
    expect(validated?.status).not.toBe('evaluating');
    expect(observed.at(-1)?.type).toBe('goal.succeeded');
    expect(observed.map((entry) => entry.type).indexOf('goal.attempt.validated')).toBeLessThan(
      observed.length - 1,
    );
  });
});

// ---------------------------------------------------------------------------
// AC10: cleanup
// ---------------------------------------------------------------------------

describe('closed()', () => {
  const TERMINALS: readonly [string, () => Promise<GoalRun>][] = [
    ['succeeded', async () => startGoal(goalOptions(createFixture(), scriptedValidator([PASS])))],
    [
      'exhausted',
      async () =>
        startGoal(
          goalOptions(createFixture(), scriptedValidator([failing()]), {
            retryPolicy: RETRY_ON_FAIL,
            budget: { maximumAttempts: 1, maximumTotalSteps: 1000 },
          }),
        ),
    ],
    [
      'failed by a validator error',
      async () =>
        startGoal(
          goalOptions(
            createFixture(),
            scriptedValidator([
              { kind: 'error', error: { kind: 'execute', code: 'X', message: 'm' } },
            ]),
          ),
        ),
    ],
    [
      'failed as unsupported',
      async () =>
        startGoal(
          goalOptions(createFixture(), scriptedValidator([PASS]), {
            requireDeterministicValidation: true,
          }),
        ),
    ],
    [
      'canceled',
      async () => {
        const run = startGoal(goalOptions(createFixture(), scriptedValidator([PASS])));
        run.abort();
        return run;
      },
    ],
  ];

  it.each(TERMINALS)(
    'settles a cleanup acknowledgement after %s, idempotently',
    async (_label, start) => {
      const run = await start();
      await run.result();
      const first = await run.closed();
      expect(first).toEqual({ status: 'not-required' });
      expect(await run.closed()).toBe(first);
      expect(await run.closed()).toEqual(first);
    },
  );

  it('waits for a non-terminal goal and then acknowledges the inner run', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    await reached.promise;
    let settled = false;
    const closing = run.closed().then((acknowledgement) => {
      settled = true;
      return acknowledgement;
    });
    await yieldToPortableEventLoop();
    expect(settled).toBe(false);
    run.abort();
    const acknowledgement = await closing;
    expect(settled).toBe(true);
    expect(acknowledgement.status).not.toBe('unresolved');
  });

  it('stays pending when called before the first inner run exists', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    let settled = false;
    const closing = run.closed().then(() => {
      settled = true;
    });
    await yieldToPortableEventLoop();
    expect(settled).toBe(false);
    run.abort();
    await closing;
  });

  it.each([
    [[{ status: 'completed' }, { status: 'not-required' }], { status: 'completed' }],
    [[{ status: 'not-required' }, { status: 'not-required' }], { status: 'not-required' }],
    [
      [{ status: 'completed' }, { status: 'unresolved', reason: 'unknown-effect' }],
      { status: 'unresolved', reason: 'unknown-effect' },
    ],
    [
      [
        { status: 'unresolved', reason: 'unknown-effect' },
        { status: 'failed', error: 'x' },
      ],
      { status: 'unresolved', reason: 'unknown-effect' },
    ],
    [[{ status: 'completed' }, { status: 'failed', error: 'x' }], { status: 'failed', error: 'x' }],
  ] as const)(
    'aggregates the inner acknowledgements %j into %j',
    async (acknowledgements, expected) => {
      const fixture = createFixture();
      const original = fixture.session.run.bind(fixture.session);
      let next = 0;
      spyOn(fixture.session, 'run').mockImplementation((input) => {
        const agentRun = original(input);
        const acknowledgement = acknowledgements[next++];
        agentRun.closed = async () => acknowledgement as never;
        return agentRun;
      });
      const run = startGoal(
        goalOptions(fixture, scriptedValidator([failing(), PASS]), { retryPolicy: RETRY_ON_FAIL }),
      );
      await run.result();
      expect(run.attempts()).toHaveLength(2);
      expect(await run.closed()).toEqual(expected);
    },
  );

  it('reports a rejecting inner closed() as a failed acknowledgement', async () => {
    const fixture = createFixture();
    const original = fixture.session.run.bind(fixture.session);
    spyOn(fixture.session, 'run').mockImplementation((input) => {
      const agentRun = original(input);
      agentRun.closed = () => Promise.reject(new Error('cleanup exploded'));
      return agentRun;
    });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    await run.result();
    const acknowledgement = await run.closed();
    expect(acknowledgement.status).toBe('failed');
  });

  it('bounds only the calling wait with its own signal', async () => {
    const reached = deferred<void>();
    const fixture = createFixture({ generate: createBlockingGenerate(reached) });
    const run = startGoal(goalOptions(fixture, scriptedValidator([PASS])));
    await reached.promise;
    const bounded = await run.closed({ signal: AbortSignal.abort() });
    expect(bounded).toEqual({ status: 'unresolved', reason: 'timed-out' });
    run.abort();
    const unbounded = await run.closed();
    expect(unbounded.status).not.toBe('unresolved');
  });

  it('starts no further attempt after a terminal state', async () => {
    const fixture = createFixture();
    const runSpy = spyOn(fixture.session, 'run');
    const { run } = await runToEnd(
      goalOptions(fixture, scriptedValidator([failing()]), {
        retryPolicy: RETRY_ON_FAIL,
        budget: { maximumAttempts: 1, maximumTotalSteps: 1000 },
      }),
    );
    await fixture.runtime.advance(60_000);
    await yieldToPortableEventLoop();
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(run.status()).toBe('exhausted');
  });
});
