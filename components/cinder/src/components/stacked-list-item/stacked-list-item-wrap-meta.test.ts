/// <reference lib="dom" />
/**
 * `wrapMeta` on a phone: line two is one run of text, the dot, the word and the meta, so a wrapped
 * line returns to the row's text edge. The row draws an inline copy of its status in line two,
 * shown only in the phone form (where the status column is hidden), and a row without `wrapMeta`
 * draws none. The layout is measured in a browser (`stacked-list-item-wrap-meta.playwright.ts`).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: Fixture } = await import('./stacked-list-item-wrap-meta.fixture.svelte');
const { default: StatusListFixture } =
  await import('../../test/fixtures/status-list-fixture.svelte');

const stylesheet = readFileSync(new URL('./stacked-list-item.css', import.meta.url), 'utf8');

afterEach(() => cleanup());

describe('wrapMeta on a phone', () => {
  test('draws the status at the start of line two, before the meta', () => {
    const { container } = render(Fixture);
    const lineTwo = container.querySelector('.cinder-stacked-list-item__line-two');
    const inline = lineTwo?.querySelector('.cinder-stacked-list-item__status-inline');
    expect(inline?.textContent).toContain('Check not met');
    expect(lineTwo?.firstElementChild).toBe(inline ?? null);
    expect(inline?.nextElementSibling?.classList.contains('cinder-stacked-list-item__meta')).toBe(
      true,
    );
  });

  test('shows the inline copy only in the phone form, where line two spans the status column', () => {
    const phoneRules = stylesheet.slice(
      stylesheet.indexOf("a `wrapMeta` row's line two is one run"),
    );
    expect(stylesheet).toMatch(/\.cinder-stacked-list-item__status-inline \{\s*display: none;/);
    expect(phoneRules).toContain('@container cinder-stacked-list-item (max-width: 639.98px)');
    expect(phoneRules).toMatch(/__line-two \{\s*grid-column: status \/ trailing;/);
    expect(phoneRules).toMatch(/__status-inline \{[^}]*display: inline-flex;/);
    expect(phoneRules).toMatch(/__description\) \{\s*display: inline;/);
  });

  test('a row without wrapMeta draws no inline status', () => {
    const { container } = render(StatusListFixture, {
      props: {
        rows: [{ id: 'one', title: 'Daily summary', day: 'Today', status: 'Done', meta: 'Chat' }],
      },
    });
    expect(container.querySelector('.cinder-stacked-list-item__status-inline')).toBeNull();
  });
});
