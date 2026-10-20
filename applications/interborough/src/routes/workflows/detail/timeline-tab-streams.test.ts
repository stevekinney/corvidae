import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import type { FleetEventFrame } from '../../../lib/live-source/fleet-event-source.svelte.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf-1',
    type: 'streamer',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 1,
    operationType: 'activity',
    operationLabel: 'doThing',
    inputSummary: '{}',
    timestamp: 1_000,
    status: 'completed',
    ...overrides,
  };
}

class InertFleet {
  caughtUp = false;
  subscribe(_onFrame: (frame: FleetEventFrame) => void): () => void {
    return () => {};
  }
}

function streamEntry(step: number, key: string): WorkflowTimelineEntry {
  return entry({
    step,
    operationType: 'stream',
    operationLabel: key,
    inputSummary: JSON.stringify({ key }),
  });
}

function clientWith(entries: WorkflowTimelineEntry[], chunks: Record<string, unknown[]> = {}) {
  const requests: Array<{ key: string; after?: unknown }> = [];
  return {
    requests,
    client: {
      getTimeline: async () => entries,
      operations: {
        'weft.workflows.activities.pending.list': async () => ({ items: [] }),
        'weft.workflows.streams.chunks': async (input: { key: string; after?: unknown }) => {
          requests.push({
            key: input.key,
            ...(input.after === undefined ? {} : { after: input.after }),
          });
          return {
            chunks: (chunks[input.key] ?? []).map((value, sequence) => ({ sequence, value })),
          };
        },
      },
      activity: { complete: async () => {}, completeExceptionally: async () => {} },
    },
  };
}

function renderTimeline(
  client: ReturnType<typeof clientWith>['client'],
  props: { canReadStreams?: boolean; status?: WorkflowState['status'] } = {},
) {
  return render(TimelineTabHarness, {
    props: {
      client,
      workflow: workflow({ status: props.status ?? 'completed' }),
      liveObservations: new WorkflowLiveObservations(
        new InertFleet(),
        new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        'wf-1',
      ),
      finalizerStatus: null,
      canReadStreams: props.canReadStreams ?? true,
    },
  });
}

describe('TimelineTab stream links', () => {
  test('links each stream step to a view listing its stored chunks in order', async () => {
    const { client, requests } = clientWith(
      [
        entry({ step: 0, operationLabel: 'prepare' }),
        streamEntry(1, 'progress'),
        streamEntry(2, 'audit-log'),
      ],
      { progress: ['starting', 'halfway', 'done'], 'audit-log': ['x'] },
    );
    const { findByRole, getByRole, queryByRole, container, findByText } = renderTimeline(client);

    const link = await findByRole('button', { name: 'View chunks of progress' });
    expect(getByRole('button', { name: 'View chunks of audit-log' })).not.toBeNull();
    // Nothing is read until a stream is opened.
    expect(requests).toEqual([]);

    await fireEvent.click(link);

    await findByText('halfway');
    const sequences = [...container.querySelectorAll<HTMLElement>('[data-chunk-sequence]')].map(
      (element) => element.dataset['chunkSequence'],
    );
    expect(sequences).toEqual(['0', '1', '2']);
    expect(requests).toEqual([{ key: 'progress' }]);
    expect(container.querySelector('[data-stream-key]')?.textContent).toBe('progress');

    // The step that is not a stream has no link.
    expect(queryByRole('button', { name: 'View chunks of prepare' })).toBeNull();
  });

  test('switches to another stream, and closes the view', async () => {
    const { client } = clientWith([streamEntry(1, 'progress'), streamEntry(2, 'audit-log')], {
      progress: ['starting'],
      'audit-log': ['entry-one'],
    });
    const { findByRole, findByText, queryByText, container } = renderTimeline(client);

    await fireEvent.click(await findByRole('button', { name: 'View chunks of progress' }));
    await findByText('starting');
    await fireEvent.click(await findByRole('button', { name: 'View chunks of audit-log' }));
    await findByText('entry-one');
    expect(queryByText('starting')).toBeNull();

    await fireEvent.click(await findByRole('button', { name: 'Close' }));
    await waitFor(() => expect(container.querySelector('[data-stream-key]')).toBeNull());
  });

  test('renders no stream link without streams:read', async () => {
    const { client, requests } = clientWith([streamEntry(1, 'progress')], { progress: ['a'] });
    const { findByText, queryByRole } = renderTimeline(client, { canReadStreams: false });

    // The timeline itself renders.
    await findByText('Stream');
    expect(queryByRole('button', { name: /View chunks/ })).toBeNull();
    expect(requests).toEqual([]);
  });

  test('renders no stream link for a run with no stream operations', async () => {
    const { client } = clientWith([
      entry({ step: 0, operationLabel: 'prepare' }),
      entry({ step: 1, operationType: 'sleep', operationLabel: 'sleep', status: 'completed' }),
    ]);
    const { findByText, queryByRole } = renderTimeline(client);

    await findByText('prepare');
    expect(queryByRole('button', { name: /View chunks/ })).toBeNull();
  });
});
