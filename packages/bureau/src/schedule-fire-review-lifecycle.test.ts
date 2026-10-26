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
  regatingApprovalToolbox,
  reviewsOf,
} from './schedule-fire-fixtures.test-support';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau } from './types';
import { expireReviews } from './testing/expired-reviews.test-support';

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
      agents: {
        default: createAgent({
          generate: chargesWithFreshCallIds(),
          toolbox: approvalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
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
      taskRetention: { olderThan: 1 },
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox([]),
          stopWhen: stopAtApproval,
        }),
      },
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
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'expiring-session');
    const review = await reviewOf(bureau, fireId);
    await pollUntil(
      async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );
    const pending = await sessionMetadata(bureau, 'expiring-session');
    expect(keysOf(pending['pendingApprovalOverrides'])).toEqual([review.id]);

    const swept = await expireReviews(bureau, Date.now() + 60 * 60 * 1000);

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
    expect(await expireReviews(bureau, Date.now() + 2 * 60 * 60 * 1000)).toBe(0);
    const refused = await rejectionOf(
      bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice }),
    );
    expect((refused as BureauError).code).toBe('NOT_FOUND');
  });
});

/**
 * A storage whose first process dies between a fire step's session write, which records the
 * approval, and the step's commit: the journal of the step is held for good, so the approval is in
 * the session and not in the checkpoint. `storageAfterCrash` is what the next process opens. The
 * held write is never released: that process is dead, and releasing it would make Weft warn that
 * it lost a checkpoint compare-and-swap.
 */
