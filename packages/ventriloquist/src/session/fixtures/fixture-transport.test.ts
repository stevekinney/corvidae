import { describe, expect, test } from 'bun:test';

import { createHarness, flush } from '../session.test-support.ts';
import { createFixtureTransport } from './fixture-transport.ts';

describe('the fixture transport pump', () => {
  test('gives the client every frame the host sent, in order, and empties the outbox', async () => {
    const harness = createHarness();
    const transport = createFixtureTransport({ session: harness.session });
    void harness.session.start();
    await flush();
    transport.connect();
    expect(transport.received.map((message) => message.kind)).toEqual(['capabilities']);
    expect(transport.failures).toEqual([]);
    expect(transport.outbox).toEqual([]);
  });

  test('records what the client refused to decode and delivers only what it accepted', async () => {
    const harness = createHarness();
    const transport = createFixtureTransport({ session: harness.session });
    void harness.session.start();
    await flush();
    transport.connect();
    const accepted = transport.received.length;
    transport.outbox.push('this is not a control frame');
    const delivered = transport.pump();
    expect(delivered).toEqual([]);
    expect(transport.received).toHaveLength(accepted);
    expect(transport.failures.map((failure) => failure.reason)).toEqual(['invalid-json']);
    expect(transport.outbox).toEqual([]);
  });
});
