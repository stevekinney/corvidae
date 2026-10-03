/**
 * COR-851 — `bureau.goals`: the control plane over a durable goal, end to end
 * over a real `createBureau`.
 *
 * What survives a restart is in `goals-recovery.test.ts`; this file covers the
 * operations themselves: create (and its refusals), get, list, active, cancel,
 * and close.
 */
import {
  createAgent,
  OPERATIVE_RESOLVE_RUN_OPTIONS,
  type RunnableAgent,
  stopWhen,
} from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { GoalState } from './goal-state';
import {
  cancelUntilSettled,
  CHECK,
  createCheckValidator,
  createDiagnostics,
  createLatch,
  GOAL_BOUNDS,
  goalRequest,
  goalStatus,
  hangUntilAborted,
  lastPromptOf,
  listedIds,
  pollUntil,
  TERMINAL_STATUSES,
  workerAgent,
  workflowStatus,
} from './testing/goal-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';

const open: Bureau[] = [];

afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot(
  options: Parameters<typeof createBureau>[0],
  diagnostics = createDiagnostics(),
) {
  const bureau = await createBureau({
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: diagnostics.onDiagnostic,
    ...options,
  });
  open.push(bureau);
  return { bureau, diagnostics };
}

async function finished(bureau: Bureau, goalRunId = 'g1'): Promise<GoalState> {
  let latest: GoalState | undefined;
  await pollUntil(async () => {
    latest = await bureau.goals.get(goalRunId);
    return latest !== undefined && (TERMINAL_STATUSES as readonly string[]).includes(latest.status);
  });
  if (latest === undefined) throw new Error(`goal ${goalRunId} never ended`);
  return latest;
}

async function reaches(bureau: Bureau, status: GoalState['status'], goalRunId = 'g1') {
  const reached = await pollUntil(async () => (await goalStatus(bureau, goalRunId)) === status);
  expect(reached).toBe(true);
}

