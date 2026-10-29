/**
 * COR-1707. `bureau.tasks.start` is the one way to start a task: it always runs in a context (a
 * new one when none is named), its `commandId` replays through the command ledger under the
 * task-start operation version, and its handle reads the task's result, liveness, and events.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  type RunEvent,
  stopWhen,
} from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from '../agent-catalog.ts';
import { BureauLedgerConflictError, createCommandLedger } from '../command-ledger.ts';
import { BureauError, createBureau } from '../create-bureau.ts';
import { waitForCondition } from '../test/index.ts';
import {
  createSqliteStorageFixture,
  type BureauStorageFixture as StorageFixture,
} from '../test/storage-fixtures.ts';
import { createAskingAgent } from '../test/task-record-crash-agent.ts';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { Bureau } from '../types.ts';
import { MemoryStorage } from '@lostgradient/storage';

const ORIGIN = '2026-10-26T00:00:00.000Z';

const bureaus: Bureau<AgentDefinitions>[] = [];
const fixtures: StorageFixture[] = [];

afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

/** A generate that holds every task at its first step until `release()`. */
function held(): { generate: GenerateFunction; release(): void } {
  const gate = Promise.withResolvers<void>();
  return {
    generate: async () => {
      await gate.promise;
      return { content: 'done', toolCalls: [] };
    },
    release: () => gate.resolve(),
  };
}

type Opened = { readonly bureau: Bureau<AgentDefinitions>; readonly release: () => void };

async function open(
  options: { durable?: boolean; fixture?: StorageFixture; released?: boolean } = {},
): Promise<Opened & { readonly fixture: StorageFixture | undefined }> {
  const durable = options.durable ?? true;
  const runtime = createManualRuntimeServices({ origin: ORIGIN });
  const fixture = durable
    ? (options.fixture ?? createSqliteStorageFixture({ runtime }))
    : undefined;
  if (fixture !== undefined && options.fixture === undefined) fixtures.push(fixture);
  const gate = held();
  if (options.released === true) gate.release();
  const agent = () =>
    createAgent({
      generate: gate.generate,
      stopWhen: stopWhen.noToolCalls(),
      toolbox: createToolbox([]),
    });
  const bureau = await createBureau<AgentDefinitions>({
    agents: { default: agent(), researcher: agent(), asker: createAskingAgent() },
    runtime,
    ...(fixture === undefined
      ? { storage: new MemoryStorage() }
      : {
          storage: fixture.storage,
          durable: true,
          durableOwnership: { ownership: 'none' as const },
        }),
  });
  bureaus.push(bureau);
  await bureau.recovery();
  return { bureau, release: gate.release, fixture };
}

async function collect(iterable: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe('bureau.tasks.start contexts', () => {
  it('creates a context, listed by contexts.list(), when none is named', async () => {
    const { bureau, release } = await open();
    const task = await bureau.tasks.start('default', 'hello');
    release();
    await task.result();
    const listed = await bureau.contexts.list();
    expect(listed.map((context) => context.id)).toContain(task.contextId);
  });

  it('continues the caller’s own context', async () => {
    const { bureau, release } = await open({ released: true });
    release();
    const first = await bureau.tasks.start('default', 'one', { principal: 'alice' });
    await first.result();
    const second = await bureau.tasks.start('default', 'two', {
      principal: 'alice',
      contextId: first.contextId,
    });
    await second.result();
    expect(second.contextId).toBe(first.contextId);
    expect(second.id).not.toBe(first.id);
  });

  it('refuses a context bound to another agent with BAD_REQUEST', async () => {
    const { bureau } = await open({ released: true });
    const first = await bureau.tasks.start('default', 'one');
    await first.result();
    const refusal = await rejectionOf(
      bureau.tasks.start('researcher', 'two', { contextId: first.contextId }),
    );
    expect(refusal).toBeInstanceOf(BureauError);
    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
  });

  it('refuses another principal’s context as NOT_FOUND', async () => {
    const { bureau } = await open({ released: true });
    const first = await bureau.tasks.start('default', 'one', { principal: 'alice' });
    await first.result();
    const refusal = await rejectionOf(
      bureau.tasks.start('default', 'two', { principal: 'mallory', contextId: first.contextId }),
    );
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
  });

  it('refuses a seeding conversation that also names a context with BAD_REQUEST', async () => {
    const { bureau } = await open({ released: true });
    const first = await bureau.tasks.start('default', 'one');
    await first.result();
    const conversation = (await bureau.contexts.get(first.contextId))!.conversationHistory;
    const refusal = await rejectionOf(
      bureau.tasks.start('default', { conversation }, { contextId: first.contextId }),
    );
    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
  });

  it('seeds a new context with a conversation, whose task runs on that history', async () => {
    const { bureau } = await open({ released: true });
    const first = await bureau.tasks.start('default', 'one');
    await first.result();
    const conversation = (await bureau.contexts.get(first.contextId))!.conversationHistory;

    const seeded = await bureau.tasks.start('default', { conversation });
    const result = await seeded.result();

    expect(result.content).toBe('done');
    expect(seeded.contextId).not.toBe(first.contextId);
    const listed = await bureau.contexts.list();
    expect(listed.map((context) => context.id)).toContain(seeded.contextId);
    const history = (await bureau.contexts.get(seeded.contextId))!.conversationHistory;
    const texts = history.ids.map((id) => history.messages[id]?.content);
    // The seeded history, then the seeded task's own answer.
    expect(texts.slice(0, conversation.ids.length)).toEqual(
      conversation.ids.map((id) => conversation.messages[id]?.content),
    );
    expect(texts.length).toBeGreaterThan(conversation.ids.length);
  });

  it('gives a parked task’s review the context the task created', async () => {
    const { bureau } = await open();
    const task = await bureau.tasks.start('asker', 'deploy it');
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === task.id),
      'the task parks on its human wait',
    );
    const review = bureau.reviews.list().find((candidate) => candidate.runId === task.id);
    expect(review?.sessionId).toBe(task.contextId);
  });
});

