/**
 * COR-2113 — `bureau.checks.list` over a real Bureau and its handler: a verdict, a validate-mode
 * block and a tripwire each become a row; each filter narrows; one cursor pages newest first across
 * the audit trail and the goal store; a caller sees what it owns, widened by `bureau.audit:read`
 * for run rows and `bureau.goals:read` for goal rows; and no row carries text a check produced.
 */
import type { JSONValue, Validator, ValidatorOutcome } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import {
  answering,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from '../../testing/goal-fixtures.test-support';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  openWorkspacePrivacyBureau,
  WORKSPACE_PRIVACY_ACTORS,
  workspacePrivacyCall,
  type WorkspacePrivacyActor,
} from '../workspace-privacy-fixtures.test-support.ts';
import { workspaceConformanceLedger } from '../workspace-conformance-ledger.test-support.ts';
import { checksListOperation } from './checks-operations.ts';
import { decodeChecksCursor, encodeChecksCursor } from './checks-reader.ts';
import {
  as,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const FEEDBACK = 'CHECK-FEEDBACK-SENTINEL-4a1c';
const EVIDENCE = 'CHECK-EVIDENCE-SENTINEL-9e3b';
const FLAGGED = 'CHECK-FLAGGED-TEXT-SENTINEL-27d0';
const GUARDRAIL_DETAIL = 'CHECK-GUARDRAIL-DETAIL-SENTINEL-6f82';

/** Passes an answer that says `done`; fails any other with feedback and evidence that are content. */
const judge: Validator = {
  identity: { name: 'judge', version: '1' },
  determinism: 'deterministic',
  validate: ({ result }): ValidatorOutcome =>
    result.content.includes('done')
      ? { kind: 'pass', evidence: [{ source: 'judge', detail: { said: result.content } }] }
      : {
          kind: 'fail',
          feedback: FEEDBACK,
          evidence: [{ source: 'judge', detail: { saw: EVIDENCE } }],
          retryable: false,
        },
};

type Row = {
  kind: string;
  checkId: string;
  agentName: string | null;
  outcome: string;
  timestamp: string;
  runId: string;
  goalRunId: string | null;
  attemptId: string | null;
  score: number | null;
};

const rowsOf = (body: RpcBody): Row[] => (body.result?.['checks'] as Row[]) ?? [];
const cursorOf = (body: RpcBody): string | null => body.result?.['nextCursor'] as string | null;

async function serve(): Promise<OpenedBureau> {
  const opened = await openBureau({
    agents: {
      worker: workerAgent(answering('done')),
      slacker: workerAgent(answering('not yet'), 'slacker'),
    },
    a2aAgents: ['worker', 'slacker'],
    generate: answering('done'),
    validators: [judge],
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

/** Creates a goal as `key` for `agentName`, waits for its verdict, and answers its id. */
async function judgedGoal(
  opened: OpenedBureau,
  key: string,
  agentName: 'worker' | 'slacker',
  idempotencyKey: string,
): Promise<string> {
  const created = await rpc(
    opened.handler,
    'bureau.goals.create',
    {
      agentName,
      prompt: 'work',
      identity: { name: 'goal', version: '1' },
      validator: { name: 'judge', version: '1' },
      bounds: { maximumAttempts: 1, maximumTotalSteps: 100 },
      idempotencyKey,
    },
    key,
  );
  expect(created.error).toBeUndefined();
  const goalRunId = (created.result!['goal'] as { goalRunId: string }).goalRunId;
  expect(
    await pollUntil(async () => {
      const goal = await opened.bureau.goals.get(goalRunId);
      return (
        goal !== undefined &&
        TERMINAL_STATUSES.includes(goal.status as (typeof TERMINAL_STATUSES)[number]) &&
        goal.attempts.every((attempt) => attempt.validation !== undefined)
      );
    }),
  ).toBe(true);
  return goalRunId;
}

/** Starts a run for `owner` and waits until its owner is on record. */
async function startedRun(opened: OpenedBureau, owner: string): Promise<string> {
  const run = await opened.bureau.tasks.start('default', 'work', { principal: owner });
  await waitForCondition(async () => {
    const completed = await opened.bureau.internals.auditTrail?.query({
      runId: run.id,
      type: 'run.completed',
    });
    return completed?.length === 1;
  }, `run ${run.id} never reached its terminal audit record`);
  return run.id;
}

type Recorded = { runId: string; type: string; detail: Record<string, unknown>; at: number };

/** Writes a guardrail or tripwire record the way the run's observer does, at a chosen time. */
async function record(opened: OpenedBureau, entry: Recorded): Promise<void> {
  await opened.bureau.internals.auditTrail!.record({
    runId: entry.runId,
    type: entry.type,
    detail: entry.detail,
    timestampMs: entry.at,
    strict: true,
  });
}

const blocked = (runId: string, at: number, guardrailName = 'pii-input'): Recorded => ({
  runId,
  type: 'run.guardrail',
  at,
  detail: {
    step: 0,
    guardrailName,
    category: 'pii',
    phase: 'input',
    confidence: 1,
    action: 'block',
  },
});

const tripped = (runId: string, at: number, guardrailName = 'spend-limit'): Recorded => ({
  runId,
  type: 'run.tripwire',
  at,
  detail: {
    step: 0,
    guardrailName,
    category: 'spend',
    phase: 'output',
    confidence: 0.9,
    detail: GUARDRAIL_DETAIL,
  },
});

async function list(opened: OpenedBureau, key: string, params: object = {}): Promise<RpcBody> {
  return rpc(opened.handler, 'bureau.checks.list', params, key);
}

/** Every row, a page of `limit` at a time, in the order the pages came. */
async function allPages(
  opened: OpenedBureau,
  key: string,
  limit: number,
  params: object = {},
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | null = null;
  // A cursor that never ended would repeat a page, and the rows' own uniqueness check says so.
  do {
    const body: RpcBody = await list(opened, key, {
      ...params,
      limit,
      ...(cursor === null ? {} : { cursor }),
    });
    expect(body.error).toBeUndefined();
    rows.push(...rowsOf(body));
    cursor = cursorOf(body);
  } while (cursor !== null);
  return rows;
}

const keyOf = (row: Row): string =>
  `${row.kind}|${row.runId}|${row.goalRunId}|${row.timestamp}|${row.checkId}`;

describe('the operation', () => {
  it('is served, registered, and listed in OpenRPC', async () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(checksListOperation);
    const opened = await serve();
    const response = await opened.handler(
      new Request('http://localhost/openrpc.json', { headers: as('operator-key') }),
    );
    const document = (await response.json()) as { methods: Array<{ name: string }> };
    expect(document.methods.map((method) => method.name)).toContain('bureau.checks.list');
  });

  it('answers nothing from a Bureau with no checks', async () => {
    const opened = await serve();
    const body = await list(opened, 'alice-key');
    expect(body.result).toEqual({ checks: [], nextCursor: null });
  });
});

describe('rows (AC1)', () => {
  it('lists a verdict, a validate-mode block and a tripwire with their kind, check, agent, outcome and time', async () => {
    const opened = await serve();
    const passed = await judgedGoal(opened, 'alice-key', 'worker', 'alice-pass');
    const failed = await judgedGoal(opened, 'alice-key', 'slacker', 'alice-fail');
    const runId = await startedRun(opened, OWNER.alice);
    const BLOCKED_AT = Date.parse('2026-01-01T10:00:00.000Z');
    const TRIPPED_AT = Date.parse('2026-01-01T11:00:00.000Z');
    await record(opened, blocked(runId, BLOCKED_AT));
    await record(opened, tripped(runId, TRIPPED_AT));

    const body = await list(opened, 'alice-key');

    expect(body.error).toBeUndefined();
    const rows = rowsOf(body);
    const goalRows = rows.filter((row) => row.kind === 'goal.attempt.validated');
    expect(goalRows.map((row) => [row.goalRunId, row.checkId, row.agentName, row.outcome])).toEqual(
      expect.arrayContaining([
        [passed, 'judge@1', 'worker', 'pass'],
        [failed, 'judge@1', 'slacker', 'fail'],
      ]),
    );
    const verdict = goalRows.find((row) => row.goalRunId === passed)!;
    const stored = (await opened.bureau.goals.get(passed))!.attempts[0]!;
    expect(verdict).toEqual({
      kind: 'goal.attempt.validated',
      checkId: 'judge@1',
      agentName: 'worker',
      outcome: 'pass',
      timestamp: new Date(Date.parse(stored.validation!.completedAt)).toISOString(),
      runId: stored.runId,
      goalRunId: passed,
      attemptId: stored.attemptId,
      score: null,
    });
    expect(rows.filter((row) => row.kind !== 'goal.attempt.validated')).toEqual([
      {
        kind: 'run.tripwire',
        checkId: 'spend-limit',
        agentName: 'default',
        outcome: 'tripwire',
        timestamp: '2026-01-01T11:00:00.000Z',
        runId,
        goalRunId: null,
        attemptId: null,
        score: null,
      },
      {
        kind: 'run.guardrail',
        checkId: 'pii-input',
        agentName: 'default',
        outcome: 'block',
        timestamp: '2026-01-01T10:00:00.000Z',
        runId,
        goalRunId: null,
        attemptId: null,
        score: null,
      },
    ]);
  });

  it.each(['block', 'warn', 'sanitize', 'redact'] as const)(
    'reads a guardrail’s %s as the outcome',
    async (action) => {
      const opened = await serve();
      const runId = await startedRun(opened, OWNER.alice);
      const entry = blocked(runId, 1_000);
      await record(opened, { ...entry, detail: { ...entry.detail, action } });

      expect(rowsOf(await list(opened, 'alice-key')).map((row) => row.outcome)).toEqual([action]);
    },
  );

  it('leaves out a guardrail record that names no known action or no guardrail', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    const entry = blocked(runId, 1_000);
    await record(opened, { ...entry, detail: { ...entry.detail, action: 'shrug' } });
    await record(opened, { ...entry, at: 2_000, detail: { ...entry.detail, guardrailName: 7 } });
    const { action: _action, ...withoutAction } = entry.detail;
    await record(opened, { ...entry, at: 3_000, detail: withoutAction });

    expect(rowsOf(await list(opened, 'alice-key'))).toEqual([]);
  });

  it('names the agent of a run from its start, and leaves it null for a run that was never seen starting', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, blocked(runId, 2_000));
    // A run the trail holds no start of, owned through its goal's attempt.
    const goalRunId = await judgedGoal(opened, 'alice-key', 'worker', 'alice-attempt');
    const attempt = (await opened.bureau.goals.get(goalRunId))!.attempts[0]!;
    await record(opened, tripped(attempt.runId, 3_000));

    const rows = rowsOf(await list(opened, 'alice-key', { until: 3_000 }));

    expect(rows.map((row) => [row.kind, row.agentName])).toEqual([
      ['run.tripwire', 'worker'],
      ['run.guardrail', 'default'],
    ]);
  });
});

