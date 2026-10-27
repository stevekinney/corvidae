import { describe, expect, test } from 'bun:test';

import { createDeferred } from '../session/fixtures/deferred.ts';
import { SessionSlot } from '../session/session-slot.ts';
import type { Authorization } from './websocket-types.ts';
import {
  LAUNCH,
  SECOND_SESSION_IDENTIFIER,
  SESSION_COOKIE,
  SESSION_IDENTIFIER,
  connect,
  scriptedProcess,
  startHarness,
} from './websocket.test-support.ts';

describe('expiry of the principal', () => {
  const expiring = (milliseconds: number) => ({
    authentication: () => ({
      ok: true as const,
      subject: 'user-1',
      expiresInMilliseconds: milliseconds,
    }),
  });

  test('freezes input and starts cleanup when the lifetime ends, and not before', async () => {
    const harness = startHarness(expiring(5_000));
    try {
      const client = connect(harness);
      await client.handshake();
      harness.clock.advance(4_999);
      expect(harness.session().snapshot.closed).toBe(false);
      harness.clock.advance(1);
      const summary = await harness.session().closed;
      expect(summary.cause).toBe('authorization-revoked');
      const awaited25 = await client.waitForKind('cleanup-result');
      expect(awaited25.outcome).toBe('complete');
      const awaited26 = await client.closed;
      expect(awaited26.code).toBe(1000);
      expect(harness.process.cleanups).toBe(1);
    } finally {
      await harness.stop();
    }
  });

  test('operations still queued when authority ends are canceled, never run late', async () => {
    const harness = startHarness(expiring(5_000));
    try {
      const client = connect(harness);
      await client.handshake();
      harness.process.stallWrites();
      for (const text of ['a', 'b']) {
        client.sendResult(client.endpoint.input(text));
      }
      await client.waitFor(
        (message) => message.kind === 'operation-ack' && message.operationSequence === 2,
      );
      await harness.process.writes(1);
      harness.clock.advance(5_000);
      const failure = await client.waitForKind('operation-failure');
      expect(failure.operationSequence).toBe(2);
      harness.process.releaseWrites();
      await harness.session().closed;
      expect(harness.process.written.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
        'a',
      ]);
    } finally {
      await harness.stop();
    }
  });

  test('closes a socket that has not said hello when its lifetime ends', async () => {
    const harness = startHarness(expiring(1_000));
    try {
      const client = connect(harness);
      await client.opened;
      harness.clock.advance(1_000);
      const awaited27 = await client.closed;
      expect(awaited27.code).toBe(1008);
      expect(harness.clock.pendingTimers).toBe(0);
      expect(harness.slot.current).toBeUndefined();
    } finally {
      await harness.stop();
    }
  });

  test('a lifetime that ends while the host is deciding creates nothing', async () => {
    const decision = createDeferred<Authorization>();
    let created = 0;
    const harness = startHarness({
      ...expiring(1_000),
      authorization: () => decision.promise,
      createProcess: () => {
        created += 1;
        return scriptedProcess().hosted;
      },
    });
    try {
      const client = connect(harness);
      await client.opened;
      client.hello();
      // load-proof: the hello reaches the pending authorization inside the promise chain on the in-memory harness, and the clock then advances by hand, not by time
      await Bun.sleep(0);
      harness.clock.advance(1_000);
      const awaited28 = await client.closed;
      expect(awaited28.code).toBe(1008);
      decision.resolve({ allowed: true, grant: 'interactive', launch: LAUNCH });
      // load-proof: a negative window: the assertion that follows is that no session was created after the revocation, and load can delay a creation but never cause one
      await Bun.sleep(0);
      expect(created).toBe(0);
    } finally {
      await harness.stop();
    }
  });
});

