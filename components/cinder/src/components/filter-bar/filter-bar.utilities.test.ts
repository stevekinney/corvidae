import { describe, expect, test } from 'bun:test';

import type { ChoiceFacet, FacetDefinition, FilterSegment } from './filter-bar.types.ts';
import {
  appliedSummary,
  appliedValues,
  estimateFilterBarWidth,
  fromControlValue,
  isCollapsible,
  optionLabel,
  resolveFilterBarLayout,
  segmentSelectLabel,
  toControlValue,
} from './filter-bar.utilities.ts';

const SEGMENTS: FilterSegment[] = [
  { value: 'all', label: 'All', count: 19 },
  { value: 'waiting', label: 'Waiting on you', count: 2 },
];

const CHOICE: ChoiceFacet = {
  type: 'choice',
  key: 'startedBy',
  label: 'Started by',
  options: [
    { value: 'chats', label: 'Chats' },
    { value: 'goals', label: 'Goals' },
  ],
};

function contents(overrides: Partial<Parameters<typeof estimateFilterBarWidth>[0]> = {}) {
  return {
    segments: SEGMENTS,
    facets: [CHOICE] as readonly FacetDefinition[],
    appliedFilters: [],
    segmentsLabel: 'Status',
    searchVisible: true,
    ...overrides,
  };
}

describe('applied values', () => {
  test('values wins over value, and an empty value is no values', () => {
    expect(appliedValues({ key: 'a', label: 'A', value: 'x,y', values: ['x', 'y'] })).toEqual([
      'x',
      'y',
    ]);
    expect(appliedValues({ key: 'a', label: 'A', value: 'x' })).toEqual(['x']);
    expect(appliedValues({ key: 'a', label: 'A', value: '' })).toEqual([]);
  });

  test('a summary follows the facet option order and puts an unknown value last', () => {
    expect(
      appliedSummary(CHOICE, {
        key: 'startedBy',
        label: 'Started by',
        value: '',
        values: ['zebra', 'goals', 'chats'],
      }),
    ).toBe('Chats, Goals, zebra');
  });

  test('optionLabel falls back to the value', () => {
    expect(optionLabel(CHOICE.options, 'goals')).toBe('Goals');
    expect(optionLabel(CHOICE.options, 'other')).toBe('other');
  });

  test('a segment select label carries its count, and a pending count is left off', () => {
    expect(segmentSelectLabel({ value: 'a', label: 'All', count: 19 })).toBe('All 19');
    expect(segmentSelectLabel({ value: 'a', label: 'All', count: 0 })).toBe('All 0');
    expect(segmentSelectLabel({ value: 'a', label: 'All', count: 'pending' })).toBe('All');
    expect(segmentSelectLabel({ value: 'a', label: 'All' })).toBe('All');
  });

  test('the clearing value maps both ways and leaves every other value alone', () => {
    expect(fromControlValue(toControlValue(''))).toBe('');
    expect(toControlValue('fact')).toBe('fact');
    expect(fromControlValue('fact')).toBe('fact');
    expect(toControlValue('')).not.toBe('');
  });
});

describe('collapsibility', () => {
  test('segments, choice facets and toggle facets can collapse', () => {
    expect(isCollapsible(contents())).toBe(true);
    expect(isCollapsible(contents({ segments: [] }))).toBe(true);
    expect(
      isCollapsible(contents({ segments: [], facets: [{ type: 'toggle', key: 't', label: 'T' }] })),
    ).toBe(true);
  });

  test('selects and search alone cannot', () => {
    expect(
      isCollapsible(
        contents({
          segments: [],
          facets: [{ type: 'select', key: 'k', label: 'K', options: [] }],
        }),
      ),
    ).toBe(false);
  });
});

