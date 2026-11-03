import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Heading level for the page title, so the document outline stays correct inside a host page. */
export type PageHeaderHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Where a page's status sits: `inline` on the title's first line, beside it ("Waiting on you"
 * next to a chat's title), or `below` the title ("Done", then when it finished).
 */
export type PageHeaderStatusPlacement = 'inline' | 'below';

/**
 * A list page's create action: a secondary, icon-only "+" button at the right of the header with
 * a tooltip and an accessible name, in the same place whether the list is empty or not.
 */
export type PageHeaderCreateAction = {
  /** The tooltip and the accessible name, such as "New agent" or "Start run". */
  label: string;
  /** Render the action as a link to this address instead of a button. */
  href?: string;
  /** Called when the action is pressed. Not called while the action is inert. */
  onclick?: (event: MouseEvent) => void;
  /** Disables the action: not focusable, not pressable. Prefer `inertReason`, which keeps focus. */
  disabled?: boolean;
  /**
   * Makes the action inert and says why: it stays focusable, ignores the press, carries
   * `aria-disabled`, and the reason describes it ("Off until the list loads"). Use it where the
   * page cannot create yet but should still tell a keyboard user so, such as under a full-page
   * error. Under a stale `<StaleRegion>` the region's own reason does this.
   */
  inertReason?: string;
  /**
   * Whether creating changes something, so the action goes inert under a stale `<StaleRegion>`.
   * @default true
   */
  mutating?: boolean;
  /** A custom icon in place of the "+"; decorative, the label names the action. */
  icon?: Snippet;
};

/** Props for the PageHeader component. */
export type PageHeaderProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'title'
> & {
  /** Page-level heading content. Rendered inside the `headingLevel` heading; snippets must emit phrasing content. */
  title: string | Snippet;
  /** Heading level for the title element. Defaults to `1`. */
  headingLevel?: PageHeaderHeadingLevel;
  /** Optional supporting content rendered below the title; snippets must emit phrasing content. */
  description?: string | Snippet;
  /** Optional breadcrumb navigation rendered above the heading row. */
  breadcrumbs?: Snippet;
  /** Optional trailing actions (buttons, menus, controls). */
  actions?: Snippet;
  /**
   * A list page's create action, drawn last in the actions region as a secondary icon-only "+"
   * with a tooltip. It is always secondary, in every state of the page.
   */
  createAction?: PageHeaderCreateAction;
  /**
   * A full-page error state shows under this header. The header's primary buttons then draw as
   * secondary, so the error's "Try again" is the only primary on the page.
   * @default false
   */
  error?: boolean;
  /**
   * The page's status, such as a dot and "Waiting on you". It is a snippet so the page owns the
   * words and the tone; see `statusPlacement` for where it sits.
   */
  status?: Snippet;
  /**
   * Where `status` sits: `inline` beside the title on its first line, or `below` the title.
   * @default "below"
   */
  statusPlacement?: PageHeaderStatusPlacement;
  /**
   * The title's plain text, for the tooltip that shows the full title when it is cut off, when
   * `title` is a snippet. A string `title` is used as it is.
   */
  titleText?: string;
  /** Additional class names merged with `.cinder-page-header`. */
  class?: string;
};

/**
 * Schema-generator surface. The runtime title and description also accept
 * snippets, while schema-driven consumers use their string variants.
 */
export interface PageHeaderSchemaProps {
  /** Page-level heading text rendered inside the `headingLevel` heading; the runtime API also accepts a template-only snippet. */
  title: string;
  /**
   * Heading level for the title element. Defaults to `1`.
   * @default 1
   */
  headingLevel?: PageHeaderHeadingLevel;
  /** Optional supporting text rendered below the title; the runtime API also accepts a template-only snippet. */
  description?: string;
  /**
   * A full-page error state shows under this header, so its primary buttons draw as secondary.
   * @default false
   */
  error?: boolean;
  /**
   * Where `status` sits: `inline` beside the title on its first line, or `below` the title.
   * @default "below"
   */
  statusPlacement?: PageHeaderStatusPlacement;
  /** The title's plain text, for the full-title tooltip when `title` is a snippet. */
  titleText?: string;
  /** Additional class names merged with `.cinder-page-header`. */
  class?: string;
}