describe('bureau.tasks.start with a commandId', () => {
  it('refuses a commandId without a principal with BAD_REQUEST', async () => {
    const { bureau } = await open();
    const refusal = await rejectionOf(bureau.tasks.start('default', 'x', { commandId: 'cmd-1' }));
    expect((refusal as BureauError).code).toBe('BAD_REQUEST');
  });

  it('refuses a commandId without a durable engine with NOT_CONFIGURED', async () => {
    const { bureau } = await open({ durable: false });
    const refusal = await rejectionOf(
      bureau.tasks.start('default', 'x', { commandId: 'cmd-1', principal: 'alice' }),
    );
    expect((refusal as BureauError).code).toBe('NOT_CONFIGURED');
    expect((refusal as BureauError).subject).toBe('durable');
  });

  it('records a receipt and replays the same task on a retry while it runs', async () => {
    const { bureau, release } = await open();
    const options = { commandId: 'cmd-1', principal: 'alice' } as const;
    const first = await bureau.tasks.start('default', 'hello', options);
    const retry = await bureau.tasks.start('default', 'hello', options);
    expect(first.receipt?.requestId).toBe('cmd-1');
    expect(retry.id).toBe(first.id);
    expect(retry.contextId).toBe(first.contextId);
    expect(retry.receipt).toEqual(first.receipt);
    const tail = collect(retry);
    release();
    const result = await retry.result();
    expect(result.content).toBe('done');
    const tailEvents = await tail;
    expect(tailEvents.some((event) => event.type === 'run.completed')).toBe(true);
    const located = await bureau.tasks.receipt({
      commandId: 'cmd-1',
      principal: 'alice',
      agentName: 'default',
    });
    expect(located.status).toBe('recorded');
  });

  it('replays a settled task, whose handle still settles its result', async () => {
    const { bureau } = await open({ released: true });
    const options = { commandId: 'cmd-1', principal: 'alice' } as const;
    const first = await bureau.tasks.start('default', 'hello', options);
    await first.result();
    const retry = await bureau.tasks.start('default', 'hello', options);
    expect(retry.id).toBe(first.id);
    const replayed = await retry.result();
    expect(replayed.content).toBe('done');
  });

  it('replays the task a process before a restart started', async () => {
    const before = await open({ released: true });
    const options = { commandId: 'cmd-1', principal: 'alice' } as const;
    const first = await before.bureau.tasks.start('default', 'hello', options);
    await first.result();
    await before.bureau.tasks.wait(first.id);
    await before.bureau.dispose();
    bureaus.splice(bureaus.indexOf(before.bureau), 1);

    const after = await open({ fixture: before.fixture!, released: true });
    const retry = await after.bureau.tasks.start('default', 'hello', options);
    expect(retry.id).toBe(first.id);
    expect(retry.contextId).toBe(first.contextId);
    expect(await collect(retry)).toEqual([]);
    const result = await retry.result();
    expect(result.finishReason).toBe('stop-condition');
  });

  it('refuses a retry that changes the agent, input, context, or request context', async () => {
    const { bureau } = await open({ released: true });
    const options = { commandId: 'cmd-1', principal: 'alice' } as const;
    const first = await bureau.tasks.start('default', 'hello', options);
    await first.result();
    expect(await rejectionOf(bureau.tasks.start('default', 'bye', options))).toBeInstanceOf(
      BureauLedgerConflictError,
    );
    expect(
      await rejectionOf(
        bureau.tasks.start('default', 'hello', { ...options, contextId: first.contextId }),
      ),
    ).toBeInstanceOf(BureauLedgerConflictError);
    const requestContext = {
      authority: {
        principalId: 'alice',
        tenantId: 'bureau',
        ownerId: 'default',
        capabilities: ['tools:execute'],
        authorizationRevision: 'bureau:1',
      },
      audience: 'tenant' as const,
    };
    expect(
      await rejectionOf(bureau.tasks.start('default', 'hello', { ...options, requestContext })),
    ).toBeInstanceOf(BureauLedgerConflictError);
  });

  it('does not read a receipt recorded under the previous operation version', async () => {
    const { bureau } = await open({ released: true });
    const runtime = createManualRuntimeServices({ origin: ORIGIN });
    const ledger = createCommandLedger<{ runId: string; sessionId: string }, object>({
      kv: bureau.internals.kv!,
      clock: runtime.clock,
      nextConflictId: () => runtime.identifiers.next('conflict'),
    });
    const claimed = await ledger.claim(
      {
        callerId: 'alice',
        target: 'default',
        requestId: 'cmd-1',
        operationVersion: 'bureau.run-creation.v1',
      },
      'old-digest',
      { runId: 'run-from-v1', sessionId: 'session-from-v1' },
    );
    if (claimed.outcome !== 'claimed') throw new Error('expected a fresh claim');
    await ledger.complete(claimed.entry, { status: 'completed' });

    const task = await bureau.tasks.start('default', 'hello', {
      commandId: 'cmd-1',
      principal: 'alice',
    });
    expect(task.id).not.toBe('run-from-v1');
    expect(task.receipt?.runId).toBe(task.id);
    await task.result();
  });
});

