import type { HTMLAttributes } from 'svelte/elements';

export type PaginationProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
  /** Current page number (1-indexed). Bindable. */
  currentPage: number;
  /** Total number of pages. Omit when only previous/next availability is known. */
  totalPages?: number;
  /**
   * Whether a previous page is available. When totalPages is unknown, defaults to currentPage > 1.
   * In callback mode (`onPrevious` or `onNext` given) it alone decides, defaulting to false.
   */
  hasPreviousPage?: boolean;
  /**
   * Whether a next page is available. When totalPages is unknown, defaults to false. In callback
   * mode (`onPrevious` or `onNext` given) it alone decides.
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
   * in callback mode: `currentPage` is never changed by the component, Previous is enabled by
   * `hasPreviousPage` alone, and no page-number buttons render. Keep the offset or cursor in the
   * caller.
   */
  onPrevious?: () => void;
  /**
   * Called when the user asks for the next page. Giving this or `onPrevious` puts the component
   * in callback mode: `currentPage` is never changed by the component, Next is enabled by
   * `hasNextPage` alone, and no page-number buttons render. When `totalPages` is given the
   * controls show "Page N of M".
   */
  onNext?: () => void;
  /** Custom class merged with `.cinder-pagination`. */
  class?: string;
};
