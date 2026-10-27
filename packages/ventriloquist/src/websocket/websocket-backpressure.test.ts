import { describe, expect, test } from 'bun:test';

import { connect, startHarness, type Harness, type TestClient } from './websocket.test-support.ts';

async function withClient(
  options: Parameters<typeof startHarness>[0],
  body: (harness: Harness, client: TestClient) => Promise<void>,
): Promise<void> {
  const harness = startHarness(options);
  try {
    const client = connect(harness);
    await client.handshake();
    await body(harness, client);
  } finally {
    await harness.stop();
  }
}

/** Send one input and wait until the host has answered it, so the next one finds a settled window. */
async function inputAnswered(client: TestClient, text: string): Promise<void> {
  const from = client.messages.length;
  client.sendResult(client.endpoint.input(text));
  await client.waitFor(
    (message) => message.kind === 'operation-ack' || message.kind === 'operation-failure',
    from,
  );
}

describe('the host operation FIFO', () => {
  const small = { server: { budgets: { operationQueueLimit: 2 } } } as const;

  test('a full FIFO refuses the next input with fifo-full and leaves the attachment and the queue alone', async () => {
    await withClient(small, async (harness, client) => {
      harness.process.stallWrites();
      // One write is in flight and two wait, which is every slot there is.
      for (const text of ['a', 'b', 'c']) await inputAnswered(client, text);
      expect(client.kinds().filter((kind) => kind === 'operation-ack')).toHaveLength(3);
      client.sendResult(client.endpoint.input('d'));
      const refused = await client.waitForKind('operation-failure');
      expect(refused).toMatchObject({ code: 'fifo-full', operationSequence: 4 });
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect(harness.session().snapshot.closed).toBe(false);
      // The refused input was not queued, so only the first write has run.
      expect(harness.process.written.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
        'a',
      ]);
    });
  });

  test('capacity returns as the backend settles writes: a later input is accepted and arrives after the queued ones', async () => {
    await withClient(small, async (harness, client) => {
      harness.process.stallWrites();
      for (const text of ['a', 'b', 'c']) await inputAnswered(client, text);
      await inputAnswered(client, 'refused');
      harness.process.releaseWrites();
      await harness.process.writes(3);
      await inputAnswered(client, 'e');
      await harness.process.writes(4);
      expect(harness.process.written.map((bytes) => new TextDecoder().decode(bytes))).toEqual([
        'a',
        'b',
        'c',
        'e',
      ]);
    });
  });

  test('the host sends no message when capacity returns, so the client learns only by trying', async () => {
    await withClient(small, async (harness, client) => {
      harness.process.stallWrites();
      for (const text of ['a', 'b', 'c']) await inputAnswered(client, text);
      await inputAnswered(client, 'refused');
      const before = client.frames.length;
      harness.process.releaseWrites();
      await harness.process.writes(3);
      // load-proof: a negative window: the assertion that follows is that no further frame was sent, and load can delay a frame but never create one
      await Bun.sleep(0);
      expect(client.frames.length).toBe(before);
    });
  });

  test('unsettled input bytes are bounded too: input past the byte budget is fifo-full, not buffered', async () => {
    await withClient({}, async (harness, client) => {
      harness.process.stallWrites();
      await inputAnswered(client, 'x'.repeat(64 * 1024));
      client.sendResult(client.endpoint.input('y'));
      const awaited62 = await client.waitForKind('operation-failure');
      expect(awaited62.code).toBe('fifo-full');
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });
  });
});

describe('the client operation window', () => {
  const window = {
    server: { limits: { maxQueuedOperations: 4 }, budgets: { operationQueueLimit: 4 } },
  } as const;

  test('the endpoint refuses locally once the unacknowledged window is full, and nothing is sent', async () => {
    await withClient(window, async (harness, client) => {
      for (let count = 1; count <= 4; count += 1) client.sendResult(client.endpoint.input('k'));
      const refused = client.endpoint.input('k');
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.failure).toMatchObject({
          code: 'fifo-full',
          reason: 'operation-window-full',
        });
      }
      // Four operations were sent in one turn, so no acknowledgement can have returned yet.
      await harness.process.writes(4);
      expect(harness.process.written).toHaveLength(4);
    });
  });

  test('an acknowledgement frees a slot, and the next input is sent', async () => {
    await withClient(window, async (harness, client) => {
      for (let count = 1; count <= 4; count += 1) client.sendResult(client.endpoint.input('k'));
      expect(client.endpoint.input('k').ok).toBe(false);
      await client.waitFor(
        (message) => message.kind === 'operation-ack' && message.operationSequence === 1,
      );
      client.sendResult(client.endpoint.input('after'));
      await harness.process.writes(5);
      expect(new TextDecoder().decode(harness.process.written[4])).toBe('after');
    });
  });
});
