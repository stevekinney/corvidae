import { QueryClient } from '@tanstack/svelte-query';
import { describe, expect, test } from 'bun:test';

import { invalidateEmptyViews } from './empty-views.ts';
import { queryKeys } from './query.ts';

describe('invalidateEmptyViews', () => {
  test('asks again every view whose probe found nothing, and no view that has something', () => {
    const queryClient = new QueryClient();
    const empty = queryKeys.view('runs', null);
    const emptyType = queryKeys.view('workflows', 'order-processing');
    const full = queryKeys.view('goals', null);
    const unanswered = queryKeys.view('audit', null);
    const elsewhere = queryKeys.goals.list();
    queryClient.setQueryData(empty, () => ({ empty: true, recheckMs: 5_000 }));
    queryClient.setQueryData(emptyType, () => ({ empty: true }));
    queryClient.setQueryData(full, () => ({ empty: false }));
    queryClient.setQueryData(unanswered, () => undefined);
    queryClient.setQueryData(elsewhere, () => ({ empty: true }));

    invalidateEmptyViews(queryClient);

    expect(queryClient.getQueryState(empty)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(emptyType)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(full)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(unanswered)?.isInvalidated).toBeFalsy();
    expect(queryClient.getQueryState(elsewhere)?.isInvalidated).toBeFalsy();
  });

  test('reads the answer’s own field, never an inherited one', () => {
    const queryClient = new QueryClient();
    const key = queryKeys.view('runs', null);
    queryClient.setQueryData(key, () => Object.create({ empty: true }) as object);

    invalidateEmptyViews(queryClient);

    expect(queryClient.getQueryState(key)?.isInvalidated).toBeFalsy();
  });
});
