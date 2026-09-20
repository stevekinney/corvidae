import type { HTMLAttributes } from 'svelte/elements';
export type ShortcutFieldProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'role'
> & {
  /**
   * Ordered list of platform key names for the recorded combination.
   * Bindable—the component writes to it directly after a valid capture and
   * on clear, so `bind:value` is the supported alternative to mirroring
   * `onValueChange` yourself. Defaults to `[]`.
   * @default []
   */
  value?: string[];
  /**
   * Called with the recorded combination when capture completes, and also
   * called with an empty array when the user clears the field—handle the
   * empty-array case to persist a removal, not only a successful capture.
   */
  onValueChange?: (value: string[]) => void;
  /** Returns an error message for a combination the application cannot accept; the field keeps the previous value until a valid replacement is committed. */
  validate?: (value: string[]) => string | undefined;
  /**
   * Accessible label for the shortcut field. Defaults to `'Keyboard
   * shortcut'`.
   * @default 'Keyboard shortcut'
   */
  label?: string;
  /** Set when the shortcut is unavailable. Defaults to `false`. @default false */
  disabled?: boolean;
  /** Additional class merged with the component's root class. */
  class?: string;
};
