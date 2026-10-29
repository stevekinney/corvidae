/**
 * COR-1579 — review resolution with two Bureau processes over one SQLite file that share nothing
 * else. A peer derives the human waits of a run it does not hold from durable state, and resolves
 * a session run's park; a durable decision record, claimed before anything irreversible, makes
 * one decision of resolvers racing in different processes, for human waits and tool approvals.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
  type Toolbox,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import { BureauError, createBureau, ReviewRoundChangedError } from './create-bureau';
import { reviewDecisionKey } from './review-decision-record';
import * as runtimeCompositionModule from './runtime-composition';
import {
  bufferedSignals,
  buffersSignal,
  type OpenedProcess,
  openProcess,
  pollUntil,
  readsDecisionRecord,
  reviewAuditEntries,
  textOf,
  writesDecisionRecord,
} from './test/session-input-fixtures';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type {
  Bureau,
  BureauOptions,
  PendingHumanWaitReview,
  PendingReview,
  PendingToolApprovalReview,
  StartTaskOptions,
} from './types';

const APPROVAL_SECRET = 'review-resolution-multi-instance-secret';

/** A renewal interval short enough that A hears B's signal promptly, far inside the claim's TTL. */
const OWNERSHIP = {
  ownership: 'workflow-lease',
  workflowClaimTtlMs: 30_000,
  workflowClaimRenewIntervalMs: 25,
} as const;

let directory: string;
let path: string;
const processes: OpenedProcess[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'corvidae-review-resolution-multi-'));
  path = join(directory, 'bureau.sqlite');
});

afterEach(async () => {
  for (const opened of processes.splice(0).toReversed()) await opened.bureau.dispose();
  await rm(directory, { recursive: true, force: true });
});

/** What a test controls about the charge tool, shared by every process's own toolbox. */
type Charges = {
  readonly charged: number[];
  /** When set, the tool's own policy refuses a resumed call before it runs. */
  refuseOnResume: boolean;
  /** When set, the toolbox's policy gates a resumed call again. */
  regate: boolean;
};

function newCharges(): Charges {
  return { charged: [], refuseOnResume: false, regate: false };
}

/**
 * A gated toolbox with an approval secret: every `charge-card` call needs approval. Each process
 * builds its own, as separate processes would, and they all count into one `Charges`.
 */
function gatedToolbox(charges: Charges): Toolbox {
  return createToolbox(
    [
      createTool({
        name: 'charge-card',
        version: '1.0.0',
        description: 'Charge a payment card',
        input: z.object({ cents: z.number() }),
        policy: {
          beforeExecute: () =>
            charges.refuseOnResume
              ? { status: 'deny', reason: 'Current policy refuses this charge' }
              : { status: 'allow' },
        },
        async execute({ cents }) {
          charges.charged.push(cents);
          return { charged: cents };
        },
      }),
    ],
    {
      approvalSecret: APPROVAL_SECRET,
      policy: {
        // Only the charge is gated: `requestHumanInput` joins this toolbox on a humanInput run.
        beforeExecute: (context) => {
          if (context.toolName !== 'charge-card') return { status: 'allow' };
          const gatedAgain = charges.regate;
          return {
            allow: false,
            status: 'needs_approval',
            reason: gatedAgain ? 'Approval required again' : 'Operator approval required',
            action: { message: 'Approve charge' },
          };
        },
      },
    },
  ) as unknown as Toolbox;
}

type Seen = {
  /** The conversation as JSON at each step after a park, to read the delivered answer. */
  readonly resumed: string[];
};

/** A model that parks on `answer` for its first `parks` steps, then answers. */
function asking(seen: Seen, parks = 1): GenerateFunction {
  return async (context: GenerateContext) => {
    if (context.step > 0) seen.resumed.push(JSON.stringify(context.conversation.current));
    if (context.step < parks) {
      return {
        content: '',
        toolCalls: [
          {
            id: `call-${String(context.step)}`,
            name: 'requestHumanInput',
            arguments: { signalName: 'answer', prompt: 'Which environment?' },
          },
        ],
      };
    }
    return { content: 'thanks', toolCalls: [] };
  };
}

/** A model that asks to charge a card once, then finishes. */
function charging(): GenerateFunction {
  return async (context: GenerateContext) =>
    context.step === 0
      ? {
          content: '',
          toolCalls: [{ id: 'call-charge', name: 'charge-card', arguments: { cents: 500 } }],
        }
      : { content: 'Charged.', toolCalls: [] };
}

