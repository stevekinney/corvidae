import type { Snippet } from 'svelte';

type InlineConfirmSharedProps = {
  /** Label for the confirming action. */
  confirmLabel: string;
  /** Label for the cancelling action. Defaults to `'Cancel'`. @default 'Cancel' */
  cancelLabel?: string;
  /** Marks the confirming action as destructive. Defaults to `false`. @default false */
  destructive?: boolean;
  /**
   * The strip sits flush inside a bordered container. At the container's start or end it drops
   * its own rule there instead of doubling the container's edge. Defaults to `false`.
   * @default false
   */
  flush?: boolean;
  /**
   * Whether the confirmation is open. Bindable, and component-owned on
   * close: confirming, clicking Cancel, and pressing Escape all set this
   * to `false` before calling `onConfirm`/`onCancel`, so a bound parent
   * observes the confirmation as already closed by the time either
   * callback runs—neither callback can veto or delay that close. Defaults
   * to `false`.
   * @default false
   */
  open?: boolean;
  /** The in-flow strip (default) or a single guarded action button. */
  presentation?: 'strip' | 'two-press';
  /** Bindable armed state for two-press presentation. */
  armed?: boolean;
  /** Request identity; changing it disarms two-press presentation. */
  requestKey?: string;
  /** Disables and disarms two-press presentation. */
  disabled?: boolean;
  /** Blocks interaction while keeping the action focusable for an explanatory reason. */
  blocked?: boolean;
  /** Requires a second press; defaults to `true` in two-press presentation. */
  requiresSecondPress?: boolean;
  /** Explicit aria-disabled value for a blocked action. */
  ariaDisabled?: boolean;
  /** Full accessible label shown after the first press. */
  armedLabel?: string;
  /** Status text shown while the two-press action is armed. */
  armedHint?: string;
  /** Optional keyboard instruction shown beside the armed status on fine pointers. */
  armedEscapeHint?: string;
  /** Shows a loading state on the action button. */
  loading?: boolean;
  /** Accessible loading label for the action button. */
  loadingLabel?: string;
  /** Id referenced by the action button's aria-describedby. */
  ariaDescribedBy?: string;
  /** Additional content rendered below the prompt, above the confirm/cancel actions, while the confirmation is open. */
  children?: Snippet;
  /** Called when the user confirms the action, after `open` is already set to `false`. */
  onConfirm?: () => void;
  /** Called when the user cancels the action (via the Cancel action or Escape), after `open` is already set to `false`. */
  onCancel?: () => void;
  /** Additional class merged with the component's root class. */
  class?: string;
  /** Additional class merged with the two-press status hint. */
  hintClass?: string;
  /** Id assigned to the two-press status hint. */
  hintId?: string;
};

export type InlineConfirmProps = InlineConfirmSharedProps &
  (
    | {
        /** Strip confirmation prompt text. */
        presentation?: 'strip';
        prompt: string;
      }
    | {
        /** Single guarded action button without a competing Cancel action. */
        presentation: 'two-press';
        prompt?: never;
      }
  );
