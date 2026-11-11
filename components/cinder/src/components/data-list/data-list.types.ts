import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { StackedListItemDensity } from '../stacked-list-item/stacked-list-item.types.ts';

/** A group of consecutive rows under one header band (a day on Runs and Chats). */
export type DataListGroup = {
  /** Identifies the group. Consecutive items with the same key share one header. */
  key: string | number;
  /** The header's text, such as `Today, Monday, Nov 2`. */
  label: string;
  /** Muted text at the right of the header, such as the time zone (`Central time`). */
  detail?: string;
};

// Forwarded `<ul>` attributes (matches GridListProps). `role` is omitted because
// the component enforces `role="list"`; `class` and `children` are redefined
// below with component-specific shapes.
export type DataListProps<T> = Omit<
  HTMLAttributes<HTMLUListElement>,
  'role' | 'class' | 'children'
> & {
  /** The records to render. Each is passed to `children`. */
  items: T[];
  /**
   * Key extractor for stable DOM reconciliation. Svelte uses this to identify
   * each row when the list is reordered, filtered, or updated. Without a key,
   * rows are matched by index and the wrong row instances may receive updated
   * props, causing O(n) churn and incorrect rendering.
   *
   * ```svelte
   * <DataList {items} key={(m) => m.id}>
   * ```
   */
  key: (item: T) => string | number;
  /**
   * List-level density inherited by StackedListItem rows that do not set their
   * own `density` prop. Omit to let each row use its own default. A per-row
   * `density` always overrides this list-level value.
   *
   * Note: when passing a variable that may be `undefined`, spread conditionally
   * because `exactOptionalPropertyTypes` is enabled:
   * `{...(density ? { density } : {})}`
   */
  density?: StackedListItemDensity;
  /**
   * Keep the status column's width for every row that has no `status` (a workflow, an agent with
   * nothing to report), so titles line up down the whole list. A row's own `statusColumn` wins.
   */
  statusColumn?: boolean;
  /**
   * Group consecutive items under a header band, newest group first as the items arrive. Each
   * group is a nested list named by its header, so a screen reader announces the day. Items are
   * not reordered; pass them already sorted.
   */
  groupBy?: (item: T) => DataListGroup;
  /**
   * Announce rows inserted while the list is on screen. Called with the number of new rows; the
   * returned text (`1 new run`) is spoken politely through a live region that is also drawn as a
   * status strip above the first group. The first render announces nothing. Rows inserted above
   * the viewport do not move what the reader is looking at.
   */
  insertionAnnouncement?: (count: number) => string;
  /** Additional class merged onto the `.cinder-data-list` root element. */
  class?: string;
  /**
   * Row renderer. MUST render an `<li>` (the list root is a `<ul role="list">`).
   * StackedListItem is the recommended row — it renders an `<li>` with
   * leading/title/description/meta/trailing slots.
   */
  children: Snippet<[T]>;
  /**
   * Rendered when `items` is empty. The component automatically wraps the
   * snippet output in `<li class="cinder-data-list-empty">`.
   *
   * **Do NOT wrap in an `<li>` yourself** — the component provides the `<li>`
   * wrapper automatically. Pass only inner content (e.g. a `<p>`, a `<div>`,
   * or plain text). Contrast with `children`, which must render an `<li>`.
   */
  empty?: Snippet;
};
