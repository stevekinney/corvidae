import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import type { ComponentProps } from 'svelte';

import { activityContractHash, HttpClientError } from '@lostgradient/weft';

import type { RegistrySnapshotSource } from '../system/registry-view.ts';
import ContractVerificationPanel from './contract-verification-panel.svelte';
import {
  MalformedWorkerDiagnosticsError,
  type WorkerManifestDiagnostics,
} from './worker-manifest-diagnostics.ts';

const chargeSchema = {
  inputSchema: { type: 'object', properties: { amount: { type: 'number' } } },
};

const registry: RegistrySnapshotSource = {
  registryVersion: 2,
  workflows: [
    {
      manifestVersion: 1,
      name: 'checkout',
      workflowVersion: '2.0.0',
      revision: 'checkout-rev',
      contractHash: 'sha256:checkout',
      contract: {
        name: 'checkout',
        workflowVersion: '2.0.0',
        activities: { charge: chargeSchema },
      },
    },
  ],
  activeRevisions: { checkout: 'checkout-rev' },
  activities: {},
};

function diagnostics(
  workerId: string,
  chargeHash: string,
  workflows?: WorkerManifestDiagnostics['deploymentVersion']['workflows'],
): WorkerManifestDiagnostics {
  return {
    instance: {
      workerId,
      queue: 'payments',
      health: 'active',
      connectedAt: 1,
      startedAt: 1,
      lastHeartbeatAt: 1,
      heartbeatAgeMs: 1,
    },
    deploymentVersion: {
      deploymentName: 'payments-api',
      buildId: 'build-7',
      artifactDigest: 'sha256:artifact',
      runtimeName: 'bun',
      runtimeVersion: '1.3.0',
      sdkVersion: '0.20.0',
      manifestVersion: 1,
      protocolVersion: 3,
      manifestDigest: 'sha256:manifest',
      workflows: workflows ?? {
        checkout: {
          workflowVersion: '2.0.0',
          workflowRevision: 'checkout-rev',
          contractHash: 'sha256:checkout',
          activities: { charge: { contractHash: chargeHash, implementationRevision: 'impl' } },
        },
      },
    },
  };
}

type PanelProps = ComponentProps<typeof ContractVerificationPanel>;

function renderPanel(overrides: Record<string, unknown> = {}) {
  const props = {
    diagnostics: [],
    snapshot: registry,
    loading: false,
    refreshing: false,
    error: null,
    ...overrides,
  } as PanelProps;
  return render(ContractVerificationPanel, { props });
}

describe('ContractVerificationPanel', () => {
  test('shows a matching manifest as text, not color alone', async () => {
    const view = renderPanel({
      diagnostics: [diagnostics('worker-a', await activityContractHash(chargeSchema))],
    });
    expect(await view.findByText('Matches registry')).not.toBeNull();
    expect(view.getByRole('region', { name: 'Contract verification' })).not.toBeNull();
  });

  test('lists drift findings with labels, reasons, and both identities', async () => {
    const view = renderPanel({
      diagnostics: [
        diagnostics('worker-a', 'sha256:stale', {
          checkout: {
            workflowVersion: '2.0.0',
            workflowRevision: 'checkout-rev',
            contractHash: 'sha256:checkout',
            activities: {
              charge: { contractHash: 'sha256:stale', implementationRevision: 'impl' },
              audit: { contractHash: 'sha256:audit', implementationRevision: 'impl' },
            },
          },
        }),
      ],
    });
    expect(await view.findByText('Drift · 2 findings')).not.toBeNull();
    expect(view.getByRole('table', { name: 'Contract drift for worker worker-a' })).not.toBeNull();
    expect(view.getByText('Extra activity')).not.toBeNull();
    expect(view.getByText('Activity contract hash mismatch')).not.toBeNull();
    expect(view.getByText('contract-hash-mismatch')).not.toBeNull();
    expect(view.getByText('checkout.audit')).not.toBeNull();
    expect(view.getByText('checkout.charge')).not.toBeNull();
  });

  test('renders the copyable commands with the known manifest substituted', async () => {
    const view = renderPanel({
      diagnostics: [diagnostics('worker-a', await activityContractHash(chargeSchema))],
    });
    await view.findByText('Matches registry');
    expect(
      view.getByText('weft codegen --from weft-registry.json --out weft-registry.d.ts'),
    ).not.toBeNull();
    expect(
      view.getByText(
        'weft worker verify --manifest payments-api-build-7.manifest.json --from weft-registry.json',
      ),
    ).not.toBeNull();
    expect(view.getAllByRole('button', { name: /copy/i }).length).toBeGreaterThanOrEqual(2);
  });

  test('shows a loading state', () => {
    const view = renderPanel({ loading: true });
    expect(view.getByRole('status', { name: 'Loading contract verification' })).not.toBeNull();
  });

  test('shows the cached-evidence badge while refreshing', async () => {
    const view = renderPanel({
      refreshing: true,
      diagnostics: [diagnostics('worker-a', await activityContractHash(chargeSchema))],
    });
    expect(view.getByText('Refreshing · showing cached evidence')).not.toBeNull();
    expect(await view.findByText('Matches registry')).not.toBeNull();
  });

  test('shows an empty state when no manifest is accepted', () => {
    const view = renderPanel({ diagnostics: [] });
    expect(view.getByText('No accepted manifests')).not.toBeNull();
  });

  test('shows an empty state when there is no registry snapshot yet', () => {
    expect(
      renderPanel({ snapshot: undefined }).getByText('No registry snapshot yet'),
    ).not.toBeNull();
  });

  test('treats an empty registry as no snapshot to compare against', () => {
    const view = renderPanel({
      snapshot: { registryVersion: 2, workflows: [], activeRevisions: {}, activities: {} },
      diagnostics: [diagnostics('worker-a', 'sha256:x')],
    });
    expect(view.getByText('No registry snapshot yet')).not.toBeNull();
  });

  test('shows when no worker serves the selected workflow', async () => {
    const view = renderPanel({
      workflowName: 'billing',
      diagnostics: [diagnostics('worker-a', 'sha256:x')],
    });
    expect(await view.findByText('No worker serves this workflow')).not.toBeNull();
  });

  test('shows permission denied for a 403', () => {
    const view = renderPanel({
      error: new HttpClientError(403, 'Forbidden', { faultCode: 'Forbidden' }),
    });
    expect(view.getByText('Permission denied')).not.toBeNull();
    expect(view.getByText(/requires the system:read scope/)).not.toBeNull();
  });

  test('shows a malformed-response state', () => {
    const view = renderPanel({
      error: new MalformedWorkerDiagnosticsError('response.worker.instance.health'),
    });
    expect(view.getByText('Malformed server response')).not.toBeNull();
    expect(view.getByText(/response\.worker\.instance\.health/)).not.toBeNull();
  });

  test('shows a server-fault state', () => {
    const view = renderPanel({ error: new HttpClientError(500, 'Engine unavailable') });
    expect(view.getByText('Something went wrong')).not.toBeNull();
    expect(view.queryByText('Permission denied')).toBeNull();
  });
});
