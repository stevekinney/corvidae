/// <reference lib="dom" />
/**
 * COR-2012 (B04, rows 04l 10e 10f 10g 45u 52l 52m 53i 53j 60c 60o 60x 70c 70d): the filter bar is
 * one row that never wraps. Wide it draws status segments, facet chips and a search field; medium
 * folds the segments into a "Status: All 19" select and the search into an icon button; narrow
 * keeps the select and a Filter menu.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import. testing-library
// reads `globalThis.document` / `window` at module-init (top-level, not inside test bodies),
// so we register happy-dom's globals first and then dynamic-import testing-library below.
setupHappyDom();

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/svelte');
const { flushSync } = await import('svelte');
const { default: FilterBar } = await import('./filter-bar.svelte');

const filterBarCss = readFileSync(new URL('./filter-bar.css', import.meta.url), 'utf8');

beforeEach(() => document.body.replaceChildren());
afterEach(() => cleanup());

// The Runs list from PageRuns: six status segments that add up to All 19.
const RUN_SEGMENTS = [
  { value: 'all', label: 'All', count: 19 },
  { value: 'waiting', label: 'Waiting on you', count: 2 },
  { value: 'running', label: 'Running', count: 0 },
  { value: 'done', label: 'Done', count: 15 },
  { value: 'failed', label: 'Failed', count: 1 },
  { value: 'canceled', label: 'Canceled', count: 1 },
];

const STARTED_BY = {
  type: 'choice' as const,
  key: 'startedBy',
  label: 'Started by',
  options: [
    { value: 'you', label: 'You', count: 0 },
    { value: 'chats', label: 'Chats', count: 5 },
    { value: 'schedules', label: 'Schedules', count: 4 },
    { value: 'goals', label: 'Goals', count: 8 },
    { value: 'interborough', label: 'Interborough', count: 2 },
    { value: 'workflows', label: 'Workflows', count: 0 },
    { value: 'agents', label: 'Agents', count: 0 },
  ],
};

const AGENT = {
  type: 'choice' as const,
  key: 'agent',
  label: 'Agent',
  multiple: false,
  options: [
    { value: 'assistant', label: 'Assistant' },
    { value: 'tool-runner', label: 'Tool runner' },
  ],
};

const WORKFLOW = {
  type: 'choice' as const,
  key: 'workflow',
  label: 'Workflow',
  options: [
    { value: 'release-notes', label: 'Release notes', count: 1 },
    { value: 'triage-inbox', label: 'Triage inbox', count: 2 },
    { value: 'order-refund', label: 'Order refund', count: 0 },
    { value: 'chat', label: 'Chat with an agent · internal', count: 6 },
    { value: 'goal', label: 'Goal attempts · internal', count: 8 },
    { value: 'tick', label: 'Schedule tick · internal', count: 2 },
  ],
};

const MISSED = {
  type: 'toggle' as const,
  key: 'missed',
  label: 'Missed runs',
  count: 1,
};

const KIND = {
  type: 'select' as const,
  key: 'kind',
  label: 'Kind',
  options: [
    { value: 'fact', label: 'Fact' },
    { value: 'how-to', label: 'How-to' },
  ],
};

const WRITER = {
  type: 'select' as const,
  key: 'writer',
  label: 'Written by',
  placeholder: 'Anyone',
  options: [
    { value: 'you', label: 'You' },
    { value: 'tool-runner', label: 'Tool runner' },
  ],
};

function textOf(element: Element | null | undefined): string {
  return (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function optionTexts(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map((option) => textOf(option));
}

function chipTrigger(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [
    ...container.querySelectorAll<HTMLButtonElement>('.cinder-filter-bar__chip-trigger'),
  ].find((candidate) => textOf(candidate).startsWith(label));
  if (!button) throw new Error(`no chip for ${label}`);
  return button;
}

describe('FilterBar structure', () => {
  test('is a labelled search landmark that rest attributes cannot override', () => {
    const { container } = render(FilterBar, {
      role: 'presentation',
      'aria-label': 'Run filters',
    } as never);
    const root = container.querySelector('.cinder-filter-bar');
    expect(root?.getAttribute('role')).toBe('search');
    expect(root?.getAttribute('aria-label')).toBe('Run filters');
  });

  test('merges a custom class', () => {
    const { container } = render(FilterBar, { class: 'custom-class' });
    const root = container.querySelector('.cinder-filter-bar');
    expect(root?.classList.contains('custom-class')).toBe(true);
  });

  test('draws one row and no second row of chips or a Clear all button', () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT],
      appliedFilters: [{ key: 'agent', value: 'tool-runner', label: 'Agent' }],
    });
    expect(container.querySelectorAll('.cinder-filter-bar__row')).toHaveLength(1);
    expect(container.querySelector('.cinder-filter-bar__chips')).toBeNull();
    expect(textOf(container)).not.toContain('Clear all');
    const rule = filterBarCss.match(/\.cinder-filter-bar__row \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toContain('flex-wrap: nowrap');
  });

  test('omits the search field when searchVisible is false', () => {
    const { container } = render(FilterBar, { searchVisible: false, facets: [KIND] });
    expect(container.querySelector('.cinder-search-field')).toBeNull();
    expect(container.querySelector('.cinder-select')).not.toBeNull();
  });

  test('disables every control', () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      disabled: true,
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, MISSED, KIND],
    });
    expect(
      container.querySelector<HTMLButtonElement>('.cinder-filter-bar__chip-trigger')?.disabled,
    ).toBe(true);
    expect(container.querySelector('.cinder-filter-bar__toggle')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(container.querySelector('.cinder-search-field input')?.hasAttribute('disabled')).toBe(
      true,
    );
    expect(container.querySelector('.cinder-filter-bar')?.hasAttribute('data-disabled')).toBe(true);
  });
});

describe('FilterBar wide layout (rows 10e 60c 70c)', () => {
  test('draws the segments with their counts in their accessible names, then the chips, then search', () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT],
      searchPlaceholder: 'Search runs',
    });

    const group = container.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute('aria-labelledby')).toBeTruthy();
    const segments = [...container.querySelectorAll('[role="radio"]')].map((segment) =>
      textOf(segment),
    );
    expect(segments.map((text) => text.replace(/,\s*/, ', '))).toEqual([
      'All, 19',
      'Waiting on you, 2',
      'Running, 0',
      'Done, 15',
      'Failed, 1',
      'Canceled, 1',
    ]);
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'All',
    );

    const order = [...container.querySelector('.cinder-filter-bar__row')!.children].map((child) =>
      child.classList.contains('cinder-filter-bar__chip')
        ? 'chip'
        : child.classList.contains('cinder-segmented-control-container')
          ? 'segments'
          : child.classList.contains('cinder-search-field')
            ? 'search'
            : 'other',
    );
    expect(order.filter((kind) => kind !== 'other')).toEqual([
      'segments',
      'chip',
      'chip',
      'search',
    ]);
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.placeholder).toBe(
      'Search runs',
    );
    expect(
      container.querySelector('.cinder-filter-bar')?.getAttribute('data-cinder-search-position'),
    ).toBe('end');
  });

  test('choosing a segment reports its value and keeps it chosen when uncontrolled', async () => {
    const changes: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      onSegmentChange: (value: string) => changes.push(value),
    });
    await fireEvent.click(container.querySelector('[data-cinder-segment-value="failed"]')!);
    flushSync();
    expect(changes).toEqual(['failed']);
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'Failed',
    );
  });

  test('a controlled segmentValue wins over a click until the consumer changes it', async () => {
    const { container, rerender } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      segmentValue: 'failed',
    });
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'Failed',
    );
    await rerender({ segmentValue: 'done' } as never);
    flushSync();
    expect(container.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain(
      'Done',
    );
  });

  test('a toggle chip sits beside the segments with a dot and a count, and is not a segment (rows 70c 70d)', async () => {
    const changes: [string, string][] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      searchVisible: false,
      segments: [
        { value: 'all', label: 'All', count: 4 },
        { value: 'active', label: 'Active', count: 3 },
        { value: 'paused', label: 'Paused', count: 1 },
      ],
      facets: [
        MISSED,
        { type: 'choice', key: 'agent', label: 'Agent', options: [{ value: 'a', label: 'A' }] },
        {
          type: 'choice',
          key: 'workflow',
          label: 'Workflow',
          options: [{ value: 'w', label: 'W' }],
        },
      ],
      onFacetChange: (key: string, value: string) => changes.push([key, value]),
    });

    expect(container.querySelectorAll('[role="radio"]')).toHaveLength(3);
    expect(container.querySelector('.cinder-search-field')).toBeNull();
    const toggle = container.querySelector<HTMLButtonElement>('.cinder-filter-bar__toggle')!;
    expect(textOf(toggle)).toBe('Missed runs 1');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(toggle.querySelector('.cinder-filter-bar__dot')?.getAttribute('data-cinder-tone')).toBe(
      'warning',
    );

    const row = [...container.querySelector('.cinder-filter-bar__row')!.children];
    const labels = row.map((child) => textOf(child));
    expect(labels.findIndex((text) => text.startsWith('Missed runs'))).toBeLessThan(
      labels.findIndex((text) => text === 'Agent'),
    );
    expect(labels.findIndex((text) => text === 'Agent')).toBeLessThan(
      labels.findIndex((text) => text === 'Workflow'),
    );

    await fireEvent.click(toggle);
    expect(changes).toEqual([['missed', 'true']]);
  });

  test('an applied toggle is pressed and clicking it reports an empty value', async () => {
    const changes: [string, string][] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      searchVisible: false,
      facets: [MISSED],
      appliedFilters: [{ key: 'missed', value: 'true', label: 'Missed runs' }],
      onFacetChange: (key: string, value: string) => changes.push([key, value]),
    });
    const toggle = container.querySelector<HTMLButtonElement>('.cinder-filter-bar__toggle')!;
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    await fireEvent.click(toggle);
    expect(changes).toEqual([['missed', '']]);
  });

  test('a toggle at zero still shows its count', () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      searchVisible: false,
      facets: [{ ...MISSED, count: 0 }],
    });
    expect(textOf(container.querySelector('.cinder-filter-bar__toggle'))).toBe('Missed runs 0');
  });
});

