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
import type { Session } from './session.ts';

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
    // The exit waits for end of file, so the client still holds authority: the session refuses the input.
    transport.send(transport.client.input(utf8('early')));
    expect(transport.pump()).toMatchObject([
      { kind: 'operation-failure', code: 'read-only', message: 'input-disabled' },
    ]);
    harness.stream.end();
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual([
      'process-exit',
      'cleanup-result',
    ]);
    // The exit and the cleanup result ended the generation, so the client refuses further input before any frame exists.
    const late = transport.client.input(utf8('late'));
    expect(late).toMatchObject({
      ok: false,
      failure: { code: 'stale-generation', reason: 'attachment-revoked' },
    });
    expect(transport.pump()).toEqual([]);
    expect(harness.backend?.calls.filter((call) => call.call === 'write')).toEqual([]);
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
    // The write is submitted after the acknowledgement, so its deadline starts a turn later.
    await flush();
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

  // "Output-only sources ... advertise no input, resize, or kill capability", so a terminate from
  // an attachment without `kill` is never a stop. It is answered as the attachment ending, never dropped.
  test('a read-only client cannot stop the session by sending terminate: it is detached, and told so', async () => {
    const { harness, transport } = await wire({}, { grant: 'read-only' });
    transport.send(transport.client.terminate());
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('disconnect');
    expect(transport.pump().map((message) => message.kind)).toEqual(['cleanup-result']);
    expect(transport.closeCodes).toEqual([1000]);
    expect(transport.failures).toEqual([]);
  });

  test('a terminate on an output-only attachment is answered with the cleanup result', async () => {
    const { harness, transport } = await wire({ backend: false });
    transport.send(transport.client.terminate());
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('disconnect');
    expect(transport.pump().map((message) => message.kind)).toEqual(['cleanup-result']);
    expect(transport.closeCodes).toEqual([1000]);
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

describe('trailing output after the process exit', () => {
  test('output the backend produced before its streams ended is delivered before the process exit', async () => {
    const { harness, transport } = await wire();
    harness.stream.push(utf8('first'));
    await flush();
    harness.session.reportProcessExit(0, null);
    // The exit has been reported, but the stream has not reached end of file.
    harness.stream.push(utf8('trailing'));
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual(['output', 'output']);
    harness.stream.end();
    await flush();
    const rest = transport.pump();
    expect(rest.map((message) => message.kind)).toEqual(['process-exit']);
    transport.send(transport.client.consumeOutput(13));
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual(['cleanup-result']);
    expect(transport.failures).toEqual([]);
    const payloads = transport.received
      .filter((message) => message.kind === 'output')
      .map((message) => new TextDecoder().decode(message.payload));
    expect(payloads).toEqual(['first', 'trailing']);
  });

  test('an exit whose streams never end is sent when the attachment is revoked, before the cleanup result', async () => {
    const { harness, transport } = await wire();
    harness.session.reportProcessExit(3, null);
    expect(transport.pump()).toEqual([]);
    harness.clock.advance(5_000);
    await flush();
    const messages = transport.pump();
    expect(messages.map((message) => message.kind)).toEqual(['process-exit', 'cleanup-result']);
    expect(messages[0]).toMatchObject({ exitCode: 3 });
  });

  test('an exit with no sources to wait for is sent at once', async () => {
    const { harness, transport } = await wire({ sources: [] });
    harness.session.reportProcessExit(0, null);
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual([
      'process-exit',
      'cleanup-result',
    ]);
  });

  test('a frame the endpoint refuses fails the connection closed instead of being dropped', async () => {
    // An output-only session has no process, so the endpoint refuses an exit the session reports anyway.
    const { harness, transport } = await wire({ backend: false, sources: [] });
    harness.session.reportProcessExit(0, null);
    await flush();
    expect(harness.session.snapshot.connection.kind).toBe('revoked');
    const summary = await harness.session.closed;
    // The exit is the first cause, so the refusal it provokes hurries the close without replacing it.
    expect(summary.cause).toBe('process-exit');
    expect(transport.closeCodes).toEqual([1002]);
  });
});

/** A rejection that carries one of the startup failure codes, as the Bun helpers' `ProcessStartFailure` does. */
function startRejectedWith(code: string): Error {
  return Object.assign(new Error('refused'), { code });
}

describe('the code a backend refused to start with', () => {
  test('reaches a client that arrives after the failure as unsupported-runtime, with no attachment', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(startRejectedWith('unsupported-runtime')) },
    });
    void harness.session.start();
    await flush();
    expect(harness.session.startFailureCode).toBe('unsupported-runtime');
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    expect(transport.received).toMatchObject([
      { kind: 'attachment-error', code: 'unsupported-runtime' },
    ]);
    expect(transport.failures).toEqual([]);
    expect(transport.closeCodes).toEqual([1011]);
  });

  test('reaches a client that arrives after the failure as spawn-failed when that is the code', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(startRejectedWith('spawn-failed')) },
    });
    void harness.session.start();
    await flush();
    expect(harness.session.startFailureCode).toBe('spawn-failed');
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    expect(transport.received).toMatchObject([{ kind: 'attachment-error', code: 'spawn-failed' }]);
  });

  test('is read from a start that throws synchronously, too', async () => {
    const harness = createHarness({
      backend: {
        start: () => {
          throw startRejectedWith('unsupported-runtime');
        },
      },
    });
    void harness.session.start();
    await flush();
    expect(harness.session.startFailureCode).toBe('unsupported-runtime');
  });

  test.each([
    ['an error with no code', new Error('no shell')],
    ['an unrelated code', startRejectedWith('EACCES')],
    ['a value that is not an error', null],
  ])('is absent for %s, which is a spawn-failed', async (_label, rejection) => {
    const harness = createHarness({ backend: { start: () => Promise.reject(rejection) } });
    void harness.session.start();
    await flush();
    expect(harness.session.startFailureCode).toBeUndefined();
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    expect(transport.received).toMatchObject([{ kind: 'attachment-error', code: 'spawn-failed' }]);
  });

  test('is spawn-failed for a client already attached, whose generation the protocol will not call unsupported', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(startRejectedWith('unsupported-runtime')) },
    });
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    void harness.session.start();
    await flush();
    const messages = transport.pump();
    expect(messages.map((message) => message.kind)).toEqual(['attachment-error', 'cleanup-result']);
    expect(messages[0]).toMatchObject({ code: 'spawn-failed' });
    expect(transport.failures).toEqual([]);
    expect(transport.closeCodes).toEqual([1011]);
  });
});

