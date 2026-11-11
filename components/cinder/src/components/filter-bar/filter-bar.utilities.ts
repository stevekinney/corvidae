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

/** The inline size, in pixels, an estimate gives the search field's smallest wide form. */
const SEARCH_FIELD_WIDTH = 176;
/** The inline size, in pixels, of an icon-only control (the search button, the Filter button's icon). */
const ICON_CONTROL_WIDTH = 36;
const GAP = 8;
/** The inline padding, in pixels, of one segment button (12px a side). */
const SEGMENT_PADDING = 24;
/** The inline padding, in pixels, of the segmented control's track around its buttons. */
const SEGMENT_TRACK_PADDING = 8;
/** Average glyph width of the toolbar's 13px text. */
const GLYPH_WIDTH = 6.4;

function textWidth(text: string): number {
  return Math.ceil(text.length * GLYPH_WIDTH);
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

/** What the bar holds, which is all its width estimate needs to know. */
export type FilterBarContents = {
  segments: readonly FilterSegment[];
  facets: readonly FacetDefinition[];
  appliedFilters: readonly AppliedFilter[];
  segmentsLabel: string;
  searchVisible: boolean;
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

/**
 * An estimate, in pixels, of the inline size the bar needs in a layout. It is a text-width guess,
 * not a measurement: the bar's real controls vary with the font, but the estimate only decides
 * when to step down, and a tablet or phone viewport steps it down before this does.
 */
export function estimateFilterBarWidth(
  contents: FilterBarContents,
  layout: FilterBarLayout,
): number {
  const widths: number[] = [];

  if (layout === 'wide') {
    // The segments are one control, a track with no gap between its buttons, so they take one
    // place in the row: each button's label, its count and its padding, inside the track's own.
    if (contents.segments.length > 0) {
      let track = SEGMENT_TRACK_PADDING;
      for (const segment of contents.segments) {
        track +=
          textWidth(segment.label) + (segment.count === undefined ? 0 : 22) + SEGMENT_PADDING;
      }
      widths.push(track);
    }
  } else if (contents.segments.length > 0) {
    const longest = Math.max(
      ...contents.segments.map((segment) => textWidth(segmentSelectLabel(segment))),
    );
    widths.push(textWidth(`${contents.segmentsLabel}: `) + longest + 56);
  }

  if (layout === 'narrow') {
    widths.push(textWidth('Filter') + ICON_CONTROL_WIDTH + 24);
  } else {
    for (const facet of contents.facets) {
      const applied = contents.appliedFilters.find((filter) => filter.key === facet.key);
      if (facet.type === 'select') {
        const longest = Math.max(
          textWidth(facet.placeholder ?? 'All'),
          ...facet.options.map((option) => textWidth(option.label)),
        );
        widths.push(textWidth(`${facet.label}: `) + longest + 56);
      } else if (facet.type === 'choice') {
        const value =
          applied === undefined ? 0 : textWidth(`: ${appliedSummary(facet, applied)}`) + 22;
        widths.push(textWidth(facet.label) + 44 + value);
      } else if (facet.type === 'toggle') {
        widths.push(textWidth(facet.label) + (facet.count === undefined ? 0 : 22) + 48);
      } else {
        widths.push(160);
      }
    }
    if (contents.searchVisible) {
      widths.push(layout === 'wide' ? SEARCH_FIELD_WIDTH : ICON_CONTROL_WIDTH);
    }
  }

  const total =
    widths.reduce((sum, width) => sum + width, 0) + GAP * Math.max(0, widths.length - 1);
  return Math.ceil(total * 1.05);
}

/** What decides the layout. */
export type ResolveLayoutInput = {
  contents: FilterBarContents;
  /** A layout the consumer forced. */
  forced: 'auto' | FilterBarLayout;
  /** Whether the viewport is under the phone breakpoint. */
  phone: boolean;
  /** Whether the viewport is under the tablet breakpoint. */
  tablet: boolean;
  /** The bar's own inline size in pixels, or `undefined` before it has been measured. */
  containerWidth: number | undefined;
};

const ORDER: Record<FilterBarLayout, number> = { wide: 2, medium: 1, narrow: 0 };

/**
 * The layout the bar is drawn in: the narrower of what the viewport asks for and what the bar's
 * own width can hold, so a bar beside a wide sidebar never overflows and never wraps. A forced
 * layout wins, and a bar that cannot collapse is always `wide`.
 */
export function resolveFilterBarLayout(input: ResolveLayoutInput): FilterBarLayout {
  if (input.forced !== 'auto') return input.forced;
  if (!isCollapsible(input.contents)) return 'wide';

  const viewport: FilterBarLayout = input.phone ? 'narrow' : input.tablet ? 'medium' : 'wide';
  let container: FilterBarLayout = 'wide';
  if (input.containerWidth !== undefined) {
    if (input.containerWidth < estimateFilterBarWidth(input.contents, 'medium')) {
      container = 'narrow';
    } else if (input.containerWidth < estimateFilterBarWidth(input.contents, 'wide')) {
      container = 'medium';
    }
  }
  return ORDER[viewport] <= ORDER[container] ? viewport : container;
}
