/**
 * Typed faults, generation preconditions, and the remove operation for the
 * worker deployment routing operations (COR-277). The routing catalog itself
 * is covered by `worker/deployment-routing.test.ts`.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { throwingRejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import { testWorkerManifest } from '../../worker/registry-fixtures.test-support.ts';
import type { OperationFault } from '../operation-fault.ts';
import { createLiveOperationRegistry } from '../rest-bindings.ts';
import {
  createPreviewWorkerDeploymentRoutingOperation,
  createPromoteWorkerDeploymentOperation,
  createRemoveWorkerDeploymentVersionOperation,
  createRollbackWorkerDeploymentOperation,
  createSetWorkerDeploymentRoutingOperation,
  workerDeploymentRemoveRestBinding,
} from './worker-deployment-routing.ts';

type Invocable = { invoke: (context: never) => Promise<unknown> };

function invoke(operation: Invocable, input: unknown): Promise<unknown> {
  return operation.invoke({ input } as never);
}

/** The fault an operation threw, or a failure if it did not throw one. */
async function faultOf(promise: Promise<unknown>): Promise<OperationFault> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && 'data' in error) {
      return error as OperationFault;
    }
    throw new Error(`Expected an OperationFault, received ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the operation to fault, but it succeeded.');
}

async function stateOf(catalog: WorkerDeploymentCatalog, buildId: string) {
  const version = await catalog.getVersion('billing', buildId);
  return version?.state;
}

class InterleavingStorage extends MemoryStorage {
  #beforeCommit: (() => Promise<void>) | undefined;
  arm(beforeCommit: () => Promise<void>): void {
    this.#beforeCommit = beforeCommit;
  }
  override async conditionalBatch(...args: Parameters<MemoryStorage['conditionalBatch']>) {
    const beforeCommit = this.#beforeCommit;
    this.#beforeCommit = undefined;
    if (beforeCommit !== undefined) await beforeCommit();
    return super.conditionalBatch(...args);
  }
}

async function catalogWithBuilds(
  buildIds: readonly string[] = ['build-a', 'build-b'],
  storage: MemoryStorage = new MemoryStorage(),
): Promise<WorkerDeploymentCatalog> {
  const catalog = new WorkerDeploymentCatalog(storage);
  for (const buildId of buildIds) {
    const manifest = testWorkerManifest({
      deployment: { name: 'billing', buildId, artifactDigest: `sha256:${buildId}` },
    });
    await catalog.registerVersion({
      deploymentName: 'billing',
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest,
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  return catalog;
}

const ROUTING = {
  deploymentName: 'billing',
  currentBuildId: 'build-a',
  rampBasisPoints: 10_000,
} as const;

describe('preview reports the generation a change should be applied against', () => {
  it('returns 0 before the first routing change and the live generation after', async () => {
    const catalog = await catalogWithBuilds();
    const preview = createPreviewWorkerDeploymentRoutingOperation({ catalog });
    expect(await invoke(preview, ROUTING)).toMatchObject({ valid: true, currentGeneration: 0 });

    await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);
    expect(await invoke(preview, ROUTING)).toMatchObject({ valid: true, currentGeneration: 1 });
  });

  it('faults with a typed stale-generation Conflict when expectedGeneration has been passed', async () => {
    const catalog = await catalogWithBuilds();
    await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);

    const fault = await faultOf(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), {
        ...ROUTING,
        expectedGeneration: 0,
      }),
    );
    expect(fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'stale-generation', currentGeneration: 1 },
    });
  });

  it('rejects a ramping build equal to the current build as InvalidParams, before any write', async () => {
    const catalog = await catalogWithBuilds();
    const fault = await faultOf(
      invoke(createPreviewWorkerDeploymentRoutingOperation({ catalog }), {
        ...ROUTING,
        rampingBuildId: 'build-a',
      }),
    );
    expect(fault.code).toBe('InvalidParams');
  });
});

describe('setrouting, promote, and rollback fault with typed Conflicts', () => {
  it('setrouting: a stale expectedGeneration is a Conflict naming the current generation', async () => {
    const catalog = await catalogWithBuilds();
    const set = createSetWorkerDeploymentRoutingOperation({ catalog });
    await invoke(set, ROUTING);

    const fault = await faultOf(invoke(set, { ...ROUTING, expectedGeneration: 0 }));
    expect(fault).toMatchObject({
      code: 'Conflict',
      data: { reason: 'stale-generation', currentGeneration: 1 },
    });
    expect(await catalog.getRouting('billing')).toMatchObject({ generation: 1 });
  });

  it.each([
    ['promote', createPromoteWorkerDeploymentOperation],
    ['rollback', createRollbackWorkerDeploymentOperation],
  ] as const)(
    '%s: applies against the generation passed, and a moved pointer is a stale-generation Conflict',
    async (_name, create) => {
      const catalog = await catalogWithBuilds();
      const operation = create({ catalog });
      await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);

      // The generation the caller previewed is honored.
      expect(
        await invoke(operation, {
          deploymentName: 'billing',
          buildId: 'build-b',
          expectedGeneration: 1,
        }),
      ).toMatchObject({ currentBuildId: 'build-b', generation: 2 });

      // A caller still holding generation 1 is refused, and the pointer is untouched.
      const fault = await faultOf(
        invoke(operation, { deploymentName: 'billing', buildId: 'build-a', expectedGeneration: 1 }),
      );
      expect(fault).toMatchObject({
        code: 'Conflict',
        data: { reason: 'stale-generation', currentGeneration: 2 },
      });
      expect(await catalog.getRouting('billing')).toMatchObject({
        currentBuildId: 'build-b',
        generation: 2,
      });
    },
  );

  it.each([
    ['promote', createPromoteWorkerDeploymentOperation],
    ['rollback', createRollbackWorkerDeploymentOperation],
  ] as const)(
    '%s: omitting expectedGeneration keeps today’s behavior, including the first routing change',
    async (_name, create) => {
      const catalog = await catalogWithBuilds();
      const operation = create({ catalog });
      expect(
        await invoke(operation, { deploymentName: 'billing', buildId: 'build-a' }),
      ).toMatchObject({
        currentBuildId: 'build-a',
        generation: 1,
      });
      expect(
        await invoke(operation, { deploymentName: 'billing', buildId: 'build-b' }),
      ).toMatchObject({
        currentBuildId: 'build-b',
        generation: 2,
      });
    },
  );

  it('promote without expectedGeneration still refuses a pointer that moves between its read and its write', async () => {
    const storage = new InterleavingStorage();
    const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
    const rival = new WorkerDeploymentCatalog(storage);
    await invoke(createSetWorkerDeploymentRoutingOperation({ catalog }), ROUTING);

    storage.arm(async () => {
      await rival.setRouting({ ...ROUTING, currentBuildId: 'build-b', updatedAt: 9 });
    });
    const fault = await faultOf(
      invoke(createPromoteWorkerDeploymentOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    );
    expect(fault).toMatchObject({ code: 'Conflict', data: { currentGeneration: 2 } });
  });

  it('a missing build is NotFound and a build that is not ready is a Conflict', async () => {
    const catalog = await catalogWithBuilds();
    const set = createSetWorkerDeploymentRoutingOperation({ catalog });

    expect(await faultOf(invoke(set, { ...ROUTING, currentBuildId: 'missing' }))).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'billing/missing' },
    });
    expect(
      await faultOf(
        invoke(createPromoteWorkerDeploymentOperation({ catalog }), {
          deploymentName: 'billing',
          buildId: 'missing',
        }),
      ),
    ).toMatchObject({ code: 'NotFound' });

    await catalog.markDraining('billing', 'build-b');
    expect(
      await faultOf(invoke(set, { ...ROUTING, rampingBuildId: 'build-b', rampBasisPoints: 100 })),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-not-ready' } });
  });

  it('declares the faults it can produce', () => {
    const registry = createLiveOperationRegistry();
    const faults = (name: string) =>
      [
        ...(registry.list().find((operation) => operation.name === name)?.producibleFaults ?? []),
      ].toSorted();
    for (const name of [
      'weft.worker.deployments.setrouting',
      'weft.worker.deployments.promote',
      'weft.worker.deployments.rollback',
      'weft.worker.deployments.preview',
    ]) {
      expect(faults(name), name).toEqual(['Conflict', 'InvalidParams', 'NotFound']);
    }
    expect(faults('weft.worker.deployments.remove')).toEqual(['Conflict', 'NotFound']);
  });
});

describe('weft.worker.deployments.remove', () => {
  it('removes an unreferenced build and calls the catalog’s own removeVersion', async () => {
    const catalog = await catalogWithBuilds();
    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });

    expect(await invoke(remove, { deploymentName: 'billing', buildId: 'build-b' })).toEqual({
      deploymentName: 'billing',
      buildId: 'build-b',
      removed: true,
    });
    expect(await stateOf(catalog, 'build-b')).toBe('removed');
    expect(await stateOf(catalog, 'build-a')).toBe('ready');
  });

  it('refuses a referenced build with a version-referenced Conflict, and leaves it ready', async () => {
    const catalog = await catalogWithBuilds();
    await catalog.reference('billing', 'build-b', 1);
    await catalog.reference('billing', 'build-b', 1);

    const fault = await faultOf(
      invoke(createRemoveWorkerDeploymentVersionOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    );
    expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-referenced' } });
    expect(fault.message).toContain('2 executions');
    expect(await stateOf(catalog, 'build-b')).toBe('ready');
  });

  it('faults NotFound for a build that never existed and for one already removed', async () => {
    const catalog = await catalogWithBuilds();
    const remove = createRemoveWorkerDeploymentVersionOperation({ catalog });

    expect(
      await faultOf(invoke(remove, { deploymentName: 'billing', buildId: 'missing' })),
    ).toMatchObject({
      code: 'NotFound',
      data: { resource: 'workerDeploymentVersion', identifier: 'billing/missing' },
    });

    await invoke(remove, { deploymentName: 'billing', buildId: 'build-b' });
    expect(
      await faultOf(invoke(remove, { deploymentName: 'billing', buildId: 'build-b' })),
    ).toMatchObject({ code: 'NotFound' });
  });

  it('reports a reference taken between its read and its write as a Conflict, not a removal', async () => {
    const storage = new InterleavingStorage();
    const catalog = await catalogWithBuilds(['build-a', 'build-b'], storage);
    const rival = new WorkerDeploymentCatalog(storage);

    storage.arm(async () => {
      await rival.reference('billing', 'build-b', 1);
    });
    const fault = await faultOf(
      invoke(createRemoveWorkerDeploymentVersionOperation({ catalog }), {
        deploymentName: 'billing',
        buildId: 'build-b',
      }),
    );
    expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-referenced' } });
    expect(await stateOf(catalog, 'build-b')).toBe('ready');
  });

  it('is registered with a REST binding and needs a live catalog', async () => {
    expect(workerDeploymentRemoveRestBinding).toMatchObject({
      method: 'POST',
      path: '/v1/worker-deployments/remove',
      operationName: 'weft.worker.deployments.remove',
    });
    const input = { deploymentName: 'billing', buildId: 'build-b' };
    expect(
      await workerDeploymentRemoveRestBinding.extractInput(
        new Request('http://localhost/v1/worker-deployments/remove', {
          method: 'POST',
          body: JSON.stringify(input),
        }),
        {},
        {},
      ),
    ).toEqual(input);
    expect(
      createLiveOperationRegistry()
        .list()
        .some((operation) => operation.name === 'weft.worker.deployments.remove'),
    ).toBe(true);
    expect(
      await throwingRejectionOf(invoke(createRemoveWorkerDeploymentVersionOperation(), input)),
    ).toThrow('live worker deployment catalog');
  });
});