describe('bureau.goals', () => {
  it('fails startup when two validators are registered under one name and version', async () => {
    const error = await rejectionOf(
      createBureau({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator(), createCheckValidator()],
        storage: { type: 'memory' },
        durableExecution: true,
      }),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('"check@1" is registered more than once');
  });

  it('runs a goal across a retry and exposes it through get, list, active, and close', async () => {
    const prompts: string[] = [];
    let calls = 0;
    const validatorCalls: Parameters<ReturnType<typeof createCheckValidator>['validate']>[0][] = [];
    const { bureau, diagnostics } = await boot({
      agents: {
        worker: workerAgent(({ conversation }) => {
          calls += 1;
          prompts.push(lastPromptOf(conversation));
          return Promise.resolve({ content: calls === 1 ? 'nope' : 'done', toolCalls: [] });
        }),
      },
      validators: [createCheckValidator({ calls: validatorCalls })],
    });

    const created = await bureau.goals.create(goalRequest());
    expect(created).toMatchObject({
      outcome: 'created',
      controller: { status: 'started' },
      goal: { status: 'pending', transitionSeq: 0, controllerRestarts: 0 },
    });

    const goal = await finished(bureau);
    expect(goal).toMatchObject({
      status: 'succeeded',
      terminalReason: 'validator-passed',
      usage: { attempts: 2, steps: 2 },
      controllerRestarts: 0,
    });
    expect(goal.attempts.map((attempt) => [attempt.runId, attempt.status])).toEqual([
      ['goal-g1-a0', 'failed'],
      ['goal-g1-a1', 'passed'],
    ]);
    expect(goal.attempts[0]?.validation?.outcome).toMatchObject({
      kind: 'fail',
      feedback: 'say done',
    });
    // The retry's turn is the feedback alone, because its transcript holds the prompt.
    expect(prompts).toEqual(['work', 'say done']);
    expect(validatorCalls[1]?.history.map((attempt) => attempt.feedback)).toEqual(['say done']);
    expect(validatorCalls[1]?.result.content).toBe('done');

    expect(await bureau.goals.get('g1')).toEqual(goal);
    expect(await bureau.goals.list()).toEqual([goal]);
    expect(await bureau.goals.list({ status: 'failed' })).toEqual([]);
    expect(await bureau.goals.list({ status: ['failed', 'succeeded'] })).toEqual([goal]);
    expect(await bureau.goals.active('g1')).toBeUndefined();
    expect(await workflowStatus(bureau, 'goal:g1')).toBe('completed');

    const closed = await bureau.goals.close('g1');
    // The default retention keeps every checkpoint, so there is nothing to clean up.
    expect(closed).toMatchObject({
      outcome: 'closed',
      goal: { status: 'succeeded' },
      cleanup: { status: 'not-required' },
    });
    const closedAt = closed.outcome === 'closed' ? closed.goal.closedAt : undefined;
    expect(typeof closedAt).toBe('string');
    expect(await bureau.goals.close('g1')).toMatchObject({ outcome: 'closed', goal: { closedAt } });
    expect(await listedIds(bureau)).toEqual(['g1']);
    expect(diagnostics.scope('goals')).toEqual([]);
  });

  it('reports the attempt run and the validation execution while they are in flight', async () => {
    const attempt = createLatch();
    const validating = createLatch();
    const { bureau } = await boot({
      agents: {
        worker: workerAgent(async () => {
          await attempt.promise;
          return { content: 'done', toolCalls: [] };
        }),
      },
      validators: [createCheckValidator({ before: () => validating.promise })],
    });
    await bureau.goals.create(goalRequest());

    await reaches(bureau, 'running');
    expect(await bureau.goals.active('g1')).toMatchObject({
      kind: 'attempt',
      attemptId: 'g1:a0',
      attemptIndex: 0,
      runId: 'goal-g1-a0',
      runStatus: 'running',
    });
    attempt.release();

    await reaches(bureau, 'evaluating');
    expect(await bureau.goals.active('g1')).toMatchObject({
      kind: 'validation',
      attemptId: 'g1:a0',
      attemptIndex: 0,
      validator: CHECK,
    });
    validating.release();

    const ended = await finished(bureau);
    expect(ended.status).toBe('succeeded');
    expect(await bureau.goals.active('g1')).toBeUndefined();
  });

  describe('create', () => {
    it('is idempotent on a goal id and refuses a different request under it', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      const first = await bureau.goals.create(goalRequest());
      expect(first.outcome).toBe('created');

      const again = await bureau.goals.create(goalRequest());
      expect(again).toMatchObject({ outcome: 'existing', goal: { goalRunId: 'g1' } });
      const different = await bureau.goals.create(goalRequest({ prompt: 'something else' }));
      expect(different).toMatchObject({
        outcome: 'conflict',
        goal: { objective: { prompt: 'work' } },
      });
      expect(await bureau.goals.list()).toHaveLength(1);
    });

    it('does not show another principal the goal that its id collides with', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest({ principal: 'alice', prompt: 'private prompt' }));

      const intruder = await bureau.goals.create(
        goalRequest({ principal: 'mallory', prompt: 'private prompt' }),
      );
      const owner = await bureau.goals.create(
        goalRequest({ principal: 'alice', prompt: 'another prompt' }),
      );

      // It learns the id is taken, and nothing about what holds it.
      expect(intruder).toEqual({ outcome: 'conflict' });
      expect(owner).toMatchObject({
        outcome: 'conflict',
        goal: { objective: { prompt: 'private prompt' } },
      });
    });

    it('refuses a goal id that a signal could never be delivered under', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });

      expect(await bureau.goals.create(goalRequest({ goalRunId: 'g'.repeat(200) }))).toMatchObject({
        outcome: 'rejected',
        code: 'invalid-goal-run-id',
      });
      expect(await bureau.goals.create(goalRequest({ goalRunId: 'line\nbreak' }))).toMatchObject({
        outcome: 'rejected',
        code: 'invalid-goal-run-id',
      });
      expect(await bureau.goals.list()).toEqual([]);
    });

    it('refuses an empty goal id with the documented outcome rather than throwing', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });

      const created = await bureau.goals.create(goalRequest({ goalRunId: '' }));

      expect(created).toMatchObject({ outcome: 'rejected', code: 'invalid-goal-run-id' });
      expect(await bureau.goals.list()).toEqual([]);
    });

    it.each([
      {
        label: 'a fork-from-baseline policy with no baseline run',
        policy: { kind: 'fork-from-baseline' },
        instructions: undefined,
      },
      {
        label: 'a fresh-from-artifact policy with no instructions',
        policy: { kind: 'fresh-from-artifact', artifact: {} },
        instructions: undefined,
      },
      {
        label: 'a fresh-from-artifact policy whose artifact is not a handoff artifact',
        policy: { kind: 'fresh-from-artifact', artifact: { kind: 'handoff' } },
        instructions: 'approved instructions',
      },
    ] as const)('refuses $label, before writing anything', async ({ policy, instructions }) => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });

      const outcome = await bureau.goals.create(
        goalRequest({ conversationPolicy: policy as never, instructions }),
      );

      expect(outcome).toMatchObject({ outcome: 'rejected', code: 'invalid-configuration' });
      expect(await bureau.goals.list()).toEqual([]);
    });

    it('refuses a validator that is missing or registered at another version, before writing anything', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [
          createCheckValidator({ version: '2' }),
          createCheckValidator({ version: '3' }),
        ],
      });

      expect(
        await bureau.goals.create(goalRequest({ validator: { name: 'other', version: '1' } })),
      ).toMatchObject({
        outcome: 'rejected',
        code: 'validator-missing',
      });
      expect(await bureau.goals.create(goalRequest())).toMatchObject({
        outcome: 'rejected',
        code: 'validator-version-mismatch',
        availableVersions: ['2', '3'],
      });
      expect(await bureau.goals.list()).toEqual([]);
    });

    it('refuses an unknown agent, an agent that cannot run durably, and a configuration COR-638 rejects', async () => {
      const inProcessOnly: RunnableAgent<unknown, boolean> = {
        name: 'in-process',
        hasOutput: false,
        run: () => {
          throw new Error('never runs');
        },
      };
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted), 'in-process': inProcessOnly },
        validators: [createCheckValidator()],
      });
      const refused = (request: Parameters<typeof bureau.goals.create>[0]) =>
        bureau.goals.create(request);

      expect(await refused({ ...goalRequest(), agentName: 'nobody' })).toMatchObject({
        outcome: 'rejected',
        code: 'agent-not-found',
      });
      expect(await refused({ ...goalRequest(), agentName: 'in-process' })).toMatchObject({
        outcome: 'rejected',
        code: 'agent-not-durable',
      });
      expect(
        await refused(goalRequest({ bounds: { maximumAttempts: 0, maximumTotalSteps: 1 } })),
      ).toMatchObject({
        outcome: 'rejected',
        code: 'invalid-configuration',
      });
      expect(await refused(goalRequest({ bounds: { maximumAttempts: 2 } }))).toMatchObject({
        outcome: 'rejected',
        code: 'invalid-configuration',
      });
      expect(await refused(goalRequest({ prompt: 'x'.repeat(70_000) }))).toMatchObject({
        outcome: 'rejected',
        code: 'objective-too-large',
      });
      expect(await bureau.goals.list()).toEqual([]);
    });

    it('ends a goal that demands deterministic evidence from a stochastic validator before any attempt runs', async () => {
      let ran = false;
      const { bureau } = await boot({
        agents: {
          worker: workerAgent(() => {
            ran = true;
            return Promise.resolve({ content: 'done', toolCalls: [] });
          }),
        },
        validators: [createCheckValidator({ determinism: 'stochastic' })],
      });

      const created = await bureau.goals.create(
        goalRequest({ requireDeterministicValidation: true }),
      );

      expect(created).toMatchObject({
        outcome: 'created',
        controller: { status: 'not-needed' },
        goal: {
          status: 'failed',
          terminalReason: 'unsupported-validation',
          attempts: [],
          transitionSeq: 1,
        },
      });
      expect(await bureau.getDurableRun('goal:g1')).toBeNull();
      expect(ran).toBe(false);
    });

    it('refuses a goal when the bureau has no durable engine', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
        durableExecution: false,
      });

      expect(await bureau.goals.create(goalRequest())).toMatchObject({
        outcome: 'rejected',
        code: 'durable-unavailable',
      });
      expect(await bureau.goals.list()).toEqual([]);
      expect(await bureau.goals.recover()).toEqual({ goals: [], failures: [] });
    });

    it('refuses a goal once the bureau is shutting down', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      const disposing = bureau.dispose();

      expect(await bureau.goals.create(goalRequest())).toMatchObject({
        outcome: 'rejected',
        code: 'shutdown',
      });
      await disposing;
    });
  });

  describe('cancel', () => {
    it('cancels a goal mid-attempt and answers only once everything has stopped', async () => {
      const { bureau, diagnostics } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest({ principal: 'alice' }));
      await reaches(bureau, 'running');

      const { settled: outcome } = await cancelUntilSettled(bureau, 'g1', {
        principal: 'alice',
        reason: 'no longer wanted',
      });

      expect(outcome).toMatchObject({
        outcome: 'canceled',
        goal: {
          status: 'canceled',
          terminalReason: 'goal-canceled',
          cancellation: { principal: 'alice', reason: 'no longer wanted' },
        },
      });
      const goal = await bureau.goals.get('g1');
      expect(goal?.attempts.map((attempt) => attempt.status)).toEqual(['aborted']);
      expect(goal?.active).toBeUndefined();
      expect(await bureau.goals.active('g1')).toBeUndefined();
      // Every thing it names is terminal: the attempt's run and the controller.
      expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
      expect(['completed', 'cancelled']).toContain((await workflowStatus(bureau, 'goal:g1')) ?? '');

      // Idempotent: a repeat reads everything back again and changes nothing. It
      // answers `canceled`, not `already-terminal`, because the record being
      // `canceled` was never the whole of what `cancel()` answers for.
      expect(await bureau.goals.cancel('g1')).toMatchObject({
        outcome: 'canceled',
        goal: { status: 'canceled' },
      });
      expect(await bureau.goals.get('g1')).toEqual(goal);
      expect(diagnostics.scope('goals')).toEqual([]);
    });

    it('stops the attempt run through the controller finalizer when only the controller is hard-cancelled', async () => {
      // The default ownership is 'workflow-lease': the finalizer is driven by
      // the engine, not by the control plane, so nothing here calls
      // `goals.cancel` or `goals.recover` to stop the attempt.
      const { bureau, diagnostics } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest());
      await reaches(bureau, 'running');
      expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('running');

      expect(await bureau.cancelDurableRun('goal:g1')).toEqual({ status: 'requested' });

      const stopped = await pollUntil(
        async () => (await workflowStatus(bureau, 'goal-g1-a0')) === 'cancelled',
      );
      expect(stopped).toBe(true);
      expect(await workflowStatus(bureau, 'goal:g1')).toBe('cancelled');
      expect(diagnostics.scope('goals')).toEqual([]);
    });

    it('answers cancel() with canceled only once the controller finalizer has settled, retrying through cancellation-pending', async () => {
      const { bureau, diagnostics } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest());
      await reaches(bureau, 'running');

      const { first, settled } = await cancelUntilSettled(bureau);

      // The first read may find the finalizer still owed; the retry is what settles it.
      expect(['canceled', 'cancellation-pending']).toContain(first.outcome);
      expect(settled).toMatchObject({ outcome: 'canceled', goal: { status: 'canceled' } });
      expect(await workflowStatus(bureau, 'goal-g1-a0')).toBe('cancelled');
      expect(diagnostics.scope('goals')).toEqual([]);
    });

    it('cancels a goal while its validator is running and ignores the verdict that arrives afterwards', async () => {
      const validating = createLatch();
      const verdictDelivered = createLatch();
      const { bureau } = await boot({
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators: [
          createCheckValidator({
            before: async () => {
              await validating.promise;
              verdictDelivered.release();
            },
          }),
        ],
      });
      await bureau.goals.create(goalRequest());
      await reaches(bureau, 'evaluating');

      const { settled: outcome } = await cancelUntilSettled(bureau);
      expect(outcome).toMatchObject({ outcome: 'canceled' });
      const canceled = await bureau.goals.get('g1');

      validating.release();
      await verdictDelivered.promise;
      await pollUntil(() => false, 10);
      expect(await bureau.goals.get('g1')).toEqual(canceled);
      expect(canceled?.attempts.map((attempt) => attempt.status)).toEqual(['aborted']);
      expect(canceled?.attempts[0]?.validation).toBeUndefined();
    });

    it('reports a goal that has already ended, and one that does not exist', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest());
      const ended = await finished(bureau);

      expect(await bureau.goals.cancel('g1')).toEqual({ outcome: 'already-terminal', goal: ended });
      expect(await bureau.goals.cancel('missing')).toEqual({ outcome: 'not-found' });
      expect(await bureau.goals.get('g1')).toEqual(ended);
    });
  });

  describe('authorization', () => {
    it('reads a goal that another principal owns exactly as it reads a goal that is not there', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest({ principal: 'alice' }));
      await bureau.goals.create(goalRequest({ goalRunId: 'g2', principal: 'bob' }));
      await bureau.goals.create(goalRequest({ goalRunId: 'g3' }));
      await reaches(bureau, 'running');

      const own = await bureau.goals.get('g1', { principal: 'alice' });
      expect(own?.goalRunId).toBe('g1');
      expect(await bureau.goals.get('g1', { principal: 'mallory' })).toBeUndefined();
      expect(await bureau.goals.active('g1', { principal: 'mallory' })).toBeUndefined();
      expect(await bureau.goals.cancel('g1', { principal: 'mallory' })).toEqual({
        outcome: 'not-found',
      });
      expect(await bureau.goals.close('g1', { principal: 'mallory' })).toEqual({
        outcome: 'not-found',
      });
      expect(await bureau.goals.recover('g1', { principal: 'mallory' })).toEqual({
        goals: [{ goalRunId: 'g1', outcome: 'not-found' }],
        failures: [],
      });

      // The sweep honors the principal too: it neither recovers nor names a goal the caller cannot see.
      const sweptByMallory = await bureau.goals.recover(undefined, { principal: 'mallory' });
      expect(sweptByMallory.goals.map((entry) => entry.goalRunId)).toEqual(['g3']);
      const sweptByAlice = await bureau.goals.recover(undefined, { principal: 'alice' });
      expect(sweptByAlice.goals.map((entry) => entry.goalRunId).toSorted()).toEqual(['g1', 'g3']);
      const swept = await bureau.goals.recover();
      expect(swept.goals.map((entry) => entry.goalRunId).toSorted()).toEqual(['g1', 'g2', 'g3']);

      // A principal sees its own goals and the ones that have no owner.
      expect(await listedIds(bureau, { principal: 'alice' })).toEqual(['g1', 'g3']);
      // Omitting the principal is a trusted, internal call.
      expect(await listedIds(bureau)).toEqual(['g1', 'g2', 'g3']);
      // And the denied cancel changed nothing.
      const untouched = await bureau.goals.get('g1');
      expect(untouched?.cancellation).toBeUndefined();
    });
  });

  describe('close', () => {
    it("acknowledges the pruning of the controller's checkpoint history, each time it is asked", async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(() => Promise.resolve({ content: 'done', toolCalls: [] })) },
        validators: [createCheckValidator()],
        checkpointRetention: { keepLast: 1 },
      });
      await bureau.goals.create(goalRequest());
      await finished(bureau);

      const first = await bureau.goals.close('g1');
      const again = await bureau.goals.close('g1');

      expect(first).toMatchObject({ outcome: 'closed', cleanup: { status: 'completed' } });
      expect(again).toMatchObject({ outcome: 'closed', cleanup: { status: 'completed' } });
    });

    it('has nothing to clean up for a goal that ended without a controller', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator({ determinism: 'stochastic' })],
        checkpointRetention: { keepLast: 1 },
      });
      await bureau.goals.create(goalRequest({ requireDeterministicValidation: true }));

      expect(await bureau.goals.close('g1')).toMatchObject({
        outcome: 'closed',
        cleanup: { status: 'not-required' },
      });
    });

    it('does not close a goal that is still running', async () => {
      const { bureau } = await boot({
        agents: { worker: workerAgent(hangUntilAborted) },
        validators: [createCheckValidator()],
      });
      await bureau.goals.create(goalRequest());

      expect(await bureau.goals.close('g1')).toMatchObject({ outcome: 'not-terminal' });
    });
  });

  it('keeps a catalog agent usable as an ordinary durable run beside a goal', async () => {
    const { bureau } = await boot({
      agents: {
        worker: createAgent({
          name: 'worker',
          generate: () => Promise.resolve({ content: 'done', toolCalls: [] }),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      validators: [createCheckValidator()],
    });
    await bureau.goals.create(goalRequest());
    const run = bureau.run('worker', 'plain');

    const result = await run.result();
    expect(result.content).toBe('done');
    const ended = await finished(bureau);
    expect(ended.status).toBe('succeeded');
  });

  it('prices a retry from the input its run was started with, not from the goal prompt', async () => {
    let calls = 0;
    const base = workerAgent(() => {
      calls += 1;
      return Promise.resolve({
        content: calls === 1 ? 'nope' : 'done',
        toolCalls: [],
        usage: { prompt: 10, completion: 10, total: 20 },
      });
    });
    const resolveOptions = (
      base as unknown as Record<
        symbol,
        (input: unknown, context: unknown) => Promise<Record<string, unknown>>
      >
    )[OPERATIVE_RESOLVE_RUN_OPTIONS];
    if (resolveOptions === undefined)
      throw new Error('the worker agent has no run-option resolver');
    const resolved: unknown[] = [];
    const priced = Object.create(base, {
      [OPERATIVE_RESOLVE_RUN_OPTIONS]: {
        value: (input: unknown, context: unknown) => {
          resolved.push(input);
          return resolveOptions
            .call(base, input, context)
            .then((options) => ({ ...options, costEstimation: { model: 'gpt-4o' } }));
        },
      },
    }) as RunnableAgent<unknown, boolean>;
    const { bureau } = await boot({
      agents: { worker: priced },
      validators: [createCheckValidator()],
    });

    await bureau.goals.create(
      goalRequest({ bounds: { ...GOAL_BOUNDS, maximumTotalCostUsd: 100 } }),
    );
    const goal = await finished(bureau);

    expect(goal).toMatchObject({ status: 'succeeded' });
    // A retry is started with a seeded conversation; its own cost lookups must
    // resolve the estimator from that input too, never from the prompt string.
    const seeded = resolved.filter((input) => typeof input !== 'string');
    expect(seeded.length).toBeGreaterThanOrEqual(2);
  });
});
