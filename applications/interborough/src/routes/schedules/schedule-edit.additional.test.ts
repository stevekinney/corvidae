import { requireElement } from '../../../tests/dom.test-support.ts';

/**
 * Component tests for `<ScheduleEdit>` against a REAL in-process weft
 * server.
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import { HttpClient } from '@lostgradient/weft';

import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import ScheduleEditHarness from './schedule-edit-test-harness.test-harness.svelte';

describe('ScheduleEdit additional', () => {
  test('prefills the cadence from the existing schedule and updates it on save', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'nightly-rollup',
          onClose: () => (closed = true),
        },
      });

      const workflowTypeField = await waitFor(() =>
        getByRole('textbox', { name: 'Workflow type' }),
      );
      expect(requireElement(workflowTypeField, HTMLInputElement).value).toBe(
        'inventory-sync-sweep',
      );
      expect(requireElement(workflowTypeField, HTMLInputElement).disabled).toBe(true);

      await fireEvent.click(getByRole('button', { name: 'Save changes' }));

      await waitFor(() => expect(closed).toBe(true));
      const updated = await server.engine.getSchedule('nightly-rollup');
      // Cadence unchanged (no edit made) but the round trip through
      // updateSchedule() must succeed against the real server.
      expect(updated?.cronExpression).toBe('0 2 * * *');
    } finally {
      await server.stop();
    }
  });

  test('prefills revisionPolicy from the fetched ScheduleSummary and leaves it unchanged on an unrelated save (WFT-117)', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'pinned-rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
      revisionPolicy: 'pinned',
    });
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    let closed = false;
    try {
      const { getByRole } = render(ScheduleEditHarness, {
        props: {
          client,
          scheduleId: 'pinned-rollup',
          onClose: () => (closed = true),
        },
      });

      const pinnedRadio = await waitFor(() => getByRole('radio', { name: 'Pinned' }));
      expect(requireElement(pinnedRadio, HTMLInputElement).checked).toBe(true);

      const before = await server.engine.getSchedule('pinned-rollup');
      const pinnedRevisionBefore = before?.pinnedRevision;

      await fireEvent.click(getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(closed).toBe(true));

      // Unchanged revisionPolicy must not resend it — the pin is never
      // silently re-captured by an unrelated cadence-only save.
      const after = await server.engine.getSchedule('pinned-rollup');
      expect(after?.revisionPolicy).toBe('pinned');
      expect(after?.pinnedRevision).toBe(pinnedRevisionBefore);
    } finally {
      await server.stop();
    }
  });
});
