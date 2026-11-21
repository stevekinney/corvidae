/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: JsonDiffViewer } = await import('./json-diff-viewer.svelte');

beforeEach(() => document.body.replaceChildren());
afterEach(() => cleanup());

const ROW = '.cinder-json-diff-viewer__row';

/** The rows of one kind, as `key: value` text with the marker dropped. */
function rowsOfKind(container: HTMLElement, kind: string): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`${ROW}[data-cinder-diff-kind="${kind}"]`),
  );
}

/** The changed, added, removed or unchanged rows that show a value, not a nested list. */
function leafRowsOfKind(container: HTMLElement, kind: string): HTMLElement[] {
  return rowsOfKind(container, kind).filter(
    (row) => row.querySelector(':scope > .cinder-json-diff-viewer__value') !== null,
  );
}

function keyOf(row: HTMLElement): string {
  return row.querySelector(':scope > .cinder-json-diff-viewer__key')?.textContent ?? '';
}

function markerOf(row: HTMLElement): string {
  return row.querySelector('.cinder-json-diff-viewer__marker')?.textContent ?? '';
}

function valueOf(row: HTMLElement): string {
  return row.querySelector(':scope > .cinder-json-diff-viewer__value')?.textContent ?? '';
}

function buttons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
}

/**
 * A selector with the stylesheet's line breaks taken out, as the DOM's selector parser wants it:
 * the formatter wraps a long `:has(...)` across lines, which a browser accepts and happy-dom does not.
 */
function compactSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
}

const CROSS_LEVEL_GROUP =
  ':has(> .cinder-json-diff-viewer__list > .cinder-json-diff-viewer__control:last-child)';

/**
 * Whether the coarse-pointer rule's selector list matches `element`. happy-dom evaluates a
 * `:last-child` inside `:has()` as if it were absent, so the two cross-level groups, the only ones
 * that use it, are checked by what they say in the stylesheet: the previous sibling is a row whose
 * inner list ends in a control, and the element is a control or a row holding a button. Every other
 * group is matched by the DOM's own selector engine.
 */
function ruleMatches(element: HTMLElement, selectorList: string): boolean {
  const groups = selectorList.split(/,(?![^(]*\))/).map((group) => group.trim());
  return groups.some((group) => {
    if (!group.includes(':last-child')) return element.matches(group);
    expect(group).toContain(CROSS_LEVEL_GROUP.replace(/^/, '.cinder-json-diff-viewer__row'));
    const previous = element.previousElementSibling;
    const lastOfInner = previous?.querySelector(
      ':scope > .cinder-json-diff-viewer__list',
    )?.lastElementChild;
    const previousEndsInControl =
      previous?.classList.contains('cinder-json-diff-viewer__row') === true &&
      lastOfInner?.classList.contains('cinder-json-diff-viewer__control') === true;
    const isControl = element.classList.contains('cinder-json-diff-viewer__control');
    const holdsButton =
      element.classList.contains('cinder-json-diff-viewer__row') &&
      element.querySelector(':scope > .cinder-json-diff-viewer__button') !== null;
    const followedBy = group.split(' + ')[1] ?? '';
    return (
      previousEndsInControl &&
      (followedBy.startsWith('.cinder-json-diff-viewer__control') ? isControl : holdsButton)
    );
  });
}

/** The button whose accessible name is exactly `name`: its `aria-label`, else its text. */
function buttonNamedBy(container: HTMLElement, name: string): HTMLButtonElement {
  return requiredInstance(
    buttons(container).find(
      (button) =>
        (button.getAttribute('aria-label') ??
          (button.textContent ?? '').replace(/\s+/g, ' ').trim()) === name,
    ) ?? null,
    HTMLButtonElement,
  );
}

function buttonNamed(container: HTMLElement, pattern: RegExp): HTMLButtonElement {
  return requiredInstance(
    buttons(container).find((button) =>
      pattern.test((button.textContent ?? '').replace(/\s+/g, ' ').trim()),
    ) ?? null,
    HTMLButtonElement,
  );
}

