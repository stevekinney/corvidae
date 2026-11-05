/**
 * `<ScheduleLastFire>` follows the engine: it is shown once a schedule has fired, and the word
 * after the date is how the newest run ended ("Last run Oct 30, failed"). The fleet feed moves it when the schedule fires
 * again and when that run settles (Codex review on COR-1654): the cached history of an earlier fire
 * must never sit beside a later fire's time.
 */
import type { QueryClient } from '@tanstack/svelte-query';
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { HttpClient } from '@lostgradient/weft';

import { quietFor } from '@lostgradient/testing/wait-until';
import {
  applyFleetEventFrame,
  applyScheduleFleetFrame,
} from '../../lib/live-source/cache-integration.ts';
import type { FleetEventFrame } from '../../lib/live-source/fleet-event-source.svelte.ts';
import ScheduleLastFireHarness from './schedule-last-fire-test-harness.test-harness.svelte';

/** The text a component shows, with its whitespace collapsed. */
function textOf(container: HTMLElement): string {
  return (container.textContent ?? '').replaceAll(/\s+/g, ' ').trim();
}

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

describe('ScheduleLastFire in the summary line of a schedule’s page', () => {
  test('says Last ran with the date and how it ended: done, failed, and Never run', async () => {
    const history = { runs: [run('run-1', 'completed', 1_000)] };
    const { container, rerender } = render(ScheduleLastFireHarness, {
      props: {
        client: clientListing(history),
        scheduleId: 'nightly',
        lastFireAt: 1_000,
        summary: true,
      },
    });
    await waitFor(() =>
      expect(textOf(container)).toMatch(/^Last ran [A-Z][a-z]{2} \d{1,2}, done$/),
    );

    history.runs = [run('run-2', 'failed', 2_000), run('run-1', 'completed', 1_000)];
    await rerender({ lastFireAt: 2_000 });
    await waitFor(() =>
      expect(textOf(container)).toMatch(/^Last ran [A-Z][a-z]{2} \d{1,2}, failed$/),
    );

    await rerender({ lastFireAt: undefined });
    expect(textOf(container)).toBe('Never run');
  });
});

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
    expect(textOf(container)).toMatch(/^Last run [A-Z][a-z]{2} \d{1,2}$/);

    // The same wiring the shell makes: one subscription, applying each frame to the query cache.
    const deliver = (next: FleetEventFrame) => applyFleetEventFrame(queryClient!, next);

    // It fires again: the new run is going, so how it ended is not known yet, and the success of
    // the one before it is no longer the answer.
    history.runs = [run('run-2', 'running', 2_000), run('run-1', 'completed', 1_000)];
    await rerender({ lastFireAt: 2_000 });
    deliver(frame('schedule:fired', 'run-2'));
    await waitFor(() => expect(outcome()).toBe('unknown'));

    // The run fails: the glyph changes from success to failure.
    history.runs = [run('run-2', 'failed', 2_000), run('run-1', 'completed', 1_000)];
    deliver(frame('workflow:failed', 'run-2'));
    await waitFor(() => expect(outcome()).toBe('failed'));
    expect(textOf(container)).toMatch(/^Last run [A-Z][a-z]{2} \d{1,2}, failed$/);
  });

  test('a run that settles in a history the schedule does not own leaves the outcome alone', async () => {
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
    await quietFor(50);

    expect(outcome()).toBe('succeeded');
  });
});

describe('ScheduleLastFire for a schedule that has not fired', () => {
  test('says "Never run", and a phone says nothing', async () => {
    const client = clientListing({ runs: [] });
    const first = render(ScheduleLastFireHarness, {
      props: { client, scheduleId: 'nightly', lastFireAt: undefined },
    });
    expect(textOf(first.container)).toBe('Never run');
    first.unmount();
    const phone = render(ScheduleLastFireHarness, {
      props: { client, scheduleId: 'nightly', lastFireAt: undefined, phone: true },
    });
    expect(textOf(phone.container)).toBe('');
  });

  test('a phone says "Last ran" and a canceled run says so', async () => {
    const history = { runs: [run('run-1', 'cancelled', 1_000)] };
    const { container } = render(ScheduleLastFireHarness, {
      props: {
        client: clientListing(history),
        scheduleId: 'nightly',
        lastFireAt: 1_000,
        phone: true,
      },
    });
    await waitFor(() =>
      expect(textOf(container)).toMatch(/^Last ran [A-Z][a-z]{2} \d{1,2}, canceled$/),
    );
  });
});
