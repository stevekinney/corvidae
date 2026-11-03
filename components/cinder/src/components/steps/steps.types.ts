import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

export type StepsOrientation = 'horizontal' | 'vertical';

/**
 * What kind of list the steps render as:
 *
 * - `'stepper'`: the ordered wizard indicator, a navigation landmark with markers and connectors.
 *   Which step is current comes from `currentStep`.
 * - `'checklist'`: a bordered card of rows, each with a marker, a label, a description and an
 *   `action`, under an optional `heading` and a "N of M done" counter. Steps complete in any
 *   order: a step is done when its `done` is set, and the current step is the first one that
 *   isn't.
 * - `'status'`: a borderless list of progress by step, such as a restart's "Saved your choice,
 *   Stopped the server, Starting Interborough". Each row shows a check, a spinner or a hollow
 *   circle, and the list is a status live region so a change is announced.
 */
export type StepsVariant = 'stepper' | 'checklist' | 'status';

export type StepItemState = 'complete' | 'current' | 'upcoming' | 'skipped';
export type StepItem = {
  /** Stable identifier used as the keyed-each key. Must be unique. */
  id: string;
  /**
   * Visible label for the step. Accepts plain text or a snippet. Snippet
   * content is rendered inside a `<span>` that may itself sit inside the
   * step's generated `<a>`/`<button>` — emit phrasing content only (text,
   * inline formatting, icons), never block or interactive elements.
   */
  label: string | Snippet;
  /**
   * Optional secondary text shown beneath the label. Accepts plain text or a
   * snippet, with the same phrasing-only, non-interactive constraint as
   * `label` — the content can end up inside the step's own control.
   */
  description?: string | Snippet;
  /**
   * Optional state override for this step. When omitted, state is derived from
   * `currentStep`. Use `skipped` for a past step that was advanced past without
   * completing.
   */
  state?: 'skipped';
  /**
   * Marks the step finished in the `'checklist'` and `'status'` variants, where steps complete
   * in any order instead of following `currentStep`. The current step is the first step that
   * isn't done. Ignored by the `'stepper'` variant.
   */
  done?: boolean;
  /**
   * Content rendered at the row's end in the `'checklist'` variant, usually a button or two. It
   * receives the step's state, so the page can give the current step the primary button and the
   * rest a secondary one. A done step normally passes none. Ignored by the other variants.
   */
  action?: Snippet<[state: StepItemState]> | undefined;
  /**
   * When set, the step body renders as a link (`<a>`) to this href. The marker
   * and connector stay decorative; only the body (label + description) is the
   * interactive target.
   */
  href?: string;
  /**
   * When set, the step body renders as a button invoking this callback. When
   * combined with `href`, the body renders as a link that also runs the
   * callback on click (the consumer decides whether to `preventDefault`).
   */
  onclick?: (event: MouseEvent) => void;
};
export type StepsProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
  /** Ordered list of step entries from first to last. */
  steps: StepItem[];
  /**
   * Zero-based index of the active step in the `'stepper'` variant. Steps with index <
   * currentStep are "completed". Pass `steps.length` to mark every step as complete (terminal
   * "done" state). The `'checklist'` and `'status'` variants ignore it and read each step's
   * `done` instead.
   * @default 0
   */
  currentStep?: number;
  /**
   * Which list the steps render as: `'stepper'` is the ordered wizard indicator, `'checklist'` is
   * a card of rows that each carry an action, and `'status'` is a list of progress by step.
   * @default "stepper"
   */
  variant?: StepsVariant;
  /**
   * Layout direction of the `'stepper'` variant. The `'checklist'` and `'status'` variants are
   * always vertical. Defaults to 'horizontal'. @default "horizontal"
   */
  orientation?: StepsOrientation;
  /**
   * Title of the `'checklist'` card, such as "Get started". It sits at the start of the card's
   * header row, with the counter at the end, and names the section.
   */
  heading?: string;
  /**
   * Heading level for `heading`.
   * @default 3
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Text of the counter at the end of the `'checklist'` header, from how many steps are done and
   * how many there are. Defaults to "N of M done".
   */
  progressLabel?: (done: number, total: number) => string;
  /**
   * Visually-hidden text announced for the step in progress in the `'status'` variant.
   * @default "In progress"
   */
  currentLabel?: string;
  /**
   * Visually-hidden text announced for a step that hasn't started in the `'status'` variant.
   * @default "Pending"
   */
  pendingLabel?: string;
  /**
   * Accessible name for the wrapper: the nav landmark of the `'stepper'`, the status region of
   * the `'status'` variant, and the section of a `'checklist'` that has no `heading`. Defaults to
   * 'Progress'.
   * @default "Progress"
   */
  label?: string;
  /**
   * Visually-hidden text prepended to completed steps so screen readers
   * announce state + label. Defaults to 'Completed'.
   * @default "Completed"
   */
  completedLabel?: string;
  /**
   * Visually-hidden text prepended to skipped steps so screen readers announce
   * state + label. Defaults to 'Skipped'.
   * @default "Skipped"
   */
  skippedLabel?: string;
  /** Additional class names merged with `.cinder-steps`. */
  class?: string;
};
