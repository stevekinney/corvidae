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
    const status = requiredInstance(container.querySelector('[role="status"]'), HTMLElement);
    expect(status.textContent).toBe('No differences');
    expect(container.querySelector(ROW)).toBeNull();
    expect(buttons(container)).toHaveLength(0);
  });

  test('renders "No differences" for equal primitives', () => {
    const { container } = render(JsonDiffViewer, { before: 'same', after: 'same' });
    expect(container.textContent).toContain('No differences');
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

    const more = buttonNamed(container, /^Show 200 more changes \(11,800 not shown\)$/);
    await fireEvent.click(more);
    expect(rowsOfKind(container, 'changed')).toHaveLength(400);
    buttonNamed(container, /^Show 200 more changes \(11,600 not shown\)$/);
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
      buttonNamed(container, /^Show 200 more unchanged entries \(250 not shown\)$/),
    );
    expect(rowsOfKind(container, 'unchanged')).toHaveLength(400);
  });

  test('pages a nested level independently of its parent', () => {
    const before = { list: Array.from({ length: 300 }, (_, index) => index) };
    const after = { list: Array.from({ length: 300 }, (_, index) => index + 1) };
    const { container } = render(JsonDiffViewer, { before, after });
    expect(leafRowsOfKind(container, 'changed')).toHaveLength(200);
    buttonNamed(container, /^Show 100 more changes \(100 not shown\)$/);
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
