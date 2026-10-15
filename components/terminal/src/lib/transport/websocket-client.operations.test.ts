import { describe, expect, test } from 'bun:test';

import { PIPE, READ_ONLY, rig, unwrap, type Rig } from './transport-test-support.ts';
import type { OperationResult, TerminalTransportEvent } from './transport-types.ts';

const decoder = new TextDecoder();

/** Let the host take what the client sent, so its ledgers can answer it. */
function received(subject: Rig) {
  return subject.fromClient();
}

describe('sendInput', () => {
  test('resolves accepted when the host acknowledges it, and not when it is sent', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    let settled: OperationResult | undefined;
    const sending = subject.client.sendInput('ls\r').then((result) => {
      settled = result;
    });
    const [message] = received(subject);
    expect(message).toMatchObject({ kind: 'input', sequence: 1 });
    expect(decoder.decode((message as { payload: Uint8Array }).payload)).toBe('ls\r');
    await Promise.resolve();
    expect(settled).toBeUndefined();
    subject.serve(subject.host.acknowledgeOperation(1));
    await sending;
    expect(settled).toEqual({ status: 'accepted', sequence: 1 });
    expect(events).toContainEqual({ type: 'operation-ack', sequence: 1 });
  });

  test('sends the exact bytes, whatever they are', async () => {
    const subject = rig();
    await subject.attach();
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x03]);
    void subject.client.sendInput(bytes);
    const [message] = received(subject);
    expect([...(message as { payload: Uint8Array }).payload]).toEqual([...bytes]);
  });

  test('a host refusal resolves as failed with the host code, and the attachment carries on', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    const sending = subject.client.sendInput('x');
    received(subject);
    subject.serve(subject.host.failOperation(1, 'read-only', 'not allowed'));
    expect(await sending).toEqual({ status: 'failed', sequence: 1, code: 'read-only' });
    expect(subject.client.state).toBe('writable');
    expect(events).toContainEqual({
      type: 'operation-failure',
      sequence: 1,
      code: 'read-only',
      message: 'not allowed',
    });
  });

  test('a failure of a submitted operation is the terminal status: failed, never an exit', async () => {
    const subject = rig();
    await subject.attach();
    const sending = subject.client.sendInput('x');
    received(subject);
    subject.serve(subject.host.failOperation(1, 'backend-failed', 'the pty is gone'));
    expect(await sending).toEqual({ status: 'failed', sequence: 1, code: 'backend-failed' });
    expect(subject.client.state).toBe('failed');
    expect(subject.client.authorityRevoked).toBe(true);
  });

  test('an unknown delivery, a transport-failed report, is also the terminal status', async () => {
    const subject = rig();
    await subject.attach();
    const sending = subject.client.sendInput('x');
    received(subject);
    subject.serve(subject.host.failOperation(1, 'transport-failed', 'no acknowledgement'));
    expect(await sending).toMatchObject({ status: 'failed', code: 'transport-failed' });
    expect(subject.client.state).toBe('failed');
  });

  test('is refused without sending when the grant has no input', async () => {
    const subject = rig({ requestedMode: 'read-only' });
    await subject.attach(READ_ONLY);
    const result = await subject.client.sendInput('x');
    expect(result).toEqual({
      status: 'refused',
      code: 'read-only',
      reason: 'operation-not-permitted',
    });
    expect(received(subject)).toEqual([]);
  });

  test('is refused before the handshake completes', async () => {
    const subject = rig();
    void subject.client.connect();
    expect(await subject.client.sendInput('x')).toMatchObject({
      status: 'refused',
      code: 'stale-generation',
      reason: 'attachment-revoked',
    });
    expect(subject.socket().sent).toEqual([]);
  });

  test('is refused once authority was revoked by stopping', async () => {
    const subject = rig();
    await subject.attach();
    void subject.client.stop();
    expect(await subject.client.sendInput('x')).toMatchObject({
      status: 'refused',
      code: 'read-only',
      reason: 'authority-revoked',
    });
  });

  test('a send that throws leaves the operation unknown and ends the transport', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().sendThrows = true;
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    expect(await subject.client.sendInput('x')).toEqual({ status: 'unknown', sequence: 1 });
    expect(subject.client.state).toBe('disconnected');
    expect(subject.client.deliveryUnknown).toEqual([1]);
    expect(events).toContainEqual({ type: 'delivery-unknown', sequences: [1] });
  });
});

