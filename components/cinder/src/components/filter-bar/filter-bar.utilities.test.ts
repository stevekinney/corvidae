import { describe, expect, test } from 'bun:test';

import type { ChoiceFacet, FacetDefinition, FilterSegment } from './filter-bar.types.ts';
import {
  appliedSummary,
  appliedValues,
  type FilterBarContents,
  type FilterBarFitInput,
  foldableFacetKeys,
  fromControlValue,
  isCollapsible,
  layoutForm,
  narrowerForm,
  nextFilterBarFit,
  normalizeForm,
  optionLabel,
  resolveFilterBarForm,
  segmentSelectLabel,
  toControlValue,
  viewportLayout,
  widerForm,
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

  test('a segment select label carries its count, and a pending count is the wide segment’s dash', () => {
    expect(segmentSelectLabel({ value: 'a', label: 'All', count: 19 })).toBe('All 19');
    expect(segmentSelectLabel({ value: 'a', label: 'All', count: 0 })).toBe('All 0');
    expect(segmentSelectLabel({ value: 'a', label: 'All', count: 'pending' })).toBe('All –');
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

const WIDE = layoutForm('wide');
const SEARCH_FOLDED = layoutForm('search-folded');
const MEDIUM = layoutForm('medium');
const NARROW = layoutForm('narrow');

describe('resolveFilterBarForm', () => {
  const base = {
    collapsible: true,
    forced: 'auto' as const,
    viewport: 'wide' as const,
    fitted: WIDE,
    foldable: 0,
  };

  test('follows the viewport while the bar fits or is unmeasured', () => {
    expect(viewportLayout(false, false)).toBe('wide');
    expect(viewportLayout(false, true)).toBe('medium');
    expect(viewportLayout(true, true)).toBe('narrow');
    expect(resolveFilterBarForm(base)).toEqual(WIDE);
    expect(resolveFilterBarForm({ ...base, viewport: 'medium' })).toEqual(MEDIUM);
  });

  test('takes the narrower of the viewport and what the bar was measured to fit', () => {
    expect(resolveFilterBarForm({ ...base, fitted: MEDIUM })).toEqual(MEDIUM);
    expect(resolveFilterBarForm({ ...base, viewport: 'medium', fitted: NARROW })).toEqual(NARROW);
    expect(narrowerForm(WIDE, NARROW, 0)).toEqual(NARROW);
    // A medium form with a chip folded is narrower than the medium form a tablet asks for.
    const folded = { layout: 'medium' as const, folded: 1 };
    expect(
      resolveFilterBarForm({ ...base, viewport: 'medium', fitted: folded, foldable: 2 }),
    ).toEqual(folded);
  });

  test('a forced layout wins and folds no chip, and a bar that cannot collapse is wide', () => {
    expect(resolveFilterBarForm({ ...base, forced: 'narrow' })).toEqual(NARROW);
    expect(
      resolveFilterBarForm({
        ...base,
        forced: 'medium',
        fitted: { layout: 'medium', folded: 2 },
        foldable: 2,
      }),
    ).toEqual(MEDIUM);
    expect(
      resolveFilterBarForm({ ...base, collapsible: false, viewport: 'narrow', fitted: NARROW }),
    ).toEqual(WIDE);
  });

  test('a fold count past the chips that can fold now counts as all of them', () => {
    expect(normalizeForm({ layout: 'medium', folded: 3 }, 1)).toEqual({
      layout: 'medium',
      folded: 1,
    });
    expect(normalizeForm({ layout: 'medium', folded: 3 }, 0)).toEqual(MEDIUM);
    expect(widerForm({ layout: 'medium', folded: 2 }, 2)).toEqual({ layout: 'medium', folded: 1 });
    expect(widerForm(MEDIUM, 2)).toEqual(SEARCH_FOLDED);
    expect(widerForm(NARROW, 2)).toEqual({ layout: 'medium', folded: 2 });
    expect(widerForm(WIDE, 2)).toEqual(WIDE);
  });
});

describe('foldableFacetKeys', () => {
  const FACETS: FacetDefinition[] = [
    CHOICE,
    { type: 'choice', key: 'workflow', label: 'Workflow', options: [] },
    { type: 'choice', key: 'agent', label: 'Agent', options: [] },
    { type: 'select', key: 'kind', label: 'Kind', options: [] },
    { type: 'toggle', key: 'missed', label: 'Missed runs' },
  ];

  test('only unapplied choice and toggle chips fold, from the end of the list by default', () => {
    expect(foldableFacetKeys(FACETS, new Set())).toEqual([
      'missed',
      'agent',
      'workflow',
      'startedBy',
    ]);
    expect(foldableFacetKeys(FACETS, new Set(['agent', 'missed']))).toEqual([
      'workflow',
      'startedBy',
    ]);
  });

  test('the fold order names the least used first, and an applied chip never folds', () => {
    const order = ['workflow', 'agent', 'startedBy'];
    expect(foldableFacetKeys(FACETS, new Set(), order)).toEqual([
      'workflow',
      'agent',
      'startedBy',
      'missed',
    ]);
    expect(foldableFacetKeys(FACETS, new Set(['agent', 'startedBy']), order)).toEqual([
      'workflow',
      'missed',
    ]);
    expect(foldableFacetKeys(FACETS, new Set(), ['kind', 'gone', 'agent', 'agent'])).toEqual([
      'agent',
      'missed',
      'workflow',
      'startedBy',
    ]);
  });
});

describe('nextFilterBarFit', () => {
  const base: FilterBarFitInput = {
    drawn: WIDE,
    viewport: 'wide',
    foldable: 0,
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
    // Search folds before the segments do: wide goes to search-folded, and only then to medium.
    expect(nextFilterBarFit({ ...base, need: 1100 }).fitted).toEqual(SEARCH_FOLDED);
    expect(nextFilterBarFit({ ...base, drawn: SEARCH_FOLDED, need: 1100 }).fitted).toEqual(MEDIUM);
    expect(nextFilterBarFit({ ...base, drawn: MEDIUM, need: 1100 }).fitted).toEqual(NARROW);
    expect(nextFilterBarFit({ ...base, drawn: NARROW, need: 1100 }).fitted).toBeUndefined();
  });

  test('a medium row that overflows moves its unapplied chips into the menu one at a time before it folds to narrow', () => {
    const medium = { ...base, foldable: 2, need: 700, available: 640 };
    expect(nextFilterBarFit({ ...medium, drawn: MEDIUM }).fitted).toEqual({
      layout: 'medium',
      folded: 1,
    });
    expect(nextFilterBarFit({ ...medium, drawn: { layout: 'medium', folded: 1 } }).fitted).toEqual({
      layout: 'medium',
      folded: 2,
    });
    expect(nextFilterBarFit({ ...medium, drawn: { layout: 'medium', folded: 2 } }).fitted).toEqual(
      NARROW,
    );
    // From narrow it steps up to the medium form with every chip folded, then gives them back.
    expect(
      nextFilterBarFit({ ...medium, drawn: NARROW, need: 300, widerNeed: 600 }).fitted,
    ).toEqual({ layout: 'medium', folded: 2 });
    expect(
      nextFilterBarFit({
        ...medium,
        drawn: { layout: 'medium', folded: 1 },
        need: 600,
        widerNeed: 640,
      }).fitted,
    ).toEqual(MEDIUM);
  });

  test('a folded row steps up when the wider form, as measured, fits', () => {
    const folded = { ...base, drawn: MEDIUM, need: 700 };
    expect(nextFilterBarFit({ ...folded, widerNeed: 1000 }).fitted).toEqual(SEARCH_FOLDED);
    expect(nextFilterBarFit({ ...folded, widerNeed: 1100 }).fitted).toBeUndefined();
    expect(
      nextFilterBarFit({ ...folded, drawn: SEARCH_FOLDED, need: 900, widerNeed: 1000 }).fitted,
    ).toEqual(WIDE);
    expect(nextFilterBarFit({ ...folded, drawn: NARROW, widerNeed: 700 }).fitted).toEqual(MEDIUM);
  });

  test('a folded row never steps past the viewport form', () => {
    expect(
      nextFilterBarFit({ ...base, drawn: MEDIUM, viewport: 'medium', need: 700, widerNeed: 1 })
        .fitted,
    ).toBeUndefined();
  });

  test('an unmeasured wider form is drawn to measure it, unless the bar is in use', () => {
    const folded = { ...base, drawn: MEDIUM, need: 700 };
    expect(nextFilterBarFit(folded)).toEqual({ fitted: SEARCH_FOLDED, waiting: false });
    expect(nextFilterBarFit({ ...folded, mayProbe: false })).toEqual({
      fitted: undefined,
      waiting: true,
    });
  });
});
