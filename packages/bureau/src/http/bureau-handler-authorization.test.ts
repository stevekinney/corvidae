/**
 * COR-718 — owner-of-record authorization in `createBureauHandler`, black-box:
 * every request goes through the handler as a fetch, and every resource is made
 * by a real Bureau. Two principals hold the same scopes and disjoint resources.
 */
import { type GenerateFunction, stopWhen } from '@lostgradient/operative';
import {
  type AuthConfig,
  createOperationHandler,
  principalFromApiKey,
  type AuthorizationScope,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { waitForCondition } from '../test';
import type { Bureau } from '../types.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import {
  BUREAU_HANDLER_OPERATIONS,
  type BureauHandlerHost,
  createBureauHandler,
} from './create-bureau-handler.ts';
import { mayAccessOwnedResource, type OwnerAccessPredicate } from './owner-predicate.ts';

type Handler = (request: Request) => Promise<Response>;
type Credential = { subject: string; scopes: readonly AuthorizationScope[] };

const SENTINEL = 'SENTINEL-TRANSCRIPT-8d1f';

/** Every key the suite presents, by name. A key is its own name plus `-key`. */
const credentialsByKey: Record<string, Credential> = {
  'alice-key': { subject: 'alice', scopes: [] },
  'alice-alias-key': { subject: 'alice', scopes: [] },
  'bob-key': { subject: 'bob', scopes: [] },
  'reader-key': { subject: 'reader', scopes: ['bureau.reviews:read', 'bureau.tasks:read'] },
  'resolver-key': { subject: 'resolver', scopes: ['bureau.reviews:resolve'] },
  'tasks-key': { subject: 'tasks', scopes: ['bureau.tasks:read'] },
  'observer-key': { subject: 'observer', scopes: ['bureau.events:observe-all'] },
  'system-key': { subject: 'system:scheduler', scopes: [...BUREAU_SCOPES] },
  'anonymous-key': { subject: 'anonymous:local', scopes: [...BUREAU_SCOPES] },
};

function authentication(auditSink: AuthConfig['auditSink'] = () => undefined): AuthConfig {
  return {
    auditSink,
    resolveApiKeyPrincipal: async (key) => {
      const credential = credentialsByKey[key];
      return credential === undefined
        ? null
        : principalFromApiKey({ subject: credential.subject, scopes: [...credential.scopes] });
    },
  };
}

function as(key: string): Record<string, string> {
  return { 'X-API-Key': key };
}

function rpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function subscribe(name: string, query: Record<string, string>, headers: Record<string, string>) {
  const search = new URLSearchParams(query).toString();
  return new Request(`http://localhost/v1/subscriptions/${name}?${search}`, {
    headers: { Accept: 'text/event-stream', ...headers },
  });
}

type RpcBody = {
  result?: Record<string, unknown>;
  error?: { code: number; message?: string; data?: { httpStatus?: number; weftCode?: string } };
};

type CatalogOperation = (typeof BUREAU_HANDLER_OPERATIONS)[number];

/**
 * The parameters to send an operation: only the keys its own schema declares,
 * taken from `candidates`. Every operation rejects an undeclared key as
 * `InvalidParams` before it runs, so an extra key would make a request pass or
 * match for the wrong reason.
 */
