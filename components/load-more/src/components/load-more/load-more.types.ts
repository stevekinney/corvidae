/** Where a LoadMore footer sits: centered on its own, or spread across the foot of a framed list. */
export type LoadMoreVariant = 'centered' | 'footer';

export type LoadMoreProps = {
  /** Called when the next page should be loaded. Caller flips `loading` and `hasMore`. */
  onLoadMore?: () => void | Promise<void>;
  /** Whether more items are available. Bindable. */
  hasMore?: boolean;
  /** Whether a load is in progress. Bindable. */
  loading?: boolean;
  /**
   * Scroll container the sentinel is observed within. Pass the scrollable
   * ancestor element when the list scrolls inside a container rather than the
   * viewport. `null`/omitted observes against the viewport. Captured at
   * attachment time.
   */
  root?: Element | Document | null;
  /** rootMargin passed to IntersectionObserver. Captured at attachment time. */
  rootMargin?: string;
  /** Visible label for the load-more button. @default "Load more" */
  buttonLabel?: string;
  /** Visible label for the retry button after a load error. @default "Try again" */
  retryLabel?: string;
  /**
   * How many items the list shows now. With `totalCount` the footer reads "Showing 10 of 19" next
   * to its button, and keeps that count when a load fails.
   */
  loadedCount?: number;
  /** How many items exist in all; pairs with `loadedCount`. */
  totalCount?: number;
  /**
   * What the count counts, said after it: "waiting tasks" gives "Showing 3 of 12 waiting tasks".
   * Without it the footer reads "Showing 3 of 12".
   */
  countNoun?: string;
  /**
   * What the list holds, in the plural, for the failure message: "runs" gives "Couldn’t load more
   * runs." @default "items"
   */
  itemLabel?: string;
  /**
   * Replaces the whole failure message shown after `onLoadMore` rejects. By default it reads
   * "Couldn’t load more {itemLabel}." followed by the count when `loadedCount` and `totalCount`
   * are set.
   */
  errorMessage?: string;
  /**
   * Opens in the failed state: the footer says "Couldn’t load more {itemLabel}." with the count and
   * offers the retry button, as if the last load had rejected. For a list whose own trigger (a
   * table that loads as its end scrolls into view) made the request and it failed, so the footer
   * can take over with the same retry any keyboard user can press. Pressing the button clears it,
   * and a rejection sets it again.
   * @default false
   */
  failed?: boolean;
  /**
   * Where the footer sits. `'centered'` puts the count, the message and the button in one centered
   * row. `'footer'` is for the foot of a framed table or list: the count or message at the start
   * and the button at the end, and a failure in the warning tone with its first sentence in bold.
   * @default 'centered'
   */
  variant?: LoadMoreVariant;
  /** Politely announced when the end of the list is reached. @default "End of list" */
  endOfListMessage?: string;
  /** Maximum consecutive sentinel-triggered requests before auto-loading pauses. @default 5 */
  maxRetries?: number;
  /** Notified when onLoadMore throws or rejects. */
  onError?: (error: unknown) => void;
  /** Custom class merged with `.cinder-load-more`. */
  class?: string;
};
