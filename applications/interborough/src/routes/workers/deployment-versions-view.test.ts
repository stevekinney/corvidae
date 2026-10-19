import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import type { ScopeGate } from '../../lib/scopes.svelte.ts';
import DeploymentVersionsView from './deployment-versions-view.svelte';
import type { DeploymentOverview } from './deployments-data.ts';
import { NOW, routing, version } from './deployments-test-support.test-support.ts';
import type { WorkerSummary } from './worker-catalog-types.ts';

const OPEN_GATE: ScopeGate = { disabled: false, title: undefined };
const LOCKED_GATE: ScopeGate = { disabled: true, title: 'Requires system:admin' };

function overview(overrides: Partial<DeploymentOverview> = {}): DeploymentOverview {
  return {
    deploymentName: 'billing',
    versions: [
      version('build-a', { firstSeenAt: NOW - 300, executionReferences: 2 }),
      version('build-b', { firstSeenAt: NOW - 200 }),
      version('build-c', { firstSeenAt: NOW - 100 }),
    ],
    routing: routing({
      currentBuildId: 'build-b',
      rampingBuildId: 'build-c',
      rampBasisPoints: 1_250,
      generation: 5,
    }),
    ...overrides,
  };
}

function connectedWorker(buildId: string): WorkerSummary {
  return {
    id: `wkr-${buildId}`,
    transport: 'websocket',
    queue: 'default',
    activities: [],
    concurrency: 4,
    inFlight: 1,
    availableCapacity: 3,
    connectedAt: 0,
    lastHeartbeatAt: 0,
    startedAt: 0,
    heartbeatAgeMs: 1,
    capabilities: {},
    health: 'active',
    deploymentName: 'billing',
    buildId,
  };
}

function renderView(
  props: Partial<Parameters<typeof render<typeof DeploymentVersionsView>>[1]> = {},
  gate: ScopeGate = OPEN_GATE,
) {
  const calls: string[] = [];
  const view = render(DeploymentVersionsView, {
    props: {
      overviews: [overview()],
      workers: [],
      adminGate: gate,
      now: NOW,
      onSetRouting: (name: string) => calls.push(`set:${name}`),
      onMove: (kind: string, name: string, build: string) => calls.push(`${kind}:${name}/${build}`),
      onDrain: (name: string, build: string) => calls.push(`drain:${name}/${build}`),
      onResume: (name: string, build: string) => calls.push(`resume:${name}/${build}`),
      onRemove: (name: string, build: string) => calls.push(`remove:${name}/${build}`),
      ...props,
    } as never,
  });
  return { ...view, calls };
}

function row(container: HTMLElement, buildId: string): HTMLElement {
  const found = Array.from(container.querySelectorAll<HTMLElement>('tbody tr')).find((candidate) =>
    candidate.textContent?.includes(buildId),
  );
  if (!found) throw new Error(`missing row for ${buildId}`);
  return found;
}

describe('DeploymentVersionsView — what the server reports', () => {
  test('shows the routing pointer: current and ramping builds, share as a percentage, generation', () => {
    const { getByText } = renderView();
    expect(getByText('Current build').nextElementSibling?.textContent).toContain('build-b');
    expect(getByText('Ramping build').nextElementSibling?.textContent).toContain('build-c');
    expect(getByText('Traffic to the ramping build').nextElementSibling?.textContent).toContain(
      '12.5% (1250 of 10000 basis points)',
    );
    expect(getByText('Rollout generation').nextElementSibling?.textContent?.trim()).toBe('5');
  });

  test('lists each build with its state, digests, references, role, and connected workers', () => {
    const { container } = renderView({
      workers: [connectedWorker('build-b'), connectedWorker('build-b')],
    });
    const a = row(container, 'build-a');
    expect(within(a).getByText('Ready')).not.toBeNull();
    expect(within(a).getByText('2 referenced · reachable')).not.toBeNull();
    expect(within(a).getByText('None connected')).not.toBeNull();
    const b = row(container, 'build-b');
    expect(within(b).getByText('Current')).not.toBeNull();
    expect(within(b).getByText(/2 workers · 2\/8 in flight/)).not.toBeNull();
    expect(within(b).getByText('0 unreferenced')).not.toBeNull();
    expect(within(row(container, 'build-c')).getByText('Ramping')).not.toBeNull();
    expect(container.querySelector('[title="sha256:artifact-build-a"]')).not.toBeNull();
    expect(container.querySelector('[title="sha256:manifest-build-a"]')).not.toBeNull();
  });

  test('names a draining state and operator-drained workers in text', () => {
    const { container } = renderView({
      overviews: [overview({ versions: [version('build-a', { state: 'draining' })] })],
      workers: [{ ...connectedWorker('build-a'), health: 'draining' }],
    });
    const a = row(container, 'build-a');
    expect(within(a).getByText('Draining')).not.toBeNull();
    expect(within(a).getByText(/1 draining, 0 drained/)).not.toBeNull();
  });

  test('says there is no routing pointer yet, and counts removed builds without listing them', () => {
    const { getByText, container } = renderView({
      overviews: [
        overview({
          routing: null,
          versions: [version('build-a'), version('build-z', { state: 'removed' })],
        }),
      ],
    });
    expect(getByText(/No routing pointer yet/)).not.toBeNull();
    expect(getByText(/1 removed build is retained by the server and not listed/)).not.toBeNull();
    expect(container.textContent).not.toContain('build-z');
  });

  test('an empty server shows the empty state', () => {
    const { getByText } = renderView({ overviews: [] });
    expect(getByText('No deployment versions')).not.toBeNull();
  });
});