const THREE_LEVELS_BEFORE = {
  run: {
    settings: { timeout: 30, retries: 3, verbose: true, region: 'us-east-1' },
    owner: 'data-platform',
  },
  name: 'Nightly ETL',
};
const THREE_LEVELS_AFTER = {
  run: {
    settings: { timeout: 60, retries: 3, region: 'us-east-1', cache: 'warm' },
    owner: 'data-platform',
  },
  name: 'Nightly ETL',
};

describe('JsonDiffViewer', () => {
  test('renders one added, one removed and one changed row nested three levels deep', () => {
    const { container } = render(JsonDiffViewer, {
      before: THREE_LEVELS_BEFORE,
      after: THREE_LEVELS_AFTER,
    });

    const [added] = rowsOfKind(container, 'added');
    const [removed] = rowsOfKind(container, 'removed');
    const [changed] = leafRowsOfKind(container, 'changed');
    expect(keyOf(requiredInstance(added ?? null, HTMLElement))).toBe('cache');
    expect(valueOf(requiredInstance(added ?? null, HTMLElement))).toBe('"warm"');
    expect(keyOf(requiredInstance(removed ?? null, HTMLElement))).toBe('verbose');
    expect(valueOf(requiredInstance(removed ?? null, HTMLElement))).toBe('true');
    expect(keyOf(requiredInstance(changed ?? null, HTMLElement))).toBe('timeout');
    expect(valueOf(requiredInstance(changed ?? null, HTMLElement))).toBe('30 → 60');

    // The leaf sits under run > settings: two list levels below the root list.
    const nested = requiredInstance(changed ?? null, HTMLElement).closest(
      '.cinder-json-diff-viewer__list',
    );
    let depth = 0;
    for (
      let list: Element | null | undefined = nested;
      list;
      list = list.parentElement?.closest('.cinder-json-diff-viewer__list')
    ) {
      depth += 1;
    }
    expect(depth).toBe(3);
  });

  test('collapses unchanged entries by default and reveals them on request', async () => {
    const { container } = render(JsonDiffViewer, {
      before: THREE_LEVELS_BEFORE,
      after: THREE_LEVELS_AFTER,
    });

    expect(rowsOfKind(container, 'unchanged')).toHaveLength(0);
    expect(container.textContent).not.toContain('Nightly ETL');
    expect(container.textContent).not.toContain('data-platform');

    const names = buttons(container).map((button) =>
      button.textContent?.replace(/\s+/g, ' ').trim(),
    );
    // Innermost level first: the document order of the buttons.
    expect(names).toEqual([
      'Show 2 unchanged entries',
      'Show 1 unchanged entry',
      'Show 1 unchanged entry',
    ]);
    for (const button of buttons(container)) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
    }

    const settingsButton = requiredInstance(buttons(container)[0] ?? null, HTMLButtonElement);
    await fireEvent.click(settingsButton);
    expect(settingsButton.getAttribute('aria-expanded')).toBe('true');
    expect(settingsButton.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Hide 2 unchanged entries',
    );
    const unchanged = rowsOfKind(container, 'unchanged');
    expect(unchanged.map(keyOf)).toEqual(['retries', 'region']);
    expect(markerOf(requiredInstance(unchanged[0] ?? null, HTMLElement))).toBe('=');

    await fireEvent.click(settingsButton);
    expect(rowsOfKind(container, 'unchanged')).toHaveLength(0);
  });

  test('leaves entries that did not change out of the changed rows', () => {
    const { container } = render(JsonDiffViewer, { before: { a: 1, b: 2 }, after: { a: 1, b: 3 } });
    expect(rowsOfKind(container, 'changed').map(keyOf)).toEqual(['b']);
    expect(rowsOfKind(container, 'added')).toHaveLength(0);
    expect(rowsOfKind(container, 'removed')).toHaveLength(0);
  });
});

