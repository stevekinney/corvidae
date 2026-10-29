import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { QueryClient, QueryObserver } from '@tanstack/svelte-query';
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

  test('asks again a probe that has not answered yet, so an event during its first read is not lost', async () => {
    const queryClient = new QueryClient();
    const key = queryKeys.view('runs', null);
    let reads = 0;
    const release = Promise.withResolvers<{ empty: boolean }>();
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        reads += 1;
        return reads === 1 ? release.promise : Promise.resolve({ empty: false });
      },
    });
    const stop = observer.subscribe(() => {});
    await waitUntil(() => reads === 1, { message: 'the first read began' });

    invalidateEmptyViews(queryClient);

    await waitUntil(() => reads === 2, { message: 'the probe was asked again' });
    release.resolve({ empty: true });
    await waitUntil(() => observer.getCurrentResult().data?.empty === false, {
      message: 'the second answer stands',
    });
    stop();
  });

  test('leaves a probe that failed alone', async () => {
    const queryClient = new QueryClient();
    let reads = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.view('audit', null),
      queryFn: () => {
        reads += 1;
        return Promise.reject(new Error('The server broke.'));
      },
      retry: false,
    });
    const stop = observer.subscribe(() => {});
    await waitUntil(() => observer.getCurrentResult().isError, { message: 'the probe failed' });

    invalidateEmptyViews(queryClient);

    await quietFor(50);
    expect(reads).toBe(1);
    stop();
  });

  test('reads the answer’s own field, never an inherited one', () => {
    const queryClient = new QueryClient();
    const key = queryKeys.view('runs', null);
    queryClient.setQueryData(key, () => Object.create({ empty: true }) as object);

    invalidateEmptyViews(queryClient);

    expect(queryClient.getQueryState(key)?.isInvalidated).toBeFalsy();
  });
});