describe('filters (AC2)', () => {
  /** Alice's runs, at fixed times, and her two verdicts. */
  async function seeded(): Promise<{ opened: OpenedBureau; runId: string; passed: string }> {
    const opened = await serve();
    const passed = await judgedGoal(opened, 'alice-key', 'worker', 'alice-pass');
    await judgedGoal(opened, 'alice-key', 'slacker', 'alice-fail');
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, blocked(runId, 1_000, 'pii-input'));
    await record(opened, blocked(runId, 2_000, 'secrets-output'));
    await record(opened, tripped(runId, 3_000, 'spend-limit'));
    return { opened, runId, passed };
  }

  it('narrows by kind', async () => {
    const { opened } = await seeded();
    for (const kind of ['goal.attempt.validated', 'run.guardrail', 'run.tripwire'] as const) {
      const rows = rowsOf(await list(opened, 'alice-key', { kind }));
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.kind))).toEqual(new Set([kind]));
    }
    expect(rowsOf(await list(opened, 'alice-key', { kind: 'run.guardrail' }))).toHaveLength(2);
  });

  it('narrows by check id', async () => {
    const { opened } = await seeded();
    expect(
      rowsOf(await list(opened, 'alice-key', { checkId: 'secrets-output' })).map(
        (row) => row.checkId,
      ),
    ).toEqual(['secrets-output']);
    expect(rowsOf(await list(opened, 'alice-key', { checkId: 'judge@1' }))).toHaveLength(2);
    expect(rowsOf(await list(opened, 'alice-key', { checkId: 'judge' }))).toEqual([]);
  });

  it('narrows by agent', async () => {
    const { opened } = await seeded();
    expect(
      rowsOf(await list(opened, 'alice-key', { agentName: 'slacker' })).map((row) => row.outcome),
    ).toEqual(['fail']);
    expect(rowsOf(await list(opened, 'alice-key', { agentName: 'default' }))).toHaveLength(3);
    expect(rowsOf(await list(opened, 'alice-key', { agentName: 'nobody' }))).toEqual([]);
  });

  it('narrows by outcome', async () => {
    const { opened } = await seeded();
    expect(
      rowsOf(await list(opened, 'alice-key', { outcome: 'pass' })).map((row) => row.kind),
    ).toEqual(['goal.attempt.validated']);
    expect(
      rowsOf(await list(opened, 'alice-key', { outcome: 'tripwire' })).map((row) => row.checkId),
    ).toEqual(['spend-limit']);
    expect(rowsOf(await list(opened, 'alice-key', { outcome: 'redact' }))).toEqual([]);
  });

  it('narrows by time, both ends inclusive', async () => {
    const { opened } = await seeded();
    const between = rowsOf(await list(opened, 'alice-key', { since: 2_000, until: 3_000 }));
    expect(between.map((row) => row.checkId)).toEqual(['spend-limit', 'secrets-output']);
    const justOne = rowsOf(await list(opened, 'alice-key', { since: 1_000, until: 1_000 }));
    expect(justOne.map((row) => row.checkId)).toEqual(['pii-input']);
    const lately = rowsOf(await list(opened, 'alice-key', { since: 4_000 }));
    expect(lately.every((row) => row.kind === 'goal.attempt.validated')).toBe(true);
    expect(lately).toHaveLength(2);
    expect(rowsOf(await list(opened, 'alice-key', { since: 5_000, until: 4_000 }))).toEqual([]);
  });

  it('combines filters', async () => {
    const { opened } = await seeded();
    expect(
      rowsOf(
        await list(opened, 'alice-key', { kind: 'run.guardrail', outcome: 'block', since: 1_500 }),
      ).map((row) => row.checkId),
    ).toEqual(['secrets-output']);
  });
});

