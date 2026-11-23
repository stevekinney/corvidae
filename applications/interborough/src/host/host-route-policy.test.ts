import { createAgentSchedule as seedAgentSchedule } from '@lostgradient/operative';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { createLiveOperationRegistry } from '@lostgradient/weft';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSchedule, listBureauSchedules } from '../lib/bureau-schedules.ts';
import { enableDemoPlugin } from './demo-plugin-home.ts';
import { pluginsWithUnseededDemo } from './demo-plugin.test-support.ts';
import { authorizeHostRoutes, inventoryHostRoutes } from './host-route-policy.ts';
import { startHost } from './host.ts';

test('new host methods and routes require explicit classification', () => {
  expect(() =>
    inventoryHostRoutes({ '/host/unclassified': { GET: () => new Response() } }),
  ).toThrow('Unclassified');
  expect(() => inventoryHostRoutes({ '/host/providers': { PATCH: () => new Response() } })).toThrow(
    'Unclassified',
  );
});

test('a trigger delivery is deployment-operator with the trigger-receive admission, and only as a POST (COR-2169)', () => {
  const [entry, ...others] = inventoryHostRoutes({
    '/triggers/:workflow': { POST: () => new Response() },
  });
  expect(others).toEqual([]);
  expect(entry).toMatchObject({
    key: 'POST /triggers/:workflow',
    resourceClass: 'deployment-operator',
    admission: 'trigger-receive',
    delegated: false,
  });
  // The class is the route's, so removing it fails the inventory (AC3).
  expect(() =>
    inventoryHostRoutes({ '/triggers/:workflow': { GET: () => new Response() } }),
  ).toThrow('Unclassified');
  expect(() =>
    inventoryHostRoutes({ '/triggers/:workflow': { PUT: () => new Response() } }),
  ).toThrow('Unclassified');
  expect(() => inventoryHostRoutes({ '/triggers/:name': { POST: () => new Response() } })).toThrow(
    'Unclassified',
  );
});

test('a trigger-receive route takes the public-origin guard and skips authorize and release, and no other route does', async () => {
  const calls: string[] = [];
  const authority = {
    authenticate: () => {
      throw new Error('not called');
    },
    mutation: () => {
      throw new Error('not called');
    },
    authorize: async (_request: Request, classification: string) => {
      calls.push(`authorize ${classification}`);
      return undefined;
    },
    release: async (_request: Request, classification: string, response: Response) => {
      calls.push(`release ${classification}`);
      return response;
    },
  };
  const guarded = authorizeHostRoutes(
    {
      '/triggers/:workflow': { POST: () => new Response('delivered') },
      '/host/status': { GET: () => new Response('status') },
    },
    authority,
    (request) => {
      calls.push(`loopback ${new URL(request.url).pathname}`);
      return undefined;
    },
    (request) => {
      calls.push(`public ${new URL(request.url).pathname}`);
      return undefined;
    },
  );
  const call = async (path: string, method: string) => {
    const handler = (guarded[path] as Record<string, (r: Request, s: never) => Promise<Response>>)[
      method
    ];
    return handler!(new Request(`http://127.0.0.1${path}`, { method }), undefined as never);
  };
  const delivered = await call('/triggers/:workflow', 'POST');
  expect(await delivered.text()).toBe('delivered');
  expect(calls).toEqual(['public /triggers/:workflow']);
  calls.length = 0;
  await call('/host/status', 'GET');
  expect(calls).toEqual([
    'loopback /host/status',
    'authorize deployment-operator',
    'release deployment-operator',
  ]);

  // A refusal of the public guard is the answer, and nothing runs after it.
  calls.length = 0;
  const refused = authorizeHostRoutes(
    { '/triggers/:workflow': { POST: () => new Response('delivered') } },
    authority,
    () => undefined,
    () => new Response(null, { status: 403 }),
  );
  const refusedHandler = (
    refused['/triggers/:workflow'] as Record<string, (r: Request, s: never) => Promise<Response>>
  )['POST']!;
  const refusal = await refusedHandler(
    new Request('http://127.0.0.1/triggers/x', { method: 'POST' }),
    undefined as never,
  );
  expect(refusal.status).toBe(403);
  expect(calls).toEqual([]);
});

