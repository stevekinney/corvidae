/**
 * Component tests for the page that edits a schedule (`<ScheduleEdit>`) against a REAL in-process
 * weft server: an engine schedule's save reaches the engine, a refetch that arrives mid-edit does
 * not discard what was typed, another schedule gets its own draft, and a skipped run is kept or
 * restored as the warning says (COR-15, COR-1985; the form is the one that makes a schedule,
 * COR-2018).
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';
import type { QueryClient } from '@tanstack/svelte-query';

import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import ScheduleEditHarness from './schedule-edit-test-harness.test-harness.svelte';
import { scheduleDetailQueryKey } from './schedule-queries.ts';

const SAVE = 'Save changes';

describe('ScheduleEdit', () => {
  test('saving an edited name and overlap policy persists them (COR-15)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'all-options',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
      description: 'before',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByLabelText, getByRole } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'all-options', onClose: () => (closed = true) },
      });

      const name = await waitFor(() => getByRole('textbox', { name: /^Name/ }));
      expect((name as HTMLInputElement).value).toBe('before');
      await fireEvent.input(name, { target: { value: 'after' } });
      await fireEvent.change(getByLabelText('If a run is still going'), {
        target: { value: 'allow' },
      });
      await fireEvent.change(getByLabelText('If Interborough was off'), {
        target: { value: 'on' },
      });

      await fireEvent.click(getByRole('button', { name: SAVE }));
      await waitFor(() => expect(closed).toBe(true));

      const after = await server.engine.getSchedule('all-options');
      expect(after?.description).toBe('after');
      expect(after?.overlap).toBe('allow');
      expect(after?.backfill).toBe(true);
    } finally {
      await server.stop();
    }
  });

  test('a background refetch after the schedule fires does not discard an unsaved cadence edit, and the edit still saves (COR-15 review)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'cadence-edit',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    let queryClient: QueryClient | undefined;
    try {
      const { getByLabelText, getByRole } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'cadence-edit',
          onClose: () => (closed = true),
          onQueryClient: (qc) => (queryClient = qc),
        },
      });

      // Edit ONLY the cadence: `0 2 * * *` opens as Every day, and At moves from 2:00 to 5:00.
      const at = await waitFor(() => {
        const field = getByLabelText('At');
        if (!(field instanceof HTMLInputElement)) throw new Error('At field not rendered');
        return field;
      });
      await fireEvent.change(at, { target: { value: '5:00 AM' } });

      // The schedule is run: `updatedAt` moves while the revision, which only a change to the
      // schedule moves, stays what the draft was built from.
      const before = await server.engine.getSchedule('cadence-edit');
      await server.engine.triggerSchedule('cadence-edit');
      if (queryClient === undefined) throw new Error('queryClient was never captured');
      await queryClient.invalidateQueries({ queryKey: scheduleDetailQueryKey('cadence-edit') });
      await waitFor(() => {
        const cached = queryClient?.getQueryData<{ updatedAt: number }>(
          scheduleDetailQueryKey('cadence-edit'),
        );
        expect(cached?.updatedAt).not.toBe(before?.updatedAt);
      });

      // The unsaved cadence edit survives the refetch.
      await fireEvent.click(getByRole('button', { name: SAVE }));
      await waitFor(() => expect(closed).toBe(true));
      const saved = await server.engine.getSchedule('cadence-edit');
      expect(saved?.cronExpression).toBe('0 5 * * *');
    } finally {
      await server.stop();
    }
  });

  test("switching to another schedule while the form is dirty opens its own draft instead of saving one schedule's edits onto the other (COR-15 review)", async () => {
    const server = await startLiveSourceTestServer();
    for (const id of ['switch-a', 'switch-b']) {
      await server.engine.schedule({
        workflow: 'inventory-sync-sweep',
        id,
        cron: '0 2 * * *',
        input: {},
        description: id,
      });
    }
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });
    try {
      const { getByRole, rerender } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'switch-a', onClose: () => {} },
      });
      const name = await waitFor(() => getByRole('textbox', { name: /^Name/ }));
      await fireEvent.input(name, { target: { value: 'dirty edit for a' } });

      await rerender({ client, scheduleId: 'switch-b', onClose: () => {} });
      await waitFor(() =>
        expect((getByRole('textbox', { name: /^Name/ }) as HTMLInputElement).value).toBe(
          'switch-b',
        ),
      );
    } finally {
      await server.stop();
    }
  });

  test('renders the not-found fault when the schedule no longer exists', async () => {
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'missing', onClose: () => {} },
      });

      await waitFor(() => expect(getByText('Not found')).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('says the schedule could not be loaded, and tries again on request', async () => {
    const client = new HttpClient({ baseUrl: 'http://127.0.0.1:1' });

    const { getByRole, getByText } = render(ScheduleEditHarness, {
      props: { client, scheduleId: 'nightly-rollup' },
    });

    await waitFor(() => expect(getByText(SCHEDULE_COPY.detail.loadFailed)).not.toBeNull());
    expect(getByRole('button', { name: 'Try again' })).not.toBeNull();
  });

  test('keeps a skipped run across a save that leaves the cadence alone, and says nothing about one (COR-1985)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'skip-then-edit',
      cron: '0 2 * * *',
      timeZone: 'UTC',
      input: { warehouseId: 'wh-main' },
    });
    await server.engine.skipNextScheduleOccurrence('skip-then-edit');
    const skipped = await server.engine.getSchedule('skip-then-edit');
    expect(skipped?.skippedOccurrences).toHaveLength(1);
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole, queryByTestId } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'skip-then-edit', onClose: () => (closed = true) },
      });

      const name = await waitFor(() => getByRole('textbox', { name: /^Name/ }));
      await fireEvent.input(name, { target: { value: 'Renamed' } });
      expect(queryByTestId('schedule-edit-skip-pending')).toBeNull();
      await fireEvent.click(getByRole('button', { name: SAVE }));
      await waitFor(() => expect(closed).toBe(true));
      // The skip names a run the save leaves next, so the save does not restore it.
      const saved = await server.engine.getSchedule('skip-then-edit');
      expect(saved?.description).toBe('Renamed');
      expect(saved?.skippedOccurrences).toEqual(skipped?.skippedOccurrences);
    } finally {
      await server.stop();
    }
  });

  test('says a save ends the skips the new cadence no longer runs at, when the cadence changes (COR-1985)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'skip-then-move',
      cron: '0 2 * * *',
      timeZone: 'UTC',
      input: { warehouseId: 'wh-main' },
    });
    await server.engine.skipNextScheduleOccurrence('skip-then-move');
    const skipped = await server.engine.getSchedule('skip-then-move');
    expect(skipped?.skippedOccurrences).toHaveLength(1);
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByLabelText, getByRole, getByTestId, queryByTestId } = render(
        ScheduleEditHarness,
        {
          props: { client, scheduleId: 'skip-then-move', onClose: () => (closed = true) },
        },
      );

      const at = await waitFor(() => {
        const field = getByLabelText('At');
        if (!(field instanceof HTMLInputElement)) throw new Error('At field not rendered');
        return field;
      });
      expect(queryByTestId('schedule-edit-skip-pending')).toBeNull();
      await fireEvent.change(at, { target: { value: '5:00 AM' } });
      await waitFor(() =>
        expect(getByTestId('schedule-edit-skip-pending').textContent).toContain(
          SCHEDULE_COPY.edit.skipPending,
        ),
      );
      await fireEvent.click(getByRole('button', { name: SAVE }));
      await waitFor(() => expect(closed).toBe(true));
      // The warning is true: a new cadence ends a skip it no longer runs at.
      const saved = await server.engine.getSchedule('skip-then-move');
      expect(saved?.cronExpression).toBe('0 5 * * *');
      expect(saved?.skippedOccurrences).toBeUndefined();
    } finally {
      await server.stop();
    }
  });

  test('says nothing about a skip when none is pending', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'no-skip-edit',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, queryByTestId } = render(ScheduleEditHarness, {
        props: { client, scheduleId: 'no-skip-edit', onClose: () => {} },
      });

      await waitFor(() => getByRole('textbox', { name: /^Name/ }));
      expect(queryByTestId('schedule-edit-skip-pending')).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
