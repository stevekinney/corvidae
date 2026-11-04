import type { Snippet } from 'svelte';

type ModalBaseProps = {
  /** Controls whether the modal is open; bindable for controlled usage. */
  open: boolean;
  /** When true, clicking the backdrop outside the modal panel dismisses it. Default `true`. */
  dismissOnBackdropClick?: boolean;
  /** When true, pressing Escape dismisses the modal. Default `true`. */
  dismissOnEscape?: boolean;
  /** When true, renders the close button in the upper corner of the modal panel. Default `true`. */
  closeButtonVisible?: boolean;
  /**
   * Viewport width below which the modal opens as a bottom sheet instead of a centred card: it
   * docks to the bottom edge with a grabber and rounded top corners, its footer actions stack at
   * full width and 44px with the last action (the confirmation) first, and it rides above the
   * on-screen keyboard and the bottom safe area. A CSS length such as `"640px"`, or `false` for the
   * centred card at every width. Ignored for `chrome="none"`.
   * @default false
   */
  sheetBelow?: string | false;
  /** Additional class names merged with the component's root class. */
  class?: string;
  children: Snippet;
  footer?: Snippet;
  /**
   * Content drawn at the trailing edge of the header, on the title's line (a count such as "3 of 9
   * chosen"). It is not part of the dialog's accessible name. With the close button hidden it sits
   * at the panel's own padding; with the close button shown it stays clear of it. Ignored by
   * `chrome="none"`, which draws no header.
   */
  headerTrailing?: Snippet;
  triggerRef?: HTMLElement | null;
  /**
   * Fired on user-initiated dismissal. Includes: Escape key (native dialog 'cancel' event),
   * backdrop click, and the close-X button. EXCLUDES: parent-driven open = false.
   * Callbacks are not awaited and thrown callbacks do not block close.
   */
  onDismiss?: () => void;
  /**
   * Fired once the exit transition genuinely finishes and the panel actually
   * unmounts — not when `open` first flips false. Modal keeps its children
   * mounted for the whole exit-transition window (via `SlidingDialogState`),
   * so a CONSUMER that composes Modal and wraps it in its own `{#if}` keyed
   * directly on the same condition that flips `open` false would destroy the
   * whole component instance before this exit ever gets a chance to play.
   * Use this callback to decouple that wrapping condition from the live open
   * state: keep the composing consumer's own mount gate true until this
   * fires, then clear it. Fires immediately (no animation) when
   * `prefers-reduced-motion: reduce` collapses the transition duration to
   * zero. Does NOT fire if `open` flips back to true before the exit
   * transition completes (a reopen-during-close) — the panel never actually
   * unmounts in that case, so the composing consumer's mount gate must stay
   * on. Same pattern as `PopoverProps`/`SelectionPopoverProps`'
   * `onExitComplete` (CIN-376).
   */
  onExitComplete?: () => void;
};

type DefaultChromeProps = {
  /**
   * Chrome mode. `'default'` renders the header, visible title, border,
   * `max-width: min(90vw, 32rem)`, and body padding. `'none'` renders a
   * chromeless, full-bleed surface — the header, title, border, max-width, and
   * padding are all suppressed, but coordination (focus trap, scroll lock,
   * escape-stack participation, the exit-transition lifecycle, `role="dialog"`
   * and `aria-modal`) is entirely unchanged. Default `'default'`.
   */
  chrome?: 'default';
  /** Text rendered as the modal's visible heading and used as its accessible label. */
  title: string;
  /** Not used in the default chrome — the visible title supplies the accessible name instead. */
  'aria-label'?: never;
};

type ChromelessProps = {
  /** See `DefaultChromeProps.chrome`. `'none'` renders no header, so `aria-label` must supply the accessible name instead. */
  chrome: 'none';
  /** Optional in the chromeless chrome — no header renders, so this is never displayed. */
  title?: string;
  /** Required in the chromeless chrome: since no visible title renders, this supplies the dialog's accessible name. */
  'aria-label': string;
};

type ModalSharedProps = ModalBaseProps & (DefaultChromeProps | ChromelessProps);

type DialogModalProps = ModalSharedProps & {
  /** ARIA role applied to the underlying dialog element. Default `dialog`. */
  role?: 'dialog';
  /** When set, applied as aria-describedby on the underlying <dialog>. Pass a short, plain description ID only. */
  describedById?: string;
};

type AlertDialogModalProps = ModalSharedProps & {
  /** ARIA role applied to the underlying dialog element. Use `alertdialog` for urgent prompts that cannot be dismissed without an explicit action. */
  role: 'alertdialog';
  /** Required for alertdialog so assistive technology receives the urgent condition and required action. */
  describedById: string;
};

export type ModalProps = DialogModalProps | AlertDialogModalProps;
