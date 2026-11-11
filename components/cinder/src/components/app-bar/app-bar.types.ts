import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Heading level for an AppBar title that is the page's own heading. */
export type AppBarHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * An icon-only action at the end of the bar. Its `label` is required: an icon has no name of its
 * own, so the label is the action's accessible name and its tooltip.
 */
export type AppBarAction = {
  /** The accessible name and the tooltip, such as "Share" or "Save". */
  label: string;
  /** The icon. It is decorative; the label names the action. */
  icon: Snippet;
  /** Render the action as a link to this address instead of a button. */
  href?: string;
  /** Called when the action is pressed. Not called while the action is inert. */
  onclick?: (event: MouseEvent) => void;
  /** Makes the action inert: it stays focusable, ignores the press and carries `aria-disabled`. */
  disabled?: boolean;
};

/** The Back action at the start of the bar: an icon-only chevron with a tooltip. */
export type AppBarBackAction = {
  /**
   * The accessible name and the tooltip.
   * @default "Back"
   */
  label?: string;
  /** Render Back as a link to this address instead of a button. */
  href?: string;
  /** Called when Back is pressed. */
  onclick?: (event: MouseEvent) => void;
};

/** Props for the AppBar component. */
export type AppBarProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children' | 'title'> & {
  /** The page's title, 20px bold on one line that ends in an ellipsis. Snippets must emit phrasing content. */
  title?: string | Snippet;
  /**
   * Draws the title. Bind a large PageHeader's `collapsed` here so the title appears once the large
   * title scrolls away; while it is hidden the title is also hidden from assistive technology.
   * @default true
   */
  titleVisible?: boolean;
  /**
   * Makes the title the page's heading at this level, for a page whose identity lives in the bar.
   * Leave it unset when a PageHeader carries the page's heading.
   */
  headingLevel?: AppBarHeadingLevel;
  /** A Back action at the start of the bar. */
  back?: AppBarBackAction;
  /** Content at the start of the bar, after Back. */
  leading?: Snippet;
  /** Content at the end of the bar, before the icon actions. */
  trailing?: Snippet;
  /** Icon-only actions at the end of the bar, each with a required name and a tooltip. */
  actions?: AppBarAction[];
  /** Additional class names merged with `.cinder-app-bar`. */
  class?: string;
};

/** Schema-generator surface: the props JSON can express. */
export interface AppBarSchemaProps {
  /** The page's title, 20px bold on one line that ends in an ellipsis; the runtime API also accepts a template-only snippet. */
  title?: string;
  /**
   * Draws the title. Bind a large PageHeader's `collapsed` here so the title appears once the large
   * title scrolls away; while it is hidden the title is also hidden from assistive technology.
   * @default true
   */
  titleVisible?: boolean;
  /**
   * Makes the title the page's heading at this level, for a page whose identity lives in the bar.
   * Leave it unset when a PageHeader carries the page's heading.
   */
  headingLevel?: AppBarHeadingLevel;
  /** Additional class names merged with `.cinder-app-bar`. */
  class?: string;
}
