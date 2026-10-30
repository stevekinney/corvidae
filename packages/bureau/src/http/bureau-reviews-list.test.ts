/**
 * COR-1828 — `bureau.reviews.list` as one inbox: pending or resolved, Bureau and engine items in one
 * ordered list across pages, a page token bound to its filters, engine items only for a caller who
 * holds `reviews:read`, resolved records visible to their owner, and `remember` on `resolve`.
 */
import {
  createOperationHandler,
  createOperationHandlerAuthenticator,
  principalFromApiKey,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import type { PendingReview, ResolvedReview, ResolveReviewInput } from '../types.ts';
import {
  type BureauReviewsOperationHost,
  bureauReviewsOperations,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { mayAccessOwnedResource } from './owner-predicate.ts';

const OWNER_KEY = 'owner-key';
const OTHER_KEY = 'other-key';
const READER_KEY = 'reader-key';
const OPERATOR_KEY = 'operator-key';
const KEYS = {
  [OWNER_KEY]: { subject: 'tester', scopes: [] as string[] },
  [OTHER_KEY]: { subject: 'stranger', scopes: [] as string[] },
  // The engine's scope alone: it reads the engine's reviews and none of the Bureau's of others.
  [READER_KEY]: { subject: 'tester', scopes: ['reviews:read'] },
  [OPERATOR_KEY]: { subject: 'ops', scopes: ['bureau.reviews:read', 'reviews:read'] },
} as const;

const authenticate = createOperationHandlerAuthenticator(
  {
    resolveApiKeyPrincipal: async (key: string) => {
      const held = Object.hasOwn(KEYS, key) ? KEYS[key as keyof typeof KEYS] : undefined;
      return held === undefined
        ? null
        : principalFromApiKey({ subject: held.subject, scopes: held.scopes as never });
    },
    auditSink: () => undefined,
  },
  { additionalScopes: BUREAU_SCOPES },
);

async function call(
  host: BureauReviewsOperationHost,
  key: string,
  method: string,
  params: unknown,
) {
  const handler = createOperationHandler({
    operations: bureauReviewsOperations,
    host,
    authenticate,
  });
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': key },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as {
    result?: {
      reviews: Array<{
        source: string;
        id: string;
        status: string;
        kind: string;
        requestedAt: number;
        resolution?: Record<string, unknown>;
      }>;
      nextPageToken: string | null;
    };
    error?: {
      data?: { httpStatus?: number; issues?: Array<{ path: string[]; code: string }> };
    };
  };
}

function pendingApproval(id: string, requestedAt: number, runId = 'run-1'): PendingReview {
  return {
    kind: 'tool-approval',
    id,
    runId,
    sessionId: 'session-1',
    agentName: 'writer',
    approval: {
      callId: id,
      toolName: 'send-email',
      arguments: {},
      action: { type: 'input' },
      approvalToken: 'signed-token',
    },
    requestedAt,
    ageMilliseconds: 5,
    status: 'pending',
    round: 0,
  } as unknown as PendingReview;
}

function resolvedRecord(
  id: string,
  decidedAt: number,
  owner: string,
  overrides: Partial<ResolvedReview> = {},
): ResolvedReview {
  return {
    review: { ...pendingApproval(id, decidedAt - 100), status: 'approved' },
    decision: 'approve',
    decidedBy: 'api-key:bob',
    decidedAt,
    owner,
    ...overrides,
  };
}

type EngineEntry =
  | {
      status: 'pending';
      reviewId: string;
      workflowId: string;
      artifact: unknown;
      reviewType: string;
      reviewers: string[];
      allowPartial: boolean;
      createdAt: number;
    }
  | {
      status: 'completed';
      reviewId: string;
      workflowId: string;
      artifact: unknown;
      reviewType: string;
      reviewers: string[];
      allowPartial: boolean;
      createdAt: number;
      decision: 'approved' | 'rejected' | 'needs-changes';
      reviewer: string;
      feedback?: string;
      timestamp: number;
    };

function engineReview(id: string, createdAt: number, completedAt?: number): EngineEntry {
  const base = {
    reviewId: id,
    workflowId: `wf-${id}`,
    artifact: { text: 'draft' },
    reviewType: 'content',
    reviewers: ['alice'],
    allowPartial: false,
    createdAt,
  };
  return completedAt === undefined
    ? { ...base, status: 'pending' }
    : {
        ...base,
        status: 'completed',
        decision: 'needs-changes',
        reviewer: 'alice',
        feedback: 'Tighten it',
        timestamp: completedAt,
      };
}

function hostOf(options: {
  pending?: PendingReview[];
  resolved?: ResolvedReview[];
  engine?: EngineEntry[];
  record?: ResolveReviewInput[];
}): BureauReviewsOperationHost {
  const engine = {
    listReviews: async (filter: { status?: 'pending' | 'completed' }) =>
      (options.engine ?? []).filter((entry) => entry.status === (filter.status ?? 'pending')),
  };
  return {
    reviews: {
      list: () => options.pending ?? [],
      get: async () => undefined,
      resolve: async (input) => {
        options.record?.push(input);
        return { id: input.id, kind: 'tool-approval', decision: input.decision };
      },
      listResolved: async (filter) =>
        (options.resolved ?? []).filter(
          (record) =>
            filter?.resolvedAfter === undefined || record.decidedAt >= filter.resolvedAfter,
        ),
      durableEngine: () => engine as never,
    },
    ownership: {
      runOwner: async () => 'api-key:tester',
      mayAccess: mayAccessOwnedResource,
    },
  };
}

const ids = (body: Awaited<ReturnType<typeof call>>) =>
  body.result?.reviews.map((review) => `${review.source}:${review.id}`);

describe('bureau.reviews.list as one inbox (COR-1828)', () => {
  it('lists pending Bureau and engine reviews oldest request first, across pages', async () => {
    const host = hostOf({
      pending: [pendingApproval('approval:b', 200), pendingApproval('approval:d', 400)],
      engine: [engineReview('e-a', 100), engineReview('e-c', 300), engineReview('e-e', 500)],
    });

    const first = await call(host, READER_KEY, 'bureau.reviews.list', { limit: 2 });
    expect(ids(first)).toEqual(['engine:e-a', 'bureau:approval:b']);
    expect(first.result?.nextPageToken).toEqual(expect.any(String));
    const second = await call(host, READER_KEY, 'bureau.reviews.list', {
      limit: 2,
      pageToken: first.result?.nextPageToken,
    });
    expect(ids(second)).toEqual(['engine:e-c', 'bureau:approval:d']);
    const third = await call(host, READER_KEY, 'bureau.reviews.list', {
      limit: 2,
      pageToken: second.result?.nextPageToken,
    });
    expect(ids(third)).toEqual(['engine:e-e']);
    expect(third.result?.nextPageToken).toBeNull();
    // The whole list in one page is the same order.
    const whole = await call(host, READER_KEY, 'bureau.reviews.list', {});
    expect(ids(whole)).toEqual([
      'engine:e-a',
      'bureau:approval:b',
      'engine:e-c',
      'bureau:approval:d',
      'engine:e-e',
    ]);
    expect(whole.result?.reviews.map((review) => review.requestedAt)).toEqual([
      100, 200, 300, 400, 500,
    ]);
  });

  it('breaks a tie on source, Bureau first, then on id', async () => {
    const host = hostOf({
      pending: [pendingApproval('approval:z', 100), pendingApproval('approval:a', 100)],
      engine: [engineReview('e-1', 100)],
    });

    const body = await call(host, READER_KEY, 'bureau.reviews.list', { limit: 1 });
    expect(ids(body)).toEqual(['bureau:approval:a']);
    const next = await call(host, READER_KEY, 'bureau.reviews.list', {
      limit: 1,
      pageToken: body.result?.nextPageToken,
    });
    expect(ids(next)).toEqual(['bureau:approval:z']);
    const last = await call(host, READER_KEY, 'bureau.reviews.list', {
      limit: 1,
      pageToken: next.result?.nextPageToken,
    });
    expect(ids(last)).toEqual(['engine:e-1']);
  });

  it('lists resolved reviews latest decision first, from both sources, across pages', async () => {
    const host = hostOf({
      resolved: [
        resolvedRecord('approval:old', 1_000, 'api-key:tester'),
        resolvedRecord('approval:new', 3_000, 'api-key:tester'),
      ],
      engine: [engineReview('e-done', 100, 2_000)],
    });

    const first = await call(host, READER_KEY, 'bureau.reviews.list', {
      status: 'resolved',
      limit: 2,
    });
    expect(ids(first)).toEqual(['bureau:approval:new', 'engine:e-done']);
    expect(first.result?.reviews[1]).toMatchObject({
      status: 'completed',
      resolution: {
        decision: 'needs-changes',
        decidedBy: 'alice',
        decidedAt: 2_000,
        reason: 'Tighten it',
      },
    });
    expect(first.result?.reviews[0]).toMatchObject({
      status: 'approved',
      resolution: { decision: 'approve', decidedBy: 'api-key:bob', decidedAt: 3_000 },
    });
    const second = await call(host, READER_KEY, 'bureau.reviews.list', {
      status: 'resolved',
      limit: 2,
      pageToken: first.result?.nextPageToken,
    });
    expect(ids(second)).toEqual(['bureau:approval:old']);
    expect(second.result?.nextPageToken).toBeNull();
  });

  it('keeps only the reviews decided at or after resolvedAfter, from both sources', async () => {
    const host = hostOf({
      resolved: [
        resolvedRecord('approval:old', 1_000, 'api-key:tester'),
        resolvedRecord('approval:new', 3_000, 'api-key:tester'),
      ],
      engine: [engineReview('e-old', 50, 900), engineReview('e-new', 60, 2_000)],
    });

    const body = await call(host, READER_KEY, 'bureau.reviews.list', {
      status: 'resolved',
      resolvedAfter: 2_000,
    });

    expect(ids(body)).toEqual(['bureau:approval:new', 'engine:e-new']);
  });

  it('rejects resolvedAfter on a pending list', async () => {
    const body = await call(hostOf({}), OWNER_KEY, 'bureau.reviews.list', { resolvedAfter: 5 });

    expect(body.error?.data?.httpStatus).toBe(400);
  });

  it('refuses a page token under other filters, and a token that is not ours', async () => {
    const host = hostOf({
      pending: [pendingApproval('approval:a', 100), pendingApproval('approval:b', 200)],
      resolved: [resolvedRecord('approval:r', 1_000, 'api-key:tester')],
    });
    const first = await call(host, OWNER_KEY, 'bureau.reviews.list', { limit: 1 });
    const token = first.result?.nextPageToken;
    expect(token).toEqual(expect.any(String));

    for (const params of [
      { status: 'resolved', pageToken: token },
      { status: 'resolved', resolvedAfter: 1, pageToken: token },
    ]) {
      const body = await call(host, OWNER_KEY, 'bureau.reviews.list', params);
      expect(body.error?.data?.httpStatus).toBe(400);
      expect(body.error?.data?.issues?.[0]).toMatchObject({
        path: ['pageToken'],
        code: 'page-token-filters-changed',
      });
    }
    const forged = await call(host, OWNER_KEY, 'bureau.reviews.list', { pageToken: 'not-a-token' });
    expect(forged.error?.data?.issues?.[0]).toMatchObject({
      path: ['pageToken'],
      code: 'page-token-malformed',
    });
    // The same filters continue.
    const again = await call(host, OWNER_KEY, 'bureau.reviews.list', { pageToken: token });
    expect(ids(again)).toEqual(['bureau:approval:b']);
  });

  it('shows engine reviews only to a caller who holds reviews:read', async () => {
    const host = hostOf({
      pending: [pendingApproval('approval:a', 100)],
      resolved: [resolvedRecord('approval:r', 1_000, 'api-key:tester')],
      engine: [engineReview('e-pending', 50), engineReview('e-done', 60, 2_000)],
    });

    for (const status of ['pending', 'resolved'] as const) {
      const without = await call(host, OWNER_KEY, 'bureau.reviews.list', { status });
      expect(without.result?.reviews.every((review) => review.source === 'bureau')).toBe(true);
      const withScope = await call(host, READER_KEY, 'bureau.reviews.list', { status });
      expect(withScope.result?.reviews.some((review) => review.source === 'engine')).toBe(true);
    }
  });

  it('shows a resolved record to its owner and an operator, and to no other caller', async () => {
    const host = hostOf({
      resolved: [
        resolvedRecord('approval:mine', 3_000, 'api-key:tester'),
        resolvedRecord('approval:theirs', 2_000, 'api-key:someone-else'),
        resolvedRecord('approval:unowned', 1_000, 'anonymous:local'),
      ],
    });

    expect(ids(await call(host, OWNER_KEY, 'bureau.reviews.list', { status: 'resolved' }))).toEqual(
      ['bureau:approval:mine'],
    );
    expect(ids(await call(host, OTHER_KEY, 'bureau.reviews.list', { status: 'resolved' }))).toEqual(
      [],
    );
    expect(
      ids(await call(host, OPERATOR_KEY, 'bureau.reviews.list', { status: 'resolved' })),
    ).toEqual(['bureau:approval:mine', 'bureau:approval:theirs', 'bureau:approval:unowned']);
  });

  it('projects a resolved record without a tool approval’s token, and with the wait the decision took', async () => {
    const host = hostOf({ resolved: [resolvedRecord('approval:mine', 3_000, 'api-key:tester')] });

    const body = await call(host, OWNER_KEY, 'bureau.reviews.list', { status: 'resolved' });

    expect(JSON.stringify(body)).not.toContain('signed-token');
    expect(body.result?.reviews[0]).toMatchObject({ ageMilliseconds: 100 });
  });

  it('lists a resolved human wait with the digest and references of its answer, never a value', async () => {
    const wait: ResolvedReview = {
      review: {
        kind: 'human-wait',
        id: 'human-wait:run-1:answer:0',
        runId: 'run-1',
        sessionId: 'session-1',
        agentName: 'asker',
        signalName: 'answer',
        prompt: 'Credentials?',
        requestedAt: 10,
        ageMilliseconds: 0,
        status: 'approved',
      },
      decision: 'approve',
      decidedBy: 'api-key:bob',
      decidedAt: 500,
      owner: 'api-key:tester',
      answerDigest: 'a'.repeat(64),
      secretRefs: ['human-wait:run-1:answer:0/password'],
    };

    const body = await call(hostOf({ resolved: [wait] }), OWNER_KEY, 'bureau.reviews.list', {
      status: 'resolved',
    });

    expect(body.result?.reviews[0]).toMatchObject({
      kind: 'human-wait',
      resolution: {
        decision: 'approve',
        answerDigest: 'a'.repeat(64),
        secretRefs: ['human-wait:run-1:answer:0/password'],
      },
    });
  });
});

describe('bureau.reviews.resolve with remember (COR-1828)', () => {
  it('passes remember to the Bureau for an approval, and refuses it on any other decision', async () => {
    const record: ResolveReviewInput[] = [];
    const host: BureauReviewsOperationHost = {
      ...hostOf({ record }),
      reviews: {
        ...hostOf({ record }).reviews,
        get: async (id) =>
          id === 'approval:run-1:call-1'
            ? pendingApproval(id, 1)
            : {
                kind: 'human-wait',
                id,
                runId: 'run-1',
                agentName: undefined,
                signalName: 'answer',
                prompt: undefined,
                requestedAt: 1,
                ageMilliseconds: 0,
                status: 'pending',
              },
      },
    };
    const resolve = (params: unknown) => call(host, OWNER_KEY, 'bureau.reviews.resolve', params);

    await resolve({ id: 'approval:run-1:call-1', decision: 'approve', remember: true });
    expect(record.at(-1)).toMatchObject({ decision: 'approve', remember: true });

    const denied = await resolve({ id: 'approval:run-1:call-1', decision: 'deny', remember: true });
    expect(denied.error?.data?.httpStatus).toBe(400);
    const human = await resolve({
      id: 'human-wait:run-1:answer:0',
      decision: 'approve',
      remember: true,
    });
    expect(human.error?.data?.httpStatus).toBe(422);
    expect(record).toHaveLength(1);
  });
});