describe('paging (AC3)', () => {
  it('returns every row exactly once across pages, newest first across the trail and the goals, at one cursor', async () => {
    const opened = await serve();
    const passed = await judgedGoal(opened, 'alice-key', 'worker', 'alice-pass');
    const failed = await judgedGoal(opened, 'alice-key', 'slacker', 'alice-fail');
    const runId = await startedRun(opened, OWNER.alice);
    const stamps = await Promise.all(
      [passed, failed].map(async (goalRunId) =>
        Date.parse(
          (await opened.bureau.goals.get(goalRunId))!.attempts[0]!.validation!.completedAt,
        ),
      ),
    );
    // Trail rows before, at and after each verdict's millisecond, so a page boundary falls between
    // rows of one source and of two.
    for (const [index, at] of [...stamps, ...stamps.map((stamp) => stamp + 1)].entries()) {
      await record(opened, blocked(runId, at, `at-${index}-a`));
      await record(opened, tripped(runId, at, `at-${index}-b`));
    }
    await record(opened, blocked(runId, Math.min(...stamps) - 5, 'earlier'));
    await record(opened, blocked(runId, Math.max(...stamps) + 5, 'later'));

    const whole = await allPages(opened, 'alice-key', 100);

    expect(whole).toHaveLength(2 + 8 + 2);
    expect(new Set(whole.map(keyOf)).size).toBe(whole.length);
    const times = whole.map((row) => Date.parse(row.timestamp));
    expect(times).toEqual(times.toSorted((first, second) => second - first));
    // At one millisecond a trail row comes before a goal row.
    for (const [index, row] of whole.entries()) {
      const next = whole[index + 1];
      if (next === undefined || row.timestamp !== next.timestamp) continue;
      expect(row.kind === 'goal.attempt.validated' && next.kind !== 'goal.attempt.validated').toBe(
        false,
      );
    }
    for (const limit of [1, 2, 3, 5, 11]) {
      const paged = await allPages(opened, 'alice-key', limit);
      expect(paged.map(keyOf), `limit ${limit}`).toEqual(whole.map(keyOf));
    }
  });

  it('continues across a trail longer than one read of it', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    for (let index = 0; index < 450; index += 1) {
      await record(opened, blocked(runId, 10_000 + (index % 7), `guard-${index}`));
    }

    const paged = await allPages(opened, 'alice-key', 100);

    expect(paged).toHaveLength(450);
    expect(new Set(paged.map((row) => row.checkId)).size).toBe(450);
    const times = paged.map((row) => Date.parse(row.timestamp));
    expect(times).toEqual(times.toSorted((first, second) => second - first));
  });

  it('fills a page from the rows the caller may see, across rows it may not', async () => {
    const opened = await serve();
    const aliceRun = await startedRun(opened, OWNER.alice);
    const bobRun = await startedRun(opened, OWNER.bob);
    await record(opened, blocked(aliceRun, 1_000, 'alice-early'));
    for (let index = 0; index < 5; index += 1) {
      await record(opened, blocked(bobRun, 2_000 + index, `bob-${index}`));
    }
    await record(opened, blocked(aliceRun, 9_000, 'alice-late'));

    const first = await list(opened, 'alice-key', { limit: 1 });
    expect(rowsOf(first).map((row) => row.checkId)).toEqual(['alice-late']);
    expect(cursorOf(first)).not.toBeNull();
    const second = await list(opened, 'alice-key', { limit: 1, cursor: cursorOf(first)! });
    expect(rowsOf(second).map((row) => row.checkId)).toEqual(['alice-early']);
    expect(cursorOf(second)).toBeNull();
  });

  it('holds the same filter across pages', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    for (let index = 0; index < 6; index += 1) {
      await record(
        opened,
        index % 2 === 0
          ? blocked(runId, 1_000 + index, `g${index}`)
          : tripped(runId, 1_000 + index, `g${index}`),
      );
    }

    const paged = await allPages(opened, 'alice-key', 2, { kind: 'run.tripwire' });

    expect(paged.map((row) => row.checkId)).toEqual(['g5', 'g3', 'g1']);
  });
});