describe('DeploymentVersionsView — actions', () => {
  test('offers promote and rollback by build age, drain and resume per build, and set routing', async () => {
    const { container, calls, getByRole } = renderView();
    await fireEvent.click(getByRole('button', { name: 'Set routing' }));
    await fireEvent.click(
      within(row(container, 'build-a')).getByRole('button', { name: 'Roll back to' }),
    );
    await fireEvent.click(
      within(row(container, 'build-c')).getByRole('button', { name: 'Promote' }),
    );
    await fireEvent.click(within(row(container, 'build-b')).getByRole('button', { name: 'Drain' }));
    await fireEvent.click(
      within(row(container, 'build-b')).getByRole('button', { name: 'Resume' }),
    );
    expect(calls).toEqual([
      'set:billing',
      'rollback:billing/build-a',
      'promote:billing/build-c',
      'drain:billing/build-b',
      'resume:billing/build-b',
    ]);
    // The current build is already current.
    expect(
      within(row(container, 'build-b')).queryByRole('button', { name: /Promote|Roll back/ }),
    ).toBeNull();
  });

  test('removal is offered only for a build nothing depends on, and says exactly why it is not', async () => {
    const { container, calls } = renderView();
    // build-a is referenced; build-b is current; build-c is ramping.
    for (const [buildId, reason] of [
      ['build-a', 'Build billing/build-a is still referenced by 2 executions'],
      ['build-b', 'Build billing/build-b is the current build of its routing pointer'],
      ['build-c', 'Build billing/build-c is the ramping build of its routing pointer'],
    ] as const) {
      const target = row(container, buildId);
      expect(within(target).getByRole('button', { name: 'Remove' }).hasAttribute('disabled')).toBe(
        true,
      );
      expect(within(target).getByText(new RegExp(`Cannot remove: ${reason}`))).not.toBeNull();
    }
    expect(calls).toEqual([]);

    const free = renderView({
      overviews: [overview({ routing: routing({ currentBuildId: 'build-b' }) })],
    });
    const removable = within(row(free.container, 'build-c')).getByRole('button', {
      name: 'Remove',
    });
    expect(removable.hasAttribute('disabled')).toBe(false);
    await fireEvent.click(removable);
    expect(free.calls).toEqual(['remove:billing/build-c']);
  });

  test('without system:admin every action is disabled and the reason is on offer', () => {
    const { container, getByRole } = renderView({}, LOCKED_GATE);
    expect(getByRole('button', { name: 'Set routing' }).hasAttribute('disabled')).toBe(true);
    for (const buildId of ['build-a', 'build-b', 'build-c']) {
      expect(
        within(row(container, buildId))
          .getByRole('button', { name: 'Drain' })
          .hasAttribute('disabled'),
      ).toBe(true);
      expect(within(row(container, buildId)).queryByRole('button', { name: 'Remove' })).toBeNull();
    }
  });
});

describe('DeploymentVersionsView — workflow bucket', () => {
  test('explains which build a typed workflow id lands on', async () => {
    const { getByLabelText, getByRole } = renderView({
      overviews: [
        overview({
          routing: routing({
            currentBuildId: 'build-b',
            rampingBuildId: 'build-c',
            rampBasisPoints: 10_000,
          }),
        }),
      ],
    });
    expect(getByRole('status').textContent).toContain('Enter a workflow id');
    await fireEvent.input(getByLabelText('Workflow ID'), { target: { value: 'wf-42' } });
    expect(getByRole('status').textContent).toContain(
      'wf-42 lands on build build-c, the ramping build',
    );
  });
});
