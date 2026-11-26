/**
 * COR-2095 — a run's outcome is published as one of `run.completed`, `run.error` or `run.aborted`,
 * and `run.settled` carries its `status` and `finishReason`. The one seam is the task registry's
 * `onSettled`, so a chat run, a goal attempt, a workflow step, a schedule fire and a child all
 * reach it the same way.
 *
 * This file is the table of `tmp/chef/briefs/COR-2095-matrix.md`, one entry per matrix row, in the
 * matrix's order. A row is driven end to end (a real run) unless it says `seam`: a row that differs
 * from another only in the settlement written (`timed-out`, `deadline-exceeded`, a null message,
 * an `elicitation-denied` finish) writes that settlement to the task registry, which is what each
 * settlement writer does. A row marked `unchanged` pins what `main` already did. The recovery and
 * `owner-lost` rows are in `run-outcome-events-recovery.test.ts`.
 */
import {
  createAgent,
  type GenerateFunction,
  type GuardrailsOptions,
  type InputDetector,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer/testing';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import {
  type BureauEventsOperationHost,
  bureauEventsSubscriptionOperation,
  createBureauEventRegistry,
} from './bureau-events-operation';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createReceiver, deliveriesOf, newEncryptionKey } from './hooks/hooks.test-support';
import {
  cancelUntilSettled,
  createCheckValidator,
  goalRequest,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import {
  createScheduleFireHarness,
  failingWrites,
  fireOnce,
} from './schedule-fire-fixtures.test-support';

const ALICE = 'api-key:alice';

interface Published {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const OUTCOME_KINDS = ['run.completed', 'run.error', 'run.aborted'] as const;
const OUTCOME_OR_SETTLED = new Set<string>([...OUTCOME_KINDS, 'run.settled']);

const bureaus: Bureau<AgentDefinitions>[] = [];
const scheduleHarness = createScheduleFireHarness();
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
  await scheduleHarness.dispose();
});

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}

/** Every envelope the Bureau's feed holds. */
async function everything(
  bureau: Bureau,
): Promise<Array<Published & { readonly sequence: number }>> {
  await bureau.internals.taskRegistry.flush();
  return await collect<Published & { readonly sequence: number }>(
    bureau.internals.eventFeed.feed.replay() as AsyncIterable<
      Published & { readonly sequence: number }
    >,
  );
}

/** The outcome and `run.settled` envelopes of one run, in feed order. */
async function outcomesOf(bureau: Bureau, runId: string): Promise<Published[]> {
  const feed = await everything(bureau);
  return feed
    .filter((entry) => OUTCOME_OR_SETTLED.has(entry.kind) && entry.payload['runId'] === runId)
    .map(({ kind, payload }) => ({ kind, payload }));
}

/** Just the kinds of {@link outcomesOf}. */
async function kindsOf(bureau: Bureau, runId: string): Promise<string[]> {
  const published = await outcomesOf(bureau, runId);
  return published.map((entry) => entry.kind);
}

/** How many deliveries a hook has. */
async function deliveryCount(bureau: Bureau, hookId: string): Promise<number> {
  const deliveries = await deliveriesOf(bureau, hookId);
  return deliveries.length;
}

const TERMINAL = new Set(['completed', 'failed', 'canceled']);

/** Waits until the task is terminal, then until every announcement of it has been made. */
async function settle(bureau: Bureau, id: string): Promise<void> {
  await waitUntil(
    async () => {
      const task = await bureau.tasks.get(id);
      return task !== undefined && TERMINAL.has(task.status);
    },
    { message: `task ${id} is terminal` },
  );
  await bureau.internals.taskRegistry.flush();
}

function agentOf(name: string, generate: GenerateFunction, extra: object = {}) {
  return createAgent({ name, generate, stopWhen: stopWhen.noToolCalls(), ...extra });
}

async function open(
  agents: Record<string, ReturnType<typeof agentOf>>,
  extra: Partial<Parameters<typeof createBureau>[0]> = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents,
    storage: new MemoryStorage(),
    onDiagnostic: () => undefined,
    ...extra,
  });
  bureaus.push(bureau);
  return bureau;
}

const completes: GenerateFunction = async () => ({ content: 'done', toolCalls: [] });
const fails: GenerateFunction = async () => {
  throw new Error('the provider exploded');
};

