import { describe, expect, it } from 'bun:test';
import { MemoryStorage } from '../storage/memory.ts';
import {
  selectWorkerDeployment,
  WorkerDeploymentCatalog,
  type DeploymentRoutingCandidate,
  type WorkerDeploymentRouting,
} from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';

function manifest(buildId: string, workflowRevision = 'revision-a'): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: 'billing', buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      checkout: {
        workflowVersion: '1',
        workflowRevision,
        contractHash: 'sha256:workflow',
        activities: {
          charge: { contractHash: 'sha256:activity', implementationRevision: buildId },
        },
      },
    },
    capabilities: {},
  };
}
function routing(rampingBuildId?: string, rampBasisPoints = 10_000): WorkerDeploymentRouting {
  return {
    deploymentName: 'billing',
    currentBuildId: 'build-a',
    ...(rampingBuildId ? { rampingBuildId } : {}),
    rampBasisPoints,
    generation: 1,
    updatedAt: 1,
  };
}
function candidate(
  workerId: string,
  buildId: string,
  availableCapacity = 1,
): DeploymentRoutingCandidate {
  return { workerId, buildId, manifest: manifest(buildId), availableCapacity };
}

describe('revision-aware worker deployment routing', () => {
  it('selects exact versions and excludes draining or unavailable workers', () => {
    const result = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'run-1',
      activityName: 'charge',
      routing: routing(),
      candidates: [
        candidate('z', 'build-a'),
        candidate('a', 'build-a', 0),
        { ...candidate('draining', 'build-a'), draining: true },
      ],
    });
    expect(result.candidate?.workerId).toBe('z');
    const pinned = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'run-1',
      requirement: { buildId: 'build-b' },
      routing: routing('build-b'),
      candidates: [candidate('worker-a', 'build-a')],
    });
    expect(pinned).toMatchObject({
      candidate: undefined,
      reason: 'revision-incompatible',
      buildId: 'build-b',
    });
  });
  it('uses deterministic basis-point rollout boundaries and revision checks', () => {
    const ramp = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 10_000),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(ramp.buildId).toBe('build-b');
    const noRamp = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 0),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(noRamp.buildId).toBe('build-a');
    const oneBasisPoint = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 1),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(oneBasisPoint.buildId).toBe('build-a');
    const almostComplete = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      activityName: 'charge',
      routing: routing('build-b', 9_999),
      candidates: [candidate('a', 'build-a'), candidate('b', 'build-b')],
    });
    expect(almostComplete.buildId).toBe('build-b');
    const incompatible = selectWorkerDeployment({
      deploymentName: 'billing',
      workflowId: 'same',
      requirement: { workflowRevision: 'missing' },
      routing: routing(),
      candidates: [candidate('a', 'build-a')],
    });
    expect(incompatible).toMatchObject({ candidate: undefined, reason: 'revision-incompatible' });
  });
  it('protects references while draining and removing a version', async () => {
    const catalog = new WorkerDeploymentCatalog(new MemoryStorage());
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-a',
      artifactDigest: 'sha256:build-a',
      manifestDigest: 'sha256:m',
      manifest: manifest('build-a'),
      state: 'ready',
      firstSeenAt: 1,
    });
    await catalog.reference('billing', 'build-a', 1);
    const retained = await catalog.markDraining('billing', 'build-a');
    expect(retained?.state).toBe('ready');
    expect(await catalog.removeVersion('billing', 'build-a')).toBe(false);
    await catalog.reference('billing', 'build-a', -1);
    const draining = await catalog.markDraining('billing', 'build-a');
    expect(draining?.state).toBe('draining');
    expect(await catalog.removeVersion('billing', 'build-a')).toBe(true);
  });
  it('recovers immutable versions and routing pointers from durable storage', async () => {
    const storage = new MemoryStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-a',
      artifactDigest: 'sha256:build-a',
      manifestDigest: 'sha256:m',
      manifest: manifest('build-a'),
      state: 'ready',
      firstSeenAt: 1,
    });
    const pointer = await catalog.setRouting({
      deploymentName: 'billing',
      currentBuildId: 'build-a',
      rampBasisPoints: 0,
      updatedAt: 2,
    });
    expect(pointer?.generation).toBe(1);
    const recovered = new WorkerDeploymentCatalog(storage);
    const versions = await recovered.listVersions('billing');
    expect(versions.map((version) => version.buildId)).toEqual(['build-a']);
    const recoveredRouting = await recovered.getRouting('billing');
    expect(recoveredRouting?.currentBuildId).toBe('build-a');
    expect(
      await recovered.setRouting({
        deploymentName: 'billing',
        currentBuildId: 'build-a',
        rampBasisPoints: 0,
        updatedAt: 3,
        expectedGeneration: 0,
      }),
    ).toBeNull();
  });
});