describe('startup failure', () => {
  test('a backend that fails to start after capabilities were issued is reported as spawn-failed before the cleanup result', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(new Error('no shell')) },
    });
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    expect(transport.client.phase).toBe('attached');
    void harness.session.start();
    await flush();
    const messages = transport.pump();
    expect(messages.map((message) => message.kind)).toEqual(['attachment-error', 'cleanup-result']);
    expect(messages[0]).toMatchObject({ code: 'spawn-failed' });
    expect(messages.some((message) => message.kind === 'process-exit')).toBe(false);
    expect(transport.failures).toEqual([]);
    // The close waits for the cleanup result, and carries the table's spawn-failed code.
    expect(transport.closeCodes).toEqual([1011]);
  });
});

describe('liveness', () => {
  test('a stale frame does not count as liveness', async () => {
    const { harness, transport } = await wire();
    harness.clock.advance(20_000);
    transport.connection.receive(forged({ kind: 'input', payload: utf8('x') }, 1, 99));
    harness.clock.advance(20_000);
    expect(harness.session.snapshot.connection.kind).toBe('revoked');
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('liveness-expired');
  });

  test('a frame for another session does not count as liveness', async () => {
    const { harness, transport } = await wire();
    harness.clock.advance(20_000);
    const foreign = encodeFrame({
      kind: 'resize',
      sessionId: '7c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5',
      attachmentGeneration: 1,
      sequence: 1,
      columns: 10,
      rows: 10,
    } as unknown as ClientMessage);
    if (foreign.ok) transport.connection.receive(foreign.value);
    harness.clock.advance(20_000);
    expect(harness.session.snapshot.connection.kind).toBe('revoked');
  });

  test('a malformed frame does not count as liveness', async () => {
    const { harness, transport } = await wire();
    harness.clock.advance(20_000);
    transport.connection.receive('not a frame');
    harness.clock.advance(20_000);
    expect(harness.session.snapshot.connection.kind).toBe('revoked');
  });
});

