import { requireElement } from '../../../tests/dom.test-support.ts';

/**
 * Component tests for `<ScheduleList>` against a REAL in-process weft server
 * (`live-source-test-server.test-support.ts` — plan §11: "No mock server, no
 * fixture drift"). `fixtures/workflows.ts` already registers
 * `inventory-sync-sweep` (from `fixtures/schedules.ts`), so schedules are
 * created directly against that real workflow type per test.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';
import { flushSync } from 'svelte';

import { HttpClient } from '@lostgradient/weft';

import { awakeTurns } from '@lostgradient/testing/wait-until';
import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import ScheduleListHarness from './schedule-list-test-harness.test-harness.svelte';

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

/** The row of a schedule, found by its identifier, which no row shows. */
function row(id: string): Element | null {
  return document.querySelector(`[data-schedule="${id}"]`);
}

function resetLocation(path = '/schedules'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('ScheduleList', () => {
  beforeEach(() => {
    resetLocation();
  });

  test('a filter that matches nothing is the filtered empty state, and Clear filters takes it out', async () => {
    resetLocation('/schedules?status=cancelled');
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
      const { findByText, getByRole } = render(ScheduleListHarness, { props: { client } });

      expect(await findByText('No matching schedules')).not.toBeNull();
      await fireEvent.click(getByRole('button', { name: 'Clear filters' }));
      await waitFor(() => expect(window.location.search).toBe(''));
      await waitFor(() => expect(row('nightly-rollup')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('is a table of every schedule with the workflow each one runs, whichever way it was made', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      timeZone: 'America/Los_Angeles',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, getAllByRole } = render(ScheduleListHarness, { props: { client } });

      await waitFor(() => expect(row('nightly-rollup')).not.toBeNull());
      expect(getAllByRole('columnheader').map((cell) => cell.textContent?.trim())).toEqual([
        'Schedule',
        'Runs',
        'Repeats',
        'Next run',
        'Last run',
        'Status',
        'Actions',
      ]);
      // The workflow it runs is a link, and the zone a cron is read in is named.
      expect(
        within(getByRole('table')).getByRole('link', { name: 'inventory-sync-sweep' }),
      ).not.toBeNull();
      expect(row('nightly-rollup')?.textContent).toContain('in America/Los Angeles');
      expect(row('nightly-rollup')?.getAttribute('data-status-word')).toBe('Scheduled');
      expect(row('nightly-rollup')?.getAttribute('data-kind')).toBe('code');
    } finally {
      await server.stop();
    }
  });

  test('renders a schedule row with its status badge and human-readable cadence', async () => {
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
      const { getByText, getByRole } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => expect(getByText('Nightly rollup')).not.toBeNull());
      const { getByText: getByTextInList } = within(getByRole('table'));
      // An active schedule needs no badge; one that is not says so.
      expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active');
      expect(getByText('Every day at 02:00')).not.toBeNull();
      expect(getByTextInList('inventory-sync-sweep')).not.toBeNull();
      // The row shows what the schedule is called, and nowhere its identifier.
      expect(row('nightly-rollup')?.textContent).not.toContain('nightly-rollup');
    } finally {
      await server.stop();
    }
  });

  test('a paused schedule shows the Paused badge', async () => {
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
      const { getByText, getByRole } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => expect(getByText('Weekly digest')).not.toBeNull());
      const { getByText: getByTextInList } = within(getByRole('table'));
      expect(getByTextInList('Paused')).not.toBeNull();
      expect(row('weekly-digest')?.getAttribute('data-status-word')).toBe('Paused');
    } finally {
      await server.stop();
    }
  });

  /**
   * T9.4 accessibility pass: before this fix, the row's ONLY navigation
   * affordance was `Table.Row`'s `onclick` — Cinder's `table-row.svelte`
   * spreads `onclick` straight onto a bare `<tr>` with no `tabindex`/keydown
   * handling, so the row was reachable by mouse only. A real `<a href>` is
   * the keyboard path (Tab reaches it, Enter activates it natively — no app
   * JS needed for that part), mirroring `workflow-table.svelte`'s identical
   * id-link pattern.
   */
  test('the schedule id renders as a real link to the detail URL (keyboard-reachable, not row-onclick-only)', async () => {
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
      const { getByRole } = render(ScheduleListHarness, {
        props: { client },
      });

      const link = await waitFor(() => getByRole('link', { name: 'Nightly rollup' }));
      expect(link.getAttribute('href')).toBe('/schedules/nightly-rollup');
    } finally {
      await server.stop();
    }
  });

  test('clicking a row navigates to the schedule detail URL', async () => {
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
      const { getByText } = render(ScheduleListHarness, {
        props: { client },
      });

      const idCell = await waitFor(() => {
        const cell = getByText('Nightly rollup');
        expect(cell).not.toBeNull();
        return cell;
      });
      await fireEvent.click(idCell);

      expect(window.location.pathname).toBe('/schedules/nightly-rollup');
    } finally {
      await server.stop();
    }
  });

  test('a schedule that has fired says how its last run ended, and one that has not says so', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'fired-probe',
      description: 'Fired probe',
      every: '50ms',
      input: { warehouseId: 'wh-main' },
    });
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'idle-probe',
      description: 'Idle probe',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    for await (const _ of awakeTurns()) {
      const runs = await client.list({ scheduleId: 'fired-probe', limit: 5 });
      if (runs.items.some((run) => run.status === 'completed')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      render(ScheduleListHarness, { props: { client } });

      await waitFor(() =>
        expect(
          row('fired-probe')
            ?.querySelector('[data-testid="schedule-last-fire"]')
            ?.getAttribute('data-outcome'),
        ).toBe('succeeded'),
      );
      expect(row('idle-probe')?.textContent).toContain('not fired yet');
    } finally {
      await server.stop();
    }
  });

  test('sets a cron expression it cannot put in words in monospace', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'weekday-probe',
      description: 'Weekday probe',
      cron: '0 9 * * 1-5',
      input: { warehouseId: 'wh-main' },
    });
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'daily-probe',
      description: 'Daily probe',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      render(ScheduleListHarness, { props: { client } });

      await waitFor(() =>
        expect(row('weekday-probe')?.textContent).toContain('Cron · 0 9 * * 1-5'),
      );
      const codes = (id: string) =>
        Array.from(
          row(id)?.querySelectorAll('code.ib-identifier') ?? [],
          (code) => code.textContent,
        );
      expect(codes('weekday-probe')).toContain('0 9 * * 1-5');
      // A cadence in words has no expression to set.
      expect(codes('daily-probe')).not.toContain('0 2 * * *');
    } finally {
      await server.stop();
    }
  });

  test('a schedule whose last run failed says so', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'system-failure-demo',
      id: 'failing-probe',
      description: 'Failing probe',
      every: '50ms',
      input: { orderId: 'order-1' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    for await (const _ of awakeTurns()) {
      const runs = await client.list({ scheduleId: 'failing-probe', limit: 5 });
      if (runs.items.some((run) => run.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    try {
      render(ScheduleListHarness, { props: { client } });

      await waitFor(() =>
        expect(
          row('failing-probe')
            ?.querySelector('[data-testid="schedule-last-fire"]')
            ?.getAttribute('data-outcome'),
        ).toBe('failed'),
      );
    } finally {
      await server.stop();
    }
  });

  test('the actions menu resumes a paused schedule, opens its editor, and copies its identifier', async () => {
    const server = await startLiveSourceTestServer();
    const handle = await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    await handle.pause();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    const written: string[] = [];
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (text: string) => (written.push(text), Promise.resolve()) },
    });

    try {
      const { getByRole, findByText } = render(ScheduleListHarness, { props: { client } });
      const actions = await waitFor(() =>
        getByRole('button', { name: 'Actions for Nightly rollup' }),
      );

      // The identifier is copied, and the person is told so.
      await fireEvent.click(actions);
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: 'Copy ID' })));
      await waitFor(() => expect(written).toEqual(['nightly-rollup']));
      expect(await findByText('Schedule ID copied')).not.toBeNull();

      await fireEvent.click(getByRole('button', { name: 'Actions for Nightly rollup' }));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: /Resume/ })));
      await waitFor(() =>
        expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active'),
      );

      await fireEvent.click(getByRole('button', { name: 'Actions for Nightly rollup' }));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: 'Edit' })));
      expect(window.location.pathname).toBe('/schedules/nightly-rollup/edit');
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
      await server.stop();
    }
  });

  test('says when the identifier could not be copied', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('Clipboard blocked')) },
    });

    try {
      const { getByRole, findByText } = render(ScheduleListHarness, { props: { client } });
      await fireEvent.click(
        await waitFor(() => getByRole('button', { name: 'Actions for Nightly rollup' })),
      );
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: 'Copy ID' })));

      expect(await findByText(/The schedule ID was not copied/)).not.toBeNull();
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
      await server.stop();
    }
  });

  test('an ?agent= filter that matches nothing says so, and keeps the agent in the filter', async () => {
    resetLocation('/schedules?agent=assistant');
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
      const { getByRole, findByText } = render(ScheduleListHarness, { props: { client } });

      expect(await findByText('No matching schedules')).not.toBeNull();
      await fireEvent.click(getByRole('button', { name: 'Clear filters' }));
      await waitFor(() => expect(window.location.search).toBe(''));
    } finally {
      await server.stop();
    }
  });

  test('the New schedule button is disabled with a reason when schedules:write is missing', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(ScheduleListHarness, {
        props: { client, scopes: ['schedules:read'] },
      });

      await waitFor(() => {
        expect(
          requireElement(getByRole('button', { name: 'New schedule' }), HTMLButtonElement).disabled,
        ).toBe(true);
      });
      // The reason is the disabled button's own title, not a second control beside it.
      expect(getByRole('button', { name: 'New schedule' }).getAttribute('title')).toBe(
        'Requires schedules:write',
      );
    } finally {
      await server.stop();
    }
  });

  test('the New schedule button is enabled with schedules:write granted', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, queryByText } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => {
        expect(
          requireElement(getByRole('button', { name: 'New schedule' }), HTMLButtonElement).disabled,
        ).toBe(false);
      });
      expect(queryByText('Requires schedules:write')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('pausing an active schedule updates its badge to Paused', async () => {
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
      const { getByText, getByRole } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => {
        expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active');
      });

      await fireEvent.click(getByRole('button', { name: 'Actions for Nightly rollup' }));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: /Pause/ })));

      await waitFor(() => {
        expect(within(getByRole('table')).getByText('Paused')).not.toBeNull();
      });
      expect(getByText('Nightly rollup')).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('cancelling a schedule requires Tier-2 confirmation before it takes effect (T8.2 tier sweep)', async () => {
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
      const { getByText, getByRole, queryByText } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => {
        expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active');
      });

      await fireEvent.click(getByRole('button', { name: 'Actions for Nightly rollup' }));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: /Cancel/ })));

      // Opening the menu item shows the confirm dialog — the schedule must
      // NOT be cancelled yet (this is exactly the gap the tier sweep fixed:
      // the row action previously mutated on click with no confirm step at
      // all).
      await waitFor(() => {
        expect(getByText('Cancel this schedule?')).not.toBeNull();
      });
      expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active');

      await fireEvent.click(getByRole('button', { name: 'Cancel schedule' }));

      await waitFor(() => {
        expect(within(getByRole('table')).getByText('Canceled')).not.toBeNull();
      });
      expect(queryByText('Cancel this schedule?')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('dismissing the cancel confirm dialog leaves the schedule active', async () => {
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
      const { getByText, getByRole, queryByText } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => {
        expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active');
      });

      await fireEvent.click(getByRole('button', { name: 'Actions for Nightly rollup' }));
      await fireEvent.click(await waitFor(() => getByRole('menuitem', { name: /Cancel/ })));
      await waitFor(() => {
        expect(getByText('Cancel this schedule?')).not.toBeNull();
      });

      await fireEvent.click(getByRole('button', { name: 'Cancel' }));

      flushSync();
      expect(queryByText('Cancel this schedule?')?.outerHTML ?? null).toBeNull();
      expect(row('nightly-rollup')?.getAttribute('data-status')).toBe('active');
    } finally {
      await server.stop();
    }
  });

  test('a fault (unreachable server) renders the fault banner with a retry action', async () => {
    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:1' });

    const { getByRole } = render(ScheduleListHarness, {
      props: { client },
    });

    await waitFor(() => expect(getByRole('button', { name: 'Retry' })).not.toBeNull());
  });

  test('a ?status= URL query param (dashboard-card deep link) pre-filters the status Select', async () => {
    resetLocation('/schedules?status=paused');
    const server = await startLiveSourceTestServer();
    const handle = await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'weekly-digest',
      description: 'Weekly digest',
      cron: '0 9 * * 1',
      input: { warehouseId: 'wh-main' },
    });
    await handle.pause();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, getByText, queryByText } = render(ScheduleListHarness, {
        props: { client },
      });

      await waitFor(() => expect(getByText('Weekly digest')).not.toBeNull());
      expect(queryByText('Nightly rollup')).toBeNull();
      expect(getByRole('button', { name: /Status: Paused/ })).not.toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('choosing a status updates the address, replacing history, and removing the chip takes it out', async () => {
    resetLocation('/schedules');
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(ScheduleListHarness, { props: { client } });
      const status = await waitFor(() => getByRole('combobox', { name: 'Status' }));

      await fireEvent.change(status, { target: { value: 'paused' } });
      await waitFor(() => expect(window.location.search).toBe('?status=paused'));

      await fireEvent.click(getByRole('button', { name: /Remove.*Status: Paused|Status: Paused/ }));
      await waitFor(() => expect(window.location.search).toBe(''));
    } finally {
      await server.stop();
    }
  });
});