describe('revocation by the host', () => {
  test('revokeSession matches the subject as well as the session, so a shared identity revokes only the named one', async () => {
    const processes = [scriptedProcess(), scriptedProcess()];
    let next = 0;
    const slots = new Map<string, SessionSlot>();
    const harness = startHarness({
      authentication: (request) => ({
        ok: true,
        subject: request.headers.get('cookie') === SESSION_COOKIE ? 'user-1' : 'user-2',
        expiresInMilliseconds: 3_600_000,
      }),
      createProcess: () => (processes[next++] as ReturnType<typeof scriptedProcess>).hosted,
      server: {
        slotFor: (subject) => {
          const slot = slots.get(subject) ?? new SessionSlot();
          slots.set(subject, slot);
          return slot;
        },
      },
    });
    try {
      const first = connect(harness);
      const second = connect(harness, { cookie: 'sid=other' });
      await first.handshake();
      await second.handshake();
      expect(await harness.terminal.revokeSession('user-2', SESSION_IDENTIFIER)).toBe(true);
      await second.closed;
      expect(processes[1]?.cleanups).toBe(1);
      expect(first.socket.readyState).toBe(WebSocket.OPEN);
      expect(processes[0]?.cleanups).toBe(0);
      expect(await harness.terminal.revokeSession('user-3', SESSION_IDENTIFIER)).toBe(false);
    } finally {
      await harness.stop();
    }
  });

  test('revokeSubject freezes every attachment of that subject and reports how many', async () => {
    const harness = startHarness({
      authentication: (request) => ({
        ok: true,
        subject: request.headers.get('cookie') === SESSION_COOKIE ? 'user-1' : 'user-2',
        expiresInMilliseconds: 3_600_000,
      }),
    });
    try {
      const client = connect(harness);
      await client.handshake();
      expect(await harness.terminal.revokeSubject('user-2')).toBe(0);
      expect(harness.session().snapshot.closed).toBe(false);
      expect(await harness.terminal.revokeSubject('user-1')).toBe(1);
      const awaited29 = await harness.session().closed;
      expect(awaited29.cause).toBe('authorization-revoked');
      const awaited30 = await client.waitForKind('cleanup-result');
      expect(awaited30.outcome).toBe('complete');
      const awaited31 = await client.closed;
      expect(awaited31.code).toBe(1000);
    } finally {
      await harness.stop();
    }
  });

  test('revokeSession finds the attachment by session identity and refuses an unknown one', async () => {
    const harness = startHarness();
    try {
      const client = connect(harness);
      const { sessionId } = await client.handshake();
      expect(await harness.terminal.revokeSession('user-1', SECOND_SESSION_IDENTIFIER)).toBe(false);
      expect(await harness.terminal.revokeSession('user-1', sessionId)).toBe(true);
      const awaited32 = await harness.session().closed;
      expect(awaited32.cause).toBe('authorization-revoked');
      await client.closed;
      expect(harness.process.cleanups).toBe(1);
    } finally {
      await harness.stop();
    }
  });

  test('input sent after revocation is not run', async () => {
    const harness = startHarness();
    try {
      const client = connect(harness);
      await client.handshake();
      harness.process.stallWrites();
      client.sendResult(client.endpoint.input('first'));
      await harness.process.writes(1);
      const revoking = harness.terminal.revokeSubject('user-1');
      client.sendResult(client.endpoint.input('late'));
      harness.process.releaseWrites();
      await revoking;
      await client.closed;
      expect(harness.process.written.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
        'first',
      ]);
    } finally {
      await harness.stop();
    }
  });

  test('revoking a socket that has not yet said hello closes it', async () => {
    const harness = startHarness();
    try {
      const client = connect(harness);
      await client.opened;
      expect(await harness.terminal.revokeSubject('user-1')).toBe(1);
      const awaited33 = await client.closed;
      expect(awaited33.code).toBe(1008);
    } finally {
      await harness.stop();
    }
  });

  test('closing the server revokes every attachment and waits for their cleanup', async () => {
    const harness = startHarness();
    try {
      const client = connect(harness);
      await client.handshake();
      await harness.terminal.close();
      expect(harness.session().snapshot.closed).toBe(true);
      expect(harness.process.cleanups).toBe(1);
      const awaited34 = await client.closed;
      expect(awaited34.code).toBe(1000);
    } finally {
      await harness.stop();
    }
  });
});
