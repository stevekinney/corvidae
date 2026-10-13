import { describe, expect, test } from 'bun:test';

import {
  expectOk,
  OTHER_SESSION_IDENTIFIER,
  PTY_CAPABILITIES,
  SESSION_IDENTIFIER,
  TOKEN,
} from './endpoint-pair.test-support.ts';
import { decodeFrame, encodeFrame } from './frame-codec.ts';
import type { ClientMessage, ProtocolMessage, ServerMessage } from './messages.ts';
import {
  BINARY_FRAME_HEADER_BYTES,
  MAXIMUM_FRAME_PAYLOAD_BYTES,
  MAXIMUM_SEQUENCE,
} from './protocol-constants.ts';

const header = {
  sessionId: SESSION_IDENTIFIER,
  attachmentGeneration: 3,
  sequence: 7,
};

const CLIENT_MESSAGES: readonly ClientMessage[] = [
  {
    kind: 'hello',
    version: 1,
    sessionId: SESSION_IDENTIFIER,
    requestedMode: 'interactive',
    token: TOKEN,
  },
  { kind: 'input', ...header, payload: Uint8Array.of(0x6c, 0x73, 0x0d) },
  { kind: 'resize', ...header, columns: 120, rows: 40 },
  { kind: 'output-consumed', ...header, consumedBytes: 4096 },
  { kind: 'terminate', ...header },
];

const SERVER_MESSAGES: readonly ServerMessage[] = [
  {
    kind: 'capabilities',
    version: 1,
    sessionId: SESSION_IDENTIFIER,
    attachmentGeneration: 3,
    capabilities: PTY_CAPABILITIES,
    maxFrameBytes: 65_536,
    maxQueuedOperations: 256,
  },
  { kind: 'output', ...header, channel: 'pty', payload: Uint8Array.of(0, 0xff, 0x1b, 0x5b) },
  { kind: 'operation-ack', ...header, operationSequence: 5 },
  {
    kind: 'operation-failure',
    ...header,
    operationSequence: 5,
    code: 'fifo-full',
    message: 'the queue is full',
  },
  { kind: 'process-exit', ...header, exitCode: 0, signal: null },
  { kind: 'process-exit', ...header, exitCode: null, signal: 'SIGTERM' },
  {
    kind: 'attachment-error',
    ...header,
    code: 'spawn-failed',
    message: 'no such shell',
  },
  {
    kind: 'attachment-error',
    sessionId: SESSION_IDENTIFIER,
    attachmentGeneration: 0,
    sequence: 0,
    code: 'unsupported-runtime',
    message: 'windows',
  },
  { kind: 'cleanup-result', ...header, outcome: 'complete' },
];

function textOf(message: ProtocolMessage): string {
  return expectOk(encodeFrame(message)) as string;
}

function failureOf(result: { ok: boolean; failure?: { code: string; reason: string } }) {
  expect(result.ok).toBe(false);
  return { code: result.failure?.code, reason: result.failure?.reason };
}

describe('round trip', () => {
  test.each(CLIENT_MESSAGES.map((message) => [message.kind, message] as const))(
    'carries client message %s unchanged',
    (_kind, message) => {
      const frame = expectOk(encodeFrame(message));
      expect(typeof frame === 'string').toBe(message.kind !== 'input');
      expect(expectOk(decodeFrame(frame, 'host'))).toEqual(message);
    },
  );

  test.each(SERVER_MESSAGES.map((message) => [message.kind, message] as const))(
    'carries server message %s unchanged',
    (_kind, message) => {
      const frame = expectOk(encodeFrame(message));
      expect(typeof frame === 'string').toBe(message.kind !== 'output');
      expect(expectOk(decodeFrame(frame, 'client'))).toEqual(message);
    },
  );

  test('carries every output channel and the extremes of generation and sequence', () => {
    for (const channel of ['pty', 'stdout', 'stderr'] as const) {
      const message: ProtocolMessage = {
        kind: 'output',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: MAXIMUM_SEQUENCE,
        sequence: MAXIMUM_SEQUENCE,
        channel,
        payload: new Uint8Array(0),
      };
      expect(expectOk(decodeFrame(expectOk(encodeFrame(message)), 'client'))).toEqual(message);
    }
  });

  test('lays out a binary frame header in fixed big-endian fields', () => {
    const frame = expectOk(
      encodeFrame({
        kind: 'output',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: 0x0102_0304_0506,
        sequence: 9,
        channel: 'stderr',
        payload: Uint8Array.of(0xaa, 0xbb),
      }),
    ) as Uint8Array;
    expect(frame.length).toBe(BINARY_FRAME_HEADER_BYTES + 2);
    expect([...frame.subarray(0, 4)]).toEqual([1, 1, 2, 3]);
    expect(Buffer.from(frame.subarray(4, 20)).toString('hex')).toBe(
      SESSION_IDENTIFIER.replaceAll('-', ''),
    );
    expect([...frame.subarray(20, 28)]).toEqual([0, 0, 1, 2, 3, 4, 5, 6]);
    expect([...frame.subarray(28, 36)]).toEqual([0, 0, 0, 0, 0, 0, 0, 9]);
    expect([...frame.subarray(36)]).toEqual([0, 0, 0, 2, 0xaa, 0xbb]);
  });

  test('puts the version, kind and direction in every control frame', () => {
    expect(JSON.parse(textOf({ kind: 'terminate', ...header }))).toEqual({
      version: 1,
      kind: 'terminate',
      direction: 'client-to-server',
      ...header,
    });
  });

  test('reads a frame held in a view onto a larger buffer', () => {
    const frame = expectOk(encodeFrame(CLIENT_MESSAGES[1]!)) as Uint8Array;
    const backing = new Uint8Array(frame.length + 11);
    backing.set(frame, 5);
    expect(expectOk(decodeFrame(backing.subarray(5, 5 + frame.length), 'host'))).toEqual(
      CLIENT_MESSAGES[1]!,
    );
  });
});

