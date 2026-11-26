/**
 * COR-2095 — the rows of `tmp/chef/briefs/COR-2095-matrix.md` that need a second process or a
 * restart: a run whose owner is gone (`owner-lost`), a stalled owner whose real settlement then
 * replaces that inference, a terminal checkpoint settled at boot, a run that fails after the
 * restart, and what the durable event history keeps of `run.settled`.
 *
 * Each "process" is a Bureau with its own manual runtime over one SQLite file, as
 * `process-local-task-lease.test.ts` builds them. Nothing waits on a wall clock.
 */
import { createManualRuntimeServices, type ManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateFunction,
  stopWhen,
  type GenerateContext,
} from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createToolbox } from 'armorer/testing';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { failingWrites } from './schedule-fire-fixtures.test-support';
import { createSqliteStorageFixture } from './test/storage-fixtures';
import { createDurableEventHistoryFixture } from './test/durable-event-history-fixture';

const ORIGIN_MS = Date.parse('2026-10-30T00:00:00.000Z');
const SECOND = 1_000;
const PRINCIPAL = 'api-key:alice';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

interface Published {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

const OUTCOME_OR_SETTLED = new Set(['run.completed', 'run.error', 'run.aborted', 'run.settled']);

/** The outcome and `run.settled` envelopes of one run on one Bureau's feed, in order. */
async function outcomesOf(bureau: Bureau, runId: string): Promise<Published[]> {
  await bureau.internals.taskRegistry.flush();
  const published: Published[] = [];
  for await (const envelope of bureau.internals.eventFeed.feed.replay()) {
    const entry = envelope as unknown as Published;
    if (OUTCOME_OR_SETTLED.has(entry.kind) && entry.payload['runId'] === runId) {
      published.push({ kind: entry.kind, payload: entry.payload });
    }
  }
  return published;
}

/** How many outcome and `run.settled` envelopes one run has on one Bureau's feed. */
async function outcomeCount(bureau: Bureau, runId: string): Promise<number> {
  const published = await outcomesOf(bureau, runId);
  return published.length;
}

/** A parked run ends when its process lets it, or fails when it is aborted (shutdown). */
function parkedUntil(finish: Promise<void>, outcome: 'completed' | 'failed'): GenerateFunction {
  return ({ signal }) =>
    new Promise((resolve, reject) => {
      void finish.then(() => {
        if (outcome === 'failed') reject(new Error('the provider failed'));
        else resolve({ content: 'done', toolCalls: [] });
      });
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

interface Process {
  readonly bureau: Bureau<AgentDefinitions>;
  readonly runtime: ManualRuntimeServices;
  readonly finishRuns: () => void;
}

async function boot(
  database: ReturnType<typeof createSqliteStorageFixture>,
  atMilliseconds: number,
  outcome: 'completed' | 'failed' = 'completed',
): Promise<Process> {
  const runtime = createManualRuntimeServices({ origin: new Date(atMilliseconds).toISOString() });
  let finishRuns = (): void => undefined;
  const finish = new Promise<void>((resolve) => {
    finishRuns = resolve;
  });
  const bureau = await createBureau<AgentDefinitions>({
    agents: {
      default: createAgent({
        generate: parkedUntil(finish, outcome),
        toolbox: createToolbox([]),
        stopWhen: stopWhen.noToolCalls(),
      }),
    },
    storage: database.open(),
    durable: false,
    runtime,
    maintenance: 'automatic',
    onDiagnostic: () => undefined,
  });
  cleanups.push(async () => {
    finishRuns();
    await bureau.shutdown();
  });
  return { bureau, runtime, finishRuns };
}

async function startTask(process: Process): Promise<string> {
  const task = await process.bureau.tasks.start('default', 'work', { principal: PRINCIPAL });
  return task.id;
}

describe('a run whose owner is gone (owner-lost)', () => {
  it('is announced by the process that boots next: run.error with owner-lost, then run.settled failed', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const crashed = await boot(database, ORIGIN_MS);
    const taskId = await startTask(crashed);

    const booter = await boot(database, ORIGIN_MS + 31 * SECOND);
    await booter.bureau.recovery();
    await waitUntil(async () => (await outcomeCount(booter.bureau, taskId)) === 2, {
      message: 'the booter announced the lost run',
    });

    const published = await outcomesOf(booter.bureau, taskId);
    expect(published.map((entry) => entry.kind)).toEqual(['run.error', 'run.settled']);
    expect(published[0]?.payload).toMatchObject({
      runId: taskId,
      finishReason: 'owner-lost',
    });
    for (const absent of ['step', 'errorCode', 'errorKind', 'message']) {
      expect(published[0]?.payload).not.toHaveProperty(absent);
    }
    expect(published[1]?.payload).toEqual({
      runId: taskId,
      status: 'failed',
      finishReason: 'owner-lost',
    });
  });

  it.each([
    ['completed', 'run.completed', 'completed'],
    ['failed', 'run.error', 'failed'],
    ['canceled', 'run.aborted', 'canceled'],
  ] as const)(
    'is announced again on the stalled owner’s own feed when its real settlement (%s) replaces the inference, and the booter’s pair stands',
    async (real, outcomeKind, status) => {
      const database = createSqliteStorageFixture();
      cleanups.push(() => database.dispose());
      const stalled = await boot(database, ORIGIN_MS, real === 'failed' ? 'failed' : 'completed');
      const taskId = await startTask(stalled);
      const booter = await boot(database, ORIGIN_MS + 31 * SECOND);
      await booter.bureau.recovery();
      await waitUntil(async () => (await outcomeCount(booter.bureau, taskId)) === 2, {
        message: 'the booter announced the lost run',
      });
      expect(await outcomesOf(stalled.bureau, taskId)).toEqual([]);

      // The owner was alive all along; its run now ends for real.
      if (real === 'canceled') await stalled.bureau.tasks.cancel(taskId);
      else stalled.finishRuns();
      await waitUntil(async () => (await outcomeCount(stalled.bureau, taskId)) === 2, {
        message: 'the owner announced its own settlement',
      });

      const own = await outcomesOf(stalled.bureau, taskId);
      expect(own.map((entry) => entry.kind)).toEqual([outcomeKind, 'run.settled']);
      expect(own[1]?.payload).toMatchObject({ runId: taskId, status });
      expect(own[1]?.payload['finishReason']).not.toBe('owner-lost');
      // The booter's earlier pair stands, unchanged.
      const lost = await outcomesOf(booter.bureau, taskId);
      expect(lost.map((entry) => entry.kind)).toEqual(['run.error', 'run.settled']);
      expect(lost[0]?.payload['finishReason']).toBe('owner-lost');
    },
  );

  // Matrix row "owner-lost, then the real settlement, in the durable history" has nothing to
  // observe: `owner-lost` is a settlement of a process-local run (`durable: false`), which keeps
  // no durable event history (`tasks.events` answers `unsupported-capability` there), and a
  // durable run is recovered from its checkpoint instead. The announcement the history sink hangs
  // on is the one `run.settled` listener, which the rows above and below cover for each status.
  it('has no durable history for a process-local run, so owner-lost writes no history entry', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const crashed = await boot(database, ORIGIN_MS);
    const taskId = await startTask(crashed);
    const booter = await boot(database, ORIGIN_MS + 31 * SECOND);
    await booter.bureau.recovery();
    await waitUntil(async () => (await outcomeCount(booter.bureau, taskId)) === 2, {
      message: 'the booter announced the lost run',
    });

    expect(await booter.bureau.tasks.events(taskId)).toMatchObject({
      outcome: 'unsupported-capability',
    });
  });
});

describe('what the durable event history keeps of a settlement', () => {
  const agents = (generate: GenerateFunction) => ({
    default: createAgent({
      generate,
      toolbox: createToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
    }),
  });

  async function historyOf(generate: GenerateFunction, abort = false) {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const bureau = await createBureau<AgentDefinitions>({
      agents: agents(generate),
      storage: database.open(),
      durable: true,
      durableOwnership: { ownership: 'none' },
      onDiagnostic: () => undefined,
    });
    cleanups.push(() => bureau.dispose());
    const run = await bureau.tasks.start('default', 'go', { principal: PRINCIPAL });
    if (abort) {
      await waitUntil(() => bureau.internals.store.getRun(run.id)?.status === 'running', {
        message: 'the run is running',
      });
      await bureau.tasks.cancel(run.id);
    }
    await waitUntil(
      async () => {
        const task = await bureau.tasks.get(run.id);
        return ['completed', 'failed', 'canceled'].includes(task?.status ?? '');
      },
      { message: 'the task is terminal' },
    );
    await bureau.internals.taskRegistry.flush();
    await waitUntil(
      async () => {
        const page = await bureau.tasks.events(run.id);
        return !('outcome' in page) && page.events.some((event) => event.kind === 'run.settled');
      },
      { message: 'run.settled reached the history' },
    );
    const page = await bureau.tasks.events(run.id);
    if ('outcome' in page) throw new Error('expected a page');
    return { runId: run.id, events: page.events };
  }

  it.each([
    [
      'completes',
      async () => ({ content: 'done', toolCalls: [] }),
      false,
      'completed',
      'stop-condition',
      ['run.completed', 'run.settled'],
    ],
    [
      'fails',
      async () => Promise.reject(new Error('the provider failed')),
      false,
      'failed',
      'error',
      ['run.error', 'run.completed', 'run.settled'],
    ],
    [
      'aborts',
      ({ signal }: GenerateContext) =>
        new Promise<never>((_resolve, reject) =>
          signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
      true,
      'canceled',
      'aborted',
      ['run.aborted', 'run.settled'],
    ],
  ] as const)(
    'a run that %s: run.settled carries status and finishReason, and no outcome kind is sunk',
    async (_name, generate, abort, status, finishReason, kinds) => {
      const { runId, events } = await historyOf(generate, abort);

      const settled = events.filter((event) => event.kind === 'run.settled');
      expect(settled).toHaveLength(1);
      expect(settled[0]?.payload).toEqual({ runId, status, finishReason });
      // The kinds are the run's own actions and `run.settled`: the outcome events this change
      // publishes are not sunk, because the run's own action already is.
      expect(events.map((event) => event.kind)).toEqual([...kinds]);
    },
  );

  it('reads a run.settled entry written before this change as it is, with no status', async () => {
    const fixture = await createDurableEventHistoryFixture({
      backend: 'sqlite',
      sequence: [
        {
          owner: { kind: 'run', id: 'old-run' },
          kind: 'run.settled',
          payload: { runId: 'old-run' },
        },
      ],
    });
    try {
      expect(fixture.envelopes[0]).toMatchObject({
        kind: 'run.settled',
        payload: { runId: 'old-run' },
      });
      expect(fixture.envelopes[0]?.payload).not.toHaveProperty('status');
    } finally {
      await fixture.dispose();
    }
  });
});

describe('a run settled at boot, and a run that fails after a restart', () => {
  async function openOver(
    database: ReturnType<typeof createSqliteStorageFixture>,
    generate: GenerateFunction,
    storage = database.open(),
  ) {
    const bureau = await createBureau<AgentDefinitions>({
      id: 'outcome-recovery',
      agents: {
        default: createAgent({
          generate,
          toolbox: createToolbox([]),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage,
      durable: true,
      durableOwnership: { ownership: 'none' },
      onDiagnostic: () => undefined,
    });
    cleanups.push(() => bureau.dispose());
    return bureau;
  }

  it.each([
    ['completes', async () => ({ content: 'done', toolCalls: [] }), 'run.completed'],
    ['fails', async () => Promise.reject(new Error('the provider failed')), 'run.error'],
  ] as const)(
    'announces the outcome of a durable run whose checkpoint was terminal when its settlement write was lost (%s)',
    async (_name, generate, outcomeKind) => {
      const database = createSqliteStorageFixture();
      cleanups.push(() => database.dispose());
      // The first process finishes the run but never records how it ended.
      const faults = failingWrites('"settled":{', 1_000);
      const first = await openOver(database, generate, faults.wrap(database.open()));
      const run = await first.tasks.start('default', 'go', { principal: PRINCIPAL });
      await waitUntil(() => faults.failed > 0, { message: 'the settlement write was lost' });
      await first.internals.taskRegistry.flush();
      expect(await outcomesOf(first, run.id)).toEqual([]);
      await first.dispose();

      const second = await openOver(database, generate);
      await second.recovery();
      await waitUntil(async () => (await outcomeCount(second, run.id)) === 2, {
        message: 'the boot settled the run from its checkpoint',
      });

      const published = await outcomesOf(second, run.id);
      expect(published.map((entry) => entry.kind)).toEqual([outcomeKind, 'run.settled']);
      if (outcomeKind === 'run.error') {
        for (const absent of ['step', 'errorCode', 'errorKind']) {
          expect(published[0]?.payload).not.toHaveProperty(absent);
        }
      }
    },
  );

  it('announces run.error with the code and kind of a run that fails after it was recovered and resumed', async () => {
    const database = createSqliteStorageFixture();
    cleanups.push(() => database.dispose());
    const asksThenFails: GenerateFunction = async (context: GenerateContext) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'answer', prompt: 'Which environment?' },
            },
          ],
        };
      }
      throw new Error('the provider failed after the answer');
    };
    const crashed = await openOver(database, asksThenFails);
    const run = await crashed.tasks.start('default', 'which?', { principal: PRINCIPAL });
    await waitUntil(() => crashed.reviews.list().some((review) => review.runId === run.id), {
      message: 'the run parked',
    });

    const restarted = await openOver(database, asksThenFails);
    await restarted.recovery();
    await waitUntil(() => restarted.reviews.list().some((review) => review.runId === run.id), {
      message: 'the recovered run parked again',
    });
    const [review] = restarted.reviews.list().filter((candidate) => candidate.runId === run.id);
    await restarted.reviews.resolve({
      id: review!.id,
      decision: 'approve',
      principal: PRINCIPAL,
      payload: 'staging',
    });
    await waitUntil(
      async () => {
        const task = await restarted.tasks.get(run.id);
        return task?.status === 'failed';
      },
      { message: 'the recovered run failed' },
    );

    const published = await outcomesOf(restarted, run.id);
    expect(published.map((entry) => entry.kind)).toEqual(['run.error', 'run.settled']);
    expect(published[0]?.payload).toMatchObject({ runId: run.id, finishReason: 'error' });
    expect(typeof published[0]?.payload['errorCode']).toBe('string');
    expect(typeof published[0]?.payload['errorKind']).toBe('string');
  });
});
