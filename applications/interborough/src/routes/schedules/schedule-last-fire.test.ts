/**
 * `<ScheduleLastFire>` follows the engine: it is shown once a schedule has fired, and the glyph
 * beside the time is how the newest run ended. The fleet feed moves it when the schedule fires
 * again and when that run settles (Codex review on COR-1654): the cached history of an earlier fire
 * must never sit beside a later fire's time.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { HttpClient } from '@lostgradient/weft';

import {
  applyScheduleFleetFrame,
  subscribeScheduleInvalidation,
} from '../../lib/live-source/cache-integration.ts';
import type { FleetEventFrame } from '../../lib/live-source/fleet-event-source.svelte.ts';
import ScheduleLastFireHarness from './schedule-last-fire-test-harness.test-harness.svelte';

type Run = { id: string; status: string; createdAt: number; updatedAt: number };

function run(id: string, status: string, createdAt: number): Run {
  return { id, status, createdAt, updatedAt: createdAt + 1 };
}

/** Just what the component reads of the engine's client: the schedule's runs, newest first. */
function clientListing(history: { runs: Run[] }): HttpClient {
  return {
    baseUrl: 'http://localhost:1',
    headers: {},
    list: async () => ({ items: history.runs, nextCursor: null }),
  } as unknown as HttpClient;
}

function frame(kind: string, workflowId?: string): FleetEventFrame {
  return {
    kind,
    ...(workflowId === undefined ? {} : { workflowId }),
    sequence: 1,
    cursor: '1',
    emittedAtMs: 0,
    payload: { scheduleId: 'nightly' },
  };
}

describe('ScheduleLastFire as the schedule fires again', () => {
  test('shows the outcome of the newest run, not the run it showed when it first rendered', async () => {
    const history = { runs: [run('run-1', 'completed', 1_000)] };
    let queryClient: QueryClient | undefined;
    const { container, rerender } = render(ScheduleLastFireHarness, {
      props: {
        client: clientListing(history),
        scheduleId: 'nightly',
        lastFireAt: 1_000,
        onQueryClient: (created: QueryClient) => {
          queryClient = created;
        },
      },
    });
    const outcome = () =>
      container.querySelector('[data-testid="schedule-last-fire"]')?.getAttribute('data-outcome');
    await waitFor(() => expect(outcome()).toBe('succeeded'));
    expect(container.querySelector('[aria-label="last run succeeded"]')).not.toBeNull();

    // The same wiring the shell makes: one subscription, applying each frame to the query cache.
    let deliver: ((next: FleetEventFrame) => void) | undefined;
    subscribeScheduleInvalidation(
      {
        subscribe(listener) {
          deliver = listener;
          return () => undefined;
        },
      },
      queryClient!,
    );

    // It fires again: the new run is going, so how it ended is not known yet, and the success of
    // the one before it is no longer the answer.
    history.runs = [run('run-2', 'running', 2_000), run('run-1', 'completed', 1_000)];
    await rerender({ lastFireAt: 2_000 });
    deliver?.(frame('schedule:fired', 'run-2'));
    await waitFor(() => expect(outcome()).toBe('unknown'));

    // The run fails: the glyph changes from success to failure.
    history.runs = [run('run-2', 'failed', 2_000), run('run-1', 'completed', 1_000)];
    deliver?.(frame('workflow:failed', 'run-2'));
    await waitFor(() => expect(outcome()).toBe('failed'));
    expect(container.querySelector('[aria-label="last run did not succeed"]')).not.toBeNull();
  });

  test('a run that settles in a history the schedule does not own leaves the glyph alone', async () => {
    const history = { runs: [run('run-1', 'completed', 1_000)] };
    let queryClient: QueryClient | undefined;
    const { container } = render(ScheduleLastFireHarness, {
      props: {
        client: clientListing(history),
        scheduleId: 'nightly',
        lastFireAt: 1_000,
        onQueryClient: (created: QueryClient) => {
          queryClient = created;
        },
      },
    });
    const outcome = () =>
      container.querySelector('[data-testid="schedule-last-fire"]')?.getAttribute('data-outcome');
    await waitFor(() => expect(outcome()).toBe('succeeded'));

    history.runs = [run('run-1', 'failed', 1_000)];
    applyScheduleFleetFrame(queryClient!, frame('workflow:failed', 'someone-elses-run'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(outcome()).toBe('succeeded');
  });
});