describe('a cancellation while the process exit is held', () => {
  // "Exit: the host emits PTY EOF or source completion, then the distinct process-exit result when
  // known, revokes the generation, and emits cleanup-result." A cancellation is not a submitted failure.
  test('does not suppress the exit: the client receives process-exit and the transport closes normally', async () => {
    const { harness, transport } = await wire();
    transport.send(transport.client.input(utf8('queued')));
    // The exit cancels the queued operation before the source has reached end of file.
    harness.session.reportProcessExit(0, null);
    await flush();
    expect(transport.closeCodes).toEqual([]);
    harness.stream.end();
    await flush();
    transport.pump();
    expect(transport.closeCodes).toEqual([1000]);
    expect(transport.received.map((message) => message.kind)).toEqual([
      'capabilities',
      'operation-ack',
      'process-exit',
      'operation-failure',
      'cleanup-result',
    ]);
    expect(transport.failures).toEqual([]);
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('process-exit');
  });

  test('a cancellation with no exit held is still reported at once', async () => {
    const gate = createDeferred<void>();
    const { harness, transport } = await wire({ backend: { write: () => gate.promise } });
    transport.send(transport.client.input(utf8('a')));
    await flush();
    transport.send(transport.client.input(utf8('b')));
    void harness.session.stop();
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual([
      'operation-ack',
      'operation-ack',
      'operation-failure',
      'operation-failure',
      'cleanup-result',
    ]);
    gate.resolve();
  });
});

describe('a submitted write that fails while the process exit is held', () => {
  // "backend-failed | server, submitted operation | operation failure; generation revoked | 1011" and
  // "A failed connection is not a successful process exit": the held exit is dropped, never sent to be refused.
  test('reports the failure and the cleanup result without calling the dropped exit a protocol violation', async () => {
    const write = createDeferred<void>();
    const harness = createHarness({ backend: { write: () => write.promise } });
    let violations = 0;
    const attach = harness.session.attach.bind(harness.session);
    harness.session.attach = (request) => {
      const result = attach(request);
      if (!result.accepted) return result;
      const original = result.attachment.protocolViolation;
      return {
        ...result,
        attachment: {
          ...result.attachment,
          protocolViolation: () => {
            violations += 1;
            return original();
          },
        },
      };
    };
    const transport = createFixtureTransport({ session: harness.session });
    void harness.session.start();
    await flush();
    transport.connect();
    transport.send(transport.client.input(utf8('a')));
    await flush();
    harness.session.reportProcessExit(0, null);
    write.reject(new Error('write failed'));
    await flush();
    harness.stream.end();
    await flush();
    transport.pump();
    expect(transport.received.map((message) => message.kind)).toEqual([
      'capabilities',
      'operation-ack',
      'operation-failure',
      'cleanup-result',
    ]);
    expect(transport.failures).toEqual([]);
    expect(transport.closeCodes).toEqual([1011]);
    expect(violations).toBe(0);
  });
});

