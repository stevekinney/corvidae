/**
 * COR-1622 — the order, retry and bounds of a schedule fire's review closes: a close follows the
 * request it closes in the history even when the request waits on its seed read, a canceled fire's
 * open requests are closed at boot whether or not its task is settled (the audit record and the
 * history event each on their own), a checkpoint that cannot be read strictly closes nothing, and
 * a fire's seed state goes with the fire.
 */
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import type { Storage } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';

import { createDurableEventHistory } from './durable-event-history';
import { OWNER } from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  askingGenerate,
  chargesOnce,
  auditRecordsOf,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  historyKinds,
  holdingWrites,
  pollUntil,
  reviewOf,
  storedText,
} from './schedule-fire-fixtures.test-support';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitOptions = {
  generate: askingGenerate(),
  humanInput: true,
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
};

/**
 * Holds the first `limit` scans of the fleet feed once armed (all of them by default), so a read of
 * the history waits for `release`.
 */
function holdingHistoryReads(limit = Number.POSITIVE_INFINITY) {
  let armed = false;
  let holding = 0;
  let held = false;
  const release = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  return {
    arm(): void {
      armed = true;
    },
    release(): void {
      release.resolve();
    },
    reached: reached.promise,
    get held(): boolean {
      return held;
    },
    wrap(storage: Storage): Storage {
      return new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
            if (
              !armed ||
              property !== 'scan' ||
              !storedText(args).startsWith('fleet-event') ||
              holding >= limit
            ) {
              return call();
            }
            holding += 1;
            held = true;
            reached.resolve();
            // `scan` answers an async iterable, which starts reading once `release` is called.
            return (async function* () {
              await release.promise;
              yield* call() as AsyncIterable<unknown>;
            })();
          };
        },
      });
    },
  };
}

/**
 * Holds only the storage reads made under a fire's seed read of its review history (found by the
 * stack they are made from), so the reads a decision, the follower or the maintenance pass make
 * of their own are left free.
 */
function holdingSeedRead() {
  let armed = false;
  let held = 0;
  const release = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  return {
    arm(): void {
      armed = true;
    },
    release(): void {
      release.resolve();
    },
    reached: reached.promise,
    get held(): number {
      return held;
    },
    wrap(storage: Storage): Storage {
      return new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
            if (!armed || !['scan', 'get', 'list'].includes(property)) return call();
            const stack = String(new Error().stack);
            if (
              !stack.includes('readFireReviewHistory') ||
              stack.includes('closeAbandonedFireRequests')
            ) {
              return call();
            }
            held += 1;
            reached.resolve();
            if (property === 'scan') {
              return (async function* () {
                await release.promise;
                yield* call() as AsyncIterable<unknown>;
              })();
            }
            return release.promise.then(call);
          };
        },
      });
    },
  };
}

