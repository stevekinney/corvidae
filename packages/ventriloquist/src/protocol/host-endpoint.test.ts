import { describe, expect, test } from 'bun:test';

import { ClientEndpoint } from './client-endpoint.ts';
import {
  connect,
  expectOk,
  OTHER_SESSION_IDENTIFIER,
  OUTPUT_ONLY_CAPABILITIES,
  PIPE_CAPABILITIES,
  PTY_CAPABILITIES,
  READ_ONLY_CAPABILITIES,
  SESSION_IDENTIFIER,
  TOKEN,
} from './endpoint-pair.test-support.ts';
import { decodeFrame, encodeFrame } from './frame-codec.ts';
import { HostEndpoint } from './host-endpoint.ts';
import type { ClientMessage } from './messages.ts';
import { MAXIMUM_SEQUENCE } from './protocol-constants.ts';
import { SequenceCursor } from './sequence-cursor.ts';

function helloFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    kind: 'hello',
    direction: 'client-to-server',
    sessionId: SESSION_IDENTIFIER,
    requestedMode: 'interactive',
    token: TOKEN,
    ...overrides,
  });
}

/** Encode a client message with the given generation and sequence, bypassing the client endpoint. */
function clientFrame(
  message: Record<string, unknown>,
  header: { sequence: number; generation?: number; sessionId?: string },
): Uint8Array | string {
  return expectOk(
    encodeFrame({
      sessionId: header.sessionId ?? SESSION_IDENTIFIER,
      attachmentGeneration: header.generation ?? 1,
      sequence: header.sequence,
      ...message,
    } as unknown as ClientMessage),
  );
}

function inputFrame(sequence: number, generation = 1): Uint8Array | string {
  return clientFrame({ kind: 'input', payload: Uint8Array.of(0x61) }, { sequence, generation });
}

function failureOf(result: {
  ok: boolean;
  failure?: { code: string; reason: string; reply?: string };
}) {
  expect(result.ok).toBe(false);
  return { code: result.failure?.code, reason: result.failure?.reason };
}

describe('constructing a host endpoint', () => {
  test.each([0, 65_537, 262_144, 1.5])('rejects a frame limit of %j', (maxFrameBytes) => {
    expect(() => new HostEndpoint({ maxFrameBytes })).toThrow(RangeError);
  });

  test.each([0, 257, 4096, 1.5])('rejects a queue depth of %j', (maxQueuedOperations) => {
    expect(() => new HostEndpoint({ maxQueuedOperations })).toThrow(RangeError);
  });

  test('accepts the contractual maxima and nothing above them', () => {
    const host = new HostEndpoint({ maxFrameBytes: 65_536, maxQueuedOperations: 256 });
    expectOk(host.receive(helloFrame()));
    expect(
      JSON.parse(
        expectOk(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES })),
      ),
    ).toMatchObject({ maxFrameBytes: 65_536, maxQueuedOperations: 256 });
  });

  test('advertises the limits it was given', () => {
    const host = new HostEndpoint({ maxFrameBytes: 1024, maxQueuedOperations: 8 });
    expectOk(host.receive(helloFrame()));
    const capabilities = expectOk(
      host.issueCapabilities({ generation: 4, capabilities: PTY_CAPABILITIES }),
    );
    expect(JSON.parse(capabilities)).toMatchObject({
      version: 1,
      kind: 'capabilities',
      sessionId: SESSION_IDENTIFIER,
      attachmentGeneration: 4,
      maxFrameBytes: 1024,
      maxQueuedOperations: 8,
    });
  });
});

