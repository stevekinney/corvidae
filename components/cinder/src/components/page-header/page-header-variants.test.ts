/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

import { declarationsFor } from '../../test/css.ts';
import {
  contrastRatio,
  type OklchColor,
  wcagLuminance,
} from '../../tokens/runtime/contrast/color-math.ts';

// setupHappyDom() MUST run before any `@testing-library/svelte` import.
setupHappyDom();

const { render, cleanup, fireEvent } = await import('@testing-library/svelte');
const { createRawSnippet, flushSync } = await import('svelte');
const { default: PageHeader } = await import('./page-header.svelte');
const { default: Harness } = await import('./page-header-variants-harness.test.svelte');

const stylesheet = readFileSync(new URL('./page-header.css', import.meta.url), 'utf8');
const tokens = readFileSync(new URL('../../styles/tokens-base.css', import.meta.url), 'utf8');

// A controllable IntersectionObserver, installed before each render, so a test can scroll the
// large title away and back without a layout engine.
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

function oklchFrom(source: string, pattern: RegExp): OklchColor {
  const match = pattern.exec(source);
  if (match === null) throw new Error(`no colour matches ${pattern}`);
  return { l: Number(match[1]) / 100, c: Number(match[2]), h: Number(match[3]) };
}

const OKLCH = String.raw`oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)`;

describe('PageHeader decisions (COR-2320)', () => {
  test('the decision group stays visible, and the overflow menu never holds a decision', async () => {
    const { container, getByRole } = render(Harness, {
      props: {
        withDecisions: true,
        overflow: [{ label: 'Copy link' }, { label: 'Cancel run', decision: true }],
      },
    });

    const actions = container.querySelector('.cinder-page-header__actions');
    const group = actions?.querySelector('.cinder-page-header__decisions');
    expect(actions?.firstElementChild).toBe(group ?? null);
    for (const name of ['Approve', 'Deny', 'Cancel run']) {
      const button = getByRole('button', { name });
      expect(group?.contains(button)).toBe(true);
      expect(button.closest('[role="menu"]')).toBeNull();
    }

    await fireEvent.click(getByRole('button', { name: 'More actions' }));
    const items = [...document.querySelectorAll('.cinder-dropdown-item')].map((item) =>
      item.textContent?.trim(),
    );
    expect(items).toEqual(['Copy link']);
    for (const menu of document.querySelectorAll('[role="menu"]')) {
      for (const name of ['Approve', 'Deny', 'Cancel run']) {
        expect(menu.textContent).not.toContain(name);
      }
    }
  });

  test('decisions draw at the compact header height like every other header action', () => {
    const { getByRole } = render(Harness, {
      props: { withDecisions: true, overflow: [{ label: 'Cancel run', decision: true }] },
    });
    for (const name of ['Approve', 'Deny', 'Cancel run']) {
      expect(getByRole('button', { name }).getAttribute('data-cinder-size')).toBe('xs');
    }
  });

  test('an overflow of only decisions draws no menu button at all', () => {
    const { container } = render(Harness, {
      props: { overflow: [{ label: 'Cancel run', decision: true }] },
    });
    expect(container.querySelector('.cinder-page-header__overflow')).toBeNull();
    expect(container.querySelector('.cinder-page-header__decisions')?.textContent).toContain(
      'Cancel run',
    );
  });

  test('a hero keeps its decisions visible beneath the title', () => {
    const { container } = render(Harness, {
      props: {
        variant: 'hero',
        withDecisions: true,
        overflow: [{ label: 'Copy link' }, { label: 'Cancel run', decision: true }],
      },
    });
    const group = container.querySelector(
      '.cinder-page-header__hero-actions .cinder-page-header__decisions',
    );
    expect(group?.textContent).toContain('Approve');
    expect(group?.textContent).toContain('Cancel run');
  });
});

