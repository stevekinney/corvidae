/**
 * COR-851 — the durable goal store: revision-CAS writes, create-if-absent,
 * idempotent transitions, rejection of stale, late, and illegal ones, and
 * fail-closed decoding of corrupt records.
 */
import {
  type GoalRunStatus,
  type GoalRunTerminalReason,
  TERMINAL_STATUS_BY_REASON,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore, WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  boundValidationOutcome,
  createGoalState,
  type CreateGoalStateInput,
  type DurableGoalAttempt,
  GOAL_OBJECTIVE_MAXIMUM_BYTES,
  GOAL_RECORD_KEY_PREFIX,
  GOAL_VALIDATION_MAXIMUM_BYTES,
  goalAttemptId,
  goalAttemptRunId,
  goalDecisionId,
  GoalObjectiveTooLargeError,
  goalRecordKey,
  type GoalState,
  goalTransitionId,
  goalWorkflowId,
  InvalidGoalStateError,
  isGoalState,
} from './goal-state';
import {
  createGoalStore,
  type GoalStore,
  type GoalTransitionRequest,
  type GoalTransitionResult,
} from './goal-store';

const GOAL = 'goal-1';

function createKv() {
  return textValueStore(new MemoryStorage());
}

function input(overrides: Partial<CreateGoalStateInput> = {}): CreateGoalStateInput {
  return {
    goalRunId: GOAL,
    identity: { name: 'ship-feature', version: '1' },
    objective: { agentName: 'builder', prompt: 'Make the tests pass.' },
    validator: { name: 'tests@bureau', version: '1.0.0' },
    conversationPolicy: { kind: 'continue' },
    bounds: { maximumAttempts: 3, maximumTotalTokens: 1000 },
    principal: 'user-1',
    now: '2026-10-02T00:00:00.000Z',
    ...overrides,
  };
}

function setup(corrupt: string[] = []) {
  const kv = createKv();
  const store = createGoalStore(kv, { onCorrupt: (key) => corrupt.push(key) });
  return { kv, store };
}

let clock = 0;
const at = () => `2026-10-02T00:00:${String(10 + clock++).padStart(2, '0')}.000Z`;

function attempt(index: number, overrides: Partial<DurableGoalAttempt> = {}): DurableGoalAttempt {
  return {
    attemptId: goalAttemptId(GOAL, index),
    attemptIndex: index,
    runId: goalAttemptRunId(GOAL, index),
    sessionId: `session-${index}`,
    startedAt: '2026-10-02T00:00:05.000Z',
    usage: { steps: 0, tokens: 0 },
    status: 'running',
    ...overrides,
  };
}

function transition(
  seq: number,
  to: GoalRunStatus,
  overrides: Partial<GoalTransitionRequest> = {},
): GoalTransitionRequest {
  return {
    goalRunId: GOAL,
    seq,
    transitionId: goalTransitionId(GOAL, seq),
    to,
    at: at(),
    cause: `to-${to}`,
    ...overrides,
  };
}

async function created(store: GoalStore, overrides: Partial<CreateGoalStateInput> = {}) {
  const state = createGoalState(input(overrides));
  expect(await store.create(state)).toEqual({ status: 'created', record: state });
  return state;
}

function applied(result: GoalTransitionResult): GoalState {
  if (result.status !== 'applied') throw new Error(`expected applied, got ${result.status}`);
  return result.record;
}

/** pending -> running (attempt 0) -> evaluating, seqs 1 and 2. */
async function toEvaluating(store: GoalStore): Promise<GoalState> {
  applied(
    await store.applyTransition(
      transition(1, 'running', {
        attempt: attempt(0),
        usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
        active: {
          kind: 'attempt',
          attemptId: goalAttemptId(GOAL, 0),
          runId: goalAttemptRunId(GOAL, 0),
          startedAt: '2026-10-02T00:00:05.000Z',
        },
      }),
    ),
  );
  return applied(
    await store.applyTransition(
      transition(2, 'evaluating', {
        attempt: attempt(0, { status: 'evaluating', finishReason: 'stop-condition' }),
        active: {
          kind: 'validation',
          attemptId: goalAttemptId(GOAL, 0),
          validator: { name: 'tests@bureau', version: '1.0.0' },
          startedAt: '2026-10-02T00:00:06.000Z',
        },
      }),
    ),
  );
}

