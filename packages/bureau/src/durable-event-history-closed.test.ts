/**
 * COR-1594, correction 3 — `DurableEventHistorySubscribeOptions.onClosed` tells a subscriber that
 * its subscription ended because of an error, so it can stop trusting it: once for an error close,
 * and never for the subscriber's own `unsubscribe()` or an abort of its signal.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createFleetEventFeed,
  KEYS,
  resolveStorage,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { createDurableEventHistory, type DurableEventHistory } from './durable-event-history';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const owner = { kind: 'run', id: 'run-1' } as const;

async function openHistory() {
  const storage = await resolveStorage({ type: 'memory' });
  const diagnostics: string[] = [];
  const history: DurableEventHistory = createDurableEventHistory(
    storage,
    createManualRuntimeServices(),
    (diagnostic) => diagnostics.push(diagnostic.message),
  );
  cleanups.push(() => history.dispose());
  return { storage, history, diagnostics };
}

/** Lets the subscription's loop run to its end, with no timer. */
async function settleSubscription(subscription: { readonly closed: boolean }): Promise<void> {
  for (let turn = 0; turn < 200 && !subscription.closed; turn += 1) {
    await yieldToPortableEventLoop();
  }
  for (let turn = 0; turn < 10; turn += 1) await yieldToPortableEventLoop();
}

describe('the close notification of a history subscription', () => {
  it('is called once, with the error, when the replay itself rejects', async () => {
    const { storage, history } = await openHistory();
    await history.record(owner, 'run.started', {});
    await storage.put(KEYS.fleetEvent(0), new Uint8Array([1, 2, 3, 4]));
    const closed: unknown[] = [];

    const subscription = history.subscribeEventHistory(owner, () => {}, {
      onClosed: (error) => closed.push(error),
    });
    await settleSubscription(subscription);

    expect(subscription.closed).toBe(true);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeInstanceOf(Error);
  });

  it('is called once when a stored record is corrupt', async () => {
    const { storage, history } = await openHistory();
    const closed: unknown[] = [];
    const subscription = history.subscribeEventHistory(owner, () => {}, {
      onClosed: (error) => closed.push(error),
    });
    // A record the history cannot decode, appended to the feed the subscription tails.
    const feed = createFleetEventFeed(storage);
    await feed.append({
      kind: 'legacy.kind',
      workflowId: 'run:run-1',
      emittedAtMs: 0,
      payload: 'not-a-wrapper',
    });
    feed.dispose();
    await settleSubscription(subscription);

    expect(subscription.closed).toBe(true);
    expect(closed).toHaveLength(1);
  });

  it('is not called when the subscriber unsubscribes', async () => {
    const { history } = await openHistory();
    const closed: unknown[] = [];
    const subscription = history.subscribeEventHistory(owner, () => {}, {
      onClosed: (error) => closed.push(error),
    });

    subscription.unsubscribe();
    await settleSubscription(subscription);

    expect(subscription.closed).toBe(true);
    expect(closed).toEqual([]);
  });

  it('is not called when the subscriber aborts its signal', async () => {
    const { history } = await openHistory();
    const closed: unknown[] = [];
    const controller = new AbortController();
    const subscription = history.subscribeEventHistory(owner, () => {}, {
      signal: controller.signal,
      onClosed: (error) => closed.push(error),
    });

    controller.abort();
    await settleSubscription(subscription);

    expect(subscription.closed).toBe(true);
    expect(closed).toEqual([]);
  });
});
