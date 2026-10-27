/**
 * COR-1613 — a schedule fire's reviews are closed exactly once in the audit trail and the durable
 * history, whichever way the fire is canceled and wherever a crash lands, and an approval's session
 * prune commits before its in-memory state is dropped.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { type GenerateFunction, stopWhen, createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError } from './create-bureau';
import { OWNER, rpc } from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  askingGenerate,
  auditRecordsOf,
  chargesOnce,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  handlerOf,
  historyKinds,
  holdingWrites,
  pollUntil,
  reviewOf,
  reviewsOf,
  storedText,
} from './schedule-fire-fixtures.test-support';
import { scheduledFireHoldings, scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';
import { withAdvancingClock } from './testing/advancing-turn.test-support';
import { expireReviews } from './testing/expired-reviews.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const SESSION = 'audit-session';
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** A continuing fire with a committed approval: its second step ends only when it is canceled. */
const continuingGenerate: GenerateFunction = async (context) => {
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

const cancelRoutes = {
  'in the engine': (bureau: Bureau, fireId: string) => {
    void bureau.durableEngine()?.cancel(fireId);
  },
  'through its task': (bureau: Bureau, fireId: string) => {
    void rpc(handlerOf(bureau), 'bureau.tasks.cancel', { taskId: fireId }, 'alice-key');
  },
};

describe('a fire canceled with a committed approval, then a crash before the canceled record', () => {
  for (const [route, cancel] of Object.entries(cancelRoutes)) {
    it(`is closed once, in the audit trail and the durable history, when canceled ${route}`, async () => {
      const path = harness.nextDatabasePath();
      const hold = holdingWrites('review.tool-approval.canceled');
      harness.onDispose(() => hold.release());
      const first = await harness.open({
        storage: await harness.sqliteStorage(path, (storage) => hold.wrap(storage)),
        agents: {
          default: createAgent({
            generate: continuingGenerate,
            toolbox: approvalToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
      });
      const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
      const review = await reviewOf(first, fireId);
      await sleep(50);
      hold.arm();
      cancel(first, fireId);
      await Promise.race([hold.reached, sleep(3000)]);
      expect(hold.held).toBe(true);
      expect(await durableStatus(first, fireId)).toBe('cancelled');

      // The next process: the canceled record was never written.
      const restarted = await harness.open({
        storage: await harness.sqliteStorage(path),
        agents: {
          default: createAgent({
            generate: continuingGenerate,
            toolbox: approvalToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
      });
      await pollUntil(async () => {
        const records = await auditRecordsOf(
          restarted,
          fireId,
          'review.tool-approval.canceled',
          review.id,
        );
        return records.length > 0 ? true : undefined;
      }, 'the restart to record the canceled review');

      expect(
        await auditRecordsOf(restarted, fireId, 'review.tool-approval.canceled', review.id),
      ).toHaveLength(1);
      const closed = await restarted.getReview(review.id);
      expect(closed?.status).toBe('canceled');
      await pollUntil(async () => {
        const kinds = await historyKinds(restarted, fireId);
        return kinds.includes('review.canceled') ? true : undefined;
      }, 'the history to close the request');
      const kinds = await historyKinds(restarted, fireId);
      expect(kinds.indexOf('review.requested')).toBeLessThan(kinds.indexOf('review.canceled'));

      // A second restart finds the review closed already, and writes nothing more.
      const again = await harness.open({
        storage: await harness.sqliteStorage(path),
        agents: {
          default: createAgent({
            generate: continuingGenerate,
            toolbox: approvalToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
      });
      await sleep(100);
      expect(
        await auditRecordsOf(again, fireId, 'review.tool-approval.canceled', review.id),
      ).toHaveLength(1);
      const againKinds = await historyKinds(again, fireId);
      expect(againKinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
    });
  }
});

describe('a fire canceled while parked on a human wait', () => {
  const waitOptions = {
    generate: askingGenerate(),
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  };

  it('closes the wait exactly once, live', async () => {
    const path = harness.nextDatabasePath();
    const bureau = await harness.open({
      ...waitOptions,
      storage: await harness.sqliteStorage(path),
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, SESSION);
    const review = await reviewOf(bureau, fireId);

    await bureau.durableEngine()?.cancel(fireId);

    await pollUntil(async () => {
      const records = await auditRecordsOf(bureau, fireId, 'review.human-wait.canceled', review.id);
      return records.length > 0 ? true : undefined;
    }, 'the canceled wait to be recorded');
    await sleep(100);
    expect(
      await auditRecordsOf(bureau, fireId, 'review.human-wait.canceled', review.id),
    ).toHaveLength(1);
    const closed = await bureau.getReview(review.id);
    expect(closed?.status).toBe('canceled');
  });

  it('closes the wait exactly once when the process dies before the record, and restarts', async () => {
    const path = harness.nextDatabasePath();
    const hold = holdingWrites('review.human-wait.canceled');
    harness.onDispose(() => hold.release());
    const first = await harness.open({
      ...waitOptions,
      storage: await harness.sqliteStorage(path, (storage) => hold.wrap(storage)),
    });
    const { fireId } = await fireOnce(first, OWNER.alice, SESSION);
    const review = await reviewOf(first, fireId);
    hold.arm();
    void first.durableEngine()?.cancel(fireId);
    await Promise.race([hold.reached, sleep(3000)]);
    expect(hold.held).toBe(true);

    const restarted = await harness.open({
      ...waitOptions,
      storage: await harness.sqliteStorage(path),
    });
    await pollUntil(async () => {
      const records = await auditRecordsOf(
        restarted,
        fireId,
        'review.human-wait.canceled',
        review.id,
      );
      return records.length > 0 ? true : undefined;
    }, 'the restart to record the canceled wait');
    await sleep(100);

    expect(
      await auditRecordsOf(restarted, fireId, 'review.human-wait.canceled', review.id),
    ).toHaveLength(1);
    expect(reviewsOf(restarted, fireId)).toEqual([]);
  });
});

describe('a fire approval’s session prune commits before its in-memory state is dropped', () => {
  it('keeps the approval out of the list, refuses it, and a later release finishes the prune', async () => {
    const path = harness.nextDatabasePath();
    const failing = { on: false };
    const storage = await harness.sqliteStorage(
      path,
      (raw) =>
        new Proxy(raw, {
          get(target, property) {
            const member = Reflect.get(target, property, target) as unknown;
            if (typeof member !== 'function' || typeof property !== 'string') return member;
            return (...args: unknown[]) => {
              if (
                failing.on &&
                property === 'conditionalBatch' &&
                storedText(args).includes('pendingApprovalOverrides')
              ) {
                return Promise.reject(new Error('the session store is unavailable'));
              }
              return (member as (...a: unknown[]) => unknown).apply(target, args);
            };
          },
        }),
    );
    const charges: number[] = [];
    // A manual clock keeps the task inside retention until the test moves it, so the maintenance
    // pass that expires the approval is not also the pass that releases the fire's task.
    const runtime = createManualRuntimeServices();
    const diagnostics: string[] = [];
    const bureau = await harness.open({
      storage,
      runtime,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      retention: { tasks: { olderThan: 60_000 } },
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, SESSION);
    const review = await reviewOf(bureau, fireId);
    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );

    // The approval expires, and its release cannot commit the session prune.
    failing.on = true;
    await withAdvancingClock(runtime, expireReviews(bureau, Date.now() + 60 * 60 * 1000));
    failing.on = false;

    // The maintenance pass reports the failed release instead of throwing it.
    expect(diagnostics.some((message) => message.includes('expired-review sweep failed'))).toBe(
      true,
    );
    expect(reviewsOf(bureau, fireId)).toEqual([]);
    const refusal = await rejectionOf(
      bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    const state = scheduledFireReviewStateOf(bureau);
    expect(scheduledFireHoldings(state, fireId)).toContain('pendingApprovalOverrides');
    const session = await bureau.getSession(SESSION);
    expect(Object.keys((session?.metadata['pendingApprovalOverrides'] as object) ?? {})).toEqual([
      review.id,
    ]);

    // The next release of the fire, here its task leaving retention, retries it.
    await runtime.advance(60_001);
    await pollUntil(async () => {
      await bureau.runDurableMaintenance();
      return (await bureau.tasks.record(fireId)) === undefined ? true : undefined;
    }, 'the fire’s task to leave retention');

    const after = await bureau.getSession(SESSION);
    expect(Object.keys((after?.metadata['pendingApprovalOverrides'] as object) ?? {})).toEqual([]);
    expect(scheduledFireHoldings(state, fireId)).toEqual([]);
    expect(
      await auditRecordsOf(bureau, fireId, 'review.tool-approval.expired', review.id),
    ).toHaveLength(1);
    expect(charges).toEqual([]);
  });
});