describe('transport liveness', () => {
  test('a quiet read-only attachment stays attached while the transport reports itself alive', async () => {
    const { harness, transport } = await wire({}, { grant: 'read-only' });
    for (let tick = 0; tick < 4; tick += 1) {
      harness.clock.advance(20_000);
      expect(transport.connection.noteTransportAlive()).toBe(true);
    }
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(harness.session.snapshot.closed).toBe(false);
  });

  test('a quiet output-only attachment stays attached while the transport reports itself alive', async () => {
    const { harness, transport } = await wire({ backend: false });
    for (let tick = 0; tick < 4; tick += 1) {
      harness.clock.advance(20_000);
      expect(transport.connection.noteTransportAlive()).toBe(true);
    }
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
  });

  test('a dead transport still expires, and a late report revives nothing', async () => {
    const { harness, transport } = await wire({}, { grant: 'read-only' });
    harness.clock.advance(30_000);
    expect(transport.connection.noteTransportAlive()).toBe(false);
    await flush();
    const summary = await harness.session.closed;
    expect(summary.cause).toBe('liveness-expired');
    expect(transport.closeCodes).toEqual([1000]);
  });

  test('a report before any attachment exists is ignored', () => {
    const harness = createHarness();
    const transport = createFixtureTransport({ session: harness.session });
    expect(transport.connection.noteTransportAlive()).toBe(false);
  });

  test('a transport report grants no authority', async () => {
    const { harness, transport } = await wire({}, { grant: 'read-only' });
    transport.connection.noteTransportAlive();
    transport.connection.receive(forged({ kind: 'input', payload: utf8('x') }, 1));
    await flush();
    expect(harness.backend?.calls).toEqual([{ call: 'start' }]);
    expect(harness.session.snapshot.connection).toEqual({ kind: 'attached', generation: 1 });
    expect(transport.wire.filter((event) => event.type === 'frame')).toHaveLength(2);
  });
});

describe('a source that emits while the attachment is being admitted', () => {
  test('its output is held until the capabilities are issued, then delivered in order', async () => {
    const { transport } = await wire({
      sources: [
        {
          kind: 'subscription',
          channel: 'pty',
          subscribe: (deliver) => {
            deliver(utf8('early'));
            deliver(utf8('second'));
            return () => undefined;
          },
        },
      ],
    });
    expect(transport.closeCodes).toEqual([]);
    expect(transport.failures).toEqual([]);
    expect(transport.received.map((message) => message.kind)).toEqual([
      'capabilities',
      'output',
      'output',
    ]);
    expect(
      transport.received
        .filter((message) => message.kind === 'output')
        .map((message) => new TextDecoder().decode(message.payload)),
    ).toEqual(['early', 'second']);
  });
});

describe('a startup failure that precedes the attachment', () => {
  test('is reported to an authorized client as spawn-failed, then the transport closes', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(new Error('no shell')) },
    });
    void harness.session.start();
    await flush();
    const transport = createFixtureTransport({ session: harness.session });
    transport.connect();
    expect(transport.received).toMatchObject([{ kind: 'attachment-error', code: 'spawn-failed' }]);
    expect(transport.failures).toEqual([]);
    expect(transport.closeCodes).toEqual([1011]);
  });

  test('is not revealed to a client the host refused', async () => {
    const harness = createHarness({
      backend: { start: () => Promise.reject(new Error('no shell')) },
    });
    void harness.session.start();
    await flush();
    const transport = createFixtureTransport({ session: harness.session, grant: false });
    transport.connect();
    expect(transport.received).toEqual([]);
    expect(transport.closeCodes).toEqual([1008]);
  });
});

describe('a synchronous process exit from the backend', () => {
  test('is sent after the operation that caused it has been acknowledged', async () => {
    const holder: { session?: Session } = {};
    const { harness, transport } = await wire({
      sources: [],
      backend: {
        write: () => {
          holder.session?.reportProcessExit(1, null);
          return Promise.resolve();
        },
      },
    });
    holder.session = harness.session;
    transport.send(transport.client.input(utf8('x')));
    await flush();
    expect(transport.pump().map((message) => message.kind)).toEqual([
      'operation-ack',
      'process-exit',
      'cleanup-result',
    ]);
    expect(transport.failures).toEqual([]);
    expect(transport.closeCodes).toEqual([1000]);
  });
});

describe('the endpoint window and the session FIFO share one depth', () => {
  function connectionFor(operationQueueLimit: number, limits?: { maxQueuedOperations: number }) {
    const harness = createHarness({ budgets: { operationQueueLimit } });
    return () =>
      new SessionConnection({
        session: harness.session,
        authorize: () => ({ allowed: true, grant: 'interactive' }),
        send: () => undefined,
        close: () => undefined,
        ...(limits === undefined ? {} : { limits }),
      });
  }

  test('a session FIFO deeper than the endpoint can window is rejected at construction', () => {
    expect(connectionFor(300)).toThrow(RangeError);
    expect(connectionFor(256, { maxQueuedOperations: 100 })).toThrow(RangeError);
  });

  test('a matching or shallower session FIFO is accepted', () => {
    expect(connectionFor(256)).not.toThrow();
    expect(connectionFor(100, { maxQueuedOperations: 100 })).not.toThrow();
    expect(connectionFor(50, { maxQueuedOperations: 100 })).not.toThrow();
  });

  test('the depth the client is told is the depth the session enforces', async () => {
    const { transport } = await wire({ budgets: { operationQueueLimit: 100 } });
    expect(transport.client.terms?.maxQueuedOperations).toBe(100);
  });
});

