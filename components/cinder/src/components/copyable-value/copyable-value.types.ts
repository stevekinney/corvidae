import type { HTMLAttributes } from 'svelte/elements';

/** Props for the CopyableValue component. */
export type CopyableValueProps = Omit<HTMLAttributes<HTMLSpanElement>, 'class' | 'children'> & {
  /** The text shown, in monospace, and the text the copy control writes to the clipboard, such as an address or an identifier. */
  value: string;
  /** Prefer separator breaks and select the text as one value. Defaults to false. */
  breakHints?: boolean;
  /** Accessible name of the copy control, also its tooltip. Defaults to "Copy to clipboard". */
  label?: string;
  /** What is announced once the copy succeeds. Defaults to "Copied"; say what was copied when `label` does ("Address copied"). */
  copiedLabel?: string;
  /** Custom class merged with `.cinder-copyable-value`. */
  class?: string;
};
