/**
 * The drain guard: a drain is confirmed against the target as it was listed when the dialog
 * opened, so a worker that started draining, left, or a deployment that gained a worker meanwhile
 * is refused instead of drained blind.
 */
import { describe, expect, test } from 'bun:test';

import { drainFingerprint } from './drain-guard.ts';
import type { WorkerSummary } from './worker-catalog-types.ts';

function worker(overrides: Partial<WorkerSummary> = {}): WorkerSummary {
  return {
    id: 'w1',
    transport: 'websocket',
    queue: 'default',
    activities: [],
    concurrency: 4,
    inFlight: 0,
    availableCapacity: 4,
    connectedAt: 0,
    lastHeartbeatAt: 0,
    startedAt: 0,
    heartbeatAgeMs: 0,
    capabilities: {},
    health: 'active',
    ...overrides,
  };
}

describe('drainFingerprint', () => {
  test('a worker is fingerprinted by its health, and a worker that left by nothing', () => {
    const target = { kind: 'worker', id: 'w1' } as const;
    expect(drainFingerprint([worker()], target)).toBe('active');
    expect(drainFingerprint([worker({ health: 'draining' })], target)).toBe('draining');
    expect(drainFingerprint([worker({ id: 'w2' })], target)).toBeNull();
  });

  test('a deployment is fingerprinted by its workers and their health, whatever the list order', () => {
    const target = { kind: 'deployment', name: 'api' } as const;
    const first = worker({ id: 'a', deploymentName: 'api' });
    const second = worker({ id: 'b', deploymentName: 'api' });
    const other = worker({ id: 'c', deploymentName: 'billing' });
    expect(drainFingerprint([first, second, other], target)).toBe('a:active,b:active');
    expect(drainFingerprint([second, other, first], target)).toBe('a:active,b:active');
    expect(drainFingerprint([first, { ...second, health: 'draining' }], target)).toBe(
      'a:active,b:draining',
    );
    expect(drainFingerprint([other], target)).toBeNull();
  });

  test('a build target is not this guard’s, so it has no fingerprint', () => {
    expect(
      drainFingerprint([worker()], { kind: 'build', deploymentName: 'api', buildId: 'b1' }),
    ).toBeNull();
  });
});
