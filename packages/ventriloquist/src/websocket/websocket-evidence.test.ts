import { SCENARIO_HANG_GUARD_MILLISECONDS, outcomeOf, rethrow } from '@lostgradient/testing';
import addFormats from 'ajv-formats';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  validateEvidence,
  type EvidenceCell,
  type EvidenceReport,
} from '../../../../scripts/terminal/evidence-schema.ts';
import { createDeferred } from '../session/fixtures/deferred.ts';
import type { Authorization } from './websocket-types.ts';
import {
  LAUNCH,
  ORIGIN,
  SESSION_COOKIE,
  SESSION_IDENTIFIER,
  connect,
  forgeInput,
  forgeText,
  scriptedProcess,
  startHarness,
  type Harness,
  type HarnessOptions,
  type TestClient,
} from './websocket.test-support.ts';

const packageRoot = join(import.meta.dir, '../..');
const repositoryRoot = join(packageRoot, '../..');
const reportPath = join(packageRoot, 'test-results/websocket.json');
const schemaPath = join(repositoryRoot, 'scripts/terminal/evidence.schema.json');

/**
 * Every cell of the WebSocket fault-injection matrix. Each is driven over a real loopback socket
 * against the real server; a cell passes only when every check of every variant it names held.
 * The matrix owner key is `websocket`.
 */
const EXPECTED_CELL_IDS = [
  'websocket-close-during-handshake',
  'websocket-close-during-input',
  'websocket-close-during-resize',
  'websocket-close-during-output',
  'websocket-close-during-exit',
  'websocket-slow-consumer',
  'websocket-malformed-frames',
  'websocket-origin-rejection',
  'websocket-missing-credentials',
  'websocket-expired-authority',
  'websocket-stale-generation',
  'websocket-operation-window',
  'websocket-liveness',
  'websocket-transport-security',
] as const;

type CellId = (typeof EXPECTED_CELL_IDS)[number];
type Check = { readonly label: string; readonly ok: boolean };
type Observation = { readonly checks: readonly Check[]; readonly cleanups: number };
type Variant = { readonly label: string; run(): Promise<Observation> };

const check = (label: string, ok: boolean): Check => ({ label, ok });

/** Run a variant against a fresh server, always stopping it, and count the process cleanups it saw. */
async function observe(
  options: HarnessOptions,
  body: (harness: Harness) => Promise<readonly Check[]>,
): Promise<Observation> {
  const harness = startHarness(options);
  try {
    const checks = await body(harness);
    return { checks, cleanups: harness.process.cleanups };
  } finally {
    harness.process.releaseWrites();
    await harness.stop();
  }
}

const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** Drop the transport without a close frame, as a killed browser or a cut cable does. */
function sever(client: TestClient): void {
  (client.socket as unknown as { terminate(): void }).terminate();
}

const handshakeClose: Variant[] = [
  {
    label: 'dropped before the hello',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.socket.close(1000);
        await harness.closesHandled(1);
        return [
          check('no connection remains', harness.terminal.connectionCount === 0),
          check('no session was reserved', harness.slot.current === undefined),
          check('the host was never asked', harness.authorizations.length === 0),
          check('no timer is left running', harness.clock.pendingTimers === 0),
        ];
      }),
  },
  {
    label: 'dropped while the host decides',
    run: async () => {
      const decision = createDeferred<Authorization>();
      const asked = createDeferred<void>();
      let created = 0;
      return observe(
        {
          authorization: () => {
            asked.resolve();
            return decision.promise;
          },
          createProcess: () => {
            created += 1;
            return scriptedProcess().hosted;
          },
        },
        async (harness) => {
          const client = connect(harness);
          await client.opened;
          client.hello();
          await asked.promise;
          sever(client);
          await harness.closesHandled(1);
          decision.resolve({ allowed: true, grant: 'interactive', launch: LAUNCH });
          await Promise.resolve().then(() => Bun.sleep(0));
          return [
            check('no process was made', created === 0),
            check('no session was reserved', harness.slot.current === undefined),
            check('no connection remains', harness.terminal.connectionCount === 0),
          ];
        },
      );
    },
  },
  {
    label: 'silent past the handshake deadline',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.opened;
        harness.clock.advance(10_000);
        const closed = await client.closed;
        return [
          check('closed with 1008', closed.code === 1008),
          check('no connection remains', harness.terminal.connectionCount === 0),
          check('no timer is left running', harness.clock.pendingTimers === 0),
        ];
      }),
  },
];