const INJECTION = 'TRIPWIRE-SENTINEL';
const detector: InputDetector = {
  name: 'sentinel',
  detect: async (input) =>
    input.includes(INJECTION)
      ? { triggered: true, category: 'prompt-injection', confidence: 0.99 }
      : { triggered: false, category: 'prompt-injection', confidence: 0 },
};
const TRIPWIRE: GuardrailsOptions = { mode: 'tripwire', input: { detectors: [detector] } };

const nextTool = createTool({
  name: 'next',
  description: 'Asks for one more step',
  input: z.object({}),
  execute: async () => 'ok',
});
const forever: GenerateFunction = async () => ({
  content: 'still going',
  toolCalls: [{ name: 'next', arguments: {} }],
});

/** The outcome kind and the `run.settled` envelope that must follow it. */
function expectOutcome(
  published: readonly Published[],
  expected: {
    readonly kind: (typeof OUTCOME_KINDS)[number];
    readonly status: 'completed' | 'failed' | 'canceled';
    readonly finishReason: string | undefined;
  },
): { readonly outcome: Published; readonly settled: Published } {
  expect(published.map((entry) => entry.kind)).toEqual([expected.kind, 'run.settled']);
  const [outcome, settled] = published as [Published, Published];
  expect(settled.payload).toEqual({
    runId: outcome.payload['runId'],
    status: expected.status,
    ...(expected.finishReason === undefined ? {} : { finishReason: expected.finishReason }),
  });
  for (const other of OUTCOME_KINDS) {
    if (other !== expected.kind) expect(published.map((entry) => entry.kind)).not.toContain(other);
  }
  return { outcome, settled };
}

/** A task the registry knows, settled directly: what a settlement writer does. */
async function admitAndSettle(
  bureau: Bureau,
  taskId: string,
  settlement: {
    readonly status: 'completed' | 'failed' | 'canceled';
    readonly finishReason: string | null;
    readonly message: string | null;
  },
): Promise<boolean> {
  const registry = bureau.internals.taskRegistry;
  await registry.recordAdmission({
    taskId,
    contextId: taskId,
    incarnation: '',
    agentName: 'default',
    owner: ALICE,
    origin: { kind: 'api' },
    message: 'go',
  });
  const recorded = await registry.recordSettled(taskId, {
    at: new Date().toISOString(),
    ...settlement,
  });
  await registry.flush();
  return recorded;
}

interface Row {
  /** The matrix row, by its input or failure. */
  readonly row: string;
  readonly run: () => Promise<void>;
}

const EXECUTIONS = [
  ['in process', { durable: false }],
  ['durably', { durable: true }],
] as const;

