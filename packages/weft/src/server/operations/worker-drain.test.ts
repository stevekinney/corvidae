/**
 * Deployment drain and resume, deployment-wide and build-scoped (COR-277).
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import {
  TEST_ACCEPTED_MANIFEST_DIGEST,
  testWorkerManifest,
} from '../../worker/registry-fixtures.test-support.ts';
import { WorkerRegistry } from '../../worker/registry.ts';
import { executeOperation } from '../operation-catalog.ts';
import type { OperationFault } from '../operation-fault.ts';
import { principalFromApiKey } from '../principal.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import { createOperationTestEngine } from './operation-registry-test-helpers.test-support.ts';
import {
  createClearDeploymentDrainOperation,
  createClearDeploymentDrainRestBinding,
  createDrainDeploymentOperation,
  createDrainDeploymentRestBinding,
} from './worker-drain.ts';

function invoke(operation: { invoke: (context: never) => Promise<unknown> }, input: unknown) {
  return operation.invoke({ input } as never);
}

async function faultOf(promise: Promise<unknown>): Promise<OperationFault> {
  try {
    await promise;
  } catch (error) {
    return error as OperationFault;
  }
  throw new Error('Expected a fault, but the operation succeeded.');
}

async function fixture() {
  const registry = new WorkerRegistry();
  const catalog = new WorkerDeploymentCatalog(new MemoryStorage());
  for (const [id, buildId] of [
    ['old-1', 'build-1'],
    ['new-1', 'build-2'],
  ] as const) {
    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id,
      queue: 'default',
      activities: ['charge'],
      concurrency: 2,
      deploymentName: 'payments',
      buildId,
    });
    await catalog.registerVersion({
      deploymentName: 'payments',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: testWorkerManifest({
        deployment: { name: 'payments', buildId, artifactDigest: `sha256:${buildId}` },
      }),
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  return {
    registry,
    catalog,
    drain: createDrainDeploymentOperation({ workerRegistry: registry, catalog, clock: () => 5 }),
    resume: createClearDeploymentDrainOperation({ workerRegistry: registry, catalog }),
  };
}

describe('weft.worker.deployments.drain and .resume — build-scoped', () => {
  it('drains and resumes one build independently of its siblings', async () => {
    const { registry, drain, resume } = await fixture();

    expect(
      await invoke(drain, { deploymentName: 'payments', buildId: 'build-1', reason: 'bad build' }),
    ).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      buildId: 'build-1',
      affectedWorkers: 1,
      inFlight: 0,
      health: 'drained',
    });
    expect(registry.findWorker('charge', { queue: 'default' })?.id).toBe('new-1');

    expect(await invoke(resume, { deploymentName: 'payments', buildId: 'build-1' })).toMatchObject({
      buildId: 'build-1',
      health: 'active',
    });
    expect(
      registry
        .getWorkerSummaries(1)
        .map((worker) => worker.health)
        .toSorted(),
    ).toEqual(['active', 'active']);
  });

  it('leaves the deployment-wide drain and resume exactly as they were when no build is named', async () => {
    const { registry, drain, resume } = await fixture();

    const drained = await invoke(drain, { deploymentName: 'payments' });
    expect(drained).toEqual({
      target: 'deployment',
      deploymentName: 'payments',
      affectedWorkers: 2,
      inFlight: 0,
      health: 'drained',
    });
    expect(drained).not.toHaveProperty('buildId');
    expect(registry.findWorker('charge', { queue: 'default' })).toBeUndefined();

    const resumed = await invoke(resume, { deploymentName: 'payments' });
    expect(resumed).toMatchObject({ affectedWorkers: 2, health: 'active' });
    expect(resumed).not.toHaveProperty('buildId');
  });

  it('refuses to drain a build the catalog has not accepted or has removed, without marking it', async () => {
    const { registry, drain } = await fixture();

    const unknown = await faultOf(
      invoke(drain, { deploymentName: 'payments', buildId: 'build-9' }),
    );
    expect(unknown).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'payments/build-9' },
    });
    const otherDeployment = await faultOf(
      invoke(drain, { deploymentName: 'shipping', buildId: 'build-1' }),
    );
    expect(otherDeployment.code).toBe('NotFound');

    // Nothing was marked: a worker that later connects on that build is routable.
    registry.register({
      manifest: testWorkerManifest(),
      acceptedManifestDigest: TEST_ACCEPTED_MANIFEST_DIGEST,
      id: 'late',
      queue: 'default',
      activities: ['charge'],
      concurrency: 1,
      deploymentName: 'payments',
      buildId: 'build-9',
    });
    expect(registry.getWorkerSummaries(1).find((worker) => worker.id === 'late')?.health).toBe(
      'active',
    );
  });

  it('writes the build’s state to the catalog: drain is draining, resume is ready', async () => {
    const { catalog, drain, resume } = await fixture();
    const stateOf = async (buildId: string) => {
      const version = await catalog.getVersion('payments', buildId);
      return version?.state;
    };

    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1' });
    expect(await stateOf('build-1')).toBe('draining');
    expect(await stateOf('build-2')).toBe('ready');

    await invoke(resume, { deploymentName: 'payments', buildId: 'build-1' });
    expect(await stateOf('build-1')).toBe('ready');
  });

  it('keeps the drain on a build that has executions bound to it', async () => {
    const { catalog, drain } = await fixture();
    await catalog.reference('payments', 'build-1', 1);

    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1' });

    const version = await catalog.getVersion('payments', 'build-1');
    expect(version?.state).toBe('draining');
  });

  it('refuses to resume a removed build, leaving it removed and still drained', async () => {
    const { registry, catalog, drain, resume } = await fixture();
    await invoke(drain, { deploymentName: 'payments', buildId: 'build-1' });
    await catalog.removeVersion('payments', 'build-1');

    const fault = await faultOf(invoke(resume, { deploymentName: 'payments', buildId: 'build-1' }));

    expect(fault).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'payments/build-1' },
    });
    const version = await catalog.getVersion('payments', 'build-1');
    expect(version?.state).toBe('removed');
    expect(registry.findWorker('charge', { queue: 'default' })?.id).toBe('new-1');
  });

  it('resumes a build with no marker as a no-op, even one the catalog does not know', async () => {
    const { resume } = await fixture();
    expect(await invoke(resume, { deploymentName: 'payments', buildId: 'build-9' })).toMatchObject({
      buildId: 'build-9',
      affectedWorkers: 0,
      health: 'active',
    });
  });

  it('is a discovery-only error without a registry or, for a build, a catalog', async () => {
    const registry = new WorkerRegistry();
    expect(
      await throwingRejectionOf(
        invoke(createDrainDeploymentOperation({ workerRegistry: registry }), {
          deploymentName: 'payments',
          buildId: 'build-1',
        }),
      ),
    ).toThrow('discovery-only');
  });
});

describe('build-scoped drain over REST and the live registry', () => {
  it('reads buildId from the POST body and from the DELETE query', async () => {
    const drain = createDrainDeploymentRestBinding();
    const resume = createClearDeploymentDrainRestBinding();
    expect(drain.inputSources).toMatchObject({
      buildId: { kind: 'body-field', bodyField: 'buildId' },
    });
    expect(resume.inputSources).toMatchObject({
      buildId: { kind: 'query', queryParam: 'buildId' },
    });

    expect(
      await drain.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain', {
          method: 'POST',
          body: JSON.stringify({ buildId: 'build-1', reason: 'bad build' }),
        }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments', buildId: 'build-1', reason: 'bad build' });
    expect(
      await drain.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain', { method: 'POST' }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments' });
    expect(
      await resume.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain?buildId=build-1', {
          method: 'DELETE',
        }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments', buildId: 'build-1' });
    expect(
      await resume.extractInput(
        new Request('http://localhost/v1/worker-deployments/payments/drain', { method: 'DELETE' }),
        { deploymentName: 'payments' },
        {},
      ),
    ).toEqual({ deploymentName: 'payments' });
  });

  it('wires the catalog into the live drain operation so a build is checked, with its fault on the wire', async () => {
    const engine = createOperationTestEngine();
    const registry = createLiveOperationRegistry({
      workerRegistry: new WorkerRegistry(),
      workerDeploymentCatalog: new WorkerDeploymentCatalog(new MemoryStorage()),
    });
    const result = await executeOperation(
      'weft.worker.deployments.drain',
      { deploymentName: 'payments', buildId: 'build-1' },
      {
        principal: principalFromApiKey({ subject: 'admin', scopes: ['system:admin'] }),
        host: engine,
        transport: 'jsonRpcStdio',
        registry,
      },
    );
    engine[Symbol.dispose]();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a fault');
    expect(result.fault).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'payments/build-1' },
    });
  });
});
