/**
 * COR-851 — the goal record decoder refuses a record whose status, attempts, and
 * active work contradict each other, and the store can never write one.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  createGoalState,
  type DurableGoalAttempt,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  goalSessionId,
  type GoalState,
  goalTransitionId,
  isGoalState,
} from './goal-state';
import { createGoalStore, type GoalStore, type GoalTransitionRequest } from './goal-store';

const GOAL = 'goal-consistency';
const VALIDATOR = { name: 'tests@bureau', version: '1.0.0' };
const STARTED = '2026-10-02T00:00:05.000Z';
let tick = 0;
const at = (): string => `2026-10-02T00:01:${String(10 + tick++).padStart(2, '0')}.000Z`;

function attempt(index: number, overrides: Partial<DurableGoalAttempt> = {}): DurableGoalAttempt {
  return {
    attemptId: goalAttemptId(GOAL, index),
    attemptIndex: index,
    runId: goalAttemptRunId(GOAL, index),
    sessionId: goalSessionId(GOAL, 0),
    startedAt: STARTED,
    usage: { steps: 0, tokens: 0 },
    status: 'running',
    ...overrides,
  };
}

const attemptWork = (index: number) =>
  ({
    kind: 'attempt',
    attemptId: goalAttemptId(GOAL, index),
    runId: goalAttemptRunId(GOAL, index),
    startedAt: STARTED,
  }) as const;

const validationWork = (index: number) =>
  ({
    kind: 'validation',
    attemptId: goalAttemptId(GOAL, index),
    validator: VALIDATOR,
    startedAt: STARTED,
  }) as const;

let sequence = 0;
async function send(
  store: GoalStore,
  to: GoalTransitionRequest['to'],
  extra: Partial<GoalTransitionRequest> = {},
): Promise<GoalState> {
  sequence += 1;
  const result = await store.applyTransition({
    goalRunId: GOAL,
    seq: sequence,
    transitionId: goalTransitionId(GOAL, sequence),
    to,
    at: at(),
    cause: `to-${to}`,
    ...extra,
  });
  if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  return result.record;
}

/** One real record of every status, each built through the store. */
async function records(): Promise<Record<string, GoalState>> {
  sequence = 0;
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  const pending = createGoalState({
    goalRunId: GOAL,
    identity: { name: 'goal', version: '1' },
    objective: { agentName: 'builder', prompt: 'Make the tests pass.' },
    validator: VALIDATOR,
    conversationPolicy: { kind: 'continue' },
    bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
    now: '2026-10-02T00:00:00.000Z',
  });
  await store.create(pending);
  const running = await send(store, 'running', { attempt: attempt(0), active: attemptWork(0) });
  const evaluating = await send(store, 'evaluating', {
    attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
    active: validationWork(0),
  });
  const retrying = await send(store, 'retrying', {
    attempt: attempt(0, { status: 'failed', finishReason: 'stop-condition' }),
    active: null,
  });
  await send(store, 'running', { attempt: attempt(1), active: attemptWork(1) });
  await send(store, 'evaluating', {
    attempt: attempt(1, { status: 'evaluating', finishReason: 'stop-condition' }),
    active: validationWork(1),
  });
  const succeeded = await send(store, 'succeeded', {
    attempt: attempt(1, { status: 'passed', finishReason: 'stop-condition' }),
    active: null,
    terminalReason: 'validator-passed',
  });
  return { pending, running, evaluating, retrying, succeeded };
}

type Mutation = (record: Record<string, unknown>) => void;

const attemptsOf = (record: Record<string, unknown>) =>
  record['attempts'] as Array<Record<string, unknown>>;

const contradictions: Array<[string, string, Mutation]> = [
  ['pending', 'active work', (r) => (r['active'] = attemptWork(0))],
  ['pending', 'an attempt', (r) => (r['attempts'] = [attempt(0, { status: 'failed' })])],
  ['running', 'no attempts and no active work', (r) => (r['attempts'] = [])],
  ['running', 'no active work', (r) => delete r['active']],
  ['running', 'validation work', (r) => (r['active'] = validationWork(0))],
  ['running', 'work for another attempt', (r) => (r['active'] = attemptWork(1))],
  [
    'running',
    'work for another run',
    (r) => (r['active'] = { ...attemptWork(0), runId: 'goal-other-a0' }),
  ],
  [
    'running',
    'a last attempt that is not running',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'failed'),
  ],
  ['evaluating', 'no active work', (r) => delete r['active']],
  ['evaluating', 'attempt work', (r) => (r['active'] = attemptWork(0))],
  ['evaluating', 'work for another attempt', (r) => (r['active'] = validationWork(1))],
  [
    'evaluating',
    'a last attempt that is still running',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'running'),
  ],
  ['evaluating', 'no attempts', (r) => (r['attempts'] = [])],
  ['retrying', 'active work', (r) => (r['active'] = attemptWork(0))],
  ['retrying', 'no attempts', (r) => (r['attempts'] = [])],
  [
    'retrying',
    'a last attempt still in flight',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'running'),
  ],
  ['succeeded', 'active work', (r) => (r['active'] = validationWork(1))],
  [
    'succeeded',
    'a last attempt still in flight',
    (r) => ((attemptsOf(r)[1] as Record<string, unknown>)['status'] = 'evaluating'),
  ],
  [
    'succeeded',
    'an earlier attempt still in flight',
    (r) => ((attemptsOf(r)[0] as Record<string, unknown>)['status'] = 'running'),
  ],
];

