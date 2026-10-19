/**
 * COR-1596 — what a schedule fire's tool approval leaves behind, and what it must not bring back.
 *
 * A fire is never on the run store, so nothing removes its review state the way the store's
 * `run.removed` removes a session run's. These tests pin each way the state ends (a decision, an
 * expiry, the fire's task leaving retention), the crash that must not bring back an approval the
 * run never committed, and what a fire that continues past an approval owes the resolver.
 */
import { MemoryStorage } from '@lostgradient/weft';
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { ApprovalOutcomeNotWrittenError, BureauError } from './create-bureau';
import {
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
} from './http/management/management-fixtures.test-support.ts';
import {
  approvalToolbox,
  askingGenerate,
  chargesOnce,
  chargesWithFreshCallIds,
  createScheduleFireHarness,
  durableStatus,
  fireOnce,
  handlerOf,
  pollUntil,
  reviewOf,
  reviewsOf,
} from './schedule-fire-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';

const harness = createScheduleFireHarness();
const { open } = harness;

afterEach(async () => {
  await harness.dispose();
});

const stopAtApproval = stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls());

async function sessionMetadata(
  bureau: Bureau,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const session = await bureau.getSession(sessionId);
  return session?.metadata ?? {};
}

const decoder = new TextDecoder();
/** The text a storage call carries, whichever of strings and bytes its keys and values are. */
function storedText(value: unknown): string {
  if (value instanceof Uint8Array) return decoder.decode(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(storedText).join(' ');
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).map(storedText).join(' ');
  }
  return '';
}

const keysOf = (value: unknown): string[] =>
  typeof value === 'object' && value !== null ? Object.keys(value) : [];

describe('a resolved fire approval leaves nothing of its own in the session', () => {
  it('drops the fire’s authority, round and override for each of several fires of one recurring session', async () => {
    const charges: number[] = [];
    const bureau = await open({
      generate: chargesWithFreshCallIds(),
      toolbox: approvalToolbox(charges),
      stopWhen: stopAtApproval,
    });
    const fires: string[] = [];
    for (let count = 0; count < 3; count += 1) {
      const { fireId } = await fireOnce(bureau, OWNER.alice, 'recurring-session');
      const review = await reviewOf(bureau, fireId);
      await bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
      await pollUntil(
        async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
        'the fire to complete',
      );
      fires.push(fireId);
    }

    expect(charges).toEqual([4242, 4242, 4242]);
    const metadata = await sessionMetadata(bureau, 'recurring-session');
    expect(keysOf(metadata['lastRequestAuthorities'])).toEqual([]);
    expect(keysOf(metadata['pendingApprovalRounds'])).toEqual([]);
    expect(keysOf(metadata['pendingApprovalOverrides'])).toEqual([]);
    // What fences a concurrent resolver stays while the fire's task does: three fires, three ids.
    expect(keysOf(metadata['resolvedReviewDecisions']).toSorted()).toEqual(
      fires.map((fireId, index) => `approval:${fireId}:charge-${index + 1}`).toSorted(),
    );
  });

  it('retires the fence with the fire’s task, and not before', async () => {
    const bureau = await open({
      generate: chargesOnce,
      toolbox: approvalToolbox([]),
      stopWhen: stopAtApproval,
      taskRetention: { olderThan: 1 },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'retained-session');
    const review = await reviewOf(bureau, fireId);
    await bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to complete',
    );
    const before = await sessionMetadata(bureau, 'retained-session');
    expect(keysOf(before['resolvedReviewDecisions'])).toEqual([review.id]);

    await pollUntil(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await bureau.runDurableMaintenance(Date.now());
      return (await bureau.tasks.record(fireId)) === undefined ? true : undefined;
    }, 'the fire’s task to leave retention');

    const after = await sessionMetadata(bureau, 'retained-session');
    expect(keysOf(after['resolvedReviewDecisions'])).toEqual([]);
    expect(after['resolvedReviewIds'] ?? []).toEqual([]);
  });
});

