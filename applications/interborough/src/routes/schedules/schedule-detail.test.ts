import { requireElement } from '../../../tests/dom.test-support.ts';

/**
 * Component tests for `<ScheduleDetail>` against a REAL in-process weft
 * server (`live-source-test-server.test-support.ts`).
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';

import { waitUntil } from '@lostgradient/testing/wait-until';
import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import ScheduleDetailHarness from './schedule-detail-test-harness.test-harness.svelte';

/**
 * Polls a server-side condition until it holds, BEFORE the page under test
 * mounts, so the page's own initial fetch already contains the data the
 * assertion needs. Without this, the queued-runs/history tests race the
 * engine's real scheduler (fire → run → persist) against the DOM `waitFor`
 * window — a race the un-instrumented suite wins easily but the ~7×-slower
 * `--coverage` run can lose (observed: the queued-runs assertion timing
 * out at 5s only under coverage instrumentation). Waiting on the SERVER
 * state rather than bumping the DOM timeout keeps the assertion about
 * rendering, not about scheduler latency.
 */
async function waitForServerState(check: () => Promise<boolean>, label: string): Promise<void> {
  await waitUntil(check, { message: label });
}

/**
 * How often the engine's scheduler looks for a due fire in the tests that wait on a real scheduled
 * run. The engine's default is one second, which made each of those tests wait out a whole poll;
 * a fire is still the engine's own, started by its real scheduler (COR-1737).
 */
const FAST_SCHEDULER_POLL_MS = 20;