describe('the goal record decoder', () => {
  it('decodes the record of every status the store writes', async () => {
    for (const record of Object.values(await records())) {
      expect(isGoalState(JSON.parse(JSON.stringify(record)))).toBe(true);
    }
  });

  it.each(contradictions)('treats a %s goal with %s as corrupt', async (status, _name, mutate) => {
    const every = await records();
    const base = every[status] as GoalState;
    const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    mutate(record);
    expect(isGoalState(record)).toBe(false);
  });

  describe("the ids derived from the record's own goal", () => {
    const OTHER = 'goal-other';
    const rewrite = (record: Record<string, unknown>, index: number, change: object) => {
      attemptsOf(record)[index] = { ...attemptsOf(record)[index], ...change };
    };
    // Each mutation moves one derived id to the id another goal's builder produces
    // (or to an id no builder produces), keeping the record otherwise consistent.
    const mismatches: Array<[string, string, Mutation]> = [
      [
        'running',
        'an attempt id built for another goal',
        (r) => {
          rewrite(r, 0, { attemptId: goalAttemptId(OTHER, 0) });
          r['active'] = { ...attemptWork(0), attemptId: goalAttemptId(OTHER, 0) };
        },
      ],
      [
        'running',
        'an attempt run id built for another goal, which the active work agrees with',
        (r) => {
          rewrite(r, 0, { runId: goalAttemptRunId(OTHER, 0) });
          r['active'] = { ...attemptWork(0), runId: goalAttemptRunId(OTHER, 0) };
        },
      ],
      [
        'running',
        'a session id built for another goal',
        (r) => rewrite(r, 0, { sessionId: goalSessionId(OTHER, 0) }),
      ],
      [
        'running',
        'a session id no builder produces',
        (r) => rewrite(r, 0, { sessionId: 'session-0' }),
      ],
      [
        'succeeded',
        'a later attempt in a session the continue policy never gives it',
        (r) => rewrite(r, 1, { sessionId: goalSessionId(GOAL, 1) }),
      ],
      [
        'retrying',
        'a validation decision id built for another attempt',
        (r) =>
          rewrite(r, 0, {
            validation: {
              identity: VALIDATOR,
              startedAt: STARTED,
              completedAt: STARTED,
              outcome: { kind: 'fail', feedback: 'no', evidence: [], retryable: true },
              decisionId: goalDecisionId(goalAttemptId(OTHER, 0)),
            },
          }),
      ],
    ];

    it.each(mismatches)('treats a %s goal with %s as corrupt', async (status, _name, mutate) => {
      const every = await records();
      const base = every[status] as GoalState;
      const record = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(record);
      expect(isGoalState(record)).toBe(false);
    });

    it('accepts the session a fork policy gives a later attempt, and refuses the trunk for it', async () => {
      const every = await records();
      const base = every['succeeded'] as GoalState;
      const forked = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      forked['conversationPolicy'] = {
        kind: 'fork-from-baseline',
        throughRun: 0,
      };
      rewrite(forked, 1, { sessionId: goalSessionId(GOAL, 1) });
      const trunk = JSON.parse(JSON.stringify(forked)) as Record<string, unknown>;
      rewrite(trunk, 1, { sessionId: goalSessionId(GOAL, 0) });
      expect(isGoalState(forked)).toBe(true);
      expect(isGoalState(trunk)).toBe(false);
    });

    it('refuses to write a transition that carries them', async () => {
      sequence = 0;
      const store = createGoalStore(textValueStore(new MemoryStorage()));
      await store.create(
        createGoalState({
          goalRunId: GOAL,
          identity: { name: 'goal', version: '1' },
          objective: { agentName: 'builder', prompt: 'p' },
          validator: VALIDATOR,
          conversationPolicy: { kind: 'continue' },
          bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
          now: '2026-10-02T00:00:00.000Z',
        }),
      );
      const foreign = {
        ...attempt(0),
        runId: goalAttemptRunId(OTHER, 0),
      };
      const result = await store.applyTransition({
        goalRunId: GOAL,
        seq: 1,
        transitionId: goalTransitionId(GOAL, 1),
        to: 'running',
        at: at(),
        cause: 'foreign run',
        attempt: foreign,
        active: { ...attemptWork(0), runId: foreign.runId },
      });
      expect(result.status).toBe('rejected');
      const stored = await store.get(GOAL);
      expect(stored?.status).toBe('pending');
    });
  });

  it('refuses a transition that would leave the record contradicting itself', async () => {
    sequence = 0;
    const store = createGoalStore(textValueStore(new MemoryStorage()));
    await store.create(
      createGoalState({
        goalRunId: GOAL,
        identity: { name: 'goal', version: '1' },
        objective: { agentName: 'builder', prompt: 'p' },
        validator: VALIDATOR,
        conversationPolicy: { kind: 'continue' },
        bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
        now: '2026-10-02T00:00:00.000Z',
      }),
    );
    // Running with no attempt and no active work.
    const result = await store.applyTransition({
      goalRunId: GOAL,
      seq: 1,
      transitionId: goalTransitionId(GOAL, 1),
      to: 'running',
      at: at(),
      cause: 'bad',
    });
    expect(result.status).toBe('rejected');
    const stored = await store.get(GOAL);
    expect(stored?.status).toBe('pending');
  });
});
