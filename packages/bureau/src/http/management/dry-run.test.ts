/**
 * COR-2522 — the destructive operations of Bureau accept `dryRun: true`: the call makes its checks,
 * writes nothing, publishes nothing, and answers `{ dryRun: true, target, effects }`.
 *
 * This file holds what spans operations (the catalog, and the counts of the effects) and the
 * dry run of each operation that needs no files or governed memory of its own; `dry-run-files`,
 * `dry-run-hooks`, `dry-run-memory` and `dry-run-workflows` hold the rest.
 */
import { createAgent } from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { waitForCondition, waitForTaskState } from '../../test';
import { startTaskFrom } from '../../test/task-start-request.ts';
import {
  CHECK,
  createCheckValidator,
  hangUntilAborted,
  workerAgent,
} from '../../testing/goal-fixtures.test-support';
import { createBureauCatalogSnapshot } from '../bureau-catalog-snapshot.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { dryRunEffectsOf } from './dry-run-references.ts';
import {
  dryRunResultOf,
  expectNothingWritten,
  expectSameFaultAsTheRealCall,
  type DryRunSubject,
  withBureau,
} from './dry-run.test-support.ts';
import { answering, type OpenedBureau, OWNER, rpc } from './management-fixtures.test-support.ts';

/** The operations whose names end as a destructive operation's does, and the one target each acts on. */
const DRY_RUN_OPERATIONS = [
  'bureau.agents.definitions.delete',
  'bureau.agents.disable',
  'bureau.contexts.delete',
  'bureau.contexts.forgetgrants',
  'bureau.goals.cancel',
  'bureau.hooks.delete',
  'bureau.memory.embedding.cancel',
  'bureau.memory.forget',
  'bureau.schedules.cancel',
  'bureau.tasks.cancel',
  'bureau.workflows.delete',
  'bureau.workflows.runs.cancel',
] as const;

/** A name that says it cancels, deletes, disables or forgets. */
const DESTRUCTIVE_SUFFIX = /\.(cancel|delete|disable|forget|forgetgrants)$/;

describe('the catalog marks the operations that support a dry run', () => {
  const operations = createBureauCatalogSnapshot().operations;

  it('marks each of the twelve, and each takes a boolean `dryRun`', () => {
    for (const name of DRY_RUN_OPERATIONS) {
      const operation = operations.find((candidate) => candidate.name === name);
      expect(operation?.supportsDryRun).toBe(true);
      const properties = operation?.inputSchema['properties'] as Record<string, { type?: string }>;
      expect(properties['dryRun']?.type).toBe('boolean');
      // Not required: a call without it is the real call.
      expect(operation?.inputSchema['required'] ?? []).not.toContain('dryRun');
    }
  });

  it('fails for any operation whose name ends in cancel, delete, disable, forget or forgetgrants and does not', () => {
    const unmarked = operations
      .filter((operation) => operation.name.startsWith('bureau.'))
      .filter((operation) => DESTRUCTIVE_SUFFIX.test(operation.name))
      .filter((operation) => operation.supportsDryRun !== true)
      .map((operation) => operation.name);
    expect(unmarked).toEqual([]);
  });

  it('marks exactly those twelve and no other operation', () => {
    const marked = operations
      .filter((operation) => operation.supportsDryRun === true)
      .map((operation) => operation.name);
    expect(marked.toSorted()).toEqual([...DRY_RUN_OPERATIONS].toSorted());
  });

  it('serves each over JSON-RPC, and an unknown key is refused, so a misspelt `dryRun` never runs the call', () => {
    for (const name of DRY_RUN_OPERATIONS) {
      const operation = BUREAU_HANDLER_OPERATIONS.find((candidate) => candidate.name === name);
      expect(operation?.transports.jsonRpcHttp).toBe(true);
      expect(operation?.unknownKeyPolicy.jsonRpc).toBe('reject');
    }
  });

  it('exposes `dryRun` on the MCP tool of every one of them that is an MCP tool', () => {
    const exposed = DRY_RUN_OPERATIONS.filter(
      (name) =>
        BUREAU_HANDLER_OPERATIONS.find((operation) => operation.name === name)?.mcpExposable,
    );
    // Today only `bureau.tasks.cancel` is: the tool's input is the operation's, so it takes it too.
    expect(exposed).toEqual(['bureau.tasks.cancel']);
    const tool = operations.find((operation) => operation.name === 'bureau.tasks.cancel');
    expect(Object.keys(tool?.inputSchema['properties'] as object)).toContain('dryRun');
  });

  it('shows `dryRun` on each method in the Bureau OpenRPC wire golden', async () => {
    const golden = JSON.parse(
      await readFile(
        join(import.meta.dir, '..', '__fixtures__', 'wire-golden', 'local.openrpc.json'),
        'utf8',
      ),
    ) as { methods: Array<{ name: string; params: Array<{ name: string }> }> };
    for (const name of DRY_RUN_OPERATIONS) {
      const method = golden.methods.find((candidate) => candidate.name === name);
      expect(method?.params.map((parameter) => parameter.name)).toContain('dryRun');
    }
  });
});

