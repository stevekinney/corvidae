import { HttpClientError } from '@lostgradient/weft';
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  matchingCheckout,
  registrySnapshot,
  workerManifest,
} from '../workers/contract-verification.test-support.ts';
import { MalformedWorkerDiagnosticsError } from '../workers/worker-manifest-diagnostics.ts';
import RegistryContractVerificationPanel from './registry-contract-verification-panel.svelte';

type PanelProps = {
  workflow: string;
  registry: ReturnType<typeof registrySnapshot>;
  diagnostics: ReturnType<typeof workerManifest>[] | undefined;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
};

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    workflow: 'checkout',
    registry: registrySnapshot(),
    diagnostics: [
      workerManifest({ checkout: matchingCheckout() }, { workerId: 'worker-a' }),
      workerManifest(
        {
          checkout: {
            ...matchingCheckout(),
            activities: { charge: matchingCheckout().activities['charge']! },
          },
        },
        { workerId: 'worker-b', buildId: 'build-8' },
      ),
      workerManifest({}, { workerId: 'worker-c' }),
    ],
    loading: false,
    refreshing: false,
    error: null,
    ...overrides,
  };
  return render(RegistryContractVerificationPanel, { props });
}

describe('RegistryContractVerificationPanel', () => {
  test('shows each serving worker’s verification status for the workflow', () => {
    const { getAllByText, getByRole, getByText } = renderPanel();

    expect(getByRole('region', { name: 'Worker contract verification' })).not.toBeNull();
    expect(getByText('Drift · 1 of 2 workers')).not.toBeNull();
    expect(getAllByText('Matches registry').length).toBeGreaterThan(0);
    expect(getByText('Drift detected')).not.toBeNull();
    expect(getByText('Missing from worker')).not.toBeNull();
    expect(getByText('1 other connected worker does not serve this workflow.')).not.toBeNull();
    expect(getByRole('table', { name: 'worker-b checkout activity verification' })).not.toBeNull();
  });

  test('every serving worker matching reads as verified', () => {
    const { getByText } = renderPanel({
      diagnostics: [workerManifest({ checkout: matchingCheckout() })],
    });
    expect(getByText('Verified · every serving worker matches')).not.toBeNull();
    // A single serving worker names its manifest file in the command.
    expect(
      getByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry-v2.json',
      ),
    ).not.toBeNull();
  });

  test('loading state', () => {
    const { getByRole, queryByText } = renderPanel({ loading: true });
    expect(getByRole('status', { name: 'Loading worker contract verification' })).not.toBeNull();
    expect(queryByText('Drift · 1 of 2 workers')).toBeNull();
  });

  test('empty state: no worker serves the workflow', () => {
    const { getByText } = renderPanel({ workflow: 'refund' });
    expect(getByText('No worker manifests for this workflow')).not.toBeNull();
  });

  test('empty state: no manifests yet', () => {
    const { getByText } = renderPanel({ diagnostics: [] });
    expect(getByText('No worker manifests for this workflow')).not.toBeNull();
  });

  test('stale state keeps cached evidence with the neutral refreshing badge', () => {
    const { getByText } = renderPanel({ refreshing: true });
    expect(getByText('Refreshing · showing cached evidence')).not.toBeNull();
    expect(getByText('Drift · 1 of 2 workers')).not.toBeNull();
  });

  test('permission-denied state', () => {
    const { getByText } = renderPanel({
      error: new HttpClientError(403, 'Missing scope system:read', { faultCode: 'Forbidden' }),
    });
    expect(getByText('Permission denied')).not.toBeNull();
  });

  test('malformed-response state', () => {
    const { getByText } = renderPanel({
      error: new MalformedWorkerDiagnosticsError('response.worker.instance'),
    });
    expect(getByText('Malformed server response')).not.toBeNull();
  });

  test('server-fault state', () => {
    const { getByText } = renderPanel({ error: new HttpClientError(503, 'Service unavailable') });
    expect(getByText('Something went wrong')).not.toBeNull();
  });
});
