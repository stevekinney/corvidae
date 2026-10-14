import { describe, expect, test } from 'bun:test';

import { ClientEndpoint } from '../protocol/client-endpoint.ts';
import { encodeFrame } from '../protocol/frame-codec.ts';
import type { ClientMessage } from '../protocol/messages.ts';
import { createDeferred } from './fixtures/deferred.ts';
import {
  createFixtureTransport,
  type FixtureTransport,
  type FixtureTransportOptions,
} from './fixtures/fixture-transport.ts';
import { createScriptedStream } from './fixtures/scripted-sources.ts';
import { SessionConnection } from './session-connection.ts';
import {
  createHarness,
  flush,
  utf8,
  type Harness,
  type HarnessOptions,
} from './session.test-support.ts';

async function wire(
  harnessOptions: HarnessOptions = {},
  transportOptions: Omit<FixtureTransportOptions, 'session'> = {},
): Promise<{ harness: Harness; transport: FixtureTransport }> {
  const harness = createHarness(harnessOptions);
  const transport = createFixtureTransport({ session: harness.session, ...transportOptions });
  void harness.session.start();
  await flush();
  transport.connect();
  return { harness, transport };
}

/** Encode a client message the way a hostile or stale peer would, bypassing the client endpoint. */
function forged(
  message: Record<string, unknown>,
  sequence: number,
  generation = 1,
): string | Uint8Array {
  const encoded = encodeFrame({
    sessionId: '0b6f0c3e-8a1d-4c55-9a64-2f6e9b7d1c10',
    attachmentGeneration: generation,
    sequence,
    ...message,
  } as unknown as ClientMessage);
  if (!encoded.ok) throw new Error('could not forge a frame');
  return encoded.value;
}

describe('a throwing authorization', () => {
  test('fails closed: no capabilities, no attachment, and the transport closes with the internal-error code', async () => {
    const harness = createHarness();
    const sent: (Uint8Array | string)[] = [];
    const closeCodes: number[] = [];
    const connection = new SessionConnection({
      session: harness.session,
      authorize: () => {
        throw new Error('token store unavailable');
      },
      send: (frame) => sent.push(frame),
      close: (code) => closeCodes.push(code),
    });
    const client = new ClientEndpoint({
      sessionId: harness.session.sessionId,
      requestedMode: 'interactive',
      token: 'fixture-token',
    });
    const hello = client.hello();
    if (!hello.ok) throw new Error('could not build hello');
    expect(() => connection.receive(hello.value)).not.toThrow();
    expect(sent).toEqual([]);
    expect(closeCodes).toEqual([1011]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'detached' });
  });
});

describe('the handshake', () => {
  test('issues the generation and the server-derived capabilities', async () => {
    const { transport } = await wire();
    expect(transport.client.phase).toBe('attached');
    expect(transport.client.terms).toEqual({
      generation: 1,
      capabilities: { mode: 'pty', input: true, resize: true, kill: true, readOnly: false },
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
    });
  });

  test('a read-only grant narrows what the client asked for', async () => {
    const { transport } = await wire({}, { grant: 'read-only' });
    expect(transport.client.terms?.capabilities).toEqual({
      mode: 'pty',
      input: false,
      resize: false,
      kill: false,
      readOnly: true,
    });
    expect(transport.client.input(utf8('x'))).toMatchObject({ ok: false });
  });

  test('a refused authorization closes the transport and issues nothing', async () => {
    const { harness, transport } = await wire({}, { grant: false });
    expect(transport.closeCodes).toEqual([1008]);
    expect(transport.received).toEqual([]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'detached' });
    expect(await transport.connection.transportClosed()).toBeUndefined();
  });

  test('a session identifier that is not this session is refused the same way', async () => {
    const { harness, transport } = await wire(
      {},
      { sessionId: '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5' },
    );
    expect(transport.closeCodes).toEqual([1008]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'detached' });
  });

  test('a second connection is refused without disturbing the first', async () => {
    const { harness, transport } = await wire();
    const second = createFixtureTransport({ session: harness.session });
    second.connect();
    expect(second.closeCodes).toEqual([1008]);
    expect(transport.closeCodes).toEqual([]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(transport.client.input(utf8('still'))).toMatchObject({ ok: true });
  });

  test('an unsupported version is refused before any attachment exists', async () => {
    const harness = createHarness();
    const closeCodes: number[] = [];
    const connection = new SessionConnection({
      session: harness.session,
      authorize: () => ({ allowed: true, grant: 'interactive' }),
      send: () => undefined,
      close: (code) => closeCodes.push(code),
    });
    connection.receive(
      JSON.stringify({ version: 2, kind: 'hello', direction: 'client-to-server', sessionId: 'x' }),
    );
    expect(closeCodes).toEqual([1002]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'detached' });
  });
});

