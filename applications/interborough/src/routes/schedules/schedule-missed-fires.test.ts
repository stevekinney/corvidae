/**
 * A schedule that missed fires says so on its page (COR-1725): the persisted count and the time it
 * last missed one, which a reload shows again, and, for the `schedule:missed-fire` events received
 * while the page is open, the window and the count of each, which a reload empties. Against a real
 * in-process weft server whose clock the test moves, as the engine’s is when it was down.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { HttpClient } from '@lostgradient/weft';

import { SCHEDULE_COPY } from '../../app/copy.ts';
import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
import {
  startLiveSourceTestServer,
  type LiveSourceTestServer,
} from '../../lib/live-source/live-source-test-server.test-support.ts';
import ScheduleDetailHarness from './schedule-detail-test-harness.test-harness.svelte';

let server: LiveSourceTestServer | undefined;
afterEach(async () => {
  cleanup();
  await server?.stop();
  server = undefined;
});

const MINUTE = 60_000;

/** An engine whose clock is the test’s, with a schedule that fires every minute. */
async function openSchedule(clock: { now: number }): Promise<HttpClient> {
  server = await startLiveSourceTestServer({ getNow: () => clock.now });
  await server.engine.schedule({
    workflow: 'inventory-sync-sweep',
    id: 'missed-probe',
    every: '1m',
    input: { warehouseId: 'wh-main' },
  });
  return new HttpClient({ baseUrl: server.baseUrl, token: server.token });
}

/** Moves the engine’s clock past `occurrences` fires in one step, as an engine that was down finds it. */
async function missFires(clock: { now: number }, occurrences: number): Promise<void> {
  clock.now += occurrences * MINUTE + 30_000;
  await server?.engine.scheduler.tick(clock.now);
}

describe('a schedule that missed fires before the page opened', () => {
  test('shows the persisted count and when it last missed one, and lists no windows, though the feed replays the miss', async () => {
    const clock = { now: Date.now() };
    const client = await openSchedule(clock);
    await missFires(clock, 3);
    await waitUntil(
      async () => {
        const schedule = await client.getSchedule('missed-probe');
        return (schedule?.lastMissedFireAt ?? 0) > 0;
      },
      { message: 'missed-probe records its last missed fire' },
    );
    let fleet: FleetEventSource | undefined;

    const { findByText, findByTestId, queryByTestId } = render(ScheduleDetailHarness, {
      props: {
        client,
        id: 'missed-probe',
        onFleetSource: (source: FleetEventSource) => {
          fleet = source;
        },
      },
    });

    expect(await findByText('3 missed')).not.toBeNull();
    const last = await findByTestId('schedule-last-missed');
    expect(last.textContent).toContain('last missed');
    // The feed replays what the engine retained, the miss among it, before it is caught up.
    await waitUntil(() => fleet?.caughtUp === true, { message: 'the fleet feed is caught up' });
    expect(queryByTestId('schedule-missed-windows')).toBeNull();
  });

  test('shows no last missed time for a schedule that never missed one', async () => {
    const client = await openSchedule({ now: Date.now() });

    const { findByTestId, queryByTestId } = render(ScheduleDetailHarness, {
      props: { client, id: 'missed-probe' },
    });

    await findByTestId('schedule-status-line');
    expect(queryByTestId('schedule-last-missed')).toBeNull();
    expect(queryByTestId('schedule-missed-windows')).toBeNull();
  });
});

describe('a schedule that misses fires while the page is open', () => {
  test('lists the window and the count of the missed fire, and the persisted count follows', async () => {
    const clock = { now: Date.now() };
    const client = await openSchedule(clock);
    let fleet: FleetEventSource | undefined;
    const { findByTestId, findByText, queryByTestId } = render(ScheduleDetailHarness, {
      props: {
        client,
        id: 'missed-probe',
        onFleetSource: (source: FleetEventSource) => {
          fleet = source;
        },
      },
    });
    await findByTestId('schedule-status-line');
    expect(queryByTestId('schedule-missed-windows')).toBeNull();
    await fleet?.whenConnected();

    await missFires(clock, 3);

    const list = await findByTestId('schedule-missed-windows');
    await waitFor(() => expect(list.querySelectorAll('li')).toHaveLength(1));
    expect(list.textContent).toContain(' to ');
    expect(list.textContent).toContain(SCHEDULE_COPY.missed(3));
    expect(await findByText(SCHEDULE_COPY.missedWindows)).not.toBeNull();
    const last = await findByTestId('schedule-last-missed');
    expect(last.textContent).toContain('last missed');
  });
});
