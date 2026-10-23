/**
 * COR-1664 — reconciling the claims runs and sessions hold on managed assets, from the asset side,
 * over a real asset service. The matrix this file pins:
 *
 * | Run state                        | Claims                                       |
 * | -------------------------------- | -------------------------------------------- |
 * | completed, failed, canceled      | released (including a row compaction removed) |
 * | in flight                        | kept                                         |
 * | no durable record, or unreadable | kept, said once                              |
 * | goal attempt, goal going         | kept; released once the goal is over         |
 *
 * | Session incarnation | Claims   |
 * | ------------------- | -------- |
 * | live                | kept     |
 * | deleted, replaced   | released |
 *
 * Every pass is idempotent, and another holder's claim on the same asset is never touched.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { createAssetService } from './assets/asset-service';
import { AssetReservedHolderError } from './assets/errors';
import { bureauClaim, heldClaimsOf } from './assets/internal-access';
import { releaseHeldClaims, runRowHolderId, sessionRowHolderId } from './assets/row-asset-claims';
import { createMemoryAssetStorage } from './assets/storage';
import type { AssetService } from './assets/types';
import { createAssetClaimReconciler } from './asset-claim-reconciliation';
import type { DurableEnd } from './catalog-run-settlement';
import type { CatalogRunRecoveryLoad } from './runtime-composition';
import { alice, aliceAdministrator, pngBytes } from './testing/asset-fixtures.test-support';
import type { BureauDiagnostic } from './types';

const UNTIL = '9999-12-31T23:59:59.999Z';
const services: AssetService[] = [];
afterEach(async () => {
  while (services.length > 0) await services.pop()!.shutdown();
});

async function admitAsset(service: AssetService): Promise<string> {
  const admission = await service.admit(
    { source: { kind: 'inline', bytes: pngBytes(2, 2) }, declaredMediaType: 'image/png' },
    alice,
  );
  await admission.work.result();
  return admission.assetId;
}

async function holdersOf(service: AssetService, assetId: string): Promise<string[]> {
  const descriptor = await service.inspect(assetId, aliceAdministrator, {
    projection: 'privileged',
  });
  if (descriptor.projection !== 'privileged') throw new Error('expected the privileged projection');
  return descriptor.retention.references.map((reference) => reference.holderId);
}

interface Scenario {
  readonly ends?: Record<string, DurableEnd | Error>;
  readonly records?: Record<string, CatalogRunRecoveryLoad>;
  readonly goalsOver?: Record<string, boolean | Error>;
  readonly liveSessions?: Record<string, string>;
  readonly closed?: () => boolean;
}

async function setup(scenario: Scenario = {}) {
  const service = await createAssetService({ storage: createMemoryAssetStorage() });
  services.push(service);
  const diagnostics: BureauDiagnostic[] = [];
  const forgotten: string[] = [];
  const reconciler = createAssetClaimReconciler({
    assets: () => service,
    durableEnd: async (runId) => {
      const end = scenario.ends?.[runId] ?? 'not-durable';
      if (end instanceof Error) throw end;
      return end;
    },
    loadRecoveryRecord: async (runId) => scenario.records?.[runId] ?? { status: 'missing' },
    goalIsOver: async (goalRunId) => {
      const over = scenario.goalsOver?.[goalRunId] ?? false;
      if (over instanceof Error) throw over;
      return over;
    },
    sessionIsLive: async (sessionId, incarnation) =>
      scenario.liveSessions?.[sessionId] === incarnation,
    isClosed: scenario.closed ?? (() => false),
    onReleased: (claim) => forgotten.push(`${claim.holderId}|${claim.assetId}`),
    diagnose: (diagnostic) => diagnostics.push(diagnostic),
  });
  const claim = async (assetId: string, holderId: string) =>
    service.retain(assetId, alice, { holderId, until: UNTIL, [bureauClaim]: true });
  return { service, reconciler, diagnostics, forgotten, claim };
}

describe('what the public asset service does not offer (COR-1664)', () => {
  it('has no claim lookup across principals, and the package index exports no way to one', async () => {
    const { service } = await setup();
    // @ts-expect-error `heldClaims` is not on the public `AssetService`.
    const lookup: unknown = service.heldClaims;

    expect(lookup).toBeUndefined();
    expect('heldClaims' in service).toBe(false);
    const exported = await import('./index');
    for (const name of ['heldClaimsOf', 'exposeHeldClaims', 'bureauClaim', 'isReservedHolderId']) {
      expect(name in exported).toBe(false);
    }
  });

  it.each(['run-row:agent-run-1:row-1', 'session-row:s:i:row-1', 'run-row:'])(
    'refuses a public retain under the reserved holder %s, and Bureau’s own claim may take it',
    async (holderId) => {
      const { service } = await setup();
      const assetId = await admitAsset(service);

      const refusal = await service.retain(assetId, alice, { holderId, until: UNTIL }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(refusal).toBeInstanceOf(AssetReservedHolderError);
      expect(await holdersOf(service, assetId)).toEqual([]);
      await service.retain(assetId, alice, { holderId, until: UNTIL, [bureauClaim]: true });
      expect(await holdersOf(service, assetId)).toEqual([holderId]);
    },
  );

  it('still accepts a public retain under any other holder', async () => {
    const { service } = await setup();
    const assetId = await admitAsset(service);

    await service.retain(assetId, alice, { holderId: 'my-feature:1', until: UNTIL });

    expect(await holdersOf(service, assetId)).toEqual(['my-feature:1']);
  });
});

describe('reconciling the claims of runs', () => {
  it.each(['completed', 'failed', 'canceled'] as const)(
    'releases the claims of a run that %s, including a row no checkpoint names, once',
    async (end) => {
      const { service, reconciler, claim } = await setup({ ends: { 'agent-run-1': end } });
      const first = await admitAsset(service);
      const second = await admitAsset(service);
      await claim(first, runRowHolderId('agent-run-1', 'row-kept'));
      await claim(second, runRowHolderId('agent-run-1', 'row-compacted-out'));
      await claim(second, sessionRowHolderId('session-1', 'incarnation-1', 'row-1'));

      expect(await reconciler.reconcileRunClaims()).toEqual({ released: 2, kept: 0 });

      expect(await holdersOf(service, first)).toEqual([]);
      expect(await holdersOf(service, second)).toEqual([
        sessionRowHolderId('session-1', 'incarnation-1', 'row-1'),
      ]);
      expect(await reconciler.reconcileRunClaims()).toEqual({ released: 0, kept: 0 });
    },
  );

  it('keeps every claim of a run that is still in flight, because it resumes', async () => {
    const { service, reconciler, claim, diagnostics } = await setup({
      ends: { 'agent-run-1': 'in-flight' },
    });
    const assetId = await admitAsset(service);
    await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));

    expect(await reconciler.reconcileRunClaims()).toEqual({ released: 0, kept: 1 });

    expect(await holdersOf(service, assetId)).toEqual([runRowHolderId('agent-run-1', 'row-1')]);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['has no durable record', { 'agent-run-1': 'not-durable' as const }],
    ['cannot be read', { 'agent-run-1': new Error('the engine is down') }],
  ])('keeps the claims of a run that %s, and says so once across passes', async (_name, ends) => {
    const { service, reconciler, claim, diagnostics } = await setup({ ends });
    const assetId = await admitAsset(service);
    await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));

    await reconciler.reconcileRunClaims();
    await reconciler.reconcileRunClaims();

    expect(await holdersOf(service, assetId)).toEqual([runRowHolderId('agent-run-1', 'row-1')]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warn', scope: 'assets' });
    expect(diagnostics[0]?.message).toContain('agent-run-1');
  });

  it('leaves a terminal goal attempt of a goal that goes on to the goal forwarder', async () => {
    const attempt = {
      status: 'found',
      record: { goalAttempt: { goalRunId: 'goal-1', attemptIndex: 0 } },
    } as unknown as CatalogRunRecoveryLoad;
    const scenario = {
      ends: { 'agent-run-1': 'completed' as const },
      records: { 'agent-run-1': attempt },
      goalsOver: { 'goal-1': false },
    };
    const { service, reconciler, claim } = await setup(scenario);
    const assetId = await admitAsset(service);
    await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));

    expect(await reconciler.reconcileRunClaims()).toEqual({ released: 0, kept: 1 });
    expect(await holdersOf(service, assetId)).toHaveLength(1);

    scenario.goalsOver['goal-1'] = true;
    expect(await reconciler.reconcileRunClaims()).toEqual({ released: 1, kept: 0 });
    expect(await holdersOf(service, assetId)).toEqual([]);
  });

  it.each([
    ['a recovery record that is corrupt', { 'agent-run-1': { status: 'corrupt' as const } }, {}],
    [
      'a goal that cannot be read',
      {
        'agent-run-1': {
          status: 'found',
          record: { goalAttempt: { goalRunId: 'goal-1', attemptIndex: 0 } },
        } as unknown as CatalogRunRecoveryLoad,
      },
      { 'goal-1': new Error('the goal store is down') },
    ],
  ])(
    'keeps the claims of a terminal run it cannot place: %s',
    async (_name, records, goalsOver) => {
      const { service, reconciler, claim, diagnostics } = await setup({
        ends: { 'agent-run-1': 'completed' },
        records,
        goalsOver,
      });
      const assetId = await admitAsset(service);
      await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));

      expect(await reconciler.reconcileRunClaims()).toEqual({ released: 0, kept: 1 });

      expect(await holdersOf(service, assetId)).toHaveLength(1);
      expect(diagnostics).toHaveLength(1);
    },
  );

  it('forgets the claims it releases, so a later claim for the same pair is made again', async () => {
    const { service, reconciler, claim, forgotten } = await setup({
      ends: { 'agent-run-1': 'completed' },
    });
    const assetId = await admitAsset(service);
    const holderId = runRowHolderId('agent-run-1', 'row-1');
    await claim(assetId, holderId);

    await reconciler.reconcileRunClaims();

    expect(forgotten).toEqual([`${holderId}|${assetId}`]);
  });

  it('does nothing once releases are closed, and without an asset service', async () => {
    const { service, reconciler, claim } = await setup({
      ends: { 'agent-run-1': 'completed' },
      closed: () => true,
    });
    const assetId = await admitAsset(service);
    await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));

    expect(await reconciler.reconcileRunClaims()).toEqual({ released: 0, kept: 0 });
    expect(await holdersOf(service, assetId)).toHaveLength(1);

    const without = createAssetClaimReconciler({
      assets: () => undefined,
      durableEnd: async () => 'completed',
      loadRecoveryRecord: async () => ({ status: 'missing' }),
      goalIsOver: async () => true,
      sessionIsLive: async () => false,
      isClosed: () => false,
      diagnose: () => {},
    });
    expect(await without.reconcileRunClaims()).toEqual({ released: 0, kept: 0 });
    expect(await without.reconcileSessionClaims()).toEqual({ released: 0, kept: 0 });
  });
});

describe('reconciling claims that other holders or other reconcilers also touch', () => {
  it('skips a malformed holder id and still releases the other runs’ claims', async () => {
    const { service, reconciler, claim } = await setup({ ends: { 'agent-run-1': 'completed' } });
    const assetId = await admitAsset(service);
    await claim(assetId, 'run-row:%:row');
    await claim(assetId, 'session-row:%:i:row');
    await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));

    expect(await reconciler.reconcileRunClaims()).toEqual({ released: 1, kept: 0 });
    expect(await reconciler.reconcileSessionClaims()).toEqual({ released: 0, kept: 0 });

    const remaining = await holdersOf(service, assetId);
    expect(remaining.toSorted()).toEqual(['run-row:%:row', 'session-row:%:i:row']);
  });

  it('emits one release and counts one when two reconcilers release the same claim', async () => {
    const { service, reconciler, claim } = await setup({ ends: { 'agent-run-1': 'completed' } });
    const other = createAssetClaimReconciler({
      assets: () => service,
      durableEnd: async () => 'completed',
      loadRecoveryRecord: async () => ({ status: 'missing' }),
      goalIsOver: async () => true,
      sessionIsLive: async () => false,
      isClosed: () => false,
      diagnose: () => {},
    });
    const assetId = await admitAsset(service);
    await claim(assetId, runRowHolderId('agent-run-1', 'row-1'));
    const events: string[] = [];
    service.subscribe((event) => {
      if (event.type === 'asset.released') events.push(event.holderId ?? '');
    });

    const reports = await Promise.all([
      reconciler.reconcileRunClaims(),
      other.reconcileRunClaims(),
    ]);
    // Release events are delivered after the write settles.
    await service.auditRecords();

    expect(reports.reduce((total, report) => total + report.released, 0)).toBe(1);
    expect(events).toEqual([runRowHolderId('agent-run-1', 'row-1')]);
    expect(await holdersOf(service, assetId)).toEqual([]);
  });

  it('emits nothing when a holder that holds nothing is released', async () => {
    const { service } = await setup();
    const assetId = await admitAsset(service);
    const events: string[] = [];
    service.subscribe((event) => events.push(event.type));

    expect(await service.releaseClaim(assetId, alice, 'run-row:none:row')).toBe(false);
    await service.auditRecords();

    expect(events).toEqual([]);
  });
});

describe('releasing a claim while another Bureau updates the same asset (COR-1664)', () => {
  /** Two services over one store, so the per-asset lock of one cannot hide the other's write. */
  async function twoServices() {
    const storage = createMemoryAssetStorage();
    let beforeCommit: (() => Promise<void>) | undefined;
    const contended: typeof storage = {
      ...storage,
      conditionalBatch: async (conditions, operations) => {
        const hook = beforeCommit;
        beforeCommit = undefined;
        await hook?.();
        return storage.conditionalBatch(conditions, operations);
      },
    };
    const reconciling = await createAssetService({ storage: contended });
    const other = await createAssetService({ storage });
    services.push(reconciling, other);
    return { reconciling, other, interleave: (hook: () => Promise<void>) => (beforeCommit = hook) };
  }

  it('retries after a lost compare-and-swap and releases the dead holder once', async () => {
    const { reconciling, other, interleave } = await twoServices();
    const assetId = await admitAsset(reconciling);
    const dead = runRowHolderId('agent-run-1', 'row-1');
    await reconciling.retain(assetId, alice, { holderId: dead, until: UNTIL, [bureauClaim]: true });
    const failures: unknown[] = [];
    const claims = await heldClaimsOf(reconciling, 'run-row:');
    const events: string[] = [];
    reconciling.subscribe((event) => {
      if (event.type === 'asset.released') events.push(event.holderId ?? '');
    });
    // Another Bureau renews a different reference between the reconciler's read and its write.
    interleave(async () => {
      await other.retain(assetId, alice, {
        holderId: 'session-row:s:i:r',
        until: UNTIL,
        [bureauClaim]: true,
      });
    });

    const released = await releaseHeldClaims(reconciling, claims, (_claim, error) =>
      failures.push(error),
    );
    await reconciling.auditRecords();

    expect(failures).toEqual([]);
    expect(released).toBe(1);
    expect(events).toEqual([dead]);
    expect(await holdersOf(reconciling, assetId)).toEqual(['session-row:s:i:r']);
  });

  it('counts a claim the other Bureau released meanwhile as no release', async () => {
    const { reconciling, other, interleave } = await twoServices();
    const assetId = await admitAsset(reconciling);
    const dead = runRowHolderId('agent-run-1', 'row-1');
    await reconciling.retain(assetId, alice, { holderId: dead, until: UNTIL, [bureauClaim]: true });
    const claims = await heldClaimsOf(reconciling, 'run-row:');
    interleave(async () => {
      await other.release(assetId, alice, dead);
    });

    const released = await releaseHeldClaims(reconciling, claims, () => {
      throw new Error('unexpected failure');
    });

    expect(released).toBe(0);
    expect(await holdersOf(reconciling, assetId)).toEqual([]);
  });
});