/** A drop while one kind of operation is in flight: cleanup runs once, and nothing is retried. */
function closeDuringOperation(kind: 'input' | 'resize', how: 'sever' | 'close'): Variant {
  return {
    label: `${kind} in flight, transport ${how === 'sever' ? 'severed' : 'closed'}`,
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const session = harness.session();
        harness.process.stallWrites();
        if (kind === 'input') {
          client.sendResult(client.endpoint.input('typed'));
          await harness.process.writes(1);
        } else {
          client.sendResult(client.endpoint.resize(100, 40));
          await harness.process.resizes(1);
        }
        if (how === 'sever') sever(client);
        else client.socket.close(1000);
        const summary = await session.closed;
        await harness.closesHandled(1);
        return [
          check('the session closed by disconnect', summary.cause === 'disconnect'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
          check(
            'the operation reached the backend once and was not retried',
            (kind === 'input' ? harness.process.written.length : harness.process.resized.length) ===
              1,
          ),
          check('no connection remains', harness.terminal.connectionCount === 0),
        ];
      }),
  };
}

const closeDuringOutput: Variant[] = [
  {
    label: 'output sent and never acknowledged, transport severed',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const session = harness.session();
        harness.process.stream.push(new Uint8Array(8_192).fill(0x41));
        await client.waitForKind('output');
        sever(client);
        const summary = await session.closed;
        return [
          check('the session closed by disconnect', summary.cause === 'disconnect'),
          check('the unparsed bytes are reported unavailable', summary.drain.state === 'truncated'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
          check('nothing was sent after the close', harness.terminal.connectionCount === 0),
        ];
      }),
  },
  {
    label: 'output arriving as the transport closes',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const session = harness.session();
        client.socket.close(1000);
        harness.process.stream.push(new Uint8Array(1_024).fill(0x42));
        const summary = await session.closed;
        return [
          check('the session closed once', summary.cause === 'disconnect'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
        ];
      }),
  },
];

const closeDuringExit: Variant[] = [
  {
    label: 'exit reported, transport severed before the cleanup result',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const session = harness.session();
        harness.process.stream.push(new TextEncoder().encode('last words'));
        await client.waitForKind('output');
        harness.process.stream.end();
        harness.process.exit(5);
        await client.waitForKind('process-exit');
        sever(client);
        const summary = await session.closed;
        return [
          check('the exit began the close', summary.cause === 'process-exit'),
          check('cleanup completed', summary.cleanup === 'complete'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
          check('the exit is not a successful result', summary.process.kind === 'exited'),
        ];
      }),
  },
  {
    label: 'transport severed before the exit is known',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const session = harness.session();
        sever(client);
        harness.process.stream.end();
        harness.process.exit(0);
        const summary = await session.closed;
        return [
          check('exactly one close', summary.sessionIdentity === SESSION_IDENTIFIER),
          check('the process was cleaned up once', harness.process.cleanups === 1),
        ];
      }),
  },
];

const slowConsumer: Variant[] = [
  {
    label: 'reads everything and acknowledges nothing',
    run: () =>
      observe({ server: { budgets: { outputQueueBytes: 64 * 1024 } } }, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        harness.process.stream.push(new Uint8Array(40 * 1024).fill(0x41));
        await client.waitForKind('output');
        harness.process.stream.push(new Uint8Array(40 * 1024).fill(0x42));
        const summary = await harness.session().closed;
        return [
          check('the session failed visibly on overflow', summary.cause === 'output-overflow'),
          check('the slot is quarantined', summary.quarantined),
          check('the client acknowledged nothing', client.endpoint.outputBytes.consumed === 0),
          check('the process was cleaned up once', harness.process.cleanups === 1),
        ];
      }),
  },
  {
    label: 'acknowledges each chunk, so the stream outlasts the budget',
    run: () =>
      observe({ server: { budgets: { outputQueueBytes: 64 * 1024 } } }, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const chunk = new Uint8Array(40 * 1024).fill(0x43);
        for (let round = 1; round <= 4; round += 1) {
          harness.process.stream.push(chunk);
          while (client.endpoint.outputBytes.received < round * chunk.length) {
            await client.waitForFrames(client.frames.length + 1);
          }
          client.sendResult(client.endpoint.consumeOutput(chunk.length));
          client.sendResult(client.endpoint.input('.'));
          await client.waitFor(
            (message) =>
              message.kind === 'operation-ack' && message.operationSequence === round * 2,
          );
        }
        return [
          check('still attached after four times the budget', !harness.session().snapshot.closed),
          check(
            'the host holds exactly what the client reported',
            client.endpoint.outputBytes.consumed === 4 * chunk.length,
          ),
        ];
      }),
  },
  {
    label: 'multi-byte output is counted in bytes, not characters',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const bytes = new TextEncoder().encode('世界 😀');
        harness.process.stream.push(bytes);
        await client.waitForKind('output');
        client.sendResult(client.endpoint.consumeOutput('世界 😀'.length));
        client.sendResult(client.endpoint.terminate());
        const summary = await harness.session().closed;
        return [
          check('a character count leaves the bytes unparsed', summary.drain.state === 'truncated'),
          check('the shortfall is the byte count', summary.drain.unavailableBytes === bytes.length),
        ];
      }),
  },
];

