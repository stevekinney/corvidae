/// <reference lib="dom" />
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import type { BannerPreset } from './banner-presets.ts';
import Banner from './banner.svelte';

const asOf = new Date('2026-11-02T16:44:00Z');
const facts = { dataUpdatedAt: asOf, timeZone: 'America/Chicago' };

// "Today" for the as-of time: 11:10 AM Central on the day the data loaded.
beforeEach(() => setSystemTime(new Date('2026-11-02T17:10:00Z')));

afterEach(() => {
  setSystemTime();
  cleanup();
  document.body.replaceChildren();
});

function renderPreset(preset: BannerPreset, props: Record<string, unknown> = {}) {
  const view = render(Banner, { props: { preset, ...facts, ...props } as never });
  const root = view.container.querySelector<HTMLElement>('.cinder-banner');
  if (!root) throw new Error('The banner did not render.');
  return { ...view, root };
}

function spoken(element: Element | null | undefined): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

function actionLabels(root: HTMLElement): string[] {
  return [
    ...root.querySelectorAll('.cinder-banner__actions button, .cinder-banner__actions a'),
  ].map((element) => element.textContent?.trim() ?? '');
}

describe('Banner presets: tone, name and words', () => {
  const table: [BannerPreset, string, string, string][] = [
    ['offline', 'warning', 'Connection problem', 'You’re offline. Showing what loaded as of'],
    ['unreachable', 'warning', 'Connection problem', 'Can’t reach the Interborough server.'],
    ['stopped', 'warning', 'Connection problem', 'Stopped retrying. Can’t reach'],
    ['out-of-date', 'warning', 'Connection problem', 'Can’t reach the Interborough server.'],
    ['refresh-failed', 'warning', 'Refresh problem', 'Couldn’t refresh this page.'],
    ['restarting', 'info', 'Restart status', 'Restarting Interborough. Your changes are saved.'],
    ['reconnecting', 'info', 'Restart status', 'Reconnecting… Your changes are saved.'],
    ['restart-failed', 'warning', 'Restart status', 'Interborough didn’t come back.'],
    ['back-online', 'success', 'Connection restored', 'Back online. Updated just now.'],
  ];

  for (const [preset, variant, label, start] of table) {
    test(`${preset} is ${variant}, named "${label}", and starts "${start}"`, () => {
      const { root } = renderPreset(preset);
      expect(root.getAttribute('data-cinder-preset')).toBe(preset);
      expect(root.getAttribute('data-cinder-variant')).toBe(variant);
      expect(root.getAttribute('role')).toBe('region');
      expect(root.getAttribute('aria-label')).toBe(label);
      expect(spoken(root.querySelector('.cinder-banner__content'))).toContain(start);
    });
  }

  test('every preset is non-dismissible, even when dismissible is passed', () => {
    for (const preset of [
      'offline',
      'unreachable',
      'stopped',
      'out-of-date',
      'refresh-failed',
      'restarting',
      'reconnecting',
      'restart-failed',
      'back-online',
    ] as const) {
      const { root } = renderPreset(preset, { dismissible: true });
      expect(root.querySelector('.cinder-banner__dismiss')).toBeNull();
      cleanup();
    }
  });

  test('the sentence reads in one run of text with the lead in bold', () => {
    const { root } = renderPreset('unreachable', { retryInSeconds: 4, attempt: 3 });
    const content = root.querySelector('.cinder-banner__content');
    expect(content?.querySelector('strong')?.textContent).toBe(
      'Can’t reach the Interborough server.',
    );
    expect(spoken(content)).toBe(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8).',
    );
    expect(root.querySelector('.cinder-banner__stale')).toBeNull();
  });

  test('the as-of time is absolute, never "2 min ago"', () => {
    const { root } = renderPreset('offline', { dataUpdatedAt: new Date(Date.now() - 120_000) });
    expect(root.textContent).toContain(' CST');
    expect(root.textContent).not.toContain('ago');
  });

  test('a page changes the subject and the consequence, not the preset', () => {
    const { root } = renderPreset('offline', {
      subject: 'runs',
      consequence: 'Start run is off until the connection is back.',
    });
    expect(spoken(root.querySelector('.cinder-banner__content'))).toContain(
      'Showing runs as of 10:44 AM CST. Start run is off until the connection is back.',
    );
  });

  test('a custom title replaces the lead and can sit on its own line', () => {
    const { root } = renderPreset('refresh-failed', {
      title: 'Couldn’t refresh memories',
      titleLayout: 'stacked',
    });
    const title = root.querySelector('.cinder-banner__title');
    expect(title?.textContent).toBe('Couldn’t refresh memories');
    expect(title?.getAttribute('data-cinder-title-layout')).toBe('stacked');
  });

  test('a preset runs its lead inline, a plain banner stacks its title', () => {
    expect(
      renderPreset('offline')
        .root.querySelector('.cinder-banner__title')
        ?.getAttribute('data-cinder-title-layout'),
    ).toBe('inline');
    cleanup();
    const plain = render(Banner, {
      props: {
        variant: 'warning',
        title: '1 change waits for a restart',
        children: createRawSnippet(() => ({
          render: () => '<span>Workflow claim renew interval.</span>',
        })),
      },
    });
    const title = plain.container.querySelector('.cinder-banner__title');
    expect(title?.getAttribute('data-cinder-title-layout')).toBe('stacked');
    expect(plain.container.querySelector('.cinder-banner__text')?.textContent).toBe(
      'Workflow claim renew interval.',
    );
  });

  test('children replace the generated words and keep the relative stale notice', () => {
    const { root } = renderPreset('unreachable', {
      children: createRawSnippet(() => ({ render: () => '<span>Their own words.</span>' })),
    });
    expect(root.querySelector('.cinder-banner__title')).toBeNull();
    expect(root.querySelector('.cinder-banner__content')?.textContent).toContain(
      'Their own words.',
    );
    expect(root.querySelector('.cinder-banner__stale')).not.toBeNull();
  });
});

