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

  test('is named by what it does, says what it runs and when, and keeps the engine’s fields behind the Engine disclosure', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
      overlapPolicy: 'queue',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText, getByRole, getByTestId, queryByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      // The heading is the name, and the identifier is on the page nowhere.
      await waitFor(() =>
        expect(getByRole('heading', { level: 1, name: 'Nightly rollup' })).not.toBeNull(),
      );
      expect(document.body.textContent).not.toContain('nightly-rollup');
      // What it starts, and the cadence in words, in one sentence.
      const status = getByTestId('schedule-status-line');
      expect(status.textContent).toContain('inventory-sync-sweep');
      expect(status.textContent).toContain('every day at 02:00');
      expect(getByTestId('schedule-next-fires').querySelectorAll('li')).toHaveLength(5);
      // The overlap policy is one line, and its consequence is in the tooltip.
      expect(getByTestId('schedule-overlap').textContent).toContain(
        'Queues a fire if the previous run is still going',
      );
      expect(getByText(/Queue can grow unbounded during outages/)).not.toBeNull();

      // The engine's fields are not there until the disclosure opens.
      for (const hidden of [
        '0 2 * * *',
        'Jitter',
        'Revision policy',
        'Worker binding for scheduled runs',
      ]) {
        expect(queryByText(hidden), hidden).toBeNull();
      }
      await fireEvent.click(getByRole('button', { name: 'Engine' }));
      expect(await waitFor(() => getByText('0 2 * * *'))).not.toBeNull();
      expect(getByText('Jitter')).not.toBeNull();
      expect(getByText('Revision policy')).not.toBeNull();
      // COR-164: the scheduled-run worker rule, worded once in worker-inheritance-rules.ts.
      expect(getByText('Worker binding for scheduled runs')).not.toBeNull();
      expect(getByText(/a schedule carries no worker-versioning rule of its own/)).not.toBeNull();
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
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: 'Copy id' })));

      await waitFor(() => expect(written).toEqual(['nightly-rollup']));
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
      await server.stop();
    }
  });

  test('a schedule that missed fires shows how many in a warning badge beside its status', async () => {
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
      const { findByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'missed-probe' },
      });

      expect(await findByText('3 missed')).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('a schedule with no current or queued runs shows the empty runs note', async () => {
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
      const { getByText, getByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await waitFor(() =>
        expect(getByText('No runs yet. This schedule has not fired.')).not.toBeNull(),
      );
      await fireEvent.click(getByRole('button', { name: 'Engine' }));
      await waitFor(() => expect(getByText('No active or queued runs.')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('queued runs (weft 0.13+ ScheduleQueuedRun[]) render as links with a queued-at timestamp', async () => {
    const server = await startLiveSourceTestServer();
    // `long-sleeper` parks on a 24h `ctx.sleep()`, so its run stays "running"
    // for the lifetime of this test — the first occurrence occupies
    // `currentWorkflowId` and every occurrence after it queues behind it
    // under `overlapPolicy: 'queue'` rather than completing and freeing the
    // slot. `every: '50ms'` (far below the engine's 1s scheduler poll
    // interval) guarantees a tick is always due at each poll without
    // relying on a fixed wall-clock sleep before the assertion below —
    // `waitFor` polls the rendered DOM until a queued run actually appears.
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
      const { getByRole, getAllByRole } = render(ScheduleDetailHarness, {
        props: { client, id: 'queue-probe' },
      });

      // Queued runs are the engine's, so they are under the disclosure. A queued-run row is the
      // only link that says "queued …": the current-run row never does, so this can only pass
      // once a real `ScheduleQueuedRun` entry has round-tripped through the API.
      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'Engine' })));
      const queuedLink = await waitFor(() => {
        const found = getAllByRole('link').find((link) => /queued /.test(link.textContent ?? ''));
        expect(found).toBeDefined();
        return found;
      });
      expect(queuedLink?.getAttribute('href')).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('a current run is a link to its run under “Running now” in the Engine disclosure', async () => {
    const server = await startLiveSourceTestServer();
    // `long-sleeper` parks on a 24h `ctx.sleep()`, so the first occurrence
    // stays "running" indefinitely and durably occupies
    // `schedule.currentWorkflowId` — no `overlapPolicy: 'queue'` needed here
    // since this test only cares about the current-run branch
    // (`schedule-detail.svelte`'s `{#if schedule.currentWorkflowId}` block),
    // not the queued-runs branch. Waiting on the server-side
    // `currentWorkflowId` before mounting (rather than polling the DOM after
    // mount) keeps this deterministic instead of racing the engine's
    // scheduler the way an un-instrumented run and a `--coverage` run can
    // resolve differently.
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
      const { getByRole, getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'current-run-probe' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'Engine' })));
      const heading = await waitFor(() => getByText('Running now'));
      const currentRunLink = await waitFor(() => {
        const link = heading.parentElement?.querySelector('a');
        expect(link).not.toBeNull();
        return link;
      });
      expect(currentRunLink?.getAttribute('href')).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('recent runs (weft.workflows.list scheduleId filter, weft 0.13+) shows persisted history, not just live fires', async () => {
    const server = await startLiveSourceTestServer();
    // `inventory-sync-sweep` completes near-instantly (one activity call),
    // so within a couple of the engine's 1s scheduler polls it has both
    // fired and completed — real, persisted history reachable via
    // `fetchScheduleRunHistory`'s `scheduleId` filter, independent of
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
      const { getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'history-probe' },
      });

      const completedBadge = await waitFor(() => getByText('Completed'));
      expect(completedBadge).not.toBeNull();
      const runLink = completedBadge.closest('li')?.querySelector('a');
      expect(runLink?.getAttribute('href')).toMatch(/^\/runs\//);
    } finally {
      await server.stop();
    }
  });

  test('sets the cron expression in monospace, in the sentence and in the Engine list', async () => {
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
      const { getByRole, getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'weekday-probe' },
      });

      const sentence = await waitFor(() => getByTestId('schedule-status-line'));
      expect(sentence.textContent).toContain('on cron 0 9 * * 1-5');
      expect(
        Array.from(sentence.querySelectorAll('code.ib-identifier'), (code) => code.textContent),
      ).toContain('0 9 * * 1-5');

      await fireEvent.click(getByRole('button', { name: 'Engine' }));
      const definition = await waitFor(() => {
        const found = document.querySelector('.cinder-description-list__definition code');
        if (found === null) throw new Error('the Engine list has not rendered the cron expression');
        return found;
      });
      expect(definition.textContent).toBe('0 9 * * 1-5');
      expect(definition.classList.contains('ib-identifier')).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test('a cancelled run shows the failure glyph, as the list does', async () => {
    const server = await startLiveSourceTestServer();
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

      const runs = await waitFor(() => getByTestId('schedule-runs'));
      await waitFor(() => expect(within(runs).getAllByText('Cancelled').length).toBeGreaterThan(0));
      const cancelled = within(runs).getAllByText('Cancelled')[0]?.closest('li');
      expect(cancelled?.querySelector('.ib-schedule-glyph')).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('a failed run is marked as failed with how long it took, opens its run when clicked, and the back link returns to the list', async () => {
    const server = await startLiveSourceTestServer();
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
      const { getByRole, getByTestId } = render(ScheduleDetailHarness, {
        props: { client, id: 'failing-probe' },
      });

      const runs = await waitFor(() => getByTestId('schedule-runs'));
      await waitFor(() => expect(within(runs).getAllByText('Failed').length).toBeGreaterThan(0));
      const link = within(runs).getAllByRole('link')[0];
      if (link === undefined) throw new Error('expected a run link');
      await fireEvent.click(link);
      expect(window.location.pathname).toMatch(/^\/runs\//);

      await fireEvent.click(getByRole('button', { name: /Back to schedules/ }));
      expect(window.location.pathname).toBe('/schedules');
    } finally {
      await server.stop();
    }
  });

  test('a paused schedule says it is not scheduled instead of listing next fires', async () => {
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
      const { getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'weekly-digest' },
      });

      await waitFor(() =>
        expect(getByText('Not scheduled. This schedule is paused.')).not.toBeNull(),
      );
    } finally {
      await server.stop();
    }
  });

  test('pause/resume toggles based on the current status, gated on schedules:write', async () => {
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

      const pauseButton = await waitFor(() => getByRole('button', { name: /Pause/ }));
      await fireEvent.click(pauseButton);

      await waitFor(() => expect(getByRole('button', { name: /Resume/ })).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('pause/cancel actions are disabled when schedules:write is missing', async () => {
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
        props: { client, id: 'nightly-rollup', scopes: ['schedules:read'] },
      });

      await waitFor(() => {
        expect(
          requireElement(getByRole('button', { name: /Pause/ }), HTMLButtonElement).disabled,
        ).toBe(true);
      });
      await fireEvent.click(getByRole('button', { name: 'More actions' }));
      const cancel = await waitFor(() => getByRole('menuitem', { name: /Cancel/ }));
      expect(
        cancel.hasAttribute('disabled') || cancel.getAttribute('aria-disabled') === 'true',
      ).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test('cancelling requires confirming the Tier-2 dialog', async () => {
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
      const { getByRole, getByText } = render(ScheduleDetailHarness, {
        props: { client, id: 'nightly-rollup' },
      });

      await fireEvent.click(await waitFor(() => getByRole('button', { name: 'More actions' })));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: /Cancel/ })));

      const dialog = await waitFor(() => getByRole('dialog'));
      await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel schedule' }));

      await waitFor(() => expect(getByText('Cancelled')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('a fault (unreachable server) renders the fault banner with a retry action', async () => {
    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:1' });

    const { getByRole } = render(ScheduleDetailHarness, {
      props: { client, id: 'nightly-rollup' },
    });

    await waitFor(() => expect(getByRole('button', { name: 'Retry' })).not.toBeNull());
  });
});
