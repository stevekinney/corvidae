import type { Snippet } from 'svelte';
import type { HTMLSelectAttributes } from 'svelte/elements';

/**
 * One choice in a Select.
 *
 * Every field after `disabled` is drawn only by the `listbox` presentation, which has room for
 * it; the native presentation shows the label alone.
 */
export type SelectOption<T extends string = string> = {
  /** Submitted value. */
  value: T;
  /** Visible label (primary line). */
  label: string;
  /**
   * When true the option cannot be chosen. In the listbox it is still shown, and the keyboard
   * cursor can stand on it, so its reason (`description`) can be read.
   */
  disabled?: boolean;
  /**
   * Listbox only: muted words on the label's own line, after a middle dot ("Nightly archiver ·
   * no description"). Use it for a fact that belongs beside the name; a sentence goes in
   * `description`.
   */
  suffix?: string;
  /**
   * Listbox only: muted words drawn after the value in the trigger when this option is the
   * current one ("Claude Sonnet 5.5 · Anthropic"), while the option row keeps its plain label.
   * Use it when a group heading names what the trigger no longer has beside it.
   */
  triggerSuffix?: string;
  /** Listbox only: a muted sentence under the label ("Answers every message with the same scripted reply."). */
  description?: string;
  /** Listbox only: a muted line under the description ("Needs a provider"). */
  note?: string;
  /**
   * Listbox only: group name. Options that share a name render together under a heading.
   * Ungrouped options render first, without a heading, and groups follow in the order `groups`
   * lists them (then in order of first appearance for any `groups` does not list).
   */
  group?: string;
};

/**
 * Settings for one named group of a listbox Select. A group is created by `SelectOption.group`;
 * list it in `groups` to give it a heading that differs from its name, a divider, a message,
 * or a place in the order, or to show a heading that has no options at all.
 */
export type SelectGroup = {
  /** The name `SelectOption.group` refers to. */
  name: string;
  /** Heading text. Defaults to `name`. */
  heading?: string;
  /** Draw a divider above the group, as the design does above "Unavailable". */
  divided?: boolean;
  /**
   * Non-selectable text drawn under the heading ("Connect in Settings › Models to choose a GPT
   * model."). It is not an option: the cursor and typeahead skip it. A link inside it is a
   * keyboard stop of its own, reached with Tab from the trigger.
   */
  message?: Snippet;
};

/** Colour of the select's value: `accent` is for the one select that names what its surface is about to do. */
export type SelectTone = 'default' | 'accent';

/** Visual style of the select: bordered for forms and filter bars, ghost inside a bordered container. */
export type SelectVariant = 'default' | 'ghost';

/**
 * How the select is drawn. `native` is the platform `<select>`: right for forms, and the phone's
 * own picker. `listbox` is a button that opens a drawn listbox, which can show descriptions,
 * group headings with messages, a check on the current option and a footer.
 */
export type SelectPresentation = 'native' | 'listbox';

export type SelectProps<T extends string = string> = Omit<
  HTMLSelectAttributes,
  'class' | 'size'
> & {
  /** Unique identifier — required for label association and ARIA wiring. */
  id: string;
  /** Bound selected value. `undefined` when nothing is selected. */
  value?: NoInfer<T>;
  /** Options to render as `<option>` children. The sole inference source for T. */
  options: readonly SelectOption<T>[];
  /** Visible label rendered in a `<label>` associated via `for`. */
  label?: string;
  /**
   * Whether the label is visibly rendered. Set `false` to visually hide it
   * while keeping it available to assistive technology.
   * @default true
   */
  labelVisible?: boolean;
  /** Helper text rendered below the control; wired via `aria-describedby`. */
  description?: string;
  /** Validation error message; sets `aria-invalid="true"` and is wired via `aria-describedby`. */
  error?: string;
  /** Marks the control required and sets the native `required` attribute. */
  required?: boolean;
  /** Disables the control. */
  disabled?: boolean;
  /**
   * Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px,
   * `lg` 40px. Replaces the native list-box `size` attribute, which Cinder does not forward.
   * @default "md"
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Visual style. `ghost` has no border or fill at rest, a neutral tint on hover and while open,
   * the focus ring wrapping the whole control, and keeps its chevron: use it for a select inside
   * a bordered container (a composer, an inline toolbar) so the row of controls reads as one
   * surface. `default` is the bordered select for forms and filter bars.
   * @default "default"
   */
  variant?: SelectVariant;
  /**
   * Colour of the value. `accent` draws it in the accent colour and weight, for the one select that
   * names what the container it sits in is about to do (the agent a new chat is with), beside
   * `default` controls that only set options.
   * @default "default"
   */
  tone?: SelectTone;
  /**
   * Native `<select>` or a drawn listbox; see `SelectPresentation`. The listbox-only props below
   * (`placeholder`, `valuePrefix`, `leading`, `footer`, `groups`, and the rich option fields) do
   * nothing in the native presentation.
   * @default "native"
   */
  presentation?: SelectPresentation;
  /** Listbox only: text shown in the trigger while no option is selected, such as `Loading models`. */
  placeholder?: string;
  /**
   * Listbox only: muted text drawn before the value in the trigger ("Model" before "Claude Sonnet
   * 5.5"). It is decorative and hidden from assistive technology; the name comes from `label`.
   */
  valuePrefix?: string;
  /** Listbox only: a mark drawn before each option's label and before the selected value in the trigger, such as an avatar. Decorative. */
  leading?: Snippet<[SelectOption<T>]>;
  /** Listbox only: headings, dividers and messages for the option groups. */
  groups?: readonly SelectGroup[];
  /**
   * Listbox only: content drawn below the options, outside the `role="listbox"` element, so the
   * arrow keys never reach it. A link or button in it is a keyboard stop of its own, after the
   * last option, reached with Tab from the trigger.
   */
  footer?: Snippet;
  /**
   * The control shows its value and can be focused, but does not open and does not change.
   * Exposed as `aria-readonly` on the listbox presentation; the native presentation also blocks
   * the picker.
   */
  readonly?: boolean;
  /**
   * Marks a select that changes something. Inside a stale `<StaleRegion>` it goes inert: it can
   * be focused but not opened or changed, carries `aria-disabled`, and the region's reason
   * describes it. It returns by itself when the region stops being stale.
   * @default false
   */
  mutating?: boolean;
  /** Called with the new value when the person picks an option. */
  onValueChange?: (value: T) => void;
  /**
   * Intercepts the option the person picked before the bindable value is written. Return a
   * replacement value to use instead, including the current value to refuse the pick; return
   * nothing to accept it. The control shows what the hook returned, never the refused pick.
   */
  onValueChangeRequest?: (next: T) => T | void;
  /**
   * Listbox only: viewport width below which the options dock to the bottom edge as a sheet. A
   * simple CSS length such as `'640px'`, or `false` to always anchor.
   * @default "640px"
   */
  sheetBelow?: string | false;
  /** Extra class names merged with `.cinder-select-field`. */
  class?: string;
};