function paramsFor(
  operation: CatalogOperation,
  candidates: Record<string, string>,
): Record<string, string> {
  const shape = (operation.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
  return Object.fromEntries(
    Object.keys(shape)
      .filter((key) => key in candidates)
      .map((key) => [key, candidates[key]!]),
  );
}

/** What the caller was told: a JSON-RPC fault rides in a 200 envelope, so read its own status. */
async function effectiveStatus(response: Response): Promise<number> {
  if (!response.headers.get('content-type')?.includes('application/json')) return response.status;
  const body = (await response.clone().json()) as RpcBody;
  return body.error?.data?.httpStatus ?? response.status;
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

/** The response body with the id it was asked about replaced, so two ids compare equal. */
async function maskedText(pending: Promise<Response>, requested: string): Promise<string> {
  const response = await pending;
  const text = await response.text();
  return text.replaceAll(requested, '<id>');
}

const httpStatusOf = (body: RpcBody) => body.error?.data?.httpStatus;

async function call(handler: Handler, method: string, params: unknown, key: string) {
  const response = await handler(rpc(method, params, as(key)));
  return (await response.json()) as RpcBody;
}

/** A request with no credential header at all, as an uncredentialed caller sends it. */
async function callWithoutCredentials(handler: Handler, method: string, params: unknown) {
  const response = await handler(rpc(method, params));
  return (await response.json()) as RpcBody;
}

/** Reads a Server-Sent Events response until `text` appears, then stops it. */
async function readUntil(response: Response, text: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes(text)) {
    const { done, value } = await reader.read();
    if (done) break;
    received += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return received;
}

/** Parks the first generate of every session on a human wait, and finishes the second. */
function parkingGenerate(): GenerateFunction {
  const calls = new Map<string, number>();
  return async ({ conversation }) => {
    const sessionId = conversation.current.id;
    const count = (calls.get(sessionId) ?? 0) + 1;
    calls.set(sessionId, count);
    if (count > 1) return { content: 'approved and processed', toolCalls: [] };
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
  };
}

async function openBureau(id = 'authorization-bureau') {
  return createBureau({
    id,
    agents: {},
    generate: parkingGenerate(),
    toolbox: createToolbox([]),
    storage: { type: 'memory' },
    durableExecution: true,
    humanInput: true,
    stopWhen: stopWhen.some(stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()),
  });
}

/** A parked run, and the id of the review it is waiting on. */
async function parkRun(bureau: Bureau, principal: string | undefined, message = 'park me') {
  const run = await bureau.createRun({
    message,
    ...(principal === undefined ? {} : { principal }),
  });
  await waitForCondition(
    () => bureau.listPendingReviews().some((review) => review.runId === run.id),
    `run ${run.id} never parked`,
  );
  const review = bureau.listPendingReviews().find((candidate) => candidate.runId === run.id);
  return { run, reviewId: review!.id };
}

async function withTwoOwners<T>(
  body: (context: {
    bureau: Bureau;
    handler: Handler;
    alice: Awaited<ReturnType<typeof parkRun>>;
    bob: Awaited<ReturnType<typeof parkRun>>;
  }) => Promise<T>,
): Promise<T> {
  const bureau = await openBureau();
  try {
    const alice = await parkRun(bureau, 'api-key:alice', `alice ${SENTINEL}`);
    const bob = await parkRun(bureau, 'api-key:bob', `bob ${SENTINEL}`);
    const handler = createBureauHandler(bureau, { authentication: authentication() });
    return await body({ bureau, handler, alice, bob });
  } finally {
    await bureau.dispose();
  }
}

function reviewIds(body: RpcBody): string[] {
  const reviews = (body.result?.['reviews'] ?? []) as Array<{ id: string }>;
  return reviews.map((review) => review.id).toSorted();
}

describe('owner strings and reserved namespaces', () => {
  it.each([
    ['system:scheduler', 'system-key'],
    ['anonymous:local', 'anonymous-key'],
  ])(
    'refuses a credential whose subject is %s with the 401 authentication fault',
    async (_s, key) => {
      const events: Array<Record<string, unknown>> = [];
      const bureau = await openBureau();
      try {
        const handler = createBureauHandler(bureau, {
          authentication: authentication((event) => events.push({ ...event })),
        });

        const response = await handler(rpc('bureau.reviews.list', {}, as(key)));

        expect(response.status).toBe(401);
        expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
        expect(events).toHaveLength(1);
        expect(JSON.stringify(events)).not.toContain(key);
      } finally {
        await bureau.dispose();
      }
    },
  );

  it('refuses a credential whose principal has no subject', async () => {
    const bureau = await openBureau();
    try {
      const handler = createBureauHandler(bureau, {
        authentication: {
          auditSink: () => undefined,
          resolveApiKeyPrincipal: async () => ({
            ...principalFromApiKey({ subject: 'x', scopes: [] }),
            subject: undefined,
          }),
        },
      });

      expect(await statusOf(handler(rpc('bureau.reviews.list', {}, as('any'))))).toBe(401);
    } finally {
      await bureau.dispose();
    }
  });

  it('owns what an API key creates as api-key:<encoded subject>', async () => {
    const bureau = await openBureau();
    try {
      const { run } = await parkRun(bureau, 'api-key:ops%20user%2F1%3Aa');
      const handler = createBureauHandler(bureau, {
        authentication: {
          auditSink: () => undefined,
          resolveApiKeyPrincipal: async () =>
            principalFromApiKey({ subject: 'ops user/1:a', scopes: [] }),
        },
      });

      const listed = await call(handler, 'bureau.reviews.list', {}, 'any');

      expect(reviewIds(listed)).toHaveLength(1);
      expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('api-key:ops%20user%2F1%3Aa');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('distinct keys stay apart', () => {
  it('keeps two keys with different subjects from seeing each other’s resources', async () => {
    await withTwoOwners(async ({ handler, alice, bob }) => {
      expect(reviewIds(await call(handler, 'bureau.reviews.list', {}, 'alice-key'))).toEqual([
        alice.reviewId,
      ]);
      expect(reviewIds(await call(handler, 'bureau.reviews.list', {}, 'bob-key'))).toEqual([
        bob.reviewId,
      ]);
      const foreign = await call(handler, 'bureau.reviews.get', { id: bob.reviewId }, 'alice-key');
      expect(httpStatusOf(foreign)).toBe(404);
    });
  });

  it('lets several keys share an owner only when the resolver returns the same subject', async () => {
    await withTwoOwners(async ({ handler, alice }) => {
      const viaAlias = await call(
        handler,
        'bureau.reviews.get',
        { id: alice.reviewId },
        'alice-alias-key',
      );
      const viaOriginal = await call(
        handler,
        'bureau.reviews.get',
        { id: alice.reviewId },
        'alice-key',
      );

      expect(viaAlias.result).toMatchObject({ id: alice.reviewId });
      // The review's age is read at request time, so it is the one field that differs.
      expect({ ...viaOriginal.result, ageMilliseconds: 0 }).toEqual({
        ...viaAlias.result,
        ageMilliseconds: 0,
      });
    });
  });
});

describe('the reviews owner predicate', () => {
  it('lists only the caller’s own reviews, and gets or resolves another’s as a missing id', async () => {
    await withTwoOwners(async ({ bureau, handler, alice, bob }) => {
      const missing = await call(
        handler,
        'bureau.reviews.get',
        { id: 'no-such-review' },
        'alice-key',
      );
      const foreign = await call(handler, 'bureau.reviews.get', { id: bob.reviewId }, 'alice-key');
      const resolveMissing = await call(
        handler,
        'bureau.reviews.resolve',
        { id: 'no-such-review', decision: 'approve' },
        'alice-key',
      );
      const resolveForeign = await call(
        handler,
        'bureau.reviews.resolve',
        { id: bob.reviewId, decision: 'approve' },
        'alice-key',
      );

      expect(missing.error?.data?.httpStatus).toBe(404);
      expect(foreign.error?.data?.httpStatus).toBe(404);
      expect(foreign.error?.code).toBe(missing.error?.code);
      expect(JSON.stringify(foreign).replaceAll(bob.reviewId, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('no-such-review', '<id>'),
      );
      expect(JSON.stringify(resolveForeign).replaceAll(bob.reviewId, '<id>')).toBe(
        JSON.stringify(resolveMissing).replaceAll('no-such-review', '<id>'),
      );
      // Bob's review is still pending, and Alice's own are within her reach.
      expect(bureau.listPendingReviews().map((review) => review.id)).toContain(bob.reviewId);
      const own = await call(handler, 'bureau.reviews.get', { id: alice.reviewId }, 'alice-key');
      expect(own.result).toMatchObject({ id: alice.reviewId });
    });
  });

  it('lets the owner resolve its own review without any Bureau scope, and records the owner as the actor', async () => {
    await withTwoOwners(async ({ bureau, handler, alice }) => {
      const resolved = await call(
        handler,
        'bureau.reviews.resolve',
        { id: alice.reviewId, decision: 'approve' },
        'alice-key',
      );

      expect(resolved.result).toMatchObject({ id: alice.reviewId, receipt: 'applied' });
      const entries = await bureau.auditTrail?.query({ runId: alice.run.id });
      expect(
        entries
          ?.filter((entry) => entry.type.startsWith('review.'))
          .map((entry) => entry.principal),
      ).toEqual(['api-key:alice']);
    });
  });

  it('gives bureau.reviews:read every owner’s list and get, but not resolve', async () => {
    await withTwoOwners(async ({ handler, alice, bob }) => {
      expect(reviewIds(await call(handler, 'bureau.reviews.list', {}, 'reader-key'))).toEqual(
        [alice.reviewId, bob.reviewId].toSorted(),
      );
      const readByReader = await call(
        handler,
        'bureau.reviews.get',
        { id: bob.reviewId },
        'reader-key',
      );
      expect(readByReader.result).toMatchObject({ id: bob.reviewId });
      const resolve = await call(
        handler,
        'bureau.reviews.resolve',
        { id: bob.reviewId, decision: 'approve' },
        'reader-key',
      );
      expect(resolve.error?.data?.httpStatus).toBe(404);
    });
  });

  it('gives bureau.reviews:resolve every owner’s resolve, but a write scope does not imply its read scope', async () => {
    await withTwoOwners(async ({ handler, alice, bob }) => {
      expect(reviewIds(await call(handler, 'bureau.reviews.list', {}, 'resolver-key'))).toEqual([]);
      const readByResolver = await call(
        handler,
        'bureau.reviews.get',
        { id: bob.reviewId },
        'resolver-key',
      );
      expect(httpStatusOf(readByResolver)).toBe(404);
      const resolved = await call(
        handler,
        'bureau.reviews.resolve',
        { id: alice.reviewId, decision: 'approve' },
        'resolver-key',
      );
      expect(resolved.result).toMatchObject({ id: alice.reviewId, receipt: 'applied' });
    });
  });

  it('writes no audit entry for an owner denial', async () => {
    await withTwoOwners(async ({ bureau, handler, bob }) => {
      const before = (await bureau.auditTrail?.query({})) ?? [];

      await call(handler, 'bureau.reviews.list', {}, 'alice-key');
      await call(handler, 'bureau.reviews.get', { id: bob.reviewId }, 'alice-key');
      await call(
        handler,
        'bureau.reviews.resolve',
        { id: bob.reviewId, decision: 'approve' },
        'alice-key',
      );
      const events = await handler(
        subscribe('operative.runs.events', { runId: bob.run.id }, as('alice-key')),
      );
      expect(events.status).toBe(404);

      const after = (await bureau.auditTrail?.query({})) ?? [];
      expect(after).toEqual(before);
    });
  });
});

describe('the run events owner predicate', () => {
  it('lets the run’s owner subscribe and refuses another owner as an unknown run', async () => {
    await withTwoOwners(async ({ handler, alice, bob }) => {
      const own = await handler(
        subscribe('operative.runs.events', { runId: alice.run.id }, as('alice-key')),
      );
      expect(own.status).toBe(200);
      expect(await readUntil(own, 'event: run.started')).toContain('event: run.started');

      const foreign = await handler(
        subscribe('operative.runs.events', { runId: bob.run.id }, as('alice-key')),
      );
      const unknown = await handler(
        subscribe('operative.runs.events', { runId: 'no-such-run' }, as('alice-key')),
      );
      expect(foreign.status).toBe(404);
      expect(await maskedText(Promise.resolve(foreign), bob.run.id)).toBe(
        await maskedText(Promise.resolve(unknown), 'no-such-run'),
      );
    });
  });

  it('lets bureau.tasks:read subscribe to any owner’s run, and observe-all alone does not', async () => {
    await withTwoOwners(async ({ handler, bob }) => {
      const read = await handler(
        subscribe('operative.runs.events', { runId: bob.run.id }, as('tasks-key')),
      );
      expect(read.status).toBe(200);
      await read.body?.cancel();
      const observer = await handler(
        subscribe('operative.runs.events', { runId: bob.run.id }, as('observer-key')),
      );
      expect(observer.status).toBe(404);
    });
  });
});

describe('the fleet feed', () => {
  it('requires bureau.events:observe-all, which bureau.tasks:read alone does not grant', async () => {
    await withTwoOwners(async ({ bureau, handler }) => {
      const feed = (key: string) =>
        handler(subscribe('bureau.events', { bureauId: bureau.id }, as(key)));

      expect(await statusOf(feed('alice-key'))).toBe(403);
      expect(await statusOf(feed('tasks-key'))).toBe(403);
      const observed = await feed('observer-key');
      expect(observed.status).toBe(200);
      await observed.body?.cancel();
    });
  });
});

describe('credentials', () => {
  it('answers every catalog operation with the 401 authentication fault when called without credentials', async () => {
    const bureau = await openBureau();
    try {
      const handler = createBureauHandler(bureau, { authentication: authentication() });
      expect(BUREAU_HANDLER_OPERATIONS.length).toBeGreaterThan(0);

      for (const operation of BUREAU_HANDLER_OPERATIONS) {
        const response = operation.transports.jsonRpcHttp
          ? await handler(rpc(operation.name, {}))
          : await handler(subscribe(operation.name, { bureauId: bureau.id, runId: 'x' }, {}));
        expect([operation.name, response.status]).toEqual([operation.name, 401]);
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('answers every catalog operation with neither 401 nor 403 for the local caller under allow', async () => {
    const bureau = await openBureau();
    try {
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

      for (const operation of BUREAU_HANDLER_OPERATIONS) {
        const params = paramsFor(operation, {
          id: 'x',
          runId: 'x',
          bureauId: bureau.id,
          decision: 'approve',
        });
        const response = operation.transports.jsonRpcHttp
          ? await handler(rpc(operation.name, params))
          : await handler(subscribe(operation.name, params, {}));
        const status = await effectiveStatus(response);
        // A missing id is a 404 and a bad request a 400: only the two
        // authentication faults are ruled out, and a request that was malformed
        // would rule them out for the wrong reason.
        expect([operation.name, status === 401 || status === 403, status === 400]).toEqual([
          operation.name,
          false,
          false,
        ]);
        await response.body?.cancel();
      }
    } finally {
      await bureau.dispose();
    }
  });

  it('records one authentication audit event for an invalid key, without any part of the key', async () => {
    const events: Array<Record<string, unknown>> = [];
    const bureau = await openBureau();
    try {
      const handler = createBureauHandler(bureau, {
        authentication: authentication((event) => events.push({ ...event })),
      });
      const presented = 'definitely-not-a-key-9b2e';

      const response = await handler(rpc('bureau.reviews.list', {}, as(presented)));

      expect(response.status).toBe(401);
      expect(events).toHaveLength(1);
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(presented);
      expect(serialized).not.toContain(presented.slice(0, 8));
    } finally {
      await bureau.dispose();
    }
  });
});

describe('the local caller under allow', () => {
  it('owns what it creates as anonymous:local, and records that actor when it resolves a review', async () => {
    const bureau = await openBureau();
    try {
      const { run, reviewId } = await parkRun(bureau, undefined);
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

      const resolved = await callWithoutCredentials(handler, 'bureau.reviews.resolve', {
        id: reviewId,
        decision: 'approve',
      });

      expect(resolved.result).toMatchObject({ id: reviewId, receipt: 'applied' });
      expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('anonymous:local');
      const entries = await bureau.auditTrail?.query({ runId: run.id });
      expect(
        entries
          ?.filter((entry) => entry.type.startsWith('review.'))
          .map((entry) => entry.principal),
      ).toEqual(['anonymous:local']);
    } finally {
      await bureau.dispose();
    }
  });

  it('lets two uncredentialed callers see each other’s resources, all owned by anonymous:local', async () => {
    const bureau = await openBureau();
    try {
      const first = await parkRun(bureau, undefined, 'first');
      const second = await parkRun(bureau, undefined, 'second');
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

      const listedByOne = await callWithoutCredentials(handler, 'bureau.reviews.list', {});
      const listedByTwo = await callWithoutCredentials(handler, 'bureau.reviews.list', {});

      expect(reviewIds(listedByOne)).toEqual([first.reviewId, second.reviewId].toSorted());
      expect(reviewIds(listedByTwo)).toEqual(reviewIds(listedByOne));
      for (const { run } of [first, second]) {
        expect(await bureau.getOwner({ kind: 'run', id: run.id })).toBe('anonymous:local');
      }
    } finally {
      await bureau.dispose();
    }
  });
});

describe('identifiers grant nothing', () => {
  /** The string-valued id parameters an operation declares, found from its own schema. */
  function idParameters(operation: (typeof BUREAU_HANDLER_OPERATIONS)[number]): string[] {
    const shape = (operation.inputSchema as unknown as { shape: Record<string, unknown> }).shape;
    return Object.keys(shape).filter((key) => key === 'id' || key.endsWith('Id'));
  }

  it('answers real and random ids identically to a non-owner without operator scopes', async () => {
    await withTwoOwners(async ({ bureau, handler, bob }) => {
      const realIds: Record<string, string> = {
        id: bob.reviewId,
        runId: bob.run.id,
        bureauId: bureau.id,
      };
      let probed = 0;

      for (const operation of BUREAU_HANDLER_OPERATIONS) {
        for (const parameter of idParameters(operation)) {
          const send = async (requested: string) => {
            const params = paramsFor(operation, { [parameter]: requested, decision: 'approve' });
            const request = operation.transports.jsonRpcHttp
              ? rpc(operation.name, params, as('alice-key'))
              : subscribe(operation.name, params, as('alice-key'));
            const response = await handler(request);
            const status = await effectiveStatus(response);
            const text = await maskedText(Promise.resolve(response), requested);
            return { status, text };
          };

          const real = await send(realIds[parameter] ?? 'unmapped');
          const random = await send(`random-${crypto.randomUUID()}`);

          expect([operation.name, parameter, real]).toEqual([operation.name, parameter, random]);
          // The request reached the operation and was refused there: not a 400
          // for a malformed request, and not a success.
          expect([operation.name, parameter, [403, 404].includes(real.status)]).toEqual([
            operation.name,
            parameter,
            true,
          ]);
          probed += 1;
        }
      }
      expect(probed).toBeGreaterThanOrEqual(3);
    });
  });
});

describe('one predicate on both transports', () => {
  it('decides bureau.reviews.get and the runs events wrapper through the same function', async () => {
    await withTwoOwners(async ({ bureau, bob }) => {
      const decisions: Array<Parameters<OwnerAccessPredicate>[0]['operatorScope']> = [];
      const counting: OwnerAccessPredicate = (request) => {
        decisions.push(request.operatorScope);
        return mayAccessOwnedResource(request);
      };
      const host: BureauHandlerHost = {
        bureauFeeds: { get: (id) => (id === bureau.id ? bureau.eventFeed : undefined) },
        runFeeds: bureau.runEventFeeds,
        reviews: bureau,
        ownership: {
          runOwner: (runId) => bureau.getOwner({ kind: 'run', id: runId }),
          mayAccess: counting,
        },
      };
      const handler = createOperationHandler({
        operations: BUREAU_HANDLER_OPERATIONS,
        host,
        authenticate: createBureauHandlerAuthenticateFor('alice-key'),
      });

      const jsonRpc = await call(handler, 'bureau.reviews.get', { id: bob.reviewId }, 'alice-key');
      const sse = await handler(
        subscribe('operative.runs.events', { runId: bob.run.id }, as('alice-key')),
      );

      expect(jsonRpc.error?.data?.httpStatus).toBe(404);
      expect(sse.status).toBe(404);
      expect(decisions).toEqual(['bureau.reviews:read', 'bureau.tasks:read']);
    });
  });
});

/** An `authenticate` hook that admits `key` as its credential and nothing else. */
function createBureauHandlerAuthenticateFor(key: string) {
  const credential = credentialsByKey[key]!;
  return async () => ({
    method: 'api-key' as const,
    principal: principalFromApiKey({
      subject: credential.subject,
      scopes: [...credential.scopes],
    }),
  });
}

describe('deployment isolation', () => {
  it('shares no state between two Bureaus with different ids and separate storage', async () => {
    const first = await openBureau('first-bureau');
    const second = await openBureau('second-bureau');
    try {
      const { run, reviewId } = await parkRun(first, 'api-key:alice');
      const handler = createBureauHandler(second, { authentication: authentication() });

      const crossed = await call(handler, 'bureau.reviews.get', { id: reviewId }, 'alice-key');
      expect(httpStatusOf(crossed)).toBe(404);
      expect(reviewIds(await call(handler, 'bureau.reviews.list', {}, 'alice-key'))).toEqual([]);
      expect(
        await statusOf(
          handler(subscribe('operative.runs.events', { runId: run.id }, as('tasks-key'))),
        ),
      ).toBe(404);
      expect(
        await statusOf(
          handler(subscribe('bureau.events', { bureauId: first.id }, as('observer-key'))),
        ),
      ).toBe(404);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });
});

describe('transcripts stay inside the Bureau', () => {
  it('returns no session transcript content from any served operation', async () => {
    await withTwoOwners(async ({ bureau, alice }) => {
      const session = await bureau.getSession(alice.run.sessionId);
      expect(JSON.stringify(session?.conversationHistory)).toContain(SENTINEL);
      // Let the run finish, so its feeds hold every kind of event it publishes.
      await bureau.resolveReview({
        id: alice.reviewId,
        decision: 'approve',
        principal: 'api-key:alice',
      });
      await waitForCondition(
        () => bureau.getRun(alice.run.id)?.status !== 'running',
        'the approved run never finished',
      );
      const handler = createBureauHandler(bureau, {
        authentication: {
          auditSink: () => undefined,
          resolveApiKeyPrincipal: async () =>
            principalFromApiKey({ subject: 'alice', scopes: [...BUREAU_SCOPES] }),
        },
      });
      const bodies: string[] = [];

      for (const operation of BUREAU_HANDLER_OPERATIONS) {
        const params = paramsFor(operation, {
          id: alice.reviewId,
          runId: alice.run.id,
          bureauId: bureau.id,
          decision: 'approve',
        });
        const response = operation.transports.jsonRpcHttp
          ? await handler(rpc(operation.name, params, as('k')))
          : await handler(subscribe(operation.name, params, as('k')));
        // The resolved review is still readable, and resolving it again is a 404:
        // either way the request reached the operation, and the body is scanned.
        const status = await effectiveStatus(response);
        expect([operation.name, status === 400]).toEqual([operation.name, false]);
        if (operation.name === 'bureau.reviews.get') {
          expect(status).toBe(200);
          expect(await response.clone().text()).toContain(alice.reviewId);
        }
        bodies.push(
          operation.transports.jsonRpcHttp
            ? await response.text()
            : await readUntil(
                response,
                operation.name === 'bureau.events'
                  ? 'event: review.approved'
                  : 'event: run.completed',
              ),
        );
      }

      expect(bodies.join('\n')).not.toContain(SENTINEL);
      expect(bodies.join('\n')).toContain(alice.reviewId);
    });
  });
});
