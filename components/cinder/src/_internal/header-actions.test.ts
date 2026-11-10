/// <reference lib="dom" />
import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

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

  test('the actions box is the title line box, so the header height is equal with and without actions', () => {
    for (const name of ['card', 'section-heading']) {
      const css = component(name);
      const rule = css.match(/\.cinder-(?:card|section-heading)__actions\s*\{[^}]*\}/)?.[0] ?? '';
      // A 24px control centered on one line box: the margin cancels the difference exactly.
      expect(rule).toContain('margin-block: calc((1lh - var(--cinder-control-height-xs)) / 2)');
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

  test('coarse pointers get the touch target from hit-area padding, not visual height', () => {
    const css = readFileSync(new URL('../components/button/button.css', import.meta.url), 'utf8');
    expect(css).toMatch(/pointer:\s*coarse[\s\S]*?\[data-cinder-compact\]::before/);
    expect(css).toContain('var(--cinder-touch-target-min)');
  });
});
