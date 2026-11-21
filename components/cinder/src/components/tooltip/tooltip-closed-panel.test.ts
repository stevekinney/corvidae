/**
 * COR-2539 (design correction round 3): a closed Tooltip's panel is `position: fixed` and sits in
 * its wrapper (it is portaled only while it shows), so an ancestor with a `transform`, a `filter`
 * or layout containment makes that ancestor its containing block. A panel hidden by `visibility`
 * alone still takes part in layout there and widens the ancestor's scrollable area by the panel's
 * own `max-content` width. A closed panel takes no part in layout; `aria-describedby` still
 * resolves, because an element with `display: none` still supplies a description.
 *
 * The geometry itself is measured in a browser: `tooltip-closed-panel.playwright.ts`.
 */
import { describe, expect, test } from 'bun:test';

const source = await Bun.file(new URL('./tooltip.css', import.meta.url)).text();
const css = source.replace(/\s+/g, ' ');

describe('a closed tooltip panel', () => {
  test('is out of layout, not only invisible', () => {
    const closed = /\.cinder-tooltip:not\(\[data-cinder-visible\]\) \{([^}]*)\}/.exec(css)?.[1];
    expect(closed).toBeDefined();
    expect(closed).toContain('display: none;');
    expect(closed).toContain('visibility: hidden;');
  });

  test('is still laid out for the whole exit, because `data-cinder-visible` outlives the fade', () => {
    // The exit transition runs while the attribute is present; only a settled close removes it.
    expect(css).toMatch(/\.cinder-tooltip\[data-cinder-closing\] \{[^}]*opacity: 0;/);
    expect(css).not.toMatch(/\.cinder-tooltip\[data-cinder-closing\] \{[^}]*display: none/);
  });
});
