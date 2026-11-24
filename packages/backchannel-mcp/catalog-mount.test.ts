import { defineOperation, principalFromApiKey } from '@lostgradient/backchannel';
import { mountCatalog } from '@lostgradient/backchannel-mcp/velveteen';
import { externalOAuth, hostedOAuth, OAuthStore } from '@lostgradient/mcp/oauth';
import { MemoryStorage } from '@lostgradient/storage';
import { createApplication } from '@lostgradient/velveteen/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';

test('mounts a hosted issuer and catalog in a Velveteen app', async () => {
  using storage = new MemoryStorage();
  let currentName = 'Camera';
  let writes = 0;
  let revocations = 0;
  let subscriptions = 0;
  let role = 'reader';
  const principal = principalFromApiKey({
    subject: 'user',
    scopes: ['equipment:read', 'equipment:write'],
  });
  const read = defineOperation({
    name: 'equipment.lookup',
    summary: 'Lookup',
    destructive: false,
    mcpExposable: true,
    inputSchema: z.object({}),
    outputSchema: z.object({ name: z.string() }),
    access: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['equipment:read'] },
    },
    transports: {
      http: false,
      jsonRpcHttp: true,
      jsonRpcWebSocket: false,
      jsonRpcStdio: false,
    },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({ name: currentName }),
  });
  const write = defineOperation({
    name: 'equipment.rename',
    summary: 'Rename',
    destructive: true,
    mcpExposable: true,
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ name: z.string() }),
    access: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['equipment:write'] },
    },
    transports: {
      http: false,
      jsonRpcHttp: true,
      jsonRpcWebSocket: false,
      jsonRpcStdio: false,
    },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async ({ input }) => {
      currentName = input.name;
      writes++;
      return { name: currentName };
    },
  });
  const authorization = hostedOAuth({
    stores: new OAuthStore(storage),
    notifyGrantRevoked: async () => {
      revocations++;
    },
    subscribeGrantRevocation: () => {
      subscriptions++;
      return () => {};
    },
    defaultScopes: ['equipment:read'],
    scopeDescriptions: {
      'equipment:read': 'Read equipment',
      'equipment:write': 'Rename equipment',
    },
    identity: {
      session: async () => ({
        subject: role,
        tenant: 'team',
        binding: 'session',
      }),
      signIn: async () => new Response(null, { status: 401 }),
      principalForGrant: async ({ subject }) => ({
        principal: principalFromApiKey({
          subject,
          scopes: subject === 'reader' ? ['equipment:read'] : ['equipment:read', 'equipment:write'],
        }),
        delegableScopes:
          subject === 'reader' ? ['equipment:read'] : ['equipment:read', 'equipment:write'],
      }),
    },
  });
  const routing = {
    version: 1,
    nodes: [
      {
        id: '/',
        directory: '',
        parentId: null,
        params: [],
        page: { component: 'page.svelte' },
      },
    ],
    routes: [
      {
        id: '/',
        pattern: '^/$',
        params: [],
        node: 0,
        leaf: 0,
        ancestors: [0],
        layouts: [],
        errors: [null],
      },
    ],
  };
  let starts = 0;
  let stops = 0;
  const catalog = mountCatalog({
    basePath: '/api',
    publicOrigin: 'https://equipment.example',
    operations: [read, write],
    host: {},
    authenticateApi: async (request) =>
      request.headers.get('x-session') === 'active'
        ? { method: 'api-key', principal }
        : new Response(null, { status: 401 }),
    mcp: { serverInfo: { name: 'equipment', version: '1' }, authorization },
  })['/api'];
  const app = await createApplication({
    generation: {
      directory: '.',
      manifest: {
        version: 1,
        basePath: '/app',
        routing,
        client: { file: '', url: '', stylesheets: [], nodes: {} },
        server: { file: '', nodes: {} },
        routes: {},
        assets: [],
        outputs: [],
      },
    } as never,
    registry: {
      manifest: routing,
      nodes: [{ page: async () => ({ default: {} }) }],
      Root: {},
      render: () => ({ body: 'equipment page', head: '' }),
    } as never,
    hooks: {
      handle: async ({ event, resolve }) =>
        event.url.pathname === '/app/internal'
          ? event.fetch(
              event.url.searchParams.get('path') ??
                '/.well-known/oauth-protected-resource/app/api/mcp',
              {
                method: event.request.method,
                headers: event.request.headers,
                body: event.request.body,
                duplex: 'half',
              } as RequestInit,
            )
          : resolve(),
    },
    mounts: {
      '/api': {
        rootPaths: catalog.rootPaths,
        start(base) {
          starts++;
          const service = catalog.start(base);
          return {
            fetch: service.fetch,
            close() {
              stops++;
              service.close();
            },
          };
        },
      },
      '/other-service': {
        rootPaths: () => ['/.well-known/unrelated'],
        start: () => () => new Response('other'),
      },
    },
  });
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://equipment.example${path}`, init));
  try {
    expect(starts).toBe(1);
    const metadata = await request('/.well-known/oauth-protected-resource/app/api/mcp').then(
      (result) => result.json(),
    );
    expect(metadata.resource).toBe('https://equipment.example/app/api/mcp');
    expect(metadata.authorization_servers).toEqual(['https://equipment.example']);
    expect(await request('/app/internal').then((result) => result.json())).toEqual(metadata);
    expect(await request('/.well-known/unrelated').then((result) => result.text())).toBe('other');
    expect(await request('/app/').then((result) => result.text())).toContain('equipment page');
    const rpc = await request('/app/api/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session': 'active' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'equipment.lookup',
        params: {},
      }),
    });
    expect(await rpc.json().then((result) => result.result)).toEqual({
      name: 'Camera',
    });
    const internalRpc = await request('/app/internal?path=%2Fapp%2Fapi%2Fjsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session': 'active' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'equipment.lookup',
        params: {},
      }),
    });
    expect(await internalRpc.json().then((result) => result.result)).toEqual({
      name: 'Camera',
    });
    const refusedRpc = await request('/app/api/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'equipment.lookup',
        params: {},
      }),
    });
    expect(refusedRpc.status).toBe(401);
    expect(
      await request('/.well-known/oauth-authorization-server').then((result) => result.status),
    ).toBe(200);
    const registration = await request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test client',
        redirect_uris: ['https://client.example/callback'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const client = await registration.json();
    const verifier = 'a'.repeat(43);
    const query = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://client.example/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: metadata.resource,
    });
    const page = await request(`/oauth/authorize?${query}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    const transaction = /name="transaction" value="([^"]+)"/.exec(html)![1];
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
    const formHeaders = {
      origin: 'https://equipment.example',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const approved = await request('/oauth/authorize', {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        transaction,
        csrf,
        client_id: client.client_id,
        decision: 'approve',
      }),
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const tokenResponse = await request('/oauth/token', {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: verifier,
        resource: metadata.resource,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json().then((result) => result.access_token);
    const transport = new StreamableHTTPClientTransport(new URL(metadata.resource), {
      fetch: (url, init) => {
        const incoming = new Request(url, init);
        const headers = new Headers(incoming.headers);
        headers.set('authorization', `Bearer ${token}`);
        return app.fetch(new Request(incoming, { headers }));
      },
    });
    const mcp = new Client({ name: 'test', version: '1' });
    await mcp.connect(transport);
    expect(
      await mcp
        .callTool({ name: 'equipment.lookup', arguments: {} })
        .then((result) => result.structuredContent),
    ).toEqual({ name: 'Camera' });
    const denied = await mcp.callTool({
      name: 'equipment.rename',
      arguments: { name: 'Tripod' },
    });
    expect(denied.isError).toBe(true);
    expect(denied._meta?.['mcp/www_authenticate']).toBeUndefined();
    expect(writes).toBe(0);
    await mcp.close();
    const internalTransport = new StreamableHTTPClientTransport(new URL(metadata.resource), {
      fetch: (url, init) => {
        const incoming = new Request(url, init);
        const headers = new Headers(incoming.headers);
        headers.set('authorization', `Bearer ${token}`);
        return app.fetch(
          new Request('https://equipment.example/app/internal?path=%2Fapp%2Fapi%2Fmcp', {
            method: incoming.method,
            headers,
            body: incoming.body,
            signal: incoming.signal,
            duplex: 'half',
          } as RequestInit),
        );
      },
    });
    const internalMcp = new Client({ name: 'internal-test', version: '1' });
    await internalMcp.connect(internalTransport);
    expect(
      await internalMcp
        .callTool({ name: 'equipment.lookup', arguments: {} })
        .then((result) => result.structuredContent),
    ).toEqual({ name: 'Camera' });
    await internalMcp.close();
    role = 'editor';
    query.set('scope', 'equipment:read equipment:write');
    const editorPage = await request(`/oauth/authorize?${query}`);
    expect(editorPage.status).toBe(200);
    const editorHtml = await editorPage.text();
    const editorTransaction = /name="transaction" value="([^"]+)"/.exec(editorHtml)![1];
    const editorCsrf = /name="csrf" value="([^"]+)"/.exec(editorHtml)![1];
    const editorApproval = await request('/oauth/authorize', {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        transaction: editorTransaction,
        csrf: editorCsrf,
        client_id: client.client_id,
        decision: 'approve',
      }),
    });
    expect(editorApproval.status).toBe(302);
    const editorCode = new URL(editorApproval.headers.get('location')!).searchParams.get('code')!;
    const editorTokenResponse = await request('/oauth/token', {
      method: 'POST',
      headers: formHeaders,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        code: editorCode,
        redirect_uri: 'https://client.example/callback',
        code_verifier: verifier,
        resource: metadata.resource,
      }),
    });
    expect(editorTokenResponse.status).toBe(200);
    const editorToken = await editorTokenResponse.json().then((result) => result.access_token);
    const editorTransport = new StreamableHTTPClientTransport(new URL(metadata.resource), {
      fetch: (url, init) => {
        const incoming = new Request(url, init);
        const headers = new Headers(incoming.headers);
        headers.set('authorization', `Bearer ${editorToken}`);
        return app.fetch(new Request(incoming, { headers }));
      },
    });
    const editor = new Client({ name: 'editor', version: '1' });
    await editor.connect(editorTransport);
    expect(
      await editor
        .callTool({
          name: 'equipment.rename',
          arguments: { name: 'Tripod' },
        })
        .then((result) => result.structuredContent),
    ).toEqual({ name: 'Tripod' });
    expect(
      await editor
        .callTool({ name: 'equipment.lookup', arguments: {} })
        .then((result) => result.structuredContent),
    ).toEqual({ name: 'Tripod' });
    expect(writes).toBe(1);
    await editor.close();
    currentName = 'Camera';
    writes = 0;
    const internalEditorTransport = new StreamableHTTPClientTransport(new URL(metadata.resource), {
      fetch: (url, init) => {
        const incoming = new Request(url, init);
        const headers = new Headers(incoming.headers);
        headers.set('authorization', `Bearer ${editorToken}`);
        return app.fetch(
          new Request('https://equipment.example/app/internal?path=%2Fapp%2Fapi%2Fmcp', {
            method: incoming.method,
            headers,
            body: incoming.body,
            signal: incoming.signal,
            duplex: 'half',
          } as RequestInit),
        );
      },
    });
    const internalEditor = new Client({
      name: 'internal-editor',
      version: '1',
    });
    await internalEditor.connect(internalEditorTransport);
    const renamedInternally = await internalEditor.callTool({
      name: 'equipment.rename',
      arguments: { name: 'Tripod' },
    });
    expect(renamedInternally.structuredContent).toEqual({ name: 'Tripod' });
    const readInternally = await internalEditor.callTool({
      name: 'equipment.lookup',
      arguments: {},
    });
    expect(readInternally.structuredContent).toEqual({ name: 'Tripod' });
    expect(writes).toBe(1);
    await internalEditor.close();
    const management = authorization.configure({
      origin: 'https://equipment.example',
      resourcePath: '/app/api/mcp',
      scopes: ['equipment:read', 'equipment:write'],
    });
    const readerGrants = await management.listConnectedApps({ subject: 'reader', tenant: 'team' });
    expect(readerGrants).toHaveLength(1);
    expect(
      await management.revokeConnectedApp(
        { subject: 'reader', tenant: 'team' },
        readerGrants[0].grantId,
      ),
    ).toBe(true);
    expect(revocations).toBe(1);
    expect(subscriptions).toBeGreaterThan(0);
    expect(
      await request('/oauth/revoke', {
        method: 'POST',
        headers: formHeaders,
        body: new URLSearchParams({ client_id: client.client_id, token }),
      }).then((result) => result.status),
    ).toBe(200);
  } finally {
    await app.dispose();
    expect(stops).toBe(1);
  }
});

test('serves an external authority through public and internal requests', async () => {
  let name = 'Camera';
  let renames = 0;
  const principal = principalFromApiKey({
    subject: 'user',
    scopes: ['equipment:read', 'equipment:write'],
  });
  const common = {
    mcpExposable: true,
    transports: {
      http: false,
      jsonRpcHttp: true,
      jsonRpcWebSocket: false,
      jsonRpcStdio: false,
    },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
  } as const;
  const lookup = defineOperation({
    ...common,
    name: 'equipment.lookup',
    summary: 'Lookup',
    destructive: false,
    inputSchema: z.object({}),
    outputSchema: z.object({ name: z.string() }),
    access: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['equipment:read'] },
    },
    invoke: async () => ({ name }),
  });
  const rename = defineOperation({
    ...common,
    name: 'equipment.rename',
    summary: 'Rename',
    destructive: true,
    inputSchema: z.object({ name: z.string() }),
    outputSchema: z.object({ name: z.string() }),
    access: {
      kind: 'scoped',
      scopes: { kind: 'allOf', scopes: ['equipment:write'] },
    },
    invoke: async ({ input }) => {
      name = input.name;
      renames++;
      return { name };
    },
  });
  const authority = externalOAuth({
    issuer: 'https://login.example',
    verifyAccessToken: async (token: string) => ({
      issuer: 'https://login.example',
      audience: 'https://equipment.example/app/api/mcp',
      expiresAt: Date.now() + 60000,
      subject: token,
      scopes: token === 'editor' ? ['equipment:read', 'equipment:write'] : ['equipment:read'],
    }),
    resolvePrincipal: async (grant) => ({
      principal,
      delegableScopes:
        grant.subject === 'reader' ? ['equipment:read'] : ['equipment:read', 'equipment:write'],
    }),
  });
  const routing = { version: 1, nodes: [], routes: [] };
  const app = await createApplication({
    generation: {
      directory: '.',
      manifest: {
        version: 1,
        basePath: '/app',
        routing,
        client: { file: '', url: '', stylesheets: [], nodes: {} },
        server: { file: '', nodes: {} },
        routes: {},
        assets: [],
        outputs: [],
      },
    } as never,
    registry: {
      manifest: routing,
      nodes: [],
      Root: {},
      render: () => ({ body: '', head: '' }),
    } as never,
    hooks: {
      handle: async ({ event, resolve }) =>
        event.url.pathname === '/app/internal'
          ? event.fetch(event.url.searchParams.get('path')!, {
              method: event.request.method,
              headers: event.request.headers,
              body: event.request.body,
              duplex: 'half',
            } as RequestInit)
          : resolve(),
    },
    mounts: mountCatalog({
      basePath: '/api',
      publicOrigin: 'https://equipment.example',
      operations: [lookup, rename],
      host: {},
      authenticateApi: async () => ({ method: 'api-key', principal }),
      mcp: {
        serverInfo: { name: 'equipment', version: '1' },
        authorization: authority,
      },
    }),
  });
  const request = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`https://equipment.example${path}`, init));
  try {
    const resource = '/.well-known/oauth-protected-resource/app/api/mcp';
    const metadata = await request(resource).then((result) => result.json());
    expect(metadata.authorization_servers).toEqual(['https://login.example']);
    expect(metadata.scopes_supported.toSorted()).toEqual(['equipment:read', 'equipment:write']);
    expect(
      await request(`/app/internal?path=${encodeURIComponent(resource)}`).then((result) =>
        result.json(),
      ),
    ).toEqual(metadata);
    expect(await request('/oauth/authorize').then((result) => result.status)).toBe(404);
    for (const internal of [false, true]) {
      name = 'Camera';
      renames = 0;
      const connect = async (token: string) => {
        const transport = new StreamableHTTPClientTransport(
          new URL('https://equipment.example/app/api/mcp'),
          {
            fetch: (url, init) => {
              const incoming = new Request(url, init);
              const headers = new Headers(incoming.headers);
              headers.set('authorization', `Bearer ${token}`);
              const target = internal
                ? 'https://equipment.example/app/internal?path=%2Fapp%2Fapi%2Fmcp'
                : incoming.url;
              return app.fetch(
                new Request(target, {
                  method: incoming.method,
                  headers,
                  body: incoming.body,
                  signal: incoming.signal,
                  duplex: 'half',
                } as RequestInit),
              );
            },
          },
        );
        const client = new Client({ name: 'test', version: '1' });
        await client.connect(transport);
        return client;
      };
      const reader = await connect('reader');
      expect(
        await reader
          .callTool({ name: 'equipment.lookup', arguments: {} })
          .then((result) => result.structuredContent),
      ).toEqual({ name: 'Camera' });
      const denied = await reader.callTool({
        name: 'equipment.rename',
        arguments: { name: 'Tripod' },
      });
      expect(denied.isError).toBe(true);
      expect(denied._meta?.['mcp/www_authenticate']).toBeUndefined();
      expect(renames).toBe(0);
      await reader.close();
      const editor = await connect('editor');
      expect(
        await editor
          .callTool({
            name: 'equipment.rename',
            arguments: { name: 'Tripod' },
          })
          .then((result) => result.structuredContent),
      ).toEqual({ name: 'Tripod' });
      expect(
        await editor
          .callTool({ name: 'equipment.lookup', arguments: {} })
          .then((result) => result.structuredContent),
      ).toEqual({ name: 'Tripod' });
      expect(renames).toBe(1);
      await editor.close();
    }
  } finally {
    await app.dispose();
  }
});