const passed = {
  identity: { name: 'tests@bureau', version: '1.0.0' },
  startedAt: '2026-10-02T00:00:06.000Z',
  completedAt: '2026-10-02T00:00:07.000Z',
  outcome: { kind: 'pass', evidence: [{ source: 'bun-test', detail: { passed: 12 } }] },
  decisionId: goalDecisionId(goalAttemptId(GOAL, 0)),
} as const;

describe('goal record keys', () => {
  it('never match, or are matched by, a Weft-reserved prefix', () => {
    const keys = [GOAL_RECORD_KEY_PREFIX, goalRecordKey('goal-1'), goalRecordKey('wf:order')];

    for (const key of keys) {
      for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
        expect(key.startsWith(reserved)).toBe(false);
        expect(reserved.startsWith(key)).toBe(false);
      }
    }
  });

  it('keeps identifiers containing separators distinct', async () => {
    const { store } = setup();
    await store.create(createGoalState(input({ goalRunId: 'a:b' })));
    await store.create(createGoalState(input({ goalRunId: 'a' })));

    const colon = await store.get('a:b');
    const plain = await store.get('a');
    expect(colon?.goalRunId).toBe('a:b');
    expect(plain?.goalRunId).toBe('a');
    expect(await store.list()).toHaveLength(2);
  });

  it('derives deterministic identifiers from the goal run id', () => {
    expect(goalWorkflowId('g')).toBe('goal:g');
    expect(goalTransitionId('g', 3)).toBe('g:t3');
    expect(goalAttemptId('g', 1)).toBe('g:a1');
    expect(goalAttemptRunId('g', 1)).toBe('goal-g-a1');
    expect(goalDecisionId('g:a1')).toBe('g:a1:decision');
  });
});

describe('createGoalState', () => {
  it('builds a pending record at revision 1, transition 0 that decodes', () => {
    const state = createGoalState(input());

    expect(state).toMatchObject({
      schemaVersion: 1,
      goalRunId: GOAL,
      workflowId: 'goal:goal-1',
      revision: 1,
      transitionSeq: 0,
      status: 'pending',
      attempts: [],
      controllerRestarts: 0,
      requireDeterministicValidation: false,
      usage: { attempts: 0, steps: 0, tokens: 0, durationMs: 0 },
      currentTransition: { seq: 0, transitionId: 'goal-1:t0', from: 'pending', to: 'pending' },
    });
    expect(isGoalState(JSON.parse(JSON.stringify(state)))).toBe(true);
  });

  it('rejects what startGoal rejects: a budget with no aggregate bound', () => {
    expect(() => createGoalState(input({ bounds: { maximumAttempts: 2 } }))).toThrow(
      'at least one aggregate bound',
    );
  });

  it('rejects a fork-from-baseline without a valid throughRun', () => {
    expect(() =>
      createGoalState(
        input({
          conversationPolicy: { kind: 'fork-from-baseline', throughRun: -1 },
        }),
      ),
    ).toThrow('throughRun');
  });

  it('rejects an objective above the inline cap with a typed error', () => {
    const prompt = 'x'.repeat(GOAL_OBJECTIVE_MAXIMUM_BYTES + 1);

    expect(() => createGoalState(input({ objective: { agentName: 'builder', prompt } }))).toThrow(
      GoalObjectiveTooLargeError,
    );
  });

  it('counts the cap in UTF-8 bytes across prompt and instructions', () => {
    const half = 'é'.repeat(GOAL_OBJECTIVE_MAXIMUM_BYTES / 4 + 1);

    expect(() =>
      createGoalState(
        input({ objective: { agentName: 'builder', prompt: half, instructions: half } }),
      ),
    ).toThrow(GoalObjectiveTooLargeError);
    expect(() =>
      createGoalState(
        input({
          objective: {
            agentName: 'builder',
            prompt: 'a'.repeat(GOAL_OBJECTIVE_MAXIMUM_BYTES - 4),
            instructions: 'abcd',
          },
        }),
      ),
    ).not.toThrow();
  });

  it('omits unset optional fields from the stored JSON', () => {
    const json = JSON.parse(JSON.stringify(createGoalState(input({ principal: undefined }))));

    expect('principal' in json).toBe(false);
    expect('retryPolicy' in json).toBe(false);
    expect('validatorTimeoutMs' in json).toBe(false);
  });
});

