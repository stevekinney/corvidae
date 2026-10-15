import { describe, expect, test } from 'bun:test';

import { rig, type Rig } from './transport-test-support.ts';
import type { TerminalTransportEvent } from './transport-types.ts';

const encoder = new TextEncoder();

async function connectFailure(attempt: Promise<unknown>): Promise<string> {
  try {
    await attempt;
  } catch (error) {
    return (error as { reason: string }).reason;
  }
  return 'connected';
}

function output(
  subject: Rig,
  text: string | Uint8Array,
  channel: 'pty' | 'stdout' | 'stderr' = 'pty',
) {
  subject.serve(subject.host.output(channel, text));
}

/** The cumulative byte counts the client has reported parsed, in order. */
function consumed(subject: Rig): number[] {
  return subject
    .fromClient()
    .flatMap((message) => (message.kind === 'output-consumed' ? [message.consumedBytes] : []));
}

describe('output', () => {
  test('reaches a subscriber in order, with the exact bytes', async () => {
    const subject = rig();
    await subject.attach();
    const chunks: Uint8Array[] = [];
    subject.client.subscribeOutput((chunk) => chunks.push(chunk));
    output(subject, new Uint8Array([0x80, 0xff, 0x00]));
    output(subject, 'second');
    expect([...(chunks[0] as Uint8Array)]).toEqual([0x80, 0xff, 0x00]);
    expect(new TextDecoder().decode(chunks[1])).toBe('second');
  });

  test('is never acknowledged by being received: only the parse report acknowledges it', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'abc');
    output(subject, 'defg');
    expect(consumed(subject)).toEqual([]);
    expect(subject.client.state).toBe('writable');
    (parsers[0] as () => void)();
    expect(consumed(subject)).toEqual([3]);
    (parsers[1] as () => void)();
    expect(consumed(subject)).toEqual([7]);
  });

  test('counts UTF-8 bytes, not characters, so a multi-byte chunk acknowledges its own length', async () => {
    const subject = rig();
    await subject.attach();
    const text = 'héllo → 世界 😀';
    const bytes = encoder.encode(text);
    expect(bytes.length).toBeGreaterThan(text.length);
    subject.client.subscribeOutput((_chunk, parsed) => parsed());
    output(subject, bytes);
    expect(consumed(subject)).toEqual([bytes.length]);
  });

  test('acknowledges a late parse in order, never ahead of an earlier chunk', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'one');
    output(subject, 'two');
    output(subject, 'three');
    (parsers[2] as () => void)();
    (parsers[1] as () => void)();
    expect(consumed(subject)).toEqual([]);
    (parsers[0] as () => void)();
    expect(consumed(subject)).toEqual([11]);
  });

  test('a parse reported twice acknowledges once', async () => {
    const subject = rig();
    await subject.attach();
    subject.client.subscribeOutput((_chunk, parsed) => {
      parsed();
      parsed();
    });
    output(subject, 'abc');
    expect(consumed(subject)).toEqual([3]);
  });

  test('an empty chunk has nothing to acknowledge and nothing to parse', async () => {
    const subject = rig();
    await subject.attach();
    const chunks: Uint8Array[] = [];
    subject.client.subscribeOutput((chunk) => chunks.push(chunk));
    output(subject, new Uint8Array(0));
    expect(chunks).toEqual([]);
    expect(consumed(subject)).toEqual([]);
  });

  test('with several subscribers, a chunk is acknowledged when all of them parsed it', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'abcd');
    (parsers[0] as () => void)();
    expect(consumed(subject)).toEqual([]);
    (parsers[1] as () => void)();
    expect(consumed(subject)).toEqual([4]);
  });

  test('is held while nothing is subscribed and delivered, in order, to the first subscriber', async () => {
    const subject = rig();
    await subject.attach();
    output(subject, 'before');
    output(subject, ' subscribing');
    expect(consumed(subject)).toEqual([]);
    const chunks: string[] = [];
    subject.client.subscribeOutput((chunk, parsed) => {
      chunks.push(new TextDecoder().decode(chunk));
      parsed();
    });
    expect(chunks).toEqual(['before', ' subscribing']);
    expect(consumed(subject)).toEqual([6, 18]);
    output(subject, '!');
    expect(chunks).toEqual(['before', ' subscribing', '!']);
  });

  test('held output is bounded by the host budget, and past it the connection fails closed', async () => {
    const subject = rig({ maximumPendingOutputBytes: 10 });
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    output(subject, '0123456789');
    expect(subject.client.state).toBe('writable');
    output(subject, 'x');
    expect(subject.client.state).toBe('failed');
    expect(subject.socket().closes).toEqual([1011]);
    expect(events).toContainEqual({
      type: 'transport-error',
      cause: 'protocol',
      failure: 'transport-failed',
    });
  });

  test('an unsubscribed listener hears no more, and what it never parsed is never acknowledged', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    const stop = subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'abc');
    stop();
    output(subject, 'def');
    expect(parsers).toHaveLength(1);
    expect(consumed(subject)).toEqual([]);
  });

  test('a parse reported after the transport ended sends nothing', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'abc');
    subject.socket().drop(1006);
    const sentBefore = subject.socket().sent.length;
    (parsers[0] as () => void)();
    expect(subject.socket().sent.length).toBe(sentBefore);
  });

  test('a parse reported after the cleanup result sends nothing', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'abc');
    subject.serve(subject.host.cleanupResult('complete'));
    const sentBefore = subject.socket().sent.length;
    (parsers[0] as () => void)();
    expect(subject.socket().sent.length).toBe(sentBefore);
  });

  test('output is still acknowledged after the process exits, so the host can finish draining', async () => {
    const subject = rig();
    await subject.attach();
    const parsers: (() => void)[] = [];
    subject.client.subscribeOutput((_chunk, parsed) => parsers.push(parsed));
    output(subject, 'last words');
    subject.serve(subject.host.processExit(0, null));
    (parsers[0] as () => void)();
    expect(consumed(subject)).toEqual([10]);
  });

  test('a listener that throws revokes the attachment: the socket closes and the state is failed', async () => {
    const subject = rig();
    await subject.attach();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.client.subscribeOutput(() => {
      throw new Error('the renderer exploded');
    });
    output(subject, 'abc');
    expect(subject.client.state).toBe('failed');
    expect(subject.socket().closes).toEqual([1011]);
    expect(events).toContainEqual({ type: 'transport-error', cause: 'callback-failed' });
  });

  test('a state listener that throws does the same, once, however many changes follow', async () => {
    const subject = rig();
    const events: TerminalTransportEvent[] = [];
    subject.client.subscribe((event) => events.push(event));
    subject.client.subscribeState(() => {
      throw new Error('the view exploded');
    });
    const connected = subject.client.connect();
    expect(subject.client.state).toBe('failed');
    expect(await connectFailure(connected)).toBe('protocol');
    expect(subject.sockets).toEqual([]);
    expect(events.filter((event) => event.type === 'transport-error')).toHaveLength(1);
  });

  test('an event listener that throws does the same', async () => {
    const subject = rig();
    await subject.attach();
    subject.client.subscribe((event) => {
      if (event.type === 'operation-ack') throw new Error('the listener exploded');
    });
    void subject.client.sendInput('x');
    subject.fromClient();
    subject.serve(subject.host.acknowledgeOperation(1));
    expect(subject.client.state).toBe('failed');
  });
});
