import { PostgresStorage } from '@lostgradient/storage-postgres';
import { createPostgresTestServer } from '@lostgradient/testing/postgres-server';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createProtectedHttpHandler } from './http.ts';
import { OAuthStore } from './oauth-store.ts';
import { hostedOAuth } from './oauth/issuer.ts';

test('consent, exchange, rotation and revocation survive separate PostgreSQL pools', async () => {
  await using database = await createPostgresTestServer();
  const configuration = { url: database.url, table: 'oauth_contract' };
  const verifier = 'a'.repeat(43);
  const binding = {
    issuer: 'https://issuer.test',
    client: 'client',
    csrf: 'csrf',
    binding: 'session',
    subject: 'subject',
  };
  const consent = {
    ...binding,
    tenant: 'tenant',
    resource: 'https://resource.test',
    scopes: ['read'],
    state: '',
    redirect: 'https://client.test/callback',
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    expiresAt: Date.now() + 60_000,
  };
  const approval = {
    grantId: 'grant',
    code: 'code',
    tenant: 'tenant',
    subject: 'subject',
    resource: 'https://resource.test',
    scopes: ['read'],
  };
  const expiresAt = Date.now() + 60_000;
  const exchange = {
    code: 'code',
    issuer: 'https://issuer.test',
    client: 'client',
    redirect: consent.redirect,
    verifier,
    resource: approval.resource,
    access: 'access',
    refresh: 'refresh',
    expiresAt,
  };
  {
    await using storage = new PostgresStorage(configuration);
    const store = new OAuthStore(storage);
    expect(await store.createConsent('consent', consent)).toBe(true);
    expect(await store.approveConsent('consent', binding, approval)).toBe(true);
  }
  {
    await using firstStorage = new PostgresStorage(configuration);
    await using secondStorage = new PostgresStorage(configuration);
    const first = new OAuthStore(firstStorage);
    const second = new OAuthStore(secondStorage);
    const results = await Promise.all([
      first.exchange(exchange),
      second.exchange({ ...exchange, access: 'access-two', refresh: 'refresh-two' }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0]
      ? exchange
      : { ...exchange, access: 'access-two', refresh: 'refresh-two' };
    expect(await second.getAccess(winner.access)).toEqual(
      expect.objectContaining({
        subject: 'subject',
        tenant: 'tenant',
        issuer: 'https://issuer.test',
        client: 'client',
        resource: approval.resource,
        scopes: ['read'],
      }),
    );
    expect(
      await first.rotate({
        refresh: winner.refresh,
        issuer: 'https://issuer.test',
        client: 'client',
        resource: approval.resource,
        access: 'rotated',
        nextRefresh: 'next',
        expiresAt,
        scopes: ['read'],
      }),
    ).toBe('rotated');
    expect(await first.createConsent('race', consent)).toBe(true);
    expect(
      await first.approveConsent('race', binding, {
        ...approval,
        grantId: 'race-grant',
        code: 'race-code',
      }),
    ).toBe(true);
    await Promise.all([
      first.exchange({
        ...exchange,
        code: 'race-code',
        access: 'race-access',
        refresh: 'race-refresh',
      }),
      second.revokeGrant('race-grant'),
    ]);
    expect(await second.getAccess('race-access')).toBeNull();
    expect(
      await second.rotate({
        refresh: 'race-refresh',
        issuer: 'https://issuer.test',
        client: 'client',
        resource: approval.resource,
        access: 'race-next-access',
        nextRefresh: 'race-next-refresh',
        expiresAt,
        scopes: ['read'],
      }),
    ).toBe('invalid');
    expect(await first.createConsent('revoked', consent)).toBe(true);
    expect(
      await first.approveConsent('revoked', binding, {
        ...approval,
        grantId: 'revoked-grant',
        code: 'revoked-code',
      }),
    ).toBe(true);
    expect(await second.revokeGrant('revoked-grant')).toBe(true);
    expect(
      await first.exchange({
        ...exchange,
        code: 'revoked-code',
        access: 'revoked-access',
        refresh: 'revoked-refresh',
      }),
    ).toBe(false);
  }
  {
    await using storage = new PostgresStorage(configuration);
    const store = new OAuthStore(storage);
    expect(await store.getAccess('rotated')).not.toBeNull();
    expect(await store.revokeGrant('grant')).toBe(true);
    expect(await store.getAccess('rotated')).toBeNull();
    expect(
      await store.rotate({
        refresh: 'next',
        issuer: 'https://issuer.test',
        client: 'client',
        resource: approval.resource,
        access: 'later',
        nextRefresh: 'later-refresh',
        expiresAt,
        scopes: ['read'],
      }),
    ).toBe('invalid');
  }
});

test('separate live issuers enforce grant and current authority across restart', async () => {
  await using database = await createPostgresTestServer();
  const configuration = { url: database.url, table: 'oauth_issuer_contract' };
  await using firstStorage = new PostgresStorage(configuration);
  await using secondStorage = new PostgresStorage(configuration);
  let allowed = true;
  let authorityCalls = 0;
  let pauseAt = 0;
  let reached!: () => void;
  let release!: () => void;
  const reachedPause = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const makeIssuer = (storage: PostgresStorage) =>
    hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => ({ subject: 'subject', tenant: 'tenant', binding: 'session' }),
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => {
          authorityCalls++;
          if (authorityCalls === pauseAt) {
            reached();
            await resume;
          }
          return allowed ? { delegableScopes: ['read'] } : null;
        },
      },
    });
  const first = makeIssuer(firstStorage);
  const second = makeIssuer(secondStorage);
  const request = (issuer: ReturnType<typeof makeIssuer>, path: string, init?: RequestInit) =>
    issuer.handle(new Request(`https://issuer.test${path}`, init));
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const registration = await request(first, '/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Client',
      redirect_uris: ['https://client.test/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  expect(registration.status).toBe(201);
  const client = await registration.json();
  const verifier = 'a'.repeat(43);
  const authorize = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://client.test/callback',
    response_type: 'code',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://issuer.test/mcp',
  });
  const issueCode = async () => {
    const page = await request(first, `/oauth/authorize?${authorize}`);
    const html = await page.text();
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)![1]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const response = await request(second, '/oauth/authorize', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        transaction,
        csrf,
        client_id: client.client_id,
        decision: 'approve',
      }),
    });
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location')!).searchParams.get('code')!;
  };
  const exchange = (code: string) =>
    request(second, '/oauth/token', {
      method: 'POST',
      headers,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: 'https://client.test/callback',
        code_verifier: verifier,
        resource: 'https://issuer.test/mcp',
      }),
    });
  const code = await issueCode();
  const independentCode = await issueCode();
  await firstStorage[Symbol.asyncDispose]();
  const exchanged = await exchange(code);
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json();
  const independentResponse = await exchange(independentCode);
  const independent = await independentResponse.json();
  await secondStorage[Symbol.asyncDispose]();
  await using restartedStorage = new PostgresStorage(configuration);
  await using peerStorage = new PostgresStorage(configuration);
  const restarted = makeIssuer(restartedStorage);
  const peer = makeIssuer(peerStorage);
  const refresh = await request(restarted, '/oauth/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: 'https://issuer.test/mcp',
    }),
  });
  expect(refresh.status).toBe(200);
  const rotated = await refresh.json();
  let dispatches = 0;
  const protectedHttp = createProtectedHttpHandler({
    origin: 'https://issuer.test',
    resourcePath: '/mcp',
    issuer: 'https://issuer.test',
    scopes: ['read'],
    verifyAccessToken: peer.verifyAccessToken,
    resolvePrincipal: async () => ({ delegableScopes: ['read'] }),
    dispatch: async () => {
      dispatches++;
      return new Response('ok');
    },
  });
  const protectedRequest = () =>
    protectedHttp(
      new Request('https://issuer.test/mcp', {
        headers: { authorization: `Bearer ${rotated.access_token}` },
      }),
    );
  const beforeRevoke = await protectedRequest();
  expect(beforeRevoke.status).toBe(200);
  expect(await beforeRevoke.text()).toBe('ok');
  expect(dispatches).toBe(1);
  pauseAt = authorityCalls + 2;
  const racingAccess = protectedRequest();
  await reachedPause;
  const revoked = await request(restarted, '/oauth/revoke', {
    method: 'POST',
    headers,
    body: new URLSearchParams({ client_id: client.client_id, token: rotated.refresh_token }),
  });
  expect(revoked.status).toBe(200);
  expect(await new OAuthStore(restartedStorage).getAccess(rotated.access_token)).toBeNull();
  release();
  const afterRevoke = await racingAccess;
  expect(afterRevoke.status).toBe(401);
  expect(dispatches).toBe(1);
  expect(await restarted.verifyAccessToken(rotated.access_token)).toBeNull();
  expect(await restarted.verifyAccessToken(independent.access_token)).not.toBeNull();
  allowed = false;
  expect(await peer.verifyAccessToken(independent.access_token)).toBeNull();
  const deniedRefresh = await request(restarted, '/oauth/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: independent.refresh_token,
      resource: 'https://issuer.test/mcp',
    }),
  });
  expect(deniedRefresh.status).toBe(400);
});
