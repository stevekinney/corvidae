import { ClientEndpoint } from '@lostgradient/ventriloquist';
import { afterEach, describe, expect, test } from 'bun:test';

import { createFakeInputEngine, createInputSettings } from '../input/input-test-support.ts';
import type { InputRefusal } from '../input/input-types.ts';
import { createTerminalInput } from '../input/terminal-input.ts';
import { WRITABLE, rig, type Rig } from './transport-test-support.ts';
import type { TerminalTransportState } from './transport-types.ts';

const decoder = new TextDecoder();

/** A client whose host advertises a small operation window, so it can be filled in a few keystrokes. */
async function windowOf(size: number): Promise<Rig> {
  const subject = rig({}, { maxQueuedOperations: size });
  await subject.attach();
  return subject;
}

/** The input text the host has received, in order. */
function typed(subject: Rig): string[] {
  return subject
    .fromClient()
    .flatMap((message) => (message.kind === 'input' ? [decoder.decode(message.payload)] : []));
}

describe('the operation window', () => {
  test('a full window refuses the next input locally, sends nothing for it, and reports backpressured', async () => {
    const subject = await windowOf(3);
    const states: TerminalTransportState[] = [];
    subject.client.subscribeState((state) => states.push(state));
    for (const text of ['a', 'b', 'c']) {
      expect(subject.client.input.input(new TextEncoder().encode(text)).ok).toBe(true);
    }
    expect(subject.client.state).toBe('writable');
    const refused = subject.client.input.input(new TextEncoder().encode('d'));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure).toMatchObject({ code: 'fifo-full', reason: 'operation-window-full' });
    }
    expect(subject.client.state).toBe('backpressured');
    expect(states).toEqual(['backpressured']);
    expect(typed(subject)).toEqual(['a', 'b', 'c']);
  });

  test('stays backpressured, and sends nothing, for as long as nothing is acknowledged', async () => {
    const subject = await windowOf(2);
    subject.client.input.input(new TextEncoder().encode('a'));
    subject.client.input.input(new TextEncoder().encode('b'));
    subject.client.input.input(new TextEncoder().encode('c'));
    const sentBefore = subject.socket().sent.length;
    const refusedAgain = subject.client.input.input(new TextEncoder().encode('d'));
    expect(refusedAgain.ok).toBe(false);
    if (!refusedAgain.ok) expect(refusedAgain.failure.code).toBe('fifo-full');
    expect(subject.socket().sent.length).toBe(sentBefore);
    expect(subject.client.state).toBe('backpressured');
  });

  test('an acknowledgement frees the window and returns the state to writable', async () => {
    const subject = await windowOf(2);
    subject.client.input.input(new TextEncoder().encode('a'));
    subject.client.input.input(new TextEncoder().encode('b'));
    subject.client.input.input(new TextEncoder().encode('c'));
    expect(subject.client.state).toBe('backpressured');
    const states: TerminalTransportState[] = [];
    subject.client.subscribeState((state) => states.push(state));
    subject.fromClient();
    subject.serve(subject.host.acknowledgeOperation(1));
    expect(subject.client.state).toBe('writable');
    expect(states).toEqual(['writable']);
    expect(subject.client.input.input(new TextEncoder().encode('e')).ok).toBe(true);
    expect(typed(subject)).toEqual(['e']);
  });

  test('a refused keystroke is not queued: after the window frees only new input is sent', async () => {
    const subject = await windowOf(2);
    for (const text of ['a', 'b', 'refused'])
      subject.client.input.input(new TextEncoder().encode(text));
    subject.fromClient();
    subject.serve(subject.host.acknowledgeOperation(1));
    subject.serve(subject.host.acknowledgeOperation(2));
    subject.client.input.input(new TextEncoder().encode('later'));
    expect(typed(subject)).toEqual(['later']);
    expect(
      subject
        .socket()
        .sent.map((frame) => (typeof frame === 'string' ? '' : decoder.decode(frame)))
        .join(''),
    ).not.toContain('refused');
  });

  test('a resize is refused while backpressured too', async () => {
    const subject = await windowOf(1);
    subject.client.input.input(new TextEncoder().encode('a'));
    subject.client.input.input(new TextEncoder().encode('b'));
    expect(subject.client.state).toBe('backpressured');
    expect(await subject.client.sendResize(100, 40)).toMatchObject({
      status: 'refused',
      code: 'fifo-full',
    });
  });

  test('sendInput reports the local refusal as fifo-full and moves to backpressured', async () => {
    const subject = await windowOf(1);
    void subject.client.sendInput('a');
    expect(await subject.client.sendInput('b')).toMatchObject({
      status: 'refused',
      code: 'fifo-full',
    });
    expect(subject.client.state).toBe('backpressured');
  });
});