describe('PageHeader large title (COR-2320)', () => {
  test('renders the title at the large page-title step', () => {
    const { container } = render(Harness, { props: { variant: 'large' } });
    expect(
      container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-variant'),
    ).toBe('large');
    expect(
      declarationsFor(
        stylesheet,
        ".cinder-page-header[data-cinder-variant='large'] .cinder-page-header__title",
      ).get('font-size'),
    ).toBe('var(--cinder-text-page-title-large)');
    expect(tokens).toContain('--cinder-text-page-title-large: 1.75rem;');
  });

  test('collapses into a sticky bar at the default size once the title scrolls away', () => {
    const { container } = render(Harness, { props: { variant: 'large', title: 'Runs' } });
    const header = container.querySelector('.cinder-page-header');
    const bar = header?.previousElementSibling;
    const title = container.querySelector('h1.cinder-page-header__title');
    if (title === null) throw new Error('no title');
    expect(bar?.classList.contains('cinder-page-header__bar')).toBe(true);
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    expect(bar?.hasAttribute('data-cinder-collapsed')).toBe(false);

    moveTitle(title, -120);
    expect(bar?.hasAttribute('data-cinder-collapsed')).toBe(true);
    expect(bar?.textContent?.trim()).toBe('Runs');
    // The heading stays the only heading: the bar repeats the words, not the element.
    expect(container.querySelectorAll('h1')).toHaveLength(1);

    moveTitle(title, 40);
    expect(bar?.hasAttribute('data-cinder-collapsed')).toBe(false);
  });

  test('a title waiting below the fold has not collapsed', () => {
    const { container } = render(Harness, { props: { variant: 'large' } });
    const title = container.querySelector('.cinder-page-header__title');
    if (title === null) throw new Error('no title');
    moveTitle(title, 1200);
    expect(
      container.querySelector('.cinder-page-header__bar')?.hasAttribute('data-cinder-collapsed'),
    ).toBe(false);
  });

  test('the bar is sticky, takes no height and shows the title at the default page-title size', () => {
    const bar = declarationsFor(stylesheet, '.cinder-page-header__bar');
    expect(bar.get('position')).toBe('sticky');
    expect(bar.get('inset-block-start')).toBe('0');
    expect(bar.get('block-size')).toBe('0');
    expect(declarationsFor(stylesheet, '.cinder-page-header__bar-title').get('font-size')).toBe(
      'var(--cinder-text-page-title)',
    );
  });

  test('collapsedBar={false} leaves the title to an AppBar', () => {
    const { container } = render(Harness, { props: { variant: 'large', collapsedBar: false } });
    expect(container.querySelector('.cinder-page-header__bar')).toBeNull();
  });

  test('the default variant draws no bar and watches nothing', () => {
    const { container } = render(Harness);
    const title = container.querySelector('.cinder-page-header__title');
    expect(container.querySelector('.cinder-page-header__bar')).toBeNull();
    expect(records.some((record) => title !== null && record.targets.includes(title))).toBe(false);
    expect(
      container.querySelector('.cinder-page-header')?.hasAttribute('data-cinder-variant'),
    ).toBe(false);
  });
});