const chatRows: Row[] = EXECUTIONS.flatMap(([execution, durability]) => [
  {
    row: `chat run completes (${execution})`,
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) }, durability);
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);

      const { outcome } = expectOutcome(await outcomesOf(bureau, run.id), {
        kind: 'run.completed',
        status: 'completed',
        finishReason: 'stop-condition',
      });
      expect(outcome.payload).toEqual({ runId: run.id, finishReason: 'stop-condition' });
    },
  },
  {
    row: `chat run fails with error (${execution})`,
    run: async () => {
      const bureau = await open({ default: agentOf('default', fails) }, durability);
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);

      const { outcome } = expectOutcome(await outcomesOf(bureau, run.id), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'error',
      });
      expect(Object.keys(outcome.payload).toSorted()).toEqual([
        'errorCode',
        'errorKind',
        'finishReason',
        'runId',
        'step',
      ]);
      expect(outcome.payload).toMatchObject({ runId: run.id, finishReason: 'error' });
      expect(typeof outcome.payload['step']).toBe('number');
      expect(typeof outcome.payload['errorCode']).toBe('string');
      expect(typeof outcome.payload['errorKind']).toBe('string');
      // The text is read through the task, never from the event (Revision 2026-11-16).
      expect(outcome.payload).not.toHaveProperty('message');
      const task = await bureau.tasks.get(run.id);
      expect(task?.statusMessage).toContain('the provider exploded');
      // unchanged: the run's own `action` envelope with `actionType: 'run.completed'` is still
      // published for a failed run; only the outcome kind `run.completed` is not.
      const feed = await everything(bureau);
      const completedActions = feed.filter(
        (entry) =>
          entry.kind === 'action' &&
          entry.payload['runId'] === run.id &&
          entry.payload['actionType'] === 'run.completed',
      );
      expect(completedActions).toHaveLength(1);
    },
  },
  {
    row: `run ends tripwire (${execution})`,
    run: async () => {
      const bureau = await open(
        { default: agentOf('default', completes, { guardrails: TRIPWIRE }) },
        durability,
      );
      const run = await bureau.tasks.start('default', `please ${INJECTION}`, { principal: ALICE });
      await settle(bureau, run.id);

      const { outcome } = expectOutcome(await outcomesOf(bureau, run.id), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'tripwire',
      });
      expect(outcome.payload).toMatchObject({
        runId: run.id,
        finishReason: 'tripwire',
        errorCode: 'TRIPWIRE',
        errorKind: 'policy',
      });
    },
  },
  {
    row: `run ends maximum-steps (${execution})`,
    run: async () => {
      const bureau = await open(
        {
          default: agentOf('default', forever, {
            toolbox: createToolbox([nextTool]),
            maximumSteps: 2,
          }),
        },
        durability,
      );
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);

      const { outcome } = expectOutcome(await outcomesOf(bureau, run.id), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'maximum-steps',
      });
      expect(outcome.payload).toMatchObject({ errorCode: 'MAXIMUM_STEPS', errorKind: 'policy' });
    },
  },
  {
    row: `run canceled through the API (${execution})`,
    run: async () => {
      const bureau = await open({ default: agentOf('default', hangUntilAborted) }, durability);
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await waitUntil(() => bureau.internals.store.getRun(run.id)?.status === 'running', {
        message: 'the run is running',
      });
      const cancellation = await bureau.tasks.cancel(run.id);
      expect(cancellation?.receipt).toBe('cancel-requested');
      await settle(bureau, run.id);

      const { outcome } = expectOutcome(await outcomesOf(bureau, run.id), {
        kind: 'run.aborted',
        status: 'canceled',
        finishReason: 'aborted',
      });
      expect(outcome.payload).toEqual({ runId: run.id, finishReason: 'aborted' });
    },
  },
]);

/** seam: a finish reason the chat path reaches only through a provider or a human. */
const finishReasonRows: Row[] = (
  [
    ['elicitation-denied', 'run.error', 'failed'],
    ['budget-exceeded', 'run.error', 'failed'],
    ['aborted', 'run.aborted', 'canceled'],
  ] as const
).map(([finishReason, kind, status]) => ({
  row: `seam: a ${status} settlement with finish reason ${finishReason}`,
  run: async () => {
    const bureau = await open({ default: agentOf('default', completes) });
    await admitAndSettle(bureau, `task-${finishReason}`, {
      status,
      finishReason,
      message: status === 'failed' ? 'it stopped' : null,
    });

    const { outcome } = expectOutcome(await outcomesOf(bureau, `task-${finishReason}`), {
      kind,
      status,
      finishReason,
    });
    expect(outcome.payload['finishReason']).toBe(finishReason);
  },
}));

