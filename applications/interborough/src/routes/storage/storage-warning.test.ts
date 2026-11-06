/**
 * Component tests for the warning at the top of Health › Storage: it shows only while the
 * Bureau's attention list holds a firing storage alert, names what was measured, and sends a plain
 * click to the retention settings while leaving a modified click to the browser.
 */
import { HttpClient } from '@lostgradient/weft';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { router } from '../../lib/router.svelte.ts';
import StorageRouteHarness from './storage-route-test-harness.test-harness.svelte';
import { serveStorage } from './storage-server.test-support.ts';

let server: ReturnType<typeof serveStorage> | undefined;

afterEach(() => {
  cleanup();
  server?.restore();
  server = undefined;
});

function open(alertSizeBytes?: number) {
  server = serveStorage({
    keys: { 'app:notes': 'text' },
    ...(alertSizeBytes === undefined ? {} : { alertSizeBytes }),
  });
  return render(StorageRouteHarness, {
    props: { client: new HttpClient({ baseUrl: 'http://localhost:7233' }) },
  } as never);
}

describe('the storage warning', () => {
  test('is absent while no storage alert fires', async () => {
    const view = open();
    await waitFor(() => expect(view.getByTestId('storage-count')).toBeDefined());
    await waitFor(() =>
      expect(server?.calls.some((call) => call.body?.includes('bureau.health.attention'))).toBe(
        true,
      ),
    );
    expect(view.queryByTestId('storage-warning')).toBeNull();
  });

  test('says what was measured and links to retention', async () => {
    const view = open(1_717_986_918);
    const warning = await view.findByTestId('storage-warning');
    expect(warning.textContent).toContain('Storage is over its warning level · 1.6 GB.');
    const link = view.getByRole('link', { name: 'Change retention' });
    expect(link.getAttribute('href')).toBe(router.href('/settings/data-and-retention'));
  });

  test('a plain click navigates to retention and a modified click is left to the browser', async () => {
    const view = open(1_717_986_918);
    const link = await view.findByRole('link', { name: 'Change retention' });
    // A modified click is the browser's: it opens the link in a new tab and the page stays.
    expect(await fireEvent.click(link, { metaKey: true })).toBe(true);
    expect(await fireEvent.click(link, { shiftKey: true })).toBe(true);
    expect(await fireEvent.click(link, { button: 1 })).toBe(true);
    // A plain click is taken over: the router navigates and the default is prevented.
    expect(await fireEvent.click(link)).toBe(false);
    await waitFor(() => expect(router.pathname).toBe('/settings/data-and-retention'));
  });
});
