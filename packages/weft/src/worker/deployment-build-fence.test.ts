/**
 * COR-1582, correction 1: a run must never end up bound to a removed build.
 *
 * Removal's scan cannot see a binding committed after it, so `remove` first writes a durable fence
 * key for the build, then scans, and every commit that binds a run to a build requires that
 * build's fence key to be absent. The tests below place a binding at each point a removal is
 * exposed: between the fence and the scan's verdict, and after the removal has finished. Each one
 * asserts the invariant itself, that no non-terminal run is bound to a removed build, and the
 * typed outcome of the binding that lost.
 */
import { describe, expect, it } from 'bun:test';

import { decode, encode } from '../core/codec/index.ts';
import { Engine } from '../core/engine.ts';
import type { WorkflowState } from '../core/types.ts';
import { workflow } from '../core/types.ts';
import { forkWorkflowOperation } from '../server/operations/fork-workflow.ts';
import { startWorkflowOperation } from '../server/operations/start-workflow.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { waitForCondition } from '../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import {
  buildManifest,
  DEPLOYMENT,
  drainBuildOne,
  faultOf,
  fixture,
  InterleavingStorage,
  invoke,
  putsKeyWithPrefix,
  writesVersionState,
} from './deployment-build-fixture.test-support.ts';
import { seedBoundRun } from './deployment-build-references.test-support.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import {
  evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint,
  recordWorkflowWorkerUpgrade,
  type WorkflowWorkerBinding,
} from './versioning-policy.ts';

const FENCE_PREFIX = 'worker-deployment-removal:';
const fenceKey = (buildId: string) => `${FENCE_PREFIX}${DEPLOYMENT}:${buildId}`;
const versionKey = (buildId: string) => `worker-deployment-version:${DEPLOYMENT}:${buildId}`;

/** The state a run record holds, read straight from storage. */
async function runOf(storage: MemoryStorage, id: string) {
  const bytes = await storage.get(`wf:${id}`);
  if (bytes === null) return undefined;
  const state = decode(bytes) as WorkflowState;
  return { status: state.status, buildId: state.workerBinding?.current.buildId };
}

/** The lifecycle state of a build, read from the catalog. */
async function stateOf(catalog: WorkerDeploymentCatalog, buildId: string) {
  const version = await catalog.getVersion(DEPLOYMENT, buildId);
  return version?.state;
}

/** Every top-level run record, as `[id, status, bound build]`. */
async function runs(storage: MemoryStorage) {
  const found: Array<[string, string, string | undefined]> = [];
  for await (const [key, bytes] of storage.scan('wf:')) {
    if (key.slice(3).includes(':')) continue;
    const state = decode(bytes) as WorkflowState;
    found.push([state.id, state.status, state.workerBinding?.current.buildId]);
  }
  return found.toSorted(([left], [right]) => left.localeCompare(right));
}

/** The invariant: no run that can still execute is bound to a build that has been removed. */
async function assertNoRunOnRemovedBuild(storage: MemoryStorage, catalog: WorkerDeploymentCatalog) {
  const terminal = new Set(['completed', 'failed', 'cancelled', 'timed-out']);
  const versions = await catalog.listVersions();
  const removed = versions
    .filter((version) => version.state === 'removed')
    .map((version) => version.buildId);
  const everyRun = await runs(storage);
  const stranded = everyRun.filter(
    ([, status, buildId]) =>
      !terminal.has(status) && buildId !== undefined && removed.includes(buildId),
  );
  expect(stranded).toEqual([]);
}

/** `checkout-1` finished on `build-1`, which is then routed away from and drained. */
async function finishedRunOnDrainedBuild(storage = new InterleavingStorage()) {
  const fx = await fixture(storage);
  const handle = await fx.engine.start('checkout', null, { id: 'checkout-1' });
  await handle.signal('go', 'done');
  await handle.result();
  await drainBuildOne(fx.catalog);
  return { ...fx, storage };
}