describe('FilterBar choice chips (rows 10e 52l 52m 53i 53j)', () => {
  test('an unapplied facet is a "+ Started by" add chip that opens a titled checkbox list with counts', async () => {
    const { container } = render(FilterBar, { layout: 'wide', facets: [STARTED_BY] });
    const trigger = chipTrigger(container, 'Started by');
    expect(trigger.closest('.cinder-filter-bar__chip')?.hasAttribute('data-cinder-applied')).toBe(
      false,
    );
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    await fireEvent.click(trigger);
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(textOf(document.querySelector('.cinder-filter-bar__options-title'))).toBe('Started by');
    const rows = [...document.querySelectorAll('.cinder-filter-bar__option')].map((row) =>
      textOf(row),
    );
    expect(rows).toEqual([
      'You 0',
      'Chats 5',
      'Schedules 4',
      'Goals 8',
      'Interborough 2',
      'Workflows 0',
      'Agents 0',
    ]);
    // The first five add up to All 19, and every row's count describes its checkbox.
    const counts = [...document.querySelectorAll('.cinder-filter-bar__option-count')].map((count) =>
      Number(count.textContent),
    );
    expect(counts.slice(0, 5).reduce((sum, count) => sum + count, 0)).toBe(19);
    const checkbox = document.querySelector<HTMLInputElement>('.cinder-filter-bar__option input')!;
    expect(textOf(document.getElementById(checkbox.getAttribute('aria-describedby') ?? ''))).toBe(
      '0',
    );
    expect(textOf(document.querySelector('.cinder-filter-bar__options-footer'))).toContain(
      'Matches any selected',
    );
    expect(textOf(document.querySelector('.cinder-filter-bar__options-footer'))).toContain('Clear');
  });

  test("ticking boxes reports every chosen value in the facet's own order", async () => {
    const changes: [string, readonly string[]][] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      facets: [STARTED_BY],
      appliedFilters: [
        { key: 'startedBy', value: 'goals', label: 'Started by', values: ['goals'] },
      ],
      onFacetValuesChange: (key: string, values: readonly string[]) => changes.push([key, values]),
    });
    await fireEvent.click(chipTrigger(container, 'Started by'));
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );

    const chats = [
      ...document.querySelectorAll<HTMLInputElement>('.cinder-filter-bar__option input'),
    ].find((input) => textOf(input.closest('.cinder-filter-bar__option')).startsWith('Chats'))!;
    await fireEvent.click(chats);
    expect(changes).toEqual([['startedBy', ['chats', 'goals']]]);
  });

  test('Clear empties a multiple choice facet and is off while nothing is chosen', async () => {
    const changes: [string, readonly string[]][] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      facets: [STARTED_BY],
      appliedFilters: [
        { key: 'startedBy', value: 'chats,goals', label: 'Started by', values: ['chats', 'goals'] },
      ],
      onFacetValuesChange: (key: string, values: readonly string[]) => changes.push([key, values]),
    });
    await fireEvent.click(chipTrigger(container, 'Started by'));
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );
    const clear = document.querySelector<HTMLButtonElement>('.cinder-filter-bar__options-clear')!;
    expect(clear.disabled).toBe(false);
    await fireEvent.click(clear);
    expect(changes).toEqual([['startedBy', []]]);
  });

  test('an applied facet is a tinted chip reading "Started by: Chats, Goals" with an x', async () => {
    const removed: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      facets: [STARTED_BY],
      appliedFilters: [
        { key: 'startedBy', value: 'goals,chats', label: 'Started by', values: ['goals', 'chats'] },
      ],
      onFilterRemove: (key: string) => removed.push(key),
    });
    const chip = container.querySelector('.cinder-filter-bar__chip')!;
    expect(chip.hasAttribute('data-cinder-applied')).toBe(true);
    // Read in the facet's own order, whatever order the consumer stored.
    expect(textOf(chip.querySelector('.cinder-filter-bar__chip-trigger'))).toBe(
      'Started by: Chats, Goals',
    );
    const remove = chip.querySelector<HTMLButtonElement>('.cinder-filter-bar__chip-remove')!;
    expect(remove.getAttribute('aria-label')).toBe('Remove filter: Started by: Chats, Goals');
    await fireEvent.click(remove);
    expect(removed).toEqual(['startedBy']);
  });

  test('applied chips are tinted with the accent and drawn after the add chips, in the DOM too', () => {
    const chip =
      filterBarCss.match(/\.cinder-filter-bar__chip\[data-cinder-applied\] \{[^}]*\}/)?.[0] ?? '';
    expect(chip).toContain('var(--cinder-accent-background)');
    expect(chip).not.toContain('order:');
    const base = filterBarCss.match(/\.cinder-filter-bar__chip \{[^}]*\}/)?.[0] ?? '';
    expect(base).toContain('1px dashed');
  });

  test('an applied chip follows the add chips whatever order the facets are listed in (row 53i)', () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, WORKFLOW, AGENT],
      appliedFilters: [
        { key: 'workflow', value: 'release-notes', label: 'Workflow', values: ['release-notes'] },
      ],
    });
    const chips = [...container.querySelectorAll('.cinder-filter-bar__chip-trigger')].map(
      (trigger) => textOf(trigger),
    );
    expect(chips).toEqual(['Started by', 'Agent', 'Workflow: Release notes']);
  });

  test('an applied filter no facet draws still gets a chip that removes it', async () => {
    const removed: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      facets: [AGENT],
      appliedFilters: [{ key: 'updated', value: 'Last 24 hours', label: 'Updated' }],
      onFilterRemove: (key: string) => removed.push(key),
    });
    const chip = container.querySelector('.cinder-filter-bar__chip[data-cinder-static]')!;
    expect(textOf(chip)).toBe('Updated: Last 24 hours');
    await fireEvent.click(chip.querySelector('.cinder-filter-bar__chip-remove')!);
    expect(removed).toEqual(['updated']);
    await waitFor(() =>
      expect(textOf(container.querySelector('[role="status"]'))).toBe(
        '1 active filter: Updated: Last 24 hours',
      ),
    );
  });

  test('in the narrow form that filter is a row in the Filter menu with its own Remove', async () => {
    const removed: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'narrow',
      segments: RUN_SEGMENTS,
      appliedFilters: [{ key: 'updated', value: 'Last 24 hours', label: 'Updated' }],
      onFilterRemove: (key: string) => removed.push(key),
    });
    await fireEvent.click(container.querySelector('.cinder-filter-bar__menu-button')!);
    flushSync();
    await waitFor(() => expect(document.querySelector('.cinder-filter-bar__menu')).not.toBeNull());
    const remove = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove filter: Updated: Last 24 hours"]',
    )!;
    await fireEvent.click(remove);
    expect(removed).toEqual(['updated']);
  });

  test('focus lands on the add chip after the consumer clears the filter on remove', async () => {
    let applied = [{ key: 'agent', value: 'tool-runner', label: 'Agent' }];
    const { container, rerender } = render(FilterBar, {
      layout: 'wide',
      facets: [AGENT],
      appliedFilters: applied,
      onFilterRemove: () => {
        applied = [];
        void rerender({ appliedFilters: applied } as never);
      },
    });
    await fireEvent.click(container.querySelector('.cinder-filter-bar__chip-remove')!);
    await waitFor(() => expect(document.activeElement?.id).toContain('facet-agent'));
    expect(textOf(document.activeElement)).toBe('Agent');
  });

  test('a single choice facet lists radio rows and reports the picked value', async () => {
    const changes: [string, string][] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      facets: [AGENT],
      onFacetChange: (key: string, value: string) => changes.push([key, value]),
    });
    await fireEvent.click(chipTrigger(container, 'Agent'));
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );
    expect(document.querySelector('.cinder-filter-bar__options-footer')).toBeNull();
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>(
        '.cinder-filter-bar__options input[type="radio"]',
      ),
    ];
    expect(radios).toHaveLength(2);
    await fireEvent.click(radios[1]!);
    expect(changes).toEqual([['agent', 'tool-runner']]);
  });

  test('the Workflow popover lists its rows in order with counts that add up to All 19 (row 53j)', async () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT, WORKFLOW],
      appliedFilters: [
        { key: 'workflow', value: 'release-notes', label: 'Workflow', values: ['release-notes'] },
      ],
    });
    // The applied chip reads "Workflow: Release notes", and the add chips are still there.
    expect(textOf(container.querySelector('.cinder-filter-bar__chip[data-cinder-applied]'))).toBe(
      'Workflow: Release notes',
    );
    await fireEvent.click(chipTrigger(container, 'Workflow'));
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-filter-bar__options')).not.toBeNull(),
    );
    expect(textOf(document.querySelector('.cinder-filter-bar__options-title'))).toBe('Workflow');
    const rows = [...document.querySelectorAll('.cinder-filter-bar__option')];
    expect(rows.map((row) => textOf(row))).toEqual([
      'Release notes 1',
      'Triage inbox 2',
      'Order refund 0',
      'Chat with an agent · internal 6',
      'Goal attempts · internal 8',
      'Schedule tick · internal 2',
    ]);
    expect(rows[0]!.querySelector<HTMLInputElement>('input')?.checked).toBe(true);
    const total = rows.reduce(
      (sum, row) =>
        sum + Number(row.querySelector('.cinder-filter-bar__option-count')?.textContent),
      0,
    );
    expect(total).toBe(19);
  });
});

