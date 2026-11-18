import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Heading level for the page title, so the document outline stays correct inside a host page. */
export type PageHeaderHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Where a page's status sits: `inline` on the title's first line, beside it ("Waiting on you"
 * next to a chat's title), or `below` the title ("Done", then when it finished).
 */
export type PageHeaderStatusPlacement = 'inline' | 'below';

/** Where a narrow header's actions go: on a row of their own, or beside the status. */
export type PageHeaderNarrowActions = 'own-row' | 'beside-status';

/**
 * The header's layout. `default` is the page title beside its actions. `large` sets the title at
 * the large page-title size and, once it scrolls away, shows it at the default size in a sticky
 * bar. `hero` is a full-bleed band: an eyebrow, a display title, facts and actions beneath the
 * title, and a focal value or media at the inline end.
 */
export type PageHeaderVariant = 'default' | 'large' | 'hero';

/**
 * The band a `hero` header draws. `plain` draws none; `tint` is a light or dark indigo wash;
 * `accent` is a saturated indigo gradient with light text; `night` is near-black with an indigo
 * glow. Every tone keeps its text at 4.5:1 or better.
 */
export type PageHeaderTone = 'plain' | 'tint' | 'accent' | 'night';

/**
 * One action in the header's overflow menu. An action marked `decision` is never put in the menu:
 * it is drawn as a visible button beside the `decisions` group instead.
 */
export type PageHeaderOverflowAction = {
  /** The visible text of the menu item, and of the button when it is a decision. */
  label: string;
  /** Render the action as a link to this address instead of a button. */
  href?: string;
  /** Called when the action is pressed. */
  onclick?: (event: MouseEvent) => void;
  /** Makes the action inert: the press is blocked and it carries `aria-disabled`. */
  disabled?: boolean;
  /** Draws the action as destructive, such as Delete. */
  danger?: boolean;
  /**
   * A decision the page is waiting on, such as approve, deny or edit for an approval, or Cancel
   * for running or paused work. It is always visible and never hidden in the menu.
   */
  decision?: boolean;
};

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
  /**
   * A lighter phrase drawn straight after the title, in the same heading at the same size, such as
   * ", made easier" after a brand name. Include any leading space or punctuation.
   */
  titleSoft?: string;
  /**
   * The thing's identifier, such as a workflow's `release-notes`, drawn small, monospaced and muted
   * beside the title and never broken inside. Leave it out when the title is the identifier.
   */
  identifier?: string;
  /** Heading level for the title element. Defaults to `1`. */
  headingLevel?: PageHeaderHeadingLevel;
  /**
   * The header's layout: `default`, `large` (a large title that collapses into a sticky bar on
   * scroll) or `hero` (a full-bleed band).
   * @default "default"
   */
  variant?: PageHeaderVariant;
  /**
   * The band a `hero` header draws: `plain`, `tint`, `accent` or `night`. The other variants
   * ignore it.
   * @default "plain"
   */
  tone?: PageHeaderTone;
  /** A short neutral line above a `hero` title, such as the section or the place. */
  eyebrow?: string;
  /** Optional supporting content rendered below the title; snippets must emit phrasing content. */
  description?: string | Snippet;
  /** Optional breadcrumb navigation rendered above the heading row. */
  breadcrumbs?: Snippet;
  /** Optional trailing actions (buttons, menus, controls). */
  actions?: Snippet;
  /**
   * A short caption for the actions, under their row: which version each button runs on, or a
   * "Connect a provider" link that says why a button is held. It sits at the inline end under the
   * actions in a wide header and starts the line under them below 640px of header width, and the
   * actions' group is described by it (`aria-describedby`). A button the caption explains can point
   * its own `aria-describedby` at `actionsNoteId`.
   */
  actionsNote?: string | Snippet;
  /**
   * The id of the `actionsNote` element, for a button that points its own `aria-describedby` at it.
   * Defaults to an id derived from the header's.
   */
  actionsNoteId?: string;
  /**
   * The decision action group: approve, deny or edit for an approval, or Cancel for running or
   * paused work. It is drawn first among the actions, is never put in the overflow menu, and stays
   * visible at every width.
   */
  decisions?: Snippet;
  /**
   * Secondary actions behind one "More actions" menu button. An action marked `decision` is drawn
   * as a visible button instead, so a decision is never hidden in the menu.
   */
  overflow?: PageHeaderOverflowAction[];
  /**
   * The accessible name of the overflow menu button.
   * @default "More actions"
   */
  overflowLabel?: string;
  /** A `hero` header's facts beneath the title, such as a KeyFacts row. */
  facts?: Snippet;
  /** Optional media at the inline end of a `hero` header. A hero needs none to look finished. */
  media?: Snippet;
  /**
   * One large icon glyph drawn at low opacity at the bottom inline-end corner of a `hero` band. It
   * is decorative and hidden from assistive technology, and it is not drawn when `focal` is set.
   */
  art?: Snippet;
  /**
   * A `hero` header's focal value at the inline end: one large tabular value first, then its label
   * in a `<small>`, then an optional Meter. Below 720px of header width it sits above the title.
   */
  focal?: Snippet;
  /**
   * Whether a `large` title has scrolled away. Bind it to pair the header with an AppBar's
   * `titleVisible`.
   * @default false
   */
  collapsed?: boolean;
  /**
   * Whether a `large` header draws its own sticky bar with the title once the title scrolls away.
   * Turn it off when an AppBar shows the title instead.
   * @default true
   */
  collapsedBar?: boolean;
  /**
   * A list page's create action, drawn last in the actions region as a secondary icon-only "+"
   * with a tooltip. It is always secondary, in every state of the page.
   */
  createAction?: PageHeaderCreateAction;
  /**
   * Insets the header with padding around it. Off by default: the header is flush with the content
   * beneath it, so its title lines up with that content. Pass it where the header should sit in
   * from the edge of its container.
   * @default false
   */
  inset?: boolean;
  /**
   * Draws a rule under the header. Off by default: space separates the header from the page, and
   * the rule is opt-in.
   * @default false
   */
  divider?: boolean;
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
   * Where the actions go in a narrow header (a phone). `own-row` puts them on a row of their own
   * under the title and the status. `beside-status` puts them at the inline end of the status's
   * row instead, which saves that row's height, for a page whose actions are a few compact
   * controls and whose content below needs the room, such as a chat; with no status they sit
   * beside the title. A wide header is the same either way.
   * @default "own-row"
   */
  narrowActions?: PageHeaderNarrowActions;
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
   * A lighter phrase drawn straight after the title, in the same heading at the same size, such as
   * ", made easier" after a brand name. Include any leading space or punctuation.
   */
  titleSoft?: string;
  /**
   * The thing's identifier, such as a workflow's `release-notes`, drawn small, monospaced and muted
   * beside the title and never broken inside. Leave it out when the title is the identifier.
   */
  identifier?: string;
  /**
   * Heading level for the title element. Defaults to `1`.
   * @default 1
   */
  headingLevel?: PageHeaderHeadingLevel;
  /**
   * The header's layout: `default`, `large` (a large title that collapses into a sticky bar on
   * scroll) or `hero` (a full-bleed band).
   * @default "default"
   */
  variant?: PageHeaderVariant;
  /**
   * The band a `hero` header draws: `plain`, `tint`, `accent` or `night`. The other variants
   * ignore it.
   * @default "plain"
   */
  tone?: PageHeaderTone;
  /** A short neutral line above a `hero` title, such as the section or the place. */
  eyebrow?: string;
  /** Optional supporting text rendered below the title; the runtime API also accepts a template-only snippet. */
  description?: string;
  /** A short caption under the actions' row; the runtime API also accepts a template-only snippet. */
  actionsNote?: string;
  /** The id of the `actionsNote` element, for a button that points its `aria-describedby` at it. */
  actionsNoteId?: string;
  /**
   * Insets the header with padding around it. Off by default: the header is flush with the content
   * beneath it, so its title lines up with that content. Pass it where the header should sit in
   * from the edge of its container.
   * @default false
   */
  inset?: boolean;
  /**
   * Draws a rule under the header. Off by default: space separates the header from the page, and
   * the rule is opt-in.
   * @default false
   */
  divider?: boolean;
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
  /**
   * Where the actions go in a narrow header (a phone): `own-row` on a row of their own under the
   * title and the status, or `beside-status` at the inline end of the status's row.
   * @default "own-row"
   */
  narrowActions?: PageHeaderNarrowActions;
  /**
   * The accessible name of the overflow menu button.
   * @default "More actions"
   */
  overflowLabel?: string;
  /**
   * Whether a `large` title has scrolled away. Bind it to pair the header with an AppBar's
   * `titleVisible`.
   * @default false
   */
  collapsed?: boolean;
  /**
   * Whether a `large` header draws its own sticky bar with the title once the title scrolls away.
   * Turn it off when an AppBar shows the title instead.
   * @default true
   */
  collapsedBar?: boolean;
  /** The title's plain text, for the full-title tooltip when `title` is a snippet. */
  titleText?: string;
  /** Additional class names merged with `.cinder-page-header`. */
  class?: string;
}
