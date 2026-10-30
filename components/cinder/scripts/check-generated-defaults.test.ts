/**
 * Regression test for `03-defaults-pipeline` part C: replaces the manual
 * spot-check with an automated one. For every `component: prop` pair below,
 * reads the regenerated README's generated Props table and asserts the
 * prop's row has a non-empty (not `—`) Default cell.
 *
 * Parses the table the same way `render-component-readme.ts`'s
 * `renderPropsTable` emits it, matching the prop name in the first column
 * and checking the fourth (Default) column. `renderPropsTable` escapes
 * every literal `|` inside a cell as `\|` (both in descriptions and in
 * union-typed Type columns, e.g. `` `"a"` \| `"b"` ``), so splitting on
 * every `|` character — escaped or not — misaligns the columns for any row
 * whose Type or description contains one. `splitTableRow` below follows
 * GFM's own rule for this rather than treating every `\|` as escaped: a
 * `|` is a real delimiter unless it's preceded by an odd run of
 * backslashes — an authored `foo\|bar` becomes `foo\\|bar` once
 * `renderPropsTable`'s own `\|` escaping runs on it, and GFM (and this
 * parser) reads that *even* pair of backslashes as NOT escaping the pipe.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const COMPONENTS_DIR = join(import.meta.dir, '..', 'src', 'components');

/** Splits a Markdown table row on unescaped `|`, using GFM's backslash-parity rule. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let backslashRun = 0;
  for (const char of line) {
    if (char === '\\') {
      backslashRun++;
      current += char;
      continue;
    }
    if (char === '|' && backslashRun % 2 === 0) {
      cells.push(current.trim());
      current = '';
      backslashRun = 0;
      continue;
    }
    current += char;
    backslashRun = 0;
  }
  cells.push(current.trim());
  return cells;
}

/** Reads a component's README's Default column value for a given prop. */
function defaultCellFor(componentId: string, propName: string): string | undefined {
  const readmePath = join(COMPONENTS_DIR, componentId, 'README.md');
  const readme = readFileSync(readmePath, 'utf8');

  for (const line of readme.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = splitTableRow(line);
    // cells[0] is '' (text before the leading `|`); cells[1] is the Prop column.
    const cellPropName = cells[1]?.replace(/^`|`$/g, '');
    if (cellPropName === propName) {
      return cells[4];
    }
  }
  return undefined;
}

const CASES: Record<string, string[]> = {
  'approval-card': ['editableArgs', 'headingLevel'],
  banner: ['dismissible', 'variant'],
  calendar: ['firstDayOfWeek', 'locale', 'label', 'disabled'],
  'button-group': ['orientation'],
  'donut-chart': ['valueLabels', 'scrollable'],
  'find-bar': ['activeIndex', 'debounceMs', 'label', 'matchCount', 'minQueryLength', 'value'],
  'guidance-region': ['storageKey'],
  'hover-card': ['openDelay', 'closeDelay', 'placement', 'offset'],
  'host-provider': ['platform', 'safeHeaderLeft', 'safeHeaderRight'],
  'inline-confirm': ['cancelLabel', 'destructive', 'open'],
  'json-editor': ['rows', 'validFeedbackVisible'],
  'kanban-board': ['collapsible', 'reorderColumns'],
  'key-value-editor': ['addLabel'],
  'load-more': ['buttonLabel', 'retryLabel', 'endOfListMessage', 'maxRetries'],
  'matrix-chart': ['colorScale', 'cellLabelsVisible', 'height', 'loading', 'dataTableVisibility'],
  'menu-bar': ['label'],
  'navigation-bar': ['label'],
  'parameter-field': ['unsaved', 'experimental'],
  'shortcut-field': ['value', 'label', 'disabled'],
  'terminal-output': ['followLatest', 'value'],
  'zoom-pan-viewer': ['scale', 'ariaLabel'],
  'setting-row': ['required', 'disabled'],
  'share-card': ['copyLinkLabel', 'copiedLabel', 'shareLabel'],
  steps: ['orientation', 'label', 'completedLabel', 'skippedLabel'],
  'table-cell': ['align', 'as'],
  'table-header-cell': ['sortable', 'scope', 'align'],
  table: ['stickyHeader', 'density', 'selectable', 'scrollable'],
  tab: ['disabled'],
  'terminal-frame': ['status', 'columnWidth', 'rowHeight'],
  tabs: ['orientation', 'fill'],
  'tag-input': ['duplicateValuesAllowed', 'commitOnSubmit', 'readonly'],
  tooltip: ['describe'],
  'mega-menu': ['openOnHover', 'viewportVisible', 'indicatorVisible', 'label'],
};

describe('splitTableRow — backslash-parity delimiter handling', () => {
  test('an odd backslash run keeps the pipe inside its cell (escaped)', () => {
    expect(splitTableRow('|a|b\\|c|d|')).toEqual(['', 'a', 'b\\|c', 'd', '']);
  });

  test('an even backslash run treats the pipe as a real delimiter', () => {
    expect(splitTableRow('|a|b\\\\|c|d|')).toEqual(['', 'a', 'b\\\\', 'c', 'd', '']);
  });

  test('a single unescaped pipe is always a delimiter', () => {
    expect(splitTableRow('|a|b|c|')).toEqual(['', 'a', 'b', 'c', '']);
  });

  test('three backslashes (odd) before a pipe still escapes it', () => {
    expect(splitTableRow('|a|b\\\\\\|c|d|')).toEqual(['', 'a', 'b\\\\\\|c', 'd', '']);
  });
});

describe('regenerated READMEs — Default column backfill', () => {
  for (const [componentId, props] of Object.entries(CASES)) {
    for (const propName of props) {
      test(`${componentId}: ${propName} has a non-empty Default cell`, () => {
        const cell = defaultCellFor(componentId, propName);
        expect(cell).toBeDefined();
        expect(cell).not.toBe('—');
      });
    }
  }
});
