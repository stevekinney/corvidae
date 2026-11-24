import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { OAuthStore } from '../oauth-store.ts';
import { hostedOAuth } from './issuer.ts';

describe('hosted OAuth issuer', () => {
  test('configures a hosted profile with the catalog resource and scopes', async () => {
    using storage = new MemoryStorage();
    const store = new OAuthStore(storage);
    let assertions = 0;
    let subscribed = '';
    const profile = hostedOAuth({
      stores: store,
      defaultScopes: ['read'],
      scopeDescriptions: { read: 'Read' },
      subscribeGrantRevocation: (grantId) => {
        subscribed = grantId;
        return () => {};
      },
      identity: {
        assertStore: (actual) => {
          expect(actual).toBe(store);
          assertions++;
        },
        session: async () => null,
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => ({ delegableScopes: ['read'] }),
      },
    });
    const issuer = profile.configure({
      origin: 'https://issuer.test',
      resourcePath: '/app/api/mcp',
      scopes: ['read'],
    });
    const response = await issuer.handle(
      new Request('https://issuer.test/.well-known/oauth-authorization-server'),
    );
    expect(await response.json().then((result) => result.issuer)).toBe('https://issuer.test');
    expect(assertions).toBe(1);
    issuer.subscribeGrantRevocation?.('grant', () => {});
    expect(subscribed).toBe('grant');
    expect(() =>
      profile.configure({ origin: 'https://issuer.test', resourcePath: '/mcp', scopes: ['write'] }),
    ).toThrow();
  });
  test('registers, discovers, authorizes, exchanges, refreshes and revokes', async () => {
    using storage = new MemoryStorage();
    const issuer = hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read', 'write'],
      startingScopes: ['read', 'write'],
      scopeDescriptions: { read: 'Read', write: 'Write' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => ({ subject: 'subject', tenant: 'tenant', binding: 'session' }),
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => ({ delegableScopes: ['read'] }),
      },
    });
    const request = (path: string, init?: RequestInit) =>
      issuer.handle(new Request(`https://issuer.test${path}`, init));
    const metadataResponse = await request('/.well-known/oauth-authorization-server');
    const metadata = await metadataResponse.json();
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['client_secret_post', 'none']);
    const registration = await request('/oauth/register', {
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
    const parameters = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://client.test/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://issuer.test/mcp',
      state: 'state',
    });
    const page = await request(`/oauth/authorize?${parameters}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)?.[1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(transaction).toBeTruthy();
    expect(csrf).toBeTruthy();
    const approval = await request('/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        transaction: transaction!,
        csrf: csrf!,
        client_id: client.client_id,
        decision: 'approve',
      }),
    });
    expect(approval.status).toBe(302);
    const redirect = new URL(approval.headers.get('location')!);
    expect(redirect.searchParams.get('iss')).toBe('https://issuer.test');
    expect(redirect.searchParams.get('code')).toBeTruthy();
    const grants = [];
    for await (const [, value] of storage.scan('oauth:grant:'))
      grants.push(JSON.parse(new TextDecoder().decode(value)));
    expect(grants).toHaveLength(1);
    expect(grants[0].grantId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await issuer.listConnectedApps({ subject: 'subject', tenant: 'tenant' })).toEqual([
      expect.objectContaining({
        grantId: grants[0].grantId,
        clientName: 'Client',
        clientId: client.client_id,
        resource: 'https://issuer.test/mcp',
        approvedAt: expect.any(Number),
        permissions: [{ scope: 'read', description: 'Read', available: true }],
      }),
    ]);
    expect(await issuer.listConnectedApps({ subject: 'other', tenant: 'tenant' })).toEqual([]);
    expect(
      await issuer.revokeConnectedApp({ subject: 'other', tenant: 'tenant' }, grants[0].grantId),
    ).toBe(false);
    for await (const [key, bytes] of storage.scan('oauth:grant:')) {
      const oldGrant = JSON.parse(new TextDecoder().decode(bytes));
      delete oldGrant.approvedAt;
      await storage.put(key, new TextEncoder().encode(JSON.stringify(oldGrant)));
    }
    const oldInventory = await issuer.listConnectedApps({ subject: 'subject', tenant: 'tenant' });
    expect(oldInventory[0]?.approvedAt).toBeNull();
    const token = await request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: redirect.searchParams.get('code')!,
        redirect_uri: 'https://client.test/callback',
        code_verifier: verifier,
        resource: 'https://issuer.test/mcp',
      }),
    });
    expect(token.status).toBe(200);
    const credentials = await token.json();
    expect(credentials.scope).toBe('read');
    expect(credentials).not.toHaveProperty('grantId');
    expect(credentials).not.toHaveProperty('tenant');
    expect(credentials).not.toHaveProperty('clientId');
    const verified = await issuer.verifyAccessToken(credentials.access_token);
    expect(verified).toEqual(expect.objectContaining({ subject: 'subject', scopes: ['read'] }));
    const otherIssuer = hostedOAuth({
      issuer: 'https://other.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read', 'write'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read', write: 'Write' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => ({ subject: 'subject', tenant: 'tenant', binding: 'session' }),
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => ({ delegableScopes: ['read'] }),
      },
    });
    expect(await otherIssuer.verifyAccessToken(credentials.access_token)).toBeNull();
    const refreshRequest = () =>
      request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.client_id,
          refresh_token: credentials.refresh_token,
          resource: 'https://issuer.test/mcp',
        }),
      });
    const clock = spyOn(Date, 'now').mockReturnValue(verified!.expiresAt + 1);
    try {
      expect(await issuer.verifyAccessToken(credentials.access_token)).toBeNull();
      const refreshed = await refreshRequest();
      expect(refreshed.status).toBe(200);
      const next = await refreshed.json();
      expect(await issuer.verifyAccessToken(next.access_token)).not.toBeNull();
      const replay = await refreshRequest();
      expect(replay.status).toBe(400);
      expect(await issuer.verifyAccessToken(next.access_token)).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  test('consent failures and an approve/deny race never create partial grants', async () => {
    using storage = new MemoryStorage();
    let session = { subject: 'subject', tenant: 'tenant', binding: 'synthetic-backend-secret' };
    let allowed = true;
    const issuer = hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => session,
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => (allowed ? { delegableScopes: ['read'] } : null),
      },
    });
    const request = (path: string, init?: RequestInit) =>
      issuer.handle(new Request(`https://issuer.test${path}`, init));
    const registration = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: '<script>marker</script>',
        redirect_uris: ['https://client.test/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    const client = await registration.json();
    const verifier = 'synthetic-verifier-value'.repeat(2);
    const parameters = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://client.test/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://issuer.test/mcp',
    });
    const page = await request(`/oauth/authorize?${parameters}`, {
      headers: {
        authorization: 'Bearer synthetic-bearer-value',
        cookie: 'session=synthetic-cookie-value',
      },
    });
    const html = await page.text();
    expect(html).toContain('&lt;script&gt;marker&lt;/script&gt;');
    expect(html).not.toContain('<script>marker</script>');
    for (const secret of [
      'synthetic-bearer-value',
      'synthetic-cookie-value',
      verifier,
      'synthetic-backend-secret',
    ])
      expect(html).not.toContain(secret);
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)![1]!;
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
    const submit = (decision: string, submittedCsrf = csrf) =>
      request('/oauth/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          transaction,
          csrf: submittedCsrf,
          client_id: client.client_id,
          decision,
        }),
      });
    const csrfFailure = await submit('approve', 'wrong');
    expect(csrfFailure.status).toBe(400);
    session = { ...session, binding: 'other' };
    const bindingFailure = await submit('approve');
    expect(bindingFailure.status).toBe(400);
    session = { ...session, binding: 'synthetic-backend-secret' };
    allowed = false;
    const authorityFailure = await submit('approve');
    expect(authorityFailure.status).toBe(403);
    const count = async (prefix: string) => {
      let total = 0;
      for await (const _ of storage.scan(prefix)) total++;
      return total;
    };
    expect(await count('oauth:grant:')).toBe(0);
    expect(await count('oauth:code:')).toBe(0);
    allowed = true;
    const results = await Promise.all([submit('approve'), submit('deny')]);
    expect(results.filter((response) => response.status === 302)).toHaveLength(1);
    const accepted = results[0].status === 302;
    expect(await count('oauth:grant:')).toBe(accepted ? 1 : 0);
    expect(await count('oauth:code:')).toBe(accepted ? 1 : 0);
    const deniedPage = await request(`/oauth/authorize?${parameters}`);
    const deniedHtml = await deniedPage.text();
    const deniedTransaction = /name="transaction" value="([^"]+)"/.exec(deniedHtml)![1]!;
    const deniedCsrf = /name="csrf" value="([^"]+)"/.exec(deniedHtml)![1]!;
    const denied = await request('/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        transaction: deniedTransaction,
        csrf: deniedCsrf,
        client_id: client.client_id,
        decision: 'deny',
      }),
    });
    expect(denied.status).toBe(302);
    expect(await count('oauth:grant:')).toBe(accepted ? 1 : 0);
    expect(await count('oauth:code:')).toBe(accepted ? 1 : 0);
  });

  test('auth methods match discovery and failures do not disclose private inputs', async () => {
    using storage = new MemoryStorage();
    const secrets = [
      'synthetic-bearer-value',
      'synthetic-cookie-value',
      'synthetic-verifier-value',
      'synthetic-backend-secret',
    ];
    const issuer = hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => {
          throw new Error(secrets[3]);
        },
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => null,
      },
    });
    const request = (path: string, init?: RequestInit) =>
      issuer.handle(new Request(`https://issuer.test${path}`, init));
    const register = (method: 'none' | 'client_secret_post') =>
      request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://client.test/callback'],
          token_endpoint_auth_method: method,
        }),
      });
    const publicRegistration = await register('none');
    const confidentialRegistration = await register('client_secret_post');
    const publicClient = await publicRegistration.json();
    const confidential = await confidentialRegistration.json();
    const token = (clientId: string, secret?: string) =>
      request('/oauth/token', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Bearer ${secrets[0]}`,
          cookie: `session=${secrets[1]}`,
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          code: 'missing',
          code_verifier: secrets[2]!,
          resource: 'https://issuer.test/mcp',
          ...(secret ? { client_secret: secret } : {}),
        }),
      });
    const publicResult = await token(publicClient.client_id);
    const confidentialResult = await token(confidential.client_id, confidential.client_secret);
    const wrongSecretResult = await token(confidential.client_id, 'wrong');
    expect(publicResult.status).toBe(400);
    expect(confidentialResult.status).toBe(400);
    expect(wrongSecretResult.status).toBe(401);
    expect(confidential.client_secret_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const clock = spyOn(Date, 'now').mockReturnValue(confidential.client_secret_expires_at * 1000);
    try {
      const expiredSecret = await token(confidential.client_id, confidential.client_secret);
      expect(expiredSecret.status).toBe(401);
    } finally {
      clock.mockRestore();
    }
    const verifier = 'a'.repeat(43);
    const query = new URLSearchParams({
      client_id: publicClient.client_id,
      redirect_uri: 'https://client.test/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://issuer.test/mcp',
    });
    const logs: unknown[][] = [];
    const log = spyOn(console, 'log').mockImplementation((...values) => {
      logs.push(values);
    });
    const warn = spyOn(console, 'warn').mockImplementation((...values) => {
      logs.push(values);
    });
    const error = spyOn(console, 'error').mockImplementation((...values) => {
      logs.push(values);
    });
    try {
      const failure = await request(`/oauth/authorize?${query}`, {
        headers: { authorization: `Bearer ${secrets[0]}`, cookie: `session=${secrets[1]}` },
      });
      const tokenFailure = await token(publicClient.client_id);
      const output = `${await failure.text()} ${await tokenFailure.text()} ${JSON.stringify(logs)}`;
      expect(failure.status).toBe(500);
      for (const secret of secrets) expect(output).not.toContain(secret);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('rejects incorrect redirects, PKCE and resource before creating consent', async () => {
    using storage = new MemoryStorage();
    const issuer = hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => ({ subject: 'subject', tenant: 'tenant', binding: 'session' }),
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => ({ delegableScopes: ['read'] }),
      },
    });
    const registration = await issuer.handle(
      new Request('https://issuer.test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://client.test/callback'],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    const client = await registration.json();
    const valid = {
      client_id: client.client_id,
      redirect_uri: 'https://client.test/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://issuer.test/mcp',
    };
    for (const change of [
      { redirect_uri: 'https://client.test/callback/' },
      { code_challenge_method: 'plain' },
      { resource: 'https://other.test/mcp' },
    ]) {
      const result = await issuer.handle(
        new Request(
          `https://issuer.test/oauth/authorize?${new URLSearchParams({ ...valid, ...change })}`,
        ),
      );
      expect(result.status).toBe(400);
    }
    let count = 0;
    for await (const _ of storage.scan('oauth:consent:')) count++;
    expect(count).toBe(0);
  });

  test('snapshots identity callbacks before an authorization request awaits', async () => {
    using storage = new MemoryStorage();
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity = {
      scopes: ['read'],
      session: async () => {
        started();
        await resumed;
        return { subject: 'subject', tenant: 'tenant', binding: 'session' };
      },
      signIn: async () => new Response(null, { status: 401 }),
      async principalForGrant() {
        return { delegableScopes: this.scopes };
      },
    };
    const issuer = hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read', 'write'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read', write: 'Write' },
      store: new OAuthStore(storage),
      identity,
    });
    const registration = await issuer.handle(
      new Request('https://issuer.test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://client.test/callback'],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    const client = await registration.json();
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://client.test/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://issuer.test/mcp',
      scope: 'write',
    });
    const response = issuer.handle(new Request(`https://issuer.test/oauth/authorize?${query}`));
    await waiting;
    identity.principalForGrant = async () => ({ delegableScopes: ['write'] });
    release();
    const result = await response;
    expect(result.status).toBe(400);
  });

  test('captures the session identity before awaiting current authority', async () => {
    using storage = new MemoryStorage();
    let started!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = { subject: 'original-subject', tenant: 'tenant', binding: 'session' };
    const issuer = hostedOAuth({
      issuer: 'https://issuer.test',
      resource: 'https://issuer.test/mcp',
      scopes: ['read'],
      startingScopes: ['read'],
      scopeDescriptions: { read: 'Read' },
      store: new OAuthStore(storage),
      identity: {
        session: async () => session,
        signIn: async () => new Response(null, { status: 401 }),
        principalForGrant: async () => {
          started();
          await resumed;
          return { delegableScopes: ['read'] };
        },
      },
    });
    const registration = await issuer.handle(
      new Request('https://issuer.test/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: ['https://client.test/callback'],
          token_endpoint_auth_method: 'none',
        }),
      }),
    );
    const client = await registration.json();
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://client.test/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url'),
      code_challenge_method: 'S256',
      resource: 'https://issuer.test/mcp',
    });
    const response = issuer.handle(new Request(`https://issuer.test/oauth/authorize?${query}`));
    await waiting;
    session.subject = 'changed-subject';
    release();
    const result = await response;
    const html = await result.text();
    expect(html).toContain('original-subject');
    expect(html).not.toContain('changed-subject');
  });
});