describe('a restart cannot bind to a build while it is being removed', () => {
  it('fails a restart that commits after the removal scanned and before it wrote, and the build is removed', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    let restart: unknown;
    storage.arm(
      async () => {
        restart = await rejectionOf(
          engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
        );
      },
      (operations) => writesVersionState(operations, 'removed'),
    );

    const outcome = await catalog.removeVersion(DEPLOYMENT, 'build-1');

    expect(storage.fired).toBe(true);
    expect(outcome).toEqual({ outcome: 'removed' });
    expect(restart).toMatchObject({ name: 'WorkerDeploymentVersionRemovingError' });
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'completed', buildId: 'build-1' });
    await assertNoRunOnRemovedBuild(storage, catalog);
  });

  it('fails a restart whose build check read it as draining and whose commit lands after the removal finished', async () => {
    // The door review's probe: the removal runs to completion right after the restart's own read
    // of the version record, so the restart goes on to commit on bytes that said `draining`.
    const storage = new InterleavingStorage();
    await using fx = await finishedRunOnDrainedBuild(storage);
    const { engine, catalog } = fx;
    let removal: unknown;
    storage.arm(
      async () => {
        removal = await catalog.removeVersion(DEPLOYMENT, 'build-1');
      },
      (operations) => putsKeyWithPrefix(operations, 'wf:checkout-1'),
    );

    const restart = await rejectionOf(
      engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
    );

    expect(storage.fired).toBe(true);
    expect(removal).toEqual({ outcome: 'removed' });
    expect(restart).toMatchObject({ name: 'WorkerDeploymentVersionRemovedError' });
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'completed', buildId: 'build-1' });
    await assertNoRunOnRemovedBuild(storage, catalog);
  });

  it('lets a restart that committed before the fence stand, and refuses the removal for it', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    storage.arm(async () => {
      await engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });
    });

    const outcome = await catalog.removeVersion(DEPLOYMENT, 'build-1');

    // The restart's commit is the removal's first batch, so it committed ahead of the fence and
    // the scan that follows the fence sees it.
    expect(outcome).toEqual({ outcome: 'referenced', references: 1 });
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'running', buildId: 'build-1' });
    expect(await stateOf(catalog, 'build-1')).toBe('draining');
    expect(await storage.get(fenceKey('build-1'))).toBeNull();
  });
});

describe('every other path that binds a run is fenced the same way', () => {
  it('fork: a fork of a finished run that commits during the removal fails as removing, then as removed', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    let during: unknown;
    storage.arm(
      async () => {
        during = await rejectionOf(engine.fork('checkout-1'));
      },
      (operations) => writesVersionState(operations, 'removed'),
    );

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });

    expect(storage.fired).toBe(true);
    // Not reported as a missing revision: the fork re-reads the fence and names the build.
    expect(during).toMatchObject({ name: 'WorkerDeploymentVersionRemovingError' });
    expect(await rejectionOf(engine.fork('checkout-1'))).toMatchObject({
      name: 'WorkerDeploymentVersionRemovedError',
    });
    expect(await runs(storage)).toEqual([['checkout-1', 'completed', 'build-1']]);
  });

  it('fork over the operation: Conflict version-removing during, version-removed after', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    let during: unknown;
    storage.arm(
      async () => {
        during = await faultOf(invoke(forkWorkflowOperation, { workflowId: 'checkout-1' }, engine));
      },
      (operations) => writesVersionState(operations, 'removed'),
    );
    await catalog.removeVersion(DEPLOYMENT, 'build-1');

    expect(during).toMatchObject({ code: 'Conflict', data: { reason: 'version-removing' } });
    expect(
      await faultOf(invoke(forkWorkflowOperation, { workflowId: 'checkout-1' }, engine)),
    ).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });
  });

  it('fork: a fork that lost to a fence the removal released before the fork re-read it is told to retry', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine } = fx;
    storage.arm(
      async () => {
        await storage.put(fenceKey('build-1'), encode({ token: 'in-flight' }));
        releaseFenceOnNextRead(storage, true);
      },
      (operations) =>
        putsKeyWithPrefix(operations, 'wf:') && !putsKeyWithPrefix(operations, 'wf:checkout-1'),
    );

    expect(await rejectionOf(engine.fork('checkout-1'))).toMatchObject({
      name: 'WorkerDeploymentVersionRemovingError',
    });
    expect(await runs(storage)).toEqual([['checkout-1', 'completed', 'build-1']]);
  });

  it('fork: a fork that lost for another reason keeps its own error', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine } = fx;
    storage.arm(
      async () => {
        // The revision the fork pins leaves the catalog before the fork commits.
        for await (const [key] of storage.scan('catalog-entry:')) await storage.delete(key);
      },
      (operations) =>
        putsKeyWithPrefix(operations, 'wf:') && !putsKeyWithPrefix(operations, 'wf:checkout-1'),
    );

    expect(await rejectionOf(engine.fork('checkout-1'))).toMatchObject({
      name: 'WorkflowRevisionUnavailableError',
    });
  });

  it('fresh start: a start that chose the build while it was ready fails once the build is removed', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    const { engine, catalog } = fx;
    storage.arm(
      async () => {
        // The start has selected `build-1`, the routed build; before its commit the build is routed
        // away from, drained, and removed.
        await drainBuildOne(catalog);
        await catalog.removeVersion(DEPLOYMENT, 'build-1');
      },
      (operations) => putsKeyWithPrefix(operations, 'wf:checkout-fresh'),
    );

    const error = await rejectionOf(engine.start('checkout', null, { id: 'checkout-fresh' }));

    expect(storage.fired).toBe(true);
    expect(error).toMatchObject({ name: 'WorkerDeploymentVersionRemovedError' });
    expect(await runOf(storage, 'checkout-fresh')).toBeUndefined();
    await assertNoRunOnRemovedBuild(storage, catalog);
  });

  it('fresh start over weft.workflows.start answers Conflict version-removed', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    const { engine, catalog } = fx;
    storage.arm(
      async () => {
        await drainBuildOne(catalog);
        await catalog.removeVersion(DEPLOYMENT, 'build-1');
      },
      (operations) => putsKeyWithPrefix(operations, 'wf:checkout-fresh'),
    );

    const fault = await faultOf(
      invoke(startWorkflowOperation, { type: 'checkout', id: 'checkout-fresh' }, engine),
    );

    expect(fault).toMatchObject({ code: 'Conflict', data: { reason: 'version-removed' } });
  });

  it('fresh start: a start that loses to a fence the removal then releases is retried and binds', async () => {
    const storage = new InterleavingStorage();
    await using fx = await fixture(storage);
    const { engine, catalog } = fx;
    storage.arm(
      async () => {
        // A removal has placed its fence, and is refused and releases it before the start that
        // lost to the fence reads it again.
        await storage.put(fenceKey('build-1'), encode({ token: 'in-flight' }));
        releaseFenceOnNextRead(storage);
      },
      (operations) => putsKeyWithPrefix(operations, 'wf:checkout-retry'),
    );

    await engine.start('checkout', null, { id: 'checkout-retry' });

    expect(await runOf(storage, 'checkout-retry')).toEqual({
      status: 'running',
      buildId: 'build-1',
    });
    expect(await stateOf(catalog, 'build-1')).toBe('ready');
  });
});

