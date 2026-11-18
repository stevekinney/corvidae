/**
 * How the playground previews compound parts. The families themselves are component metadata
 * (`compound.parts` and `composeOnly` in each `<name>.meta.json`), generated into
 * `./compound-families.generated.ts`; these two sets are the playground's own preview decisions.
 */

/**
 * Compound parts that read a STRICT context getter at instance-init scope: with
 * no provider ancestor the read throws `missing_context` during `mount()`.
 *
 * This is a strict SUBSET of `COMPOUND_COMPONENT_PARENTS`, and the subset
 * is the point. Most family members (`table-row`, `side-navigation-item`,
 * `statistic`, the `chat-*` leaves, …) read context through the optional
 * `tryGet*` accessors and bare-mount perfectly well — gating on family
 * membership alone would take a working live preview away from ~17 components
 * that currently have one, and since compose-only leaves ship no
 * `*.example.svelte` files there is no featured example to fall back to.
 *
 * The playground uses this to skip the bare mount for these parts (see
 * `canBareMount` in `../component-page-live-preview.ts`), which is chosen over
 * auto-wrapping them in a synthesized provider: several need a nesting depth
 * greater than two (`Table > Table.Header > Table.Row > Table.HeaderCell`),
 * their roots have their own required props, and `tab`/`segment`/`choice-grid-item`
 * need registration values matching the root's selection state — a generic
 * `<Root><Part/></Root>` wrapper renders blank or misleading for most of them.
 */
export const CONTEXT_REQUIRED_PARTS: ReadonlySet<string> = new Set([
  'accordion-item',
  'choice-grid-item',
  'command-item',
  'context-menu-trigger',
  'dropdown-item',
  'dropdown-menu',
  'dropdown-trigger',
  'segment',
  'speed-dial-action',
  'tab',
  'tab-list',
  'tab-panel',
  'table-header-cell',
  'tree-item',
]);

/**
 * Compound parts whose root element is a list item (`<li>`), so they are only valid inside the
 * parent's list. They read context through the optional accessors and bare-mount without
 * throwing, but a bare `<li>` with no `<ul>`/`<ol>` is invalid markup that assistive technology
 * cannot place (axe `listitem`). Like {@link CONTEXT_REQUIRED_PARTS}, they skip the bare mount and
 * take the compose-guidance branch that links to the root's page, which shows the real list.
 *
 * Kept in step with the sources by `compound-parts.test.ts`, in both directions.
 */
export const LIST_ITEM_PARTS: ReadonlySet<string> = new Set([
  'feed-boundary',
  'feed-event',
  'grid-list-item',
  'side-navigation-group',
  'side-navigation-item',
]);
