import { AUTHORIZATION_SCOPES } from '@lostgradient/weft';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

  test('Bureau owns what the local caller creates as anonymous:local', async () => {
    const host = await start();
    const run = host.bureau.run('assistant', 'Who am I?');
    await run.result();
    const [session] = await host.bureau.listSessions();
    if (session === undefined) throw new Error('Expected the run to create a session.');
    expect(await host.bureau.getOwner({ kind: 'session', id: session.id })).toBe('anonymous:local');
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
    for (const path of ['/', '/chat', '/runs/abc', '/inbox']) {
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

  test('answers an unknown path with 404', async () => {
    const host = await start(await createBuild());
    expect(await statusOf(host, '/nowhere/at/all')).toBe(404);
  });
});
