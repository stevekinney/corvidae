import { OAuthStore, hostedOAuth } from '@lostgradient/mcp/oauth';
import { PostgresStorage } from '@lostgradient/storage-postgres';
import { createPostgresTestServer } from '@lostgradient/testing/postgres-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTool, createToolbox } from 'armorer';
import { createToolboxMcpHandler } from 'armorer/mcp/http';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';

test('independent approvals retain native tool access after one grant is revoked on another host', async () => {
  await using database = await createPostgresTestServer();
  const configuration = { url: database.url, table: 'connected_apps_tool_contract' };
  await using storageA = new PostgresStorage(configuration);
  await using storageB = new PostgresStorage(configuration);
  const storeA = new OAuthStore(storageA);
  const storeB = new OAuthStore(storageB);
  const verifier = 'a'.repeat(43);
  const identity = { subject: 'person', tenant: 'workspace' };
  const issuerConfiguration = {
    issuer: 'https://issuer.test',
    resource: 'https://issuer.test/mcp',
    scopes: ['read'],
    startingScopes: ['read'],
    scopeDescriptions: { read: 'Read assets' },
    identity: {
      session: async () => ({ ...identity, binding: 'session' }),
      signIn: async () => new Response(null, { status: 401 }),
      principalForGrant: async () => ({ delegableScopes: ['read'] }),
    },
  };
  const issuerA = hostedOAuth({ ...issuerConfiguration, store: storeA });
  const issuerB = hostedOAuth({ ...issuerConfiguration, store: storeB });
  const tokens: string[] = [];
  for (const [id, client] of [
    ['first', 'claude'],
    ['second', 'claude'],
    ['third', 'chatgpt'],
  ] as const) {
    const consent = {
      issuer: 'https://issuer.test',
      client,
      redirect: 'https://client.test/callback',
      csrf: 'csrf',
      binding: 'session',
      ...identity,
      challenge: createHash('sha256').update(verifier).digest('base64url'),
      expiresAt: Date.now() + 60_000,
      resource: 'https://issuer.test/mcp',
      scopes: ['read'],
      state: '',
    };
    const binding = {
      issuer: consent.issuer,
      client,
      csrf: consent.csrf,
      binding: consent.binding,
      subject: identity.subject,
    };
    expect(await storeA.createConsent(id, consent)).toBe(true);
    expect(
      await storeA.approveConsent(id, binding, {
        grantId: id,
        code: `code-${id}`,
        ...identity,
        resource: consent.resource,
        scopes: ['read'],
      }),
    ).toBe(true);
    expect(
      await storeB.exchange({
        issuer: consent.issuer,
        code: `code-${id}`,
        client,
        redirect: consent.redirect,
        resource: consent.resource,
        verifier,
        access: `access-${id}`,
        refresh: `refresh-${id}`,
        accessExpiresAt: Date.now() + 60_000,
        refreshExpiresAt: Date.now() + 60_000,
      }),
    ).toBe(true);
    tokens.push(`access-${id}`);
  }
  const tool = createTool({
    name: 'read',
    version: '1',
    description: 'Read assets',
    input: z.object({}),
    async execute() {
      return 'asset';
    },
  });
  const endpoint = await createToolboxMcpHandler(createToolbox([tool]), {
    tools: [{ id: tool.id, name: 'equipment.read', scopes: ['read'] }],
    authorization: {
      origin: 'https://issuer.test',
      resourcePath: '/mcp',
      issuer: 'https://issuer.test',
      scopes: ['read'],
      verifyAccessToken: issuerB.verifyAccessToken,
      resolvePrincipal: async () => ({ delegableScopes: ['read'] }),
    },
    requestContext: () => ({
      authority: {
        principalId: 'person',
        tenantId: 'workspace',
        ownerId: 'person',
        capabilities: ['read'],
        authorizationRevision: '1',
      },
    }),
  });
  const server = Bun.serve({
    port: 0,
    fetch: (request) =>
      endpoint.fetch(new Request(new URL('/mcp', 'https://issuer.test'), request)),
  });
  const call = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${token}`);
        return fetch(url, { ...init, headers });
      },
    });
    const client = new Client({ name: 'fixture', version: '1' });
    try {
      await client.connect(transport);
      return await client.callTool({ name: 'equipment.read', arguments: {} });
    } finally {
      await client.close();
    }
  };
  try {
    expect(JSON.stringify(await call(tokens[0]!))).toContain('asset');
    expect(await issuerA.revokeConnectedApp(identity, 'first')).toBe(true);
    const denied = await fetch(new URL('/mcp', server.url), {
      headers: { authorization: `Bearer ${tokens[0]}` },
    });
    expect(denied.status).toBe(401);
    expect(JSON.stringify(await call(tokens[1]!))).toContain('asset');
    expect(JSON.stringify(await call(tokens[2]!))).toContain('asset');
  } finally {
    server.stop(true);
    await endpoint.close();
  }
});
