import { createAgent, createMockGenerate, type GenerateFunction } from '@lostgradient/operative';
import {
  AUTHORIZATION_SCOPES,
  type OperationHandlerMount,
  principalFromApiKey,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createBureau } from '../create-bureau.ts';
import { RunRegisteredEvent, RunRemovedEvent } from '../events.ts';
import { waitForCondition } from '../test';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

const generate: GenerateFunction = async () => ({ content: 'Done.', toolCalls: [] });
const API_KEY = 'handler-test-key';
const credentials = { 'X-API-Key': API_KEY };
/** The scopes of `events:read` and every Bureau scope, for the one key the tests present. */
function resolveKey(
  scopes: readonly Parameters<typeof principalFromApiKey>[0]['scopes'][number][],
) {
  return async (key: string) =>
    key === API_KEY ? principalFromApiKey({ subject: 'tester', scopes: [...scopes] }) : null;
}
const allScopes = {
  auditSink: () => undefined,
  resolveApiKeyPrincipal: resolveKey(['events:read', ...BUREAU_SCOPES]),
};

async function buildBureau(options: { id?: string; agents?: string[]; persist?: boolean } = {}) {
  const agents = Object.fromEntries(
    (options.agents ?? []).map((name) => [
      name,
      createAgent({ generate: createMockGenerate([]), name }),
    ]),
  );
  return createBureau({
    ...(options.id === undefined ? {} : { id: options.id }),
    agents,
    generate,
    ...(options.persist === true ? { storage: { type: 'memory' as const } } : {}),
  });
}

function jsonRpc(method: string, params: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/jsonrpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, { headers });
}

type TestBureau = Awaited<ReturnType<typeof buildBureau>>;

async function statusOf(handler: (request: Request) => Promise<Response>, request: Request) {
  const response = await handler(request);
  return response.status;
}

async function rpcStatus(handler: (request: Request) => Promise<Response>, request: Request) {
  const response = await handler(request);
  const body = (await response.json()) as { error?: { data?: { httpStatus?: number } } };
  return body.error?.data?.httpStatus;
}

async function withBureau<T>(
  options: Parameters<typeof buildBureau>[0],
  run: (bureau: TestBureau) => Promise<T> | T,
): Promise<T> {
  const bureau = await buildBureau(options);
  try {
    return await run(bureau);
  } finally {
    await bureau.dispose();
  }
}

