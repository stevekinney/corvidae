import { AUTHORIZATION_SCOPES, MCP_LEGACY_PROTOCOL_VERSION } from '@lostgradient/weft';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serveComposedJsonRpc } from './composed-json-rpc.ts';
import { enableDemoPlugin } from './demo-plugin-home.ts';
import { deriveStartOverrideSigningSecret, startHost, type Host } from './host.ts';

const directories: string[] = [];
const hosts: Host[] = [];

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A build directory holding the two kinds of file the host serves. */
async function createBuild(): Promise<string> {
  const build = await scratch('interborough-build-');
  await mkdir(join(build, 'assets'));
  await writeFile(join(build, 'index.html'), '<!doctype html><div id="app"></div>');
  await writeFile(join(build, 'assets', 'main-abc12345.js'), 'export const loaded = true;');
  await writeFile(join(build, 'secret.txt'), 'outside the assets directory');
  return build;
}

async function start(buildDirectory?: string): Promise<Host> {
  const home = await scratch('interborough-home-');
  await enableDemoPlugin(home);
  const host = await startHost({
    environment: { INTERBOROUGH_HOME: home },
    port: 0,
    ...(buildDirectory === undefined ? {} : { buildDirectory }),
  });
  hosts.push(host);
  return host;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

type Principal = { method: string; subject: string | null; scopes: string[] };

async function statusOf(host: Host, path: string): Promise<number> {
  const response = await fetch(new URL(path, host.url));
  return response.status;
}

async function principalOver(host: Host, headers: HeadersInit = {}): Promise<Principal> {
  const response = await fetch(new URL('/api/v1/principal', host.url), { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Principal;
}

describe('the host’s listener', () => {
  test('waits for the browser build before binding, and releases the home if it fails', async () => {
    const home = await scratch('interborough-home-');
    const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const port = reservation.port!;
    await reservation.stop(true);
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const ready: PromiseLike<void> = {
      then(resolve, reject) {
        reached.resolve();
        return gate.promise.then(resolve, reject);
      },
    };
    const starting = startHost({
      environment: { INTERBOROUGH_HOME: home },
      port,
      browserReady: ready,
    });
    await reached.promise;
    const probe = Bun.serve({ hostname: '127.0.0.1', port, fetch: () => new Response() });
    await probe.stop(true);
    const failure = new Error('browser build failed');
    gate.reject(failure);
    await expect(starting).rejects.toBe(failure);
    const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port });
    hosts.push(host);
    expect(host.url.port).toBe(String(port));
  });
  test('the Bureau principal reports the explicit local workspace owner', async () => {
    const host = await start();
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.system.principal', params: {} }),
    });
    expect(response.status).toBe(200);
    const principal = await response.json();
    expect(principal.result.workspace).toEqual({
      version: 1,
      workspaceId: host.workspaceId,
      actorId: 'local-owner',
      actorKind: 'local',
      owner: 'anonymous:local',
      membershipRevision: 'local-owner-v1',
      capabilities: ['workspace:use', 'workspace:manage', 'deployment:operate'],
    });
  });
  test('listens on loopback only', async () => {
    const host = await start();
    expect(host.url.hostname).toBe('127.0.0.1');
    expect(host.url.protocol).toBe('http:');
  });

  test('refuses a port that is not a whole number rather than falling back', async () => {
    const home = await scratch('interborough-home-');
    const failure = await startHost({
      environment: { INTERBOROUGH_HOME: home, INTERBOROUGH_PORT: 'not-a-port' },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(String(failure)).toContain('INTERBOROUGH_PORT');
  });
});

describe('the identity of every request', () => {
  test('Weft reports anonymous:local holding every scope', async () => {
    const host = await start();
    const principal = await principalOver(host);
    expect(principal.subject).toBe('anonymous:local');
    expect([...principal.scopes].toSorted()).toEqual([...AUTHORIZATION_SCOPES].toSorted());
  });

  test('a credential the caller sends does not change who it is', async () => {
    const host = await start();
    for (const headers of [
      { authorization: 'Bearer someone-else' },
      { 'x-api-key': 'someone-else' },
    ]) {
      const principal = await principalOver(host, headers);
      expect(principal.subject).toBe('anonymous:local');
    }
  });

  test('Weft’s private listener answers only the relay’s key', async () => {
    const host = await start();
    // Weft audits each refusal to the console, which is the point of keeping them.
    const audit = spyOn(console, 'warn').mockImplementation(() => undefined);
    const direct = await fetch(new URL('/v1/principal', host.server.url));
    expect(direct.status).toBe(401);
    const wrong = await fetch(new URL('/v1/principal', host.server.url), {
      headers: { 'x-api-key': 'guess' },
    });
    expect(wrong.status).toBe(401);
    expect(audit).toHaveBeenCalledTimes(2);
    audit.mockRestore();
  });

  test('Bureau serves the same caller under /bureau', async () => {
    const host = await start();
    const health = await fetch(new URL('/bureau/v1/health', host.url));
    expect(health.status).toBe(200);
    // Listing reviews needs `bureau.reviews:read`, a scope only the local caller's grant supplies.
    const response = await fetch(new URL('/bureau/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.reviews.list', params: {} }),
    });
    const body = (await response.json()) as { result?: { reviews: unknown[] } };
    expect(body.result?.reviews).toEqual([]);
  });

  test('Bureau serves its MCP tools under /bureau/mcp, as the local caller', async () => {
    const host = await start();
    // A 2025-era client on the SDK's stateless legacy lane: each request is one POST.
    const mcp = async (id: number, method: string, params: Record<string, unknown>) => {
      const response = await fetch(new URL('/bureau/mcp', host.url), {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': MCP_LEGACY_PROTOCOL_VERSION,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const data = text.startsWith('{') ? text : (text.match(/^data: (.*)$/m)?.[1] ?? 'null');
      return JSON.parse(data) as { result?: Record<string, unknown> };
    };
    const initialized = await mcp(1, 'initialize', {
      protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'interborough-test', version: '1.0.0' },
    });
    expect(initialized.result?.['serverInfo']).toMatchObject({ name: 'bureau' });
    const listed = await mcp(2, 'tools/list', {});
    const tools = (listed.result?.['tools'] ?? []) as Array<{ name: string }>;
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('bureau.reviews.list');
    // A model's longer explanation of a failed run is kept off MCP, so a model cannot spend tokens
    // asking another model to explain a run (COR-2534); the stored-facts explanation is on it.
    expect(names).toContain('bureau.tasks.explain');
    expect(names.filter((name) => name.startsWith('bureau.tasks.explanation.'))).toEqual([]);
    // The run inspector is an injected `ui://` resource, linked from `bureau.tasks.inspect` (COR-910).
    const inspect = (tools as Array<{ name: string; _meta?: unknown }>).find(
      (tool) => tool.name === 'bureau.tasks.inspect',
    );
    expect(inspect?._meta).toMatchObject({
      ui: { resourceUri: 'ui://inspectors/run-inspector/v1' },
    });
    // Every tool a running panel lists in its `allowedTools` is visible to apps; every other tool
    // to the model alone (COR-2209).
    const panelTools = new Set([
      'bureau.tasks.inspect',
      'bureau.tasks.events',
      'bureau.tasks.cancel',
      'bureau.reviews.list',
      'bureau.reviews.get',
      'bureau.reviews.resolve',
      'bureau.workflows.get',
      'bureau.workflows.update',
      'bureau.runs.compare',
      // The schedule editor's reads (COR-2545); its writes are host-only and never listed here.
      'bureau.schedules.list',
      'bureau.schedules.get',
      'bureau.agents.list',
      'bureau.workflows.list',
      'bureau.tasks.get',
      // The failure explanation's one read (COR-2543).
      'bureau.tasks.explain',
      'bureau.runs.timeline',
    ]);
    const visibilities = Object.fromEntries(
      (tools as Array<{ name: string; _meta?: { ui?: { visibility?: unknown } } }>).map((tool) => [
        tool.name,
        tool._meta?.ui?.visibility,
      ]),
    );
    expect(visibilities).toEqual(
      Object.fromEntries(
        names.map((name) => [name, panelTools.has(name) ? ['model', 'app'] : ['model']]),
      ),
    );
    expect(names.filter((name) => panelTools.has(name)).length).toBeGreaterThan(0);
    expect(names.some((name) => !panelTools.has(name))).toBe(true);
    const resources = await mcp(4, 'resources/list', {});
    expect(resources.result?.['resources']).toMatchObject([
      { uri: 'ui://inspectors/run-inspector/v1', mimeType: 'text/html;profile=mcp-app' },
      { uri: 'ui://inspectors/pending-review/v1', mimeType: 'text/html;profile=mcp-app' },
      {
        uri: 'ui://inspectors/workflow-revision-review/v1',
        mimeType: 'text/html;profile=mcp-app',
      },
      { uri: 'ui://inspectors/schedule-editor/v1', mimeType: 'text/html;profile=mcp-app' },
      { uri: 'ui://inspectors/run-timeline/v1', mimeType: 'text/html;profile=mcp-app' },
      { uri: 'ui://inspectors/failure-explanation/v1', mimeType: 'text/html;profile=mcp-app' },
      { uri: 'ui://inspectors/run-comparison/v1', mimeType: 'text/html;profile=mcp-app' },
    ]);
    // The failure explanation opens from the explain tool (COR-2543).
    const explain = (tools as Array<{ name: string; _meta?: unknown }>).find(
      (tool) => tool.name === 'bureau.tasks.explain',
    );
    expect(explain?._meta).toMatchObject({
      ui: { resourceUri: 'ui://inspectors/failure-explanation/v1' },
    });
    // The pending-review app opens from the existing `bureau.reviews.list`; it adds no tool name.
    const reviewList = tools.find((tool) => tool.name === 'bureau.reviews.list') as {
      _meta?: unknown;
    };
    expect(reviewList._meta).toMatchObject({
      ui: { resourceUri: 'ui://inspectors/pending-review/v1' },
    });
    const review = await mcp(6, 'resources/read', { uri: 'ui://inspectors/pending-review/v1' });
    expect(review.result?.['contents']).toMatchObject([
      { mimeType: 'text/html;profile=mcp-app', text: expect.stringContaining('<div id="root">') },
    ]);
    const page = await mcp(5, 'resources/read', { uri: 'ui://inspectors/run-inspector/v1' });
    expect(page.result?.['contents']).toMatchObject([
      {
        text: expect.stringContaining('<div id="root">'),
        _meta: { contentDigest: expect.any(String) },
      },
    ]);
    // Listing reviews needs `bureau.reviews:read`, which the local caller's grant supplies.
    const called = await mcp(3, 'tools/call', { name: 'bureau.reviews.list', arguments: {} });
    expect(called.result?.['isError']).toBeFalsy();
    expect(called.result?.['structuredContent']).toEqual({
      reviews: [],
      nextPageToken: null,
      // How many reviews the listing holds in all (COR-2426).
      total: 0,
    });
  });

  test('Bureau owns what the local caller creates as anonymous:local', async () => {
    const host = await start();
    const run = await host.bureau.tasks.start('demo:assistant', 'Who am I?');
    await run.result();
    const [session] = await host.bureau.contexts.list();
    if (session === undefined) throw new Error('Expected the run to create a session.');
    expect(await host.bureau.ownerOf({ kind: 'session', id: session.id })).toBe('anonymous:local');
  });
});

describe('the relay to Weft’s server', () => {
  test('carries JSON-RPC over HTTP', async () => {
    const host = await start();
    const response = await fetch(new URL('/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'weft.system.principal', params: {} }),
    });
    const body = (await response.json()) as { id: number; result: Principal };
    expect(body.id).toBe(7);
    expect(body.result.subject).toBe('anonymous:local');
  });

  test('signs worker start-override previews, so a missing workflow is not found rather than unsupported', async () => {
    const host = await start();
    const response = await fetch(new URL('/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'weft.worker.startoverrides.preview',
        params: { workflowId: 'no-such-workflow' },
      }),
    });
    const body = (await response.json()) as { error?: { data?: { weftCode?: string } } };
    expect(body.error?.data?.weftCode).toBe('NotFound');
  });

  test('serves Bureau and Weft operations together on /jsonrpc and lists both in rpc.discover', async () => {
    const host = await start();
    const call = async (id: number, method: string) => {
      const response = await fetch(new URL('/jsonrpc', host.url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { id: number; result?: unknown; error?: unknown };
    };
    const agents = await call(1, 'bureau.agents.list');
    expect(agents.error).toBeUndefined();
    expect(agents.result).toHaveProperty('agents');
    const capabilities = await call(2, 'weft.storage.capabilities');
    expect(capabilities.error).toBeUndefined();
    const discovered = (await call(3, 'rpc.discover')) as {
      result: { methods: { name: string }[] };
    };
    const names = discovered.result.methods.map((method) => method.name);
    expect(names).toContain('bureau.agents.list');
    expect(names).toContain('weft.storage.capabilities');
    expect(new Set(names).size).toBe(names.length);
  });

  test('answers a batch that mixes Bureau and Weft operations with a response for each id', async () => {
    const host = await start();
    const response = await fetch(new URL('/jsonrpc', host.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 'agents', method: 'bureau.agents.list', params: {} },
        { jsonrpc: '2.0', id: 'storage', method: 'weft.storage.capabilities', params: {} },
        { jsonrpc: '2.0', id: 'who', method: 'weft.system.principal', params: {} },
        { jsonrpc: '2.0', method: 'bureau.agents.list', params: {} },
      ]),
    });
    expect(response.status).toBe(200);
    const answers = (await response.json()) as { id: string; result?: unknown; error?: unknown }[];
    expect(answers.map((answer) => answer.id)).toEqual(['agents', 'storage', 'who']);
    for (const answer of answers) expect(answer.error).toBeUndefined();
    expect(answers[0]?.result).toHaveProperty('agents');
  });

  test('keeps earlier batch answers when the relay refuses a later call', async () => {
    const response = await serveComposedJsonRpc(
      new Request('http://localhost/jsonrpc', {
        method: 'POST',
        body: JSON.stringify([
          { jsonrpc: '2.0', id: 'agents', method: 'bureau.agents.list' },
          { jsonrpc: '2.0', id: 7, method: 'weft.storage.capabilities' },
        ]),
      }),
      {
        bureauMethods: new Set(['bureau.agents.list']),
        authorizeEngine: async () => undefined,
        refuseBureau: async () => undefined,
        bureau: async () => Response.json({ jsonrpc: '2.0', id: 'agents', result: { agents: [] } }),
        relay: async () => new Response('Bad Gateway', { status: 502 }),
      },
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual([
      { jsonrpc: '2.0', id: 'agents', result: { agents: [] } },
      {
        jsonrpc: '2.0',
        id: 7,
        error: { code: -32603, message: 'Upstream request refused', data: { status: 502 } },
      },
    ]);
  });

  test('derives the signing secret from the key without echoing it', () => {
    const secret = deriveStartOverrideSigningSecret('a-process-key');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toContain('a-process-key');
    expect(deriveStartOverrideSigningSecret('a-process-key')).toBe(secret);
    expect(deriveStartOverrideSigningSecret('another-key')).not.toBe(secret);
  });

  test('carries JSON-RPC over a WebSocket', async () => {
    const host = await start();
    const url = new URL('/jsonrpc', host.url);
    url.protocol = 'ws:';
    const socket = new WebSocket(url);
    const reply = await new Promise<string>((resolve, reject) => {
      socket.addEventListener('open', () => {
        socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'weft.system.principal', params: {} }),
        );
      });
      socket.addEventListener('message', (event) => resolve(String(event.data)));
      socket.addEventListener('error', () => reject(new Error('The WebSocket failed.')));
    });
    socket.close();
    expect((JSON.parse(reply) as { result: Principal }).result.subject).toBe('anonymous:local');
  });

  test('streams Server-Sent Events without buffering them', async () => {
    const host = await start();
    const controller = new AbortController();
    const response = await fetch(new URL('/api/v1/events/sse', host.url), {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(first?.done).toBe(false);
    controller.abort();
  });
});

