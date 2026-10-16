import { HttpClientError } from '@lostgradient/weft';
import { render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  CHARGE_HASH,
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
  test('shows each serving worker’s verification status for the workflow', async () => {
    const { findAllByText, findByRole, findByText } = renderPanel();

    expect(await findByRole('region', { name: 'Worker contract verification' })).not.toBeNull();
    expect(await findByText('Drift · 1 of 2 workers')).not.toBeNull();
    expect(await findAllByText('Matches registry')).not.toHaveLength(0);
    expect(await findByText('Drift detected')).not.toBeNull();
    expect(await findByText('Missing from worker')).not.toBeNull();
    expect(
      await findByText('1 other connected worker does not serve this workflow.'),
    ).not.toBeNull();
    expect(
      await findByRole('table', { name: 'worker-b checkout activity verification' }),
    ).not.toBeNull();
  });

  test('every serving worker matching reads as verified', async () => {
    const { findByText } = renderPanel({
      diagnostics: [workerManifest({ checkout: matchingCheckout() })],
    });
    expect(await findByText('Verified · every serving worker matches')).not.toBeNull();
    // A single serving worker names its manifest file in the command.
    expect(
      await findByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry-v2.json',
      ),
    ).not.toBeNull();
  });

  test('loading state', async () => {
    const { findByRole, queryByText } = renderPanel({ loading: true });
    expect(
      await findByRole('status', { name: 'Loading worker contract verification' }),
    ).not.toBeNull();
    expect(queryByText('Drift · 1 of 2 workers')).toBeNull();
  });

  test('empty state: no worker serves the workflow', async () => {
    const { findByText } = renderPanel({ workflow: 'refund' });
    expect(await findByText('No worker manifests for this workflow')).not.toBeNull();
  });

  test('empty state: no manifests yet', async () => {
    const { findByText } = renderPanel({ diagnostics: [] });
    expect(await findByText('No worker manifests for this workflow')).not.toBeNull();
  });

  test('stale state keeps cached evidence with the neutral refreshing badge', async () => {
    const { findByText } = renderPanel({ refreshing: true });
    expect(await findByText('Refreshing · showing cached evidence')).not.toBeNull();
    expect(await findByText('Drift · 1 of 2 workers')).not.toBeNull();
  });

  test('permission-denied state', async () => {
    const { findByText } = renderPanel({
      error: new HttpClientError(403, 'Missing scope system:read', { faultCode: 'Forbidden' }),
    });
    expect(await findByText('Permission denied')).not.toBeNull();
  });

  test('malformed-response state', async () => {
    const { findByText } = renderPanel({
      error: new MalformedWorkerDiagnosticsError('response.worker.instance'),
    });
    expect(await findByText('Malformed server response')).not.toBeNull();
  });

  test('server-fault state', async () => {
    const { findByText } = renderPanel({ error: new HttpClientError(503, 'Service unavailable') });
    expect(await findByText('Something went wrong')).not.toBeNull();
  });

  test('names the activity whose contract hash differs on a serving worker', async () => {
    const { findByRole } = renderPanel({
      diagnostics: [
        workerManifest(
          {
            checkout: {
              ...matchingCheckout(),
              activities: {
                ...matchingCheckout().activities,
                charge: { contractHash: 'sha256:charge-v2', implementationRevision: 'impl-2' },
              },
            },
          },
          { workerId: 'worker-d' },
        ),
      ],
    });

    const table = await findByRole('table', { name: 'worker-d checkout activity verification' });
    const charge = within(table)
      .getAllByRole('row')
      .find((row) => row.textContent?.includes('charge'));
    expect(charge?.textContent).toContain('Contract hash differs from registry');
    expect(charge?.textContent).toContain(CHARGE_HASH);
  });

  test('loading state while the expected activity hashes are computed', async () => {
    const { getByRole, findByText } = renderPanel();
    expect(getByRole('status', { name: 'Loading worker contract verification' })).not.toBeNull();
    expect(await findByText('Drift · 1 of 2 workers')).not.toBeNull();
  });
});
