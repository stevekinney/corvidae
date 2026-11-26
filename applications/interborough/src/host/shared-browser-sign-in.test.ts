import { principalFromApiKey } from '@lostgradient/backchannel';
import type { BrowserSignInOptions } from '@lostgradient/credentials/browser-sign-in';
import { MemoryStorage } from '@lostgradient/storage';
import { expect, test } from 'bun:test';
import {
  createSharedBrowserSignIn,
  type SharedBrowserSignInOptions,
} from './shared-browser-sign-in.ts';

const options: SharedBrowserSignInOptions = {
  origin: 'https://settings.example',
  provider: new Promise<Awaited<BrowserSignInOptions['provider']>>(() => {}),
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
