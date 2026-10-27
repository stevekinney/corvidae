import { describe, expect, test } from 'bun:test';

import type { HostedProcess } from '../bun/process-types.ts';
import { ClientEndpoint } from '../protocol/client-endpoint.ts';
import type { ServerMessage } from '../protocol/messages.ts';
import { createDeferred } from '../session/fixtures/deferred.ts';
import { ManualClock } from '../session/fixtures/manual-clock.ts';
import { SessionSlot } from '../session/session-slot.ts';
import {
  MAXIMUM_TIMER_MILLISECONDS,
  TerminalConnection,
  closeCodeForDenial,
  type ConnectionSettings,
  type TerminalSocket,
} from './terminal-connection.ts';
import { resolveWebSocketLimits } from './websocket-limits.ts';
import type { Authorization } from './websocket-types.ts';
import {
  LAUNCH,
  SESSION_IDENTIFIER,
  TICKET,
  scriptedProcess,
  type ScriptedProcess,
} from './websocket.test-support.ts';

const OPEN = 1;
const CLOSING = 2;

/** A socket the test controls completely: what it reports, and what it does when written to. */
class FakeSocket implements TerminalSocket {
  readonly data = { subject: 'user-1', expiresInMilliseconds: 3_600_000, profileId: 'shell' };
  readonly sent: (string | Uint8Array)[] = [];
  readonly closes: number[] = [];
  pings = 0;
  readyState = OPEN;
  sendStatus = 1;
  buffered = 0;
  closeThrows = false;
  pingThrows = false;

  send(frame: string | Uint8Array): number {
    if (this.sendStatus > 0 || this.sendStatus === -1) this.sent.push(frame);
    return this.sendStatus;
  }
  ping(): number {
    if (this.pingThrows) throw new Error('cannot ping');
    this.pings += 1;
    return 1;
  }
  close(code?: number): void {
    if (this.closeThrows) throw new Error('already closed');
    this.closes.push(code ?? 1005);
  }
  getBufferedAmount(): number {
    return this.buffered;
  }
}

type Rig = {
  readonly socket: FakeSocket;
  readonly connection: TerminalConnection;
  readonly process: ScriptedProcess;
  readonly clock: ManualClock;
  readonly slot: SessionSlot;
  readonly finished: TerminalConnection[];
  readonly client: ClientEndpoint;
  /** Everything the host sent that decoded for the client. */
  messages(): ServerMessage[];
};

function rig(
  options: {
    maximumBufferedBytes?: number;
    createProcess?: () => HostedProcess;
    socket?: FakeSocket;
    authorize?: ConnectionSettings['host']['authorize'];
    slotFor?: ConnectionSettings['slotFor'];
  } = {},
): Rig {
  const socket = options.socket ?? new FakeSocket();
  const process = scriptedProcess();
  const clock = new ManualClock();
  const slot = new SessionSlot();
  const finished: TerminalConnection[] = [];
  const connection = new TerminalConnection(
    socket,
    {
      host: {
        authenticate: () => ({ ok: false, denial: 'unauthenticated' }),
        authorize:
          options.authorize ?? (() => ({ allowed: true, grant: 'interactive', launch: LAUNCH })),
      },
      createProcess: options.createProcess ?? (() => process.hosted),
      clock,
      limits: resolveWebSocketLimits(
        options.maximumBufferedBytes === undefined
          ? {}
          : { maximumBufferedBytes: options.maximumBufferedBytes },
      ),
      slotFor: options.slotFor ?? (() => slot),
    },
    (done) => finished.push(done),
  );
  const client = new ClientEndpoint({
    sessionId: SESSION_IDENTIFIER,
    requestedMode: 'interactive',
    token: TICKET,
  });
  return {
    socket,
    connection,
    process,
    clock,
    slot,
    finished,
    client,
    messages: () => {
      const decoded: ServerMessage[] = [];
      const reader = new ClientEndpoint({
        sessionId: SESSION_IDENTIFIER,
        requestedMode: 'interactive',
        token: TICKET,
      });
      reader.hello();
      for (const frame of socket.sent) {
        const result = reader.receive(frame);
        if (result.ok) decoded.push(result.value);
      }
      return decoded;
    },
  };
}

