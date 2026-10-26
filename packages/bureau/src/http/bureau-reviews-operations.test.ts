import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import {
  createOperationHandler,
  createOperationHandlerAuthenticator,
  principalFromApiKey,
  principalFromJwtClaims,
} from '@lostgradient/weft';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  ApprovalOutcomeNotWrittenError,
  BureauError,
  createBureau,
  ReviewRoundChangedError,
} from '../create-bureau.ts';
import { waitForCondition } from '../test';
import type { Bureau, PendingReview, ResolveReviewInput, ReviewStatus } from '../types.ts';
import {
  type BureauReviewsOperationHost,
  bureauReviewSchema,
  bureauReviewsOperations,
  projectReview,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { mayAccessOwnedResource, ownerOfPrincipal } from './owner-predicate.ts';
import { createMemoryAssetStorage } from '../assets/storage';
import type { AgentDefinitions } from '../agent-catalog';

const silent = () => undefined;
const API_KEY = 'reviews-test-key';
const credentials = { 'X-API-Key': API_KEY };
/** One caller, `tester`, who owns what the stubbed reviews' run belongs to. */
const authentication = {
  resolveApiKeyPrincipal: async (key: string) =>
    key === API_KEY ? principalFromApiKey({ subject: 'tester', scopes: [] }) : null,
  auditSink: silent,
};

async function call(
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: unknown,
) {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...credentials },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; data?: { httpStatus?: number; weftCode?: string } };
  };
}

function toolApprovalReview(overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    kind: 'tool-approval',
    id: 'approval:run-1:call-1',
    runId: 'run-1',
    sessionId: 'session-1',
    agentName: 'writer',
    approval: {
      callId: 'call-1',
      toolName: 'send-email',
      arguments: { to: 'someone@example.test' },
      action: { type: 'input', message: 'Confirm the recipient' },
      reason: 'sends mail',
      policyPauseTier: 'tool',
      approvalToken: 'secret-signed-token',
      approvalBinding: { secret: 'binding' } as never,
      metadata: { internal: true } as never,
    },
    requestedAt: 1_000,
    ageMilliseconds: 50,
    status: 'pending',
    round: 0,
    ...overrides,
  } as PendingReview;
}

function stubHost(
  overrides: Partial<BureauReviewsOperationHost['reviews']> = {},
  record: ResolveReviewInput[] = [],
) {
  const ownership: BureauReviewsOperationHost['ownership'] = {
    runOwner: async (runId) => (runId === 'run-1' ? 'api-key:tester' : undefined),
    mayAccess: mayAccessOwnedResource,
  };
  const reviews: BureauReviewsOperationHost['reviews'] = {
    listPendingReviews: () => [toolApprovalReview()],
    getReview: async (id) =>
      id === 'approval:run-1:call-1'
        ? { ...toolApprovalReview(), status: 'approved' as ReviewStatus }
        : undefined,
    resolveReview: async (input) => {
      record.push(input);
      return { id: input.id, kind: 'tool-approval', decision: input.decision };
    },
    ...overrides,
  };
  return { reviews, ownership };
}

function serve(
  host: BureauReviewsOperationHost,
  authenticate = createOperationHandlerAuthenticator(authentication, {
    additionalScopes: BUREAU_SCOPES,
  }),
) {
  return createOperationHandler({ operations: bureauReviewsOperations, host, authenticate });
}

function runHumanWaitReview(overrides: Partial<PendingReview> = {}): PendingReview {
  return {
    kind: 'human-wait',
    id: 'human-wait:run-2:answer:0',
    runId: 'run-2',
    agentName: 'asker',
    signalName: 'answer',
    prompt: 'Which environment?',
    requestedAt: 2_000,
    ageMilliseconds: 10,
    status: 'pending',
    ...overrides,
  } as PendingReview;
}