const settlementRows: Row[] = [
  {
    row: 'seam: a schedule fire times out',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      await admitAndSettle(bureau, 'fire-timeout', {
        status: 'failed',
        finishReason: 'timed-out',
        message: 'The fire timed out (after 30s).',
      });

      const { outcome } = expectOutcome(await outcomesOf(bureau, 'fire-timeout'), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'timed-out',
      });
      expect(outcome.payload).toEqual({ runId: 'fire-timeout', finishReason: 'timed-out' });
    },
  },
  {
    row: 'seam: a fire’s workflow fails with no finish reason',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      await admitAndSettle(bureau, 'fire-no-reason', {
        status: 'failed',
        finishReason: null,
        message: 'it failed',
      });

      const { outcome, settled } = expectOutcome(await outcomesOf(bureau, 'fire-no-reason'), {
        kind: 'run.error',
        status: 'failed',
        finishReason: undefined,
      });
      expect(outcome.payload['finishReason']).toBe('error');
      expect(settled.payload).not.toHaveProperty('finishReason');
    },
  },
  {
    row: 'seam: the A2A command deadline passes before start',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      await admitAndSettle(bureau, 'a2a-deadline', {
        status: 'failed',
        finishReason: 'deadline-exceeded',
        message: 'The command deadline passed.',
      });

      const { outcome } = expectOutcome(await outcomesOf(bureau, 'a2a-deadline'), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'deadline-exceeded',
      });
      for (const absent of ['errorCode', 'errorKind', 'step']) {
        expect(outcome.payload).not.toHaveProperty(absent);
      }
    },
  },
  {
    row: 'seam: a catalog run rejects, and no live RunErrorEvent left an entry',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      await admitAndSettle(bureau, 'catalog-rejects', {
        status: 'failed',
        finishReason: 'error',
        message: 'the catalog run rejected',
      });

      const { outcome } = expectOutcome(await outcomesOf(bureau, 'catalog-rejects'), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'error',
      });
      expect(outcome.payload).toEqual({ runId: 'catalog-rejects', finishReason: 'error' });
    },
  },
  {
    row: 'seam: whatever message a failed settlement holds, the event carries none',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      await admitAndSettle(bureau, 'with-message', {
        status: 'failed',
        finishReason: 'error',
        message: 'gateway rejected {"password": "hunter2"} Bearer abc.def-123',
      });

      const { outcome } = expectOutcome(await outcomesOf(bureau, 'with-message'), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'error',
      });
      expect(outcome.payload).toEqual({ runId: 'with-message', finishReason: 'error' });
      // The text is read through the authorized task read.
      const task = await bureau.tasks.get('with-message');
      expect(task?.statusMessage).toContain('hunter2');
    },
  },
  {
    row: 'a process-local run aborted by shutdown announces run.aborted, then run.settled, while the feed is open',
    run: async () => {
      const bureau = await open(
        { default: agentOf('default', hangUntilAborted) },
        { durable: false },
      );
      const seen: string[] = [];
      bureau.addEventListener('run.aborted', () => seen.push('run.aborted'));
      bureau.addEventListener('run.settled', (event) => seen.push(`run.settled:${event.status}`));
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await waitUntil(() => bureau.internals.store.getRun(run.id)?.status === 'running', {
        message: 'the run is running',
      });

      await bureau.shutdown();

      expect(seen).toEqual(['run.aborted', 'run.settled:canceled']);
    },
  },
  {
    row: 'duplicate: a second settlement of a settled task announces nothing',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      await admitAndSettle(bureau, 'twice', {
        status: 'completed',
        finishReason: 'stop-condition',
        message: null,
      });
      await bureau.internals.taskRegistry.recordSettled('twice', {
        at: new Date().toISOString(),
        status: 'failed',
        finishReason: 'error',
        message: 'late',
      });
      await bureau.internals.taskRegistry.flush();
      await quietFor(20);

      expectOutcome(await outcomesOf(bureau, 'twice'), {
        kind: 'run.completed',
        status: 'completed',
        finishReason: 'stop-condition',
      });
    },
  },
  {
    row: 'a settlement write that fails publishes no outcome and no run.settled, and the failure’s detail is dropped when its run is removed',
    run: async () => {
      const faults = failingWrites('"settled":{', 100);
      const bureau = await open(
        { default: agentOf('default', fails) },
        { storage: faults.wrap(new MemoryStorage()), durable: false },
      );
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await waitUntil(() => faults.failed > 0, { message: 'the settlement write was refused' });
      await bureau.internals.taskRegistry.flush();

      expect(await outcomesOf(bureau, run.id)).toEqual([]);
      // The run's live `run.error` left an entry that no announcement took.
      expect(bureau.internals.runOutcomeDetails.size()).toBe(1);

      bureau.internals.store.removeRun(run.id);
      await waitUntil(() => bureau.internals.runOutcomeDetails.size() === 0, {
        message: 'run.removed dropped the entry',
      });
    },
  },
  {
    row: 'the failure details a never-announced run left are cleared when the Bureau is disposed',
    run: async () => {
      const faults = failingWrites('"settled":{', 100);
      const bureau = await open(
        { default: agentOf('default', fails) },
        { storage: faults.wrap(new MemoryStorage()), durable: false },
      );
      await bureau.tasks.start('default', 'go', { principal: ALICE });
      await waitUntil(() => faults.failed > 0, { message: 'the settlement write was refused' });
      await bureau.internals.taskRegistry.flush();
      expect(bureau.internals.runOutcomeDetails.size()).toBe(1);

      await bureau.dispose();

      expect(bureau.internals.runOutcomeDetails.size()).toBe(0);
    },
  },
  {
    row: 'every announced failure takes its detail, so none is held after a run fails and settles',
    run: async () => {
      const bureau = await open({ default: agentOf('default', fails) });
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);

      expect(bureau.internals.runOutcomeDetails.size()).toBe(0);
    },
  },
  {
    row: 'late: a settlement of a task whose record is gone publishes nothing',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      const recorded = await bureau.internals.taskRegistry.recordSettled('never-admitted', {
        at: new Date().toISOString(),
        status: 'failed',
        finishReason: 'error',
        message: 'no record',
      });
      await bureau.internals.taskRegistry.flush();

      expect(recorded).toBe(false);
      expect(await outcomesOf(bureau, 'never-admitted')).toEqual([]);
    },
  },
];

