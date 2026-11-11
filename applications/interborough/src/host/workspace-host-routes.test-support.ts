/** Six-actor probes for the host's real administrator routes. */
import type { WorkspaceMembership } from '@lostgradient/bureau';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createLiveOperationRegistry } from '@lostgradient/weft';
import { expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, type Host } from './host.ts';
import {
  petsDocument,
  startMcpServer,
  startOAuthMcpServer,
} from './tool-source-servers.test-support.ts';

async function upgradeResponse(
  host: Host,
  actor: string,
): Promise<{ status: number; body: string }> {
  const address = host.url;
  return new Promise((resolve, reject) => {
    const socket = connect(Number(address.port), address.hostname);
    let received = Buffer.alloc(0);
    socket.once('error', reject);
    socket.once('connect', () =>
      socket.write(
        [
          'GET /jsonrpc HTTP/1.1',
          `Host: ${address.host}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: Zml4dHVyZS1rZXktMTIzNA==',
          `X-Api-Key: ${actor}`,
          '',
          '',
        ].join('\r\n'),
      ),
    );
    socket.on('data', (chunk) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const headers = received.subarray(0, boundary).toString();
      const status = Number(/^HTTP\/1\.[01] (\d+)/.exec(headers)?.[1]);
      const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(headers)?.[1] ?? 0);
      const body = received.subarray(boundary + 4);
      if (body.length < length) return;
      socket.destroy();
      resolve({ status, body: body.subarray(0, length).toString() });
    });
  });
}

/** Exercise every ordinary administrator route with an actual valid administrator request. */
export async function exerciseAdministratorRoutes(
  host: Host,
  members: Map<string, WorkspaceMembership>,
): Promise<string[]> {
  const mcp = await startMcpServer('route-fixture-token');
  const oauth = await startOAuthMcpServer();
  try {
    const source = (id: string) => ({
      id,
      kind: 'mcp' as const,
      transport: {
        type: 'http' as const,
        url: `${mcp.origin}/`,
        authentication: { type: 'bearer' as const, credential: 'token' },
      },
    });
    const oauthSource = {
      id: 'oauth-source',
      kind: 'mcp' as const,
      transport: {
        type: 'http' as const,
        url: `${oauth.origin}/`,
        authentication: { type: 'oauth' as const },
      },
    };
    await host.providers.connect({
      provider: 'anthropic',
      apiKey: 'route-provider-secret',
      models: ['sonnet'],
    });
    await host.toolSources.connect({
      id: 'fixture-source',
      principal: 'workspace-a:admin',
      source: source('fixture-source'),
      credentials: { token: 'route-fixture-token' },
    });
    await host.toolSources.connect({
      id: 'oauth-source',
      principal: 'workspace-a:admin',
      source: oauthSource,
    });
    const cases: Array<{ key: string; path: string; body?: Record<string, unknown> }> = [
      { key: 'GET /host/providers', path: '/host/providers' },
      {
        key: 'PUT /host/providers/:name',
        path: '/host/providers/anthropic',
        body: { apiKey: 'route-provider-secret', models: ['sonnet'] },
      },
      {
        key: 'POST /host/providers/:name/test',
        path: '/host/providers/anthropic/test',
        body: { apiKey: 'route-provider-secret' },
      },
      { key: 'PUT /host/catalog', path: '/host/catalog', body: { edits: [] } },
      { key: 'POST /host/providers/reload', path: '/host/providers/reload' },
      { key: 'DELETE /host/providers/:name', path: '/host/providers/anthropic', body: {} },
      { key: 'GET /host/plugins', path: '/host/plugins' },
      {
        key: 'PUT /host/plugins/:name',
        path: '/host/plugins/shared-integration',
        body: { configuration: { label: 'route-fixture' } },
      },
      {
        key: 'PUT /host/plugins/:name/secrets/:key',
        path: '/host/plugins/shared-integration/secrets/shared-secret',
        body: { value: 'route-integration-secret' },
      },
      { key: 'GET /host/tool-sources', path: '/host/tool-sources' },
      {
        key: 'GET /host/tool-sources/:id/affected-agents',
        path: '/host/tool-sources/fixture-source/affected-agents',
      },
      {
        key: 'POST /host/tool-sources/:id/probe',
        path: '/host/tool-sources/fixture-source/probe',
        body: { source: source('fixture-source'), credentials: { token: 'route-fixture-token' } },
      },
      {
        key: 'POST /host/tool-sources/:id/test',
        path: '/host/tool-sources/fixture-source/test',
        body: {},
      },
      {
        key: 'PUT /host/tool-sources/:id/tools',
        path: '/host/tool-sources/fixture-source/tools',
        body: { tools: { wipe: { enabled: true } } },
      },
      {
        key: 'POST /host/tool-sources/:id/authorize',
        path: '/host/tool-sources/oauth-source/authorize',
        body: {},
      },
      {
        key: 'PUT /host/tool-sources/:id',
        path: '/host/tool-sources/new-source',
        body: { source: source('new-source'), credentials: { token: 'route-fixture-token' } },
      },
      { key: 'DELETE /host/tool-sources/:id', path: '/host/tool-sources/fixture-source', body: {} },
      {
        key: 'POST /host/openapi-inspection',
        path: '/host/openapi-inspection',
        body: { fileName: 'pets.json', text: JSON.stringify(petsDocument) },
      },
    ];
    const live = host.routeInventory.filter(
      (entry) => entry.resourceClass === 'administrator-shared' && !entry.delegated,
    );
    expect([...cases.map((entry) => entry.key), 'GET /host/oauth/callback/:id'].toSorted()).toEqual(
      live.map((entry) => entry.key).toSorted(),
    );
    let authorizationUrl: string | undefined;
    for (const entry of cases) {
      const method = entry.key.split(' ')[0]!;
      const snapshot = await host.plugins.snapshot();
      const payload =
        entry.body === undefined
          ? undefined
          : {
              ...entry.body,
              operationId: crypto.randomUUID(),
              expectedRevision: snapshot.configurationRevision,
            };
      for (const actor of ['alice', 'bob', 'grantee', 'foreign', 'removed', 'admin']) {
        const response = await fetch(new URL(entry.path, host.url), {
          method,
          headers: {
            'x-api-key': actor,
            origin: host.url.origin,
            'content-type': 'application/json',
          },
          ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        });
        const text = await response.text();
        if (actor === 'foreign' || actor === 'removed') {
          expect(response.status, `${entry.key} ${actor}`).toBe(403);
          expect(text).toBe('Workspace membership required');
        } else if (actor === 'admin')
          expect(response.status, `${entry.key} administrator`).toBe(200);
        else expect(response.status, `${entry.key} ${actor}`).toBe(403);
        expect(text.includes('route-provider-secret')).toBe(false);
        expect(text.includes('route-fixture-token')).toBe(false);
        expect(text.includes('route-integration-secret')).toBe(false);
        expect(text).not.toContain('workspace-a-private-input');
        expect(text).not.toContain('workspace-b-private-input');
        if (actor === 'admin' && entry.key === 'POST /host/tool-sources/:id/authorize')
          authorizationUrl = (JSON.parse(text) as { authorizationUrl: string }).authorizationUrl;
      }
    }
    if (authorizationUrl === undefined) throw new Error('Expected the administrator OAuth flow');
    const redirect = await fetch(authorizationUrl, { redirect: 'manual' });
    const callback = redirect.headers.get('location');
    if (callback === null) throw new Error('Expected the OAuth callback');
    const forged = new URL(callback);
    forged.searchParams.set('state', 'incorrect');
    const invalid = await fetch(forged);
    expect(invalid.status).toBe(400);
    const administrator = members.get('admin');
    if (administrator === undefined) throw new Error('Expected the initiating administrator');
    members.delete('admin');
    const denied = await fetch(callback);
    expect(denied.status).toBe(403);
    expect(oauth.issuedAccessTokens).toHaveLength(0);
    members.set('admin', administrator);
    const complete = await fetch(callback);
    expect(complete.status).toBe(200);
    expect(oauth.issuedAccessTokens).toHaveLength(1);
    const replay = await fetch(callback);
    expect(replay.status).toBe(400);
    expect(oauth.issuedAccessTokens).toHaveLength(1);
    return [...cases.map((entry) => entry.key), 'GET /host/oauth/callback/:id'];
  } finally {
    await oauth.stop();
    await mcp.stop();
  }
}

/** Exercise every live engine relay entry through one of its registered transports. */
export async function exerciseEngineRelay(host: Host): Promise<void> {
  const rest: Record<string, { method: string; path: string }> = {
    'weft.workflows.events.sse': { method: 'GET', path: '/v1/workflows/fixture/events/sse' },
    'weft.events.sse': { method: 'GET', path: '/v1/events/sse' },
    'weft.tasks.diagnostics.deadletters.clear': {
      method: 'DELETE',
      path: '/v1/tasks/diagnostics/dead-letter/fixture',
    },
    'weft.storage.get': { method: 'GET', path: '/v1/storage/fixture' },
    'weft.storage.preview': { method: 'GET', path: '/v1/storage/-/preview?key=fixture' },
    'weft.storage.put': { method: 'PUT', path: '/v1/storage/fixture' },
    'weft.storage.delete': { method: 'DELETE', path: '/v1/storage/fixture' },
    'weft.storage.scan': { method: 'GET', path: '/v1/storage' },
    'weft.storage.batch': { method: 'POST', path: '/v1/storage/-/batch' },
    'weft.storage.conditionalbatch': { method: 'POST', path: '/v1/storage/-/conditional-batch' },
  };
  const websocketOnly = new Set(['weft.workflows.events', 'weft.events.subscribe']);
  const operations = createLiveOperationRegistry().list();
  expect(
    operations
      .filter((entry) => !entry.transports.jsonRpcHttp)
      .map((entry) => entry.name)
      .toSorted(),
  ).toEqual([...Object.keys(rest), ...websocketOnly].toSorted());
  const observed = new Set<string>();
  for (const actor of ['alice', 'bob', 'admin', 'grantee', 'foreign', 'removed']) {
    for (const operation of operations) {
      if (websocketOnly.has(operation.name)) continue;
      const binding = rest[operation.name];
      const method = binding?.method ?? 'POST';
      const path = binding?.path ?? '/jsonrpc';
      const response = await fetch(new URL(path, host.url), {
        method,
        headers: {
          'x-api-key': actor,
          origin: host.url.origin,
          'content-type': 'application/json',
          accept: 'text/event-stream',
        },
        ...(binding === undefined
          ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: operation.name, params: {} }) }
          : {}),
      });
      const text = await response.text();
      expect(response.status, `${operation.name}:${actor}`).toBe(403);
      if (actor === 'foreign' || actor === 'removed')
        expect(text).toBe('Workspace membership required');
      else expect(text).not.toBe('Workspace membership required');
      observed.add(`${operation.name}:${actor}`);
    }
    const upgrade = await upgradeResponse(host, actor);
    expect(upgrade.status).toBe(403);
    if (actor === 'foreign' || actor === 'removed')
      expect(upgrade.body).toBe('Workspace membership required');
    else expect(upgrade.body).not.toBe('Workspace membership required');
    for (const name of websocketOnly) observed.add(`${name}:${actor}`);
  }
  expect(observed.size).toBe(operations.length * 6);
  // Only the trusted local identity may operate the engine; an API-key member cannot.
  const home = await mkdtemp(join(tmpdir(), 'interborough-engine-control-'));
  const localHost = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  const url = new URL('/jsonrpc', localHost.url);
  url.protocol = 'ws:';
  const socket = new WebSocket(url);
  try {
    const frames: Array<{ id?: number; error?: unknown; result?: unknown }> = [];
    socket.addEventListener('message', (event) => frames.push(JSON.parse(String(event.data))));
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener(
        'error',
        () => reject(new Error('The operator WebSocket was rejected')),
        { once: true },
      );
    });
    socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.events.subscribe', params: {} }),
    );
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'weft.workflows.events',
        params: { workflowId: 'fixture', selector: 'events' },
      }),
    );
    await waitUntil(
      () => frames.some((frame) => frame.id === 1) && frames.some((frame) => frame.id === 2),
      { message: 'operator subscriptions to reach the engine' },
    );
    for (const id of [1, 2]) {
      const frame = frames.find((item) => item.id === id);
      expect(frame?.error).toBeUndefined();
      expect(frame?.result).toMatchObject({ subscriptionId: expect.any(String) });
    }
  } finally {
    socket.close();
    await localHost.close();
    await rm(home, { recursive: true, force: true });
  }
}
