/// <reference lib="dom" />
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

import { injectStrippedStyles } from '../test/css.ts';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: Harness } = await import('./header-actions-harness.test.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const component = (name: string) =>
  readFileSync(new URL(`../components/${name}/${name}.css`, import.meta.url), 'utf8');

describe('header actions never grow the header', () => {
  for (const kind of ['card', 'section-heading'] as const) {
    test(`${kind}: a default-size button in the actions draws at xs, one in the body does not`, () => {
      const { getByTestId } = render(Harness, { props: { kind, withActions: true } });
      expect(getByTestId('header-button').getAttribute('data-cinder-size')).toBe('xs');
      expect(getByTestId('body-button').getAttribute('data-cinder-size')).toBe('md');
    });
  }

  for (const kind of ['card', 'section-heading'] as const) {
    test(`${kind}: under an error-demoting context a primary header button is secondary at xs`, () => {
      const { getByTestId } = render(Harness, {
        props: { kind, withActions: true, underError: true },
      });
      const header = getByTestId('header-button');
      expect(header.getAttribute('data-cinder-size')).toBe('xs');
      expect(header.getAttribute('data-cinder-variant')).toBe('secondary');
    });
  }

  test('the actions box is the title line box, so the header height is equal with and without actions', () => {
    for (const name of ['card', 'section-heading']) {
      const css = component(name);
      const rule = css.match(/\.cinder-(?:card|section-heading)__actions\s*\{[^}]*\}/)?.[0] ?? '';
      // A 24px control centered on one line box: the margin cancels the difference exactly. It
      // reads the compact height, which a coarse pointer does not raise.
      expect(rule).toContain(
        'margin-block: calc((1lh - var(--_cinder-compact-control-height)) / 2)',
      );
      expect(rule).not.toMatch(/padding/);
    }
  });

  test('card renders actions beside the title, baseline aligned', () => {
    const { container } = render(Harness, { props: { kind: 'card', withActions: true } });
    const row = container.querySelector('.cinder-card__title-row');
    expect(row?.querySelector('.cinder-card__actions button')).not.toBeNull();
    expect(component('card')).toMatch(/__title-row\s*\{[^}]*align-items:\s*baseline/);
    cleanup();
    const without = render(Harness, { props: { kind: 'card', withActions: false } });
    expect(without.container.querySelector('.cinder-card__actions')).toBeNull();
  });
});

describe('coarse pointers get a real touch box without enlarging the painted control', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const tokens = read('../styles/tokens-base.css');
  const foundation = read('../styles/foundation.css');
  const buttonCss = read('../components/button/button.css');

  // happy-dom cannot evaluate `(pointer: coarse)`, so the coarse run applies those blocks
  // unconditionally (`@media all`); the fine run is the stylesheet as authored.
  const emulate = (pointer: 'fine' | 'coarse') =>
    injectStrippedStyles(
      tokens,
      pointer === 'coarse'
        ? foundation.replace('@media (pointer: coarse) {', '@media all {')
        : foundation,
      pointer === 'coarse'
        ? buttonCss.replace('@media (pointer: coarse) {', '@media all {')
        : buttonCss,
    );

  const pixels = (value: string): number => {
    const match = /^(-?[\d.]+)(px|rem)$/.exec(value.trim());
    if (match === null) throw new Error(`not a length: ${value}`);
    return Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
  };

  const rootValue = (name: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(name);

  test('a coarse pointer raises the xs step while compact buttons reach 44px by a hit-area pseudo-element', () => {
    const clean = emulate('coarse');
    try {
      expect(pixels(rootValue('--cinder-control-height-xs'))).toBe(44);
      expect(pixels(rootValue('--_cinder-compact-control-height'))).toBe(24);
      // The hit region is a pseudo-element reaching 44px that takes no layout space; the box
      // itself never carries the touch minimum or a transparent border.
      const hitRule =
        /\.cinder-button\[data-cinder-hit-target='44'\]::before\s*\{[^}]*\}/s.exec(
          buttonCss,
        )?.[0] ?? '';
      expect(hitRule).toContain('position: absolute;');
      expect(hitRule).toContain('var(--cinder-touch-target-min)');
      expect(buttonCss).not.toMatch(
        /\.cinder-button\[data-cinder-hit-target='44'\]\s*\{[^}]*min-height:\s*var\(--cinder-touch-target-min\)/s,
      );
      expect(buttonCss).not.toContain('border: 10px solid transparent');
      expect(buttonCss).not.toContain('background-clip');
    } finally {
      clean();
    }
  });

  for (const kind of ['card', 'section-heading'] as const) {
    test(`${kind}: on a coarse pointer a header button owns a 44px hit box without changing its compact face`, () => {
      const fineClean = emulate('fine');
      const fineRender = render(Harness, { props: { kind, withActions: true } });
      const fineHeight = pixels(
        getComputedStyle(fineRender.getByTestId('header-button')).minHeight,
      );
      fineRender.unmount();
      fineClean();
      expect(fineHeight).toBe(24);

      const clean = emulate('coarse');
      try {
        const { getByTestId } = render(Harness, { props: { kind, withActions: true } });
        const header = pixels(getComputedStyle(getByTestId('header-button')).minHeight);
        // The layout box is the painted face; the 44px region is a pseudo-element (asserted above).
        expect(header).toBe(24);
        expect(pixels(getComputedStyle(getByTestId('body-button')).minHeight)).toBe(32);
        expect(fineHeight).toBe(24);
      } finally {
        clean();
      }
    });
  }

  for (const name of ['card', 'section-heading', 'page-header']) {
    test(`${name}: the actions margin uses the fine xs height on a coarse pointer, so it never goes negative`, () => {
      const rule = component(name).match(
        /margin-block:\s*calc\(\(1lh - var\((--[\w-]+)\)\) \/ 2\);/,
      );
      expect(rule, `${name} centres its actions on the title line box`).not.toBeNull();
      const property = rule?.[1] as string;
      const heights = (['fine', 'coarse'] as const).map((pointer) => {
        const clean = emulate(pointer);
        try {
          return pixels(rootValue(property));
        } finally {
          clean();
        }
      });
      expect(heights).toEqual([24, 24]);
    });
  }

  test('the compact height is the fine xs control height', () => {
    expect(foundation).toContain('--_cinder-compact-control-height: 1.5rem;');
    expect(tokens).toContain('--cinder-control-height-xs: 1.5rem;');
  });
});