describe('the parks of runs another process holds (COR-1579)', () => {
  it('lists every page of running agent runs, by what each page reports, with the local entry winning', async () => {
    const runIds = ['run-1', 'run-2', 'run-3'];
    const offsets: Array<number | undefined> = [];
    // An engine that caps every page at one run, whatever limit it is asked for.
    const engine = {
      list: async (filter: { offset?: number }) => {
        offsets.push(filter.offset);
        const offset = filter.offset ?? 0;
        return {
          items: runIds.slice(offset, offset + 1).map((id) => ({ id })),
          total: runIds.length,
          offset,
          limit: 1,
        };
      },
    };
    const local = runHumanWaitReview({ id: 'human-wait:run-1:answer:0', runId: 'run-1' });
    const { reviews } = stubHost({
      listPendingReviews: () => [local],
      pendingHumanWaitsOfRun: async (runId: string) => [
        {
          ...(runHumanWaitReview({ id: `human-wait:${runId}:answer:0`, runId }) as Extract<
            PendingReview,
            { kind: 'human-wait' }
          >),
          prompt: 'derived',
        },
      ],
      durableEngine: () => engine as unknown as ReturnType<Bureau['durableEngine']>,
    });
    const host = {
      reviews,
      ownership: { runOwner: async () => 'api-key:tester', mayAccess: mayAccessOwnedResource },
    };

    const body = await call(serve(host), 'bureau.reviews.list', {});

    const listed = (body.result?.['reviews'] ?? []) as Array<{ id: string; prompt?: string }>;
    expect(listed.map(({ id }) => id)).toEqual([
      'human-wait:run-1:answer:0',
      'human-wait:run-2:answer:0',
      'human-wait:run-3:answer:0',
    ]);
    expect(listed[0]?.prompt).toBe('Which environment?');
    expect(offsets).toEqual([0, 1, 2]);
  });
});

describe('a human wait of a run with no session (COR-1577)', () => {
  it('projects without a sessionId key, and a session’s human wait keeps its sessionId', () => {
    const run = projectReview({ ...runHumanWaitReview(), status: 'pending' });
    const session = projectReview({
      ...runHumanWaitReview({ sessionId: 'session-1' }),
      status: 'pending',
    });

    expect('sessionId' in run).toBe(false);
    expect(run).toMatchObject({ kind: 'human-wait', runId: 'run-2', signalName: 'answer' });
    expect(session).toMatchObject({ kind: 'human-wait', sessionId: 'session-1' });
  });

  it('is listed to the run’s owner, hidden from another caller, and open to an operator', async () => {
    const owned = {
      reviews: stubHost({ listPendingReviews: () => [runHumanWaitReview()] }).reviews,
      ownership: {
        runOwner: async (runId: string) => (runId === 'run-2' ? 'api-key:other' : undefined),
        mayAccess: mayAccessOwnedResource,
      },
    };
    const operator = createOperationHandlerAuthenticator(
      {
        ...authentication,
        resolveApiKeyPrincipal: async (key: string) =>
          key === API_KEY
            ? principalFromApiKey({ subject: 'tester', scopes: ['bureau.reviews:read'] })
            : null,
      },
      { additionalScopes: BUREAU_SCOPES },
    );

    const hidden = await call(serve(owned), 'bureau.reviews.list', {});
    const visible = await call(serve(owned, operator), 'bureau.reviews.list', {});

    expect(hidden.result).toEqual({ reviews: [] });
    expect(visible.result).toMatchObject({ reviews: [{ id: 'human-wait:run-2:answer:0' }] });
  });
});