describe('createGoalStore create, get, and list', () => {
  it('creates once and refuses a duplicate, handing back the record already there', async () => {
    const { store } = setup();
    const original = await created(store);

    const duplicate = await store.create(
      createGoalState(input({ objective: { agentName: 'impostor', prompt: 'other' } })),
    );

    expect(duplicate).toEqual({ status: 'duplicate', existing: original });
    expect(await store.get(GOAL)).toEqual(original);
  });

  it('reports a duplicate without a record when the existing one is unreadable', async () => {
    const corrupt: string[] = [];
    const { kv, store } = setup(corrupt);
    await kv.set(goalRecordKey(GOAL), 'not json');

    expect(await store.create(createGoalState(input()))).toEqual({ status: 'duplicate' });
    expect(corrupt).toContain(goalRecordKey(GOAL));
  });

  it('refuses to create a record that is not a fresh pending one', async () => {
    const { store } = setup();
    const state = createGoalState(input());

    await expect(store.create({ ...state, revision: 2 })).rejects.toThrow(InvalidGoalStateError);
    await expect(store.create({ ...state, status: 'running' })).rejects.toThrow(
      InvalidGoalStateError,
    );
    await expect(store.create({ ...state, schemaVersion: 2 } as never)).rejects.toThrow(
      InvalidGoalStateError,
    );
    expect(await store.list()).toEqual([]);
  });

  it('returns undefined for an unknown goal and lists every readable one', async () => {
    const { store } = setup();
    await created(store, { goalRunId: 'a' });
    await created(store, { goalRunId: 'b' });

    expect(await store.get('missing')).toBeUndefined();
    const listed = await store.list();
    expect(listed.map((record) => record.goalRunId)).toEqual(['a', 'b']);
  });
});

