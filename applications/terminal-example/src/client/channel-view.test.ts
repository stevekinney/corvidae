import { describe, expect, test } from 'bun:test';

import type { TerminalWebSocketClient } from '@lostgradient/terminal';
import type { Capabilities, OutputChannel } from '@lostgradient/ventriloquist';

import { channelView, terminalStateFor } from './channel-view.ts';

type Listener = (chunk: Uint8Array, parsed: () => void, channel: OutputChannel) => void;

/** The part of the client a view uses: one subscription, and the failure hook. */
function fakeClient() {
  const listeners = new Set<Listener>();
  const failures: unknown[] = [];
  const client = {
    subscribeOutput(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rendererFailed: (failure: unknown) => failures.push(failure),
  } as unknown as TerminalWebSocketClient;
  return {
    client,
    failures,
    listenerCount: () => listeners.size,
    deliver(channel: OutputChannel, text: string, parsed: () => void) {
      for (const listener of listeners) listener(new TextEncoder().encode(text), parsed, channel);
    },
  };
}

describe('channelView', () => {
  test('hands a view only its own channel, and reports the other channel parsed at once', () => {
    const fake = fakeClient();
    const seen: string[] = [];
    const parsedOutput: string[] = [];
    const view = channelView(fake.client, 'stdout');
    view.subscribeOutput((chunk, parsed) => {
      seen.push(new TextDecoder().decode(chunk));
      parsed();
    });
    fake.deliver('stdout', 'out', () => parsedOutput.push('out'));
    fake.deliver('stderr', 'err', () => parsedOutput.push('err'));
    expect(seen).toEqual(['out']);
    // Both chunks were acknowledged: a view never holds the other channel's bytes.
    expect(parsedOutput).toEqual(['out', 'err']);
  });

  test('two views of one client each report every chunk, which is what the client counts', () => {
    const fake = fakeClient();
    channelView(fake.client, 'stdout').subscribeOutput((_chunk, parsed) => parsed());
    channelView(fake.client, 'stderr').subscribeOutput((_chunk, parsed) => parsed());
    let reports = 0;
    const parsed = () => {
      reports += 1;
    };
    // The client registers one release per listener, so a chunk is released only when both views
    // reported it: one parsed it, and the other passed it over.
    fake.deliver('stdout', 'a', parsed);
    expect(reports).toBe(2);
    fake.deliver('stderr', 'b', parsed);
    expect(reports).toBe(4);
  });

  test('unsubscribes, and takes no input', () => {
    const fake = fakeClient();
    const view = channelView(fake.client, 'stderr');
    const stop = view.subscribeOutput(() => undefined);
    expect(fake.listenerCount()).toBe(1);
    stop();
    expect(fake.listenerCount()).toBe(0);
    expect(view.input).toBeUndefined();
  });

  test('a view that fails closed stops the whole session', () => {
    const fake = fakeClient();
    const failure = { phase: 'render', message: 'broken' } as const;
    channelView(fake.client, 'stdout').rendererFailed(failure);
    expect(fake.failures).toEqual([failure]);
  });
});

describe('terminalStateFor', () => {
  const withInput: Capabilities = {
    mode: 'pty',
    input: true,
    resize: true,
    kill: true,
    readOnly: false,
  };
  const noInput: Capabilities = { ...withInput, mode: 'pipe', input: false, resize: false };

  test('shows a connection that was granted no input as read-only', () => {
    expect(terminalStateFor('writable', noInput)).toBe('read-only');
    expect(terminalStateFor('writable', withInput)).toBe('writable');
    expect(terminalStateFor('writable', undefined)).toBe('writable');
  });

  test('passes every other state through', () => {
    for (const state of [
      'empty',
      'connecting',
      'read-only',
      'backpressured',
      'exited',
      'disconnected',
      'denied',
      'failed',
      'cleanup-incomplete',
    ] as const) {
      expect(terminalStateFor(state, noInput)).toBe(state);
    }
  });
});
