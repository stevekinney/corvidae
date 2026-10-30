/**
 * COR-1813 — `Bureau`'s worker rollouts over a Weft deployment catalog: what ramp, promote, and
 * roll back write, the generation fence on every one, the refusals, the audit entry each move
 * leaves, and a routing record written before `previousBuildId` existed.
 */
import { MemoryStorage } from '@lostgradient/storage';
import {
  encode,
  WorkerDeploymentCatalog,
  WORKER_DEPLOYMENT_ROUTING_PREFIX,
} from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import {
  type BureauWorkerDeployments,
  createBureauWorkerDeployments,
  WorkerDeploymentRolloutError,
  type WorkerDeploymentAuditEntry,
  type WorkerDeploymentRolloutReason,
} from './worker-deployments.ts';
import { catalogWithBuilds, DEPLOYMENT, routeTo } from './worker-deployments.test-support.ts';

type Recorded = {
  deployments: BureauWorkerDeployments;
  audits: WorkerDeploymentAuditEntry[];
  diagnostics: string[];
};

function deploymentsOver(
  catalog: WorkerDeploymentCatalog,
  options: { auditFails?: boolean } = {},
): Recorded {
  const audits: WorkerDeploymentAuditEntry[] = [];
  const diagnostics: string[] = [];
  const deployments = createBureauWorkerDeployments({
    catalog,
    now: () => Date.UTC(2026, 9, 29, 12, 0, 0),
    audit: async (entry) => {
      if (options.auditFails === true) throw new Error('trail is down');
      audits.push(entry);
    },
    diagnose: (message) => diagnostics.push(message),
  });
  return { deployments, audits, diagnostics };
}

/** The rollout error a call threw, or a failure if it did not throw one. */
async function refusalOf(call: Promise<unknown>): Promise<WorkerDeploymentRolloutError> {
  try {
    await call;
  } catch (error) {
    if (error instanceof WorkerDeploymentRolloutError) return error;
    throw error;
  }
  throw new Error('Expected the move to be refused.');
}

async function reasonOf(call: Promise<unknown>): Promise<WorkerDeploymentRolloutReason> {
  const refusal = await refusalOf(call);
  return refusal.reason;
}

