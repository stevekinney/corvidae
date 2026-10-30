import { QueryClient } from '@tanstack/svelte-query';
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { flushSync } from 'svelte';

import type { WorkflowEvent, WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';

import { workflowEventsKey } from '../../../lib/live-source/cache-integration.ts';
import { installFetchImplementation } from '../../../lib/live-source/fetch.test-support.ts';
import EventsTabHarness from './events-tab.test-harness.svelte';
import {
  selectTimelineStep,
  timelineSelectionFor,
} from './timeline/timeline-selection-store.svelte.ts';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'order-fulfillment',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

/** Answers the live tail's SSE request with a quiet stream that completes its replay and then stays open, closing when the tail aborts — enough to exercise the wiring without needing the reconnect surface (covered by `src/lib/live-source/workflow-tail-source.test.ts`). */
function quietTailResponse(signal: AbortSignal | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `event: ping\ndata: ${JSON.stringify({ emittedAtMs: 0, replayComplete: true })}\n\n`,
        ),
      );
      signal?.addEventListener('abort', () => controller.close(), { once: true });
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

let restoreFetch: () => void;

beforeEach(() => {
  restoreFetch = installFetchImplementation(async (_input, init) =>
    quietTailResponse(init?.signal ?? undefined),
  );
});

afterEach(() => {
  restoreFetch();
});

function client(events: WorkflowEvent[] = []) {
  return {
    getEvents: async (): Promise<WorkflowEvent[]> => events,
    getTimeline: async (): Promise<WorkflowTimelineEntry[]> => [],
    baseUrl: 'http://weft.test',
    headers: {},
  };
}

