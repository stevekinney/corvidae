import type { Snippet } from 'svelte';

/**
 * One option in a Combobox.
 */
export type ComboboxOption<T extends string = string> = {
  /** Submitted value. */
  value: T;
  /** Visible label (primary line). */
  label: string;
  /** Optional secondary description rendered beneath the label inside the option. */
  description?: string;
  /**
   * Colour of the `description` line. `danger` draws a reason that something is wrong ("Can't
   * load · order-refund.json line 12") in the danger text colour; the words still say it, so
   * colour is never the only signal. The default is muted text.
   * @default "default"
   */
  descriptionTone?: 'default' | 'danger';
  /**
   * Short raw identifier drawn small and monospaced beside the label (an event kind such as
   * `run.error`). It is also drawn beside the label in the closed field once the option is chosen.
   */
  code?: string;
  /**
   * Muted words on the label's own line, after a middle dot ("Chat with an agent · built in"). Use
   * it for a fact that belongs beside the name; a sentence goes in `description`, and a short
   * trailing value in `meta`.
   */
  suffix?: string;
  /**
   * Short text drawn at the trailing edge of the row, on the label's line ("4 steps", "any
   * workflow"). A consumer that needs more than text passes the `optionMeta` snippet, which
   * replaces this.
   */
  meta?: string;
  /**
   * Optional avatar image URL rendered to the left of the label.
   * The avatar is decorative — its alt text is empty because the
   * option's accessible name already includes the label.
   */
  avatar?: string;
  /** When true, the option is non-selectable. */
  disabled?: boolean;
  /**
   * Optional group name. Options that share a name render together under a
   * heading that shows the name and how many of the group's options are
   * listed. Ungrouped options render first, without a heading, and
   * groups follow in order of first appearance. A blank name counts as ungrouped.
   */
  group?: string;
};

/**
 * How the Combobox is drawn. `input` is a text field: the person types into the closed field
 * itself and the options open below it. `picker` is a button that shows the chosen option (and
 * its description) and opens a panel with its own search field above the options, for lists
 * whose rows need room to be read.
 */
export type ComboboxPresentation = 'input' | 'picker';

/** What a Combobox tells its `footer` snippet about the list it sits under. */
export type ComboboxFooterContext = {
  /** The text the person has typed to narrow the list; empty when they have not. */
  query: string;
  /** How many options match `query`, before the `maxVisibleOptions` cap. */
  matchCount: number;
  /** How many options there are in all. */
  totalCount: number;
};

/**
 * The message a Combobox draws when the option list failed to load. The options that did load
 * stay listed and selectable beneath it.
 */
export type ComboboxLoadError = {
  /** What failed, in plain words ("Couldn’t load workflows."). */
  title: string;
  /** Why, and what still works ("Interborough didn’t answer. Chat with an agent is built in and still works."). */
  description?: string;
  /**
   * Label of the retry button, which calls `onRetry`.
   * @default "Try again"
   */
  retryLabel?: string;
};

/**
 * Props for the Combobox component.
 *
 * v1 scope (deliberately small):
 * - Single-select only.
 * - Synchronous local filtering — consumer supplies a `filter` callback,
 *   or the default substring-on-label match runs.
 * - No async / remote loading; no debounced fetch. A consumer that loads its options draws the
 *   wait with `loading`, a failure with `loadError`, and passes the options it has.
 * - No virtualization. Visible options are capped at 200; consumers with
 *   larger lists must paginate or pre-filter externally.
 * - No multi-select or token chips; custom-value submission is opt-in.
 *
 * Custom-value submission is opt-in through `customValueAllowed`; the default
 * remains a constrained single-select.
 */
