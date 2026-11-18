/// <reference lib="dom" />
import { describe, expect, test } from 'bun:test';
import { parse } from 'postcss';

/**
 * COR-2449 (AC10): a placeholder takes the same space as the shape it stands in for, so nothing
 * moves when the data arrives. happy-dom does no layout, so each test holds the declarations that
 * make the height (the same token, line height, padding and gap) equal on the placeholder and on
 * the loaded component's own stylesheet; the Chromium measurement lives in the browser fixture
 * specs.
 */
async function sheet(path: string): Promise<string> {
  return Bun.file(new URL(path, import.meta.url)).text();
}

const skeleton = await sheet('./skeleton.css');
const stackedListItem = await sheet('../stacked-list-item/stacked-list-item.css');
const dataList = await sheet('../data-list/data-list.css');
const groupedListItem = await sheet('../grouped-list-item/grouped-list-item.css');
const formField = await sheet('../form-field/form-field.css');
const formSection = await sheet('../form-section/form-section.css');
const input = await sheet('../input/input.css');
const card = await sheet('../card/card.css');
const feed = await sheet('../feed/feed.css');
const tokens = await sheet('../../../../tokens/src/styles/tokens-base.css');
const foundation = await sheet('../../../../foundation/src/styles/foundation.css');

/** A loaded status-first list draws no border of its own: not the list, and not a row. */
function loadedHasNoFrame(): boolean {
  const drawn = [
    ...rule(stackedListItem, '.cinder-stacked-list-item').keys(),
    ...rule(dataList, '.cinder-data-list').keys(),
  ];
  return !drawn.some((property) => property.startsWith('border') || property === 'background');
}

/** The declarations of every rule that names `selector` on its own, later rules over earlier. */
function rule(css: string, selector: string): Map<string, string> {
  const wanted = selector.replace(/\s+/g, ' ').trim();
  const found = new Map<string, string>();
  parse(css).walkRules((candidate) => {
    const names = candidate.selector.split(',').map((entry) => entry.replace(/\s+/g, ' ').trim());
    if (!names.includes(wanted)) return;
    candidate.walkDecls((declaration) => {
      found.set(declaration.prop, declaration.value);
    });
  });
  expect(found.size, `${selector} must declare something`).toBeGreaterThan(0);
  return found;
}

function declared(css: string, selector: string, property: string): string {
  const value = rule(css, selector).get(property);
  expect(value, `${selector} must declare ${property}`).toBeDefined();
  // Whitespace and the space inside a bracket do not change a value.
  return value!.replace(/\s+/g, ' ').replace(/\(\s/g, '(').replace(/\s\)/g, ')').trim();
}

/** One line of text in the type a rule sets: its size times its leading. */
function lineOf(css: string, selector: string): string {
  return `calc(${declared(css, selector, 'font-size')} * ${declared(css, selector, 'line-height')})`;
}

const LOADED_ROW =
  ".cinder-stacked-list-item.cinder-stacked-list-item--lines:not([data-cinder-density='condensed'])";