describe('reconciling the claims of sessions', () => {
  it('releases the claims of a deleted session and of a replaced incarnation, and keeps the live one', async () => {
    const { service, reconciler, claim } = await setup({
      liveSessions: { 'session-live': 'incarnation-2', 'session-replaced': 'incarnation-new' },
    });
    const assetId = await admitAsset(service);
    const live = sessionRowHolderId('session-live', 'incarnation-2', 'row-1');
    const replaced = sessionRowHolderId('session-replaced', 'incarnation-old', 'row-1');
    const current = sessionRowHolderId('session-replaced', 'incarnation-new', 'row-1');
    const deleted = sessionRowHolderId('session-deleted', 'incarnation-1', 'row-1');
    const runHolder = runRowHolderId('agent-run-1', 'row-1');
    for (const holderId of [live, replaced, current, deleted, runHolder]) {
      await claim(assetId, holderId);
    }

    expect(await reconciler.reconcileSessionClaims()).toEqual({ released: 2, kept: 2 });

    const remaining = await holdersOf(service, assetId);
    expect(remaining.toSorted()).toEqual([live, current, runHolder].toSorted());
    expect(await reconciler.reconcileSessionClaims()).toEqual({ released: 0, kept: 2 });
  });

  it('keeps the claims of a session the store cannot answer for, and says so once', async () => {
    const { service, claim, diagnostics } = await setup();
    const assetId = await admitAsset(service);
    await claim(assetId, sessionRowHolderId('session-1', 'incarnation-1', 'row-1'));
    const reconciler = createAssetClaimReconciler({
      assets: () => service,
      durableEnd: async () => 'completed',
      loadRecoveryRecord: async () => ({ status: 'missing' }),
      goalIsOver: async () => true,
      sessionIsLive: async () => {
        throw new Error('the session store is down');
      },
      isClosed: () => false,
      diagnose: (diagnostic) => diagnostics.push(diagnostic),
    });

    await reconciler.reconcileSessionClaims();
    await reconciler.reconcileSessionClaims();

    expect(await holdersOf(service, assetId)).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
  });
});