describe('copying at the boundary', () => {
  test('a producer that mutates its buffer after encoding cannot change the frame', () => {
    const producer = Uint8Array.of(1, 2, 3, 4);
    const frame = expectOk(
      encodeFrame({ kind: 'input', ...header, payload: producer }),
    ) as Uint8Array;
    const before = frame.slice();
    producer.fill(0xff);
    expect(frame).toEqual(before);
  });

  test('a transport that reuses its buffer after decoding cannot change the message', () => {
    const wire = expectOk(
      encodeFrame({ kind: 'input', ...header, payload: Uint8Array.of(1, 2, 3, 4) }),
    ) as Uint8Array;
    const message = expectOk(decodeFrame(wire, 'host'));
    wire.fill(0xff);
    expect(message.kind === 'input' && [...message.payload]).toEqual([1, 2, 3, 4]);
  });

  test('copies exactly the bytes of a view, not the buffer behind it', () => {
    const backing = Uint8Array.of(9, 9, 1, 2, 3, 9, 9);
    const frame = expectOk(
      encodeFrame({ kind: 'input', ...header, payload: backing.subarray(2, 5) }),
    ) as Uint8Array;
    const message = expectOk(decodeFrame(frame, 'host'));
    expect(message.kind === 'input' && [...message.payload]).toEqual([1, 2, 3]);
  });
});