describe('bureau.reviews.list', () => {
  it('returns the pending reviews without the approval token, binding, or metadata', async () => {
    const handler = serve(stubHost());

    const body = await call(handler, 'bureau.reviews.list', {});

    expect(body.result).toEqual({
      reviews: [
        {
          id: 'approval:run-1:call-1',
          kind: 'tool-approval',
          runId: 'run-1',
          sessionId: 'session-1',
          agentName: 'writer',
          requestedAt: 1_000,
          ageMilliseconds: 50,
          status: 'pending',
          round: 0,
          approval: {
            callId: 'call-1',
            toolName: 'send-email',
            arguments: { to: 'someone@example.test' },
            reason: 'sends mail',
            action: { type: 'input', message: 'Confirm the recipient' },
            policyPauseTier: 'tool',
          },
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain('secret-signed-token');
  });

  it('rejects any input key', async () => {
    const body = await call(serve(stubHost()), 'bureau.reviews.list', { status: 'approved' });

    expect(body.error?.data?.httpStatus).toBe(400);
  });
});

const SECRET = 'sentinel-secret-value-1f3a';

function approvalActionReview(
  operation: Record<string, unknown>,
  status: ReviewStatus = 'pending',
): PendingReview {
  const base = toolApprovalReview();
  if (base.kind !== 'tool-approval') throw new Error('expected a tool approval');
  return {
    ...base,
    status,
    approval: {
      ...base.approval,
      action: {
        type: 'approval',
        message: 'Run the deploy script',
        risk: 'high',
        operation,
        sandbox: { provider: 'docker', name: `box-${SECRET}`, workingDir: '/srv/work' },
        env: [`DEPLOY_TOKEN=${SECRET}`],
        snapshotId: 'snapshot-secret-id',
        expiresAt: '2030-01-01T00:00:00.000Z',
        editableArgs: true,
        policyVersion: 'policy-version-secret',
        idempotencyKey: 'idempotency-key-secret',
      },
    },
  } as PendingReview;
}

describe('the tool-approval action projection', () => {
  const internalFields = [
    SECRET,
    'DEPLOY_TOKEN',
    'env',
    'snapshotId',
    'snapshot-secret-id',
    'policyVersion',
    'policy-version-secret',
    'idempotencyKey',
    'idempotency-key-secret',
    'sandbox',
    'workingDir',
    'editableArgs',
    'argsPreview',
  ];

  it('keeps env, idempotency key, snapshot id, policy version, and sandbox off list and get', async () => {
    const review = approvalActionReview({
      kind: 'command',
      command: 'deploy --prod',
      filesTouched: ['a.txt'],
      argsPreview: { token: SECRET },
    });
    const handler = serve(
      stubHost({
        listPendingReviews: () => [review],
        getReview: async () => ({ ...review, status: 'pending' as ReviewStatus }),
      }),
    );

    const listed = await call(handler, 'bureau.reviews.list', {});
    const fetched = await call(handler, 'bureau.reviews.get', { id: review.id });

    for (const body of [listed, fetched]) {
      const text = JSON.stringify(body);
      for (const field of internalFields) expect(text).not.toContain(field);
    }
    expect(fetched.result?.['approval']).toMatchObject({
      action: {
        type: 'approval',
        message: 'Run the deploy script',
        risk: 'high',
        expiresAt: '2030-01-01T00:00:00.000Z',
        operation: { kind: 'command', command: 'deploy --prod', filesTouched: ['a.txt'] },
      },
    });
  });

  it('exposes what each operation kind does and to what', () => {
    const project = (operation: Record<string, unknown>) => {
      const projected = projectReview({ ...approvalActionReview(operation), status: 'pending' });
      if (projected.kind !== 'tool-approval') throw new Error('expected a tool approval');
      const { action } = projected.approval;
      return action.type === 'approval' ? action.operation : undefined;
    };

    expect(project({ kind: 'file-write', filesTouched: ['b.txt'], argsPreview: 1 })).toEqual({
      kind: 'file-write',
      filesTouched: ['b.txt'],
    });
    expect(project({ kind: 'patch', diff: '--- a\n+++ b', filesTouched: ['c.txt'] })).toEqual({
      kind: 'patch',
      diff: '--- a\n+++ b',
      filesTouched: ['c.txt'],
    });
    expect(project({ kind: 'other' })).toEqual({ kind: 'other' });
  });
});

describe('bureau.reviews.get', () => {
  it('returns one review by id, including a resolved one', async () => {
    const body = await call(serve(stubHost()), 'bureau.reviews.get', {
      id: 'approval:run-1:call-1',
    });

    expect(body.result).toMatchObject({ id: 'approval:run-1:call-1', status: 'approved' });
  });

  it('answers NotFound for an id that matches nothing', async () => {
    const body = await call(serve(stubHost()), 'bureau.reviews.get', { id: 'missing' });

    expect(body.error?.data?.httpStatus).toBe(404);
  });
});

describe('bureau.reviews.resolve', () => {
  it('fills the principal from the authenticated API key in its namespaced form', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));

    const body = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
    });

    expect(body.result).toEqual({
      id: 'approval:run-1:call-1',
      kind: 'tool-approval',
      decision: 'approve',
      receipt: 'applied',
    });
    expect(record).toEqual([
      { id: 'approval:run-1:call-1', decision: 'approve', principal: 'api-key:tester' },
    ]);
  });

  it('percent-encodes the subject a key resolver returns', async () => {
    const record: ResolveReviewInput[] = [];
    const authenticate = createOperationHandlerAuthenticator(
      {
        resolveApiKeyPrincipal: async () =>
          principalFromApiKey({ subject: 'ops user/1:a', scopes: ['bureau.reviews:resolve'] }),
        auditSink: silent,
      },
      { additionalScopes: BUREAU_SCOPES },
    );
    const handler = serve(stubHost({}, record), authenticate);

    await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'deny',
    });

    expect(record[0]?.principal).toBe('api-key:ops%20user%2F1%3Aa');
    expect(ownerOfPrincipal(principalFromApiKey({ subject: 'ops user/1:a', scopes: [] }))).toBe(
      'api-key:ops%20user%2F1%3Aa',
    );
  });

  it('rejects a principal in the payload', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));

    const body = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
      principal: 'api-key:somebody-else',
    });

    expect(body.error?.data?.httpStatus).toBe(400);
    expect(record).toEqual([]);
  });

  it('requires a reason to reject, and reports a landed reject as applied', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));

    const missing = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'reject',
      reason: '   ',
    });
    const given = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'reject',
      reason: 'not this one',
    });

    expect(missing.error?.data?.httpStatus).toBe(400);
    expect(given.result).toMatchObject({ decision: 'reject', receipt: 'applied' });
    expect(record).toHaveLength(1);
    expect(record[0]?.reason).toBe('not this one');
  });

  it('reports superseded when the approval was re-gated and the review stays pending', async () => {
    const handler = serve(
      stubHost({
        resolveReview: async (input) => ({
          id: input.id,
          kind: 'tool-approval',
          decision: input.decision,
          result: { outcome: 'action_required', pendingApproval: {} },
        }),
      }),
    );

    const body = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
    });

    expect(body.result).toMatchObject({ receipt: 'superseded' });
    expect(JSON.stringify(body.result)).not.toContain('pendingApproval');
  });

  it('maps a Bureau error onto the fault a client branches on', async () => {
    const failing = (error: BureauError) =>
      serve(
        stubHost({
          resolveReview: async () => {
            throw error;
          },
        }),
      );
    const input = { id: 'approval:run-1:call-1', decision: 'approve' };

    const notFound = await call(
      failing(new BureauError('No pending review', 'NOT_FOUND')),
      'bureau.reviews.resolve',
      input,
    );
    const conflict = await call(
      failing(new BureauError('already resolved', 'CONFLICT')),
      'bureau.reviews.resolve',
      input,
    );
    const unprocessable = await call(
      failing(new BureauError('bad', 'BAD_REQUEST')),
      'bureau.reviews.resolve',
      input,
    );

    expect(notFound.error?.data?.httpStatus).toBe(404);
    expect(conflict.error?.data?.httpStatus).toBe(409);
    expect(unprocessable.error?.data?.httpStatus).toBe(422);
  });

  it('tells a decision whose outcome was not written from a resolver that lost', async () => {
    const input = { id: 'approval:run-1:call-1', decision: 'approve' };
    const failing = (error: BureauError) =>
      serve(
        stubHost({
          resolveReview: async () => {
            throw error;
          },
        }),
      );

    const unwritten = await call(
      failing(new ApprovalOutcomeNotWrittenError('resolved, but not written')),
      'bureau.reviews.resolve',
      input,
    );
    const lost = await call(
      failing(new BureauError('already resolved', 'CONFLICT')),
      'bureau.reviews.resolve',
      input,
    );

    expect(unwritten.error?.data?.httpStatus).toBe(409);
    // The token is the start of the reason, and nothing else on the wire carries it.
    const reasonOf = (reply: typeof unwritten) =>
      (reply.error?.data as { reason?: string } | undefined)?.reason;
    expect(reasonOf(unwritten)?.startsWith('APPROVAL_OUTCOME_NOT_WRITTEN: ')).toBe(true);
    expect(reasonOf(lost)?.startsWith('APPROVAL_OUTCOME_NOT_WRITTEN')).toBe(false);
    expect(JSON.stringify(lost.error)).not.toContain('APPROVAL_OUTCOME_NOT_WRITTEN');
    expect(JSON.stringify(unwritten.error)).not.toContain('"code":"APPROVAL');
  });

  it('forwards the round the caller read to the Bureau, and omits it when none was named (COR-1659)', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));
    const id = 'approval:run-1:call-1';

    await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve', round: 2 });
    await call(handler, 'bureau.reviews.resolve', { id, decision: 'deny', round: 0 });
    await call(handler, 'bureau.reviews.resolve', { id, decision: 'deny' });

    expect(record).toEqual([
      { id, decision: 'approve', principal: 'api-key:tester', round: 2 },
      { id, decision: 'deny', principal: 'api-key:tester', round: 0 },
      { id, decision: 'deny', principal: 'api-key:tester' },
    ]);
  });

  it('refuses a round that is not a non-negative integer before the Bureau is reached (COR-1659)', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));

    for (const round of [-1, 1.5, '1']) {
      const body = await call(handler, 'bureau.reviews.resolve', {
        id: 'approval:run-1:call-1',
        decision: 'approve',
        round,
      });
      expect(body.error?.data?.httpStatus, String(round)).toBe(400);
    }
    expect(record).toEqual([]);
  });

  it('tells a review that moved to another round from a resolver that lost (COR-1659)', async () => {
    const input = { id: 'approval:run-1:call-1', decision: 'approve', round: 0 };
    const failing = (error: BureauError) =>
      serve(
        stubHost({
          resolveReview: async () => {
            throw error;
          },
        }),
      );
    const reasonOf = (reply: Awaited<ReturnType<typeof call>>) =>
      (reply.error?.data as { reason?: string } | undefined)?.reason;

    const moved = await call(
      failing(new ReviewRoundChangedError('now at round 1')),
      'bureau.reviews.resolve',
      input,
    );
    const lost = await call(
      failing(new BureauError('already resolved', 'CONFLICT')),
      'bureau.reviews.resolve',
      input,
    );

    expect(moved.error?.data?.httpStatus).toBe(409);
    expect(reasonOf(moved)?.startsWith('REVIEW_ROUND_CHANGED: ')).toBe(true);
    expect(reasonOf(lost)?.startsWith('REVIEW_ROUND_CHANGED')).toBe(false);
    expect(JSON.stringify(lost.error)).not.toContain('REVIEW_ROUND_CHANGED');
  });

  it('answers Forbidden to an authenticated caller it cannot attribute, even one that holds the scope', async () => {
    const record: ResolveReviewInput[] = [];
    const authenticate = async () => ({
      method: 'jwt' as const,
      principal: principalFromJwtClaims(
        { sub: 'someone', scope: 'bureau.reviews:resolve' },
        { additionalScopes: new Set(BUREAU_SCOPES) },
      ),
    });
    const handler = createOperationHandler({
      operations: bureauReviewsOperations,
      host: stubHost({}, record),
      authenticate,
    });

    const body = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
    });

    expect(body.error?.data?.httpStatus).toBe(403);
    expect(record).toEqual([]);
  });
});

