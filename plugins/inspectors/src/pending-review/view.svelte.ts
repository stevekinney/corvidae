import { SvelteMap } from 'svelte/reactivity';

import type { ReviewView } from './model.ts';

/** What one review's row remembers between redraws: its outcome and a half-typed reason. */
export type RowState = {
  /** What the last attempt on this review said. */
  readonly outcome: string | null;
  /** The reject form is open. */
  readonly rejecting: boolean;
  /** The reject reason typed so far. */
  readonly draft: string;
};

/** The state of a review nothing has happened to. */
export const IDLE_ROW: RowState = { outcome: null, rejecting: false, draft: '' };

/** What the pending-review page shows. A change to any field redraws just what it feeds. */
export type ReviewsView = {
  /** The reviews waiting for a decision, in the order the host listed them. */
  views: ReviewView[];
  /** The state of each review's row, by review id. A row with no entry is {@link IDLE_ROW}. */
  readonly rows: SvelteMap<string, RowState>;
  /** What the polite live region says now. It outlives every change of the list. */
  announcement: string;
  /** A standing note above the list, or `null`. */
  notice: string | null;
};

/** A view the page updates and the component reads. */
export function createReviewsView(): ReviewsView {
  const view: ReviewsView = $state({
    views: [],
    rows: new SvelteMap<string, RowState>(),
    announcement: '',
    notice: null,
  });
  return view;
}
