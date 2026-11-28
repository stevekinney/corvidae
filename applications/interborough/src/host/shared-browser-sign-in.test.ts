import { principalFromApiKey, type Principal } from '@lostgradient/backchannel';
import type { BrowserSignInOptions } from '@lostgradient/credentials/browser-sign-in';
import { MemoryStorage } from '@lostgradient/storage';
import { expect, test } from 'bun:test';
import {
  createLocalA2aKeys,
  keySettingsAccessHandler,
  keySettingsMembership,
  localKeySettingsHandler,
} from './api-key-settings.ts';
import {
  createSharedBrowserSignIn,
  sharedBrowserRoutes,
  sharedBrowserServerHooks,
  type SharedBrowserSignInOptions,
} from './shared-browser-sign-in.ts';

const options: SharedBrowserSignInOptions = {
  origin: 'https://settings.example',
  provider: new Promise<Awaited<Extract<BrowserSignInOptions['provider'], Promise<unknown>>>>(
    () => {},
  ),
  resolveAccount: async () => null,
  scopes: async () => [],
  oauth: {
    resourcePath: '/bureau/mcp',
    scopes: ['reviews:read'],
    startingScopes: ['reviews:read'],
    scopeDescriptions: { 'reviews:read': 'Read reviews' },
    delegableScopes: async () => [],
    operationScopes: {},
  },
};
const workspace = { workspaceId: 'workspace', resolveMembership: async () => null };

test('only a current browser operator or the guarded local owner can manage keys', () => {
  const operator: Principal = {
    ...principalFromApiKey({ subject: 'operator', scopes: [] }),
    method: 'browser-session',
    workspace: {
      version: 1,
      workspaceId: 'workspace',
      actorId: 'operator',
      actorKind: 'user',
      owner: 'operator',
      membershipRevision: 'current',
      capabilities: ['workspace:use', 'workspace:manage'],
    },
  };
  const local: Principal = {
    ...operator,
    method: 'unauthenticated-local',
    workspace: {
      ...operator.workspace!,
      actorId: 'local-owner',
      actorKind: 'local',
      capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
    },
  };
  expect(keySettingsMembership(operator, 'shared')).toBe(operator.workspace);
  expect(keySettingsMembership(local, 'local')).toBe(local.workspace);
  expect(keySettingsMembership(operator, 'local')).toBeUndefined();
  expect(keySettingsMembership(local, 'shared')).toBeUndefined();
  expect(keySettingsMembership({ ...operator, method: 'api-key' }, 'shared')).toBeUndefined();
  expect(
    keySettingsMembership(
      { ...operator, workspace: { ...operator.workspace!, actorKind: 'service' } },
      'shared',
    ),
  ).toBeUndefined();
  expect(
    keySettingsMembership(
      { ...operator, workspace: { ...operator.workspace!, capabilities: ['workspace:use'] } },
      'shared',
    ),
  ).toBeUndefined();
});

