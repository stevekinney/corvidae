/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: Sidebar } = await import('./sidebar.svelte');

const sidebarCss = await Bun.file(new URL('./sidebar.css', import.meta.url)).text();

function navigation() {
  return createRawSnippet(() => ({
    render: () => '<ul><li>items</li></ul>',
    setup: () => {},
  }));
}

describe('Sidebar railLabels (COR-2315)', () => {
  test('marks the aside only when it is asked to draw the labelled rail', () => {
    const plain = render(Sidebar, { props: { navigation: navigation() } });
    expect(plain.container.querySelector('aside')?.hasAttribute('data-cinder-rail-labels')).toBe(
      false,
    );
    plain.unmount();
    const labelled = render(Sidebar, { props: { railLabels: true, navigation: navigation() } });
    expect(labelled.container.querySelector('aside')?.hasAttribute('data-cinder-rail-labels')).toBe(
      true,
    );
  });

  test('the prop never reaches the aside as an attribute of its own name', () => {
    const { container } = render(Sidebar, {
      props: { railLabels: true, navigation: navigation() },
    });
    expect(container.querySelector('aside')?.hasAttribute('raillabels')).toBe(false);
  });

  test('the labelled rail is 76px wide, an icon over its label, and the label is drawn', () => {
    expect(sidebarCss).toMatch(
      /\.cinder-sidebar\[data-cinder-collapsed\]\[data-cinder-rail-labels\]:not\(\.cinder-sidebar--mobile\)\s*\{\s*inline-size:\s*4\.75rem;/,
    );
    expect(sidebarCss).toMatch(
      /\[data-cinder-rail-labels\]\s+\.cinder-side-navigation\s+:is\(a, button\)\.cinder-side-navigation-item\s*\{[^}]*flex-direction:\s*column;[^}]*inline-size:\s*100%;/,
    );
    // The label is put back where the folded rail clips it.
    expect(sidebarCss).toMatch(
      /> \.cinder-side-navigation-item__label\s*\{[^}]*position:\s*static;[^}]*clip:\s*auto;[^}]*clip-path:\s*none;/,
    );
  });

  test('the labelled rail gives its items 68px and never ends a label in an ellipsis (COR-2445)', () => {
    // The nav hands back its inline padding, down to one step, and the item has none of its own.
    expect(sidebarCss).toMatch(
      /\[data-cinder-rail-labels\]:not\(\.cinder-sidebar--mobile\)\s+\.cinder-sidebar__nav\s*\{\s*padding-inline:\s*var\(--cinder-space-1\);/,
    );
    expect(sidebarCss).toMatch(
      /:is\(a, button\)\.cinder-side-navigation-item\s*\{[^}]*padding-inline:\s*0;/,
    );
    const labelRule =
      sidebarCss.match(/> \.cinder-side-navigation-item__label\s*\{[^}]*\}/)?.[0] ?? '';
    expect(labelRule).not.toContain('text-overflow: ellipsis');
    expect(labelRule).toContain('white-space: normal');
    // The group break is a margin and a padding of one step each side of the hairline.
    expect(sidebarCss).toMatch(
      /\[data-cinder-rail-labels\]\s+\.cinder-side-navigation-group\[data-cinder-static\]\s*\{\s*margin-block-start:\s*calc\(\s*var\(--cinder-space-2\) - var\(--cinder-side-navigation-list-gap, var\(--cinder-space-1\)\)\s*\);\s*padding-block-start:\s*var\(--cinder-space-2\);/,
    );
  });

  test('the labelled rules outrank the folded rules they undo, so load order cannot decide', () => {
    // The folded label rule is `.cinder-sidebar[data-cinder-collapsed] .cinder-side-navigation
    // a.cinder-navigation-item > :not([aria-hidden]):not(svg):not(img):not(.count)`, six classes
    // and attributes and three elements; the labelled label rule names seven classes and
    // attributes before it reaches its one element.
    const labelled = sidebarCss.match(
      /(\.cinder-sidebar\[data-cinder-collapsed\]\[data-cinder-rail-labels\][^{]*?> \.cinder-side-navigation-item__label)\s*\{/,
    )?.[1];
    expect(labelled).toBeDefined();
    const classesAndAttributes = (labelled?.match(/\.[a-z][\w-]*|\[[^\]]+\]/g) ?? []).length;
    expect(classesAndAttributes).toBeGreaterThanOrEqual(7);
  });
});
