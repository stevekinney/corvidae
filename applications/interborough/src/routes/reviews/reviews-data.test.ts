import { QueryClient, QueryObserver } from '@tanstack/svelte-query';
import { expect, test } from 'bun:test';
import { refreshObservedReviews } from './reviews-data.ts';

test('scope teardown quietly cancels both gone-review refreshes', async () => {
  const cache = new QueryClient();
  const refresh = (status: string) => () =>
    cache.fetchQuery({
      queryKey: ['reviews', status],
      queryFn: () => new Promise(() => {}),
      retry: false,
    });
  const pending = refreshObservedReviews(refresh('pending'), refresh('resolved'));
  await cache.cancelQueries({ queryKey: ['reviews'] });
  await pending;
});

test('a failed refresh remains visible to the query observer without an unhandled rejection', async () => {
  const cache = new QueryClient();
  const queryKey = ['reviews', 'pending'];
  const failure = new Error('refresh failed');
  const queryFn = async () => {
    throw failure;
  };
  cache.setQueryData(queryKey, []);
  const observer = new QueryObserver(cache, { queryKey, queryFn, staleTime: Infinity });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await refreshObservedReviews(() => cache.fetchQuery({ queryKey, queryFn, retry: false }));
    expect(observer.getCurrentResult().error).toBe(failure);
  } finally {
    unsubscribe();
  }
});
