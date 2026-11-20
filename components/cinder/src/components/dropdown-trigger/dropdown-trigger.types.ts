import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import type { ButtonSize, ButtonVariant } from '../button/button.types.ts';
export type DropdownTriggerProps = Omit<HTMLButtonAttributes, 'class'> & {
  /** Additional class names merged with the component's root class. */
  class?: string;
  /** Render the trailing disclosure caret. Defaults to true. */
  caretVisible?: boolean;
  /**
   * The trigger shows only an icon (its name in visually hidden text): it is drawn square, as tall
   * as it is wide, at its size, so a "More actions" menu in a row of buttons is a square, never a
   * pill. Pair it with `caretVisible={false}`.
   * @default false
   */
  iconOnly?: boolean;
  /**
   * Draws the trigger as a Button of this variant. Inside a ButtonGroup (a split button) the
   * trigger is always drawn as a Button, and without this it takes the variant of the Button
   * beside it, so the two halves are one control with one seam; with neither it is `soft`,
   * Button's default. Outside a group, without this, the trigger keeps its own bordered face.
   */
  variant?: ButtonVariant;
  /**
   * Draws the trigger at this Button size. Inside a ButtonGroup, without this, it takes the size
   * of the Button beside it, or `md`.
   */
  size?: ButtonSize;
  /**
   * Marks a menu of actions that change something. Inside a stale `<StaleRegion>` the trigger
   * goes inert: it keeps focus and carries `aria-disabled`, the menu does not open, and the
   * region's reason describes it. It returns by itself when the region stops being stale.
   * @default false
   */
  mutating?: boolean;
  children?: Snippet;
};