describe('a host that refuses with fifo-full', () => {
  test('a refusal by the host is backpressured, and the next acknowledgement is the way back', async () => {
    const subject = await windowOf(8);
    const first = subject.client.sendInput('a');
    const second = subject.client.sendInput('b');
    const third = subject.client.sendInput('c');
    subject.fromClient();
    subject.serve(subject.host.acknowledgeOperation(1));
    subject.serve(subject.host.failOperation(2, 'fifo-full', 'input-overflow'));
    expect(await first).toMatchObject({ status: 'accepted' });
    expect(await second).toEqual({ status: 'failed', sequence: 2, code: 'fifo-full' });
    expect(subject.client.state).toBe('backpressured');
    // The refusal itself is not an acknowledgement: the state holds until one arrives.
    subject.serve(subject.host.acknowledgeOperation(3));
    expect(await third).toMatchObject({ status: 'accepted', sequence: 3 });
    expect(subject.client.state).toBe('writable');
  });

  test('with nothing else in flight the host sends nothing that frees it, so the state holds', async () => {
    const subject = await windowOf(8);
    const sending = subject.client.sendInput('a');
    subject.fromClient();
    subject.serve(subject.host.failOperation(1, 'fifo-full', 'input-overflow'));
    await sending;
    expect(subject.client.state).toBe('backpressured');
    expect(subject.client.input.input(new TextEncoder().encode('b')).ok).toBe(false);
  });

  test('a refusal that arrives while not writable changes nothing', async () => {
    const subject = await windowOf(8);
    const sending = subject.client.sendInput('a');
    subject.fromClient();
    subject.serve(subject.host.processExit(0, null));
    subject.serve(subject.host.failOperation(1, 'fifo-full', 'late'));
    await sending;
    expect(subject.client.state).toBe('exited');
  });
});

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

/** The terminal's own input path, bound to a fake engine, over this client. */
function bindTerminal(subject: Rig) {
  const element = document.createElement('div');
  document.body.append(element);
  hosts.push(element);
  const engine = createFakeInputEngine();
  const refusals: InputRefusal[] = [];
  const input = createTerminalInput({
    engine,
    host: element,
    controller: subject.client.input,
    // The view is writable only while the transport says so.
    readSettings: () => createInputSettings({ writable: subject.client.state === 'writable' }),
    onCaptureChange: () => {},
    onReview: () => {},
    onRefused: (refusal) => refusals.push(refusal),
  });
  // The component refreshes the input path on the reactive update that follows a state change,
  // which is after the refusal that caused it has been handled.
  subject.client.subscribeState(() => queueMicrotask(() => input.refresh()));
  return { engine, refusals };
}

describe('with the terminal input path', () => {
  test('a keystroke typed while paused is held, and typing after the window frees is delivered', async () => {
    const subject = await windowOf(2);
    const { engine, refusals } = bindTerminal(subject);
    engine.report({ kind: 'text', data: 'a' });
    engine.report({ kind: 'text', data: 'b' });
    // The window is full: this keystroke is refused, and the transport pauses the view.
    engine.report({ kind: 'text', data: 'c' });
    await Promise.resolve();
    expect(subject.client.state).toBe('backpressured');
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['paused']);
    // Typed while paused: held back, not sent and not queued.
    engine.report({ kind: 'text', data: 'd' });
    expect(typed(subject)).toEqual(['a', 'b']);
    // The acknowledgement frees the window and the view returns to writable.
    subject.serve(subject.host.acknowledgeOperation(1));
    await Promise.resolve();
    expect(subject.client.state).toBe('writable');
    engine.report({ kind: 'text', data: 'e' });
    expect(typed(subject)).toEqual(['e']);
    expect(refusals.map((refusal) => refusal.reason)).toEqual(['paused', 'read-only']);
  });

  test('the terminal stays paused until it has seen the state leave writable and come back', async () => {
    const subject = await windowOf(1);
    const { engine } = bindTerminal(subject);
    engine.report({ kind: 'text', data: 'a' });
    engine.report({ kind: 'text', data: 'b' });
    await Promise.resolve();
    expect(subject.client.state).toBe('backpressured');
    engine.report({ kind: 'text', data: 'c' });
    expect(typed(subject)).toEqual(['a']);
    subject.serve(subject.host.acknowledgeOperation(1));
    // Writable again, but the terminal has not yet seen the view leave and return.
    engine.report({ kind: 'text', data: 'd' });
    expect(typed(subject)).toEqual([]);
    await Promise.resolve();
    engine.report({ kind: 'text', data: 'e' });
    expect(typed(subject)).toEqual(['e']);
  });
});

test('the endpoint used here is the real protocol client', () => {
  expect(
    new ClientEndpoint({ sessionId: 'x', requestedMode: 'interactive', token: 't' }).phase,
  ).toBe('idle');
  expect(WRITABLE.input).toBe(true);
});