describe('createBureauHandler options', () => {
  it('throws on an option it does not know', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'allow', cors: {} } as never),
      ).toThrow(/unknown option "cors"/);
    });
  });

  it.each(['publicUrl', 'discoveryUrl', 'signing', 'cors', 'rateLimitKey', 'limits'])(
    'does not accept the deferred option %s',
    async (name) => {
      await withBureau({}, (bureau) => {
        expect(() =>
          createBureauHandler(bureau, { unauthenticatedAccess: 'allow', [name]: {} } as never),
        ).toThrow(`unknown option "${name}"`);
      });
    },
  );

  it('rejects an unauthenticatedAccess value that is neither reject nor allow', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'maybe' } as never),
      ).toThrow(/unauthenticatedAccess must be/);
    });
  });

  it('accepts an authentication-only configuration', async () => {
    await withBureau({}, (bureau) => {
      expect(typeof createBureauHandler(bureau, { authentication: allScopes })).toBe('function');
    });
  });

  it('throws when authentication configures static API keys alone', async () => {
    await withBureau({}, (bureau) => {
      expect(() => createBureauHandler(bureau, { authentication: { apiKeys: [API_KEY] } })).toThrow(
        /resolveApiKeyPrincipal/,
      );
    });
  });

  it('throws when authentication configures static API keys beside resolveApiKeyPrincipal', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          authentication: {
            apiKeys: [API_KEY],
            resolveApiKeyPrincipal: async () => null,
          },
        }),
      ).toThrow(/resolveApiKeyPrincipal/);
    });
  });

  it('throws when authentication configures jwt', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          authentication: { jwt: { secret: 'a-secret-long-enough-for-hmac-use' } },
        }),
      ).toThrow(/authentication\.jwt is not supported/);
    });
  });

  it('throws when authentication configures mtls', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          authentication: { mtls: { ca: 'ca', cert: 'cert', key: 'key' } },
        }),
      ).toThrow(/authentication\.mtls is not supported/);
    });
  });

  it('forwards mounts to the handler', async () => {
    await withBureau({}, async (bureau) => {
      const mount: OperationHandlerMount = {
        pathPrefix: '/adapter',
        fetch: async (_request, context) =>
          Response.json({
            method: context.principal.method,
            subject: 'subject' in context.principal ? context.principal.subject : undefined,
          }),
      };
      const handler = createBureauHandler(bureau, { authentication: allScopes, mounts: [mount] });

      const response = await handler(get('/adapter/ping', credentials));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ method: 'api-key', subject: 'tester' });
    });
  });

  it('serves the local caller under allow with exactly the built-in Weft scopes and the Bureau scopes', async () => {
    await withBureau({}, async (bureau) => {
      const mount: OperationHandlerMount = {
        pathPrefix: '/adapter',
        fetch: async (_request, context) =>
          Response.json({
            method: context.principal.method,
            subject: 'subject' in context.principal ? context.principal.subject : 'none',
            scopes: 'scopes' in context.principal ? [...context.principal.scopes] : [],
          }),
      };
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        mounts: [mount],
      });

      const response = await handler(get('/adapter/ping'));
      const body = (await response.json()) as {
        method: string;
        subject?: string;
        scopes: string[];
      };

      expect(body.method).toBe('unauthenticated-local');
      expect(body.subject).toBeUndefined();
      expect(new Set(body.scopes)).toEqual(new Set([...AUTHORIZATION_SCOPES, ...BUREAU_SCOPES]));
    });
  });

  it('refuses a mount that shadows a catalog route', async () => {
    await withBureau({}, (bureau) => {
      const mount: OperationHandlerMount = {
        pathPrefix: '/jsonrpc',
        fetch: async () => new Response('no'),
      };
      expect(() =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'allow', mounts: [mount] }),
      ).toThrow(
        'createOperationHandler: mount pathPrefix "/jsonrpc" overlaps the catalog route "/jsonrpc"',
      );
    });
  });

  it('drops a Bureau scope the handler did not register, and keeps the ones it did', async () => {
    await withBureau({}, async (bureau) => {
      const mount: OperationHandlerMount = {
        pathPrefix: '/adapter',
        fetch: async (_request, context) =>
          Response.json({
            scopes: 'scopes' in context.principal ? [...context.principal.scopes].toSorted() : [],
          }),
      };
      const handler = createBureauHandler(bureau, {
        authentication: {
          auditSink: () => undefined,
          resolveApiKeyPrincipal: resolveKey([
            'bureau.reviews:read',
            'bureau.reviews:resolve',
            'bureau.deliveries:read',
          ]),
        },
        mounts: [mount],
      });

      const response = await handler(get('/adapter/scopes', credentials));
      const body = (await response.json()) as { scopes: string[] };

      expect(body.scopes).toEqual(['bureau.reviews:read', 'bureau.reviews:resolve']);
      expect(body.scopes).not.toContain('bureau.deliveries:read');
    });
  });
});

describe('createBureauHandler publish', () => {
  it('accepts names that exist in the agent catalog', async () => {
    await withBureau({ agents: ['support', 'triage-2'] }, (bureau) => {
      expect(
        typeof createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          publish: ['support', 'triage-2'],
        }),
      ).toBe('function');
    });
  });

  it('throws for a name that is not in the agent catalog', async () => {
    await withBureau({ agents: ['support'] }, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'allow', publish: ['ghost'] }),
      ).toThrow(/"ghost", which is not in the Bureau's agent catalog/);
    });
  });

  it.each(['Support', 'support_', '-support', 'support-', 'sup port', 'a/b', ''])(
    'throws for the name %p, which is not a path segment',
    async (name) => {
      await withBureau({}, (bureau) => {
        expect(() =>
          createBureauHandler(bureau, { unauthenticatedAccess: 'allow', publish: [name] }),
        ).toThrow(/must match/);
      });
    },
  );

  it('throws when publish is not an array', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          publish: 'support' as never,
        }),
      ).toThrow(/publish must be an array/);
    });
  });
});

