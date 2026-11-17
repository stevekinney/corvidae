import type { Snippet } from 'svelte';

import type { DialogCancelProps } from '../../utilities/dialog-props.ts';

/**
 * A thin opinionated preset over `<Modal>` for destructive-action confirmations.
 *
 * Composes `<Modal>` + two `<Button>`s. Does not open its own `<dialog>` or manage
 * its own focus trap — all of that is owned by `<Modal>`.
 *
 * Default focus lands on the **cancel** button (`autofocus`) — the industry-standard
 * guard against accidental destructive confirms.
 *
 * For richer body content (markup, lists, multi-paragraph text), compose `<Modal>` +
 * `<Button>` directly. `aria-describedby` works best with short, plain-text descriptions.
 */
/**
 * Cancel semantics (shared vocabulary from {@link DialogCancelProps}): the
 * cancel button ALWAYS renders, defaulting its label to "Cancel". `onCancel`
 * fires on every dismissal affordance — cancel button, Escape, backdrop
 * click, or the close-X — but NOT on parent-driven `open = false`; callbacks
 * are not awaited and thrown callbacks do not block close.
 */
export type ConfirmDialogProps = Omit<DialogCancelProps, 'cancelLabel'> & {
  /**
   * Label for the cancel button, which ALWAYS renders.
   * @default 'Cancel'
   */
  cancelLabel?: string;
  /** Controls visibility. Bindable. */
  open: boolean;
  /** Modal title; passed through to <Modal>. */
  title: string;
  /**
   * Optional body description — a short sentence or two. Rendered as a single <p> and wired
   * to aria-describedby. A string is plain text; a snippet may add phrasing content inside the
   * sentence, such as a key in `<code>`. Anything bigger than a sentence (a list, a code block, a
   * checkbox) goes in `options`, below it. Screen readers announce aria-describedby targets as one
   * continuous run, so keep the description short either way.
   */
  description?: string | Snippet;
  /**
   * Content rendered below the description and above the typed confirmation: a checkbox that
   * changes what the confirmation does, or the exact command about to run in a code block. The
   * description says what the dialog does; the options say what each choice does. Keep the
   * description short, and keep controls here labelled.
   */
  options?: Snippet;
  /**
   * Confirm button label. Required — no default. Name the action being confirmed:
   * - Destructive: "Delete", "Discard changes", "Remove from organization".
   * - Non-destructive: "Save", "Continue", "Publish".
   * Never use "OK" or "Confirm" in production — they don't describe the action.
   */
  confirmLabel: string;
  /**
   * Glyph at the start of the confirm button, such as a restart, stop or trash icon. Decorative:
   * the label names the action.
   */
  confirmIcon?: Snippet;
  /**
   * When true, the confirm button uses variant="danger". The cancel button still
   * receives default focus regardless — color is never the sole destructive signal.
   */
  destructive?: boolean;
  /**
   * When set, renders a labelled text input and disables the confirm button until the
   * trimmed input matches this value case-insensitively.
   */
  typeToConfirm?: string;
  /** Visible label for the typed-confirmation input. Defaults to `Type "<value>" to confirm`. */
  typeToConfirmLabel?: string;
  /**
   * True while the confirmed work is in flight. The confirm button shows `busyLabel` and a spinner
   * and ignores presses (it stays focusable), Cancel is inert, the typed field is read-only, and
   * the dialog cannot be dismissed (Escape, the backdrop and the close button do nothing) until
   * the work answers. Pair it with `closeOnConfirm={false}`, so the dialog stays open to show the
   * answer.
   * @default false
   */
  busy?: boolean;
  /**
   * Confirm button label while `busy`, such as "Restoring…" or "Deleting…". Defaults to
   * `confirmLabel`, so the words stay put and only the spinner shows.
   */
  busyLabel?: string | undefined;
  /**
   * Bold lead sentence of the failure, such as "Couldn’t delete the agent.", set before `error`.
   * Shown only with `error`.
   */
  errorTitle?: string | undefined;
  /**
   * Why the confirmed work failed, in a danger callout between the body and the actions that is
   * announced as it appears: "Nothing was deleted." The dialog stays open, the typed text stays,
   * and the confirm button stays armed under its own label, so pressing it again is the retry.
   * Clear it to hide the callout.
   */
  error?: string | undefined;
  /**
   * Whether the dialog closes itself when the confirm button is pressed. Set `false` when the
   * confirmed work can fail and the page needs the dialog to stay open to show it: the page then
   * closes the dialog with `open = false` once the work succeeds.
   * @default true
   */
  closeOnConfirm?: boolean;
  /**
   * Fired when the user activates the confirm button. Required. The component closes itself
   * after, unless `closeOnConfirm` is `false`.
   */
  onConfirm: () => void;
  /**
   * Viewport width below which the dialog is a bottom sheet: a grabber, a compact Cancel beside
   * the confirmation, which fills the rest of the row (above Cancel when the two do not fit), both
   * drawn at the button's painted height and reaching 44px through its hit area, with Cancel
   * keeping initial focus. A CSS length such as `"640px"`, or `false` for the centred dialog at
   * every width.
   * @default "640px"
   */
  sheetBelow?: string | false;
  /** Fired once the underlying modal's exit transition has completed. */
  onExitComplete?: () => void;
  /** Forwarded to <Modal>; focus is restored here on close. */
  triggerRef?: HTMLElement | null;
  /** Optional extra class on the underlying <Modal>. Destructured as `class: className` per repo convention. */
  class?: string;
};
