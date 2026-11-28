/**
 * The preload clears TanStack Query's timers after every test, so a query a finished test fetched
 * is not kept alive for its five-minute `gcTime` (see `query-timers.ts`). The first test leaves a
 * query without observers on purpose; the second would still see its removal timer without the
 * preload's clearing.
 */
import { waitUntil } from '@lostgradient/testing/wait-until';
import { QueryClient, QueryObserver } from '@tanstack/svelte-query';
import { describe, expect, test } from 'bun:test';

import { pendingQueryTimers } from './query-timers.ts';

describe("TanStack Query's timers between tests", () => {
  test('a query that loses its last observer schedules its removal', async () => {
    const client = new QueryClient();
    const observer = new QueryObserver(client, {
      queryKey: ['between-tests'],
      queryFn: () => 'answered',
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await waitUntil(() => observer.getCurrentResult().status === 'success', {
      message: 'the query to answer',
    });
    unsubscribe();
    expect(pendingQueryTimers()).toBeGreaterThan(0);
  });

  test('the next test starts with none of them scheduled', () => {
    expect(pendingQueryTimers()).toBe(0);
  });
});