describe('createBureauHandler bureau id', () => {
  it('throws when the Bureau id is empty, because its feed could not be addressed', async () => {
    const bureau = await buildBureau({ id: '' });
    try {
      expect(bureau.id).toBe('');
      expect(() => createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toThrow(
        /empty id/,
      );
    } finally {
      await bureau.dispose();
    }
  });
});

describe('createBureauHandler persistence', () => {
  it('throws when the Bureau persists without an explicit id', async () => {
    await withBureau({ persist: true }, (bureau) => {
      expect(bureau.kv).toBeDefined();
      expect(bureau.hasExplicitId).toBe(false);
      expect(() => createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toThrow(
        /without an explicit `id`/,
      );
    });
  });

  it('serves a persistent Bureau that has an explicit id', async () => {
    await withBureau({ persist: true, id: 'persistent-bureau' }, (bureau) => {
      expect(bureau.hasExplicitId).toBe(true);
      expect(typeof createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toBe(
        'function',
      );
    });
  });

  it('serves an ephemeral Bureau without an explicit id', async () => {
    await withBureau({}, (bureau) => {
      expect(bureau.kv).toBeUndefined();
      expect(bureau.hasExplicitId).toBe(false);
      expect(typeof createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toBe(
        'function',
      );
    });
  });
});

describe('createBureauHandler authentication matrix', () => {
  it('throws with no authentication under the default reject', async () => {
    await withBureau({}, (bureau) => {
      expect(() => createBureauHandler(bureau, {})).toThrow(/authentication is required/);
      expect(() => createBureauHandler(bureau, { unauthenticatedAccess: 'reject' })).toThrow(
        /authentication is required/,
      );
    });
  });

  it('serves the local caller under allow: health, documents, and every operation answer', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });

      expect(await statusOf(handler, get('/v1/health'))).toBe(200);
      for (const document of ['/openapi.json', '/openrpc.json', '/asyncapi.json']) {
        expect(await statusOf(handler, get(document))).toBe(200);
      }
      expect(await rpcStatus(handler, jsonRpc('bureau.reviews.list', {}))).toBeUndefined();
      const feed = await handler(
        get(`/v1/subscriptions/bureau.events?bureauId=${bureau.id}`, {
          Accept: 'text/event-stream',
        }),
      );
      expect(feed.status).toBe(200);
      await feed.body?.cancel();
    });
  });

  it('throws when authentication is combined with allow', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, { authentication: allScopes, unauthenticatedAccess: 'allow' }),
      ).toThrow(/cannot be combined with unauthenticatedAccess: 'allow'/);
    });
  });

  it('answers 401 on every route without credentials when authentication is configured', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, { authentication: allScopes });

      for (const path of ['/v1/health', '/openapi.json', '/openrpc.json', '/asyncapi.json']) {
        const response = await handler(get(path));
        expect(response.status).toBe(401);
      }
      expect(await statusOf(handler, jsonRpc('bureau.reviews.list', {}))).toBe(401);
      expect(await statusOf(handler, get('/v1/health', { 'X-API-Key': 'wrong' }))).toBe(401);
      expect(await statusOf(handler, get('/v1/health', credentials))).toBe(200);
    });
  });

  it('answers 403, not 401, for an authenticated caller that lacks bureau.events:observe-all', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, {
        authentication: {
          resolveApiKeyPrincipal: resolveKey(['events:read', 'bureau.tasks:read']),
          auditSink: () => undefined,
        },
      });

      const feed = await handler(
        get(`/v1/subscriptions/bureau.events?bureauId=${bureau.id}`, {
          ...credentials,
          Accept: 'text/event-stream',
        }),
      );

      expect(feed.status).toBe(403);
    });
  });

  it('keeps the Bureau scopes a credential claims, and drops the ones it does not register', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, {
        authentication: {
          resolveApiKeyPrincipal: resolveKey(['bureau.reviews:read', 'bureau.deliveries:read']),
          auditSink: () => undefined,
        },
      });

      const list = await handler(jsonRpc('bureau.reviews.list', {}, credentials));
      const body = (await list.json()) as { result?: unknown };

      expect(body.result).toEqual({ reviews: [] });
    });
  });
});

