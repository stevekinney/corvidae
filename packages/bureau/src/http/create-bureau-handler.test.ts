import {
  createAgent,
  createMockGenerate,
  ScheduleAttemptedEvent,
  SessionCreatedEvent,
  SteeringAcceptedEvent,
  type GenerateFunction,
} from '@lostgradient/operative';
import {
  AUTHORIZATION_SCOPES,
  type OperationHandlerMount,
  principalFromApiKey,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createMemoryAssetStorage } from '../assets/storage';
import { createBureau } from '../create-bureau.ts';
import { RunAbortSettledEvent, RunRegisteredEvent, RunRemovedEvent } from '../events.ts';
import { waitForCondition } from '../test';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { createBureauHandler } from './create-bureau-handler.ts';
import type { AgentDefinitions } from '../agent-catalog';
import { MemoryStorage } from '@lostgradient/storage';

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

async function buildBureau(
  options: {
    id?: string;
    agents?: string[];
    persist?: boolean;
    assets?: boolean;
    durable?: boolean;
  } = {},
) {
  const agents = Object.fromEntries(
    (options.agents ?? []).map((name) => [
      name,
      createAgent({ generate: createMockGenerate([]), name }),
    ]),
  );
  return createBureau<AgentDefinitions>({
    ...(options.id === undefined ? {} : { id: options.id }),
    agents: { ...agents, default: createAgent({ generate }) },
    ...(options.persist === true || options.durable === true
      ? { storage: new MemoryStorage() }
      : {}),
    ...(options.durable === true ? { durable: true } : {}),
    // The handler serves the asset operations, so it needs the service behind them.
    ...(options.assets === false ? {} : { assets: { storage: createMemoryAssetStorage() } }),
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

  it.each(['cors', 'rateLimitKey', 'limits'])(
    'does not accept the deferred option %s',
    async (name) => {
      await withBureau({}, (bureau) => {
        expect(() =>
          createBureauHandler(bureau, { unauthenticatedAccess: 'allow', [name]: {} } as never),
        ).toThrow(`unknown option "${name}"`);
      });
    },
  );

  it('refuses A2A options that are malformed, or that need publicUrl without it (COR-903)', async () => {
    await withBureau({ id: 'a2a-bureau', durable: true }, (bureau) => {
      const build = (options: Record<string, unknown>) => () =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'allow', ...options } as never);
      expect(build({ publicUrl: 'not a url' })).toThrow(/publicUrl must be an absolute http/);
      expect(build({ publicUrl: 'https://example.test/?x=1' })).toThrow(/no query or fragment/);
      expect(build({ publicUrl: 'ftp://example.test' })).toThrow(/http or https/);
      expect(build({ discoveryUrl: 'https://example.test' })).toThrow(
        /discoveryUrl needs publicUrl/,
      );
      expect(build({ signing: {} })).toThrow(/signing needs publicUrl/);
      expect(build({ publicUrl: 'https://example.test', discoveryUrl: 'nope' })).toThrow(
        /discoveryUrl must be an absolute http/,
      );
      expect(build({ publicUrl: 'https://example.test' })).not.toThrow();
    });
  });

  it('refuses publicUrl over a Bureau with no durable engine, whose sends could create no task (COR-903)', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          publicUrl: 'https://example.test',
        }),
      ).toThrow(/publicUrl needs a Bureau with a durable engine/);
    });
  });

  it('refuses to serve A2A over a task retention shorter than a send binding is kept (COR-903)', async () => {
    await withBureau({}, (bureau) => {
      const retaining = (taskRetention: TestBureau['internals']['taskRetention']) => () =>
        createBureauHandler(
          Object.create(bureau, {
            internals: {
              value: { ...bureau.internals, taskRetention, hasDurableEngine: true },
            },
          }) as TestBureau,
          { unauthenticatedAccess: 'allow', publicUrl: 'https://example.test' },
        );
      expect(bureau.internals.taskRetention).toEqual({ olderThan: 30 * 86_400_000 });
      expect(retaining({ olderThan: 86_399_999 })).toThrow(/retention.tasks window to be at least/);
      expect(retaining({ olderThan: 86_400_000 })).not.toThrow();
      expect(retaining('forever')).not.toThrow();
    });
  });

  it('rejects an unauthenticatedAccess value that is neither reject nor allow', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'maybe' } as never),
      ).toThrow(/unauthenticatedAccess must be/);
    });
  });

  it('throws at construction when the Bureau has no asset service', async () => {
    await withBureau({ assets: false }, (bureau) => {
      expect(() => createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toThrow(
        /assets/,
      );
    });
  });

  it.each([0, -1, 1.5, Number.NaN, '1024'])(
    'rejects a maxRequestBodyBytes that is not a positive integer (%p)',
    async (value) => {
      await withBureau({}, (bureau) => {
        expect(() =>
          createBureauHandler(bureau, {
            unauthenticatedAccess: 'allow',
            maxRequestBodyBytes: value,
          } as never),
        ).toThrow(/maxRequestBodyBytes must be a positive integer/);
      });
    },
  );

  it('answers 413 to a JSON-RPC body over maxRequestBodyBytes', async () => {
    await withBureau({}, async (bureau) => {
      const handler = createBureauHandler(bureau, {
        unauthenticatedAccess: 'allow',
        maxRequestBodyBytes: 100,
      });

      const small = await handler(jsonRpc('bureau.reviews.list', {}));
      const large = await handler(jsonRpc('bureau.reviews.list', { padding: 'x'.repeat(200) }));

      expect(small.status).toBe(200);
      expect(large.status).toBe(413);
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

describe('createBureauHandler a2aAgents', () => {
  it('accepts names that exist in the agent catalog', async () => {
    await withBureau({ agents: ['support', 'triage-2'] }, (bureau) => {
      expect(
        typeof createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          a2aAgents: ['support', 'triage-2'],
        }),
      ).toBe('function');
    });
  });

  it('throws for a name that is not in the agent catalog', async () => {
    await withBureau({ agents: ['support'] }, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, { unauthenticatedAccess: 'allow', a2aAgents: ['ghost'] }),
      ).toThrow(/"ghost", which is not in the Bureau's agent catalog/);
    });
  });

  it.each(['Support', 'support_', '-support', 'support-', 'sup port', 'a/b', ''])(
    'throws for the name %p, which is not a path segment',
    async (name) => {
      await withBureau({}, (bureau) => {
        expect(() =>
          createBureauHandler(bureau, { unauthenticatedAccess: 'allow', a2aAgents: [name] }),
        ).toThrow(/must match/);
      });
    },
  );

  it('throws when a2aAgents is not an array', async () => {
    await withBureau({}, (bureau) => {
      expect(() =>
        createBureauHandler(bureau, {
          unauthenticatedAccess: 'allow',
          a2aAgents: 'support' as never,
        }),
      ).toThrow(/a2aAgents must be an array/);
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
      expect(bureau.internals.kv).toBeDefined();
      expect(bureau.internals.hasExplicitId).toBe(false);
      expect(() => createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toThrow(
        /without an explicit `id`/,
      );
    });
  });

  it('serves a persistent Bureau that has an explicit id', async () => {
    await withBureau({ persist: true, id: 'persistent-bureau' }, (bureau) => {
      expect(bureau.internals.hasExplicitId).toBe(true);
      expect(typeof createBureauHandler(bureau, { unauthenticatedAccess: 'allow' })).toBe(
        'function',
      );
    });
  });

  it('serves an ephemeral Bureau without an explicit id', async () => {
    await withBureau({}, (bureau) => {
      expect(bureau.internals.kv).toBeUndefined();
      expect(bureau.internals.hasExplicitId).toBe(false);
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
        'bureau.agents.definitions.revisions',
        'bureau.agents.definitions.update',
        'bureau.agents.list',
        'bureau.agents.models',
        'bureau.agents.versions.list',
        'bureau.agents.versions.restore',
        'bureau.assets.get',
        'bureau.assets.uploads.append',
        'bureau.assets.uploads.complete',
        'bureau.assets.uploads.create',
        'bureau.audit.query',
        'bureau.contexts.delete',
        'bureau.contexts.fork',
        'bureau.contexts.get',
        'bureau.contexts.input',
        'bureau.contexts.list',
        'bureau.contexts.steer',
        'bureau.decisions.decide',
        'bureau.deployment.get',
        'bureau.diagnostics.get',
        'bureau.events',
        'bureau.goals.cancel',
        'bureau.goals.create',
        'bureau.goals.get',
        'bureau.goals.list',
        'bureau.memory.correct',
        'bureau.memory.forget',
        'bureau.memory.get',
        'bureau.memory.list',
        'bureau.memory.search',
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
        'bureau.settings.events',
        'bureau.settings.get',
        'bureau.settings.schema',
        'bureau.settings.update',
        'bureau.tasks.cancel',
        'bureau.tasks.events',
        'bureau.tasks.get',
        'bureau.tasks.inspect',
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
        'operative.runs.events',
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
      bureau.internals.eventFeed.publish(new RunRegisteredEvent('run-1'));
      bureau.internals.eventFeed.publish(new RunRemovedEvent('run-1'));
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
      bureau.internals.eventFeed.publish(new RunRemovedEvent('run-1'));
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

  it('streams the newly published event families over bureau.events', async () => {
    await withBureau({ id: 'event-families-bureau' }, async (bureau) => {
      const handler = createBureauHandler(bureau, { authentication: allScopes });
      const response = await handler(
        get('/v1/subscriptions/bureau.events?bureauId=event-families-bureau', {
          ...credentials,
          Accept: 'text/event-stream',
        }),
      );
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const events = [
        new SessionCreatedEvent('session-1', 'agent', 'incarnation-1', 1, 100),
        new ScheduleAttemptedEvent('schedule-1', 200),
        new SteeringAcceptedEvent('session-1', 'command-1', 2),
        new RunAbortSettledEvent('run-1'),
      ];
      for (const event of events) {
        bureau.internals.eventFeed.publish(event);
        while (!text.includes(`event: ${event.type}`)) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      }
      await reader.cancel();
      for (const event of events) expect(text).toContain(`event: ${event.type}`);
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
    const bureau = await createBureau<AgentDefinitions>({
      agents: {
        default: createAgent({ generate }),
      },
      assets: { storage: createMemoryAssetStorage() },
    });
    try {
      const run = await bureau.tasks.start('default', 'hello');
      await waitForCondition(
        () => bureau.internals.runEventFeeds.get(run.id) !== undefined,
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

describe('createBureauHandler WebSocket transport', () => {
  it('refuses a bad API key before calling server.upgrade', async () => {
    await withBureau({ id: 'websocket-auth-bureau' }, async (bureau) => {
      const handler = createBureauHandler(bureau, { authentication: allScopes });
      let upgrades = 0;
      const upgraded = await handler.upgrade(
        new Request('http://localhost/jsonrpc', { headers: { 'X-API-Key': 'wrong-key' } }),
        { upgrade: () => ((upgrades += 1), true) },
      );
      expect(upgraded).toBe(false);
      expect(upgrades).toBe(0);
    });
  });

  it('serves bureau.events over a real authenticated WebSocket', async () => {
    await withBureau({ id: 'websocket-bureau' }, async (bureau) => {
      bureau.internals.eventFeed.publish(new RunRegisteredEvent('run-1'));
      bureau.internals.eventFeed.publish(new RunRemovedEvent('run-1'));
      const handler = createBureauHandler(bureau, { authentication: allScopes });
      const server = Bun.serve({
        port: 0,
        fetch: async (request) => {
          if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            if (await handler.upgrade(request, server)) return undefined;
          }
          return handler(request);
        },
        websocket: handler.websocket,
      });
      try {
        const socket = new WebSocket(`ws://localhost:${server.port}/jsonrpc`, {
          headers: credentials,
        } as never);
        const frames: Array<Record<string, unknown>> = [];
        const delivered = new Promise<Record<string, unknown>>((resolve, reject) => {
          socket.addEventListener('message', (event) => {
            const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
            frames.push(parsed);
            if (parsed['method'] === 'weft.events.deliver') resolve(parsed);
          });
          socket.addEventListener('error', () => reject(new Error('WebSocket failed')));
        });
        await new Promise<void>((resolve) => socket.addEventListener('open', () => resolve()));
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'bureau.events',
            params: { bureauId: bureau.id, kinds: ['run.registered'] },
          }),
        );
        expect(await delivered).toMatchObject({
          method: 'weft.events.deliver',
          params: {
            envelope: { kind: 'run.registered', payload: { runId: 'run-1' } },
          },
        });
        expect(frames[0]).toMatchObject({
          id: 1,
          result: { subscriptionId: expect.any(String) },
        });
        expect(frames).toHaveLength(2);
        const deliveredFrame = frames.find((frame) => frame['method'] === 'weft.events.deliver')!;
        const subscriptionId = (deliveredFrame['params'] as { subscriptionId: string })
          .subscriptionId;
        expect(subscriptionId).toEqual(expect.any(String));
        const unsubscribed = new Promise<Record<string, unknown>>((resolve) => {
          const listener = (event: MessageEvent) => {
            const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
            if (parsed['id'] !== 2) return;
            socket.removeEventListener('message', listener);
            resolve(parsed);
          };
          socket.addEventListener('message', listener);
        });
        socket.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'weft.workflows.unsubscribe',
            params: { subscriptionId },
          }),
        );
        expect(await unsubscribed).toMatchObject({ id: 2, result: {} });
        const run = await bureau.tasks.start('default', 'hello');
        await waitForCondition(
          () => bureau.internals.runEventFeeds.get(run.id) !== undefined,
          'expected a run feed for the WebSocket cursor check',
        );
        for (const [id, method, params] of [
          [3, 'bureau.events', { bureauId: bureau.id, fromCursor: 'malformed' }],
          [4, 'operative.runs.events', { runId: run.id, fromCursor: 'malformed' }],
        ] as const) {
          const response = new Promise<Record<string, unknown>>((resolve) => {
            const listener = (event: MessageEvent) => {
              const parsed = JSON.parse(String(event.data)) as Record<string, unknown>;
              if (parsed['id'] !== id) return;
              socket.removeEventListener('message', listener);
              resolve(parsed);
            };
            socket.addEventListener('message', listener);
          });
          socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
          expect(await response).toMatchObject({
            id,
            error: { code: -32602, data: { weftCode: 'InvalidParams' } },
          });
        }
        socket.close();
      } finally {
        server.stop(true);
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
      'bureau.memory:read',
      'bureau.memory:write',
      'bureau.assets:read',
      'bureau.assets:write',
      'bureau.events:observe-all',
      'bureau.decisions:write',
      'bureau.settings:read',
      'bureau.settings:write',
      'bureau.diagnostics:read',
    ]);
  });
});
