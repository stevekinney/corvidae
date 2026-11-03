import type { Snippet } from 'svelte';
import type { HTMLButtonAttributes } from 'svelte/elements';
import type { BadgeVariant } from '../badge/badge.types.ts';
// `onclick` and `onkeydown` are omitted because the component sets both
// unconditionally on the root `<button>` (activation + the shared roving
// tabindex keyboard handler) — same reasoning as `id` and `value` below. Since
// `{...rest}` is spread before those explicit handlers, an un-omitted
// `onclick`/`onkeydown` prop would type-check but the component's own handler
// would silently replace it at runtime (a consumer's forwarded handler would
// simply never fire, with no compile-time or runtime signal). Omitting them
// makes `<Tab onclick={...} />` a compile error instead.
export type TabProps = Omit<
  HTMLButtonAttributes,
  'id' | 'disabled' | 'value' | 'class' | 'children' | 'onclick' | 'onkeydown'
> & {
  /** Stable identifier used for tab selection; matches TabPanel in the default pattern. */
  value: string;
  /** Optional explicit id override; auto-generated otherwise for ARIA wiring. */
  id?: string;
  /**
   * Optional non-empty `aria-controls` target for caller-owned panels. Empty or
   * whitespace-only strings are treated as omitted. By default, Cinder points
   * at the matching TabPanel id (`${baseId}-panel-${value}`).
   */
  controls?: string;
  /** Disables this single tab and removes it from keyboard activation. @default false */
  disabled?: boolean;
  /** Additional class names merged with `.cinder-tab`. */
  class?: string;
  /** Tab label content. */
  children: Snippet;
  /**
   * A count of things in this tab that want attention, drawn as a small pill after the label. Zero,
   * a negative number and `undefined` show nothing, so a healthy tab carries no chip. The count is
   * part of the tab's accessible name, so it never depends on colour.
   */
  count?: number;
  /**
   * The words that follow the count in the pill's accessible name: "needs attention" gives
   * "1 needs attention", so the tab reads "Workers 1 needs attention". Without it the pill
   * reads as the bare number.
   */
  countLabel?: string;
  /** Tone of the count pill. Defaults to `'warning'`, the amber of a count that needs attention. */
  countTone?: BadgeVariant;
  /**
   * Decorative content rendered inside an `aria-hidden` span (badges, kbd hints,
   * counters). Do NOT use for interactive controls like close buttons —
   * `aria-hidden` removes the content from the accessibility tree, making any
   * interactive child unreachable by keyboard and invisible to screen readers.
   *
   * For a closeable tab, render a separate `<button>` immediately after the
   * `<Tab>` in the DOM (as a sibling within the tab strip) and associate it
   * with the tab via `aria-label="Close [tab name]"`. The close button must
   * live outside the `<Tab>` element entirely.
   */
  trailing?: Snippet;
};