describe('FilterBar select facets (row 45u)', () => {
  test('Kind and Written by are two separate selects that read "Kind: All" and "Written by: Anyone"', async () => {
    const { container } = render(FilterBar, {
      facets: [KIND, WRITER],
      searchPlaceholder: 'Search memories',
    });
    const prefixes = [...container.querySelectorAll('.cinder-select__prefix')].map((prefix) =>
      textOf(prefix),
    );
    expect(prefixes).toEqual(['Kind:', 'Written by:']);
    const values = [...container.querySelectorAll('.cinder-select__value')].map((value) =>
      textOf(value),
    );
    expect(values).toEqual(['All', 'Anyone']);
    expect(container.querySelectorAll('.cinder-select[role="combobox"]')).toHaveLength(2);
    // A bar of selects and a search field starts with the search and stacks in a narrow pane.
    expect(
      container.querySelector('.cinder-filter-bar')?.getAttribute('data-cinder-search-position'),
    ).toBe('start');
    expect(
      container.querySelector('.cinder-filter-bar')?.hasAttribute('data-cinder-collapsible'),
    ).toBe(false);
    const first = container.querySelector('.cinder-filter-bar__row')!.firstElementChild!;
    expect(first.classList.contains('cinder-search-field')).toBe(true);
  });

  test('opening Kind lists All, Fact and How-to with All current, and a pick reports the value', async () => {
    const changes: [string, string][] = [];
    const { container } = render(FilterBar, {
      facets: [KIND, WRITER],
      onFacetChange: (key: string, value: string) => changes.push([key, value]),
    });
    await fireEvent.click(container.querySelectorAll('.cinder-select[role="combobox"]')[0]!);
    flushSync();
    expect(optionTexts()).toEqual(['All', 'Fact', 'How-to']);
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.textContent).toContain(
      'All',
    );

    await fireEvent.click([...document.querySelectorAll('[role="option"]')][2]!);
    flushSync();
    expect(changes).toEqual([['kind', 'how-to']]);
  });

  test('the Written by list offers Anyone, You and Tool runner', async () => {
    const { container } = render(FilterBar, { facets: [KIND, WRITER] });
    await fireEvent.click(container.querySelectorAll('.cinder-select[role="combobox"]')[1]!);
    flushSync();
    expect(optionTexts()).toEqual(['Anyone', 'You', 'Tool runner']);
  });

  test('picking the clearing row reports an empty value and a select never becomes a chip', async () => {
    const changes: [string, string][] = [];
    const { container } = render(FilterBar, {
      facets: [KIND],
      appliedFilters: [{ key: 'kind', value: 'fact', label: 'Kind' }],
      onFacetChange: (key: string, value: string) => changes.push([key, value]),
    });
    expect(textOf(container.querySelector('.cinder-select__value'))).toBe('Fact');
    expect(container.querySelector('.cinder-filter-bar__chip')).toBeNull();
    await fireEvent.click(container.querySelector('.cinder-select[role="combobox"]')!);
    flushSync();
    await fireEvent.click([...document.querySelectorAll('[role="option"]')][0]!);
    flushSync();
    expect(changes).toEqual([['kind', '']]);
  });

  test('a custom facet renders its snippet with the value and the bar-level disabled state', () => {
    const received: unknown[] = [];
    const control = createRawSnippet((arguments_: () => { value: string; disabled: boolean }) => {
      received.push(arguments_());
      return { render: () => '<span data-testid="custom">custom</span>', setup: () => {} };
    });
    const { container } = render(FilterBar, {
      facets: [{ type: 'custom', key: 'range', label: 'Range', control }],
      appliedFilters: [{ key: 'range', value: 'week', label: 'Range' }],
      disabled: true,
    });
    expect(container.querySelector('[data-testid="custom"]')).not.toBeNull();
    expect(received[0]).toMatchObject({ value: 'week', disabled: true });
  });
});

