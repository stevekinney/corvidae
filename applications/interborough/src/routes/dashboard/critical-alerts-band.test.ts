/**
 * Component tests for `<CriticalAlertsBand>` (plan §9.1, this track's
 * brief). Covers rendered chips, the both-scopes-denied lock state, and the
 * 403-degrades-the-principal path (plan §6). Its local client double avoids
 * mutating `globalThis.fetch`, which must remain isolated while Bun executes
 * component tests in parallel.
 */
import { notifyManager, type QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, spyOn, test } from 'bun:test';
import { tick } from 'svelte';

import { HttpClient, HttpClientError } from '@lostgradient/weft';

import { invalidateForTaskEvent } from '../../app/task-event-queries.ts';
import { router } from '../../lib/router.svelte.ts';
import { TASK_HEARTBEAT_STALE_AFTER_MS } from '../workers/worker-catalog-types.ts';
import CriticalAlertsBandHarness from './critical-alerts-band-test-harness.test-harness.svelte';

// This component waits for two independently scheduled TanStack Query
// observers. Keep the established full-suite window rather than depending on
// Testing Library's 1-second default while Bun is executing other files.
const WAIT_FOR_TWO_QUERIES = { timeout: 3_000 };

async function waitForSettledQueries(queryClient: QueryClient): Promise<void> {
  if (queryClient.isFetching() > 0) {
    await new Promise<void>((resolve) => {
      const unsubscribe = queryClient.getQueryCache().subscribe(() => {
        if (queryClient.isFetching() === 0) {
          unsubscribe();
          resolve();
        }
      });
    });
  }
  await new Promise<void>((resolve) => notifyManager.schedule(resolve));
  await tick();
}

const EMPTY_DIAGNOSTICS_SUMMARY = {
  stuckQueued: 0,
  staleInflight: 0,
  retryStorms: 0,
  allWorkersAtCapacity: 0,
  deadLettered: 0,
  delayed: 0,
  unadoptedTerminal: 0,
};

function alertClient(options: {
  diagnostics: unknown;
  reviews: unknown;
  diagnosticsInputs?: unknown[];
}): HttpClient {
  const client = new HttpClient({ baseUrl: 'http://weft.test/api' });
  Object.defineProperty(client, 'operations', {
    value: {
      'weft.tasks.diagnostics': (input: unknown) => {
        options.diagnosticsInputs?.push(input);
        return options.diagnostics instanceof HttpClientError
          ? Promise.reject(options.diagnostics)
          : Promise.resolve(options.diagnostics);
      },
    },
  });
  Object.defineProperty(client, 'listReviews', { value: () => Promise.resolve(options.reviews) });
  return client;
}

