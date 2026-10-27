/**
 * Component tests for `<PutPanel>` (plan §9.6, §10.6: Tier-2 `ConfirmDialog`
 * on writes; reserved-prefix inline warning).
 */
import { fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { StorageConnection } from './storage-client.ts';

import ToastHost from '../../app/toast-host.svelte';
import PutPanelHarness from './put-panel-test-harness.test-harness.svelte';
import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';

function fakeClient(): StorageConnection {
  return { baseUrl: 'http://localhost:7233', headers: {} };
}

let activeStub: { calls: StubbedFetchCall[]; restore: () => void } | undefined;

afterEach(() => {
  activeStub?.restore();
  activeStub = undefined;
});

describe('PutPanel', () => {
  beforeEach(() => {
    render(ToastHost);
  });

  test('does not write until the confirm dialog is accepted', async () => {
    activeStub = stubStorageFetch(() => new Response(null, { status: 204 }));

    const { getByLabelText, getByText, findByRole } = render(PutPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.input(getByLabelText('Key'), { target: { value: 'app:config' } });
    await fireEvent.input(getByLabelText('Value'), { target: { value: '{"a":1}' } });
    await fireEvent.click(getByText('Put · confirm'));

    const dialog = await findByRole('dialog');
    expect(dialog).not.toBeNull();
    expect(activeStub.calls).toHaveLength(0);
  });

  test('writes after the confirm dialog is accepted', async () => {
    activeStub = stubStorageFetch(() => new Response(null, { status: 204 }));

    const { getByLabelText, getByText, findByRole } = render(PutPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.input(getByLabelText('Key'), { target: { value: 'app:config' } });
    await fireEvent.input(getByLabelText('Value'), { target: { value: 'hello' } });
    await fireEvent.click(getByText('Put · confirm'));
    await findByRole('dialog');
    await fireEvent.click(getByText('Write'));

    // load-proof: the stubbed fetch resolves in memory, so the request is issued inside the click handler promise chain
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(activeStub.calls).toHaveLength(1);
    expect(activeStub.calls[0]?.method).toBe('PUT');
    expect(activeStub.calls[0]?.url).toContain('/v1/storage/app%3Aconfig');
  });

  test('shows the refused write’s fault under the form', async () => {
    activeStub = stubStorageFetch(() =>
      Response.json(
        { error: { code: 'Conflict', message: 'The stored value changed during the write' } },
        { status: 409 },
      ),
    );

    const { container, getByLabelText, getByText, findByRole } = render(PutPanelHarness, {
      props: { client: fakeClient() },
    });

    await fireEvent.input(getByLabelText('Key'), { target: { value: 'app:config' } });
    await fireEvent.input(getByLabelText('Value'), { target: { value: 'hello' } });
    await fireEvent.click(getByText('Put · confirm'));
    await findByRole('dialog');
    await fireEvent.click(getByText('Write'));

    await waitFor(() =>
      expect(container.querySelector('.weft-storage-error')?.textContent).toBe(
        'The stored value changed during the write',
      ),
    );
  });

  test('shows the reserved-prefix warning when the key matches a Weft-owned prefix', async () => {
    const { getByLabelText, findByText, queryByText } = render(PutPanelHarness, {
      props: { client: fakeClient() },
    });

    expect(queryByText(/reserved prefix/)).toBeNull();

    await fireEvent.input(getByLabelText('Key'), { target: { value: 'wf:my-workflow' } });

    expect(await findByText(/reserved prefix/)).not.toBeNull();
  });
});