function crashAfterApprovalWrite() {
  const recordsApproval = (args: unknown[]) =>
    storedText(args).includes('pendingApprovalOverrides');
  const journalsStep = (args: unknown[]) => /wf:[^ ]+:ckpt/.test(storedText(args));
  let armed = false;
  let held = false;
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const storageAfterCrash = new MemoryStorage();
  const storage = new Proxy(storageAfterCrash, {
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
  return { storage, storageAfterCrash, reached: reached.promise };
}

/**
 * The same storage with every step record of a run's checkpoint read back without its `parts`: a
 * current-version record that fails the parts check, which a tolerant `loadSteps` skips and a
 * strict one rejects. The record on disk is untouched.
 */
function withUnreadableStepRecords(storage: MemoryStorage): MemoryStorage {
  const encoder = new TextEncoder();
  return new Proxy(storage, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (typeof member !== 'function') return member;
      if (property !== 'get') return (member as (...a: unknown[]) => unknown).bind(target);
      return async (...args: unknown[]) => {
        const value = await (member as (...a: unknown[]) => unknown).apply(target, args);
        const key = String(args[0]);
        if (
          !key.startsWith('durable-run:') ||
          !key.includes(':step:') ||
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

describe('the audit record of an expired fire approval', () => {
  it('keeps the round the approval had been superseded to', async () => {
    const charges: number[] = [];
    const bureau = await open({
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: regatingApprovalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const { fireId } = await fireOnce(bureau, OWNER.alice, 'rounds-session');
    const review = await reviewOf(bureau, fireId);
    // Approving it gates the call again: the tool does not run, and the review is at round 1.
    const superseded = await bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER.alice,
    });
    expect(superseded.superseded).toBe(true);
    expect(charges).toEqual([]);

    expect(await expireReviews(bureau, Date.now() + 60 * 60 * 1000)).toBe(1);

    const records = await bureau.auditTrail?.query({ runId: fireId });
    const expired = records?.find((record) => record.type === 'review.tool-approval.expired');
    const detail = expired?.detail as { review?: { round?: number } } | undefined;
    expect(detail?.review?.round).toBe(1);
  });
});

describe('a crash between a fire step’s session write and its commit', () => {
  it('restores only the approvals the run committed, and approving one charges once', async () => {
    const { storage: holdingStorage, storageAfterCrash: raw, reached } = crashAfterApprovalWrite();
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
      storage: holdingStorage,
      agents: {
        default: createAgent({ generate, toolbox: approvalToolbox([]), stopWhen: stopAtApproval }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'crash-session');
    await reached;
    const abandoned = await reviewOf(first, fireId);
    expect(abandoned.id).toBe(`approval:${fireId}:charge-A`);

    const charges: number[] = [];
    const restarted = await open({
      storage: raw,
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
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

  it('lists nothing for an abandoned approval once the fire has ended, and leaves none in its session', async () => {
    const { storage, storageAfterCrash, reached } = crashAfterApprovalWrite();
    let attempt = 0;
    const generate: GenerateFunction = async (context) => {
      if (context.step > 0) return { content: 'charged', toolCalls: [] };
      attempt += 1;
      // The replay ends before its own write-back: the provider is down.
      if (attempt === 2) throw new Error('the provider is down for the replay');
      return {
        content: '',
        toolCalls: [{ id: `charge-${attempt}`, name: 'charge-card', arguments: { cents: 100 } }],
      };
    };
    const first = await open({
      storage,
      agents: {
        default: createAgent({ generate, toolbox: approvalToolbox([]), stopWhen: stopAtApproval }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'ended-crash-session');
    await reached;
    const abandoned = await reviewOf(first, fireId);
    expect(abandoned.id).toBe(`approval:${fireId}:charge-1`);

    const diagnostics: string[] = [];
    const second = await open({
      storage: storageAfterCrash,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      agents: {
        default: createAgent({ generate, toolbox: approvalToolbox([]), stopWhen: stopAtApproval }),
      },
    });
    await pollUntil(async () => {
      const status = await durableStatus(second, fireId);
      return status !== undefined && !['pending', 'running', 'suspended'].includes(status)
        ? status
        : undefined;
    }, 'the replay to end');
    // Whatever settles the fire reconciles its session with its checkpoint, which never held
    // the abandoned approval.
    await pollUntil(async () => {
      const metadata = await sessionMetadata(second, 'ended-crash-session');
      return keysOf(metadata['pendingApprovalOverrides']).length === 0 ? true : undefined;
    }, 'the fire’s session to shed the abandoned approval');
    // The replay ended in error, which is what leaves the fire without a write-back of its own.
    expect(diagnostics.join('\n')).toContain('the provider is down for the replay');
    const metadata = await sessionMetadata(second, 'ended-crash-session');
    expect(keysOf(metadata['lastRequestAuthorities'])).toEqual([]);
    expect(keysOf(metadata['pendingApprovalRounds'])).toEqual([]);

    const charges: number[] = [];
    const third = await open({
      storage: storageAfterCrash,
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    expect(reviewsOf(third, fireId)).toEqual([]);
    expect(charges).toEqual([]);
  });

  it('keeps a committed approval whose step record fails the parts check, at settle and after a restart', async () => {
    const storage = new MemoryStorage();
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        return {
          content: '',
          toolCalls: [{ id: 'charge-X', name: 'charge-card', arguments: { cents: 100 } }],
        };
      }
      // The first process never gets past its second step: it is the one that dies.
      if (dead) return new Promise<never>(() => {});
      return { content: 'done', toolCalls: [] };
    };
    let dead = true;
    const first = await open({
      storage,
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'unreadable-session');
    await reviewOf(first, fireId);
    await pollUntil(async () => {
      const metadata = await sessionMetadata(first, 'unreadable-session');
      return keysOf(metadata['pendingApprovalOverrides']).length === 1 ? true : undefined;
    }, 'the approval to reach the session');
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    dead = false;
    const diagnostics: string[] = [];
    const second = await open({
      storage: withUnreadableStepRecords(storage),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    await pollUntil(async () => {
      const status = await durableStatus(second, fireId);
      return status !== undefined && !['pending', 'running', 'suspended'].includes(status)
        ? status
        : undefined;
    }, 'the recovered fire to settle');
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));

    // Neither the replay's write-back nor the settle reconcile may take a step it could not read
    // for a step that was never committed.
    const kept = await sessionMetadata(second, 'unreadable-session');
    expect(keysOf(kept['pendingApprovalOverrides'])).toEqual([`approval:${fireId}:charge-X`]);
    expect(keysOf(kept['lastRequestAuthorities'])).toEqual([fireId]);
    expect(diagnostics.join('\n')).toContain('Could not read what schedule fire');

    const bootDiagnostics: string[] = [];
    const third = await open({
      storage: withUnreadableStepRecords(storage),
      onDiagnostic: (diagnostic) => bootDiagnostics.push(diagnostic.message),
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
    });
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    const afterRestart = await sessionMetadata(third, 'unreadable-session');
    expect(keysOf(afterRestart['pendingApprovalOverrides'])).toEqual([
      `approval:${fireId}:charge-X`,
    ]);
    // Not listed while its checkpoint cannot be read, and said so, rather than taken for gone.
    expect(reviewsOf(third, fireId)).toEqual([]);
    expect(bootDiagnostics.join('\n')).toContain('Could not read what schedule fire');
  });

  it('does not list a review again that was decided before the crash, at the replay or at any later boot', async () => {
    const { storage, storageAfterCrash, reached } = crashAfterApprovalWrite();
    const firstCharges: number[] = [];
    const first = await open({
      storage,
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(firstCharges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'decided-crash-session');
    await reached;
    const review = await reviewOf(first, fireId);
    // Decided in the window: the tool ran, and the step that raised the approval never commits.
    await first.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    expect(firstCharges).toEqual([4242]);

    // The replay makes the same call under the same id.
    const secondCharges: number[] = [];
    const second = await open({
      storage: storageAfterCrash,
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(secondCharges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    await pollUntil(
      async () => ((await durableStatus(second, fireId)) === 'completed' ? true : undefined),
      'the replay to complete',
    );
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(reviewsOf(second, fireId)).toEqual([]);
    const metadata = await sessionMetadata(second, 'decided-crash-session');
    expect(keysOf(metadata['pendingApprovalOverrides'])).toEqual([]);
    expect(keysOf(metadata['lastRequestAuthorities'])).toEqual([]);

    const third = await open({
      storage: storageAfterCrash,
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox([]),
          stopWhen: stopAtApproval,
        }),
      },
    });
    for (let turn = 0; turn < 50; turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    expect(reviewsOf(third, fireId)).toEqual([]);
    expect(secondCharges).toEqual([]);
  });
});

describe('a fire’s approval is fenced across Bureau processes by the durable decision record (COR-1579)', () => {
  it('refuses a peer’s stale denial after the first decision’s session fence has retired with the task', async () => {
    const storage = { type: 'sqlite' as const, path: harness.nextDatabasePath() };
    const firstCharges: number[] = [];
    const first = await open({
      storage,
      taskRetention: { olderThan: 1 },
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(firstCharges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const { fireId } = await fireOnce(first, OWNER.alice, 'fenced-session');
    const review = await reviewOf(first, fireId);
    await pollUntil(
      async () => ((await durableStatus(first, fireId)) === 'completed' ? true : undefined),
      'the fire to end at its approval',
    );
    // A peer that lists the same approval, from the session the fire recorded it in.
    const peerCharges: number[] = [];
    const peer = await open({
      storage,
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox(peerCharges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    await reviewOf(peer, fireId);

    await first.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    // The task leaves retention, and the session's own record of the decision goes with it.
    await pollUntil(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await first.runDurableMaintenance(Date.now());
      return (await first.tasks.record(fireId)) === undefined ? true : undefined;
    }, 'the fire’s task to leave retention');
    const metadata = await sessionMetadata(first, 'fenced-session');
    expect(keysOf(metadata['resolvedReviewDecisions'])).toEqual([]);

    const refusal = await rejectionOf(
      peer.resolveReview({ id: review.id, decision: 'deny', principal: OWNER.bob }),
    );

    expect((refusal as BureauError).code).toBe('CONFLICT');
    expect(firstCharges).toEqual([4242]);
    expect(peerCharges).toEqual([]);
  });
});

describe('a fire’s task stream ends when its last review closes', () => {
  const statusesOf = (frames: readonly { data?: unknown }[]) =>
    frames.map((frame) => (frame.data as { status?: string }).status);

  /** A fire held at its first step until `release`, so a subscriber can connect before it raises. */
  async function heldFire() {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const charges: number[] = [];
    const generate: GenerateFunction = async (context) => {
      if (context.step > 0) return { content: 'done', toolCalls: [] };
      entered.resolve();
      await gate.promise;
      return {
        content: '',
        toolCalls: [{ id: 'charge-1', name: 'charge-card', arguments: { cents: 4242 } }],
      };
    };
    const bureau = await open({
      storage: { type: 'sqlite', path: harness.nextDatabasePath() },
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox(charges),
          stopWhen: stopAtApproval,
        }),
      },
    });
    const created = await bureau.createSchedule({
      agentName: 'default',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
    });
    await bureau.runDurableMaintenance(created?.nextFireAt ?? 0);
    await entered.promise;
    const fireId = await pollUntil(async () => {
      const schedule = await bureau.getSchedule(created?.id ?? '');
      return schedule?.currentWorkflowId ?? undefined;
    }, 'the fire to start');
    const follow = async () =>
      readFrames(
        await handlerOf(bureau)(
          subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
        ),
        { timeoutMs: 8_000 },
      );
    return { bureau, fireId, follow, release: () => gate.resolve(), charges };
  }

  const closings = {
    decided: async (bureau: Bureau, reviewId: string) => {
      await bureau.resolveReview({ id: reviewId, decision: 'approve', principal: OWNER.alice });
    },
    expired: async (bureau: Bureau) => {
      expect(await expireReviews(bureau, Date.now() + 60 * 60 * 1000)).toBe(1);
    },
  };

  for (const [closing, close] of Object.entries(closings)) {
    it(`gives a subscriber from before the review working, input-required, then its end, once the review is ${closing}`, async () => {
      const { bureau, fireId, follow, release } = await heldFire();
      const reading = follow();
      release();
      const review = await reviewOf(bureau, fireId);
      await pollUntil(
        async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
        'the fire to settle with its approval open',
      );

      await close(bureau, review.id);
      const frames = await reading;

      expect(statusesOf(frames)).toEqual(['working', 'input-required', 'completed']);
      expect(frames.map((frame) => frame.event)).toEqual([
        'task.snapshot',
        'task.status',
        'task.status',
      ]);
    });

    it(`gives a subscriber from while it waits input-required, then its end, once the review is ${closing}`, async () => {
      const { bureau, fireId, follow, release } = await heldFire();
      release();
      const review = await reviewOf(bureau, fireId);
      await pollUntil(
        async () => ((await durableStatus(bureau, fireId)) === 'completed' ? true : undefined),
        'the fire to settle with its approval open',
      );
      const reading = follow();
      await new Promise((resolve) => setTimeout(resolve, 20));

      await close(bureau, review.id);
      const frames = await reading;

      expect(statusesOf(frames)).toEqual(['input-required', 'completed']);
    });
  }

  it('gives a subscriber from before a human wait working, input-required, working, then its end', async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const generate: GenerateFunction = async (context) => {
      if (context.step === 0) {
        entered.resolve();
        await gate.promise;
      }
      return askingGenerate()(context);
    };
    const bureau = await open({
      storage: { type: 'sqlite', path: harness.nextDatabasePath() },
      agents: {
        default: createAgent({
          generate,
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
    });
    const created = await bureau.createSchedule({
      agentName: 'default',
      input: 'check in',
      spec: '1m',
      principal: OWNER.alice,
    });
    await bureau.runDurableMaintenance(created?.nextFireAt ?? 0);
    await entered.promise;
    const fireId = await pollUntil(async () => {
      const schedule = await bureau.getSchedule(created?.id ?? '');
      return schedule?.currentWorkflowId ?? undefined;
    }, 'the fire to start');
    const reading = readFrames(
      await handlerOf(bureau)(
        subscribeRequest('bureau.tasks.events', { taskId: fireId }, 'alice-key'),
      ),
      { timeoutMs: 8_000 },
    );
    gate.resolve();
    const review = await reviewOf(bureau, fireId);
    // Let the stream hear the park before the answer, so its order is the task's.
    await new Promise((resolve) => setTimeout(resolve, 50));

    await bureau.resolveReview({ id: review.id, decision: 'approve', principal: OWNER.alice });
    const frames = await reading;

    expect(statusesOf(frames)).toEqual(['working', 'input-required', 'working', 'completed']);
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
      storage,
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox([]),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
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
      storage,
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
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
      storage: { type: 'sqlite', path: harness.nextDatabasePath() },
      agents: {
        default: createAgent({
          generate: chargesOnce,
          toolbox: approvalToolbox([]),
          stopWhen: stopAtApproval,
        }),
      },
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
      storage: { type: 'sqlite', path: harness.nextDatabasePath() },
      agents: {
        default: createAgent({
          generate: askingGenerate(),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
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
    const diagnostics: string[] = [];
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
      // No `stopWhen.pendingApproval()`: the fire takes another step with the approval pending.
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.message),
      agents: {
        default: createAgent({
          generate,
          toolbox: approvalToolbox(charges),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
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
    expect(diagnostics.join('\n')).toContain('another step to take');
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
    const bureau = await open({ agents: { asker: agent } });

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
