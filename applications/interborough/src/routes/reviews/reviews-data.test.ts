import { QueryClient } from '@tanstack/svelte-query';
import { expect, test } from 'bun:test';
import { refreshGoneReviews } from './reviews-data.ts';

test('scope teardown quietly cancels both gone-review refreshes', async () => {
  const cache = new QueryClient();
  const refresh = (status: string) => () =>
    cache.fetchQuery({
      queryKey: ['reviews', status],
      queryFn: () => new Promise(() => {}),
      retry: false,
    });
  const pending = refreshGoneReviews(refresh('pending'), refresh('resolved'));
  await cache.cancelQueries({ queryKey: ['reviews'] });
  await pending;
});

test('a non-cancellation failure still reaches the caller', async () => {
  const failure = new Error('refresh failed');
  let caught: unknown;
  try {
    await refreshGoneReviews(
      async () => {
        throw failure;
      },
      async () => undefined,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(failure);
});
