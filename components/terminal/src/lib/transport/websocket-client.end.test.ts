import { describe, expect, test } from 'bun:test';

import { rig } from './transport-test-support.ts';
import type { CleanupResult, OperationResult, TerminalTransportEvent } from './transport-types.ts';

async function outcomeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { reason: string }).reason;
  }
  return 'connected';
}

function settledValues<Value>(promises: Promise<Value>[]): Promise<Value[]> {
  return Promise.all(promises);
}

describe('a dropped transport', () => {
  test('is disconnected: input is disabled, delivery of what was unresolved is unknown, and it is reported', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    const first = subject.client.sendInput('a');
    const second = subject.client.sendResize(90, 30);
    subject.socket().drop(1006);
    expect(await settledValues<OperationResult>([first, second])).toEqual([
      { status: 'unknown', sequence: 1 },
      { status: 'unknown', sequence: 2 },
    ]);
    expect(subject.client.state).toBe('disconnected');
    expect(subject.client.authorityRevoked).toBe(true);
    expect(subject.client.deliveryUnknown).toEqual([1, 2]);
    expect(events).toContainEqual({ type: 'transport-error', cause: 'closed', closeCode: 1006 });
    expect(events).toContainEqual({ type: 'delivery-unknown', sequences: [1, 2] });
    expect(await subject.client.sendInput('b')).toMatchObject({ status: 'refused' });
  });

  test('is never reconnected: no second socket, and connect stays refused', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().drop(1006);
    expect(await outcomeOf(subject.client.connect())).toBe('already-used');
    expect(subject.sockets).toHaveLength(1);
    expect(subject.client.state).toBe('disconnected');
  });

  test('a socket error ends the transport the same way, once, even if the close follows', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.socket().fail();
    subject.socket().drop(1006);
    expect(subject.client.state).toBe('disconnected');
    expect(events.filter((event) => event.type === 'transport-error')).toEqual([
      { type: 'transport-error', cause: 'error' },
    ]);
  });

  test('the server ending the attachment with a liveness expiry is a cleanup report then a normal close', async () => {
    const subject = rig();
    await subject.attach();
    subject.serve(subject.host.cleanupResult('complete'));
    subject.socket().drop(1000);
    expect(subject.client.state).toBe('disconnected');
    expect(subject.sockets).toHaveLength(1);
  });

  test('an operation the host answered before the drop keeps its answer', async () => {
    const subject = rig();
    await subject.attach();
    const accepted = subject.client.sendInput('a');
    subject.fromClient();
    subject.serve(subject.host.acknowledgeOperation(1));
    subject.socket().drop(1006);
    expect(await accepted).toEqual({ status: 'accepted', sequence: 1 });
    expect(subject.client.deliveryUnknown).toEqual([]);
  });
});

describe('close', () => {
  test('closes the socket normally, ends the state and leaves unresolved operations unknown', async () => {
    const subject = rig();
    await subject.attach();
    const pending = subject.client.sendInput('a');
    subject.client.close();
    expect(subject.socket().closes).toEqual([1000]);
    expect(await pending).toEqual({ status: 'unknown', sequence: 1 });
    expect(subject.client.state).toBe('disconnected');
  });

  test('is idempotent, and does not report a transport error for a close it asked for', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.client.close();
    subject.client.close();
    subject.socket().drop(1000);
    expect(subject.socket().closes).toEqual([1000]);
    expect(events.map((event) => event.type)).not.toContain('transport-error');
  });

  test('survives a socket that throws when closed', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().closeThrows = true;
    subject.client.close();
    expect(subject.client.state).toBe('disconnected');
  });

  test('cancels a connection that is still opening', async () => {
    const subject = rig();
    const connected = subject.client.connect();
    subject.client.close();
    expect(await outcomeOf(connected)).toBe('closed');
    expect(subject.client.state).toBe('failed');
    expect(subject.clock.pendingTimers).toBe(0);
  });
});

