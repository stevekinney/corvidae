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
import { inventoryHostRoutes } from './host-route-policy.ts';
import { startHost } from './host.ts';

test('new host methods and routes require explicit classification', () => {
  expect(() =>
    inventoryHostRoutes({ '/host/unclassified': { GET: () => new Response() } }),
  ).toThrow('Unclassified');
  expect(() => inventoryHostRoutes({ '/host/providers': { PATCH: () => new Response() } })).toThrow(
    'Unclassified',
  );
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
    ]);
    expect(keys).toContain('POST /host/restart');
    expect(
      host.routeInventory.find((entry) => entry.key === 'GET /host/status')?.resourceClass,
    ).toBe('deployment-operator');
    expect(keys).toContain('* /bureau/*');
    const bureauRoute = host.routeInventory.find((entry) => entry.key === '* /bureau/*');
    expect(bureauRoute?.resourceClass).toBeNull();
    expect(bureauRoute?.children?.filter((entry) => entry.kind === 'operation')).toHaveLength(115);
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
