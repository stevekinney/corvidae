/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

// A controllable `matchMedia`, installed before the first query is read, so a test can put the
// viewport in its phone form and back.
type Listener = (event: Event) => void;
const listeners = new Set<Listener>();
let phone = false;
const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    media: query,
    get matches() {
      return phone;
    },
    addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
    addListener: (listener: Listener) => listeners.add(listener),
    removeListener: (listener: Listener) => listeners.delete(listener),
  }),
});

afterAll(() => {
  if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', originalMatchMedia);
  else Reflect.deleteProperty(window, 'matchMedia');
});

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { createRawSnippet, flushSync } = await import('svelte');
const { default: Breadcrumbs } = await import('./breadcrumbs.svelte');

const stylesheet = readFileSync(new URL('./breadcrumbs.css', import.meta.url), 'utf8');

function setPhone(next: boolean) {
  phone = next;
  for (const listener of listeners) listener(new Event('change'));
  flushSync();
}

afterEach(() => {
  cleanup();
  setPhone(false);
});

const trail = [{ label: 'Runs', href: '/runs' }, { label: 'Look up order 4472' }];

describe('Breadcrumbs phone form', () => {
  test('shows the whole trail on a wide viewport', () => {
    const { container } = render(Breadcrumbs, { items: trail });

    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('nav')?.hasAttribute('data-cinder-collapsed')).toBe(false);
  });

  test('collapses to a back link labelled with the parent, then the current page', () => {
    setPhone(true);
    const { container } = render(Breadcrumbs, { items: trail });

    const back = container.querySelector<HTMLAnchorElement>('.cinder-breadcrumbs__back');
    expect(back?.getAttribute('href')).toBe('/runs');
    expect(back?.getAttribute('aria-label')).toBe('Back to Runs');
    expect(back?.textContent?.trim()).toBe('Runs');
    const items = container.querySelectorAll('li');
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent?.trim()).toBe('Look up order 4472');
    expect(container.querySelector('[aria-current="page"]')?.textContent?.trim()).toBe(
      'Look up order 4472',
    );
    expect(container.querySelector('.cinder-breadcrumbs__separator')).toBeNull();
  });

  test('keeps only the parent and the leaf of a deeper trail', () => {
    setPhone(true);
    const { container } = render(Breadcrumbs, {
      items: [
        { label: 'Home', href: '/' },
        { label: 'Goals', href: '/goals' },
        { label: 'Draft release notes' },
      ],
    });

    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('href')).toBe(
      '/goals',
    );
    expect(container.querySelectorAll('li')).toHaveLength(1);
    expect(container.textContent).not.toContain('Home');
  });

  test('a trail at a section root shows only the current page', () => {
    setPhone(true);
    const { container } = render(Breadcrumbs, { items: [{ label: 'Runs' }] });

    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(1);
  });

  test('backLabel names the back link and replaces {label}', () => {
    setPhone(true);
    const { container } = render(Breadcrumbs, { items: trail, backLabel: 'Return to {label}' });

    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('aria-label')).toBe(
      'Return to Runs',
    );
  });

  test('collapseBelow={false} always shows the whole trail', () => {
    setPhone(true);
    const { container } = render(Breadcrumbs, { items: trail, collapseBelow: false });

    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  test('follows the viewport as it crosses the breakpoint', () => {
    const { container } = render(Breadcrumbs, { items: trail });
    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();

    setPhone(true);
    expect(container.querySelector('.cinder-breadcrumbs__back')).not.toBeNull();

    setPhone(false);
    expect(container.querySelector('.cinder-breadcrumbs__back')).toBeNull();
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  test('rejects a breakpoint that is not a CSS length', () => {
    expect(() => render(Breadcrumbs, { items: trail, collapseBelow: 'phone' })).toThrow(
      /collapseBelow/,
    );
  });

  test('the back link is a touch target and the leaf truncates first', () => {
    expect(stylesheet).toMatch(
      /\.cinder-breadcrumbs__back\s*\{[^}]*min-block-size:\s*var\(--cinder-touch-target-min\)/,
    );
    expect(stylesheet).toMatch(
      /\[data-cinder-collapsed\]\s+\.cinder-breadcrumbs__list\s*\{[^}]*flex:\s*1 1 auto/,
    );
  });
});

describe('Breadcrumbs current page popover', () => {
  const longTitle =
    'Please refund order 4471, it arrived damaged, and also check whether the Parcelly damage claims batch from last week was filed for the same carrier';
  const longTrail = [
    { label: 'Chat', href: '/chat' },
    { label: longTitle, popover: true as const },
  ];

  test('draws the current page as a bordered button that keeps the full title', () => {
    const { container } = render(Breadcrumbs, { items: longTrail });

    const trigger = container.querySelector<HTMLButtonElement>('.cinder-breadcrumbs__trigger');
    expect(trigger?.tagName).toBe('BUTTON');
    expect(trigger?.getAttribute('aria-current')).toBe('page');
    expect(trigger?.querySelector('.cinder-breadcrumbs__trigger-label')?.textContent).toBe(
      longTitle,
    );
    expect(stylesheet).toMatch(
      /\.cinder-breadcrumbs__trigger\s*\{[^}]*max-inline-size:[^;]*18\.75rem/,
    );
    expect(stylesheet).toMatch(
      /\.cinder-breadcrumbs__trigger-label\s*\{[^}]*text-overflow:\s*ellipsis/,
    );
  });

  test('opens a dialog popover holding the full title', async () => {
    const { container } = render(Breadcrumbs, { items: longTrail });
    const trigger = container.querySelector<HTMLButtonElement>('.cinder-breadcrumbs__trigger');
    if (!trigger) throw new Error('missing trigger');

    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    flushSync();

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    const panel = document.querySelector('.cinder-breadcrumbs__popover-text');
    expect(panel?.textContent).toBe(longTitle);
  });

  test('a snippet fills the popover with anything else', async () => {
    const content = createRawSnippet(() => ({
      render: () => '<span class="custom-popover">Rename or delete this chat</span>',
    }));
    const { container } = render(Breadcrumbs, {
      items: [
        { label: 'Chat', href: '/chat' },
        { label: 'Refund order 4471', popover: content },
      ],
    });
    const trigger = container.querySelector<HTMLButtonElement>('.cinder-breadcrumbs__trigger');
    if (!trigger) throw new Error('missing trigger');
    await fireEvent.click(trigger);
    flushSync();

    expect(document.querySelector('.custom-popover')?.textContent).toBe(
      'Rename or delete this chat',
    );
  });

  test('keeps the popover trigger in the phone form', () => {
    setPhone(true);
    const { container } = render(Breadcrumbs, { items: longTrail });

    expect(container.querySelector('.cinder-breadcrumbs__back')?.getAttribute('href')).toBe(
      '/chat',
    );
    expect(container.querySelector('.cinder-breadcrumbs__trigger')).not.toBeNull();
  });

  test('an ancestor entry never becomes a trigger', () => {
    const { container } = render(Breadcrumbs, {
      items: [{ label: 'Chat', href: '/chat', popover: true }, { label: 'Current' }],
    });

    expect(container.querySelector('.cinder-breadcrumbs__trigger')).toBeNull();
  });
});
