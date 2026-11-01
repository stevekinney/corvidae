import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState, WorkflowTimelineEntry } from '@lostgradient/weft';
import { QueryClient } from '@tanstack/svelte-query';

import type { FleetEventFrame } from '../../../lib/live-source/fleet-event-source.svelte.ts';
import TimelineTabHarness from './timeline-tab.test-harness.svelte';
import { timelineSelectionFor } from './timeline/timeline-selection-store.svelte.ts';
import { WorkflowLiveObservations } from './timeline/workflow-live-observations.svelte.ts';

function workflow(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    id: 'wf-1',
    type: 'trip-booking-saga',
    status: 'running',
    input: {},
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

type EntryOverrides = { [K in keyof WorkflowTimelineEntry]?: WorkflowTimelineEntry[K] | undefined };

function entry(overrides: EntryOverrides): WorkflowTimelineEntry {
  // A key set to `undefined` stands for an entry the engine reported without it.
  return {
    step: 1,
    operationType: 'activity',
    operationLabel: 'doThing',
    inputSummary: '{}',
    timestamp: 1_000,
    status: 'completed',
    ...overrides,
  } as WorkflowTimelineEntry;
}

class InertFleet {
  caughtUp = false;
  #handler: ((frame: FleetEventFrame) => void) | null = null;

  subscribe(onFrame: (frame: FleetEventFrame) => void): () => void {
    this.#handler = onFrame;
    return () => {
      this.#handler = null;
    };
  }

  emit(frame: FleetEventFrame): void {
    this.#handler?.(frame);
  }
}

function inertQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function baseClient(
  entries: WorkflowTimelineEntry[],
  pendingItems: ReadonlyArray<{
    token: string;
    operationId: string;
    activityName: string;
    step: number;
    attempt: number;
    createdAt: number;
  }> = [],
) {
  return {
    getTimeline: async () => entries,
    operations: {
      'weft.workflows.activities.pending.list': async () => ({ items: pendingItems }),
    },
    activity: {
      complete: async () => {},
      completeExceptionally: async () => {},
    },
  };
}

function liveObservations(): WorkflowLiveObservations {
  return new WorkflowLiveObservations(new InertFleet(), inertQueryClient(), 'wf-1');
}

describe('TimelineTab', () => {
  test('shows an empty state with no steps', async () => {
    const { getByText } = render(TimelineTabHarness, {
      props: {
        client: baseClient([]),
        workflow: workflow(),
        liveObservations: liveObservations(),
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('No steps yet')).not.toBeNull());
  });

  test('lists the steps in order, each in words and in code, with the count in the list header', async () => {
    const entries = [
      entry({ step: 1, operationLabel: 'reserveFlight' }),
      entry({ step: 2, operationLabel: 'reserveHotel', status: 'running' }),
    ];

    const { getByText, getByTestId } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow(),
        liveObservations: liveObservations(),
        finalizerStatus: null,
      },
    });

    await waitFor(() => {
      expect(getByText('Reserve flight')).not.toBeNull();
      expect(getByText('reserveFlight')).not.toBeNull();
      expect(getByText('reserveHotel')).not.toBeNull();
    });
    expect(getByTestId('steps-count').textContent?.trim()).toBe('2 steps');
  });

  test('draws every step’s bar on one scale, from the run’s start', async () => {
    const entries = [
      entry({ step: 1, operationLabel: 'first', timestamp: 1_000, duration: 250 }),
      entry({ step: 2, operationLabel: 'second', timestamp: 1_250, duration: 750 }),
    ];

    const { container } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ createdAt: 1_000 }),
        liveObservations: liveObservations(),
        finalizerStatus: null,
        now: 5_000,
      },
    });

    await waitFor(() => expect(container.querySelectorAll('.ib-step-row__bar')).toHaveLength(2));
    const [first, second] = [...container.querySelectorAll('.ib-step-row__bar')].map((bar) =>
      bar.getAttribute('style'),
    );
    expect(first).toContain('inset-inline-start: 0%');
    expect(first).toContain('inline-size: 25%');
    expect(second).toContain('inset-inline-start: 25%');
    expect(second).toContain('inline-size: 75%');
  });

  test('opening a step shows it beside the list, links it to Events, and marks its row current', async () => {
    const entries = [entry({ step: 1, operationLabel: 'reserveFlight' })];

    const { getByText, getByRole, getAllByRole } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-select-1' }),
        liveObservations: liveObservations(),
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('reserveFlight')).not.toBeNull());
    const row = getByRole('button', { name: /Reserve flight/ });
    expect(row.getAttribute('aria-current')).toBeNull();

    await fireEvent.click(row);

    await waitFor(() => {
      expect(getAllByRole('heading', { level: 3, name: 'Reserve flight' })).toHaveLength(1);
    });
    expect(getByRole('button', { name: /Reserve flight/ }).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(timelineSelectionFor('wf-select-1').selectedStepId).toBe('step-1');
  });

  test('filters to Failed and to Waiting, and offers a way back when nothing matches', async () => {
    const entries = [
      entry({ step: 1, operationLabel: 'doneStep' }),
      entry({ step: 2, operationLabel: 'brokenStep', status: 'failed' }),
      entry({ step: 3, operationLabel: 'openStep', status: 'running', duration: undefined }),
    ];

    const { getByRole, getByText, queryByText, getByTestId } = render(TimelineTabHarness, {
      props: {
        client: baseClient(entries),
        workflow: workflow({ id: 'wf-filter-1' }),
        liveObservations: liveObservations(),
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getByText('doneStep')).not.toBeNull());
    await fireEvent.click(getByRole('radio', { name: 'Failed' }));
    await waitFor(() => expect(queryByText('doneStep')?.outerHTML ?? null).toBeNull());
    expect(getByText('brokenStep')).not.toBeNull();
    expect(getByTestId('steps-count').textContent?.trim()).toBe('1 of 3 steps');

    await fireEvent.click(getByRole('radio', { name: 'Waiting' }));
    await waitFor(() => expect(getByText('openStep')).not.toBeNull());
    expect(queryByText('brokenStep')).toBeNull();
  });

  test('offers only All, Failed and Waiting', async () => {
    const { getAllByRole } = render(TimelineTabHarness, {
      props: {
        client: baseClient([entry({ step: 1 })]),
        workflow: workflow({ id: 'wf-filter-2' }),
        liveObservations: liveObservations(),
        finalizerStatus: null,
      },
    });

    await waitFor(() => expect(getAllByRole('radio')).toHaveLength(3));
    expect(
      getAllByRole('radio').map(
        (radio) => radio.getAttribute('aria-label') ?? radio.textContent?.trim(),
      ),
    ).toEqual(['All', 'Failed', 'Waiting']);
  });

  test('says so, with a way to try again, when the steps cannot be read', async () => {
    const { findByText, findByRole } = render(TimelineTabHarness, {
      props: {
        client: {
          ...baseClient([]),
          getTimeline: async () => {
            throw new Error('timeline is down');
          },
        },
        workflow: workflow({ id: 'wf-error-1' }),
        liveObservations: liveObservations(),
        finalizerStatus: null,
      },
    });

    expect(await findByText('The steps could not be read')).not.toBeNull();
    expect(await findByRole('button', { name: 'Try again' })).not.toBeNull();
  });
});
