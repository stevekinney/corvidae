import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { callJsonRpc } from '@lostgradient/backchannel/client';
import { resolve } from 'node:path';
import { createSqliteStorageFixture } from '../test/storage-fixtures';
import { WEFT_SCOPE_VOCABULARY, Engine, workflow } from '@lostgradient/weft';
import {
  createOperationHandler,
  createOperationHandlerAuthenticator,
  principalFromApiKey,
  principalFromJwtClaims,
  type OperationHandlerAuthenticate,
  type WorkspaceIdentity,
} from '@lostgradient/backchannel';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { workspaceConformanceLedger } from './workspace-conformance-ledger.test-support.ts';
import { z } from 'zod';

import {
  ApprovalOutcomeNotWrittenError,
  BureauError,
  ReviewAlreadyResolvedError,
  ReviewRoundChangedError,
} from '../bureau-errors.ts';
import { createBureau } from '../create-bureau.ts';
import { waitForCondition } from '../test';
import type { Bureau } from '../bureau-types/facade.ts';
import type { PendingReview, ResolveReviewInput, ReviewStatus } from '../bureau-types/reviews.ts';
import {
  type BureauReviewsOperationHost,
  bureauReviewSchema,
  bureauReviewsOperations,
  effectiveApprovalExpiry,
  projectReview,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { buildBureauHandlerHost, createBureauHandler } from './create-bureau-handler.ts';
import { mayAccessOwnedResource, ownerOfPrincipal } from './owner-predicate.ts';
import { createMemoryAssetStorage } from '../assets/storage';
import type { AgentDefinitions } from '../agent-catalog';
import { MemoryStorage } from '@lostgradient/storage';
import { withWorkspaceMembership } from './workspace-principal.ts';
import {
  WORKSPACE_PRIVACY_ACTORS,
  openWorkspacePrivacyBureau,
  openWorkspaceApproval,
  workspacePrivacyCall,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const silent = () => undefined;
const witnesses = workspaceConformanceLedger('bureau-reviews-operations.test.ts');
const API_KEY = 'reviews-test-key';
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
  key = API_KEY,
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
    list: () => [toolApprovalReview()],
    get: async (id) =>
      id === 'approval:run-1:call-1'
        ? { ...toolApprovalReview(), status: 'approved' as ReviewStatus }
        : undefined,
    resolve: async (input) => {
      record.push(input);
      return { id: input.id, kind: 'tool-approval', decision: input.decision };
    },
    ...overrides,
  };
  return { reviews, ownership };
}

function serve(
  host: Omit<BureauReviewsOperationHost, 'reviewContinuation'> &
    Partial<Pick<BureauReviewsOperationHost, 'reviewContinuation'>>,
  authenticate: OperationHandlerAuthenticate = createOperationHandlerAuthenticator(authentication, {
    scopeVocabulary: WEFT_SCOPE_VOCABULARY,
    additionalScopes: BUREAU_SCOPES,
  }),
) {
  // A stub run is no chat's, so no decision here continues one (`review-continuation.test.ts`).
  const served: BureauReviewsOperationHost = {
    reviewContinuation: async () => ({ status: 'not-chat' }),
    ...host,
  };
  return createOperationHandler({
    operations: bureauReviewsOperations,
    host: served,
    authenticate,
  });
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
  it('does not expose raw engine reviews to a workspace administrator with legacy scope', async () => {
    const engine = {
      listReviews: async () => [
        {
          reviewId: 'engine-review-1',
          workflowId: 'workflow-1',
          createdAt: 1_000,
          timestamp: 1_100,
          status: 'completed' as const,
          reviewType: 'human',
          reviewers: ['operator'],
          allowPartial: false,
          artifact: null,
          decision: 'approved' as const,
          reviewer: 'operator',
        },
      ],
    };
    const host = {
      reviews: stubHost({ durableEngine: () => engine as never }).reviews,
      ownership: { runOwner: async () => 'api-key:tester', mayAccess: mayAccessOwnedResource },
    };
    const authenticate = withWorkspaceMembership(
      createOperationHandlerAuthenticator(
        {
          ...authentication,
          resolveApiKeyPrincipal: async (key: string) =>
            key === API_KEY
              ? principalFromApiKey({ subject: 'tester', scopes: ['reviews:read'] })
              : null,
        },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
      ),
      {
        workspaceId: 'workspace-a',
        resolveMembership: async () =>
          ({
            version: 1,
            workspaceId: 'workspace-a',
            actorId: 'tester',
            actorKind: 'user',
            owner: 'api-key:tester',
            membershipRevision: 'revision-1',
            capabilities: ['workspace:use', 'workspace:manage'],
          }) satisfies WorkspaceIdentity,
      },
    );
    const body = await call(serve(host, authenticate), 'bureau.reviews.list', {
      status: 'resolved',
    });
    expect(body.result).toEqual({ reviews: [], nextPageToken: null, total: 0 });
  });

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
      list: () => [local],
      pendingOf: async (runId: string) => [
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
      reviews: stubHost({ list: () => [runHumanWaitReview()] }).reviews,
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
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
    );

    const hidden = await call(serve(owned), 'bureau.reviews.list', {});
    const visible = await call(serve(owned, operator), 'bureau.reviews.list', {});

    expect(hidden.result).toEqual({ reviews: [], nextPageToken: null, total: 0 });
    expect(visible.result).toMatchObject({ reviews: [{ id: 'human-wait:run-2:answer:0' }] });
  });
});

