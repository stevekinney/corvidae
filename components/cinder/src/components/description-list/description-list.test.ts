/// <reference lib="dom" />
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { declarationsFor } from '@lostgradient/component-tooling/test/css.ts';
import { setupHappyDom } from '@lostgradient/testing';
import type { DescriptionListDefinition } from './description-list.types.ts';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: DescriptionList } = await import('./description-list.svelte');
const { createRawSnippet } = await import('svelte');

type Item = { id?: string; term: string; definition: DescriptionListDefinition };

function actionSnippet(transform: (item: Item) => string) {
  // createRawSnippet receives getter functions at runtime even though
  // the TypeScript types model them as plain values.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createRawSnippet<[Item]>((getItem: any) => ({
    render: () => transform(getItem()),
  }));
}

function definitionSnippet(html: string): DescriptionListDefinition {
  return createRawSnippet(() => ({
    render: () => html,
  }));
}

afterEach(() => cleanup());

const sampleItems: Item[] = [
  { term: 'Status', definition: 'Active' },
  { term: 'Owner', definition: 'Steve' },
];

describe('DescriptionList', () => {
  test('default variant renders <dl> with rows containing <dt> and <dd>', () => {
    const { container } = render(DescriptionList, { items: sampleItems });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl).not.toBeNull();
    expect(dl?.tagName).toBe('DL');
    expect(dl?.getAttribute('data-cinder-variant')).toBe('default');

    const rows = dl?.querySelectorAll('.cinder-description-list__row');
    expect(rows?.length).toBe(2);

    const firstRow = rows?.[0];
    expect(firstRow?.querySelector('dt')?.textContent).toBe('Status');
    expect(firstRow?.querySelector('dd')?.textContent).toContain('Active');

    const secondRow = rows?.[1];
    expect(secondRow?.querySelector('dt')?.textContent).toBe('Owner');
    expect(secondRow?.querySelector('dd')?.textContent).toContain('Steve');
  });

  test('a definition’s text ends where its value or note does, with no whitespace after it', () => {
    const { container } = render(DescriptionList, {
      items: [
        { term: 'Lease window', definition: '10:38 → still held' },
        { term: 'Check', definition: 'Passed', note: 'tone-check v2' },
      ],
    });
    const definitions = Array.from(
      container.querySelectorAll('.cinder-description-list__definition'),
      (definition) => definition.textContent,
    );
    expect(definitions).toEqual(['10:38 → still held', 'Passed tone-check v2']);
  });

  test('striped variant sets data-cinder-variant="striped"', () => {
    const { container } = render(DescriptionList, { items: sampleItems, variant: 'striped' });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('data-cinder-variant')).toBe('striped');
  });

  test('two-column variant sets data-cinder-variant and preserves DOM order (dt then dd)', () => {
    const { container } = render(DescriptionList, { items: sampleItems, variant: 'two-column' });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('data-cinder-variant')).toBe('two-column');

    const rows = dl?.querySelectorAll('.cinder-description-list__row');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstRow = rows![0]!;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(firstRow.children[0]!.tagName).toBe('DT');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(firstRow.children[1]!.tagName).toBe('DD');
  });

  test('narrow variant renders <dt> with cinder-sr-only class and keeps text in DOM', () => {
    const { container } = render(DescriptionList, { items: sampleItems, variant: 'narrow' });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('data-cinder-variant')).toBe('narrow');

    const dts = dl?.querySelectorAll('dt');
    expect(dts?.length).toBe(2);

    const firstDt = dts?.[0];
    expect(firstDt?.classList.contains('cinder-sr-only')).toBe(true);
    expect(firstDt?.textContent).toBe('Status');

    const firstDd = dl?.querySelector('dd');
    expect(firstDd?.classList.contains('cinder-sr-only')).toBe(false);
  });

  test('fields variant sets data-cinder-variant, keeps each term before its value, and rules each row', () => {
    const { container } = render(DescriptionList, { items: sampleItems, variant: 'fields' });
    const dl = container.querySelector('dl');
    expect(dl?.getAttribute('data-cinder-variant')).toBe('fields');
    const row = container.querySelector('.cinder-description-list__row');
    expect(row?.firstElementChild?.tagName).toBe('DT');
    expect(row?.lastElementChild?.tagName).toBe('DD');
    const css = readFileSync(new URL('./description-list.css', import.meta.url), 'utf8');
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] \.cinder-description-list__row\s*\{[^}]*border-block-end: var\(--cinder-border-width\) solid/s,
    );
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\] dt\s*\{[^}]*font-weight: var\(--cinder-font-normal\)/s,
    );
  });

  // COR-2760: a default row has no fill or frame, so it starts on the content's leading edge.
  test('default rows start on the content edge while every other variant keeps the 12px inset', () => {
    const css = readFileSync(new URL('./description-list.css', import.meta.url), 'utf8');
    expect(
      declarationsFor(
        css,
        ".cinder-description-list[data-cinder-variant='default'] .cinder-description-list__row",
      ).get('padding-inline'),
    ).toBe('0');
    expect(declarationsFor(css, '.cinder-description-list__row').get('padding')).toBe(
      'var(--cinder-space-2) var(--cinder-space-3)',
    );
    // A linked default row keeps its tint 12px past the row's start.
    expect(declarationsFor(css, '.cinder-description-list__link::after').get('inset-inline')).toBe(
      'calc(var(--cinder-space-3) * -1) 0',
    );
  });

  test('fields variant is flat by default and `framed` opts into the tinted frame', () => {
    const flat = render(DescriptionList, { items: sampleItems, variant: 'fields' });
    expect(flat.container.querySelector('dl')?.hasAttribute('data-cinder-framed')).toBe(false);
    flat.unmount();
    const framed = render(DescriptionList, { items: sampleItems, variant: 'fields', framed: true });
    expect(framed.container.querySelector('dl')?.hasAttribute('data-cinder-framed')).toBe(true);
    const css = readFileSync(new URL('./description-list.css', import.meta.url), 'utf8');
    const base = css.match(/\[data-cinder-variant='fields'\]\s*\{([^}]*)\}/s)?.[1] ?? '';
    expect(base).not.toMatch(/background|border-radius|padding-inline-start/);
    // The tinted fill is the framed list's `::before` (COR-2394).
    expect(css).toMatch(
      /\[data-cinder-variant='fields'\]\[data-cinder-framed\]::before\s*\{[^}]*background: var\(--cinder-surface-inset\)/s,
    );
  });

  test('facts variant sets data-cinder-variant and keeps each term before its value', () => {
    const { container } = render(DescriptionList, { items: sampleItems, variant: 'facts' });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('data-cinder-variant')).toBe('facts');
    expect(dl?.querySelectorAll('.cinder-description-list__row').length).toBe(2);
    expect(dl?.querySelector('dt')?.classList.contains('cinder-sr-only')).toBe(false);
    expect(dl?.querySelector('dt')?.nextElementSibling?.tagName).toBe('DD');
  });

  test('actions snippet renders inside <dd> wrapped in .cinder-description-list__actions', () => {
    const actions = actionSnippet((item) => `<a aria-label="Edit ${item.term}">Edit</a>`);
    const { container } = render(DescriptionList, { items: sampleItems, actions });

    const actionsWrappers = container.querySelectorAll('.cinder-description-list__actions');
    expect(actionsWrappers.length).toBe(2);

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const firstActions = actionsWrappers[0]!;
    expect(firstActions.parentElement?.tagName).toBe('DD');
    expect(firstActions.querySelector('[aria-label="Edit Status"]')).not.toBeNull();

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const secondActions = actionsWrappers[1]!;
    expect(secondActions.querySelector('[aria-label="Edit Owner"]')).not.toBeNull();
  });

  test('definition snippets render rich HTML inside the definition wrapper', () => {
    const items: Item[] = [
      { term: 'Run ID', definition: definitionSnippet('<code>abc-123</code>') },
      { term: 'Status', definition: 'Active' },
    ];
    const { container } = render(DescriptionList, { items });

    const definitions = container.querySelectorAll('.cinder-description-list__definition');
    expect(definitions).toHaveLength(2);
    expect(definitions[0]?.querySelector('code')?.textContent).toBe('abc-123');
    expect(definitions[1]?.textContent).toContain('Active');
  });

  test('class prop is composed onto the root <dl>', () => {
    const { container } = render(DescriptionList, {
      items: sampleItems,
      class: 'my-custom-class',
    });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('class')).toContain('cinder-description-list');
    expect(dl?.getAttribute('class')).toContain('my-custom-class');
  });

  test('rest props spread onto the <dl> root', () => {
    const { container } = render(DescriptionList, {
      items: sampleItems,
      id: 'user-info',
      'aria-labelledby': 'user-heading',
    } as Parameters<typeof render>[1]);
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('id')).toBe('user-info');
    expect(dl?.getAttribute('aria-labelledby')).toBe('user-heading');
  });

  test('rest props cannot clobber managed class attribute', () => {
    const { container } = render(DescriptionList, {
      items: sampleItems,
      class: 'rogue',
    });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl?.getAttribute('class')).toContain('cinder-description-list');
    expect(dl?.getAttribute('class')).toContain('rogue');
  });

  test('empty items renders an empty <dl> with no rows', () => {
    const { container } = render(DescriptionList, { items: [] });
    const dl = container.querySelector('.cinder-description-list');
    expect(dl).not.toBeNull();
    const rows = dl?.querySelectorAll('.cinder-description-list__row');
    expect(rows?.length).toBe(0);
  });

  test('keying with explicit id renders both rows when terms are duplicate', () => {
    const items: Item[] = [
      { id: 'email-work', term: 'Email', definition: 'work@example.com' },
      { id: 'email-personal', term: 'Email', definition: 'personal@example.com' },
    ];
    const { container } = render(DescriptionList, { items });
    const rows = container.querySelectorAll('.cinder-description-list__row');
    expect(rows.length).toBe(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(rows[0]!.textContent).toContain('work@example.com');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(rows[1]!.textContent).toContain('personal@example.com');
  });

  test('keying falls back to term when id is omitted', () => {
    const items: Item[] = [
      { term: 'Alpha', definition: 'first' },
      { term: 'Beta', definition: 'second' },
    ];
    const { container } = render(DescriptionList, { items });
    const rows = container.querySelectorAll('.cinder-description-list__row');
    expect(rows.length).toBe(2);
  });

  test('default <dd> margin reset is present in the stylesheet', async () => {
    const css = await Bun.file(`${import.meta.dir}/description-list.css`).text();
    expect(css).toMatch(/\.cinder-description-list[^{]*dd[^{]*\{[^}]*margin:\s*0/);
  });

  test('default variant row dividers are scoped away from striped rows', async () => {
    const css = await Bun.file(`${import.meta.dir}/description-list.css`).text();
    expect(css).toMatch(
      /\.cinder-description-list\[data-cinder-variant='default'\][\s\S]*?\.cinder-description-list__row:not\(:first-child\)[\s\S]*?border-block-start:\s*var\(--cinder-border-width\) solid var\(--cinder-border-muted\)/,
    );
    expect(css).not.toMatch(
      /\.cinder-description-list\[data-cinder-variant='striped'\][\s\S]*?border-block-start/,
    );
  });

  test('two-column layout uses subgrid progressively and collapses by container width', async () => {
    const css = await Bun.file(`${import.meta.dir}/description-list.css`).text();

    expect(css).toContain('@supports (grid-template-columns: subgrid)');
    expect(css).toContain('grid-template-columns: subgrid;');
    expect(css).toContain('@container (max-width: 28rem)');
    expect(css).toMatch(/@container \(max-width: 28rem\)[\s\S]*?grid-template-columns:\s*1fr;/);
  });

  test('<dl> content model: only row divs as direct children, each with exactly dt then dd', () => {
    const { container } = render(DescriptionList, { items: sampleItems });
    const dl = container.querySelector('.cinder-description-list')!;

    for (const child of Array.from(dl.children)) {
      expect(child.tagName).toBe('DIV');
      expect(child.classList.contains('cinder-description-list__row')).toBe(true);
      expect(child.children.length).toBe(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(child.children[0]!.tagName).toBe('DT');
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(child.children[1]!.tagName).toBe('DD');
    }
  });

  test('<dd> content model: definition div first, at most one actions div, in order', () => {
    const actions = actionSnippet((item) => `<button>Edit ${item.term}</button>`);
    const { container } = render(DescriptionList, { items: sampleItems, actions });
    const dds = container.querySelectorAll('dd');

    for (const dd of Array.from(dds)) {
      const children = Array.from(dd.children);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(children[0]!.classList.contains('cinder-description-list__definition')).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(children[1]!.classList.contains('cinder-description-list__actions')).toBe(true);
      expect(children.length).toBe(2);
    }
  });

  test('<dd> without actions contains only the definition div', () => {
    const { container } = render(DescriptionList, { items: sampleItems });
    const dds = container.querySelectorAll('dd');

    for (const dd of Array.from(dds)) {
      const children = Array.from(dd.children);
      expect(children.length).toBe(1);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(children[0]!.classList.contains('cinder-description-list__definition')).toBe(true);
    }
  });
});

const descriptionListCss = await Bun.file(
  new URL('./description-list.css', import.meta.url),
).text();

describe('DescriptionList formatted values', () => {
  test('formats a timestamp as readable text with the exact time on hover', () => {
    const { container } = render(DescriptionList, {
      items: [
        { term: 'Created', definition: { type: 'timestamp', value: '2026-10-30T14:15:07Z' } },
      ],
    });
    const time = container.querySelector('dd time');
    expect(time).not.toBeNull();
    // Readable: a short date and time in the list's time zone.
    // ICU 74+ joins the date and time with "at", older ICU with a comma.
    expect(time?.textContent?.trim()).toMatch(/^Oct 30, 2026(?:,| at) 2:15 PM UTC$/);
    // Exact: the full date with seconds, on hover.
    expect(time?.getAttribute('title')).toMatch(
      /^Friday, October 30, 2026(?:,| at) 2:15:07 PM UTC$/,
    );
    // Machine-readable: the exact instant.
    expect(time?.getAttribute('datetime')).toBe('2026-10-30T14:15:07.000Z');
  });

  test('accepts a Date and an epoch number, and honours the time zone and locale', () => {
    const when = new Date('2026-10-30T14:15:07Z');
    const { container } = render(DescriptionList, {
      items: [
        { id: 'date', term: 'Date', definition: { type: 'timestamp', value: when } },
        {
          id: 'epoch',
          term: 'Epoch',
          definition: { type: 'timestamp', value: when.getTime(), timeZone: 'America/New_York' },
        },
      ],
    });
    const times = Array.from(container.querySelectorAll('dd time'));
    expect(times[0]?.textContent?.trim()).toMatch(/^Oct 30, 2026(?:,| at) 2:15 PM UTC$/);
    expect(times[1]?.textContent?.trim()).toContain('10:15 AM');
  });

  test('an unparseable timestamp reads as invalid and carries no title', () => {
    const { container } = render(DescriptionList, {
      items: [{ term: 'Created', definition: { type: 'timestamp', value: 'not a date' } }],
    });
    expect(container.querySelector('dd time')).toBeNull();
    expect(container.querySelector('dd')?.textContent).toContain('Invalid date');
  });

  test('shortens an ID and offers a copy button that copies the whole value', async () => {
    const id = '3f2b9c1a-7d4e-4a86-9b0c-1e5d6f7a8b90';
    const writeText = mock(async () => undefined);
    const originalClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      const { container } = render(DescriptionList, {
        items: [{ term: 'Run ID', definition: { type: 'identifier', value: id } }],
      });
      const code = container.querySelector('dd code');
      expect(code?.textContent?.trim()).toBe('3f2b9c1a…8b90');
      expect(code?.textContent).not.toBe(id);
      expect(code?.getAttribute('title')).toBe(id);

      const copy = container.querySelector<HTMLButtonElement>('dd .cinder-copy-button');
      expect(copy).not.toBeNull();
      expect(copy?.getAttribute('aria-label')).toBe('Copy Run ID');
      expect(copy?.getAttribute('data-cinder-appearance')).toBe('inline');
      // Icon-only: an icon and no visible text.
      expect(copy?.querySelector('svg')).not.toBeNull();
      expect(copy?.textContent?.trim()).toBe('');

      await fireEvent.click(copy as HTMLButtonElement);
      expect(writeText).toHaveBeenCalledWith(id);
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test('shows a short ID whole', () => {
    const { container } = render(DescriptionList, {
      items: [{ term: 'Run ID', definition: { type: 'identifier', value: 'run-42' } }],
    });
    expect(container.querySelector('dd code')?.textContent?.trim()).toBe('run-42');
  });

  test('lists read-only tags and counts system tags instead of listing them', () => {
    const { container } = render(DescriptionList, {
      items: [
        {
          term: 'Tags',
          definition: { type: 'tags', tags: ['billing', 'nightly'], systemTagCount: 3 },
        },
      ],
    });
    const chips = Array.from(container.querySelectorAll('dd .cinder-chip'));
    expect(chips.map((chip) => chip.textContent?.trim())).toEqual(['billing', 'nightly']);
    // Read-only: nothing to remove.
    expect(container.querySelector('dd [aria-label^="Remove"]')).toBeNull();
    expect(
      container.querySelector('dd .cinder-description-list__system-tags')?.textContent,
    ).toContain('3 system tags');
    // Without a callback there is no add action.
    expect(container.querySelector('dd button')).toBeNull();
  });

  test('offers an empty label and Add a tag when a callback is given and calls it', async () => {
    const onAddTag = mock(() => {});
    const { container, getByRole } = render(DescriptionList, {
      items: [
        { term: 'Tags', definition: { type: 'tags', tags: [], emptyLabel: 'None', onAddTag } },
      ],
    });
    expect(container.querySelector('.cinder-description-list__empty')?.textContent).toBe('None');
    expect(container.querySelectorAll('.cinder-description-list__tag')).toHaveLength(0);
    await fireEvent.click(getByRole('button', { name: 'Add a tag' }));
    expect(onAddTag).toHaveBeenCalledTimes(1);
  });

  test('keeps the default add-only empty state quiet until a caller opts into an empty label', () => {
    const { container } = render(DescriptionList, {
      props: {
        items: [{ term: 'Tags', definition: { type: 'tags', tags: [], onAddTag: () => {} } }],
      },
    });
    expect(container.querySelector('.cinder-description-list__empty')).toBeNull();
    expect(container.querySelector('button')?.textContent).toContain('Add a tag');
  });

  test('singularises one system tag and says No tags for an empty read-only list', () => {
    const { container } = render(DescriptionList, {
      items: [
        { id: 'one', term: 'One', definition: { type: 'tags', tags: [], systemTagCount: 1 } },
        { id: 'none', term: 'None', definition: { type: 'tags', tags: [] } },
      ],
    });
    const text = container.textContent ?? '';
    expect(text).toContain('1 system tag');
    expect(text).not.toContain('1 system tags');
    expect(text).toContain('No tags');
  });

  test('a note is a muted second line under its definition, read with it, and absent when empty', () => {
    const { container } = render(DescriptionList, {
      items: [
        { term: 'Check', definition: 'Contains phrase', note: 'contains-phrase, version 1' },
        { term: 'Owner', definition: 'Steve', note: '' },
        { term: 'Status', definition: 'Active' },
      ],
    });
    const rows = [...container.querySelectorAll('.cinder-description-list__row')];
    const note = rows[0]?.querySelector('dd .cinder-description-list__note');
    expect(note?.textContent).toBe('contains-phrase, version 1');
    // The note sits in the same definition as the value, so a reader hears them together.
    expect(note?.closest('.cinder-description-list__definition')?.textContent).toContain(
      'Contains phrase',
    );
    expect(rows[1]?.querySelector('.cinder-description-list__note')).toBeNull();
    expect(rows[2]?.querySelector('.cinder-description-list__note')).toBeNull();
    expect(descriptionListCss).toMatch(
      /\.cinder-description-list__note\s*\{[^}]*color:\s*var\(--cinder-text-muted\)/,
    );
  });

  test('two-column variant mutes the term and draws no row dividers', () => {
    const rule = (selector: string) =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
        descriptionListCss,
      )?.[1] ?? '';
    expect(rule(".cinder-description-list[data-cinder-variant='two-column'] dt")).toContain(
      'color: var(--cinder-text-muted)',
    );
    // Only the default variant draws a divider.
    const dividers = descriptionListCss.match(/border-block-start[^;]*;/g) ?? [];
    expect(dividers).toHaveLength(1);
    expect(descriptionListCss).toMatch(
      /data-cinder-variant='default'\]\s*\.cinder-description-list__row:not\(:first-child\)\s*\{[^}]*border-block-start/,
    );
  });

  test('code is shown whole in a code element, and an empty field as a quiet word', () => {
    const { container } = render(DescriptionList, {
      items: [
        { term: 'Payload', definition: { type: 'code', value: '{"orderId":4471}' } },
        { term: 'Note', definition: { type: 'empty', label: 'None' } },
      ],
    });
    const code = container.querySelector('.cinder-description-list__code');
    expect(code?.tagName).toBe('CODE');
    expect(code?.textContent).toBe('{"orderId":4471}');
    expect(container.querySelector('.cinder-description-list__empty')?.textContent).toBe('None');
  });
});

describe('DescriptionList grid variant', () => {
  const flat = descriptionListCss.replace(/\s+/g, ' ');

  test('flows the pairs in as many equal columns as its own width fits, a term over each value', () => {
    const grid =
      /\.cinder-description-list\[data-cinder-variant='grid'\] \{([^}]*)\}/.exec(flat)?.[1] ?? '';
    // Tracks from the list's own inline size (auto-fill), never a viewport query, at a token width.
    expect(grid).toContain('display: grid;');
    expect(grid).toMatch(
      /grid-template-columns: repeat\( auto-fill, minmax\(min\(100%, var\(--_cinder-description-list-column-min\)\), 1fr\) \);/,
    );
    expect(grid).toContain(
      '--_cinder-description-list-column-min: calc(var(--cinder-space-24) + var(--cinder-space-2));',
    );
    expect(grid).toContain('gap: var(--cinder-space-2) var(--cinder-space-3);');
    // No rules and no fill: neither the list nor its rows draw a border or a background.
    expect(flat).not.toMatch(/variant='grid'\][^{]*\{[^}]*(border|background)/);
    expect(flat).not.toMatch(/@media[^{]*\{[^}]*variant='grid'/);
  });

  test('a wide item takes the whole row, in the grid and facts variants', () => {
    const { container } = render(DescriptionList, {
      variant: 'grid',
      items: [
        { term: 'Order ID', definition: '4471' },
        { term: 'Reason', definition: 'A long reason that runs past two lines', wide: true },
      ],
    });
    const rows = [...container.querySelectorAll('.cinder-description-list__row')];
    expect(rows.map((row) => row.hasAttribute('data-cinder-wide'))).toEqual([false, true]);
    expect(container.querySelector('dl')?.getAttribute('data-cinder-variant')).toBe('grid');
    expect(flat).toContain(
      ".cinder-description-list:is([data-cinder-variant='facts'], [data-cinder-variant='grid']) .cinder-description-list__row[data-cinder-wide] { grid-column: 1 / -1; }",
    );
  });
});
