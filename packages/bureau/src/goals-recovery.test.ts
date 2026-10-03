/**
 * COR-851 — what a durable goal does across a process restart.
 *
 * Bureau A runs a goal until a precise point and then "dies": its generate or
 * validator never resolves and it is deliberately not disposed. Bureau B boots
 * over the same SQLite file, and everything it knows about the goal it learns
 * from storage. Records a dead process could have left behind at points no
 * public call can stop at (between claiming an attempt's run and starting it,
 * in `retrying`, with a controller that cannot reason about its record) are
 * written directly through the goal store, which is the only thing that ever
 * writes them.
 */
import { readGenerationProfile } from '@lostgradient/operative';
import { KEYS } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { MAXIMUM_CONTROLLER_RESTARTS } from './goal-recovery';
import { createGoalState, goalRecordKey, type GoalState } from './goal-state';
import {
  CHECK,
  createCheckValidator,
  createDiagnostics,
  createLatch,
  createTestDatabase,
  durableIds,
  goalRequest,
  goalStatus,
  hangForever,
  hangUntilAborted,
  lastPromptOf,
  pollUntil,
  TERMINAL_STATUSES,
  type TestDatabase,
  workerAgent,
  workflowStatus,
} from './testing/goal-fixtures.test-support';
import {
  bootOver,
  inspect,
  pendingGoal,
  seedPoisoned,
  seedRetrying,
  seedRunning,
} from './testing/goal-recovery-fixtures.test-support';
import type { Bureau } from './types';

const cleanups: Array<() => Promise<void> | void> = [];
let database: TestDatabase = createTestDatabase('unset');

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  await database.remove();
});

async function track<T extends Bureau>(bureau: T): Promise<T> {
  cleanups.push(() => bureau.dispose());
  return bureau;
}

async function inspection() {
  const view = await inspect(database.path);
  cleanups.push(() => view.dispose());
  return view;
}

async function status(bureau: Bureau, wanted: GoalState['status'], goalRunId = 'g1') {
  const reached = await pollUntil(async () => (await goalStatus(bureau, goalRunId)) === wanted);
  expect(reached).toBe(true);
}

async function ended(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  if (latest === undefined) throw new Error(`goal ${goalRunId} never ended`);
  return latest;
}

/** Starts a goal in a bureau whose attempt never finishes, and waits for it to be running. */
async function crashWhileRunning(
  request: Parameters<Bureau['goals']['create']>[0] = goalRequest(),
) {
  const diagnostics = createDiagnostics();
  const { bureau } = await bootOver({
    path: database.path,
    agents: { worker: workerAgent(hangForever) },
    validators: [createCheckValidator()],
    diagnostics,
  });
  cleanups.push(() => bureau.dispose());
  await bureau.goals.create(request);
  await status(bureau, 'running');
  return bureau;
}

