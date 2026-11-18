/**
 * COR-2112 — `bureau.goals.verdict` over a real Bureau and its handler: an attempt's feedback and
 * evidence are content behind their own read, what judged an attempt is recorded when the validator
 * ran, and a record written before that decodes with `judgedBy: null`.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import type { Validator, ValidatorOutcome } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { BUREAU_VERSION } from '../../bureau-version.ts';
import type { GoalState } from '../../goal-state.ts';
import { BUREAU_PLUGIN_NAME } from '../../plugins/bureau-plugin.ts';
import {
  answering,
  createLatch,
  hangUntilAborted,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
} from '../../testing/goal-fixtures.test-support';
import {
  inspect,
  pendingGoal,
  seedRetrying,
} from '../../testing/goal-recovery-fixtures.test-support';
import { workspaceConformanceLedger } from '../workspace-conformance-ledger.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  WORKSPACE_PRIVACY_ACTORS,
  workspacePrivacyCall,
  type WorkspacePrivacyActor,
} from '../workspace-privacy-fixtures.test-support.ts';
import { openBureau, type OpenedBureau, OWNER, rpc } from './management-fixtures.test-support.ts';
import { bureauGoalsOperations, goalsVerdictOperation } from './goals-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const FEEDBACK = 'VERDICT-FEEDBACK-SENTINEL-3b7d';
const EVIDENCE = 'VERDICT-EVIDENCE-SENTINEL-8c21';

/** Fails an answer that does not say `done`, with feedback and evidence that are private content. */
function judge(name: string, version = '1'): Validator {
  return {
    identity: { name, version },
    determinism: 'deterministic',
    validate: ({ result }): ValidatorOutcome =>
      result.content.includes('done')
        ? { kind: 'pass', evidence: [{ source: name, detail: { said: result.content } }] }
        : {
            kind: 'fail',
            feedback: FEEDBACK,
            evidence: [{ source: name, detail: { saw: EVIDENCE } }],
            retryable: true,
          },
  };
}

const GOAL = {
  agentName: 'worker',
  prompt: 'work',
  identity: { name: 'goal', version: '1' },
  validator: { name: 'judge', version: '1' },
  bounds: { maximumAttempts: 1, maximumTotalSteps: 100 },
};

type Serve = {
  readonly generate?: Parameters<typeof workerAgent>[0];
  readonly validators?: readonly Validator[];
  readonly plugins?: NonNullable<Parameters<typeof openBureau>[0]>['bureauOptions'];
  readonly storage?: MemoryStorage;
  readonly durableHistory?: boolean;
};

