import { describe, expect, test } from 'bun:test';

import { decodeFrame, encodeFrame } from '../protocol/frame-codec.ts';
import type { ClientMessage } from '../protocol/messages.ts';
import { createDeferred } from './fixtures/deferred.ts';
import { createFixtureTransport, type FixtureTransport } from './fixtures/fixture-transport.ts';
import {
  createHarness,
  flush,
  SESSION_ID,
  utf8,
  type Harness,
  type HarnessOptions,
} from './session.test-support.ts';

/**
 * The structural guard for how a connection ends. Every way a session can close or fail is one row,
 * run on a fixture transport that behaves like a real WebSocket: once closed it drops what it is
 * sent and the test records it. Each row asserts the exact wire: the frames in order, the cleanup
 * result as the last frame (the one exception is a transport that cannot carry it), then exactly one
 * close with the failure table's code and nothing after it.
 *
 * Quoted from documentation/terminal/contract.md:
 * - "Exit: the host emits PTY EOF or source completion, then the distinct process-exit result when
 *   known, revokes the generation, and emits cleanup-result."
 * - "Cleanup: stop revokes authority first, cancels unsent operations, terminates owned
 *   descendants, closes handles, and reports complete, incomplete, or unknown".
 * - Failure table close codes: malformed-frame 1002, frame-too-large 1009, stale-generation 1008,
 *   read-only 1008, fifo-full 1013, spawn-failed 1011, backend-failed 1011, transport-failed 1011,
 *   cleanup-incomplete 1000, protocol-version-unsupported 1002.
 * - "Startup failure: ... produces `attachment-error` with no process-exit success."
 * - "Output queue ... overflow revokes the generation and quarantines cleanup"
 *   (security-and-budgets.md).
 */
type Scenario = {
  readonly harness: Harness;
  readonly transport: FixtureTransport;
};

type Row = {
  readonly name: string;
  /** The contract text the expected frames and close code come from. */
  readonly cite: string;
  readonly run: () => Promise<Scenario>;
  /** Every frame the host put on the wire, in order. */
  readonly frames: readonly string[];
  /** The one close, or `none` when the connection is still live. */
  readonly close: number | 'none';
  /** The outcome the cleanup result reports, when it is not `complete`. */
  readonly outcome?: 'incomplete' | 'unknown';
  /** A transport that cannot carry the cleanup result is closed without it. */
  readonly cleanupUndeliverable?: true;
};

const STOP_CITE = '"Cleanup: stop revokes authority first, cancels unsent operations ..."';

async function connected(
  options: HarnessOptions = {},
  grant?: 'read-only' | 'interactive',
): Promise<Scenario> {
  const harness = createHarness(options);
  const transport = createFixtureTransport({
    session: harness.session,
    ...(grant === undefined ? {} : { grant }),
  });
  void harness.session.start();
  await flush();
  transport.connect();
  return { harness, transport };
}

async function finished(scenario: Scenario): Promise<Scenario> {
  await flush();
  await scenario.harness.session.closed;
  await flush();
  return scenario;
}

function forged(message: Record<string, unknown>, sequence: number, generation = 1): string {
  const encoded = encodeFrame({
    sessionId: SESSION_ID,
    attachmentGeneration: generation,
    sequence,
    ...message,
  } as unknown as ClientMessage);
  if (!encoded.ok) throw new Error('could not forge a frame');
  return encoded.value as string;
}

