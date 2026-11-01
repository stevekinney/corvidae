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

      await waitFor(() => expect(getByText('Schedule not found')).not.toBeNull());
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
      const { getByRole, getByTestId, getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      // The heading is the name, and the identifier is on the page nowhere.
      await waitFor(() =>
        expect(getByRole('heading', { level: 1, name: 'Nightly rollup' })).not.toBeNull(),
      );
      expect(document.body.textContent).not.toContain('nightly-rollup');
      // What it starts, and the cadence in words with its zone, in one sentence beside its status.
      const status = getByTestId('schedule-status-line');
      expect(status.textContent).toContain('inventory-sync-sweep');
      expect(status.textContent).toContain('every day at 02:00');
      expect(status.textContent).toContain('in America/Los Angeles');
      expect(status.querySelector('[data-status-word]')?.getAttribute('data-status-word')).toBe(
        'Scheduled',
      );
      // The details: the workflow, the zone, the overlap line (its consequence in the title), and
      // the rule for the worker that runs it.
      const rail = getByTestId('schedule-rail');
      expect(within(rail).getByText('Workflow')).not.toBeNull();
      expect(getByTestId('schedule-rail-zone').textContent).toBe('America/Los Angeles');
      expect(getByTestId('schedule-overlap').textContent).toContain(
        'Queues a fire if the previous run is still going',
      );
      expect(getByTestId('schedule-overlap').getAttribute('title')).toMatch(
        /Queue can grow unbounded during outages/,
      );
      expect(within(rail).getByText('Skips the fires it missed')).not.toBeNull();
      expect(getByText('Worker version for scheduled runs')).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('lists the next runs in the schedule’s own zone, with the zone named', async () => {
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

      const list = await waitFor(() => getByTestId('schedule-next-fires'));
      const times = Array.from(list.querySelectorAll('time'));
      expect(times).toHaveLength(5);
      // Every run is 09:00 on the Los Angeles clock, whatever zone this machine is in, and says so.
      for (const time of times) expect(time.textContent).toMatch(/9:00\s?AM P[SD]T/);
      expect(getByTestId('schedule-zone').textContent).toContain('America/Los Angeles');
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

  test('the actions menu copies the identifier, which no page shows', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    });

    try {
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'More actions' })));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: 'Copy ID' })));

      await waitFor(() => expect(written).toEqual(['nightly-rollup']));
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
      await server.stop();
    }
  });

  test('the actions menu copies the identifier, which no page shows', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    });

    try {
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'More actions' })));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: 'Copy ID' })));

      await waitFor(() => expect(written).toEqual(['nightly-rollup']));
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
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
        const { findByTestId, findAllByTestId, unmount } = render(ScheduleDetailHarness, {
          props: { client, id: 'missed-probe' },
        });

        const count = await findByTestId('schedule-missed-count');
        expect(count.textContent).toContain('3 missed');
        const rows = await findAllByTestId('schedule-missed-row');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows[0]?.textContent).toBe('Missed');
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
      const { getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await waitFor(() => expect(getByText('No runs yet')).not.toBeNull());
      expect(getByText('Nothing is running')).not.toBeNull();
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

      const rail = await waitFor(() => getByTestId('schedule-rail'));
      const queue = await waitFor(() => {
        const found = rail.querySelector('.ib-schedule__queue');
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
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'history-probe' },
      });

      const table = await waitFor(() => getByRole('table', { name: /Runs this schedule started/ }));
      const done = await waitFor(() => within(table).getAllByText('Done')[0]);
      const link = done?.closest('tr')?.querySelector('a');
      expect(link?.getAttribute('href')).toMatch(/^\/runs\//);
      const hrefs = Array.from(table.querySelectorAll('tbody a'), (a) => a.getAttribute('href'));
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
      cron: '0 9 * * 1-5',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'weekday-probe' },
      });

      const sentence = await waitFor(() => getByTestId('schedule-status-line'));
      expect(sentence.textContent).toContain('on cron 0 9 * * 1-5');
      expect(
        Array.from(sentence.querySelectorAll('code.ib-identifier'), (code) => code.textContent),
      ).toContain('0 9 * * 1-5');
      const rail = getByTestId('schedule-rail');
      expect(
        Array.from(rail.querySelectorAll('code.ib-identifier'), (code) => code.textContent),
      ).toContain('0 9 * * 1-5');
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
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'cancelled-probe' },
      });

      const table = await waitFor(() => getByRole('table', { name: /Runs this schedule started/ }));
      await waitFor(() =>
        expect(
          within(table)
            .getAllByText('Canceled')
            .some((word) => word.closest('[data-status-word]') !== null),
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
      const { getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'failing-probe' },
      });

      const table = await waitFor(() => getByRole('table', { name: /Runs this schedule started/ }));
      await waitFor(() => expect(within(table).getAllByText('Failed').length).toBeGreaterThan(0));
      const link = within(table).getAllByRole('link')[0];
      if (link === undefined) throw new Error('expected a run link');
      await fireEvent.click(link);
      expect(window.location.pathname).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('a paused schedule has no next runs and says so with a done empty state', async () => {
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
      const { getByText, queryByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'weekly-digest' },
      });

      await waitFor(() => expect(getByText('Nothing is coming up')).not.toBeNull());
      expect(queryByTestId('schedule-next-fires')).toBeNull();
      expect(getByText(/This schedule is Paused/)).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('Skip the next one skips exactly that run, marks it, and takes the button away', async () => {
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
      const { getByRole, getByTestId, queryByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'skip-probe' },
      });

      await fireEvent.click(
        await waitFor(() => getByRole('button', { name: 'Skip the next one' })),
      );

      await waitFor(async () => {
        const schedule = await client.getSchedule('skip-probe');
        expect(schedule?.skipUntil).toBeDefined();
      });
      const list = getByTestId('schedule-next-fires');
      await waitFor(() =>
        expect(
          Array.from(list.querySelectorAll('li'), (item) => item.getAttribute('data-skipped')),
        ).toEqual(['true', 'false', 'false', 'false', 'false']),
      );
      expect(within(list).getByText('Skipped')).not.toBeNull();
      expect(queryByRole('button', { name: 'Skip the next one' })).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('Skip the next one is refused, and says the schedule changed, when it moved on after the page read it', async () => {
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
      const { getByRole, findByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'stale-probe' },
      });
      const skip = await waitFor(() => getByRole('button', { name: 'Skip the next one' }));
      // Another caller changes the cadence after the page read the schedule.
      await client.updateSchedule('stale-probe', { cron: '0 10 * * *' });
      await fireEvent.click(skip);

      const notice = await findByTestId('schedule-notice');
      expect(notice.getAttribute('data-notice')).toBe('stale');
      const after = await client.getSchedule('stale-probe');
      expect(after?.skipUntil).toBeUndefined();
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
      const { getByRole, findByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'run-now-probe' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'Run now' })));

      const result = await findByTestId('schedule-run-now');
      expect(result.getAttribute('data-outcome')).toBe('started');
      expect(result.querySelector('a')?.getAttribute('href')).toMatch(/^\/runs\//);
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
      const { getByRole, findByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'paused-run-now' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'Run now' })));

      const started = await findByTestId('schedule-run-now');
      expect(started.getAttribute('data-outcome')).toBe('started');
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
      const { getByRole, getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      const toggle = await waitFor(() => getByRole('switch', { name: 'On' }));
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.hasAttribute('data-changes')).toBe(true);
      await fireEvent.click(toggle);
      await waitFor(() =>
        expect(getByRole('switch', { name: 'On' }).getAttribute('aria-checked')).toBe('false'),
      );
      await waitFor(() => {
        expect(
          getByTestId('schedule-status-line')
            .querySelector('[data-status-word]')
            ?.getAttribute('data-status-word'),
        ).toBe('Paused');
      });

      // The switch is held while the write settles, so it is pressed again once it is free.
      await waitFor(() =>
        expect(
          requireElement(getByRole('switch', { name: 'On' }), HTMLButtonElement).disabled,
        ).toBe(false),
      );
      await fireEvent.click(getByRole('switch', { name: 'On' }));
      await waitFor(() =>
        expect(getByRole('switch', { name: 'On' }).getAttribute('aria-checked')).toBe('true'),
      );
    } finally {
      await server.stop();
    }
  });

  test('the switch, Run now and Cancel are disabled when schedules:write is missing', async () => {
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
      expect(requireElement(getByRole('switch', { name: 'On' }), HTMLButtonElement).disabled).toBe(
        true,
      );
      // Skipping is a write too, so the button is not offered at all.
      expect(queryByRole('button', { name: 'Skip the next one' })).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('cancelling requires confirming the dialog', async () => {
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
      const { getByRole, getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'More actions' })));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: /Cancel/ })));

      const dialog = await waitFor(() => getByRole('dialog'));
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel schedule' }));

      await waitFor(() =>
        expect(
          getByTestId('schedule-status-line')
            .querySelector('[data-status-word]')
            ?.getAttribute('data-status-word'),
        ).toBe('Canceled'),
      );
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
