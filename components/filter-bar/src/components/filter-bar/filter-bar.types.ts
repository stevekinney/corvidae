import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** A single option available within a select or choice facet. */
export type FacetOption = {
  /** The value submitted when this option is selected. */
  value: string;
  /** The human-readable label shown in the option list. */
  label: string;
  /** When true, the option is visible but not selectable. */
  disabled?: boolean;
  /**
   * How many rows this option would match, drawn at the end of its row in a choice facet's
   * popover ("Chats 5"). It reads as part of the row's accessible name. Zero is shown.
   */
  count?: number;
};

/**
 * An always-visible single-choice facet, drawn as a Select that reads "Kind: All". Choosing the
 * placeholder row clears the facet. It never becomes a chip: its value is on the control.
 */
export type SelectFacet = {
  /** Discriminant that determines how the facet is rendered. */
  type: 'select';
  /** Unique key used to identify this facet in the applied-filter map. */
  key: string;
  /** Accessible label for the facet control, and the prefix before its value ("Kind:"). */
  label: string;
  /** Text of the row that clears the facet, and what the control reads while it is clear. Defaults to `All`. */
  placeholder?: string;
  /** Options available for selection. */
  options: readonly FacetOption[];
  /** Whether the facet control is disabled. */
  disabled?: boolean;
};

/**
 * A facet drawn as an add-facet chip ("+ Started by") that opens a popover of options. A facet
 * with a value becomes a tinted chip that reads "Started by: Chats, Goals" with an x that removes it.
 */
export type ChoiceFacet = {
  /** Discriminant that determines how the facet is rendered. */
  type: 'choice';
  /** Unique key used to identify this facet in the applied-filter map. */
  key: string;
  /** The chip's label, and the popover's title unless `title` is set. */
  label: string;
  /** Title drawn at the top of the popover. Defaults to `label`. */
  title?: string;
  /** Options, in the order they are drawn. */
  options: readonly FacetOption[];
  /**
   * Whether more than one option can be chosen. When true the popover is a list of checkboxes
   * whose footer reads "Matches any selected" beside a Clear link, and a change reports
   * through `onFacetValuesChange`. When false it is a list of radio rows and a change reports
   * through `onFacetChange`. Defaults to `true`.
   */
  multiple?: boolean;
  /** Footer text of a multiple choice popover. Defaults to `Matches any selected`. */
  matchLabel?: string;
  /** Whether the facet control is disabled. */
  disabled?: boolean;
};

/** The tone of the dot on a toggle facet. */
export type ToggleFacetTone = 'warning' | 'danger' | 'info' | 'success' | 'neutral';

/**
 * A facet that is either on or off, drawn as a chip with a dot and a count ("Missed runs 1").
 * Use it for a warning filter that sits beside the segments without being one of them, because
 * a row can be both in a segment and in the filter.
 */
export type ToggleFacet = {
  /** Discriminant that determines how the facet is rendered. */
  type: 'toggle';
  /** Unique key used to identify this facet in the applied-filter map. */
  key: string;
  /** The chip's label. */
  label: string;
  /** How many rows the filter would match, drawn after the label. Zero is shown. */
  count?: number;
  /** Tone of the dot before the label. Defaults to `warning`. */
  tone?: ToggleFacetTone;
  /** Whether the facet control is disabled. */
  disabled?: boolean;
};

/**
 * A facet rendered by a consumer-supplied snippet. Use for date-range pickers,
 * comboboxes, or any control that cannot be expressed as a select list.
 */
export type CustomFacet = {
  /** Discriminant that determines how the facet is rendered. */
  type: 'custom';
  /** Unique key used to identify this facet in the applied-filter map. */
  key: string;
  /** Accessible label for the facet, and its row in the narrow form's Filter menu. */
  label: string;
  /**
   * Consumer-supplied snippet that renders the full facet control. Receives
   * the bar-level `disabled` state — the snippet MUST apply it to its own
   * control(s), since FilterBar cannot reach inside consumer markup.
   */
  control: Snippet<[{ value: string; onValueChange: (value: string) => void; disabled: boolean }]>;
};