describe('FilterBar medium layout (row 10f)', () => {
  test('folds the segments into a "Status: All 19" select, keeps the chips and turns search into an icon button', async () => {
    const changes: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'medium',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT],
      onSegmentChange: (value: string) => changes.push(value),
    });
    expect(container.querySelector('[role="radiogroup"]')).toBeNull();
    expect(textOf(container.querySelector('.cinder-select__prefix'))).toBe('Status:');
    expect(textOf(container.querySelector('.cinder-select__value'))).toBe('All 19');
    expect(
      [...container.querySelectorAll('.cinder-filter-bar__chip-trigger')].map((trigger) =>
        textOf(trigger),
      ),
    ).toEqual(['Started by', 'Agent']);
    expect(container.querySelector('.cinder-search-field')).toBeNull();
    expect(container.querySelector('button[aria-label="Search"]')).not.toBeNull();

    await fireEvent.click(container.querySelector('.cinder-select[role="combobox"]')!);
    flushSync();
    expect(optionTexts()).toEqual([
      'All 19',
      'Waiting on you 2',
      'Running 0',
      'Done 15',
      'Failed 1',
      'Canceled 1',
    ]);
    await fireEvent.click([...document.querySelectorAll('[role="option"]')][4]!);
    flushSync();
    expect(changes).toEqual(['failed']);
  });

  test('the select reads the chosen segment, such as "Status: Problems 1"', () => {
    const { container } = render(FilterBar, {
      layout: 'medium',
      segments: [
        { value: 'all', label: 'All', count: 3 },
        { value: 'problems', label: 'Problems', count: 1 },
      ],
      segmentValue: 'problems',
      facets: [
        {
          type: 'choice',
          key: 'starts',
          label: 'Starts',
          options: [{ value: 'a', label: 'On a schedule' }],
        },
      ],
    });
    expect(textOf(container.querySelector('.cinder-select__value'))).toBe('Problems 1');
  });

  test('the search icon opens a popover holding the search field', async () => {
    const queries: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'medium',
      segments: RUN_SEGMENTS,
      onSearchChange: (query: string) => queries.push(query),
    });
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Search"]')!;
    await fireEvent.click(button);
    flushSync();
    await waitFor(() =>
      expect(document.querySelector('.cinder-search-field input')).not.toBeNull(),
    );
    const input = document.querySelector<HTMLInputElement>('.cinder-search-field input')!;
    await fireEvent.input(input, { target: { value: 'refund' } });
    expect(queries).toEqual(['refund']);
  });

  test('a filtered-to-nothing bar keeps the "Status: All 0" select and its applied chip (row 60x)', () => {
    const { container } = render(FilterBar, {
      layout: 'medium',
      segments: [
        { value: 'all', label: 'All', count: 0 },
        { value: 'paused', label: 'Paused', count: 0 },
      ],
      facets: [
        {
          type: 'choice',
          key: 'starts',
          label: 'Starts',
          multiple: false,
          options: [{ value: 'schedule', label: 'On a schedule' }],
        },
      ],
      appliedFilters: [{ key: 'starts', value: 'schedule', label: 'Starts' }],
    });
    expect(textOf(container.querySelector('.cinder-select__value'))).toBe('All 0');
    const chip = container.querySelector('.cinder-filter-bar__chip[data-cinder-applied]');
    expect(textOf(chip)).toBe('Starts: On a schedule');
    expect(chip?.querySelector('.cinder-filter-bar__chip-remove')).not.toBeNull();
  });
});

