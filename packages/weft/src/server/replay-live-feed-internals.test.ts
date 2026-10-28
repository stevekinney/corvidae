import { describe, expect, it } from 'bun:test';

import { armAndWait, createDurableSubscription } from './replay-live-feed-internals.ts';
import type { ReplayLiveFeedBackend, SequencedEventEnvelope } from './workflow-event-feed.ts';

type Envelope = SequencedEventEnvelope;

function emptyBackend(): ReplayLiveFeedBackend<Envelope> {
  return {
    async *replay() {},
    snapshotTailSequence: async () => -1,
    subscribeLive: () => () => {},
  };
}

describe('createDurableSubscription', () => {
  it('ends the subscription when the per-call signal aborts and no lifecycle signal is set', async () => {
    const controller = new AbortController();
    const subscription = createDurableSubscription(
      emptyBackend(),
      { pollIntervalMs: 60_000 },
      { signal: controller.signal },
    );
    const iterator = subscription[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();

    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it('ends the subscription when either the per-call or the lifecycle signal aborts', async () => {
    const lifecycle = new AbortController();
    const caller = new AbortController();
    const subscription = createDurableSubscription(
      emptyBackend(),
      { pollIntervalMs: 60_000, lifecycleSignal: lifecycle.signal },
      { signal: caller.signal },
    );
    const iterator = subscription[Symbol.asyncIterator]();
    const pending = iterator.next();
    lifecycle.abort();

    expect(await pending).toEqual({ done: true, value: undefined });
  });
});

describe('armAndWait', () => {
  const unusedEnvelope: Envelope = { sequence: 1, cursor: '1' };

  it('returns at once and withdraws the waker when an envelope is already buffered', async () => {
    const installed: Array<(() => void) | null> = [];
    await armAndWait(
      [unusedEnvelope],
      () => false,
      undefined,
      (waker) => installed.push(waker),
    );

    expect(installed).toHaveLength(2);
    expect(typeof installed[0]).toBe('function');
    expect(installed[1]).toBeNull();
  });

  it('returns at once and withdraws the waker when the buffer already overflowed', async () => {
    const installed: Array<(() => void) | null> = [];
    await armAndWait(
      [],
      () => true,
      undefined,
      (waker) => installed.push(waker),
    );

    expect(installed.at(-1)).toBeNull();
  });

  it('returns at once and withdraws the waker when the signal already aborted', async () => {
    const installed: Array<(() => void) | null> = [];
    await armAndWait(
      [],
      () => false,
      AbortSignal.abort(),
      (waker) => installed.push(waker),
    );

    expect(installed.at(-1)).toBeNull();
  });

  it('parks until the installed waker fires', async () => {
    let wake: (() => void) | null = null;
    let settled = false;
    const parked = armAndWait(
      [],
      () => false,
      undefined,
      (waker) => {
        wake = waker;
      },
    ).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    wake!();
    await parked;
    expect(settled).toBe(true);
  });
});
