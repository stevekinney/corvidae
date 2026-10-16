import { HttpClientError } from '@lostgradient/weft';
import { render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  matchingCheckout,
  registrySnapshot,
  RESERVE_HASH,
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
  test('a matching manifest reads as verified in text, not only color', async () => {
    const { findByRole, findByText, findAllByText } = renderPanel();

    expect(await findByRole('region', { name: 'Contract verification' })).not.toBeNull();
    expect(await findByText('Verified · manifest matches registry')).not.toBeNull();
    expect(await findAllByText('Matches registry')).not.toHaveLength(0);
    expect(await findByText('1 registry workflow not served by this worker')).not.toBeNull();
  });

  test('drift names each missing, extra, and changed activity', async () => {
    const drifted = {
      ...matchingCheckout(),
      workflowVersion: '3.0.0',
      contractHash: 'sha256:drifted',
      activities: {
        charge: { contractHash: 'sha256:charge-v2', implementationRevision: 'impl-2' },
        refundCard: { contractHash: 'sha256:refund-card', implementationRevision: 'impl-1' },
      },
    };
    const { findByText } = renderPanel({ diagnostics: workerManifest({ checkout: drifted }) });

    expect(await findByText('Drift · manifest differs from registry')).not.toBeNull();
    expect(await findByText('Drift detected')).not.toBeNull();
    expect(
      await findByText('Workflow version differs from the active registry revision'),
    ).not.toBeNull();
    expect(
      await findByText('Contract hash differs from the active registry revision'),
    ).not.toBeNull();
    expect(await findByText('Missing from worker')).not.toBeNull();
    expect(await findByText('Not in registry')).not.toBeNull();
    expect(await findByText('Contract hash differs from registry')).not.toBeNull();
    expect(await findByText('sha256:refund-card')).not.toBeNull();
  });

  test('renders copyable CLI commands with the known file names substituted', async () => {
    const { findByText, findByRole } = renderPanel();

    expect(
      await findByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry-v2.json',
      ),
    ).not.toBeNull();
    expect(
      await findByText('weft codegen --from registry-v2.json --out weft-registry.d.ts'),
    ).not.toBeNull();
    expect(await findByRole('button', { name: 'Copy weft worker verify command' })).not.toBeNull();
    expect(await findByRole('button', { name: 'Copy weft codegen command' })).not.toBeNull();
  });

  test('loading state', async () => {
    const { findByRole, queryByText } = renderPanel({ loading: true });
    expect(await findByRole('status', { name: 'Loading contract verification' })).not.toBeNull();
    // A verdict is never claimed while evidence is still loading.
    expect(queryByText('Verified · manifest matches registry')).toBeNull();
  });

  test('empty state: no accepted manifest', async () => {
    const { findByText, queryByText } = renderPanel({ diagnostics: null });
    expect(await findByText('No accepted manifest')).not.toBeNull();
    expect(queryByText('Verified · manifest matches registry')).toBeNull();
  });

  test('empty state: no registry snapshot yet', async () => {
    const { findByText } = renderPanel({ registry: undefined });
    expect(await findByText('No registry snapshot yet')).not.toBeNull();
    // Without a snapshot the command still names the worker's manifest file.
    expect(
      await findByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from registry.json',
      ),
    ).not.toBeNull();
  });

  test('empty state: a registry with no workflow revisions', async () => {
    const { findByText } = renderPanel({
      registry: { ...registrySnapshot(), workflows: [], activeRevisions: {} },
    });
    expect(await findByText('No registry snapshot yet')).not.toBeNull();
  });

  test('stale state keeps cached evidence with the neutral refreshing badge', async () => {
    const { findByText } = renderPanel({ refreshing: true });
    expect(await findByText('Refreshing · showing cached evidence')).not.toBeNull();
    expect(await findByText('Verified · manifest matches registry')).not.toBeNull();
  });

  test('permission-denied state', async () => {
    const { findByText } = renderPanel({
      error: new HttpClientError(403, 'Missing scope system:read', { faultCode: 'Forbidden' }),
    });
    expect(await findByText('Permission denied')).not.toBeNull();
  });

  test('malformed-response state', async () => {
    const { findByText } = renderPanel({
      error: new MalformedWorkerDiagnosticsError('response.worker.deploymentVersion.workflows'),
    });
    expect(await findByText('Malformed server response')).not.toBeNull();
  });

  test('malformed-response state from the registry snapshot', async () => {
    const { findByText } = renderPanel({ error: new MalformedRegistrySnapshotError() });
    expect(await findByText('Malformed server response')).not.toBeNull();
    expect(await findByText('The server returned a malformed registry snapshot.')).not.toBeNull();
  });

  test('server-fault state', async () => {
    const { findByText } = renderPanel({
      error: new HttpClientError(500, 'Internal server error'),
    });
    expect(await findByText('Something went wrong')).not.toBeNull();
    expect(await findByText('Internal server error')).not.toBeNull();
  });

  test('a strict payload rejection and a contract mismatch get different copy', async () => {
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
    expect(await strict.findByText('Strict payload boundary rejected a value')).not.toBeNull();
    expect(strict.queryByText('Contract mismatch')).toBeNull();
    strict.unmount();

    const mismatch = renderPanel({
      error: new HttpClientError(409, 'Conflict', {
        faultCode: 'Conflict',
        data: { compatibilityReasons: ['contract-hash-mismatch'] },
      }),
    });
    expect(await mismatch.findByText('Contract mismatch')).not.toBeNull();
    expect(
      await mismatch.findByText('Candidate payload contract differs from the active revision.'),
    ).not.toBeNull();
    expect(mismatch.queryByText('Strict payload boundary rejected a value')).toBeNull();
  });

  test('a worker that advertises no workflows says so', async () => {
    const { findByText } = renderPanel({ diagnostics: workerManifest({}) });
    expect(await findByText('This worker advertises no workflows.')).not.toBeNull();
    expect(await findByText('2 registry workflows not served by this worker')).not.toBeNull();
  });

  test('a workflow the registry has no active revision of is explained', async () => {
    const { findByText } = renderPanel({
      diagnostics: workerManifest({
        ghost: {
          workflowVersion: '0.0.0',
          workflowRevision: 'ghost-rev',
          contractHash: 'sha256:ghost',
          activities: {},
        },
      }),
    });
    expect(await findByText('Not in registry')).not.toBeNull();
    expect(await findByText(/registry has no active revision of this workflow/)).not.toBeNull();
    expect(
      await findByText('Neither the worker nor the registry declares activities.'),
    ).not.toBeNull();
  });

  test('loading state while the expected activity hashes are computed', async () => {
    const { getByRole, queryByText, findByText } = renderPanel();
    // Hashing is asynchronous, so no verdict is claimed on the first render.
    expect(getByRole('status', { name: 'Loading contract verification' })).not.toBeNull();
    expect(queryByText('Verified · manifest matches registry')).toBeNull();
    expect(await findByText('Verified · manifest matches registry')).not.toBeNull();
  });

  test('attributes contract-hash drift to the activity that changed, with both hashes', async () => {
    const changed = {
      ...matchingCheckout(),
      contractHash: 'sha256:drifted',
      activities: {
        ...matchingCheckout().activities,
        reserve: { contractHash: 'sha256:reserve-v2', implementationRevision: 'impl-2' },
      },
    };
    const { findByRole } = renderPanel({ diagnostics: workerManifest({ checkout: changed }) });

    const table = await findByRole('table', { name: 'checkout activity verification' });
    const rows = within(table).getAllByRole('row');
    const reserve = rows.find((row) => row.textContent?.includes('reserve'));
    const charge = rows.find((row) => row.textContent?.includes('charge'));
    expect(reserve?.textContent).toContain('Contract hash differs from registry');
    expect(reserve?.textContent).toContain('sha256:reserve-v2');
    expect(reserve?.textContent).toContain(RESERVE_HASH);
    expect(charge?.textContent).toContain('Matches registry');
  });

  test('a registry activity contract that cannot be hashed renders a fault, not a verdict', async () => {
    const snapshot = registrySnapshot();
    const unhashable = {
      ...snapshot,
      workflows: snapshot.workflows.map((manifest) =>
        manifest.revision === 'rev-2'
          ? {
              ...manifest,
              contract: {
                ...manifest.contract,
                activities: { charge: { inputSchema: { x: 1n } } },
              },
            }
          : manifest,
      ),
    };
    const { findByText, queryByText } = renderPanel({ registry: unhashable });
    expect(await findByText('Something went wrong')).not.toBeNull();
    expect(queryByText('Verified · manifest matches registry')).toBeNull();
  });
});