describe('FilterBar narrow layout (rows 04l 10g)', () => {
  test('shows only the Status select and a Filter button', () => {
    const { container } = render(FilterBar, {
      layout: 'narrow',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT],
    });
    expect(textOf(container.querySelector('.cinder-select__prefix'))).toBe('Status:');
    expect(textOf(container.querySelector('.cinder-select__value'))).toBe('All 19');
    expect(container.querySelector('.cinder-filter-bar__chip')).toBeNull();
    expect(container.querySelector('.cinder-search-field')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>('.cinder-filter-bar__menu-button')!;
    expect(textOf(button)).toBe('Filter');
    expect(button.getAttribute('aria-label')).toBe('Filter');
    const controls = [...container.querySelector('.cinder-filter-bar__row')!.children].filter(
      (child) => textOf(child) !== '',
    );
    expect(controls).toHaveLength(2);
  });

  test('the Filter menu holds every chip and Search, and a row opens its options in place', async () => {
    const changes: [string, readonly string[]][] = [];
    const { container } = render(FilterBar, {
      layout: 'narrow',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT],
      onFacetValuesChange: (key: string, values: readonly string[]) => changes.push([key, values]),
    });
    await fireEvent.click(container.querySelector('.cinder-filter-bar__menu-button')!);
    flushSync();
    await waitFor(() => expect(document.querySelector('.cinder-filter-bar__menu')).not.toBeNull());
    const rows = [...document.querySelectorAll('.cinder-filter-bar__menu-row')].map((row) =>
      textOf(row),
    );
    expect(rows).toEqual(['Started by', 'Agent', 'Search']);

    await fireEvent.click(
      document.querySelectorAll<HTMLButtonElement>('.cinder-filter-bar__menu-row')[0]!,
    );
    flushSync();
    expect(document.querySelectorAll('.cinder-filter-bar__option')).toHaveLength(7);
    // The row's own words are the title, so the section draws none of its own.
    expect(document.querySelector('.cinder-filter-bar__options-title')).toBeNull();
    const chats = [
      ...document.querySelectorAll<HTMLInputElement>('.cinder-filter-bar__option input'),
    ][1]!;
    await fireEvent.click(chats);
    expect(changes).toEqual([['startedBy', ['chats']]]);
  });

  test('the Search row opens the search field', async () => {
    const { container } = render(FilterBar, {
      layout: 'narrow',
      segments: RUN_SEGMENTS,
      facets: [AGENT],
    });
    await fireEvent.click(container.querySelector('.cinder-filter-bar__menu-button')!);
    flushSync();
    await waitFor(() => expect(document.querySelector('.cinder-filter-bar__menu')).not.toBeNull());
    const search = [
      ...document.querySelectorAll<HTMLButtonElement>('.cinder-filter-bar__menu-row'),
    ].find((row) => textOf(row) === 'Search')!;
    expect(search.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(search);
    flushSync();
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(
      document.querySelector('.cinder-filter-bar__menu .cinder-search-field input'),
    ).not.toBeNull();
  });

  test('the Filter button counts the applied filters and the menu rows say what they hold', async () => {
    const { container } = render(FilterBar, {
      layout: 'narrow',
      segments: RUN_SEGMENTS,
      facets: [STARTED_BY, AGENT],
      appliedFilters: [
        { key: 'startedBy', value: 'chats,goals', label: 'Started by', values: ['chats', 'goals'] },
        { key: 'agent', value: 'tool-runner', label: 'Agent' },
      ],
    });
    const button = container.querySelector<HTMLButtonElement>('.cinder-filter-bar__menu-button')!;
    expect(button.getAttribute('aria-label')).toBe('Filter, 2 applied');
    await fireEvent.click(button);
    flushSync();
    await waitFor(() => expect(document.querySelector('.cinder-filter-bar__menu')).not.toBeNull());
    const rows = [...document.querySelectorAll('.cinder-filter-bar__menu-row')].map((row) =>
      textOf(row),
    );
    expect(rows).toEqual(['Started by Chats, Goals', 'Agent Tool runner', 'Search']);
  });

  test('a select facet in the menu reports the empty value when its clearing row is chosen', async () => {
    const changes: [string, string][] = [];
    const { container } = render(FilterBar, {
      layout: 'narrow',
      segments: RUN_SEGMENTS,
      facets: [KIND],
      appliedFilters: [{ key: 'kind', value: 'fact', label: 'Kind' }],
      onFacetChange: (key: string, value: string) => changes.push([key, value]),
    });
    await fireEvent.click(container.querySelector('.cinder-filter-bar__menu-button')!);
    flushSync();
    await waitFor(() => expect(document.querySelector('.cinder-filter-bar__menu')).not.toBeNull());
    await fireEvent.click(
      document.querySelector<HTMLButtonElement>('.cinder-filter-bar__menu-row')!,
    );
    flushSync();
    const radios = [
      ...document.querySelectorAll<HTMLInputElement>(
        '.cinder-filter-bar__menu input[type="radio"]',
      ),
    ];
    expect(radios).toHaveLength(3);
    expect(radios[1]!.checked).toBe(true);
    await fireEvent.click(radios[0]!);
    expect(changes).toEqual([['kind', '']]);
  });
});

