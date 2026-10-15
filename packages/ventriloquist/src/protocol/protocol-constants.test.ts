import { describe, expect, test } from 'bun:test';

import {
  isValidSequence,
  MAXIMUM_FRAME_PAYLOAD_BYTES,
  MAXIMUM_QUEUED_OPERATIONS,
  MAXIMUM_SEQUENCE,
  MESSAGE_KIND_DIRECTIONS,
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
