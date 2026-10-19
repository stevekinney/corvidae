import { requireElement } from '../../../tests/dom.test-support.ts';

/**
 * Component tests for the Storage route (plan §9.6, Appendix B "denied
 * lock-states"): the `storage:admin` scope gate, and the controls and
 * Capabilities tab that follow what `weft.storage.capabilities` reports
 * (COR-1539).
 */
import { HttpClient } from '@lostgradient/weft';
import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';
import StorageRouteHarness from './storage-route-test-harness.test-harness.svelte';

function fakeClient(): HttpClient {
  return new HttpClient({ baseUrl: 'http://localhost:7233' });
}

let activeStub: ReturnType<typeof stubStorageFetch> | undefined;

afterEach(() => {
  activeStub?.restore();
  activeStub = undefined;
});

const CAPABILITIES = {
  persistence: 'local',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  boundedRangeDelete: true,
} as const;

const CAPABILITIES_METHOD = 'weft.storage.capabilities';

function isCapabilitiesCall(call: StubbedFetchCall): boolean {
  if (call.body === undefined) return false;
  try {
    return (JSON.parse(call.body) as { method?: unknown }).method === CAPABILITIES_METHOD;
  } catch {
    return false;
  }
}

/** Answers the `weft.storage.capabilities` JSON-RPC call with `capabilities`; anything else is a 500. */
function capabilitiesHandler(capabilities: object): (call: StubbedFetchCall) => Response {
  return (call) =>
    isCapabilitiesCall(call)
      ? Response.json({ jsonrpc: '2.0', id: 1, result: capabilities })
      : new Response('unexpected', { status: 500 });
}

function definitionFor(term: HTMLElement): HTMLElement {
  expect(term.tagName).toBe('DT');
  const definition = term.nextElementSibling;
  if (!definition) throw new Error('Definition not found');
  expect(definition.tagName).toBe('DD');
  return requireElement(definition, HTMLElement);
}

describe('Storage route', () => {
  test('shows a lock state naming the required scope when storage:admin is not granted', async () => {
    const { getByText, queryByRole } = render(StorageRouteHarness, {
      props: { client: fakeClient(), scopes: [] },
    });

    expect(getByText('Storage access requires storage:admin')).not.toBeNull();
    expect(getByText('Requires storage:admin')).not.toBeNull();
    // The KV browser tabs never mount when the scope is missing.
    expect(queryByRole('tablist')).toBeNull();
  });

  test('renders the KV browser / Capabilities tabs when storage:admin is granted', async () => {
    activeStub = stubStorageFetch(capabilitiesHandler(CAPABILITIES));

    const { getByText, queryByText } = render(StorageRouteHarness, {
      props: { client: fakeClient() },
    });

    expect(getByText('KV browser')).not.toBeNull();
    expect(getByText('Capabilities')).not.toBeNull();
    expect(queryByText('Storage access requires storage:admin')).toBeNull();
  });

  test('shows the reserved-prefix awareness banner when unlocked', async () => {
    activeStub = stubStorageFetch(capabilitiesHandler(CAPABILITIES));

    const { getByText } = render(StorageRouteHarness, { props: { client: fakeClient() } });

    expect(getByText(/used internally by the/)).not.toBeNull();
  });

  test('reads the capabilities from weft.storage.capabilities and never probes with a batch', async () => {
    activeStub = stubStorageFetch(capabilitiesHandler(CAPABILITIES));

    const { getByText, findByText } = render(StorageRouteHarness, {
      props: { client: fakeClient() },
    });
    await fireEvent.click(getByText('Capabilities'));
    await findByText('Atomic batch');

    expect(activeStub.calls.some(isCapabilitiesCall)).toBe(true);
    expect(activeStub.calls.some((call) => call.url.includes('conditional-batch'))).toBe(false);
  });

  test('renders every reported capability on the Capabilities tab, supported', async () => {
    activeStub = stubStorageFetch(capabilitiesHandler(CAPABILITIES));

    const { getByText, findByText } = render(StorageRouteHarness, {
      props: { client: fakeClient() },
    });
    await fireEvent.click(getByText('Capabilities'));

    const conditionalBatch = definitionFor(await findByText('Conditional batch'));
    expect(await within(conditionalBatch).findByText('supported')).not.toBeNull();
    expect(definitionFor(await findByText('Persistence')).textContent).toContain('local');
    expect(definitionFor(await findByText('Read after write')).textContent).toContain(
      'linearizable',
    );
    expect(definitionFor(await findByText('Scan consistency')).textContent).toContain('snapshot');
  });

  test('renders a capability the backend reports as unsupported', async () => {
    activeStub = stubStorageFetch(
      capabilitiesHandler({ ...CAPABILITIES, conditionalBatch: false, boundedRangeDelete: false }),
    );

    const { getByText, findByText } = render(StorageRouteHarness, {
      props: { client: fakeClient() },
    });
    await fireEvent.click(getByText('Capabilities'));

    const conditionalBatch = definitionFor(await findByText('Conditional batch'));
    expect(await within(conditionalBatch).findByText('not supported')).not.toBeNull();
    const atomicBatch = definitionFor(await findByText('Atomic batch'));
    expect(within(atomicBatch).getByText('supported')).not.toBeNull();
  });

  test('offers conditional batching only when the backend reports it', async () => {
    activeStub = stubStorageFetch(capabilitiesHandler(CAPABILITIES));
    const supported = render(StorageRouteHarness, { props: { client: fakeClient() } });
    await fireEvent.click(supported.getByText('Batch'));
    expect(
      await supported.findByRole('switch', { name: 'Conditional (compare-and-swap)' }),
    ).not.toBeNull();
    supported.unmount();
    activeStub.restore();

    activeStub = stubStorageFetch(
      capabilitiesHandler({ ...CAPABILITIES, conditionalBatch: false }),
    );
    const unsupported = render(StorageRouteHarness, { props: { client: fakeClient() } });
    await fireEvent.click(unsupported.getByText('Batch'));
    await unsupported.findByText('Apply batch · confirm');
    // The capabilities read has settled once the Capabilities tab shows its rows.
    await fireEvent.click(unsupported.getByText('Capabilities'));
    await unsupported.findByText('Conditional batch');
    await fireEvent.click(unsupported.getByText('KV browser'));
    // Returning to the KV browser remounts it on its default operation, so Batch is chosen again:
    // without this the assertion below would hold whatever the backend reported.
    await fireEvent.click(unsupported.getByText('Batch'));
    await unsupported.findByText('Apply batch · confirm');
    expect(
      unsupported.queryByRole('switch', { name: 'Conditional (compare-and-swap)' }),
    ).toBeNull();
  });

  test('shows the fault, and no capability rows, when the capabilities read fails', async () => {
    activeStub = stubStorageFetch(() =>
      Response.json({
        jsonrpc: '2.0',
        id: 1,
        error: {
          code: -32603,
          message: 'boom',
          data: { httpStatus: 500, weftCode: 'EngineFailure' },
        },
      }),
    );

    const { getByText, findByRole, queryByText } = render(StorageRouteHarness, {
      props: { client: fakeClient() },
    });
    await fireEvent.click(getByText('Capabilities'));

    expect(await findByRole('alert')).not.toBeNull();
    expect(queryByText('Conditional batch')).toBeNull();
  });
});