describe('payload bytes', () => {
  const payloads: ReadonlyArray<readonly [string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['NUL', Uint8Array.of(0, 0, 0)],
    ['invalid UTF-8', Uint8Array.of(0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xff)],
    ['a split multibyte sequence', Uint8Array.of(0xe6, 0x97)],
    ['a split escape sequence', Uint8Array.of(0x1b, 0x5b, 0x33)],
    ['a binary mouse report', Uint8Array.of(0x1b, 0x5b, 0x4d, 0x20, 0xe0, 0xf0)],
    ['every byte value', Uint8Array.from({ length: 256 }, (_, value) => value)],
  ];

  test.each(payloads)('survives %s exactly', (_name, payload) => {
    const output = expectOk(
      decodeFrame(
        expectOk(encodeFrame({ kind: 'output', ...header, channel: 'pty', payload })),
        'client',
      ),
    );
    const input = expectOk(
      decodeFrame(expectOk(encodeFrame({ kind: 'input', ...header, payload })), 'host'),
    );
    expect(output.kind === 'output' && output.payload).toEqual(payload);
    expect(input.kind === 'input' && input.payload).toEqual(payload);
  });

  test('accepts a payload of exactly the maximum and rejects one byte more', () => {
    const exact = new Uint8Array(MAXIMUM_FRAME_PAYLOAD_BYTES);
    expect(encodeFrame({ kind: 'input', ...header, payload: exact }).ok).toBe(true);
    expect(
      failureOf(
        encodeFrame({ kind: 'input', ...header, payload: new Uint8Array(exact.length + 1) }),
      ),
    ).toEqual({ code: 'frame-too-large', reason: 'oversized' });
  });

  test('honours a smaller advertised limit on both sides', () => {
    const limits = { maxFrameBytes: 8 };
    const message: ProtocolMessage = { kind: 'input', ...header, payload: new Uint8Array(8) };
    const frame = expectOk(encodeFrame(message, limits));
    expect(decodeFrame(frame, 'host', limits).ok).toBe(true);
    expect(failureOf(decodeFrame(frame, 'host', { maxFrameBytes: 7 }))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
    expect(
      failureOf(encodeFrame({ kind: 'input', ...header, payload: new Uint8Array(9) }, limits)),
    ).toEqual({ code: 'frame-too-large', reason: 'oversized' });
  });
});

describe('size of control frames is counted in UTF-8 bytes', () => {
  const terminate = textOf({ kind: 'terminate', ...header });
  const exactBytes = new TextEncoder().encode(terminate).length;

  test('accepts a frame of exactly the limit and rejects one byte under it', () => {
    expect(decodeFrame(terminate, 'host', { maxFrameBytes: exactBytes }).ok).toBe(true);
    expect(failureOf(decodeFrame(terminate, 'host', { maxFrameBytes: exactBytes - 1 }))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
    expect(
      failureOf(encodeFrame({ kind: 'terminate', ...header }, { maxFrameBytes: exactBytes - 1 })),
    ).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
  });

  test('rejects text whose UTF-16 length is under the limit but whose UTF-8 length is over it', () => {
    const wide = JSON.stringify({ padding: 'é'.repeat(MAXIMUM_FRAME_PAYLOAD_BYTES / 2 + 1) });
    expect(wide.length).toBeLessThan(MAXIMUM_FRAME_PAYLOAD_BYTES + 100);
    expect(new TextEncoder().encode(wide).length).toBeGreaterThan(MAXIMUM_FRAME_PAYLOAD_BYTES);
    expect(failureOf(decodeFrame(wide, 'host'))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
  });

  test('rejects text longer than the limit without needing to measure it', () => {
    expect(failureOf(decodeFrame('x'.repeat(MAXIMUM_FRAME_PAYLOAD_BYTES + 1), 'host'))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
  });
});

describe('rejecting control frames', () => {
  const valid = JSON.parse(textOf({ kind: 'terminate', ...header })) as Record<string, unknown>;

  function decodeWith(changes: Record<string, unknown>, remove: readonly string[] = []) {
    const record: Record<string, unknown> = { ...valid, ...changes };
    for (const name of remove) delete record[name];
    return failureOf(decodeFrame(JSON.stringify(record), 'host'));
  }

  test.each([
    ['not JSON', 'terminate', 'invalid-json'],
    ['a truncated object', '{"version":1,"kind":"term', 'invalid-json'],
    ['an array', '[]', 'not-an-object'],
    ['null', 'null', 'not-an-object'],
    ['a number', '5', 'not-an-object'],
  ])('rejects %s', (_name, text, reason) => {
    expect(failureOf(decodeFrame(text, 'host'))).toEqual({ code: 'malformed-frame', reason });
  });

  test('fails closed on an unknown or missing version', () => {
    expect(decodeWith({ version: 2 })).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
    expect(decodeWith({ version: '1' })).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
    expect(decodeWith({}, ['version'])).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
  });

  test('rejects an unknown kind, a binary kind sent as text, and a direction that disagrees with the kind', () => {
    expect(decodeWith({ kind: 'launch' })).toEqual({
      code: 'malformed-frame',
      reason: 'unknown-kind',
    });
    expect(decodeWith({ kind: 'toString' })).toEqual({
      code: 'malformed-frame',
      reason: 'unknown-kind',
    });
    expect(decodeWith({ kind: 'input' })).toEqual({
      code: 'malformed-frame',
      reason: 'binary-kind-in-text',
    });
    expect(decodeWith({ kind: 'output' })).toEqual({
      code: 'malformed-frame',
      reason: 'binary-kind-in-text',
    });
    expect(decodeWith({ direction: 'server-to-client' })).toEqual({
      code: 'malformed-frame',
      reason: 'direction-mismatch',
    });
    expect(decodeWith({}, ['direction'])).toEqual({
      code: 'malformed-frame',
      reason: 'direction-mismatch',
    });
  });

  test('rejects a message that travels the wrong way', () => {
    for (const message of SERVER_MESSAGES.filter((candidate) => candidate.kind !== 'output')) {
      expect(failureOf(decodeFrame(textOf(message), 'host'))).toEqual({
        code: 'malformed-frame',
        reason: 'wrong-direction',
      });
    }
    for (const message of CLIENT_MESSAGES.filter((candidate) => candidate.kind !== 'input')) {
      expect(failureOf(decodeFrame(textOf(message), 'client'))).toEqual({
        code: 'malformed-frame',
        reason: 'wrong-direction',
      });
    }
  });

  test('rejects an extra field, a missing field and a prototype-polluting key', () => {
    expect(decodeWith({ extra: true })).toEqual({
      code: 'malformed-frame',
      reason: 'unknown-field',
    });
    expect(
      decodeFrame(JSON.stringify(valid).replace('{', '{"__proto__":{},'), 'host'),
    ).toMatchObject({
      ok: false,
      failure: { reason: 'unknown-field' },
    });
    expect(decodeWith({}, ['sequence'])).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-sequence',
    });
    expect(decodeWith({}, ['sessionId'])).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-session-identifier',
    });
  });

  test.each([
    [
      'sessionId',
      'invalid-session-identifier',
      [OTHER_SESSION_IDENTIFIER.toUpperCase(), 'not-a-uuid', 7, null, ''],
    ],
    ['attachmentGeneration', 'invalid-generation', [0, -1, 1.5, '1', null, MAXIMUM_SEQUENCE + 1]],
    ['sequence', 'invalid-sequence', [0, -1, 1.5, '1', null, MAXIMUM_SEQUENCE + 1]],
  ])('rejects an invalid %s', (name, reason, values) => {
    for (const value of values) {
      expect(decodeWith({ [name]: value })).toEqual({ code: 'malformed-frame', reason });
    }
  });
});