async function attach(subject: Rig): Promise<void> {
  subject.connection.open();
  const hello = subject.client.hello();
  if (!hello.ok) throw new Error('no hello');
  await subject.connection.receive(hello.value);
}

describe('the principal lifetime', () => {
  /** A clock that only records what is asked of it, so a delay no real timer could hold can be inspected. */
  function recordingClock() {
    const scheduled: { callback: () => void; delay: number }[] = [];
    return {
      scheduled,
      clock: {
        schedule(callback: () => void, delay: number) {
          scheduled.push({ callback, delay });
          return () => undefined;
        },
      },
    };
  }

  function build(lifetime: number) {
    const socket = new FakeSocket();
    (socket.data as { expiresInMilliseconds: number }).expiresInMilliseconds = lifetime;
    const { scheduled, clock } = recordingClock();
    const process = scriptedProcess();
    const connection = new TerminalConnection(
      socket,
      {
        host: {
          authenticate: () => ({ ok: false, denial: 'unauthenticated' }),
          authorize: () => ({ allowed: true, grant: 'interactive', launch: LAUNCH }),
        },
        createProcess: () => process.hosted,
        clock,
        limits: resolveWebSocketLimits(),
        slotFor: () => new SessionSlot(),
      },
      () => undefined,
    );
    connection.open();
    // The first timer is the handshake deadline; the principal's lifetime follows it.
    return { socket, scheduled: () => scheduled.slice(1) };
  }

  test('a lifetime a timer can hold is one step', () => {
    const { socket, scheduled } = build(MAXIMUM_TIMER_MILLISECONDS);
    expect(scheduled().map((entry) => entry.delay)).toEqual([MAXIMUM_TIMER_MILLISECONDS]);
    scheduled()[0]?.callback();
    expect(socket.closes).toEqual([1008]);
  });

  test('a longer lifetime is waited out in steps that never exceed what a timer can hold', () => {
    // setTimeout treats a delay above the 32-bit maximum as 1 ms, which would revoke at once.
    const lifetime = 2 * MAXIMUM_TIMER_MILLISECONDS + 1_000;
    const { socket, scheduled } = build(lifetime);
    expect(scheduled().map((entry) => entry.delay)).toEqual([MAXIMUM_TIMER_MILLISECONDS]);
    scheduled()[0]?.callback();
    expect(socket.closes).toEqual([]);
    scheduled()[1]?.callback();
    expect(socket.closes).toEqual([]);
    expect(scheduled().map((entry) => entry.delay)).toEqual([
      MAXIMUM_TIMER_MILLISECONDS,
      MAXIMUM_TIMER_MILLISECONDS,
      1_000,
    ]);
    expect(scheduled().reduce((total, entry) => total + entry.delay, 0)).toBe(lifetime);
    scheduled()[2]?.callback();
    expect(socket.closes).toEqual([1008]);
  });
});

describe('closeCodeForDenial', () => {
  test('a refusal is a policy violation and an undecided host is a retry', () => {
    expect(closeCodeForDenial('forbidden')).toBe(1008);
    expect(closeCodeForDenial('unauthenticated')).toBe(1008);
    expect(closeCodeForDenial('expired')).toBe(1008);
    expect(closeCodeForDenial('unavailable')).toBe(1013);
  });
});