test('key Settings access exposes an opaque scope and rechecks membership without caching', async () => {
  let principal: Exclude<Principal, { method: 'unauthenticated' }> = {
    ...principalFromApiKey({ subject: 'operator', scopes: [] }),
    method: 'browser-session',
    workspace: {
      version: 1,
      workspaceId: 'private-workspace',
      actorId: 'private-actor',
      actorKind: 'user',
      owner: 'private-owner',
      membershipRevision: 'current',
      capabilities: ['workspace:use', 'workspace:manage'],
    },
  };
  const handler = keySettingsAccessHandler(
    { authenticate: async () => ({ method: 'browser-session', principal }) },
    () => true,
  );
  const request = new Request('https://settings.example/host/api-keys/access');
  const allowed = await handler(request);
  const allowedText = await allowed.text();
  const initial = JSON.parse(allowedText);
  expect(allowed.headers.get('cache-control')).toBe('private, no-store');
  expect(initial).toEqual({ allowed: true, scope: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect(allowedText).not.toMatch(/private-|current|operator/u);

  principal = {
    ...principal,
    workspace: { ...principal.workspace!, membershipRevision: 'revised' },
  };
  const revised = await handler(request);
  expect(await revised.json()).not.toEqual(initial);

  principal = {
    ...principal,
    workspace: { ...principal.workspace!, capabilities: ['workspace:use'] },
  };
  const denied = await handler(request);
  expect(denied.headers.get('cache-control')).toBe('private, no-store');
  expect(await denied.json()).toEqual({ allowed: false });
});

test('the local API key route provisions only the durable A2A identity', async () => {
  using storage = new MemoryStorage();
  const workspaceId = 'local-workspace';
  const now = () => 1000;
  const principal: Principal = {
    ...principalFromApiKey({ subject: 'local-owner', scopes: [] }),
    method: 'unauthenticated-local',
    workspace: {
      version: 1,
      workspaceId,
      actorId: 'local-owner',
      actorKind: 'local',
      owner: 'anonymous:local',
      membershipRevision: 'current',
      capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
    },
  };
  const handle = localKeySettingsHandler({
    authority: { authenticate: async () => ({ method: 'unauthenticated-local', principal }) },
    keys: createLocalA2aKeys(storage, workspaceId, now),
    workspaceId,
    now,
  });
  async function call(method: string, params: unknown, origin = 'http://localhost:7829') {
    return handle(
      new Request('http://localhost:7829/host/api-keys/jsonrpc', {
        method: 'POST',
        headers: { host: 'localhost:7829', origin, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: method, method, params }),
      }),
    );
  }
  const input = { subject: 'a2a', label: 'Desktop caller', scopes: ['bureau.assets:read'] };
  const untrusted = await call('api.keys.issue', input, 'https://untrusted.example');
  expect(untrusted.status).toBe(403);
  const forbidden = await call('api.keys.issue', { ...input, subject: 'other' });
  const forbiddenBody = await forbidden.json();
  expect(forbiddenBody?.result).toBeUndefined();
  const issued = await call('api.keys.issue', input);
  expect(issued.headers.get('cache-control')).toBe('private, no-store');
  const { result } = await issued.json();
  if (typeof result?.secret !== 'string') throw new Error('No issued service key');
  const keys = createLocalA2aKeys(storage, workspaceId, now);
  expect(await keys.verify(result.secret)).toEqual({
    id: result.id,
    subject: 'a2a',
    workspaceId,
    scopes: ['bureau.assets:read'],
  });
  const listed = await call('api.keys.list', {});
  const list = await listed.text();
  expect(list.includes(result.secret)).toBe(false);
  const revoked = await call('api.keys.revoke', { id: result.id });
  const revokedBody = await revoked.json();
  expect(revokedBody.result).toEqual({ id: result.id, revoked: true });
  expect(await createLocalA2aKeys(storage, workspaceId, now).verify(result.secret)).toBeNull();
});

test('server-side private fetch refuses JSON-RPC mutations and malformed requests', async () => {
  const hooks = sharedBrowserServerHooks({} as never, options.origin, () => 1);
  const event = { request: new Request('https://settings.example/reviews') } as never;
  for (const body of ['{', JSON.stringify({ method: 'bureau.reviews.resolve', params: {} })]) {
    const response = await hooks.handleFetch!({
      event,
      request: new Request('https://settings.example/jsonrpc', { method: 'POST', body }),
      fetch: async () => {
        throw new Error('must not reach the network');
      },
    });
    expect(response.status).toBe(403);
  }
});

test('routes shared Reviews documents to the private server and local navigation to the shell', async () => {
  using storage = new MemoryStorage();
  const shared = createSharedBrowserSignIn(options, workspace, storage);
  const routes = sharedBrowserRoutes(
    shared,
    { fetch: async () => new Response('private') },
    async () => new Response('shell'),
  );
  if (!('/reviews' in routes)) throw new Error('Reviews route was not registered');
  const { GET: handler } = routes['/reviews'];
  const sharedResponse = await handler(
    new Request('http://127.0.0.1/reviews', { headers: { host: 'settings.example' } }),
  );
  expect(await sharedResponse.text()).toBe('private');
  const localResponse = await handler(
    new Request('http://127.0.0.1/reviews', { headers: { host: 'localhost' } }),
  );
  expect(await localResponse.text()).toBe('shell');
});

test('candidate assets coexist with the guarded private build and preserve private refusals', async () => {
  using storage = new MemoryStorage();
  const shared = createSharedBrowserSignIn(options, workspace, storage);
  const candidateRequests: string[] = [];
  const registered = sharedBrowserRoutes(
    shared,
    {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/private.js')) return new Response('private asset');
        if (path.endsWith('/refused.js')) return new Response(null, { status: 403 });
        return new Response(null, { status: 404 });
      },
    },
    async () => new Response('ordinary document'),
    (request) => {
      const path = new URL(request.url).pathname;
      candidateRequests.push(path);
      return path.endsWith('/candidate.js')
        ? new Response('candidate asset')
        : new Response(null, { status: 404 });
    },
  );
  if (!('/_assets/*' in registered)) throw new Error('Asset route was not registered');
  const { GET: asset } = registered['/_assets/*'] as {
    GET: (request: Request) => Promise<Response>;
  };
  const receive = (name: string, host = 'settings.example') =>
    asset(new Request(`http://127.0.0.1/_assets/${name}`, { headers: { host } }));

  const privateAsset = await receive('private.js');
  expect(await privateAsset.text()).toBe('private asset');
  const refused = await receive('refused.js');
  expect(refused.status).toBe(403);
  const candidate = await receive('candidate.js');
  expect(await candidate.text()).toBe('candidate asset');
  const localCandidate = await receive('candidate.js', 'localhost');
  expect(await localCandidate.text()).toBe('candidate asset');
  const missing = await receive('missing.js');
  expect(missing.status).toBe(404);
  expect(candidateRequests).toEqual([
    '/_assets/candidate.js',
    '/_assets/candidate.js',
    '/_assets/missing.js',
  ]);
});

