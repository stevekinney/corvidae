import type { HTMLAttributes } from 'svelte/elements';
export type ShortcutFieldProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'role'
> & {
  /** Ordered list of platform key names for the recorded combination. */
  value?: string[];
  /** Called with the recorded combination when capture completes. */
  onValueChange?: (value: string[]) => void;
  /** Returns an error message for a combination the application cannot accept; the field keeps the previous value until a valid replacement is committed. */
  validate?: (value: string[]) => string | undefined;
  /** Accessible label for the shortcut field. */
  label?: string;
  /** Set when the shortcut is unavailable. */
  disabled?: boolean;
  /** Additional class merged with the component's root class. */
  class?: string;
};