function malformed(label: string, build: (generation: number) => string | Uint8Array): Variant {
  return {
    label,
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        const { attachmentGeneration } = await client.handshake();
        client.send(build(attachmentGeneration));
        const closed = await client.closed;
        const summary = await harness.session().closed;
        return [
          check('closed with 1002', closed.code === 1002),
          check('the generation was revoked', summary.cause === 'protocol-failure'),
          check('nothing reached the process', harness.process.written.length === 0),
          check('the process was cleaned up once', harness.process.cleanups === 1),
        ];
      }),
  };
}

const envelope = (generation: number) => ({
  sessionId: SESSION_IDENTIFIER,
  attachmentGeneration: generation,
  sequence: 1,
});

const malformedFrames: Variant[] = [
  malformed('text that is not JSON', () => 'definitely not json'),
  malformed('a binary frame of zeros', () => new Uint8Array(64)),
  malformed('an unknown protocol version', (generation) =>
    forgeText({ kind: 'terminate', ...envelope(generation) }, { version: 2 }),
  ),
  malformed('an unexpected field', (generation) =>
    forgeText({ kind: 'terminate', ...envelope(generation) }, { argumentList: ['x'] }),
  ),
  malformed('input in a text frame', (generation) =>
    forgeText(
      { kind: 'resize', ...envelope(generation), columns: 80, rows: 24 },
      { kind: 'input', payload: 'ls', columns: undefined, rows: undefined },
    ),
  ),
  malformed('a server message sent by the client', (generation) =>
    forgeText({ kind: 'operation-ack', ...envelope(generation), operationSequence: 1 }),
  ),
  malformed('an out-of-order sequence', (generation) => forgeInput(generation, 9)),
  {
    label: 'a frame over the socket ceiling',
    run: () =>
      observe({ server: { limits: { maxFrameBytes: 1_000 } } }, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        client.send(new Uint8Array(1_041));
        const closed = await client.closed;
        const summary = await harness.session().closed;
        return [
          check('the transport failed abnormally', closed.code === 1006 || closed.code === 1009),
          check('the session closed by disconnect', summary.cause === 'disconnect'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
        ];
      }),
  },
  {
    label: 'a first frame that is not a hello',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.send('{"kind":"hello"}');
        const closed = await client.closed;
        return [
          check('closed with 1002', closed.code === 1002),
          check('the host was never asked', harness.authorizations.length === 0),
          check('no session was reserved', harness.slot.current === undefined),
        ];
      }),
  },
];

/** The status the server gives a request that is not a real WebSocket handshake but passes every gate it is held to. */
async function upgradeStatus(
  harness: Harness,
  headers: Record<string, string>,
  query = '',
): Promise<number> {
  const response = await fetch(harness.url.replace('ws:', 'http:') + query, {
    headers: { upgrade: 'websocket', connection: 'Upgrade', ...headers },
  });
  await response.text();
  return response.status;
}

