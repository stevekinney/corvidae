/**
 * `task.resynced` (COR-1669, part 2b-3): a failed durable append leaves every reader of a task's
 * history behind for good, so the Bureau appends one event that restates where the task stands.
 * Each test starts at the management handler's `bureau.tasks.events`, over a real SQLite store
 * whose appends a test fails on demand.
 */
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { GenerateFunction } from '@lostgradient/operative';
import { resolveStorage } from '@lostgradient/weft';
import { type Storage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import { createSqliteStorageFixture } from '../../test/storage-fixtures';
import { TASK_RESYNCED_EVENT_KIND } from '../../task-resync.ts';
import { createTaskEventProjector } from './tasks-events-operation.ts';
import {
  approvalToolbox,
  chargesOnce,
  openBureau,
  type OpenedBureau,
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
  type SseFrame,
} from './management-fixtures.test-support.ts';
import { quietFor } from '@lostgradient/testing/wait-until';

type Faults = {
  /** How many of the next appends to the durable history fail. */
  failAppends: number;
  /** When set, the boot repair's listing of owed tasks waits for it, and `held` resolves once one is waiting. */
  hold?: Promise<void> | undefined;
  held?: () => void;
};

type Faulty = { readonly storage: Storage; readonly faults: Faults };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

type StoredOperation = { readonly key: string; readonly value?: Uint8Array | undefined };

/** Whether an operation appends an event owned by a run (not a session's, a schedule's...). */
function isRunAppend(operation: StoredOperation): boolean {
  if (!operation.key.startsWith('fleet-event:') || operation.value === undefined) return false;
  return new TextDecoder().decode(operation.value).includes('run:run-');
}

/** A SQLite store that survives Bureaus, and fails the next `faults.failAppends` history appends. */
async function faultyStorage(): Promise<Faulty> {
  const fixture = createSqliteStorageFixture({ runtime: createDefaultRuntimeServices() });
  const base = await resolveStorage(fixture.configuration);
  const faults: Faults = { failAppends: 0 };
  const storage = new Proxy(base, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'keys' && faults.hold !== undefined) {
        return async function* (...parameters: unknown[]) {
          // The boot repair's own listing of the tasks it owes, not the reconcile's before it.
          if (new Error().stack?.includes('resyncCandidates') === true) {
            faults.held?.();
            await faults.hold;
          }
          yield* (value as (...arguments_: unknown[]) => AsyncIterable<unknown>).call(
            target,
            ...parameters,
          );
        };
      }
      if (property === 'conditionalBatch') {
        return async (
          conditions: unknown,
          operations: readonly StoredOperation[],
          ...rest: unknown[]
        ) => {
          if (faults.failAppends > 0 && operations.some((o) => isRunAppend(o))) {
            faults.failAppends -= 1;
            throw new Error('injected: the history append failed');
          }
          return (value as (...parameters: unknown[]) => unknown).call(
            target,
            conditions,
            operations,
            ...rest,
          );
        };
      }
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  }) as Storage;
  cleanups.push(async () => {
    await (base as unknown as { dispose?: () => Promise<void> | void }).dispose?.();
    await fixture.dispose();
  });
  return { storage, faults };
}

/** Parks the run on a human wait once, then finishes once it is answered. */
function parksThenAnswers(onFinish?: () => void): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'wait-1',
            name: 'requestHumanInput',
            arguments: { signalName: 'human-response', prompt: 'Which?' },
          },
        ],
      };
    }
    onFinish?.();
    return { content: 'the answer', toolCalls: [] };
  };
}