describe('createBureauHandler catalog', () => {
  it('serves the management, events, runs events, and reviews operations and nothing else', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, { authentication: allScopes });

      const openRpc = await handler(get('/openrpc.json', credentials));
      const document = (await openRpc.json()) as { methods: Array<{ name: string }> };
      const asyncApi = await handler(get('/asyncapi.json', credentials));
      const asyncDocument = JSON.stringify(await asyncApi.json());

      expect(document.methods.map((method) => method.name).toSorted()).toEqual([
        'bureau.agents.catalog',
        'bureau.agents.definitions.create',
        'bureau.agents.definitions.delete',
        'bureau.agents.definitions.get',
        'bureau.agents.definitions.list',
        'bureau.agents.definitions.publish',
        'bureau.agents.definitions.revisions',
        'bureau.agents.definitions.update',
        'bureau.agents.definitions.withdraw',
        'bureau.agents.list',
        'bureau.audit.query',
        'bureau.contexts.delete',
        'bureau.contexts.get',
        'bureau.contexts.list',
        'bureau.deployment.get',
        'bureau.goals.cancel',
        'bureau.goals.create',
        'bureau.goals.get',
        'bureau.goals.list',
        'bureau.reviews.get',
        'bureau.reviews.list',
        'bureau.reviews.resolve',
        'bureau.schedules.cancel',
        'bureau.schedules.create',
        'bureau.schedules.get',
        'bureau.schedules.list',
        'bureau.schedules.pause',
        'bureau.schedules.resume',
        'bureau.schedules.update',
        'bureau.tasks.cancel',
        'bureau.tasks.get',
        'bureau.tasks.list',
        'bureau.tasks.respond',
        'bureau.workflows.create',
        'bureau.workflows.delete',
        'bureau.workflows.get',
        'bureau.workflows.list',
        'bureau.workflows.pause',
        'bureau.workflows.resume',
        'bureau.workflows.revisions',
        'bureau.workflows.runs.get',
        'bureau.workflows.runs.list',
        'bureau.workflows.signal',
        'bureau.workflows.update',
        'rpc.discover',
        'weft.system.principal',
      ]);
      expect(asyncDocument).toContain('/v1/subscriptions/bureau.events');
      expect(asyncDocument).toContain('/v1/subscriptions/operative.runs.events');
      expect(asyncDocument).toContain('/v1/subscriptions/bureau.tasks.events');
    });
  });

  it.each(['bureau.run', 'bureau.getRun', 'bureau.abortRun'])(
    'does not serve %s',
    async (method) => {
      await withBureau({}, async (bureau) => {
        const handler = createBureauHandler(bureau, { authentication: allScopes });

        const response = await handler(jsonRpc(method, {}, credentials));
        const body = (await response.json()) as { error?: { code: number }; result?: unknown };

        expect(body.result).toBeUndefined();
        expect(body.error?.code).toBe(-32601);
        const subscription = await handler(
          get(`/v1/subscriptions/${method}`, { ...credentials, Accept: 'text/event-stream' }),
        );
        expect(subscription.status).toBe(404);
      });
    },
  );

  it('streams bureau.events over Server-Sent Events from the Bureau itself', async () => {
    await withBureau({ id: 'events-bureau' }, async (bureau) => {
      bureau.eventFeed.publish(new RunRegisteredEvent('run-1'));
      const handler = createBureauHandler(bureau, { authentication: allScopes });

      const response = await handler(
        get('/v1/subscriptions/bureau.events?bureauId=events-bureau', {
          ...credentials,
          Accept: 'text/event-stream',
        }),
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: run.registered')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      bureau.eventFeed.publish(new RunRemovedEvent('run-1'));
      while (!text.includes('event: run.removed')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      expect(text).toContain('event: run.registered');
      expect(text).toContain('event: run.removed');
    });
  });

  it('answers 404 for a bureau id that is not this Bureau', async () => {
    await withBureau({ id: 'events-bureau' }, async (bureau) => {
      const handler = createBureauHandler(bureau, { authentication: allScopes });

      const response = await handler(
        get('/v1/subscriptions/bureau.events?bureauId=someone-else', {
          ...credentials,
          Accept: 'text/event-stream',
        }),
      );

      expect(response.status).toBe(404);
    });
  });

  it('streams operative.runs.events for a run the Bureau owns', async () => {
    const bureau = await createBureau({ agents: {}, generate });
    try {
      const run = await bureau.createRun({ message: 'hello' });
      await waitForCondition(
        () => bureau.runEventFeeds.get(run.id) !== undefined,
        'expected the bureau to create the run feed',
      );
      const handler = createBureauHandler(bureau, { authentication: allScopes });

      const response = await handler(
        get(`/v1/subscriptions/operative.runs.events?runId=${run.id}`, {
          ...credentials,
          Accept: 'text/event-stream',
        }),
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: run.started')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      await reader.cancel();

      expect(text).toContain('event: run.started');
    } finally {
      await bureau.dispose();
    }
  });
});

describe('createBureauHandler under Bun.serve', () => {
  it('gives the same response as calling the handler directly', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, { authentication: allScopes });
      const server = Bun.serve({ port: 0, fetch: handler });
      try {
        const direct = await handler(jsonRpc('bureau.reviews.list', {}, credentials));
        const served = await fetch(`http://localhost:${server.port}/jsonrpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...credentials },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'bureau.reviews.list',
            params: {},
          }),
        });
        const unauthenticated = await fetch(`http://localhost:${server.port}/v1/health`);

        expect(served.status).toBe(direct.status);
        expect(await served.json()).toEqual(await direct.json());
        expect(unauthenticated.status).toBe(401);
      } finally {
        await server.stop(true);
      }
    });
  });
});

describe('the Bureau scope list', () => {
  it('registers the operator scopes, and not the delivery scopes', () => {
    expect([...BUREAU_SCOPES]).toEqual([
      'bureau.tasks:read',
      'bureau.tasks:write',
      'bureau.reviews:read',
      'bureau.reviews:resolve',
      'bureau.audit:read',
      'bureau.schedules:read',
      'bureau.schedules:write',
      'bureau.goals:read',
      'bureau.goals:write',
      'bureau.contexts:read',
      'bureau.contexts:write',
      'bureau.agents:read',
      'bureau.agents:write',
      'bureau.workflows:read',
      'bureau.workflows:write',
      'bureau.events:observe-all',
    ]);
  });
});