describe('CriticalAlertsBand', () => {
  test('renders nothing when diagnostics are clean and no reviews are near timeout', async () => {
    const client = alertClient({
      diagnostics: { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY, limit: 50 },
      reviews: [],
    });

    let queryClient!: QueryClient;
    const { container, queryByLabelText } = render(CriticalAlertsBandHarness, {
      props: { client, onQueryClientReady: (value) => (queryClient = value) },
    });

    await waitForSettledQueries(queryClient);
    expect(queryByLabelText('Loading alerts')).toBeNull();
    expect(container.textContent).toBe('');
  });

  test('asks for stale heartbeats at the Workers route threshold', async () => {
    const diagnosticsInputs: unknown[] = [];
    const client = alertClient({
      diagnostics: { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY, limit: 50 },
      reviews: [],
      diagnosticsInputs,
    });

    let queryClient!: QueryClient;
    render(CriticalAlertsBandHarness, {
      props: { client, onQueryClientReady: (value) => (queryClient = value) },
    });

    await waitForSettledQueries(queryClient);
    expect(diagnosticsInputs).toEqual([
      expect.objectContaining({ staleHeartbeatAfterMs: TASK_HEARTBEAT_STALE_AFTER_MS }),
    ]);
  });

  test('keeps the loading skeleton visible until both alert queries settle', async () => {
    let resolveReviews!: (reviews: unknown) => void;
    const reviews = new Promise<unknown>((resolve) => {
      resolveReviews = resolve;
    });
    const client = alertClient({
      diagnostics: { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY, limit: 50 },
      reviews,
    });

    let queryClient!: QueryClient;
    const { queryByLabelText } = render(CriticalAlertsBandHarness, {
      props: { client, onQueryClientReady: (value) => (queryClient = value) },
    });

    expect(queryByLabelText('Loading alerts')).not.toBeNull();

    resolveReviews([]);

    await waitForSettledQueries(queryClient);
    expect(queryByLabelText('Loading alerts')).toBeNull();
  });

  test('renders a diagnostic chip that deep-links to the workers queue view', async () => {
    const client = alertClient({
      diagnostics: {
        items: [],
        summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 3 },
        limit: 50,
      },
      reviews: [],
    });

    const { getByText } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () => expect(getByText('3 dead-lettered tasks')).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );
    const link = getByText('3 dead-lettered tasks').closest('a');
    expect(link?.getAttribute('href')).toBe('/workers?diagnostic=deadLettered');
  });

  test('a chip whose items all belong to one workflow also links to that run', async () => {
    const client = alertClient({
      diagnostics: {
        items: [
          {
            kind: 'dead-lettered',
            state: 'dead-lettered',
            operationId: 'op-1',
            workflowId: 'wf-owner',
            retryCount: 0,
            requeueCount: 0,
            evidence: [],
          },
        ],
        summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
        limit: 50,
      },
      reviews: [],
    });

    const { getByText, getByRole } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () => expect(getByText('1 dead-lettered task')).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );
    expect(getByText('1 dead-lettered task').closest('a')?.getAttribute('href')).toBe(
      '/workers?diagnostic=deadLettered',
    );
    expect(getByRole('link', { name: 'Open workflow wf-owner' }).getAttribute('href')).toBe(
      '/runs/wf-owner',
    );

    const navigate = spyOn(router, 'navigate').mockImplementation(() => {});
    try {
      await fireEvent.click(getByRole('link', { name: 'Open workflow wf-owner' }));
      expect(navigate).toHaveBeenCalledWith('/runs/wf-owner');
    } finally {
      navigate.mockRestore();
    }
  });

  test('renders a reviews-near-timeout chip that deep-links to /reviews', async () => {
    const now = Date.now();
    const client = alertClient({
      diagnostics: { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY, limit: 50 },
      reviews: [
        {
          status: 'pending',
          reviewId: 'review-1',
          workflowId: 'wf-1',
          artifact: {},
          reviewType: 'content',
          reviewers: ['alice@example.com'],
          allowPartial: false,
          createdAt: now - 950_000,
          timeout: 1_000_000,
        },
      ],
    });

    const { getByText } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () => expect(getByText('1 review near timeout')).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );
    const link = getByText('1 review near timeout').closest('a');
    expect(link?.getAttribute('href')).toBe('/reviews');
  });

  test('shows a lock notice instead of chips when both scopes are denied', async () => {
    const client = alertClient({
      diagnostics: { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY, limit: 50 },
      reviews: [],
    });

    const { getByText } = render(CriticalAlertsBandHarness, {
      props: { client, scopes: [] },
    });

    await waitFor(() =>
      expect(
        getByText('Requires system:read, reviews:read to see critical alerts here.'),
      ).not.toBeNull(),
    );
  });

  test('a 403 from diagnostics degrades to a partial lock note while reviews chips still render', async () => {
    const now = Date.now();
    const client = alertClient({
      diagnostics: new HttpClientError(403, 'Forbidden'),
      reviews: [
        {
          status: 'pending',
          reviewId: 'review-1',
          workflowId: 'wf-1',
          artifact: {},
          reviewType: 'content',
          reviewers: ['alice@example.com'],
          allowPartial: false,
          createdAt: now - 950_000,
          timeout: 1_000_000,
        },
      ],
    });

    const { getByText } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () => expect(getByText('1 review near timeout')).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );
    expect(getByText('Requires system:read')).not.toBeNull();
  });

  test('a 403 from reviews preserves diagnostic chips and reports the reviews lock note', async () => {
    const client = alertClient({
      diagnostics: {
        items: [],
        summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 3 },
        limit: 50,
      },
      reviews: Promise.reject(new HttpClientError(403, 'Forbidden')),
    });

    const { getByText } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () => expect(getByText('3 dead-lettered tasks')).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );
    expect(getByText('Requires reviews:read')).not.toBeNull();
  });

  test('two forbidden alert queries settle on the combined lock notice', async () => {
    const client = alertClient({
      diagnostics: new HttpClientError(403, 'Forbidden'),
      reviews: Promise.reject(new HttpClientError(403, 'Forbidden')),
    });

    const { getByText } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () =>
        expect(
          getByText('Requires system:read, reviews:read to see critical alerts here.'),
        ).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );
  });

  test('alert chips handle clicks through the client router', async () => {
    const now = Date.now();
    const client = alertClient({
      diagnostics: {
        items: [],
        summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 3 },
        limit: 50,
      },
      reviews: [
        {
          status: 'pending',
          reviewId: 'review-1',
          workflowId: 'wf-1',
          artifact: {},
          reviewType: 'content',
          reviewers: ['alice@example.com'],
          allowPartial: false,
          createdAt: now - 950_000,
          timeout: 1_000_000,
        },
      ],
    });

    const { getByText } = render(CriticalAlertsBandHarness, { props: { client } });

    await waitFor(
      () => expect(getByText('3 dead-lettered tasks')).not.toBeNull(),
      WAIT_FOR_TWO_QUERIES,
    );

    const diagnosticLink = getByText('3 dead-lettered tasks').closest('a');
    const reviewLink = getByText('1 review near timeout').closest('a');
    expect(
      diagnosticLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(
      reviewLink?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    ).toBe(false);
  });

  test('a task:dead-lettered event refreshes the dead-letter chip without waiting for the poll', async () => {
    let diagnostics: unknown = { items: [], summary: EMPTY_DIAGNOSTICS_SUMMARY, limit: 50 };
    const client = new HttpClient({ baseUrl: 'http://weft.test/api' });
    Object.defineProperty(client, 'operations', {
      value: { 'weft.tasks.diagnostics': () => Promise.resolve(diagnostics) },
    });
    Object.defineProperty(client, 'listReviews', { value: () => Promise.resolve([]) });

    let queryClient!: QueryClient;
    const { container, findByText } = render(CriticalAlertsBandHarness, {
      props: { client, onQueryClientReady: (value) => (queryClient = value) },
    });
    await waitForSettledQueries(queryClient);
    expect(container.textContent).toBe('');

    // The server dead-letters a result; the fleet feed's event is all the band hears.
    diagnostics = {
      items: [],
      summary: { ...EMPTY_DIAGNOSTICS_SUMMARY, deadLettered: 1 },
      limit: 50,
    };
    invalidateForTaskEvent(queryClient, {
      kind: 'task:dead-lettered',
      sequence: 7,
      cursor: '7',
      emittedAtMs: 1,
      payload: { operationId: 'op_dead' },
    });

    expect(await findByText('1 dead-lettered task')).not.toBeNull();
  });
});