describe('projectReview', () => {
  it('reads the round of a review rebuilt from an audit record that predates rounds as 0', () => {
    const { round: _round, ...recorded } = toolApprovalReview() as Extract<
      PendingReview,
      { kind: 'tool-approval' }
    >;

    const projected = projectReview({ ...recorded, status: 'approved' } as never);

    expect(projected).toMatchObject({ kind: 'tool-approval', round: 0 });
    expect(bureauReviewSchema.safeParse(projected).success).toBe(true);
  });

  it('carries the supersession round of a tool approval', () => {
    const projected = projectReview({
      ...(toolApprovalReview() as Extract<PendingReview, { kind: 'tool-approval' }>),
      round: 2,
      status: 'pending',
    });

    expect(projected).toMatchObject({ kind: 'tool-approval', round: 2 });
  });

  it('omits optional fields that are absent', () => {
    const projected = projectReview({
      kind: 'human-wait',
      id: 'human-wait:run-1:answer:0',
      runId: 'run-1',
      sessionId: 'session-1',
      agentName: undefined,
      signalName: 'answer',
      prompt: undefined,
      requestedAt: 1,
      ageMilliseconds: 2,
      status: 'pending',
    });

    expect(projected).toEqual({
      kind: 'human-wait',
      id: 'human-wait:run-1:answer:0',
      runId: 'run-1',
      sessionId: 'session-1',
      signalName: 'answer',
      requestedAt: 1,
      ageMilliseconds: 2,
      status: 'pending',
    });
  });
});