const originRejection: Variant[] = [
  ['no Origin header', undefined],
  ['a null Origin', 'null'],
  ['an unlisted Origin', 'https://evil.example'],
  ['a look-alike Origin', 'https://terminal.example.evil.example'],
].map(([label, origin]): Variant => ({
  label: label as string,
  run: () =>
    observe({}, async (harness) => {
      const headers: Record<string, string> = { cookie: SESSION_COOKIE };
      if (origin !== undefined) headers['origin'] = origin;
      const status = await upgradeStatus(harness, headers);
      const client = connect(harness, origin === undefined ? { origin: null } : { origin });
      const refused = await client.opened.then(
        () => false,
        () => true,
      );
      return [
        check('answered 403', status === 403),
        check('the socket never opened', refused),
        check('the host was never asked', harness.authorizations.length === 0),
        check('no connection remains', harness.terminal.connectionCount === 0),
      ];
    }),
}));

const missingCredentials: Variant[] = [
  {
    label: 'no cookie',
    run: () =>
      observe({}, async (harness) => {
        const status = await upgradeStatus(harness, { origin: ORIGIN });
        const client = connect(harness, { cookie: null });
        const refused = await client.opened.then(
          () => false,
          () => true,
        );
        return [
          check('answered 401', status === 401),
          check('the socket never opened', refused),
          check('the host was never asked', harness.authorizations.length === 0),
        ];
      }),
  },
  {
    label: 'a cookie the host does not accept',
    run: () =>
      observe({}, async (harness) => {
        const status = await upgradeStatus(harness, { origin: ORIGIN, cookie: 'sid=forged' });
        const client = connect(harness, { cookie: 'sid=forged' });
        const refused = await client.opened.then(
          () => false,
          () => true,
        );
        return [check('answered 401', status === 401), check('the socket never opened', refused)];
      }),
  },
  {
    label: 'a credential in the URL instead of the cookie',
    run: () =>
      observe({}, async (harness) => {
        const status = await upgradeStatus(
          harness,
          { origin: ORIGIN, cookie: SESSION_COOKIE },
          '&token=hunter2',
        );
        return [
          check('answered 400 without reading it', status === 400),
          check('the host was never asked', harness.authorizations.length === 0),
        ];
      }),
  },
  {
    label: 'a host that cannot decide',
    run: () =>
      observe(
        {
          authentication: () => {
            throw new Error('identity provider unreachable');
          },
        },
        async (harness) => {
          const status = await upgradeStatus(harness, { origin: ORIGIN, cookie: SESSION_COOKIE });
          return [check('answered 503 and admitted nothing', status === 503)];
        },
      ),
  },
];

const expiredAuthority: Variant[] = [
  {
    label: 'the principal expires mid-session',
    run: () =>
      observe(
        { authentication: () => ({ ok: true, subject: 'user-1', expiresInMilliseconds: 5_000 }) },
        async (harness) => {
          const client = connect(harness);
          await client.handshake();
          harness.process.stallWrites();
          client.sendResult(client.endpoint.input('first'));
          client.sendResult(client.endpoint.input('second'));
          await client.waitFor(
            (message) => message.kind === 'operation-ack' && message.operationSequence === 2,
          );
          await harness.process.writes(1);
          harness.clock.advance(5_000);
          const failure = await client.waitForKind('operation-failure');
          harness.process.releaseWrites();
          const summary = await harness.session().closed;
          const closed = await client.closed;
          return [
            check('authority was revoked', summary.cause === 'authorization-revoked'),
            check('the queued operation was canceled explicitly', failure.operationSequence === 2),
            check(
              'only the submitted write ran',
              harness.process.written.length === 1 &&
                decode(harness.process.written[0]) === 'first',
            ),
            check(
              'the client was told cleanup finished',
              client.kinds().includes('cleanup-result'),
            ),
            check(
              'the in-flight write is unknown delivery, so the close is 1011',
              closed.code === 1011,
            ),
          ];
        },
      ),
  },
  {
    label: 'the principal expires before the hello',
    run: () =>
      observe(
        { authentication: () => ({ ok: true, subject: 'user-1', expiresInMilliseconds: 1_000 }) },
        async (harness) => {
          const client = connect(harness);
          await client.opened;
          harness.clock.advance(1_000);
          const closed = await client.closed;
          return [
            check('closed with 1008', closed.code === 1008),
            check('no session was reserved', harness.slot.current === undefined),
          ];
        },
      ),
  },
  {
    label: 'the host revokes the subject',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        const revoked = await harness.terminal.revokeSubject('user-1');
        const summary = await harness.session().closed;
        return [
          check('one attachment was revoked', revoked === 1),
          check('cleanup ran', summary.cause === 'authorization-revoked'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
        ];
      }),
  },
  {
    label: 'the host denies authorization at the hello',
    run: () =>
      observe({ authorization: { allowed: false, denial: 'expired' } }, async (harness) => {
        const client = connect(harness);
        await client.opened;
        client.hello();
        const closed = await client.closed;
        return [
          check('closed with 1008', closed.code === 1008),
          check('no capabilities were issued', client.frames.length === 0),
        ];
      }),
  },
];