describe('an unanswered fire approval expires', () => {
  it('is swept, leaves the list and the session, and the fire’s review state ends', async () => {
    const charges: number[] = [];
    const bureau = await open({
      generate: chargesOnce,
      toolbox: approvalToolbox(charges),
      stopWhen: stopAtApproval,
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'expiring-session');
    const review = await reviewOf(bureau, fireId);
    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );
    const pending = await sessionMetadata(bureau, 'expiring-session');
    expect(keysOf(pending['pendingApprovalOverrides'])).toEqual([review.id]);

    const swept = await bureau.sweepExpiredReviews(Date.now() + 60 * 60 * 1000);

    expect(swept).toBe(1);
    expect(reviewsOf(bureau, fireId)).toEqual([]);
    const handler = handlerOf(bureau);
    const inbox = await rpc(handler, 'bureau.reviews.list', {}, 'alice-key');
    expect(inbox.result?.['reviews']).toEqual([]);
    const task = await rpc(handler, 'bureau.tasks.get', { taskId: fireId }, 'alice-key');
    expect(task.result?.['status']).not.toBe('input-required');
    const metadata = await sessionMetadata(bureau, 'expiring-session');
    expect(keysOf(metadata['pendingApprovalOverrides'])).toEqual([]);
    expect(keysOf(metadata['lastRequestAuthorities'])).toEqual([]);
    expect(keysOf(metadata['pendingApprovalRounds'])).toEqual([]);
    // Expired, not decided: nothing ran, and a second sweep finds nothing.
    expect(charges).toEqual([]);
    expect(await bureau.sweepExpiredReviews(Date.now() + 2 * 60 * 60 * 1000)).toBe(0);
    const refused = await rejectionOf(
      bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    expect((refused as BureauError).code).toBe('NOT_FOUND');
  });
});

describe('a crash between a fire step’s session write and its commit', () => {
  it('restores only the approvals the run committed, and approving one charges once', async () => {
    // The first process's journal of step 0 is held for good: that is a crash between the step's
    // session write, which records the approval, and the step's commit, which the run never makes.
    const recordsApproval = (args: unknown[]) =>
      storedText(args).includes('pendingApprovalOverrides');
    const journalsStep = (args: unknown[]) => /wf:[^ ]+:ckpt/.test(storedText(args));
    let armed = false;
    let held = false;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const raw = new MemoryStorage();
    const holdingStorage = new Proxy(raw, {
      get(target, property) {
        const member = Reflect.get(target, property, target) as unknown;
        if (typeof member !== 'function' || typeof property !== 'string') return member;
        return (...args: unknown[]) => {
          const call = () => (member as (...a: unknown[]) => unknown).apply(target, args);
          if (property !== 'conditionalBatch' || held) return call();
          if (armed && journalsStep(args)) {
            held = true;
            reached.resolve();
            return release.promise.then(call);
          }
          if (recordsApproval(args)) armed = true;
          return call();
        };
      },
    });
    let attempt = 0;
    const generate: GenerateFunction = async (context) => {
      if (context.step > 0) return { content: 'charged', toolCalls: [] };
      attempt += 1;
      const label = attempt === 1 ? 'A' : 'B';
      return {
        content: '',
        toolCalls: [
          {
            id: `charge-${label}`,
            name: 'charge-card',
            arguments: { cents: attempt === 1 ? 100 : 200 },
          },
        ],
      };
    };
    const first = await open({
      generate,
      toolbox: approvalToolbox([]),
      stopWhen: stopAtApproval,
      storage: holdingStorage,
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'crash-session');
    await reached.promise;
    const abandoned = await reviewOf(first, fireId);
    expect(abandoned.id).toBe(`approval:${fireId}:charge-A`);

    const charges: number[] = [];
    const restarted = await open({
      generate,
      toolbox: approvalToolbox(charges),
      stopWhen: stopAtApproval,
      storage: raw,
    });
    await pollUntil(
      async () => ((await durableStatus(restarted, fireId)) === 'completed' ? true : undefined),
      'the recovered fire to complete',
    );
    await reviewOf(restarted, fireId);

    expect(reviewsOf(restarted, fireId).map((review) => review.id)).toEqual([
      `approval:${fireId}:charge-B`,
    ]);
    const metadata = await sessionMetadata(restarted, 'crash-session');
    expect(keysOf(metadata['pendingApprovalOverrides'])).toEqual([`approval:${fireId}:charge-B`]);
    await restarted.resolveReview({
      id: `approval:${fireId}:charge-B`,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(charges).toEqual([200]);
    expect(restarted.listPendingReviews()).toEqual([]);

    // never released: this process is dead
  });
});

describe('a fire still going when its process restarts', () => {
  it('resolves an approval it committed and one it makes after, each under its own binding', async () => {
    const databasePath = harness.nextDatabasePath();
    const storage = { type: 'sqlite' as const, path: databasePath };
    let dead = true;
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 100 } }],
        };
      }
      // The first process never gets past its second step: it is the one that dies.
      if (dead) return new Promise<never>(() => {});
      if (context.step === 1) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-Y', name: 'charge-card', arguments: { cents: 200 } }],
        };
      }
      return { content: 'done', toolCalls: [] };
    };
    const first = await open({
      generate,
      toolbox: approvalToolbox([]),
      stopWhen: stopWhen.noToolCalls(),
      storage,
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'mid-flight-session');
    await reviewOf(first, fireId);
    // The approval is committed once its step has: wait for the checkpoint to hold it.
    await pollUntil(async () => {
      const session = await first.getSession('mid-flight-session');
      return JSON.stringify(session?.metadata ?? {}).includes('charge-X') ? true : undefined;
    }, 'the approval to reach the session');
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    dead = false;
    const charges: number[] = [];
    const restarted = await open({
      generate,
      toolbox: approvalToolbox(charges),
      stopWhen: stopWhen.noToolCalls(),
      storage,
    });
    await pollUntil(
      () => (reviewsOf(restarted, fireId).length === 2 ? true : undefined),
      'both approvals to be listed',
    );

    const ids = reviewsOf(restarted, fireId)
      .map((review) => review.id)
      .toSorted();
    expect(ids).toEqual([`approval:${fireId}:charge-X`, `approval:${fireId}:charge-Y`]);
    for (const id of ids) {
      await restarted.resolveReview({ id, decision: 'approve', principal: OWNER.alice });
    }
    expect(charges.toSorted((left, right) => left - right)).toEqual([100, 200]);
  });
});

