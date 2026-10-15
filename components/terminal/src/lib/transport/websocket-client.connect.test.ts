import { describe, expect, test } from 'bun:test';

import {
  FakeSocket,
  READ_ONLY,
  SESSION_IDENTIFIER,
  TICKET,
  WRITABLE,
  rig,
} from './transport-test-support.ts';
import type { TerminalTransportEvent, TerminalTransportState } from './transport-types.ts';
import { TerminalConnectError, TerminalWebSocketClient } from './websocket-client.ts';

async function rejection(promise: Promise<unknown>): Promise<TerminalConnectError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TerminalConnectError) return error;
    throw error;
  }
  throw new Error('expected the connection to be refused');
}

describe('connect', () => {
  test('makes no socket until connect is called, and starts empty', () => {
    const { client, sockets } = rig();
    expect(client.state).toBe('empty');
    expect(sockets).toEqual([]);
    expect(client.capabilities).toBeUndefined();
    expect(client.terms).toBeUndefined();
    expect(client.authorityRevoked).toBe(false);
  });

  test('opens one socket to the address, asks for binary frames as buffers, and says hello once it is open', async () => {
    const subject = rig();
    const connected = subject.client.connect();
    const socket = subject.socket();
    expect(socket.url).toBe('wss://terminal.example/terminal?profile=shell');
    expect(socket.binaryType).toBe('arraybuffer');
    expect(subject.client.state).toBe('connecting');
    expect(socket.sent).toEqual([]);
    socket.open();
    const [hello] = subject.fromClient();
    expect(hello).toEqual({
      kind: 'hello',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      requestedMode: 'interactive',
      token: TICKET,
    });
    subject.serve(subject.host.issueCapabilities({ generation: 7, capabilities: WRITABLE }));
    const capabilities = await connected;
    expect(capabilities).toEqual(WRITABLE);
    expect(subject.client.state).toBe('writable');
    expect(subject.client.capabilities).toEqual(WRITABLE);
    expect(subject.client.terms).toMatchObject({ generation: 7, maxFrameBytes: 65_536 });
  });

  test('the ticket is the only secret in the hello and never appears in the address', async () => {
    const subject = rig();
    await subject.attach();
    expect(subject.socket().url).not.toContain(TICKET);
    expect(JSON.stringify(subject.socket().sent[0])).toContain(TICKET);
  });

  test('a read-only grant is read-only, and reports the grant', async () => {
    const subject = rig({ requestedMode: 'read-only' });
    await subject.attach(READ_ONLY);
    expect(subject.client.state).toBe('read-only');
    expect(subject.client.capabilities).toEqual(READ_ONLY);
  });

  test('reports the state changes and the capabilities, in order, to anyone listening', async () => {
    const subject = rig();
    const states: TerminalTransportState[] = [];
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribeState((state) => states.push(state));
    subject.client.subscribe((event) => events.push(event));
    await subject.attach();
    expect(states).toEqual(['connecting', 'writable']);
    expect(events.map((event) => event.type)).toEqual(['state', 'state', 'capabilities']);
  });

  test('an unsubscribed listener hears nothing more', async () => {
    const subject = rig();
    const states: TerminalTransportState[] = [];
    const events: string[] = [];
    const stopStates = subject.client.subscribeState((state) => states.push(state));
    const stopEvents = subject.client.subscribe((event) => events.push(event.type));
    stopStates();
    stopEvents();
    await subject.attach();
    expect(states).toEqual([]);
    expect(events).toEqual([]);
  });

  test('is single-use: a second connect is refused and opens nothing', async () => {
    const subject = rig();
    await subject.attach();
    const second = await rejection(subject.client.connect());
    expect(second.reason).toBe('already-used');
    expect(subject.sockets).toHaveLength(1);
  });

  test('a client that was closed before it connected cannot connect', async () => {
    const subject = rig();
    subject.client.close();
    expect(subject.client.state).toBe('empty');
    const awaited1 = await rejection(subject.client.connect());
    expect(awaited1.reason).toBe('already-used');
    expect(subject.sockets).toEqual([]);
  });

  test('refuses an address that carries a credential before any socket exists', () => {
    expect(
      () =>
        new TerminalWebSocketClient({
          url: 'wss://terminal.example/terminal?profile=shell&token=hunter2',
          sessionId: SESSION_IDENTIFIER,
          ticket: TICKET,
        }),
    ).toThrow('only the profile parameter');
  });

  test('allows a plain ws: address to loopback only with the switch', () => {
    const options = { sessionId: SESSION_IDENTIFIER, ticket: TICKET };
    expect(
      () =>
        new TerminalWebSocketClient({
          ...options,
          url: 'ws://localhost:3000/terminal?profile=shell',
        }),
    ).toThrow('loopback');
    expect(
      () =>
        new TerminalWebSocketClient({
          ...options,
          url: 'ws://localhost:3000/terminal?profile=shell',
          allowInsecureLoopback: true,
        }),
    ).not.toThrow();
  });

  test('uses the browser WebSocket when no socket factory is supplied', async () => {
    const original = globalThis.WebSocket;
    const made: string[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        made.push(url);
      }
    }
    Object.defineProperty(globalThis, 'WebSocket', { value: RecordingSocket, configurable: true });
    try {
      const client = new TerminalWebSocketClient({
        url: 'wss://terminal.example/terminal?profile=shell',
        sessionId: SESSION_IDENTIFIER,
        ticket: TICKET,
      });
      void client.connect().catch(() => undefined);
      expect(made).toEqual(['wss://terminal.example/terminal?profile=shell']);
      client.close();
    } finally {
      Object.defineProperty(globalThis, 'WebSocket', { value: original, configurable: true });
    }
  });
});

