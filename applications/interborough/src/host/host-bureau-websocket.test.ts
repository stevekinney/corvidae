/**
 * Bureau's WebSocket plane through the public listener (COR-1734): an upgrade under `/bureau/` goes
 * to the Bureau handler with the prefix removed, behind the same request guard as every other
 * route, and the engine relay's upgrades still work beside it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startHost, type Host } from './host.ts';

const homes: string[] = [];
const hosts: Host[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  for (const host of hosts.splice(0)) await host.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

async function start(): Promise<Host> {
  const home = await mkdtemp(join(tmpdir(), 'interborough-bureau-websocket-'));
  homes.push(home);
  const host = await startHost({ environment: { INTERBOROUGH_HOME: home }, port: 0 });
  hosts.push(host);
  return host;
}

type Frame = Record<string, unknown>;

/** A socket to `path` on the host, open, with a reader for the JSON frames it receives. */
async function connect(host: Host, path: string) {
  const url = new URL(path, host.url);
  url.protocol = 'ws:';
  const socket = new WebSocket(url);
  sockets.push(socket);
  const received: Frame[] = [];
  const waiting: { matches: (frame: Frame) => boolean; resolve: (frame: Frame) => void }[] = [];
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    received.push(frame);
    for (const wait of waiting.filter((candidate) => candidate.matches(frame))) {
      waiting.splice(waiting.indexOf(wait), 1);
      wait.resolve(frame);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error(`${path} did not upgrade.`)), {
      once: true,
    });
  });
  return {
    socket,
    /** Resolves with the first frame, already received or still to come, that `matches`. */
    next(matches: (frame: Frame) => boolean): Promise<Frame> {
      const earlier = received.find(matches);
      if (earlier !== undefined) return Promise.resolve(earlier);
      return new Promise((resolve) => waiting.push({ matches, resolve }));
    },
    call(id: number, method: string, params: Frame): Promise<Frame> {
      const answer = this.next((frame) => frame['id'] === id);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return answer;
    },
  };
}

/** The status line of a raw WebSocket handshake, so the guard's inputs are exactly what is sent. */
async function handshakeStatus(
  host: Host,
  path: string,
  headers: Record<string, string>,
): Promise<number> {
  const sent = {
    host: `127.0.0.1:${host.url.port}`,
    connection: 'Upgrade',
    upgrade: 'websocket',
    'sec-websocket-version': '13',
    'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
    ...headers,
  };
  const lines = Object.entries(sent).map(([name, value]) => `${name}: ${value}`);
  const text = await new Promise<string>((resolve, reject) => {
    let received = '';
    void Bun.connect({
      hostname: host.url.hostname,
      port: Number(host.url.port),
      socket: {
        open: (socket) =>
          void socket.write(`GET ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`),
        data: (socket, chunk) => {
          received += new TextDecoder().decode(chunk);
          if (received.includes('\r\n')) socket.end();
        },
        close: () => resolve(received),
        error: (_socket, error) => reject(error),
      },
    });
  });
  return Number(text.split(' ')[1]);
}

describe('an upgrade under /bureau/', () => {
  test('subscribes to bureau.events at host.url and receives an event', async () => {
    const host = await start();
    const client = await connect(host, '/bureau/jsonrpc');

    const subscribed = await client.call(1, 'bureau.events', {
      bureauId: host.bureau.id,
      kinds: ['run.registered'],
    });
    expect(subscribed).toMatchObject({ id: 1, result: { subscriptionId: expect.any(String) } });
    const delivered = client.next((frame) => frame['method'] === 'weft.events.deliver');
    const run = await host.bureau.tasks.start('assistant', 'Tell me when you start.');

    expect(await delivered).toMatchObject({
      method: 'weft.events.deliver',
      params: { envelope: { kind: 'run.registered', payload: { runId: run.id } } },
    });
  });

  test('is served beside an engine upgrade on the same listener', async () => {
    const host = await start();
    const bureau = await connect(host, '/bureau/jsonrpc');
    const engine = await connect(host, '/jsonrpc');

    const engineAnswer = await engine.call(1, 'weft.system.principal', {});
    const bureauAnswer = await bureau.call(1, 'bureau.events', { bureauId: host.bureau.id });

    expect(engineAnswer).toMatchObject({ id: 1, result: expect.any(Object) });
    expect(bureauAnswer).toMatchObject({ id: 1, result: { subscriptionId: expect.any(String) } });
  });

  test('is refused by the request guard exactly as an engine upgrade is', async () => {
    const host = await start();
    const foreignOrigin = { origin: 'https://attacker.example' };
    const reboundHost = { host: `attacker.example:${host.url.port}` };

    for (const path of ['/jsonrpc', '/bureau/jsonrpc']) {
      expect(await handshakeStatus(host, path, {}), path).toBe(101);
      expect(await handshakeStatus(host, path, foreignOrigin), `${path} from another origin`).toBe(
        403,
      );
      expect(await handshakeStatus(host, path, reboundHost), `${path} with a rebound Host`).toBe(
        403,
      );
    }
  });

  test('is answered as a plain request when the path is not one Bureau upgrades', async () => {
    const host = await start();

    const status = await handshakeStatus(host, '/bureau/v1/health', {});

    expect(status).toBe(200);
  });
});