describe('the reviews operations against a real Bureau', () => {
  const emptyToolbox = () => createToolbox([]) as unknown as Toolbox;

  async function parkedBureau() {
    let calls = 0;
    const generate: GenerateFunction = async () => {
      calls++;
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              name: 'requestHumanInput',
              arguments: { signalName: 'human-response', prompt: 'Approve this?' },
            },
          ],
        };
      }
      return { content: 'approved and processed', toolCalls: [] };
    };
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'reviews-bureau',
      agents: {
        default: createAgent({
          generate,
          toolbox: emptyToolbox(),
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
      humanInput: true,
    });
    const run = await bureau.createRun({
      agentName: 'default',
      message: 'park-me',
      principal: 'api-key:tester',
    });
    await waitForCondition(
      () => bureau.listPendingReviews().some((review) => review.runId === run.id),
      'expected requestHumanInput to park and surface a pending review',
    );
    return { bureau, run };
  }

  it('lists, reads, and resolves a pending human-wait review through the handler', async () => {
    const { bureau, run } = await parkedBureau();
    try {
      const handler = createBureauHandler(bureau, { authentication });

      const listed = await call(handler, 'bureau.reviews.list', {});
      const [review] = (listed.result?.['reviews'] ?? []) as Array<Record<string, unknown>>;
      expect(review).toMatchObject({
        kind: 'human-wait',
        runId: run.id,
        signalName: 'human-response',
        prompt: 'Approve this?',
        status: 'pending',
      });
      const id = String(review?.['id']);

      const fetched = await call(handler, 'bureau.reviews.get', { id });
      expect(fetched.result).toMatchObject({ id, kind: 'human-wait', status: 'pending' });

      const resolved = await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve' });
      expect(resolved.result).toEqual({
        id,
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      });

      const after = await call(handler, 'bureau.reviews.list', {});
      expect(after.result).toEqual({ reviews: [] });
      const again = await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve' });
      expect(again.error?.data?.httpStatus).toBe(404);
      const resolvedReview = await call(handler, 'bureau.reviews.get', { id });
      expect(resolvedReview.result).toMatchObject({ id, status: 'approved' });
    } finally {
      await bureau.dispose();
    }
  });

  it('records the namespaced API-key principal in the audit trail and rejects with a reason', async () => {
    const { bureau } = await parkedBureau();
    try {
      const handler = createBureauHandler(bureau, { authentication });
      const listed = await call(handler, 'bureau.reviews.list', {});
      const [first] = (listed.result?.['reviews'] ?? []) as Array<{ id: string }>;
      const id = String(first?.id);

      const resolved = await call(handler, 'bureau.reviews.resolve', {
        id,
        decision: 'reject',
        reason: 'wrong task',
      });

      expect(resolved.result).toMatchObject({ decision: 'reject', receipt: 'applied' });
      const records = JSON.stringify(await bureau.auditTrail?.query({}));
      expect(records).toContain('api-key:tester');
    } finally {
      await bureau.dispose();
    }
  });

  it('writes the outcome of a tool approval resolved through the handler into the session', async () => {
    const charges: number[] = [];
    let generations = 0;
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'handler-approval-secret',
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
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'reviews-tool-approval-bureau',
      agents: {
        default: createAgent({
          generate: async () => {
            generations++;
            return generations === 1
              ? {
                  content: '',
                  toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
                }
              : { content: 'Charged.', toolCalls: [] };
          },
          toolbox,
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Charge it',
        principal: 'api-key:tester',
      });
      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected the tool call to surface a pending approval',
      );
      const handler = createBureauHandler(bureau, { authentication });
      const listed = await call(handler, 'bureau.reviews.list', {});
      const [review] = (listed.result?.['reviews'] ?? []) as Array<{ id: string; round: number }>;
      expect(review?.round).toBe(0);

      const resolved = await call(handler, 'bureau.reviews.resolve', {
        id: review?.id,
        decision: 'approve',
      });

      expect(resolved.result).toMatchObject({ decision: 'approve', receipt: 'applied' });
      const session = await bureau.getSession(run.sessionId);
      const history = session?.conversationHistory;
      const row = history?.ids
        .map((id) => history.messages[id])
        .find((message) => message?.toolResult?.callId === 'call-1');
      expect(row?.toolResult?.outcome).toBe('success');
      expect(row?.toolResult?.content).toEqual({ charged: 500 });
      expect(charges).toEqual([500]);
    } finally {
      await bureau.dispose();
    }
  });

  it('refuses a decision on a round the review has moved past, through the handler (COR-1659)', async () => {
    const charges: number[] = [];
    let generations = 0;
    let evaluations = 0;
    // A policy that gates the resumed call again, so an approval supersedes itself: round 0 to 1.
    const toolbox = createToolbox(
      [
        createTool({
          name: 'charge-card',
          version: '1.0.0',
          description: 'Charge a payment card',
          input: z.object({ cents: z.number() }),
          async execute({ cents }) {
            charges.push(cents);
            return { charged: cents };
          },
        }),
      ],
      {
        approvalSecret: 'handler-approval-secret',
        policy: {
          // The reason changes with each evaluation, so the approval it binds does not carry over.
          beforeExecute: () => {
            evaluations += 1;
            return {
              allow: false,
              status: 'needs_approval',
              reason: `Operator approval required (evaluation ${evaluations})`,
              action: { message: 'Approve charge' },
            };
          },
        },
      },
    ) as unknown as Toolbox;
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'reviews-round-fence-bureau',
      agents: {
        default: createAgent({
          generate: async () => {
            generations++;
            return generations === 1
              ? {
                  content: '',
                  toolCalls: [{ id: 'call-1', name: 'charge-card', arguments: { cents: 500 } }],
                }
              : { content: 'Charged.', toolCalls: [] };
          },
          toolbox,
          stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
    });
    try {
      const run = await bureau.createRun({
        agentName: 'default',
        message: 'Charge it',
        principal: 'api-key:tester',
      });
      await waitForCondition(
        () => bureau.listPendingReviews().some((review) => review.runId === run.id),
        'expected the tool call to surface a pending approval',
      );
      const handler = createBureauHandler(bureau, { authentication });
      const listed = await call(handler, 'bureau.reviews.list', {});
      const [review] = (listed.result?.['reviews'] ?? []) as Array<{ id: string; round: number }>;
      expect(review?.round).toBe(0);
      const reasonOf = (reply: Awaited<ReturnType<typeof call>>) =>
        (reply.error?.data as { reason?: string } | undefined)?.reason;

      // The first resolver supersedes round 0, so the review is now at round 1.
      const first = await call(handler, 'bureau.reviews.resolve', {
        id: review?.id,
        decision: 'approve',
        round: 0,
      });
      expect(first.result).toMatchObject({ receipt: 'superseded' });
      const reread = await call(handler, 'bureau.reviews.get', { id: review?.id });
      expect(reread.result).toMatchObject({ status: 'pending', round: 1 });

      // A second resolver that still shows round 0 is refused, and nothing changes.
      const stale = await call(handler, 'bureau.reviews.resolve', {
        id: review?.id,
        decision: 'deny',
        round: 0,
      });
      expect(stale.error?.data?.httpStatus).toBe(409);
      expect(reasonOf(stale)?.startsWith('REVIEW_ROUND_CHANGED: ')).toBe(true);
      const unchanged = await call(handler, 'bureau.reviews.get', { id: review?.id });
      expect(unchanged.result).toMatchObject({ status: 'pending', round: 1 });

      // The round it reads next decides.
      const current = await call(handler, 'bureau.reviews.resolve', {
        id: review?.id,
        decision: 'deny',
        round: 1,
      });
      expect(current.result).toMatchObject({ decision: 'deny', receipt: 'applied' });
      expect(charges).toEqual([]);
    } finally {
      await bureau.dispose();
    }
  });

  it('answers NotFound for an id that matches nothing', async () => {
    const { bureau } = await parkedBureau();
    try {
      const handler = createBureauHandler(bureau, { authentication });

      const body = await call(handler, 'bureau.reviews.get', { id: 'missing' });

      expect(body.error?.data?.httpStatus).toBe(404);
    } finally {
      await bureau.dispose();
    }
  });
});

