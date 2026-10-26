/**
 * COR-1613 (correction) — what closes a schedule fire's review, and what does not: a re-gate
 * (`review.superseded`) leaves a review pending under its id, a decision in flight is not expired
 * by the sweep, a canceled review gets one `canceled` record whichever route cancels it and at
 * whichever round it stood, and this process's own close does not undo the prune that follows it.
 */
import {
  type GenerateFunction,
  stopWhen,
  type Toolbox,
  createAgent,
} from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BureauError } from './create-bureau';
import {
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
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
  regatingApprovalToolbox,
  reviewOf,
  reviewsOf,
  storedText,
} from './schedule-fire-fixtures.test-support';
import { scheduledFireHoldings, scheduledFireReviewStateOf } from './scheduled-fire-review-state';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';
import { expireReviews } from './testing/expired-reviews.test-support';

const harness = createScheduleFireHarness();

afterEach(async () => {
  await harness.dispose();
});

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const stopAtApproval = stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls());
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;
const peerOptions = {
  generate: chargesOnce,
  stopWhen: stopAtApproval,
  durableOwnership: OWNERSHIP,
  maintenance: 'automatic' as const,
};

const waitOptions = {
  generate: askingGenerate(),
  humanInput: true,
  stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
};

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

async function settleAtApproval(bureau: Bureau, fireId: string): Promise<void> {
  await pollUntil(
    async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
    'the fire to end at its approval',
  );
}

/** Follows a fire's task stream and reports whether it has ended, without waiting for it. */
async function followTask(bureau: Bureau, fireId: string) {
  let ended = false;
  const frames = readFrames(
    await handlerOf(bureau)(
      subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
    ),
    { timeoutMs: 20_000 },
  ).finally(() => {
    ended = true;
  });
  frames.catch(() => undefined);
  return {
    frames,
    get ended(): boolean {
      return ended;
    },
  };
}

