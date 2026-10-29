/**
 * The views whose probe found nothing to list, asked again when the thing they list may have
 * arrived (COR-1725). A probe that answers `empty` is the one the frame used to ask on a timer
 * (`recheckMs`, `app/view-probes.ts`); an event that can add the first item asks it once instead.
 */
import type { Query, QueryClient } from '@tanstack/svelte-query';

import { queryKeys } from './query.ts';

/** The prefix every view probe is stored under (`queryKeys.view`). */
const VIEW_KEY_PREFIX = queryKeys.view('', null).slice(0, 1);

/** Whether a probe's cached answer says its view is empty. */
function isEmptyAnswer(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    Object.hasOwn(data, 'empty') &&
    Reflect.get(data, 'empty') === true
  );
}

/** Whether a probe is on its first read: it has no answer yet and is not a failure. */
function isFirstRead(query: Query): boolean {
  return query.state.data === undefined && query.state.status === 'pending';
}

/**
 * Asks again every view probe whose last answer was "empty", or that is still on its first read; a
 * view that has something to show is left alone. A read in flight began before the event, and
 * TanStack Query lets it finish when it has no answer yet (it cancels only a read that has one), so
 * it is cancelled first: its "empty" would otherwise stand, with the feed live and no timer to ask again.
 */
export function invalidateEmptyViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: VIEW_KEY_PREFIX,
    predicate: (query) => isEmptyAnswer(query.state.data),
  });
  void queryClient
    .cancelQueries({ queryKey: VIEW_KEY_PREFIX, predicate: isFirstRead })
    .then(() =>
      queryClient.invalidateQueries({ queryKey: VIEW_KEY_PREFIX, predicate: isFirstRead }),
    );
}
