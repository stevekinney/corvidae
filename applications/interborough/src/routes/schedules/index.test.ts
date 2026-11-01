/**
 * Component tests for the Schedules domain router (`index.svelte`): the address says whether the
 * list, the page that makes a schedule, one schedule, or its edit page is shown.
 */
import { render, waitFor } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { Window, type DetachedWindowAPI } from 'happy-dom';

import { HttpClient } from '@lostgradient/weft';

import { startLiveSourceTestServer } from '../../lib/live-source/live-source-test-server.test-support.ts';
import { router } from '../../lib/router.svelte.ts';
import IndexHarness from './index-test-harness.test-harness.svelte';

function happyDomAPI(): DetachedWindowAPI {
  if (!(window instanceof Window)) {
    throw new Error('expected the test window to be backed by happy-dom');
  }
  return window.happyDOM;
}

function resetLocation(path = '/schedules'): void {
  happyDomAPI().setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

describe('Schedules index router', () => {
  test('/schedules renders the list', async () => {
    resetLocation('/schedules');
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole } = render(IndexHarness, { props: { client } });
      await waitFor(() => expect(getByRole('heading', { name: 'Schedules' })).not.toBeNull());
    } finally {
      await server.stop();
    }
  });

  test('/schedules/<id> renders the detail page, not the list', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    resetLocation('/schedules/nightly-rollup');
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByText, queryByRole } = render(IndexHarness, { props: { client } });
      await waitFor(() => expect(getByText('Nightly rollup', { selector: 'h1' })).not.toBeNull());
      expect(queryByRole('heading', { name: 'Schedules' })).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('/schedules/new renders the page that makes a schedule, not the list or a schedule named new', async () => {
    resetLocation('/schedules/new');
    const server = await startLiveSourceTestServer();
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, queryByRole } = render(IndexHarness, { props: { client } });
      await waitFor(() =>
        expect(getByRole('heading', { level: 1, name: 'New schedule' })).not.toBeNull(),
      );
      expect(queryByRole('heading', { name: 'Schedules' })).toBeNull();
      expect(queryByRole('dialog')).toBeNull();
    } finally {
      await server.stop();
    }
  });

  test('/schedules/<id>/edit renders the edit page, not the detail page', async () => {
    const server = await startLiveSourceTestServer();
    await server.engine.schedule({
      workflow: 'inventory-sync-sweep',
      id: 'nightly-rollup',
      description: 'Nightly rollup',
      cron: '0 2 * * *',
      input: { warehouseId: 'wh-main' },
    });
    resetLocation('/schedules/nightly-rollup/edit');
    const client = new HttpClient({ baseUrl: server.baseUrl, token: server.token });

    try {
      const { getByRole, queryByRole } = render(IndexHarness, { props: { client } });
      await waitFor(() =>
        expect(getByRole('heading', { level: 1, name: 'Edit schedule' })).not.toBeNull(),
      );
      expect(queryByRole('dialog')).toBeNull();
      expect(queryByRole('heading', { level: 1, name: 'Nightly rollup' })).toBeNull();
    } finally {
      await server.stop();
    }
  });
});
