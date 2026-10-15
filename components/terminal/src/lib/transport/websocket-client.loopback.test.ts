import {
  ManualClock,
  SessionSlot,
  createDeferred,
  createScriptedBackend,
  createScriptedStream,
  type Session,
} from '@lostgradient/ventriloquist';
import type { HostedProcess } from '@lostgradient/ventriloquist/bun';
import {
  createTerminalWebSocketServer,
  type AuthorizationRequest,
  type SocketData,
} from '@lostgradient/ventriloquist/websocket';
import { afterEach, describe, expect, test } from 'bun:test';

import { createFakeInputEngine, createInputSettings } from '../input/input-test-support.ts';
import { createTerminalInput } from '../input/terminal-input.ts';
import type {
  BrowserSocket,
  TerminalTransportEvent,
  TerminalTransportState,
} from './transport-types.ts';
import { TerminalWebSocketClient } from './websocket-client.ts';

/**
 * The client against the real server over a real loopback socket. The host here is a scripted
 * process behind the real upgrade gate, so the cookie, the origin and the wire are all the real
 * thing. Nothing starts a process.
 */
const ORIGIN = 'https://terminal.example';
const COOKIE = 'sid=valid';
const SESSION_IDENTIFIER = '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10';
const TICKET = 'host-ticket';

type Loopback = {
  readonly url: string;
  readonly clock: ManualClock;
  readonly written: string[];
  readonly authorizations: AuthorizationRequest[];
  readonly sockets: BrowserSocket[];
  readonly cleanups: () => number;
  push(text: string): void;
  session(): Session;
  writes(count: number): Promise<void>;
  createClient(options?: { cookie?: string; origin?: string }): TerminalWebSocketClient;
  stop(): Promise<void>;
};

const running: Loopback[] = [];
afterEach(async () => {
  for (const loopback of running.splice(0)) await loopback.stop();
});

function startLoopback(window = 256): Loopback {
  const clock = new ManualClock();
  const slot = new SessionSlot();
  const stream = createScriptedStream('pty');
  const written: string[] = [];
  const waiters: { count: number; resolve(): void }[] = [];
  const authorizations: AuthorizationRequest[] = [];
  const sockets: BrowserSocket[] = [];
  let cleanups = 0;
  const backend = createScriptedBackend({
    write: (bytes) => {
      written.push(new TextDecoder().decode(bytes));
      for (const waiter of waiters.splice(0)) {
        if (written.length >= waiter.count) waiter.resolve();
        else waiters.push(waiter);
      }
      return Promise.resolve();
    },
    cleanup: () => {
      cleanups += 1;
      return Promise.resolve('complete');
    },
  });
  const exit = createDeferred<void>();
  const hosted: HostedProcess = {
    mode: 'pty',
    backend,
    sources: [stream.source],
    startFailure: undefined,
    reportExitTo: async (receiver) => {
      await receiver.start();
      await exit.promise;
    },
  };
  const terminal = createTerminalWebSocketServer({
    host: {
      authenticate: (request) =>
        request.headers.get('cookie') === COOKIE
          ? { ok: true, subject: 'user-1', expiresInMilliseconds: 3_600_000 }
          : { ok: false, denial: 'unauthenticated' },
      authorize: (request) => {
        authorizations.push(request);
        return {
          allowed: true,
          grant: 'interactive',
          launch: {
            mode: 'pty',
            profile: {
              executable: '/bin/sh',
              argumentList: [],
              workingDirectory: '/',
              environment: {},
            },
            dimensions: { columns: 80, rows: 24 },
          },
        };
      },
    },
    createProcess: () => hosted,
    allowedOrigins: [ORIGIN],
    allowInsecureLoopback: true,
    slotFor: () => slot,
    clock,
    limits: { maxQueuedOperations: window },
    budgets: { operationQueueLimit: window },
  });
  const server = Bun.serve<SocketData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch: (request, listener) => terminal.handleUpgrade(request, listener),
    websocket: terminal.websocket,
  });
  const url = `ws://127.0.0.1:${server.port}/terminal?profile=shell`;
  const loopback: Loopback = {
    url,
    clock,
    written,
    authorizations,
    sockets,
    cleanups: () => cleanups,
    push: (text) => stream.push(new TextEncoder().encode(text)),
    session: () => slot.current as Session,
    writes: (count) => {
      if (written.length >= count) return Promise.resolve();
      return new Promise((resolve) => waiters.push({ count, resolve }));
    },
    createClient: (options = {}) =>
      new TerminalWebSocketClient({
        url,
        sessionId: SESSION_IDENTIFIER,
        ticket: TICKET,
        allowInsecureLoopback: true,
        createSocket: (address) => {
          // A browser sends its own Origin and the page's cookie; the headers stand in for both.
          const socket = new WebSocket(address, {
            headers: { Origin: options.origin ?? ORIGIN, Cookie: options.cookie ?? COOKIE },
          } as never) as unknown as BrowserSocket;
          sockets.push(socket);
          return socket;
        },
      }),
    async stop() {
      exit.resolve();
      await terminal.close();
      await server.stop(true);
    },
  };
  running.push(loopback);
  return loopback;
}