const subordinateRows: Row[] = [
  {
    row: 'goal attempt completes',
    run: async () => {
      const bureau = await open(
        { worker: workerAgent(completes) },
        { durable: true, validators: [createCheckValidator()] },
      );
      await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
      await settle(bureau, 'goal-g1-a0');

      expectOutcome(await outcomesOf(bureau, 'goal-g1-a0'), {
        kind: 'run.completed',
        status: 'completed',
        finishReason: 'stop-condition',
      });
    },
  },
  {
    row: 'goal attempt fails with error',
    run: async () => {
      const bureau = await open(
        { worker: workerAgent(fails) },
        { durable: true, validators: [createCheckValidator()] },
      );
      await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
      await settle(bureau, 'goal-g1-a0');

      const { outcome } = expectOutcome(await outcomesOf(bureau, 'goal-g1-a0'), {
        kind: 'run.error',
        status: 'failed',
        finishReason: 'error',
      });
      expect(outcome.payload).toMatchObject({ runId: 'goal-g1-a0', finishReason: 'error' });
      // A goal attempt is dispatched with the id its owner recorded, so no run event feed is
      // attached to it (`bureau-catalog-dispatch.ts` registers only `bureau.run()` runs); the
      // observer the dispatcher hands such a run (COR-2096) leaves the live RunErrorEvent's detail.
      expect(typeof outcome.payload['step']).toBe('number');
      expect(typeof outcome.payload['errorCode']).toBe('string');
      expect(typeof outcome.payload['errorKind']).toBe('string');
      expect(bureau.internals.runOutcomeDetails.size()).toBe(0);
    },
  },
  {
    row: 'goal attempt aborts',
    run: async () => {
      const bureau = await open(
        { worker: workerAgent(hangUntilAborted) },
        { durable: true, validators: [createCheckValidator()] },
      );
      await bureau.goals.create(goalRequest({ goalRunId: 'g1' }));
      await waitUntil(async () => (await bureau.tasks.get('goal-g1-a0')) !== undefined, {
        message: 'the attempt is a task',
      });
      await cancelUntilSettled(bureau, 'g1');
      await settle(bureau, 'goal-g1-a0');

      expectOutcome(await outcomesOf(bureau, 'goal-g1-a0'), {
        kind: 'run.aborted',
        status: 'canceled',
        finishReason: 'aborted',
      });
    },
  },
  ...(['completes', 'fails', 'aborts'] as const).map((how) => ({
    row: `workflow step ${how}`,
    run: async () => {
      const release = Promise.withResolvers<string>();
      const harness = await startWorkflowBureau({
        replies: {
          writer: () => {
            if (how === 'fails') throw new Error('the step failed');
            return how === 'aborts' ? release.promise : 'written';
          },
        },
      });
      try {
        await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
        const run = await harness.bureau
          .durableEngine()
          ?.start('digest', null, { id: 'instance-1' });
        let stepId = '';
        await waitUntil(
          async () => {
            const runs = await harness.bureau.durableEngine()?.list({ type: 'agentRun' });
            stepId = runs?.items[0]?.id ?? '';
            return stepId !== '' && (await harness.bureau.tasks.get(stepId)) !== undefined;
          },
          { message: 'the step run is a task' },
        );
        if (how === 'aborts') await harness.bureau.durableEngine()?.cancel(stepId);
        await run?.result().catch(() => undefined);
        await settle(harness.bureau, stepId);

        const expected = {
          completes: ['run.completed', 'completed', 'stop-condition'],
          fails: ['run.error', 'failed', undefined],
          aborts: ['run.aborted', 'canceled', undefined],
        }[how] as [
          'run.completed' | 'run.error' | 'run.aborted',
          'completed' | 'failed' | 'canceled',
          string | undefined,
        ];
        const published = await outcomesOf(harness.bureau, stepId);
        expect(published.map((entry) => entry.kind)).toEqual([expected[0], 'run.settled']);
        expect(published[1]?.payload['status']).toBe(expected[1]);
      } finally {
        release.resolve('released');
        await harness.dispose();
      }
    },
  })),
  {
    row: 'schedule fire completes',
    run: async () => {
      const bureau = await scheduleHarness.open({
        agents: { default: agentOf('default', completes) },
      });
      const { fireId } = await fireOnce(bureau, ALICE);
      await settle(bureau, fireId);

      expectOutcome(await outcomesOf(bureau, fireId), {
        kind: 'run.completed',
        status: 'completed',
        finishReason: 'stop-condition',
      });
    },
  },
  {
    row: 'schedule fire fails, and its run.error omits what no live event told',
    run: async () => {
      const bureau = await scheduleHarness.open({
        agents: { default: agentOf('default', fails) },
      });
      const { fireId } = await fireOnce(bureau, ALICE);
      await settle(bureau, fireId);

      const published = await outcomesOf(bureau, fireId);
      expect(published.map((entry) => entry.kind)).toEqual(['run.error', 'run.settled']);
      expect(published[0]?.payload).toMatchObject({ runId: fireId });
      expect(published[1]?.payload).toMatchObject({ runId: fireId, status: 'failed' });
    },
  },
];

