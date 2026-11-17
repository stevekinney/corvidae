/**
 * COR-2342: a theme island paints its own canvas and text.
 *
 * Redeclaring tokens under `[data-theme]` paints nothing, so a dark island inside a light page kept
 * the page's light background and inherited its light text. The foundation styles paint every
 * non-root `[data-theme]` element, at zero specificity so component backgrounds still win, and
 * `data-theme-paint='none'` opts an island out. These pin the CSS shape; the browser fixture test
 * `theme-island-paint.playwright.ts` checks the computed values.
 */
import { describe, expect, test } from 'bun:test';

const foundation = await Bun.file(new URL('./foundation.css', import.meta.url)).text();

const ISLAND_SELECTOR = ":where([data-theme]:not(:root, [data-theme-paint='none']))";

/** The declaration block that follows the island selector. */
function islandBlock(): string {
  const start = foundation.indexOf(`${ISLAND_SELECTOR} {`);
  expect(start, 'foundation.css has the theme island paint rule').toBeGreaterThan(-1);
  expect(foundation.indexOf(`${ISLAND_SELECTOR} {`, start + 1), 'only one rule').toBe(-1);
  const open = foundation.indexOf('{', start);
  return foundation.slice(open + 1, foundation.indexOf('}', open));
}

describe('theme island painting', () => {
  test('a non-root data-theme element paints the canvas background and default text', () => {
    const block = islandBlock();
    expect(block).toContain('background-color: var(--cinder-surface-canvas);');
    expect(block).toContain('color: var(--cinder-text-default);');
  });

  test('the rule is a top-level :where() rule, so it has zero specificity', () => {
    expect(foundation).toMatch(/^:where\(\[data-theme\]:not\(:root, /m);
  });

  test('the root is excluded and data-theme-paint none opts an island out', () => {
    expect(foundation).toMatch(
      /^:where\(\[data-theme\]:not\(:root, \[data-theme-paint='none'\]\)\) \{/m,
    );
  });
});
