import {
  createOperationHandler,
  principalFromApiKey,
  principalFromJwtClaims,
  type AuthenticatedPrincipal,
} from '@lostgradient/backchannel';
import { createOperationMcpMount } from '@lostgradient/backchannel-mcp';
import { createApiKeys } from '@lostgradient/credentials/api-keys';
import { MemoryStorage } from '@lostgradient/storage';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'bun:test';
import { apiKeyManagementOperations, createApiKeyManagementHandler } from './backchannel.ts';

it('enforces workspace, delegation, write guards and the credential lifecycle', async () => {
  using storage = new MemoryStorage();
  let clock = 10;
  let current = true;
  const keys = createApiKeys({
    storage,
    now: () => clock,
    authorizeManagement: async (actor: { workspace?: { workspaceId: string } }, request) =>
      current && actor.workspace?.workspaceId === request.workspaceId,
    resolveAuthority: async ({ workspaceId, subject }) => ({
      workspaceId,
      subject,
      scopes: ['read'],
    }),
  });
  const principal = (workspaceId: string) => ({
    ...principalFromJwtClaims({ sub: 'manager' }),
    workspace: {
      version: 1 as const,
      workspaceId,
      actorId: 'manager',
      actorKind: 'user' as const,
      owner: 'owner',
      membershipRevision: '1',
      capabilities: ['workspace:use' as const, 'workspace:manage' as const],
    },
  });
  let actor: AuthenticatedPrincipal = principal('A');
  const handler = createApiKeyManagementHandler({
    host: {
      keys,
      currentManager: async () => current,
      targets: async () => [{ subject: 'service', scopes: ['read'] }],
      allowedActions: async (_actor, key) =>
        key.revokedAt === undefined ? ['rotate', 'revoke'] : [],
      overlapCutoff: () => 20,
    },
    authenticateSession: async () => ({
      method: actor.method === 'api-key' ? 'api-key' : 'jwt',
      principal: actor,
    }),
    publicOrigin: 'https://app.test',
    guardWrite: async (request) => {
      const token = request.headers.get('x-csrf-token');
      if (token === 'throw') throw new Error('Guard failed');
      return token === 'valid';
    },
  });
  const call = async (method: string, params: object, guard = 'valid') => {
    const response = await handler(
      new Request('https://app.test/key-admin/jsonrpc', {
        method: 'POST',
        headers: {
          origin: 'https://app.test',
          'x-csrf-token': guard,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return {
      response,
      body: response.headers.get('content-type')?.includes('json')
        ? ((await response.json()) as {
            result?: {
              id: string;
              secret: string;
              retiresAt: number;
              revoked: boolean;
              keys: unknown[];
            };
            error?: unknown;
          })
        : {},
    };
  };
  expect(
    apiKeyManagementOperations.map((operation) => [operation.name, operation.mcpExposable]),
  ).toEqual([
    ['api.keys.list', false],
    ['api.keys.issue', false],
    ['api.keys.rotate', false],
    ['api.keys.revoke', false],
  ]);
  const oversized = await handler(
    new Request('https://app.test/key-admin/jsonrpc', {
      method: 'POST',
      headers: {
        origin: 'https://app.test',
        'x-csrf-token': 'valid',
        'content-type': 'application/json',
      },
      body: 'x'.repeat(1024 * 1024 + 1),
    }),
  );
  expect(oversized.status).toBe(413);
  expect(oversized.headers.get('cache-control')).toBe('private, no-store');
  expect(await Array.fromAsync(storage.scan('api-keys:'))).toEqual([]);
  for (const method of ['api.keys.issue', 'api.keys.rotate', 'api.keys.revoke']) {
    const denied = await call(method, {}, 'invalid');
    expect(denied.response.status).toBe(403);
  }
  const guardFailure = await call('api.keys.issue', {}, 'throw');
  expect(guardFailure.response.status).toBe(503);
  const input = { label: 'sync', subject: 'service', scopes: ['read'], expiresAt: 100 };
  const deniedIssue = await call('api.keys.issue', { ...input, scopes: ['write'] });
  expect(deniedIssue.body.error).toBeDefined();
  const issuedResponse = await call('api.keys.issue', input);
  const issued = issuedResponse.body.result!;
  expect(issued.secret).toStartWith('lgk_');
  expect(await keys.verify(issued.secret)).not.toBeNull();
  const listResponse = await call('api.keys.list', {});
  const list = listResponse.body.result!;
  expect(list.keys[0]).toMatchObject({
    id: issued.id,
    label: 'sync',
    subject: 'service',
    scopes: ['read'],
    expiresAt: 100,
    actions: ['rotate', 'revoke'],
  });
  expect(list).toMatchObject({ targets: [{ subject: 'service', scopes: ['read'] }] });
  expect(JSON.stringify(list)).not.toContain(issued.secret);
  actor = principal('B');
  const otherList = await call('api.keys.list', {});
  expect(otherList.body.result!.keys).toEqual([]);
  const otherRotate = await call('api.keys.rotate', { id: issued.id });
  expect(otherRotate.body.error).toBeDefined();
  const otherRevoke = await call('api.keys.revoke', { id: issued.id });
  expect(otherRevoke.body.error).toBeDefined();
  actor = principal('A');
  const replacementResponse = await call('api.keys.rotate', { id: issued.id });
  const replacement = replacementResponse.body.result!;
  expect(replacement.retiresAt).toBe(20);
  expect(await keys.verify(issued.secret)).not.toBeNull();
  expect(await keys.verify(replacement.secret)).not.toBeNull();
  clock = 20;
  expect(await keys.verify(issued.secret)).toBeNull();
  expect(await keys.verify(replacement.secret)).not.toBeNull();
  const revoked = await call('api.keys.revoke', { id: replacement.id });
  expect(revoked.body.result!.revoked).toBe(true);
  expect(await keys.verify(replacement.secret)).toBeNull();
  const laterResponse = await call('api.keys.list', {});
  const later = JSON.stringify(laterResponse.body);
  expect(later).not.toContain(issued.secret);
  expect(later).not.toContain(replacement.secret);
  const attempts = [
    ['api.keys.list', {}],
    ['api.keys.issue', input],
    ['api.keys.rotate', { id: issued.id }],
    ['api.keys.revoke', { id: issued.id }],
  ] as const;
  const beforeEntries = await Array.fromAsync(storage.scan('api-keys:'));
  const storageBefore = JSON.stringify(beforeEntries.map(([key, value]) => [key, [...value]]));
  for (const rejectedActor of ['stale', 'service']) {
    current = rejectedActor !== 'stale';
    if (rejectedActor === 'service')
      actor = {
        ...principalFromApiKey({ subject: 'service', scopes: [] }),
        workspace: { ...principal('A').workspace, actorKind: 'service' },
      };
    for (const [method, params] of attempts) {
      const denied = await call(method, params);
      expect(denied.body.error).toBeDefined();
    }
  }
  const afterEntries = await Array.fromAsync(storage.scan('api-keys:'));
  const storageAfter = JSON.stringify(afterEntries.map(([key, value]) => [key, [...value]]));
  expect(storageAfter).toBe(storageBefore);
});

it('excludes every management operation from MCP discovery and dispatch', async () => {
  using storage = new MemoryStorage();
  const keys = createApiKeys({
    storage,
    authorizeManagement: async () => true,
    resolveAuthority: async (identity) => ({ ...identity, scopes: [] }),
  });
  const host = {
    keys,
    currentManager: async () => true,
    targets: async () => [],
    allowedActions: async () => [],
    overlapCutoff: () => 20,
  };
  const handler = createOperationHandler({
    operations: apiKeyManagementOperations,
    host,
    mounts: [createOperationMcpMount({ serverInfo: { name: 'settings-test', version: '1' } })],
  });
  const transport = new StreamableHTTPClientTransport(new URL('http://settings.test/mcp'), {
    // The preceding DOM test may install a different AbortSignal realm; cancellation is not under test here.
    fetch: (url, init) => handler(new Request(url, { ...init, signal: undefined })),
  });
  const client = new Client({ name: 'settings-test', version: '1' });
  await client.connect(transport);
  try {
    const discovery = await client.listTools();
    for (const operation of apiKeyManagementOperations) {
      expect(discovery.tools.some((tool) => tool.name === operation.name)).toBe(false);
      const result = await client.callTool({ name: operation.name, arguments: {} }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect('error' in result || ('value' in result && result.value.isError === true)).toBe(true);
    }
  } finally {
    await client.close();
  }
});
