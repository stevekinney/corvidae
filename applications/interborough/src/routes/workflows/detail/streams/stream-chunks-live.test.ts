/**
 * A stream's view reads again when the fleet feed announces one of its chunks (`stream:chunk`), and
 * on a timer only while that feed is not live and the run can still write (COR-1725). The feed is
 * the real source over a stubbed stream; the timer is the view's own, so the clock is faked and
 * moved by hand.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import type { WorkflowStatus } from '@lostgradient/weft';

import { settle, until } from '../../../../lib/fake-timers.test-support.ts';
import {
  createLiveFeeds,
  type LiveFeeds,
} from '../../../../lib/live-source/live-feeds.test-support.ts';
import { STREAM_POLL_INTERVAL_MS, type StreamChunksClient } from './stream-chunks-data.ts';
import StreamChunksViewHarness from './stream-chunks-view.test-harness.svelte';

let feeds: LiveFeeds | undefined;
let requests: Array<{ after?: unknown }>;
let stored: Array<{ sequence: number; value: unknown }>;

const client: StreamChunksClient = {
  operations: {
    'weft.workflows.streams.chunks': async (input) => {
      requests.push(input);
      const after = typeof input.after === 'number' ? input.after : -1;
      return { chunks: stored.filter((chunk) => chunk.sequence > after) };
    },
  },
};

beforeEach(() => {
  jest.useFakeTimers();
  requests = [];
  stored = [{ sequence: 0, value: 'first' }];
});

afterEach(() => {
  cleanup();
  feeds?.close();
  feeds = undefined;
  jest.useRealTimers();
});

function open(status: WorkflowStatus = 'running') {
  feeds = createLiveFeeds();
  return render(StreamChunksViewHarness, {
    props: {
      fleetEvents: feeds.fleetEvents,
      client,
      workflowId: 'wf-1',
      streamKey: 'progress',
      status,
      onClose: () => {},
    },
  } as never);
}

const chunkFrame = (workflowId: string, key: string, sequence: number) => ({
  workflowId,
  payload: { workflowId, key, sequence },
});

function shown(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('[data-chunk-sequence]')].map((element) =>
    Number(element.dataset['chunkSequence']),
  );
}

describe('a stream’s chunks', () => {
  test('are asked for on a timer while the feed is not live', async () => {
    open();
    await until(() => expect(requests).toHaveLength(1));

    await feeds?.passPolls(3, STREAM_POLL_INTERVAL_MS);

    expect(requests.length).toBeGreaterThanOrEqual(4);
  });

  test('are asked for on no timer while the feed is live, and once for each chunk of the stream', async () => {
    const { container } = open();
    await until(() => expect(requests).toHaveLength(1));
    await feeds?.fleetGoesLive();
    const before = requests.length;

    await feeds?.passPolls(5, STREAM_POLL_INTERVAL_MS);
    expect(requests).toHaveLength(before);

    stored = [...stored, { sequence: 1, value: 'second' }];
    await feeds?.fleetEvent('stream:chunk', chunkFrame('wf-1', 'progress', 1));
    await until(() => expect(requests).toHaveLength(before + 1));
    expect(requests.at(-1)?.after).toBe(0);
    await until(() => expect(shown(container)).toEqual([0, 1]));

    await feeds?.passPolls(2, STREAM_POLL_INTERVAL_MS);
    expect(requests).toHaveLength(before + 1);
  });

  test('are not asked for again by another run’s chunk, another key’s, or another kind of event', async () => {
    open();
    await until(() => expect(requests).toHaveLength(1));
    await feeds?.fleetGoesLive();
    const before = requests.length;

    await feeds?.fleetEvent('stream:chunk', chunkFrame('wf-2', 'progress', 1));
    await feeds?.fleetEvent('stream:chunk', chunkFrame('wf-1', 'other-key', 1));
    await feeds?.fleetEvent('activity:completed', chunkFrame('wf-1', 'progress', 1));
    await feeds?.fleetEvent('stream:chunk', { workflowId: 'wf-1', payload: null });
    await feeds?.passPolls(2, STREAM_POLL_INTERVAL_MS);

    expect(requests).toHaveLength(before);
  });

  test('are asked for again after a retention gap, which lost events the view cannot name', async () => {
    open();
    await until(() => expect(requests).toHaveLength(1));
    await feeds?.fleetGoesLive();
    const before = requests.length;

    await feeds?.fleetEvent('fleet:gap');

    await until(() => expect(requests).toHaveLength(before + 1));
  });

  test('are asked for once when two chunks arrive while a read is in flight, and the last is shown', async () => {
    const { container } = open();
    await until(() => expect(requests).toHaveLength(1));
    await feeds?.fleetGoesLive();
    const before = requests.length;

    stored = [...stored, { sequence: 1, value: 'second' }, { sequence: 2, value: 'third' }];
    await feeds?.fleetEvent('stream:chunk', chunkFrame('wf-1', 'progress', 1));
    await feeds?.fleetEvent('stream:chunk', chunkFrame('wf-1', 'progress', 2));

    await until(() => expect(shown(container)).toEqual([0, 1, 2]));
    expect(requests.length).toBeLessThanOrEqual(before + 2);
  });

  test('go back to the timer when the feed is lost', async () => {
    open();
    await until(() => expect(requests).toHaveLength(1));
    await feeds?.fleetGoesLive();
    feeds?.hub.end('fleet');
    await until(() => expect(feeds?.fleetEvents.status).toBe('reconnecting'));
    const before = requests.length;

    await feeds?.passPolls(3, STREAM_POLL_INTERVAL_MS);

    expect(requests.length).toBeGreaterThan(before);
  });

  test('are asked for on no timer once the run has ended, live or not, and the read of a finished run is one', async () => {
    open('completed');
    await until(() => expect(requests).toHaveLength(1));

    await feeds?.passPolls(4, STREAM_POLL_INTERVAL_MS);

    expect(requests).toHaveLength(1);
  });

  test('stop being asked for when the view is closed: its subscription goes with it', async () => {
    const view = open();
    await until(() => expect(requests).toHaveLength(1));
    // The shell’s own subscription keeps the connection open, as it does in the application.
    const keepOpen = feeds?.fleetEvents.subscribe(() => {});
    await feeds?.fleetGoesLive();
    const before = requests.length;

    view.unmount();
    await feeds?.fleetEvent('stream:chunk', chunkFrame('wf-1', 'progress', 1));
    await feeds?.passPolls(3, STREAM_POLL_INTERVAL_MS);
    await settle();

    expect(requests).toHaveLength(before);
    keepOpen?.();
  });
});