describe('the built application', () => {
  test('serves index.html at every client route', async () => {
    const host = await start(await createBuild());
    // A plugin's page has a path of one segment or several (`/plugins/:plugin/*`).
    for (const path of [
      '/',
      '/chats',
      '/runs/abc',
      '/reviews',
      '/plugins/acme/overview',
      '/plugins/acme/reviews/queue',
    ]) {
      const response = await fetch(new URL(path, host.url));
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(await response.text(), path).toContain('<div id="app"></div>');
    }
  });

  test('serves hashed assets and refuses a path that leaves the assets directory', async () => {
    const host = await start(await createBuild());
    const asset = await fetch(new URL('/assets/main-abc12345.js', host.url));
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('export const loaded = true;');
    expect(await statusOf(host, '/assets/missing.js')).toBe(404);
    for (const path of ['/assets/%2e%2e/secret.txt', '/assets/..%2fsecret.txt']) {
      expect(await statusOf(host, path), path).toBe(404);
    }
    expect(await statusOf(host, '/assets/%zz')).toBe(400);
  });

  test('says how to build when there is no build', async () => {
    const empty = await scratch('interborough-empty-');
    const host = await start(join(empty, 'build'));
    const response = await fetch(new URL('/', host.url));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('bun run --filter=@lostgradient/interborough build');
  });

  test('serves the shell for an unknown address a browser navigates to, so the router can say so', async () => {
    const host = await start(await createBuild());
    for (const path of ['/nowhere/at/all', '/nonsense/route', '/chats/new/extra', '/gone.html']) {
      const response = await fetch(new URL(path, host.url), { headers: { accept: 'text/html' } });
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(await response.text(), path).toContain('<div id="app"></div>');
    }
  });

  test('answers a miss that is not a page navigation with 404', async () => {
    const host = await start(await createBuild());
    // A script's fetch, an asset, and every prefix the engine, the Bureau, or the host owns.
    expect(await statusOf(host, '/nowhere/at/all')).toBe(404);
    expect(await statusOf(host, '/favicon.ico')).toBe(404);
    for (const path of ['/assets/missing.js', '/bureau/missing', '/host/missing']) {
      const response = await fetch(new URL(path, host.url), { headers: { accept: 'text/html' } });
      expect(response.status, path).toBe(404);
    }
    const post = await fetch(new URL('/nowhere/at/all', host.url), {
      method: 'POST',
      headers: { accept: 'text/html' },
    });
    expect(post.status).toBe(404);
  });
});
