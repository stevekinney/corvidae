/// <reference lib="dom" />
import { describe, expect, it } from 'bun:test';

import { attachDeferredToggle } from './deferred-toggle.ts';

/** Let every already-queued promise reaction run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function setup(options: { hydrate: () => Promise<void>; alreadyHydrated?: boolean }) {
  const toggle = document.createElement('button');
  // One entry per click event the button receives: whether the bootstrap listener
  // cancelled it. The recording listener is attached last, so it observes the outcome.
  const clicks: boolean[] = [];
  const errors: unknown[] = [];
  let hydrationCalls = 0;
  let hydrated = options.alreadyHydrated ?? false;
  attachDeferredToggle(toggle, {
    hydrate: async () => {
      hydrationCalls += 1;
      await options.hydrate();
      hydrated = true;
    },
    isHydrated: () => hydrated,
    onError: (error) => errors.push(error),
  });
  toggle.addEventListener('click', (event) => clicks.push(event.defaultPrevented));
  return { toggle, clicks, errors, hydrationCalls: () => hydrationCalls };
}

describe('attachDeferredToggle', () => {
  it('cancels the first click, hydrates, then replays the click once', async () => {
    const { toggle, clicks, errors, hydrationCalls } = setup({ hydrate: async () => {} });

    toggle.click();
    await settle();

    expect(hydrationCalls()).toBe(1);
    expect(clicks).toEqual([true, false]);
    expect(errors).toEqual([]);
  });

  it('does not start a second attempt or a second replay for a click while one is in flight', async () => {
    let finish!: () => void;
    const { toggle, clicks, hydrationCalls } = setup({
      hydrate: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });

    toggle.click();
    toggle.click();
    expect(hydrationCalls()).toBe(1);
    finish();
    await settle();

    expect(hydrationCalls()).toBe(1);
    // The first click was cancelled, the second passed through untouched, and the
    // replay is the only click hydration adds.
    expect(clicks).toEqual([true, false, false]);
  });

  it('retries on a later click after a failed hydration instead of staying inert', async () => {
    let attempts = 0;
    const { toggle, clicks, errors, hydrationCalls } = setup({
      hydrate: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('chunk request failed');
      },
    });

    toggle.click();
    await settle();
    expect(errors).toHaveLength(1);
    expect(clicks).toEqual([true]);

    toggle.click();
    await settle();

    expect(hydrationCalls()).toBe(2);
    expect(clicks).toEqual([true, true, false]);
    expect(errors).toHaveLength(1);
  });

  it('leaves clicks alone once the shell is hydrated', async () => {
    const { toggle, clicks, hydrationCalls } = setup({
      hydrate: async () => {},
      alreadyHydrated: true,
    });

    toggle.click();
    await settle();

    expect(hydrationCalls()).toBe(0);
    expect(clicks).toEqual([false]);
  });

  it('does nothing when the toolbar button is absent', () => {
    expect(() =>
      attachDeferredToggle(null, {
        hydrate: async () => {},
        isHydrated: () => false,
        onError: () => {},
      }),
    ).not.toThrow();
  });
});