describe('sending to the socket', () => {
  test('a frame the socket queued under backpressure (status -1) is delivered, not failed, and not an acknowledgement', async () => {
    const subject = rig();
    subject.socket.sendStatus = -1;
    await attach(subject);
    expect(subject.messages().map((message) => message.kind)).toEqual(['capabilities']);
    expect(subject.socket.closes).toEqual([]);
    expect(subject.process.written).toEqual([]);
  });

  test('a frame the socket dropped (status 0) fails the attachment closed with the transport code', async () => {
    const subject = rig();
    subject.socket.sendStatus = 0;
    await attach(subject);
    expect(subject.socket.closes).toEqual([1011]);
    const summary = await subject.slot.current?.closed;
    expect(summary?.cause).toBe('protocol-failure');
    expect(subject.process.cleanups).toBe(1);
  });

  test('a socket that is no longer open fails the attachment instead of writing to it', async () => {
    const subject = rig();
    subject.socket.readyState = CLOSING;
    await attach(subject);
    expect(subject.socket.sent).toEqual([]);
    expect(subject.socket.closes).toEqual([1011]);
    const awaited21 = await subject.slot.current?.closed;
    expect(awaited21?.quarantined).toBe(false);
    expect(subject.process.cleanups).toBe(1);
  });

  test('a socket buffer above its bound fails the attachment: bufferedAmount is a limit, never an acknowledgement', async () => {
    const subject = rig({ maximumBufferedBytes: 64 * 1024 });
    await attach(subject);
    subject.socket.buffered = 64 * 1024 + 1;
    subject.process.stream.push(new TextEncoder().encode('output'));
    const summary = await subject.slot.current?.closed;
    expect(summary?.cause).toBe('protocol-failure');
    expect(subject.socket.closes).toEqual([1011]);
    expect(subject.process.cleanups).toBe(1);
  });

  test('a buffer exactly at its bound is still within it', async () => {
    const subject = rig({ maximumBufferedBytes: 64 * 1024 });
    await attach(subject);
    subject.socket.buffered = 64 * 1024;
    subject.process.stream.push(new TextEncoder().encode('output'));
    await subject.process.stream.source.kind;
    // load-proof: a negative window: the assertion that follows is that the socket was not closed, and load can delay a close but never create one
    await Bun.sleep(0);
    expect(subject.socket.closes).toEqual([]);
    expect(subject.messages().map((message) => message.kind)).toEqual(['capabilities', 'output']);
  });

  test('a close that throws on a socket that is already gone is swallowed', async () => {
    const subject = rig();
    subject.socket.closeThrows = true;
    subject.socket.sendStatus = 0;
    await attach(subject);
    await subject.slot.current?.closed;
    expect(subject.socket.closes).toEqual([]);
  });
});

describe('pings', () => {
  test('are scheduled after attach on the clock, repeat, and stop when the connection ends', async () => {
    const subject = rig();
    await attach(subject);
    subject.clock.advance(9_999);
    expect(subject.socket.pings).toBe(0);
    subject.clock.advance(1);
    expect(subject.socket.pings).toBe(1);
    subject.clock.advance(10_000);
    expect(subject.socket.pings).toBe(2);
    await subject.connection.transportClosed();
    subject.clock.advance(60_000);
    expect(subject.socket.pings).toBe(2);
    expect(subject.clock.pendingTimers).toBe(0);
  });

  test('a ping that throws does not end the loop', async () => {
    const subject = rig();
    await attach(subject);
    subject.socket.pingThrows = true;
    subject.clock.advance(10_000);
    subject.socket.pingThrows = false;
    subject.clock.advance(10_000);
    expect(subject.socket.pings).toBe(1);
  });

  test('a pong before the attachment exists proves nothing and a pong after extends the deadline', async () => {
    const subject = rig();
    subject.connection.noteTransportAlive();
    await attach(subject);
    subject.clock.advance(29_000);
    subject.connection.noteTransportAlive();
    subject.clock.advance(29_000);
    expect(subject.slot.current?.snapshot.closed).toBe(false);
    subject.clock.advance(1_000);
    const awaited22 = await subject.slot.current?.closed;
    expect(awaited22?.cause).toBe('liveness-expired');
  });
});

