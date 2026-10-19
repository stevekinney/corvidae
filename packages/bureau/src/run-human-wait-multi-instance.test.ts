/**
 * COR-1579 — the human wait of a `bureau.run()` run, with two Bureau processes over one SQLite
 * file that share nothing else. A peer that does not hold the parked run lists, reads and resolves
 * its review, authorizing the caller against the run's real owner, and a durable decision record
 * makes one decision of two racing resolvers, wherever each runs.
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
import { principalFromApiKey } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { AgentDefinitions } from './agent-catalog';
import { BureauError } from './create-bureau';
import { createBureauHandler } from './http/create-bureau-handler';
import { reviewDecisionKey } from './review-decision-record';
import {
  bufferedSignals,
  buffersSignal,
  type OpenedProcess,
  openProcess,
  pollUntil,
  readsDecisionRecord,
  reviewAuditEntries,
} from './test/session-input-fixtures';
import { rejectionOf } from './testing/promise-outcome.test-support.ts';
import type { Bureau, PendingHumanWaitReview, ResolveReviewInput } from './types';

/** The owner string of the API key `owner-key`, whose subject is `tester`. */
const OWNER = 'api-key:tester';
const OWNER_KEY = 'owner-key';
const STRANGER_KEY = 'stranger-key';
const keys: Record<string, Parameters<typeof principalFromApiKey>[0]> = {
  [OWNER_KEY]: { subject: 'tester', scopes: [] },
  [STRANGER_KEY]: { subject: 'stranger', scopes: [] },
};
const authentication = {
  resolveApiKeyPrincipal: async (key: string) =>
    key in keys ? principalFromApiKey(keys[key]!) : null,
  auditSink: () => undefined,
};

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
  directory = await mkdtemp(join(tmpdir(), 'corvidae-run-human-wait-multi-'));
  path = join(directory, 'bureau.sqlite');
});

afterEach(async () => {
  for (const opened of processes.splice(0).toReversed()) await opened.bureau.dispose();
  await rm(directory, { recursive: true, force: true });
});

type Seen = {
  /** The conversation as JSON at each step after a park, to read the delivered answer. */
  readonly resumed: string[];
};