async function open(
  generate: GenerateFunction,
  charges: Charges,
  options: Partial<BureauOptions<AgentDefinitions>> = {},
): Promise<OpenedProcess> {
  const opened = await openProcess(path, generate, {
    id: 'review-resolution-multi-instance',
    durableOwnership: OWNERSHIP,
    ...options,
    agents: {
      ...options.agents,
      default: createAgent({
        generate,
        toolbox: gatedToolbox(charges),
        stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      }),
    },
  });
  processes.push(opened);
  return opened;
}

/** The review a process lists for a run, once it does. */
async function listed(bureau: Bureau<AgentDefinitions>, runId: string): Promise<PendingReview> {
  await pollUntil(() => bureau.reviews.list().some((review) => review.runId === runId));
  return bureau.reviews.list().find((review) => review.runId === runId)!;
}

/** B's derived review of a run A holds, once the park has committed. */
async function derived(
  bureau: Bureau<AgentDefinitions>,
  runId: string,
): Promise<PendingHumanWaitReview> {
  let found: PendingHumanWaitReview | undefined;
  await pollUntil(async () => {
    [found] = await bureau.reviews.pendingOf(runId);
    return found !== undefined;
  });
  return found!;
}

/** Two processes, B opened first, and one session run parked in A on a human wait. */
async function sessionParkedInA(
  parks = 1,
  aOptions: Partial<BureauOptions<AgentDefinitions>> = {},
  runOptions: StartTaskOptions = { principal: 'alice' },
) {
  const seenByA: Seen = { resumed: [] };
  const charges = newCharges();
  const b = await open(asking({ resumed: [] }, parks), charges);
  const a = await open(asking(seenByA, parks), charges, aOptions);
  const run = await a.bureau.tasks.start('default', 'deploy', runOptions);
  const review = await listed(a.bureau, run.id);
  await derived(b.bureau, run.id);
  return { a, b, run, review, seenByA };
}

/**
 * A tool approval of a settled run, held by two processes A and B that were both opened after it
 * settled and restored it at boot.
 */
async function settledApproval(charges: Charges) {
  const generate = charging();
  const setup = await openProcess(path, generate, {
    id: 'review-resolution-multi-instance',
    durableOwnership: OWNERSHIP,
    agents: {
      default: createAgent({
        generate,
        toolbox: gatedToolbox(charges),
        stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
      }),
    },
  });
  const run = await setup.bureau.tasks.start('default', 'Charge the customer', {
    principal: 'alice',
  });
  await setup.bureau.tasks.wait(run.id);
  await pollUntil(async () => {
    const session = await setup.bureau.contexts.get(run.contextId);
    return session?.metadata['lastRunStatus'] !== 'running';
  });
  await listed(setup.bureau, run.id);
  await setup.bureau.dispose();
  const a = await open(charging(), charges);
  const b = await open(charging(), charges);
  const review = (await listed(a.bureau, run.id)) as PendingToolApprovalReview;
  await listed(b.bureau, run.id);
  return { a, b, run, review };
}

function codeOf(reason: unknown): string | undefined {
  return reason instanceof BureauError ? reason.code : undefined;
}

/** A write that persists a review's resolution into its session. */
function persistsResolution(operations: Parameters<typeof writesDecisionRecord>[0]): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' &&
      operation.key.startsWith('agent-session') &&
      textOf(operation).includes('resolvedReviewDecisions'),
  );
}

describe('the by-run derivation (COR-1579)', () => {
  it("derives a peer's pending human waits of a run", async () => {
    const charges = newCharges();
    const catalogSeen: Seen = { resumed: [] };
    const agents = {
      asker: createAgent({
        generate: asking(catalogSeen),
        toolbox: createToolbox([]) as unknown as Toolbox,
        stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
      }),
    };
    const b = await open(asking({ resumed: [] }), charges, { agents });
    const a = await open(asking({ resumed: [] }), charges, { agents });
    const sessionRun = await a.bureau.tasks.start('default', 'deploy', { principal: 'alice' });
    const catalogRun = await a.bureau.tasks.start('asker', 'deploy', {
      principal: 'api-key:alice',
    });

    for (const task of [sessionRun, catalogRun]) {
      const runId = task.id;
      const local = (await listed(a.bureau, runId)) as PendingHumanWaitReview;
      const peer = await derived(b.bureau, runId);
      expect(await b.bureau.reviews.pendingOf(runId)).toHaveLength(1);
      expect(peer).toMatchObject({
        kind: 'human-wait',
        id: local.id,
        runId,
        signalName: local.signalName,
        prompt: local.prompt,
        status: 'pending',
      });
      expect(peer.sessionId).toBe(task.contextId);
    }

    for (const task of [sessionRun, catalogRun]) {
      const runId = task.id;
      const local = await listed(a.bureau, runId);
      await a.bureau.reviews.resolve({ id: local.id, decision: 'approve', principal: 'alice' });
    }
    await catalogRun.result();
    await a.bureau.tasks.wait(sessionRun.id);
    expect(await b.bureau.reviews.pendingOf(sessionRun.id)).toEqual([]);
    expect(await b.bureau.reviews.pendingOf(catalogRun.id)).toEqual([]);
  });
});