/** Resolves the next time the client reports `state`. */
function reaches(client: TerminalWebSocketClient, state: TerminalTransportState): Promise<void> {
  if (client.state === state) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = client.subscribeState((next) => {
      if (next !== state) return;
      stop();
      resolve();
    });
  });
}

describe('over a real loopback socket', () => {
  test('attaches with the host cookie and origin, and the address carries no credential', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    const capabilities = await client.connect();
    expect(capabilities.input).toBe(true);
    expect(client.state).toBe('writable');
    expect(loopback.authorizations).toEqual([
      {
        subject: 'user-1',
        profileId: 'shell',
        sessionId: SESSION_IDENTIFIER,
        requestedMode: 'interactive',
        operation: 'attach',
        ticket: TICKET,
      },
    ]);
    expect(loopback.url).not.toContain(COOKIE);
    expect(loopback.url).not.toContain(TICKET);
    client.close();
  });

  test.each([
    ['a missing cookie', { cookie: '' }],
    ['a cookie the host rejects', { cookie: 'sid=forged' }],
    ['a foreign origin', { origin: 'https://evil.example' }],
  ])('%s is refused at the upgrade and never reaches the host', async (_name, options) => {
    const loopback = startLoopback();
    const client = loopback.createClient(options);
    const failure = await client.connect().then(
      () => 'connected',
      (error: { reason: string }) => error.reason,
    );
    expect(failure).not.toBe('connected');
    expect(client.state).toBe('failed');
    expect(loopback.authorizations).toEqual([]);
  });

  test('input is acknowledged by the host, and arrives as the exact bytes', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    await client.connect();
    expect(await client.sendInput('ls -l\r')).toEqual({ status: 'accepted', sequence: 1 });
    await loopback.writes(1);
    expect(loopback.written).toEqual(['ls -l\r']);
    expect(await client.sendResize(120, 40)).toEqual({ status: 'accepted', sequence: 2 });
    client.close();
  });

  test('output is acknowledged only by the parse report: receipt alone leaves the host holding it', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    await client.connect();
    const received = createDeferred<void>();
    client.subscribeOutput(() => received.resolve());
    loopback.push('héllo → 世界');
    await received.promise;
    // Received, never parsed: the host still counts every byte as unavailable.
    const awaited2 = await client.stop();
    expect(awaited2.outcome).toBe('complete');
    const summary = await loopback.session().closed;
    expect(summary.drain.state).toBe('truncated');
    expect(summary.drain.unavailableBytes).toBe(new TextEncoder().encode('héllo → 世界').length);
  });

  test('a parse report acknowledges exactly the byte count, and the host drains', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    await client.connect();
    const received = createDeferred<void>();
    client.subscribeOutput((_chunk, parsed) => {
      parsed();
      received.resolve();
    });
    loopback.push('héllo → 世界');
    await received.promise;
    // The acknowledgement travels ahead of the terminate on the same ordered socket.
    const awaited3 = await client.stop();
    expect(awaited3.outcome).toBe('complete');
    const summary = await loopback.session().closed;
    expect(summary.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
  });

  test('stop revokes authority, the host cleans up, and the client reports the host result', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    await client.connect();
    expect(await client.stop()).toEqual({ outcome: 'complete', source: 'host' });
    expect(client.state).toBe('disconnected');
    expect(loopback.cleanups()).toBe(1);
  });

  test('a dropped socket is disconnected, nothing reconnects, and the host cleans up the process it owned', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    await client.connect();
    const events: TerminalTransportEvent[] = [];
    client.subscribe((event) => events.push(event));
    const session = loopback.session();
    const disconnected = reaches(client, 'disconnected');
    // The listener goes away without a close handshake, as a killed server or a cut cable does.
    (loopback.sockets[0] as unknown as { terminate(): void }).terminate();
    await disconnected;
    expect(events.map((event) => event.type)).toContain('transport-error');
    const awaited4 = await session.closed;
    expect(awaited4.cause).toBe('disconnect');
    expect(loopback.cleanups()).toBe(1);
    expect(loopback.sockets).toHaveLength(1);
    expect(client.authorityRevoked).toBe(true);
    expect(await client.sendInput('x')).toMatchObject({ status: 'refused' });
  });

  test('liveness expiry on the host is a cleanup report then a close, and the client does not come back', async () => {
    const loopback = startLoopback();
    const client = loopback.createClient();
    await client.connect();
    loopback.clock.advance(30_000);
    await reaches(client, 'disconnected');
    const awaited5 = await loopback.session().closed;
    expect(awaited5.cause).toBe('liveness-expired');
    expect(loopback.sockets).toHaveLength(1);
  });
});