describe('a connection that does not complete', () => {
  test('a handshake that takes too long fails, closes the socket and rejects', async () => {
    const subject = rig({ connectTimeoutMilliseconds: 5_000 });
    const connected = subject.client.connect();
    subject.socket().open();
    subject.clock.advance(4_999);
    expect(subject.client.state).toBe('connecting');
    subject.clock.advance(1);
    const failure = await rejection(connected);
    expect(failure.reason).toBe('handshake-timeout');
    expect(subject.client.state).toBe('failed');
    expect(subject.socket().closes).toEqual([1000]);
    expect(subject.clock.pendingTimers).toBe(0);
  });

  test('the timer does not outlive a completed handshake', async () => {
    const subject = rig();
    await subject.attach();
    expect(subject.clock.pendingTimers).toBe(0);
  });

  test('a socket the browser refuses to open is a failed connection', async () => {
    const subject = rig();
    const connected = subject.client.connect();
    subject.socket().fail();
    subject.socket().drop(1006);
    const failure = await rejection(connected);
    expect(failure.reason).toBe('closed');
    expect(subject.client.state).toBe('failed');
    expect(subject.client.authorityRevoked).toBe(true);
  });

  test('a refusal by the host, a 1008 close before any capabilities, is denied', async () => {
    const subject = rig();
    const states: TerminalTransportState[] = [];
    subject.client.subscribeState((state) => states.push(state));
    const connected = subject.client.connect();
    subject.socket().open();
    subject.socket().drop(1008);
    const failure = await rejection(connected);
    expect(failure.reason).toBe('denied');
    expect(subject.client.state).toBe('denied');
    expect(states).toEqual(['connecting', 'denied']);
  });

  test('reports the unexpected loss of the transport', async () => {
    const subject = rig();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    const connected = subject.client.connect();
    subject.socket().drop(1006);
    await rejection(connected);
    expect(events).toContainEqual({ type: 'transport-error', cause: 'closed', closeCode: 1006 });
  });

  test('a factory that throws is a failed connection with no socket', async () => {
    const subject = rig({
      createSocket: () => {
        throw new Error('no WebSocket here');
      },
    });
    const failure = await rejection(subject.client.connect());
    expect(failure.reason).toBe('socket-unavailable');
    expect(subject.client.state).toBe('failed');
    expect(subject.clock.pendingTimers).toBe(0);
  });

  test('a hello the socket cannot send is a failed connection', async () => {
    const subject = rig();
    const connected = subject.client.connect();
    subject.socket().sendThrows = true;
    subject.socket().open();
    const failure = await rejection(connected);
    expect(failure.reason).toBe('closed');
    expect(subject.client.state).toBe('failed');
  });

  test('a startup failure before any capabilities is reported with its code and is never an exit', async () => {
    const subject = rig();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    const connected = subject.client.connect();
    subject.socket().open();
    subject.fromClient();
    subject.serve(subject.host.attachmentError('spawn-failed', 'the backend failed to start'));
    const failure = await rejection(connected);
    expect(failure.reason).toBe('startup-failed');
    expect(failure.code).toBe('spawn-failed');
    expect(subject.client.state).toBe('failed');
    expect(events).toContainEqual({
      type: 'attachment-error',
      code: 'spawn-failed',
      message: 'the backend failed to start',
    });
    subject.socket().drop(1011);
    expect(subject.client.state).toBe('failed');
  });

  test('a frame the protocol rejects while connecting fails the connection and closes with its code', async () => {
    const subject = rig();
    const connected = subject.client.connect();
    subject.socket().open();
    subject.socket().deliver('this is not a frame');
    const failure = await rejection(connected);
    expect(failure.reason).toBe('protocol');
    expect(failure.code).toBe('malformed-frame');
    expect(subject.client.state).toBe('failed');
    expect(subject.socket().closes).toEqual([1002]);
  });

  test('a frame of a type the browser should never deliver fails closed', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.socket().deliver(new Blob(['x']));
    expect(subject.client.state).toBe('failed');
    expect(events).toContainEqual({
      type: 'transport-error',
      cause: 'protocol',
      failure: 'malformed-frame',
    });
  });

  test('a second capabilities frame on an attached connection breaks the protocol', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().deliver(
      JSON.stringify({
        kind: 'capabilities',
        version: 1,
        direction: 'server-to-client',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: 1,
        capabilities: WRITABLE,
        maxFrameBytes: 65_536,
        maxQueuedOperations: 256,
      }),
    );
    expect(subject.client.state).toBe('failed');
    expect(subject.socket().closes).toEqual([1002]);
  });
});

describe('frames for another attachment', () => {
  test('a frame addressed to another session proves nothing and is ignored', async () => {
    const subject = rig();
    await subject.attach();
    const states: TerminalTransportState[] = [];
    subject.client.subscribeState((state) => states.push(state));
    subject.socket().deliver(
      JSON.stringify({
        kind: 'operation-ack',
        version: 1,
        direction: 'server-to-client',
        sessionId: '6d9d9a52-3a1e-4f67-8f7b-0c0f2f0c5e11',
        attachmentGeneration: 1,
        sequence: 1,
        operationSequence: 1,
      }),
    );
    expect(subject.client.state).toBe('writable');
    expect(states).toEqual([]);
  });
});