/** Rejects the first write that carries every marker, once armed. */
function failingWriteOnce(...markers: string[]) {
  const state = { armed: true, failures: 0 };
  return {
    state,
    wrap(storage: Storage): Storage {
      return new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            if (
              state.armed &&
              ['conditionalBatch', 'put', 'batch'].includes(property) &&
              markers.every((marker) => storedText(args).includes(marker))
            ) {
              state.armed = false;
              state.failures += 1;
              return Promise.reject(new Error('the write failed'));
            }
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
}

/** Rejects every write that carries `marker` while `on`. */
function failingWrites(marker: string) {
  const state = { on: true };
  return {
    state,
    wrap(storage: Storage): Storage {
      return new Proxy(storage, {
        get(target, property) {
          const member = Reflect.get(target, property, target) as unknown;
          if (typeof member !== 'function' || typeof property !== 'string') return member;
          return (...args: unknown[]) => {
            if (
              state.on &&
              ['conditionalBatch', 'put', 'batch'].includes(property) &&
              storedText(args).includes(marker)
            ) {
              return Promise.reject(new Error('the write failed'));
            }
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    },
  };
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * The same storage with every step record of a run's checkpoint read back without its `parts`
 * while `state.on`: a record a tolerant `loadSteps` skips and a strict one rejects. The record on
 * disk is untouched.
 */
function unreadableSteps(
  storage: Storage,
  state: { on: boolean },
  stepPattern = /:step:/,
): Storage {
  return new Proxy(storage, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function') return member;
      if (property !== 'get') return (member as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const value = await (member as (...a: unknown[]) => unknown).apply(target, args);
        const key = String(args[0]);
        if (
          !state.on ||
          !key.startsWith('durable-run:') ||
          !stepPattern.test(key) ||
          (typeof value !== 'string' && !(value instanceof Uint8Array))
        ) {
          return value;
        }
        const record = JSON.parse(typeof value === 'string' ? value : decoder.decode(value)) as {
          parts?: unknown;
        };
        delete record.parts;
        const unreadable = JSON.stringify(record);
        return typeof value === 'string' ? unreadable : encoder.encode(unreadable);
      };
    },
  });
}

async function openWaiting(path: string, wrap: (storage: Storage) => Storage = (s) => s) {
  return harness.open({ ...waitOptions, storage: await harness.sqliteStorage(path, wrap) });
}

/**
 * Starts a schedule's fire without waiting for the maintenance pass that launches it, which, with
 * the history's reads held, cannot finish its retention step until they are released.
 */
async function startFire(bureau: Bureau, sessionId: string): Promise<string> {
  const created = await bureau.createSchedule({
    agentName: 'researcher',
    input: 'check in',
    spec: '1m',
    principal: OWNER.alice,
    sessionId,
  });
  const occurrence = created?.nextFireAt;
  if (created === undefined || occurrence === null || occurrence === undefined) {
    throw new Error('The schedule has no first occurrence.');
  }
  void bureau.runDurableMaintenance(occurrence).catch(() => undefined);
  return pollUntil(async () => {
    const schedule = await bureau.getSchedule(created.id);
    return schedule?.currentWorkflowId;
  }, 'the tick to launch a fire');
}

async function taskStatus(bureau: Bureau, fireId: string): Promise<string | undefined> {
  const task = await bureau.tasks.get(fireId);
  return task?.status;
}

describe('a close that waits for the seed read', () => {
  it('follows the request it closes in the history', async () => {
    const hold = holdingHistoryReads();
    harness.onDispose(() => hold.release());
    const bureau = await openWaiting(harness.nextDatabasePath(), (storage) => hold.wrap(storage));
    hold.arm();
    const fireId = await startFire(bureau, 'closes-seed-order');
    const review = await reviewOf(bureau, fireId);
    await Promise.race([hold.reached, sleep(3_000)]);
    expect(hold.held).toBe(true);

    // The wait is answered while the fire's seed read, which the request waits on, is under way.
    const resolving = bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
      payload: 'staging',
    });
    await sleep(200);
    hold.release();
    await resolving;
    await pollUntil(async () => {
      const kinds = await historyKinds(bureau, fireId);
      return kinds.includes('review.approved') ? kinds : undefined;
    }, 'the answer to reach the history');

    expect(await historyKinds(bureau, fireId)).toEqual(['review.requested', 'review.approved']);
  });

  it('follows the request when the wait is canceled instead', async () => {
    const hold = holdingHistoryReads();
    harness.onDispose(() => hold.release());
    const bureau = await openWaiting(harness.nextDatabasePath(), (storage) => hold.wrap(storage));
    hold.arm();
    const fireId = await startFire(bureau, 'closes-seed-cancel');
    await reviewOf(bureau, fireId);
    await Promise.race([hold.reached, sleep(3_000)]);
    expect(hold.held).toBe(true);

    void bureau.durableEngine()?.cancel(fireId);
    await sleep(300);
    hold.release();
    await pollUntil(async () => {
      const kinds = await historyKinds(bureau, fireId);
      return kinds.includes('review.canceled') ? kinds : undefined;
    }, 'the cancel to reach the history');

    expect(await historyKinds(bureau, fireId)).toEqual(['review.requested', 'review.canceled']);
  });
});

describe('a tool approval’s decision that waits for the seed read', () => {
  it('follows the request it closes in the history', async () => {
    // Only the seed read is held: the decision's own reads, and the follower's, are free, so it
    // is the decision's wait for the seed read that keeps the request first.
    const hold = holdingSeedRead();
    harness.onDispose(() => hold.release());
    const charges: number[] = [];
    const bureau = await harness.open({
      generate: chargesOnce,
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      storage: await harness.sqliteStorage(harness.nextDatabasePath(), (storage) =>
        hold.wrap(storage),
      ),
    });
    hold.arm();
    const fireId = await startFire(bureau, 'closes-seed-approval');
    const review = await reviewOf(bureau, fireId);
    await Promise.race([hold.reached, sleep(3_000)]);
    expect(hold.held).toBeGreaterThan(0);

    let decided = false;
    const deciding = bureau
      .resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice })
      .then(() => {
        decided = true;
      });
    await sleep(500);
    // The decision has not been recorded ahead of the request it closes.
    expect(decided).toBe(false);
    hold.release();
    await deciding;
    await pollUntil(async () => {
      const kinds = await historyKinds(bureau, fireId);
      return kinds.includes('review.approved') && kinds.includes('review.requested')
        ? kinds
        : undefined;
    }, 'both events to reach the history');

    expect(await historyKinds(bureau, fireId)).toEqual(['review.requested', 'review.approved']);
    expect(charges).toEqual([4242]);
  });
});

describe('a canceled fire’s closes, retried at boot', () => {
  it('writes the audit record that failed once, exactly once, at the next boot', async () => {
    const path = harness.nextDatabasePath();
    const failing = failingWriteOnce('audit-dedupe:v1:review.canceled');
    const first = await openWaiting(path, (storage) => failing.wrap(storage));
    const { fireId } = await fireOnce(first, OWNER.alice, 'closes-audit-retry');
    const review = await reviewOf(first, fireId);

    void first.durableEngine()?.cancel(fireId);
    await pollUntil(async () => {
      const kinds = await historyKinds(first, fireId);
      return kinds.includes('review.canceled') ? true : undefined;
    }, 'the history close');
    await pollUntil(
      async () => ((await taskStatus(first, fireId)) === 'canceled' ? true : undefined),
      'the task to settle',
    );
    expect(failing.state.failures).toBe(1);
    expect(await auditRecordsOf(first, fireId, 'review.human-wait.canceled', review.id)).toEqual(
      [],
    );
    await first.dispose();

    const restarted = await openWaiting(path);
    await pollUntil(async () => {
      const records = await auditRecordsOf(
        restarted,
        fireId,
        'review.human-wait.canceled',
        review.id,
      );
      return records.length > 0 ? true : undefined;
    }, 'the next boot to write the audit record');
    await sleep(300);

    expect(
      await auditRecordsOf(restarted, fireId, 'review.human-wait.canceled', review.id),
    ).toHaveLength(1);
    const kinds = await historyKinds(restarted, fireId);
    expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
  });

  it('writes the history event that failed once after the audit record committed, and no second audit record', async () => {
    const path = harness.nextDatabasePath();
    const failing = failingWriteOnce('outbox-dedupe:', 'review.canceled');
    const first = await openWaiting(path, (storage) => failing.wrap(storage));
    const { fireId } = await fireOnce(first, OWNER.alice, 'closes-history-retry');
    const review = await reviewOf(first, fireId);

    void first.durableEngine()?.cancel(fireId);
    await pollUntil(async () => {
      const records = await auditRecordsOf(first, fireId, 'review.human-wait.canceled', review.id);
      return records.length > 0 ? true : undefined;
    }, 'the audit record');
    await pollUntil(
      async () => ((await taskStatus(first, fireId)) === 'canceled' ? true : undefined),
      'the task to settle',
    );
    expect(failing.state.failures).toBe(1);
    const firstKinds = await historyKinds(first, fireId);
    expect(firstKinds.filter((kind) => kind === 'review.canceled')).toEqual([]);
    await first.dispose();

    const restarted = await openWaiting(path);
    await pollUntil(async () => {
      const kinds = await historyKinds(restarted, fireId);
      return kinds.includes('review.canceled') ? true : undefined;
    }, 'the next boot to write the history event');
    await sleep(300);

    const restartedKinds = await historyKinds(restarted, fireId);
    expect(restartedKinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
    expect(
      await auditRecordsOf(restarted, fireId, 'review.human-wait.canceled', review.id),
    ).toHaveLength(1);
  });

  it('closes nothing for a checkpoint it cannot read strictly, and the right review at a later boot', async () => {
    // A fire that parks on `first`, is answered, and parks on `second`.
    const asksTwice: GenerateFunction = async (context) => {
      if (context.step > 1) return { content: 'thanks', toolCalls: [] };
      const signalName = context.step === 0 ? 'first' : 'second';
      return {
        content: '',
        toolCalls: [
          {
            id: `call-${String(context.step)}`,
            name: 'requestHumanInput',
            arguments: { signalName, prompt: 'Which one?' },
          },
        ],
      };
    };
    const options = { ...waitOptions, generate: asksTwice };
    const path = harness.nextDatabasePath();
    // The history never got the waits' requests, and the process died as it began its closing.
    const noRequest = failingWrites('review.requested');
    const hold = holdingWrites('review.human-wait.canceled');
    harness.onDispose(() => hold.release());
    const open = async (wrap: (storage: Storage) => Storage) =>
      harness.open({ ...options, storage: await harness.sqliteStorage(path, wrap) });
    const first = await open((storage) => hold.wrap(noRequest.wrap(storage)));
    const { fireId } = await fireOnce(first, OWNER.alice, 'closes-strict');
    const answered = await reviewOf(first, fireId);
    // The first wait is answered outside the review path, so no audit record says so.
    await first.durableEngine()?.signal(fireId, 'first', 'go');
    const waiting = await pollUntil(
      () => first.listPendingReviews().find((listed) => listed.id !== answered.id),
      'the second wait',
    );
    hold.arm();
    void first.durableEngine()?.cancel(fireId);
    await Promise.race([hold.reached, sleep(3_000)]);
    expect(hold.held).toBe(true);

    // The next boot reads a checkpoint whose latest step cannot be read. A tolerant read would
    // fall back to the step before it and close the wait that was answered; a strict one closes
    // nothing, and the task is settled all the same.
    const unreadable = { on: true };
    const second = await open((storage) => unreadableSteps(storage, unreadable, /:step:0*1$/));
    await pollUntil(
      async () => ((await taskStatus(second, fireId)) === 'canceled' ? true : undefined),
      'the task to settle despite the close that could not be made',
    );
    await sleep(300);
    expect(await auditRecordsOf(second, fireId, 'review.human-wait.canceled')).toEqual([]);
    await second.dispose();

    // A later boot with a readable checkpoint closes the right review, though the task is settled.
    unreadable.on = false;
    const third = await open((storage) => unreadableSteps(storage, unreadable));
    await pollUntil(async () => {
      const records = await auditRecordsOf(third, fireId, 'review.human-wait.canceled');
      return records.length > 0 ? true : undefined;
    }, 'the later boot to close the wait');
    await sleep(300);

    const closed = await auditRecordsOf(third, fireId, 'review.human-wait.canceled');
    expect(closed.map((record) => (record.detail as { review: { id: string } }).review.id)).toEqual(
      [waiting.id],
    );
    expect(await durableStatus(third, fireId)).toBe('cancelled');
  });
});

/** A fire whose first step asks to charge a card, and whose next step runs until it is aborted. */
const continuing: GenerateFunction = async (context) => {
  if (context.step === 0) {
    return {
      content: '',
      toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 4242 } }],
    };
  }
  return new Promise((_resolve, reject) => {
    context.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
};

async function openApproving(path: string, wrap: (storage: Storage) => Storage = (s) => s) {
  return harness.open({
    generate: continuing,
    toolbox: approvalToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    storage: await harness.sqliteStorage(path, wrap),
  });
}

describe('a canceled fire’s tool approval, retried at boot', () => {
  it('has its audit record written exactly once when only that write failed', async () => {
    const path = harness.nextDatabasePath();
    const failing = failingWriteOnce('audit-dedupe:v1:review.canceled');
    const first = await openApproving(path, (storage) => failing.wrap(storage));
    const { fireId } = await fireOnce(first, OWNER.alice, 'closes-approval-audit-retry');
    const review = await reviewOf(first, fireId);
    expect(review.kind).toBe('tool-approval');

    void first.durableEngine()?.cancel(fireId);
    await pollUntil(async () => {
      const kinds = await historyKinds(first, fireId);
      return kinds.includes('review.canceled') ? true : undefined;
    }, 'the history close');
    await pollUntil(
      async () => ((await taskStatus(first, fireId)) === 'canceled' ? true : undefined),
      'the task to settle',
    );
    expect(failing.state.failures).toBe(1);
    expect(await auditRecordsOf(first, fireId, 'review.tool-approval.canceled', review.id)).toEqual(
      [],
    );
    await first.dispose();

    const restarted = await openApproving(path);
    await pollUntil(async () => {
      const records = await auditRecordsOf(
        restarted,
        fireId,
        'review.tool-approval.canceled',
        review.id,
      );
      return records.length > 0 ? true : undefined;
    }, 'the next boot to write the audit record');
    await sleep(300);

    expect(
      await auditRecordsOf(restarted, fireId, 'review.tool-approval.canceled', review.id),
    ).toHaveLength(1);
    const kinds = await historyKinds(restarted, fireId);
    expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
  });

  it('writes no canceled record for a request a replay superseded and never committed', async () => {
    const path = harness.nextDatabasePath();
    const first = await openWaiting(path);
    const { fireId } = await fireOnce(first, OWNER.alice, 'closes-abandoned');
    await reviewOf(first, fireId);
    void first.durableEngine()?.cancel(fireId);
    await pollUntil(
      async () => ((await taskStatus(first, fireId)) === 'canceled' ? true : undefined),
      'the task to settle',
    );
    // What a dead attempt and its replay's settlement leave behind: a request that was never
    // committed, ended only by a `review.superseded` with no decision after it.
    const abandoned = `approval:${fireId}:abandoned-call`;
    const writer = createDurableEventHistory(
      await harness.sqliteStorage(path),
      createManualRuntimeServices(),
    );
    const payload = { reviewId: abandoned, runId: fireId, principal: 'p', kind: 'tool-approval' };
    await writer.record({ kind: 'run', id: fireId }, 'review.requested', payload);
    await writer.record({ kind: 'run', id: fireId }, 'review.superseded', {
      ...payload,
      principal: 'system:replay',
    });
    await writer.dispose();
    await first.dispose();

    const restarted = await openWaiting(path);
    await sleep(1_500);

    expect(
      await auditRecordsOf(restarted, fireId, 'review.tool-approval.canceled', abandoned),
    ).toEqual([]);
    const kinds = await historyKinds(restarted, fireId);
    expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
  });

  it('repairs a re-gated approval at the round the supersession paired with a decision led to', async () => {
    const path = harness.nextDatabasePath();
    const first = await openWaiting(path);
    const { fireId } = await fireOnce(first, OWNER.alice, 'closes-regated');
    await reviewOf(first, fireId);
    void first.durableEngine()?.cancel(fireId);
    await pollUntil(
      async () => ((await taskStatus(first, fireId)) === 'canceled' ? true : undefined),
      'the task to settle',
    );
    // An approval that was re-gated once: the supersession, then the decision of the round it
    // left, and then nothing else, so round 1 is the pending one when the fire is canceled.
    const regated = `approval:${fireId}:regated-call`;
    const writer = createDurableEventHistory(
      await harness.sqliteStorage(path),
      createManualRuntimeServices(),
    );
    const owner = { kind: 'run', id: fireId } as const;
    const payload = { reviewId: regated, runId: fireId, principal: 'p', kind: 'tool-approval' };
    await writer.record(owner, 'review.requested', payload);
    await writer.record(owner, 'review.superseded', payload);
    await writer.record(owner, 'review.approved', payload);
    await writer.dispose();
    await first.dispose();

    const restarted = await openWaiting(path);
    await pollUntil(async () => {
      const records = await auditRecordsOf(
        restarted,
        fireId,
        'review.tool-approval.canceled',
        regated,
      );
      return records.length > 0 ? records : undefined;
    }, 'the next boot to close the re-gated approval');

    const [record] = await auditRecordsOf(
      restarted,
      fireId,
      'review.tool-approval.canceled',
      regated,
    );
    expect((record?.detail as { review: { round: number } }).review.round).toBe(1);
  });
});
