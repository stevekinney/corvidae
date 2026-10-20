import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { tick } from 'svelte';

import { HttpClientError, type WorkflowStatus } from '@lostgradient/weft';

import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
import type { StreamChunksClient } from './stream-chunks-data.ts';
import StreamChunksView from './stream-chunks-view.svelte';

type Chunk = { sequence: number; value: unknown };

/** A fake server: it answers each request with the chunks the test has queued, and records the cursor it was asked for. */
function fakeClient(answers: Array<Chunk[] | Error>): {
  client: StreamChunksClient;
  requests: Array<{ workflowId: string; key: string; after?: unknown }>;
} {
  const requests: Array<{ workflowId: string; key: string; after?: unknown }> = [];
  const client: StreamChunksClient = {
    operations: {
      'weft.workflows.streams.chunks': async (input) => {
        requests.push(input);
        const answer = answers.shift() ?? [];
        if (answer instanceof Error) throw answer;
        return { chunks: answer };
      },
    },
  };
  return { client, requests };
}

/** Let promise continuations and Svelte's DOM flush run, without advancing the fake clock. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  await tick();
  for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
}

async function advance(milliseconds: number): Promise<void> {
  jest.advanceTimersByTime(milliseconds);
  await settle();
}

function renderView(
  client: StreamChunksClient,
  props: { status?: WorkflowStatus; streamKey?: string } = {},
) {
  return render(StreamChunksView, {
    props: {
      client,
      workflowId: 'wf-1',
      streamKey: props.streamKey ?? 'progress',
      status: props.status ?? 'running',
      onClose: () => {},
    },
  });
}

function sequences(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('[data-chunk-sequence]')].map((element) =>
    Number(element.dataset['chunkSequence']),
  );
}

afterEach(() => {
  jest.useRealTimers();
});

describe('StreamChunksView', () => {
  test('lists every stored chunk in order, asking without a cursor the first time', async () => {
    jest.useFakeTimers();
    const { client, requests } = fakeClient([
      [
        { sequence: 0, value: 'first' },
        { sequence: 1, value: { n: 2 } },
        { sequence: 2, value: 'third' },
      ],
    ]);
    const { container } = renderView(client, { status: 'completed' });
    await settle();

    expect(requests).toEqual([{ workflowId: 'wf-1', key: 'progress' }]);
    expect(sequences(container)).toEqual([0, 1, 2]);
    expect(container.textContent).toContain('first');
    expect(container.textContent).toContain('"n": 2');
    expect(container.querySelector('[data-state="ready"]')).not.toBeNull();
  });

  test('polls every 2 seconds for chunks after the last it holds, with none shown twice or skipped', async () => {
    jest.useFakeTimers();
    const { client, requests } = fakeClient([
      [
        { sequence: 0, value: 'a' },
        { sequence: 1, value: 'b' },
      ],
      [{ sequence: 2, value: 'c' }],
      // The server never repeats a chunk, but the view must not show one twice if it does.
      [
        { sequence: 2, value: 'c' },
        { sequence: 3, value: 'd' },
        { sequence: 4, value: 'e' },
      ],
      [],
    ]);
    const { container } = renderView(client);
    await settle();
    expect(sequences(container)).toEqual([0, 1]);

    await advance(1_999);
    expect(requests).toHaveLength(1);

    await advance(1);
    expect(sequences(container)).toEqual([0, 1, 2]);

    await advance(2_000);
    expect(sequences(container)).toEqual([0, 1, 2, 3, 4]);

    await advance(2_000);
    expect(sequences(container)).toEqual([0, 1, 2, 3, 4]);

    expect(requests.map((request) => request.after)).toEqual([undefined, 1, 2, 4]);
    expect(requests.every((request) => request.key === 'progress')).toBe(true);
  });

  test('makes no request once the run turns terminal', async () => {
    jest.useFakeTimers();
    const { client, requests } = fakeClient([
      [{ sequence: 0, value: 'a' }],
      [{ sequence: 1, value: 'b' }],
      [{ sequence: 2, value: 'c' }],
    ]);
    const { rerender } = renderView(client);
    await settle();
    await advance(2_000);
    expect(requests).toHaveLength(2);

    await rerender({
      client,
      workflowId: 'wf-1',
      streamKey: 'progress',
      status: 'completed',
      onClose: () => {},
    });
    await settle();
    await advance(10_000);

    expect(requests).toHaveLength(2);
  });

  test('stops polling when it is closed', async () => {
    jest.useFakeTimers();
    const { client, requests } = fakeClient([[{ sequence: 0, value: 'a' }], []]);
    const { unmount } = renderView(client);
    await settle();

    unmount();
    await advance(10_000);

    expect(requests).toHaveLength(1);
  });

  test('says there are no chunks for a run that is still going', async () => {
    jest.useFakeTimers();
    const { client } = fakeClient([[]]);
    const { container } = renderView(client, { status: 'running' });
    await settle();

    const empty = container.querySelector('[data-state="empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain(RUN_DETAIL_COPY.streams.noChunks);
    expect(empty?.textContent).not.toContain(RUN_DETAIL_COPY.streams.swept);
  });

  test('says there are no chunks for a completed run too', async () => {
    jest.useFakeTimers();
    for (const status of ['completed', 'failed', 'suspended'] as const) {
      const { client } = fakeClient([[]]);
      const { container, unmount } = renderView(client, { status });
      await settle();
      const empty = container.querySelector('[data-state="empty"]');
      expect(empty?.textContent).toContain(RUN_DETAIL_COPY.streams.noChunks);
      unmount();
    }
  });

  test('says the stream is no longer kept for a cancelled or timed-out run, whose chunks are swept', async () => {
    jest.useFakeTimers();
    for (const status of ['cancelled', 'timed-out'] as const) {
      const { client } = fakeClient([[]]);
      const { container, unmount } = renderView(client, { status });
      await settle();
      const empty = container.querySelector('[data-state="empty"]');
      expect(empty?.textContent).toContain(RUN_DETAIL_COPY.streams.swept);
      expect(empty?.textContent).not.toContain(RUN_DETAIL_COPY.streams.noChunks);
      unmount();
    }
  });

  test('shows a long key cut off, with the whole key in its title', async () => {
    jest.useFakeTimers();
    const longKey = `progress-of-the-nightly-reconciliation-${'x'.repeat(40)}`;
    const { client, requests } = fakeClient([[{ sequence: 0, value: 'a' }]]);
    const { container } = renderView(client, { streamKey: longKey, status: 'completed' });
    await settle();

    const label = container.querySelector<HTMLElement>('[data-stream-key]');
    expect(label?.getAttribute('title')).toBe(longKey);
    expect(label?.textContent?.length).toBeLessThanOrEqual(RUN_DETAIL_COPY.streams.keyDisplayLimit);
    expect(label?.textContent?.endsWith('…')).toBe(true);
    // The request still names the whole key.
    expect(requests[0]?.key).toBe(longKey);
  });

  test('shows a short key whole, with no title', async () => {
    jest.useFakeTimers();
    const { client } = fakeClient([[{ sequence: 0, value: 'a' }]]);
    const { container } = renderView(client, { streamKey: 'progress', status: 'completed' });
    await settle();

    const label = container.querySelector<HTMLElement>('[data-stream-key]');
    expect(label?.textContent).toBe('progress');
    expect(label?.hasAttribute('title')).toBe(false);
  });

  test('shows a fault in the fault banner and keeps the chunks it already holds', async () => {
    jest.useFakeTimers();
    const { client } = fakeClient([
      [{ sequence: 0, value: 'a' }],
      new HttpClientError(500, 'Internal server error'),
    ]);
    const { container } = renderView(client);
    await settle();
    await advance(2_000);

    const banner = container.querySelector('.weft-workflow-detail__fault-banner');
    expect(banner).not.toBeNull();
    expect(sequences(container)).toEqual([0]);
  });

  test('is a fault, not an empty stream, when the first read fails', async () => {
    jest.useFakeTimers();
    const { client } = fakeClient([new HttpClientError(500, 'Internal server error')]);
    const { container } = renderView(client, { status: 'completed' });
    await settle();

    expect(container.querySelector('[data-state="error"]')).not.toBeNull();
    expect(container.querySelector('.weft-workflow-detail__fault-banner')).not.toBeNull();
    expect(container.textContent).not.toContain(RUN_DETAIL_COPY.streams.noChunks);
    expect(container.querySelector('[data-state="empty"]')).toBeNull();
  });
});