describe('EventsTab', () => {
  test('renders checkpoint events honestly as "Checkpoint · step N"', async () => {
    const events: WorkflowEvent[] = [
      { type: 'workflow:checkpoint', timestamp: 1_000, data: { step: 1 } },
      { type: 'workflow:checkpoint', timestamp: 2_000, data: { step: 2 } },
    ];

    const { getByText } = render(EventsTabHarness, {
      props: { client: client(events), workflow: workflow() },
    });

    await waitFor(() => {
      expect(getByText('Checkpoint · step 1')).not.toBeNull();
    });
    expect(getByText('Checkpoint · step 2')).not.toBeNull();
    expect(getByText('2 events')).not.toBeNull();
  });

  test('shows an empty count with no events', async () => {
    const { getByText } = render(EventsTabHarness, {
      props: { client: client([]), workflow: workflow() },
    });

    await waitFor(() => {
      expect(getByText('0 events')).not.toBeNull();
    });
  });

  test('Live defaults on for a running workflow and can be paused', async () => {
    const { getByRole } = render(EventsTabHarness, {
      props: { client: client([]), workflow: workflow({ status: 'running' }) },
    });

    await waitFor(() => {
      expect(getByRole('button', { name: 'Live' })).not.toBeNull();
    });
    await fireEvent.click(getByRole('button', { name: 'Live' }));
    expect(getByRole('button', { name: 'Paused' })).not.toBeNull();
  });

  test('Live defaults off for a terminal workflow', async () => {
    const { getByRole } = render(EventsTabHarness, {
      props: { client: client([]), workflow: workflow({ status: 'completed' }) },
    });

    expect(getByRole('button', { name: 'Paused' })).not.toBeNull();
  });

  test('a Timeline-tab step selection filters the events tab to matching rows, and Clear restores them', async () => {
    const events: WorkflowEvent[] = [
      { type: 'workflow:checkpoint', timestamp: 1_000, data: { step: 1 } },
      { type: 'workflow:checkpoint', timestamp: 2_000, data: { step: 2 } },
    ];
    const wf = workflow({ id: 'wf_events_selection_1' });

    // Simulate the Timeline tab having already selected step 2 — the
    // linked-selection store is shared module state (see that module's
    // doc), so setting it here is equivalent to a click over there.
    timelineSelectionFor(wf.id);
    selectTimelineStep('step-2');

    const { getByText, getByRole, queryByText } = render(EventsTabHarness, {
      props: { client: client(events), workflow: wf },
    });

    await waitFor(() => {
      expect(getByText('step: 2')).not.toBeNull();
      expect(getByText('Checkpoint · step 2')).not.toBeNull();
    });
    expect(queryByText('Checkpoint · step 1')).toBeNull();
    expect(getByText('1 events')).not.toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Clear step filter' }));

    flushSync();
    expect(queryByText('step: 2')?.outerHTML ?? null).toBeNull();
    expect(getByText('Checkpoint · step 1')).not.toBeNull();
    expect(getByText('2 events')).not.toBeNull();
  });

  test('Download menu offers both export options', async () => {
    const { getByRole, getByText } = render(EventsTabHarness, {
      props: { client: client([]), workflow: workflow() },
    });

    await fireEvent.click(getByRole('button', { name: /Download/ }));

    await waitFor(() => {
      expect(getByText('Event history · JSON')).not.toBeNull();
    });
    expect(getByText('Events + timeline · JSON')).not.toBeNull();
  });

  test('renders "No events to display." once loaded with no events', async () => {
    const { getByText } = render(EventsTabHarness, {
      props: { client: client([]), workflow: workflow() },
    });

    await waitFor(() => {
      const emptyState = getByText('No events to display.');
      expect(emptyState.getAttribute('role')).toBe('status');
      expect(emptyState.parentElement?.tagName).toBe('LI');
      expect(emptyState.parentElement?.parentElement?.tagName).toBe('OL');
    });
  });

  test('a non-checkpoint event renders its raw type as the summary', async () => {
    const events: WorkflowEvent[] = [
      { type: 'workflow:started', timestamp: 1_000, data: { reason: 'kickoff' } },
    ];

    const { getByText } = render(EventsTabHarness, {
      props: { client: client(events), workflow: workflow() },
    });

    await waitFor(() => expect(getByText('workflow:started')).not.toBeNull());
  });

  test('a refetch after tail frames keeps the lifecycle rows and takes the fresh checkpoints', async () => {
    restoreFetch();
    restoreFetch = installFetchImplementation(async (_input, init) => {
      const frames = [
        `event: ping\ndata: ${JSON.stringify({ emittedAtMs: 0, replayComplete: true })}\n\n`,
        `id: 0\ndata: ${JSON.stringify({
          kind: 'workflow:started',
          workflowId: 'wf_1',
          selector: 'events',
          sequence: 0,
          cursor: '0',
          emittedAtMs: 1_500,
          payload: { reason: 'kickoff' },
        })}\n\n`,
      ];
      const signal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame));
          signal?.addEventListener('abort', () => controller.close(), { once: true });
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const checkpoints: WorkflowEvent[] = [
      { type: 'workflow:checkpoint', timestamp: 1_000, data: { step: 1 } },
    ];
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { getByText } = render(EventsTabHarness, {
      props: { client: client(checkpoints), workflow: workflow(), queryClient },
    });
    await waitFor(() => expect(getByText('workflow:started')).not.toBeNull());
    expect(getByText('Checkpoint · step 1')).not.toBeNull();

    // A window-focus or reconnect refetch, with a checkpoint committed in the meantime.
    checkpoints.push({ type: 'workflow:checkpoint', timestamp: 2_000, data: { step: 2 } });
    await queryClient.refetchQueries({ queryKey: workflowEventsKey('wf_1') });

    await waitFor(() => expect(getByText('Checkpoint · step 2')).not.toBeNull());
    expect(getByText('workflow:started')).not.toBeNull();
    expect(getByText('Checkpoint · step 1')).not.toBeNull();
  });

  test('an event with a data payload renders a Details collapsible trigger', async () => {
    // Cinder's `Collapsible` toggles via a `transition:` directive whose
    // lifecycle event dispatch happy-dom can't construct cross-realm — no
    // test in this repo drives a transitioning Cinder trigger via
    // `fireEvent.click` (see `advanced-options.test.ts`'s identical note).
    // This only asserts the trigger itself renders (the `entry.details !==
    // undefined` branch), not the post-expand content.
    const events: WorkflowEvent[] = [
      { type: 'workflow:checkpoint', timestamp: 1_000, data: { step: 1, note: 'first' } },
    ];

    const { getByRole } = render(EventsTabHarness, {
      props: { client: client(events), workflow: workflow() },
    });

    await waitFor(() => expect(getByRole('button', { name: /Details/ })).not.toBeNull());
  });

  test('clicking "Event history · JSON" downloads the events export', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = mock(() => 'blob:mock-url');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = mock(() => {});

    try {
      const events: WorkflowEvent[] = [
        { type: 'workflow:checkpoint', timestamp: 1_000, data: { step: 1 } },
      ];
      const { getByRole, getByText } = render(EventsTabHarness, {
        props: { client: client(events), workflow: workflow({ id: 'wf_download_1' }) },
      });

      await fireEvent.click(getByRole('button', { name: /Download/ }));
      await waitFor(() => expect(getByText('Event history · JSON')).not.toBeNull());
      await fireEvent.click(getByText('Event history · JSON'));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test('clicking "Events + timeline · JSON" fetches the timeline and downloads the combined export', async () => {
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = mock(() => 'blob:mock-url');
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = mock(() => {});

    try {
      const events: WorkflowEvent[] = [
        { type: 'workflow:checkpoint', timestamp: 1_000, data: { step: 1 } },
      ];
      const { getByRole, getByText } = render(EventsTabHarness, {
        props: { client: client(events), workflow: workflow({ id: 'wf_download_2' }) },
      });

      await fireEvent.click(getByRole('button', { name: /Download/ }));
      await waitFor(() => expect(getByText('Events + timeline · JSON')).not.toBeNull());
      await fireEvent.click(getByText('Events + timeline · JSON'));

      await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    } finally {
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
