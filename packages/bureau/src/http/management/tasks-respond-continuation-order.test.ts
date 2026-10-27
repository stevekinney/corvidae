/**
 * COR-1607: an answer must not move a task back to `working` over a newer `input-required`.
 *
 * Weft's A2A continuation (COR-1473) stored a task status and wrote WORKING after it delivered
 * the signal, so a run that took the answer and parked again before that write landed had its
 * new INPUT_REQUIRED overwritten; the fix conditions the write on the sequence read before the
 * signal. Bureau's `bureau.tasks.respond` also delivers the signal first and only then persists
 * the decision and records `review.approved`, so the run can resume and raise its next wait in
 * between. Bureau stores no task status to overwrite: `tasks.get` derives it from the waits open
 * now, and `tasks.events` folds the durable history over the set of open reviews, so an answer
 * that lands late closes only the wait it answered. These tests hold the answer's writes until
 * the run has parked again, forcing that order, and check the task still reads `input-required`.
 */

import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { resolveStorage, type Storage } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createTemporaryPath, removeTemporaryPath } from '@lostgradient/testing/temporary-path';

import { waitForCondition } from '../../test';
import {
  openBureau,
  type OpenedBureau,
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
  type SseFrame,
} from './management-fixtures.test-support.ts';

const textDecoder = new TextDecoder();

/** The human-input call a model makes to park on `signalName`. */
function waitOn(signalName: string) {
  return {
    content: '',
    toolCalls: [
      {
        id: `wait-${signalName}`,
        name: 'requestHumanInput',
        arguments: { signalName, prompt: `Answer ${signalName}?` },
      },
    ],
  };
}

/** A model that parks on `first`, then on `second`, then finishes. */
function parksTwice(): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) return waitOn('first');
    if (calls === 2) return waitOn('second');
    return { content: 'done', toolCalls: [] };
  };
}

/** A catalog agent that parks on `first`, then on `second`, then finishes. */
const asksTwice = createAgent({
  generate: async (context: GenerateContext) => {
    if (context.step === 0) return waitOn('first');
    if (context.step === 1) return waitOn('second');
    return { content: 'done', toolCalls: [] };
  },
  toolbox: createToolbox([]),
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
});

type HeldStorage = {
  readonly storage: Storage;
  /** Holds every later write `matches` selects, until `release()`. */
  arm(matches: (payload: string) => boolean): void;
  held(): number;
  release(): void;
};

function payloadText(value: unknown): string {
  if (value instanceof Uint8Array) return textDecoder.decode(value);
  if (Array.isArray(value)) return value.map(payloadText).join('\n');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(payloadText).join('\n');
  }
  return typeof value === 'string' ? value : '';
}

/** Wraps a storage so a test can hold the writes it selects. */
function holdWrites(inner: Storage): HeldStorage {
  let matches: ((payload: string) => boolean) | undefined;
  let held = 0;
  const gate = Promise.withResolvers<void>();
  const writes = new Set<PropertyKey>(['put', 'batch', 'conditionalBatch']);
  const storage = new Proxy(inner, {
    get(target, property) {
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      const bound = (member as (...parameters: unknown[]) => unknown).bind(target);
      if (!writes.has(property)) return bound;
      return async (...parameters: unknown[]) => {
        if (matches?.(payloadText(parameters)) === true) {
          held += 1;
          await gate.promise;
        }
        return bound(...parameters);
      };
    },
  });
  return {
    storage,
    arm: (predicate) => {
      matches = predicate;
    },
    held: () => held,
    release: () => gate.resolve(),
  };
}

/** A Bureau over a SQLite file whose writes a test can hold, removed afterwards. */
async function withHeldBureau(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau, hold: HeldStorage) => Promise<void>,
): Promise<void> {
  const path = createTemporaryPath('bureau-respond-order', '.sqlite');
  const hold = holdWrites(await resolveStorage({ type: 'sqlite', path }));
  const opened = await openBureau({ ...options, storage: hold.storage });
  try {
    await body(opened, hold);
  } finally {
    hold.release();
    await opened.dispose();
    hold.storage[Symbol.dispose]();
    removeTemporaryPath(path);
  }
}

const statuses = (frames: readonly SseFrame[]) =>
  frames.flatMap((frame) =>
    frame.event === 'task.status' || frame.event === 'task.snapshot'
      ? [(frame.data as { status: string }).status]
      : [],
  );

async function historyKinds(opened: OpenedBureau, runId: string): Promise<string[]> {
  const page = await opened.bureau.tasks.events(runId);
  return 'events' in page ? page.events.map((event) => event.kind) : [];
}

