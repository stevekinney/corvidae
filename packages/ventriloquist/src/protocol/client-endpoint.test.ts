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
import type { ProtocolMessage, ServerMessage } from './messages.ts';
import { MAXIMUM_SEQUENCE } from './protocol-constants.ts';
import { SequenceCursor } from './sequence-cursor.ts';

function newClient(
  overrides: Partial<ConstructorParameters<typeof ClientEndpoint>[0]> = {},
  cursors?: { inbound: SequenceCursor; outbound: SequenceCursor },
): ClientEndpoint {
  return new ClientEndpoint(
    { sessionId: SESSION_IDENTIFIER, requestedMode: 'interactive', token: TOKEN, ...overrides },
    cursors,
  );
}

function capabilitiesFrame(overrides: Record<string, unknown> = {}): string {
  return expectOk(
    encodeFrame({
      kind: 'capabilities',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      attachmentGeneration: 1,
      capabilities: PTY_CAPABILITIES,
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
      ...overrides,
    } as unknown as ProtocolMessage),
  ) as string;
}

/** Encode a server message with the given header, bypassing the host endpoint. */
function serverFrame(
  message: Record<string, unknown>,
  header: { sequence: number; generation?: number; sessionId?: string },
): Uint8Array | string {
  return expectOk(
    encodeFrame({
      sessionId: header.sessionId ?? SESSION_IDENTIFIER,
      attachmentGeneration: header.generation ?? 1,
      sequence: header.sequence,
      ...message,
    } as unknown as ServerMessage),
  );
}

function output(sequence: number, generation = 1, bytes = 1): Uint8Array | string {
  return serverFrame(
    { kind: 'output', channel: 'pty', payload: new Uint8Array(bytes) },
    { sequence, generation },
  );
}

function failureOf(result: { ok: boolean; failure?: { code: string; reason: string } }) {
  expect(result.ok).toBe(false);
  return { code: result.failure?.code, reason: result.failure?.reason };
}

function attached(overrides: Record<string, unknown> = {}): ClientEndpoint {
  const client = newClient();
  expectOk(client.hello());
  expectOk(client.receive(capabilitiesFrame(overrides)));
  return client;
}