describe('bureau.reviews.list', () => {
  it('returns the pending reviews without the approval token, binding, or metadata', async () => {
    const handler = serve(stubHost());

    const body = await call(handler, 'bureau.reviews.list', {});

    expect(body.result).toEqual({
      nextPageToken: null,
      total: 1,
      reviews: [
        {
          source: 'bureau',
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
            mayRemember: false,
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

  it('rejects a key it does not define, and a status it does not know', async () => {
    for (const params of [{ principal: 'api-key:other' }, { status: 'approved' }]) {
      const body = await call(serve(stubHost()), 'bureau.reviews.list', params);

      expect(body.error?.data?.httpStatus).toBe(400);
    }
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
        list: () => [review],
        get: async () => ({ ...review, status: 'pending' as ReviewStatus }),
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

  it('gives a pending review the earlier of its action’s and its binding’s deadlines (COR-2280)', async () => {
    const base = approvalActionReview({ kind: 'other' });
    if (base.kind !== 'tool-approval' || base.approval.action.type !== 'approval') {
      throw new Error('expected an approval');
    }
    const bindingOnly = {
      ...base,
      approval: {
        ...base.approval,
        action: { ...base.approval.action, expiresAt: undefined },
        approvalBinding: { expiresAt: Date.parse('2029-06-01T00:00:00.000Z'), nonce: SECRET },
      },
    } as unknown as PendingReview;
    const handler = serve(
      stubHost({
        list: () => [bindingOnly],
        get: async () => ({ ...bindingOnly, status: 'pending' as ReviewStatus }),
      }),
    );

    const listed = await call(handler, 'bureau.reviews.list', {});
    const fetched = await call(handler, 'bureau.reviews.get', { id: bindingOnly.id });

    expect(fetched.result?.['approval']).toMatchObject({
      action: { type: 'approval', expiresAt: '2029-06-01T00:00:00.000Z' },
    });
    expect(listed.result?.['reviews']).toMatchObject([
      { approval: { action: { expiresAt: '2029-06-01T00:00:00.000Z' } } },
    ]);
    for (const body of [listed, fetched]) expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it('reads each deadline only when it is a valid instant (COR-2280)', () => {
    const early = Date.parse('2030-01-01T00:00:00.000Z');
    expect(effectiveApprovalExpiry(undefined, early)).toBe('2030-01-01T00:00:00.000Z');
    expect(effectiveApprovalExpiry('2030-01-01T00:05:00Z', undefined)).toBe(
      '2030-01-01T00:05:00.000Z',
    );
    expect(effectiveApprovalExpiry('2030-01-01T00:05:00Z', early)).toBe('2030-01-01T00:00:00.000Z');
    expect(effectiveApprovalExpiry('2029-12-31T23:00:00Z', early)).toBe('2029-12-31T23:00:00.000Z');
    expect(effectiveApprovalExpiry('2030-01-01T00:00:00Z', early)).toBe('2030-01-01T00:00:00.000Z');
    expect(effectiveApprovalExpiry(undefined, undefined)).toBeUndefined();
    expect(effectiveApprovalExpiry('soon', Number.NaN)).toBeUndefined();
    expect(effectiveApprovalExpiry('soon', Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(effectiveApprovalExpiry('soon', Number.MAX_SAFE_INTEGER + 2)).toBeUndefined();
    expect(effectiveApprovalExpiry(undefined, '2030-01-01T00:00:00.000Z')).toBeUndefined();
    expect(effectiveApprovalExpiry('soon', early)).toBe('2030-01-01T00:00:00.000Z');
    expect(effectiveApprovalExpiry(undefined, -1)).toBe('1969-12-31T23:59:59.999Z');
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
  it('projects the current remember permission and fails closed when unavailable', async () => {
    const review = toolApprovalReview();
    const permitted = serve(stubHost({ get: async () => review, mayRemember: async () => true }));
    const denied = serve(stubHost({ get: async () => review }));
    const permittedResult = await call(permitted, 'bureau.reviews.get', { id: review.id });
    const deniedResult = await call(denied, 'bureau.reviews.get', { id: review.id });
    expect(permittedResult.result).toMatchObject({ approval: { mayRemember: true } });
    expect(deniedResult.result).toMatchObject({ approval: { mayRemember: false } });
  });
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
      { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
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

  it('passes the decision surface through to the decision (COR-2292)', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));

    await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
      decisionSurface: 'reviews',
    });
    await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'deny',
    });

    expect(record).toEqual([
      {
        id: 'approval:run-1:call-1',
        decision: 'approve',
        principal: 'api-key:tester',
        decisionSurface: 'reviews',
      },
      { id: 'approval:run-1:call-1', decision: 'deny', principal: 'api-key:tester' },
    ]);
  });

  it('refuses a decision surface outside the closed set, or on a human wait (COR-2292)', async () => {
    const record: ResolveReviewInput[] = [];
    const handler = serve(stubHost({}, record));
    const waitHandler = serve(
      stubHost(
        {
          list: () => [runHumanWaitReview({ runId: 'run-1' })],
          get: async () => ({
            ...runHumanWaitReview({ runId: 'run-1' }),
            status: 'pending' as ReviewStatus,
          }),
        },
        record,
      ),
    );

    const cased = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
      decisionSurface: 'Reviews',
    });
    const unknown = await call(handler, 'bureau.reviews.resolve', {
      id: 'approval:run-1:call-1',
      decision: 'approve',
      decisionSurface: 'https://example.test/reviews',
    });
    const onWait = await call(waitHandler, 'bureau.reviews.resolve', {
      id: 'human-wait:run-2:answer:0',
      decision: 'approve',
      answer: 'staging',
      decisionSurface: 'reviews',
    });

    expect(cased.error?.data?.httpStatus).toBe(400);
    expect(unknown.error?.data?.httpStatus).toBe(400);
    expect(onWait.error?.data?.httpStatus).toBe(422);
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
        resolve: async (input) => ({
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
          resolve: async () => {
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
          resolve: async () => {
            throw error;
          },
        }),
      );

    const unwritten = await call(
      failing(
        new ApprovalOutcomeNotWrittenError('resolved, but not written', {
          id: input.id,
          kind: 'tool-approval',
          decision: 'approve',
        }),
      ),
      'bureau.reviews.resolve',
      input,
    );
    const lost = await call(
      failing(new BureauError('already resolved', 'CONFLICT')),
      'bureau.reviews.resolve',
      input,
    );

    expect(unwritten.result).toMatchObject({
      id: input.id,
      decision: 'approve',
      receipt: 'applied',
      warning: 'APPROVAL_OUTCOME_NOT_WRITTEN',
    });
    const reasonOf = (reply: typeof unwritten) =>
      (reply.error?.data as { reason?: string } | undefined)?.reason;
    expect(unwritten.error).toBeUndefined();
    expect(reasonOf(lost)?.startsWith('APPROVAL_OUTCOME_NOT_WRITTEN')).toBe(false);
    // COR-2426: a review already resolved with another decision carries its own token.
    const alreadyResolved = await call(
      failing(new ReviewAlreadyResolvedError('Review "x" is already resolved')),
      'bureau.reviews.resolve',
      input,
    );
    expect(alreadyResolved.error?.data?.httpStatus).toBe(409);
    expect(reasonOf(alreadyResolved)).toBe('REVIEW_ALREADY_RESOLVED');
    expect(reasonOf(lost)?.startsWith('REVIEW_ALREADY_RESOLVED')).toBe(false);
    expect(JSON.stringify(lost.error)).not.toContain('APPROVAL_OUTCOME_NOT_WRITTEN');
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
          resolve: async () => {
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
    expect(reasonOf(moved)).toBe('REVIEW_ROUND_CHANGED');
    expect(reasonOf(lost)?.startsWith('REVIEW_ROUND_CHANGED')).toBe(false);
    expect(JSON.stringify(lost.error)).not.toContain('REVIEW_ROUND_CHANGED');
  });

  it('answers Forbidden to an authenticated caller it cannot attribute, even one that holds the scope', async () => {
    const record: ResolveReviewInput[] = [];
    const authenticate = async () => ({
      method: 'jwt' as const,
      principal: principalFromJwtClaims(
        { sub: 'someone', scope: 'bureau.reviews:resolve' },
        { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: new Set(BUREAU_SCOPES) },
      ),
    });
    const handler = createOperationHandler({
      operations: bureauReviewsOperations,
      host: {
        ...stubHost({}, record),
        reviewContinuation: async () => ({ status: 'not-chat' as const }),
      },
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

  it('says where a decided tool approval was decided, and nothing when it is unknown (COR-2292)', () => {
    const decided = {
      ...(toolApprovalReview() as Extract<PendingReview, { kind: 'tool-approval' }>),
      status: 'approved' as ReviewStatus,
      resolvedBy: 'api-key:tester',
      resolvedAt: 2_000,
    };

    const known = projectReview({ ...decided, decisionSurface: 'reviews' });
    const unknown = projectReview(decided);

    expect(known.resolution).toEqual({
      decision: 'approve',
      decidedBy: 'api-key:tester',
      decidedAt: 2_000,
      decisionSurface: 'reviews',
    });
    expect(unknown.resolution).not.toHaveProperty('decisionSurface');
    expect(bureauReviewSchema.safeParse(known).success).toBe(true);
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
      source: 'bureau',
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
          toolbox: createToolbox([]) as unknown as Toolbox,
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
      storage: new MemoryStorage(),
      durable: true,
    });
    const run = await bureau.tasks.start('default', 'park-me', { principal: 'api-key:tester' });
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === run.id),
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
      expect(after.result).toEqual({ reviews: [], nextPageToken: null, total: 0 });
      const again = await call(handler, 'bureau.reviews.resolve', { id, decision: 'approve' });
      expect(again.error?.data?.httpStatus).toBe(404);
      // COR-2426: another decision on a review that is already resolved is told apart from any other
      // lost race, so a client can say it is no longer waiting.
      const other = await call(handler, 'bureau.reviews.resolve', {
        id,
        decision: 'reject',
        reason: 'Too late',
      });
      expect(other.error?.data?.httpStatus).toBe(409);
      expect((other.error?.data as { reason?: string } | undefined)?.reason).toBe(
        'REVIEW_ALREADY_RESOLVED',
      );
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
      const records = JSON.stringify(await bureau.internals.auditTrail?.query({}));
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
      storage: new MemoryStorage(),
      durable: true,
    });
    try {
      const run = await bureau.tasks.start('default', 'Charge it', { principal: 'api-key:tester' });
      await waitForCondition(
        () => bureau.reviews.list().some((review) => review.runId === run.id),
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
      const session = await bureau.contexts.get(run.contextId);
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

  it('resolves a tool approval of an agent disabled meanwhile (COR-2429)', async () => {
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
      id: 'reviews-disabled-agent-bureau',
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
      storage: new MemoryStorage(),
      durable: true,
    });
    try {
      const run = await bureau.tasks.start('default', 'Charge it', { principal: 'api-key:tester' });
      await waitForCondition(
        () => bureau.reviews.list().some((review) => review.runId === run.id),
        'expected the tool call to surface a pending approval',
      );
      await bureau.agents.disable('default', { disabledBy: 'operator' });
      const handler = createBureauHandler(bureau, { authentication });
      const listed = await call(handler, 'bureau.reviews.list', {});
      const [review] = (listed.result?.['reviews'] ?? []) as Array<{ id: string }>;

      const resolved = await call(handler, 'bureau.reviews.resolve', {
        id: review?.id,
        decision: 'approve',
      });

      // What the agent had started finishes: the decision is recorded and the approved call runs
      // once, as a file agent's parked run resumes from its snapshot. Nothing new starts on it.
      expect(resolved.result).toMatchObject({ decision: 'approve', receipt: 'applied' });
      expect(charges).toEqual([500]);
      const after = await call(handler, 'bureau.reviews.list', {});
      expect(after.result).toEqual({ reviews: [], nextPageToken: null, total: 0 });
      expect(await rejectionOf(bureau.tasks.start('default', 'Again'))).toBeDefined();
      expect(generations).toBe(1);
    } finally {
      await bureau.dispose();
    }
  });

  it.each(['jsonrpc', 'mcp'] as const)(
    'refuses a decision on a round the review has moved past, through %s (COR-1659)',
    async (firstTransport) => {
      const refundStorage = createSqliteStorageFixture();
      const { createRefundLedger } = await import(
        resolve(import.meta.dir, '../../../../plugins/demo/src/refund-ledger.ts')
      );
      const ledger = createRefundLedger(refundStorage.storage);
      await ledger.addCharge({
        merchant: 'merchant',
        order: 'order',
        amount: 10000,
        currency: 'USD',
        paymentReference: 'private-payment',
        providerAccount: 'private-provider',
      });
      const refund = await ledger.admit({
        merchant: 'merchant',
        commandId: 'command',
        order: 'order',
        amount: 500,
        toolRevision: '1.1.0',
        owner: 'api-key:tester',
      });
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
        reviewPolicy: {
          matches: (review) =>
            review.kind === 'tool-approval' && review.approval.toolName === 'charge-card',
          mayRead: (_review, principal) =>
            principal.method === 'api-key' &&
            ['tester', 'operator'].includes(principal.subject ?? ''),
          mayDecide: (_review, principal) =>
            principal.method === 'api-key' &&
            ['tester', 'operator'].includes(principal.subject ?? ''),
          effect: async () => {
            const current = await ledger.get(refund.id);
            if (!current) return undefined;
            if (current.currency !== 'USD') throw new Error('Unsupported refund currency');
            return {
              kind: 'refund',
              refundId: current.id,
              orderId: current.order,
              cents: current.amount,
              currency: current.currency,
              status: current.status,
            };
          },
        },
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
        storage: new MemoryStorage(),
        durable: true,
      });
      try {
        const run = await bureau.tasks.start('default', 'Charge it', {
          principal: 'api-key:tester',
        });
        await waitForCondition(
          () => bureau.reviews.list().some((review) => review.runId === run.id),
          'expected the tool call to surface a pending approval',
        );
        const handler = createBureauHandler(bureau, {
          mcp: {},
          authentication: {
            ...authentication,
            resolveApiKeyPrincipal: async (key) =>
              key === 'agent-key' || key === 'operator-key'
                ? principalFromApiKey({
                    subject: key === 'agent-key' ? 'agent' : 'operator',
                    scopes: ['bureau.reviews:read', 'bureau.reviews:resolve'],
                  })
                : authentication.resolveApiKeyPrincipal(key),
          },
        });
        const listed = await call(handler, 'bureau.reviews.list', {});
        const [review] = (listed.result?.['reviews'] ?? []) as Array<{ id: string; round: number }>;
        expect(review?.round).toBe(0);
        const detail = await call(handler, 'bureau.reviews.get', { id: review?.id });
        expect(detail.result?.['effect']).toEqual({
          kind: 'refund',
          refundId: refund.id,
          orderId: 'order',
          cents: 500,
          currency: 'USD',
          status: 'admitted',
        });
        expect(JSON.stringify(detail.result)).not.toContain('private-provider');
        expect(
          bureauReviewSchema.safeParse({
            ...detail.result,
            effect: {
              kind: 'refund',
              refundId: refund.id,
              orderId: 'order',
              cents: 500,
              currency: 'EUR',
              status: 'admitted',
            },
          }).success,
        ).toBe(false);
        const operatorDetail = await call(
          handler,
          'bureau.reviews.get',
          { id: review?.id },
          'operator-key',
        );
        expect(operatorDetail.result).toMatchObject({ id: review?.id, round: 0 });
        const reasonOf = (reply: Awaited<ReturnType<typeof call>>) =>
          (reply.error?.data as { reason?: string } | undefined)?.reason;

        const transport = new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
          fetch: (url, init) => {
            const request = new Request(url, init);
            request.headers.set('X-API-Key', API_KEY);
            return handler(request);
          },
        });
        const client = new Client({ name: 'reviews-contract-test', version: '1.0.0' });
        await client.connect(transport);
        try {
          const detail = await client.callTool({
            name: 'bureau.reviews.get',
            arguments: { id: review!.id },
          });
          expect(detail.structuredContent).toMatchObject({ id: review!.id, round: 0 });
          const missing = await client.callTool({
            name: 'bureau.reviews.resolve',
            arguments: { id: review!.id, decision: 'approve' },
          });
          expect(missing.isError).toBe(true);
        } finally {
          await client.close();
        }

        const missingRound = await call(handler, 'bureau.reviews.resolve', {
          id: review?.id,
          decision: 'approve',
        });
        expect(missingRound.error).toBeDefined();
        expect(charges).toEqual([]);
        const initiallyPending = await call(handler, 'bureau.reviews.get', { id: review?.id });
        expect(initiallyPending.result).toMatchObject({ status: 'pending', round: 0 });
        const forged = await call(
          handler,
          'bureau.reviews.resolve',
          { id: review?.id, decision: 'approve', round: 0, decisionSurface: 'reviews' },
          'agent-key',
        );
        expect(forged.error).toBeDefined();
        const agentDetail = await call(
          handler,
          'bureau.reviews.get',
          { id: review?.id },
          'agent-key',
        );
        expect(agentDetail.error?.data?.httpStatus).toBe(404);
        const agentList = await call(handler, 'bureau.reviews.list', {}, 'agent-key');
        expect(agentList.result?.['reviews']).toEqual([]);
        const remembered = await call(handler, 'bureau.reviews.resolve', {
          id: review?.id,
          decision: 'approve',
          round: 0,
          remember: true,
        });
        expect(remembered.error).toBeDefined();
        expect(charges).toEqual([]);
        expect(
          await rejectionOf(
            bureau.reviews.resolve({
              id: review!.id,
              decision: 'approve',
              principal: 'api-key:tester',
              round: 0,
            }),
          ),
        ).toBeInstanceOf(Error);
        expect(charges).toEqual([]);

        // The first resolver supersedes round 0, so the review is now at round 1.
        let first: unknown;
        if (firstTransport === 'mcp') {
          const next = new Client({ name: 'review-supersession-test', version: '1.0.0' });
          await next.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
              fetch: (url, init) => {
                const request = new Request(url, init);
                request.headers.set('X-API-Key', API_KEY);
                return handler(request);
              },
            }),
          );
          try {
            const reply = await next.callTool({
              name: 'bureau.reviews.resolve',
              arguments: { id: review!.id, decision: 'approve', round: 0 },
            });
            first = reply.structuredContent;
          } finally {
            await next.close();
          }
        } else {
          const reply = await call(handler, 'bureau.reviews.resolve', {
            id: review?.id,
            decision: 'approve',
            round: 0,
          });
          first = reply.result;
        }
        expect(first).toMatchObject({ receipt: 'superseded' });
        const reread = await call(handler, 'bureau.reviews.get', { id: review?.id });
        expect(reread.result).toMatchObject({ status: 'pending', round: 1 });

        // A second resolver that still shows round 0 is refused, and nothing changes.
        const stale = await call(handler, 'bureau.reviews.resolve', {
          id: review?.id,
          decision: 'deny',
          round: 0,
        });
        expect(stale.error?.data?.httpStatus).toBe(409);
        expect(reasonOf(stale)).toBe('REVIEW_ROUND_CHANGED');
        for (const [key, round] of [
          [API_KEY, 0],
          ['agent-key', 1],
        ] as const) {
          const peer = new Client({ name: 'review-conflict-test', version: '1.0.0' });
          await peer.connect(
            new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
              fetch: (url, init) => {
                const request = new Request(url, init);
                request.headers.set('X-API-Key', key);
                return handler(request);
              },
            }),
          );
          try {
            const refusal = await peer.callTool({
              name: 'bureau.reviews.resolve',
              arguments: { id: review!.id, decision: 'deny', round, decisionSurface: 'reviews' },
            });
            expect(refusal.isError).toBe(true);
            if (key === API_KEY)
              expect(JSON.stringify(refusal.structuredContent)).toContain('REVIEW_ROUND_CHANGED');
            else expect(JSON.stringify(refusal.structuredContent)).toContain('NotFound');
          } finally {
            await peer.close();
          }
        }
        const unchanged = await call(handler, 'bureau.reviews.get', { id: review?.id });
        expect(unchanged.result).toMatchObject({ status: 'pending', round: 1 });

        // The round it reads next decides.
        const request = {
          endpoint: 'http://localhost/jsonrpc',
          method: 'bureau.reviews.resolve',
          id: 'decision',
          headers: { 'X-API-Key': API_KEY },
        };
        const refused = await callJsonRpc({
          ...request,
          params: { id: review!.id, decision: 'deny', round: 0 },
          fetch: (url, init) => handler(new Request(url, init)),
        });
        expect(refused.ok).toBe(false);
        const beforeLostReply = await call(handler, 'bureau.reviews.get', { id: review?.id });
        expect(beforeLostReply.result).toMatchObject({ status: 'pending', round: 1 });
        const lostReply = await rejectionOf(
          callJsonRpc({
            ...request,
            params: {
              id: review!.id,
              decision: 'deny',
              round: 1,
              ...(firstTransport === 'jsonrpc' ? { decisionSurface: 'reviews' } : {}),
            },
            fetch: async (url, init) => {
              await handler(new Request(url, init));
              throw new Error('response lost after dispatch');
            },
          }),
        );
        expect(String(lostReply)).toContain('response lost after dispatch');
        const decidedReply = await call(handler, 'bureau.reviews.get', { id: review?.id });
        const decided = decidedReply.result;
        expect(decided).toMatchObject({
          status: 'denied',
          round: 1,
          resolvedBy: 'api-key:tester',
          resolvedAt: expect.any(Number),
          resolution: { decidedBy: 'api-key:tester' },
        });
        if (firstTransport === 'jsonrpc')
          expect(decided?.['resolution']).toMatchObject({ decisionSurface: 'reviews' });
        else expect(decided?.['resolution']).not.toHaveProperty('decisionSurface');
        expect(charges).toEqual([]);
      } finally {
        await bureau.dispose();
        await refundStorage.dispose();
      }
    },
  );

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

describe('workspace privacy for reviews', () => {
  it('returns approval feedback only to the owner', async () => {
    const { opened, review } = await openWorkspaceApproval();
    try {
      const actors = Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[];
      for (const actor of [
        ...actors.filter((candidate) => candidate !== 'owner'),
        'owner',
      ] as WorkspacePrivacyActor[]) {
        const response = await workspacePrivacyCall(opened, actor, 'bureau.reviews.resolve', {
          id: review.id,
          decision: 'reject',
          reason: 'PRIVATE-APPROVAL-FEEDBACK-31ac',
        });
        witnesses.observePrivateProjection('bureau.reviews.resolve', actor, response);
        if (actor === 'owner') expect(response.text).toContain('PRIVATE-APPROVAL-FEEDBACK-31ac');
        else if (actor === 'foreign' || actor === 'removed') expect(response.status).toBe(403);
        else expect(response.body?.error?.data?.httpStatus).toBe(404);
      }
    } finally {
      await opened.dispose();
    }
  });
  it('excludes engine review artifacts from every workspace actor while a non-workspace control sees them', async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const engine = buildBureauHandlerHost(opened.bureau, []).reviews.durableEngine?.();
      if (!(engine instanceof Engine)) throw new Error('Expected the real durable engine');
      const reviewWorkflow = workflow({ name: 'workspace-engine-review-fixture' }).execute(
        async function* (context) {
          return yield* context.review({
            artifact: { text: 'PRIVATE-ENGINE-ARTIFACT-598a' },
            reviewType: 'content',
            reviewers: ['alice'],
          });
        },
      );
      const register: unknown = Reflect.get(engine, 'register');
      if (typeof register !== 'function') throw new Error('Expected engine workflow registration');
      Reflect.apply(register, engine, [reviewWorkflow]);
      await engine.start('workspace-engine-review-fixture', null);
      await waitForCondition(async () => {
        const reviews = await engine.listReviews();
        return reviews.length > 0;
      }, 'engine review is parked');
      const engineReviews = await engine.listReviews();
      const engineReview = engineReviews[0]!;
      const control = createOperationHandler({
        operations: bureauReviewsOperations,
        host: buildBureauHandlerHost(opened.bureau, []),
        authenticate: createOperationHandlerAuthenticator(
          {
            resolveApiKeyPrincipal: async (key) =>
              key === API_KEY
                ? principalFromApiKey({ subject: 'control', scopes: ['reviews:read'] })
                : null,
            auditSink: silent,
          },
          { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
        ),
      });
      const controlResult = await call(control, 'bureau.reviews.list', {});
      expect(JSON.stringify(controlResult)).toContain('PRIVATE-ENGINE-ARTIFACT-598a');
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const result = await workspacePrivacyCall(opened, actor, 'bureau.reviews.list', {});
        expect(result.text).not.toContain(engineReview.reviewId);
        expect(result.text).not.toContain('PRIVATE-ENGINE-ARTIFACT-598a');
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else expect(result.body?.error).toBeUndefined();
      }
    } finally {
      await opened.dispose();
    }
  });

  it('lists a workflow review with its workflow’s name and the step and message its request kept, pending and resolved (COR-2426)', async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const host = buildBureauHandlerHost(opened.bureau, []);
      const engine = host.reviews.durableEngine?.();
      if (!(engine instanceof Engine)) throw new Error('Expected the real durable engine');
      const reviewWorkflow = workflow({ name: 'release-notes' }).execute(async function* (context) {
        return yield* context.review({
          artifact: { text: 'Draft notes' },
          reviewType: 'content',
          reviewers: ['alice'],
          step: 'Collect merged changes',
          message: 'Approve to publish, or send it back with a note.',
        });
      });
      const register: unknown = Reflect.get(engine, 'register');
      if (typeof register !== 'function') throw new Error('Expected engine workflow registration');
      Reflect.apply(register, engine, [reviewWorkflow]);
      await engine.start('release-notes', null);
      await waitForCondition(async () => {
        const reviews = await engine.listReviews();
        return reviews.length > 0;
      }, 'engine review is parked');
      const control = createOperationHandler({
        operations: bureauReviewsOperations,
        host,
        authenticate: createOperationHandlerAuthenticator(
          {
            resolveApiKeyPrincipal: async (key) =>
              key === API_KEY
                ? principalFromApiKey({ subject: 'control', scopes: ['reviews:read'] })
                : null,
            auditSink: silent,
          },
          { scopeVocabulary: WEFT_SCOPE_VOCABULARY, additionalScopes: BUREAU_SCOPES },
        ),
      });
      const kept = {
        source: 'engine',
        workflowName: 'release-notes',
        step: 'Collect merged changes',
        message: 'Approve to publish, or send it back with a note.',
      };

      const pending = await call(control, 'bureau.reviews.list', {});
      expect(pending.result?.['reviews']).toEqual([expect.objectContaining(kept)]);

      const [entry] = await engine.listReviews();
      if (entry === undefined) throw new Error('Expected the engine review');
      await engine.submitReview(entry.reviewId, { decision: 'approved', reviewer: 'alice' });
      const resolved = await call(control, 'bureau.reviews.list', { status: 'resolved' });
      expect(resolved.result?.['reviews']).toEqual([expect.objectContaining(kept)]);
    } finally {
      await opened.dispose();
    }
  });

  it('keeps list, get, and resolve owner-scoped for all six actor outcomes', async () => {
    const opened = await openWorkspacePrivacyBureau({
      agents: {
        parked: createAgent({
          generate: async () => {
            return {
              content: '',
              toolCalls: [
                {
                  id: 'workspace-review-call',
                  name: 'requestHumanInput',
                  arguments: { signalName: 'workspace-review', prompt: 'REVIEW-SENTINEL' },
                },
              ],
            };
          },
          toolbox: createToolbox([]) as unknown as Toolbox,
          stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
        }),
      },
    });
    const run = await opened.bureau.tasks.start('parked', 'workspace-review', {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    await waitForCondition(
      () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
      'expected workspace review',
    );
    const listed = opened.bureau.reviews.list();
    const review = listed[0]!;
    try {
      for (const actor of [
        ...(Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]).filter(
          (value) => value !== 'owner',
        ),
        'owner',
      ] as WorkspacePrivacyActor[]) {
        const denied = actor === 'foreign' || actor === 'removed';
        const expectedStatus = denied ? 403 : actor === 'owner' ? 200 : 404;
        const list = await workspacePrivacyCall(opened, actor, 'bureau.reviews.list', {});
        witnesses.observeCollection('bureau.reviews.list', actor, list, review.id);
        expect(list.status, `${actor} list`).toBe(denied ? 403 : 200);
        const ids = ((list.body?.result?.['reviews'] ?? []) as Array<{ id: string }>).map(
          (entry) => entry.id,
        );
        expect(ids, actor).toEqual(actor === 'owner' ? [review.id] : []);
        if (actor === 'owner') expect(list.text).toContain('REVIEW-SENTINEL');
        else expect(list.text).not.toContain('REVIEW-SENTINEL');
        for (const method of ['bureau.reviews.get', 'bureau.reviews.resolve'] as const) {
          const response = await workspacePrivacyCall(opened, actor, method, {
            id: review.id,
            ...(method.endsWith('resolve') ? { decision: 'deny' } : {}),
          });
          witnesses.observeWire(method, actor, response);
          expect(response.status, `${actor} ${method}`).toBe(denied ? 403 : 200);
          if (actor === 'owner') {
            expect(response.body?.error).toBeUndefined();
            if (method === 'bureau.reviews.get') expect(response.text).toContain('REVIEW-SENTINEL');
          }
          if (expectedStatus === 404) {
            expect(response.body?.error?.data?.httpStatus, `${actor} ${method}`).toBe(404);
            const unknown = await workspacePrivacyCall(opened, actor, method, {
              id: 'unknown-review',
              ...(method.endsWith('resolve') ? { decision: 'deny' } : {}),
            });
            expect(JSON.stringify(response.body?.error).replaceAll(review.id, '<id>')).toBe(
              JSON.stringify(unknown.body?.error).replaceAll('unknown-review', '<id>'),
            );
            expect(response.text).not.toContain('REVIEW-SENTINEL');
          }
        }
      }
    } finally {
      await opened.dispose();
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
      storage: new MemoryStorage(),
      durable: true,
    });
    const run = await bureau.tasks.start(
      'asker',
      'deploy',
      principal === undefined ? {} : { principal },
    );
    await waitForCondition(
      () => bureau.reviews.list().some((review) => review.runId === run.id),
      'expected the catalog run to park and surface a pending review',
    );
    const [review] = bureau.reviews.list();
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
      expect(list.result).toEqual({ reviews: [], nextPageToken: null, total: 0 });
      // The refusals left the review pending and the run parked.
      expect(bureau.reviews.list().map((review) => review.id)).toEqual([id]);
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
      expect(await bureau.ownerOf({ kind: 'review', id })).toBe('anonymous:local');
      const keyed = createBureauHandler(bureau, { authentication: authenticationFor });
      const local = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

      // An API key owns as `api-key:<subject>`, never as `anonymous:local`, so the run is not
      // its own; the operator scope is what reaches it.
      for (const key of [OWNER_KEY, OTHER_KEY]) {
        const hidden = await callAs(key, keyed, 'bureau.reviews.get', { id });
        expect(hidden.error?.data?.httpStatus).toBe(404);
        const listed = await callAs(key, keyed, 'bureau.reviews.list', {});
        expect(listed.result).toEqual({ reviews: [], nextPageToken: null, total: 0 });
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

it('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