describe('a session human wait another process holds (COR-1579)', () => {
  it("resolves a peer's parked session human wait", async () => {
    const { a, b, run, review, seenByA } = await sessionParkedInA();

    expect(await b.bureau.reviews.get(review.id)).toMatchObject({
      id: review.id,
      kind: 'human-wait',
      sessionId: run.contextId,
      status: 'pending',
    });
    expect(
      await b.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        payload: { environment: 'from-b' },
      }),
    ).toMatchObject({ id: review.id, kind: 'human-wait', decision: 'approve' });

    await a.bureau.tasks.wait(run.id);
    expect(seenByA.resumed).toHaveLength(1);
    expect(seenByA.resumed[0]).toContain('from-b');
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(1);
  });

  it('lets one of two racing resolvers decide a session human wait', async () => {
    const { a, b, run, review, seenByA } = await sessionParkedInA(2);
    const heldA = a.seam.holdRead(readsDecisionRecord);
    const heldB = b.seam.holdRead(readsDecisionRecord);
    const fromA = a.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'alice',
      payload: { environment: 'from-a' },
    });
    const fromB = b.bureau.reviews.resolve({
      id: review.id,
      decision: 'deny',
      principal: 'alice',
      reason: 'from-b',
    });
    await Promise.all([heldA.reached, heldB.reached]);
    heldA.release();
    heldB.release();
    const outcomes = await Promise.allSettled([fromA, fromB]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(codeOf((rejected[0] as PromiseRejectedResult).reason)).toBe('CONFLICT');
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ decision: string }>).value.decision;

    // The run consumed one signal and parked again on the same name, and no buffered second
    // payload is waiting to answer that park.
    const second = `human-wait:${run.id}:answer:1`;
    await pollUntil(() => a.bureau.reviews.list().some(({ id }) => id === second));
    expect(seenByA.resumed).toHaveLength(1);
    expect(seenByA.resumed[0]).toContain(winner === 'approve' ? 'from-a' : '__abDenied');
    expect(await bufferedSignals(a.real, run.id)).toEqual([]);
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(1);
  });

  it("keeps a session human wait's claim when delivery throws, and delivers once on a same-decision retry", async () => {
    const { a, b, run, review, seenByA } = await sessionParkedInA(2);
    const decision = {
      id: review.id,
      decision: 'approve',
      principal: 'alice',
      payload: { environment: 'production' },
    } as const;
    const failing = a.seam.failWrites(buffersSignal, new Error('the signal write was lost'));
    const failed = await rejectionOf(a.bureau.reviews.resolve(decision));
    failing.stop();

    expect((failed as Error).message).toContain('the signal write was lost');
    expect(await a.real.get(reviewDecisionKey(review.id, 0))).not.toBeNull();
    const different = await rejectionOf(
      b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'alice' }),
    );
    expect(codeOf(different)).toBe('CONFLICT');

    expect(await b.bureau.reviews.resolve(decision)).toMatchObject({
      id: review.id,
      decision: 'approve',
    });
    const second = `human-wait:${run.id}:answer:1`;
    await pollUntil(() => a.bureau.reviews.list().some(({ id }) => id === second));
    expect(seenByA.resumed).toHaveLength(1);
    expect(seenByA.resumed[0]).toContain('production');
    expect(await bufferedSignals(a.real, run.id)).toEqual([]);
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(1);
  });

  it("refuses a peer's approval of a wait whose transport-issued authority it cannot revalidate", async () => {
    // A, which holds the run, validates the transport-issued authority it carries. B, opened
    // first, has no validator at all.
    const { a, b, run, review, seenByA } = await sessionParkedInA(
      1,
      { requestAuthorityValidator: () => true },
      {
        requestContext: {
          authority: {
            principalId: 'api-key:alice',
            tenantId: 'tenant-a',
            ownerId: 'owner-a',
            capabilities: ['tools:execute'],
            authorizationRevision: 'gateway:api-key:alice',
          },
          audience: 'tenant',
        },
      },
    );
    // A second peer, whose validator says the authority is no longer current.
    const stale = await open(asking({ resumed: [] }), newCharges(), {
      requestAuthorityValidator: () => false,
    });
    await derived(stale.bureau, run.id);

    for (const peer of [b, stale]) {
      const refusal = await rejectionOf(
        peer.bureau.reviews.resolve({
          id: review.id,
          decision: 'approve',
          principal: 'alice',
          payload: { environment: 'production' },
        }),
      );
      expect(codeOf(refusal)).toBe('CONFLICT');
    }
    // Nothing was delivered or claimed, and the run is still parked.
    expect(await a.real.get(reviewDecisionKey(review.id, 0))).toBeNull();
    expect(await bufferedSignals(a.real, run.id)).toEqual([]);
    const stillPending = await b.bureau.reviews.pendingOf(run.id);
    expect(stillPending.map(({ id }) => id)).toEqual([review.id]);
    expect(a.bureau.reviews.list().map(({ id }) => id)).toEqual([review.id]);
    expect(seenByA.resumed).toEqual([]);
  });
});

