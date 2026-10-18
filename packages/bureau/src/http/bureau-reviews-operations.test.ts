import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import {
  createOperationHandler,
  createOperationHandlerAuthenticator,
  principalFromApiKey,
  principalFromJwtClaims,
} from '@lostgradient/weft';
import { createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from '../create-bureau.ts';
import { waitForCondition } from '../test';
import type { PendingReview, ResolveReviewInput, ReviewStatus } from '../types.ts';
import {
  type BureauReviewsOperationHost,
  bureauReviewsOperations,
  projectReview,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import { mayAccessOwnedResource, ownerOfPrincipal } from './owner-predicate.ts';

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
    const bureau = await createBureau({
      id: 'reviews-bureau',
      agents: {},
      generate,
      toolbox: emptyToolbox(),
      storage: { type: 'memory' },
      durableExecution: true,
      humanInput: true,
      stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
    });
    const run = await bureau.createRun({ message: 'park-me', principal: 'api-key:tester' });
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