describe('failures inside the connection', () => {
  test('an exception while handling a frame closes the socket with 1011 and releases the session', async () => {
    const process = scriptedProcess();
    const hosted: HostedProcess = {
      ...process.hosted,
      reportExitTo: () => {
        throw new Error('cannot report the exit');
      },
    };
    const subject = rig({ createProcess: () => hosted });
    await attach(subject);
    expect(subject.socket.closes).toContain(1011);
    const awaited23 = await subject.slot.current?.closed;
    expect(awaited23?.cause).toBe('disconnect');
    expect(process.cleanups).toBe(1);
    // load-proof: the finish of the connection is a promise continuation of the cleanup already awaited, with no socket I/O pending, so a microtask drain completes it
    await Bun.sleep(0);
    expect(subject.finished).toContain(subject.connection);
  });

  test('a rejection from the exit report is contained', async () => {
    const process = scriptedProcess();
    const hosted: HostedProcess = {
      ...process.hosted,
      reportExitTo: () => Promise.reject(new Error('exit report failed')),
    };
    const subject = rig({ createProcess: () => hosted });
    await attach(subject);
    // load-proof: a negative window: the assertion that follows is that the socket was not closed, and load can delay a close but never create one
    await Bun.sleep(0);
    expect(subject.socket.closes).toEqual([]);
  });

  test('a slot provider that throws closes with 1011 before a session exists', async () => {
    const subject = rig({
      slotFor: () => {
        throw new Error('no slot');
      },
    });
    await attach(subject);
    expect(subject.socket.closes).toEqual([1011]);
    expect(subject.connection.sessionId).toBeUndefined();
  });

  test('a session that is refused by the slot after the process was made releases that process', async () => {
    const subject = rig();
    subject.slot.create({
      sessionId: '6d9d9a52-3a1e-4f67-8f7b-0c0f2f0c5e11',
      profile: { profileId: 'other' },
      dimensions: { columns: 80, rows: 24 },
      clock: subject.clock,
      sources: [],
    });
    await attach(subject);
    expect(subject.socket.closes).toEqual([1013]);
    expect(subject.process.cleanups).toBe(1);
  });

  test('a process whose cleanup rejects while being released does not stop the refusal', async () => {
    const process = scriptedProcess();
    process.backend.cleanup = () => Promise.reject(new Error('cleanup failed'));
    const subject = rig({ createProcess: () => process.hosted });
    subject.slot.create({
      sessionId: '6d9d9a52-3a1e-4f67-8f7b-0c0f2f0c5e11',
      profile: { profileId: 'other' },
      dimensions: { columns: 80, rows: 24 },
      clock: subject.clock,
      sources: [],
    });
    await attach(subject);
    expect(subject.socket.closes).toEqual([1013]);
  });

  test('a process whose sources the session cannot carry is released unstarted and the socket closes with 1011', async () => {
    const mismatched = scriptedProcess({ mode: 'pipe' });
    const hosted: HostedProcess = {
      ...mismatched.hosted,
      mode: 'pty',
      backend: scriptedProcess().backend,
      sources: mismatched.hosted.sources,
    };
    const subject = rig({ createProcess: () => hosted });
    await attach(subject);
    expect(subject.socket.closes).toEqual([1011]);
    expect(subject.slot.current).toBeUndefined();
  });

  test('a release that rejects does not stop the socket from closing', async () => {
    const mismatched = scriptedProcess({ mode: 'pipe' });
    const backend = scriptedProcess().backend;
    backend.cleanup = () => Promise.reject(new Error('cleanup failed'));
    const subject = rig({
      createProcess: () => ({
        ...mismatched.hosted,
        mode: 'pty',
        backend,
        sources: mismatched.hosted.sources,
      }),
    });
    await attach(subject);
    expect(subject.socket.closes).toEqual([1011]);
  });

  test('a connection depth shallower than the session FIFO is refused when the connection is built', async () => {
    // Bypass the limits resolver, which would refuse this at construction, to reach the guard in the connection.
    const subject = rig();
    const limits = resolveWebSocketLimits({}, { operationQueueLimit: 1 });
    const connection = new TerminalConnection(
      subject.socket,
      {
        host: {
          authenticate: () => ({ ok: false, denial: 'unauthenticated' }),
          authorize: () => ({ allowed: true, grant: 'interactive', launch: LAUNCH }),
        },
        createProcess: () => subject.process.hosted,
        clock: subject.clock,
        limits: { ...limits, budgets: { ...limits.budgets, operationQueueLimit: 300 } },
        slotFor: () => subject.slot,
      },
      () => undefined,
    );
    connection.open();
    const hello = subject.client.hello();
    if (!hello.ok) throw new Error('no hello');
    await connection.receive(hello.value);
    expect(subject.socket.closes).toEqual([1011]);
    const awaited24 = await subject.slot.current?.closed;
    expect(awaited24?.cause).toBe('host-dispose');
  });
});

