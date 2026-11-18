import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';

/**
 * Props for the CopyButton component.
 *
 * Copies `value` to the clipboard when clicked and renders a brief
 * confirmation state. The `children` snippet defines the button label;
 * `confirmation` is rendered while the copied state is active.
 *
 * Extends `HTMLButtonAttributes` (minus `class`) so consumers can pass
 * any native button attribute — `id`, `data-*`, `form`, etc. The component
 * owns `aria-label`, `aria-live`, `onclick`, and `type` (always `"button"`,
 * never a form submitter): these are Omit-ted so a consumer-supplied value is
 * a compile error rather than being silently overridden at runtime (the
 * component drives the copied-state announcement and clipboard handler
 * itself). `data-cinder-copied` is also owned but is a `data-*` attribute that
 * can't be expressed in the Omit, so it's overridden by spread ordering.
 *
 * The native `value` attribute is also Omit-ted: CopyButton's bespoke `value`
 * is the required clipboard text, and leaving the optional native `value` in
 * the surface confused schema/README generation (it dropped the prop as
 * `unknown-shape`). Omit-ting it makes `value: string` unambiguously owned.
 */
export type CopyButtonProps = Omit<
  HTMLButtonAttributes,
  'class' | 'aria-label' | 'aria-live' | 'onclick' | 'type' | 'value'
> & {
  /** Text to copy to the clipboard. */
  value: string;
  /** Optional HTML representation written alongside text/plain through ClipboardItem. */
  html?: string;
  /** Optional image blob or URL written alongside text and HTML when supported. */
  image?: Blob | string;
  /** Duration in ms to show the confirmation state. Default 1500. */
  confirmDuration?: number;
  /** Accessible label for the idle state. Defaults to "Copy to clipboard". */
  label?: string;
  /** Accessible label for the copied state — what `aria-live="polite"` announces
   * when the copy succeeds. Defaults to "Copied". Override this when `label` is
   * customized so the live-region announcement reflects what just happened
   * (e.g. label="Copy code" + copiedLabel="Code copied"). */
  copiedLabel?: string;
  /**
   * Shows the words "Copy", and "Copied" after a copy, after the icon. By default the button is
   * the Copy icon alone (a Check after a copy), named by `label`, which also shows as a tooltip.
   * The button keeps one width in both states.
   * @default false
   */
  textVisible?: boolean;
  /** Additional class names merged with `.cinder-copy-button`. */
  class?: string;
  /** The words of the text face at rest, after the Copy icon. Passing them shows the text face. */
  children?: Snippet;
  /** The words of the text face once copied, after the Check icon. Defaults to "Copied". */
  confirmation?: Snippet;
  /** Called when the clipboard write fails (permission denied, insecure context, or the legacy execCommand fallback also failing). */
  onError?: () => void;
};