describe('a goal across a process restart', () => {
  it('finishes a goal whose attempt was running when the process died, in exactly one attempt', async () => {
    database = createTestDatabase('running');
    const dead = await crashWhileRunning(
      goalRequest({ bounds: { maximumAttempts: 3, maximumTotalDurationMs: 600_000 } }),
    );
    const view = await inspection();

    let steps = 0;
    const { bureau, diagnostics } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    const report = await bureau.waitForRecovery?.();

    // Recovery neither cancelled the controller as an unowned run nor reported a failure.
    expect(report).toMatchObject({ outcome: 'clean', perRunFailures: [] });
    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', terminalReason: 'validator-passed' });
    expect(goal.attempts.map((attempt) => [attempt.runId, attempt.status])).toEqual([
      ['goal-g1-a0', 'passed'],
    ]);
    expect(goal.controllerRestarts).toBe(0);
    expect(steps).toBe(1);
    expect(await workflowStatus(bureau, 'goal:g1')).toBe('completed');
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('completed');
    expect(await durableIds(bureau, 'goal')).toEqual(
      expect.arrayContaining(['goal:g1', 'goal-g1-a0']),
    );
    const goalWorkflows = await durableIds(bureau, 'goal');
    expect(goalWorkflows).toHaveLength(2);
    // A goal controller has no services, so Weft wrote no marker for it.
    expect(await view.storage.get(KEYS.workflowHasServices('goal:g1'))).toBeNull();
    expect(diagnostics.scope('goals')).toEqual([]);

    // The dead process's late writes are stale updates: the goal does not move.
    await dead.dispose();
    await pollUntil(() => false, 10);
    expect(await bureau.goals.get('g1')).toEqual(goal);
  });

  it('keeps a goal parked on its attempt, then finishes it when the attempt ends', async () => {
    database = createTestDatabase('parked');
    await crashWhileRunning(
      goalRequest({ bounds: { maximumAttempts: 3, maximumTotalDurationMs: 600_000 } }),
    );
    const release = createLatch();
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(async () => {
          await release.promise;
          return { content: 'done', toolCalls: [] };
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    // Still waiting, and recovery knows what on.
    expect(await goalStatus(bureau, 'g1')).toBe('running');
    expect(await bureau.goals.active('g1')).toMatchObject({
      kind: 'attempt',
      runId: 'goal-g1-a0',
      runStatus: 'running',
    });
    expect(await bureau.goals.recover('g1')).toEqual({
      goals: [{ goalRunId: 'g1', outcome: 'running', attempt: 'watching' }],
      failures: [],
    });

    release.release();
    const goal = await ended(bureau);
    expect(goal.status).toBe('succeeded');
  });

  it('re-runs a validator that was executing when the process died, and commits one decision', async () => {
    database = createTestDatabase('evaluating');
    const stuck = createLatch();
    const { bureau: dead } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator({ before: () => stuck.promise })],
    });
    cleanups.push(() => dead.dispose());
    await dead.goals.create(goalRequest());
    await status(dead, 'evaluating');

    const validatorCalls: Parameters<ReturnType<typeof createCheckValidator>['validate']>[0][] = [];
    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator({ calls: validatorCalls })],
    });
    await track(bureau);

    const goal = await ended(bureau);
    expect(goal.status).toBe('succeeded');
    expect(goal.attempts).toHaveLength(1);
    expect(goal.attempts[0]?.validation).toMatchObject({
      decisionId: 'g1:a0:decision',
      outcome: { kind: 'pass' },
    });
    expect(validatorCalls).toHaveLength(1);
    // The attempt's run had already finished, so it is never run again.
    expect(steps).toBe(0);

    stuck.release();
    await pollUntil(() => false, 10);
    expect(await bureau.goals.get('g1')).toEqual(goal);
  });

  it('starts the next attempt of a goal that died in retrying, carrying the feedback it recorded', async () => {
    database = createTestDatabase('retrying');
    const prompts: string[] = [];
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(({ conversation }) => {
          prompts.push(lastPromptOf(conversation));
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    await seedRetrying(view);
    expect(await goalStatus(bureau, 'g1')).toBe('retrying');

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started' }],
      failures: [],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', usage: { attempts: 2 } });
    expect(goal.attempts.map((attempt) => [attempt.runId, attempt.status])).toEqual([
      ['goal-g1-a0', 'failed'],
      ['goal-g1-a1', 'passed'],
    ]);
    expect(prompts).toEqual(['say done']);
  });

  it('does not run again a goal that had already ended, whether it succeeded or was canceled', async () => {
    database = createTestDatabase('terminal');
    let firstSteps = 0;
    const { bureau: first } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          firstSteps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
        hanging: workerAgent(hangUntilAborted, 'hanging'),
      },
      validators: [createCheckValidator()],
    });
    cleanups.push(() => first.dispose());
    await first.goals.create(goalRequest());
    await first.goals.create(goalRequest({ goalRunId: 'g2', agentName: 'hanging' as 'worker' }));
    const succeeded = await ended(first, 'g1');
    await status(first, 'running', 'g2');
    await first.goals.cancel('g2');
    const canceled = await ended(first, 'g2');
    expect(firstSteps).toBe(1);

    let secondSteps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          secondSteps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
        hanging: workerAgent(hangUntilAborted, 'hanging'),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    expect(await bureau.goals.get('g1')).toEqual(succeeded);
    expect(await bureau.goals.get('g2')).toEqual(canceled);
    expect(await bureau.goals.recover()).toEqual({ goals: [], failures: [] });
    expect(await bureau.goals.recover('g1')).toEqual({
      goals: [{ goalRunId: 'g1', outcome: 'already-terminal' }],
      failures: [],
    });
    expect(await bureau.goals.recover('missing')).toEqual({
      goals: [{ goalRunId: 'missing', outcome: 'not-found' }],
      failures: [],
    });
    expect(secondSteps).toBe(0);
  });

  it('leaves a goal interrupted by shutdown unfinished for the next process, never failed or canceled', async () => {
    database = createTestDatabase('shutdown');
    const { bureau: first } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await first.goals.create(goalRequest());
    await status(first, 'running');
    const report = await first.shutdown();
    // Nothing the goal owns is left unresolved by the shutdown.
    expect(report).toMatchObject({ unresolved: 0, failed: 0 });

    const view = await inspection();
    const left = await view.store.get('g1');
    expect(left?.status).toBe('running');
    expect(left?.cancellation).toBeUndefined();

    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    expect(await ended(bureau)).toMatchObject({ status: 'succeeded' });
  });
});

