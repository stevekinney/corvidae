import { createLiveOperationRegistry } from '@lostgradient/weft';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    expect(keys).toContain('POST /host/restart');
    expect(keys).toContain('* /bureau/*');
    const bureauRoute = host.routeInventory.find((entry) => entry.key === '* /bureau/*');
    expect(bureauRoute?.resourceClass).toBeNull();
    expect(bureauRoute?.children?.filter((entry) => entry.kind === 'operation')).toHaveLength(111);
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
