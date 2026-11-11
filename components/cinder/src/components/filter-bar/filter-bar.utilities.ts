import type {
  AppliedFilter,
  FacetDefinition,
  FacetOption,
  FilterBarLayout,
  FilterSegment,
} from './filter-bar.types.ts';

/** Viewport width below which a list's segments collapse to a select and a Filter menu. */
export const FILTER_BAR_PHONE_BREAKPOINT = '640px';

/** Viewport width below which a list's segments collapse to a select. */
export const FILTER_BAR_TABLET_BREAKPOINT = '1024px';

/**
 * The value the row that clears a select facet carries inside the controls. A Select reads an
 * empty value as "nothing chosen" and draws its placeholder, so the clearing row ("All") needs a
 * value of its own; the bar maps it to and from the empty string it reports.
 */
export const FILTER_BAR_CLEAR_VALUE = '__cinder-filter-bar-clear__';

/** A facet's reported value as the control that draws it holds it. */
export function toControlValue(value: string): string {
  return value === '' ? FILTER_BAR_CLEAR_VALUE : value;
}

/** A control's value as the bar reports it. */
export function fromControlValue(value: string): string {
  return value === FILTER_BAR_CLEAR_VALUE ? '' : value;
}

/** The values an applied filter holds, whichever way it carries them. */
export function appliedValues(filter: AppliedFilter): readonly string[] {
  if (filter.values !== undefined) return filter.values;
  return filter.value === '' ? [] : [filter.value];
}

