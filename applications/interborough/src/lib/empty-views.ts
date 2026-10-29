/**
 * The views whose probe found nothing to list, asked again when the thing they list may have
 * arrived (COR-1725). A probe that answers `empty` is the one the frame used to ask on a timer
 * (`recheckMs`, `app/view-probes.ts`); an event that can add the first item asks it once instead.
 */
import type { QueryClient } from '@tanstack/svelte-query';

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

/** Asks again every view probe whose last answer was "empty"; a view that has something to show is left alone. */
export function invalidateEmptyViews(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    queryKey: VIEW_KEY_PREFIX,
    predicate: (query) => isEmptyAnswer(query.state.data),
  });
}