describe('ScheduleDetail', () => {
  test('locks the detail with a reason, and never fetches, when schedules:read is missing', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { findByText, queryByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup', scopes: ['schedules:write'] },
      });

      expect(await findByText('Schedule is locked')).not.toBeNull();
      expect(await findByText('Requires schedules:read')).not.toBeNull();
      expect(queryByText('0 2 * * *')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('renders the not-found state for an unknown id', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'does-not-exist' },
      });

      await waitFor(() => expect(getByText('This schedule doesn’t exist')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('is named by what it does, says what it runs and when, and has the details beside its runs', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      timeZone: 'America/Los_Angeles',
      input: { warehouseId: 'wh-main' },
      overlapPolicy: 'queue',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, getByTestId, queryByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      // The heading is the name, and the identifier is on the page nowhere.
      await waitFor(() =>
        expect(getByRole('heading', { level: 1, name: 'Nightly rollup' })).not.toBeNull(),
      );
      expect(document.body.textContent).not.toContain('nightly-rollup');
      // What it runs and when, in one sentence: the workflow linked, and the cadence in words.
      const sentence = getByTestId('schedule-status-line');
      expect(sentence.textContent).toContain('Runs Inventory sync sweep');
      expect(sentence.textContent).toContain('every day at');
      expect(sentence.querySelector('a')?.getAttribute('href')).toBe(
        '/workflows/inventory-sync-sweep',
      );
      // The switch says Active; the heading row does not repeat it as a status word.
      expect(document.querySelector('.cinder-page-header [data-status-word]')).toBeNull();
      // The details card: what runs, when (in the form's words), and how it behaves; no callout.
      const card = within(getByTestId('schedule-details'));
      expect(card.getByText('What runs')).not.toBeNull();
      expect(card.getByText('Every day')).not.toBeNull();
      expect(card.getByText('Pacific time')).not.toBeNull();
      expect(getByTestId('schedule-overlap').textContent).toContain('Queue this one');
      expect(getByTestId('schedule-overlap').getAttribute('title')).toMatch(
        /Queue can grow unbounded during outages/,
      );
      expect(card.getByText('Don’t catch up on missed runs')).not.toBeNull();
      expect(queryByText('Worker version for scheduled runs')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('lists the next three runs in the viewer’s zone, farthest first, under a note that names the zone', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'la-morning',
      description: 'LA morning',
      cron: '0 9 * * *',
      timeZone: 'America/Los_Angeles',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'la-morning' },
      });

      const list = await waitFor(() => getByTestId('schedule-runs'));
      const times = Array.from(list.querySelectorAll('li[data-cinder-tone="pending"] time'));
      expect(times).toHaveLength(3);
      for (const time of times) expect(time.textContent).toMatch(/\d{1,2}:\d{2}\s?[AP]M/);
      // Farthest first, so the nearest sits against the Now marker.
      const stamps = times.map((time) => Date.parse(time.getAttribute('datetime') ?? ''));
      expect(stamps).toEqual(stamps.toSorted((first, second) => second - first));
      // The note under Runs says which zone the page reads times in, the viewer's.
      expect(getByTestId('schedule-zone').textContent).toContain(
        'Upcoming above, past below, times in',
      );
    } finally {
      await server.stop();
    }
  });

  test('a schedule with no description is named by what it starts', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'unnamed-probe',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'unnamed-probe' },
      });

      await waitFor(() =>
        expect(
          getByRole('heading', { level: 1, name: 'Schedule for inventory-sync-sweep' }),
        ).not.toBeNull(),
      );
    } finally {
      await server.stop();
    }
  });

  test('the actions menu holds one item, a danger Delete schedule, and no identifier is on the page', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, getAllByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'More actions' })));
      await waitFor(() => expect(getAllByRole('menuitem')).toHaveLength(1));
      const item = getByRole('menuitem', { name: 'Delete schedule' });
      expect(item.getAttribute('data-cinder-variant') ?? item.className).toContain('danger');
      expect(document.body.textContent).not.toContain('nightly-rollup');
    } finally {
      await server.stop();
    }
  });

  test('a schedule that missed fires shows how many, and lists each missed fire after a reload', async () => {
    // The engine's clock is moved past three occurrences in one step, as it is for an engine that
    // was down, so the next tick skips them as missed. A tick that is only late by its own poll
    // drift no longer counts as a missed fire (COR-1616), so the real poller never does this.
    const clock = { now: Date.now() };
    const server = await startLiveSourceTestServer({ getNow: () => clock.now });
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'missed-probe',
      every: '1m',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    clock.now += 3 * 60_000 + 30_000;
    await server.engine.scheduler.tick(clock.now);

    await waitForServerState(async () => {
      const schedule = await client.getSchedule('missed-probe');
      return (schedule?.missedFireCount ?? 0) > 0;
    }, 'missed-probe has missed fires');

    try {
      // Each mount reads the rows the engine persisted, as a page reload does.
      for (let mount = 0; mount < 2; mount += 1) {
        const { findAllByText, findByRole, findByText, unmount } = render(ScheduleDetailHarness, {
          props: { client, id: 'missed-probe' },
        });

        // The missed runs are the one status word of the heading, and once each among the past runs.
        await waitFor(() =>
          expect(
            document
              .querySelector('.cinder-page-header [data-status-word]')
              ?.getAttribute('data-status-word'),
          ).toBe('Missed runs, 3'),
        );
        // They are one band below Now, and open to each miss.
        const band = await findByText(/^Missed \d+ times since /);
        expect(band).not.toBeNull();
        await fireEvent.click(await findByRole('button', { name: /Show each/ }));
        const rows = await findAllByText(/^Missed, /);
        expect(rows.length).toBeGreaterThan(0);
        unmount();
      }
    } finally {
      await server.stop();
    }
  });

  test('a schedule with no runs says so, and shows nothing running', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText, queryByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await waitFor(() => expect(getByText('No runs yet.')).not.toBeNull());
      // A run that is going is said only while there is one.
      expect(queryByText('Running now')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('queued runs render in the details as links to the run', async () => {
    const server = await startLiveSourceTestServer({
      schedulerPollIntervalMs: FAST_SCHEDULER_POLL_MS,
    });
    // `long-sleeper` parks on a 24h `ctx.sleep()`, so its run stays "running" for the lifetime of
    // this test: the first occurrence occupies `currentWorkflowId` and every occurrence after it
    // queues behind it under `overlapPolicy: 'queue'`. Waiting on the server state before mounting
    // keeps the assertion about rendering, not about scheduler latency.
    await server.engine.schedule({
      workflow: 'long-sleeper',
      id: 'queue-probe',
      every: '50ms',
      input: { label: 'queue-probe-run' },
      overlapPolicy: 'queue',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    await waitForServerState(async () => {
      const schedule = await client.getSchedule('queue-probe');
      return (schedule?.queuedRuns?.length ?? 0) > 0;
    }, 'queue-probe has a queued run');

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'queue-probe' },
      });

      const card = await waitFor(() => getByTestId('schedule-details'));
      const queue = await waitFor(() => {
        const found = card.querySelector('.ib-schedule-card__queue');
        expect(found).not.toBeNull();
        return found;
      });
      expect(queue?.querySelector('a')?.getAttribute('href')).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('a current run is a link to its run under “Running now” in the details', async () => {
    const server = await startLiveSourceTestServer({
      schedulerPollIntervalMs: FAST_SCHEDULER_POLL_MS,
    });
    await server.engine.schedule({
      workflow: 'long-sleeper',
      id: 'current-run-probe',
      every: '50ms',
      input: { label: 'current-run-probe-run' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    await waitForServerState(async () => {
      const schedule = await client.getSchedule('current-run-probe');
      return schedule?.currentWorkflowId !== undefined;
    }, 'current-run-probe has a current run');

    try {
      const { getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'current-run-probe' },
      });

      const term = await waitFor(() => getByText('Running now'));
      const link = await waitFor(() => {
        const found = term.parentElement?.querySelector('dd a');
        expect(found).not.toBeNull();
        return found;
      });
      expect(link?.getAttribute('href')).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('past runs are the persisted history, each linking to its run with how it ended', async () => {
    const server = await startLiveSourceTestServer({
      schedulerPollIntervalMs: FAST_SCHEDULER_POLL_MS,
    });
    // `inventory-sync-sweep` completes near-instantly, so within a few polls it has fired and
    // completed: real, persisted history reachable by the `scheduleId` filter, independent of
    // whether this page ever observes the live `schedule:fired` event.
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'history-probe',
      every: '50ms',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    await waitForServerState(async () => {
      const history = await client.list({ scheduleId: 'history-probe', limit: 20 });
      return history.items.some((run) => run.status === 'completed');
    }, 'history-probe has a completed run');

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'history-probe' },
      });

      const list = await waitFor(() => getByTestId('schedule-runs'));
      const done = await waitFor(() => within(list).getAllByText('Done')[0]);
      const link = done?.closest('li[data-cinder-kind="run"]')?.querySelector('a');
      expect(link?.getAttribute('href')).toMatch(/^\/runs\//);
      const hrefs = Array.from(list.querySelectorAll('li[data-cinder-kind="run"] a'), (a) =>
        a.getAttribute('href'),
      );
      expect(new Set(hrefs).size).toBe(hrefs.length);
    } finally {
      await server.stop();
    }
  });

  test('sets the cron expression it cannot put in words in monospace', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'weekday-probe',
      description: 'Weekday probe',
      cron: '*/7 9 * * 1-5',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'weekday-probe' },
      });

      const sentence = await waitFor(() => getByTestId('schedule-status-line'));
      expect(sentence.textContent).toContain('on cron */7 9 * * 1-5');
      expect(
        Array.from(sentence.querySelectorAll('code.ib-identifier'), (code) => code.textContent),
      ).toContain('*/7 9 * * 1-5');
      const card = getByTestId('schedule-details');
      expect(
        Array.from(card.querySelectorAll('code.ib-identifier'), (code) => code.textContent),
      ).toContain('*/7 9 * * 1-5');
    } finally {
      await server.stop();
    }
  });

  test('a cancelled run is Canceled in the past runs', async () => {
    const server = await startLiveSourceTestServer({
      schedulerPollIntervalMs: FAST_SCHEDULER_POLL_MS,
    });
    const handle = await server.engine.schedule({
      workflow: 'long-sleeper',
      id: 'cancelled-probe',
      description: 'Cancelled probe',
      every: '50ms',
      input: { label: 'cancelled-probe' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    // One run is started; stop the schedule from starting another, then cancel the one running.
    let runId: string | undefined;
    await waitForServerState(async () => {
      const started = await client.list({ scheduleId: 'cancelled-probe', limit: 5 });
      runId = started.items[0]?.id;
      return runId !== undefined;
    }, 'cancelled-probe has started a run');
    await handle.pause();
    await client.cancel(runId!);
    await waitForServerState(async () => {
      const runs = await client.list({ scheduleId: 'cancelled-probe', limit: 5 });
      return runs.items.some((run) => run.status === 'cancelled');
    }, 'cancelled-probe has a cancelled run');

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'cancelled-probe' },
      });

      const list = await waitFor(() => getByTestId('schedule-runs'));
      await waitFor(() =>
        expect(
          within(list)
            .getAllByText('Canceled')
            .some((word) => word.closest('li[data-cinder-kind="run"]') !== null),
        ).toBe(true),
      );
    } finally {
      await server.stop();
    }
  });

  test('a failed run is Failed with how long it took, and opens its run', async () => {
    const server = await startLiveSourceTestServer({
      schedulerPollIntervalMs: FAST_SCHEDULER_POLL_MS,
    });
    await server.engine.schedule({
      workflow: 'system-failure-demo',
      id: 'failing-probe',
      description: 'Failing probe',
      every: '50ms',
      input: { orderId: 'order-1' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    await waitForServerState(async () => {
      const runs = await client.list({ scheduleId: 'failing-probe', limit: 5 });
      return runs.items.some((run) => run.status === 'failed');
    }, 'failing-probe has a failed run');

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'failing-probe' },
      });

      const list = await waitFor(() => getByTestId('schedule-runs'));
      await waitFor(() => expect(within(list).getAllByText('Failed').length).toBeGreaterThan(0));
      const link = list.querySelector<HTMLAnchorElement>('li[data-cinder-kind="run"] a');
      if (link === null) throw new Error('expected a run link');
      await fireEvent.click(link);
      expect(window.location.pathname).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('a paused schedule has no upcoming runs and says so', async () => {
    const server = await startLiveSourceTestServer();
    const handle = await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'weekly-digest',
      description: 'Weekly digest',
      cron: '0 9 * * 1',
      input: { warehouseId: 'wh-main' },
    });
    await handle.pause();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText, queryByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'weekly-digest' },
      });

      await waitFor(() =>
        expect(getByText('No upcoming runs while the schedule is paused.')).not.toBeNull(),
      );
      // Nothing is coming, so there is no Now marker to split the upcoming from the past.
      expect(queryByText('Now')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('Skip on a later run skips exactly that run, crosses its time out, offers Undo in its place, and Undo takes the skip back', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'skip-probe',
      description: 'Skip probe',
      cron: '0 9 * * *',
      timeZone: 'UTC',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getAllByRole, getByRole, getByTestId, queryByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'skip-probe' },
      });
      const struck = () =>
        Array.from(
          getByTestId('schedule-runs').querySelectorAll('li[data-cinder-tone="pending"] time'),
          (time) => time.hasAttribute('data-cinder-struck'),
        );

      // Every upcoming run offers Skip; the middle one is the run after the next.
      const skips = await waitFor(() => {
        const found = getAllByRole('button', { name: /^Skip / });
        expect(found).toHaveLength(3);
        return found;
      });
      await fireEvent.click(skips[1]!);

      await waitFor(async () => {
        const schedule = await client.getSchedule('skip-probe');
        expect(schedule?.skippedOccurrences).toHaveLength(1);
        expect(schedule?.skippedOccurrences?.[0]).toBeGreaterThan(schedule?.nextFireAt ?? 0);
      });
      await waitFor(() => expect(struck()).toEqual([false, true, false]));
      const list = getByTestId('schedule-runs');
      expect(within(list).getByText('Skipped')).not.toBeNull();
      expect(getAllByRole('button', { name: /^Skip / })).toHaveLength(2);
      const undo = getByRole('button', { name: /^Undo skipping / });
      // Undo sits on the row only: the page raises no toast beside it.
      expect(queryByRole('status', { name: /skipped/i })).toBeNull();

      await fireEvent.click(undo);

      await waitFor(async () => {
        const schedule = await client.getSchedule('skip-probe');
        expect(schedule?.skippedOccurrences).toBeUndefined();
      });
      await waitFor(() => expect(struck()).toEqual([false, false, false]));
      expect(queryByRole('button', { name: /^Undo skipping / })).toBeNull();
      expect(getAllByRole('button', { name: /^Skip / })).toHaveLength(3);
    } finally {
      await server.stop();
    }
  });

  test('Skip is refused, and says the schedule changed, when it moved on after the page read it', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'stale-probe',
      description: 'Stale probe',
      cron: '0 9 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getAllByRole, findByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'stale-probe' },
      });
      const skip = await waitFor(() => getAllByRole('button', { name: /^Skip / }).at(-1));
      // Another caller changes the cadence after the page read the schedule.
      await client.updateSchedule('stale-probe', { cron: '0 10 * * *' });
      await fireEvent.click(skip!);

      const notice = await findByTestId('schedule-notice');
      expect(notice.getAttribute('data-notice')).toBe('stale');
      const after = await client.getSchedule('stale-probe');
      expect(after?.skippedOccurrences).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test('Run now starts one run, says so, and links to it', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'run-now-probe',
      description: 'Run now probe',
      cron: '0 9 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, findByText, findByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'run-now-probe' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'Run now' })));

      // A toast says so, with a link to the run, and the run is one the engine started.
      await findByText('Started Run now probe.');
      expect(await findByRole('button', { name: 'Open run' })).not.toBeNull();
      const runs = await client.list({ scheduleId: 'run-now-probe', limit: 5 });
      expect(runs.items).toHaveLength(1);
    } finally {
      await server.stop();
    }
  });

  test('Run now works on a paused schedule', async () => {
    const server = await startLiveSourceTestServer();
    const handle = await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'paused-run-now',
      description: 'Paused run now',
      cron: '0 9 * * *',
      input: { warehouseId: 'wh-main' },
    });
    await handle.pause();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, findByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'paused-run-now' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'Run now' })));

      await findByText('Started Paused run now.');
    } finally {
      await server.stop();
    }
  });

  test('the On switch pauses and resumes the schedule', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      const toggle = await waitFor(() =>
        getByRole('switch', { name: 'Active, Nightly rollup schedule' }),
      );
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.hasAttribute('data-changes')).toBe(true);
      await fireEvent.click(toggle);
      await waitFor(() =>
        expect(
          getByRole('switch', { name: 'Active, Nightly rollup schedule' }).getAttribute(
            'aria-checked',
          ),
        ).toBe('false'),
      );
      await waitFor(() => {
        // The switch says Paused, so the heading row has no status word of its own.
        expect(document.querySelector('.cinder-page-header [data-status-word]')).toBeNull();
      });

      // The switch is held while the write settles, so it is pressed again once it is free.
      await waitFor(() =>
        expect(
          requireElement(
            getByRole('switch', { name: 'Active, Nightly rollup schedule' }),
            HTMLButtonElement,
          ).disabled,
        ).toBe(false),
      );
      await fireEvent.click(getByRole('switch', { name: 'Active, Nightly rollup schedule' }));
      await waitFor(() =>
        expect(
          getByRole('switch', { name: 'Active, Nightly rollup schedule' }).getAttribute(
            'aria-checked',
          ),
        ).toBe('true'),
      );
    } finally {
      await server.stop();
    }
  });

  test('the switch, Run now and Delete schedule are disabled when schedules:write is missing', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, queryByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup', scopes: ['schedules:read'] },
      });

      await waitFor(() => {
        expect(
          requireElement(getByRole('button', { name: 'Run now' }), HTMLButtonElement).disabled,
        ).toBe(true);
      });
      expect(
        requireElement(
          getByRole('switch', { name: 'Active, Nightly rollup schedule' }),
          HTMLButtonElement,
        ).disabled,
      ).toBe(true);
      // Skipping is a write too, so the button is not offered at all.
      expect(queryByRole('button', { name: /^Skip / })).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('deleting asks first, names the schedule, and leaves for the list once it is done', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'More actions' })));
      await fireEvent.click(
        await waitFor(() => getByRole('menuitem', { name: 'Delete schedule' })),
      );

      const dialog = await waitFor(() => getByRole('dialog', { name: 'Delete Nightly rollup?' }));
      expect(dialog.textContent).toContain(
        'It stops running and its upcoming runs are removed. Past runs stay on Runs. This can’t be undone.',
      );
      // Cancel is the dialog's secondary button, and Delete schedule is the destructive one.
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).not.toBeNull();
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete schedule' }));

      await waitFor(async () => {
        const deleted = await client.getSchedule('nightly-rollup');
        expect(deleted?.status).toBe('cancelled');
      });
      await waitFor(() => expect(router.pathname).toBe('/schedules'));
    } finally {
      await server.stop();
    }
  });

  test('a fault (unreachable server) renders the error state with a retry action', async () => {
    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:1' });

    const { getByRole } = render(ScheduleDetailHarness, {
      props: { client, id: 'nightly-rollup' },
    });

    await waitFor(() => expect(getByRole('button', { name: 'Try again' })).not.toBeNull());
  });
});
