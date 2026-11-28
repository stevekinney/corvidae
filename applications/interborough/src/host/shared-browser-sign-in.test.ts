import { principalFromApiKey } from '@lostgradient/backchannel';
import type { BrowserSignInOptions } from '@lostgradient/credentials/browser-sign-in';
import { MemoryStorage } from '@lostgradient/storage';
import { expect, test } from 'bun:test';
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
    {} as never,
    { fetch: async () => new Response('private') },
    async () => new Response('shell'),
  );
  if (!('/reviews' in routes)) throw new Error('Reviews route was not registered');
  const { GET: handler } = routes['/reviews'] as {
    GET: (request: Request) => Response | Promise<Response>;
  };
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
    {} as never,
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
    const credential = new Request('http://127.0.0.1/key-admin/jsonrpc', {
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
