/**
 * Route-level test for `/reviews`. The route holds no scope gate of its own: the Bureau answers the
 * caller its own reviews whatever the engine's scopes are, and what the principal may read of the
 * engine's reviews only decides whether they are listed beside them (`reviews-page.test.ts`). A
 * Bureau that refuses the caller is the view frame's `forbidden` state (`view-frame.test.ts`).
 * `reviews.integration.test.ts` covers the engine's data flow against a real engine.
 */
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';

import ReviewsTestHarness from './reviews-test-harness.test-harness.svelte';

/** Never resolves: this test asserts only what renders before any query settles. */
function pendingClient(): HttpClient {
  return new HttpClient({ baseUrl: 'http://localhost' });
}

describe('Reviews route', () => {
  test('names itself Reviews, and has no Archive to switch to', async () => {
    const { getByRole, queryByRole } = render(ReviewsTestHarness, {
      props: { client: pendingClient(), scopes: ['reviews:read', 'events:read'] },
    });

    expect(getByRole('heading', { level: 1, name: 'Reviews' })).not.toBeNull();
    expect(queryByRole('radio', { name: 'Archive' })).toBeNull();
    expect(queryByRole('radio', { name: 'Inbox' })).toBeNull();
  });

  test('is not locked for a principal without reviews:read, because the Bureau’s reviews need none', async () => {
    const { getByRole, queryByText } = render(ReviewsTestHarness, {
      props: { client: pendingClient(), scopes: [] },
    });

    expect(getByRole('heading', { level: 1, name: 'Reviews' })).not.toBeNull();
    expect(queryByText('Reviews are locked')).toBeNull();
    expect(queryByText('Requires reviews:read')).toBeNull();
  });
});
