import { describe, expect, test } from 'bun:test';

import { reject } from '../protocol/protocol-failure.ts';
import {
  SESSION_IDENTIFIER,
  connect,
  forgeText,
  startHarness,
  type Harness,
} from './websocket.test-support.ts';

const PING_INTERVAL_MILLISECONDS = 10_000;

async function withHarness(body: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = startHarness();
  try {
    await body(harness);
  } finally {
    await harness.stop();
  }
}

describe('the harness waiters', () => {
  test('closesHandled(n) stays pending until the nth socket close has been handled', async () => {
    await withHarness(async (harness) => {
      let resolved = false;
      const both = harness.closesHandled(2).then(() => {
        resolved = true;
      });
      const first = connect(harness);
      await first.opened;
      first.socket.close(1000);
      await harness.closesHandled(1);
      // The second close has not happened, so the waiter for two was kept, not resolved.
      expect(resolved).toBe(false);
      const second = connect(harness);
      await second.opened;
      second.socket.close(1000);
      await both;
      expect(resolved).toBe(true);
      expect(harness.closeCodes).toEqual([1000, 1000]);
    });
  });

  test('pongsReceived(n) stays pending until the nth pong has reached the server', async () => {
    await withHarness(async (harness) => {
      const client = connect(harness);
      await client.handshake();
      let resolved = false;
      const both = harness.pongsReceived(2).then(() => {
        resolved = true;
      });
      harness.clock.advance(PING_INTERVAL_MILLISECONDS);
      await harness.pongsReceived(1);
      expect(resolved).toBe(false);
      harness.clock.advance(PING_INTERVAL_MILLISECONDS);
      await both;
      expect(resolved).toBe(true);
    });
  });
});

describe('the test client', () => {
  test('refuses to send a frame the endpoint could not build, and says why', async () => {
    await withHarness(async (harness) => {
      const client = connect(harness);
      await client.opened;
      expect(() => client.sendResult(reject('malformed-frame', 'invalid-field'))).toThrow(
        'the endpoint refused to build the frame: invalid-field',
      );
      client.socket.close(1000);
      await client.closed;
    });
  });
});

describe('forgeText', () => {
  test('patches a control frame the real encoder built, and removes a field patched to undefined', () => {
    const forged = forgeText(
      { kind: 'terminate', sessionId: SESSION_IDENTIFIER, attachmentGeneration: 1, sequence: 1 },
      { sequence: undefined, extra: true },
    );
    const parsed = JSON.parse(forged) as Record<string, unknown>;
    expect(parsed['kind']).toBe('terminate');
    expect(parsed['extra']).toBe(true);
    expect('sequence' in parsed).toBe(false);
  });

  test('refuses a message that encodes as a binary frame', () => {
    expect(() =>
      forgeText({
        kind: 'input',
        sessionId: SESSION_IDENTIFIER,
        attachmentGeneration: 1,
        sequence: 1,
        payload: new Uint8Array([0x78]),
      }),
    ).toThrow('the message does not encode as a control frame');
  });

  test('refuses a message the encoder rejects', () => {
    expect(() =>
      forgeText({
        kind: 'terminate',
        sessionId: 'not a session identifier',
        attachmentGeneration: 1,
        sequence: 1,
      }),
    ).toThrow('the message does not encode as a control frame');
  });
});
