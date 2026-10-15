import { describe, expect, test } from 'bun:test';

import { encodeFrame } from '../protocol/frame-codec.ts';
import type { HelloMessage } from '../protocol/messages.ts';
import { createDeferred } from '../session/fixtures/deferred.ts';
import type { Authorization } from './websocket-types.ts';
import {
  LAUNCH,
  ORIGIN,
  SECOND_SESSION_IDENTIFIER,
  SESSION_COOKIE,
  SESSION_IDENTIFIER,
  TICKET,
  connect,
  forgeText,
  scriptedProcess,
  startHarness,
  type Harness,
} from './websocket.test-support.ts';

async function withHarness(
  options: Parameters<typeof startHarness>[0],
  body: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = startHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.stop();
  }
}

const HELLO: HelloMessage = {
  kind: 'hello',
  version: 1,
  sessionId: SESSION_IDENTIFIER,
  requestedMode: 'interactive',
  token: TICKET,
};

describe('a successful handshake', () => {
  test('control: a hello forged without any change is accepted, so every refusal below is due to its change', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.opened;
      client.expectCapabilities();
      client.send(forgeText(HELLO));
      const awaited2 = await client.waitForKind('capabilities');
      expect(awaited2.sessionId).toBe(SESSION_IDENTIFIER);
    });
  });

  test('issues a generation, the advertised limits and server-derived capabilities', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      const capabilities = await client.handshake();
      expect(await client.refused()).toBe(false);
      expect(capabilities.sessionId).toBe(SESSION_IDENTIFIER);
      expect(capabilities.attachmentGeneration).toBeGreaterThanOrEqual(1);
      expect(capabilities.maxFrameBytes).toBe(65_536);
      expect(capabilities.maxQueuedOperations).toBe(256);
      expect(capabilities.capabilities).toEqual({
        mode: 'pty',
        input: true,
        resize: true,
        kill: true,
        readOnly: false,
      });
    });
  });

  test('asks the host to authorize the profile, the session and the operation, with the ticket and no credential', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.handshake();
      expect(harness.authorizations).toEqual([
        {
          subject: 'user-1',
          profileId: 'shell',
          sessionId: SESSION_IDENTIFIER,
          requestedMode: 'interactive',
          operation: 'attach',
          ticket: TICKET,
        },
      ]);
      expect(JSON.stringify(harness.authorizations)).not.toContain(SESSION_COOKIE);
    });
  });

  test('makes the process only after the host authorized the launch', async () => {
    const decision = createDeferred<Authorization>();
    const process = scriptedProcess();
    let created = 0;
    await withHarness(
      {
        process,
        authorization: () => decision.promise,
        createProcess: () => {
          created += 1;
          return process.hosted;
        },
      },
      async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.hello();
        await Bun.sleep(0);
        expect(created).toBe(0);
        expect(harness.slot.current).toBeUndefined();
        decision.resolve({ allowed: true, grant: 'interactive', launch: LAUNCH });
        await client.waitForKind('capabilities');
        expect(created).toBe(1);
      },
    );
  });

  test('a read-only grant narrows an interactive request, and the client cannot widen it', async () => {
    await withHarness(
      { authorization: { allowed: true, grant: 'read-only', launch: LAUNCH } },
      async (harness) => {
        const client = connect(harness);
        const { capabilities, attachmentGeneration } = await client.handshake();
        expect(capabilities).toEqual({
          mode: 'pty',
          input: false,
          resize: false,
          kill: false,
          readOnly: true,
        });
        // The endpoint refuses locally, but the host must refuse too: send the frame by hand.
        const forged = encodeFrame({
          kind: 'input',
          sessionId: SESSION_IDENTIFIER,
          attachmentGeneration,
          sequence: 1,
          payload: new TextEncoder().encode('rm -rf /\r'),
        });
        if (!forged.ok) throw new Error('could not build the frame');
        client.send(forged.value);
        // The client never submitted this operation, so its own endpoint rejects the host's answer;
        // the raw frame is what proves the host refused it.
        await client.waitForFrames(2);
        const answer = JSON.parse(client.frames[1]?.raw as string) as {
          kind: string;
          code: string;
        };
        expect(answer).toMatchObject({ kind: 'operation-failure', code: 'read-only' });
        expect(harness.process.written).toEqual([]);
      },
    );
  });

  test('copies and freezes the launch the host decided, so the host mutating it later changes nothing', async () => {
    const launch = {
      mode: 'pty' as const,
      profile: {
        executable: '/bin/sh',
        argumentList: ['-l'],
        workingDirectory: '/',
        environment: { PATH: '/bin' },
      },
      dimensions: { columns: 100, rows: 30 },
    };
    const seen: unknown[] = [];
    const process = scriptedProcess();
    await withHarness(
      {
        authorization: { allowed: true, grant: 'interactive', launch },
        createProcess: (snapshot) => {
          seen.push(snapshot);
          return process.hosted;
        },
      },
      async (harness) => {
        const client = connect(harness);
        await client.handshake();
        launch.profile.argumentList.push('--evil');
        launch.profile.environment.PATH = '/tmp/evil';
        launch.dimensions.columns = 1;
        const snapshot = seen[0] as typeof launch;
        expect(snapshot).not.toBe(launch);
        expect(snapshot.profile.argumentList).toEqual(['-l']);
        expect(snapshot.profile.environment).toEqual({ PATH: '/bin' });
        expect(snapshot.dimensions).toEqual({ columns: 100, rows: 30 });
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.profile)).toBe(true);
        expect(Object.isFrozen(snapshot.profile.argumentList)).toBe(true);
        expect(Object.isFrozen(snapshot.profile.environment)).toBe(true);
        expect(Object.isFrozen(snapshot.dimensions)).toBe(true);
        expect(harness.session().dimensions).toEqual({ columns: 100, rows: 30 });
      },
    );
  });

  test('carries a pipe launch with its input setting through to the process factory', async () => {
    const process = scriptedProcess({ mode: 'pipe' });
    const seen: unknown[] = [];
    await withHarness(
      {
        process,
        authorization: {
          allowed: true,
          grant: 'interactive',
          launch: { ...LAUNCH, mode: 'pipe', acceptsInput: true },
        },
        createProcess: (snapshot) => {
          seen.push(snapshot);
          return process.hosted;
        },
      },
      async (harness) => {
        const client = connect(harness);
        const { capabilities } = await client.handshake();
        expect(capabilities.mode).toBe('pipe');
        expect(capabilities.resize).toBe(false);
        expect((seen[0] as { acceptsInput: boolean }).acceptsInput).toBe(true);
      },
    );
  });
});

