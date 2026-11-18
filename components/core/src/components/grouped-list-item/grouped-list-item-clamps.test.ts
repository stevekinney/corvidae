/// <reference lib="dom" />
/**
 * GroupedListItem's clamped text (COR-2227): `titleLines` and `subtitleLines` are the most lines at
 * every width, the clamped text reads in one native tooltip on the row (never one per line, which a
 * linked row's cover would hide), `chevronColumn` keeps the chevron's column on a row with no link,
 * the narrow shape pins the chevron to the title's first line, and a leading glyph sits on that
 * line at every width.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: GroupedListItem } = await import('./grouped-list-item.svelte');

const text = (value: string) => createRawSnippet(() => ({ render: () => `<span>${value}</span>` }));

const css = readFileSync(new URL('./grouped-list-item.css', import.meta.url), 'utf8')
  .replace(/\/\*.*?\*\//gs, '')
  .replace(/\s+/g, ' ');

const longTitle =
  'Release notes digest finished for the week of October 26, with eleven changes across four workflows and two agents';
const longBody =
  'Warning, The digest skipped two drafts because their authors had not marked them ready, and one draft was over its length limit';

describe('GroupedListItem clamps', () => {
  test('titleLines and subtitleLines mark their lines, and an unset prop leaves the text unclamped', () => {
    const clamped = render(GroupedListItem, {
      props: {
        title: text(longTitle),
        subtitle: text(longBody),
        titleLines: 2,
        subtitleLines: 1,
      },
    });
    const title = clamped.container.querySelector('.cinder-grouped-list-item__title');
    const subtitle = clamped.container.querySelector('.cinder-grouped-list-item__subtitle');
    expect(title?.getAttribute('data-cinder-lines')).toBe('2');
    expect(subtitle?.getAttribute('data-cinder-lines')).toBe('1');
    // The clamp is visual only: the whole text stays in the document.
    expect(title?.textContent).toBe(longTitle);
    expect(subtitle?.textContent).toBe(longBody);
    clamped.unmount();

    const plain = render(GroupedListItem, {
      props: { title: text('Home'), subtitle: text('On') },
    });
    expect(
      plain.container
        .querySelector('.cinder-grouped-list-item__title')
        ?.hasAttribute('data-cinder-lines'),
    ).toBe(false);
    expect(
      plain.container
        .querySelector('.cinder-grouped-list-item__subtitle')
        ?.hasAttribute('data-cinder-lines'),
    ).toBe(false);
  });

  test('the stylesheet clamps at every width, outside any container query', () => {
    const outsideQueries = css.replace(/@container[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    expect(outsideQueries).toMatch(
      /__title\[data-cinder-lines\], \.cinder-grouped-list-item__subtitle\[data-cinder-lines\] \{[^}]*-webkit-box-orient: vertical[^}]*overflow: hidden/,
    );
    expect(outsideQueries).toMatch(/\[data-cinder-lines='2'\] \{[^}]*line-clamp: 2/);
    expect(outsideQueries).toMatch(/\[data-cinder-lines='1'\] \{[^}]*line-clamp: 1/);
  });
});

describe('GroupedListItem row tooltip', () => {
  test('a linked row draws one tooltip on the row: the title, a line break, then line two', () => {
    const { container, getByRole, queryByRole } = render(GroupedListItem, {
      props: {
        href: '/runs/7',
        title: text(longTitle),
        subtitle: text(longBody),
        titleLines: 2,
        subtitleLines: 2,
        tooltip: longTitle,
        subtitleTooltip: longBody,
      },
    });
    expect(container.querySelector('li')?.getAttribute('title')).toBe(`${longTitle}\n${longBody}`);
    // Neither line carries a tooltip of its own: the link's cover would hide line two's.
    expect(container.querySelectorAll('[title]')).toHaveLength(1);
    expect(container.querySelector('.cinder-grouped-list-item__title')?.hasAttribute('title')).toBe(
      false,
    );
    expect(
      container.querySelector('.cinder-grouped-list-item__subtitle')?.hasAttribute('title'),
    ).toBe(false);
    // The tooltip is on the row, not the link, so the link's description does not repeat its name
    // and the row adds no focus stop.
    expect(getByRole('link').textContent).toBe(longTitle);
    expect(getByRole('link').hasAttribute('title')).toBe(false);
    expect(queryByRole('link', { description: /./ })).toBeNull();
    expect(container.querySelector('li')?.hasAttribute('tabindex')).toBe(false);
  });

  test('a row with no link draws the same tooltip and stays out of the tab order', () => {
    const { container } = render(GroupedListItem, {
      props: {
        title: text(longTitle),
        subtitle: text(longBody),
        tooltip: longTitle,
        subtitleTooltip: longBody,
      },
    });
    const row = container.querySelector('li');
    expect(row?.getAttribute('title')).toBe(`${longTitle}\n${longBody}`);
    expect(row?.hasAttribute('tabindex')).toBe(false);
    expect(container.querySelector('a')).toBeNull();
  });

  test('a row with no line two has the title alone, with no line break; a row with neither has none', () => {
    const titleOnly = render(GroupedListItem, {
      props: { href: '/runs/7', title: text('Run started'), tooltip: 'Run started' },
    });
    expect(titleOnly.container.querySelector('li')?.getAttribute('title')).toBe('Run started');
    titleOnly.unmount();
    const none = render(GroupedListItem, { props: { title: text('Run started') } });
    expect(none.container.querySelector('li')?.hasAttribute('title')).toBe(false);
  });
});

describe('GroupedListItem chevron column', () => {
  test('a linked row marks its chevron, and an unlinked row with chevronColumn keeps the column', () => {
    const linked = render(GroupedListItem, {
      props: { href: '/runs/7', title: text('A'), trailing: text('10:42 AM') },
    });
    const linkedRow = linked.container.querySelector('li');
    expect(linkedRow?.classList.contains('cinder-grouped-list-item--chevron')).toBe(true);
    expect(linkedRow?.classList.contains('cinder-grouped-list-item--chevron-column')).toBe(false);
    linked.unmount();

    const kept = render(GroupedListItem, {
      props: { title: text('A'), trailing: text('10:42 AM'), chevronColumn: true },
    });
    const keptRow = kept.container.querySelector('li');
    expect(keptRow?.classList.contains('cinder-grouped-list-item--chevron-column')).toBe(true);
    expect(kept.container.querySelector('.cinder-grouped-list-item__chevron')).toBeNull();
    kept.unmount();

    const plain = render(GroupedListItem, { props: { title: text('A') } });
    expect(
      plain.container.querySelector('li')?.classList.contains('cinder-grouped-list-item--chevron'),
    ).toBe(false);
  });

  test('the column is reserved padding at every width, the same width as the chevron and its gap', () => {
    expect(css).toMatch(
      /--_cinder-grouped-list-item-chevron-column: calc\(1rem \+ var\(--cinder-space-3\)\)/,
    );
    expect(css).toMatch(
      /\.cinder-grouped-list-item--chevron-column > \.cinder-grouped-list-item__content \{ padding-inline-end: calc\( var\(--cinder-space-2\) \+ var\(--_cinder-grouped-list-item-chevron-column\) \); \}/,
    );
  });

  test('in a narrow row the chevron is pinned to the first line and line two runs under its column', () => {
    const phone =
      /@container cinder-grouped-list-item \(width < 26rem\) \{(.*?)\} \}/.exec(css)?.[1] ?? '';
    expect(phone).toMatch(
      /--trailing\.cinder-grouped-list-item--chevron:not\( \.cinder-grouped-list-item--flow-chevron, \.cinder-grouped-list-item--timed \) > \.cinder-grouped-list-item__content \{ padding-inline-end: calc\( var\(--cinder-space-2\) \+ var\(--_cinder-grouped-list-item-chevron-column\) \); \}/,
    );
    // A time-led row keeps its chevron in its own grid, on the first row (COR-2503).
    const pinned =
      /--trailing:not\( \.cinder-grouped-list-item--flow-chevron, \.cinder-grouped-list-item--timed \) \.cinder-grouped-list-item__chevron \{([^}]*)\}/.exec(
        phone,
      )?.[1] ?? '';
    expect(pinned).toContain('position: absolute');
    expect(pinned).toContain('inset-block-start: var(--cinder-space-2-5)');
    expect(pinned).toContain('inset-inline-end: var(--cinder-space-2)');
    // Drawn over the link's cover, so it takes no pointer: a press on it opens the row.
    expect(pinned).toContain('pointer-events: none');
    expect(phone).toMatch(
      /__subtitle \{ margin-inline-end: calc\(var\(--_cinder-grouped-list-item-chevron-column\) \* -1\); \}/,
    );
  });

  test('a suggested row, or one led by an avatar or a thumbnail, keeps its chevron in the flow', () => {
    const suggested = render(GroupedListItem, {
      props: { title: text('Call'), href: '/next/1', trailing: text('10:42 AM'), suggested: true },
    });
    expect(
      suggested.container
        .querySelector('li')
        ?.classList.contains('cinder-grouped-list-item--flow-chevron'),
    ).toBe(true);
    suggested.unmount();
    const avatar = render(GroupedListItem, {
      props: {
        title: text('Ada'),
        href: '/people/ada',
        trailing: text('10:42 AM'),
        leading: text('A'),
        leadingKind: 'avatar',
      },
    });
    expect(
      avatar.container
        .querySelector('li')
        ?.classList.contains('cinder-grouped-list-item--flow-chevron'),
    ).toBe(true);
    avatar.unmount();
    const icon = render(GroupedListItem, {
      props: {
        title: text('Run'),
        href: '/runs/7',
        trailing: text('10:42 AM'),
        leading: text('I'),
      },
    });
    expect(
      icon.container
        .querySelector('li')
        ?.classList.contains('cinder-grouped-list-item--flow-chevron'),
    ).toBe(false);
  });
});

describe('GroupedListItem leading glyph', () => {
  test('a leading icon sits on the title’s first line at every width, never centred on the row', () => {
    const outsideQueries = css.replace(/@container[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    const rule =
      /\.cinder-grouped-list-item__leading\[data-cinder-leading='icon'\] \{([^}]*)\}/.exec(
        outsideQueries,
      )?.[1] ?? '';
    expect(rule).toContain('align-self: flex-start');
    expect(rule).toContain('min-inline-size: 1.75rem');
    expect(rule).toContain(
      'block-size: calc(var(--_cinder-grouped-list-item-title-line) + 2 * var(--cinder-space-2-5))',
    );
    expect(rule).toContain('padding-block: var(--cinder-space-2-5)');
  });
});

describe('GroupedListItem arriving', () => {
  test('a row that arrives fades in over the fast duration, and only that row', () => {
    const arriving = render(GroupedListItem, { props: { title: text('A'), arriving: true } });
    expect(
      arriving.container
        .querySelector('li')
        ?.classList.contains('cinder-grouped-list-item--arriving'),
    ).toBe(true);
    arriving.unmount();
    const settled = render(GroupedListItem, { props: { title: text('A') } });
    expect(
      settled.container
        .querySelector('li')
        ?.classList.contains('cinder-grouped-list-item--arriving'),
    ).toBe(false);
    expect(css).toMatch(
      /\.cinder-grouped-list-item--arriving \{ animation: cinder-grouped-list-item-arrive var\(--cinder-duration-fast\) var\(--cinder-ease-standard\); \}/,
    );
  });
});