describe('a goal when the validator it names is no longer registered', () => {
  it.each([
    { label: 'removed', validators: [], code: 'VALIDATOR_MISSING' },
    {
      label: 're-versioned',
      validators: [createCheckValidator({ version: '2' })],
      code: 'VALIDATOR_VERSION_MISMATCH',
    },
  ])(
    'ends the attempt unavailable, explicitly, when it was $label',
    async ({ validators, code }) => {
      database = createTestDatabase('validator');
      const stuck = createLatch();
      const { bureau: dead } = await bootOver({
        path: database.path,
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators: [createCheckValidator({ before: () => stuck.promise })],
      });
      cleanups.push(() => dead.dispose());
      await dead.goals.create(goalRequest());
      await status(dead, 'evaluating');

      const { bureau } = await bootOver({
        path: database.path,
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators,
      });
      await track(bureau);

      const goal = await ended(bureau);
      expect(goal).toMatchObject({
        status: 'failed',
        terminalReason: 'validator-infrastructure-error',
      });
      const outcome = goal.attempts[0]?.validation?.outcome;
      expect(outcome).toMatchObject({ kind: 'unavailable', error: { kind: 'load', code } });
      expect(goal.attempts[0]?.validation?.identity).toEqual(CHECK);
    },
  );
});

describe('a cancellation that a process died in the middle of', () => {
  it('is completed by the next process once the marker is durable', async () => {
    database = createTestDatabase('marker');
    await crashWhileRunning();
    const view = await inspection();
    // The control plane wrote the marker and died before it could do anything else.
    await view.store.requestCancellation(
      'g1',
      { requestedAt: '2026-10-02T12:00:00.000Z', reason: 'operator' },
      '2026-10-02T12:00:00.000Z',
    );

    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await track(bureau);

    const goal = await ended(bureau);
    expect(goal).toMatchObject({
      status: 'canceled',
      terminalReason: 'goal-canceled',
      cancellation: { reason: 'operator' },
    });
    expect(goal.attempts.map((attempt) => attempt.status)).toEqual(['aborted']);
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
  });

  it('is completed when the controller workflow was cancelled out from under its goal', async () => {
    database = createTestDatabase('outside');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(hangUntilAborted) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.goals.create(goalRequest());
    await status(bureau, 'running');

    // Someone cancels the controller's workflow directly, not through the goal.
    expect(await bureau.cancelDurableRun('goal:g1')).toEqual({ status: 'requested' });
    expect(await goalStatus(bureau, 'g1')).toBe('running');

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'canceled' }],
    });
    const goal = await bureau.goals.get('g1');
    expect(goal).toMatchObject({
      status: 'canceled',
      terminalReason: 'goal-canceled',
      cancellation: { reason: 'The goal controller was cancelled.' },
    });
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
  });
});