const staleGeneration: Variant[] = [
  {
    label: 'input addressed to a generation that is not the current one',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        const { attachmentGeneration } = await client.handshake();
        client.send(forgeInput(attachmentGeneration + 1, 1));
        await client.waitForFrames(2);
        const answer = JSON.parse(client.frames[1]?.raw as string) as { code: string };
        client.sendResult(client.endpoint.input('current'));
        await harness.process.writes(1);
        return [
          check('refused as stale-generation', answer.code === 'stale-generation'),
          check('the attachment stayed live', client.socket.readyState === WebSocket.OPEN),
          check(
            'only the current generation ran',
            decode(harness.process.written[0]) === 'current' &&
              harness.process.written.length === 1,
          ),
        ];
      }),
  },
  {
    label: 'input addressed to another session',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        const { attachmentGeneration } = await client.handshake();
        client.send(
          forgeInput(attachmentGeneration, 1, 'x', '6d9d9a52-3a1e-4f67-8f7b-0c0f2f0c5e11'),
        );
        await client.waitForFrames(2);
        const answer = JSON.parse(client.frames[1]?.raw as string) as { code: string };
        return [
          check('refused as stale-generation', answer.code === 'stale-generation'),
          check('nothing reached the process', harness.process.written.length === 0),
        ];
      }),
  },
  {
    label: 'a replay of a retired session identity',
    run: () =>
      observe({}, async (harness) => {
        const first = connect(harness);
        await first.handshake();
        first.sendResult(first.endpoint.terminate());
        await first.closed;
        await harness.session().closed;
        const again = connect(harness);
        await again.opened;
        again.hello();
        const closed = await again.closed;
        return [
          check('refused with 1008', closed.code === 1008),
          check('no capabilities were issued', again.frames.length === 0),
        ];
      }),
  },
];

const operationWindow: Variant[] = [
  {
    label: 'the host FIFO is full',
    run: () =>
      observe({ server: { budgets: { operationQueueLimit: 2 } } }, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        harness.process.stallWrites();
        for (const text of ['a', 'b', 'c']) {
          const from = client.messages.length;
          client.sendResult(client.endpoint.input(text));
          await client.waitFor((message) => message.kind === 'operation-ack', from);
        }
        client.sendResult(client.endpoint.input('d'));
        const refused = await client.waitForKind('operation-failure');
        harness.process.releaseWrites();
        await harness.process.writes(3);
        const from = client.messages.length;
        client.sendResult(client.endpoint.input('e'));
        await client.waitFor((message) => message.kind === 'operation-ack', from);
        await harness.process.writes(4);
        return [
          check('refused as fifo-full', refused.code === 'fifo-full'),
          check('the attachment stayed live', client.socket.readyState === WebSocket.OPEN),
          check(
            'the refused input never ran and the later one did',
            harness.process.written.map(decode).join(',') === 'a,b,c,e',
          ),
        ];
      }),
  },
  {
    label: 'the client window is full',
    run: () =>
      observe(
        { server: { limits: { maxQueuedOperations: 4 }, budgets: { operationQueueLimit: 4 } } },
        async (harness) => {
          const client = connect(harness);
          await client.handshake();
          for (let count = 1; count <= 4; count += 1) client.sendResult(client.endpoint.input('k'));
          const refused = client.endpoint.input('k');
          await client.waitFor(
            (message) => message.kind === 'operation-ack' && message.operationSequence === 1,
          );
          const sent = client.endpoint.input('after');
          if (sent.ok) client.sendResult(sent);
          await harness.process.writes(5);
          return [
            check(
              'refused locally as fifo-full',
              !refused.ok && refused.failure.code === 'fifo-full',
            ),
            check('an acknowledgement freed the window', sent.ok),
            check('only sent operations ran', harness.process.written.length === 5),
          ];
        },
      ),
  },
];