describe('input, resize and acknowledgement', () => {
  test('an accepted operation is acknowledged on entering the FIFO, and the backend sees it in order', async () => {
    const { harness, transport } = await wire();
    transport.send(transport.client.input(utf8('ls')));
    transport.send(transport.client.resize(100, 40));
    const messages = transport.pump();
    expect(messages.map((message) => message.kind)).toEqual(['operation-ack', 'operation-ack']);
    await flush();
    expect(harness.backend?.calls.slice(1)).toEqual([
      { call: 'write', bytes: utf8('ls') },
      { call: 'resize', columns: 100, rows: 40 },
    ]);
  });

  test('a stale generation is told so and cannot reach the process, the view or cleanup', async () => {
    const { harness, transport } = await wire();
    transport.connection.receive(forged({ kind: 'input', payload: utf8('rm -rf') }, 1, 99));
    const [failure] = transport.pump();
    expect(failure).toMatchObject({ kind: 'operation-failure', code: 'stale-generation' });
    await flush();
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(harness.session.snapshot.cleanup).toEqual({ kind: 'idle' });
    expect(transport.closeCodes).toEqual([]);
  });

  test('a stale session identifier is refused the same way', async () => {
    const { harness, transport } = await wire();
    const stale = encodeFrame({
      kind: 'resize',
      sessionId: '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5',
      attachmentGeneration: 1,
      sequence: 1,
      columns: 10,
      rows: 10,
    } as unknown as ClientMessage);
    if (stale.ok) transport.connection.receive(stale.value);
    const [failure] = transport.pump();
    expect(failure).toMatchObject({ kind: 'operation-failure', code: 'stale-generation' });
    await flush();
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
  });

  test('input after the process exited is refused with an explicit failure, not queued', async () => {
    const { harness, transport } = await wire();
    harness.session.reportProcessExit(0, null);
    transport.pump();
    transport.send(transport.client.input(utf8('late')));
    const [failure] = transport.pump();
    expect(failure).toMatchObject({
      kind: 'operation-failure',
      code: 'read-only',
      message: 'input-disabled',
    });
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toEqual([]);
    harness.stream.end();
    await flush();
  });

  test('the session FIFO limit and input budget are reported as fifo-full without touching authority', async () => {
    const barrier = createDeferred<void>();
    const { harness, transport } = await wire({ backend: { write: () => barrier.promise } });
    for (let index = 0; index < 257; index += 1) {
      transport.send(transport.client.input(Uint8Array.of(1)));
      transport.pump();
    }
    transport.send(transport.client.input(Uint8Array.of(1)));
    const [failure] = transport.pump();
    expect(failure).toMatchObject({
      kind: 'operation-failure',
      code: 'fifo-full',
      message: 'fifo-full',
    });
    expect(transport.client.authorityRevoked).toBe(false);
    barrier.resolve();
    await flush();
    expect(harness.session.snapshot.connection.kind).toBe('attached');
  });

  test('input over the byte budget is reported under the same wire code with its own reason', async () => {
    const barrier = createDeferred<void>();
    const { transport } = await wire({ backend: { write: () => barrier.promise } });
    transport.send(transport.client.input(new Uint8Array(65_536)));
    transport.pump();
    transport.send(transport.client.input(Uint8Array.of(1)));
    const [failure] = transport.pump();
    expect(failure).toMatchObject({ code: 'fifo-full', message: 'input-overflow' });
    barrier.resolve();
  });

  test('a backend failure after acceptance is a submitted-operation failure that revokes authority', async () => {
    const { harness, transport } = await wire({
      backend: { write: () => Promise.reject(new Error('x')) },
    });
    transport.send(transport.client.input(utf8('a')));
    transport.send(transport.client.input(utf8('b')));
    await flush();
    const messages = transport.pump();
    expect(messages.map((message) => message.kind)).toEqual([
      'operation-ack',
      'operation-ack',
      'operation-failure',
      'operation-failure',
      'cleanup-result',
    ]);
    expect(messages.filter((message) => message.kind === 'operation-failure')).toMatchObject([
      { code: 'backend-failed', message: 'backend-failed' },
      { code: 'backend-failed', message: 'revoked' },
    ]);
    expect(transport.client.authorityRevoked).toBe(true);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('backend-failed');
  });

  test('a write that outlives its deadline is reported as unknown delivery', async () => {
    const { harness, transport } = await wire({
      backend: { write: () => new Promise(() => undefined) },
    });
    transport.send(transport.client.input(utf8('hang')));
    transport.pump();
    harness.clock.advance(2_000);
    await flush();
    const failure = transport.pump().find((message) => message.kind === 'operation-failure');
    expect(failure).toMatchObject({
      code: 'transport-failed',
      message: 'acknowledgement-deadline',
    });
  });
});