describe('a refused handshake', () => {
  test.each([
    ['forbidden', 1008],
    ['unauthenticated', 1008],
    ['expired', 1008],
    ['unavailable', 1013],
  ] as const)(
    'a %s authorization closes with %d and never makes a process',
    async (denial, code) => {
      let created = 0;
      await withHarness(
        {
          authorization: { allowed: false, denial },
          createProcess: () => {
            created += 1;
            return scriptedProcess().hosted;
          },
        },
        async (harness) => {
          const client = connect(harness);
          await client.opened;
          client.hello();
          const awaited3 = await client.closed;
          expect(awaited3.code).toBe(code);
          expect(client.frames).toEqual([]);
          expect(created).toBe(0);
          expect(harness.slot.current).toBeUndefined();
          await Bun.sleep(0);
          expect(harness.terminal.connectionCount).toBe(0);
        },
      );
    },
  );

  test('an authorization callback that throws is an undecided host and leaks nothing', async () => {
    await withHarness(
      {
        authorization: () => {
          throw new Error('secret failure detail');
        },
      },
      async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.hello();
        const awaited4 = await client.closed;
        expect(awaited4.code).toBe(1013);
        expect(client.frames).toEqual([]);
      },
    );
  });

  test.each([
    [
      'a relative working directory',
      { ...LAUNCH, profile: { ...LAUNCH.profile, workingDirectory: 'relative' } },
    ],
    ['zero columns', { ...LAUNCH, dimensions: { columns: 0, rows: 24 } }],
    [
      'a NUL in the environment',
      { ...LAUNCH, profile: { ...LAUNCH.profile, environment: { A: 'a\u0000b' } } },
    ],
  ])('a launch with %s is refused with 1011 before any process is made', async (_name, launch) => {
    let created = 0;
    await withHarness(
      {
        authorization: { allowed: true, grant: 'interactive', launch },
        createProcess: () => {
          created += 1;
          return scriptedProcess().hosted;
        },
      },
      async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.hello();
        const awaited5 = await client.closed;
        expect(awaited5.code).toBe(1011);
        expect(created).toBe(0);
      },
    );
  });

  test('a process factory that throws closes with 1011', async () => {
    await withHarness(
      {
        createProcess: () => {
          throw new Error('cannot make a process');
        },
      },
      async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.hello();
        const awaited6 = await client.closed;
        expect(awaited6.code).toBe(1011);
        expect(harness.slot.current).toBeUndefined();
      },
    );
  });

  test('a first frame that is not a valid hello closes with 1002 and asks the host nothing', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.opened;
      client.send('this is not json');
      const awaited7 = await client.closed;
      expect(awaited7.code).toBe(1002);
      expect(harness.authorizations).toEqual([]);
    });
  });

  test('a hello of another protocol version closes with 1002', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.opened;
      client.send(forgeText(HELLO, { version: 2 }));
      const awaited8 = await client.closed;
      expect(awaited8.code).toBe(1002);
      expect(harness.authorizations).toEqual([]);
    });
  });

  test.each([
    ['a command', { command: 'rm -rf /' }],
    ['an argument list', { argumentList: ['-c', 'evil'] }],
    ['a working directory', { workingDirectory: '/' }],
    ['a tenant', { tenantId: 'someone-else' }],
    ['an environment', { environment: { LD_PRELOAD: '/tmp/evil.so' } }],
  ])(
    'a hello that supplies %s is malformed, so a client cannot choose what runs',
    async (_name, extra) => {
      await withHarness({}, async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.send(forgeText(HELLO, extra));
        const awaited9 = await client.closed;
        expect(awaited9.code).toBe(1002);
        expect(harness.authorizations).toEqual([]);
        expect(harness.slot.current).toBeUndefined();
      });
    },
  );

  test.each([
    ['a session identifier that is not a UUID', { sessionId: 'shell' }],
    ['an empty token', { token: '' }],
    ['an unknown mode', { requestedMode: 'root' }],
  ])('a hello with %s is refused before the host is asked', async (_name, patch) => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.opened;
      client.send(forgeText(HELLO, patch));
      const awaited10 = await client.closed;
      expect(awaited10.code).toBe(1002);
      expect(harness.authorizations).toEqual([]);
    });
  });

  test('a first frame that is not a hello closes with 1002', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.opened;
      client.send(
        forgeText({
          kind: 'terminate',
          sessionId: SESSION_IDENTIFIER,
          attachmentGeneration: 1,
          sequence: 1,
        }),
      );
      const awaited11 = await client.closed;
      expect(awaited11.code).toBe(1002);
      expect(harness.authorizations).toEqual([]);
    });
  });

  test('a socket that never says hello is closed when the handshake deadline passes', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.opened;
      harness.clock.advance(9_999);
      expect(harness.terminal.connectionCount).toBe(1);
      harness.clock.advance(1);
      const awaited12 = await client.closed;
      expect(awaited12.code).toBe(1008);
      expect(harness.clock.pendingTimers).toBe(0);
      expect(harness.terminal.connectionCount).toBe(0);
    });
  });

  test('the deadline no longer applies once the client is attached', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness);
      await client.handshake();
      harness.clock.advance(60_000 - 1);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  test('a client that leaves while the host is deciding gets no session and no process', async () => {
    const decision = createDeferred<Authorization>();
    let created = 0;
    await withHarness(
      {
        authorization: () => decision.promise,
        createProcess: () => {
          created += 1;
          return scriptedProcess().hosted;
        },
      },
      async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.hello();
        await Bun.sleep(0);
        client.socket.close(1000);
        await harness.closesHandled(1);
        decision.resolve({ allowed: true, grant: 'interactive', launch: LAUNCH });
        // The decision settles on a later turn than the close; a marker queued now runs after it.
        await Promise.resolve().then(() => Bun.sleep(0));
        expect(created).toBe(0);
        expect(harness.slot.current).toBeUndefined();
        expect(harness.terminal.connectionCount).toBe(0);
      },
    );
  });

  test('a startup failure is reported as an attachment error, never as an exit, and closes with 1011', async () => {
    await withHarness(
      { process: scriptedProcess({ startFailure: 'spawn-failed' }) },
      async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const error = await client.waitForKind('attachment-error');
        expect(error.code).toBe('spawn-failed');
        const awaited13 = await client.closed;
        expect(awaited13.code).toBe(1011);
        expect(client.kinds()).not.toContain('process-exit');
      },
    );
  });
});