/**
 * Deletes the fence as a failed commit reads it, standing in for a refused removal releasing it.
 * `before` deletes it ahead of the read, so the read finds it already gone; otherwise the read
 * that finds it present is the last one to.
 */
function releaseFenceOnNextRead(storage: MemoryStorage, before = false): void {
  const original = storage.get.bind(storage);
  let released = false;
  storage.get = async (key: string) => {
    if (!released && key === fenceKey('build-1') && (await original(key)) !== null) {
      released = true;
      if (before) await storage.delete(key);
      const value = await original(key);
      if (!before) await storage.delete(key);
      return value;
    }
    return original(key);
  };
}

describe('a child start is fenced the same way', () => {
  it("fails a child that inherits its parent's build when the parent finishes and the build is removed first", async () => {
    const storage = new InterleavingStorage();
    const engine = new Engine({ storage });
    try {
      engine.register(
        workflow({ name: 'tree', workerVersioningPolicy: { mode: 'pinned' } }).execute(
          async function* (ctx, input: { role: 'parent' | 'child' }) {
            if (input.role === 'child') return 'child-done';
            yield* ctx.waitForSignal('spawn');
            return yield* ctx.startChild('tree', { role: 'child' }, { id: 'tree-child' });
          },
        ),
      );
      const [first] = await engine.workflows.listRevisions('tree');
      const revision = first?.manifest.revision ?? '';
      const catalog = new WorkerDeploymentCatalog(storage);
      for (const buildId of ['build-1', 'build-2']) {
        await catalog.registerVersion({
          deploymentName: DEPLOYMENT,
          buildId,
          artifactDigest: `sha256:${buildId}`,
          manifestDigest: `sha256:manifest-${buildId}`,
          manifest: buildManifest(revision, buildId, 'tree'),
          state: 'ready',
          firstSeenAt: 1,
        });
      }
      await catalog.setRouting({
        deploymentName: DEPLOYMENT,
        currentBuildId: 'build-1',
        rampBasisPoints: 10_000,
        updatedAt: 1,
      });
      const parent = await engine.start('tree', { role: 'parent' }, { id: 'tree-parent' });
      let removal: unknown;
      storage.arm(
        async () => {
          // The parent, still bound to `build-1`, has finished by the time the removal scans.
          const bytes = (await storage.get('wf:tree-parent'))!;
          const state = decode(bytes) as WorkflowState;
          await storage.put('wf:tree-parent', encode({ ...state, status: 'completed' }));
          await drainBuildOne(catalog);
          removal = await catalog.removeVersion(DEPLOYMENT, 'build-1');
        },
        (operations) => putsKeyWithPrefix(operations, 'wf:tree-child'),
      );

      await parent.signal('spawn');
      // The parent's own record was rewritten under it, so it never settles; the removal and the
      // child's refusal are what the storage shows.
      await waitForCondition(() => removal !== undefined, {
        timeoutMs: 2_000,
        label: 'the removal to finish',
      });

      expect(storage.fired).toBe(true);
      expect(removal).toEqual({ outcome: 'removed' });
      expect(await runOf(storage, 'tree-child')).toBeUndefined();
      await assertNoRunOnRemovedBuild(storage, catalog);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('an automatic worker upgrade is fenced', () => {
  const binding = (buildId: string): WorkflowWorkerBinding => ({
    workflowId: 'run-1',
    workflowType: 'checkout',
    deploymentName: DEPLOYMENT,
    buildId,
    artifactDigest: `sha256:${buildId}`,
    manifestDigest: `sha256:manifest-${buildId}`,
    routingGeneration: 1,
    workflowRevision: 'revision-a',
    workflowContractHash: 'sha256:workflow',
    activityContracts: {},
    activityName: '*',
    activityContractHash: 'sha256:workflow',
    boundAt: 1,
    checkpointId: 'run-1',
  });
  const policy = {
    mode: 'auto-upgrade' as const,
    compatibility: {
      deploymentName: DEPLOYMENT,
      buildId: 'build-2',
      artifactDigest: 'sha256:build-2',
      manifestDigest: 'sha256:manifest-build-2',
      workflowRevision: 'revision-a',
      activityContractHash: 'sha256:workflow',
    },
  };

  it('control: an upgrade onto an unfenced build is recorded', async () => {
    const storage = new MemoryStorage();
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      policy: 'auto-upgrade',
    });

    const record = await recordWorkflowWorkerUpgrade(
      storage,
      policy,
      binding('build-1'),
      binding('build-2'),
    );

    expect(record.current.buildId).toBe('build-2');
  });

  it('an upgrade onto a fenced build is refused and the run stays where it was', async () => {
    const storage = new MemoryStorage();
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      policy: 'auto-upgrade',
    });
    await storage.put(fenceKey('build-2'), encode({ token: 'fenced' }));

    expect(
      await rejectionOf(
        recordWorkflowWorkerUpgrade(storage, policy, binding('build-1'), binding('build-2')),
      ),
    ).toBeInstanceOf(Error);
    expect(await runOf(storage, 'run-1')).toEqual({ status: 'running', buildId: 'build-1' });
  });

  it('an upgrade that lands between a removal fence and its write is refused, and the build is removed', async () => {
    const storage = new InterleavingStorage();
    const catalog = new WorkerDeploymentCatalog(storage);
    for (const buildId of ['build-1', 'build-2']) {
      await catalog.registerVersion({
        deploymentName: DEPLOYMENT,
        buildId,
        artifactDigest: `sha256:${buildId}`,
        manifestDigest: `sha256:manifest-${buildId}`,
        manifest: buildManifest('revision-a', buildId),
        state: 'ready',
        firstSeenAt: 1,
      });
    }
    await catalog.setVersionState(DEPLOYMENT, 'build-2', 'draining');
    await seedBoundRun(storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
      policy: 'auto-upgrade',
    });
    let upgrade: unknown;
    storage.arm(
      async () => {
        upgrade = await rejectionOf(
          recordWorkflowWorkerUpgrade(storage, policy, binding('build-1'), binding('build-2')),
        );
      },
      (operations) => writesVersionState(operations, 'removed'),
    );

    expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'removed' });

    expect(storage.fired).toBe(true);
    expect(upgrade).toBeInstanceOf(Error);
    await assertNoRunOnRemovedBuild(storage, catalog);
    const attempt = await evaluateAndRecordWorkflowWorkerUpgradeAfterCheckpoint(
      storage,
      'run-1',
      'checkpoint-1',
    );
    expect(attempt.upgraded).toBe(false);
  });
});