describe('Banner presets: actions', () => {
  test('a retrying preset offers Retry now, with a refresh glyph, and calls onRetry', async () => {
    const onRetry = mock(() => {});
    const { root } = renderPreset('unreachable', { onRetry });
    expect(actionLabels(root)).toEqual(['Retry now']);
    const button = root.querySelector<HTMLButtonElement>('.cinder-banner__actions button');
    expect(button?.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(button?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    await fireEvent.click(button as HTMLButtonElement);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('offers nothing without onRetry', () => {
    expect(renderPreset('offline').root.querySelector('.cinder-banner__actions')).toBeNull();
  });

  test('stopped makes Retry now the primary action', () => {
    const { root } = renderPreset('stopped', { onRetry: () => {} });
    expect(
      root.querySelector('.cinder-banner__actions button')?.getAttribute('data-cinder-variant'),
    ).toBe('primary');
  });

  test('retryVariant moves the emphasis for a page whose retries have stopped', () => {
    const { root } = renderPreset('unreachable', { onRetry: () => {}, retryVariant: 'primary' });
    expect(
      root.querySelector('.cinder-banner__actions button')?.getAttribute('data-cinder-variant'),
    ).toBe('primary');
  });

  test('reconnecting keeps Retry now', () => {
    expect(actionLabels(renderPreset('reconnecting', { onRetry: () => {} }).root)).toEqual([
      'Retry now',
    ]);
  });

  test('restarting and back-online have no action even when onRetry is passed', () => {
    for (const preset of ['restarting', 'back-online'] as const) {
      expect(
        renderPreset(preset, { onRetry: () => {} }).root.querySelector('.cinder-banner__actions'),
      ).toBeNull();
      cleanup();
    }
  });

  test('restart-failed offers Open Health and a primary Restart again', async () => {
    const onRestart = mock(() => {});
    const onOpenHealth = mock(() => {});
    const { root } = renderPreset('restart-failed', { onRestart, onOpenHealth, onRetry: () => {} });
    expect(actionLabels(root)).toEqual(['Open Health', 'Restart again']);
    const [health, restart] = [
      ...root.querySelectorAll<HTMLElement>('.cinder-banner__actions button'),
    ];
    expect(restart?.getAttribute('data-cinder-variant')).toBe('primary');
    expect(health?.getAttribute('data-cinder-variant')).toBe('secondary');
    await fireEvent.click(restart as HTMLElement);
    await fireEvent.click(health as HTMLElement);
    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onOpenHealth).toHaveBeenCalledTimes(1);
  });

  test('Open Health becomes a link when healthHref is given', () => {
    const { root } = renderPreset('restart-failed', { healthHref: '/system' });
    expect(root.querySelector('a')?.getAttribute('href')).toBe('/system');
    expect(root.querySelector('a')?.textContent?.trim()).toBe('Open Health');
  });

  test('page actions follow the preset actions', () => {
    const { root } = renderPreset('offline', {
      onRetry: () => {},
      actions: createRawSnippet(() => ({ render: () => '<button>Details</button>' })),
    });
    expect(actionLabels(root)).toEqual(['Retry now', 'Details']);
  });
});

describe('Banner glyph, neutral tone and sticky', () => {
  test('offline and unreachable carry a decorative connection glyph, others do not', () => {
    const offline = renderPreset('offline').root.querySelector('.cinder-banner__icon');
    expect(offline?.getAttribute('aria-hidden')).toBe('true');
    expect(offline?.querySelector('svg')?.getAttribute('class')).toContain('lucide-wifi-off');
    cleanup();
    expect(
      renderPreset('unreachable')
        .root.querySelector('.cinder-banner__icon svg')
        ?.getAttribute('class'),
    ).toContain('lucide-unplug');
    cleanup();
    expect(renderPreset('refresh-failed').root.querySelector('.cinder-banner__icon')).toBeNull();
  });

  test('an icon snippet replaces the preset glyph', () => {
    const { root } = renderPreset('offline', {
      icon: createRawSnippet(() => ({ render: () => '<svg data-testid="own"></svg>' })),
    });
    expect(root.querySelector('.cinder-banner__icon [data-testid="own"]')).not.toBeNull();
    expect(root.querySelector('.lucide-wifi-off')).toBeNull();
  });

  test('neutral is a notice named Notice and does not take the status tint', () => {
    const { container } = render(Banner, {
      props: {
        variant: 'neutral',
        title: 'Release helper isn’t available',
        children: createRawSnippet(() => ({
          render: () => '<span>Its plugin, Demo, is disabled.</span>',
        })),
      },
    });
    const root = container.querySelector('.cinder-banner');
    expect(root?.getAttribute('data-cinder-variant')).toBe('neutral');
    expect(root?.getAttribute('aria-label')).toBe('Notice');
    expect(root?.classList.contains('cinder-_status-surface')).toBe(false);
  });

  test('sticky marks the root for the sticky rule', () => {
    const { container } = render(Banner, {
      props: {
        sticky: true,
        variant: 'warning',
        children: createRawSnippet(() => ({ render: () => '<span>x</span>' })),
      },
    });
    expect(container.querySelector('.cinder-banner')?.getAttribute('data-cinder-sticky')).toBe(
      'true',
    );
  });

  // s4#17: rows scrolled under a stuck banner showed through the scroll container's top padding.
  test('a sticky banner covers the band above it with the page canvas, clear of its border', async () => {
    const css = await Bun.file(new URL('./banner.css', import.meta.url)).text();
    const cover = /\.cinder-banner\[data-cinder-sticky='true'\]::before \{([^}]*)\}/.exec(css)?.[1];
    expect(cover).toBeDefined();
    expect(cover).toContain('position: absolute;');
    expect(cover).toContain('inset-block-end: calc(100% + 1px);');
    expect(cover).toContain('block-size: var(--cinder-space-4);');
    expect(cover).toContain('background: var(--cinder-surface-canvas);');
    expect(cover).toContain('pointer-events: none;');
  });
});