describe('the ownership slot', () => {
  test('refuses a second attachment for the same principal without disturbing the first', async () => {
    await withHarness({}, async (harness) => {
      const first = connect(harness);
      await first.handshake();
      const second = connect(harness, { sessionId: SECOND_SESSION_IDENTIFIER });
      await second.opened;
      second.hello();
      const awaited14 = await second.closed;
      expect(awaited14.code).toBe(1013);
      first.sendResult(first.endpoint.input('a'));
      await harness.process.writes(1);
      const awaited15 = await first.waitForKind('operation-ack');
      expect(awaited15.operationSequence).toBe(1);
    });
  });

  test('refuses to reuse a retired session identity', async () => {
    const processes = [scriptedProcess(), scriptedProcess()];
    let next = 0;
    await withHarness(
      { createProcess: () => (processes[next++] as ReturnType<typeof scriptedProcess>).hosted },
      async (harness) => {
        const first = connect(harness);
        await first.handshake();
        first.sendResult(first.endpoint.terminate());
        await first.waitForKind('cleanup-result');
        await first.closed;
        const again = connect(harness);
        await again.opened;
        again.hello();
        const awaited16 = await again.closed;
        expect(awaited16.code).toBe(1008);
      },
    );
  });

  test('admits a new identity once the previous session closed with a complete cleanup', async () => {
    const processes = [scriptedProcess(), scriptedProcess()];
    let next = 0;
    await withHarness(
      { createProcess: () => (processes[next++] as ReturnType<typeof scriptedProcess>).hosted },
      async (harness) => {
        const first = connect(harness);
        await first.handshake();
        first.sendResult(first.endpoint.terminate());
        const awaited17 = await first.waitForKind('cleanup-result');
        expect(awaited17.outcome).toBe('complete');
        await first.closed;
        await harness.session().closed;
        const second = connect(harness, { sessionId: SECOND_SESSION_IDENTIFIER });
        const awaited18 = await second.handshake();
        expect(awaited18.sessionId).toBe(SECOND_SESSION_IDENTIFIER);
      },
    );
  });

  test('a session that closed with an incomplete cleanup quarantines the slot against a replacement', async () => {
    const processes = [scriptedProcess({ cleanup: 'incomplete' }), scriptedProcess()];
    let next = 0;
    let created = 0;
    await withHarness(
      {
        createProcess: () => {
          created += 1;
          return (processes[next++] as ReturnType<typeof scriptedProcess>).hosted;
        },
      },
      async (harness) => {
        const first = connect(harness);
        await first.handshake();
        first.sendResult(first.endpoint.terminate());
        const awaited19 = await first.waitForKind('cleanup-result');
        expect(awaited19.outcome).toBe('incomplete');
        await first.closed;
        const second = connect(harness, { sessionId: SECOND_SESSION_IDENTIFIER });
        await second.opened;
        second.hello();
        const awaited20 = await second.closed;
        expect(awaited20.code).toBe(1008);
        // The refused attempt made a process only to release it unstarted.
        expect(created).toBe(2);
        expect(processes[1]?.cleanups).toBe(1);
      },
    );
  });
});