describe('stop', () => {
  test('revokes authority at once, sends terminate, and resolves with the host cleanup result', async () => {
    const subject = rig();
    await subject.attach();
    let result: CleanupResult | undefined;
    const stopping = subject.client.stop().then((value) => {
      result = value;
    });
    expect(subject.client.authorityRevoked).toBe(true);
    expect(subject.fromClient()).toMatchObject([{ kind: 'terminate' }]);
    await Promise.resolve();
    expect(result).toBeUndefined();
    subject.serve(subject.host.cleanupResult('complete'));
    await stopping;
    expect(result).toEqual({ outcome: 'complete', source: 'host' });
    expect(subject.client.state).toBe('disconnected');
  });

  test('reports an incomplete cleanup as quarantine', async () => {
    const subject = rig();
    await subject.attach();
    const stopping = subject.client.stop();
    subject.serve(subject.host.cleanupResult('incomplete'));
    expect(await stopping).toEqual({ outcome: 'incomplete', source: 'host' });
    expect(subject.client.state).toBe('cleanup-incomplete');
  });

  test('stopping again after the report returns the same report', async () => {
    const subject = rig();
    await subject.attach();
    const stopping = subject.client.stop();
    subject.serve(subject.host.cleanupResult('complete'));
    const first = await stopping;
    expect(await subject.client.stop()).toBe(first);
  });

  test('is unknown when the transport ends before the host reports', async () => {
    const subject = rig();
    await subject.attach();
    const stopping = subject.client.stop();
    subject.socket().drop(1006);
    expect(await stopping).toEqual({ outcome: 'unknown', source: 'local' });
    expect(await subject.client.stop()).toEqual({ outcome: 'unknown', source: 'local' });
  });

  test('before connecting there is nothing to clean up', async () => {
    const subject = rig();
    expect(await subject.client.stop()).toEqual({ outcome: 'complete', source: 'local' });
    expect(subject.sockets).toEqual([]);
  });

  test('during the handshake leaves without an attachment to ask, and the outcome is unknown', async () => {
    const subject = rig();
    const connected = subject.client.connect();
    expect(await subject.client.stop()).toEqual({ outcome: 'unknown', source: 'local' });
    expect(await outcomeOf(connected)).toBe('closed');
  });

  test('a terminate the socket cannot send ends in unknown', async () => {
    const subject = rig();
    await subject.attach();
    subject.socket().sendThrows = true;
    expect(await subject.client.stop()).toEqual({ outcome: 'unknown', source: 'local' });
    expect(subject.client.state).toBe('disconnected');
  });

  test('can be asked after an exit, to collect the cleanup', async () => {
    const subject = rig();
    await subject.attach();
    subject.serve(subject.host.processExit(0, null));
    const stopping = subject.client.stop();
    subject.serve(subject.host.cleanupResult('complete'));
    expect(await stopping).toEqual({ outcome: 'complete', source: 'host' });
    expect(subject.client.state).toBe('exited');
  });
});

describe('a stop the host never answers', () => {
  test('resolves unknown once the deadline passes, and closes the socket', async () => {
    const subject = rig({ stopTimeoutMilliseconds: 5_000 });
    await subject.attach();
    const stopping = subject.client.stop();
    subject.clock.advance(4_999);
    expect(subject.socket().closes).toEqual([]);
    subject.clock.advance(1);
    expect(await stopping).toEqual({ outcome: 'unknown', source: 'local' });
    expect(subject.socket().closes).toEqual([1000]);
    expect(subject.client.state).toBe('disconnected');
    expect(subject.clock.pendingTimers).toBe(0);
  });

  test('a prompt answer cancels the deadline', async () => {
    const subject = rig({ stopTimeoutMilliseconds: 5_000 });
    await subject.attach();
    const stopping = subject.client.stop();
    subject.serve(subject.host.cleanupResult('complete'));
    expect(await stopping).toEqual({ outcome: 'complete', source: 'host' });
    expect(subject.clock.pendingTimers).toBe(0);
  });

  test('defaults to ten seconds', async () => {
    const subject = rig();
    await subject.attach();
    const stopping = subject.client.stop();
    subject.clock.advance(9_999);
    expect(subject.socket().closes).toEqual([]);
    subject.clock.advance(1);
    expect(await stopping).toMatchObject({ outcome: 'unknown' });
  });
});

describe('rendererFailed', () => {
  test('asks the host to stop, so input is revoked and cleanup runs; it does not reset or switch', async () => {
    const subject = rig();
    await subject.attach();
    subject.client.rendererFailed({ phase: 'render', message: 'the engine failed' });
    expect(subject.fromClient()).toMatchObject([{ kind: 'terminate' }]);
    expect(subject.client.authorityRevoked).toBe(true);
  });
});

describe('what an event never carries', () => {
  test('no state, event, result or error includes the ticket', async () => {
    const subject = rig({ ticket: 'ticket-that-must-never-leak' });
    const seen: string[] = [];
    subject.client.subscribe((event) => seen.push(JSON.stringify(event)));
    subject.client.subscribeState((state) => seen.push(state));
    await subject.attach();
    const pending = subject.client.sendInput('x');
    subject.socket().drop(1008);
    seen.push(JSON.stringify(await pending));
    expect(seen.join('\n')).not.toContain('ticket-that-must-never-leak');
  });
});