describe('the effects of a dry run, counted from the Bureau’s own listings', () => {
  const summary = (id: string, status: string) => ({ id, status });
  const goal = (agentName: string, status: string) => ({ objective: { agentName }, status });

  it('counts an agent’s schedules, goals and open chats, and leaves out what has ended or been cancelled', async () => {
    const effects = await dryRunEffectsOf({
      schedules: {
        list: async () => ({
          items: [
            summary('a', 'active'),
            summary('b', 'paused'),
            summary('c', 'cancelled'),
            summary('d', 'active'),
          ] as never,
          total: 4,
          offset: 0,
          limit: 100,
        }),
        agentName: async (id) => (id === 'd' ? 'other' : 'writer'),
      },
      goals: {
        list: async () =>
          [
            goal('writer', 'running'),
            goal('writer', 'succeeded'),
            goal('writer', 'canceled'),
            goal('other', 'running'),
          ] as never,
      },
      contexts: {
        list: async (options) => {
          expect(options).toMatchObject({ agentName: 'writer', archived: 'exclude' });
          return [{ id: 'one' }, { id: 'two' }] as never;
        },
      },
      workflows: undefined,
    }).agentEffects('writer');
    expect(effects).toEqual([
      { kind: 'schedules', count: 2 },
      { kind: 'goals', count: 1 },
      { kind: 'open-chats', count: 2 },
    ]);
  });

  it('pages through the chats and reports a floor when it stops reading', async () => {
    let pages = 0;
    const effects = await dryRunEffectsOf({
      schedules: { list: async () => undefined, agentName: async () => undefined },
      goals: { list: async () => [] },
      contexts: {
        list: async () => {
          pages += 1;
          // Every page is full, so the listing never says it is done.
          return Array.from({ length: 100 }, (_, index) => ({
            id: `chat-${pages}-${index}`,
          })) as never;
        },
      },
      workflows: undefined,
    }).agentEffects('writer');
    expect(effects.find((entry) => entry.kind === 'open-chats')).toEqual({
      kind: 'open-chats',
      count: 10_000,
      atLeast: true,
    });
    expect(pages).toBe(100);
  });

  it('counts a workflow’s schedules by the identifier in their id, and its unfinished instances', async () => {
    const effects = await dryRunEffectsOf({
      schedules: {
        list: async () =>
          ({
            items: [
              summary('bureau-workflow-schedule:digest:1', 'cancelled'),
              summary('bureau-workflow-schedule:digest:2', 'active'),
              summary('bureau-workflow-schedule:other:1', 'active'),
              summary('a-schedule-of-an-agent', 'active'),
            ],
            total: 4,
            offset: 0,
            limit: 100,
          }) as never,
        agentName: async () => undefined,
      },
      goals: { list: async () => [] },
      contexts: { list: async () => [] },
      workflows: { runCounts: async () => ({ active: 3, last24Hours: 9, lastRunAt: null }) },
    }).workflowEffects('digest');
    expect(effects).toEqual([
      { kind: 'schedules', count: 1 },
      { kind: 'running-instances', count: 3 },
    ]);
  });

  it('is Unavailable when the engine cannot count a workflow’s instances, rather than answering 0', async () => {
    const source = {
      schedules: { list: async () => undefined, agentName: async () => undefined },
      goals: { list: async () => [] },
      contexts: { list: async () => [] },
      workflows: { runCounts: async () => null },
    };
    expect(await rejectionOf(dryRunEffectsOf(source).workflowEffects('digest'))).toMatchObject({
      code: 'Unavailable',
      data: { reason: 'workflow-run-counts-unavailable' },
    });
  });
});

async function startParkedRun(opened: OpenedBureau, sessionId?: string) {
  const run = await startTaskFrom(opened.bureau, {
    agentName: 'default',
    input: 'work',
    principal: OWNER.alice,
    ...(sessionId === undefined ? {} : { contextId: sessionId }),
  });
  await waitForCondition(
    () => opened.bureau.tasks.detail(run.id)?.status === 'running',
    `run ${run.id} never started`,
  );
  return run;
}