describe('fail-closed decoding', () => {
  const key = goalRecordKey(GOAL);

  function mutated(change: (record: Record<string, unknown>) => void): string {
    const record = JSON.parse(JSON.stringify(createGoalState(input()))) as Record<string, unknown>;
    change(record);
    return JSON.stringify(record);
  }

  const corruptions: Array<[string, () => string]> = [
    ['text that is not JSON', () => 'not json'],
    ['a JSON array', () => '[]'],
    ['JSON null', () => 'null'],
    ['a different schema version', () => mutated((r) => (r['schemaVersion'] = 2))],
    ['a missing identity', () => mutated((r) => delete r['identity'])],
    ['an unknown extra field', () => mutated((r) => (r['extra'] = 1))],
    ['a revision of zero', () => mutated((r) => (r['revision'] = 0))],
    ['a fractional revision', () => mutated((r) => (r['revision'] = 1.5))],
    ['an unknown status', () => mutated((r) => (r['status'] = 'paused'))],
    [
      'a terminal status with no terminal reason',
      () =>
        mutated((r) => {
          r['status'] = 'succeeded';
          (r['currentTransition'] as Record<string, unknown>)['to'] = 'succeeded';
        }),
    ],
    [
      'a non-terminal status carrying a terminal reason',
      () => mutated((r) => (r['terminalReason'] = 'validator-passed')),
    ],
    [
      'a terminal reason that belongs to a different status',
      () =>
        mutated((r) => {
          r['status'] = 'failed';
          r['terminalReason'] = 'validator-passed';
          (r['currentTransition'] as Record<string, unknown>)['to'] = 'failed';
        }),
    ],
    [
      'a workflow id that does not belong to the goal',
      () => mutated((r) => (r['workflowId'] = 'goal:other')),
    ],
    [
      'a transition sequence that disagrees with the current transition',
      () => mutated((r) => (r['transitionSeq'] = 4)),
    ],
    [
      'a current transition whose target is not the status',
      () => mutated((r) => ((r['currentTransition'] as Record<string, unknown>)['to'] = 'running')),
    ],
    [
      'a closedAt on a goal that is not terminal',
      () => mutated((r) => (r['closedAt'] = '2026-10-02T00:00:00.000Z')),
    ],
    ['attempts that are not an array', () => mutated((r) => (r['attempts'] = {}))],
    [
      'an attempt whose index does not match its position',
      () => mutated((r) => (r['attempts'] = [{ ...attempt(1) }])),
    ],
    [
      'an attempt with an unknown finish reason',
      () => mutated((r) => (r['attempts'] = [{ ...attempt(0), finishReason: 'sleepy' }])),
    ],
    [
      'a validation outcome of an unknown kind',
      () =>
        mutated(
          (r) =>
            (r['attempts'] = [
              { ...attempt(0), validation: { ...passed, outcome: { kind: 'maybe' } } },
            ]),
        ),
    ],
    [
      'a validation outcome with an extra field',
      () =>
        mutated(
          (r) =>
            (r['attempts'] = [
              { ...attempt(0), validation: { ...passed, outcome: { kind: 'canceled', extra: 1 } } },
            ]),
        ),
    ],
    [
      'negative usage',
      () => mutated((r) => ((r['usage'] as Record<string, unknown>)['tokens'] = -1)),
    ],
    [
      'a budget with no aggregate bound',
      () => mutated((r) => (r['bounds'] = { maximumAttempts: 1 })),
    ],
    [
      'a retry policy naming an unknown reason',
      () => mutated((r) => (r['retryPolicy'] = { retryOn: ['whenever'] })),
    ],
    [
      'an unknown conversation policy',
      () => mutated((r) => (r['conversationPolicy'] = { kind: 'telepathy' })),
    ],
    [
      'a fresh-from-artifact policy with a malformed artifact',
      () =>
        mutated((r) => {
          (r['objective'] as Record<string, unknown>)['instructions'] = 'go';
          r['conversationPolicy'] = { kind: 'fresh-from-artifact', artifact: {} };
        }),
    ],
    ['a non-positive validator timeout', () => mutated((r) => (r['validatorTimeoutMs'] = 0))],
    [
      'an objective above the inline cap',
      () =>
        mutated(
          (r) =>
            ((r['objective'] as Record<string, unknown>)['prompt'] = 'x'.repeat(
              GOAL_OBJECTIVE_MAXIMUM_BYTES + 1,
            )),
        ),
    ],
    [
      'an active-work record of an unknown kind',
      () => mutated((r) => (r['active'] = { kind: 'nap' })),
    ],
    ['a cancellation marker without a timestamp', () => mutated((r) => (r['cancellation'] = {}))],
    ['a negative controller restart count', () => mutated((r) => (r['controllerRestarts'] = -1))],
  ];

  for (const [name, build] of corruptions) {
    it(`treats ${name} as absent and reports it`, async () => {
      const corrupt: string[] = [];
      const { kv, store } = setup(corrupt);
      await kv.set(key, build());

      expect(await store.get(GOAL)).toBeUndefined();
      expect(await store.list()).toEqual([]);
      expect(corrupt).toEqual([key, key]);
    });
  }

  it('refuses every write against a corrupt record instead of repairing it', async () => {
    const { kv, store } = setup();
    await kv.set(key, 'not json');

    expect(await store.applyTransition(transition(1, 'running'))).toEqual({ status: 'corrupt' });
    expect(await store.requestCancellation(GOAL, { requestedAt: at() }, at())).toEqual({
      status: 'corrupt',
    });
    expect(await store.recordControllerRestart(GOAL, at())).toEqual({ status: 'corrupt' });
    expect(await store.close(GOAL, at())).toEqual({ status: 'corrupt' });
    expect(await kv.get(key)).toBe('not json');
  });

  it('accepts a record with a persisted fork-from-baseline policy and a retry policy', async () => {
    const { store } = setup();
    const state = createGoalState(
      input({
        conversationPolicy: { kind: 'fork-from-baseline', throughRun: 0 },
        retryPolicy: { retryOn: ['validator-fail-retryable'] },
        validatorTimeoutMs: 500,
        requireDeterministicValidation: true,
      }),
    );
    await store.create(state);

    expect(await store.get(GOAL)).toEqual(state);
  });
});

