/**
 * COR-851 — `bureau.goals`: the control plane over a durable goal, end to end
 * over a real `createBureau`.
 *
 * What survives a restart is in `goals-recovery.test.ts`; this file covers the
 * operations themselves: create (and its refusals), get, list, active, cancel,
 * and close.
 */
import { createAgent, type RunnableAgent, stopWhen } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { createBureau } from './create-bureau';
import type { GoalState } from './goal-state';
import {
  CHECK,
  createCheckValidator,
  createDiagnostics,
  createLatch,
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
    // The retry's prompt carries the feedback; the validator saw the earlier attempt.
    expect(prompts).toEqual(['work', 'work\n\nsay done']);
    expect(validatorCalls[1]?.history.map((attempt) => attempt.feedback)).toEqual(['say done']);
    expect(validatorCalls[1]?.result.content).toBe('done');

    expect(await bureau.goals.get('g1')).toEqual(goal);
    expect(await bureau.goals.list()).toEqual([goal]);
    expect(await bureau.goals.list({ status: 'failed' })).toEqual([]);
    expect(await bureau.goals.list({ status: ['failed', 'succeeded'] })).toEqual([goal]);
    expect(await bureau.goals.active('g1')).toBeUndefined();
    expect(await workflowStatus(bureau, 'goal:g1')).toBe('completed');

    const closed = await bureau.goals.close('g1');
    expect(closed).toMatchObject({ outcome: 'closed', goal: { status: 'succeeded' } });
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

      const outcome = await bureau.goals.cancel('g1', {
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

      // Idempotent: a repeat answers from the record and changes nothing.
      expect(await bureau.goals.cancel('g1')).toMatchObject({ outcome: 'already-terminal' });
      expect(await bureau.goals.get('g1')).toEqual(goal);
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

      const outcome = await bureau.goals.cancel('g1');
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

      // A principal sees its own goals and the ones that have no owner.
      expect(await listedIds(bureau, { principal: 'alice' })).toEqual(['g1', 'g3']);
      // Omitting the principal is a trusted, internal call.
      expect(await listedIds(bureau)).toEqual(['g1', 'g2', 'g3']);
      // And the denied cancel changed nothing.
      const untouched = await bureau.goals.get('g1');
      expect(untouched?.cancellation).toBeUndefined();
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
});
