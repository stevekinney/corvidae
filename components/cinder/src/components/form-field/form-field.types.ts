import type { Snippet } from 'svelte';
/** @schemaObject */
export type FormFieldManaged = {
  /** Policy or administrator that owns the value. */
  by?: string | undefined;
  /** Human-readable explanation for the constraint. */
  reason?: string | undefined;
  /** The whole line to show beside the lock glyph, replacing the "Managed by" wording, such as "Locked by your deployment (remote mode). Change it in the deployment's configuration." */
  message?: string | undefined;
};

export type FormFieldProps = {
  /** Required stable id — used for `<label for>`, description, error, and the child control's id via context. */
  id: string;
  /** Visible label text. Omit only when the child control supplies its own accessible name, such as via aria-label or aria-labelledby. */
  label?: string | undefined;
  /**
   * Whether the label is visibly rendered. Set `false` to visually hide it
   * while keeping it associated with the control.
   * @default true
   */
  labelVisible?: boolean | undefined;
  /** Helper text rendered below the control; wired into `aria-describedby`. */
  description?: string | undefined;
  /** Advisory for a legal but potentially risky value; does not mark the control invalid. */
  warning?: string | undefined;
  /** Validation error; sets `aria-invalid="true"` on opted-in controls via context. */
  error?: string | undefined;
  /**
   * The glyph drawn before the error message: `warning` (a triangle, the default) for a value the
   * person can fix, or `error` (a circle) for a conflict such as a URL that is already connected.
   * @default "warning"
   */
  errorGlyph?: 'warning' | 'error' | undefined;
  /** Rendered after the error message inside the same live region, such as a link to the record that conflicts ("Open GitHub") or a quiet Retry. */
  errorAction?: Snippet | undefined;
  /** Neutral explanation drawn under the helper text and wired into `aria-describedby`, such as why a field is cleared. Not an error and not a warning. */
  note?: string | undefined;
  /** Rendered beside the control on the same row, such as a Try again button after a failed test. The control takes the room the trailing content leaves. */
  trailing?: Snippet | undefined;
  /** Policy ownership metadata displayed without disabling the control. */
  managed?: FormFieldManaged | undefined;
  /** Renders a visual required marker and exposes `required: true` on the context. */
  required?: boolean | undefined;
  /** Propagated to opted-in controls via context. Does not style FormField itself. */
  disabled?: boolean | undefined;
  /** Additional class merged with `.cinder-form-field`. */
  class?: string;
  /** Control(s) rendered inside the field. */
  children: Snippet;
};
