import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createToolboxMcpHandler } from 'armorer/mcp/http';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createTool } from '../src/create-tool';
import { createToolbox } from '../src/create-toolbox';
import { createStoreDouble, deferred, rpc, TASKS_CAPABILITIES } from './fixtures/mcp-task-harness';

describe('protected native MCP listener', () => {
  test('fences task reads and input delivery to the grant and current permission', async () => {
    let binding = { grantId: 'grant', clientId: 'client', tenant: 'tenant', subject: 'subject' };
    let permission = true;
    let revision = '1';
    let actorCapabilities = ['write'];
    let deliveries = 0;
    let aborted = false;
    const tool = createTool({
      name: 'task',
      version: '1',
      description: 'task',
      input: z.object({}),
      metadata: { mcp: { taskBacked: true } },
      async execute(_input, context) {
        context.signal?.addEventListener('abort', () => {
          aborted = true;
        });
        const answer = await context.elicit!({ mode: 'form', message: 'Continue?' });
        if (answer.action === 'accept') deliveries++;
        return 'done';
      },
    });
    const store = createStoreDouble();
    const endpoint = await createToolboxMcpHandler(createToolbox([tool]), {
      tools: [{ id: tool.id, name: 'public.task', scopes: ['write'] }],
      taskStore: store,
      authorization: {
        origin: 'https://equipment.example.com',
        resourcePath: '/mcp',
        issuer: 'https://issuer.example.com',
        scopes: ['write'],
        async verifyAccessToken() {
          return {
            ...binding,
            issuer: 'https://issuer.example.com',
            audience: 'https://equipment.example.com/mcp',
            expiresAt: Date.now() + 60000,
            scopes: ['write'],
          };
        },
        async resolvePrincipal() {
          return { delegableScopes: permission ? ['write'] : [], revision, actorCapabilities };
        },
      },
      requestContext: (principal) => ({
        authority: {
          principalId: 'subject',
          tenantId: 'tenant',
          ownerId: 'subject',
          capabilities: principal.actorCapabilities,
          authorizationRevision: principal.revision,
        },
      }),
    });
    const adapter = {
      fetch: (request: Request) => {
        const headers = new Headers(request.headers);
        headers.set('authorization', 'Bearer marker');
        return endpoint.fetch(
          new Request(new URL('/mcp', 'https://equipment.example.com'), {
            method: request.method,
            headers,
            body: request.body,
          }),
        );
      },
    };
    const capabilities = { ...TASKS_CAPABILITIES, elicitation: {} };
    try {
      const created = await rpc(
        adapter as never,
        'tools/call',
        { name: 'public.task', arguments: {} },
        capabilities,
      );
      const taskId = created.result!['taskId'] as string;
      expect(taskId).toBeString();
      let inputKey = '';
      await waitUntil(async () => {
        const read = await rpc(adapter as never, 'tasks/get', { taskId }, capabilities);
        if (read.result?.['status'] !== 'input_required') return false;
        inputKey = Object.keys(read.result['inputRequests'] as object)[0]!;
        return true;
      });
      for (const field of ['grantId', 'clientId', 'tenant', 'subject'] as const) {
        const original = binding;
        binding = { ...binding, [field]: 'other' };
        const read = await rpc(adapter as never, 'tasks/get', { taskId }, capabilities);
        expect(read.error).toBeDefined();
        const update = await rpc(
          adapter as never,
          'tasks/update',
          { taskId, inputResponses: { [inputKey]: { action: 'accept', content: {} } } },
          capabilities,
        );
        expect(update.error).toBeDefined();
        expect(deliveries).toBe(0);
        binding = original;
      }
      permission = false;
      const denied = await rpc(
        adapter as never,
        'tasks/update',
        { taskId, inputResponses: { [inputKey]: { action: 'accept', content: {} } } },
        capabilities,
      );
      expect(denied.error).toBeDefined();
      expect(deliveries).toBe(0);
      permission = true;
      for (const changed of ['revision', 'capabilities'] as const) {
        if (changed === 'revision') revision = '2';
        else actorCapabilities = ['write', 'extra'];
        for (const method of ['tasks/get', 'tasks/update', 'tasks/cancel']) {
          const refused = await rpc(
            adapter as never,
            method,
            { taskId, inputResponses: { [inputKey]: { action: 'accept', content: {} } } },
            capabilities,
          );
          expect(refused.error).toBeDefined();
          expect(deliveries).toBe(0);
        }
        revision = '1';
        actorCapabilities = ['write'];
      }
      const gate = deferred<void>();
      const heldBatch = store.batchCount + 1;
      store.hold(heldBatch, gate.promise);
      const racing = rpc(
        adapter as never,
        'tasks/update',
        { taskId, inputResponses: { [inputKey]: { action: 'accept', content: {} } } },
        capabilities,
      );
      await waitUntil(() => store.batchCount >= heldBatch);
      revision = '2';
      gate.resolve();
      const racedResult = await racing;
      expect(racedResult.error).toBeDefined();
      expect(deliveries).toBe(0);
      revision = '1';
      const restored = await rpc(adapter as never, 'tasks/get', { taskId }, capabilities);
      expect(restored.result?.['status']).toBe('input_required');
      const allowed = await rpc(
        adapter as never,
        'tasks/update',
        { taskId, inputResponses: { [inputKey]: { action: 'accept', content: {} } } },
        capabilities,
      );
      expect(allowed.error).toBeUndefined();
      await waitUntil(() => deliveries === 1);
      await waitUntil(
        async () =>
          (await rpc(adapter as never, 'tasks/get', { taskId }, capabilities)).result?.[
            'status'
          ] === 'completed',
      );
      revision = '2';
      const hidden = await rpc(adapter as never, 'tasks/get', { taskId }, capabilities);
      expect(hidden.error).toBeDefined();
      revision = '1';
      const visible = await rpc(adapter as never, 'tasks/get', { taskId }, capabilities);
      expect(JSON.stringify(visible.result)).toContain('done');
    } finally {
      await endpoint.close();
    }
    expect(aborted).toBe(false);
  });
  test('refuses a protected input continuation after identity or authority changes', async () => {
    for (const change of [
      'grantId',
      'subject',
      'tenant',
      'clientId',
      'permission',
      'revision',
      'capabilities',
      'none',
    ] as const) {
      let binding = { grantId: 'grant', clientId: 'client', tenant: 'tenant', subject: 'subject' };
      let permission = true;
      let revision = 'initial';
      let capabilities = ['write'];
      const projected: string[] = [];
      let deliveries = 0;
      let aborted = false;
      const tool = createTool({
        name: 'approval',
        version: '1',
        description: 'approval',
        input: z.object({}),
        async execute(_input, context) {
          context.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          const answer = await context.elicit!({ mode: 'form', message: 'Continue?' });
          if (answer.action === 'accept') deliveries++;
          return 'complete';
        },
      });
      const endpoint = await createToolboxMcpHandler(createToolbox([tool]), {
        tools: [{ id: tool.id, name: 'approval', scopes: ['write'] }],
        authorization: {
          origin: 'https://equipment.example.com',
          resourcePath: '/mcp',
          issuer: 'https://issuer.example.com',
          scopes: ['write'],
          async verifyAccessToken() {
            return {
              ...binding,
              issuer: 'https://issuer.example.com',
              audience: 'https://equipment.example.com/mcp',
              expiresAt: Date.now() + 60000,
              scopes: ['write'],
            };
          },
          async resolvePrincipal() {
            return { delegableScopes: permission ? ['write'] : [], revision, capabilities };
          },
        },
        requestContext: (principal) => {
          projected.push(principal.revision);
          return {
            authority: {
              principalId: 'subject',
              tenantId: 'tenant',
              ownerId: 'subject',
              capabilities: principal.capabilities,
              authorizationRevision: principal.revision,
            },
          };
        },
      });
      const transport = new StreamableHTTPClientTransport(
        new URL('https://equipment.example.com/mcp'),
        {
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('authorization', 'Bearer marker');
            return endpoint.fetch(new Request(url, { ...init, headers }));
          },
        },
      );
      const client = new Client(
        { name: 'test', version: '1' },
        { capabilities: { elicitation: {} }, versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      try {
        await client.connect(transport);
        const round = (await client.callTool(
          { name: 'approval', arguments: {} },
          { allowInputRequired: true },
        )) as unknown as { resultType: string; requestState: string };
        expect(round.resultType).toBe('input_required');
        if (change === 'permission') permission = false;
        else if (change === 'revision') revision = 'current';
        else if (change === 'capabilities') capabilities = ['write', 'other'];
        else if (change !== 'none') binding = { ...binding, [change]: 'different' };
        const retry = client.callTool(
          {
            name: 'approval',
            arguments: {},
            requestState: round.requestState,
            inputResponses: { elicitation: { action: 'accept', content: {} } },
          } as Parameters<Client['callTool']>[0],
          { allowInputRequired: true },
        );
        if (change === 'none') await retry;
        else {
          const refusal = await retry.then(
            (result) => result.isError === true,
            () => true,
          );
          expect(refusal).toBe(true);
        }
        expect(deliveries).toBe(change === 'none' ? 1 : 0);
        if (change === 'none') expect(projected.at(-1)).toBe('initial');
      } finally {
        await client.close();
        await endpoint.close();
      }
      if (change !== 'none') expect(aborted).toBe(true);
    }
  });
  test('selects a pinned public name and enforces tenant authority before execution', async () => {
    let calls = 0;
    let authorityRevision = 0;
    let advanceAuthority = false;
    let checksAfterChange = 0;
    const assets = new Map([
      ['one', 'old'],
      ['two', 'old'],
    ]);
    const rename = createTool({
      name: 'rename',
      version: '1',
      description: 'rename',
      input: z.object({ name: z.string() }),
      async execute({ name }, context) {
        calls++;
        expect(JSON.stringify(context)).not.toContain('bearer-marker');
        expect(context.requestContext!.authority.authorizationRevision).toBe(
          String(authorityRevision),
        );
        const tenant = context.requestContext!.authority.tenantId;
        assets.set(tenant, name);
        return { name };
      },
    });
    const lookup = createTool({
      name: 'lookup',
      version: '1',
      description: 'lookup',
      input: z.object({}),
      async execute(_input, context) {
        return { name: assets.get(context.requestContext!.authority.tenantId) };
      },
    });
    const toolbox = createToolbox([rename, lookup]);
    const authorization = {
      origin: 'https://equipment.example.com',
      resourcePath: '/mcp',
      issuer: 'https://issuer.example.com',
      scopes: ['read', 'write'],
      async verifyAccessToken(token: string) {
        return {
          issuer: 'https://issuer.example.com',
          audience: 'https://equipment.example.com/mcp',
          expiresAt: Date.now() + 60000,
          subject: 'user',
          grantId: token === 'bearer-marker-one' ? 'grant-one' : 'grant-two',
          clientId: 'client',
          tenant: token === 'bearer-marker-one' ? 'one' : 'two',
          scopes: ['read', 'write'],
        };
      },
      async resolvePrincipal(grant: { tenant?: string }) {
        if (advanceAuthority && ++checksAfterChange === 2) authorityRevision++;
        return {
          tenant: grant.tenant!,
          revision: String(authorityRevision),
          delegableScopes: grant.tenant === 'one' ? ['read'] : ['read', 'write'],
        };
      },
    };
    const configuration = {
      tools: [
        { id: rename.id, name: 'equipment.rename', scopes: ['write'] },
        { id: lookup.id, name: 'equipment.lookup', scopes: ['read'] },
      ],
      authorization,
      requestContext: (principal: { tenant: string; revision: string }) => ({
        authority: {
          principalId: 'user',
          tenantId: principal.tenant,
          ownerId: 'user',
          capabilities: ['write'],
          authorizationRevision: principal.revision,
        },
      }),
    };
    const endpoint = await createToolboxMcpHandler(toolbox, configuration);
    const server = Bun.serve({ port: 0, fetch: endpoint.fetch });
    const clients: Client[] = [];
    const connect = async (token: string) => {
      const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('authorization', `Bearer ${token}`);
          return fetch(url, { ...init, headers });
        },
      });
      const client = new Client(
        { name: 'test', version: '1' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      );
      clients.push(client);
      await client.connect(transport);
      return client;
    };
    try {
      const denied = await connect('bearer-marker-one');
      const listed = await denied.listTools();
      expect(listed.tools[0]).toMatchObject({
        name: 'equipment.rename',
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['write'] }] },
      });
      expect(listed.tools[1]).toMatchObject({
        name: 'equipment.lookup',
        _meta: { securitySchemes: [{ type: 'oauth2', scopes: ['read'] }] },
      });
      const read = await denied.callTool({ name: 'equipment.lookup', arguments: {} });
      expect(JSON.stringify(read)).toContain('old');
      expect(
        await throwingRejectionOf(
          denied.callTool({ name: 'equipment.rename', arguments: { name: 'denied' } }),
        ),
      ).toThrow();
      expect(calls).toBe(0);
      const allowed = await connect('bearer-marker-two');
      advanceAuthority = true;
      await allowed.callTool({ name: 'equipment.rename', arguments: { name: 'new' } });
      expect(calls).toBe(1);
      expect([...assets]).toEqual([
        ['one', 'old'],
        ['two', 'new'],
      ]);
      expect(
        await throwingRejectionOf(
          createToolboxMcpHandler(toolbox, {
            ...configuration,
            tools: [{ ...configuration.tools[0]!, id: 'missing@1' }],
          }),
        ),
      ).toThrow();
      expect(
        await throwingRejectionOf(
          createToolboxMcpHandler(toolbox, {
            ...configuration,
            tools: [...configuration.tools, ...configuration.tools],
          }),
        ),
      ).toThrow();
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      server.stop(true);
      await endpoint.close();
    }
  });
});