describe('a tool approval two processes hold (COR-1579)', () => {
  it('decides an approve/deny race by whichever claims first', async () => {
    // A first: B is held before its claim commits, and A approves.
    {
      const charges = newCharges();
      const { a, b, review } = await settledApproval(charges);
      const heldB = b.seam.holdWrite(writesDecisionRecord);
      const fromB = b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'bob' });
      await heldB.reached;
      expect(
        await a.bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'alice' }),
      ).toMatchObject({ id: review.id, decision: 'approve' });
      heldB.release();
      expect(codeOf(await rejectionOf(fromB))).toBe('CONFLICT');
      expect(charges.charged).toHaveLength(1);
      for (const opened of processes.splice(0)) await opened.bureau.dispose();
      await rm(directory, { recursive: true, force: true });
      directory = await mkdtemp(join(tmpdir(), 'corvidae-review-resolution-multi-'));
      path = join(directory, 'bureau.sqlite');
    }
    // B first: A is held before its claim commits, and B denies.
    {
      const charges = newCharges();
      const { a, b, review } = await settledApproval(charges);
      const heldA = a.seam.holdWrite(writesDecisionRecord);
      const fromA = a.bureau.reviews.resolve({
        id: review.id,
        decision: 'approve',
        principal: 'alice',
      });
      await heldA.reached;
      expect(
        await b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'bob' }),
      ).toMatchObject({ id: review.id, decision: 'deny' });
      heldA.release();
      expect(codeOf(await rejectionOf(fromA))).toBe('CONFLICT');
      expect(charges.charged).toHaveLength(0);
    }
  });

  it('answers a same-decision approval racer by when the first decision persists', async () => {
    const charges = newCharges();
    const { a, b, review } = await settledApproval(charges);
    const decision = { id: review.id, decision: 'approve', principal: 'alice' } as const;
    const heldPersistence = a.seam.holdWrite(persistsResolution);
    const fromA = a.bureau.reviews.resolve(decision);
    await heldPersistence.reached;

    const early = await rejectionOf(b.bureau.reviews.resolve(decision));
    expect(codeOf(early)).toBe('CONFLICT');
    expect((early as Error).message).toContain('already being resolved');

    heldPersistence.release();
    expect(await fromA).toMatchObject({ id: review.id, decision: 'approve' });
    expect(await b.bureau.reviews.resolve(decision)).toMatchObject({
      id: review.id,
      decision: 'approve',
    });
    expect(charges.charged).toHaveLength(1);
  });

  it("releases a session approval's claim when the policy gates it again", async () => {
    const charges = newCharges();
    const { a, review } = await settledApproval(charges);
    charges.regate = true;

    const resolved = await a.bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'alice',
    });

    expect(resolved).toMatchObject({ id: review.id, superseded: true });
    expect(a.bureau.reviews.list()).toMatchObject([{ id: review.id, round: 1 }]);
    expect(await a.real.get(reviewDecisionKey(review.id, 0))).toBeNull();
    // B is opened after the re-gate: it restores the round at boot.
    const b = await open(charging(), charges);
    const reopened = (await listed(b.bureau, review.runId)) as PendingToolApprovalReview;
    expect(reopened).toMatchObject({ id: review.id, round: 1 });
    expect(
      await b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'bob' }),
    ).toMatchObject({ id: review.id, decision: 'deny' });
    expect(charges.charged).toHaveLength(0);
  });

  describe('when a peer has re-gated the approval and this process still lists the round it left (COR-1659)', () => {
    /** A re-gates round 0 to 1; B has not heard of it yet. */
    async function regatedByA() {
      const charges = newCharges();
      const { a, b, review } = await settledApproval(charges);
      charges.regate = true;
      await a.bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'alice' });
      expect(a.bureau.reviews.list()).toMatchObject([{ id: review.id, round: 1 }]);
      charges.regate = false;
      return { b, review, charges };
    }

    it('refuses a decision on the round it left with the typed refusal, and then accepts the current round', async () => {
      const { b, review, charges } = await regatedByA();

      const stale = await rejectionOf(
        b.bureau.reviews.resolve({
          id: review.id,
          decision: 'approve',
          principal: 'bob',
          round: 0,
        }),
      );
      expect(stale).toBeInstanceOf(ReviewRoundChangedError);
      expect(codeOf(stale)).toBe('CONFLICT');
      expect(charges.charged).toHaveLength(0);

      // The refusal caught this process up, so the round the caller reads next decides.
      expect(
        await b.bureau.reviews.resolve({
          id: review.id,
          decision: 'deny',
          principal: 'bob',
          round: 1,
        }),
      ).toMatchObject({ id: review.id, decision: 'deny' });
      expect(charges.charged).toHaveLength(0);
    });

    it('accepts the current round at once, with no earlier refusal to catch it up', async () => {
      const { b, review, charges } = await regatedByA();

      expect(
        await b.bureau.reviews.resolve({
          id: review.id,
          decision: 'deny',
          principal: 'bob',
          round: 1,
        }),
      ).toMatchObject({ id: review.id, decision: 'deny' });
      expect(charges.charged).toHaveLength(0);
    });

    it('refuses a round that is ahead of every round it knows of', async () => {
      const { b, review } = await regatedByA();

      const ahead = await rejectionOf(
        b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'bob', round: 5 }),
      );
      expect(ahead).toBeInstanceOf(ReviewRoundChangedError);
    });

    it('still refuses a decision that names no round with a plain conflict', async () => {
      const { b, review } = await regatedByA();

      const unfenced = await rejectionOf(
        b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'bob' }),
      );
      expect(codeOf(unfenced)).toBe('CONFLICT');
      expect(unfenced).not.toBeInstanceOf(ReviewRoundChangedError);
    });
  });

  it("releases a session approval's claim on a proven pre-execution failure", async () => {
    const charges = newCharges();
    const { a, b, review } = await settledApproval(charges);
    charges.refuseOnResume = true;

    const refused = await rejectionOf(
      a.bureau.reviews.resolve({ id: review.id, decision: 'approve', principal: 'alice' }),
    );

    expect(codeOf(refused)).toBe('CONFLICT');
    expect(await a.real.get(reviewDecisionKey(review.id, 0))).toBeNull();
    expect(
      await b.bureau.reviews.resolve({ id: review.id, decision: 'deny', principal: 'bob' }),
    ).toMatchObject({ id: review.id, decision: 'deny' });
    expect(charges.charged).toHaveLength(0);
  });
});