const liveness: Variant[] = [
  {
    label: 'no frame and no pong until the deadline',
    run: () =>
      observe({ server: { limits: { pingIntervalMilliseconds: 120_000 } } }, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        harness.clock.advance(29_999);
        const stillOpen = client.socket.readyState === WebSocket.OPEN;
        harness.clock.advance(1);
        const summary = await harness.session().closed;
        await client.waitForKind('cleanup-result');
        return [
          check('alive one millisecond before the deadline', stillOpen),
          check('expired at the deadline', summary.cause === 'liveness-expired'),
          check('the process was cleaned up once', harness.process.cleanups === 1),
          check('the client was told', client.kinds().includes('cleanup-result')),
        ];
      }),
  },
  {
    label: 'pongs alone keep an idle attachment alive',
    run: () =>
      observe({}, async (harness) => {
        const client = connect(harness);
        await client.handshake();
        for (let round = 1; round <= 4; round += 1) {
          harness.clock.advance(10_000);
          await harness.pongsReceived(round);
        }
        return [
          check('still attached after 40 seconds', !harness.session().snapshot.closed),
          check('no application frame was needed', client.messages.length === 1),
        ];
      }),
  },
];

const transportSecurity: Variant[] = [
  {
    label: 'plain http without the development switch',
    run: () =>
      observe({ allowInsecureLoopback: false }, async (harness) => {
        const status = await upgradeStatus(harness, { origin: ORIGIN, cookie: SESSION_COOKIE });
        return [check('refused with 403', status === 403)];
      }),
  },
  {
    label: 'the development switch on a listener beyond loopback',
    run: () =>
      observe({ hostname: '0.0.0.0' }, async (harness) => {
        const status = await upgradeStatus(harness, { origin: ORIGIN, cookie: SESSION_COOKIE });
        return [check('refused with 403', status === 403)];
      }),
  },
  {
    label: 'the development switch on a loopback listener still needs origin and credentials',
    run: () =>
      observe({}, async (harness) => {
        const noOrigin = await upgradeStatus(harness, { cookie: SESSION_COOKIE });
        const noCookie = await upgradeStatus(harness, { origin: ORIGIN });
        const client = connect(harness);
        await client.handshake();
        return [
          check('a missing Origin is refused', noOrigin === 403),
          check('a missing cookie is refused', noCookie === 401),
          check('the same request with both is admitted', client.endpoint.phase === 'attached'),
        ];
      }),
  },
];

const MATRIX: Record<CellId, readonly Variant[]> = {
  'websocket-close-during-handshake': handshakeClose,
  'websocket-close-during-input': [
    closeDuringOperation('input', 'sever'),
    closeDuringOperation('input', 'close'),
  ],
  'websocket-close-during-resize': [
    closeDuringOperation('resize', 'sever'),
    closeDuringOperation('resize', 'close'),
  ],
  'websocket-close-during-output': closeDuringOutput,
  'websocket-close-during-exit': closeDuringExit,
  'websocket-slow-consumer': slowConsumer,
  'websocket-malformed-frames': malformedFrames,
  'websocket-origin-rejection': originRejection,
  'websocket-missing-credentials': missingCredentials,
  'websocket-expired-authority': expiredAuthority,
  'websocket-stale-generation': staleGeneration,
  'websocket-operation-window': operationWindow,
  'websocket-liveness': liveness,
  'websocket-transport-security': transportSecurity,
};

async function buildCell(id: CellId): Promise<EvidenceCell> {
  const observed: { line: string; passed: boolean; checks: number; cleanups: number }[] = [];
  for (const variant of MATRIX[id]) {
    const observation = await variant.run();
    observed.push({
      passed: observation.checks.every((entry) => entry.ok),
      checks: observation.checks.length,
      cleanups: observation.cleanups,
      line: `${variant.label}: ${observation.checks
        .map((entry) => `${entry.ok ? 'held' : 'FAILED'} ${entry.label}`)
        .join('; ')}`,
    });
  }
  return {
    id,
    passed: observed.every((entry) => entry.passed),
    observations: observed.map((entry) => entry.line),
    versions: { bun: Bun.version },
    metrics: {
      variantsObserved: { value: observed.length, unit: 'variants' },
      checksEvaluated: {
        value: observed.reduce((sum, entry) => sum + entry.checks, 0),
        unit: 'checks',
      },
      backendCleanupCalls: {
        value: observed.reduce((sum, entry) => sum + entry.cleanups, 0),
        unit: 'calls',
      },
    },
  };
}