async function serve(options: Serve = {}): Promise<OpenedBureau> {
  const generate = options.generate ?? answering('not yet');
  const opened = await openBureau({
    agents: { worker: workerAgent(generate) },
    a2aAgents: ['worker'],
    generate,
    validators: options.validators ?? [judge('judge')],
    ...(options.plugins === undefined ? {} : { bureauOptions: options.plugins }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.durableHistory === true ? { durableHistory: true } : {}),
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

async function create(
  opened: OpenedBureau,
  key: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const body = await rpc(
    opened.handler,
    'bureau.goals.create',
    { ...GOAL, idempotencyKey: 'verdict-goal', ...overrides },
    key,
  );
  expect(body.error).toBeUndefined();
  return (body.result!['goal'] as { goalRunId: string }).goalRunId;
}

async function judged(opened: OpenedBureau, goalRunId: string, attemptIndex = 0): Promise<void> {
  await pollUntil(async () => {
    const goal = await opened.bureau.goals.get(goalRunId);
    return goal?.attempts[attemptIndex]?.validation !== undefined;
  });
}

async function ended(opened: OpenedBureau, goalRunId: string): Promise<void> {
  await pollUntil(async () => {
    const goal = await opened.bureau.goals.get(goalRunId);
    return goal !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(goal.status);
  });
}

const verdict = (opened: OpenedBureau, key: string, goalRunId: string, attemptIndex = 0) =>
  rpc(opened.handler, 'bureau.goals.verdict', { goalRunId, attemptIndex }, key);

describe('bureau.goals.verdict is served and described', () => {
  it('is a read-only goal operation, listed with the others', () => {
    expect(bureauGoalsOperations).toContain(goalsVerdictOperation);
    expect(goalsVerdictOperation.destructive).toBe(false);
    expect(goalsVerdictOperation.description?.length ?? 0).toBeGreaterThan(40);
  });
});

describe('the owner reads a verdict', () => {
  it('returns a failed attempt’s feedback and evidence, what judged it, and when', async () => {
    const opened = await serve();
    const goalRunId = await create(opened, 'alice-key');
    await ended(opened, goalRunId);

    const body = await verdict(opened, 'alice-key', goalRunId);

    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({
      goalRunId,
      attemptId: expect.any(String),
      attemptIndex: 0,
      outcome: 'fail',
      feedback: FEEDBACK,
      retryable: true,
      evidence: [{ source: 'judge', detail: { saw: EVIDENCE } }],
      reason: null,
      error: null,
      validator: { name: 'judge', version: '1' },
      configuration: null,
      judgedBy: {
        validator: { name: 'judge', version: '1' },
        source: { kind: 'bureau', name: BUREAU_PLUGIN_NAME, version: BUREAU_VERSION },
        configuration: null,
      },
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    });
  });

  it('keeps the evidence out of the goal’s own view, and the feedback out of every view but the owner’s', async () => {
    const opened = await serve();
    const goalRunId = await create(opened, 'alice-key');
    await ended(opened, goalRunId);

    const view = await rpc(opened.handler, 'bureau.goals.get', { goalRunId }, 'alice-key');
    expect(JSON.stringify(view)).not.toContain(EVIDENCE);
    // The owner's `get` carries each attempt's feedback (COR-2425), for the goal's page.
    expect(view.result).toMatchObject({
      attempts: [{ attemptIndex: 0, feedback: FEEDBACK }],
    });

    // Neither a holder of every scope nor anyone else reads it: only the owner does.
    for (const key of ['operator-key', 'goals-reader-key']) {
      const other = await rpc(opened.handler, 'bureau.goals.get', { goalRunId }, key);
      expect(other.error, key).toBeUndefined();
      expect(JSON.stringify(other), key).not.toContain(FEEDBACK);
      expect(JSON.stringify(other), key).not.toContain(EVIDENCE);
    }
    const listed = await rpc(opened.handler, 'bureau.goals.list', {}, 'alice-key');
    expect(JSON.stringify(listed)).not.toContain(FEEDBACK);
  });

  it('carries a pass’s reason from the validator to the record, the owner’s view and the verdict, and to no one else (COR-2425, row 67v)', async () => {
    const REASON = 'PASS-REASON-SENTINEL-61af';
    const passing: Validator = {
      identity: { name: 'judge', version: '1' },
      determinism: 'deterministic',
      validate: (): ValidatorOutcome => ({ kind: 'pass', evidence: [], reason: REASON }),
    };
    const opened = await serve({ validators: [passing] });
    const goalRunId = await create(opened, 'alice-key');
    await ended(opened, goalRunId);

    // The record: what the validator said, kept on the attempt's verdict.
    const record = await opened.bureau.goals.get(goalRunId);
    expect(record?.attempts[0]?.validation?.outcome).toEqual({
      kind: 'pass',
      evidence: [],
      reason: REASON,
    });
    // The owner's view of the goal.
    const own = await rpc(opened.handler, 'bureau.goals.get', { goalRunId }, 'alice-key');
    expect(own.result).toMatchObject({
      status: 'succeeded',
      attempts: [{ attemptIndex: 0, status: 'passed', reason: REASON, feedback: null }],
    });
    // The verdict, which is content.
    const read = await verdict(opened, 'alice-key', goalRunId);
    expect(read.result).toMatchObject({ outcome: 'pass', reason: REASON });
    // Owner-only on the goal's view, exactly like a missed check's feedback: no scope widens it.
    for (const key of ['operator-key', 'goals-reader-key', 'goals-content-key']) {
      const other = await rpc(opened.handler, 'bureau.goals.get', { goalRunId }, key);
      if (other.error !== undefined) continue;
      expect(JSON.stringify(other), key).not.toContain(REASON);
      for (const attempt of other.result!['attempts'] as Array<Record<string, unknown>>) {
        expect(attempt, key).not.toHaveProperty('reason');
      }
    }
    const listed = await rpc(opened.handler, 'bureau.goals.list', {}, 'alice-key');
    expect(JSON.stringify(listed)).not.toContain(REASON);
  });

  it('reads null for the reason of a pass whose validator said nothing', async () => {
    const opened = await serve({ generate: answering('done') });
    const goalRunId = await create(opened, 'alice-key');
    await ended(opened, goalRunId);

    const own = await rpc(opened.handler, 'bureau.goals.get', { goalRunId }, 'alice-key');
    expect(own.result).toMatchObject({
      attempts: [{ attemptIndex: 0, status: 'passed', reason: null }],
    });
    const read = await verdict(opened, 'alice-key', goalRunId);
    expect(read.result).toMatchObject({ outcome: 'pass', reason: null });
  });
});

describe('who else may read a verdict', () => {
  it('refuses a caller holding only bureau.goals:read, as a missing goal is, and allows bureau.goals:content', async () => {
    const opened = await serve();
    const goalRunId = await create(opened, 'alice-key');
    await ended(opened, goalRunId);

    const readOnly = await verdict(opened, 'goals-reader-key', goalRunId);
    const missing = await verdict(opened, 'goals-reader-key', 'no-such-goal');
    expect(readOnly.error?.data?.httpStatus).toBe(404);
    expect(JSON.stringify(readOnly.error).replaceAll(goalRunId, '<id>')).toBe(
      JSON.stringify(missing.error).replaceAll('no-such-goal', '<id>'),
    );
    expect(JSON.stringify(readOnly)).not.toContain(FEEDBACK);

    const stranger = await verdict(opened, 'bob-key', goalRunId);
    expect(stranger.error?.data?.httpStatus).toBe(404);
    const writer = await verdict(opened, 'goals-writer-key', goalRunId);
    expect(writer.error?.data?.httpStatus).toBe(404);

    const allowed = await verdict(opened, 'goals-content-key', goalRunId);
    expect(allowed.error).toBeUndefined();
    expect(allowed.result).toMatchObject({ outcome: 'fail', feedback: FEEDBACK });
  });
});

describe('an attempt with nothing to read', () => {
  it('tells an attempt that does not exist from one with no verdict yet, both as NotFound', async () => {
    const opened = await serve({ generate: hangUntilAborted });
    const goalRunId = await create(opened, 'alice-key');
    await pollUntil(async () => {
      const goal = await opened.bureau.goals.get(goalRunId);
      return goal?.attempts.length === 1;
    });

    const running = await verdict(opened, 'alice-key', goalRunId, 0);
    const absent = await verdict(opened, 'alice-key', goalRunId, 7);

    expect(running.error?.data?.httpStatus).toBe(404);
    expect(running.error?.data).toMatchObject({ resource: 'verdict' });
    expect(absent.error?.data?.httpStatus).toBe(404);
    expect(absent.error?.data).toMatchObject({ resource: 'attempt' });
    expect(JSON.stringify(absent.error)).not.toEqual(JSON.stringify(running.error));
  });
});

describe('what judged an attempt', () => {
  it('stores and publishes a plugin validator’s plugin, by name and version', async () => {
    const checks = definePlugin({
      name: 'checks',
      version: '2.3.4',
      description: 'Contributes a validator.',
      setup: () => ({ validators: [judge('tidy')] }),
    });
    const opened = await serve({
      generate: answering('done'),
      validators: [],
      plugins: {
        plugins: [{ descriptor: checks, source: 'package', location: '@example/checks' }],
      },
      durableHistory: true,
    });
    const goalRunId = await create(opened, 'alice-key', {
      validator: { name: 'checks:tidy', version: '1' },
    });
    await ended(opened, goalRunId);
    const judgedBy = {
      validator: { name: 'checks:tidy', version: '1' },
      source: { kind: 'plugin', name: 'checks', version: '2.3.4' },
    } as const;

    const stored = await opened.bureau.goals.get(goalRunId);
    expect(stored?.attempts[0]?.validation?.judgedBy).toEqual({ ...judgedBy, configuration: null });
    const page = await opened.bureau.goals.events(goalRunId);
    if (!('events' in page)) throw new Error(`expected an event page, got ${JSON.stringify(page)}`);
    const validated = page.events.find((event) => event.kind === 'goal.attempt.validated');
    expect(validated?.payload).toMatchObject({ judgedBy });
    const read = await verdict(opened, 'alice-key', goalRunId);
    expect(read.result).toMatchObject({
      outcome: 'pass',
      judgedBy: { ...judgedBy, configuration: null },
    });
  });

  it('names what judged attempt 0 after the goal’s validator changes and attempt 1 is judged', async () => {
    const parked = createLatch();
    let calls = 0;
    const opened = await serve({
      // The first answer fails the first validator at once; the second waits to be released.
      generate: async (request) => {
        calls += 1;
        if (calls === 2) await parked.promise;
        return answering(calls === 1 ? 'not yet' : 'done')(request);
      },
      validators: [judge('first'), judge('second')],
    });
    const goalRunId = await create(opened, 'alice-key', {
      validator: { name: 'first', version: '1' },
      bounds: { maximumAttempts: 3, maximumTotalSteps: 100 },
      retryPolicy: { retryOn: ['validator-fail-retryable'] },
    });
    await judged(opened, goalRunId, 0);

    for (;;) {
      const goal = await opened.bureau.goals.get(goalRunId);
      const outcome = await opened.bureau.goals.update(goalRunId, {
        expectedRevision: goal!.revision,
        validator: { name: 'second', version: '1' },
      });
      if (outcome.outcome !== 'stale-revision') {
        expect(outcome.outcome).toBe('updated');
        break;
      }
    }
    parked.release();
    await ended(opened, goalRunId);

    const first = await verdict(opened, 'alice-key', goalRunId, 0);
    const second = await verdict(opened, 'alice-key', goalRunId, 1);
    expect(first.result).toMatchObject({
      outcome: 'fail',
      validator: { name: 'first', version: '1' },
      judgedBy: { validator: { name: 'first', version: '1' } },
    });
    expect(second.result).toMatchObject({
      outcome: 'pass',
      validator: { name: 'second', version: '1' },
      judgedBy: { validator: { name: 'second', version: '1' } },
    });
    const stored = await opened.bureau.goals.get(goalRunId);
    expect(stored?.validator).toEqual({ name: 'second', version: '1' });
  });

  it('reads a record written before judgedBy as judgedBy null', async () => {
    const storage = new MemoryStorage();
    const inspection = await inspect(storage);
    const record = pendingGoal({
      principal: OWNER.alice,
      validator: { name: 'judge', version: '1' },
    });
    await seedRetrying(inspection, record);
    const old: GoalState | undefined = await inspection.store.get(record.goalRunId);
    expect(old?.attempts[0]?.validation).toBeDefined();
    expect(old?.attempts[0]?.validation?.judgedBy).toBeUndefined();

    const opened = await serve({ storage, generate: hangUntilAborted });
    const body = await verdict(opened, 'alice-key', record.goalRunId);

    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({
      outcome: 'fail',
      feedback: 'say done',
      validator: { name: 'judge', version: '1' },
      configuration: null,
      judgedBy: null,
    });
  });
});

const witnesses = workspaceConformanceLedger('management/goals-verdict-operation.test.ts');

describe('workspace privacy for verdicts', () => {
  it('serves a verdict to the goal’s owner alone, whatever scopes the others hold', async () => {
    const opened = await openWorkspacePrivacyBureau({
      agents: { worker: workerAgent(answering('not yet')) },
      a2aAgents: ['worker'],
      generate: answering('not yet'),
      validators: [judge('judge')],
    });
    cleanups.push(() => opened.dispose());
    const created = await workspacePrivacyCall(opened, 'owner', 'bureau.goals.create', {
      ...GOAL,
      idempotencyKey: 'workspace-verdict-goal',
    });
    const goal = created.body?.result?.['goal'] as { goalRunId?: string } | undefined;
    if (goal?.goalRunId === undefined) throw new Error('Expected a private goal');
    await ended(opened, goal.goalRunId);

    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const response = await workspacePrivacyCall(opened, actor, 'bureau.goals.verdict', {
        goalRunId: goal.goalRunId,
        attemptIndex: 0,
      });
      witnesses.observeWire('bureau.goals.verdict', actor, response);
    }
  });
});

it('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
