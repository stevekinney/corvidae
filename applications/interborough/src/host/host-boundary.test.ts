/**
 * The public listener answers every request as the one local caller holding every scope, so it
 * must refuse what a web page can send but a person at this machine cannot: a rebound Host, a
 * cross-site form post, and a cross-site WebSocket (`request-guard.ts`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(existingHome?: string): Promise<Host> {
  const home = existingHome ?? (await mkdtemp(join(tmpdir(), 'interborough-boundary-')));
  if (existingHome === undefined) homes.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

/** The status of a raw HTTP/1.1 request, so the `Host` header is exactly what a rebound page sends. */
async function rawStatus(host: Host, path: string, hostHeader: string): Promise<number> {
  const text = await new Promise<string>((resolve, reject) => {
    let received = '';
    void Bun.connect({
      hostname: host.url.hostname,
      port: Number(host.url.port),
      socket: {
        open: (socket) =>
          void socket.write(
            `GET ${path} HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`,
          ),
        data: (_socket, chunk) => void (received += new TextDecoder().decode(chunk)),
        close: () => resolve(received),
        error: (_socket, error) => reject(error),
      },
    });
  });
  return Number(text.split(' ')[1]);
}

/** Open a WebSocket to `/jsonrpc`, optionally claiming `origin`, and say whether it was answered. */
async function webSocketOutcome(host: Host, origin?: string): Promise<'answered' | 'refused'> {
  const url = new URL('/jsonrpc', host.url);
  url.protocol = 'ws:';
  const options = origin === undefined ? {} : { headers: { origin } };
  const socket: WebSocket = Reflect.construct(WebSocket, [url.toString(), options]);
  const outcome = await new Promise<'answered' | 'refused'>((resolve) => {
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'weft.system.principal', params: {} }),
      ),
    );
    socket.addEventListener('message', () => resolve('answered'));
    socket.addEventListener('error', () => resolve('refused'));
    socket.addEventListener('close', () => resolve('refused'));
  });
  socket.close();
  return outcome;
}

describe('a rebound Host', () => {
  test('is refused on the engine API, on Bureau, and on the application', async () => {
    const host = await start();
    const foreign = `attacker.example:${host.url.port}`;
    for (const path of [
      '/api/v1/principal',
      '/bureau/v1/health',
      '/host/paths',
      '/',
      '/assets/main.js',
    ]) {
      expect(await rawStatus(host, path, foreign), path).toBe(403);
    }
  });

  test('is refused when it names the right host on the wrong port', async () => {
    const host = await start();
    expect(await rawStatus(host, '/api/v1/principal', '127.0.0.1:9')).toBe(403);
  });

  test('is accepted as either of the listener’s own names', async () => {
    const host = await start();
    for (const name of ['127.0.0.1', 'localhost']) {
      expect(await rawStatus(host, '/bureau/v1/health', `${name}:${host.url.port}`), name).toBe(
        200,
      );
    }
  });
});

describe('/host/paths', () => {
  test('names both directories a person edits by hand to the local caller', async () => {
    const host = await start();
    const response = await fetch(new URL('/host/paths', host.url));
    expect(response.status).toBe(200);
    const paths = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(paths).toSorted()).toEqual([
      'agentDirectory',
      'configurationFile',
      'providers',
      'workflowDirectory',
    ]);
    expect(String(paths['workflowDirectory'])).toEndWith('workflows');
  });

  test('returns exactly the locations under the host home, built from Bungalow', async () => {
    const home = await mkdtemp(join(tmpdir(), 'interborough-boundary-'));
    homes.push(home);
    const host = await start(home);
    const response = await fetch(new URL('/host/paths', host.url));
    expect(await response.json()).toEqual({
      agentDirectory: join(home, 'agents'),
      workflowDirectory: join(home, 'workflows'),
      configurationFile: join(home, 'configuration.json'),
      providers: [
        { name: 'anthropic', secretFile: join(home, 'secrets', 'anthropic-api-key') },
        { name: 'openai', secretFile: join(home, 'secrets', 'openai-api-key') },
        { name: 'gemini', secretFile: join(home, 'secrets', 'gemini-api-key') },
      ],
    });
  });

  test('is refused for a rebound Host and for a cross-site page, with the directories unnamed', async () => {
    const host = await start();
    expect(await rawStatus(host, '/host/paths', 'attacker.example')).toBe(403);
    const crossSite = await fetch(new URL('/host/paths', host.url), {
      headers: { origin: 'https://attacker.example' },
    });
    expect(crossSite.status).toBe(403);
    expect(await crossSite.text()).not.toContain('workflowDirectory');
  });
});

describe('a cross-site request', () => {
  test('a form post changes nothing', async () => {
    const host = await start();
    const listing = await host.bureau.schedules.list();
    const [schedule] = listing?.items ?? [];
    if (schedule === undefined) throw new Error('Expected the seeded schedule.');
    const response = await fetch(new URL(`/api/v1/schedules/${schedule.id}/pause`, host.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
      },
      body: '',
    });
    expect(response.status).toBe(403);
    const unchanged = await host.bureau.schedules.get(schedule.id);
    expect(unchanged?.status).toBe('active');
  });

  test('is refused on Bureau and on the application too', async () => {
    const host = await start();
    for (const path of ['/bureau/v1/health', '/host/paths', '/']) {
      const response = await fetch(new URL(path, host.url), {
        headers: { origin: 'https://attacker.example' },
      });
      expect(response.status, path).toBe(403);
    }
  });

  test('is refused when the origin is "null", as a sandboxed frame sends', async () => {
    const host = await start();
    const response = await fetch(new URL('/api/v1/principal', host.url), {
      headers: { origin: 'null' },
    });
    expect(response.status).toBe(403);
  });

  test('is refused when only the host name, or only a prefix of it, matches', async () => {
    const host = await start();
    const port = Number(host.url.port);
    for (const origin of [
      `http://127.0.0.1:${port + 1}`,
      `http://localhost:${port + 1}`,
      `http://localhost.attacker.example:${port}`,
      `http://127.0.0.1.attacker.example:${port}`,
    ]) {
      const response = await fetch(new URL('/api/v1/principal', host.url), {
        headers: { origin },
      });
      expect(response.status, origin).toBe(403);
    }
  });

  test('a WebSocket from another origin is refused, and one from this origin is not', async () => {
    const host = await start();
    expect(await webSocketOutcome(host, 'https://attacker.example')).toBe('refused');
    expect(await webSocketOutcome(host, host.url.origin)).toBe('answered');
  });
});

describe('the page’s own requests', () => {
  test('carry an Origin of this listener, under either name, and pass', async () => {
    const host = await start();
    for (const name of ['127.0.0.1', 'localhost']) {
      const origin = `http://${name}:${host.url.port}`;
      const response = await fetch(new URL('/api/v1/principal', host.url), {
        headers: { origin, host: `${name}:${host.url.port}` },
      });
      expect(response.status, origin).toBe(200);
    }
  });
});

describe('the discovery documents', () => {
  test('answer through the public origin', async () => {
    const host = await start();
    for (const path of ['/.well-known/api-catalog', '/.well-known/mcp.json']) {
      const response = await fetch(new URL(path, host.url));
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain(host.url.origin);
    }
  });
});
