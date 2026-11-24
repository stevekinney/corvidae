import { createProtectedHttpHandler } from '@lostgradient/mcp/http';
import { hostedOAuth, OAuthStore } from '@lostgradient/mcp/oauth';
import { MemoryStorage, scopedStorage } from '@lostgradient/storage';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { PostgresStorage } from '@lostgradient/storage-postgres';
import { createPostgresTestServer } from '@lostgradient/testing/postgres-server';
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from 'openid-client';
import { createBrowserSignIn } from './browser-sign-in.ts';

const base64 = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const json = (value: unknown) => base64(new TextEncoder().encode(JSON.stringify(value)));
const postgresServer = await createPostgresTestServer();
afterAll(async () => postgresServer[Symbol.asyncDispose]());

test('transaction deadlines preserve or reject writes on each supported store', async () => {
  using memory = new MemoryStorage();
  using sqlite = new BunSQLiteStorage(':memory:');
  await using postgres = new PostgresStorage({
    url: postgresServer.url,
    table: 'consent_deadlines',
  });
  for (const storage of [memory, sqlite, postgres]) {
    const value = new TextEncoder().encode('session');
    await storage.put('session', value);
    const conditions = [{ key: 'session', expectedValue: value }];
    const operations = [{ type: 'put' as const, key: 'grant', value }];
    expect(await storage.conditionalBatch(conditions, operations, Date.now() - 1000)).toBe(false);
    expect(await storage.get('grant')).toBeNull();
    expect(await storage.conditionalBatch(conditions, operations, Date.now() + 60_000)).toBe(true);
    expect(await storage.get('grant')).toEqual(value);
    expect(
      await storage.conditionalBatch([{ key: 'session', expectedValue: null }], operations),
    ).toBe(false);
  }
});