/** The label of the option a value names, or the value itself when no option names it. */
export function optionLabel(options: readonly FacetOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/**
 * The words an applied choice chip shows after "Started by:", such as "Chats, Goals". They follow
 * the facet's own option order however the consumer stored the values, so the chip reads the same
 * as the popover's list; a value no option names comes last.
 */
export function appliedSummary(
  facet: Extract<FacetDefinition, { options: readonly FacetOption[] }>,
  filter: AppliedFilter,
): string {
  const rank = (value: string): number => {
    const index = facet.options.findIndex((option) => option.value === value);
    return index === -1 ? facet.options.length : index;
  };
  return appliedValues(filter)
    .toSorted((first, second) => rank(first) - rank(second))
    .map((value) => optionLabel(facet.options, value))
    .join(', ');
}

/** The label a segment shows in the collapsed select, which draws a count as part of the label. */
export function segmentSelectLabel(segment: FilterSegment): string {
  if (typeof segment.count === 'number') return `${segment.label} ${segment.count}`;
  return segment.label;
}

/** What the bar holds, which is all its collapsibility needs to know. */
export type FilterBarContents = {
  segments: readonly FilterSegment[];
  facets: readonly FacetDefinition[];
};

/**
 * Whether the bar collapses at all. A bar of selects, custom controls and a search field has no
 * segments to fold into a select and no chips to move into a menu, so it keeps its one form and
 * stacks inside a narrow container instead (a list pane's filters, for one).
 */
export function isCollapsible(contents: FilterBarContents): boolean {
  return (
    contents.segments.length > 0 ||
    contents.facets.some((facet) => facet.type === 'choice' || facet.type === 'toggle')
  );
}

const ORDER: Record<FilterBarLayout, number> = { wide: 2, medium: 1, narrow: 0 };
const NARROWER: Record<FilterBarLayout, FilterBarLayout> = {
  wide: 'medium',
  medium: 'narrow',
  narrow: 'narrow',
};
const WIDER: Record<FilterBarLayout, FilterBarLayout> = {
  wide: 'wide',
  medium: 'wide',
  narrow: 'medium',
};

/** The narrower of two layouts. */
export function narrowerLayout(first: FilterBarLayout, second: FilterBarLayout): FilterBarLayout {
  return ORDER[first] <= ORDER[second] ? first : second;
}

/** The layout the viewport asks for: narrow on a phone, medium on a tablet, wide otherwise. */
export function viewportLayout(phone: boolean, tablet: boolean): FilterBarLayout {
  if (phone) return 'narrow';
  return tablet ? 'medium' : 'wide';
}

/** What decides the layout. */
export type ResolveLayoutInput = {
  /** Whether the bar has anything to fold (`isCollapsible`). */
  collapsible: boolean;
  /** A layout the consumer forced. */
  forced: 'auto' | FilterBarLayout;
  /** The layout the viewport asks for (`viewportLayout`). */
  viewport: FilterBarLayout;
  /** The widest layout the bar's measured row fits, `wide` until the row has been measured. */
  fitted: FilterBarLayout;
};

/**
 * The layout the bar is drawn in: the narrower of what the viewport asks for and what the bar's
 * own row was measured to hold, so a bar beside a wide sidebar never overflows and never wraps. A
 * forced layout wins, and a bar that cannot collapse is always `wide`.
 */
export function resolveFilterBarLayout(input: ResolveLayoutInput): FilterBarLayout {
  if (input.forced !== 'auto') return input.forced;
  if (!input.collapsible) return 'wide';
  return narrowerLayout(input.viewport, input.fitted);
}

/**
 * How far, in pixels, a row may run past its box and still count as fitting: `scrollWidth` is
 * rounded to a whole pixel and a flex basis need not be.
 */
const FIT_TOLERANCE = 0.5;

/** One measurement of the drawn row, and what is known about the next wider form. */
export type FilterBarFitInput = {
  /** The layout drawn when the row was measured. */
  drawn: FilterBarLayout;
  /** The layout the viewport asks for, which the bar never draws wider than. */
  viewport: FilterBarLayout;
  /** The inline size, in pixels, the drawn row's controls need. */
  need: number;
  /** The row's inline size, in pixels. */
  available: number;
  /**
   * What the next wider form was measured to need with the same contents, or `undefined` when it
   * has not been drawn with them.
   */
  widerNeed: number | undefined;
  /**
   * Whether the bar may draw the wider form to measure it. Drawing it remounts the segments and the
   * search, so the bar does not while focus or an open popup is inside it.
   */
  mayProbe: boolean;
};

/** What a measurement decides. */
export type FilterBarFit = {
  /** The widest layout the bar now fits, or `undefined` to keep the one it has. */
  fitted: FilterBarLayout | undefined;
  /** Whether a wider form may fit but could not be drawn to find out, so the bar asks again later. */
  waiting: boolean;
};

/**
 * Decides the layout from the drawn row's measured width, never from an estimate of its text. A
 * row that needs more than it has steps down one form. A row that fits steps up when the wider
 * form, as last measured with the same contents, fits too. When that form has not been measured,
 * the bar draws it to measure it (before the browser paints), unless focus or an open popup is
 * inside the bar, in which case it waits.
 */
export function nextFilterBarFit(input: FilterBarFitInput): FilterBarFit {
  if (input.need - input.available > FIT_TOLERANCE) {
    return {
      fitted: input.drawn === 'narrow' ? undefined : NARROWER[input.drawn],
      waiting: false,
    };
  }
  if (ORDER[input.drawn] >= ORDER[input.viewport]) return { fitted: undefined, waiting: false };
  const wider = WIDER[input.drawn];
  if (input.widerNeed !== undefined) {
    const fits = input.widerNeed - input.available <= FIT_TOLERANCE;
    return { fitted: fits ? wider : undefined, waiting: false };
  }
  return input.mayProbe ? { fitted: wider, waiting: false } : { fitted: undefined, waiting: true };
}

/**
 * The inline size, in pixels, the drawn row's controls need. A row that overflows reports it in
 * `scrollWidth`. The search field is the one control that gives way (it shrinks toward nothing
 * before the row overflows), so it is counted at no less than its flex basis: a search squeezed
 * below that is a row that does not fit.
 */
export function measureFilterBarRow(row: HTMLElement): number {
  let need = row.scrollWidth;
  const search = row.querySelector<HTMLElement>(':scope > .cinder-filter-bar__search');
  if (search !== null) {
    const basis = Number.parseFloat(getComputedStyle(search).flexBasis);
    if (Number.isFinite(basis)) need += Math.max(0, basis - search.getBoundingClientRect().width);
  }
  return need;
}
