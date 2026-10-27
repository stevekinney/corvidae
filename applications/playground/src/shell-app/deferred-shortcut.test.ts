/// <reference lib="dom" />
import { describe, expect, it } from 'bun:test';

import { attachDeferredShortcut } from './deferred-shortcut.ts';

/** Let every already-queued promise reaction run. */
// load-proof: the hydrate callbacks are in-memory promises, so every reaction settles inside the microtask queue
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function setup(options: {
  hydrate: () => Promise<void>;
  attachOnHydrate?: boolean;
  signal?: AbortSignal;
}) {
  const target = new EventTarget() as unknown as Window;
  const errors: unknown[] = [];
  let activations = 0;
  let hydrationCalls = 0;
  let listenerAttached = false;
  attachDeferredShortcut(target, {
    matches: (event) => event.key === 'k' && event.metaKey,
    hydrate: async () => {
      hydrationCalls += 1;
      await options.hydrate();
      if (options.attachOnHydrate ?? true) listenerAttached = true;
    },
    isLiveListenerAttached: () => listenerAttached,
    activate: () => {
      activations += 1;
    },
    onError: (error) => errors.push(error),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const press = (init: KeyboardEventInit = { key: 'k', metaKey: true }) => {
    const event = new KeyboardEvent('keydown', { cancelable: true, ...init });
    (target as unknown as EventTarget).dispatchEvent(event);
    return event;
  };
  return {
    attachListener: () => {
      listenerAttached = true;
    },
    press,
    errors,
    activations: () => activations,
    hydrationCalls: () => hydrationCalls,
  };
}

describe('attachDeferredShortcut', () => {
  it('claims the first press, hydrates, and activates once', async () => {
    const { press, errors, activations, hydrationCalls } = setup({ hydrate: async () => {} });

    expect(press().defaultPrevented).toBe(true);
    await settle();

    expect(hydrationCalls()).toBe(1);
    expect(activations()).toBe(1);
    expect(errors).toEqual([]);
  });

  it('claims but ignores a press while hydration is in flight', async () => {
    let finish!: () => void;
    const { press, activations, hydrationCalls } = setup({
      hydrate: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });

    press();
    expect(press().defaultPrevented).toBe(true);
    finish();
    await settle();

    expect(hydrationCalls()).toBe(1);
    expect(activations()).toBe(1);
  });

  it('steps aside after hydration so the hydrated listener alone handles presses', async () => {
    const { press, activations, hydrationCalls } = setup({ hydrate: async () => {} });

    press();
    await settle();
    const later = press();
    await settle();

    expect(later.defaultPrevented).toBe(false);
    expect(hydrationCalls()).toBe(1);
    expect(activations()).toBe(1);
  });

  it('keeps handling presses after hydration until the live listener is attached', async () => {
    const { attachListener, press, activations } = setup({
      hydrate: async () => {},
      attachOnHydrate: false,
    });

    press();
    await settle();
    expect(activations()).toBe(1);

    // Hydration has finished but the page's listener is not attached yet: a
    // press in that gap is still claimed and handled, not lost.
    expect(press().defaultPrevented).toBe(true);
    await settle();
    expect(activations()).toBe(2);

    attachListener();
    expect(press().defaultPrevented).toBe(false);
    await settle();
    expect(activations()).toBe(2);
  });

  it('leaves other keys alone', async () => {
    const { press, hydrationCalls } = setup({ hydrate: async () => {} });

    expect(press({ key: 'j', metaKey: true }).defaultPrevented).toBe(false);
    await settle();

    expect(hydrationCalls()).toBe(0);
  });

  it('reports a failed attempt and lets the next press try again', async () => {
    let attempt = 0;
    const failure = new Error('chunk request dropped');
    const { press, errors, activations, hydrationCalls } = setup({
      hydrate: async () => {
        attempt += 1;
        if (attempt === 1) throw failure;
      },
    });

    press();
    await settle();
    expect(errors).toEqual([failure]);
    expect(activations()).toBe(0);

    press();
    await settle();
    expect(hydrationCalls()).toBe(2);
    expect(activations()).toBe(1);
  });

  it('does not activate when the page was swapped out while the shell hydrated', async () => {
    const controller = new AbortController();
    let finish!: () => void;
    const { press, activations } = setup({
      hydrate: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      signal: controller.signal,
    });

    press();
    controller.abort();
    finish();
    await settle();

    expect(activations()).toBe(0);
  });
});
