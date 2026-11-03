import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
export type DropdownTriggerProps = Omit<HTMLButtonAttributes, 'class'> & {
  /** Additional class names merged with the component's root class. */
  class?: string;
  /** Render the trailing disclosure caret. Defaults to true. */
  caretVisible?: boolean;
  /**
   * Marks a menu of actions that change something. Inside a stale `<StaleRegion>` the trigger
   * goes inert: it keeps focus and carries `aria-disabled`, the menu does not open, and the
   * region's reason describes it. It returns by itself when the region stops being stale.
   * @default false
   */
  mutating?: boolean;
  children?: Snippet;
};