describe('bureau.tasks.cancel with dryRun', () => {
  it('counts the run it would stop, writes nothing and leaves the task running', async () => {
    await withBureau({}, async (opened, subject) => {
      const run = await startParkedRun(opened);
      const body = await expectNothingWritten(subject, () =>
        rpc(opened.handler, 'bureau.tasks.cancel', { taskId: run.id, dryRun: true }, 'alice-key'),
      );
      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'task', id: run.id },
        effects: [{ kind: 'runs-in-progress', count: 1 }],
      });
      expect(opened.bureau.tasks.detail(run.id)?.status).toBe('running');

      // The real call then does cancel it: the dry run was the only difference.
      const real = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'alice-key',
      );
      expect(real.result).toMatchObject({ taskId: run.id });
      expect(real.result?.['dryRun']).toBeUndefined();
    });
  });

  it('counts none for a task that has finished', async () => {
    await withBureau({ generate: answering() }, async (opened, subject) => {
      const run = await opened.bureau.tasks.start('default', 'done', { principal: OWNER.alice });
      await waitForTaskState(opened.bureau, run.id);
      const body = await expectNothingWritten(subject, () =>
        rpc(opened.handler, 'bureau.tasks.cancel', { taskId: run.id, dryRun: true }, 'alice-key'),
      );
      expect(dryRunResultOf(body).effects).toEqual([{ kind: 'runs-in-progress', count: 0 }]);
    });
  });

  it('answers the fault the real call answers for a task that is missing or another owner’s', async () => {
    await withBureau({}, async (opened) => {
      const run = await startParkedRun(opened);
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.tasks.cancel',
        { taskId: 'no-such-task' },
        'alice-key',
      );
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.tasks.cancel',
        { taskId: run.id },
        'bob-key',
      );
    });
  });

  it('refuses a `dryRun` that is not a boolean, so it never runs the real call', async () => {
    await withBureau({}, async (opened) => {
      const run = await startParkedRun(opened);
      const body = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: run.id, dryRun: 'true' },
        'alice-key',
      );
      expect(body.error?.data?.httpStatus).toBe(400);
      expect(opened.bureau.tasks.detail(run.id)?.status).toBe('running');
    });
  });
});

describe('bureau.contexts.delete with dryRun', () => {
  it('counts the runs in progress it would cancel, writes nothing and keeps the context', async () => {
    await withBureau({}, async (opened, subject) => {
      const run = await startParkedRun(opened, 'chat-with-a-run');
      const body = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.contexts.delete',
          { contextId: run.contextId, dryRun: true },
          'alice-key',
        ),
      );
      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'context', id: run.contextId },
        effects: [{ kind: 'runs-in-progress', count: 1 }],
      });
      expect(await opened.bureau.contexts.get(run.contextId)).toBeDefined();
      expect(opened.bureau.tasks.detail(run.id)?.status).toBe('running');
    });
  });

  it('counts none for a chat with nothing running', async () => {
    await withBureau({ generate: answering() }, async (opened, subject) => {
      const run = await opened.bureau.tasks.start('default', 'done', { principal: OWNER.alice });
      await waitForTaskState(opened.bureau, run.id);
      const body = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.contexts.delete',
          { contextId: run.contextId, dryRun: true },
          'alice-key',
        ),
      );
      expect(dryRunResultOf(body).effects).toEqual([{ kind: 'runs-in-progress', count: 0 }]);
    });
  });

  it('answers the fault the real call answers for a context that is missing or another owner’s', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const run = await opened.bureau.tasks.start('default', 'done', { principal: OWNER.alice });
      await waitForTaskState(opened.bureau, run.id);
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.contexts.delete',
        { contextId: 'no-such-chat' },
        'alice-key',
      );
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.contexts.delete',
        { contextId: run.contextId },
        'bob-key',
      );
    });
  });
});

describe('bureau.contexts.forgetgrants with dryRun', () => {
  const agent = createAgent({
    name: 'agent',
    generate: async () => ({ content: 'the answer', toolCalls: [] }),
  });

  async function chatWithGrants(opened: OpenedBureau, grants: readonly string[]) {
    const run = await opened.bureau.tasks.start('agent', 'go', { principal: OWNER.alice });
    await waitForTaskState(opened.bureau, run.id);
    await opened.bureau.internals.sessionStore!.update(run.contextId, (session) =>
      session === undefined
        ? undefined
        : { ...session, metadata: { ...session.metadata, approvalGrants: [...grants] } },
    );
    return run;
  }

  it('counts the grants it would forget and forgets none', async () => {
    await withBureau({ agents: { agent } }, async (opened, subject) => {
      const run = await chatWithGrants(opened, [
        'default:issue_refund@3',
        'issue_refund',
        'shop:lookup_order@1',
      ]);
      const body = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.contexts.forgetgrants',
          { contextId: run.contextId, tools: ['issue_refund'], dryRun: true },
          'alice-key',
        ),
      );
      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'context-grants', id: run.contextId },
        effects: [{ kind: 'tool-grants', count: 2 }],
      });
      const session = await opened.bureau.contexts.get(run.contextId);
      expect(session?.metadata['approvalGrants']).toEqual([
        'default:issue_refund@3',
        'issue_refund',
        'shop:lookup_order@1',
      ]);
    });
  });

  it('answers the fault the real call answers for a context that is missing or another owner’s', async () => {
    await withBureau({ agents: { agent } }, async (opened) => {
      const run = await chatWithGrants(opened, ['issue_refund']);
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.contexts.forgetgrants',
        { contextId: 'no-such-chat', tools: ['issue_refund'] },
        'alice-key',
      );
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.contexts.forgetgrants',
        { contextId: run.contextId, tools: ['issue_refund'] },
        'bob-key',
      );
    });
  });
});

