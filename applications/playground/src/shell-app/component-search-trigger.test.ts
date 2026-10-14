/// <reference lib="dom" />
/**
 * Lifecycle tests for the "Search components" trigger (`component-search.svelte`).
 *
 * The palette module is replaced by `component-search-palette-fixture.svelte`
 * through the trigger's `loadPaletteModule` prop, so these tests observe loading,
 * failure, retry, and opening without a bundler or a real CommandPalette.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

// Install the shared happy-dom globals before @testing-library/svelte loads.
setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: ComponentSearch } = await import('./component-search.svelte');
const fixtureModule = (await import('./component-search-palette-fixture.svelte')) as unknown as {
  default: unknown;
  paletteFixtureLedger: { mounts: number; opens: number };
};
const { paletteFixtureLedger } = fixtureModule;

type PaletteModule = { default: unknown };

/** Let queued promise reactions, timers, and Svelte effects run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await tick();
  }
}

function pressShortcut(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'k',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event;
}

function triggerButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[data-component-search-trigger]');
  if (button === null) throw new Error('The search trigger is not rendered.');
  return button;
}

function openFixture(): HTMLElement | null {
  return document.querySelector('[data-testid="palette-fixture"][data-open]');
}

/**
 * Count net listener registrations on `window` and `document` by event type,
 * by wrapping each target's own `addEventListener`/`removeEventListener`.
 */
function trackListeners() {
  const counts = new Map<string, number>();
  const targets = [
    ['window', window],
    ['document', document],
  ] as const;
  for (const [name, target] of targets) {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    const registered = new Set<unknown>();
    Object.defineProperty(target, 'addEventListener', {
      configurable: true,
      value: (type: string, listener: unknown, options?: unknown) => {
        const key = `${name}:${type}`;
        if (!registered.has(listener)) {
          registered.add(listener);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        return add(type, listener as EventListener, options as AddEventListenerOptions);
      },
    });
    Object.defineProperty(target, 'removeEventListener', {
      configurable: true,
      value: (type: string, listener: unknown, options?: unknown) => {
        const key = `${name}:${type}`;
        if (registered.delete(listener)) counts.set(key, (counts.get(key) ?? 0) - 1);
        return remove(type, listener as EventListener, options as EventListenerOptions);
      },
    });
  }
  return {
    counts: () => Object.fromEntries([...counts].filter(([, count]) => count !== 0)),
    restore: () => {
      for (const [, target] of targets) {
        Reflect.deleteProperty(target, 'addEventListener');
        Reflect.deleteProperty(target, 'removeEventListener');
      }
    },
  };
}

describe('component-search trigger', () => {
  let originalConsoleError: typeof console.error;
  let loggedErrors: unknown[][];

  beforeEach(() => {
    paletteFixtureLedger.mounts = 0;
    paletteFixtureLedger.opens = 0;
    loggedErrors = [];
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      loggedErrors.push(args);
    };
  });

  afterEach(() => {
    console.error = originalConsoleError;
    document.body.replaceChildren();
  });

  function mount(loadPaletteModule: () => Promise<PaletteModule>) {
    return render(ComponentSearch, {
      components: ['alert', 'button'],
      loadPaletteModule,
    } as never);
  }

  test('renders the dialog trigger with its accessible name and shortcut hints', async () => {
    const { unmount } = mount(async () => fixtureModule);
    await settle();

    const button = triggerButton();
    expect(button.textContent?.trim()).toBe('Search components');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K');
    expect(button.hasAttribute('data-component-search-listening')).toBe(true);
    // Nothing loads until the reader reaches for the palette.
    expect(paletteFixtureLedger.mounts).toBe(0);

    unmount();
  });

  test('mounting then unmounting leaves the window and document listener counts unchanged', async () => {
    const listeners = trackListeners();
    try {
      const { unmount } = mount(async () => fixtureModule);
      await settle();
      expect(listeners.counts()['window:keydown']).toBe(1);

      pressShortcut();
      await settle();
      expect(openFixture()).not.toBeNull();

      unmount();
      await settle();
      expect(listeners.counts()).toEqual({});
    } finally {
      listeners.restore();
    }
  });

  test('two rapid shortcut presses load the palette once and open it once', async () => {
    let loads = 0;
    const { unmount } = mount(async () => {
      loads += 1;
      return fixtureModule;
    });
    await settle();

    const first = pressShortcut();
    const second = pressShortcut();
    await settle();

    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    expect(loads).toBe(1);
    expect(paletteFixtureLedger.mounts).toBe(1);
    expect(paletteFixtureLedger.opens).toBe(1);
    expect(openFixture()).not.toBeNull();

    unmount();
  });

  test('a rejected palette load is reported, and the next activation retries it', async () => {
    let loads = 0;
    const failure = new Error('chunk request dropped');
    const { unmount } = mount(async () => {
      loads += 1;
      if (loads === 1) throw failure;
      return fixtureModule;
    });
    await settle();

    triggerButton().click();
    await settle();
    expect(openFixture()).toBeNull();
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]?.[1]).toBe(failure);

    triggerButton().click();
    await settle();
    expect(loads).toBe(2);
    expect(openFixture()).not.toBeNull();
    expect(paletteFixtureLedger.opens).toBe(1);

    unmount();
  });
});