/** An agent that parks on `answer` for its first `parks` steps, then thanks the operator. */
function askingAgent(seen: Seen, parks = 1) {
  const generate: GenerateFunction = async (context: GenerateContext) => {
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
  return createAgent({
    generate,
    toolbox: createToolbox([]) as unknown as Toolbox,
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
}

const neverGenerates: GenerateFunction = async () => {
  throw new Error('only the catalog agent generates');
};

async function open(seen: Seen, parks = 1): Promise<OpenedProcess> {
  const opened = await openProcess(path, neverGenerates, {
    id: 'run-human-wait-multi-instance',
    agents: { asker: askingAgent(seen, parks) },
    humanInput: true,
    durableOwnership: OWNERSHIP,
  });
  processes.push(opened);
  return opened;
}

/** A's own review of its parked run. */
async function localReview(bureau: Bureau<AgentDefinitions>, runId: string) {
  await pollUntil(() => bureau.listPendingReviews().some((review) => review.runId === runId));
  const review = bureau.listPendingReviews().find((candidate) => candidate.runId === runId);
  if (review?.kind !== 'human-wait') throw new Error('expected a human wait');
  return review;
}

/** B's derived review of a run A holds, once the park has committed. */
async function peerReview(
  bureau: Bureau<AgentDefinitions>,
  runId: string,
): Promise<PendingHumanWaitReview> {
  let found: PendingHumanWaitReview | undefined;
  await pollUntil(async () => {
    [found] = await bureau.pendingHumanWaitsOfRun(runId);
    return found !== undefined;
  });
  return found!;
}

/** Two processes, B opened first, and one `bureau.run()` run parked in A. */
async function parkedInA(parks = 1) {
  const seenByA: Seen = { resumed: [] };
  const b = await open({ resumed: [] }, parks);
  const a = await open(seenByA, parks);
  const run = a.bureau.run('asker', 'deploy', { principal: OWNER });
  const review = await localReview(a.bureau, run.id);
  await peerReview(b.bureau, run.id);
  return { a, b, run, review, seenByA };
}

async function callAs(
  key: string,
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: unknown,
) {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; data?: { httpStatus?: number } };
  };
}

function conflictCode(reason: unknown): string | undefined {
  return reason instanceof BureauError ? reason.code : undefined;
}

describe('the park of a bureau.run() run another process holds (COR-1579)', () => {
  it("lists, reads and resolves a peer's parked catalog run through bureau.reviews", async () => {
    const { a, b, run, review, seenByA } = await parkedInA();
    // The HTTP resolve carries no payload; B's adapter supplies one, so A's resumed step shows
    // the decision B delivered.
    const host = {
      ...b.bureau,
      resolveReview: (input: ResolveReviewInput) =>
        b.bureau.resolveReview({ ...input, payload: { environment: 'from-b' } }),
    };
    const handler = createBureauHandler(host, { authentication });

    const listed = await callAs(OWNER_KEY, handler, 'bureau.reviews.list', {});
    const fetched = await callAs(OWNER_KEY, handler, 'bureau.reviews.get', { id: review.id });
    const resolved = await callAs(OWNER_KEY, handler, 'bureau.reviews.resolve', {
      id: review.id,
      decision: 'approve',
    });

    const listedReviews = (listed.result?.['reviews'] ?? []) as Array<{ id: string }>;
    expect(listedReviews.map(({ id }) => id)).toEqual([review.id]);
    expect(fetched.result).toMatchObject({ id: review.id, status: 'pending' });
    expect(resolved.result).toMatchObject({
      id: review.id,
      kind: 'human-wait',
      decision: 'approve',
      receipt: 'applied',
    });
    await pollUntil(() => seenByA.resumed.length > 0);
    expect(seenByA.resumed[0]).toContain('from-b');
    const result = await run.result();
    expect(result.finishReason).not.toBe('error');
    expect(a.bureau.listPendingReviews()).toEqual([]);
  });

  it("hides a peer's parked catalog run from a stranger", async () => {
    const { a, b, run, review, seenByA } = await parkedInA();
    const handler = createBureauHandler(b.bureau, { authentication });

    const listed = await callAs(STRANGER_KEY, handler, 'bureau.reviews.list', {});
    const fetched = await callAs(STRANGER_KEY, handler, 'bureau.reviews.get', { id: review.id });
    const resolved = await callAs(STRANGER_KEY, handler, 'bureau.reviews.resolve', {
      id: review.id,
      decision: 'approve',
    });

    expect(listed.result).toEqual({ reviews: [] });
    expect(fetched.error?.data?.httpStatus).toBe(404);
    expect(resolved.error?.data?.httpStatus).toBe(404);
    // Nothing was delivered: no claim, no buffered signal, and the run is still parked.
    expect(await b.real.get(reviewDecisionKey(review.id, 0))).toBeNull();
    expect(await bufferedSignals(b.real, run.id)).toEqual([]);
    const stillPending = await b.bureau.pendingHumanWaitsOfRun(run.id);
    expect(stillPending.map(({ id }) => id)).toEqual([review.id]);
    expect(a.bureau.listPendingReviews().map(({ id }) => id)).toEqual([review.id]);
    expect(seenByA.resumed).toEqual([]);
  });

  it("names the owner of a peer's catalog run", async () => {
    const { a, b, run } = await parkedInA();

    expect(await b.bureau.getOwner({ kind: 'run', id: run.id })).toBe(OWNER);
    expect(await b.bureau.getOwner({ kind: 'run', id: run.id })).toBe(
      await a.bureau.getOwner({ kind: 'run', id: run.id }),
    );
  });

  it('lets one of two racing resolvers decide a catalog park, and tells the other CONFLICT', async () => {
    const { a, b, run, review, seenByA } = await parkedInA();
    // Each resolver is held after it has read the engine's `waitingForSignals`, at its read of
    // the decision record, so both have found the park pending before either claims it.
    const heldA = a.seam.holdRead(readsDecisionRecord);
    const heldB = b.seam.holdRead(readsDecisionRecord);
    const fromA = a.bureau.resolveReview({
      id: review.id,
      decision: 'approve',
      principal: OWNER,
      payload: { environment: 'from-a' },
    });
    const fromB = b.bureau.resolveReview({
      id: review.id,
      decision: 'deny',
      principal: OWNER,
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
    expect(conflictCode((rejected[0] as PromiseRejectedResult).reason)).toBe('CONFLICT');
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ decision: string }>).value.decision;

    await pollUntil(() => seenByA.resumed.length > 0);
    expect(seenByA.resumed[0]).toContain(winner === 'approve' ? 'from-a' : '__abDenied');
    await run.result();
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(1);
  });

  it('answers both racing resolvers of a catalog park that decide the same thing', async () => {
    const { a, b, run, review, seenByA } = await parkedInA(2);
    const decision = {
      id: review.id,
      decision: 'approve',
      principal: OWNER,
      reason: 'go',
      payload: { environment: 'staging' },
    } as const;
    const heldA = a.seam.holdRead(readsDecisionRecord);
    const heldB = b.seam.holdRead(readsDecisionRecord);
    const fromA = a.bureau.resolveReview(decision);
    const fromB = b.bureau.resolveReview(decision);
    await Promise.all([heldA.reached, heldB.reached]);
    heldA.release();
    heldB.release();

    expect(await fromA).toMatchObject({ id: review.id, decision: 'approve' });
    expect(await fromB).toMatchObject({ id: review.id, decision: 'approve' });
    // Delivered once: the run resumed once, parked again on the same signal, and nothing is left
    // buffered to answer that second park.
    const second = `human-wait:${run.id}:answer:1`;
    await pollUntil(() => a.bureau.listPendingReviews().some(({ id }) => id === second));
    expect(seenByA.resumed).toHaveLength(1);
    expect(seenByA.resumed[0]).toContain('staging');
    expect(await bufferedSignals(a.real, run.id)).toEqual([]);
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(1);
  });

  it("keeps a catalog park's claim when delivery throws, and delivers once on a same-decision retry", async () => {
    const { a, b, run, review, seenByA } = await parkedInA(2);
    const decision = {
      id: review.id,
      decision: 'approve',
      principal: OWNER,
      payload: { environment: 'production' },
    } as const;
    const failing = a.seam.failWrites(buffersSignal, new Error('the signal write was lost'));
    const failed = await rejectionOf(a.bureau.resolveReview(decision));
    failing.stop();

    expect((failed as Error).message).toContain('the signal write was lost');
    const claim = await a.real.get(reviewDecisionKey(review.id, 0));
    expect(claim).not.toBeNull();
    expect(JSON.parse(new TextDecoder().decode(claim!))).toMatchObject({
      decision: 'approve',
      principal: OWNER,
      recorded: false,
    });
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(0);

    const different = await rejectionOf(
      b.bureau.resolveReview({ id: review.id, decision: 'deny', principal: OWNER }),
    );
    expect(conflictCode(different)).toBe('CONFLICT');

    expect(await b.bureau.resolveReview(decision)).toMatchObject({
      id: review.id,
      decision: 'approve',
    });
    const second = `human-wait:${run.id}:answer:1`;
    await pollUntil(() => a.bureau.listPendingReviews().some(({ id }) => id === second));
    expect(seenByA.resumed).toHaveLength(1);
    expect(seenByA.resumed[0]).toContain('production');
    expect(await bufferedSignals(a.real, run.id)).toEqual([]);
    // One entry, written by B, the re-driver: A wrote none when its delivery threw.
    expect(await reviewAuditEntries(a.bureau, run.id, review.id)).toHaveLength(1);
  });
});