async function goalStatusOf(opened: OpenedBureau, goalRunId: string) {
  const goal = await opened.bureau.goals.get(goalRunId);
  return goal?.status;
}

describe('bureau.goals.cancel with dryRun', () => {
  const NEW_GOAL = {
    agentName: 'worker',
    prompt: 'do the thing',
    identity: { name: 'goal', version: '1' },
    validator: CHECK,
    bounds: { maximumAttempts: 3, maximumTotalSteps: 100 },
  };

  async function withGoal<T>(
    body: (opened: OpenedBureau, subject: DryRunSubject, goalRunId: string) => Promise<T>,
  ): Promise<T> {
    return withBureau(
      {
        agents: { worker: workerAgent(hangUntilAborted) },
        a2aAgents: ['worker'],
        generate: hangUntilAborted,
        validators: [createCheckValidator()],
      },
      async (opened, subject) => {
        const created = await rpc(
          opened.handler,
          'bureau.goals.create',
          { ...NEW_GOAL, idempotencyKey: 'dry-run-goal' },
          'alice-key',
        );
        expect(created.error).toBeUndefined();
        const goalRunId = (created.result!['goal'] as { goalRunId: string }).goalRunId;
        await waitForCondition(async () => {
          const goal = await opened.bureau.goals.get(goalRunId);
          return (goal?.attempts.length ?? 0) > 0;
        }, 'the goal starts an attempt');
        return body(opened, subject, goalRunId);
      },
    );
  }

  it('counts the attempt runs it would stop, writes nothing and leaves the goal running', async () => {
    await withGoal(async (opened, subject, goalRunId) => {
      const body = await expectNothingWritten(subject, () =>
        rpc(opened.handler, 'bureau.goals.cancel', { goalRunId, dryRun: true }, 'alice-key'),
      );
      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'goal', id: goalRunId },
        effects: [{ kind: 'runs-in-progress', count: 1 }],
      });
      expect(await goalStatusOf(opened, goalRunId)).toBe('running');
    });
  });

  it('counts no run for the task of one of its attempts: the real cancel of that task stops nothing', async () => {
    await withGoal(async (opened, subject, goalRunId) => {
      const attemptRunId = (await opened.bureau.goals.get(goalRunId))!.attempts[0]!.runId;

      const dry = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.tasks.cancel',
          { taskId: attemptRunId, dryRun: true },
          'alice-key',
        ),
      );
      expect(dryRunResultOf(dry).effects).toEqual([{ kind: 'runs-in-progress', count: 0 }]);

      const real = await rpc(
        opened.handler,
        'bureau.tasks.cancel',
        { taskId: attemptRunId },
        'alice-key',
      );
      expect(real.result).toMatchObject({ receipt: 'rejected', reason: 'owned-by-goal' });
      expect(await goalStatusOf(opened, goalRunId)).toBe('running');
    });
  });

  it('answers a StaleRevision when `expectedRevision` is not the goal’s, as the real call does', async () => {
    await withGoal(async (opened, _subject, goalRunId) => {
      const params = { goalRunId, expectedRevision: 999 };
      const real = await rpc(opened.handler, 'bureau.goals.cancel', params, 'alice-key');
      const dry = await rpc(
        opened.handler,
        'bureau.goals.cancel',
        { ...params, dryRun: true },
        'alice-key',
      );
      expect(real.error?.data?.httpStatus).toBe(409);
      expect(dry.error).toEqual(real.error);
      expect(await goalStatusOf(opened, goalRunId)).toBe('running');
    });
  });

  it('answers the fault the real call answers for a goal that is missing or another owner’s', async () => {
    await withGoal(async (opened, _subject, goalRunId) => {
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.goals.cancel',
        { goalRunId: 'no-such-goal' },
        'alice-key',
      );
      await expectSameFaultAsTheRealCall(opened, 'bureau.goals.cancel', { goalRunId }, 'bob-key');
    });
  });
});
