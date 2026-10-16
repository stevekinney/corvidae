import { HttpClientError } from '@lostgradient/weft';
import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  matchingCheckout,
  registrySnapshot,
  workerManifest,
} from './contract-verification.test-support.ts';
import { MalformedRegistrySnapshotError } from './contract-verification.ts';
import WorkerContractVerificationPanel from './worker-contract-verification-panel.svelte';
import { MalformedWorkerDiagnosticsError } from './worker-manifest-diagnostics.ts';

type PanelProps = {
  diagnostics: ReturnType<typeof workerManifest> | null | undefined;
  registry: ReturnType<typeof registrySnapshot> | undefined;
  loading: boolean;
  refreshing: boolean;
  error: unknown;
};

function renderPanel(overrides: Partial<PanelProps> = {}) {
  const props: PanelProps = {
    diagnostics: workerManifest({ checkout: matchingCheckout() }),
    registry: registrySnapshot(),
    loading: false,
    refreshing: false,
    error: null,
    ...overrides,
  };
  return render(WorkerContractVerificationPanel, { props });
}

describe('WorkerContractVerificationPanel', () => {
  test('a matching manifest reads as verified in text, not only color', () => {
    const { getByRole, getByText, getAllByText } = renderPanel();

    expect(getByRole('region', { name: 'Contract verification' })).not.toBeNull();
    expect(getByText('Verified · manifest matches registry')).not.toBeNull();
    expect(getAllByText('Matches registry').length).toBeGreaterThan(0);
    expect(getByText('1 registry workflow not served by this worker')).not.toBeNull();
  });

  test('drift names each missing, extra, and changed activity', () => {
    const drifted = {
      ...matchingCheckout(),
      workflowVersion: '3.0.0',
      contractHash: 'sha256:drifted',
      activities: {
        charge: { contractHash: 'sha256:charge-v2', implementationRevision: 'impl-2' },
        refundCard: { contractHash: 'sha256:refund-card', implementationRevision: 'impl-1' },
      },
    };
    const { getByText } = renderPanel({ diagnostics: workerManifest({ checkout: drifted }) });

    expect(getByText('Drift · manifest differs from registry')).not.toBeNull();
    expect(getByText('Drift detected')).not.toBeNull();
    expect(getByText('Workflow version differs from the active registry revision')).not.toBeNull();
    expect(getByText('Contract hash differs from the active registry revision')).not.toBeNull();
    expect(getByText('Missing from worker')).not.toBeNull();
    expect(getByText('Not in registry')).not.toBeNull();
    expect(getByText('Hash not checked here')).not.toBeNull();
    expect(getByText('sha256:refund-card')).not.toBeNull();
  });

  test('renders copyable CLI commands with the known file names substituted', () => {
    const { getByText, getByRole } = renderPanel();

    expect(
      getByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry-v2.json',
      ),
    ).not.toBeNull();
    expect(
      getByText('weft codegen --from registry-v2.json --out weft-registry.d.ts'),
    ).not.toBeNull();
    expect(getByRole('button', { name: 'Copy weft worker verify command' })).not.toBeNull();
    expect(getByRole('button', { name: 'Copy weft codegen command' })).not.toBeNull();
  });

  test('loading state', () => {
    const { getByRole, queryByText } = renderPanel({ loading: true });
    expect(getByRole('status', { name: 'Loading contract verification' })).not.toBeNull();
    // A verdict is never claimed while evidence is still loading.
    expect(queryByText('Verified · manifest matches registry')).toBeNull();
  });

  test('empty state: no accepted manifest', () => {
    const { getByText, queryByText } = renderPanel({ diagnostics: null });
    expect(getByText('No accepted manifest')).not.toBeNull();
    expect(queryByText('Verified · manifest matches registry')).toBeNull();
  });

  test('empty state: no registry snapshot yet', () => {
    const { getByText } = renderPanel({ registry: undefined });
    expect(getByText('No registry snapshot yet')).not.toBeNull();
    // Without a snapshot the command still names the worker's manifest file.
    expect(
      getByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry.json',
      ),
    ).not.toBeNull();
  });

  test('empty state: a registry with no workflow revisions', () => {
    const { getByText } = renderPanel({
      registry: { ...registrySnapshot(), workflows: [], activeRevisions: {} },
    });
    expect(getByText('No registry snapshot yet')).not.toBeNull();
  });

  test('stale state keeps cached evidence with the neutral refreshing badge', () => {
    const { getByText } = renderPanel({ refreshing: true });
    expect(getByText('Refreshing · showing cached evidence')).not.toBeNull();
    expect(getByText('Verified · manifest matches registry')).not.toBeNull();
  });

  test('permission-denied state', () => {
    const { getByText } = renderPanel({
      error: new HttpClientError(403, 'Missing scope system:read', { faultCode: 'Forbidden' }),
    });
    expect(getByText('Permission denied')).not.toBeNull();
  });

  test('malformed-response state', () => {
    const { getByText } = renderPanel({
      error: new MalformedWorkerDiagnosticsError('response.worker.deploymentVersion.workflows'),
    });
    expect(getByText('Malformed server response')).not.toBeNull();
  });

  test('malformed-response state from the registry snapshot', () => {
    const { getByText } = renderPanel({ error: new MalformedRegistrySnapshotError() });
    expect(getByText('Malformed server response')).not.toBeNull();
    expect(getByText('The server returned a malformed registry snapshot.')).not.toBeNull();
  });

  test('server-fault state', () => {
    const { getByText } = renderPanel({ error: new HttpClientError(500, 'Internal server error') });
    expect(getByText('Something went wrong')).not.toBeNull();
    expect(getByText('Internal server error')).not.toBeNull();
  });

  test('a strict payload rejection and a contract mismatch get different copy', () => {
    const strict = renderPanel({
      error: new HttpClientError(422, 'Unprocessable', {
        faultCode: 'Unprocessable',
        data: {
          name: 'WorkerJsonValidationError',
          path: 'activity result.total',
          message: 'activity result.total: number must be finite',
        },
      }),
    });
    expect(strict.getByText('Strict payload boundary rejected a value')).not.toBeNull();
    expect(strict.queryByText('Contract mismatch')).toBeNull();
    strict.unmount();

    const mismatch = renderPanel({
      error: new HttpClientError(409, 'Conflict', {
        faultCode: 'Conflict',
        data: { compatibilityReasons: ['contract-hash-mismatch'] },
      }),
    });
    expect(mismatch.getByText('Contract mismatch')).not.toBeNull();
    expect(
      mismatch.getByText('Candidate payload contract differs from the active revision.'),
    ).not.toBeNull();
    expect(mismatch.queryByText('Strict payload boundary rejected a value')).toBeNull();
  });
});
