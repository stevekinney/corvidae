import { PostgresStorage } from '@lostgradient/storage-postgres';
import { createPostgresTestServer } from '@lostgradient/testing/postgres-server';
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createProtectedHttpHandler } from './http.ts';
import { OAuthStore } from './oauth-store.ts';
import { hostedOAuth } from './oauth/issuer.ts';

const database = await createPostgresTestServer();
afterAll(async () => {
  await database[Symbol.asyncDispose]();
});

test('consent, exchange, rotation and revocation survive separate PostgreSQL pools', async () => {
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
    accessExpiresAt: expiresAt,
    refreshExpiresAt: expiresAt,
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
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
        scopes: ['read'],
      }),
    ).toBe('rotated');
    expect(await first.createConsent('consent-race', consent)).toBe(true);
    const consentResults = await Promise.all([
      first.approveConsent('consent-race', binding, {
        ...approval,
        grantId: 'consent-race-grant',
        code: 'consent-race-code',
      }),
      second.denyConsent('consent-race', binding),
    ]);
    expect(consentResults.filter(Boolean)).toHaveLength(1);
    expect(await second.getGrant('consent-race-grant')).toEqual(
      consentResults[0] ? expect.objectContaining({ subject: 'subject' }) : null,
    );
    expect(await second.getCode('consent-race-code')).toEqual(
      consentResults[0] ? expect.objectContaining({ grantId: 'consent-race-grant' }) : null,
    );
    expect(await first.createConsent('replay', consent)).toBe(true);
    expect(
      await first.approveConsent('replay', binding, {
        ...approval,
        grantId: 'replay-grant',
        code: 'replay-code',
      }),
    ).toBe(true);
    expect(
      await second.exchange({
        ...exchange,
        code: 'replay-code',
        access: 'replay-access',
        refresh: 'replay-refresh',
      }),
    ).toBe(true);
    const rotation = {
      issuer: 'https://issuer.test',
      client: 'client',
      resource: approval.resource,
      refresh: 'replay-refresh',
      access: 'replay-next-access',
      nextRefresh: 'replay-next-refresh',
      accessExpiresAt: expiresAt,
      refreshExpiresAt: expiresAt,
      scopes: ['read'],
    };
    expect(await first.rotate(rotation)).toBe('rotated');
    expect(await second.rotate({ ...rotation, client: 'other' })).toBe('invalid');
    expect(await second.rotate({ ...rotation, resource: 'https://other.test' })).toBe('invalid');
    expect(await second.getAccess('replay-next-access')).not.toBeNull();
    expect(await second.rotate(rotation)).toBe('replay_revoked');
    expect(await first.getAccess('replay-next-access')).toBeNull();
    expect(await first.getAccess('rotated')).not.toBeNull();
    expect(await first.createConsent('collision', consent)).toBe(true);
    expect(
      await first.approveConsent('collision', binding, {
        ...approval,
        grantId: 'collision-grant',
        code: 'collision-code',
      }),
    ).toBe(true);
    expect(
      await second.exchange({
        ...exchange,
        code: 'collision-code',
        access: 'rotated',
        refresh: 'collision-refresh',
      }),
    ).toBe(false);
    expect(
      await first.exchange({
        ...exchange,
        code: 'collision-code',
        access: 'collision-access',
        refresh: 'collision-refresh',
      }),
    ).toBe(true);
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
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
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
        accessExpiresAt: expiresAt,
        refreshExpiresAt: expiresAt,
        scopes: ['read'],
      }),
    ).toBe('invalid');
  }
});

test('separate live issuers enforce grant and current authority across restart', async () => {
  const configuration = { url: database.url, table: 'oauth_issuer_contract' };
  await using firstStorage = new PostgresStorage(configuration);
  await using secondStorage = new PostgresStorage(configuration);
  let allowed = true;
  let delegableScopes = ['read'];
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
          return allowed ? { delegableScopes } : null;
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
  const originalGrant = await restarted.verifyAccessToken(tokens.access_token);
  const independentGrant = await restarted.verifyAccessToken(independent.access_token);
  expect(originalGrant).toEqual(
    expect.objectContaining({ tenant: 'tenant', clientId: client.client_id, subject: 'subject' }),
  );
  expect(independentGrant).toEqual(
    expect.objectContaining({ tenant: 'tenant', clientId: client.client_id, subject: 'subject' }),
  );
  expect(originalGrant?.grantId).toMatch(/^[0-9a-f-]{36}$/);
  expect(independentGrant?.grantId).toMatch(/^[0-9a-f-]{36}$/);
  expect(independentGrant?.grantId).not.toBe(originalGrant?.grantId);
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
  expect(await peer.verifyAccessToken(rotated.access_token)).toEqual(
    expect.objectContaining({
      grantId: originalGrant?.grantId,
      tenant: 'tenant',
      clientId: client.client_id,
      subject: 'subject',
    }),
  );
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
  delegableScopes = [];
  expect(await restarted.verifyAccessToken(independent.access_token)).toBeNull();
  const deniedDelegation = await request(peer, '/oauth/token', {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: independent.refresh_token,
      resource: 'https://issuer.test/mcp',
    }),
  });
  expect(deniedDelegation.status).toBe(400);
  delegableScopes = ['read'];
  expect(await peer.verifyAccessToken(independent.access_token)).not.toBeNull();
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