/** Union of all supported facet definition types. */
export type FacetDefinition = SelectFacet | ChoiceFacet | ToggleFacet | CustomFacet;

/** An applied filter entry: a facet key paired with its current value and display label. */
export type AppliedFilter = {
  /** The facet key this filter belongs to. */
  key: string;
  /** The current value of the filter. For a multiple choice facet it is the values joined by a comma. */
  value: string;
  /** The human-readable label of the facet. */
  label: string;
  /**
   * The chosen values of a multiple choice facet, which `value` cannot carry without a separator
   * an option's own value might contain. When present it wins over `value`.
   */
  values?: readonly string[];
};

/** One status segment in the bar's leading control, such as "Waiting on you 2". */
export type FilterSegment = {
  /** Value reported through `onSegmentChange` and matched against `segmentValue`. */
  value: string;
  /** The segment's label. */
  label: string;
  /** How many rows the segment would show. It is part of the accessible name; zero is shown. */
  count?: number | 'pending';
  /** Whether the segment can be chosen. */
  disabled?: boolean;
};

/**
 * How the bar is drawn. `wide` shows the segments, the facet chips and the search field in one
 * row. `medium` collapses the segments to a select and the search field to an icon button.
 * `narrow` shows only the select and a Filter menu that holds every facet and the search.
 */
export type FilterBarLayout = 'wide' | 'medium' | 'narrow';

/**
 * Props for the FilterBar component.
 *
 * A single-row filtering toolbar: status segments, facets drawn as selects or chips, and a search
 * field. It never wraps, and it collapses by width instead.
 */
export type FilterBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** Accessible label for the filter toolbar region. Required for screen readers. */
  'aria-label'?: string;
  /**
   * Status segments drawn first in the row ("All 19", "Waiting on you 2"). The first is the
   * default. Below the wide layout they collapse to one select reading "Status: All 19".
   */
  segments?: readonly FilterSegment[];
  /** The chosen segment's value. Defaults to the first segment. */
  segmentValue?: string;
  /** Accessible name of the segments and the prefix before the value in the collapsed select. Defaults to `Status`. */
  segmentsLabel?: string;
  /** Current text search query. When provided, the search field is controlled. */
  searchQuery?: string;
  /** Whether to render the search field. Defaults to `true`. */
  searchVisible?: boolean;
  /** Placeholder text shown in the search field. */
  searchPlaceholder?: string;
  /** Accessible label for the search input. Defaults to 'Search'. */
  searchAriaLabel?: string;
  /**
   * Which end of the row the search field sits at. A bar with segments or chips puts it at the
   * `end`; a bar of selects alone puts it at the `start`.
   */
  searchPosition?: 'start' | 'end';
  /**
   * Facet definitions rendered as filter controls. Each entry is a select, a choice, a toggle
   * or a custom snippet-driven facet.
   */
  facets?: readonly FacetDefinition[];
  /**
   * The facets that have a value. A select facet reads its value here, a choice facet draws a
   * tinted chip for its entry, and a toggle facet is on while it has an entry. Controlled by
   * the consumer; each entry is a key/value/label triple.
   */
  appliedFilters?: readonly AppliedFilter[];
  /**
   * Force a layout. By default the bar follows the viewport (phone under 640px, tablet under
   * 1024px) and narrows further when its own width cannot hold the wider form.
   */
  layout?: 'auto' | FilterBarLayout;
  /** When true, all filter controls and chips are disabled. */
  disabled?: boolean;
  /** Additional CSS classes applied to the root element. */
  class?: string;
  /** Fires when a segment is chosen. */
  onSegmentChange?: (value: string) => void;
  /** Fires when the search query changes. */
  onSearchChange?: (query: string) => void;
  /**
   * Fires when a select, single choice, toggle or custom facet changes, with the facet key and
   * the new value. A cleared facet reports an empty string.
   */
  onFacetChange?: (key: string, value: string) => void;
  /** Fires when a multiple choice facet changes, with the facet key and every chosen value. */
  onFacetValuesChange?: (key: string, values: readonly string[]) => void;
  /** Fires when an applied filter chip is removed. */
  onFilterRemove?: (key: string) => void;
};
