import { createApiKeys } from '@lostgradient/credentials/api-keys';
import { MemoryStorage } from '@lostgradient/storage';
import { expect, it } from 'bun:test';
import { z } from 'zod';
import { createOperationHandler } from '../handler/operation-handler.ts';
import { defineOperation } from '../operation-registry.ts';
import { principalFromApiKey } from '../principal.ts';

it('enforces a durable service key on Fetch and the Backchannel operation pipeline', async () => {
  using storage = new MemoryStorage();
  const read = 'inventory.equipment:read';
  const write = 'inventory.equipment:write';
  const keys = createApiKeys({
    storage,
    authorizeManagement: async () => true,
    resolveAuthority: async ({ workspaceId, subject }) => ({
      workspaceId,
      subject,
      scopes: [read, write],
    }),
  });
  const key = await keys.issue('manager', {
    label: 'sync',
    workspaceId: 'A',
    subject: 'warehouse',
    scopes: [read],
  });
  const authenticate = keys.withSession(async (incoming) =>
    incoming.headers.get('cookie') === 'session=valid'
      ? { subject: 'human', workspaceId: 'A', scopes: [read, write], id: 'browser' }
      : new Response('Unauthorized', { status: 401 }),
  );
  let name = 'Camera';
  let invoked = 0;
  const plain = async (request: Request, required: string) => {
    const principal = await authenticate(request);
    if (principal instanceof Response) return principal;
    if (!principal.scopes.includes(required)) return new Response('Forbidden', { status: 403 });
    if (required === write) name = 'Changed';
    return Response.json({ name });
  };
  const request = () => new Request('http://localhost', { headers: { 'x-api-key': key.secret } });
  expect((await plain(request(), read)).status).toBe(200);
  expect((await plain(request(), write)).status).toBe(403);
  const schema = z.object({});
  const output = z.object({ name: z.string() });
  const operation = (action: 'read' | 'rename') =>
    defineOperation({
      name: `equipment.${action}`,
      mcpExposable: false,
      summary: action,
      destructive: false,
      inputSchema: schema,
      outputSchema: output,
      access: {
        kind: 'scoped',
        scopes: { kind: 'anyOf', scopes: [action === 'read' ? read : write] },
      },
      discoverable: true,
      transports: { http: true, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => {
        invoked++;
        if (action === 'rename') name = 'Changed';
        return { name };
      },
    });
  const handler = createOperationHandler({
    operations: [operation('read'), operation('rename')],
    host: {},
    authenticate: async (incoming) => {
      const authority = await authenticate(incoming);
      if (authority instanceof Response) return authority;
      return {
        method: 'api-key',
        principal: principalFromApiKey({ subject: authority.subject, scopes: authority.scopes }),
      };
    },
  });
  const call = (method: string, headers: Record<string, string> = { 'x-api-key': key.secret }) =>
    handler(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }),
      }),
    );
  expect(await (await call('equipment.read')).json()).toMatchObject({ result: { name: 'Camera' } });
  expect(await (await call('equipment.rename')).json()).toHaveProperty('error');
  expect(name).toBe('Camera');
  expect(invoked).toBe(1);
  invoked = 0;
  expect(
    (await call('equipment.read', { cookie: 'session=valid', 'x-api-key': 'bad' })).status,
  ).toBe(401);
  expect(
    (await call('equipment.read', { 'x-api-key': key.secret, authorization: 'Bearer token' }))
      .status,
  ).toBe(401);
  expect(invoked).toBe(0);
});
