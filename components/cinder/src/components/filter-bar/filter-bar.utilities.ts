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

/**
 * One form the bar can draw: a layout and, in the `medium` layout, how many of its unapplied chips
 * have moved into a Filter menu because the row could not hold them. Applied chips never fold, so
 * a filter that is on stays visible and removable until the bar folds to `narrow`.
 */
export type FilterBarForm = {
  readonly layout: FilterBarLayout;
  /** How many of the foldable chips (`foldableFacetKeys`) are in the Filter menu, first first. */
  readonly folded: number;
};

/** The form a layout is drawn in before any chip has folded. */
export function layoutForm(layout: FilterBarLayout): FilterBarForm {
  return { layout, folded: 0 };
}

/**
 * Where a form stands among a bar's forms, widest first: wide, search-folded, medium with none to
 * all `foldable` chips folded, then narrow. The search folds to an icon button before the segments
 * fold to a select, and the unapplied chips fold one at a time before the bar folds to narrow. A
 * fold count past `foldable` (the bar's contents changed since) counts as every foldable chip.
 */
function formIndex(form: FilterBarForm, foldable: number): number {
  switch (form.layout) {
    case 'wide': {
      return 0;
    }
    case 'search-folded': {
      return 1;
    }
    case 'medium': {
      return 2 + Math.min(Math.max(form.folded, 0), foldable);
    }
    case 'narrow': {
      return 3 + foldable;
    }
  }
}

/** The form at `index` for a bar with `foldable` foldable chips, clamped to the forms there are. */
function formAt(index: number, foldable: number): FilterBarForm {
  if (index <= 0) return layoutForm('wide');
  if (index === 1) return layoutForm('search-folded');
  if (index >= 3 + foldable) return layoutForm('narrow');
  return { layout: 'medium', folded: index - 2 };
}

/** A form with its fold count clamped to the chips that can fold now. */
export function normalizeForm(form: FilterBarForm, foldable: number): FilterBarForm {
  return formAt(formIndex(form, foldable), foldable);
}

/** A key that names a form, for remembering what it was measured to need. */
export function formKey(form: FilterBarForm): string {
  return `${form.layout}:${String(form.folded)}`;
}

/** The next wider form than `form`, which is `form` itself when it is the widest. */
export function widerForm(form: FilterBarForm, foldable: number): FilterBarForm {
  return formAt(formIndex(form, foldable) - 1, foldable);
}

/** The narrower of two forms. */
export function narrowerForm(
  first: FilterBarForm,
  second: FilterBarForm,
  foldable: number,
): FilterBarForm {
  return normalizeForm(
    formIndex(first, foldable) >= formIndex(second, foldable) ? first : second,
    foldable,
  );
}

/** The layout the viewport asks for: narrow on a phone, medium on a tablet, wide otherwise. */
export function viewportLayout(phone: boolean, tablet: boolean): FilterBarLayout {
  if (phone) return 'narrow';
  return tablet ? 'medium' : 'wide';
}

/**
 * The keys of the chips that may fold into the Filter menu, in the order they fold: the choice and
 * toggle facets that have no applied filter. Those `foldOrder` names fold first, in its order (list
 * the least used first); the rest follow from the end of the facet list.
 */
export function foldableFacetKeys(
  facets: readonly FacetDefinition[],
  appliedKeys: ReadonlySet<string>,
  foldOrder: readonly string[] = [],
): string[] {
  const foldable = facets
    .filter(
      (facet) =>
        (facet.type === 'choice' || facet.type === 'toggle') && !appliedKeys.has(facet.key),
    )
    .map((facet) => facet.key);
  const named = foldOrder.filter(
    (key, index) => foldable.includes(key) && foldOrder.indexOf(key) === index,
  );
  return [...named, ...foldable.filter((key) => !named.includes(key)).toReversed()];
}

/** What decides the form. */
export type ResolveFormInput = {
  /** Whether the bar has anything to fold (`isCollapsible`). */
  collapsible: boolean;
  /** A layout the consumer forced. */
  forced: 'auto' | FilterBarLayout;
  /** The layout the viewport asks for (`viewportLayout`). */
  viewport: FilterBarLayout;
  /** The widest form the bar's measured row fits, `wide` until the row has been measured. */
  fitted: FilterBarForm;
  /** How many chips can fold into the Filter menu (`foldableFacetKeys`). */
  foldable: number;
};