describe('the list placeholder is as tall as a two-line StackedListItem', () => {
  // A copy of the row's numbers drifted by 4px to 5px (the placeholder was 59.5px, a loaded row 64px,
  // COR-2449 review). The placeholder row is now the row's own markup in its own classes, so its
  // padding, gaps, lines, status column and phone form are the row's by construction, and these
  // tests hold the construction: the placeholder declares none of them and takes the real classes.
  test('its row declares no padding, gap, grid or height of its own: the row classes give them', () => {
    const own = rule(skeleton, '.cinder-skeleton-row');
    for (const property of [
      'display',
      'padding',
      'padding-block',
      'padding-inline',
      'min-block-size',
      'grid-template-columns',
      'grid-template-rows',
      'grid-template-areas',
      'row-gap',
      'column-gap',
      'border-block-start',
    ]) {
      expect(own.has(property), `.cinder-skeleton-row must not declare ${property}`).toBe(false);
    }
    // The row's padding the placeholder takes is the two-line row's own.
    expect(declared(stackedListItem, LOADED_ROW, 'padding-block')).toBeDefined();
  });

  test('the markup is the row layout in the row classes, status column and phone form included', async () => {
    const markup = await sheet('./skeleton.svelte');
    for (const name of [
      'cinder-stacked-list-item cinder-stacked-list-item--lines cinder-stacked-list-item--status-leading',
      'cinder-stacked-list-item--status-column',
      'cinder-stacked-list-item__layout',
      'cinder-stacked-list-item__status',
      'cinder-stacked-list-item__title',
      'cinder-stacked-list-item__time',
      'cinder-stacked-list-item__line-two',
      'cinder-stacked-list-item__meta',
      'cinder-stacked-list-item__detail',
      'cinder-status-dot',
    ]) {
      expect(markup, name).toContain(name);
    }
    expect(skeleton).toContain("@import '../stacked-list-item/stacked-list-item.css';");
    // The row's own phone form: the status leads line two at the row's width.
    expect(stackedListItem).toMatch(
      /'leading title title time trailing'\s*'leading status line line trailing'/,
    );
    // The status column is the real one.
    expect(
      declared(
        stackedListItem,
        '.cinder-stacked-list-item--lines.cinder-stacked-list-item--status-column > .cinder-stacked-list-item__layout',
        '--_cinder-status-track',
      ),
    ).toBe('calc(var(--_cinder-status-width, 8rem) + var(--cinder-space-3))');
  });

  test('the margin the page gives a loaded row is given to the placeholder row too', () => {
    const margin = declared(foundation, ':where(li)', 'margin-bottom');
    expect(declared(skeleton, '.cinder-skeleton-row', 'margin-block-end')).toBe(margin);
  });

  test('the placeholder draws no frame, and no divider between rows, by default', () => {
    expect(skeleton.replace(/\s+/g, ' ')).not.toMatch(/\.cinder-skeleton-list \{[^}]*border/);
    expect(skeleton).not.toMatch(/\.cinder-skeleton-row \+ \.cinder-skeleton-row/);
    expect(loadedHasNoFrame()).toBe(true);
  });

  test('the day band bar sits in one line of the real group header, in its padding', () => {
    const header = '.cinder-data-list-group__header';
    // The real header's `padding: block inline` is the band's two paddings.
    expect(
      `${declared(skeleton, '.cinder-skeleton-day-band', 'padding-block')} ${declared(skeleton, '.cinder-skeleton-day-band', 'padding-inline')}`,
    ).toBe(declared(dataList, header, 'padding'));
    expect(declared(skeleton, '.cinder-skeleton-day-band', 'border-block-end')).toBe(
      declared(dataList, header, 'border-block-end'),
    );
    const line = lineOf(dataList, header).replace(/^calc\(|\)$/g, '');
    expect(declared(skeleton, '.cinder-skeleton-day-bar', 'margin-block')).toBe(
      `calc((${line} - 0.625rem) / 2)`,
    );
  });
});

describe('the grouped placeholder is as tall as a GroupedListItem', () => {
  test('its row has the same minimum height, padding, gap, separator and lines', () => {
    expect(declared(skeleton, '.cinder-skeleton-grouped-content', 'min-block-size')).toBe(
      declared(groupedListItem, '.cinder-grouped-list-item', 'min-block-size'),
    );
    for (const property of ['padding-block', 'padding-inline-end', 'gap', 'border-block-end']) {
      expect(declared(skeleton, '.cinder-skeleton-grouped-content', property)).toBe(
        declared(groupedListItem, '.cinder-grouped-list-item__content', property),
      );
    }
    expect(declared(skeleton, '.cinder-skeleton-grouped-row', 'padding-inline-start')).toBe(
      declared(groupedListItem, '.cinder-grouped-list-item', 'padding-inline-start'),
    );
    expect(declared(skeleton, '.cinder-skeleton-grouped-text', 'gap')).toBe(
      declared(groupedListItem, '.cinder-grouped-list-item__text', 'gap'),
    );
    expect(declared(skeleton, '.cinder-skeleton-grouped-line--title', 'font-size')).toBe(
      declared(groupedListItem, '.cinder-grouped-list-item', 'font-size'),
    );
    expect(declared(skeleton, '.cinder-skeleton-grouped-line--title', 'line-height')).toBe(
      declared(groupedListItem, '.cinder-grouped-list-item__title', 'line-height'),
    );
    expect(declared(skeleton, '.cinder-skeleton-grouped-line--subtitle', 'font-size')).toBe(
      declared(groupedListItem, '.cinder-grouped-list-item__subtitle', 'font-size'),
    );
    expect(declared(skeleton, '.cinder-skeleton-grouped-line', 'block-size')).toBe('1lh');
  });
});