test('browser login resumes consent and connector authority stays separate', async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  let providerOrigin = '';
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/.well-known/openid-configuration')
        return Response.json({
          issuer: providerOrigin,
          authorization_endpoint: `${providerOrigin}/authorize`,
          token_endpoint: `${providerOrigin}/token`,
          jwks_uri: `${providerOrigin}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      if (url.pathname === '/jwks')
        return Response.json({ keys: [{ ...jwk, kid: 'key', alg: 'RS256', use: 'sig' }] });
      if (url.pathname === '/authorize') {
        const code = crypto.randomUUID();
        const redirect = url.searchParams.get('redirect_uri')!;
        codes.set(code, {
          nonce: url.searchParams.get('nonce')!,
          challenge: url.searchParams.get('code_challenge')!,
          redirect,
        });
        const callback = new URL(redirect);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', url.searchParams.get('state')!);
        return Response.redirect(callback, 302);
      }
      if (url.pathname !== '/token') return new Response(null, { status: 404 });
      const form = new URLSearchParams(await request.text());
      const code = form.get('code') ?? '';
      const grant = codes.get(code);
      codes.delete(code);
      if (
        !grant ||
        form.get('redirect_uri') !== grant.redirect ||
        (await client.calculatePKCECodeChallenge(form.get('code_verifier') ?? '')) !==
          grant.challenge
      )
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      const now = Math.floor(Date.now() / 1000);
      const payload = `${json({ alg: 'RS256', kid: 'key' })}.${json({ iss: providerOrigin, sub: 'person', aud: 'application', iat: now, exp: now + 600, nonce: grant.nonce })}`;
      const signature = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keys.privateKey,
        new TextEncoder().encode(payload),
      );
      return Response.json({
        access_token: 'provider-token',
        token_type: 'Bearer',
        id_token: `${payload}.${base64(new Uint8Array(signature))}`,
      });
    },
  });
  using providerCleanup = { [Symbol.dispose]: () => provider.stop(true) };
  void providerCleanup;
  providerOrigin = `http://127.0.0.1:${provider.port}`;
  const configuration = await client.discovery(
    new URL(providerOrigin),
    'application',
    { client_secret: 'secret' },
    undefined,
    { execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks] },
  );
  const directory = mkdtempSync(join(tmpdir(), 'browser-consent-'));
  using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };
  void cleanup;
  using database = new BunSQLiteStorage(join(directory, 'sessions.sqlite'));
  using secondDatabase = new BunSQLiteStorage(join(directory, 'sessions.sqlite'));
  let beforeCommit: (() => Promise<void>) | undefined;
  let expireApproval = false;
  const storage = new Proxy(database, {
    get(target, property) {
      if (property === 'conditionalBatch')
        return async (...args: Parameters<typeof database.conditionalBatch>) => {
          if (beforeCommit && args[1].some((operation) => operation.key.startsWith('oauth:grant:')))
            await beforeCommit();
          if (
            expireApproval &&
            args[1].some((operation) => operation.key.startsWith('oauth:grant:'))
          )
            args[2] = Date.now() - 1;
          return target.conditionalBatch(...args);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  let active = true;
  let activeWorkspace = 'workspace';
  let scopes = ['read', 'write'];
  let asset = 'Original';
  let appOrigin = '';
  let browser!: ReturnType<typeof createBrowserSignIn>;
  let browserIdentity!: ReturnType<typeof browser.oauthIdentity>;
  const issuerOrigin = 'https://app.test';
  const resource = `${issuerOrigin}/mcp`;
  const principal = async () => (active ? { delegableScopes: [...scopes] } : null);
  const store = new OAuthStore(storage);
  function createIssuer() {
    return hostedOAuth(issuerOptions);
  }
  let issuer!: ReturnType<typeof createIssuer>;
  let protectedHandler!: ReturnType<typeof createProtectedHttpHandler>;
  const app = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/auth/')) return browser.fetch(request);
      if (path === '/mcp' || path.startsWith('/.well-known/oauth-protected-resource'))
        return protectedHandler(request);
      return issuer.handle(request);
    },
  });
  using appCleanup = { [Symbol.dispose]: () => app.stop(true) };
  void appCleanup;
  appOrigin = `http://127.0.0.1:${app.port}`;
  browser = createBrowserSignIn({
    publicOrigin: appOrigin,
    storage,
    workspaceId: 'workspace',
    cookieName: 'session',
    provider: Promise.resolve(configuration),
    resolveAccount: async () => 'person',
    resolveMembership: async ({ workspaceId }) => (active ? { workspaceId } : null),
  });
  browserIdentity = browser.oauthIdentity(store, principal);
  const unsupportedStorage = new Proxy(database, {
    get(target, property) {
      if (property === 'capabilities')
        return () => ({ ...target.capabilities(), conditionalBatchDeadline: false });
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const unsupportedBrowser = createBrowserSignIn({
    publicOrigin: appOrigin,
    storage: unsupportedStorage,
    workspaceId: 'workspace',
    cookieName: 'session',
    provider: Promise.resolve(configuration),
    resolveAccount: async () => 'person',
    resolveMembership: async ({ workspaceId }) => (active ? { workspaceId } : null),
  });
  expect(() =>
    unsupportedBrowser.oauthIdentity(new OAuthStore(unsupportedStorage), principal),
  ).toThrow('transaction deadline support');
  const issuerOptions = {
    issuer: issuerOrigin,
    resource,
    scopes: ['read', 'write'],
    startingScopes: ['read'],
    scopeDescriptions: { read: 'Read assets', write: 'Rename assets' },
    store,
    identity: {
      ...browserIdentity,
      session: async (request: Request) => {
        const identity = await browserIdentity.session(request);
        return identity && { ...identity, tenant: activeWorkspace };
      },
    },
  };
  const distinctStorage = scopedStorage(database, 'other-namespace');
  expect(() => browser.oauthIdentity(new OAuthStore(distinctStorage), principal)).toThrow();
  expect(() => hostedOAuth({ ...issuerOptions, store: new OAuthStore(distinctStorage) })).toThrow();
  for await (const entry of distinctStorage.scan(''))
    throw new Error(`Unexpected record ${entry[0]}`);
  for await (const entry of storage.scan('')) throw new Error(`Unexpected record ${entry[0]}`);
  issuer = createIssuer();
  protectedHandler = createProtectedHttpHandler({
    origin: issuerOrigin,
    resourcePath: '/mcp',
    issuer: issuerOrigin,
    scopes: ['read', 'write'],
    verifyAccessToken: issuer.verifyAccessToken,
    resolvePrincipal: principal,
    async dispatch(request, context) {
      const operation = new URL(request.url).searchParams.get('operation');
      const decision = await context.requireScopes([operation === 'rename' ? 'write' : 'read']);
      if (!decision.ok) return decision.response;
      if (operation === 'rename') asset = 'Changed';
      return Response.json({ asset });
    },
  });
  const secondBrowser = createBrowserSignIn({
    publicOrigin: appOrigin,
    storage: secondDatabase,
    workspaceId: 'workspace',
    cookieName: 'session',
    provider: Promise.resolve(configuration),
    resolveAccount: async () => 'person',
    resolveMembership: async ({ workspaceId }) => (active ? { workspaceId } : null),
  });
  const secondApp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const incoming = new URL(request.url);
      return secondBrowser.fetch(
        new Request(new URL(incoming.pathname + incoming.search, appOrigin), request),
      );
    },
  });
  using secondAppCleanup = { [Symbol.dispose]: () => secondApp.stop(true) };
  void secondAppCleanup;
  const request = (path: string, init?: RequestInit) =>
    fetch(`${appOrigin}${path}`, { ...init, redirect: 'manual' });
  const discovery = await request('/mcp');
  expect(discovery.status).toBe(401);
  expect(discovery.headers.get('www-authenticate')).toContain(
    'resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp"',
  );
  const metadataResponse = await request('/.well-known/oauth-protected-resource/mcp');
  const metadata = await metadataResponse.json();
  expect(metadata.authorization_servers).toEqual([issuerOrigin]);
  const registration = await request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Connector',
      redirect_uris: ['https://client.test/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const registered = await registration.json();
  const verifier = 'a'.repeat(43);
  const parameters = new URLSearchParams({
    client_id: registered.client_id,
    redirect_uri: 'https://client.test/callback',
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource,
    scope: 'read',
    state: 'original-state',
  });
  const authorizationPath = `/oauth/authorize?${parameters}`;
  const start = await request(authorizationPath);
  expect(start.status).toBe(303);
  const loginCookie = start.headers.getSetCookie()[0].split(';')[0];
  const upstream = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = new URL(upstream.headers.get('location')!);
  const login = await request(callback.pathname + callback.search, {
    headers: { cookie: loginCookie },
  });
  expect(login.status).toBe(303);
  expect(login.headers.get('location')).toBe(`${appOrigin}${authorizationPath}`);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const form = async (sessionCookie = cookie) => {
    const response = await request(authorizationPath, { headers: { cookie: sessionCookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    for (const value of ['Connector', resource, 'person', 'workspace', 'Read assets'])
      expect(html).toContain(value);
    return new URLSearchParams({
      transaction: /name="transaction" value="([^"]+)"/.exec(html)![1],
      csrf: /name="csrf" value="([^"]+)"/.exec(html)![1],
      client_id: registered.client_id,
    });
  };
  const submit = (form: URLSearchParams, decision: string, sessionCookie = cookie) =>
    request('/oauth/authorize', {
      method: 'POST',
      headers: { cookie: sessionCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams([...form, ['decision', decision]]),
    });
  const count = async (prefix: string) => {
    let total = 0;
    for await (const ignored of storage.scan(prefix)) {
      void ignored;
      total++;
    }
    return total;
  };
  const pending = await form();
  const identity = await browser
    .oauthIdentity(store, principal)
    .session(new Request(appOrigin, { headers: { cookie } }));
  const retained = await store.getConsent(pending.get('transaction')!, {
    issuer: issuerOrigin,
    client: registered.client_id,
    csrf: pending.get('csrf')!,
    binding: identity!.binding,
    subject: identity!.subject,
  });
  expect(retained).toEqual(
    expect.objectContaining({
      client: registered.client_id,
      redirect: parameters.get('redirect_uri'),
      state: 'original-state',
      resource,
      scopes: ['read'],
      challenge: parameters.get('code_challenge'),
    }),
  );
  const otherStart = await request(authorizationPath);
  const otherUpstream = await fetch(otherStart.headers.get('location')!, { redirect: 'manual' });
  const otherCallback = new URL(otherUpstream.headers.get('location')!);
  const otherLogin = await request(otherCallback.pathname + otherCallback.search, {
    headers: { cookie: otherStart.headers.getSetCookie()[0].split(';')[0] },
  });
  const otherCookie = otherLogin.headers.getSetCookie()[0].split(';')[0];
  const wrongSession = await submit(pending, 'approve', otherCookie);
  expect(wrongSession.status).toBe(400);
  expect(await wrongSession.json()).toEqual({ error: 'invalid_request' });
  activeWorkspace = 'other-workspace';
  const wrongWorkspace = await submit(pending, 'approve');
  expect(wrongWorkspace.status).toBe(400);
  expect(await wrongWorkspace.json()).toEqual({ error: 'invalid_request' });
  activeWorkspace = 'workspace';
  const racing = await form(otherCookie);
  let entered!: () => void;
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  beforeCommit = async () => {
    entered();
    await resumed;
  };
  const approvalInFlight = submit(racing, 'approve', otherCookie);
  await waiting;
  const otherSession = await secondBrowser.currentSession(
    new Request(appOrigin, { headers: { cookie: otherCookie } }),
  );
  const racedSignout = await fetch(`http://127.0.0.1:${secondApp.port}/auth/sign-out`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: otherCookie, origin: appOrigin, 'x-csrf-token': otherSession!.csrfToken },
  });
  expect(racedSignout.status).toBe(303);
  resume();
  const racedApproval = await approvalInFlight;
  beforeCommit = undefined;
  expect(racedApproval.status).toBe(400);
  expect(await racedApproval.json()).toEqual({ error: 'invalid_request' });
  expect(racedApproval.headers.get('location')).toBeNull();
  expect(await count('oauth:grant:')).toBe(0);
  expect(await count('oauth:code:')).toBe(0);
  const denied = await submit(await form(), 'deny');
  expect(denied.status).toBe(302);
  const deniedUrl = new URL(denied.headers.get('location')!);
  expect(deniedUrl.origin + deniedUrl.pathname).toBe('https://client.test/callback');
  expect(deniedUrl.searchParams.get('error')).toBe('access_denied');
  expect(deniedUrl.searchParams.get('state')).toBe('original-state');
  expect(deniedUrl.searchParams.get('iss')).toBe(issuerOrigin);
  expect(deniedUrl.searchParams.has('code')).toBe(false);
  const reduced = await form();
  scopes = ['write'];
  const refused = await submit(reduced, 'approve');
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: 'access_denied' });
  expect(await count('oauth:grant:')).toBe(0);
  expect(await count('oauth:code:')).toBe(0);
  scopes = ['read', 'write'];
  const expiring = await form();
  expireApproval = true;
  const expired = await submit(expiring, 'approve');
  expireApproval = false;
  expect(expired.status).toBe(400);
  expect(await expired.json()).toEqual({ error: 'invalid_request' });
  expect(await count('oauth:grant:')).toBe(0);
  expect(await count('oauth:code:')).toBe(0);
  const approved = await submit(await form(), 'approve');
  expect(approved.status).toBe(302);
  const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
  const exchange = await request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: registered.client_id,
      code,
      redirect_uri: 'https://client.test/callback',
      code_verifier: verifier,
      resource,
    }),
  });
  expect(exchange.status).toBe(200);
  const token = await exchange.json();
  const bearer = token.access_token;
  const cookieOnly = await request('/mcp', { headers: { cookie } });
  expect(cookieOnly.status).toBe(401);
  expect(cookieOnly.headers.get('www-authenticate')).toContain('resource_metadata=');
  const auth = { authorization: `Bearer ${bearer}` };
  const lookup = await request('/mcp?operation=lookup', { headers: auth });
  expect(await lookup.json()).toEqual({
    asset: 'Original',
  });
  const rename = await request('/mcp?operation=rename', { headers: auth });
  expect(rename.status).toBe(403);
  expect(rename.headers.get('www-authenticate')).toContain('insufficient_scope');
  expect(asset).toBe('Original');
  const sessionCondition = identity!.sessionCondition;
  const sessionValue = sessionCondition.expectedValue;
  const sessionRecord = JSON.parse(new TextDecoder().decode(sessionValue));
  await storage.put(
    sessionCondition.key,
    new TextEncoder().encode(JSON.stringify({ ...sessionRecord, expires: Date.now() - 1 })),
  );
  expect(await browser.currentSession(new Request(appOrigin, { headers: { cookie } }))).toBeNull();
  const lookupAfterExpiry = await request('/mcp?operation=lookup', { headers: auth });
  expect(lookupAfterExpiry.status).toBe(200);
  expect(await lookupAfterExpiry.json()).toEqual({ asset: 'Original' });
  // Restore the fixture session so the separate sign-out case can exercise it.
  await storage.put(sessionCondition.key, sessionValue);
  const session = await browser.currentSession(new Request(appOrigin, { headers: { cookie } }));
  const signedOut = await request('/auth/sign-out', {
    method: 'POST',
    headers: { cookie, origin: appOrigin, 'x-csrf-token': session!.csrfToken },
  });
  expect(signedOut.status).toBe(303);
  const afterSignout = await submit(pending, 'approve');
  expect(afterSignout.status).toBe(400);
  expect(await afterSignout.json()).toEqual({ error: 'invalid_request' });
  expect(await count('oauth:grant:')).toBe(1);
  expect(await count('oauth:code:')).toBe(0);
  const lookupAfterSignout = await request('/mcp?operation=lookup', { headers: auth });
  expect(await lookupAfterSignout.json()).toEqual({
    asset: 'Original',
  });
  active = false;
  const revoked = await request('/mcp?operation=lookup', { headers: auth });
  expect(revoked.status).toBe(401);
  expect(await revoked.text()).toBe('');
});
