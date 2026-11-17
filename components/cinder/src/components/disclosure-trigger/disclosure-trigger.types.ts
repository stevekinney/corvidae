import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';

/** Props for the DisclosureTrigger component. */
export type DisclosureTriggerProps = Omit<
  HTMLButtonAttributes,
  'class' | 'children' | 'type' | 'aria-expanded' | 'aria-controls'
> & {
  /** Whether the region the trigger shows is open: the chevron turns down and `aria-expanded` is true. */
  open: boolean;
  /** The id of the region the trigger shows and hides, for `aria-controls`. */
  controls?: string | undefined;
  /** The trigger's words, and anything that reads with them, such as a count or a duration. */
  children: Snippet;
  /** Additional class names merged with `.cinder-disclosure-trigger`. */
  class?: string | undefined;
};

/** Schema generator surface for DisclosureTrigger: excludes snippet and function props. */
export interface DisclosureTriggerSchemaProps {
  /** Whether the region the trigger shows is open. */
  open: boolean;
  /** The id of the region the trigger shows and hides, for `aria-controls`. */
  controls?: string | undefined;
  /** Additional class names merged with `.cinder-disclosure-trigger`. */
  class?: string | undefined;
}
