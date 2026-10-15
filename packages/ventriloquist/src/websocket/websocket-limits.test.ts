import { describe, expect, test } from 'bun:test';

import { BINARY_FRAME_HEADER_BYTES } from '../protocol/protocol-constants.ts';
import { WEBSOCKET_LIMIT_RANGES, resolveWebSocketLimits } from './websocket-limits.ts';

describe('resolveWebSocketLimits', () => {
  test('defaults to the documented budgets and sizes the socket from the frame budget', () => {
    const resolved = resolveWebSocketLimits();
    expect(resolved.endpoint).toEqual({ maxFrameBytes: 65_536, maxQueuedOperations: 256 });
    expect(resolved.maxPayloadLength).toBe(BINARY_FRAME_HEADER_BYTES + 65_536);
    expect(resolved.maximumBufferedBytes).toBe(1024 * 1024);
    expect(resolved.handshakeDeadlineMilliseconds).toBe(10_000);
    expect(resolved.pingIntervalMilliseconds).toBe(10_000);
    expect(resolved.maximumConnections).toBe(64);
    expect(resolved.budgets.livenessDeadlineMilliseconds).toBe(30_000);
  });

  test('a smaller frame budget shrinks what the socket accepts', () => {
    expect(resolveWebSocketLimits({ maxFrameBytes: 1_000 }).maxPayloadLength).toBe(
      BINARY_FRAME_HEADER_BYTES + 1_000,
    );
  });

  test('applies session budget overrides', () => {
    expect(
      resolveWebSocketLimits({}, { livenessDeadlineMilliseconds: 5_000 }).budgets
        .livenessDeadlineMilliseconds,
    ).toBe(5_000);
  });

  test.each(Object.entries(WEBSOCKET_LIMIT_RANGES))(
    'refuses %s below its minimum, above its maximum and fractional',
    (name, range) => {
      for (const value of [range.minimum - 1, range.maximum + 1, range.minimum + 0.5]) {
        expect(() => resolveWebSocketLimits({ [name]: value })).toThrow(RangeError);
      }
      expect(() => resolveWebSocketLimits({ [name]: range.minimum })).not.toThrow();
      expect(() => resolveWebSocketLimits({ [name]: range.maximum })).not.toThrow();
    },
  );

  test('refuses an operation window shallower than the session FIFO', () => {
    expect(() => resolveWebSocketLimits({ maxQueuedOperations: 10 })).toThrow(
      /must cover the session's operation FIFO/,
    );
    expect(
      resolveWebSocketLimits({ maxQueuedOperations: 10 }, { operationQueueLimit: 10 }).endpoint
        .maxQueuedOperations,
    ).toBe(10);
  });

  test('refuses a frame budget outside the protocol range', () => {
    expect(() => resolveWebSocketLimits({ maxFrameBytes: 10 })).toThrow(RangeError);
    expect(() => resolveWebSocketLimits({ maxFrameBytes: 1024 * 1024 })).toThrow(RangeError);
  });
});