describe('flagged sessions (COR-2116)', () => {
  const TAINTED_AT = Date.parse('2026-02-03T04:05:06.000Z');

  /** Flags a session the way the taint seam does: the stored metadata, and no event. */
  async function flag(
    opened: OpenedBureau,
    sessionId: string,
    taint: Record<string, JSONValue> = {},
  ): Promise<void> {
    await opened.bureau.internals.sessionStore!.updateMetadata(sessionId, {
      guardrailTaint: {
        category: 'prompt-injection',
        detector: 'injection-detector',
        provenance: 'user-input',
        confidence: 0.97,
        at: TAINTED_AT,
        runId: 'run-that-flagged-it',
        ...taint,
      },
    });
  }

  async function sessionOf(opened: OpenedBureau, owner: string): Promise<string> {
    const run = await opened.bureau.tasks.start('default', 'hello', { principal: owner });
    await waitForCondition(async () => {
      const completed = await opened.bureau.internals.auditTrail?.query({
        runId: run.id,
        type: 'run.completed',
      });
      return completed?.length === 1;
    }, `run ${run.id} never reached its terminal audit record`);
    return run.contextId;
  }

  it('lists a tainted session with the detector as the check, the outcome tainted and the taint’s own time (AC1, AC4)', async () => {
    const opened = await serve();
    const sessionId = await sessionOf(opened, OWNER.alice);
    await flag(opened, sessionId);

    const body = await list(opened, 'alice-key');

    expect(body.error).toBeUndefined();
    // No event announced the taint, so a row here is read from the stored metadata.
    expect(rowsOf(body)).toEqual([
      {
        kind: 'session.tainted',
        checkId: 'injection-detector',
        agentName: 'default',
        outcome: 'tainted',
        timestamp: '2026-02-03T04:05:06.000Z',
        runId: 'run-that-flagged-it',
        goalRunId: null,
        attemptId: null,
        score: null,
      },
    ]);
  });

  it('leaves a session with no taint, or a taint that is not well formed, out', async () => {
    const opened = await serve();
    await sessionOf(opened, OWNER.alice);
    const malformed = await sessionOf(opened, OWNER.alice);
    await flag(opened, malformed, { detector: 7 });
    const noTime = await sessionOf(opened, OWNER.alice);
    await flag(opened, noTime, { at: 'yesterday' });

    expect(rowsOf(await list(opened, 'alice-key'))).toEqual([]);
  });

  it('accepts session.tainted as a kind, and tainted as an outcome (AC2)', async () => {
    const opened = await serve();
    await judgedGoal(opened, 'alice-key', 'worker', 'alice-goal');
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, blocked(runId, 1_000));
    await flag(opened, await sessionOf(opened, OWNER.alice));

    const byKind = await list(opened, 'alice-key', { kind: 'session.tainted' });
    expect(byKind.error).toBeUndefined();
    expect(rowsOf(byKind).map((row) => row.kind)).toEqual(['session.tainted']);
    expect(
      rowsOf(await list(opened, 'alice-key', { outcome: 'tainted' })).map((row) => row.kind),
    ).toEqual(['session.tainted']);
    expect(
      rowsOf(await list(opened, 'alice-key', { kind: 'run.guardrail' })).map((row) => row.kind),
    ).toEqual(['run.guardrail']);
    expect(
      rowsOf(await list(opened, 'alice-key', { agentName: 'default', kind: 'session.tainted' })),
    ).toHaveLength(1);
    expect(
      rowsOf(await list(opened, 'alice-key', { checkId: 'injection-detector' })).map(
        (row) => row.kind,
      ),
    ).toEqual(['session.tainted']);
    expect(
      rowsOf(await list(opened, 'alice-key', { kind: 'session.tainted', since: TAINTED_AT + 1 })),
    ).toEqual([]);
  });

  it('shows a caller the sessions it owns, and another owner’s only with bureau.audit:read (AC3)', async () => {
    const opened = await serve();
    await flag(opened, await sessionOf(opened, OWNER.alice), { detector: 'alice-detector' });
    await flag(opened, await sessionOf(opened, OWNER.bob), { detector: 'bob-detector' });
    const sessionChecks = (key: string) =>
      list(opened, key, { kind: 'session.tainted' }).then((body) =>
        rowsOf(body).map((row) => row.checkId),
      );

    const everyDetector = ['alice-detector', 'bob-detector'];
    const ofAuditReader = await sessionChecks('audit-reader-key');
    const ofOperator = await sessionChecks('operator-key');

    expect(await sessionChecks('alice-key')).toEqual(['alice-detector']);
    expect(await sessionChecks('bob-key')).toEqual(['bob-detector']);
    expect(ofAuditReader.toSorted()).toEqual(everyDetector);
    expect(ofOperator.toSorted()).toEqual(everyDetector);
    // Reading goals is no reason to read another owner's flagged sessions.
    expect(await sessionChecks('goals-reader-key')).toEqual([]);
    expect(await sessionChecks('goals-writer-key')).toEqual([]);
  });

  it('pages a session beside a run and a goal at one millisecond, once each', async () => {
    const opened = await serve();
    const goalRunId = await judgedGoal(opened, 'alice-key', 'worker', 'alice-goal');
    const verdictAt = Date.parse(
      (await opened.bureau.goals.get(goalRunId))!.attempts[0]!.validation!.completedAt,
    );
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, blocked(runId, verdictAt, 'at-the-verdict'));
    for (const detector of ['detector-a', 'detector-b', 'detector-c']) {
      await flag(opened, await sessionOf(opened, OWNER.alice), { detector, at: verdictAt });
    }
    await flag(opened, await sessionOf(opened, OWNER.alice), {
      detector: 'detector-after',
      at: verdictAt + 1,
    });

    const whole = await allPages(opened, 'alice-key', 100);

    expect(whole).toHaveLength(6);
    expect(whole.map((row) => row.kind)).toEqual([
      'session.tainted',
      'run.guardrail',
      'goal.attempt.validated',
      'session.tainted',
      'session.tainted',
      'session.tainted',
    ]);
    for (const limit of [1, 2, 4]) {
      const paged = await allPages(opened, 'alice-key', limit);
      expect(paged.map(keyOf), `limit ${limit}`).toEqual(whole.map(keyOf));
    }
  });
});

