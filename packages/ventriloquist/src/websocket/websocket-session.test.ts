import { describe, expect, test } from 'bun:test';

import {
  SESSION_IDENTIFIER,
  connect,
  forgeInput,
  forgeText,
  scriptedProcess,
  startHarness,
  type Harness,
  type TestClient,
} from './websocket.test-support.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function withClient(
  options: Parameters<typeof startHarness>[0],
  body: (harness: Harness, client: TestClient, generation: number) => Promise<void>,
): Promise<void> {
  const harness = startHarness(options);
  try {
    const client = connect(harness);
    const { attachmentGeneration } = await client.handshake();
    await body(harness, client, attachmentGeneration);
  } finally {
    await harness.stop();
  }
}

describe('input and resize', () => {
  test('input is acknowledged on acceptance and reaches the process as the exact bytes, in order', async () => {
    await withClient({}, async (harness, client) => {
      client.sendResult(client.endpoint.input('ls'));
      client.sendResult(client.endpoint.input(new Uint8Array([0x80, 0xff, 0x00, 0x03])));
      client.sendResult(client.endpoint.input('é\r'));
      await harness.process.writes(3);
      await client.waitFor(
        (message) => message.kind === 'operation-ack' && message.operationSequence === 3,
      );
      expect(harness.process.written.map((bytes) => [...bytes])).toEqual([
        [0x6c, 0x73],
        [0x80, 0xff, 0x00, 0x03],
        [0xc3, 0xa9, 0x0d],
      ]);
      expect(
        client.messages.flatMap((message) =>
          message.kind === 'operation-ack' ? [message.operationSequence] : [],
        ),
      ).toEqual([1, 2, 3]);
    });
  });

  test('a resize reaches a PTY process and shares the input sequence', async () => {
    await withClient({}, async (harness, client) => {
      client.sendResult(client.endpoint.input('a'));
      client.sendResult(client.endpoint.resize(132, 43));
      await harness.process.resizes(1);
      expect(harness.process.resized).toEqual([{ columns: 132, rows: 43 }]);
      await client.waitFor(
        (message) => message.kind === 'operation-ack' && message.operationSequence === 2,
      );
    });
  });

  test('a resize beyond the protocol limits is refused by the host, not forwarded', async () => {
    await withClient({}, async (harness, client, generation) => {
      // Control: the same frame with valid dimensions reaches the process.
      client.send(
        forgeText({
          kind: 'resize',
          sessionId: SESSION_IDENTIFIER,
          attachmentGeneration: generation,
          sequence: 1,
          columns: 80,
          rows: 24,
        }),
      );
      await harness.process.resizes(1);
      client.send(
        forgeText(
          {
            kind: 'resize',
            sessionId: SESSION_IDENTIFIER,
            attachmentGeneration: generation,
            sequence: 2,
            columns: 80,
            rows: 24,
          },
          { rows: 0 },
        ),
      );
      const awaited35 = await client.closed;
      expect(awaited35.code).toBe(1002);
      expect(harness.process.resized).toEqual([{ columns: 80, rows: 24 }]);
    });
  });

  test('a stale generation is refused as a soft failure and leaves the attachment live', async () => {
    await withClient({}, async (harness, client, generation) => {
      client.send(forgeInput(generation + 1, 1));
      await client.waitForFrames(2);
      expect(JSON.parse(client.frames[1]?.raw as string)).toMatchObject({
        kind: 'operation-failure',
        code: 'stale-generation',
      });
      expect(harness.process.written).toEqual([]);
      client.sendResult(client.endpoint.input('still here'));
      await harness.process.writes(1);
      expect(decoder.decode(harness.process.written[0])).toBe('still here');
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  test('a frame addressed to another session is refused and never reaches this one', async () => {
    await withClient({}, async (harness, client, generation) => {
      client.send(forgeInput(generation, 1, 'x', '6d9d9a52-3a1e-4f67-8f7b-0c0f2f0c5e11'));
      await client.waitForFrames(2);
      expect(JSON.parse(client.frames[1]?.raw as string)).toMatchObject({
        kind: 'operation-failure',
        code: 'stale-generation',
      });
      expect(harness.process.written).toEqual([]);
    });
  });

  test('an out-of-order sequence breaks the protocol: the generation is revoked and the process cleaned up', async () => {
    await withClient({}, async (harness, client, generation) => {
      client.send(forgeInput(generation, 5));
      const awaited36 = await client.closed;
      expect(awaited36.code).toBe(1002);
      await harness.session().closed;
      expect(harness.process.cleanups).toBe(1);
      expect(harness.process.written).toEqual([]);
    });
  });

  test('a backend that rejects a submitted write fails the operation and the attachment', async () => {
    const process = scriptedProcess();
    process.backend.write = () => Promise.reject(new Error('the pty is gone'));
    await withClient({ process }, async (harness, client) => {
      client.sendResult(client.endpoint.input('x'));
      await client.waitForKind('operation-ack');
      const failure = await client.waitForKind('operation-failure');
      expect(failure.code).toBe('backend-failed');
      const awaited37 = await client.closed;
      expect(awaited37.code).toBe(1011);
      await harness.session().closed;
      expect(harness.process.cleanups).toBe(1);
    });
  });

  test('a write the backend never settles is unknown delivery once its deadline passes, and is never retried', async () => {
    await withClient({}, async (harness, client) => {
      harness.process.stallWrites();
      client.sendResult(client.endpoint.input('x'));
      await client.waitForKind('operation-ack');
      harness.clock.advance(2_000);
      const failure = await client.waitForKind('operation-failure');
      expect(failure.code).toBe('transport-failed');
      const awaited38 = await client.closed;
      expect(awaited38.code).toBe(1011);
      expect(harness.process.written).toHaveLength(1);
    });
  });
});

describe('output', () => {
  test('arrives as binary frames in order, and a chunk larger than the frame budget is split without losing a byte', async () => {
    await withClient({ server: { limits: { maxFrameBytes: 1_000 } } }, async (harness, client) => {
      const bytes = new Uint8Array(2_500).map((_, index) => index % 251);
      harness.process.stream.push(bytes);
      await client.waitForFrames(4);
      const outputs = client.messages.filter((message) => message.kind === 'output');
      expect(outputs.map((message) => message.payload.length)).toEqual([1_000, 1_000, 500]);
      const joined = new Uint8Array(2_500);
      let offset = 0;
      for (const message of outputs) {
        joined.set(message.payload, offset);
        offset += message.payload.length;
      }
      expect([...joined]).toEqual([...bytes]);
      expect(client.frames.slice(1).every((frame) => typeof frame.raw !== 'string')).toBe(true);
    });
  });

  test('control messages are text and output is binary, in each direction', async () => {
    await withClient({}, async (harness, client) => {
      expect(typeof client.frames[0]?.raw).toBe('string');
      harness.process.stream.push(encoder.encode('x'));
      await client.waitForKind('output');
      expect(client.frames[1]?.raw).toBeInstanceOf(Uint8Array);
      client.sendResult(client.endpoint.input('a'));
      await harness.process.writes(1);
      client.sendResult(client.endpoint.resize(100, 30));
      await harness.process.resizes(1);
    });
  });

  test('consumed-output acknowledgements count UTF-8 bytes, so a multi-byte chunk frees exactly its own size', async () => {
    const text = 'héllo → 世界 😀';
    const bytes = encoder.encode(text);
    expect(bytes.length).not.toBe(text.length);
    await withClient(
      { server: { budgets: { outputQueueBytes: 64 * 1024 } } },
      async (harness, client) => {
        const session = harness.session();
        harness.process.stream.push(bytes);
        await client.waitForKind('output');
        client.sendResult(client.endpoint.consumeOutput(bytes.length));
        expect(client.endpoint.outputBytes).toEqual({
          received: bytes.length,
          consumed: bytes.length,
        });
        client.sendResult(client.endpoint.terminate());
        await session.closed;
        const awaited39 = await session.closed;
        expect(awaited39.drain).toEqual({ state: 'drained', unavailableBytes: 0 });
      },
    );
  });

  test('a count that is the string length, not the byte length, leaves output unparsed', async () => {
    const text = '世界';
    const bytes = encoder.encode(text);
    await withClient({}, async (harness, client) => {
      const session = harness.session();
      harness.process.stream.push(bytes);
      await client.waitForKind('output');
      client.sendResult(client.endpoint.consumeOutput(text.length));
      client.sendResult(client.endpoint.terminate());
      const summary = await session.closed;
      expect(summary.drain.state).toBe('truncated');
      expect(summary.drain.unavailableBytes).toBe(bytes.length);
    });
  });

  test('an acknowledgement for more bytes than were sent is a protocol violation', async () => {
    await withClient({}, async (harness, client, generation) => {
      harness.process.stream.push(encoder.encode('abc'));
      await client.waitForKind('output');
      // Control: counting exactly the bytes received is accepted, and the connection carries on.
      client.sendResult(client.endpoint.consumeOutput(3));
      client.sendResult(client.endpoint.input('.'));
      await client.waitForKind('operation-ack');
      client.send(
        forgeText({
          kind: 'output-consumed',
          sessionId: SESSION_IDENTIFIER,
          attachmentGeneration: generation,
          sequence: 3,
          consumedBytes: 4,
        }),
      );
      const awaited40 = await client.closed;
      expect(awaited40.code).toBe(1002);
      await harness.session().closed;
      expect(harness.process.cleanups).toBe(1);
    });
  });

  test('receipt alone never acknowledges output: a client that reads everything and acknowledges nothing overflows the budget', async () => {
    await withClient(
      { server: { budgets: { outputQueueBytes: 64 * 1024 } } },
      async (harness, client) => {
        const chunk = new Uint8Array(40 * 1024).fill(0x41);
        harness.process.stream.push(chunk);
        await client.waitForKind('output', 0);
        const delivered = client.messages.length;
        harness.process.stream.push(chunk);
        const summary = await harness.session().closed;
        expect(summary.cause).toBe('output-overflow');
        expect(summary.quarantined).toBe(true);
        // The first chunk was received and still counted as unparsed.
        expect(delivered).toBeGreaterThanOrEqual(2);
        expect(client.endpoint.outputBytes.consumed).toBe(0);
        await client.closed;
      },
    );
  });

  test('acknowledging each chunk keeps a stream far larger than the budget flowing', async () => {
    await withClient(
      { server: { budgets: { outputQueueBytes: 64 * 1024 } } },
      async (harness, client) => {
        const chunk = new Uint8Array(40 * 1024).fill(0x42);
        for (let round = 1; round <= 5; round += 1) {
          harness.process.stream.push(chunk);
          while (client.endpoint.outputBytes.received < round * chunk.length) {
            await client.waitForFrames(client.frames.length + 1);
          }
          client.sendResult(client.endpoint.consumeOutput(chunk.length));
          // Frames are handled in order, so this answer proves the host applied the acknowledgement.
          client.sendResult(client.endpoint.input('.'));
          await client.waitFor(
            (message) =>
              message.kind === 'operation-ack' && message.operationSequence === round * 2,
          );
        }
        expect(harness.session().snapshot.closed).toBe(false);
      },
    );
  });
});

describe('malformed traffic', () => {
  const envelope = (generation: number) => ({
    sessionId: SESSION_IDENTIFIER,
    attachmentGeneration: generation,
    sequence: 1,
  });

  test('control: the forged frames below are valid until each is altered', async () => {
    await withClient({}, async (harness, client, generation) => {
      client.send(forgeText({ kind: 'resize', ...envelope(generation), columns: 90, rows: 30 }));
      await harness.process.resizes(1);
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    });
  });

  test.each([
    ['text that is not JSON', () => 'not json at all'],
    ['a JSON array', () => '[]'],
    ['a binary frame of zeros', () => new Uint8Array(64)],
    ['a truncated binary frame', () => new Uint8Array(10)],
    [
      'an unknown kind',
      (generation: number) =>
        forgeText({ kind: 'terminate', ...envelope(generation) }, { kind: 'launch' }),
    ],
    [
      'an unknown version',
      (generation: number) =>
        forgeText({ kind: 'terminate', ...envelope(generation) }, { version: 2 }),
    ],
    [
      'a missing direction',
      (generation: number) =>
        forgeText({ kind: 'terminate', ...envelope(generation) }, { direction: undefined }),
    ],
    [
      'an extra field',
      (generation: number) =>
        forgeText({ kind: 'terminate', ...envelope(generation) }, { argumentList: ['x'] }),
    ],
  ])('%s closes with 1002 and cleans up the process', async (_name, build) => {
    await withClient({}, async (harness, client, generation) => {
      client.send(build(generation));
      const awaited41 = await client.closed;
      expect(awaited41.code).toBe(1002);
      const summary = await harness.session().closed;
      expect(summary.cause).toBe('protocol-failure');
      expect(harness.process.cleanups).toBe(1);
    });
  });

  test('input carried in a text frame is a direction error', async () => {
    await withClient({}, async (harness, client, generation) => {
      client.send(
        forgeText(
          { kind: 'resize', ...envelope(generation), columns: 80, rows: 24 },
          { kind: 'input', payload: 'ls', columns: undefined, rows: undefined },
        ),
      );
      const awaited42 = await client.closed;
      expect(awaited42.code).toBe(1002);
      expect(harness.process.written).toEqual([]);
    });
  });

  test('a server-to-client message sent by the client is refused', async () => {
    await withClient({}, async (_harness, client, generation) => {
      client.send(
        forgeText({ kind: 'operation-ack', ...envelope(generation), operationSequence: 1 }),
      );
      const awaited43 = await client.closed;
      expect(awaited43.code).toBe(1002);
    });
  });

  test('a second hello on an attached connection is refused and the host is not asked again', async () => {
    await withClient({}, async (harness, client) => {
      client.send(
        forgeText({
          kind: 'hello',
          version: 1,
          sessionId: SESSION_IDENTIFIER,
          requestedMode: 'interactive',
          token: 'again',
        }),
      );
      const awaited44 = await client.closed;
      expect(awaited44.code).toBe(1002);
      expect(harness.authorizations).toHaveLength(1);
    });
  });

  test('a frame over the socket payload ceiling fails the connection at the listener and the process is cleaned up', async () => {
    await withClient({ server: { limits: { maxFrameBytes: 1_000 } } }, async (harness, client) => {
      client.send(new Uint8Array(1_041));
      // The listener drops an oversized message without a close frame, so both sides see 1006.
      const awaited45 = await client.closed;
      expect([1006, 1009]).toContain(awaited45.code);
      const summary = await harness.session().closed;
      expect(summary.cause).toBe('disconnect');
      expect(harness.process.cleanups).toBe(1);
      expect([1006, 1009]).toContain(harness.closeCodes[0] as number);
    });
  });

  test('a text frame over the advertised budget but inside the socket ceiling is frame-too-large, 1009', async () => {
    await withClient({ server: { limits: { maxFrameBytes: 400 } } }, async (harness, client) => {
      client.send('x'.repeat(420));
      const awaited46 = await client.closed;
      expect(awaited46.code).toBe(1009);
      const awaited47 = await harness.session().closed;
      expect(awaited47.cause).toBe('protocol-failure');
      expect(harness.process.cleanups).toBe(1);
    });
  });

  test('an input payload of exactly the advertised budget is accepted', async () => {
    await withClient({ server: { limits: { maxFrameBytes: 400 } } }, async (harness, client) => {
      client.sendResult(client.endpoint.input(new Uint8Array(400).fill(0x61)));
      await harness.process.writes(1);
      expect(harness.process.written[0]?.length).toBe(400);
      const awaited48 = await client.waitForKind('operation-ack');
      expect(awaited48.operationSequence).toBe(1);
    });
  });
});

describe('exit, stop and disconnect', () => {
  test('exit is reported after the output it follows, then cleanup, then a normal close', async () => {
    await withClient({}, async (harness, client) => {
      harness.process.stream.push(encoder.encode('bye'));
      await client.waitForKind('output');
      client.sendResult(client.endpoint.consumeOutput(3));
      harness.process.stream.end();
      harness.process.exit(7);
      const exit = await client.waitForKind('process-exit');
      expect(exit).toMatchObject({ exitCode: 7, signal: null });
      const awaited49 = await client.waitForKind('cleanup-result');
      expect(awaited49.outcome).toBe('complete');
      const awaited50 = await client.closed;
      expect(awaited50.code).toBe(1000);
      expect(client.kinds().slice(-3)).toEqual(['output', 'process-exit', 'cleanup-result']);
      expect(harness.process.cleanups).toBe(1);
    });
  });

  test('a signal exit is reported with the signal and no exit code', async () => {
    await withClient({}, async (harness, client) => {
      harness.process.stream.end();
      harness.process.exit(null, 'SIGKILL');
      expect(await client.waitForKind('process-exit')).toMatchObject({
        exitCode: null,
        signal: 'SIGKILL',
      });
    });
  });

  test('terminate revokes authority, cleans up and closes normally', async () => {
    await withClient({}, async (harness, client) => {
      client.sendResult(client.endpoint.terminate());
      const awaited51 = await client.waitForKind('cleanup-result');
      expect(awaited51.outcome).toBe('complete');
      const awaited52 = await client.closed;
      expect(awaited52.code).toBe(1000);
      expect(harness.process.cleanups).toBe(1);
      expect(harness.terminal.connectionCount).toBe(0);
    });
  });

  test('an incomplete cleanup is reported to the client and quarantines the slot', async () => {
    await withClient(
      { process: scriptedProcess({ cleanup: 'unknown' }) },
      async (harness, client) => {
        client.sendResult(client.endpoint.terminate());
        const awaited53 = await client.waitForKind('cleanup-result');
        expect(awaited53.outcome).toBe('unknown');
        const awaited54 = await harness.session().closed;
        expect(awaited54.quarantined).toBe(true);
      },
    );
  });

  test('a client that closes the socket gets connection-owned process cleanup and no reconnect', async () => {
    await withClient({}, async (harness, client) => {
      const session = harness.session();
      client.socket.close(1000);
      const summary = await session.closed;
      expect(summary.cause).toBe('disconnect');
      expect(harness.process.cleanups).toBe(1);
      await harness.closesHandled(1);
      expect(harness.terminal.connectionCount).toBe(0);
      expect(harness.clock.pendingTimers).toBe(0);
    });
  });

  test('an abruptly dropped transport is the same: cleanup runs and delivery is not claimed', async () => {
    await withClient({}, async (harness, client) => {
      const session = harness.session();
      harness.process.stallWrites();
      client.sendResult(client.endpoint.input('x'));
      await harness.process.writes(1);
      (client.socket as unknown as { terminate(): void }).terminate();
      const summary = await session.closed;
      expect(summary.cause).toBe('disconnect');
      expect(harness.process.cleanups).toBe(1);
    });
  });

  test('liveness: a client that sends nothing and never answers a ping expires at the deadline', async () => {
    await withClient(
      { server: { limits: { pingIntervalMilliseconds: 120_000 } } },
      async (harness, client) => {
        harness.clock.advance(29_999);
        expect(client.socket.readyState).toBe(WebSocket.OPEN);
        harness.clock.advance(1);
        const summary = await harness.session().closed;
        expect(summary.cause).toBe('liveness-expired');
        const awaited55 = await client.waitForKind('cleanup-result');
        expect(awaited55.outcome).toBe('complete');
        expect(harness.process.cleanups).toBe(1);
      },
    );
  });

  test('liveness: a pong, which is a transport frame and not an application message, keeps an idle attachment alive', async () => {
    await withClient({}, async (harness, client) => {
      for (let round = 1; round <= 4; round += 1) {
        harness.clock.advance(10_000);
        await harness.pongsReceived(round);
      }
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect(harness.session().snapshot.closed).toBe(false);
      expect(client.messages).toHaveLength(1);
    });
  });
});