describe('the upgrade over a real listener', () => {
  test.each([
    ['a missing Origin', { origin: null }],
    ['a wrong Origin', { origin: 'https://evil.example' }],
    ['no cookie', { cookie: null }],
    ['a cookie the host rejects', { cookie: 'sid=forged' }],
    ['a credential in the URL', { query: '&token=hunter2' }],
  ])('%s never opens a socket', async (_name, options) => {
    await withHarness({}, async (harness) => {
      const client = connect(harness, options);
      expect(await client.refused()).toBe(true);
      await client.closed;
      expect(harness.terminal.connectionCount).toBe(0);
      expect(harness.authorizations).toEqual([]);
    });
  });

  test('plain http is refused when the development switch is off', async () => {
    await withHarness({ allowInsecureLoopback: false }, async (harness) => {
      const client = connect(harness);
      expect(await client.refused()).toBe(true);
    });
  });

  test('the development switch does not apply to a listener bound beyond loopback', async () => {
    // Reached over 127.0.0.1 the peer would be loopback, but the listener is not: no server is built.
    expect(() => startHarness({ hostname: '0.0.0.0' })).toThrow(/loopback/);
  });

  test('the Origin header of an allowed origin is compared canonically', async () => {
    await withHarness({}, async (harness) => {
      const client = connect(harness, { origin: ORIGIN.toUpperCase().replace('HTTPS', 'https') });
      await client.handshake();
    });
  });
});