test('fully composed host captures its routes and its engine discovery catalog', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-workspace-inventory-'));
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    onRestartRequested: () => undefined,
  });
  try {
    const keys = host.routeInventory.map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('GET /host/providers');
    expect(
      host.routeInventory
        .filter((entry) => entry.admission !== undefined)
        .map((entry) => ({
          key: entry.key,
          admission: entry.admission,
          resourceClass: entry.resourceClass,
        })),
    ).toEqual([
      {
        key: 'GET /host/oauth/callback/:id',
        admission: 'durable-oauth-callback',
        resourceClass: 'administrator-shared',
      },
      {
        key: 'POST /triggers/:workflow',
        admission: 'trigger-receive',
        resourceClass: 'deployment-operator',
      },
    ]);
    // The only route a public origin reaches without a credential: no other `/triggers` route.
    expect(keys.filter((key) => key.includes('/triggers'))).toEqual(['POST /triggers/:workflow']);
    expect(keys).toContain('POST /host/restart');
    expect(
      host.routeInventory.find((entry) => entry.key === 'GET /host/status')?.resourceClass,
    ).toBe('deployment-operator');
    expect(keys).toContain('* /bureau/*');
    const bureauRoute = host.routeInventory.find((entry) => entry.key === '* /bureau/*');
    expect(bureauRoute?.resourceClass).toBeNull();
    // One child per operation the Bureau handler serves: 143, including `bureau.workflows.concurrency`
    // (COR-2433), `bureau.runs.compare` (COR-2544), `bureau.tasks.explain` (COR-2532), and
    // `bureau.tasks.explanation.get` and `.generate` (COR-2534).
    const operations = bureauRoute?.children?.filter((entry) => entry.kind === 'operation') ?? [];
    expect(operations).toHaveLength(143);
    expect(operations.some((entry) => entry.key === 'bureau.workflows.concurrency')).toBe(true);
    expect(operations.some((entry) => entry.key === 'bureau.runs.compare')).toBe(true);
    expect(bureauRoute?.children?.every((entry) => entry.workspaceClass !== undefined)).toBe(true);
    expect(bureauRoute?.children?.some((entry) => entry.key === '/ag-ui')).toBe(true);
    expect(host.routeInventory.find((entry) => entry.key === '* /bureau/*')?.transports).toContain(
      'websocket',
    );
    const engineRoute = host.routeInventory.find((entry) => entry.key === '* engine-proxy');
    expect(engineRoute?.resourceClass).toBe('deployment-operator');
    expect(engineRoute?.children?.map((entry) => entry.key).sort()).toEqual(
      createLiveOperationRegistry()
        .list()
        .map((operation) => operation.name)
        .sort(),
    );
    expect(
      engineRoute?.children?.every((entry) => entry.workspaceClass === 'deployment-operator'),
    ).toBe(true);
    const response = await fetch(new URL('/openrpc.json', host.url));
    expect(response.status).toBe(200);
    const document = (await response.json()) as { methods: Array<{ name: string }> };
    const live = document.methods.map((method) => method.name).sort();
    const expected = [
      'rpc.discover',
      ...createLiveOperationRegistry()
        .list()
        .filter(
          (operation) =>
            (operation.access.kind === 'public' || operation.discoverable === true) &&
            (operation.transports.jsonRpcHttp || operation.transports.jsonRpcWebSocket),
        )
        .map((operation) => operation.name),
    ].sort();
    expect(live).toEqual(expected);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('browser schedule parsing accepts the real workspace host create and list responses', async () => {
  const home = await mkdtemp(join(tmpdir(), 'interborough-schedule-contract-'));
  await enableDemoPlugin(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    plugins: pluginsWithUnseededDemo(),
  });
  try {
    const options = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(
          input instanceof Request
            ? new Request(new URL(input.url, host.url), input)
            : new URL(input, host.url),
          init,
        ),
    };
    const created = await createAgentSchedule(
      { agentName: 'demo:assistant', spec: '24h', input: 'PRIVATE-SCHEDULE-CONTRACT-c75a' },
      options,
    );
    expect(created.inputPreview).toBe('PRIVATE-SCHEDULE-CONTRACT-c75a');
    expect(created.lastFireAt).toBeNull();
    expect(created.missedFireCount).toBe(0);
    expect(created.skippedCount).toBe(0);
    expect(
      await throwingRejectionOf(
        host.bureau.schedules.create({
          agentName: 'demo:assistant',
          spec: '24h',
          input: 'PRIVATE-OTHER-OWNER-a137',
          principal: 'workspace:another-owner',
        }),
      ),
    ).toThrow('Workspace authority unavailable');
    // Historical records can outlive membership. Seed one through the native fixture boundary;
    // the public Bureau API correctly refuses new schedules for an unknown workspace owner.
    const foreign = await seedAgentSchedule({
      engine: host.engine,
      agentName: 'demo:assistant',
      spec: { every: '24h' },
      input: 'PRIVATE-OTHER-OWNER-a137',
      principal: 'workspace:another-owner',
    });
    await foreign.pause();
    expect(foreign).toBeDefined();
    const listed = await listBureauSchedules(options);
    expect(listed).toHaveLength(2);
    expect(listed.find((entry) => entry.id === created.id)).toEqual(created);
    expect(listed.find((entry) => entry.id === foreign?.id)).toMatchObject({
      inputPreview: null,
      lastFireAt: null,
      missedFireCount: null,
      skippedCount: null,
    });
    expect(JSON.stringify(listed)).not.toContain('PRIVATE-OTHER-OWNER-a137');
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});