const ROWS: Row[] = [
  {
    name: 'natural process exit',
    cite: '"Exit: ... PTY EOF or source completion, then the distinct process-exit result ... and emits cleanup-result."',
    run: async () => {
      const scenario = await connected();
      scenario.harness.stream.push(utf8('x'));
      await flush();
      scenario.harness.session.reportProcessExit(0, null);
      scenario.harness.stream.end();
      await flush();
      scenario.transport.pump();
      scenario.transport.send(scenario.transport.client.consumeOutput(1));
      return finished(scenario);
    },
    frames: ['capabilities', 'output', 'process-exit', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'source complete on an output-only session',
    cite: '"Output-only sources ... report source completion rather than inventing exit code zero."',
    run: async () => {
      const scenario = await connected({ backend: false });
      scenario.harness.stream.push(utf8('x'));
      await flush();
      scenario.harness.stream.end();
      await flush();
      scenario.transport.pump();
      scenario.transport.send(scenario.transport.client.consumeOutput(1));
      return finished(scenario);
    },
    frames: ['capabilities', 'output', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'terminate from the client',
    cite: STOP_CITE,
    run: async () => {
      const scenario = await connected();
      scenario.transport.send(scenario.transport.client.terminate());
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'host stop',
    cite: STOP_CITE,
    run: async () => {
      const scenario = await connected();
      void scenario.harness.session.stop();
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'host dispose',
    cite: STOP_CITE,
    run: async () => {
      const scenario = await connected();
      void scenario.harness.session.dispose();
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'authorization revoked',
    cite: STOP_CITE,
    run: async () => {
      const scenario = await connected();
      void scenario.harness.session.revokeAuthorization();
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'the transport closes underneath the session',
    cite: '"transport-failed | either, live session | unknown delivery; generation revoked" (the peer is already gone, so the host closes normally)',
    run: async () => {
      const scenario = await connected();
      await scenario.transport.connection.transportClosed();
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'liveness expiry',
    cite: '"Idle/liveness deadline ... liveness probes do not grant authority" (security-and-budgets.md); not a failure-table row, so the normal close',
    run: async () => {
      const scenario = await connected();
      scenario.harness.clock.advance(30_000);
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
  },
  {
    name: 'malformed frame',
    cite: '"malformed-frame | either, decode | reject; current generation revoked | 1002"',
    run: async () => {
      const scenario = await connected();
      scenario.transport.connection.receive('this is not a frame');
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1002,
  },
  {
    name: 'oversized frame',
    cite: '"frame-too-large | either, decode | reject; current generation revoked | 1009"',
    run: async () => {
      const scenario = await connected();
      scenario.transport.connection.receive('x'.repeat(70_000));
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1009,
  },
  {
    name: 'unsupported protocol version before any attachment',
    cite: '"protocol-version-unsupported | server, handshake | reject; no generation issued | 1002"',
    run: async () => {
      const harness = createHarness();
      const transport = createFixtureTransport({ session: harness.session });
      transport.connection.receive(
        JSON.stringify({
          version: 2,
          kind: 'hello',
          direction: 'client-to-server',
          sessionId: 'x',
        }),
      );
      await flush();
      return { harness, transport };
    },
    frames: [],
    close: 1002,
  },
  {
    name: 'output overflow',
    cite: '"Output queue ... overflow revokes the generation and quarantines cleanup"; "cleanup-incomplete ... explicit incomplete result ... 1000"',
    run: async () => {
      const scenario = await connected({ budgets: { outputQueueBytes: 65_536 } });
      scenario.harness.stream.push(new Uint8Array(40_000));
      scenario.harness.stream.push(new Uint8Array(40_000));
      return finished(scenario);
    },
    frames: ['capabilities', 'output', 'cleanup-result'],
    close: 1000,
    outcome: 'incomplete',
  },
  {
    name: 'cleanup that reports incomplete',
    cite: '"cleanup-incomplete | server, disposal | explicit incomplete result; slot quarantined | 1000"',
    run: async () => {
      const scenario = await connected({
        backend: { cleanup: () => Promise.resolve('incomplete') },
      });
      void scenario.harness.session.dispose();
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
    outcome: 'incomplete',
  },
  {
    name: 'cleanup that reports unknown',
    cite: '"incomplete and unknown quarantine the slot"; "cleanup-incomplete ... 1000"',
    run: async () => {
      const scenario = await connected({ backend: { cleanup: () => Promise.resolve('unknown') } });
      void scenario.harness.session.dispose();
      return finished(scenario);
    },
    frames: ['capabilities', 'cleanup-result'],
    close: 1000,
    outcome: 'unknown',
  },
  {
    name: 'backend failure on a submitted operation',
    cite: '"backend-failed | server, submitted operation | operation failure; generation revoked | 1011"',
    run: async () => {
      const scenario = await connected({
        backend: { write: () => Promise.reject(new Error('x')) },
      });
      scenario.transport.send(scenario.transport.client.input(utf8('a')));
      return finished(scenario);
    },
    frames: ['capabilities', 'operation-ack', 'operation-failure', 'cleanup-result'],
    close: 1011,
  },
  {
    name: 'a write that outlives its acknowledgement deadline',
    cite: '"transport-failed | either, live session | unknown delivery; generation revoked | 1011"',
    run: async () => {
      const scenario = await connected({ backend: { write: () => new Promise(() => undefined) } });
      scenario.transport.send(scenario.transport.client.input(utf8('hang')));
      await flush();
      scenario.harness.clock.advance(2_000);
      return finished(scenario);
    },
    frames: ['capabilities', 'operation-ack', 'operation-failure', 'cleanup-result'],
    close: 1011,
  },
  {
    name: 'stop while a write is in flight',
    cite: '"transport-failed ... unknown delivery; generation revoked | 1011": the in-flight write cannot be known to have run',
    run: async () => {
      const scenario = await connected({ backend: { write: () => new Promise(() => undefined) } });
      scenario.transport.send(scenario.transport.client.input(utf8('a')));
      await flush();
      scenario.transport.send(scenario.transport.client.terminate());
      return finished(scenario);
    },
    frames: ['capabilities', 'operation-ack', 'operation-failure', 'cleanup-result'],
    close: 1011,
  },
  {
    name: 'stop with operations that were never submitted',
    cite: STOP_CITE + ' (canceled operations were never submitted, so the stop closes normally)',
    run: async () => {
      const scenario = await connected({ backend: { write: () => new Promise(() => undefined) } });
      scenario.transport.send(scenario.transport.client.input(utf8('a')));
      scenario.transport.send(scenario.transport.client.input(utf8('b')));
      scenario.transport.send(scenario.transport.client.terminate());
      return finished(scenario);
    },
    frames: [
      'capabilities',
      'operation-ack',
      'operation-ack',
      'operation-failure',
      'operation-failure',
      'cleanup-result',
    ],
    close: 1000,
  },
  {
    name: 'startup failure after the attachment',
    cite: '"spawn-failed | server, startup | startup failure; generation revoked | 1011"; "Startup failure: ... `attachment-error` with no process-exit success."',
    run: async () => {
      const harness = createHarness({
        backend: { start: () => Promise.reject(new Error('no shell')) },
      });
      const transport = createFixtureTransport({ session: harness.session });
      transport.connect();
      void harness.session.start();
      return finished({ harness, transport });
    },
    frames: ['capabilities', 'attachment-error', 'cleanup-result'],
    close: 1011,
  },
  {
    name: 'startup failure before the attachment',
    cite: '"spawn-failed | server, startup | startup failure; generation revoked | 1011" (no attachment exists, so there is no cleanup result)',
    run: async () => {
      const harness = createHarness({
        backend: { start: () => Promise.reject(new Error('no shell')) },
      });
      void harness.session.start();
      await flush();
      const transport = createFixtureTransport({ session: harness.session });
      transport.connect();
      return { harness, transport };
    },
    frames: ['attachment-error'],
    close: 1011,
  },
  {
    name: 'a transport whose send throws',
    cite: '"transport-failed | either, live session | unknown delivery; generation revoked | 1011" (the cleanup result cannot be carried by a broken transport)',
    run: async () => {
      const scenario = await connected();
      scenario.transport.breakSends();
      scenario.harness.stream.push(utf8('x'));
      return finished(scenario);
    },
    frames: ['capabilities'],
    close: 1011,
    cleanupUndeliverable: true,
  },
  {
    name: 'a stale generation leaves the attachment live',
    cite: '"stale-generation | either, operation | explicit failure; authority unchanged | 1008 | leave current attachment live"',
    run: async () => {
      const scenario = await connected();
      scenario.transport.connection.receive(forged({ kind: 'input', payload: utf8('x') }, 1, 99));
      await flush();
      return scenario;
    },
    frames: ['capabilities', 'operation-failure'],
    close: 'none',
  },
  {
    name: 'input on a read-only attachment leaves it live',
    cite: '"read-only | client, input/query | explicit failure; authority unchanged | 1008 | operation is not queued"',
    run: async () => {
      const scenario = await connected({}, 'read-only');
      scenario.transport.connection.receive(forged({ kind: 'input', payload: utf8('x') }, 1));
      await flush();
      return scenario;
    },
    frames: ['capabilities', 'operation-failure'],
    close: 'none',
  },
  {
    name: 'a full FIFO leaves the attachment live',
    cite: '"fifo-full | client, input/resize | explicit failure; authority unchanged | 1013 | preserve existing queue; no process action"',
    run: async () => {
      const gate = createDeferred<void>();
      const scenario = await connected({
        backend: { write: () => gate.promise },
        budgets: { operationQueueLimit: 1 },
      });
      scenario.transport.send(scenario.transport.client.input(utf8('a')));
      await flush();
      scenario.transport.pump();
      scenario.transport.send(scenario.transport.client.input(utf8('b')));
      scenario.transport.pump();
      scenario.transport.send(scenario.transport.client.input(utf8('c')));
      await flush();
      return scenario;
    },
    frames: ['capabilities', 'operation-ack', 'operation-ack', 'operation-failure'],
    close: 'none',
  },
];

function wireKinds(transport: FixtureTransport): string[] {
  const kinds: string[] = [];
  for (const event of transport.wire) {
    if (event.type !== 'frame') continue;
    const decoded = decodeFrame(event.frame, 'client', { maxFrameBytes: 65_536 });
    kinds.push(decoded.ok ? decoded.value.kind : `undecodable:${decoded.failure.code}`);
  }
  return kinds;
}

describe('how every connection ends', () => {
  test('the table covers every close cause the connection can reach', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(24);
  });

  test('the fixture socket drops what is sent after it closes, and records it', async () => {
    const { transport } = await connected();
    transport.socket.close(1000);
    expect(() => transport.socket.send('late')).toThrow('closed');
    expect(transport.sentAfterClose).toEqual(['late']);
    expect(transport.wire.at(-1)).toEqual({ type: 'close', code: 1000 });
  });

  test.each(ROWS)('$name', async (row) => {
    const { harness, transport } = await row.run();
    expect(wireKinds(transport)).toEqual([...row.frames]);
    // A real socket drops whatever follows its close: nothing may be sent after it.
    expect(transport.sentAfterClose).toEqual([]);
    if (row.close === 'none') {
      expect(transport.closeCodes).toEqual([]);
      await harness.session.dispose();
      return;
    }
    expect(transport.closeCodes).toEqual([row.close]);
    expect(transport.wire.at(-1)).toEqual({ type: 'close', code: row.close });
    if (row.cleanupUndeliverable === true) return;
    if (row.frames.length === 0 || row.frames.at(-1) !== 'cleanup-result') return;
    const cleanup = transport.wire.findLast((event) => event.type === 'frame');
    const decoded =
      cleanup?.type === 'frame'
        ? decodeFrame(cleanup.frame, 'client', { maxFrameBytes: 65_536 })
        : undefined;
    expect(
      decoded?.ok && decoded.value.kind === 'cleanup-result' ? decoded.value.outcome : undefined,
    ).toBe(row.outcome ?? 'complete');
    expect(row.cite.length).toBeGreaterThan(0);
  });
});