describe('JsonDiffViewer markers and accessibility', () => {
  test('each kind carries a text marker and a name besides its colour', () => {
    const { container } = render(JsonDiffViewer, {
      before: { kept: 1, edited: 1, gone: 1 },
      after: { kept: 1, edited: 2, fresh: 1 },
    });

    const marker = (kind: string): HTMLElement => {
      const row = requiredInstance(rowsOfKind(container, kind)[0] ?? null, HTMLElement);
      return requiredInstance(row.querySelector('.cinder-json-diff-viewer__marker'), HTMLElement);
    };
    expect(marker('added').textContent).toBe('+');
    expect(marker('removed').textContent).toBe('-');
    expect(marker('changed').textContent).toBe('~');
    expect(marker('added').getAttribute('aria-label')).toBe('Added');
    expect(marker('removed').getAttribute('aria-label')).toBe('Removed');
    expect(marker('changed').getAttribute('aria-label')).toBe('Changed');
    for (const kind of ['added', 'removed', 'changed']) {
      expect(marker(kind).getAttribute('role')).toBe('img');
    }
  });

  test('the comparison is a named group of lists with native disclosure buttons', () => {
    const { container } = render(JsonDiffViewer, {
      before: { a: { b: 1, c: 2 } },
      after: { a: { b: 2, c: 2 } },
      label: 'Run input differences',
    });

    const group = requiredInstance(container.querySelector('[role="group"]'), HTMLElement);
    expect(group.getAttribute('aria-label')).toBe('Run input differences');
    expect(group.querySelectorAll('ul').length).toBe(2);
    for (const button of buttons(container)) {
      expect(button.getAttribute('type')).toBe('button');
      expect(button.hasAttribute('aria-expanded')).toBe(true);
      expect(button.textContent?.trim()).not.toBe('');
    }
  });

  test('defaults the group name', () => {
    const { container } = render(JsonDiffViewer, { before: { a: 1 }, after: { a: 2 } });
    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
      'JSON differences',
    );
  });

  test('merges a caller class onto the root', () => {
    const { container } = render(JsonDiffViewer, {
      before: 1,
      after: 2,
      class: 'custom-class',
    });
    expect(container.querySelector('.cinder-json-diff-viewer.custom-class')).not.toBeNull();
  });

  test('every control is a link-variant xs Button carrying the 44px hit target, with a chevron', () => {
    const many = Array.from({ length: 250 }, (_, index) => index);
    const { container } = render(JsonDiffViewer, {
      before: { kept: 1, many, runs: [0, 1].map((run) => ({ run, values: many.slice(0, 150) })) },
      after: {
        kept: 1,
        many: many.map((value) => value + 1),
        runs: [0, 1].map((run) => ({ run: run + 5, values: many.slice(0, 150).map((v) => v + 1) })),
      },
    });
    const controls = buttons(container);
    // The paging control, the unchanged disclosure and a render-budget control are all present.
    const names = controls.map((button) => button.textContent?.replace(/\s+/g, ' ').trim());
    expect(names).toContain('Show 50 changes');
    expect(names).toContain('Show 1 unchanged entry');
    expect(names).toContain('Show 150 changes');
    for (const button of controls) {
      expect(button.classList.contains('cinder-button')).toBe(true);
      // The viewer's own class reaches the Button, so the stylesheet's selectors match the markup.
      expect(button.classList.contains('cinder-json-diff-viewer__button')).toBe(true);
      expect(button.classList.contains('button-variant-link')).toBe(true);
      expect(button.classList.contains('button-size-extra-small')).toBe(true);
      expect(button.getAttribute('data-cinder-hit-target')).toBe('44');
      expect(button.querySelector('svg')).not.toBeNull();
    }
  });

  test('the stylesheet keeps each control on one line at the inline start, with room for its hit region', () => {
    const css = readFileSync(new URL('./json-diff-viewer.css', import.meta.url), 'utf8');
    const button = /\.cinder-json-diff-viewer__button\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(button).toContain('white-space: nowrap');
    expect(button).toContain('text-align: start');
    const control = /\.cinder-json-diff-viewer__control\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(control).toContain('text-align: start');
  });

  describe('room for the 44px hit regions on a coarse pointer', () => {
    const css = readFileSync(new URL('./json-diff-viewer.css', import.meta.url), 'utf8');
    // The rule under `@media (any-pointer: coarse)` that adds the margin, selector and all.
    const rule = /@media \(any-pointer: coarse\)\s*\{\s*([^{}]+?)\s*\{\s*([^}]*)\}/.exec(css);
    const selector = compactSelector(rule?.[1] ?? '');

    test('is one margin between two stacked controls, under the same media query Button uses', () => {
      expect(selector).toContain('+');
      expect(rule?.[2]).toContain('margin-block-start: calc(var(--cinder-space-3) * 2)');
      // Padding on every control's item or row is what the rule replaced.
      expect(css).not.toMatch(/padding-block: var\(--cinder-space-3\)/);
      const buttonCss = readFileSync(new URL('../button/button.css', import.meta.url), 'utf8');
      expect(buttonCss).toContain('@media (any-pointer: coarse)');
    });

    test('matches the second of two stacked controls and not a lone control', () => {
      // One level with 250 changes and one unchanged entry: the paging control, then the unchanged
      // disclosure directly beneath it.
      const before: Record<string, number> = { kept: 1 };
      const after: Record<string, number> = { kept: 1 };
      for (let index = 0; index < 250; index += 1) {
        before[`key-${index}`] = index;
        after[`key-${index}`] = index + 1;
      }
      const stacked = render(JsonDiffViewer, { before, after });
      const controls = Array.from(
        stacked.container.querySelectorAll<HTMLElement>('.cinder-json-diff-viewer__control'),
      );
      expect(controls).toHaveLength(2);
      expect(ruleMatches(requiredInstance(controls[0], HTMLElement), selector)).toBe(false);
      expect(ruleMatches(requiredInstance(controls[1], HTMLElement), selector)).toBe(true);
      cleanup();

      const lone = render(JsonDiffViewer, { before: { kept: 1, a: 1 }, after: { kept: 1, a: 2 } });
      const only = requiredInstance(
        lone.container.querySelector('.cinder-json-diff-viewer__control'),
        HTMLElement,
      );
      expect(ruleMatches(only, selector)).toBe(false);
    });

    test('matches a row holding a closed-level control only beside another control', () => {
      const run = (offset: number) =>
        Object.fromEntries(
          Array.from({ length: 150 }, (_, index) => [`field-${index}`, offset + index]),
        );
      const { container } = render(JsonDiffViewer, {
        before: { runs: [0, 1, 2, 3, 4].map((index) => run(index)) },
        after: { runs: [0, 1, 2, 3, 4].map((index) => run(index + 1000)) },
      });
      const withControl = Array.from(
        container.querySelectorAll<HTMLElement>(`${ROW}:has(> .cinder-json-diff-viewer__button)`),
      );
      // The first run opens whole; the four after it start closed, one under another.
      expect(withControl).toHaveLength(4);
      expect(withControl.map((row) => ruleMatches(row, selector))).toEqual([
        false,
        true,
        true,
        true,
      ]);
      // A plain row, with no control, is never matched.
      const plain = requiredInstance(
        container.querySelector(
          `${ROW}[data-cinder-diff-kind="changed"] > .cinder-json-diff-viewer__value`,
        ),
        HTMLElement,
      ).parentElement;
      expect(ruleMatches(requiredInstance(plain, HTMLElement), selector)).toBe(false);
    });
  });

  describe('room across levels on a coarse pointer', () => {
    const css = readFileSync(new URL('./json-diff-viewer.css', import.meta.url), 'utf8');
    const selector = compactSelector(
      /@media \(any-pointer: coarse\)\s*\{\s*([^{}]+?)\s*\{\s*margin-block-start/.exec(css)?.[1] ??
        '',
    );
    // The shape of the stacked-levels playground example: a nested level that ends in its own
    // "Show N unchanged" control, and the parent level's control directly under it.
    const before = {
      settings: { retries: 3, timeout: 30, region: 'us-east-1' },
      name: 'Nightly ETL',
    };
    const after = {
      settings: { retries: 5, timeout: 30, region: 'us-east-1' },
      name: 'Nightly ETL',
    };

    test("matches the parent level's control under a nested level that ends in a control", () => {
      const { container } = render(JsonDiffViewer, { before, after });
      const rootList = requiredInstance(
        container.querySelector('.cinder-json-diff-viewer > ul'),
        HTMLElement,
      );
      const parentControl = requiredInstance(
        rootList.querySelector(':scope > .cinder-json-diff-viewer__control'),
        HTMLElement,
      );
      const nestedControl = requiredInstance(
        rootList.querySelector(':scope > li > ul > .cinder-json-diff-viewer__control:last-child'),
        HTMLElement,
      );
      expect(ruleMatches(parentControl, selector)).toBe(true);
      // The nested control sits under a plain row of its own level, so it gets no margin.
      expect(ruleMatches(nestedControl, selector)).toBe(false);
    });

    test('stops matching once the nested control is no longer the last thing in its list', async () => {
      const { container } = render(JsonDiffViewer, { before, after });
      const rootList = requiredInstance(
        container.querySelector('.cinder-json-diff-viewer > ul'),
        HTMLElement,
      );
      const nestedButton = requiredInstance(
        rootList.querySelector(':scope > li > ul > .cinder-json-diff-viewer__control button'),
        HTMLButtonElement,
      );
      await fireEvent.click(nestedButton);
      const parentControl = requiredInstance(
        rootList.querySelector(':scope > .cinder-json-diff-viewer__control'),
        HTMLElement,
      );
      expect(ruleMatches(parentControl, selector)).toBe(false);
    });
  });

  test('a very long key wraps inside its column instead of widening the row', () => {
    const key = `a-very-long-property-name-${'x'.repeat(300)}`;
    const { container } = render(JsonDiffViewer, { before: { [key]: 1 }, after: { [key]: 2 } });
    expect(rowsOfKind(container, 'changed').map(keyOf)).toEqual([key]);

    const css = readFileSync(new URL('./json-diff-viewer.css', import.meta.url), 'utf8');
    const row = /\.cinder-json-diff-viewer__row\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    // Marker, key, value: the key is held to half the row, and the value keeps at least 12ch (or
    // 40% of a narrower row) however long the key is.
    const columns = /grid-template-columns:\s*([^;]+);/.exec(row)?.[1] ?? '';
    expect(columns).toBe('auto fit-content(50%) minmax(min(12ch, 40%), 1fr)');
    const valueFloor = /minmax\(min\((\d+)ch,\s*40%\),\s*1fr\)$/.exec(columns)?.[1];
    expect(Number(valueFloor)).toBeGreaterThanOrEqual(12);
    const keyRule = /\.cinder-json-diff-viewer__key\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(keyRule).toContain('overflow-wrap: anywhere');
  });

  test('ships the accessibility record beside the component', () => {
    const record = readFileSync(new URL('./json-diff-viewer.a11y.md', import.meta.url), 'utf8');
    expect(record).toContain('## Design review (required)');
    expect(record).toContain('### Keyboard matrix');
    expect(record).toContain('### Assistive-technology announcements');
  });

  test('the stylesheet gives forced-colors mode a non-tint signal for each changed kind', () => {
    const css = readFileSync(new URL('./json-diff-viewer.css', import.meta.url), 'utf8');
    expect(css).toContain('@media (forced-colors: active)');
    expect(css).toContain('border-inline-start: 2px solid CanvasText');
  });
});

describe('JsonDiffViewer arrays and type changes', () => {
  test('compares arrays by index', () => {
    const { container } = render(JsonDiffViewer, {
      before: { list: [1, 2, 3] },
      after: { list: [1, 9] },
    });
    const changed = leafRowsOfKind(container, 'changed');
    expect(changed.map(keyOf)).toEqual(['1']);
    expect(valueOf(requiredInstance(changed[0] ?? null, HTMLElement))).toBe('2 → 9');
    expect(rowsOfKind(container, 'removed').map(keyOf)).toEqual(['2']);
    expect(rowsOfKind(container, 'added')).toHaveLength(0);
  });

  test('a value that changes type shows as one removed and one added entry', () => {
    const { container } = render(JsonDiffViewer, {
      before: { timeout: 30, mode: { fast: true } },
      after: { timeout: '30s', mode: [true] },
    });

    expect(rowsOfKind(container, 'changed')).toHaveLength(0);
    const removed = rowsOfKind(container, 'removed');
    const added = rowsOfKind(container, 'added');
    expect(removed.map((row) => `${keyOf(row)}=${valueOf(row)}`)).toEqual([
      'timeout=30',
      'mode={1 key}',
    ]);
    expect(added.map((row) => `${keyOf(row)}=${valueOf(row)}`)).toEqual([
      'timeout="30s"',
      'mode=[1 item]',
    ]);
  });

  test('a root that changes type shows one removed and one added entry', () => {
    const { container } = render(JsonDiffViewer, { before: { a: 1 }, after: [1] });
    expect(rowsOfKind(container, 'removed')).toHaveLength(1);
    expect(rowsOfKind(container, 'added')).toHaveLength(1);
  });
});

describe('JsonDiffViewer identical values', () => {
  test('renders "No differences" for equal structures', () => {
    const { container } = render(JsonDiffViewer, {
      before: { a: [1, { b: null }], c: 'x' },
      after: { a: [1, { b: null }], c: 'x' },
    });
    const empty = requiredInstance(container.querySelector('.cinder-empty-state'), HTMLElement);
    expect(empty.textContent?.trim()).toBe('No differences');
    // EmptyState has one layout, so none is passed; the done kind is what draws its disc.
    expect(empty.getAttribute('data-cinder-kind')).toBe('done');
    expect(empty.querySelector('.cinder-empty-state-icon')).not.toBeNull();
    expect(container.querySelector(ROW)).toBeNull();
    expect(buttons(container)).toHaveLength(0);
  });

  test('renders "No differences" for equal primitives', () => {
    const { container } = render(JsonDiffViewer, { before: 'same', after: 'same' });
    expect(container.textContent).toContain('No differences');
  });

  test('says it in the words DiffStatistics uses for no change', async () => {
    const { default: DiffStatistics } = await import('../diff-statistics/diff-statistics.svelte');
    const { container } = render(DiffStatistics, {
      props: { added: 0, removed: 0, modified: 0, zeroVisible: false },
    });
    expect(container.textContent?.trim()).toBe('No differences');
  });
});

describe('JsonDiffViewer bounded rendering', () => {
  function bigObjects(): { before: Record<string, string>; after: Record<string, string> } {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let index = 0; index < 12_000; index += 1) {
      before[`entry-${index}`] = `before value number ${index} ${'a'.repeat(60)}`;
      after[`entry-${index}`] = `after value number ${index} ${'b'.repeat(60)}`;
    }
    return { before, after };
  }

  test('two 1 MB objects create at most 1,000 elements before any control is used', () => {
    const { before, after } = bigObjects();
    expect(JSON.stringify(before).length).toBeGreaterThan(1_000_000);
    expect(JSON.stringify(after).length).toBeGreaterThan(1_000_000);

    const { container } = render(JsonDiffViewer, { before, after });
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(1000);
    expect(rowsOfKind(container, 'changed')).toHaveLength(200);
  });

  test('two 1 MB arrays create at most 1,000 elements before any control is used', () => {
    const before = Array.from({ length: 150_000 }, (_, index) => index + 100_000);
    const after = before.map((value) => value + 1);
    expect(JSON.stringify(before).length).toBeGreaterThan(1_000_000);

    const { container } = render(JsonDiffViewer, { before, after });
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(1000);
    expect(rowsOfKind(container, 'changed')).toHaveLength(200);
  });

  test('holds entries past the first 200 behind a control that shows the next 200', async () => {
    const { before, after } = bigObjects();
    const { container } = render(JsonDiffViewer, { before, after });

    const more = buttonNamedBy(container, 'Show 200 changes, 11,800 not shown');
    // The visible words are the row's own words and the step only; the total lives in the name.
    const words = more.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    expect(words).toBe('Show 200 changes');
    expect(words.length).toBeLessThanOrEqual(16);
    await fireEvent.click(more);
    expect(rowsOfKind(container, 'changed')).toHaveLength(400);
    buttonNamedBy(container, 'Show 200 changes, 11,600 not shown');
  });

  test('names the last step by what remains, not by a full page', async () => {
    const before = Array.from({ length: 250 }, (_, index) => index);
    const after = before.map((value) => value + 1);
    const { container } = render(JsonDiffViewer, { before, after });
    await fireEvent.click(buttonNamedBy(container, 'Show 50 changes, 50 not shown'));
    expect(rowsOfKind(container, 'changed')).toHaveLength(250);
    expect(buttons(container)).toHaveLength(0);
  });

  test('pages the unchanged entries of a level the same way', async () => {
    const before: Record<string, number> = { edited: 1 };
    const after: Record<string, number> = { edited: 2 };
    for (let index = 0; index < 450; index += 1) {
      before[`same-${index}`] = index;
      after[`same-${index}`] = index;
    }
    const { container } = render(JsonDiffViewer, { before, after });
    expect(container.querySelectorAll('*').length).toBeLessThan(50);

    await fireEvent.click(buttonNamed(container, /^Show 450 unchanged entries$/));
    expect(rowsOfKind(container, 'unchanged')).toHaveLength(200);
    await fireEvent.click(
      buttonNamedBy(container, 'Show 200 more unchanged entries, 250 not shown'),
    );
    expect(rowsOfKind(container, 'unchanged')).toHaveLength(400);
  });

  test('a level that outgrows the budget closes the nested levels it cannot afford, and opens them on request', async () => {
    const run = (offset: number) =>
      Object.fromEntries(
        Array.from({ length: 150 }, (_, index) => [`field-${index}`, offset + index]),
      );
    const before = { runs: [0, 1, 2, 3, 4].map((index) => run(index)) };
    const after = { runs: [0, 1, 2, 3, 4].map((index) => run(index + 1000)) };

    const { container } = render(JsonDiffViewer, { before, after });
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(1000);
    // The first run opens whole; each later one starts closed behind a control with its count.
    expect(leafRowsOfKind(container, 'changed')).toHaveLength(150);
    const closed = buttons(container).filter((button) =>
      /^Show 150 changes$/.test(button.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
    );
    expect(closed).toHaveLength(4);
    for (const button of closed) expect(button.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(requiredInstance(closed[0] ?? null, HTMLButtonElement));
    expect(closed[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(closed[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Hide 150 changes');
    expect(leafRowsOfKind(container, 'changed').length).toBeGreaterThan(150);
  });

  test('nested changes in two 1 MB arrays of objects stay under 1,000 elements', async () => {
    const before = Array.from({ length: 9_000 }, (_, index) => ({
      id: index,
      label: `item number ${index} with some text to fill the payload out`,
      detail: { owner: 'data-platform', rank: index, flags: ['a', 'b', 'c'] },
    }));
    const after = before.map((item) => ({ ...item, detail: { ...item.detail, rank: -1 } }));
    expect(JSON.stringify(before).length).toBeGreaterThan(1_000_000);
    expect(JSON.stringify(after).length).toBeGreaterThan(1_000_000);

    const { container } = render(JsonDiffViewer, { before, after });
    expect(container.querySelectorAll('*').length).toBeLessThanOrEqual(1000);

    // The budget ran out inside the root level, so it shows fewer than a page and the rest wait
    // behind its control; opening it adds rows.
    const topRows = container.querySelectorAll('.cinder-json-diff-viewer > ul > li');
    expect(topRows.length).toBeGreaterThan(1);
    expect(topRows.length).toBeLessThan(200);
    const more = requiredInstance(
      buttons(container).find((button) =>
        /^Show 200 changes, [\d,]+ not shown$/.test(button.getAttribute('aria-label') ?? ''),
      ) ?? null,
      HTMLButtonElement,
    );
    const elementsBefore = container.querySelectorAll('*').length;
    await fireEvent.click(more);
    expect(container.querySelectorAll('*').length).toBeGreaterThan(elementsBefore);
  });

  test('keeps a small nested comparison fully open', () => {
    const { container } = render(JsonDiffViewer, {
      before: THREE_LEVELS_BEFORE,
      after: THREE_LEVELS_AFTER,
    });
    expect(buttons(container).every((button) => /unchanged/.test(button.textContent ?? ''))).toBe(
      true,
    );
  });

  test('pages a nested level independently of its parent', () => {
    const before = { list: Array.from({ length: 300 }, (_, index) => index) };
    const after = { list: Array.from({ length: 300 }, (_, index) => index + 1) };
    const { container } = render(JsonDiffViewer, { before, after });
    expect(leafRowsOfKind(container, 'changed')).toHaveLength(200);
    buttonNamedBy(container, 'Show 100 changes, 100 not shown');
  });
});

describe('JsonDiffViewer public exports', () => {
  test('is exported from the Cinder entry point and re-exported from the panel kit', async () => {
    const root = await import('../../index.ts');
    const panel = await import('../../panel/index.ts');
    expect(root.JsonDiffViewer).toBe(JsonDiffViewer);
    expect(panel.JsonDiffViewer).toBe(JsonDiffViewer);
  });
});