describe('the form placeholder is as tall as the fields it stands for', () => {
  const lines = ".cinder-skeleton-group[data-cinder-variant='form'] > .cinder-skeleton-lines";

  test('the label is in the label line, the gap is the field gap, the control is the control height', () => {
    expect(declared(skeleton, lines, 'gap')).toBe(declared(formField, '.cinder-form-field', 'gap'));
    const label = rule(skeleton, `${lines} > .cinder-skeleton-field-label`);
    expect(label.get('margin-block')?.replace(/\s+/g, ' ')).toBe(
      `calc( (var(--cinder-text-xs) * var(--cinder-leading-snug) - var(--cinder-space-2-5)) / 2 )`,
    );
    expect(declared(formField, '.cinder-form-field__label', 'font-size')).toBe(
      'var(--cinder-text-xs)',
    );
    expect(declared(formField, '.cinder-form-field__label', 'line-height')).toBe(
      'var(--cinder-leading-snug)',
    );
    expect(label.get('block-size')).toBe('var(--cinder-space-2-5)');
    expect(rule(skeleton, `${lines} > .cinder-skeleton-field-control`).get('block-size')).toBe(
      declared(input, '.cinder-input', '--_cinder-input-height'),
    );
  });

  test('fields are a form gap apart and the last one has none after it', () => {
    expect(declared(formSection, '.cinder-form-section__grid', 'gap')).toBe(
      'var(--cinder-form-section-gap, 1rem)',
    );
    expect(
      rule(skeleton, `${lines} > .cinder-skeleton-field-control`)
        .get('margin-block-end')
        ?.replace(/\s+/g, ' '),
    ).toBe('calc(var(--cinder-space-4) - var(--cinder-space-1-5))');
    // The form's default gap is 1rem, which is --cinder-space-4.
    expect(tokens).toMatch(/--cinder-space-4: 1rem;/);
    expect(
      rule(skeleton, `${lines} > .cinder-skeleton-field-control:last-child`).get(
        'margin-block-end',
      ),
    ).toBe('0');
  });
});

describe('the card placeholder is as tall as a Card', () => {
  const lines = ".cinder-skeleton-group[data-cinder-variant='card'] > .cinder-skeleton-lines";

  test('it has the card body padding, the card radius and a one-pixel edge', () => {
    expect(declared(skeleton, lines, 'padding')).toBe(
      declared(card, '.cinder-card__body', 'padding'),
    );
    expect(declared(skeleton, lines, 'border-radius')).toBe(
      declared(card, '.cinder-card', 'border-radius'),
    );
    expect(declared(skeleton, lines, 'border')).toMatch(/^1px solid /);
    expect(declared(card, '.cinder-card', 'border')).toMatch(/^1px solid /);
  });

  test('the heading bar is in a line of the title size, and lines of text have no gap between them', () => {
    expect(
      declared(skeleton, '.cinder-skeleton-lines > .cinder-skeleton-heading', 'font-size'),
    ).toBe(declared(card, '.cinder-card__title', 'font-size'));
    expect(
      declared(skeleton, '.cinder-skeleton-lines > .cinder-skeleton-heading', 'margin-block'),
    ).toBe('calc((1lh - 1.25em) / 2)');
    expect(declared(skeleton, '.cinder-skeleton-lines', 'gap')).toBe('0');
    expect(declared(skeleton, '.cinder-skeleton-lines > .cinder-skeleton', 'margin-block')).toBe(
      'calc((1lh - 1em) / 2)',
    );
  });
});

describe('a stack of lines is as tall as the same lines of text', () => {
  test('each bar plus its margin is one line box (1lh), and no gap is added', () => {
    // 1em of bar and (1lh - 1em) / 2 above and below make exactly 1lh per line.
    expect(declared(skeleton, '.cinder-skeleton', 'height')).toBe('1em');
    expect(declared(skeleton, '.cinder-skeleton-lines > .cinder-skeleton', 'margin-block')).toBe(
      'calc((1lh - 1em) / 2)',
    );
    expect(declared(skeleton, '.cinder-skeleton-lines', 'gap')).toBe('0');
  });
});

describe('the feed log placeholder is as tall as the entries list', () => {
  test('it has the list padding and gap, and each bar is a line of the log text', () => {
    expect(declared(feed, '.cinder-feed-log__loading', 'padding')).toBe(
      declared(feed, '.cinder-feed-log .cinder-feed', 'padding'),
    );
    expect(declared(feed, '.cinder-feed-log__loading', 'gap')).toBe(
      declared(feed, '.cinder-feed', 'gap'),
    );
    expect(declared(feed, '.cinder-feed-log__skeleton', 'block-size')).toBe(
      `calc(${declared(feed, '.cinder-feed-log', 'font-size')} * var(--cinder-leading-normal))`,
    );
  });
});