describe('output and consumption', () => {
  test('output reaches the client in order, and a large chunk is split without losing a byte', async () => {
    const { harness, transport } = await wire({}, { maxFrameBytes: 1_024 });
    const payload = new Uint8Array(3_000).map((_, index) => index % 251);
    harness.stream.push(payload);
    harness.stream.push(utf8('tail'));
    await flush();
    const outputs = transport.pump().filter((message) => message.kind === 'output');
    expect(outputs.map((message) => message.payload.length)).toEqual([1_024, 1_024, 952, 4]);
    const joined = new Uint8Array(3_004);
    let offset = 0;
    for (const message of outputs) {
      joined.set(message.payload, offset);
      offset += message.payload.length;
    }
    expect(joined.subarray(0, 3_000)).toEqual(payload);
    expect(joined.subarray(3_000)).toEqual(utf8('tail'));
  });

  test('an empty chunk is still one frame', async () => {
    const { harness, transport } = await wire();
    harness.stream.push(new Uint8Array(0));
    await flush();
    const [output] = transport.pump();
    expect(output).toMatchObject({ kind: 'output', payload: new Uint8Array(0) });
  });

  test('capacity returns only when the client reports the bytes parsed', async () => {
    const stream = createScriptedStream('pty');
    const { harness, transport } = await wire({
      sources: [stream.source],
      budgets: { outputQueueBytes: 65_536 },
    });
    stream.push(new Uint8Array(40_000));
    await flush();
    transport.pump();
    // Receiving the bytes frees nothing; parsing them does.
    expect(transport.client.outputBytes).toEqual({ received: 40_000, consumed: 0 });
    transport.send(transport.client.consumeOutput(40_000));
    stream.push(new Uint8Array(40_000));
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    expect(transport.pump()).toHaveLength(1);
  });

  test('without a report, the next chunk that does not fit fails the session', async () => {
    const stream = createScriptedStream('pty');
    const { harness, transport } = await wire({
      sources: [stream.source],
      budgets: { outputQueueBytes: 65_536 },
    });
    stream.push(new Uint8Array(40_000));
    stream.push(new Uint8Array(40_000));
    await flush();
    const messages = transport.pump();
    expect(messages.map((message) => message.kind)).toEqual(['output', 'cleanup-result']);
    expect(messages[1]).toMatchObject({ outcome: 'incomplete' });
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('output-overflow');
  });
});

