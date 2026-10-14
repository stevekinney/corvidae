import { describe, expect, test } from 'bun:test';

import { encodeFrame } from './frame-codec.ts';
import type { ProtocolMessage } from './messages.ts';

import {
  FRAME_PAYLOAD_BYTES_RANGE,
  isValidSequence,
  MAXIMUM_FRAME_PAYLOAD_BYTES,
  MAXIMUM_QUEUED_OPERATIONS,
  MAXIMUM_SEQUENCE,
  MESSAGE_KIND_DIRECTIONS,
  MINIMUM_FRAME_PAYLOAD_BYTES,
  PROTOCOL_VERSION,
} from './protocol-constants.ts';

describe('protocol constants', () => {
  test('match the version 1 wire schema', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(MAXIMUM_FRAME_PAYLOAD_BYTES).toBe(65_536);
    expect(MAXIMUM_QUEUED_OPERATIONS).toBe(256);
    expect(MAXIMUM_SEQUENCE).toBe(2 ** 53 - 1);
  });

  test('name the twelve message kinds and the side that sends each', () => {
    expect(Object.keys(MESSAGE_KIND_DIRECTIONS).toSorted()).toEqual(
      [
        'attachment-error',
        'capabilities',
        'cleanup-result',
        'hello',
        'input',
        'operation-ack',
        'operation-failure',
        'output',
        'output-consumed',
        'process-exit',
        'resize',
        'terminate',
      ].toSorted(),
    );
    const clientToServer = Object.entries(MESSAGE_KIND_DIRECTIONS)
      .filter(([, direction]) => direction === 'client-to-server')
      .map(([kind]) => kind);
    expect(clientToServer.toSorted()).toEqual(
      ['hello', 'input', 'output-consumed', 'resize', 'terminate'].toSorted(),
    );
  });
});

describe('isValidSequence', () => {
  test.each([0, 1, 2 ** 32, MAXIMUM_SEQUENCE])('accepts %d', (value) => {
    expect(isValidSequence(value)).toBe(true);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAXIMUM_SEQUENCE + 1])(
    'rejects %d',
    (value) => {
      expect(isValidSequence(value)).toBe(false);
    },
  );
});

describe('the minimum frame budget', () => {
  const header = {
    sessionId: '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10',
    attachmentGeneration: Number.MAX_SAFE_INTEGER,
    sequence: Number.MAX_SAFE_INTEGER,
  };
  const maxed = Number.MAX_SAFE_INTEGER;
  /** Every JSON control message that follows the handshake, with maximal numeric fields and no text. */
  const CONTROL_MESSAGES = [
    { kind: 'resize', columns: 65_535, rows: 65_535 },
    { kind: 'operation-ack', operationSequence: maxed },
    { kind: 'operation-failure', operationSequence: maxed, code: 'stale-generation', message: '' },
    { kind: 'operation-failure', operationSequence: maxed, code: 'transport-failed', message: '' },
    { kind: 'operation-failure', operationSequence: maxed, code: 'backend-failed', message: '' },
    { kind: 'operation-failure', operationSequence: maxed, code: 'read-only', message: '' },
    { kind: 'operation-failure', operationSequence: maxed, code: 'fifo-full', message: '' },
    { kind: 'output-consumed', consumedBytes: maxed },
    { kind: 'process-exit', exitCode: Number.MIN_SAFE_INTEGER, signal: null },
    { kind: 'attachment-error', code: 'unsupported-runtime', message: '' },
    { kind: 'attachment-error', code: 'spawn-failed', message: '' },
    { kind: 'attachment-error', code: 'backend-failed', message: '' },
    { kind: 'attachment-error', code: 'transport-failed', message: '' },
    { kind: 'terminate' },
    { kind: 'cleanup-result', outcome: 'incomplete' },
  ] as const;

  const sizeOf = (message: object, maxFrameBytes?: number): number | undefined => {
    const encoded = encodeFrame(
      { ...header, ...message } as unknown as ProtocolMessage,
      maxFrameBytes === undefined ? undefined : { maxFrameBytes },
    );
    return encoded.ok ? (encoded.value as string).length : undefined;
  };

  test('encodes every control message kind', () => {
    for (const message of CONTROL_MESSAGES) {
      expect(sizeOf(message, MINIMUM_FRAME_PAYLOAD_BYTES)).toBeDefined();
    }
  });

  test('is exactly the largest control message, so no slack hides growth', () => {
    const largest = Math.max(...CONTROL_MESSAGES.map((message) => sizeOf(message)!));
    expect(MINIMUM_FRAME_PAYLOAD_BYTES).toBe(largest);
    expect(FRAME_PAYLOAD_BYTES_RANGE.minimum as number).toBe(largest);
    expect(sizeOf(CONTROL_MESSAGES[2], largest - 1)).toBeUndefined();
  });
});
