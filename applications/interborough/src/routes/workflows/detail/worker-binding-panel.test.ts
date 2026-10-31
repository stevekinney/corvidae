import { render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { WorkflowState } from '@lostgradient/weft';

import WorkerBindingPanel from './worker-binding-panel.svelte';

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
  activityContracts: { charge: 'ach-1', ship: 'ach-2' },
  activityName: 'charge',
  activityContractHash: 'ach-1',
  boundAt: 1_700_000_000_000,
  checkpointId: 'wf_1',
};

const COMPATIBILITY = {
  deploymentName: 'orders',
  buildId: 'build-2',
  artifactDigest: 'sha256:artifact-2',
  manifestDigest: 'sha256:manifest-2',
  workflowRevision: 'rev-a',
  activityContractHash: 'ach-1',
};

function workflow(fields: Record<string, unknown> = {}): WorkflowState {
  return {
    id: 'wf_1',
    type: 'order-fulfillment',
    status: 'completed',
    input: null,
    versionTuple: { workflowVersion: '1' },
    createdAt: 1_000,
    updatedAt: 1_000,
    ...fields,
  };
}

describe('WorkerBindingPanel', () => {
  test('a run with no worker versioning data says so', () => {
    const { getByText, queryByTestId } = render(WorkerBindingPanel, {
      props: { workflow: workflow() },
    });
    expect(getByText(/No worker version/)).not.toBeNull();
    expect(queryByTestId('worker-binding-why')).toBeNull();
  });

  test('a pinned run shows its policy, binding, contract hashes, and why it cannot move', () => {
    const { getByText, getByTestId, container } = render(WorkerBindingPanel, {
      props: {
        workflow: workflow({
          workerVersioningPolicy: { mode: 'pinned' },
          workerBinding: { current: BINDING, history: [] },
        }),
      },
    });
    expect(getByTestId('worker-binding-why').textContent).toContain('Pinned');
    expect(getByTestId('worker-binding-why').textContent).toContain('build-1');
    for (const value of [
      'orders',
      'sha256:artifact-1',
      'sha256:manifest-1',
      'wch-1',
      'charge: ach-1; ship: ach-2',
    ]) {
      expect(container.textContent).toContain(value);
    }
    expect(getByText(/No earlier versions/)).not.toBeNull();
    expect(getByTestId('worker-binding-override-note').textContent).toContain(
      'cannot be overridden',
    );
  });

  test('an auto-upgrade run shows its compatibility requirement and every history entry', () => {
    const { getByTestId, container } = render(WorkerBindingPanel, {
      props: {
        workflow: workflow({
          status: 'running',
          workerVersioningPolicy: { mode: 'auto-upgrade', compatibility: COMPATIBILITY },
          workerBinding: {
            current: BINDING,
            history: [{ ...BINDING, buildId: 'build-0', routingGeneration: 1 }],
          },
        }),
      },
    });
    expect(container.textContent).toContain('sha256:artifact-2');
    expect(container.textContent).toContain('Requires build');
    expect(getByTestId('worker-binding-why').textContent).toContain('Auto-upgrade');
    const history = container.querySelector('ol');
    expect(history?.querySelectorAll('li').length).toBe(1);
    expect(history?.textContent).toContain('build-0');
    expect(getByTestId('worker-binding-override-note').textContent).toContain('terminal');
  });

  test('lists the binding history oldest first, though Weft stores it newest first', () => {
    // Weft prepends each replaced binding, so the stored array is newest first.
    const newest = { ...BINDING, buildId: 'build-2', routingGeneration: 2, boundAt: 2_000 };
    const oldest = { ...BINDING, buildId: 'build-0', routingGeneration: 1, boundAt: 1_000 };
    const { container } = render(WorkerBindingPanel, {
      props: {
        workflow: workflow({
          workerVersioningPolicy: { mode: 'auto-upgrade', compatibility: COMPATIBILITY },
          workerBinding: { current: BINDING, history: [newest, oldest] },
        }),
      },
    });
    const history = container.querySelector('ol');
    expect(history?.getAttribute('aria-label')).toContain('oldest first');
    const entries = [...(history?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toContain('build-0');
    expect(entries[1]).toContain('build-2');
  });

  test('a terminal auto-upgrade run says a restart can offer an override', () => {
    const { getByTestId } = render(WorkerBindingPanel, {
      props: {
        workflow: workflow({
          workerVersioningPolicy: { mode: 'auto-upgrade', compatibility: COMPATIBILITY },
          workerBinding: { current: BINDING, history: [] },
        }),
      },
    });
    expect(getByTestId('worker-binding-override-note').textContent).toContain('system:admin');
  });

  test('a record the guard refuses renders the reason and none of the data', () => {
    const { getByText, queryByTestId, container } = render(WorkerBindingPanel, {
      props: {
        workflow: workflow({
          workerVersioningPolicy: { mode: 'pinned' },
          workerBinding: { current: { ...BINDING, routingGeneration: 'three' }, history: [] },
        }),
      },
    });
    expect(getByText('Worker version unreadable')).not.toBeNull();
    expect(container.textContent).toContain('workerBinding.current.routingGeneration');
    expect(queryByTestId('worker-binding-why')).toBeNull();
    expect(container.textContent).not.toContain('sha256:artifact-1');
  });

  test('every state states the activity rule', () => {
    const { container } = render(WorkerBindingPanel, { props: { workflow: workflow() } });
    expect(container.textContent).toContain('Workflow-bound and standalone activities');
  });
});