const ORDER_ROWS: Row[] = [
  {
    row: 'a live subscriber sees the outcome before run.settled, after the run’s terminal actions',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      const seen: string[] = [];
      bureau.addEventListener('run.completed', () => seen.push('run.completed'));
      bureau.addEventListener('run.settled', () => seen.push('run.settled'));
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);

      expect(seen).toEqual(['run.completed', 'run.settled']);
      const feed = await everything(bureau);
      const kinds = feed.filter((entry) => entry.payload['runId'] === run.id);
      const lastAction = kinds.findLastIndex((entry) => entry.kind === 'action');
      const outcomeAt = kinds.findIndex((entry) => entry.kind === 'run.completed');
      expect(lastAction).toBeGreaterThanOrEqual(0);
      expect(outcomeAt).toBeGreaterThan(lastAction);
    },
  },
  {
    row: 'feed.replay() after settlement returns the outcome, then run.settled',
    run: async () => {
      const bureau = await open({ default: agentOf('default', completes) });
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);

      const first = await kindsOf(bureau, run.id);
      const second = await kindsOf(bureau, run.id);
      expect(first).toEqual(['run.completed', 'run.settled']);
      expect(second).toEqual(first);
    },
  },
  {
    row: 'a subscriber after a restart finds the in-memory feed empty of what came before',
    run: async () => {
      const storage = new MemoryStorage();
      const first = await open({ default: agentOf('default', fails) }, { storage });
      const run = await first.tasks.start('default', 'go', { principal: ALICE });
      await settle(first, run.id);
      expect(await kindsOf(first, run.id)).toEqual(['run.error', 'run.settled']);
      await first.dispose();

      const second = await open({ default: agentOf('default', fails) }, { storage });
      expect(await outcomesOf(second, run.id)).toEqual([]);
    },
  },
  // The `feed.gap` envelope of a resume cursor that was evicted is pinned, unchanged, by
  // `bureau-event-feed.test.ts` ("opens a gap when reconnecting with a previous incarnation cursor").
  {
    row: 'unchanged: a bureau.addEventListener added after the dispatch receives nothing',
    run: async () => {
      const bureau = await open({ default: agentOf('default', fails) });
      const run = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, run.id);
      const late: string[] = [];
      bureau.addEventListener('run.error', () => late.push('run.error'));
      await quietFor(20);

      expect(late).toEqual([]);
    },
  },
  {
    row: 'a kinds filter of run.error narrows to run.error',
    run: async () => {
      const bureau = await open({
        default: agentOf('default', fails),
        steady: agentOf('steady', completes),
      });
      const failing = await bureau.tasks.start('default', 'go', { principal: ALICE });
      const steady = await bureau.tasks.start('steady', 'go', { principal: ALICE });
      await settle(bureau, failing.id);
      await settle(bureau, steady.id);

      const registry = createBureauEventRegistry();
      registry.set('outcome-bureau', bureau.internals.eventFeed);
      const operation = bureauEventsSubscriptionOperation as unknown as {
        invoke: (args: {
          input: { bureauId: string; kinds: string[] };
          host: BureauEventsOperationHost;
        }) => Promise<{
          iterable: AsyncIterable<{ kind: string; payload: Record<string, unknown> }>;
          close(): Promise<void>;
        }>;
      };
      const subscription = await operation.invoke({
        input: { bureauId: 'outcome-bureau', kinds: ['run.error'] },
        host: { bureauFeeds: registry },
      });
      const seen: Array<{ kind: string; payload: Record<string, unknown> }> = [];
      for await (const envelope of subscription.iterable) {
        seen.push(envelope);
        break;
      }
      await subscription.close();

      expect(seen.map((entry) => entry.kind)).toEqual(['run.error']);
      expect(seen[0]?.payload['runId']).toBe(failing.id);
    },
  },
];