async function open(
  faulty: Faulty,
  generate: GenerateFunction,
  extra: Partial<Parameters<typeof openBureau>[0]> = {},
): Promise<OpenedBureau> {
  const opened = await openBureau({
    storage: faulty.storage,
    generate,
    ...extra,
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

const kindsOf = async (opened: OpenedBureau, runId: string): Promise<string[]> => {
  const page = await opened.bureau.tasks.events(runId);
  return 'events' in page ? page.events.map((event) => event.kind) : [];
};

const resyncCount = async (opened: OpenedBureau, runId: string): Promise<number> => {
  const kinds = await kindsOf(opened, runId);
  return kinds.filter((kind) => kind === TASK_RESYNCED_EVENT_KIND).length;
};

/** The status the last element of a stream carries. */
const lastStatus = (frames: readonly SseFrame[]): string | undefined =>
  (frames[frames.length - 1]?.data as Json | undefined)?.status;

/** The elements a task's stream replays, read until `stop` says enough (or the stream ends). */
const framesOf = async (
  opened: OpenedBureau,
  runId: string,
  stop?: (frames: readonly SseFrame[]) => boolean,
): Promise<SseFrame[]> =>
  readFrames(
    await opened.handler(subscribeRequest('bureau.tasks.events', { taskId: runId }, 'alice-key')),
    stop === undefined ? {} : { stop },
  );

const resyncs = (frames: readonly SseFrame[]) =>
  frames.filter((frame) => frame.event === 'task.resynced').map((frame) => frame.data as Json);
type Json = { status: string; revision: number };

async function answer(opened: OpenedBureau, runId: string): Promise<void> {
  const answered = await rpc(
    opened.handler,
    'bureau.tasks.respond',
    { taskId: runId, messageId: 'answer-1', answer: 'the human said so' },
    'alice-key',
  );
  expect(answered.error).toBeUndefined();
}

async function park(opened: OpenedBureau, faults: Faults, failing: number) {
  // The first append the run makes is the `review.requested` of its wait.
  faults.failAppends = failing;
  const run = await opened.bureau.tasks.start('default', 'park', { principal: OWNER.alice });
  await waitForCondition(
    () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
    'the run never parked',
  );
  return run;
}

describe('task.resynced', () => {
  it('repairs a failed append at once: the stream restates the task the lost event described', async () => {
    const faulty = await faultyStorage();
    const opened = await open(faulty, parksThenAnswers());
    const run = await park(opened, faulty.faults, 1);

    await waitForCondition(async () => (await resyncCount(opened, run.id)) > 0, 'no resync');
    const kinds = await kindsOf(opened, run.id);
    expect(kinds).not.toContain('review.requested');
    await answer(opened, run.id);
    await waitForCondition(
      () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
      'finish',
    );

    const frames = await framesOf(opened, run.id);
    const [resync] = resyncs(frames);
    expect(resync?.status).toBe('input-required');
    expect(frames.at(-1)?.event).toBe('task.status');
    expect(lastStatus(frames)).toBe('completed');
  });

  it('repairs after a failed append and a failed resync on the next maintenance pass, and not again after', async () => {
    const faulty = await faultyStorage();
    const opened = await open(faulty, parksThenAnswers());
    // The wait's event and the resync that follows it both fail.
    const run = await park(opened, faulty.faults, 2);
    await opened.bureau.maintain();
    // Settled in the Bureau's own hands: the marked task is repaired by the pass.
    await waitForCondition(
      async () => (await resyncCount(opened, run.id)) > 0,
      'the maintenance pass did not repair the task',
    );
    expect(await resyncCount(opened, run.id)).toBe(1);

    await opened.bureau.maintain();
    await opened.bureau.maintain();
    expect(await resyncCount(opened, run.id)).toBe(1);
  });

  it('covers a lost event when a later one appended: N fails, N+1 commits, the resync restates N', async () => {
    const faulty = await faultyStorage();
    // Both the wait's event and the resync fail; the answer's events then append normally.
    const opened = await open(faulty, parksThenAnswers());
    const run = await park(opened, faulty.faults, 2);
    await answer(opened, run.id);
    await waitForCondition(
      () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
      'finish',
    );
    await opened.bureau.maintain();
    await waitForCondition(
      async () => (await resyncCount(opened, run.id)) > 0,
      'the maintenance pass did not repair the task',
    );

    // The resync follows the terminal event it must not contradict, and states the end.
    const page = await opened.bureau.tasks.events(run.id);
    const events = 'events' in page ? page.events : [];
    const at = events.findIndex((event) => event.kind === TASK_RESYNCED_EVENT_KIND);
    expect(events.filter((event) => event.kind === TASK_RESYNCED_EVENT_KIND)).toHaveLength(1);
    expect(at).toBeGreaterThan(events.findIndex((event) => event.kind === 'run.completed'));
    expect(events[at]?.payload).toMatchObject({
      status: 'completed',
      settled: { status: 'completed' },
    });
    // The replay reads through to the resync, so it is the last thing the reader is told.
    const frames = await framesOf(opened, run.id);
    expect(resyncs(frames)).toHaveLength(1);
    expect(frames.at(-1)?.event).toBe('task.resynced');
    expect(lastStatus(frames)).toBe('completed');
  });

  it('repairs, on restart, a task whose settlement committed and whose append never did', async () => {
    const faulty = await faultyStorage();
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const first = await open(
      faulty,
      parksThenAnswers(() => {
        // The run's end is about to append: the process dies first, and the mark with it.
        faulty.faults.failAppends = 1_000;
        finished();
      }),
    );
    const run = await park(first, faulty.faults, 0);
    await answer(first, run.id);
    await done;
    await waitForCondition(
      () => first.bureau.tasks.detail(run.id)?.status === 'completed',
      'finish',
    );
    // No mark survives the crash: the record is settled and nothing says its end was lost.
    await first.dispose();
    faulty.faults.failAppends = 0;
    await clearMark(faulty, run.id);

    const second = await open(faulty, async () => ({ content: 'unused', toolCalls: [] }));
    await waitForCondition(
      async () => (await resyncCount(second, run.id)) > 0,
      'the boot did not repair the task',
    );
    const frames = await framesOf(second, run.id);
    const resynced = resyncs(frames);
    expect(resynced).toHaveLength(1);
    expect(resynced[0]?.status).toBe('completed');

    // Another start finds nothing owed.
    await second.dispose();
    const third = await open(faulty, async () => ({ content: 'unused', toolCalls: [] }));
    await third.bureau.maintain();
    expect(await resyncCount(third, run.id)).toBe(1);
  });
});

/** Removes the resync mark a record carries, as a crash before the mark was written leaves it. */
async function clearMark(faulty: Faulty, runId: string): Promise<void> {
  const key = `bureau-task:v1:${runId}`;
  const bytes = await faulty.storage.get(key);
  if (bytes === null || bytes === undefined) throw new Error('expected the task record');
  const record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  delete record['resyncPending'];
  await faulty.storage.put(key, new TextEncoder().encode(JSON.stringify(record)));
}

describe('the repair of a lost end', () => {
  it('carries the answer of a completed session run, read from the run the Bureau holds', async () => {
    const faulty = await faultyStorage();
    const opened = await open(
      faulty,
      parksThenAnswers(() => {
        // The run's end fails to append; the resync after it does not.
        faulty.faults.failAppends = 1;
      }),
    );
    const run = await park(opened, faulty.faults, 0);
    await answer(opened, run.id);
    await waitForCondition(async () => (await resyncCount(opened, run.id)) > 0, 'no resync');

    const frames = await framesOf(opened, run.id);
    const [resync] = frames.filter((frame) => frame.event === 'task.resynced');
    expect(resync?.data).toMatchObject({
      status: 'completed',
      artifact: { artifactId: `${run.id}:result`, text: 'the answer' },
    });
  });

  it('keeps a task that finished with an approval open as input-required once its lost event is repaired', async () => {
    const faulty = await faultyStorage();
    const charges: number[] = [];
    const opened = await open(faulty, chargesOnce, {
      toolbox: approvalToolbox(charges),
      stopAtApproval: true,
      humanInput: false,
    });
    // The approval's event and the repair after it fail; the run's end commits.
    faulty.faults.failAppends = 2;
    const run = await opened.bureau.tasks.start('default', 'charge', { principal: OWNER.alice });
    await waitForCondition(
      () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
      'the approval never became pending',
    );
    await opened.bureau.maintain();
    await waitForCondition(async () => (await resyncCount(opened, run.id)) > 0, 'no resync');

    const frames = await framesOf(opened, run.id, (seen) => seen.length >= 3);
    expect(frames.at(-1)?.event).toBe('task.resynced');
    expect(lastStatus(frames)).toBe('input-required');
  });
});

describe('the task event projection of task.resynced', () => {
  const source = (payload: unknown) => ({
    kind: TASK_RESYNCED_EVENT_KIND,
    cursor: '5',
    emittedAtMs: 1,
    payload,
  });
  const settledPayload = {
    revision: 3,
    status: 'completed',
    finishReason: 'stop',
    message: null,
    settled: {
      status: 'completed',
      finishReason: 'stop',
      message: null,
      answer: { text: 'the answer', truncated: false },
    },
    openReviewIds: [],
  };

  it('replaces what the fold knew, serves the answer, and ends a settled task', () => {
    const projector = createTaskEventProjector('task-1');
    projector.project({
      kind: 'review.requested',
      cursor: '1',
      emittedAtMs: 1,
      payload: { reviewId: 'review-1' },
    });
    const element = projector.project(source(settledPayload));
    expect(element).toMatchObject({
      kind: 'task.resynced',
      status: 'completed',
      revision: 3,
      artifact: { artifactId: 'task-1:result', text: 'the answer', truncated: false },
    });
    expect(projector.ended).toBe(true);
  });

  it('keeps a task open while its resync names an open review, and drops a payload it cannot read', () => {
    const projector = createTaskEventProjector('task-1');
    const held = projector.project(
      source({ ...settledPayload, status: 'input-required', openReviewIds: ['review-1'] }),
    );
    expect(held).toMatchObject({ kind: 'task.resynced', status: 'input-required', artifact: null });
    expect(projector.ended).toBe(false);
    // The last review closing is what lets the success show.
    const done = projector.project({
      kind: 'review.approved',
      cursor: '6',
      emittedAtMs: 2,
      payload: { reviewId: 'review-1' },
    });
    expect(done).toMatchObject({ kind: 'task.status', status: 'completed' });
    expect(createTaskEventProjector('task-1').project(source({ status: 'nonsense' }))).toBe(
      undefined,
    );
  });

  it('holds shutdown until the boot repair has finished, before storage closes', async () => {
    const faulty = await faultyStorage();
    let finished: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const first = await open(
      faulty,
      parksThenAnswers(() => {
        faulty.faults.failAppends = 1_000;
        finished();
      }),
    );
    const run = await park(first, faulty.faults, 0);
    await answer(first, run.id);
    await done;
    await waitForCondition(
      () => first.bureau.tasks.detail(run.id)?.status === 'completed',
      'finish',
    );
    await first.dispose();
    faulty.faults.failAppends = 0;
    await clearMark(faulty, run.id);

    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    faulty.faults.hold = release.promise;
    faulty.faults.held = reached.resolve;
    const second = await open(faulty, async () => ({ content: 'unused', toolCalls: [] }));
    await reached.promise;

    let disposed = false;
    const disposing = second.bureau.shutdown().then(() => {
      disposed = true;
    });
    await quietFor(200);
    expect(disposed).toBe(false);

    release.resolve();
    await disposing;
    expect(disposed).toBe(true);
    faulty.faults.hold = undefined;
    const third = await open(faulty, async () => ({ content: 'unused', toolCalls: [] }));
    expect(await resyncCount(third, run.id)).toBe(1);
  });
});
