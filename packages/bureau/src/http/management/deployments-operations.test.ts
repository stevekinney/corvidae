/**
 * COR-1813 — `bureau.deployments.*` over a real Bureau and its handler: who may read and move a
 * worker deployment's routing, the shapes the operations return, the typed faults of a refused move,
 * and the audit record each move leaves.
 */
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { catalogWithBuilds, DEPLOYMENT, routeTo } from '../../worker-deployments.test-support.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import {
  bureauWorkerDeploymentsOperations,
  deploymentsGetOperation,
  deploymentsPromoteOperation,
  deploymentsRampOperation,
  deploymentsRollBackOperation,
} from './deployments-operations.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function open(builds: readonly string[] = ['a', 'b', 'c']) {
  const catalog = await catalogWithBuilds(builds, new MemoryStorage());
  await routeTo(catalog, builds[0]!);
  const opened: OpenedBureau = await openBureau({ bureauOptions: { workerDeployments: catalog } });
  cleanups.push(() => opened.dispose());
  return { catalog, opened };
}

const call = (opened: OpenedBureau, method: string, params: unknown, key: string) =>
  rpc(opened.handler, method, params, key);

describe('bureau.deployments.*', () => {
  it('serves the four operations, each described, with the write ones destructive', () => {
    for (const operation of bureauWorkerDeploymentsOperations) {
      expect(BUREAU_HANDLER_OPERATIONS).toContain(operation);
    }
    expect(deploymentsGetOperation.destructive).toBe(false);
    for (const operation of [
      deploymentsRampOperation,
      deploymentsPromoteOperation,
      deploymentsRollBackOperation,
    ]) {
      expect(operation.destructive).toBe(true);
    }
  });

  it('reads the routing for a reader, and refuses a caller with no scope as if it did not exist', async () => {
    const { opened } = await open();

    const read = await call(
      opened,
      'bureau.deployments.get',
      { deploymentName: DEPLOYMENT },
      'deployments-reader-key',
    );
    expect(read.error).toBeUndefined();
    expect(read.result).toEqual({
      deploymentName: DEPLOYMENT,
      currentBuildId: 'a',
      rampingBuildId: null,
      rampBasisPoints: 0,
      previousBuildId: null,
      generation: 1,
      updatedAt: '1970-01-01T00:00:01.000Z',
    });

    const hidden = await call(
      opened,
      'bureau.deployments.get',
      { deploymentName: DEPLOYMENT },
      'alice-key',
    );
    expect(hidden.error?.data).toMatchObject({ resource: 'workerDeployment' });
    const unknown = await call(
      opened,
      'bureau.deployments.get',
      { deploymentName: 'nobody' },
      'operator-key',
    );
    expect(unknown.error?.data).toMatchObject({
      resource: 'workerDeploymentRouting',
      identifier: 'nobody',
    });
  });

  it('lets a reader read but not move, and a caller with no scope learn nothing', async () => {
    const { opened } = await open();

    const refused = await call(
      opened,
      'bureau.deployments.ramp',
      { deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 10 },
      'deployments-reader-key',
    );
    expect(refused.error?.data).toMatchObject({ reason: 'missing scope bureau.deployments:write' });

    const hidden = await call(
      opened,
      'bureau.deployments.promote',
      { deploymentName: DEPLOYMENT },
      'alice-key',
    );
    expect(hidden.error?.data).toMatchObject({ resource: 'workerDeployment' });
  });

  it('ramps, promotes, and rolls back for a writer, and audits each move under the deployment', async () => {
    const { opened, catalog } = await open();

    const ramp = await call(
      opened,
      'bureau.deployments.ramp',
      { deploymentName: DEPLOYMENT, buildId: 'b', rampBasisPoints: 2500 },
      'deployments-writer-key',
    );
    expect(ramp.result).toMatchObject({
      rampingBuildId: 'b',
      rampBasisPoints: 2500,
      generation: 2,
    });

    const promote = await call(
      opened,
      'bureau.deployments.promote',
      { deploymentName: DEPLOYMENT, expectedGeneration: 2 },
      'deployments-writer-key',
    );
    expect(promote.result).toMatchObject({
      currentBuildId: 'b',
      rampingBuildId: null,
      previousBuildId: 'a',
      generation: 3,
    });

    const rollBack = await call(
      opened,
      'bureau.deployments.rollback',
      { deploymentName: DEPLOYMENT },
      'operator-key',
    );
    expect(rollBack.result).toMatchObject({
      currentBuildId: 'a',
      previousBuildId: 'b',
      generation: 4,
    });
    const routed = await catalog.getRouting(DEPLOYMENT);
    expect(routed?.currentBuildId).toBe('a');

    const trail = await call(
      opened,
      'bureau.audit.query',
      { runId: 'worker-deployment:billing' },
      'audit-reader-key',
    );
    expect(trail.error).toBeUndefined();
    const records = trail.result?.['records'] as Array<{
      type: string;
      principal: string | null;
      resource: string;
      detail: Record<string, unknown> | null;
    }>;
    expect(records[2]?.detail).toEqual({
      deploymentName: 'billing',
      fromBuildId: 'b',
      currentBuildId: 'a',
      rampBasisPoints: 0,
      previousBuildId: 'b',
      generation: 4,
    });
    expect(records.map((record) => [record.type, record.principal])).toEqual([
      ['deployment.ramped', 'api-key:deployments-writer'],
      ['deployment.promoted', 'api-key:deployments-writer'],
      ['deployment.rolled-back', 'api-key:operator'],
    ]);
  });

  it('answers a refused move with a typed fault and changes nothing', async () => {
    const { opened, catalog } = await open();
    const faultOf = async (method: string, params: Record<string, unknown>) => {
      const answered = await call(
        opened,
        method,
        { deploymentName: DEPLOYMENT, ...params },
        'operator-key',
      );
      return answered.error?.data;
    };

    expect(await faultOf('bureau.deployments.promote', {})).toMatchObject({
      reason: 'no-ramping-build',
    });
    expect(await faultOf('bureau.deployments.rollback', {})).toMatchObject({
      reason: 'no-previous-build',
    });
    expect(
      await faultOf('bureau.deployments.ramp', { buildId: 'a', rampBasisPoints: 1 }),
    ).toMatchObject({ reason: 'same-as-current' });
    expect(
      await faultOf('bureau.deployments.ramp', { buildId: 'zzz', rampBasisPoints: 1 }),
    ).toMatchObject({
      resource: 'workerDeploymentVersion',
      identifier: 'billing/zzz',
    });
    expect(
      await faultOf('bureau.deployments.ramp', { buildId: 'b', rampBasisPoints: 10_001 }),
    ).toBeDefined();

    // The pointer moves after the caller read generation 1.
    await catalog.setRouting({
      deploymentName: DEPLOYMENT,
      currentBuildId: 'c',
      rampBasisPoints: 0,
      updatedAt: 9,
    });
    expect(
      await faultOf('bureau.deployments.ramp', {
        buildId: 'b',
        rampBasisPoints: 1,
        expectedGeneration: 1,
      }),
    ).toMatchObject({
      reason: 'stale-generation',
      currentGeneration: 2,
    });
    const unchanged = await catalog.getRouting(DEPLOYMENT);
    expect(unchanged?.generation).toBe(2);
  });

  it('answers UnsupportedCapability when the Bureau has no worker deployment catalog', async () => {
    const opened = await openBureau();
    cleanups.push(() => opened.dispose());
    expect(opened.bureau.deployments).toBeUndefined();

    const answered = await call(
      opened,
      'bureau.deployments.get',
      { deploymentName: DEPLOYMENT },
      'operator-key',
    );

    expect(answered.error?.data).toMatchObject({ capability: 'worker-deployments' });
  });
});