describe('createGoalStore applyTransition', () => {
  it('advances status, sequence, revision, attempts, usage, and active work', async () => {
    const { store } = setup();
    await created(store);

    const running = applied(
      await store.applyTransition(
        transition(1, 'running', {
          attempt: attempt(0),
          usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
          active: {
            kind: 'attempt',
            attemptId: goalAttemptId(GOAL, 0),
            runId: goalAttemptRunId(GOAL, 0),
            startedAt: '2026-10-02T00:00:05.000Z',
          },
        }),
      ),
    );

    expect(running).toMatchObject({
      status: 'running',
      transitionSeq: 1,
      revision: 2,
      usage: { attempts: 1 },
      active: { kind: 'attempt' },
      currentTransition: { seq: 1, transitionId: 'goal-1:t1', from: 'pending', to: 'running' },
    });
    expect(running.attempts).toEqual([attempt(0)]);
    expect(await store.get(GOAL)).toEqual(running);
  });

  it('drives a goal to success and clears the active work', async () => {
    const { store } = setup();
    await created(store);
    const evaluating = await toEvaluating(store);
    expect(evaluating.revision).toBe(3);

    const done = applied(
      await store.applyTransition(
        transition(3, 'succeeded', {
          terminalReason: 'validator-passed',
          attempt: attempt(0, {
            status: 'passed',
            validation: passed,
            finishReason: 'stop-condition',
          }),
          usage: { attempts: 1, steps: 4, tokens: 90, costUsd: 0.01, durationMs: 1000 },
          active: null,
        }),
      ),
    );

    expect(done).toMatchObject({
      status: 'succeeded',
      terminalReason: 'validator-passed',
      usage: { attempts: 1, steps: 4, tokens: 90, costUsd: 0.01, durationMs: 1000 },
    });
    expect(done.active).toBeUndefined();
    expect(done.attempts[0]?.validation?.outcome).toEqual(passed.outcome);
  });

  it('records a retry and the next attempt in one transition', async () => {
    const { store } = setup();
    await created(store);
    await toEvaluating(store);

    const retrying = applied(
      await store.applyTransition(
        transition(3, 'retrying', {
          attempt: attempt(0, { status: 'failed', feedback: 'two tests fail' }),
          active: null,
        }),
      ),
    );
    const second = applied(
      await store.applyTransition(
        transition(4, 'running', {
          attempt: attempt(1),
          usage: { attempts: 2, steps: 0, tokens: 0, durationMs: 0 },
        }),
      ),
    );

    expect(retrying.attempts[0]?.feedback).toBe('two tests fail');
    expect(second.attempts.map((item) => item.attemptIndex)).toEqual([0, 1]);
    expect(second.transitionSeq).toBe(4);
  });

  it('accepts a legal terminal transition for every terminal reason', async () => {
    const reasons = Object.keys(TERMINAL_STATUS_BY_REASON) as GoalRunTerminalReason[];

    for (const reason of reasons) {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);

      const result = await store.applyTransition(
        transition(3, TERMINAL_STATUS_BY_REASON[reason], { terminalReason: reason, active: null }),
      );

      expect(applied(result)).toMatchObject({
        status: TERMINAL_STATUS_BY_REASON[reason],
        terminalReason: reason,
      });
    }
  });

  it('keeps a failure detail on the record', async () => {
    const { store } = setup();
    await created(store);

    const failed = applied(
      await store.applyTransition(
        transition(1, 'failed', {
          terminalReason: 'unsupported-validation',
          failureDetail: 'The validator cannot supply deterministic evidence.',
        }),
      ),
    );

    expect(failed.failureDetail).toBe('The validator cannot supply deterministic evidence.');
  });

  describe('idempotency', () => {
    it('answers a replay of the current transition as a duplicate with no write', async () => {
      const { kv, store } = setup();
      await created(store);
      const request = transition(1, 'running', {
        attempt: attempt(0),
        usage: { attempts: 1, steps: 0, tokens: 0, durationMs: 0 },
      });
      const first = applied(await store.applyTransition(request));
      const stored = await kv.get(goalRecordKey(GOAL));

      const replay = await store.applyTransition(request);

      expect(replay).toEqual({ status: 'duplicate', record: first });
      expect(await kv.get(goalRecordKey(GOAL))).toBe(stored);
    });

    it('does not double count usage when a terminal commit is delivered twice', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const request = transition(3, 'succeeded', {
        terminalReason: 'validator-passed',
        usage: { attempts: 1, steps: 4, tokens: 90, durationMs: 1000 },
        active: null,
      });

      const first = applied(await store.applyTransition(request));
      const replay = await store.applyTransition(request);

      expect(replay).toEqual({ status: 'duplicate', record: first });
      expect(first.usage.tokens).toBe(90);
    });

    it('lets exactly one of two concurrent identical commits apply', async () => {
      const { store } = setup();
      await created(store);
      const request = transition(1, 'running', { attempt: attempt(0) });

      const results = await Promise.all([
        store.applyTransition(request),
        store.applyTransition(request),
      ]);

      expect(results.map((result) => result.status).toSorted()).toEqual(['applied', 'duplicate']);
      const stored = await store.get(GOAL);
      expect(stored?.revision).toBe(2);
    });

    it('treats the same transition id at a different target as a conflicting writer', async () => {
      const { store } = setup();
      await created(store);
      const first = applied(await store.applyTransition(transition(1, 'running')));

      const conflicting = await store.applyTransition({
        ...transition(1, 'failed', { terminalReason: 'attempt-run-failed' }),
        transitionId: first.currentTransition.transitionId,
      });

      expect(conflicting).toEqual({ status: 'stale', record: first });
    });
  });

  describe('stale and late transitions', () => {
    it('reports a transition that skips ahead as stale, with no write', async () => {
      const { store } = setup();
      const original = await created(store);

      expect(await store.applyTransition(transition(2, 'running'))).toEqual({
        status: 'stale',
        record: original,
      });
    });

    it('reports a replay of an older transition as stale with the authoritative record', async () => {
      const { store } = setup();
      await created(store);
      const first = transition(1, 'running');
      applied(await store.applyTransition(first));
      const current = applied(await store.applyTransition(transition(2, 'evaluating')));

      expect(await store.applyTransition(first)).toEqual({ status: 'stale', record: current });
    });

    it('rejects a late attempt completion after cancellation without touching usage', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const canceled = applied(
        await store.applyTransition(
          transition(3, 'canceled', { terminalReason: 'goal-canceled', active: null }),
        ),
      );

      const late = await store.applyTransition(
        transition(4, 'succeeded', {
          terminalReason: 'validator-passed',
          usage: { attempts: 1, steps: 9, tokens: 999, durationMs: 9 },
        }),
      );

      expect(late).toEqual({ status: 'rejected', reason: 'terminal', record: canceled });
      const stored = await store.get(GOAL);
      expect(stored?.usage.tokens).toBe(0);
    });

    it('never resurrects a terminal goal, whatever the target', async () => {
      const { store } = setup();
      await created(store);
      applied(
        await store.applyTransition(
          transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
        ),
      );

      for (const to of ['pending', 'running', 'evaluating', 'retrying'] as const) {
        const result = await store.applyTransition(transition(2, to));
        expect(result).toMatchObject({ status: 'rejected', reason: 'terminal' });
      }
    });
  });

  describe('rejections', () => {
    it('rejects an edge COR-638 does not allow', async () => {
      const { store } = setup();
      const original = await created(store);

      expect(await store.applyTransition(transition(1, 'evaluating'))).toEqual({
        status: 'rejected',
        reason: 'illegal-transition',
        record: original,
      });
      expect(
        await store.applyTransition(
          transition(1, 'succeeded', { terminalReason: 'validator-passed' }),
        ),
      ).toMatchObject({
        reason: 'illegal-transition',
      });
    });

    it('rejects a terminal transition without a matching reason, and a reason on a live one', async () => {
      const { store } = setup();
      await created(store);

      expect(await store.applyTransition(transition(1, 'failed'))).toMatchObject({
        status: 'rejected',
        reason: 'invalid-terminal-reason',
      });
      expect(
        await store.applyTransition(
          transition(1, 'failed', { terminalReason: 'validator-passed' }),
        ),
      ).toMatchObject({ reason: 'invalid-terminal-reason' });
      expect(
        await store.applyTransition(transition(1, 'running', { terminalReason: 'goal-canceled' })),
      ).toMatchObject({ reason: 'invalid-terminal-reason' });
    });

    it('rejects an attempt that leaves a gap or carries another goal’s id', async () => {
      const { store } = setup();
      await created(store);

      expect(
        await store.applyTransition(transition(1, 'running', { attempt: attempt(1) })),
      ).toMatchObject({
        reason: 'invalid-attempt',
      });
      expect(
        await store.applyTransition(
          transition(1, 'running', { attempt: { ...attempt(0), attemptId: 'someone-else:a0' } }),
        ),
      ).toMatchObject({ reason: 'invalid-attempt' });
    });

    it('keeps the first committed validation decision for an attempt', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const first = applied(
        await store.applyTransition(
          transition(3, 'retrying', {
            attempt: attempt(0, {
              status: 'failed',
              validation: { ...passed, outcome: { kind: 'canceled' } },
            }),
          }),
        ),
      );

      const second = await store.applyTransition(
        transition(4, 'running', {
          attempt: attempt(0, {
            status: 'passed',
            validation: { ...passed, decisionId: 'another-decision' },
          }),
        }),
      );

      expect(second).toEqual({
        status: 'rejected',
        reason: 'decision-already-recorded',
        record: first,
      });
    });

    it('rejects a validation outcome above the inline cap', async () => {
      const { store } = setup();
      await created(store);
      await toEvaluating(store);
      const huge = {
        ...passed,
        outcome: {
          kind: 'pass',
          evidence: [{ source: 'log', detail: 'x'.repeat(GOAL_VALIDATION_MAXIMUM_BYTES) }],
        },
      } as const;

      const result = await store.applyTransition(
        transition(3, 'succeeded', {
          terminalReason: 'validator-passed',
          attempt: attempt(0, { status: 'passed', validation: huge }),
        }),
      );

      expect(result).toMatchObject({ status: 'rejected', reason: 'oversized' });
    });

    it('reports a goal that does not exist', async () => {
      const { store } = setup();

      expect(await store.applyTransition(transition(1, 'running'))).toEqual({ status: 'missing' });
    });
  });

  describe('compare-and-swap', () => {
    it('re-evaluates after a control-plane write interleaves, and keeps both', async () => {
      const kv = createKv();
      const store = createGoalStore(kv);
      await created(store);
      let interleaved = false;
      const racing = {
        ...kv,
        get: kv.get.bind(kv),
        list: kv.list.bind(kv),
        set: kv.set.bind(kv),
        conditionalBatch: async (...args: Parameters<typeof kv.conditionalBatch>) => {
          if (!interleaved) {
            interleaved = true;
            await store.recordControllerRestart(GOAL, at());
          }
          return kv.conditionalBatch(...args);
        },
      } as typeof kv;
      const racingStore = createGoalStore(racing);

      const result = applied(await racingStore.applyTransition(transition(1, 'running')));

      expect(result).toMatchObject({ status: 'running', controllerRestarts: 1, revision: 3 });
    });

    it('reports stale, never throws, when it keeps losing the race', async () => {
      const kv = createKv();
      const store = createGoalStore(kv);
      const original = await created(store);
      let attempts = 0;
      const losing = {
        ...kv,
        get: kv.get.bind(kv),
        list: kv.list.bind(kv),
        conditionalBatch: async () => {
          attempts += 1;
          return false;
        },
      } as unknown as typeof kv;

      const result = await createGoalStore(losing).applyTransition(transition(1, 'running'));

      expect(result).toEqual({ status: 'stale', record: original });
      expect(attempts).toBe(16);
      expect(await store.get(GOAL)).toEqual(original);
    });
  });

  it('lets a cancellation request win over every transition but the one to canceled', async () => {
    const { store } = setup();
    await created(store);
    await toEvaluating(store);
    const marked = await store.requestCancellation(
      GOAL,
      { requestedAt: at(), principal: 'user-1' },
      at(),
    );
    if (marked.status !== 'updated') throw new Error('expected updated');

    const blocked = await store.applyTransition(
      transition(3, 'succeeded', { terminalReason: 'validator-passed' }),
    );
    const retry = await store.applyTransition(transition(3, 'retrying'));
    const canceled = applied(
      await store.applyTransition(
        transition(3, 'canceled', { terminalReason: 'goal-canceled', active: null }),
      ),
    );

    expect(blocked).toEqual({
      status: 'rejected',
      reason: 'cancellation-requested',
      record: marked.record,
    });
    expect(retry).toMatchObject({ reason: 'cancellation-requested' });
    expect(canceled.status).toBe('canceled');
    expect(canceled.cancellation?.principal).toBe('user-1');
  });
});