describe('sendResize', () => {
  test('is acknowledged like input and reaches the host as a resize', async () => {
    const subject = rig();
    await subject.attach();
    const sending = subject.client.sendResize(132, 43);
    const [message] = received(subject);
    expect(message).toMatchObject({ kind: 'resize', columns: 132, rows: 43, sequence: 1 });
    subject.serve(subject.host.acknowledgeOperation(1));
    expect(await sending).toEqual({ status: 'accepted', sequence: 1 });
  });

  test('is refused locally on a pipe, which has no terminal to resize', async () => {
    const subject = rig();
    await subject.attach(PIPE);
    expect(await subject.client.sendResize(80, 24)).toMatchObject({
      status: 'refused',
      code: 'read-only',
      reason: 'operation-not-permitted',
    });
    expect(received(subject)).toEqual([]);
  });

  test('shares the operation sequence with input', async () => {
    const subject = rig();
    await subject.attach();
    void subject.client.sendInput('a');
    void subject.client.sendResize(100, 30);
    void subject.client.sendInput('b');
    expect(received(subject).map((message) => (message as { sequence: number }).sequence)).toEqual([
      1, 2, 3,
    ]);
  });
});

describe('the input path the terminal uses', () => {
  test('returns the protocol result, with the sequence, and sends the frame', async () => {
    const subject = rig();
    await subject.attach();
    const result = subject.client.input.input(new TextEncoder().encode('ls'));
    expect(unwrap(result).sequence).toBe(1);
    expect(received(subject)).toHaveLength(1);
  });

  test('reflects authority and the negotiated terms', async () => {
    const subject = rig();
    expect(subject.client.input.authorityRevoked).toBe(false);
    expect(subject.client.input.terms).toBeUndefined();
    await subject.attach();
    expect(subject.client.input.terms).toMatchObject({
      maxFrameBytes: 65_536,
      maxQueuedOperations: 256,
    });
    subject.client.close();
    expect(subject.client.input.authorityRevoked).toBe(true);
  });

  test('refuses a read-only grant with the protocol code, so the terminal can name the reason', async () => {
    const subject = rig({ requestedMode: 'read-only' });
    await subject.attach(READ_ONLY);
    const result = subject.client.input.input(new Uint8Array([0x61]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('read-only');
  });

  test('is refused after the transport ended', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().drop(1006);
    const result = subject.client.input.input(new Uint8Array([0x61]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.reason).toBe('attachment-revoked');
  });

  test('throws when the transport fails after the frame was built, because delivery is unknown', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().sendThrows = true;
    expect(() => subject.client.input.input(new Uint8Array([0x61]))).toThrow('delivery is unknown');
    expect(subject.client.state).toBe('disconnected');
    expect(subject.client.deliveryUnknown).toEqual([1]);
  });

  test('is refused on a socket that is no longer open', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().readyState = 2;
    const result = subject.client.input.input(new Uint8Array([0x61]));
    expect(result.ok).toBe(false);
  });
});

describe('process exit and cleanup', () => {
  test('an exit ends the state as exited, with the code or signal, and revokes authority', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.serve(subject.host.processExit(3, null));
    expect(subject.client.state).toBe('exited');
    expect(subject.client.authorityRevoked).toBe(true);
    expect(events).toContainEqual({ type: 'process-exit', exitCode: 3, signal: null });
  });

  test('a clean cleanup after an exit leaves the state exited', async () => {
    const subject = rig();
    await subject.attach();
    subject.serve(subject.host.processExit(0, null));
    subject.serve(subject.host.cleanupResult('complete'));
    expect(subject.client.state).toBe('exited');
    subject.socket().drop(1000);
    expect(subject.client.state).toBe('exited');
  });

  test('a cleanup that is incomplete or unknown quarantines, whatever came before', async () => {
    for (const outcome of ['incomplete', 'unknown'] as const) {
      const subject = rig();
      await subject.attach();
      subject.serve(subject.host.processExit(0, null));
      subject.serve(subject.host.cleanupResult(outcome));
      expect(subject.client.state).toBe('cleanup-incomplete');
      subject.socket().drop(1000);
      expect(subject.client.state).toBe('cleanup-incomplete');
    }
  });

  test('a cleanup with no exit before it is a plain disconnect, reported by the host', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.serve(subject.host.cleanupResult('complete'));
    expect(subject.client.state).toBe('disconnected');
    subject.socket().drop(1000);
    expect(events.map((event) => event.type)).not.toContain('transport-error');
  });

  test('a startup error after the generation was issued is failed, not an exit', async () => {
    const subject = rig();
    await subject.attach();
    subject.serve(subject.host.attachmentError('backend-failed', 'the backend failed'));
    expect(subject.client.state).toBe('failed');
    subject.socket().drop(1011);
    expect(subject.client.state).toBe('failed');
  });
});