describe('who reaches the human wait of a bureau.run() run, through a real Bureau (COR-1577)', () => {
  const OWNER_KEY = 'owner-key';
  const OTHER_KEY = 'other-key';
  const OPERATOR_KEY = 'operator-key';
  const keys: Record<string, Parameters<typeof principalFromApiKey>[0]> = {
    [OWNER_KEY]: { subject: 'tester', scopes: [] },
    [OTHER_KEY]: { subject: 'stranger', scopes: [] },
    [OPERATOR_KEY]: { subject: 'ops', scopes: ['bureau.reviews:read', 'bureau.reviews:resolve'] },
  };
  const authenticationFor = {
    resolveApiKeyPrincipal: async (key: string) =>
      key in keys ? principalFromApiKey(keys[key]!) : null,
    auditSink: silent,
  };

  async function callAs(
    key: string | undefined,
    handler: (request: Request) => Promise<Response>,
    method: string,
    params: unknown,
  ) {
    const response = await handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key === undefined ? {} : { 'X-API-Key': key }),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    return (await response.json()) as {
      result?: Record<string, unknown>;
      error?: { code: number; data?: { httpStatus?: number } };
    };
  }

  /** A Bureau whose `asker` agent parks on `requestHumanInput`, and one parked run. */
  async function parkedCatalogRun(principal: string | undefined) {
    const generate: GenerateFunction = async (context) =>
      context.step === 0
        ? {
            content: '',
            toolCalls: [
              {
                id: 'call-1',
                name: 'requestHumanInput',
                arguments: { signalName: 'answer', prompt: 'Which environment?' },
              },
            ],
          }
        : { content: 'thanks', toolCalls: [] };
    const bureau = await createBureau<AgentDefinitions>({
      assets: { storage: createMemoryAssetStorage() },
      id: 'catalog-reviews-bureau',
      agents: {
        asker: createAgent({
          generate,
          toolbox: createToolbox([]) as unknown as Toolbox,
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage: { type: 'memory' },
      durable: true,
      humanInput: true,
    });
    const run = bureau.run('asker', 'deploy', principal === undefined ? {} : { principal });
    await waitForCondition(
      () => bureau.listPendingReviews().some((review) => review.runId === run.id),
      'expected the catalog run to park and surface a pending review',
    );
    const [review] = bureau.listPendingReviews();
    return { bureau, run, id: review!.id };
  }

  it('answers a non-owner NotFound to get and to resolve, as for an id that matches nothing', async () => {
    const { bureau, run, id } = await parkedCatalogRun('api-key:tester');
    try {
      const handler = createBureauHandler(bureau, { authentication: authenticationFor });

      const unknown = await callAs(OTHER_KEY, handler, 'bureau.reviews.get', { id: 'no-such' });
      const get = await callAs(OTHER_KEY, handler, 'bureau.reviews.get', { id });
      const resolve = await callAs(OTHER_KEY, handler, 'bureau.reviews.resolve', {
        id,
        decision: 'approve',
      });
      const list = await callAs(OTHER_KEY, handler, 'bureau.reviews.list', {});

      expect(get.error?.data?.httpStatus).toBe(404);
      expect(resolve.error?.data?.httpStatus).toBe(404);
      // Indistinguishable from an id that matches nothing, so an id grants nothing.
      expect(get.error?.code).toBe(unknown.error?.code);
      expect(JSON.stringify(get.error).replaceAll(id, '<id>')).toBe(
        JSON.stringify(unknown.error).replaceAll('no-such', '<id>'),
      );
      expect(list.result).toEqual({ reviews: [] });
      // The refusals left the review pending and the run parked.
      expect(bureau.listPendingReviews().map((review) => review.id)).toEqual([id]);
      const owner = await callAs(OWNER_KEY, handler, 'bureau.reviews.resolve', {
        id,
        decision: 'approve',
      });
      expect(owner.result).toMatchObject({ id, kind: 'human-wait', decision: 'approve' });
      await run.result();
    } finally {
      await bureau.dispose();
    }
  });

  it('shows a run with no principal to an operator and to the local caller, and to no other key', async () => {
    const { bureau, run, id } = await parkedCatalogRun(undefined);
    try {
      expect(await bureau.getOwner({ kind: 'review', id })).toBe('anonymous:local');
      const keyed = createBureauHandler(bureau, { authentication: authenticationFor });
      const local = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

      // An API key owns as `api-key:<subject>`, never as `anonymous:local`, so the run is not
      // its own; the operator scope is what reaches it.
      for (const key of [OWNER_KEY, OTHER_KEY]) {
        const hidden = await callAs(key, keyed, 'bureau.reviews.get', { id });
        expect(hidden.error?.data?.httpStatus).toBe(404);
        const listed = await callAs(key, keyed, 'bureau.reviews.list', {});
        expect(listed.result).toEqual({ reviews: [] });
      }
      const refused = await callAs(OTHER_KEY, keyed, 'bureau.reviews.resolve', {
        id,
        decision: 'approve',
      });
      expect(refused.error?.data?.httpStatus).toBe(404);

      const operatorListed = await callAs(OPERATOR_KEY, keyed, 'bureau.reviews.list', {});
      expect(operatorListed.result).toMatchObject({ reviews: [{ id }] });
      const localGet = await callAs(undefined, local, 'bureau.reviews.get', { id });
      expect(localGet.result).toMatchObject({ id, kind: 'human-wait', status: 'pending' });

      const resolved = await callAs(OPERATOR_KEY, keyed, 'bureau.reviews.resolve', {
        id,
        decision: 'approve',
      });
      expect(resolved.result).toMatchObject({ id, kind: 'human-wait', decision: 'approve' });
      await run.result();
    } finally {
      await bureau.dispose();
    }
  });
});
