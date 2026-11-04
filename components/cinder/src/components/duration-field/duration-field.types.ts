import type { HTMLInputAttributes } from 'svelte/elements';

import type { DurationUnit } from './duration-units.ts';

/** Props for the DurationField component. */
export type DurationFieldProps = {
  /** Unique identifier for the number input. The unit select takes `${id}-unit`. */
  id: string;
  /** The duration in milliseconds, or `null` when the field is empty. Bindable. */
  value?: number | null | undefined;
  /** Called with the next duration in milliseconds, or `null` when the number is cleared or unparseable. */
  onValueChange?: ((next: number | null) => void) | undefined;
  /** Visible label. Omit inside a FormField or SettingRow, which supplies the label. */
  label?: string | undefined;
  /** Helper text announced with the field. */
  description?: string | undefined;
  /** Validation error; marks the field invalid. */
  error?: string | undefined;
  /** Marks the field required. */
  required?: boolean | undefined;
  /** Disables the number and the unit. */
  disabled?: boolean | undefined;
  /** Form field name for the number as typed (in the shown unit). */
  name?: string | undefined;
  /**
   * Rounds the stored milliseconds to whole numbers, for a schema of type `integer`.
   * @default false
   */
  integer?: boolean | undefined;
  /**
   * The units on offer, smallest first. The default is milliseconds, seconds, minutes and hours.
   */
  units?: readonly DurationUnit[] | undefined;
  /**
   * The unit the number is shown in, by its `value`. Starts as the largest unit that shows the
   * value as a whole number, and follows the person's choice. Bindable.
   */
  unit?: string | undefined;
  /**
   * Whether the person can change the unit. When `false` the unit is fixed text inside the field's
   * frame ("30 seconds"), as a setting that always counts in seconds draws it.
   * @default true
   */
  unitSelectable?: boolean | undefined;
  /** Called when the number loses focus. */
  onblur?: HTMLInputAttributes['onblur'] | undefined;
  /** Additional class merged with `.cinder-duration-field`. */
  class?: string | undefined;
};
