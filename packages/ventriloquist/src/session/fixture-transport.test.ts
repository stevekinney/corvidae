import { describe, expect, test } from 'bun:test';

import { createFixtureTransport } from './fixtures/fixture-transport.ts';
import { createHarness, flush } from './session.test-support.ts';

describe('the fixture transport frame notification', () => {
  test('reports each frame the host puts on the wire, before the client has been given it', async () => {
    const harness = createHarness();
    const seen: number[] = [];
    // The callback runs while the frame is still waiting in the outbox, so its length is the proof.
    const transport = createFixtureTransport({
      session: harness.session,
      onFrame: () => seen.push(transport.outbox.length),
    });
    void harness.session.start();
    transport.connect();
    await flush();
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[0]).toBe(1);
    expect(transport.received.map((message) => message.kind)).toEqual(['capabilities']);
  });

  test('is optional: a transport built without it still delivers frames', async () => {
    const harness = createHarness();
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    await flush();
    expect(transport.received.map((message) => message.kind)).toEqual(['capabilities']);
  });
});