describe('the handshake', () => {
  test('builds a hello, then moves to attached when capabilities arrive', () => {
    const client = newClient();
    expect(client.phase).toBe('idle');
    expect(client.terms).toBeUndefined();
    expect(JSON.parse(expectOk(client.hello()))).toMatchObject({
      kind: 'hello',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      requestedMode: 'interactive',
      token: TOKEN,
    });
    expect(client.phase).toBe('awaiting-capabilities');
    expect(expectOk(client.receive(capabilitiesFrame({ attachmentGeneration: 7 }))).kind).toBe(
      'capabilities',
    );
    expect(client.phase).toBe('attached');
    expect(client.terms).toEqual({
      generation: 7,
      capabilities: PTY_CAPABILITIES,
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
    });
  });

  test('refuses a second hello and refuses to build one from an invalid session identifier', () => {
    const client = newClient();
    expectOk(client.hello());
    expect(failureOf(client.hello())).toEqual({
      code: 'transport-failed',
      reason: 'duplicate-handshake',
    });
    const invalid = newClient({ sessionId: 'not-a-uuid' });
    expect(failureOf(invalid.hello())).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-session-identifier',
    });
    expect(invalid.phase).toBe('idle');
  });

  test('rejects anything received before the hello was sent', () => {
    const client = newClient();
    expect(failureOf(client.receive(capabilitiesFrame()))).toEqual({
      code: 'malformed-frame',
      reason: 'handshake-incomplete',
    });
    expect(client.phase).toBe('closed');
  });

  test('ignores capabilities for another session without closing', () => {
    const client = newClient();
    expectOk(client.hello());
    const other = capabilitiesFrame({ sessionId: OTHER_SESSION_IDENTIFIER });
    expect(failureOf(client.receive(other))).toEqual({
      code: 'stale-generation',
      reason: 'stale-session',
    });
    expect(client.phase).toBe('awaiting-capabilities');
    expectOk(client.receive(capabilitiesFrame()));
  });

  test('closes on capabilities that grant more than a read-only request', () => {
    const client = newClient({ requestedMode: 'read-only' });
    expectOk(client.hello());
    expect(failureOf(client.receive(capabilitiesFrame()))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-capabilities',
    });
    expect(client.phase).toBe('closed');
  });

  test('accepts a startup failure that carries no generation, then closes', () => {
    const client = newClient();
    expectOk(client.hello());
    const failure = serverFrame(
      { kind: 'attachment-error', code: 'unsupported-runtime', message: 'windows' },
      { sequence: 0, generation: 0 },
    );
    expect(expectOk(client.receive(failure))).toMatchObject({
      kind: 'attachment-error',
      attachmentGeneration: 0,
    });
    expect(client.phase).toBe('closed');
    expect(failureOf(client.receive(output(1)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('ignores a startup failure for another session', () => {
    const client = newClient();
    expectOk(client.hello());
    const failure = serverFrame(
      { kind: 'attachment-error', code: 'unsupported-runtime', message: 'windows' },
      { sequence: 0, generation: 0, sessionId: OTHER_SESSION_IDENTIFIER },
    );
    expect(failureOf(client.receive(failure))).toEqual({
      code: 'stale-generation',
      reason: 'stale-session',
    });
    expect(client.phase).toBe('awaiting-capabilities');
  });

  test('closes on any other message before capabilities, and on a duplicate capabilities', () => {
    const early = newClient();
    expectOk(early.hello());
    expect(failureOf(early.receive(output(1)))).toEqual({
      code: 'malformed-frame',
      reason: 'handshake-incomplete',
    });
    expect(early.phase).toBe('closed');
    const duplicate = attached();
    expect(failureOf(duplicate.receive(capabilitiesFrame()))).toEqual({
      code: 'malformed-frame',
      reason: 'duplicate-handshake',
    });
    expect(duplicate.phase).toBe('closed');
  });

  test('applies the limits the host advertised to what it will accept', () => {
    const client = attached({ maxFrameBytes: 4 });
    expect(failureOf(client.receive(output(1, 1, 5)))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
    expect(client.phase).toBe('closed');
  });
});

describe('receiving after the handshake', () => {
  test('rejects a stale session or generation and leaves the attachment live', () => {
    const client = attached({ attachmentGeneration: 3 });
    const otherSession = serverFrame(
      { kind: 'output', channel: 'pty', payload: new Uint8Array(1) },
      { sequence: 1, generation: 3, sessionId: OTHER_SESSION_IDENTIFIER },
    );
    expect(failureOf(client.receive(otherSession))).toEqual({
      code: 'stale-generation',
      reason: 'stale-session',
    });
    expect(failureOf(client.receive(output(1, 2)))).toEqual({
      code: 'stale-generation',
      reason: 'stale-generation',
    });
    expect(client.outputBytes.received).toBe(0);
    expect(client.receive(output(1, 3)).ok).toBe(true);
  });

  test.each([
    ['a duplicate', [1, 1], 'duplicate-sequence'],
    ['a gap', [1, 3], 'out-of-order-sequence'],
    ['a replay', [1, 2, 1], 'out-of-order-sequence'],
  ])('closes on %s sequence', (_name, sequences, reason) => {
    const client = attached();
    const results = sequences.map((sequence) => client.receive(output(sequence)));
    expect(failureOf(results.at(-1)!)).toEqual({ code: 'malformed-frame', reason });
    expect(client.phase).toBe('closed');
  });

  test('closes on a sequence past the largest', () => {
    const client = newClient(
      {},
      { inbound: new SequenceCursor(MAXIMUM_SEQUENCE), outbound: new SequenceCursor() },
    );
    expectOk(client.hello());
    expectOk(client.receive(capabilitiesFrame()));
    expect(failureOf(client.receive(output(MAXIMUM_SEQUENCE)))).toEqual({
      code: 'malformed-frame',
      reason: 'sequence-overflow',
    });
  });

  test('closes on a channel the mode does not have', () => {
    const client = attached({ capabilities: PIPE_CAPABILITIES });
    expect(failureOf(client.receive(output(1)))).toEqual({
      code: 'malformed-frame',
      reason: 'channel-not-permitted',
    });
    expect(client.outputBytes.received).toBe(0);
  });

  test('closes on a frame going the wrong way, and on an unknown version', () => {
    const wrongWay = attached();
    const input = expectOk(
      encodeFrame({
        kind: 'input',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: 1,
        sequence: 1,
        payload: new Uint8Array(1),
      }),
    );
    expect(failureOf(wrongWay.receive(input))).toEqual({
      code: 'malformed-frame',
      reason: 'wrong-direction',
    });
    const version = attached();
    expect(failureOf(version.receive('{"version":9}'))).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
    expect(version.phase).toBe('closed');
  });

  test('accepts one process exit and rejects a second', () => {
    const client = attached();
    const exit = (sequence: number) =>
      serverFrame({ kind: 'process-exit', exitCode: 0, signal: null }, { sequence });
    expect(client.receive(exit(1)).ok).toBe(true);
    expect(failureOf(client.receive(exit(2)))).toEqual({
      code: 'malformed-frame',
      reason: 'already-reported',
    });
  });

  test('revokes authority on a process exit and refuses input and resize locally afterwards', () => {
    const client = attached();
    expect(client.authorityRevoked).toBe(false);
    expectOk(
      client.receive(
        serverFrame({ kind: 'process-exit', exitCode: 0, signal: null }, { sequence: 1 }),
      ),
    );
    expect(client.authorityRevoked).toBe(true);
    expect(failureOf(client.input('x'))).toEqual({
      code: 'read-only',
      reason: 'authority-revoked',
    });
    expect(failureOf(client.resize(80, 24))).toEqual({
      code: 'read-only',
      reason: 'authority-revoked',
    });
    expect(client.phase).toBe('attached');
  });

  test('revokes authority on an attachment error and closes on the cleanup result', () => {
    const client = attached();
    expectOk(
      client.receive(
        serverFrame(
          { kind: 'attachment-error', code: 'spawn-failed', message: 'no shell' },
          { sequence: 1 },
        ),
      ),
    );
    expect(client.authorityRevoked).toBe(true);
    expect(client.phase).toBe('attached');
    expectOk(
      client.receive(serverFrame({ kind: 'cleanup-result', outcome: 'complete' }, { sequence: 2 })),
    );
    expect(client.phase).toBe('closed');
    expect(failureOf(client.receive(output(3)))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });
});

describe('a closed endpoint holds no authority', () => {
  test.each([
    ['a malformed frame', 'not json'],
    ['an unsupported version', JSON.stringify({ version: 2, kind: 'output' })],
    ['an out-of-order sequence', output(5)],
  ])('revokes authority on %s', (_name, frame) => {
    const client = attached();
    expect(client.authorityRevoked).toBe(false);
    const rejected = client.receive(frame);
    expect(rejected.ok).toBe(false);
    expect(client.phase).toBe('closed');
    expect(client.authorityRevoked).toBe(true);
  });

  test('revokes authority when a startup failure closes the attachment', () => {
    const client = newClient();
    expectOk(client.hello());
    expectOk(
      client.receive(
        serverFrame(
          { kind: 'attachment-error', code: 'unsupported-runtime', message: 'windows' },
          { sequence: 0, generation: 0 },
        ),
      ),
    );
    expect(client.authorityRevoked).toBe(true);
  });
});

describe('acknowledgements from the host', () => {
  function withOperations(count: number) {
    const client = attached();
    const sequences = Array.from(
      { length: count },
      (_, index) => expectOk(client.input(`line ${index}`)).sequence,
    );
    return { client, sequences };
  }

  const ack = (operationSequence: number, sequence: number) =>
    serverFrame({ kind: 'operation-ack', operationSequence }, { sequence });

  test('accepts acknowledgements in submission order', () => {
    const { client, sequences } = withOperations(3);
    sequences.forEach((operationSequence, index) => {
      expect(expectOk(client.receive(ack(operationSequence, index + 1)))).toMatchObject({
        operationSequence,
      });
    });
  });

  test.each([
    ['a future', () => [[99]], 'future-acknowledgement'],
    ['an out-of-order', (sequences: number[]) => [[sequences[1]!]], 'out-of-order-acknowledgement'],
    [
      'a duplicate',
      (sequences: number[]) => [[sequences[0]!], [sequences[0]!]],
      'duplicate-acknowledgement',
    ],
    [
      'a stale',
      (sequences: number[]) => [[sequences[0]!], [sequences[1]!], [sequences[0]!]],
      'stale-acknowledgement',
    ],
  ])('closes on %s acknowledgement', (_name, plan, reason) => {
    const { client, sequences } = withOperations(2);
    const results = plan(sequences).map(([operationSequence], index) =>
      client.receive(ack(operationSequence!, index + 1)),
    );
    expect(failureOf(results.at(-1)!)).toEqual({ code: 'malformed-frame', reason });
    expect(client.phase).toBe('closed');
  });

  test('a rejected acknowledgement leaves the operation unresolved', () => {
    const { client, sequences } = withOperations(1);
    expect(client.receive(ack(99, 1)).ok).toBe(false);
    expect(client.phase).toBe('closed');
    expect(sequences).toHaveLength(1);
  });

  test('fails an operation before queueing, and revokes authority when a submitted one fails', () => {
    const { client, sequences } = withOperations(2);
    const failure = (operationSequence: number, code: string, sequence: number) =>
      serverFrame(
        { kind: 'operation-failure', operationSequence, code, message: 'm' },
        { sequence },
      );
    expect(failureOf(client.receive(failure(sequences[1]!, 'fifo-full', 1)))).toEqual({
      code: 'malformed-frame',
      reason: 'out-of-order-acknowledgement',
    });
  });

  test('resolves a pre-queue failure in order and then accepts the next acknowledgement', () => {
    const { client, sequences } = withOperations(2);
    const failure = serverFrame(
      {
        kind: 'operation-failure',
        operationSequence: sequences[0],
        code: 'read-only',
        message: 'm',
      },
      { sequence: 1 },
    );
    expectOk(client.receive(failure));
    expectOk(client.receive(ack(sequences[1]!, 2)));
    expect(client.authorityRevoked).toBe(false);
    const backend = serverFrame(
      {
        kind: 'operation-failure',
        operationSequence: sequences[1],
        code: 'backend-failed',
        message: 'm',
      },
      { sequence: 3 },
    );
    expectOk(client.receive(backend));
    expect(client.authorityRevoked).toBe(true);
    expect(failureOf(client.input('more'))).toEqual({
      code: 'read-only',
      reason: 'authority-revoked',
    });
  });

  test.each(['read-only', 'fifo-full'])(
    'rejects a later submitted-operation failure naming an operation refused with %s',
    (refusal) => {
      for (const later of ['backend-failed', 'transport-failed']) {
        const { client, sequences } = withOperations(2);
        const failure = (code: string, sequence: number) =>
          serverFrame(
            { kind: 'operation-failure', operationSequence: sequences[0], code, message: 'm' },
            { sequence },
          );
        expectOk(client.receive(failure(refusal, 1)));
        expect(failureOf(client.receive(failure(later, 2)))).toEqual({
          code: 'malformed-frame',
          reason: 'unknown-operation',
        });
        expect(client.phase).toBe('closed');
      }
    },
  );

  test('surfaces a stale-generation failure without touching the operation ledger or authority', () => {
    const { client, sequences } = withOperations(1);
    const stale = serverFrame(
      { kind: 'operation-failure', operationSequence: 50, code: 'stale-generation', message: 'm' },
      { sequence: 1 },
    );
    expect(expectOk(client.receive(stale))).toMatchObject({ code: 'stale-generation' });
    expect(client.authorityRevoked).toBe(false);
    expect(client.phase).toBe('attached');
    expectOk(client.receive(ack(sequences[0]!, 2)));
  });

  test('closes on a failure after acceptance that names a sequence which was not an operation', () => {
    const client = attached();
    const first = expectOk(client.input('a'));
    expectOk(client.receive(output(1)));
    const consumed = expectOk(client.consumeOutput(1));
    expectOk(client.input('b'));
    expect([first.sequence, consumed.sequence]).toEqual([1, 2]);
    const failure = serverFrame(
      {
        kind: 'operation-failure',
        operationSequence: consumed.sequence,
        code: 'backend-failed',
        message: 'm',
      },
      { sequence: 2 },
    );
    expect(failureOf(client.receive(failure))).toEqual({
      code: 'malformed-frame',
      reason: 'unknown-operation',
    });
    expect(client.phase).toBe('closed');
    expect(client.authorityRevoked).toBe(true);
  });

  test('closes on a failure after acceptance that names an operation never submitted', () => {
    const { client } = withOperations(1);
    const failure = serverFrame(
      { kind: 'operation-failure', operationSequence: 50, code: 'transport-failed', message: 'm' },
      { sequence: 1 },
    );
    expect(failureOf(client.receive(failure))).toEqual({
      code: 'malformed-frame',
      reason: 'future-acknowledgement',
    });
  });
});

describe('frames the client sends', () => {
  test('refuses to send before the handshake completes or after it has closed', () => {
    const client = newClient();
    expect(failureOf(client.input('x'))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
    expect(failureOf(client.resize(80, 24))).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
    expect(failureOf(client.consumeOutput(1))).toEqual({
      code: 'malformed-frame',
      reason: 'over-counted-acknowledgement',
    });
    expect(failureOf(client.terminate())).toEqual({
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
  });

  test('numbers input, resize, consumed-output and terminate in one sequence', () => {
    const client = attached();
    expectOk(client.receive(output(1, 1, 5)));
    const sent = [
      expectOk(client.input('a')),
      expectOk(client.resize(80, 24)),
      expectOk(client.consumeOutput(5)),
      expectOk(client.terminate()),
    ];
    expect(sent.map((frame) => frame.sequence)).toEqual([1, 2, 3, 4]);
    expect(typeof sent[0]!.frame).toBe('object');
    expect(typeof sent[1]!.frame).toBe('string');
  });

  test('encodes a string as UTF-8 and counts its bytes, not its UTF-16 length', () => {
    const client = attached();
    const sent = expectOk(client.input('é\u{1f600}'));
    const decoded = expectOk(decodeFrame(sent.frame, 'host'));
    expect(decoded.kind === 'input' && [...decoded.payload]).toEqual([
      0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80,
    ]);
    expect(failureOf(client.input('é'.repeat(40_000)))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
  });

  test('copies input when it is accepted', () => {
    const client = attached();
    const producer = Uint8Array.of(1, 2, 3);
    const sent = expectOk(client.input(producer));
    producer.fill(0);
    const decoded = expectOk(decodeFrame(sent.frame, 'host'));
    expect(decoded.kind === 'input' && [...decoded.payload]).toEqual([1, 2, 3]);
  });

  test('refuses what a read-only attachment, a pipe or an output-only source would refuse', () => {
    const readOnly = attached({ capabilities: READ_ONLY_CAPABILITIES });
    expect(failureOf(readOnly.input('x'))).toEqual({
      code: 'read-only',
      reason: 'operation-not-permitted',
    });
    expect(failureOf(readOnly.resize(80, 24))).toEqual({
      code: 'read-only',
      reason: 'operation-not-permitted',
    });
    const pipe = attached({ capabilities: PIPE_CAPABILITIES });
    expect(pipe.input('x').ok).toBe(true);
    expect(failureOf(pipe.resize(80, 24))).toEqual({
      code: 'read-only',
      reason: 'operation-not-permitted',
    });
    const source = attached({ capabilities: OUTPUT_ONLY_CAPABILITIES });
    expect(failureOf(source.input('x'))).toEqual({
      code: 'read-only',
      reason: 'operation-not-permitted',
    });
  });

  test('refuses an invalid dimension before sending and leaves its sequence free', () => {
    const client = attached();
    expect(failureOf(client.resize(0, 24))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-dimension',
    });
    expect(failureOf(client.resize(80, 70_000))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-dimension',
    });
    expect(expectOk(client.resize(80, 24)).sequence).toBe(1);
  });

  test('refuses more unresolved operations than the host FIFO holds, with fifo-full', () => {
    const client = attached({ maxQueuedOperations: 2 });
    expectOk(client.input('a'));
    expectOk(client.input('b'));
    expect(failureOf(client.input('c'))).toEqual({
      code: 'fifo-full',
      reason: 'operation-window-full',
    });
    expect(failureOf(client.resize(80, 24))).toEqual({
      code: 'fifo-full',
      reason: 'operation-window-full',
    });
    expectOk(
      client.receive(serverFrame({ kind: 'operation-ack', operationSequence: 1 }, { sequence: 1 })),
    );
    expect(client.input('c').ok).toBe(true);
  });

  test('revokes its own authority when it asks to stop, and keeps acknowledging output', () => {
    const client = attached();
    expectOk(client.receive(output(1, 1, 4)));
    expectOk(client.terminate());
    expect(client.authorityRevoked).toBe(true);
    expect(failureOf(client.input('x'))).toEqual({
      code: 'read-only',
      reason: 'authority-revoked',
    });
    expect(failureOf(client.resize(80, 24))).toEqual({
      code: 'read-only',
      reason: 'authority-revoked',
    });
    expect(client.consumeOutput(4).ok).toBe(true);
    expect(client.terminate().ok).toBe(true);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses to acknowledge %j bytes',
    (count) => {
      const client = attached();
      expectOk(client.receive(output(1, 1, 4)));
      expect(failureOf(client.consumeOutput(count))).toEqual({
        code: 'malformed-frame',
        reason: 'invalid-count',
      });
    },
  );

  test('never acknowledges more output than it received', () => {
    const client = attached();
    expectOk(client.receive(output(1, 1, 4)));
    expect(failureOf(client.consumeOutput(5))).toEqual({
      code: 'malformed-frame',
      reason: 'over-counted-acknowledgement',
    });
    expect(client.outputBytes).toEqual({ received: 4, consumed: 0 });
    expectOk(client.consumeOutput(3));
    expect(failureOf(client.consumeOutput(2))).toEqual({
      code: 'malformed-frame',
      reason: 'over-counted-acknowledgement',
    });
    expectOk(client.consumeOutput(1));
    expect(client.outputBytes).toEqual({ received: 4, consumed: 4 });
  });

  test('refuses to number an outgoing frame past the largest sequence', () => {
    const client = newClient(
      {},
      { inbound: new SequenceCursor(), outbound: new SequenceCursor(MAXIMUM_SEQUENCE) },
    );
    expectOk(client.hello());
    expectOk(client.receive(capabilitiesFrame()));
    expect(failureOf(client.input('x'))).toEqual({
      code: 'transport-failed',
      reason: 'sequence-overflow',
    });
    expect(failureOf(client.terminate())).toEqual({
      code: 'transport-failed',
      reason: 'sequence-overflow',
    });
  });

  test('never repeats the token in a failure', () => {
    const client = attached();
    expect(JSON.stringify(client.receive('{"version":2}'))).not.toContain(TOKEN);
  });
});

test('a connected pair shares the same view of the attachment', () => {
  const { host, client, generation } = connect({ generation: 12 });
  expect(client.terms?.generation).toBe(generation);
  expect(host.terms?.generation).toBe(generation);
});