describe('the task handle', () => {
  it('aborts a task before it settles', async () => {
    const { bureau } = await open();
    const task = await bureau.tasks.start('default', 'hello');
    task.abort('stop');
    const result = await task.result();
    expect(result.finishReason).toBe('aborted');
  });

  it('does nothing when aborted after the task settled', async () => {
    const { bureau } = await open({ released: true });
    const task = await bureau.tasks.start('default', 'hello');
    const result = await task.result();
    task.abort('too late');
    expect(result.finishReason).toBe('stop-condition');
    expect(bureau.tasks.detail(task.id)?.status).toBe('completed');
  });

  it('iterates the task’s events from its start once, and nothing on a second iteration', async () => {
    const { bureau, release } = await open();
    const task = await bureau.tasks.start('default', 'hello');
    release();
    const events = await collect(task);
    expect(events[0]?.type).toBe('run.started');
    expect(events.some((event) => event.type === 'run.completed')).toBe(true);
    expect(await collect(task)).toEqual([]);
  });

  it('reads a snapshot while the task runs and after it settles', async () => {
    const { bureau, release } = await open();
    const task = await bureau.tasks.start('default', 'hello');
    expect(task.snapshot().id).toBe(task.id);
    release();
    await task.result();
    expect(task.snapshot().status).toBe('terminal');
  });
});

describe('bureau.tasks.cancel', () => {
  it('answers with the registry’s receipt, and rejected once the task finished', async () => {
    const { bureau, release } = await open();
    const running = await bureau.tasks.start('default', 'hello');
    const cancelled = await bureau.tasks.cancel(running.id);
    expect([
      'cancel-requested',
      'canceled',
      'cleanup-pending',
      'cleaned-up',
      'cleanup-failed',
      'cleanup-unresolved',
      'unknown-outcome',
    ]).toContain(cancelled.receipt);
    release();
    await running.result();

    const finished = await bureau.tasks.start('default', 'again');
    await finished.result();
    const late = await bureau.tasks.cancel(finished.id);
    expect(late).toEqual({ receipt: 'rejected', reason: 'already-terminal' });
  });

  it('refuses a task it does not hold as NOT_FOUND', async () => {
    const { bureau } = await open();
    const refusal = await rejectionOf(bureau.tasks.cancel('run-missing'));
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
  });
});
