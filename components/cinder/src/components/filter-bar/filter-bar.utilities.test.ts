import { describe, expect, test } from 'bun:test';

import type { ChoiceFacet, FacetDefinition, FilterSegment } from './filter-bar.types.ts';
import {
  appliedSummary,
  appliedValues,
  type FilterBarContents,
  type FilterBarFitInput,
  fromControlValue,
  isCollapsible,
  narrowerLayout,
  nextFilterBarFit,
  optionLabel,
  resolveFilterBarLayout,
  segmentSelectLabel,
  toControlValue,
  viewportLayout,
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

function contents(overrides: Partial<FilterBarContents> = {}): FilterBarContents {
  return {
    segments: SEGMENTS,
    facets: [CHOICE] as readonly FacetDefinition[],
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

describe('resolveFilterBarLayout', () => {
  const base = {
    collapsible: true,
    forced: 'auto' as const,
    viewport: 'wide' as const,
    fitted: 'wide' as const,
  };

  test('follows the viewport while the bar fits or is unmeasured', () => {
    expect(viewportLayout(false, false)).toBe('wide');
    expect(viewportLayout(false, true)).toBe('medium');
    expect(viewportLayout(true, true)).toBe('narrow');
    expect(resolveFilterBarLayout(base)).toBe('wide');
    expect(resolveFilterBarLayout({ ...base, viewport: 'medium' })).toBe('medium');
  });

  test('takes the narrower of the viewport and what the bar was measured to fit', () => {
    expect(resolveFilterBarLayout({ ...base, fitted: 'medium' })).toBe('medium');
    expect(resolveFilterBarLayout({ ...base, viewport: 'medium', fitted: 'narrow' })).toBe(
      'narrow',
    );
    expect(narrowerLayout('wide', 'narrow')).toBe('narrow');
  });

  test('a forced layout wins, and a bar that cannot collapse is wide', () => {
    expect(resolveFilterBarLayout({ ...base, forced: 'narrow' })).toBe('narrow');
    expect(
      resolveFilterBarLayout({ ...base, collapsible: false, viewport: 'narrow', fitted: 'narrow' }),
    ).toBe('wide');
  });
});

describe('nextFilterBarFit', () => {
  const base: FilterBarFitInput = {
    drawn: 'wide',
    viewport: 'wide',
    need: 1021,
    available: 1042,
    widerNeed: undefined,
    mayProbe: true,
  };

  test('a drawn row that fits its box keeps its form', () => {
    expect(nextFilterBarFit(base)).toEqual({ fitted: undefined, waiting: false });
    // A row whose rounded scrollWidth is under a pixel past its box still fits.
    expect(nextFilterBarFit({ ...base, need: 1042.4 })).toEqual({
      fitted: undefined,
      waiting: false,
    });
  });

  test('a drawn row that overflows steps down one form, and narrow is the floor', () => {
    expect(nextFilterBarFit({ ...base, need: 1100 }).fitted).toBe('medium');
    expect(nextFilterBarFit({ ...base, drawn: 'medium', need: 1100 }).fitted).toBe('narrow');
    expect(nextFilterBarFit({ ...base, drawn: 'narrow', need: 1100 }).fitted).toBeUndefined();
  });

  test('a folded row steps up when the wider form, as measured, fits', () => {
    const folded = { ...base, drawn: 'medium' as const, need: 700 };
    expect(nextFilterBarFit({ ...folded, widerNeed: 1000 }).fitted).toBe('wide');
    expect(nextFilterBarFit({ ...folded, widerNeed: 1100 }).fitted).toBeUndefined();
    expect(nextFilterBarFit({ ...folded, drawn: 'narrow', widerNeed: 700 }).fitted).toBe('medium');
  });

  test('a folded row never steps past the viewport form', () => {
    expect(
      nextFilterBarFit({ ...base, drawn: 'medium', viewport: 'medium', need: 700, widerNeed: 1 })
        .fitted,
    ).toBeUndefined();
  });

  test('an unmeasured wider form is drawn to measure it, unless the bar is in use', () => {
    const folded = { ...base, drawn: 'medium' as const, need: 700 };
    expect(nextFilterBarFit(folded)).toEqual({ fitted: 'wide', waiting: false });
    expect(nextFilterBarFit({ ...folded, mayProbe: false })).toEqual({
      fitted: undefined,
      waiting: true,
    });
  });
});