test('shared browser composition requires HTTPS and refuses missing sessions', async () => {
  using storage = new MemoryStorage();
  expect(() =>
    createSharedBrowserSignIn({ ...options, origin: 'http://example.test' }, workspace, storage),
  ).toThrow();
  const shared = createSharedBrowserSignIn(options, workspace, storage);
  const request = new Request('http://127.0.0.1/bureau/v1/principal', {
    headers: { host: 'settings.example' },
  });
  expect(shared.matches(request)).toBe(true);
  expect(((await shared.authenticate(request)) as Response).status).toBe(401);
  for (const header of ['authorization', 'x-api-key']) {
    const credential = new Request('http://127.0.0.1/host/api-keys/jsonrpc', {
      method: 'POST',
      headers: { host: 'settings.example', [header]: 'credential' },
      body: '{}',
    });
    const refused = await shared.manageKeys(credential, async () => {
      throw new Error('must not authenticate machine credential');
    });
    expect(refused.status).toBe(403);
  }
});

test('connector tool calls require the explicit read mapping and granted scope', async () => {
  using storage = new MemoryStorage();
  expect(() =>
    createSharedBrowserSignIn(
      {
        ...options,
        oauth: { ...options.oauth, operationScopes: { 'bureau.tasks.cancel': 'reviews:read' } },
      },
      workspace,
      storage,
    ),
  ).toThrow();
  const shared = createSharedBrowserSignIn(
    {
      ...options,
      oauth: { ...options.oauth, operationScopes: { 'bureau.tasks.get': 'reviews:read' } },
    },
    workspace,
    storage,
  );
  const principal = {
    ...principalFromApiKey({ subject: 'member', scopes: ['reviews:read'] }),
    method: 'connector-token' as const,
  };
  const check = (name: string, destructive: boolean, scopes = principal.scopes) =>
    shared.scopeChallenge(
      { name, destructive } as never,
      {
        principal: { ...principal, scopes, hasScope: (scope: string) => scopes.has(scope) },
      } as never,
      {},
      new AbortController().signal,
    );
  expect(await check('bureau.tasks.get', false)).toBeUndefined();
  expect(await check('bureau.tasks.get', false, new Set())).toEqual({});
  expect(await check('bureau.tasks.cancel', false)).toEqual({});
  expect(await check('bureau.tasks.get', true)).toEqual({});
});
