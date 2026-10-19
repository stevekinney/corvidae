import { describe, expect, test } from 'bun:test';

import {
  explainWorkflowBucket,
  formatBasisPoints,
  moveDirection,
  removalBlockedReason,
  versionFleet,
  versionRole,
  versionStatePresentation,
} from './deployments-presentation.ts';
import { NOW, routing, version } from './deployments-test-support.test-support.ts';
import type { WorkerSummary } from './worker-catalog-types.ts';

const NO_FLEET = { workers: 0, inFlight: 0, concurrency: 0, draining: 0, drained: 0 };

function worker(buildId: string, overrides: Partial<WorkerSummary> = {}): WorkerSummary {
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
    ...overrides,
  };
}

describe('formatBasisPoints', () => {
  test.each([
    [0, '0%'],
    [100, '1%'],
    [1_250, '12.5%'],
    [10_000, '100%'],
    [1, '0.01%'],
  ])('%d basis points reads %s', (basisPoints, text) => {
    expect(formatBasisPoints(basisPoints)).toBe(text);
  });
});

describe('version state and role', () => {
  test('spells out every lifecycle state', () => {
    expect(versionStatePresentation({ state: 'ready' })).toEqual({
      label: 'Ready',
      variant: 'success',
    });
    expect(versionStatePresentation({ state: 'draining' }).label).toBe('Draining');
    expect(versionStatePresentation({ state: 'removed' }).label).toBe('Removed');
  });

  test('names the current and ramping builds of the pointer', () => {
    const pointer = routing({ currentBuildId: 'build-a', rampingBuildId: 'build-b' });
    expect(versionRole(pointer, 'build-a')).toBe('current');
    expect(versionRole(pointer, 'build-b')).toBe('ramping');
    expect(versionRole(pointer, 'build-c')).toBe('none');
    expect(versionRole(null, 'build-a')).toBe('none');
  });

  test('sums the connected workers of one build from the fleet list', () => {
    const fleet = versionFleet(
      [
        worker('build-a'),
        worker('build-a', { id: 'two', health: 'draining', inFlight: 2 }),
        worker('build-b'),
        worker('build-a', { id: 'other', deploymentName: 'shipping' }),
      ],
      'billing',
      'build-a',
    );
    expect(fleet).toEqual({ workers: 2, inFlight: 3, concurrency: 8, draining: 1, drained: 0 });
  });
});

describe('removalBlockedReason', () => {
  const pointer = routing({ currentBuildId: 'build-a', rampingBuildId: 'build-b' });

  test('allows an unreferenced, unrouted build with no workers', () => {
    expect(removalBlockedReason(version('build-c'), pointer, NO_FLEET)).toBeUndefined();
  });

  test('names the build and the number of executions that still reference it', () => {
    expect(
      removalBlockedReason(version('build-c', { executionReferences: 1 }), pointer, NO_FLEET),
    ).toBe(
      'Build billing/build-c is still referenced by 1 execution (pinned runs, schedules, pending requirements, attempts, or realms), so it stays reachable.',
    );
    expect(
      removalBlockedReason(version('build-c', { executionReferences: 3 }), pointer, NO_FLEET),
    ).toContain('3 executions');
  });

  test('refuses the current and ramping builds of the pointer, naming the role', () => {
    expect(removalBlockedReason(version('build-a'), pointer, NO_FLEET)).toContain('current build');
    expect(removalBlockedReason(version('build-b'), pointer, NO_FLEET)).toContain('ramping build');
  });

  test('refuses a build whose workers are still connected', () => {
    expect(
      removalBlockedReason(version('build-c'), pointer, { ...NO_FLEET, workers: 2 }),
    ).toContain('2 connected workers still report build billing/build-c');
  });

  test('refuses an already removed build, and never cites capacity as a reason either way', () => {
    expect(
      removalBlockedReason(version('build-c', { state: 'removed' }), pointer, NO_FLEET),
    ).toContain('already removed');
    for (const reason of [
      removalBlockedReason(version('build-c', { executionReferences: 2 }), pointer, NO_FLEET),
      removalBlockedReason(version('build-a'), pointer, NO_FLEET),
      removalBlockedReason(version('build-c'), pointer, { ...NO_FLEET, workers: 1 }),
    ]) {
      expect(reason?.toLowerCase()).not.toContain('capacity');
    }
  });
});

describe('moveDirection', () => {
  test('moving to an older build is a rollback, to a newer one a promotion', () => {
    const old = version('build-a', { firstSeenAt: NOW - 200 });
    const current = version('build-b', { firstSeenAt: NOW - 100 });
    const newer = version('build-c', { firstSeenAt: NOW });
    const pointer = routing({ currentBuildId: 'build-b' });
    const all = [old, current, newer];
    expect(moveDirection(pointer, all, old)).toBe('rollback');
    expect(moveDirection(pointer, all, newer)).toBe('promote');
    expect(moveDirection(null, all, old)).toBe('promote');
  });
});

describe('explainWorkflowBucket', () => {
  const versions = [version('build-a'), version('build-b')];

  test('says no build is chosen before the first routing change', () => {
    const explanation = explainWorkflowBucket('billing', 'wf-1', null, versions);
    expect(explanation.buildId).toBeUndefined();
    expect(explanation.text).toContain('no routing pointer yet');
  });

  test('without a ramping build every workflow lands on the current build', () => {
    const explanation = explainWorkflowBucket('billing', 'wf-1', routing(), versions);
    expect(explanation.buildId).toBe('build-a');
    expect(explanation.text).toContain('no build is ramping');
  });

  test('a full ramp sends every workflow to the ramping build, and a zero ramp to none', () => {
    const full = routing({ rampingBuildId: 'build-b', rampBasisPoints: 10_000 });
    const none = routing({ rampingBuildId: 'build-b', rampBasisPoints: 0 });
    const lands = explainWorkflowBucket('billing', 'wf-1', full, versions);
    expect(lands.buildId).toBe('build-b');
    expect(lands.text).toContain('the ramping build');
    expect(lands.text).toContain('generation 3');
    const stays = explainWorkflowBucket('billing', 'wf-1', none, versions);
    expect(stays.buildId).toBe('build-a');
    expect(stays.text).toContain('falls outside the 0%');
  });

  test('is deterministic per workflow id, and splits a partial ramp across ids', () => {
    const half = routing({ rampingBuildId: 'build-b', rampBasisPoints: 5_000 });
    const landed = new Set<string | undefined>();
    for (let index = 0; index < 40; index += 1) {
      const first = explainWorkflowBucket('billing', `wf-${index}`, half, versions);
      const again = explainWorkflowBucket('billing', `wf-${index}`, half, versions);
      expect(again).toEqual(first);
      landed.add(first.buildId);
    }
    expect(landed).toEqual(new Set(['build-a', 'build-b']));
  });

  test('reports the server’s own reason when the routed build cannot serve', () => {
    const drained = [version('build-a', { state: 'draining' }), version('build-b')];
    const explanation = explainWorkflowBucket('billing', 'wf-1', routing(), drained);
    expect(explanation.buildId).toBeUndefined();
    expect(explanation.text.length).toBeGreaterThan(0);
  });
});