describe('backpressure over a real socket', () => {
  test('fills the window, goes backpressured, holds a keystroke, and delivers one typed after the window frees', async () => {
    const loopback = startLoopback(4);
    const client = loopback.createClient();
    await client.connect();
    const element = document.createElement('div');
    document.body.append(element);
    const engine = createFakeInputEngine();
    const input = createTerminalInput({
      engine,
      host: element,
      controller: client.input,
      readSettings: () => createInputSettings({ writable: client.state === 'writable' }),
      onCaptureChange: () => {},
      onReview: () => {},
      onRefused: () => {},
    });
    client.subscribeState(() => queueMicrotask(() => input.refresh()));
    const states: TerminalTransportState[] = [];
    client.subscribeState((state) => states.push(state));

    // Four keystrokes in one turn fill the window before any acknowledgement can return.
    for (const key of ['1', '2', '3', '4']) engine.report({ kind: 'text', data: key });
    // The fifth is refused, the transport reports backpressured, and the sixth is held.
    engine.report({ kind: 'text', data: '5' });
    expect(client.state).toBe('backpressured');
    engine.report({ kind: 'text', data: '6' });
    await Promise.resolve();

    // The host's acknowledgements free the window and the state returns to writable.
    await reaches(client, 'writable');
    expect(states).toEqual(['backpressured', 'writable']);
    await Promise.resolve();
    engine.report({ kind: 'text', data: '7' });
    await loopback.writes(5);
    expect(loopback.written).toEqual(['1', '2', '3', '4', '7']);
    element.remove();
    client.close();
  });

  test('sendInput reports the refusal and the recovery without any terminal in between', async () => {
    const loopback = startLoopback(2);
    const client = loopback.createClient();
    await client.connect();
    const first = client.sendInput('a');
    const second = client.sendInput('b');
    const refused = await client.sendInput('c');
    expect(refused).toMatchObject({ status: 'refused', code: 'fifo-full' });
    expect(client.state).toBe('backpressured');
    expect(await first).toMatchObject({ status: 'accepted' });
    expect(await second).toMatchObject({ status: 'accepted' });
    expect(client.state).toBe('writable');
    expect(await client.sendInput('d')).toMatchObject({ status: 'accepted' });
    await loopback.writes(3);
    expect(loopback.written).toEqual(['a', 'b', 'd']);
    client.close();
  });
});
