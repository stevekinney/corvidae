import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState } from '@lostgradient/weft';

import Header from './header.svelte';

const BINDING = {
  workflowId: 'wf_1',
  workflowType: 'order-fulfillment',
  deploymentName: 'orders',
  buildId: 'build-1',
  artifactDigest: 'sha256:artifact-1',
  manifestDigest: 'sha256:manifest-1',
  routingGeneration: 3,
  workflowRevision: 'rev-a',
  workflowContractHash: 'wch-1',
  activityContracts: { charge: 'ach-1' },
  activityName: 'charge',
  activityContractHash: 'ach-1',
  boundAt: 1_000,
  checkpointId: 'wf_1',
};

function renderHeader(fields: Record<string, unknown>) {
  return render(Header, {
    props: {
      workflow: {
        id: 'wf_1',
        type: 'order-fulfillment',
        status: 'completed',
        input: {},
        versionTuple: { workflowVersion: '1' },
        createdAt: 1_000,
        updatedAt: 1_000,
        ...fields,
      } as WorkflowState,
      now: 2_000,
      pendingAction: null,
      onAction: () => {},
      activeTab: 'overview',
      onNavigateToTab: () => {},
      finalizerStatus: null,
      onRunQuery: async () => undefined,
      activeRevision: undefined,
    },
  });
}

describe('Header worker versioning badge', () => {
  test('a pinned run shows a text badge', () => {
    const { getByText } = renderHeader({
      workerVersioningPolicy: { mode: 'pinned' },
      workerBinding: { current: BINDING, history: [] },
    });
    expect(getByText('Worker: pinned')).not.toBeNull();
  });

  test('an auto-upgrade run shows a text badge', () => {
    const { getByText } = renderHeader({
      workerVersioningPolicy: {
        mode: 'auto-upgrade',
        compatibility: {
          deploymentName: 'orders',
          buildId: 'build-2',
          artifactDigest: 'a',
          manifestDigest: 'm',
          workflowRevision: 'rev-a',
          activityContractHash: 'ach-1',
        },
      },
      workerBinding: { current: BINDING, history: [] },
    });
    expect(getByText('Worker: auto-upgrade')).not.toBeNull();
  });

  test('a run with no worker data shows no worker badge', () => {
    const { queryByText } = renderHeader({});
    expect(queryByText(/^Worker:/)).toBeNull();
    expect(queryByText('Worker binding unreadable')).toBeNull();
  });

  test('an unreadable binding shows a warning badge in text', () => {
    const { getByText } = renderHeader({ workerVersioningPolicy: { mode: 'pinned' } });
    expect(getByText('Worker binding unreadable')).not.toBeNull();
  });
});
