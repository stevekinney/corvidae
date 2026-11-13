/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { createRawSnippet, flushSync } = await import('svelte');
const { default: AppBar } = await import('./app-bar.svelte');
const { default: PairingHarness } = await import('./app-bar-pairing-harness.test.svelte');

const stylesheet = readFileSync(new URL('./app-bar.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../styles/tokens-base.css', import.meta.url), 'utf8');

const icon = createRawSnippet(() => ({ render: () => '<span class="harness-icon"></span>' }));

// A controllable IntersectionObserver for the pairing with PageHeader's large title.
type ObserverRecord = {
  observer: IntersectionObserver;
  callback: IntersectionObserverCallback;
  targets: Element[];
};

let records: ObserverRecord[] = [];

class FakeIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '0px';
  readonly scrollMargin = '';
  readonly thresholds: readonly number[] = [0];
  private readonly record: ObserverRecord;

  constructor(callback: IntersectionObserverCallback) {
    this.record = { observer: this, callback, targets: [] };
    records.push(this.record);
  }

  observe(target: Element) {
    this.record.targets.push(target);
  }

  unobserve() {}

  disconnect() {
    this.record.targets = [];
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  records = [];
  globalThis.IntersectionObserver = FakeIntersectionObserver;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

/** Reports the title at `top` (in a 800px-tall viewport) to the observer that watches it. */
function moveTitle(title: Element, top: number): void {
  const record = records.find((candidate) => candidate.targets.includes(title));
  if (record === undefined) throw new Error('nothing observes the title');
  const box = new DOMRect(0, top, 400, 40);
  const isIntersecting = top + 40 > 0 && top < 800;
  record.callback(
    [
      {
        boundingClientRect: box,
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: box,
        isIntersecting,
        rootBounds: new DOMRect(0, 0, 400, 800),
        target: title,
        time: 0,
      },
    ],
    record.observer,
  );
  flushSync();
}

describe('AppBar (COR-2321)', () => {
  test('has leading, title and trailing slots, in that order', () => {
    const leading = createRawSnippet(() => ({
      render: () => '<span class="harness-leading">Filters</span>',
    }));
    const trailing = createRawSnippet(() => ({
      render: () => '<span class="harness-trailing">3 open</span>',
    }));
    const { container } = render(AppBar, { props: { title: 'Runs', leading, trailing } });

    const bar = container.querySelector('.cinder-app-bar');
    expect(Array.from(bar?.children ?? []).map((child) => child.className)).toEqual([
      'cinder-app-bar__leading',
      'cinder-app-bar__title',
      'cinder-app-bar__trailing',
    ]);
    expect(bar?.querySelector('.cinder-app-bar__leading .harness-leading')).not.toBeNull();
    expect(bar?.querySelector('.cinder-app-bar__title')?.textContent?.trim()).toBe('Runs');
    expect(bar?.querySelector('.cinder-app-bar__trailing .harness-trailing')).not.toBeNull();
  });

  test('draws no empty ends', () => {
    const { container } = render(AppBar, { props: { title: 'Runs' } });
    expect(container.querySelector('.cinder-app-bar__leading')).toBeNull();
    expect(container.querySelector('.cinder-app-bar__trailing')).toBeNull();
  });

  test('is sticky, 56px tall, with no rule, an 82% canvas mix and a 16px blur', () => {
    const bar = declarationsFor(stylesheet, '.cinder-app-bar');
    expect(bar.get('position')).toBe('sticky');
    expect(bar.get('inset-block-start')).toBe('0');
    expect(bar.get('min-block-size')).toBe('var(--_cinder-app-bar-height)');
    expect(bar.get('--_cinder-app-bar-height')).toBe('3.5rem');
    expect(bar.get('--_cinder-app-bar-mix')).toBe('82%');
    expect(bar.get('--_cinder-app-bar-blur')).toBe('16px');
    expect(bar.get('border')).toBe('0');
    expect(stylesheet).not.toMatch(/border-block-end:\s*1px solid var/);
    expect(stylesheet).toMatch(
      /@supports \(backdrop-filter: blur\(1px\)\) \{\s*\.cinder-app-bar \{[^}]*color-mix\(\s*in oklch,\s*var\(--cinder-surface-canvas\) var\(--_cinder-app-bar-mix\),\s*transparent\s*\);\s*backdrop-filter: blur\(var\(--_cinder-app-bar-blur\)\);/,
    );
  });

  test('falls back to an opaque surface without backdrop filters or with reduced transparency', () => {
    // The base rule is opaque; only the @supports block makes it translucent.
    expect(declarationsFor(stylesheet, '.cinder-app-bar').get('background')).toBe(
      'var(--cinder-surface-canvas)',
    );
    expect(stylesheet).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{\s*\.cinder-app-bar \{\s*background: var\(--cinder-surface-canvas\);\s*backdrop-filter: none;/,
    );
  });

  test('icon actions are named by their label and show it as a tooltip', async () => {
    const onclick = mock(() => {});
    const { container, getByRole } = render(AppBar, {
      props: {
        title: 'Death & Co',
        back: { href: '/places' },
        actions: [{ label: 'Share', icon, onclick }],
      },
    });

    const share = getByRole('button', { name: 'Share' });
    expect(share.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(share.querySelector('.harness-icon')).not.toBeNull();
    // The tooltip repeats the name; it does not describe the button a second time.
    expect(share.getAttribute('aria-describedby')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('[role="tooltip"]')).map((tip) => tip.textContent),
    ).toEqual(['Back', 'Share']);
    await fireEvent.click(share);
    expect(onclick).toHaveBeenCalledTimes(1);

    const back = getByRole('link', { name: 'Back' });
    expect(back.getAttribute('href')).toBe('/places');
    expect(back.hasAttribute('data-cinder-icon-only')).toBe(true);
  });

  test('Back takes its name from label', () => {
    const { getByRole } = render(AppBar, {
      props: { back: { label: 'Back to places', onclick: () => {} } },
    });
    expect(getByRole('button', { name: 'Back to places' })).toBeDefined();
  });

  test('an inert action stays focusable and ignores the press', async () => {
    const onclick = mock(() => {});
    const { getByRole } = render(AppBar, {
      props: { actions: [{ label: 'Save', icon, onclick, disabled: true }] },
    });
    const save = getByRole('button', { name: 'Save' });
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(save);
    expect(onclick).not.toHaveBeenCalled();
  });

  test('icon actions keep their painted box: the 44px target is the Button hit area, not layout', () => {
    expect(stylesheet).not.toContain('--cinder-touch-target-min');
    expect(stylesheet).not.toMatch(/@media \(pointer: coarse\)/);
    expect(tokens).toContain('--cinder-touch-target-min: 44px;');
  });

  test('the title is 20px bold on one line', () => {
    const title = declarationsFor(stylesheet, '.cinder-app-bar__title-text');
    expect(title.get('font-size')).toBe('var(--cinder-text-2xl)');
    expect(title.get('font-weight')).toBe('var(--cinder-font-bold)');
    expect(title.get('white-space')).toBe('nowrap');
    expect(tokens).toContain('--cinder-text-2xl: 1.25rem;');
    expect(tokens).toContain('--cinder-font-bold: 700;');
  });

  test('the title is plain text unless headingLevel makes it the page heading', () => {
    const plain = render(AppBar, { props: { title: 'Runs' } });
    expect(plain.container.querySelector('.cinder-app-bar__title-text')?.tagName).toBe('SPAN');
    cleanup();
    const heading = render(AppBar, { props: { title: 'Death & Co', headingLevel: 1 } });
    expect(heading.container.querySelector('.cinder-app-bar__title-text')?.tagName).toBe('H1');
    cleanup();
    const clamped = render(AppBar, { props: { title: 'Runs', headingLevel: 9 as never } });
    expect(clamped.container.querySelector('.cinder-app-bar__title-text')?.tagName).toBe('H6');
  });

  test('a hidden title is transparent and hidden from assistive technology', () => {
    const { container } = render(AppBar, { props: { title: 'Runs', titleVisible: false } });
    expect(
      container.querySelector('.cinder-app-bar')?.hasAttribute('data-cinder-title-visible'),
    ).toBe(false);
    expect(container.querySelector('.cinder-app-bar__title')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      declarationsFor(
        stylesheet,
        '.cinder-app-bar:not([data-cinder-title-visible]) .cinder-app-bar__title',
      ).get('opacity'),
    ).toBe('0');
  });

  test('merges a custom class and forwards attributes', () => {
    const { container } = render(AppBar, {
      props: { title: 'Runs', class: 'extra', 'data-testid': 'app-bar' },
    });
    const root = container.querySelector('.cinder-app-bar');
    expect(root?.classList.contains('extra')).toBe(true);
    expect(root?.getAttribute('data-testid')).toBe('app-bar');
  });

  test('pairs with the large PageHeader: the title appears once the large title scrolls away', () => {
    const { container } = render(PairingHarness);
    const bar = container.querySelector('.cinder-app-bar');
    const title = container.querySelector('h1.cinder-page-header__title');
    if (title === null) throw new Error('no page title');
    // The header leaves the title to the AppBar instead of drawing its own sticky bar.
    expect(container.querySelector('.cinder-page-header__bar')).toBeNull();
    expect(bar?.hasAttribute('data-cinder-title-visible')).toBe(false);

    moveTitle(title, -120);
    expect(bar?.hasAttribute('data-cinder-title-visible')).toBe(true);
    expect(container.querySelector('.cinder-app-bar__title')?.hasAttribute('aria-hidden')).toBe(
      false,
    );
    // The page keeps one heading: the AppBar's title is plain text.
    expect(container.querySelectorAll('h1')).toHaveLength(1);

    moveTitle(title, 40);
    expect(bar?.hasAttribute('data-cinder-title-visible')).toBe(false);
  });
});
