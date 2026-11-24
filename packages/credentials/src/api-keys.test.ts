import { createProtectedHttpHandler } from '@lostgradient/mcp/http';
import { MemoryStorage } from '@lostgradient/storage';
import { createApplication } from '@lostgradient/velveteen/server';
import { createMCP, createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createApiKeys } from './api-keys.ts';

describe('API key request authentication', () => {
  it('does not persist extra caller-owned fields or expose the verifier to policy', async () => {
    using storage = new MemoryStorage();
    const policyInputs: unknown[] = [];
    const keys = createApiKeys({
      storage,
      authorizeManagement: async (_actor, request) => {
        policyInputs.push(request);
        return true;
      },
      resolveAuthority: async (identity) => {
        policyInputs.push(identity);
        return { ...identity, scopes: ['read'] };
      },
    });
    const key = await keys.issue('manager', {
      workspaceId: 'A',
      subject: 'service',
      label: 'sync',
      scopes: ['read'],
      secret: 'injected',
    } as never);
    await keys.rotate('manager', {
      workspaceId: 'A',
      subject: 'service',
      id: key.id,
      retiresAt: Date.now() + 10000,
    });
    const entries = await Array.fromAsync(storage.scan('api-keys:'));
    expect(
      JSON.stringify(entries.map(([, value]) => new TextDecoder().decode(value))),
    ).not.toContain('injected');
    expect(JSON.stringify(policyInputs)).not.toContain('verifier');
  });
  it('refuses invalid or ambiguous explicit credentials before consulting a session', async () => {
    using storage = new MemoryStorage();
    const keys = createApiKeys({
      storage,
      authorizeManagement: async () => true,
      resolveAuthority: async ({ workspaceId, subject }) => ({
        workspaceId,
        subject,
        scopes: ['inventory.equipment:read'],
      }),
    });
    const issued = await keys.issue('manager', {
      workspaceId: 'A',
      subject: 'warehouse',
      label: 'sync',
      scopes: ['inventory.equipment:read'],
    });
    let sessions = 0;
    const authenticate = keys.withSession(async () => {
      sessions++;
      return { session: true };
    });
    const invalid = await authenticate(
      new Request('https://example.test', {
        headers: { cookie: 'session=valid', 'x-api-key': 'invalid' },
      }),
    );
    const ambiguous = await authenticate(
      new Request('https://example.test', {
        headers: { 'x-api-key': issued.secret, authorization: 'Bearer token' },
      }),
    );
    expect(invalid).toBeInstanceOf(Response);
    expect(ambiguous).toBeInstanceOf(Response);
    expect(sessions).toBe(0);
    expect(
      await authenticate(
        new Request('https://example.test', { headers: { 'x-api-key': issued.secret } }),
      ),
    ).toMatchObject({
      workspaceId: 'A',
      subject: 'warehouse',
      scopes: ['inventory.equipment:read'],
    });
  });

  it('rejects a storage backend without conditional atomic batches before writes', () => {
    using storage = new MemoryStorage();
    const unsupported = Object.assign(Object.create(storage), {
      capabilities: () => ({ ...storage.capabilities(), conditionalBatch: false }),
    });
    expect(() =>
      createApiKeys({
        storage: unsupported,
        authorizeManagement: async () => true,
        resolveAuthority: async () => null,
      }),
    ).toThrow('Atomic conditional storage is required');
  });
});

it('keeps service keys out of an OAuth-only MCP route and nested app fetch', async () => {
  using storage = new MemoryStorage();
  const keys = createApiKeys({
    storage,
    authorizeManagement: async () => true,
    resolveAuthority: async ({ workspaceId, subject }) => ({
      workspaceId,
      subject,
      scopes: ['inventory.equipment:read'],
    }),
  });
  const key = await keys.issue('manager', {
    workspaceId: 'A',
    subject: 'warehouse',
    label: 'sync',
    scopes: ['inventory.equipment:read'],
  });
  const mcp = await createMCP(createToolbox([]));
  let dispatched = 0;
  const protectedMcp = createProtectedHttpHandler({
    origin: 'https://app.test',
    resourcePath: '/mcp',
    issuer: 'https://issuer.test',
    scopes: ['inventory.equipment:read'],
    verifyAccessToken: async (token) =>
      token === 'valid-grant'
        ? {
            issuer: 'https://issuer.test',
            audience: 'https://app.test/mcp',
            expiresAt: Date.now() + 60000,
            subject: 'human',
            scopes: ['inventory.equipment:read'],
          }
        : null,
    resolvePrincipal: async () => ({ delegableScopes: ['inventory.equipment:read'] }),
    dispatch: async (request) => {
      dispatched++;
      return mcp.fetch(request);
    },
  });
  let seen: string | null = 'not called';
  const app = await createApplication({
    generation: {
      directory: '.',
      manifest: {
        version: 1,
        basePath: '',
        routing: { version: 1, nodes: [], routes: [] },
        client: { file: 'client.js', url: '/client.js', stylesheets: [], nodes: {} },
        server: { file: 'server.js', nodes: {} },
        routes: {},
        assets: [],
        outputs: [],
      },
    },
    registry: {
      manifest: { version: 1, nodes: [], routes: [] },
      nodes: [],
      Root: {},
      render: () => ({ body: '', head: '' }),
    } as never,
    hooks: {
      handle: async ({ event, resolve }) => {
        if (event.url.pathname === '/mcp') return protectedMcp(event.request);
        return event.url.pathname === '/nested' ? event.fetch('/destination') : resolve();
      },
    },
    mounts: {
      '/destination': () => (request) => {
        seen = request.headers.get('x-api-key');
        return new Response('ok');
      },
    },
  });
  try {
    const refused = await app.fetch(
      new Request('https://app.test/mcp', { headers: { 'x-api-key': key.secret } }),
    );
    expect(refused.status).toBe(401);
    expect(dispatched).toBe(0);
    const accepted = await app.fetch(
      new Request('https://app.test/mcp', {
        method: 'POST',
        headers: {
          authorization: 'Bearer valid-grant',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      }),
    );
    expect(accepted.status).toBe(200);
    expect(dispatched).toBe(1);
    const nested = await app.fetch(
      new Request('http://app.test/nested', { headers: { 'x-api-key': key.secret } }),
    );
    expect(nested.status).toBe(200);
    expect(seen).toBeNull();
  } finally {
    await app.dispose();
    await mcp.close();
  }
});