async function countOf(opened: OpenedBureau, runId: string, kind: string): Promise<number> {
  const kinds = await historyKinds(opened, runId);
  return kinds.filter((each) => each === kind).length;
}

async function errorOf(reply: ReturnType<typeof rpc>): Promise<unknown> {
  const body = await reply;
  return body.error;
}

function openSignals(opened: OpenedBureau, runId: string): string[] {
  return opened.bureau.reviews
    .list()
    .flatMap((review) =>
      review.runId === runId && review.kind === 'human-wait' ? [review.signalName] : [],
    );
}

async function taskOf(opened: OpenedBureau, taskId: string): Promise<unknown> {
  const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId }, 'alice-key');
  expect(task.error).toBeUndefined();
  return task.result;
}

const waitingOnSecond = {
  status: 'input-required',
  openWaits: [{ kind: 'human-wait', signalName: 'second' }],
};

describe('bureau.tasks.respond when the run parks again before the answer is recorded (COR-1607)', () => {
  it('keeps a session task input-required, in tasks.get and in its event stream', async () => {
    await withHeldBureau({ generate: parksTwice() }, async (opened, hold) => {
      const run = await opened.bureau.createRun({
        agentName: 'default',
        message: 'park',
        principal: OWNER.alice,
      });
      await waitForCondition(
        async () => (await countOf(opened, run.id, 'review.requested')) === 1,
        'the run never parked on its first wait',
      );
      const [first] = opened.bureau.reviews.list();
      expect(first?.kind === 'human-wait' ? first.signalName : undefined).toBe('first');
      const reviewId = first!.id;

      // Hold the session write that persists this decision, which follows the signal.
      hold.arm(
        (payload) => payload.includes('"resolvedReviewDecisions":{') && payload.includes(reviewId),
      );
      const answering = rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'answer-first', answer: 'one' },
        'alice-key',
      );
      await waitForCondition(
        async () => hold.held() > 0 && (await countOf(opened, run.id, 'review.requested')) === 2,
        'the run never parked on its second wait',
      );
      expect(hold.held()).toBeGreaterThan(0);
      expect(await historyKinds(opened, run.id)).not.toContain('review.approved');
      expect(await taskOf(opened, run.id)).toMatchObject(waitingOnSecond);

      hold.release();
      expect(await errorOf(answering)).toBeUndefined();
      await waitForCondition(
        async () => (await countOf(opened, run.id, 'review.approved')) === 1,
        'the first answer was never recorded',
      );
      // The forced order: the second wait is in the history before the first answer.
      const kinds = await historyKinds(opened, run.id);
      expect(kinds.lastIndexOf('review.requested')).toBeLessThan(kinds.indexOf('review.approved'));

      expect(await taskOf(opened, run.id)).toMatchObject(waitingOnSecond);
      // The snapshot, both waits, and the late answer: none of them reads `working`.
      const frames = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        ),
        { stop: (read) => read.length >= 4 },
      );
      expect(statuses(frames)).toEqual([
        'input-required',
        'input-required',
        'input-required',
        'input-required',
      ]);

      const second = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'answer-second', answer: 'two', signalName: 'second' },
        'alice-key',
      );
      expect(second.error).toBeUndefined();
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
        'the run never finished after its second answer',
      );
    });
  });

  it('keeps a catalog task input-required in tasks.get', async () => {
    await withHeldBureau({ agents: { asksTwice } }, async (opened, hold) => {
      const run = opened.bureau.run('asksTwice', 'which ones?', { principal: OWNER.alice });
      await waitForCondition(
        () => openSignals(opened, run.id).includes('first'),
        'the run never parked on its first wait',
      );

      // Hold the decision record's `recorded` mark, which follows the signal.
      hold.arm(
        (payload) => payload.includes('review-decision:v1') && payload.includes('"recorded":true'),
      );
      let answered = false;
      const answering = rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'answer-first', answer: 'one' },
        'alice-key',
      ).finally(() => {
        answered = true;
      });
      await waitForCondition(
        () => hold.held() > 0 && openSignals(opened, run.id).includes('second'),
        'the run never parked on its second wait',
      );
      expect(hold.held()).toBeGreaterThan(0);
      expect(answered).toBe(false);
      expect(await taskOf(opened, run.id)).toMatchObject(waitingOnSecond);

      hold.release();
      expect(await errorOf(answering)).toBeUndefined();
      expect(await taskOf(opened, run.id)).toMatchObject(waitingOnSecond);

      const second = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'answer-second', answer: 'two', signalName: 'second' },
        'alice-key',
      );
      expect(second.error).toBeUndefined();
      const result = await run.result();
      expect(result.content).toBe('done');
    });
  });
});