describe('FilterBar live region', () => {
  test('stays in the DOM, empty, while nothing is applied', () => {
    const { container } = render(FilterBar, { layout: 'wide', facets: [STARTED_BY, AGENT] });
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(textOf(region)).toBe('');
  });

  test('announces the count and the values once filters are applied', async () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      facets: [STARTED_BY, AGENT],
      appliedFilters: [
        { key: 'startedBy', value: 'chats,goals', label: 'Started by', values: ['chats', 'goals'] },
        { key: 'agent', value: 'tool-runner', label: 'Agent' },
      ],
    });
    await waitFor(() =>
      expect(textOf(container.querySelector('[role="status"]'))).toBe(
        '2 active filters: Started by: Chats, Goals, Agent: Tool runner',
      ),
    );
  });
});

describe('FilterBar search', () => {
  test('is uncontrolled until a searchQuery is passed and reports each edit', async () => {
    const queries: string[] = [];
    const { container } = render(FilterBar, {
      layout: 'wide',
      searchPlaceholder: 'Search workflows',
      onSearchChange: (query: string) => queries.push(query),
    });
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(input.getAttribute('aria-label')).toBe('Search');
    await fireEvent.input(input, { target: { value: 'order' } });
    expect(queries).toEqual(['order']);
    expect(input.value).toBe('order');
  });

  test('a controlled searchQuery wins', () => {
    const { container } = render(FilterBar, { layout: 'wide', searchQuery: 'refund' });
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe('refund');
  });

  test('searchPosition moves the field to the start of a bar with segments', () => {
    const { container } = render(FilterBar, {
      layout: 'wide',
      segments: RUN_SEGMENTS,
      searchPosition: 'start',
    });
    expect(
      container
        .querySelector('.cinder-filter-bar__row')!
        .firstElementChild!.classList.contains('cinder-search-field'),
    ).toBe(true);
  });
});

describe('FilterBar styles', () => {
  test('the row never wraps and the search is the one control that gives way', () => {
    expect(filterBarCss).not.toContain('flex-wrap: wrap');
    expect(filterBarCss).toContain('.cinder-filter-bar__row > .cinder-filter-bar__search');
  });
});