describe('width estimates', () => {
  test('each step down needs less room', () => {
    const wide = estimateFilterBarWidth(contents(), 'wide');
    const medium = estimateFilterBarWidth(contents(), 'medium');
    const narrow = estimateFilterBarWidth(contents(), 'narrow');
    expect(wide).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThan(narrow);
  });

  test('the Runs bar needs about a thousand pixels wide, and the Workflows bar far less', () => {
    const runs = estimateFilterBarWidth(
      contents({
        segments: [
          { value: 'all', label: 'All', count: 19 },
          { value: 'waiting', label: 'Waiting on you', count: 2 },
          { value: 'running', label: 'Running', count: 0 },
          { value: 'done', label: 'Done', count: 15 },
          { value: 'failed', label: 'Failed', count: 1 },
          { value: 'canceled', label: 'Canceled', count: 1 },
        ],
        facets: [CHOICE, { ...CHOICE, key: 'agent', label: 'Agent' }],
      }),
      'wide',
    );
    expect(runs).toBeGreaterThan(900);
    expect(runs).toBeLessThan(1150);
    const workflows = estimateFilterBarWidth(
      contents({ segments: SEGMENTS, facets: [{ ...CHOICE, key: 'starts', label: 'Starts' }] }),
      'wide',
    );
    expect(workflows).toBeLessThan(700);
  });

  test('an applied chip is wider than its add chip, and a toggle count adds room', () => {
    const applied = estimateFilterBarWidth(
      contents({
        appliedFilters: [
          { key: 'startedBy', label: 'Started by', value: 'chats', values: ['chats'] },
        ],
      }),
      'wide',
    );
    expect(applied).toBeGreaterThan(estimateFilterBarWidth(contents(), 'wide'));
    const toggle: FacetDefinition = { type: 'toggle', key: 't', label: 'Missed runs', count: 1 };
    expect(estimateFilterBarWidth(contents({ facets: [toggle] }), 'wide')).toBeGreaterThan(
      estimateFilterBarWidth(
        contents({ facets: [{ type: 'toggle', key: 't', label: 'Missed runs' }] }),
        'wide',
      ),
    );
  });

  test('accounts for select options and custom controls in wide layouts', () => {
    const select = estimateFilterBarWidth(
      contents({
        segments: [],
        searchVisible: false,
        facets: [
          {
            type: 'select',
            key: 'kind',
            label: 'Kind',
            placeholder: 'Any kind',
            options: [{ value: 'long', label: 'A long option label' }],
          },
        ],
      }),
      'wide',
    );
    const custom = estimateFilterBarWidth(
      contents({
        segments: [],
        searchVisible: false,
        facets: [{ type: 'custom', key: 'date', label: 'Date', control: undefined as never }],
      }),
      'wide',
    );
    expect(select).toBeGreaterThan(0);
    expect(custom).toBeGreaterThan(0);
  });
});

describe('resolveFilterBarLayout', () => {
  const base = { contents: contents(), forced: 'auto' as const, phone: false, tablet: false };

  test('follows the viewport when the bar has room or is unmeasured', () => {
    expect(resolveFilterBarLayout({ ...base, containerWidth: undefined })).toBe('wide');
    expect(resolveFilterBarLayout({ ...base, tablet: true, containerWidth: 5000 })).toBe('medium');
    expect(
      resolveFilterBarLayout({ ...base, tablet: true, phone: true, containerWidth: 5000 }),
    ).toBe('narrow');
  });

  test('takes the narrower of the viewport and the bar', () => {
    expect(resolveFilterBarLayout({ ...base, containerWidth: 500 })).toBe('medium');
    expect(resolveFilterBarLayout({ ...base, containerWidth: 100 })).toBe('narrow');
  });

  test('a forced layout wins, and a bar that cannot collapse is wide', () => {
    expect(resolveFilterBarLayout({ ...base, forced: 'narrow', containerWidth: 5000 })).toBe(
      'narrow',
    );
    expect(
      resolveFilterBarLayout({
        ...base,
        contents: contents({
          segments: [],
          facets: [{ type: 'select', key: 'k', label: 'K', options: [] }],
        }),
        phone: true,
        tablet: true,
        containerWidth: 100,
      }),
    ).toBe('wide');
  });
});
