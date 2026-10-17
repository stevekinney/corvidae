import type { HTMLAttributes } from 'svelte/elements';

export type PaginationProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
  /**
   * Current page number (1-indexed). Bindable. In callback mode it only feeds the "Page N of M"
   * label, so cursor paging can omit it.
   * @default 1
   */
  currentPage?: number;
  /** Total number of pages. Omit when only previous/next availability is known. */
  totalPages?: number;
  /**
   * Whether a previous page is available. When totalPages is unknown, defaults to currentPage > 1.
   * In callback mode (`onPrevious` or `onNext` given) Previous is enabled only when `onPrevious` is
   * given and this is true.
   */
  hasPreviousPage?: boolean;
  /**
   * Whether a next page is available. When totalPages is unknown, defaults to false. In callback
   * mode (`onPrevious` or `onNext` given) Next is enabled only when `onNext` is given and this is
   * true.
   * @default false
   */
  hasNextPage?: boolean;
  /** Optional total record count; formatted with formatNumber when provided. */
  totalCount?: number;
  /**
   * Formats the `totalCount` text in place of the default "N results". Receives the raw count,
   * so format it with your own locale rules.
   */
  countLabel?: (count: number) => string;
  /**
   * Called when the user asks for the previous page. Giving this or `onNext` puts the component
   * in callback mode: `currentPage` is never changed by the component, Previous is enabled when
   * this is given and `hasPreviousPage` is true, and no page-number buttons render. Keep the offset
   * or cursor in the caller.
   */
  onPrevious?: () => void;
  /**
   * Called when the user asks for the next page. Giving this or `onPrevious` puts the component
   * in callback mode: `currentPage` is never changed by the component, Next is enabled when this
   * is given and `hasNextPage` is true, and no page-number buttons render. When `totalPages` is given the
   * controls show "Page N of M".
   */
  onNext?: () => void;
  /** Custom class merged with `.cinder-pagination`. */
  class?: string;
};