describe('scores (COR-2252)', () => {
  const MESSAGE = 'SCORER-MESSAGE-SENTINEL-8d44';

  /** A `scorer.recorded` record as the sampler writes it, with every field it carries. */
  const scored = (
    runId: string,
    at: number,
    overrides: Record<string, unknown> = {},
  ): Recorded => ({
    runId,
    type: 'scorer.recorded',
    at,
    detail: {
      runKind: 'agent',
      definitionId: 'default',
      definitionVersion: 3,
      judgedBy: { kind: 'bureau', name: 'bureau', version: '1.0.0' },
      judgeName: 'politeness',
      judgeVersion: '2',
      judgeDigest: 'digest-of-politeness-2',
      determinism: 'nondeterministic',
      sampleRate: 1,
      outcome: 'pass',
      score: 0.82,
      message: MESSAGE,
      durationMs: 12,
      decisions: [{ provider: 'anthropic', model: 'claude' }],
      ...overrides,
    },
  });

  it('lists a recorded score with its check, agent, outcome, score and time, and no message (AC1, AC2)', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, scored(runId, Date.parse('2026-03-04T05:06:07.000Z')));

    const body = await list(opened, 'alice-key');

    expect(rowsOf(body)).toEqual([
      {
        kind: 'scorer.recorded',
        checkId: 'politeness@2',
        agentName: 'default',
        outcome: 'pass',
        timestamp: '2026-03-04T05:06:07.000Z',
        runId,
        goalRunId: null,
        attemptId: null,
        score: 0.82,
      },
    ]);
    for (const row of rowsOf(body)) expect(Object.keys(row)).not.toContain('message');
    expect(JSON.stringify(body)).not.toContain(MESSAGE);
    expect(JSON.stringify(body)).not.toContain('digest-of-politeness-2');
    expect(JSON.stringify(body)).not.toContain('claude');
  });

  it('answers a score of 0, a missing score and a score that is not a number', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, scored(runId, 3_000, { judgeName: 'zero', score: 0 }));
    await record(opened, scored(runId, 2_000, { judgeName: 'none', score: undefined }));
    await record(opened, scored(runId, 1_000, { judgeName: 'nan', score: 'high' }));

    expect(rowsOf(await list(opened, 'alice-key')).map((row) => [row.checkId, row.score])).toEqual([
      ['zero@2', 0],
      ['none@2', null],
      ['nan@2', null],
    ]);
  });

  it('reads the agent from the record, else from the run’s start, else leaves it null', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, scored(runId, 3_000, { judgeName: 'named', definitionId: 'recorded' }));
    await record(opened, scored(runId, 2_000, { judgeName: 'recovered', definitionId: null }));
    await record(opened, scored('run-nobody-owns', 1_000, { judgeName: 'orphan' }));

    expect(
      rowsOf(await list(opened, 'audit-reader-key')).map((row) => [row.checkId, row.agentName]),
    ).toEqual([
      ['named@2', 'recorded'],
      ['recovered@2', 'default'],
      ['orphan@2', 'default'],
    ]);
    expect(
      rowsOf(await list(opened, 'alice-key', { agentName: 'recorded' })).map((row) => row.checkId),
    ).toEqual(['named@2']);
  });

  it('leaves out a record with no scorer, version or known outcome', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    await record(opened, scored(runId, 3_000, { judgeName: undefined }));
    await record(opened, scored(runId, 2_000, { judgeVersion: 2 }));
    await record(opened, scored(runId, 1_000, { outcome: 'block' }));

    expect(rowsOf(await list(opened, 'alice-key'))).toEqual([]);
  });

  it('applies every filter and the cursor to a score, beside the other kinds (AC3)', async () => {
    const opened = await serve();
    const runId = await startedRun(opened, OWNER.alice);
    const bobRun = await startedRun(opened, OWNER.bob);
    await record(opened, scored(runId, 5_000, { judgeName: 'a', outcome: 'pass' }));
    await record(opened, scored(runId, 4_000, { judgeName: 'b', outcome: 'fail', score: 0.1 }));
    await record(
      opened,
      scored(runId, 3_000, { judgeName: 'c', outcome: 'error', score: undefined }),
    );
    await record(opened, blocked(runId, 4_000, 'a-guardrail'));
    await record(opened, scored(bobRun, 4_500, { judgeName: 'bobs' }));
    const checks = async (params: object) =>
      rowsOf(await list(opened, 'alice-key', params)).map((row) => row.checkId);

    expect(await checks({ kind: 'scorer.recorded' })).toEqual(['a@2', 'b@2', 'c@2']);
    expect(await checks({ kind: 'scorer.recorded', outcome: 'fail' })).toEqual(['b@2']);
    expect(await checks({ outcome: 'error' })).toEqual(['c@2']);
    expect(await checks({ checkId: 'a@2' })).toEqual(['a@2']);
    expect(await checks({ agentName: 'default', kind: 'scorer.recorded' })).toHaveLength(3);
    expect(await checks({ kind: 'scorer.recorded', since: 3_500, until: 4_500 })).toEqual(['b@2']);
    // At one millisecond, the record the trail wrote last comes first.
    const everything = ['a@2', 'a-guardrail', 'b@2', 'c@2'];
    expect(await checks({})).toEqual(everything);
    const paged = await allPages(opened, 'alice-key', 1);
    expect(paged.map((row) => row.checkId)).toEqual(everything);
    // Another owner's score is theirs alone.
    expect(await checks({ checkId: 'bobs@2' })).toEqual([]);
    expect(
      rowsOf(await list(opened, 'audit-reader-key', { checkId: 'bobs@2' })).map((row) => row.score),
    ).toEqual([0.82]);
  });
});