describe('exit, stop and the final result', () => {
  test('process exit, source completion and cleanup are three separate messages', async () => {
    const { harness, transport } = await wire();
    harness.stream.push(utf8('bye'));
    await flush();
    const messages = transport.pump();
    harness.session.reportProcessExit(2, null);
    harness.stream.end();
    transport.send(transport.client.consumeOutput(3));
    await flush();
    messages.push(...transport.pump());
    expect(messages.map((message) => message.kind)).toEqual([
      'output',
      'process-exit',
      'cleanup-result',
    ]);
    expect(transport.closeCodes).toEqual([1000]);
    expect(transport.client.phase).toBe('closed');
  });

  test('terminate stops the session and the client receives the cleanup result', async () => {
    const { harness, transport } = await wire();
    transport.send(transport.client.terminate());
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual(['cleanup-result']);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('attachment-stop');
  });

  test('a read-only client cannot stop the session by sending terminate', async () => {
    const { harness, transport } = await wire({}, { grant: 'read-only' });
    transport.connection.receive(forged({ kind: 'terminate' }, 1));
    await flush();
    expect(harness.session.snapshot.closed).toBe(false);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
  });

  test('a malformed frame revokes the generation and cleans up, closing once with the protocol code', async () => {
    const { harness, transport } = await wire();
    transport.connection.receive('this is not a frame');
    await flush();
    expect(transport.closeCodes).toEqual([1002]);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('protocol-failure');
    expect(harness.backend?.calls.filter((call) => call.call === 'cleanup')).toHaveLength(1);
  });

  test('a send that throws while answering a frame revokes the generation and closes with the transport-failure code', async () => {
    const harness = createHarness();
    const closeCodes: number[] = [];
    let armed = false;
    const connection = new SessionConnection({
      session: harness.session,
      authorize: () => ({ allowed: true, grant: 'interactive' }),
      send: () => {
        if (armed) throw new Error('socket is gone');
      },
      close: (code) => closeCodes.push(code),
    });
    void harness.session.start();
    await flush();
    const client = new ClientEndpoint({
      sessionId: harness.session.sessionId,
      requestedMode: 'interactive',
      token: 'fixture-token',
    });
    const hello = client.hello();
    if (!hello.ok) throw new Error('could not build hello');
    connection.receive(hello.value);
    armed = true;
    expect(() =>
      connection.receive(forged({ kind: 'input', payload: utf8('rm -rf') }, 1, 99)),
    ).not.toThrow();
    await flush();
    expect(closeCodes).toEqual([1011]);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('protocol-failure');
  });

  test('a close that throws does not escape receive', async () => {
    const harness = createHarness();
    const connection = new SessionConnection({
      session: harness.session,
      authorize: () => ({ allowed: false }),
      send: () => undefined,
      close: () => {
        throw new Error('already closed');
      },
    });
    const client = new ClientEndpoint({
      sessionId: harness.session.sessionId,
      requestedMode: 'interactive',
      token: 'fixture-token',
    });
    const hello = client.hello();
    if (!hello.ok) throw new Error('could not build hello');
    expect(() => connection.receive(hello.value)).not.toThrow();
  });

  test('a transport that closes underneath the session is a disconnect, and only once', async () => {
    const { harness, transport } = await wire();
    const first = await transport.connection.transportClosed();
    const second = await transport.connection.transportClosed();
    expect(first).toBe(second);
    expect(first?.cause).toBe('disconnect');
    expect(harness.session.snapshot.closed).toBe(true);
  });

  test('every frame the client sends counts as liveness', async () => {
    const stream = createScriptedStream('pty');
    const { harness, transport } = await wire({ sources: [stream.source] });
    stream.push(utf8('x'));
    await flush();
    transport.pump();
    harness.clock.advance(20_000);
    transport.send(transport.client.consumeOutput(1));
    harness.clock.advance(20_000);
    expect(harness.session.snapshot.connection.kind).toBe('attached');
    harness.clock.advance(10_000);
    expect(harness.session.snapshot.connection.kind).toBe('revoked');
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('liveness-expired');
  });
});