describe('a fence left by a crashed removal', () => {
  const crashed = encode({
    deploymentName: DEPLOYMENT,
    buildId: 'build-1',
    token: 'crashed',
    fencedAt: 1,
  });

  it('refuses bindings to the build until it is reconciled, and then lets them through', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, engine, catalog } = fx;
    await storage.put(fenceKey('build-1'), crashed);

    // The crash happened between the fence and the commit: the build is draining, never removed.
    expect(
      await rejectionOf(
        engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' }),
      ),
    ).toMatchObject({ name: 'WorkerDeploymentVersionRemovingError' });
    expect(await stateOf(catalog, 'build-1')).toBe('draining');

    // The next removal reconciles it. A reference elsewhere refuses this one, which proves the
    // stale fence neither blocked the scan nor survived it.
    await seedBoundRun(storage, {
      workflowId: 'run-2',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
    });
    expect(await catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'referenced',
      references: 1,
    });
    expect(await storage.get(fenceKey('build-1'))).toBeNull();
    await engine.start('checkout', null, { id: 'checkout-1', onTerminalConflict: 'start-new' });
    expect(await runOf(storage, 'checkout-1')).toEqual({ status: 'running', buildId: 'build-1' });
  });

  it('is deleted by a resume of the build', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, catalog } = fx;
    await storage.put(fenceKey('build-1'), crashed);

    await catalog.setVersionState(DEPLOYMENT, 'build-1', 'ready');

    expect(await storage.get(fenceKey('build-1'))).toBeNull();
  });

  it('is deleted when an engine starts, if the build was not removed', async () => {
    const storage = new MemoryStorage();
    await using fx = await fixture(storage);
    await drainBuildOne(fx.catalog);
    await storage.put(fenceKey('build-1'), crashed);
    fx.engine[Symbol.dispose]();

    await using restarted = await fixture(storage, false);
    await restarted.engine.start('checkout', null, { id: 'checkout-booted' });

    expect(await storage.get(fenceKey('build-1'))).toBeNull();
  });

  it('stays when the build was removed: it is the permanent tombstone', async () => {
    const storage = new MemoryStorage();
    await using fx = await fixture(storage);
    await drainBuildOne(fx.catalog);
    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
    const tombstone = await storage.get(fenceKey('build-1'));
    expect(tombstone).not.toBeNull();
    fx.engine[Symbol.dispose]();

    await using restarted = await fixture(storage, false);
    await restarted.engine.start('checkout', null, { id: 'checkout-booted' });

    expect(await storage.get(fenceKey('build-1'))).toEqual(tombstone);
    expect(await stateOf(restarted.catalog, 'build-1')).toBe('removed');
  });

  it('is released when the scan fails, so a failed removal leaves nothing behind', async () => {
    await using fx = await finishedRunOnDrainedBuild();
    const { storage, catalog } = fx;
    await storage.put('wf:corrupt', new Uint8Array([0xc1]));

    await rejectionOf(catalog.removeVersion(DEPLOYMENT, 'build-1'));

    expect(await storage.get(fenceKey('build-1'))).toBeNull();
    expect(await stateOf(catalog, 'build-1')).toBe('draining');
  });
});