describe('a scorer’s own run (COR-2252)', () => {
  const CANARY = 'SCORER-CANARY-SENTINEL-1f3a';

  it('reaches the list as the sampler recorded it, with the score and without the message', async () => {
    const opened = await openBureau({
      generate: answering('done'),
      bureauOptions: {
        scorers: {
          list: [
            {
              name: 'tone',
              version: '1.0.0',
              score: () => ({ outcome: 'pass', message: `fine ${CANARY}`, score: 0.75 }),
            },
            {
              name: 'strict',
              version: '3',
              score: () => ({ outcome: 'fail', message: `failed ${CANARY}`, score: 0.2 }),
            },
          ],
          sampleRate: 1,
          rng: () => 0,
        },
      },
    });
    cleanups.push(() => opened.dispose());
    const started = await opened.bureau.tasks.start('default', 'go', { principal: OWNER.alice });
    const sampler = opened.bureau.internals.scorerSampler!;
    await waitForCondition(() => sampler.sampledCount() === 1, 'the run was sampled');
    await sampler.flush();

    const body = await list(opened, 'alice-key', { kind: 'scorer.recorded' });

    const rows = rowsOf(body).toSorted((first, second) =>
      first.checkId.localeCompare(second.checkId),
    );
    expect(
      rows.map((row) => [row.checkId, row.agentName, row.outcome, row.score, row.runId]),
    ).toEqual([
      ['strict@3', 'default', 'fail', 0.2, started.id],
      ['tone@1.0.0', 'default', 'pass', 0.75, started.id],
    ]);
    expect(JSON.stringify(body)).not.toContain(CANARY);
    // The message is on the audit record, which is why its absence here is the operation's doing.
    const recorded = await opened.bureau.internals.auditTrail!.query({
      runId: started.id,
      type: 'scorer.recorded',
    });
    expect(JSON.stringify(recorded)).toContain(CANARY);
  });
});