const catalogRows: Row[] = [
  {
    row: 'catalog listing: the three kinds have origin run and every scope',
    run: async () => {
      const { BUREAU_EVENT_CATALOG } = await import('./bureau-event-catalog');
      for (const kind of OUTCOME_KINDS) {
        expect(BUREAU_EVENT_CATALOG[kind]).toMatchObject({
          kind,
          origin: 'run',
          scopes: ['agent', 'workflow', 'schedule'],
        });
      }
      expect(BUREAU_EVENT_CATALOG['run.error'].payload.map((field) => field.name)).toEqual([
        'runId',
        'finishReason',
        'step',
        'errorCode',
        'errorKind',
      ]);
    },
  },
];

const ROWS: Row[] = [
  ...chatRows,
  ...finishReasonRows,
  ...settlementRows,
  ...subordinateRows,
  ...ORDER_ROWS,
  ...catalogRows,
];

describe('COR-2095 outcome matrix: run outcome kinds and status on run.settled', () => {
  it.each(ROWS.map((entry) => [entry.row, entry] as const))('%s', async (_row, entry) => {
    await entry.run();
  });
});

describe('hooks on a run outcome', () => {
  async function openHooks() {
    const key = await newEncryptionKey();
    const bureau = await createBureau<AgentDefinitions>({
      id: 'outcome-hooks-bureau',
      agents: { alpha: agentOf('alpha', fails), beta: agentOf('beta', fails) },
      storage: new MemoryStorage(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      answerEncryption: { current: key },
      onDiagnostic: () => undefined,
      hooks: {},
      webhooks: {
        targets: [],
        fetch: createReceiver().fetch,
        sleep: () => Promise.resolve(),
      },
    });
    bureaus.push(bureau);
    return bureau;
  }

  const notify = { action: { type: 'notify' } } as const;

  it('fires a run.error hook scoped to one agent for that agent’s failure, and not another’s', async () => {
    const bureau = await openHooks();
    const hooks = bureau.hooks!;
    const alpha = await hooks.create({
      ...notify,
      events: ['run.error'],
      scope: { kind: 'agent', id: 'alpha' },
    });
    const completed = await hooks.create({ ...notify, events: ['run.completed'] });

    const failed = await bureau.tasks.start('beta', 'go', { principal: ALICE });
    await settle(bureau, failed.id);
    await quietFor(50);
    expect(await deliveriesOf(bureau, alpha.id)).toEqual([]);

    const mine = await bureau.tasks.start('alpha', 'go', { principal: ALICE });
    await settle(bureau, mine.id);
    await waitUntil(async () => (await deliveryCount(bureau, alpha.id)) === 1, {
      message: 'the scoped hook delivered once',
    });
    const delivered = await deliveriesOf(bureau, alpha.id);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.kind).toBe('run.error');
    // A hook on `run.completed` hears of neither failure.
    expect(await deliveriesOf(bureau, completed.id)).toEqual([]);
  });

  it('delivers once for each of run.error and run.settled when a hook lists both', async () => {
    const bureau = await openHooks();
    const both = await bureau.hooks!.create({ ...notify, events: ['run.error', 'run.settled'] });
    const run = await bureau.tasks.start('alpha', 'go', { principal: ALICE });
    await settle(bureau, run.id);
    await waitUntil(async () => (await deliveryCount(bureau, both.id)) === 2, {
      message: 'both kinds delivered',
    });

    const deliveries = await deliveriesOf(bureau, both.id);
    expect(deliveries.map((delivery) => delivery.kind).toSorted()).toEqual([
      'run.error',
      'run.settled',
    ]);
  });
});