describe('Bureau worker rollouts', () => {
  it('reads a pointer with no previous build, and nothing for a deployment never routed', async () => {
    const catalog = await catalogWithBuilds(['a', 'b']);
    const { deployments } = deploymentsOver(catalog);
    expect(await deployments.get(DEPLOYMENT)).toBeNull();

    await routeTo(catalog, 'a');
    expect(await deployments.get(DEPLOYMENT)).toEqual({
      deploymentName: DEPLOYMENT,
      currentBuildId: 'a',
      rampingBuildId: null,
      rampBasisPoints: 0,
      previousBuildId: null,
      generation: 1,
      updatedAt: '1970-01-01T00:00:01.000Z',
    });
  });

  it('ramps, promotes, and rolls back, each fenced and audited', async () => {
    const catalog = await catalogWithBuilds(['a', 'b']);
    await routeTo(catalog, 'a');
    const { deployments, audits } = deploymentsOver(catalog);
    const actor = { actor: 'api-key:operator' };

    const ramped = await deployments.ramp(
      { deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 2500 },
      actor,
    );
    expect(ramped).toMatchObject({
      currentBuildId: 'a',
      rampingBuildId: 'b',
      rampBasisPoints: 2500,
      previousBuildId: null,
      generation: 2,
      updatedAt: '2026-10-29T12:00:00.000Z',
    });

    const promoted = await deployments.promote({ deploymentName: DEPLOYMENT }, actor);
    expect(promoted).toMatchObject({
      currentBuildId: 'b',
      rampingBuildId: null,
      rampBasisPoints: 0,
      previousBuildId: 'a',
      generation: 3,
    });

    const rolledBack = await deployments.rollBack({ deploymentName: DEPLOYMENT }, actor);
    expect(rolledBack).toMatchObject({
      currentBuildId: 'a',
      rampingBuildId: null,
      previousBuildId: 'b',
      generation: 4,
    });
    // A second roll back undoes the first.
    expect(await deployments.rollBack({ deploymentName: DEPLOYMENT }, actor)).toMatchObject({
      currentBuildId: 'b',
      previousBuildId: 'a',
      generation: 5,
    });

    expect(audits.map((entry) => entry.type)).toEqual([
      'deployment.ramped',
      'deployment.promoted',
      'deployment.rolled-back',
      'deployment.rolled-back',
    ]);
    expect(audits[0]).toEqual({
      runId: 'worker-deployment:billing',
      type: 'deployment.ramped',
      principal: 'api-key:operator',
      detail: {
        deploymentName: 'billing',
        fromBuildId: 'a',
        currentBuildId: 'a',
        rampingBuildId: 'b',
        rampBasisPoints: 2500,
        generation: 2,
      },
    });
    expect(audits[1]?.detail).toEqual({
      deploymentName: 'billing',
      fromBuildId: 'a',
      currentBuildId: 'b',
      rampBasisPoints: 0,
      previousBuildId: 'a',
      generation: 3,
    });
  });

  it('keeps the previous build through a ramp, and rolls a ramp back with the current build', async () => {
    const catalog = await catalogWithBuilds(['a', 'b', 'c']);
    await routeTo(catalog, 'a');
    const { deployments } = deploymentsOver(catalog);
    await deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 10_000 });
    await deployments.promote({ deploymentName: DEPLOYMENT });
    const ramped = await deployments.ramp({
      deploymentName: DEPLOYMENT,
      buildId: 'c',
      rampBasisPoints: 100,
    });
    expect(ramped).toMatchObject({
      currentBuildId: 'b',
      rampingBuildId: 'c',
      previousBuildId: 'a',
    });

    const rolledBack = await deployments.rollBack({ deploymentName: DEPLOYMENT });
    expect(rolledBack).toMatchObject({ currentBuildId: 'a', rampingBuildId: null });
  });

  it('refuses each move that has nothing to move, and changes nothing', async () => {
    const catalog = await catalogWithBuilds(['a', 'b']);
    const { deployments, audits } = deploymentsOver(catalog);
    expect(await reasonOf(deployments.promote({ deploymentName: DEPLOYMENT }))).toBe('no-routing');
    expect(await reasonOf(deployments.rollBack({ deploymentName: DEPLOYMENT }))).toBe('no-routing');

    await routeTo(catalog, 'a');
    expect(await reasonOf(deployments.promote({ deploymentName: DEPLOYMENT }))).toBe(
      'no-ramping-build',
    );
    expect(await reasonOf(deployments.rollBack({ deploymentName: DEPLOYMENT }))).toBe(
      'no-previous-build',
    );
    expect(
      await reasonOf(
        deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'a', rampBasisPoints: 10 }),
      ),
    ).toBe('same-as-current');
    expect(
      await reasonOf(
        deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'nobody', rampBasisPoints: 10 }),
      ),
    ).toBe('build-not-found');

    for (const rampBasisPoints of [-1, 10_001, 0.5, Number.NaN]) {
      expect(
        await reasonOf(
          deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints }),
        ),
      ).toBe('invalid-ramp');
    }

    await catalog.setVersionState(DEPLOYMENT, 'b', 'draining');
    const draining = await refusalOf(
      deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 10 }),
    );
    expect([draining.reason, draining.buildId]).toEqual(['build-not-ready', 'b']);

    const unchanged = await catalog.getRouting(DEPLOYMENT);
    expect(unchanged?.generation).toBe(1);
    expect(audits).toEqual([]);
  });

  it('refuses a move whose expectedGeneration the pointer has moved past, and writes nothing', async () => {
    const catalog = await catalogWithBuilds(['a', 'b', 'c']);
    await routeTo(catalog, 'a');
    const { deployments, audits } = deploymentsOver(catalog);
    await deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 500 });
    const seen = await deployments.get(DEPLOYMENT);
    expect(seen?.generation).toBe(2);

    // Another writer moves the pointer after the caller read generation 2.
    await catalog.setRouting({
      deploymentName: DEPLOYMENT,
      currentBuildId: 'c',
      rampBasisPoints: 0,
      updatedAt: 5,
    });

    const stale = await refusalOf(
      deployments.promote({ deploymentName: DEPLOYMENT, expectedGeneration: 2 }),
    );
    expect([stale.reason, stale.currentGeneration]).toEqual(['stale-generation', 3]);
    const after = await catalog.getRouting(DEPLOYMENT);
    expect([after?.currentBuildId, after?.generation]).toEqual(['c', 3]);
    expect(audits.map((entry) => entry.type)).toEqual(['deployment.ramped']);
  });

  it('fences every move by a defined generation, the one it read when the caller named none', async () => {
    const written: Array<number | undefined> = [];
    class RecordingCatalog extends WorkerDeploymentCatalog {
      override async setRouting(
        ...parameters: Parameters<WorkerDeploymentCatalog['setRouting']>
      ): ReturnType<WorkerDeploymentCatalog['setRouting']> {
        written.push(parameters[0].expectedGeneration);
        return super.setRouting(...parameters);
      }
    }
    const storage = new MemoryStorage();
    await catalogWithBuilds(['a', 'b'], storage);
    const catalog = new RecordingCatalog(storage);
    await routeTo(catalog, 'a');
    written.length = 0;
    const { deployments } = deploymentsOver(catalog);

    await deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 1 });
    await deployments.promote({ deploymentName: DEPLOYMENT });
    await deployments.rollBack({ deploymentName: DEPLOYMENT, expectedGeneration: 3 });

    expect(written).toEqual([1, 2, 3]);
  });

  it('refuses the move when another writer wins the race between its read and its write', async () => {
    const storage = new MemoryStorage();
    const catalog = await catalogWithBuilds(['a', 'b', 'c'], storage);
    await routeTo(catalog, 'a');
    class RacingCatalog extends WorkerDeploymentCatalog {
      raced = false;
      override async setRouting(
        ...parameters: Parameters<WorkerDeploymentCatalog['setRouting']>
      ): ReturnType<WorkerDeploymentCatalog['setRouting']> {
        if (!this.raced) {
          this.raced = true;
          await catalog.setRouting({
            deploymentName: DEPLOYMENT,
            currentBuildId: 'c',
            rampBasisPoints: 0,
            updatedAt: 9,
          });
        }
        return super.setRouting(...parameters);
      }
    }
    const { deployments } = deploymentsOver(new RacingCatalog(storage));
    const stale = await refusalOf(
      deployments.ramp({ deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 1 }),
    );
    expect([stale.reason, stale.currentGeneration]).toEqual(['stale-generation', 2]);
  });

  it('keeps a move whose audit entry could not be written, and reports the failure', async () => {
    const catalog = await catalogWithBuilds(['a', 'b']);
    await routeTo(catalog, 'a');
    const { deployments, diagnostics } = deploymentsOver(catalog, { auditFails: true });

    const ramped = await deployments.ramp({
      deploymentName: DEPLOYMENT,
      buildId: 'b',
      rampBasisPoints: 1,
    });

    expect(ramped.rampingBuildId).toBe('b');
    const stored = await catalog.getRouting(DEPLOYMENT);
    expect(stored?.rampingBuildId).toBe('b');
    expect(diagnostics).toEqual([
      'Could not record the deployment.ramped audit entry for deployment "billing".',
    ]);
  });

  it('reads a routing record written before previousBuildId existed as null', async () => {
    const storage = new MemoryStorage();
    const catalog = await catalogWithBuilds(['a', 'b'], storage);
    await storage.put(
      `${WORKER_DEPLOYMENT_ROUTING_PREFIX}${encodeURIComponent(DEPLOYMENT)}`,
      encode({
        deploymentName: DEPLOYMENT,
        currentBuildId: 'a',
        rampingBuildId: 'b',
        rampBasisPoints: 300,
        generation: 7,
        updatedAt: 1_000,
      }),
    );
    const { deployments } = deploymentsOver(catalog);

    expect(await deployments.get(DEPLOYMENT)).toMatchObject({
      currentBuildId: 'a',
      rampingBuildId: 'b',
      previousBuildId: null,
      generation: 7,
    });
    expect(await reasonOf(deployments.rollBack({ deploymentName: DEPLOYMENT }))).toBe(
      'no-previous-build',
    );
    // The first promote after the upgrade records the replaced build.
    expect(await deployments.promote({ deploymentName: DEPLOYMENT })).toMatchObject({
      currentBuildId: 'b',
      previousBuildId: 'a',
      generation: 8,
    });
  });
});
