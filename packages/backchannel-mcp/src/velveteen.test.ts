import { defineOperation, principalFromApiKey } from '@lostgradient/backchannel';
import { externalOAuth } from '@lostgradient/mcp/oauth';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test } from 'bun:test';
import { z } from 'zod';
import { mountCatalog } from './velveteen.ts';

test('advertises a catalog resource through the shared mount', async () => {
  const read = defineOperation({
    name: 'equipment.lookup',
    summary: 'Lookup',
    destructive: false,
    mcpExposable: true,
    inputSchema: z.object({}),
    outputSchema: z.object({ name: z.string() }),
    access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['equipment:read'] } },
    transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
    unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
    invoke: async () => ({ name: 'Camera' }),
  });
  const principal = principalFromApiKey({ subject: 'user', scopes: ['equipment:read'] });
  const mounts = mountCatalog({
    basePath: '/api',
    publicOrigin: 'https://equipment.example',
    operations: [read],
    host: {},
    authenticateApi: async () => ({ method: 'api-key', principal }),
    mcp: {
      serverInfo: { name: 'equipment', version: '1' },
      authorization: externalOAuth({
        issuer: 'https://login.example',
        verifyAccessToken: async () => null,
        resolvePrincipal: async () => ({ principal, delegableScopes: ['equipment:read'] }),
      }),
    },
  });
  const group = mounts['/api']!;
  expect(group.rootPaths('/app')).toEqual(['/.well-known/oauth-protected-resource/app/api/mcp']);
  const service = group.start('/app');
  const response = await service(
    new Request('https://equipment.example/.well-known/oauth-protected-resource/app/api/mcp'),
  );
  expect(await response.json()).toEqual({
    resource: 'https://equipment.example/app/api/mcp',
    authorization_servers: ['https://login.example'],
    scopes_supported: ['equipment:read'],
  });
});

test.each(['modern', 'legacy'] as const)(
  'dispatches catalog tools with current authority (%s)',
  async (mode) => {
    let name = 'Camera';
    let renames = 0;
    const read = defineOperation({
      name: 'equipment.lookup',
      summary: 'Lookup',
      destructive: false,
      mcpExposable: true,
      inputSchema: z.object({}),
      outputSchema: z.object({ name: z.string() }),
      access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['equipment:read'] } },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => ({ name }),
    });
    const write = defineOperation({
      name: 'equipment.rename',
      summary: 'Rename',
      destructive: true,
      mcpExposable: true,
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ name: z.string() }),
      access: { kind: 'scoped', scopes: { kind: 'allOf', scopes: ['equipment:write'] } },
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async ({ input }) => {
        renames++;
        name = input.name;
        return { name };
      },
    });
    const principal = principalFromApiKey({
      subject: 'user',
      scopes: ['equipment:read', 'equipment:write'],
    });
    const authorization = externalOAuth({
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
    const group = mountCatalog({
      basePath: '/api',
      publicOrigin: 'https://equipment.example',
      operations: [read, write],
      host: {},
      authenticateApi: async () => ({ method: 'api-key', principal }),
      mcp: { serverInfo: { name: 'equipment', version: '1' }, authorization },
    })['/api']!;
    const service = group.start('/app');
    const clients: Client[] = [];
    async function connect(token: string) {
      const transport = new StreamableHTTPClientTransport(
        new URL('https://equipment.example/app/api/mcp'),
        {
          fetch: (url, init) => {
            const request = new Request(url, init);
            const target = new URL(request.url);
            target.pathname = '/mcp';
            const headers = new Headers(request.headers);
            headers.set('authorization', `Bearer ${token}`);
            return service(
              new Request(target, {
                method: request.method,
                headers,
                body: request.body,
                signal: request.signal,
                duplex: 'half',
              } as RequestInit),
            );
          },
        },
      );
      const client = new Client(
        { name: 'test', version: '1' },
        { versionNegotiation: { mode: mode === 'modern' ? { pin: '2026-07-28' } : 'legacy' } },
      );
      await client.connect(transport);
      clients.push(client);
      return client;
    }
    try {
      const reader = await connect('reader');
      const tools = await reader.listTools().then((result) => result.tools);
      expect(
        tools.find((tool) => tool.name === 'equipment.lookup')?._meta?.['securitySchemes'],
      ).toEqual([{ type: 'oauth2', scopes: ['equipment:read'] }]);
      expect(
        tools.find((tool) => tool.name === 'equipment.rename')?._meta?.['securitySchemes'],
      ).toEqual([{ type: 'oauth2', scopes: ['equipment:write'] }]);
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
      const upgrade = await connect('upgrade');
      const insufficient = await upgrade.callTool({
        name: 'equipment.rename',
        arguments: { name: 'Tripod' },
      });
      expect(insufficient.isError).toBe(true);
      expect(JSON.stringify(insufficient._meta)).toContain('insufficient_scope');
      expect(renames).toBe(0);
      const editor = await connect('editor');
      expect(
        await editor
          .callTool({ name: 'equipment.rename', arguments: { name: 'Tripod' } })
          .then((result) => result.structuredContent),
      ).toEqual({ name: 'Tripod' });
      expect(
        await editor
          .callTool({ name: 'equipment.lookup', arguments: {} })
          .then((result) => result.structuredContent),
      ).toEqual({ name: 'Tripod' });
      expect(renames).toBe(1);
      const restricted = mountCatalog({
        basePath: '/api',
        publicOrigin: 'https://equipment.example',
        operations: [read, write],
        host: {},
        authenticateApi: async () => ({ method: 'api-key', principal }),
        mcp: {
          serverInfo: { name: 'equipment', version: '1' },
          authorization,
          requiredScopes: ['equipment:write'],
        },
      })['/api']!.start('/app');
      const admission = await restricted(
        new Request('https://equipment.example/mcp', {
          headers: { authorization: 'Bearer upgrade' },
        }),
      );
      expect(admission.status).toBe(403);
      expect(admission.headers.get('www-authenticate')).toContain('insufficient_scope');
      expect(admission.headers.get('www-authenticate')).toContain('scope="equipment:write"');
      expect(admission.headers.get('www-authenticate')).toContain(
        '/.well-known/oauth-protected-resource/app/api/mcp',
      );
      expect(renames).toBe(1);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  },
);