describe('a re-gated fire approval with a task stream open', () => {
  async function regated(subscribe: 'before' | 'after') {
    const charges: number[] = [];
    const bureau = await harness.open({
      storage: await harness.sqliteStorage(harness.nextDatabasePath()),
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: regatingApprovalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'regate-session');
    const review = await reviewOf(bureau, fireId);
    await settleAtApproval(bureau, fireId);
    const stream = subscribe === 'before' ? await followTask(bureau, fireId) : undefined;
    if (stream !== undefined) await sleep(100);
    const outcome = await bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(outcome.superseded).toBe(true);
    return {
      bureau,
      fireId,
      review,
      stream: stream ?? (await followTask(bureau, fireId)),
      charges,
    };
  }

  for (const order of ['before', 'after'] as const) {
    it(`stays listed, open and deniable when the stream opens ${order} the re-gate`, async () => {
      const { bureau, fireId, review, stream } = await regated(order);
      await sleep(300);

      expect(stream.ended).toBe(false);
      expect(reviewsOf(bureau, fireId).map((listed) => listed.id)).toEqual([review.id]);
      const denied = await bureau.resolveReview({
        id: review.id,
        decision: 'deny',
        principal: OWNER.alice,
      });
      expect(denied.decision).toBe('deny');
      const frames = await stream.frames;
      expect(frames.at(-1)?.data).toMatchObject({ status: 'completed' });
    });
  }

  it('stays listed and deniable on a peer that replays the history', async () => {
    const path = harness.nextDatabasePath();
    const charges: number[] = [];
    const holder = await harness.open({
      ...peerOptions,
      storage: await harness.sqliteStorage(path),
      toolbox: regatingApprovalToolbox(charges),
    });
    const { fireId } = await fireOnce(holder, OWNER.alice, 'regate-peer-session');
    const review = await reviewOf(holder, fireId);
    await settleAtApproval(holder, fireId);
    const outcome = await holder.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(outcome.superseded).toBe(true);
    const peer = await harness.open({
      ...peerOptions,
      storage: await harness.sqliteStorage(path),
      toolbox: regatingApprovalToolbox([]),
    });
    await reviewOf(peer, fireId);

    const stream = await followTask(peer, fireId);
    await sleep(300);

    expect(stream.ended).toBe(false);
    expect(reviewsOf(peer, fireId).map((listed) => listed.id)).toEqual([review.id]);
    const denied = await peer.resolveReview({
      id: review.id,
      decision: 'deny',
      principal: OWNER.alice,
    });
    expect(denied.decision).toBe('deny');
  });
});

describe('the automatic sweep and a decision in flight', () => {
  it('leaves an approval alone while its tool runs, and the review ends approved once', async () => {
    const charges: number[] = [];
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            started.resolve();
            await gate.promise;
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'schedule-fire-reviews-secret',
        policy: {
          beforeExecute: () => ({
            allow: false,
            status: 'needs_approval',
            reason: 'Operator approval required',
            action: { message: 'Approve charge' },
          }),
        },
      },
    ) as unknown as Toolbox;
    const bureau = await harness.open({
      storage: await harness.sqliteStorage(harness.nextDatabasePath()),
      agents: {
        default: createAgent({ generate: chargesOnce, toolbox, stopWhen: stopAtApproval }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'sweep-race-session');
    const review = await reviewOf(bureau, fireId);
    await settleAtApproval(bureau, fireId);

    const deciding = bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    await started.promise;
    // The binding's time has passed and a maintenance tick lands, with the tool still running.
    const swept = await expireReviews(bureau, Date.now() + 60 * 60 * 1000);
    gate.resolve();
    await deciding;

    expect(swept).toBe(0);
    expect(charges).toEqual([4242]);
    const records = (await bureau.auditTrail?.query({ runId: fireId })) ?? [];
    const terminal = records
      .filter((record) => record.type.startsWith('review.tool-approval.'))
      .map((record) => record.type)
      .filter((type) => type !== 'review.tool-approval.requested');
    expect(terminal).toEqual(['review.tool-approval.approved']);
    const decided = await bureau.getReview(review.id);
    expect(decided?.status).toBe('approved');
  });
});

describe('a canceled human wait gets one canceled record, whichever route cancels it', () => {
  const routes = {
    'the task': (bureau: Bureau, fireId: string) =>
      rpc(handlerOf(bureau), 'bureau.tasks.cancel', { taskId: fireId }, 'alice-key').then(
        () => undefined,
      ),
    'the durable run': (bureau: Bureau, fireId: string) =>
      bureau.cancelDurableRun(fireId).then(() => undefined),
    'the engine': (bureau: Bureau, fireId: string) =>
      bureau.durableEngine()?.cancel(fireId) ?? Promise.resolve(),
  };
  for (const [name, cancel] of Object.entries(routes)) {
    it(`when canceled through ${name}, with the first writer held at its write`, async () => {
      // Every caller that reaches the review while the first is still writing must wait for it.
      const hold = holdingWrites('review.human-wait.canceled');
      harness.onDispose(() => hold.release());
      const bureau = await harness.open({
        ...waitOptions,
        storage: await harness.sqliteStorage(harness.nextDatabasePath(), (storage) =>
          hold.wrap(storage),
        ),
      });
      const { fireId } = await fireOnce(bureau, OWNER.alice, 'cancel-routes-session');
      const review = await reviewOf(bureau, fireId);
      hold.arm();

      const canceling = cancel(bureau, fireId);
      await Promise.race([hold.reached, sleep(3000)]);
      expect(hold.held).toBe(true);
      await sleep(300);
      hold.release();
      await canceling;
      await pollUntil(async () => {
        const records = await auditRecordsOf(
          bureau,
          fireId,
          'review.human-wait.canceled',
          review.id,
        );
        return records.length > 0 ? true : undefined;
      }, 'the canceled wait to be recorded');
      await sleep(300);

      expect(
        await auditRecordsOf(bureau, fireId, 'review.human-wait.canceled', review.id),
      ).toHaveLength(1);
      const kinds = await historyKinds(bureau, fireId);
      expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
    });
  }
});

describe('a re-gated fire approval that is canceled', () => {
  const cancelRoutes = {
    'in the engine': (bureau: Bureau, fireId: string) => {
      void bureau.durableEngine()?.cancel(fireId);
    },
    'through its task': (bureau: Bureau, fireId: string) => {
      void rpc(handlerOf(bureau), 'bureau.tasks.cancel', { taskId: fireId }, 'alice-key');
    },
  };
  const canceledRecordsAt = async (bureau: Bureau, fireId: string, reviewId: string) =>
    auditRecordsOf(bureau, fireId, 'review.tool-approval.canceled', reviewId);

  for (const [route, cancel] of Object.entries(cancelRoutes)) {
    it(`is closed as canceled at its current round when canceled ${route}`, async () => {
      const bureau = await harness.open({
        storage: await harness.sqliteStorage(harness.nextDatabasePath()),
        agents: {
          default: createAgent({
            generate: continuingGenerate,
            toolbox: regatingApprovalToolbox([]),
            stopWhen: stopWhen.noToolCalls(),
          }),
        },
      });
      const { fireId } = await fireOnce(bureau, OWNER.alice, 'regate-cancel-session');
      const review = await reviewOf(bureau, fireId);
      await sleep(50);
      const outcome = await bureau.resolveReview({
        id: review.id,
        decision: 'approve',
        principal: OWNER.alice,
      });
      expect(outcome.superseded).toBe(true);

      cancel(bureau, fireId);
      await pollUntil(async () => {
        const records = await canceledRecordsAt(bureau, fireId, review.id);
        return records.length > 0 ? true : undefined;
      }, 'the canceled approval to be recorded');
      await sleep(250);

      const records = await canceledRecordsAt(bureau, fireId, review.id);
      expect(records).toHaveLength(1);
      const detail = records[0]?.detail as { review?: { round?: number } } | undefined;
      expect(detail?.review?.round).toBe(1);
      const closed = await bureau.getReview(review.id);
      expect(closed?.status).toBe('canceled');
      const kinds = await historyKinds(bureau, fireId);
      expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
    });
  }

  it('is closed as canceled at its current round by the boot after a crash', async () => {
    const path = harness.nextDatabasePath();
    const hold = holdingWrites('review.tool-approval.canceled');
    harness.onDispose(() => hold.release());
    const first = await harness.open({
      storage: await harness.sqliteStorage(path, (storage) => hold.wrap(storage)),
      agents: {
        default: createAgent({
          generate: continuingGenerate,
          toolbox: regatingApprovalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'regate-boot-session');
    const review = await reviewOf(first, fireId);
    await sleep(50);
    await first.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    hold.arm();
    void first.durableEngine()?.cancel(fireId);
    await Promise.race([hold.reached, sleep(3000)]);
    expect(hold.held).toBe(true);

    const restarted = await harness.open({
      storage: await harness.sqliteStorage(path),
      agents: {
        default: createAgent({
          generate: continuingGenerate,
          toolbox: regatingApprovalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    await pollUntil(async () => {
      const records = await canceledRecordsAt(restarted, fireId, review.id);
      return records.length > 0 ? true : undefined;
    }, 'the restart to record the canceled approval');

    const records = await canceledRecordsAt(restarted, fireId, review.id);
    expect(records).toHaveLength(1);
    const detail = records[0]?.detail as { review?: { round?: number } } | undefined;
    expect(detail?.review?.round).toBe(1);
    // The process that was held finishes while its storage is still open.
    hold.release();
    await sleep(300);
  });
});

describe('a canceled approval whose process died between its record and its prune', () => {
  for (const filler of [0, 600]) {
    const label =
      filler === 0
        ? 'is not recorded again by the restart'
        : `is not recorded again by the restart when ${filler} later records fill the trail's first page`;
    it(label, async () => {
      const path = harness.nextDatabasePath();
      const hold = holdingWrites('pendingApprovalOverrides');
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
      const { fireId } = await fireOnce(first, OWNER.alice, 'prune-crash-session');
      const review = await reviewOf(first, fireId);
      await sleep(50);
      for (let index = 0; index < filler; index += 1) {
        await first.auditTrail?.record({
          runId: fireId,
          type: 'test.filler',
          detail: { index },
          principal: 'system:test',
        });
      }
      hold.arm();
      void first.durableEngine()?.cancel(fireId);
      await Promise.race([hold.reached, sleep(3000)]);
      expect(hold.held).toBe(true);
      expect(
        await auditRecordsOf(first, fireId, 'review.tool-approval.canceled', review.id),
      ).toHaveLength(1);

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
      await sleep(400);

      expect(
        await auditRecordsOf(restarted, fireId, 'review.tool-approval.canceled', review.id),
      ).toHaveLength(1);
      const kinds = await historyKinds(restarted, fireId);
      expect(kinds.filter((kind) => kind === 'review.canceled')).toHaveLength(1);
    });
  }
});

describe('a fire approval this process expires, with a task stream open', () => {
  it('keeps the approval in memory when the prune fails, as it does with no stream', async () => {
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
    const bureau = await harness.open({
      storage,
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox([]),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'own-expiry-session');
    const review = await reviewOf(bureau, fireId);
    await settleAtApproval(bureau, fireId);
    await followTask(bureau, fireId);
    await sleep(100);

    failing.on = true;
    await expireReviews(bureau, Date.now() + 60 * 60 * 1000).catch(() => undefined);
    await sleep(250);
    failing.on = false;

    const refusal = await rejectionOf(
      bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    expect((refusal as BureauError).code).toBe('NOT_FOUND');
    const state = scheduledFireReviewStateOf(bureau);
    expect(scheduledFireHoldings(state, fireId)).toContain('pendingApprovalOverrides');
  });
});