describe('a fire’s review is announced', () => {
  it('reaches the run’s history as review.requested, and the task reads input-required on its stream', async () => {
    const approval = await open({
      generate: chargesOnce,
      toolbox: approvalToolbox([]),
      stopWhen: stopAtApproval,
      storage: { type: 'sqlite', path: harness.nextDatabasePath() },
    });
    const { fireId } = await fireOnce(approval);
    const review = await reviewOf(approval, fireId);

    const announced = await pollUntil(async () => {
      const page = await approval.eventHistory({ kind: 'run', id: fireId });
      if (!('events' in page)) return undefined;
      const events = page.events.filter((event) => event.kind === 'review.requested');
      return events.length > 0 ? events : undefined;
    }, 'review.requested to reach the history');
    expect(announced).toHaveLength(1);
    expect(JSON.stringify(announced[0])).toContain(review.id);

    // A fire's stream is a snapshot of the task, then its end (COR-1482): the snapshot is what
    // says it is waiting.
    const frames = await readFrames(
      await handlerOf(approval)(
        subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
      ),
      { stop: (seen) => seen.length >= 1, timeoutMs: 5_000 },
    );
    expect(frames[0]).toMatchObject({
      event: 'task.snapshot',
      data: { taskId: fireId, status: 'input-required' },
    });
  });

  it('announces a human wait once, as review.requested, with the signal it waits on', async () => {
    const bureau = await open({
      generate: askingGenerate(),
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      storage: { type: 'sqlite', path: harness.nextDatabasePath() },
    });
    const { fireId } = await fireOnce(bureau);
    const review = await reviewOf(bureau, fireId);

    const announced = await pollUntil(async () => {
      const page = await bureau.eventHistory({ kind: 'run', id: fireId });
      if (!('events' in page)) return undefined;
      const events = page.events.filter((event) => event.kind === 'review.requested');
      return events.length > 0 ? events : undefined;
    }, 'review.requested to reach the history');

    expect(announced).toHaveLength(1);
    expect(JSON.stringify(announced[0])).toContain(review.id);
  });
});

describe('a fire that continues past an approval', () => {
  it('tells the resolver its outcome could not be kept, as a session run’s resolver is told', async () => {
    const charges: number[] = [];
    const secondStep = Promise.withResolvers<void>();
    const secondStepReached = Promise.withResolvers<void>();
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
        };
      }
      secondStepReached.resolve();
      await secondStep.promise;
      return { content: 'moving on', toolCalls: [] };
    };
    const bureau = await open({
      generate,
      toolbox: approvalToolbox(charges),
      // No `stopWhen.pendingApproval()`: the fire takes another step with the approval pending.
      stopWhen: stopWhen.noToolCalls(),
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'continuing-session');
    const review = await reviewOf(bureau, fireId);
    await secondStepReached.promise;

    const failure = await rejectionOf(
      bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    secondStep.resolve();

    expect(failure).toBeInstanceOf(ApprovalOutcomeNotWrittenError);
    expect((failure as BureauError).code).toBe('CONFLICT');
    // The decision took effect: only the conversation could not keep it.
    expect(charges).toEqual([4242]);
  });
});

describe('a bureau.run() run stays off the store scan (COR-1302)', () => {
  it('lists a parked run’s wait once: the store holds the run, and the scan skips it', async () => {
    const agent = createAgent({
      generate: async (context) =>
        context.step === 0
          ? {
              content: '',
              toolCalls: [
                { id: 'ask-1', name: 'requestHumanInput', arguments: { signalName: 'answer' } },
              ],
            }
          : { content: 'done', toolCalls: [] },
      toolbox: createToolbox([]),
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const bureau = await open({ agents: { asker: agent }, humanInput: true });

    const run = bureau.run('asker', 'go', { principal: OWNER.alice });
    await reviewOf(bureau, run.id);
    // The run is on the store while it lives, which is what the guard keeps the scan off. A
    // `bureau.run()` approval never reaches the scan either way, so the wait is what shows it.
    expect(bureau.getRun(run.id)).toBeDefined();

    // One entry: a scan of the store for this run would list the wait a second time.
    expect(reviewsOf(bureau, run.id).map((review) => review.kind)).toEqual(['human-wait']);
    run.abort();
    await run.result();
  });
});