describe('a controller left running in a superseded process', () => {
  it('cannot move a goal that was canceled in the process that replaced it', async () => {
    database = createTestDatabase('stale');
    const supersededVerdict = createLatch();
    const verdictDelivered = createLatch();
    const { bureau: superseded } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [
        createCheckValidator({
          before: async () => {
            await supersededVerdict.promise;
            verdictDelivered.release();
          },
        }),
      ],
    });
    cleanups.push(() => superseded.dispose());
    await superseded.goals.create(goalRequest());
    await status(superseded, 'evaluating');

    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator({ before: () => new Promise(() => {}) })],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    expect(await bureau.goals.cancel('g1')).toMatchObject({ outcome: 'canceled' });
    const canceled = await bureau.goals.get('g1');

    // The superseded controller's verdict arrives late and passes. Its commit is refused.
    supersededVerdict.release();
    await verdictDelivered.promise;
    await pollUntil(() => false, 20);

    expect(await bureau.goals.get('g1')).toEqual(canceled);
    expect(canceled).toMatchObject({ status: 'canceled', terminalReason: 'goal-canceled' });
  });
});

describe('the attempt behind a running goal', () => {
  it('is re-sent to a controller that never heard it end, once the run is found finished', async () => {
    database = createTestDatabase('lost-forwarder');
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })),
        planner: workerAgent(hangUntilAborted, 'planner'),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();

    // The attempt's run finished while nobody was forwarding it: it is a durable
    // run under the attempt's deterministic id, and the goal's record says it was running.
    bureau.run('planner', 'plan');
    await pollUntil(async () => {
      const runs = await durableIds(bureau, 'agent-run-');
      return runs.length === 1;
    });
    const [parentRunId] = await durableIds(bureau, 'agent-run-');
    await bureau.children.dispatch({
      parentRunId: parentRunId!,
      agentName: 'worker',
      input: 'work',
      childRunId: 'goal-g1-a0',
    });
    await pollUntil(async () => (await workflowStatus(bureau, 'goal-g1-a0')) === 'completed');
    const view = await inspection();
    await seedRunning(view);

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started', attempt: 'signal-resent' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts).toHaveLength(1);
  });

  it('is started again when the controller recorded it as running but its run was never created', async () => {
    database = createTestDatabase('never-created');
    let steps = 0;
    const { bureau } = await bootOver({
      path: database.path,
      agents: {
        worker: workerAgent(() => {
          steps += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    // The start returned its handle and the controller committed `running`, then the
    // process died before the run's workflow existed.
    const view = await inspection();
    await seedRunning(view);
    expect(await workflowStatus(bureau, 'goal-g1-a0')).toBeUndefined();

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started', attempt: 'run-started' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts.map((attempt) => attempt.runId)).toEqual(['goal-g1-a0']);
    expect(steps).toBe(1);
  });

  it('is started from the claim a start left behind when it died before the workflow existed', async () => {
    database = createTestDatabase('claim');
    let steps = 0;
    const worker = workerAgent(() => {
      steps += 1;
      return Promise.resolve({ content: 'done', toolCalls: [] });
    });
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    await view.claimRun('goal-g1-a0', {
      agentName: 'worker',
      definitionRevision: readGenerationProfile(worker).revision,
      input: 'work',
    });
    await view.store.create(pendingGoal());
    expect(await bureau.getDurableRun('goal-g1-a0')).toBeNull();

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded' });
    expect(goal.attempts.map((attempt) => attempt.runId)).toEqual(['goal-g1-a0']);
    expect(steps).toBe(1);
  });
});

describe('two bureaus recovering the same goal', () => {
  it('start one controller and run one attempt between them', async () => {
    database = createTestDatabase('duplicate');
    let steps = 0;
    const agents = {
      worker: workerAgent(() => {
        steps += 1;
        return Promise.resolve({ content: 'done', toolCalls: [] });
      }),
    };
    const first = await bootOver({
      path: database.path,
      agents,
      validators: [createCheckValidator()],
    });
    const second = await bootOver({
      path: database.path,
      agents,
      validators: [createCheckValidator()],
    });
    await track(first.bureau);
    await track(second.bureau);
    await first.bureau.waitForRecovery?.();
    await second.bureau.waitForRecovery?.();
    const view = await inspection();
    await view.store.create(pendingGoal());

    const reports = await Promise.all([
      first.bureau.goals.recover('g1'),
      second.bureau.goals.recover('g1'),
    ]);

    const outcomes = reports.flatMap((report) => report.goals.map((entry) => entry.outcome));
    expect(outcomes.filter((outcome) => outcome === 'started')).toHaveLength(1);
    const goal = await ended(first.bureau);
    expect(goal).toMatchObject({ status: 'succeeded', controllerRestarts: 0 });
    expect(goal.attempts).toHaveLength(1);
    expect(steps).toBe(1);
    expect(await durableIds(first.bureau, 'goal:')).toEqual(['goal:g1']);
  });
});

describe('a create that died between recording the goal and starting its controller', () => {
  it('is healed by repeating it, which starts the controller and finishes the goal', async () => {
    database = createTestDatabase('repeat-create');
    const { bureau } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    // The record is there; the process died before the controller was started.
    await view.store.create(pendingGoal());
    expect(await workflowStatus(bureau, 'goal:g1')).toBeUndefined();

    const repeated = await bureau.goals.create(goalRequest());

    expect(repeated).toMatchObject({
      outcome: 'existing',
      controller: { status: 'started' },
      goal: { goalRunId: 'g1' },
    });
    expect(await ended(bureau)).toMatchObject({ status: 'succeeded' });
  });
});

describe('a controller that ends abnormally while its goal is unfinished', () => {
  async function bootForPoison() {
    database = createTestDatabase('poison');
    const { bureau, diagnostics } = await bootOver({
      path: database.path,
      agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
      validators: [createCheckValidator()],
    });
    await track(bureau);
    await bureau.waitForRecovery?.();
    const view = await inspection();
    return { bureau, diagnostics, view };
  }

  const controllerFailed = (bureau: Bureau) =>
    pollUntil(async () => (await workflowStatus(bureau, 'goal:g1')) === 'failed');

  it('restarts it from the record, up to a bound, then reports the goal unrecoverable', async () => {
    const { bureau, view } = await bootForPoison();
    await seedPoisoned(view);

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'started' }],
    });
    for (let restart = 1; restart <= MAXIMUM_CONTROLLER_RESTARTS; restart += 1) {
      expect(await controllerFailed(bureau)).toBe(true);
      const report = await bureau.goals.recover('g1');
      expect(report.goals[0]).toMatchObject({ goalRunId: 'g1', outcome: 'restarted' });
      const restarted = await bureau.goals.get('g1');
      expect(restarted?.controllerRestarts).toBe(restart);
    }

    expect(await controllerFailed(bureau)).toBe(true);
    const past = await bureau.goals.recover('g1');
    expect(past.goals[0]).toMatchObject({ goalRunId: 'g1', outcome: 'unrecoverable' });
    // No terminal reason is invented: the goal is exactly as it was.
    const goal = await bureau.goals.get('g1');
    expect(goal).toMatchObject({
      status: 'running',
      controllerRestarts: MAXIMUM_CONTROLLER_RESTARTS,
    });
    expect(goal?.terminalReason).toBeUndefined();
  });

  it('finishes the goal once the restarted controller can read its record', async () => {
    const { bureau, view } = await bootForPoison();
    await seedPoisoned(view);
    await bureau.goals.recover('g1');
    expect(await controllerFailed(bureau)).toBe(true);

    // Repaired: the record is back to the state the first attempt starts from.
    const poisoned = await view.store.get('g1');
    const repaired = createGoalState({
      goalRunId: 'g1',
      identity: pendingGoal().identity,
      objective: pendingGoal().objective,
      validator: CHECK,
      conversationPolicy: { kind: 'continue' },
      retryPolicy: pendingGoal().retryPolicy,
      bounds: pendingGoal().bounds,
      now: '2026-10-02T12:00:00.000Z',
    });
    await view.overwrite({ ...repaired, revision: (poisoned?.revision ?? 0) + 1 });
    expect(await view.kv.get(goalRecordKey('g1'))).not.toBeNull();

    expect(await bureau.goals.recover('g1')).toMatchObject({
      goals: [{ goalRunId: 'g1', outcome: 'restarted' }],
    });

    const goal = await ended(bureau);
    expect(goal).toMatchObject({ status: 'succeeded', controllerRestarts: 1 });
    expect(goal.attempts).toHaveLength(1);
  });
});