describe('PageHeader hero (COR-2320)', () => {
  test('has eyebrow, title, facts, media and actions slots, with actions beneath the title', () => {
    const { container, getByRole } = render(Harness, {
      props: {
        variant: 'hero',
        eyebrow: 'Denver',
        withFacts: true,
        withMedia: true,
        withActions: true,
      },
    });
    const copy = container.querySelector('.cinder-page-header__hero-copy');
    const eyebrow = copy?.querySelector('.cinder-page-header__eyebrow');
    expect(eyebrow?.textContent).toBe('Denver');
    expect(eyebrow?.nextElementSibling?.classList.contains('cinder-page-header__title-line')).toBe(
      true,
    );
    expect(copy?.querySelector('.cinder-page-header__facts .harness-facts')).not.toBeNull();
    expect(container.querySelector('.cinder-page-header__media .harness-media')).not.toBeNull();
    const actions = copy?.querySelector('.cinder-page-header__hero-actions');
    expect(actions?.previousElementSibling?.classList.contains('cinder-page-header__facts')).toBe(
      true,
    );
    // Beneath the title the buttons keep their own size; only a header's side actions are compact.
    expect(getByRole('button', { name: 'Find a spot' }).getAttribute('data-cinder-size')).toBe(
      'md',
    );
    expect(container.querySelector('.cinder-page-header__actions')).toBeNull();
  });

  test('the eyebrow is neutral, not the accent colour', () => {
    const eyebrow = declarationsFor(stylesheet, '.cinder-page-header__eyebrow');
    expect(eyebrow.get('color')).toBe('var(--cinder-text-muted)');
    expect(stylesheet).not.toMatch(/__eyebrow\s*\{[^}]*accent/);
  });

  test('is a full-bleed band, never a card, with its content capped at the page width', () => {
    const band = declarationsFor(stylesheet, ".cinder-page-header[data-cinder-variant='hero']");
    expect(band.has('border')).toBe(false);
    expect(band.has('border-radius')).toBe(false);
    expect(band.has('box-shadow')).toBe(false);
    expect(band.has('max-inline-size')).toBe(false);
    expect(declarationsFor(stylesheet, '.cinder-page-header__hero').get('max-inline-size')).toBe(
      'var(--cinder-content-width)',
    );
  });

  test.each(['plain', 'tint', 'accent', 'night'] as const)(
    'tone %s marks the band, and only accent and night are dark theme islands',
    (tone) => {
      const { container } = render(Harness, { props: { variant: 'hero', tone } });
      const header = container.querySelector('.cinder-page-header');
      expect(header?.getAttribute('data-cinder-tone')).toBe(tone);
      expect(header?.getAttribute('data-theme') ?? null).toBe(
        tone === 'accent' || tone === 'night' ? 'dark' : null,
      );
    },
  );

  test('the tone defaults to plain, and the other variants carry none', () => {
    const hero = render(Harness, { props: { variant: 'hero' } });
    expect(
      hero.container.querySelector('.cinder-page-header')?.getAttribute('data-cinder-tone'),
    ).toBe('plain');
    cleanup();
    const plain = render(Harness, { props: { tone: 'night' } });
    const header = plain.container.querySelector('.cinder-page-header');
    expect(header?.hasAttribute('data-cinder-tone')).toBe(false);
    expect(header?.hasAttribute('data-theme')).toBe(false);
  });

  test('the accent band is an indigo gradient within hues 262 to 290', () => {
    const from = oklchFrom(stylesheet, new RegExp(`--_cinder-hero-from: ${OKLCH};`));
    const to = oklchFrom(stylesheet, new RegExp(`--_cinder-hero-to: ${OKLCH};`));
    for (const stop of [from, to]) {
      expect(stop.h).toBeGreaterThanOrEqual(262);
      expect(stop.h).toBeLessThanOrEqual(290);
    }
  });

  test('every tone keeps its text at 4.5:1 or better', () => {
    const lightMuted = oklchFrom(tokens, new RegExp(`--cinder-text-muted: light-dark\\(${OKLCH}`));
    const darkMuted = oklchFrom(
      tokens,
      new RegExp(`--cinder-text-muted: light-dark\\(oklch\\([^)]*\\), ${OKLCH}\\)`),
    );
    const tintLight = oklchFrom(
      stylesheet,
      new RegExp(`--_cinder-hero-band: light-dark\\(${OKLCH}`),
    );
    const tintDark = oklchFrom(
      stylesheet,
      new RegExp(`--_cinder-hero-band: light-dark\\(oklch\\([^)]*\\), ${OKLCH}\\)`),
    );
    const accentFrom = oklchFrom(stylesheet, new RegExp(`--_cinder-hero-from: ${OKLCH};`));
    const accentTo = oklchFrom(stylesheet, new RegExp(`--_cinder-hero-to: ${OKLCH};`));
    const night = oklchFrom(stylesheet, new RegExp(`--_cinder-hero-night: ${OKLCH};`));
    const ratio = (text: OklchColor, band: OklchColor) =>
      contrastRatio(wcagLuminance(text), wcagLuminance(band));

    // Muted text is the weakest text a band carries (the eyebrow and the description).
    expect(ratio(lightMuted, tintLight)).toBeGreaterThanOrEqual(4.5);
    for (const band of [tintDark, accentFrom, accentTo, night]) {
      expect(ratio(darkMuted, band)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('on accent and night the primary is a white fill with an indigo label', () => {
    const primary =
      /\.cinder-button\[data-cinder-variant='primary'\]:not\(:disabled, \[aria-disabled='true'\]\) \{([^}]*)\}/.exec(
        stylesheet,
      )?.[1];
    expect(primary).toBeDefined();
    const fill = oklchFrom(primary ?? '', new RegExp(`background: ${OKLCH};`));
    const label = oklchFrom(primary ?? '', new RegExp(`color: ${OKLCH};`));
    expect(fill.l).toBe(1);
    expect(label.h).toBeGreaterThanOrEqual(262);
    expect(label.h).toBeLessThanOrEqual(290);
    expect(contrastRatio(wcagLuminance(label), wcagLuminance(fill))).toBeGreaterThanOrEqual(4.5);
    // The rule is scoped to the two dark bands, and the hover and press keep the white face.
    expect(stylesheet).toMatch(
      /:is\(\.cinder-page-header\[data-cinder-tone='accent'\], \.cinder-page-header\[data-cinder-tone='night'\]\)\s*\.cinder-button\[data-cinder-variant='primary'\]:not/,
    );
    expect(stylesheet).toMatch(/\.cinder-button\[data-cinder-variant='primary'\]:hover/);
    expect(stylesheet).toMatch(/\.cinder-button\[data-cinder-variant='primary'\]:active/);
  });

  test('on accent and night the secondary and the segmented-control track are translucent', () => {
    expect(stylesheet).toMatch(
      /\.cinder-button\[data-cinder-variant='secondary'\]:not\(:disabled, \[aria-disabled='true'\]\) \{[^}]*background: oklch\(100% 0 0 \/ 0\.\d+\)/,
    );
    expect(stylesheet).toMatch(
      /\.cinder-segmented-control:not\(\[data-cinder-variant='tablist'\]\) \{[^}]*background: oklch\(100% 0 0 \/ 0\.\d+\)/,
    );
  });

  test('the decorative layer is hidden from assistive technology, and art yields to a focal value', () => {
    const withArt = render(Harness, { props: { variant: 'hero', withArt: true } });
    const decor = withArt.container.querySelector('.cinder-page-header__decor');
    expect(decor?.getAttribute('aria-hidden')).toBe('true');
    expect(decor?.querySelector('.cinder-page-header__pattern')).not.toBeNull();
    expect(decor?.querySelector('.cinder-page-header__art .harness-art')).not.toBeNull();
    cleanup();

    const both = render(Harness, { props: { variant: 'hero', withArt: true, withFocal: true } });
    expect(both.container.querySelector('.cinder-page-header__art')).toBeNull();
    expect(
      both.container.querySelector('.cinder-page-header__focal .harness-focal-value')?.textContent,
    ).toBe('$84.20');
  });

  test('the decorative layer is not drawn under more contrast or forced colours', () => {
    expect(stylesheet).toMatch(
      /@media \(prefers-contrast: more\), \(forced-colors: active\) \{\s*\.cinder-page-header__decor \{\s*display: none;/,
    );
  });

  test('the dotted pattern fades in from the inline end', () => {
    const pattern = declarationsFor(stylesheet, '.cinder-page-header__pattern');
    expect(pattern.get('mask-image')).toBe('linear-gradient(to left, black, transparent 65%)');
    expect(
      declarationsFor(stylesheet, '.cinder-page-header__pattern:dir(rtl)').get('mask-image'),
    ).toBe('linear-gradient(to right, black, transparent 65%)');
  });

  test('the layout answers to its own width: one column, focal first, below 720px', () => {
    expect(stylesheet).not.toMatch(/@media[^{]*width/);
    expect(stylesheet).toMatch(
      /@container \(width < 720px\) \{\s*\.cinder-page-header__hero \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-areas:\s*'focal'\s*'copy';/,
    );
    expect(
      declarationsFor(
        stylesheet,
        ".cinder-page-header[data-cinder-variant='hero'] .cinder-page-header__title",
      ).get('font-size'),
    ).toMatch(/cqi/);
    expect(
      declarationsFor(stylesheet, '.cinder-page-header__focal > :first-child').get('font-size'),
    ).toMatch(/cqi/);
    expect(
      declarationsFor(stylesheet, '.cinder-page-header__focal').get('font-variant-numeric'),
    ).toBe('tabular-nums');
  });

  test('titleSoft renders inside the same heading, lighter than the title', () => {
    const { container } = render(Harness, {
      props: { variant: 'hero', title: 'Poor Decisions', titleSoft: ', made easier' },
    });
    const heading = container.querySelector('h1');
    expect(heading?.textContent?.trim()).toBe('Poor Decisions, made easier');
    expect(heading?.querySelector('.cinder-page-header__title-soft')?.textContent).toBe(
      ', made easier',
    );
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(declarationsFor(stylesheet, '.cinder-page-header__title-soft').get('font-weight')).toBe(
      '380',
    );
    expect(
      declarationsFor(
        stylesheet,
        ".cinder-page-header[data-cinder-variant='hero'] .cinder-page-header__title",
      ).get('font-weight'),
    ).toBe('760');
  });

  test('titleSoft joins a snippet title too', () => {
    const title = createRawSnippet(() => ({ render: () => '<span>Poor Decisions</span>' }));
    const { container } = render(PageHeader, {
      props: { title, titleSoft: ', made easier', variant: 'hero' },
    });
    expect(container.querySelector('h1')?.textContent?.trim()).toBe('Poor Decisions, made easier');
  });
});