describe('rejecting message fields', () => {
  function decodeServer(message: Record<string, unknown>) {
    return failureOf(
      decodeFrame(
        JSON.stringify({ version: 1, direction: 'server-to-client', ...message }),
        'client',
      ),
    );
  }

  function decodeClient(message: Record<string, unknown>) {
    return failureOf(
      decodeFrame(
        JSON.stringify({ version: 1, direction: 'client-to-server', ...message }),
        'host',
      ),
    );
  }

  test.each([0, -1, 65_536, 1.5, '80', null, true])('rejects the dimension %j', (value) => {
    const base = { kind: 'resize', ...header, columns: 80, rows: 24 };
    expect(decodeClient({ ...base, columns: value })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-dimension',
    });
    expect(decodeClient({ ...base, rows: value })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-dimension',
    });
  });

  test('accepts the smallest and largest dimensions', () => {
    const base = { kind: 'resize', ...header };
    for (const value of [1, 65_535]) {
      expect(
        decodeFrame(
          JSON.stringify({
            version: 1,
            direction: 'client-to-server',
            ...base,
            columns: value,
            rows: value,
          }),
          'host',
        ).ok,
      ).toBe(true);
    }
  });

  test('rejects a bad hello', () => {
    const hello = {
      kind: 'hello',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      requestedMode: 'interactive',
      token: TOKEN,
    };
    expect(decodeClient({ ...hello, requestedMode: 'admin' })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeClient({ ...hello, token: '' })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeClient({ ...hello, token: 5 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
  });

  test.each([
    ['a non-object', 5],
    ['a missing key', { mode: 'pty', input: true, resize: true, kill: true }],
    ['an extra key', { ...PTY_CAPABILITIES, extra: true }],
    ['an unknown mode', { ...PTY_CAPABILITIES, mode: 'serial' }],
    ['a non-boolean flag', { ...PTY_CAPABILITIES, input: 1 }],
    [
      'an output-only source that accepts input',
      { mode: 'output-only', input: true, resize: false, kill: false, readOnly: true },
    ],
    [
      'a pipe that resizes',
      { mode: 'pipe', input: true, resize: true, kill: true, readOnly: false },
    ],
    [
      'a read-only set that writes',
      { mode: 'pty', input: true, resize: false, kill: true, readOnly: true },
    ],
  ])('rejects capabilities with %s', (_name, capabilities) => {
    const message = {
      kind: 'capabilities',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      attachmentGeneration: 1,
      capabilities,
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
    };
    expect(decodeServer(message)).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-capabilities',
    });
  });

  test.each([0, 262_145, 1.5, '65536', null])('rejects the frame limit %j', (value) => {
    const message = {
      kind: 'capabilities',
      version: 1,
      sessionId: SESSION_IDENTIFIER,
      attachmentGeneration: 1,
      capabilities: PTY_CAPABILITIES,
      maxFrameBytes: value,
      maxQueuedOperations: 256,
    };
    expect(decodeServer(message)).toEqual({ code: 'malformed-frame', reason: 'invalid-limits' });
    expect(decodeServer({ ...message, maxFrameBytes: 65_536, maxQueuedOperations: value })).toEqual(
      {
        code: 'malformed-frame',
        reason: 'invalid-limits',
      },
    );
  });

  test('rejects a failure code that does not belong to the message', () => {
    const base = { kind: 'operation-failure', ...header, operationSequence: 1, message: 'm' };
    for (const code of ['stale-generation', 'unsupported-runtime', 'nope', 7]) {
      expect(decodeServer({ ...base, code })).toEqual({
        code: 'malformed-frame',
        reason: 'invalid-field',
      });
    }
    const error = { kind: 'attachment-error', ...header, message: 'm' };
    for (const code of ['read-only', 'fifo-full', 'cleanup-incomplete', 'nope']) {
      expect(decodeServer({ ...error, code })).toEqual({
        code: 'malformed-frame',
        reason: 'invalid-field',
      });
    }
  });

  test('rejects bad process exits, cleanup outcomes, counts and operation sequences', () => {
    const exit = { kind: 'process-exit', ...header, exitCode: 0, signal: null };
    expect(decodeServer({ ...exit, exitCode: 1.5 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeServer({ ...exit, exitCode: '0' })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeServer({ ...exit, signal: '' })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeServer({ ...exit, signal: 9 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeServer({ kind: 'cleanup-result', ...header, outcome: 'fine' })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
    expect(decodeServer({ kind: 'operation-ack', ...header, operationSequence: 0 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-sequence',
    });
    expect(decodeClient({ kind: 'output-consumed', ...header, consumedBytes: -1 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-count',
    });
    expect(decodeClient({ kind: 'output-consumed', ...header, consumedBytes: 1.5 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-count',
    });
  });

  test('accepts an attachment error with neither generation nor sequence, and no half of one', () => {
    const error = {
      kind: 'attachment-error',
      sessionId: SESSION_IDENTIFIER,
      code: 'unsupported-runtime',
      message: 'm',
    };
    expect(
      decodeFrame(
        JSON.stringify({
          version: 1,
          direction: 'server-to-client',
          ...error,
          attachmentGeneration: 0,
          sequence: 0,
        }),
        'client',
      ).ok,
    ).toBe(true);
    expect(decodeServer({ ...error, attachmentGeneration: 0, sequence: 1 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-sequence',
    });
    expect(decodeServer({ ...error, attachmentGeneration: 1, sequence: 0 })).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-sequence',
    });
  });
});

describe('rejecting binary frames', () => {
  const frame = expectOk(
    encodeFrame({ kind: 'output', ...header, channel: 'pty', payload: Uint8Array.of(1, 2, 3) }),
  ) as Uint8Array;

  function mutate(changes: Record<number, number>): Uint8Array {
    const copy = frame.slice();
    for (const [offset, value] of Object.entries(changes)) copy[Number(offset)] = value;
    return copy;
  }

  test('rejects every truncation of a valid frame, including an empty one', () => {
    for (let length = 0; length < frame.length; length += 1) {
      expect(failureOf(decodeFrame(frame.subarray(0, length), 'client'))).toEqual({
        code: 'malformed-frame',
        reason: 'truncated',
      });
    }
  });

  test('rejects trailing bytes', () => {
    const longer = new Uint8Array(frame.length + 1);
    longer.set(frame);
    expect(failureOf(decodeFrame(longer, 'client'))).toEqual({
      code: 'malformed-frame',
      reason: 'trailing-bytes',
    });
  });

  test('rejects a frame over the limit before reading it, and a declared length over the limit', () => {
    expect(
      failureOf(
        decodeFrame(
          new Uint8Array(BINARY_FRAME_HEADER_BYTES + MAXIMUM_FRAME_PAYLOAD_BYTES + 1),
          'client',
        ),
      ),
    ).toEqual({ code: 'frame-too-large', reason: 'oversized' });
    const declared = mutate({ 36: 0, 37: 1, 38: 0, 39: 0 }).subarray(0, BINARY_FRAME_HEADER_BYTES);
    expect(failureOf(decodeFrame(declared, 'client', { maxFrameBytes: 100 }))).toEqual({
      code: 'frame-too-large',
      reason: 'oversized',
    });
  });

  test('rejects an unknown version, kind code and direction code', () => {
    expect(failureOf(decodeFrame(mutate({ 0: 2 }), 'client'))).toEqual({
      code: 'protocol-version-unsupported',
      reason: 'wrong-version',
    });
    for (const code of [0, 3, 255]) {
      expect(failureOf(decodeFrame(mutate({ 1: code }), 'client'))).toEqual({
        code: 'malformed-frame',
        reason: 'unknown-kind',
      });
    }
    for (const code of [0, 1, 3]) {
      expect(failureOf(decodeFrame(mutate({ 2: code }), 'client'))).toEqual({
        code: 'malformed-frame',
        reason: 'direction-mismatch',
      });
    }
  });

  test('rejects output sent to the host and input sent to the client', () => {
    expect(failureOf(decodeFrame(frame, 'host'))).toEqual({
      code: 'malformed-frame',
      reason: 'wrong-direction',
    });
    const input = expectOk(encodeFrame({ kind: 'input', ...header, payload: Uint8Array.of(1) }));
    expect(failureOf(decodeFrame(input, 'client'))).toEqual({
      code: 'malformed-frame',
      reason: 'wrong-direction',
    });
  });

  test('rejects an output channel that is not one, and an input with a channel', () => {
    for (const code of [0, 4, 255]) {
      expect(failureOf(decodeFrame(mutate({ 3: code }), 'client'))).toEqual({
        code: 'malformed-frame',
        reason: 'invalid-field',
      });
    }
    const input = (
      expectOk(encodeFrame({ kind: 'input', ...header, payload: Uint8Array.of(1) })) as Uint8Array
    ).slice();
    input[3] = 1;
    expect(failureOf(decodeFrame(input, 'host'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-field',
    });
  });

  test('rejects a generation or sequence that does not fit in 53 bits, and a zero one', () => {
    expect(failureOf(decodeFrame(mutate({ 20: 0, 21: 0x20 }), 'client'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-generation',
    });
    expect(failureOf(decodeFrame(mutate({ 28: 0, 29: 0x20 }), 'client'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-sequence',
    });
    expect(failureOf(decodeFrame(mutate({ 35: 0 }), 'client'))).toEqual({
      code: 'malformed-frame',
      reason: 'invalid-sequence',
    });
  });
});

describe('encoding refuses invalid messages', () => {
  test.each([
    ['null', null],
    ['an array', []],
    ['a string', 'terminate'],
    ['an unknown kind', { kind: 'launch' }],
    ['no kind', {}],
    ['an extra field', { kind: 'terminate', ...header, extra: 1 }],
    ['a missing field', { kind: 'terminate', sessionId: SESSION_IDENTIFIER }],
    ['a payload that is not bytes', { kind: 'input', ...header, payload: 'text' }],
    ['a payload given as numbers', { kind: 'input', ...header, payload: [1, 2] }],
    [
      'an invalid channel',
      { kind: 'output', ...header, channel: 'tty', payload: new Uint8Array(0) },
    ],
    ['an invalid dimension', { kind: 'resize', ...header, columns: 0, rows: 1 }],
  ])('refuses %s', (_name, candidate) => {
    expect(encodeFrame(candidate as unknown as ProtocolMessage).ok).toBe(false);
  });

  test('refuses a sequence past the 53-bit maximum', () => {
    expect(
      failureOf(encodeFrame({ kind: 'terminate', ...header, sequence: MAXIMUM_SEQUENCE + 1 })),
    ).toEqual({ code: 'malformed-frame', reason: 'invalid-sequence' });
  });

  test('refuses a control message larger than the limit', () => {
    expect(
      failureOf(
        encodeFrame({
          kind: 'operation-failure',
          ...header,
          operationSequence: 1,
          code: 'backend-failed',
          message: 'x'.repeat(MAXIMUM_FRAME_PAYLOAD_BYTES),
        }),
      ),
    ).toEqual({ code: 'frame-too-large', reason: 'oversized' });
  });

  test('never throws on arbitrary garbage frames', () => {
    const samples: Array<Uint8Array | string> = [
      '',
      '{',
      '{"kind":"terminate"}',
      '\u0000',
      new Uint8Array(0),
      Uint8Array.of(1),
      new Uint8Array(BINARY_FRAME_HEADER_BYTES),
      new Uint8Array(BINARY_FRAME_HEADER_BYTES).fill(0xff),
    ];
    for (const sample of samples) {
      for (const receiver of ['host', 'client'] as const) {
        expect(decodeFrame(sample, receiver).ok).toBe(false);
      }
    }
  });
});
