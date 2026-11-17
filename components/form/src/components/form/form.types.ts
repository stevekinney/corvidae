import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';

export type FormSubmitContext = { submitting: boolean };
export interface FormSchemaProps {
  /** Additional class merged with `.cinder-form`. */
  class?: string;
  /**
   * Holds the form to a single reading column, up to 720px (45rem), instead of the full width of
   * its container. Set `--cinder-form-reading-column-width` to change the width.
   * @default false
   */
  readingColumn?: boolean;
  /**
   * After `onSubmit` settles, moves focus to the first field that reports a problem
   * (`aria-invalid="true"`), so a Save that stays enabled while the form is invalid tells the
   * person where to look. Set `false` when the page manages focus itself.
   * @default true
   */
  focusProblemOnSubmit?: boolean;
}
export type FormProps = Omit<HTMLFormAttributes, 'onsubmit' | 'children'> & {
  /** May return a promise; while pending, the child snippet receives `{ submitting: true }` and duplicate submits are ignored until it settles. */
  onSubmit?: (event: SubmitEvent) => void | Promise<void>;
  /** Form controls. Receives `{ submitting }` so descendants can disable themselves while `onSubmit` is pending. */
  children?: Snippet<[FormSubmitContext]>;
  class?: string;
  /** Holds the form to a single reading column, up to 720px (45rem). @default false */
  readingColumn?: boolean;
  /** After `onSubmit` settles, moves focus to the first field that reports a problem. @default true */
  focusProblemOnSubmit?: boolean;
};