describe('a refused removal leaves no fence, and a successful one leaves the tombstone', () => {
  it.each([
    [
      'not draining',
      async (fx: Awaited<ReturnType<typeof fixture>>) =>
        fx.catalog.removeVersion(DEPLOYMENT, 'build-2'),
    ],
  ])('writes no fence for a build that is %s', async (_name, remove) => {
    await using fx = await fixture();
    await remove(fx);
    expect(await fx.storage.get(fenceKey('build-2'))).toBeNull();
  });

  it('keeps the fence as the tombstone once the build is removed', async () => {
    await using fx = await fixture();
    await drainBuildOne(fx.catalog);

    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });

    expect(decode((await fx.storage.get(fenceKey('build-1')))!)).toMatchObject({
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
    });
  });

  it('deletes the fence when the removal is refused for a reference', async () => {
    await using fx = await fixture();
    await seedBoundRun(fx.storage, {
      workflowId: 'run-1',
      deploymentName: DEPLOYMENT,
      buildId: 'build-1',
    });
    await drainBuildOne(fx.catalog);

    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({
      outcome: 'referenced',
      references: 1,
    });
    expect(await fx.storage.get(fenceKey('build-1'))).toBeNull();
  });
});

describe('both removal write conditions are pinned on their own', () => {
  async function drainingBuildB() {
    const storage = new InterleavingStorage();
    const fx = await fixture(storage);
    await fx.catalog.setVersionState(DEPLOYMENT, 'build-2', 'draining');
    return { ...fx, storage };
  }
  /** The fence write is conditioned on the checks, so a build that failed them was never fenced. */
  function expectNoFenceOnAnUnremovableBuild(storage: InterleavingStorage, label: string): void {
    if (label === 'the fence write') {
      expect(storage.committedPuts).not.toContain(fenceKey('build-2'));
    }
  }
  const atFence = (operations: Parameters<typeof putsKeyWithPrefix>[0]) =>
    putsKeyWithPrefix(operations, FENCE_PREFIX);
  const atRemoval = (operations: Parameters<typeof writesVersionState>[0]) =>
    writesVersionState(operations, 'removed');

  for (const [label, when] of [
    ['the fence write', atFence],
    ['the removal write', atRemoval],
  ] as const) {
    it(`a drain lifted on its own fails ${label} on the version bytes`, async () => {
      await using fx = await drainingBuildB();
      const { storage, catalog } = fx;
      const rival = new WorkerDeploymentCatalog(storage);
      storage.arm(async () => {
        await rival.setVersionState(DEPLOYMENT, 'build-2', 'ready');
      }, when);

      expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({
        outcome: 'not-draining',
        state: 'ready',
      });

      expect(storage.fired).toBe(true);
      expect(await stateOf(catalog, 'build-2')).toBe('ready');
      expectNoFenceOnAnUnremovableBuild(storage, label);
    });

    it(`resume, route to the build, drain again (same version bytes) fails ${label} on the routing bytes`, async () => {
      await using fx = await drainingBuildB();
      const { storage, catalog } = fx;
      const before = await storage.get(versionKey('build-2'));
      const rival = new WorkerDeploymentCatalog(storage);
      storage.arm(async () => {
        await rival.setVersionState(DEPLOYMENT, 'build-2', 'ready');
        await rival.setRouting({
          deploymentName: DEPLOYMENT,
          currentBuildId: 'build-2',
          rampBasisPoints: 10_000,
          updatedAt: 3,
          expectedGeneration: 1,
        });
        await rival.setVersionState(DEPLOYMENT, 'build-2', 'draining');
        expect(await storage.get(versionKey('build-2'))).toEqual(before);
      }, when);

      expect(await catalog.removeVersion(DEPLOYMENT, 'build-2')).toEqual({ outcome: 'routed' });

      expect(storage.fired).toBe(true);
      expect(await stateOf(catalog, 'build-2')).toBe('draining');
      expectNoFenceOnAnUnremovableBuild(storage, label);
    });
  }

  it('a fence replaced by another removal fails the removal write on the fence bytes', async () => {
    await using fx = await drainingBuildB();
    const { storage, catalog } = fx;
    storage.arm(async () => {
      await storage.put(fenceKey('build-2'), encode({ token: 'rival removal' }));
    }, atRemoval);

    const outcome = await catalog.removeVersion(DEPLOYMENT, 'build-2');

    // The first attempt's write failed, it released nothing it did not own, and the retry
    // reconciled the rival's fence and removed the build under its own.
    expect(storage.fired).toBe(true);
    expect(outcome).toEqual({ outcome: 'removed' });
    expect(decode((await storage.get(fenceKey('build-2')))!)).not.toMatchObject({
      token: 'rival removal',
    });
  });
});

describe('only top-level run records are scanned', () => {
  it('ignores a checkpoint-shaped wf: key even when it carries a running binding', async () => {
    await using fx = await fixture();
    await drainBuildOne(fx.catalog);
    await fx.storage.put(
      'wf:run-1:ckpt',
      encode({
        status: 'running',
        workerBinding: {
          current: { deploymentName: DEPLOYMENT, buildId: 'build-1' },
        },
      }),
    );

    expect(await fx.catalog.removeVersion(DEPLOYMENT, 'build-1')).toEqual({ outcome: 'removed' });
  });
});