describe('the cursor and the input', () => {
  it('names a position and nothing else, in one spelling', () => {
    const positions = [
      [5, 'run', 12],
      [5, 'run', -1],
      [5, 'goal', ['goal/with:odd chars"', 3]],
      [5, 'session', 'session-id'],
    ] as const;
    for (const position of positions) {
      const cursor = encodeChecksCursor([...position] as never);
      expect(decodeChecksCursor(cursor)).toEqual([...position]);
    }
    const good = encodeChecksCursor([5, 'run', 12]);
    for (const bad of [
      '',
      'not a cursor',
      `${good}=`,
      good.slice(0, -1),
      Buffer.from('[5,"run"]').toString('base64url'),
      Buffer.from('[5,"other",1]').toString('base64url'),
      Buffer.from('[-5,"run",1]').toString('base64url'),
      Buffer.from('[5,"run","1"]').toString('base64url'),
      Buffer.from('[5,"goal",["g",-1]]').toString('base64url'),
      Buffer.from('[5,"goal",["",1]]').toString('base64url'),
      Buffer.from('[5,"session",""]').toString('base64url'),
      Buffer.from('[5,"session",1]').toString('base64url'),
      Buffer.from('[5.5,"run",1]').toString('base64url'),
      Buffer.from('[5, "run", 1]').toString('base64url'),
      'a'.repeat(5000),
    ]) {
      expect(decodeChecksCursor(bad), bad).toBeUndefined();
    }
  });

  it('answers InvalidParams for a cursor, a limit, a filter or a key it does not take', async () => {
    const opened = await serve();
    for (const params of [
      { cursor: 'nonsense' },
      { cursor: 'a'.repeat(2000) },
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { kind: 'goal.attempt.failed' },
      { outcome: 'passed' },
      { checkId: '' },
      { agentName: 'a'.repeat(300) },
      { since: -1 },
      { until: 1.5 },
      { owner: OWNER.bob },
      { principal: OWNER.bob },
    ]) {
      const body = await list(opened, 'alice-key', params);
      expect(
        body.error?.data?.['code'] ?? body.error?.message,
        JSON.stringify(params),
      ).toBeDefined();
      expect(body.result, JSON.stringify(params)).toBeUndefined();
    }
  });
});