export type ComboboxProps<T extends string = string, AllowCustom extends boolean = false> = {
  /** Unique identifier — required for label association and ARIA wiring. */
  id: string;
  /** Currently selected value. Bindable. `''` when nothing is selected. */
  value?: AllowCustom extends true ? string : NoInfer<T> | '';
  /** Called when an option, or an arbitrary value when enabled, is committed. */
  onValueChange?: (value: AllowCustom extends true ? string : T) => void;
  /** Native form field name. Renders a hidden input carrying the selected value. */
  name?: string | undefined;
  /** Free-text input value (the text the user has typed). Bindable. */
  textInputValue?: string;
  /** Full set of options to filter. The sole inference source for T. */
  options: readonly ComboboxOption<T>[];
  /** Visible label rendered in a `<label>` associated via `for`. */
  label?: string;
  /** Accessible name for the input when no visible label is rendered. */
  'aria-label'?: string;
  /** Placeholder when no value is selected. */
  placeholder?: string;
  /**
   * Custom synchronous filter. Receives an option and the current input
   * value; returns true to keep. Defaults to case-insensitive substring
   * match on label.
   */
  filter?: (option: ComboboxOption<T>, query: string) => boolean;
  /** Helper text displayed below the input; wired via aria-describedby. */
  description?: string;
  /** Validation error message; sets aria-invalid="true". */
  error?: string;
  /** Disables the combobox. Inherited from a wrapping FormField when unset. */
  disabled?: boolean;
  /**
   * Marks the field required: renders the required marker on the label and
   * sets `aria-required` on the input. Inherited from a wrapping FormField
   * when unset.
   */
  required?: boolean;
  /** Hard cap on visible filtered options. Default 200. */
  maxVisibleOptions?: number;
  /** Allow committing typed text that is not present in `options`. */
  customValueAllowed?: AllowCustom;
  /**
   * External element id(s) to compose into `aria-describedby`. Composed
   * after the component-generated description and error ids, matching the
   * field-control contract in Select. Useful for tooltip ids, counter ids,
   * or any external hint.
   */
  'aria-describedby'?: string;
  /**
   * Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px,
   * `lg` 40px, the same heights as a Button of that size.
   * @default "md"
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Viewport width below which the options panel docks to the bottom edge as
   * a sheet (Popover's `sheetBelow`, with focus kept in the input), instead of
   * anchoring to the input. A simple CSS length such as `'640px'`, or `false`
   * to always anchor. Default `'640px'`.
   */
  sheetBelow?: string | false;
  /**
   * `input` types into the closed field; `picker` is a button that opens a panel with its own
   * search field. See `ComboboxPresentation`. `customValueAllowed` has no effect on a picker,
   * which has no text of its own to commit.
   * @default "input"
   */
  presentation?: ComboboxPresentation;
  /**
   * Picker only: placeholder, and accessible name, of the search field in the open panel
   * ("Search workflows").
   * @default "Search"
   */
  searchPlaceholder?: string;
  /**
   * Draw the loading state: the field keeps its label, required marker and chevron, shows
   * `loadingLabel` where the value goes, and does not open.
   * @default false
   */
  loading?: boolean;
  /**
   * Text shown in the field while `loading` ("Loading workflows…").
   * @default "Loading…"
   */
  loadingLabel?: string;
  /**
   * While `loading`, milliseconds after which Skeleton's own "Still loading" status appears under
   * the field. Use `10000` for the Cinder loading rule. Omit to never show it.
   */
  stillLoadingAfter?: number;
  /** While `loading`, called when Cancel in the "Still loading" status is pressed. The button renders only when this is set. */
  onCancel?: () => void;
  /** The option list failed to load; see `ComboboxLoadError`. The panel shows it above the options. */
  loadError?: ComboboxLoadError;
  /** Called when the retry button in `loadError` is pressed. The button renders only when this is set. */
  onRetry?: () => void;
  /**
   * The text of the empty panel when nothing matches, or a function of what was typed.
   * @default "No results"
   */
  noMatchLabel?: string | ((query: string) => string);
  /**
   * Content drawn below the options, outside the `role="listbox"` element, so the arrow keys
   * never reach it, and it stays visible while the options scroll and when none match. A link or button in it is a keyboard stop of its own, after the last
   * option, reached with Tab from the field.
   */
  footer?: Snippet<[ComboboxFooterContext]>;
  /**
   * Content drawn at the trailing edge of each row, replacing the option's `meta` text. It sits
   * inside the option, so it is part of the option's accessible name.
   */
  optionMeta?: Snippet<[ComboboxOption<T>]>;
  /**
   * Whether a group heading shows how many of the group's options are listed.
   * @default true
   */
  groupCountVisible?: boolean;
  /**
   * Picker only: show "N of M" beside the search field while something is typed in it.
   * @default false
   */
  matchCountVisible?: boolean;
  /**
   * Where the check on the chosen option sits: after the text (`end`) or before it (`start`).
   * @default "end"
   */
  selectedIndicator?: 'start' | 'end';
  /** Additional class names merged with `.cinder-combobox`. */
  class?: string;
};
