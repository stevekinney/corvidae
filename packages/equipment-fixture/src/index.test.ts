import { expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createFixture, fixtureScopes, publicRequest } from './index.ts';

test.each([
  ['/api/mcp', 'reader'],
  ['/mcp', 'reader'],
  ['/api/mcp', 'editor'],
  ['/mcp', 'editor'],
])('the fixture grants explicit scopes at %s to %s', async (path, subject) => {
  using fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async () => Response.json({
        issuer: 'https://identity.test',
        authorization_endpoint: 'https://identity.test/authorize',
        token_endpoint: 'https://identity.test/token',
        jwks_uri: 'https://identity.test/keys',
      }),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  void fetchMock;
  const fixture = createFixture(path, {
    origin: 'https://equipment.test',
    issuer: 'https://identity.test',
    reader: 'reader',
    editor: 'editor',
    clientId: 'client',
    clientSecret: 'secret',
    sqlitePath: ':memory:',
    port: 3000,
  });
  using storage = fixture.storage;
  const credential = 'test-session';
  await storage.put(
    `browser-sign-in:equipment_session:session:${createHash('sha256').update(credential).digest('hex')}`,
    new TextEncoder().encode(
      JSON.stringify({
        subjectId: subject,
        workspaceId: 'equipment',
        expires: Date.now() + 86400000,
        consentBinding: 'binding',
      }),
    ),
  );
  const request = (url: string, init?: RequestInit) =>
    fixture.oauth.handle(
      new Request(`https://equipment.test${url}`, {
        ...init,
        headers: { cookie: `equipment_session=${credential}`, ...init?.headers },
      }),
    );
  const registration = await request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: ['https://client.test/callback'],
      token_endpoint_auth_method: 'none',
    }),
  });
  const client = await registration.json();
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://client.test/callback',
    response_type: 'code',
    code_challenge: createHash('sha256').update('a'.repeat(43)).digest('base64url'),
    code_challenge_method: 'S256',
    resource: `https://equipment.test${path}`,
    scope: 'equipment:read equipment:write',
  });
  const response = await request(`/oauth/authorize?${query}`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain('<li>Read equipment</li>');
  expect(html.includes('<li>Rename equipment</li>')).toBe(subject === 'editor');
  const transaction = /name="transaction" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const post = (url: string, body: URLSearchParams) =>
    request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  const approval = await post(
    '/oauth/authorize',
    new URLSearchParams({ transaction, csrf, client_id: client.client_id, decision: 'approve' }),
  );
  expect(approval.status).toBe(302);
  const code = new URL(approval.headers.get('location')!).searchParams.get('code')!;
  const token = await post(
    '/oauth/token',
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: 'https://client.test/callback',
      code_verifier: 'a'.repeat(43),
      resource: `https://equipment.test${path}`,
    }),
  );
  expect(token.status).toBe(200);
  const credentials = await token.json();
  const scopes = subject === 'editor' ? ['equipment:read', 'equipment:write'] : ['equipment:read'];
  expect(credentials.scope).toBe(scopes.join(' '));
  const verified = await fixture.oauth.verifyAccessToken(credentials.access_token);
  expect(verified?.scopes).toEqual(scopes);
});

test('the synthetic role allowlist grants only each subject’s scopes', () => {
  expect(fixtureScopes('reader', 'reader', 'editor')).toEqual(['equipment:read']);
  expect(fixtureScopes('editor', 'reader', 'editor')).toEqual([
    'equipment:read',
    'equipment:write',
  ]);
  expect(fixtureScopes('other', 'reader', 'editor')).toBeNull();
  expect(() => fixtureScopes('same', 'same', 'same')).toThrow();
  expect(() => fixtureScopes('reader', 'reader', '')).toThrow();
});

test.each(['/api/mcp', '/mcp'])(
  'reconstructs the public URL for %s only for its own host',
  async (path) => {
    const incoming = new Request(`http://equipment.example.test${path}?state=one%2Ftwo`, {
      method: 'POST',
      headers: {
        host: 'equipment.example.test',
        origin: 'https://foreign.example',
        cookie: 'session=one',
        'x-forwarded-proto': 'http',
        forwarded: 'host=foreign.example',
      },
      body: 'payload',
    });
    const result = publicRequest(incoming, 'https://equipment.example.test');
    expect(result).toBeInstanceOf(Request);
    if (!(result instanceof Request)) throw new Error('Expected accepted request');
    expect(result.url).toBe(`https://equipment.example.test${path}?state=one%2Ftwo`);
    expect(result.method).toBe('POST');
    expect(result.headers.get('origin')).toBe('https://foreign.example');
    expect(result.headers.get('cookie')).toBe('session=one');
    expect(await result.text()).toBe('payload');
    expect(
      publicRequest(
        new Request('http://foreign.example/', { headers: { host: 'foreign.example' } }),
        'https://equipment.example.test',
      ),
    ).toBeInstanceOf(Response);
  },
);

test.each(['/api/mcp', '/mcp'])(
  'accepts the configured host over HTTP for %s and rejects other authorities',
  async (path) => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(incoming) {
        const request = publicRequest(incoming, 'https://equipment.example.test:8443');
        if (request instanceof Response) return request;
        return Response.json({ url: request.url, origin: request.headers.get('origin') });
      },
    });
    try {
      const accepted = await fetch(new URL(`${path}?key=value`, server.url), {
        headers: {
          host: 'equipment.example.test:8443',
          origin: 'https://foreign.example',
          'x-forwarded-host': 'foreign.example',
        },
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({
        url: `https://equipment.example.test:8443${path}?key=value`,
        origin: 'https://foreign.example',
      });
      const rejected = await fetch(new URL(path, server.url), {
        headers: { host: 'foreign.example', 'x-forwarded-host': 'equipment.example.test:8443' },
      });
      expect(rejected.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  },
);