describe('who sees what (AC4)', () => {
  async function twoOwners() {
    const opened = await serve();
    const aliceGoal = await judgedGoal(opened, 'alice-key', 'worker', 'alice-goal');
    const bobGoal = await judgedGoal(opened, 'bob-key', 'slacker', 'bob-goal');
    const aliceRun = await startedRun(opened, OWNER.alice);
    const bobRun = await startedRun(opened, OWNER.bob);
    await record(opened, blocked(aliceRun, 1_000, 'alice-guard'));
    await record(opened, blocked(bobRun, 2_000, 'bob-guard'));
    return { opened, aliceGoal, bobGoal };
  }

  const summary = (rows: Row[]) => rows.map((row) => row.goalRunId ?? row.checkId).toSorted();

  it('shows a caller its own run and goal rows and no other owner’s', async () => {
    const { opened, aliceGoal, bobGoal } = await twoOwners();

    expect(summary(rowsOf(await list(opened, 'alice-key')))).toEqual(
      [aliceGoal, 'alice-guard'].toSorted(),
    );
    expect(summary(rowsOf(await list(opened, 'bob-key')))).toEqual(
      [bobGoal, 'bob-guard'].toSorted(),
    );
  });

  it('shows another owner’s run rows only with bureau.audit:read', async () => {
    const { opened, aliceGoal, bobGoal } = await twoOwners();

    // Run rows of both owners, and neither owner's goal rows: the scope reaches no goal.
    expect(summary(rowsOf(await list(opened, 'audit-reader-key')))).toEqual([
      'alice-guard',
      'bob-guard',
    ]);
    expect(summary(rowsOf(await list(opened, 'audit-reader-key')))).not.toContain(aliceGoal);
    expect(summary(rowsOf(await list(opened, 'audit-reader-key')))).not.toContain(bobGoal);
    expect(rowsOf(await list(opened, 'tasks-reader-key'))).toEqual([]);
  });

  it('shows another owner’s goal rows only with bureau.goals:read', async () => {
    const { opened, aliceGoal, bobGoal } = await twoOwners();

    expect(summary(rowsOf(await list(opened, 'goals-reader-key')))).toEqual(
      [aliceGoal, bobGoal].toSorted(),
    );
    expect(rowsOf(await list(opened, 'goals-writer-key'))).toEqual([]);
    expect(rowsOf(await list(opened, 'goals-content-key'))).toEqual([]);
  });

  it('shows an operator every row', async () => {
    const { opened, aliceGoal, bobGoal } = await twoOwners();

    expect(summary(rowsOf(await list(opened, 'operator-key')))).toEqual(
      [aliceGoal, bobGoal, 'alice-guard', 'bob-guard'].toSorted(),
    );
  });

  it('shows a run row of a run with no owner only with bureau.audit:read', async () => {
    const opened = await serve();
    await record(opened, blocked('run-nobody-owns', 1_000, 'orphan-guard'));

    expect(rowsOf(await list(opened, 'alice-key'))).toEqual([]);
    expect(rowsOf(await list(opened, 'audit-reader-key')).map((row) => row.checkId)).toEqual([
      'orphan-guard',
    ]);
  });

  it('shows a run row of a goal attempt’s run to the goal’s owner', async () => {
    const opened = await serve();
    const goalRunId = await judgedGoal(opened, 'alice-key', 'worker', 'alice-goal');
    const attempt = (await opened.bureau.goals.get(goalRunId))!.attempts[0]!;
    await record(opened, tripped(attempt.runId, 1_000, 'attempt-wire'));

    expect(
      rowsOf(await list(opened, 'alice-key', { kind: 'run.tripwire' })).map((row) => row.checkId),
    ).toEqual(['attempt-wire']);
    expect(rowsOf(await list(opened, 'bob-key', { kind: 'run.tripwire' }))).toEqual([]);
  });

  it('answers no rows to a request that names no one', async () => {
    const opened = await serve();
    await judgedGoal(opened, 'alice-key', 'worker', 'alice-goal');
    const response = await opened.handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.checks.list', params: {} }),
      }),
    );
    expect([401, 403]).toContain(response.status);
  });
});

describe('what a row leaves out (AC5)', () => {
  it('carries no flagged text, feedback, evidence or detail', async () => {
    const opened = await serve();
    await judgedGoal(opened, 'alice-key', 'slacker', 'alice-fail');
    const runId = await startedRun(opened, OWNER.alice);
    const entry = blocked(runId, 1_000);
    await record(opened, {
      ...entry,
      detail: {
        ...entry.detail,
        detail: FLAGGED,
        text: FLAGGED,
        message: FLAGGED,
        feedback: FLAGGED,
        reason: FLAGGED,
      },
    });
    await record(opened, tripped(runId, 2_000));

    for (const key of ['alice-key', 'operator-key']) {
      const body = await list(opened, key);
      expect(rowsOf(body)).toHaveLength(3);
      const text = JSON.stringify(body);
      for (const sentinel of [FEEDBACK, EVIDENCE, FLAGGED, GUARDRAIL_DETAIL]) {
        expect(text).not.toContain(sentinel);
      }
      for (const row of rowsOf(body)) {
        expect(Object.keys(row).toSorted()).toEqual(
          [
            'agentName',
            'attemptId',
            'checkId',
            'goalRunId',
            'kind',
            'outcome',
            'runId',
            'score',
            'timestamp',
          ].toSorted(),
        );
      }
    }
  });
});

describe('workspace privacy', () => {
  const witnesses = workspaceConformanceLedger('management/checks-operations.test.ts');

  it('shows a member only their own rows, whatever scopes they hold', async () => {
    const opened = await openWorkspacePrivacyBureau({
      agents: { worker: workerAgent(answering('done')) },
      a2aAgents: ['worker'],
      generate: answering('done'),
      validators: [judge],
    });
    cleanups.push(() => opened.dispose());
    const task = await opened.bureau.tasks.start('default', 'PRIVATE-CHECK-INPUT-5d1e', {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(async () => {
      const completed = await opened.bureau.internals.auditTrail?.query({
        runId: task.id,
        type: 'run.completed',
      });
      return completed?.length === 1;
    }, 'private run settles');
    // The guardrail's name is the private text a row can hold: the owner reads it and no one else.
    await record(opened, blocked(task.id, 1_000, 'PRIVATE-CHECK-INPUT-5d1e'));

    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const result = await workspacePrivacyCall(opened, actor, 'bureau.checks.list', {});
      witnesses.observeCollection('bureau.checks.list', actor, result, task.id);
      witnesses.observePrivateProjection('bureau.checks.list', actor, result);
      if (actor === 'foreign' || actor === 'removed') {
        expect(result.status).toBe(403);
        continue;
      }
      expect(result.body?.error).toBeUndefined();
      const rows = (result.body?.result?.['checks'] ?? []) as Row[];
      if (actor === 'owner') expect(rows.map((row) => row.runId)).toEqual([task.id]);
      else expect(rows).toEqual([]);
    }
  });

  it('has six executed actor witnesses', () => {
    witnesses.verify();
  });
});
