/**
 * Props for the Toggle component.
 *
 * Uses the WAI-ARIA switch pattern (`role="switch"` + `aria-checked`) — the
 * visible UI is a sliding-thumb pill, so the accessible role must match what
 * sighted users see. Use Toggle for "this thing is on / off" affordances
 * (notifications enabled, dark mode, etc.). For a toggle button that
 * changes the state of something else without representing a binary
 * on/off (e.g. bold formatting), use Button with `aria-pressed`.
 *
 * The component renders its own label next to the switch, so consumers do not
 * hand-roll an external one. `label` is always the accessible name (wired via
 * `aria-labelledby`); `labelVisible` changes only the visual presentation and
 * never removes the accessible name.
 */
export type ToggleProps = {
  /** Native id placed on the `<button>`; the rendered label uses `aria-labelledby` to name it (label id is derived as `${id}-label`). */
  id: string;
  /** Whether the toggle is currently checked. Bindable — defaults to false. */
  checked?: boolean;
  /** Intercept a proposed checked state before the bindable value is written. Return a replacement value to transform it. */
  onValueChangeRequest?: (next: boolean) => boolean | void;
  /** Notify after the bindable value has been committed. */
  onValueChange?: (next: boolean) => void;
  /** Visible label text. Always the accessible name, even when `labelVisible` is set. Required. */
  label: string;
  /** Prevents interaction when true. Sets `disabled` attribute. */
  disabled?: boolean;
  /**
   * Shows the setting without letting a press change it, for a value that something else owns,
   * such as a schedule defined in a file. The switch stays focusable, announces
   * `aria-readonly="true"`, ignores a press on the track or the label, and still submits its value
   * with a native form (unlike `disabled`).
   * @default false
   */
  readonly?: boolean;
  /**
   * Short visible text beside the label that describes the switch, such as the file that defines
   * it ("Defined in workflows/release-notes.json"). It is wired into `aria-describedby`.
   */
  description?: string;
  /**
   * Whether `description` is drawn. Set `false` for a description that only a screen reader needs,
   * such as the consequence of flipping a switch whose reason the page already says in words: it
   * stays wired into `aria-describedby` and is visually hidden.
   * @default true
   */
  descriptionVisible?: boolean;
  /**
   * Where `description` sits. `inline` is on the label's line, for a few words ("Defined in
   * workflows/release-notes.json"). `below` stacks it under the label, with the switch beside both,
   * for a sentence that explains what the switch does.
   * @default "inline"
   */
  descriptionPlacement?: 'inline' | 'below';
  /**
   * Marks a switch that changes something. Inside a stale `<StaleRegion>` it goes inert:
   * `aria-disabled`, still focusable, ignoring the press, and described by the region's reason.
   * It returns by itself when the region stops being stale.
   * @default false
   */
  mutating?: boolean;
  /**
   * Words that follow the visible label in the accessible name only, such as the thing the switch
   * belongs to ("Daily summary schedule" makes the name "Active, Daily summary schedule"). The
   * visible label stays first, so the name keeps WCAG 2.5.3 (Label in Name). The name is then the
   * switch's `aria-label`, written as one string so every platform reads it alike.
   */
  nameDetail?: string;
  /**
   * Whether the label is visibly rendered. Set `false` for icon-only or
   * inline contexts — it stays the accessible name.
   * @default true
   */
  labelVisible?: boolean;
  /**
   * Form field name. When set, a hidden checkbox mirrors `checked` so the toggle
   * participates in native form submission. Omit for purely client-side toggles
   * (no hidden input is rendered, so there is zero overhead).
   */
  name?: string;
  /**
   * Value submitted for the hidden checkbox when `checked` and `name` is set.
   * Mirrors native checkbox semantics: the pair `name=value` is sent only while
   * checked. Defaults to `'on'`. Ignored when `name` is unset.
   */
  value?: string;
  /**
   * Associates the hidden checkbox with a form by id, matching the native
   * `form` attribute. Lets the toggle submit with a form it is not nested in.
   * Ignored when `name` is unset.
   */
  form?: string;
  /** Additional class names merged with `.cinder-toggle` on the switch button. */
  class?: string;
};
