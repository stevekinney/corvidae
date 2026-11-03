/// <reference lib="dom" />
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { flushSync } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Skeleton } = await import('./skeleton.svelte');

const skeletonCss = await Bun.file(new URL('./skeleton.css', import.meta.url)).text();

describe('Skeleton', () => {
  test('renders without errors', () => {
    const { container } = render(Skeleton);
    expect(container.querySelector('.cinder-skeleton')).not.toBeNull();
  });

  test('has root class cinder-skeleton', () => {
    const { container } = render(Skeleton);
    const element = container.querySelector('.cinder-skeleton');
    expect(element).not.toBeNull();
    expect(element?.classList.contains('cinder-skeleton')).toBe(true);
  });

  test('applies class prop alongside root class', () => {
    const { container } = render(Skeleton, { props: { class: 'my-custom-class' } });
    const element = container.querySelector('.cinder-skeleton');
    expect(element).not.toBeNull();
    expect(element?.classList.contains('cinder-skeleton')).toBe(true);
    expect(element?.classList.contains('my-custom-class')).toBe(true);
  });

  test('applies width style when width prop is provided', () => {
    const { container } = render(Skeleton, { props: { width: '200px' } });
    const element = container.querySelector('.cinder-skeleton');
    expect(element).not.toBeNull();
    expect(element?.getAttribute('style')).toContain('width: 200px');
  });

  test('applies height style when height prop is provided', () => {
    const { container } = render(Skeleton, { props: { height: '20px' } });
    const element = container.querySelector('.cinder-skeleton');
    expect(element).not.toBeNull();
    expect(element?.getAttribute('style')).toContain('height: 20px');
  });

  test('applies border-radius style when radius prop is provided', () => {
    const { container } = render(Skeleton, { props: { radius: '8px' } });
    const element = container.querySelector('.cinder-skeleton');
    expect(element).not.toBeNull();
    expect(element?.getAttribute('style')).toContain('border-radius: 8px');
  });

  test('no console errors on render', () => {
    const originalError = console.error;
    const errors: unknown[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      render(Skeleton);
      expect(errors).toHaveLength(0);
    } finally {
      console.error = originalError;
    }
  });

  test('shimmer uses a small oklch relative lift instead of srgb white mix', () => {
    expect(skeletonCss).toContain(
      'oklch(from var(--cinder-skeleton-background) calc(l + 0.06) c h) 50%',
    );
    expect(skeletonCss).not.toContain('color-mix(in srgb');
    expect(skeletonCss).not.toContain('white 40%');
  });

  test('reduced motion falls back to the skeleton background token', () => {
    const reducedMotionBlock = skeletonCss.match(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.cinder-skeleton\s*\{[\s\S]*?\}\s*\}/,
    )?.[0];

    expect(reducedMotionBlock).toContain('animation: none');
    expect(reducedMotionBlock).toContain('background: var(--cinder-skeleton-background);');
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('Skeleton lines and variant', () => {
  test('a single bar stays a bare block with no group wrapper', () => {
    const { container } = render(Skeleton, { props: { lines: 1 } });
    expect(container.querySelector('.cinder-skeleton-group')).toBeNull();
    expect(container.querySelectorAll('.cinder-skeleton')).toHaveLength(1);
  });

  test('lines renders that many bars inside one aria-hidden wrapper', () => {
    const { container } = render(Skeleton, { props: { lines: 3 } });
    const group = container.querySelector('.cinder-skeleton-group');
    expect(group?.getAttribute('data-cinder-variant')).toBe('row');
    expect(group?.querySelector('.cinder-skeleton-lines')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(container.querySelectorAll('.cinder-skeleton')).toHaveLength(3);
  });

  test('only the last bar of a group is marked short, and a width prop opts out', () => {
    const { container } = render(Skeleton, { props: { lines: 3 } });
    const bars = [...container.querySelectorAll('.cinder-skeleton')];
    expect(bars.map((bar) => bar.hasAttribute('data-cinder-last'))).toEqual([false, false, true]);
    cleanup();
    const wide = render(Skeleton, { props: { lines: 3, width: '100%' } });
    expect(wide.container.querySelector('[data-cinder-last]')).toBeNull();
  });

  test('clamps lines to a whole number between 1 and 20', () => {
    expect(
      render(Skeleton, { props: { lines: 99 } }).container.querySelectorAll('.cinder-skeleton'),
    ).toHaveLength(20);
    cleanup();
    expect(
      render(Skeleton, { props: { lines: 0 } }).container.querySelectorAll('.cinder-skeleton'),
    ).toHaveLength(1);
    cleanup();
    expect(
      render(Skeleton, { props: { lines: Number.NaN } }).container.querySelectorAll(
        '.cinder-skeleton',
      ),
    ).toHaveLength(1);
    cleanup();
    expect(
      render(Skeleton, { props: { lines: 2.9 } }).container.querySelectorAll('.cinder-skeleton'),
    ).toHaveLength(2);
  });

  test('variant card adds a heading bar above the lines', () => {
    const { container } = render(Skeleton, { props: { variant: 'card', lines: 2 } });
    const group = container.querySelector('.cinder-skeleton-group');
    expect(group?.getAttribute('data-cinder-variant')).toBe('card');
    expect(group?.querySelector('.cinder-skeleton-heading')).not.toBeNull();
    expect(container.querySelectorAll('.cinder-skeleton')).toHaveLength(3);
  });

  test('an unknown variant falls back to row', () => {
    const { container } = render(Skeleton, { props: { variant: 'bogus' as never, lines: 2 } });
    expect(
      container.querySelector('.cinder-skeleton-group')?.getAttribute('data-cinder-variant'),
    ).toBe('row');
  });

  test('applies the class prop to the group root', () => {
    const { container } = render(Skeleton, { props: { lines: 2, class: 'my-group' } });
    expect(container.querySelector('.cinder-skeleton-group')?.classList.contains('my-group')).toBe(
      true,
    );
  });
});

describe('Skeleton loading timing', () => {
  function mountUnderFakeTimers(props: Record<string, unknown>) {
    jest.useFakeTimers();
    const result = render(Skeleton, { props });
    flushSync();
    return result;
  }

  function advance(milliseconds: number) {
    jest.advanceTimersByTime(milliseconds);
    flushSync();
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders nothing until delay elapses, then the skeleton appears at 300 ms', () => {
    const { container } = mountUnderFakeTimers({ delay: 300, lines: 2 });
    expect(container.querySelector('.cinder-skeleton')).toBeNull();
    advance(299);
    expect(container.querySelector('.cinder-skeleton')).toBeNull();
    advance(1);
    expect(container.querySelectorAll('.cinder-skeleton')).toHaveLength(2);
  });

  test('a single delayed block also waits for the delay', () => {
    const { container } = mountUnderFakeTimers({ delay: 300 });
    expect(container.querySelector('.cinder-skeleton')).toBeNull();
    advance(300);
    expect(container.querySelector('.cinder-skeleton')).not.toBeNull();
  });

  test('without delay the skeleton renders on the first pass', () => {
    const { container } = mountUnderFakeTimers({ lines: 2 });
    expect(container.querySelectorAll('.cinder-skeleton')).toHaveLength(2);
  });

  test('shows Still loading with Cancel at 10 s, not before', () => {
    const onCancel = jest.fn();
    const { container, getByRole } = mountUnderFakeTimers({
      delay: 300,
      stillLoadingAfter: 10_000,
      onCancel,
      lines: 3,
    });
    advance(300);
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent?.trim()).toBe('');
    // :empty keeps the live region from adding a gap row to the group before it has text.
    expect(container.querySelector('.cinder-skeleton-status:empty')).not.toBeNull();
    expect(container.querySelector('button')).toBeNull();
    advance(9_699);
    expect(status?.textContent?.trim()).toBe('');
    advance(1);
    expect(status?.textContent).toContain('Still loading. This is taking longer than usual.');
    expect(container.querySelectorAll('.cinder-skeleton')).toHaveLength(3);
    fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('the Still loading status is outside the aria-hidden placeholder', () => {
    const { container } = mountUnderFakeTimers({ stillLoadingAfter: 10_000 });
    advance(10_000);
    const status = container.querySelector('[role="status"]');
    expect(status?.closest('[aria-hidden="true"]')).toBeNull();
  });

  test('omits Cancel when onCancel is not set and honours custom labels', () => {
    const { container } = mountUnderFakeTimers({
      stillLoadingAfter: 10_000,
      stillLoadingLabel: 'Taking a while',
    });
    advance(10_000);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Taking a while');
    expect(container.querySelector('button')).toBeNull();
    cleanup();
    const labelled = mountUnderFakeTimers({
      stillLoadingAfter: 10_000,
      onCancel: () => {},
      cancelLabel: 'Stop',
    });
    advance(10_000);
    expect(labelled.getByRole('button', { name: 'Stop' })).not.toBeNull();
  });

  test('never shows the status when stillLoadingAfter is omitted', () => {
    const { container } = mountUnderFakeTimers({ delay: 300, lines: 2 });
    advance(60_000);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('treats a non-finite stillLoadingAfter as never', () => {
    const { container } = mountUnderFakeTimers({ stillLoadingAfter: Number.NaN, delay: 300 });
    advance(60_000);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('.cinder-skeleton')).not.toBeNull();
  });

  test('a stillLoadingAfter of zero shows the status as soon as the skeleton appears', () => {
    const { container } = mountUnderFakeTimers({ stillLoadingAfter: 0 });
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Still loading. This is taking longer than usual.',
    );
  });

  test('clears both timers on unmount', () => {
    const { unmount } = mountUnderFakeTimers({ delay: 300, stillLoadingAfter: 10_000 });
    expect(jest.getTimerCount()).toBe(2);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('Skeleton list variant', () => {
  test('draws the default three rows with a reserved status column, two text bars and a time bar', () => {
    const { container } = render(Skeleton, { props: { variant: 'list' } });
    const group = container.querySelector('.cinder-skeleton-group');
    expect(group?.getAttribute('data-cinder-variant')).toBe('list');
    const rows = [...container.querySelectorAll('.cinder-skeleton-row')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelectorAll('.cinder-skeleton-row-status .cinder-skeleton')).toHaveLength(1);
      expect(row.querySelectorAll('.cinder-skeleton-row-text .cinder-skeleton')).toHaveLength(2);
      expect(row.querySelectorAll('.cinder-skeleton-row-time .cinder-skeleton')).toHaveLength(1);
    }
  });

  test('draws no leading circle, avatar or spinner', () => {
    const { container } = render(Skeleton, { props: { variant: 'list', label: 'Loading agents' } });
    expect(container.querySelector('.cinder-spinner')).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    for (const bar of container.querySelectorAll('.cinder-skeleton')) {
      expect(bar.getAttribute('style') ?? '').not.toContain('50%');
    }
  });

  test('the rows sit inside an aria-hidden wrapper', () => {
    const { container } = render(Skeleton, { props: { variant: 'list' } });
    expect(container.querySelector('.cinder-skeleton-list')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
  });

  test('rows is a whole number clamped between 1 and 20', () => {
    const count = (rows: number) => {
      const result = render(Skeleton, { props: { variant: 'list', rows } });
      const total = result.container.querySelectorAll('.cinder-skeleton-row').length;
      cleanup();
      return total;
    };
    expect(count(5)).toBe(5);
    expect(count(99)).toBe(20);
    expect(count(0)).toBe(1);
    expect(count(2.9)).toBe(2);
    expect(count(Number.NaN)).toBe(3);
  });

  test('dayBand adds a tinted band with one bar above the rows', () => {
    const plain = render(Skeleton, { props: { variant: 'list' } });
    expect(plain.container.querySelector('.cinder-skeleton-day-band')).toBeNull();
    cleanup();
    const banded = render(Skeleton, { props: { variant: 'list', dayBand: true } });
    const band = banded.container.querySelector('.cinder-skeleton-day-band');
    expect(band?.querySelectorAll('.cinder-skeleton')).toHaveLength(1);
    expect(band?.nextElementSibling?.classList.contains('cinder-skeleton-row')).toBe(true);
  });

  test('label is announced through a visually hidden polite status outside the hidden rows', () => {
    const { container } = render(Skeleton, { props: { variant: 'list', label: 'Loading agents' } });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('Loading agents');
    expect(status?.closest('[aria-hidden="true"]')).toBeNull();
    expect(container.querySelector('.cinder-skeleton-group')?.getAttribute('aria-busy')).toBe(
      'true',
    );
  });

  test('without label there is no status until the slow-loading line is asked for', () => {
    const { container } = render(Skeleton, { props: { variant: 'list' } });
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  test('label also names the other grouped variants', () => {
    const { container } = render(Skeleton, { props: { lines: 3, label: 'Loading notes' } });
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading notes');
  });

  test('applies the class prop to the group root', () => {
    const { container } = render(Skeleton, { props: { variant: 'list', class: 'my-list' } });
    expect(container.querySelector('.cinder-skeleton-group')?.classList.contains('my-list')).toBe(
      true,
    );
  });

  test('the list is a size container and a phone moves the status under the text', () => {
    expect(skeletonCss).toMatch(
      /\[data-cinder-variant='list'\]\s*\{[^}]*container-type: inline-size/,
    );
    expect(skeletonCss).toMatch(/@container cinder-skeleton \(max-width: 448px\)/);
    expect(skeletonCss).toMatch(/grid-template-columns: 8rem minmax\(0, 1fr\) auto/);
  });
});

describe('Skeleton list variant timing', () => {
  function mountUnderFakeTimers(props: Record<string, unknown>) {
    jest.useFakeTimers();
    const result = render(Skeleton, { props });
    flushSync();
    return result;
  }

  function advance(milliseconds: number) {
    jest.advanceTimersByTime(milliseconds);
    flushSync();
  }

  afterEach(() => {
    jest.useRealTimers();
  });

  test('nothing is drawn or announced for 300 ms, then the rows and the label appear', () => {
    const { container } = mountUnderFakeTimers({
      variant: 'list',
      label: 'Loading runs',
      delay: 300,
    });
    expect(container.querySelector('.cinder-skeleton')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
    expect(container.querySelector('.cinder-skeleton-group')?.hasAttribute('aria-busy')).toBe(
      false,
    );
    advance(299);
    expect(container.querySelector('.cinder-skeleton')).toBeNull();
    advance(1);
    expect(container.querySelectorAll('.cinder-skeleton-row')).toHaveLength(3);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading runs');
  });

  test('after 10 s the shared line and a ghost Cancel show below the rows, not as a banner', () => {
    const onCancel = jest.fn();
    const { container, getByRole } = mountUnderFakeTimers({
      variant: 'list',
      delay: 300,
      stillLoadingAfter: 10_000,
      stillLoadingLabel: 'Still loading runs. This is taking longer than usual.',
      onCancel,
    });
    advance(9_999);
    expect(container.querySelector('.cinder-skeleton-status')?.textContent?.trim()).toBe('');
    advance(1);
    const status = container.querySelector('.cinder-skeleton-status');
    expect(status?.textContent).toContain('Still loading runs. This is taking longer than usual.');
    expect(status?.previousElementSibling?.classList.contains('cinder-skeleton-list')).toBe(true);
    expect(container.querySelector('[role="alert"], .cinder-banner')).toBeNull();
    const cancel = getByRole('button', { name: 'Cancel' });
    expect(cancel.classList.contains('cinder-button')).toBe(true);
    expect(cancel.getAttribute('data-cinder-variant')).toBe('ghost');
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('without onCancel the slow-loading line has no button', () => {
    const { container } = mountUnderFakeTimers({ variant: 'list', stillLoadingAfter: 10_000 });
    advance(10_000);
    expect(container.querySelector('.cinder-skeleton-status')?.textContent).toContain(
      'Still loading. This is taking longer than usual.',
    );
    expect(container.querySelector('button')).toBeNull();
  });

  test('unmount clears both timers', () => {
    const { unmount } = mountUnderFakeTimers({
      variant: 'list',
      delay: 300,
      stillLoadingAfter: 10_000,
    });
    expect(jest.getTimerCount()).toBe(2);
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the slow-loading line is centred under the list', () => {
    expect(skeletonCss).toMatch(
      /\[data-cinder-variant='list'\] > \.cinder-skeleton-status\s*\{[^}]*justify-content: center/,
    );
  });
});