describe('a transport that fails while sending', () => {
  function throwingConnection(harness: Harness, attempts: (Uint8Array | string)[]) {
    return new SessionConnection({
      session: harness.session,
      authorize: () => ({ allowed: true, grant: 'interactive' }),
      send: (frame) => {
        attempts.push(frame);
        throw new Error('socket is gone');
      },
      close: () => undefined,
    });
  }

  function hello(harness: Harness): string | Uint8Array {
    const client = new ClientEndpoint({
      sessionId: harness.session.sessionId,
      requestedMode: 'interactive',
      token: 'fixture-token',
    });
    const built = client.hello();
    if (!built.ok) throw new Error('could not build hello');
    return built.value;
  }

  test('releases nothing buffered after the capabilities could not be sent', async () => {
    const early = {
      kind: 'subscription' as const,
      channel: 'pty' as const,
      subscribe: (deliver: (bytes: Uint8Array) => void) => {
        deliver(utf8('one'));
        deliver(utf8('two'));
        return () => undefined;
      },
    };
    const harness = createHarness({ sources: [early] });
    void harness.session.start();
    await flush();
    const attempts: (Uint8Array | string)[] = [];
    throwingConnection(harness, attempts).receive(hello(harness));
    // Only the capabilities were attempted; the buffered output was dropped with the attachment.
    expect(attempts).toHaveLength(1);
    expect(typeof attempts[0]).toBe('string');
  });

  test('stops sending the remaining slices of a chunk after one fails', async () => {
    const stream = createScriptedStream('pty');
    const harness = createHarness({ sources: [stream.source] });
    void harness.session.start();
    await flush();
    const attempts: (Uint8Array | string)[] = [];
    let armed = false;
    const connection = new SessionConnection({
      session: harness.session,
      authorize: () => ({ allowed: true, grant: 'interactive' }),
      send: (frame) => {
        if (!armed) return;
        attempts.push(frame);
        throw new Error('socket is gone');
      },
      close: () => undefined,
      limits: { maxFrameBytes: 1_024 },
    });
    connection.receive(hello(harness));
    armed = true;
    stream.push(new Uint8Array(5_000));
    await flush();
    // Output frames are binary; the cleanup result that follows the violation is text.
    expect(attempts.filter((frame) => typeof frame !== 'string')).toHaveLength(1);
  });
});

describe('a fatal failure of an attached connection', () => {
  test.each([
    ['a malformed frame', 'this is not a frame', 1002],
    ['an oversized frame', 'x'.repeat(70_000), 1009],
  ] as const)(
    '%s sends the cleanup result before the transport closes',
    async (_name, frame, code) => {
      const { harness, transport } = await wire();
      transport.connection.receive(frame);
      await flush();
      await harness.session.closed;
      expect(transport.sentAfterClose).toEqual([]);
      const kinds = transport.pump().map((message) => message.kind);
      expect(kinds).toEqual(['cleanup-result']);
      expect(transport.wire.at(-1)).toEqual({ type: 'close', code });
      expect(transport.closeCodes).toEqual([code]);
    },
  );

  test('a backend failure closes with the failure table code, after the cleanup result', async () => {
    const { harness, transport } = await wire({
      backend: { write: () => Promise.reject(new Error('x')) },
    });
    transport.send(transport.client.input(utf8('a')));
    await flush();
    await harness.session.closed;
    expect(transport.sentAfterClose).toEqual([]);
    expect(transport.wire.at(-1)).toEqual({ type: 'close', code: 1011 });
    expect(transport.closeCodes).toEqual([1011]);
  });
});