describe('the handshake', () => {
  test('moves from awaiting a hello to attached', () => {
    const host = new HostEndpoint();
    expect(host.phase).toBe('awaiting-hello');
    expect(host.hello).toBeUndefined();
    expect(host.terms).toBeUndefined();
    expect(expectOk(host.receive(helloFrame())).kind).toBe('hello');
    expect(host.phase).toBe('awaiting-capabilities');
    expect(host.hello?.requestedMode).toBe('interactive');
    expectOk(host.issueCapabilities({ generation: 9, capabilities: PTY_CAPABILITIES }));
    expect(host.phase).toBe('attached');
    expect(host.terms).toEqual({
      generation: 9,
      capabilities: PTY_CAPABILITIES,
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
    });
  });

  test('fails closed on an unsupported version and issues no generation', () => {
    const host = new HostEndpoint();
    expect(failureOf(host.receive(helloFrame({ version: 2 })))).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
    expect(host.receive(helloFrame())).toMatchObject({
      ok: false,
      failure: { reason: 'attachment-revoked' },
    });
    expect(host.phase).toBe('awaiting-hello');
    expect(
      failureOf(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES })),
    ).toEqual({
      code: 'transport-failed',
      reason: 'unexpected-message',
    });
  });

  test('rejects any frame that is not a hello first', () => {
    const host = new HostEndpoint();
    expect(failureOf(host.receive(inputFrame(1)))).toEqual({
      code: 'malformed-frame',
      reason: 'handshake-incomplete',
    });
    expect(failureOf(host.receive(helloFrame()))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('rejects a second hello and any frame before capabilities are issued', () => {
    const duplicate = new HostEndpoint();
    expectOk(duplicate.receive(helloFrame()));
    expect(failureOf(duplicate.receive(helloFrame()))).toEqual({
      code: 'malformed-frame',
      reason: 'duplicate-handshake',
    });
    const early = new HostEndpoint();
    expectOk(early.receive(helloFrame()));
    expect(failureOf(early.receive(inputFrame(1)))).toEqual({
      code: 'malformed-frame',
      reason: 'handshake-incomplete',
    });
  });

  test('refuses to issue capabilities that exceed what the client asked for or break the invariants', () => {
    const host = new HostEndpoint();
    expectOk(host.receive(helloFrame({ requestedMode: 'read-only' })));
    expect(
      failureOf(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES })),
    ).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-capabilities',
    });
    expect(host.phase).toBe('awaiting-capabilities');
    expect(
      failureOf(host.issueCapabilities({ generation: 0, capabilities: READ_ONLY_CAPABILITIES })),
    ).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-generation',
    });
    expect(host.phase).toBe('awaiting-capabilities');
    expectOk(host.issueCapabilities({ generation: 1, capabilities: READ_ONLY_CAPABILITIES }));
    expect(
      failureOf(host.issueCapabilities({ generation: 2, capabilities: READ_ONLY_CAPABILITIES })),
    ).toEqual({
      code: 'transport-failed',
      reason: 'unexpected-message',
    });
  });

  test('never repeats the token in a failure', () => {
    const host = new HostEndpoint();
    const result = host.receive(helloFrame({ version: 2 }));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe('receiving after the handshake', () => {
  test('accepts input, resize, consumed-output and terminate in sequence', () => {
    const { host, client } = connect();
    expectOk(client.receive(expectOk(host.output('pty', 'hello')).frame));
    expect(expectOk(host.receive(expectOk(client.input('ls\r')).frame)).kind).toBe('input');
    expect(expectOk(host.receive(expectOk(client.resize(100, 30)).frame)).kind).toBe('resize');
    expectOk(client.receive(expectOk(host.output('pty', 'out')).frame));
    expectOk(client.receive(expectOk(host.output('pty', 'put')).frame));
    expect(expectOk(host.receive(expectOk(client.consumeOutput(3)).frame)).kind).toBe(
      'output-consumed',
    );
    expect(host.outputBytes).toEqual({ produced: 11, consumed: 3 });
    expect(client.outputBytes).toEqual({ received: 11, consumed: 3 });
    expect(host.authorityRevoked).toBe(false);
    expect(expectOk(host.receive(expectOk(client.terminate()).frame)).kind).toBe('terminate');
    expect(host.authorityRevoked).toBe(true);
  });

  test('rejects a stale session or generation as an explicit failure and leaves the attachment live', () => {
    const { host } = connect({ generation: 2 });
    const otherSession = clientFrame(
      { kind: 'input', payload: Uint8Array.of(1) },
      { sequence: 1, generation: 2, sessionId: OTHER_SESSION_IDENTIFIER },
    );
    expect(failureOf(host.receive(otherSession))).toEqual({
      code: 'stale-generation',
      reason: 'stale-session',
    });
    for (const generation of [1, 3]) {
      expect(failureOf(host.receive(inputFrame(1, generation)))).toEqual({
        code: 'stale-generation',
        reason: 'stale-generation',
      });
    }
    expect(host.receive(inputFrame(1, 2)).ok).toBe(true);
  });

  test.each([
    [
      'input',
      (sequence: number, generation: number, sessionId: string) =>
        clientFrame(
          { kind: 'input', payload: Uint8Array.of(1) },
          { sequence, generation, sessionId },
        ),
    ],
    [
      'resize',
      (sequence: number, generation: number, sessionId: string) =>
        clientFrame({ kind: 'resize', columns: 80, rows: 24 }, { sequence, generation, sessionId }),
    ],
  ])(
    'answers a stale %s with an operation-failure the client surfaces, and never queues it',
    (_kind, build) => {
      const { host, client } = connect({ generation: 2, host: { maxQueuedOperations: 1 } });
      const stale = [
        build(7, 1, SESSION_IDENTIFIER),
        build(8, 3, SESSION_IDENTIFIER),
        build(9, 2, OTHER_SESSION_IDENTIFIER),
      ];
      const replies = stale.map((frame) => {
        const result = host.receive(frame);
        expect(result.ok).toBe(false);
        const reply = (result as { failure: { code: string; reply?: string } }).failure;
        expect(reply.code).toBe('stale-generation');
        expect(typeof reply.reply).toBe('string');
        return reply.reply!;
      });
      const decoded = replies.map((reply) => expectOk(decodeFrame(reply, 'client')));
      expect(
        decoded.map((message) => (message as { operationSequence?: number }).operationSequence),
      ).toEqual([7, 8, 9]);
      for (const message of decoded) {
        expect(message).toMatchObject({
          kind: 'operation-failure',
          code: 'stale-generation',
          sessionId: SESSION_IDENTIFIER,
          attachmentGeneration: 2,
        });
      }
      for (const reply of replies) {
        expect(expectOk(client.receive(reply))).toMatchObject({ code: 'stale-generation' });
      }
      expect(client.authorityRevoked).toBe(false);
      expect(host.authorityRevoked).toBe(false);
      expect(client.phase).toBe('attached');
      // The one-slot FIFO is still empty and the inbound sequence unspent.
      expect(host.receive(inputFrame(1, 2)).ok).toBe(true);
      expect(failureOf(host.receive(inputFrame(2, 2)))).toEqual({
        code: 'fifo-full',
        reason: 'operation-window-full',
      });
    },
  );

  test('answers a stale session or generation on a non-operation message without a reply', () => {
    const { host } = connect({ generation: 2 });
    const stale = clientFrame({ kind: 'terminate' }, { sequence: 1, generation: 1 });
    const result = host.receive(stale);
    expect(failureOf(result)).toEqual({ code: 'stale-generation', reason: 'stale-generation' });
    expect((result as { failure: { reply?: string } }).failure.reply).toBeUndefined();
    expect(host.authorityRevoked).toBe(false);
  });

  test('sends no reply for a stale operation once cleanup has been reported', () => {
    const { host } = connect({ generation: 2 });
    expectOk(host.cleanupResult('complete'));
    const result = host.receive(inputFrame(1, 1)) as { failure: { reply?: string } };
    expect(result.failure.reply).toBeUndefined();
  });

  test('refuses to fail a queued operation with a stale-generation code', () => {
    const { host, client } = connect();
    const first = expectOk(client.input('a'));
    expectOk(host.receive(first.frame));
    expect(failureOf(host.failOperation(first.sequence, 'stale-generation', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
  });

  test.each([
    ['a duplicate', [1, 1], 'duplicate-sequence'],
    ['a replay', [1, 2, 1], 'out-of-order-sequence'],
    ['a gap', [1, 3], 'out-of-order-sequence'],
    ['a restart', [2], 'out-of-order-sequence'],
  ])('revokes the attachment on %s sequence', (_name, sequences, reason) => {
    const { host } = connect();
    const results = sequences.map((sequence) => host.receive(inputFrame(sequence)));
    const last = results.at(-1)!;
    expect(failureOf(last)).toEqual({ code: 'malformed-frame', reason });
    expect(failureOf(host.receive(inputFrame(sequences.length + 1)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('a rejected frame has no side effect: the next frame in order is still accepted', () => {
    const { host } = connect({ generation: 5 });
    expect(host.receive(inputFrame(1, 4)).ok).toBe(false);
    expect(host.receive(inputFrame(1, 5)).ok).toBe(true);
    expect(host.receive(inputFrame(2, 4)).ok).toBe(false);
    expect(host.receive(inputFrame(2, 5)).ok).toBe(true);
  });

  test('revokes the attachment on a malformed or oversized frame', () => {
    const malformed = connect().host;
    expect(failureOf(malformed.receive('{}'))).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
    expect(failureOf(malformed.receive('{}'))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
    const oversized = connect({ host: { maxFrameBytes: 1024 } }).host;
    expect(
      failureOf(
        oversized.receive(
          clientFrame({ kind: 'input', payload: new Uint8Array(1025) }, { sequence: 1 }),
        ),
      ),
    ).toEqual({ code: 'frame-too-large', reason: 'oversized' });
    expect(failureOf(oversized.receive(inputFrame(1)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('rejects a second hello once attached', () => {
    const { host } = connect();
    expect(failureOf(host.receive(helloFrame()))).toEqual({
      code: 'malformed-frame',
      reason: 'duplicate-handshake',
    });
  });

  test('rejects server messages sent to the host', () => {
    const { host } = connect();
    const wrongWay = expectOk(
      encodeFrame({
        kind: 'cleanup-result',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: 1,
        sequence: 1,
        outcome: 'complete',
      }),
    );
    expect(failureOf(host.receive(wrongWay))).toEqual({
      code: 'malformed-frame',
      reason: 'wrong-direction',
    });
  });

  test('rejects an input sequence past the largest, then everything as overflow', () => {
    const cursors = {
      inbound: new SequenceCursor(MAXIMUM_SEQUENCE - 1),
      outbound: new SequenceCursor(),
    };
    const host = new HostEndpoint({}, cursors);
    expectOk(host.receive(helloFrame()));
    expectOk(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES }));
    expect(host.receive(inputFrame(MAXIMUM_SEQUENCE)).ok).toBe(true);
    expect(failureOf(host.receive(inputFrame(MAXIMUM_SEQUENCE)))).toEqual({
      code: 'malformed-frame',
      reason: 'sequence-overflow',
    });
  });
});

describe('operations the host refuses without queueing them', () => {
  test('answers input to a read-only attachment with a read-only failure it can send', () => {
    const { host, client } = connect({
      capabilities: READ_ONLY_CAPABILITIES,
      requestedMode: 'read-only',
    });
    const rejected = host.receive(inputFrame(1));
    expect(rejected).toMatchObject({
      ok: false,
      failure: { code: 'read-only', reason: 'operation-not-permitted' },
    });
    const reply = decodeFrame(rejected.ok ? '' : rejected.failure.reply!, 'client');
    expect(expectOk(reply)).toMatchObject({
      kind: 'operation-failure',
      operationSequence: 1,
      code: 'read-only',
      sequence: 1,
      attachmentGeneration: 1,
    });
    expect(
      host.receive(clientFrame({ kind: 'resize', columns: 80, rows: 24 }, { sequence: 2 })).ok,
    ).toBe(false);
    expect(
      host.receive(clientFrame({ kind: 'output-consumed', consumedBytes: 1 }, { sequence: 3 })).ok,
    ).toBe(false);
    expect(client.phase).toBe('attached');
  });

  test('refuses resize where the capabilities say there is nothing to resize', () => {
    const { host } = connect({ capabilities: PIPE_CAPABILITIES });
    expect(host.receive(inputFrame(1)).ok).toBe(true);
    expect(
      host.receive(clientFrame({ kind: 'resize', columns: 80, rows: 24 }, { sequence: 2 })),
    ).toMatchObject({ ok: false, failure: { code: 'read-only' } });
  });

  test('keeps the sequence of a refused operation so the next one is still in order', () => {
    const { host } = connect({ capabilities: PIPE_CAPABILITIES });
    expect(
      host.receive(clientFrame({ kind: 'resize', columns: 80, rows: 24 }, { sequence: 1 })).ok,
    ).toBe(false);
    expect(host.receive(inputFrame(2)).ok).toBe(true);
  });

  test('answers an operation past the queue depth with fifo-full and preserves the queue', () => {
    const { host } = connect({ host: { maxQueuedOperations: 2 } });
    expect(host.receive(inputFrame(1)).ok).toBe(true);
    expect(host.receive(inputFrame(2)).ok).toBe(true);
    const full = host.receive(inputFrame(3));
    expect(full).toMatchObject({
      ok: false,
      failure: { code: 'fifo-full', reason: 'operation-window-full' },
    });
    expect(expectOk(host.acknowledgeOperation(1)).sequence).toBeGreaterThan(0);
    expect(host.receive(inputFrame(4)).ok).toBe(true);
  });

  test('refuses input and resize after a stop, but still takes consumed-output', () => {
    const { host, client } = connect();
    expectOk(host.output('pty', 'abc'));
    expectOk(host.receive(expectOk(client.terminate()).frame));
    expect(host.receive(inputFrame(2))).toMatchObject({
      ok: false,
      failure: { code: 'read-only', reason: 'authority-revoked' },
    });
    const consumed = clientFrame({ kind: 'output-consumed', consumedBytes: 3 }, { sequence: 3 });
    expect(host.receive(consumed).ok).toBe(true);
  });
});

describe('a refusal the host cannot report', () => {
  function overflowing(options: { maxQueuedOperations?: number } = {}): HostEndpoint {
    const host = new HostEndpoint(options, {
      inbound: new SequenceCursor(),
      outbound: new SequenceCursor(MAXIMUM_SEQUENCE),
    });
    expectOk(host.receive(helloFrame()));
    expectOk(host.issueCapabilities({ generation: 1, capabilities: PIPE_CAPABILITIES }));
    return host;
  }

  const overflow = { code: 'transport-failed', reason: 'sequence-overflow' };

  test('returns the send failure and revokes the generation for a read-only refusal', () => {
    const host = overflowing();
    const refused = host.receive(
      clientFrame({ kind: 'resize', columns: 80, rows: 24 }, { sequence: 1 }),
    );
    expect(failureOf(refused)).toEqual(overflow);
    expect(host.authorityRevoked).toBe(true);
    expect(failureOf(host.receive(inputFrame(2)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('returns the send failure and revokes the generation for a fifo-full refusal', () => {
    const host = overflowing({ maxQueuedOperations: 1 });
    expectOk(host.receive(inputFrame(1)));
    expect(failureOf(host.receive(inputFrame(2)))).toEqual(overflow);
    expect(host.authorityRevoked).toBe(true);
    expect(failureOf(host.receive(inputFrame(3))).reason).toBe('attachment-revoked');
  });

  test('returns the send failure and revokes the generation for a stale-generation refusal', () => {
    const host = overflowing();
    expect(failureOf(host.receive(inputFrame(1, 2)))).toEqual(overflow);
    expect(host.authorityRevoked).toBe(true);
    expect(failureOf(host.receive(inputFrame(1))).reason).toBe('attachment-revoked');
  });
});

describe('acknowledgements from the client', () => {
  function withOutput() {
    const pair = connect();
    expectOk(pair.client.receive(expectOk(pair.host.output('pty', new Uint8Array(10))).frame));
    return pair;
  }

  test('rejects a duplicate, stale and over-counted consumed-output count and revokes the attachment', () => {
    const cases: Array<[number[], string]> = [
      [[4, 4], 'duplicate-acknowledgement'],
      [[4, 3], 'stale-acknowledgement'],
      [[11], 'over-counted-acknowledgement'],
      [[4, 11], 'over-counted-acknowledgement'],
    ];
    for (const [counts, reason] of cases) {
      const { host } = withOutput();
      const results = counts.map((consumedBytes, index) =>
        host.receive(
          clientFrame({ kind: 'output-consumed', consumedBytes }, { sequence: index + 1 }),
        ),
      );
      expect(failureOf(results.at(-1)!)).toEqual({ code: 'malformed-frame', reason });
      expect(failureOf(host.receive(inputFrame(counts.length + 1)))).toEqual({
        code: 'stale-generation',
        reason: 'attachment-revoked',
      });
    }
  });

  test('does not move the consumed count when an acknowledgement is rejected', () => {
    const { host } = withOutput();
    host.receive(clientFrame({ kind: 'output-consumed', consumedBytes: 99 }, { sequence: 1 }));
    expect(host.outputBytes.consumed).toBe(0);
  });
});

describe('frames the host sends', () => {
  test('refuses to send before capabilities are issued', () => {
    const host = new HostEndpoint();
    expect(failureOf(host.output('pty', 'x'))).toEqual({
      code: 'stale-generation',
      reason: 'handshake-incomplete',
    });
    expect(failureOf(host.acknowledgeOperation(1))).toEqual({
      code: 'malformed-frame',
      reason: 'future-acknowledgement',
    });
    expect(failureOf(host.processExit(0, null))).toEqual({
      code: 'stale-generation',
      reason: 'handshake-incomplete',
    });
    expect(failureOf(host.cleanupResult('complete'))).toEqual({
      code: 'stale-generation',
      reason: 'handshake-incomplete',
    });
    expect(failureOf(host.attachmentError('spawn-failed', 'x'))).toEqual({
      code: 'stale-generation',
      reason: 'handshake-incomplete',
    });
  });

  test('numbers output frames in order and keeps channels apart for a pipe', () => {
    const { host, client } = connect({ capabilities: PIPE_CAPABILITIES });
    const sent = [
      expectOk(host.output('stdout', 'a')),
      expectOk(host.output('stderr', 'b')),
      expectOk(host.output('stdout', 'c')),
    ];
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
    const received = sent.map((frame) => expectOk(client.receive(frame.frame)));
    expect(received.map((message) => message.kind === 'output' && message.channel)).toEqual([
      'stdout',
      'stderr',
      'stdout',
    ]);
  });

  test('refuses an output channel the mode does not have', () => {
    const pty = connect().host;
    expect(failureOf(pty.output('stdout', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'channel-not-permitted',
    });
    const pipe = connect({ capabilities: PIPE_CAPABILITIES }).host;
    expect(failureOf(pipe.output('pty', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'channel-not-permitted',
    });
    const source = connect({
      capabilities: OUTPUT_ONLY_CAPABILITIES,
      requestedMode: 'read-only',
    }).host;
    expect(failureOf(source.output('stderr', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'channel-not-permitted',
    });
    expect(source.output('stdout', 'x').ok).toBe(true);
  });

  test('counts a string as its UTF-8 bytes, never its UTF-16 length', () => {
    const { host } = connect();
    expectOk(host.output('pty', '\u{1f600}é'));
    expect(host.outputBytes.produced).toBe(6);
    expect(failureOf(host.output('pty', 'é'.repeat(40_000)))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
    expect(host.outputBytes.produced).toBe(6);
  });

  test('copies output when it is accepted, so the producer can reuse its buffer', () => {
    const { host, client } = connect();
    const producer = Uint8Array.of(1, 2, 3);
    const sent = expectOk(host.output('pty', producer));
    producer.fill(0);
    const message = expectOk(client.receive(sent.frame));
    expect(message.kind === 'output' && [...message.payload]).toEqual([1, 2, 3]);
  });

  test('acknowledges operations only in the order they were submitted, once each', () => {
    const { host, client } = connect();
    const sequences = [1, 2, 3].map((index) => {
      const sent = expectOk(client.input(`line ${index}`));
      expectOk(host.receive(sent.frame));
      return sent.sequence;
    });
    expect(failureOf(host.acknowledgeOperation(sequences[1]!))).toEqual({
      code: 'malformed-frame',
      reason: 'out-of-order-acknowledgement',
    });
    expect(failureOf(host.acknowledgeOperation(99))).toEqual({
      code: 'malformed-frame',
      reason: 'future-acknowledgement',
    });
    for (const sequence of sequences) {
      const ack = expectOk(host.acknowledgeOperation(sequence));
      expect(expectOk(client.receive(ack.frame))).toMatchObject({
        kind: 'operation-ack',
        operationSequence: sequence,
      });
    }
    expect(failureOf(host.acknowledgeOperation(sequences[2]!))).toEqual({
      code: 'malformed-frame',
      reason: 'duplicate-acknowledgement',
    });
    expect(failureOf(host.acknowledgeOperation(sequences[0]!))).toEqual({
      code: 'malformed-frame',
      reason: 'stale-acknowledgement',
    });
  });

  test('fails an operation before queueing in order, and after acceptance by revoking authority', () => {
    const { host, client } = connect();
    const first = expectOk(client.input('a'));
    const second = expectOk(client.input('b'));
    expectOk(host.receive(first.frame));
    expectOk(host.receive(second.frame));
    expect(failureOf(host.failOperation(second.sequence, 'fifo-full', 'full'))).toEqual({
      code: 'malformed-frame',
      reason: 'out-of-order-acknowledgement',
    });
    expect(failureOf(host.failOperation(first.sequence, 'stale-generation', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    const frames = [
      expectOk(host.failOperation(first.sequence, 'fifo-full', 'full')),
      expectOk(host.acknowledgeOperation(second.sequence)),
    ];
    expect(host.authorityRevoked).toBe(false);
    expect(failureOf(host.failOperation(99, 'backend-failed', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'future-acknowledgement',
    });
    const failure = expectOk(
      host.failOperation(second.sequence, 'backend-failed', 'the child went away'),
    );
    expect(host.authorityRevoked).toBe(true);
    for (const sent of frames) expectOk(client.receive(sent.frame));
    expect(expectOk(client.receive(failure.frame))).toMatchObject({
      kind: 'operation-failure',
      code: 'backend-failed',
      operationSequence: second.sequence,
    });
    expect(client.authorityRevoked).toBe(true);
  });

  test('reports a process exit once and separately from cleanup', () => {
    const { host } = connect();
    expectOk(host.processExit(null, 'SIGKILL'));
    expect(failureOf(host.processExit(0, null))).toEqual({
      code: 'malformed-frame',
      reason: 'already-reported',
    });
    expectOk(host.cleanupResult('complete'));
  });

  test('reports a startup failure before any generation with generation and sequence 0', () => {
    const host = new HostEndpoint();
    expectOk(host.receive(helloFrame()));
    const sent = expectOk(host.attachmentError('unsupported-runtime', 'windows'));
    expect(sent.sequence).toBe(0);
    expect(expectOk(decodeFrame(sent.frame, 'client'))).toMatchObject({
      kind: 'attachment-error',
      attachmentGeneration: 0,
      sequence: 0,
      code: 'unsupported-runtime',
    });
    expect(failureOf(host.receive(inputFrame(1)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('refuses a startup failure whose code does not fit', () => {
    const host = new HostEndpoint();
    expectOk(host.receive(helloFrame()));
    expect(failureOf(host.attachmentError('read-only' as never, 'no'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(host.receive(helloFrame()).ok).toBe(false);
  });

  test('reports an attachment failure after a generation was issued and revokes authority', () => {
    const { host, client } = connect();
    const sent = expectOk(host.attachmentError('spawn-failed', 'no such shell'));
    expect(sent.sequence).toBe(1);
    expect(expectOk(client.receive(sent.frame))).toMatchObject({
      kind: 'attachment-error',
      code: 'spawn-failed',
    });
    expect(host.authorityRevoked).toBe(true);
    expect(client.authorityRevoked).toBe(true);
  });

  test('sends exactly one cleanup result and nothing after it', () => {
    const { host } = connect();
    expectOk(host.cleanupResult('incomplete'));
    for (const attempt of [
      host.cleanupResult('complete'),
      host.output('pty', 'x'),
      host.processExit(0, null),
      host.acknowledgeOperation(1),
    ]) {
      expect(
        failureOf(attempt).reason === 'attachment-revoked' ||
          failureOf(attempt).reason === 'future-acknowledgement',
      ).toBe(true);
    }
    expect(failureOf(host.receive(inputFrame(1)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('refuses to fail a sequence that was an output-consumed frame, not an operation', () => {
    const { host, client } = connect();
    expectOk(client.receive(expectOk(host.output('pty', 'abc')).frame));
    const first = expectOk(client.input('a'));
    const consumed = expectOk(client.consumeOutput(3));
    const second = expectOk(client.input('b'));
    for (const sent of [first, consumed, second]) expectOk(host.receive(sent.frame));
    expect(consumed.sequence).toBe(2);
    expect(failureOf(host.failOperation(consumed.sequence, 'backend-failed', 'x'))).toEqual({
      code: 'malformed-frame',
      reason: 'unknown-operation',
    });
    expect(host.authorityRevoked).toBe(false);
    expectOk(host.failOperation(second.sequence, 'backend-failed', 'x'));
    expect(host.authorityRevoked).toBe(true);
  });

  test('revokes authority when the process exits, and refuses input and resize afterwards', () => {
    const { host } = connect();
    expect(host.authorityRevoked).toBe(false);
    expectOk(host.processExit(0, null));
    expect(host.authorityRevoked).toBe(true);
    const input = host.receive(inputFrame(1));
    expect(failureOf(input)).toEqual({ code: 'read-only', reason: 'authority-revoked' });
    const reply = decodeFrame(input.ok ? '' : input.failure.reply!, 'client');
    expect(expectOk(reply)).toMatchObject({
      kind: 'operation-failure',
      code: 'read-only',
      operationSequence: 1,
    });
    expect(
      failureOf(
        host.receive(clientFrame({ kind: 'resize', columns: 80, rows: 24 }, { sequence: 2 })),
      ),
    ).toEqual({ code: 'read-only', reason: 'authority-revoked' });
    // Nothing was queued, so there is no operation to acknowledge.
    expect(failureOf(host.acknowledgeOperation(1)).reason).toBe('future-acknowledgement');
    // The attachment is still live for cleanup.
    expectOk(host.cleanupResult('complete'));
  });

  test('revokes authority when the process exit could not be sent, but does not report it', () => {
    const host = new HostEndpoint(
      {},
      { inbound: new SequenceCursor(), outbound: new SequenceCursor(MAXIMUM_SEQUENCE) },
    );
    expectOk(host.receive(helloFrame()));
    expectOk(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES }));
    expect(host.processExit(0, null).ok).toBe(false);
    expect(host.authorityRevoked).toBe(true);
    expect(failureOf(host.processExit(0, null)).reason).toBe('sequence-overflow');
  });

  test('issues no capabilities once the endpoint is closed', () => {
    const malformed = new HostEndpoint();
    expectOk(malformed.receive(helloFrame()));
    expect(failureOf(malformed.receive('not json')).code).toBe('malformed-frame');
    expect(
      failureOf(malformed.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES })),
    ).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
    expect(malformed.phase).toBe('awaiting-capabilities');
    expect(malformed.terms).toBeUndefined();
    expect(malformed.output('pty', 'x').ok).toBe(false);

    const failed = new HostEndpoint();
    expectOk(failed.receive(helloFrame()));
    expectOk(failed.attachmentError('spawn-failed', 'no shell'));
    expect(
      failureOf(failed.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES })),
    ).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
    expect(failed.phase).toBe('awaiting-capabilities');
    expect(failed.terms).toBeUndefined();
  });

  test('can still report exit and cleanup after the client was revoked for a bad frame', () => {
    const { host } = connect();
    host.receive('not json');
    expectOk(host.processExit(1, null));
    expectOk(host.cleanupResult('complete'));
  });

  test('refuses to number an outgoing frame past the largest sequence', () => {
    const host = new HostEndpoint(
      {},
      { inbound: new SequenceCursor(), outbound: new SequenceCursor(MAXIMUM_SEQUENCE) },
    );
    expectOk(host.receive(helloFrame()));
    expectOk(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES }));
    expect(failureOf(host.output('pty', 'x'))).toEqual({
      code: 'transport-failed',
      reason: 'sequence-overflow',
    });
    expect(host.outputBytes.produced).toBe(0);
  });
});

test('the client endpoint type is the other half of the pair', () => {
  expect(
    new ClientEndpoint({
      sessionId: SESSION_IDENTIFIER,
      requestedMode: 'interactive',
      token: TOKEN,
    }).phase,
  ).toBe('idle');
});

describe('the host revokes authority whenever it closes', () => {
  test.each([
    ['a malformed frame', 'not json'],
    ['an unsupported version', helloFrame({ version: 2 })],
  ])('revokes authority on %s', (_name, frame) => {
    const { host } = connect();
    expect(host.authorityRevoked).toBe(false);
    expect(host.receive(frame).ok).toBe(false);
    expect(host.authorityRevoked).toBe(true);
    expect(failureOf(host.receive(inputFrame(1))).reason).toBe('attachment-revoked');
  });

  test('revokes authority on a startup failure that sends no attachment', () => {
    const host = new HostEndpoint();
    expectOk(host.receive(helloFrame()));
    expectOk(host.attachmentError('unsupported-runtime', 'windows'));
    expect(host.authorityRevoked).toBe(true);
  });
});

describe('an ordinary send the host cannot number', () => {
  function accepted(): HostEndpoint {
    const host = new HostEndpoint(
      {},
      { inbound: new SequenceCursor(), outbound: new SequenceCursor(MAXIMUM_SEQUENCE) },
    );
    expectOk(host.receive(helloFrame()));
    expectOk(host.issueCapabilities({ generation: 1, capabilities: PTY_CAPABILITIES }));
    expectOk(host.receive(inputFrame(1)));
    return host;
  }

  const overflow = { code: 'transport-failed', reason: 'sequence-overflow' };
  const sends: Array<[string, (host: HostEndpoint) => ReturnType<HostEndpoint['output']>]> = [
    ['output', (host) => host.output('pty', 'x')],
    ['acknowledgeOperation', (host) => host.acknowledgeOperation(1)],
    ['processExit', (host) => host.processExit(0, null)],
  ];

  test.each(sends)('%s revokes authority and closes the inbound side', (_name, send) => {
    const host = accepted();
    expect(host.authorityRevoked).toBe(false);
    expect(failureOf(send(host))).toEqual(overflow);
    expect(host.authorityRevoked).toBe(true);
    expect(failureOf(host.receive(inputFrame(2)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });
});

describe('a startup failure after capabilities were issued', () => {
  test('refuses unsupported-runtime with a typed failure and leaves the attachment live', () => {
    const { host } = connect();
    expect(failureOf(host.attachmentError('unsupported-runtime', 'windows'))).toEqual({
      code: 'malformed-frame',
      reason: 'unexpected-message',
    });
    expect(host.authorityRevoked).toBe(false);
    expect(host.receive(inputFrame(1)).ok).toBe(true);
    expect(expectOk(host.attachmentError('spawn-failed', 'no shell')).sequence).toBe(1);
  });
});

describe('an operation refused before it was queued', () => {
  test.each(['read-only', 'fifo-full'] as const)(
    'cannot later be failed as submitted after %s',
    (refusal) => {
      for (const later of ['backend-failed', 'transport-failed'] as const) {
        const { host } = connect();
        expectOk(host.receive(inputFrame(1)));
        expectOk(host.failOperation(1, refusal, 'refused'));
        expect(failureOf(host.failOperation(1, later, 'late'))).toEqual({
          code: 'malformed-frame',
          reason: 'unknown-operation',
        });
        expect(host.authorityRevoked).toBe(false);
      }
    },
  );
});
