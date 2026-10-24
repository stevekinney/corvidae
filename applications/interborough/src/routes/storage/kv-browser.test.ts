/**
 * Component tests for `<KvBrowser>` (plan §9.6; design `Weft UI.dc.html`
 * STORAGE "stBrowser"): the get/scan/put/delete/batch operation picker.
 */
import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import type { StorageConnection } from './storage-client.ts';

import KvBrowserHarness from './kv-browser-test-harness.test-harness.svelte';

function fakeClient(): StorageConnection {
  return { baseUrl: 'http://localhost:7233', headers: {} };
}

/** Turns on the switch that brings Put, Delete, and Batch into the picker. */
async function allowWrites(getByRole: (role: string, options?: { name: string }) => HTMLElement) {
  await fireEvent.click(getByRole('switch', { name: 'Allow writes' }));
}

/** The names in the operation picker, which the Scan panel's own Prefix / Start / end tabs are not part of. */
function operations(getByRole: (role: string, options?: { name: string }) => HTMLElement) {
  return within(getByRole('tablist', { name: 'Storage operation' }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent?.trim());
}

describe('KvBrowser', () => {
  test('opens read-only: Get and Scan are offered, and Put, Delete, and Batch are not rendered', () => {
    const { getByRole, queryByRole } = render(KvBrowserHarness, {
      props: { client: fakeClient() },
    });

    expect(operations(getByRole)).toEqual(['Get', 'Scan']);
    expect(getByRole('switch', { name: 'Allow writes' }).getAttribute('aria-checked')).toBe(
      'false',
    );
    for (const name of ['Put', 'Delete', 'Batch']) {
      expect(queryByRole('tab', { name }), name).toBeNull();
    }
  });

  test('shows the reserved-prefix warning once, beside the switch', () => {
    const { container, getAllByText } = render(KvBrowserHarness, {
      props: { client: fakeClient() },
    });

    expect(getAllByText(/used internally by the/).length).toBe(1);
    const group = container.querySelector('.weft-storage-writes');
    expect(group?.querySelector('[role="switch"]')).not.toBeNull();
    expect(group?.textContent).toContain('may disrupt recovery');
  });

  test('brings Put, Delete, and Batch into the picker when writes are allowed, and takes them out again', async () => {
    const { getByRole } = render(KvBrowserHarness, {
      props: { client: fakeClient() },
    });

    await allowWrites(getByRole);
    expect(operations(getByRole)).toEqual(['Get', 'Scan', 'Put', 'Delete', 'Batch']);

    await allowWrites(getByRole);
    expect(operations(getByRole)).toEqual(['Get', 'Scan']);
  });

  test('turning writes off while a write panel is open returns to Scan', async () => {
    const { getByRole, findByText, queryByText } = render(KvBrowserHarness, {
      props: { client: fakeClient() },
    });

    await allowWrites(getByRole);
    await fireEvent.click(getByRole('tab', { name: 'Delete' }));
    await findByText('Delete · confirm');

    await allowWrites(getByRole);

    expect(await findByText('Scan storage')).not.toBeNull();
    expect(queryByText('Delete · confirm')).toBeNull();
    expect(getByRole('tab', { name: 'Scan' }).getAttribute('aria-selected')).toBe('true');
  });

  test('defaults to the scan panel', () => {
    const { getByText } = render(KvBrowserHarness, { props: { client: fakeClient() } });

    expect(getByText('Scan storage')).not.toBeNull();
  });

  test('switches to the get panel', async () => {
    const { getByRole, findByText } = render(KvBrowserHarness, { props: { client: fakeClient() } });

    await fireEvent.click(getByRole('tab', { name: 'Get' }));

    expect(await findByText('Enter a key')).not.toBeNull();
  });

  test('switches to the put panel', async () => {
    const { getByRole, findByText } = render(KvBrowserHarness, { props: { client: fakeClient() } });

    await allowWrites(getByRole);
    await fireEvent.click(getByRole('tab', { name: 'Put' }));

    expect(await findByText('Put · confirm')).not.toBeNull();
  });

  test('switches to the delete panel', async () => {
    const { getByRole, findByText } = render(KvBrowserHarness, { props: { client: fakeClient() } });

    await allowWrites(getByRole);
    await fireEvent.click(getByRole('tab', { name: 'Delete' }));

    expect(await findByText('Delete · confirm')).not.toBeNull();
  });

  test('switches to the batch panel and defaults conditionalBatchSupported to false when omitted', async () => {
    const { getByRole, findByText, queryByText } = render(KvBrowserHarness, {
      props: { client: fakeClient() },
    });

    await allowWrites(getByRole);
    await fireEvent.click(getByRole('tab', { name: 'Batch' }));

    expect(await findByText('Apply batch · confirm')).not.toBeNull();
    expect(queryByText('Conditional (compare-and-swap)')).toBeNull();
  });

  test('unmounts the previous panel when switching between operations', async () => {
    const { getByRole, findByText, queryByText } = render(KvBrowserHarness, {
      props: { client: fakeClient() },
    });

    await findByText('Scan storage');

    await fireEvent.click(getByRole('tab', { name: 'Get' }));
    expect(await findByText('Enter a key')).not.toBeNull();
    expect(queryByText('Scan storage')).toBeNull();

    await allowWrites(getByRole);
    await fireEvent.click(getByRole('tab', { name: 'Put' }));
    expect(await findByText('Put · confirm')).not.toBeNull();
    expect(queryByText('Enter a key')).toBeNull();

    await fireEvent.click(getByRole('tab', { name: 'Delete' }));
    expect(await findByText('Delete · confirm')).not.toBeNull();
    expect(queryByText('Put · confirm')).toBeNull();

    await fireEvent.click(getByRole('tab', { name: 'Batch' }));
    expect(await findByText('Apply batch · confirm')).not.toBeNull();
    expect(queryByText('Delete · confirm')).toBeNull();

    await fireEvent.click(getByRole('tab', { name: 'Scan' }));
    expect(await findByText('Scan storage')).not.toBeNull();
    expect(queryByText('Apply batch · confirm')).toBeNull();
  });

  test('passes a true conditionalBatchSupported through to the batch panel', async () => {
    const { getByRole, findByText } = render(KvBrowserHarness, {
      props: { client: fakeClient(), conditionalBatchSupported: true },
    });

    await allowWrites(getByRole);
    await fireEvent.click(getByRole('tab', { name: 'Batch' }));
    await findByText('Apply batch · confirm');

    expect(await findByText('Conditional (compare-and-swap)')).not.toBeNull();
  });
});
