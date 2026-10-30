import type { HTMLSelectAttributes } from 'svelte/elements';

export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

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
  /** Extra class names merged with `.cinder-select-field`. */
  class?: string;
};