describe('createGoalStore control-plane writes', () => {
  it('records a cancellation once: the first marker wins', async () => {
    const { store } = setup();
    await created(store);

    const first = await store.requestCancellation(
      GOAL,
      { requestedAt: 'first', reason: 'stop' },
      at(),
    );
    const second = await store.requestCancellation(GOAL, { requestedAt: 'second' }, at());

    expect(first).toMatchObject({ status: 'updated', record: { revision: 2, transitionSeq: 0 } });
    expect(second).toMatchObject({ status: 'unchanged' });
    const stored = await store.get(GOAL);
    expect(stored?.cancellation).toEqual({ requestedAt: 'first', reason: 'stop' });
  });

  it('does not touch the transition sequence, so a controller transition still lines up', async () => {
    const { store } = setup();
    await created(store);
    await store.requestCancellation(GOAL, { requestedAt: at() }, at());
    await store.recordControllerRestart(GOAL, at());

    const result = await store.applyTransition(
      transition(1, 'canceled', { terminalReason: 'goal-canceled' }),
    );

    expect(applied(result)).toMatchObject({ status: 'canceled', transitionSeq: 1, revision: 4 });
  });

  it('refuses to cancel or restart a terminal goal and reports a missing one', async () => {
    const { store } = setup();
    await created(store);
    const done = applied(
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      ),
    );

    expect(await store.requestCancellation(GOAL, { requestedAt: at() }, at())).toEqual({
      status: 'rejected',
      reason: 'terminal',
      record: done,
    });
    expect(await store.recordControllerRestart(GOAL, at())).toMatchObject({ reason: 'terminal' });
    expect(await store.requestCancellation('nope', { requestedAt: at() }, at())).toEqual({
      status: 'missing',
    });
  });

  it('counts controller restarts', async () => {
    const { store } = setup();
    await created(store);

    await store.recordControllerRestart(GOAL, at());
    const second = await store.recordControllerRestart(GOAL, at());

    expect(second).toMatchObject({
      status: 'updated',
      record: { controllerRestarts: 2, revision: 3 },
    });
  });

  it('closes a terminal goal once and refuses to close a live one', async () => {
    const { store } = setup();
    await created(store);

    expect(await store.close(GOAL, at())).toMatchObject({
      status: 'rejected',
      reason: 'not-terminal',
    });

    applied(
      await store.applyTransition(
        transition(1, 'failed', { terminalReason: 'unsupported-validation' }),
      ),
    );
    const closed = await store.close(GOAL, 'closed-at');
    const again = await store.close(GOAL, 'later');

    expect(closed).toMatchObject({ status: 'updated', record: { closedAt: 'closed-at' } });
    expect(again).toMatchObject({ status: 'unchanged', record: { closedAt: 'closed-at' } });
  });

  it('is not affected by a transition request racing a cancellation request', async () => {
    const { store } = setup();
    await created(store);

    const [transitioned, marked] = await Promise.all([
      store.applyTransition(transition(1, 'running')),
      store.requestCancellation(GOAL, { requestedAt: at() }, at()),
    ]);

    expect(['applied', 'rejected']).toContain(transitioned.status);
    expect(marked.status).toBe('updated');
    const record = await store.get(GOAL);
    expect(record?.cancellation).toBeDefined();
    expect(record?.revision).toBe(transitioned.status === 'applied' ? 3 : 2);
  });
});

