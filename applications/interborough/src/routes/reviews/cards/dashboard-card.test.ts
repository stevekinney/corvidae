/**
 * Component tests for the Reviews dashboard card (plan §9.5: "Dashboard
 * card … pending count + nearest deadline").
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { HttpClient, type PendingReviewEntry } from '@lostgradient/weft';

import { router } from '../../../lib/router.svelte.ts';
import DashboardCardHarness from './dashboard-card-test-harness.test-harness.svelte';

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function pendingEntry(reviewId: string, createdAt: number, timeout: number): PendingReviewEntry {
  return {
    status: 'pending',
    reviewId,
    workflowId: `wf-${reviewId}`,
    artifact: {},
    reviewType: 'content',
    reviewers: ['ops@example.com'],
    allowPartial: false,
    createdAt,
    timeout,
  };
}

function clientReturning(entries: PendingReviewEntry[]): HttpClient {
  const client = new HttpClient({ baseUrl: 'http://localhost' });
  Object.defineProperty(client, 'listReviews', { value: async () => entries });
  return client;
}

describe('Reviews dashboard card', () => {
  test('shows a lock state when reviews:read is not granted', async () => {
    const { getByText } = render(DashboardCardHarness, {
      props: { client: clientReturning([]), scopes: [] },
    });

    expect(getByText('Locked')).not.toBeNull();
    expect(getByText('Requires reviews:read')).not.toBeNull();
  });

  test('shows the pending count and nearest deadline', async () => {
    const now = Date.now();
    const { getByText, findByText } = render(DashboardCardHarness, {
      props: {
        client: clientReturning([
          pendingEntry('r1', now - 60_000, 10 * 60_000),
          pendingEntry('r2', now - 60_000, 60 * 60_000),
        ]),
      },
    });

    expect(await findByText('2')).not.toBeNull();
    expect(getByText('Pending')).not.toBeNull();
    expect(getByText('Nearest deadline')).not.toBeNull();
  });

  test('shows an em dash when no pending review has a deadline', async () => {
    const now = Date.now();
    const noDeadlineEntry: PendingReviewEntry = {
      status: 'pending',
      reviewId: 'r1',
      workflowId: 'wf-r1',
      artifact: {},
      reviewType: 'content',
      reviewers: ['ops@example.com'],
      allowPartial: false,
      createdAt: now,
    };
    const { getByText, findByText } = render(DashboardCardHarness, {
      props: { client: clientReturning([noDeadlineEntry]) },
    });

    expect(await findByText('1')).not.toBeNull();
    expect(getByText('—')).not.toBeNull();
  });

  test('is titled as the engine’s reviews, because it counts no Bureau review', async () => {
    const { container } = render(DashboardCardHarness, {
      props: { client: clientReturning([]) },
    });

    expect(container.querySelector('.weft-dashboard-card__title')?.textContent).toBe(
      'Workflow reviews',
    );
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe('Workflow reviews');
  });

  test('links to /reviews', async () => {
    const { container } = render(DashboardCardHarness, {
      props: { client: clientReturning([]) },
    });

    expect(container.querySelector('a')?.getAttribute('href')).toBe('/reviews');
  });

  test('a plain click routes to /reviews in place; a modified click is left to the browser', async () => {
    landAt('/');
    const { container } = render(DashboardCardHarness, {
      props: { client: clientReturning([]) },
    });
    const link = container.querySelector('a');
    if (link === null) throw new Error('Expected the card to render its link');

    expect(await fireEvent.click(link, { button: 0, metaKey: true })).toBe(true);
    expect(router.pathname).toBe('/');

    expect(await fireEvent.click(link, { button: 0 })).toBe(false);
    expect(router.pathname).toBe('/reviews');
  });
});
