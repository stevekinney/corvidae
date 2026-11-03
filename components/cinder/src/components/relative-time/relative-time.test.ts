/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { renderSvelteOnServer, setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: RelativeTime } = await import('./relative-time.svelte');
// createRawSnippet must be imported dynamically so Bun's svelte plugin (which patches
// the svelte package to resolve to the client build) applies before this import resolves.
// A top-level static import of 'svelte' resolves to svelte/index-server.js in Bun's
// non-browser environment, making `mount()` throw "not available on the server".
const { createRawSnippet } = await import('svelte');
const relativeTimeSource = new URL('./relative-time.svelte', import.meta.url).pathname;
// Server rendering spawns a Bun process, so it runs once at module scope, off bun's per-test clock.
const relativeTimeServerHtml = await renderSvelteOnServer(relativeTimeSource, {
  date: Date.UTC(2026, 0, 1, 12),
  locale: 'en',
  tick: false,
});

afterEach(cleanup);

/** Creates a Svelte 5 Snippet that renders text content. */
function textSnippet(text: string) {
  return createRawSnippet(() => ({
    render: () => `<span>${text}</span>`,
  }));
}

describe('RelativeTime', () => {
  test('renders the cinder-relative-time wrapper with its children', () => {
    const { container } = render(RelativeTime, { children: textSnippet('content') });
    const element = container.querySelector('.cinder-relative-time');
    expect(element).not.toBeNull();
    expect(element?.textContent).toContain('content');
  });

  test('merges a custom class alongside cinder-relative-time', () => {
    const { container } = render(RelativeTime, {
      children: textSnippet('content'),
      class: 'my-custom-class',
    });
    const element = container.querySelector('.cinder-relative-time');
    expect(element?.getAttribute('class')).toContain('cinder-relative-time');
    expect(element?.getAttribute('class')).toContain('my-custom-class');
  });

  test('reads past and future deltas on the shared design format', () => {
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 0, 2, 18);
    try {
      const past = render(RelativeTime, {
        date: Date.UTC(2026, 0, 2, 17),
        locale: 'en',
        timeZone: 'America/Chicago',
        tick: false,
      });
      expect(past.container.querySelector('time')?.textContent).toBe('1 h ago');
      past.unmount();
      const minutes = render(RelativeTime, {
        date: Date.UTC(2026, 0, 2, 17, 56),
        locale: 'en',
        timeZone: 'America/Chicago',
        tick: false,
      });
      expect(minutes.container.querySelector('time')?.textContent).toBe('4 min ago');
      minutes.unmount();
      const future = render(RelativeTime, {
        date: Date.UTC(2026, 0, 2, 20),
        locale: 'en',
        timeZone: 'America/Chicago',
        tick: false,
      });
      expect(future.container.querySelector('time')?.textContent).toBe('in 2 h');
    } finally {
      Date.now = realNow;
    }
  });

  test('reads yesterday as a clock time in the given zone', () => {
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 10, 2, 16, 46);
    try {
      const view = render(RelativeTime, {
        date: Date.UTC(2026, 10, 1, 22, 12),
        timeZone: 'America/Chicago',
        locale: 'en-US',
        tick: false,
      });
      expect(view.container.querySelector('time')?.textContent).toBe('Yesterday, 4:12 PM');
    } finally {
      Date.now = realNow;
    }
  });

  test('absolute format never reads relative and puts the relative reading in the tooltip', () => {
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 10, 2, 16, 46);
    try {
      const view = render(RelativeTime, {
        date: Date.UTC(2026, 10, 2, 16, 44),
        format: 'absolute',
        timeZone: 'America/Chicago',
        locale: 'en-US',
        tick: false,
      });
      const element = view.container.querySelector('time');
      expect(element?.textContent).toBe('Today, 10:44 AM');
      expect(element?.getAttribute('title')).toBe('2 min ago');
    } finally {
      Date.now = realNow;
    }
  });

  test('relative format carries the full dated reading in the tooltip', () => {
    const realNow = Date.now;
    Date.now = () => Date.UTC(2026, 10, 2, 16, 46);
    try {
      const view = render(RelativeTime, {
        date: Date.UTC(2026, 10, 1, 22, 12),
        timeZone: 'America/Chicago',
        locale: 'en-US',
        tick: false,
      });
      expect(view.container.querySelector('time')?.getAttribute('title')).toMatch(
        /^Sunday, November 1, 2026.*4:12.PM CST$/,
      );
    } finally {
      Date.now = realNow;
    }
  });

  test('an explicit title replaces the tooltip', () => {
    const { container } = render(RelativeTime, { date: Date.now(), title: 'Sent', tick: false });
    expect(container.querySelector('time')?.getAttribute('title')).toBe('Sent');
  });

  test('defers the clock-derived label until after mounting', () => {
    const source = readFileSync(new URL('./relative-time.svelte', import.meta.url), 'utf8');

    expect(source).toContain('const initialNow = Date.now();');
    expect(source).toContain('let now = $state(initialNow);');
    expect(source).toContain('hasMounted = true;');
    expect(source).toContain("{hasMounted ? label : ''}");
  });

  test('server-renders a stable semantic time before the relative label mounts', () => {
    const html = relativeTimeServerHtml;
    expect(html).toContain('datetime="2026-01-01T12:00:00.000Z"');
    expect(html).not.toContain('Yesterday');
    expect(html).not.toContain('just now');
    expect(html).not.toContain('title=');
  });

  test.each([new Date('invalid'), 'not-a-date'])('renders invalid dates safely: %s', (date) => {
    const { container } = render(RelativeTime, { date, tick: false });
    const element = container.querySelector('time');
    expect(element?.textContent).toBe('Invalid date');
    expect(element?.hasAttribute('datetime')).toBe(false);
  });

  test('shares an adaptive clock across mounted instances', () => {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    let scheduleCount = 0;
    const scheduledDelays: number[] = [];
    let clearCount = 0;
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      scheduleCount += 1;
      scheduledDelays.push(delay ?? 0);
      return originalSetTimeout(callback, delay);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timer?: number) => {
      clearCount += 1;
      return originalClearTimeout(timer);
    }) as typeof window.clearTimeout;

    try {
      const oldDate = Date.now() - 2 * 60 * 60 * 1_000;
      const first = render(RelativeTime, { date: oldDate });
      const second = render(RelativeTime, { date: oldDate });
      expect(scheduleCount).toBe(2);
      expect(scheduledDelays.at(-1)).toBeGreaterThan(299_000);
      expect(scheduledDelays.at(-1)).toBeLessThanOrEqual(300_000);
      first.unmount();
      expect(clearCount).toBe(2);
      second.unmount();
      expect(clearCount).toBe(3);
    } finally {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });

  test('resubscribes when a bound timestamp changes its cadence', async () => {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const scheduledDelays: number[] = [];
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      return originalSetTimeout(callback, delay);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timer?: number) =>
      originalClearTimeout(timer)) as typeof window.clearTimeout;

    try {
      const view = render(RelativeTime, { date: Date.now() - 2 * 60 * 60 * 1_000 });
      await view.rerender({ date: Date.now() });
      expect(scheduledDelays.at(-1)).toBeLessThanOrEqual(60_001);
      view.unmount();
    } finally {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });

  test('schedules at the next whole minute of the displayed age', () => {
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;
    const scheduledDelays: number[] = [];
    window.setTimeout = ((callback: TimerHandler, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      return originalSetTimeout(callback, delay);
    }) as typeof window.setTimeout;
    window.clearTimeout = ((timer?: number) =>
      originalClearTimeout(timer)) as typeof window.clearTimeout;

    try {
      const renderedAt = Date.now();
      // 90 seconds old: the label turns from "1 min ago" to "2 min ago" 30 seconds from now.
      const view = render(RelativeTime, { date: renderedAt - 90_000 });
      const elapsed = Date.now() - renderedAt;
      expect(scheduledDelays.at(-1)).toBeGreaterThan(30_000 - elapsed - 5);
      expect(scheduledDelays.at(-1)).toBeLessThanOrEqual(30_001);
      view.unmount();
    } finally {
      window.setTimeout = originalSetTimeout;
      window.clearTimeout = originalClearTimeout;
    }
  });
});