// Reading the commit starts a real `git` process, so it happens once at module scope, off the
// per-test clock, and the report builders below stay in process.
const sourceSha = ((): string => {
  const result = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    timeout: SCENARIO_HANG_GUARD_MILLISECONDS,
  });
  return result.stdout.toString().trim();
})();

// The matrix drives real sockets one variant after another. It runs once at module scope, off
// Bun's per-test clock, because a variant is a handful of loopback round trips and a host under
// load must not time a test out; the tests below assert on what it recorded.
const cells: EvidenceCell[] = [];
const matrixOutcome = await outcomeOf(async () => {
  for (const id of EXPECTED_CELL_IDS) cells.push(await buildCell(id));
});

function buildReport(): EvidenceReport {
  return {
    schemaVersion: 1,
    reportKind: 'runtime',
    sourceSha,
    runId: crypto.randomUUID(),
    observedAt: new Date().toISOString(),
    expectedCellIds: [...EXPECTED_CELL_IDS],
    cells,
    passed: cells.every((cell) => cell.passed),
  };
}

function structuralErrors(report: unknown): string[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')) as object);
  return validate(report)
    ? []
    : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
}

describe('websocket evidence report', () => {
  test('writes test-results/websocket.json covering every fault-injection cell', () => {
    rethrow(matrixOutcome);
    const report = buildReport();
    mkdirSync(join(packageRoot, 'test-results'), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    const written = JSON.parse(readFileSync(reportPath, 'utf8')) as EvidenceReport;
    expect(structuralErrors(written)).toEqual([]);
    expect(validateEvidence(written, 'runtime')).toEqual([]);
    expect(written.expectedCellIds).toEqual([...EXPECTED_CELL_IDS]);
    expect(written.cells.map((cell) => cell.id)).toEqual([...EXPECTED_CELL_IDS]);
    for (const cell of written.cells) {
      expect(cell.observations.length, cell.id).toBeGreaterThan(0);
      expect(cell.passed, `${cell.id}: ${cell.observations.join(' | ')}`).toBe(true);
    }
    expect(written.passed).toBe(true);
  });

  test('names every case the issue lists', () => {
    const covered = EXPECTED_CELL_IDS.join(' ');
    for (const required of [
      'close-during-handshake',
      'close-during-input',
      'close-during-resize',
      'close-during-output',
      'close-during-exit',
      'slow-consumer',
      'malformed-frames',
      'origin-rejection',
      'missing-credentials',
      'expired-authority',
      'stale-generation',
    ]) {
      expect(covered).toContain(required);
    }
  });

  test('reports only measured metrics, never a constant the test itself sets', () => {
    rethrow(matrixOutcome);
    for (const cell of buildReport().cells) {
      expect(Object.keys(cell.metrics), cell.id).toEqual([
        'variantsObserved',
        'checksEvaluated',
        'backendCleanupCalls',
      ]);
      expect(cell.metrics['checksEvaluated']?.value, cell.id).toBeGreaterThan(0);
    }
  });

  test('fails when a required cell is missing, duplicated or unexpected', () => {
    rethrow(matrixOutcome);
    const report = buildReport();
    for (const id of EXPECTED_CELL_IDS) {
      const without = { ...report, cells: report.cells.filter((cell) => cell.id !== id) };
      expect(validateEvidence(without, 'runtime'), id).toContain('missing cell');
    }
    const first = report.cells[0] as EvidenceCell;
    expect(validateEvidence({ ...report, cells: [...report.cells, first] }, 'runtime')).toContain(
      'duplicate cell',
    );
    expect(
      validateEvidence(
        { ...report, cells: [...report.cells, { ...first, id: 'extra' }] },
        'runtime',
      ),
    ).toContain('unexpected cell');
  });

  test('records a cell as failed when a check did not hold', async () => {
    const failing: Variant = {
      label: 'a check that does not hold',
      run: () => observe({}, async () => [check('impossible', false)]),
    };
    const observation = await failing.run();
    expect(observation.checks.every((entry) => entry.ok)).toBe(false);
  });
});
