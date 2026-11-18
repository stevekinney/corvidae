/// <reference lib="dom" />
/**
 * The grouped placeholder's leading and trailing options (COR-2227): a row whose real rows lead
 * with a glyph and end in a time draws an icon block in the row's icon slot and a short bar at the
 * end of the title's line, so the bars start where the row's text starts and nothing moves when the
 * rows arrive.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: Skeleton } = await import('./skeleton.svelte');
const groupedListItemCss = await Bun.file(
  new URL(
    '../../../../grouped-list/src/components/grouped-list-item/grouped-list-item.css',
    import.meta.url,
  ),
).text();
const skeletonSource = await Bun.file(new URL('./skeleton.css', import.meta.url)).text();
const skeletonCss = skeletonSource.replace(/\/\*.*?\*\//gs, '').replace(/\s+/g, ' ');

afterEach(() => cleanup());

describe('Skeleton grouped leading and trailing', () => {
  test('both are off unless asked for', () => {
    const { container } = render(Skeleton, { props: { variant: 'grouped', rows: 2 } });
    expect(container.querySelector('.cinder-skeleton-grouped-leading')).toBeNull();
    expect(container.querySelector('.cinder-skeleton-trailing-bar')).toBeNull();
  });

  test('leading draws an icon block before each row’s content, and trailing a bar on the title’s line', () => {
    const { container } = render(Skeleton, {
      props: { variant: 'grouped', rows: 3, leading: true, trailing: true },
    });
    const rows = [...container.querySelectorAll('.cinder-skeleton-grouped-row')];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.classList.contains('cinder-skeleton-grouped-row--leading')).toBe(true);
      // The slot comes first, then the content with the separator, so the separator starts at the text.
      expect([...row.children].map((child) => child.className)).toEqual([
        'cinder-skeleton-grouped-leading',
        'cinder-skeleton-grouped-content',
      ]);
      // Every block is a `.cinder-skeleton`, so the "Still loading" line hides them on the first row.
      expect(
        row.querySelector('.cinder-skeleton-grouped-leading > .cinder-skeleton'),
      ).not.toBeNull();
      const titleLine = row.querySelector('.cinder-skeleton-grouped-line--title');
      expect(
        [...(titleLine?.children ?? [])].map((child) =>
          child.classList.contains('cinder-skeleton'),
        ),
      ).toEqual([true, true]);
      expect(titleLine?.lastElementChild?.classList.contains('cinder-skeleton-trailing-bar')).toBe(
        true,
      );
      expect(row.querySelector('.cinder-skeleton-action-bar')).toBeNull();
    }
  });

  test('chevronColumn ends the trailing bar before the chevron’s column, where the real times end', () => {
    const { container } = render(Skeleton, {
      props: { variant: 'grouped', rows: 2, leading: true, trailing: true, chevronColumn: true },
    });
    const bars = [...container.querySelectorAll('.cinder-skeleton-trailing-bar')];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.classList.contains('cinder-skeleton-trailing-bar--chevron-column')).toBe(true);
    }
    // The column is GroupedListItem's own measure: the 16px chevron and its gap. The row's own
    // padding at the end of its content is the same on both, so the bar ends where the time does.
    expect(groupedListItemCss).toContain(
      '--_cinder-grouped-list-item-chevron-column: calc(1rem + var(--cinder-space-3))',
    );
    expect(groupedListItemCss).toMatch(
      /__content \{[^}]*padding-inline-end: var\(--cinder-space-2\)/,
    );
    expect(skeletonCss).toMatch(
      /\.cinder-skeleton-grouped-content \{[^}]*padding-inline-end: var\(--cinder-space-2\)/,
    );
    expect(skeletonCss).toMatch(
      /\.cinder-skeleton-trailing-bar--chevron-column \{[^}]*margin-inline-end: calc\(1rem \+ var\(--cinder-space-3\)\)/,
    );
    // Without it, and without `trailing`, the bar keeps the row's end.
    cleanup();
    const plain = render(Skeleton, { props: { variant: 'grouped', rows: 1, trailing: true } });
    expect(
      plain.container.querySelector('.cinder-skeleton-trailing-bar--chevron-column'),
    ).toBeNull();
    cleanup();
    const untrailed = render(Skeleton, {
      props: { variant: 'grouped', rows: 1, chevronColumn: true },
    });
    expect(untrailed.container.querySelector('.cinder-skeleton-trailing-bar')).toBeNull();
  });

  test('both are ignored by the list variant', () => {
    const { container } = render(Skeleton, {
      props: { variant: 'list', leading: true, trailing: true },
    });
    expect(container.querySelector('.cinder-skeleton-grouped-leading')).toBeNull();
    expect(container.querySelector('.cinder-skeleton-trailing-bar')).toBeNull();
  });

  test('the icon slot has the grouped-list row’s metrics, and the trailing bar stays on the title’s line', () => {
    // The row's own slot: 28px with a 12px gap, its glyph on the title's first line.
    expect(groupedListItemCss).toMatch(
      /__leading \{[^}]*padding-inline-end: var\(--cinder-space-3\)/,
    );
    expect(groupedListItemCss).toMatch(
      /__leading\[data-cinder-leading='icon'\] \{[^}]*min-inline-size: 1\.75rem/,
    );
    const slot = /\.cinder-skeleton-grouped-leading \{([^}]*)\}/.exec(skeletonCss)?.[1] ?? '';
    expect(slot).toContain('min-inline-size: 1.75rem');
    expect(slot).toContain('padding-inline-end: var(--cinder-space-3)');
    expect(slot).toContain('padding-block: var(--cinder-space-2-5)');
    expect(slot).toContain(
      'block-size: calc( var(--cinder-text-base) * var(--cinder-leading-snug, 1.35) + 2 * var(--cinder-space-2-5) )',
    );
    expect(skeletonCss).toMatch(/\.cinder-skeleton-icon-block \{[^}]*inline-size: 1rem/);
    expect(skeletonCss).toMatch(/\.cinder-skeleton-trailing-bar \{[^}]*margin-inline-start: auto/);
    // Unlike the action block, the trailing bar never drops under the text in a narrow row.
    const narrow =
      /@container cinder-skeleton-grouped-row \(width < 26rem\) \{(.*?)\} \}/.exec(
        skeletonCss,
      )?.[1] ?? '';
    expect(narrow).not.toContain('trailing-bar');
  });
});
