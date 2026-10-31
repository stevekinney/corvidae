import { describe, expect, test } from 'bun:test';

import { waitFor } from '@testing-library/svelte';

import { quietFor } from '@lostgradient/testing/wait-until';
import { ActivityFeedBatcher, type ActivityFeedRow } from './activity-feed-batcher.svelte.ts';

function row(overrides: Partial<ActivityFeedRow> = {}): ActivityFeedRow {
  const id = overrides.id ?? 'cursor-1';
  return {
    id,
    tier: 'info',
    icon: 'play',
    // Each id is its own headline, so these cases are about order and the window, not repeats.
    title: `Workflow ${id}`,
    body: 'Workflow wf_12345',
    href: '/runs/wf_1',
    emittedAtMs: 1_000,
    ...overrides,
  };
}

const FAST_WINDOW_MS = 5;

describe('ActivityFeedBatcher', () => {
  test('holds a window of six lines by default, the latest first', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) batcher.ingest(row({ id }));

    await waitFor(() => expect(batcher.items).toHaveLength(6));
    expect(batcher.items.map((item) => item.id)).toEqual(['h', 'g', 'f', 'e', 'd', 'c']);
    batcher.dispose();
  });

  test('collapses repeats in a row into one line with a count, keeping the newest', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'a', title: 'Daily summary run finished' }));
    batcher.ingest(row({ id: 'b', title: 'Daily summary run finished' }));
    batcher.ingest(row({ id: 'c', title: 'Alert fired' }));
    batcher.ingest(row({ id: 'd', title: 'Daily summary run finished' }));
    batcher.ingest(row({ id: 'e', title: 'Daily summary run finished' }));

    await waitFor(() => expect(batcher.items).toHaveLength(3));
    expect(batcher.items.map((item) => [item.id, item.count])).toEqual([
      ['e', 2],
      ['c', 1],
      ['b', 2],
    ]);
    batcher.dispose();
  });

  test('keeps a repeat across a later flush, and never merges rows of different severity', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'a', title: 'Workflow failed', tier: 'warning' }));
    await waitFor(() => expect(batcher.items).toHaveLength(1));
    batcher.ingest(row({ id: 'b', title: 'Workflow failed', tier: 'warning' }));
    await waitFor(() => expect(batcher.items[0]?.count).toBe(2));
    batcher.ingest(row({ id: 'c', title: 'Workflow failed', tier: 'critical' }));

    await waitFor(() => expect(batcher.items).toHaveLength(2));
    expect(batcher.items.map((item) => [item.id, item.count])).toEqual([
      ['c', 1],
      ['b', 2],
    ]);
    batcher.dispose();
  });

  test('seed() starts an empty window from rows that already happened, oldest first', () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.seed([
      row({ id: 'a', title: 'Alert fired' }),
      row({ id: 'b', title: 'Run finished' }),
      row({ id: 'c', title: 'Run finished' }),
    ]);

    expect(batcher.items.map((item) => [item.id, item.count])).toEqual([
      ['c', 2],
      ['a', 1],
    ]);
    batcher.dispose();
  });

  test('seed() leaves a window that already has lines alone', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'live' }));
    await waitFor(() => expect(batcher.items).toHaveLength(1));

    batcher.seed([row({ id: 'old' })]);

    expect(batcher.items.map((item) => item.id)).toEqual(['live']);
    batcher.dispose();
  });

  test('resume() folds held repeats into the line on screen', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'a', title: 'Run finished' }));
    await waitFor(() => expect(batcher.items).toHaveLength(1));
    batcher.pause();
    batcher.ingest(row({ id: 'b', title: 'Run finished' }));
    await waitFor(() => expect(batcher.pendingCount).toBe(1));

    batcher.resume();

    expect(batcher.items.map((item) => [item.id, item.count])).toEqual([['b', 2]]);
    batcher.dispose();
  });

  test('starts empty, not paused', () => {
    const batcher = new ActivityFeedBatcher();
    expect(batcher.items).toEqual([]);
    expect(batcher.pendingCount).toBe(0);
    expect(batcher.paused).toBe(false);
    batcher.dispose();
  });

  test('flushes an ingested row into items after the batch window', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'a' }));

    await waitFor(() => expect(batcher.items).toHaveLength(1));
    expect(batcher.items[0]?.id).toBe('a');
    batcher.dispose();
  });

  test('coalesces multiple rows ingested within one window into a single flush, newest first', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'a' }));
    batcher.ingest(row({ id: 'b' }));
    batcher.ingest(row({ id: 'c' }));

    await waitFor(() => expect(batcher.items).toHaveLength(3));
    expect(batcher.items.map((item) => item.id)).toEqual(['c', 'b', 'a']);
    batcher.dispose();
  });

  test('caps visible items at the configured limit', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS, visibleCap: 2 });
    batcher.ingest(row({ id: 'a' }));
    await waitFor(() => expect(batcher.items).toHaveLength(1));
    batcher.ingest(row({ id: 'b' }));
    await waitFor(() => expect(batcher.items).toHaveLength(2));
    batcher.ingest(row({ id: 'c' }));

    await waitFor(() => expect(batcher.items.map((item) => item.id)).toEqual(['c', 'b']));
    batcher.dispose();
  });

  test('while paused, ingested rows accumulate as pendingCount instead of appending to items', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.pause();
    batcher.ingest(row({ id: 'a' }));
    batcher.ingest(row({ id: 'b' }));

    await waitFor(() => expect(batcher.pendingCount).toBe(2));
    expect(batcher.items).toEqual([]);
    batcher.dispose();
  });

  test('resume() flushes held rows into items and clears pendingCount', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.pause();
    batcher.ingest(row({ id: 'a' }));
    await waitFor(() => expect(batcher.pendingCount).toBe(1));

    batcher.resume();

    expect(batcher.paused).toBe(false);
    expect(batcher.pendingCount).toBe(0);
    expect(batcher.items.map((item) => item.id)).toEqual(['a']);
    batcher.dispose();
  });

  test('resume() with nothing held is a no-op beyond unpausing', () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.pause();
    batcher.resume();
    expect(batcher.paused).toBe(false);
    expect(batcher.items).toEqual([]);
    batcher.dispose();
  });

  test('rows ingested after resume append normally', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.pause();
    batcher.ingest(row({ id: 'a' }));
    await waitFor(() => expect(batcher.pendingCount).toBe(1));
    batcher.resume();

    batcher.ingest(row({ id: 'b' }));
    await waitFor(() => expect(batcher.items.map((item) => item.id)).toEqual(['b', 'a']));
    batcher.dispose();
  });

  test('dispose() cancels a pending flush so it never lands', async () => {
    const batcher = new ActivityFeedBatcher({ batchWindowMs: FAST_WINDOW_MS });
    batcher.ingest(row({ id: 'a' }));
    batcher.dispose();

    await quietFor(FAST_WINDOW_MS * 3);
    expect(batcher.items).toEqual([]);
  });
});
