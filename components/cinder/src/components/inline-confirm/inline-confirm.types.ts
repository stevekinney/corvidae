import type { Snippet } from 'svelte';

export type InlineConfirmProps = {
  /** Confirmation prompt text. */
  prompt: string;
  /** Label for the confirming action. */
  confirmLabel: string;
  /** Label for the cancelling action. */
  cancelLabel?: string;
  /** Marks the confirming action as destructive. */
  destructive?: boolean;
  /** Whether the confirmation is open. Bindable. */
  open?: boolean;
  /** Additional content rendered below the prompt, above the confirm/cancel actions, while the confirmation is open. */
  children?: Snippet;
  /** Called when the user confirms the action. */
  onConfirm?: () => void;
  /** Called when the user cancels the action. */
  onCancel?: () => void;
  /** Additional class merged with the component's root class. */
  class?: string;
};