describe('frames before the attachment exists', () => {
  test('a frame that arrives while the hello is still being authorized is a protocol violation, never queued', async () => {
    const decision = createDeferred<Authorization>();
    const subject = rig({ authorize: () => decision.promise });
    subject.connection.open();
    const hello = subject.client.hello();
    if (!hello.ok) throw new Error('no hello');
    const pending = subject.connection.receive(hello.value);
    // load-proof: the connection is driven through its in-memory socket double, so the pending receive reaches its admission wait inside the promise chain
    await Bun.sleep(0);
    await subject.connection.receive('x'.repeat(100));
    expect(subject.socket.closes).toEqual([1002]);
    decision.resolve({ allowed: true, grant: 'interactive', launch: LAUNCH });
    await pending;
    expect(subject.slot.current).toBeUndefined();
    expect(subject.process.cleanups).toBe(0);
  });

  test('a second frame arriving in the same turn as the hello is the same violation', async () => {
    const subject = rig();
    subject.connection.open();
    const hello = subject.client.hello();
    if (!hello.ok) throw new Error('no hello');
    const first = subject.connection.receive(hello.value);
    const second = subject.connection.receive('{}');
    await Promise.all([first, second]);
    expect(subject.socket.closes).toContain(1002);
    expect(subject.slot.current).toBeUndefined();
  });
});

describe('release failures', () => {
  test('a release that rejects still finishes the connection, so it leaves the registry', async () => {
    // The session is built, then the connection is refused for a depth mismatch; its dispose rejects.
    const subject = rig({
      slotFor: () =>
        ({
          create: (options: Parameters<SessionSlot['create']>[0]) => {
            const admission = real.create(options);
            if (admission.accepted) {
              admission.session.dispose = () => Promise.reject(new Error('dispose failed'));
            }
            return admission;
          },
        }) as unknown as SessionSlot,
    });
    const real = subject.slot;
    const limits = resolveWebSocketLimits({}, { operationQueueLimit: 1 });
    const finished: TerminalConnection[] = [];
    const connection = new TerminalConnection(
      subject.socket,
      {
        host: {
          authenticate: () => ({ ok: false, denial: 'unauthenticated' }),
          authorize: () => ({ allowed: true, grant: 'interactive', launch: LAUNCH }),
        },
        createProcess: () => subject.process.hosted,
        clock: subject.clock,
        limits: { ...limits, budgets: { ...limits.budgets, operationQueueLimit: 300 } },
        slotFor: () =>
          ({
            create: (options: Parameters<SessionSlot['create']>[0]) => {
              const admission = real.create(options);
              if (admission.accepted) {
                admission.session.dispose = () => Promise.reject(new Error('dispose failed'));
              }
              return admission;
            },
          }) as unknown as SessionSlot,
      },
      (done) => finished.push(done),
    );
    connection.open();
    const hello = subject.client.hello();
    if (!hello.ok) throw new Error('no hello');
    await connection.receive(hello.value);
    // load-proof: the rejecting dispose and the finish are promise continuations of the received hello on in-memory doubles, so a microtask drain completes them
    await Bun.sleep(0);
    expect(subject.socket.closes).toEqual([1011]);
    expect(finished).toContain(connection);
    // The socket closing afterwards releases again, through the same rejecting dispose, and still finishes.
    finished.length = 0;
    await connection.transportClosed();
    expect(finished).toContain(connection);
  });
});

describe('ending', () => {
  test('transportClosed is idempotent and reports the connection finished', async () => {
    const subject = rig();
    await attach(subject);
    await subject.connection.transportClosed();
    await subject.connection.transportClosed();
    expect(subject.process.cleanups).toBe(1);
    expect(subject.finished.length).toBeGreaterThanOrEqual(1);
  });

  test('revoke is a no-op on a connection that already ended', async () => {
    const subject = rig();
    await attach(subject);
    await subject.connection.transportClosed();
    const closes = [...subject.socket.closes];
    await subject.connection.revoke();
    expect(subject.socket.closes).toEqual(closes);
  });

  test('frames that arrive after the connection ended are dropped', async () => {
    const subject = rig();
    subject.connection.open();
    await subject.connection.transportClosed();
    await subject.connection.receive('{"kind":"hello"}');
    expect(subject.socket.closes).toEqual([]);
    expect(subject.process.cleanups).toBe(0);
  });

  test('a rejected authorization ends the connection once, however many times it is asked to', async () => {
    const subject = rig({ authorize: () => ({ allowed: false, denial: 'forbidden' }) });
    await attach(subject);
    await subject.connection.revoke();
    expect(subject.socket.closes).toEqual([1008]);
  });
});