describe('a Bureau with no key-value store (COR-1579)', () => {
  it('resolves as today with no key-value store', async () => {
    const original = runtimeCompositionModule.createRuntimeComposition;
    const composition = spyOn(runtimeCompositionModule, 'createRuntimeComposition');
    composition.mockImplementation(async (...parameters) => {
      const runtime = await original(...parameters);
      (runtime as { kv: unknown }).kv = undefined;
      return runtime;
    });
    const storage = new MemoryStorage();
    const seen: Seen = { resumed: [] };
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({
          generate: asking(seen),
          toolbox: gatedToolbox(newCharges()),
          stopWhen: stopWhen.noToolCalls(),
        }),
      },
      storage,
      durable: true,
    });
    composition.mockRestore();
    try {
      const run = await bureau.tasks.start('default', 'deploy', { principal: 'alice' });
      const review = await listed(bureau, run.id);
      const decision = {
        id: review.id,
        decision: 'approve',
        principal: 'alice',
        payload: { environment: 'staging' },
      } as const;

      const first = bureau.reviews.resolve(decision);
      const concurrent = await rejectionOf(bureau.reviews.resolve(decision));
      expect(await first).toMatchObject({ id: review.id, decision: 'approve' });

      expect(codeOf(concurrent)).toBe('CONFLICT');
      expect((concurrent as Error).message).toContain('already being resolved');
      await bureau.tasks.wait(run.id);
      expect(seen.resumed).toHaveLength(1);
      expect(seen.resumed[0]).toContain('staging');
      const decisionRecords: string[] = [];
      for await (const [key] of storage.scan('review-decision:')) decisionRecords.push(key);
      expect(decisionRecords).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });
});