describe('boundValidationOutcome', () => {
  it('returns an outcome under the cap untouched', () => {
    const outcome = passed.outcome;

    expect(boundValidationOutcome(outcome)).toBe(outcome);
  });

  it('replaces evidence and error causes with markers and keeps the verdict', () => {
    const big = 'x'.repeat(200);
    const fail = {
      kind: 'fail',
      feedback: 'nope',
      evidence: [{ source: 'log', detail: { text: big } }],
      retryable: true,
    } as const;
    const error = {
      kind: 'error',
      error: { kind: 'execute', code: 'boom', message: 'bad', cause: { trace: big } },
    } as const;

    const boundedFail = boundValidationOutcome(fail, 100);
    const boundedError = boundValidationOutcome(error, 100);

    expect(boundedFail).toMatchObject({ kind: 'fail', retryable: true, feedback: 'nope' });
    expect(boundedFail.kind === 'fail' && boundedFail.evidence[0]).toEqual({
      source: 'log',
      detail: { truncated: true, originalByteLength: JSON.stringify({ text: big }).length },
    });
    expect(boundedError).toMatchObject({
      kind: 'error',
      error: { code: 'boom', cause: { truncated: true } },
    });
  });

  it('truncates long free text only once the outcome is over the cap', () => {
    const reason = 'r'.repeat(10_000);

    const bounded = boundValidationOutcome({ kind: 'indeterminate', reason }, 100);

    expect(bounded.kind === 'indeterminate' && bounded.reason.length).toBeLessThan(5000);
    expect(boundValidationOutcome({ kind: 'canceled' }, 1)).toEqual({ kind: 'canceled' });
  });
});
