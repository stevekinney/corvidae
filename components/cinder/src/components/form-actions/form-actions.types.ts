import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the FormActions component. */
export type FormActionsProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'role'
> & {
  /**
   * Accessible name of the bar, read as the name of its group.
   * @default "Form actions"
   */
  label?: string | undefined;
  /**
   * How many changes the form holds that are not saved. Above zero the bar's left side reads
   * "1 unsaved change" or "N unsaved changes" in neutral text; at zero it says nothing.
   */
  unsavedChanges?: number | undefined;
  /**
   * Keeps the bar at the bottom of the nearest scrolling container, so Save is in reach however
   * long the form gets. It clears the home indicator and rides above the on-screen keyboard.
   * @default false
   */
  sticky?: boolean | undefined;
  /**
   * What a failed save says, in a danger alert above the buttons: "Couldn't save. Interborough
   * didn't answer. Your choices are still here." The first sentence is drawn as the title when
   * `errorTitle` is not set. The buttons keep their labels, so Save is the retry.
   */
  error?: string | undefined;
  /** Bold lead-in for `error`, such as "Couldn't save." */
  errorTitle?: string | undefined;
  /** The left side of the bar: a status line such as "Not saved yet", or the effect of saving ("Saving raises the policy revision."). Follows the unsaved-change count when there is one. */
  summary?: Snippet | undefined;
  /** Controls kept at the start of the bar, after the summary and before the buttons, such as a Delete outside the main pair. */
  start?: Snippet | undefined;
  /** The buttons at the end of the bar, secondary first and the primary submit last, so it sits rightmost: Cancel, then Save. */
  end: Snippet;
  /** Additional class merged with `.cinder-form-actions`. */
  class?: string | undefined;
};