/**
 * The form the bar is drawn in: the narrower of what the viewport asks for and what the bar's own
 * row was measured to hold, so a bar beside a wide sidebar never overflows and never wraps. A
 * forced layout wins and folds no chip, and a bar that cannot collapse is always `wide`.
 */
export function resolveFilterBarForm(input: ResolveFormInput): FilterBarForm {
  if (input.forced !== 'auto') return layoutForm(input.forced);
  if (!input.collapsible) return layoutForm('wide');
  return narrowerForm(layoutForm(input.viewport), input.fitted, input.foldable);
}

/**
 * How far, in pixels, a row may run past its box and still count as fitting: `scrollWidth` is
 * rounded to a whole pixel and a flex basis need not be.
 */
const FIT_TOLERANCE = 0.5;

/** One measurement of the drawn row, and what is known about the next wider form. */
export type FilterBarFitInput = {
  /** The form drawn when the row was measured. */
  drawn: FilterBarForm;
  /** The layout the viewport asks for, which the bar never draws wider than. */
  viewport: FilterBarLayout;
  /** How many chips can fold into the Filter menu (`foldableFacetKeys`). */
  foldable: number;
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
  /** The widest form the bar now fits, or `undefined` to keep the one it has. */
  fitted: FilterBarForm | undefined;
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
  const drawn = formIndex(input.drawn, input.foldable);
  if (input.need - input.available > FIT_TOLERANCE) {
    return {
      fitted: input.drawn.layout === 'narrow' ? undefined : formAt(drawn + 1, input.foldable),
      waiting: false,
    };
  }
  if (drawn <= formIndex(layoutForm(input.viewport), input.foldable)) {
    return { fitted: undefined, waiting: false };
  }
  const wider = formAt(drawn - 1, input.foldable);
  if (input.widerNeed !== undefined) {
    const fits = input.widerNeed - input.available <= FIT_TOLERANCE;
    return { fitted: fits ? wider : undefined, waiting: false };
  }
  return input.mayProbe ? { fitted: wider, waiting: false } : { fitted: undefined, waiting: true };
}

/** The row's flex items, looking through `display: contents` wrappers (a popover's trigger). */
function rowItems(parent: Element): HTMLElement[] {
  const items: HTMLElement[] = [];
  for (const child of parent.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    if (style.display === 'contents') items.push(...rowItems(child));
    else if (style.display !== 'none' && style.position !== 'absolute') items.push(child);
  }
  return items;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The inline size, in pixels, the drawn row's controls need: from the row's padding edge to the
 * far margin edge of its last control, plus the row's end padding. It is read from the controls'
 * own boxes, never from `scrollWidth`, which also counts what a control draws past its box without
 * taking room, such as the 44px hit area of the search field's clear button: that made a bar with
 * a typed query fold the next time it measured (agent Chats tab). The search field is the one
 * control that gives way (it shrinks toward nothing before the row overflows), so it is counted at
 * no less than its flex basis: a search squeezed below that is a row that does not fit.
 */
export function measureFilterBarRow(row: HTMLElement): number {
  const style = getComputedStyle(row);
  const box = row.getBoundingClientRect();
  const rtl = style.direction === 'rtl';
  const start = rtl
    ? box.right - pixels(style.borderRightWidth)
    : box.left + pixels(style.borderLeftWidth);
  let extent = 0;
  for (const item of rowItems(row)) {
    const itemBox = item.getBoundingClientRect();
    const itemStyle = getComputedStyle(item);
    const end = rtl
      ? start - (itemBox.left - pixels(itemStyle.marginLeft))
      : itemBox.right + pixels(itemStyle.marginRight) - start;
    extent = Math.max(extent, end);
  }
  let need = extent + pixels(rtl ? style.paddingLeft : style.paddingRight);
  const search = row.querySelector<HTMLElement>(':scope > .cinder-filter-bar__search');
  if (search !== null) {
    const basis = Number.parseFloat(getComputedStyle(search).flexBasis);
    if (Number.isFinite(basis)) need += Math.max(0, basis - search.getBoundingClientRect().width);
  }
  return need;
}
