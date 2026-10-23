import { MemoryStorage, WEFT_RESERVED_KEY_PREFIXES } from '@lostgradient/weft';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DEFAULT_MEMORY_KEY_PREFIX } from '../../src/create-weft-memory-record-storage';
import { createMemoryAuthority } from '../../src/governance/authority';
import {
  DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX,
  type MemoryGovernanceLedger,
  createMemoryGovernanceLedger,
} from '../../src/governance/ledger';
import type { MemoryDeletionReceipt } from '../../src/governance/ledger-types';
import { attributionFor } from '../../src/governance/record-governance';
import { throwingRejectionOf } from '../../src/testing/promise-outcome.test-support.ts';

const attribution = attributionFor(
  createMemoryAuthority({
    principal: { kind: 'user', id: 'user-a' },
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    purpose: 'test',
    capabilities: ['memory:delete'],
    policyRevision: 'authorization:1',
    projection: 'administrative',
  }),
  { governanceRevision: 'governance:1', operationId: 'op-1', at: 10 },
);

function pluck<T, K extends keyof T>(items: readonly T[], key: K): T[K][] {
  return items.map((item) => item[key]);
}

function receipt(overrides: Partial<MemoryDeletionReceipt> = {}): MemoryDeletionReceipt {
  return {
    version: 1,
    deletionId: 'deletion-1',
    tenantId: 'tenant-a',
    scope: 'source',
    trigger: 'request',
    record: {
      id: 'record-1',
      namespace: 'private:owner-a:c',
      ownerId: 'owner-a',
      collection: 'c',
      memoryClass: 'episodic',
      contentDigest: 'digest',
    },
    plan: { projections: [], identityViews: [], managedAssetRecords: [], summaries: [] },
    contentDigests: ['digest'],
    requestedBy: attribution,
    requestedAt: 10,
    boundMilliseconds: 1000,
    awaitingHoldRelease: false,
    targets: [{ target: 'indexes', lane: 'bounded-async', status: 'pending', deadline: 1010 }],
    open: true,
    updatedAt: 10,
    ...overrides,
  };
}

describe('createMemoryGovernanceLedger', () => {
  let storage: MemoryStorage;
  let ledger: MemoryGovernanceLedger;

  beforeEach(() => {
    storage = new MemoryStorage();
    ledger = createMemoryGovernanceLedger(storage);
  });

  it('uses a key prefix disjoint from Weft reserved prefixes and memory records', () => {
    for (const reserved of WEFT_RESERVED_KEY_PREFIXES) {
      expect(DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX.startsWith(reserved)).toBe(false);
    }
    expect(DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX.startsWith(DEFAULT_MEMORY_KEY_PREFIX)).toBe(false);
    expect(() => createMemoryGovernanceLedger(storage, { keyPrefix: '' })).toThrow(/non-empty/);
    expect(() =>
      createMemoryGovernanceLedger(storage, { keyPrefix: WEFT_RESERVED_KEY_PREFIXES[0] }),
    ).toThrow(/reserved/);
  });

  it('appends, filters, and prunes events per tenant in time order', async () => {
    await ledger.appendEvent({
      id: 'e2',
      at: 20,
      tenantId: 'tenant-a',
      type: 'memory.revoked',
      outcome: 'revoked',
      recordIds: ['r2'],
    });
    await ledger.appendEvent({
      id: 'e1',
      at: 10,
      tenantId: 'tenant-a',
      type: 'memory.write.admitted',
      outcome: 'admitted',
      recordIds: ['r1'],
      attribution,
    });
    await ledger.appendEvent({
      id: 'e3',
      at: 30,
      tenantId: 'tenant-b',
      type: 'memory.revoked',
      outcome: 'revoked',
      recordIds: ['r1'],
    });

    expect(pluck(await ledger.listEvents({ tenantId: 'tenant-a' }), 'id')).toEqual(['e1', 'e2']);
    expect(
      pluck(await ledger.listEvents({ tenantId: 'tenant-a', type: 'memory.revoked' }), 'id'),
    ).toEqual(['e2']);
    expect(pluck(await ledger.listEvents({ tenantId: 'tenant-a', recordId: 'r1' }), 'id')).toEqual([
      'e1',
    ]);
    expect(await ledger.pruneEvents('tenant-a', 15)).toBe(1);
    expect(pluck(await ledger.listEvents({ tenantId: 'tenant-a' }), 'id')).toEqual(['e2']);
  });

  it('round-trips deletion receipts, filters open ones, and survives a new ledger instance', async () => {
    await ledger.putReceipt(receipt());
    await ledger.putReceipt(
      receipt({ deletionId: 'deletion-2', tenantId: 'tenant-b', open: false, targets: [] }),
    );

    const restarted = createMemoryGovernanceLedger(storage);
    expect(await restarted.getReceipt('deletion-1')).toEqual(receipt());
    expect(await restarted.getReceipt('missing')).toBeUndefined();
    expect(pluck(await restarted.listReceipts({ open: true }), 'deletionId')).toEqual([
      'deletion-1',
    ]);
    expect(pluck(await restarted.listReceipts({ tenantId: 'tenant-b' }), 'deletionId')).toEqual([
      'deletion-2',
    ]);
    await restarted.deleteReceipt('deletion-2');
    expect(await restarted.getReceipt('deletion-2')).toBeUndefined();
  });

  it('opens a receipt only when none is stored under its deletion id', async () => {
    expect(await ledger.openReceipt(receipt())).toBe(true);
    // A second claimant building a receipt under the same deletion id opens nothing.
    expect(
      await ledger.openReceipt(receipt({ trigger: 'retention-expiry', requestedAt: 20 })),
    ).toBe(false);
    expect(await ledger.getReceipt('deletion-1')).toEqual(receipt());
    expect(await ledger.openReceipt(receipt({ deletionId: 'deletion-2' }))).toBe(true);
  });

  it('rejects a corrupt persisted receipt instead of treating it as absent', async () => {
    await ledger.putReceipt(receipt());
    const key = [...storage.snapshot().keys()].find((candidate) => candidate.includes('receipt:'))!;
    await storage.put(key, new TextEncoder().encode('{"version":1}'));
    expect(await throwingRejectionOf(ledger.getReceipt('deletion-1'))).toThrow();
  });

  it('stores export manifests and finds them by record', async () => {
    const manifest = {
      version: 1 as const,
      exportId: 'export-1',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      exportedBy: attribution,
      recordIds: ['r1', 'r2'],
      removedRecordIds: [],
      createdAt: 10,
      revoked: false,
    };
    await ledger.putExport(manifest);
    expect(await ledger.getExport('tenant-a', 'export-1')).toEqual(manifest);
    expect(await ledger.getExport('tenant-b', 'export-1')).toBeUndefined();
    expect(await ledger.listExports({ tenantId: 'tenant-a', recordId: 'r2' })).toEqual([manifest]);
    expect(await ledger.listExports({ tenantId: 'tenant-a', recordId: 'r9' })).toEqual([]);
    expect(await ledger.listExports({ tenantId: 'tenant-a' })).toEqual([manifest]);
  });

  describe('export manifest changes', () => {
    const manifest = {
      version: 1 as const,
      exportId: 'export-1',
      tenantId: 'tenant-a',
      ownerId: 'owner-a',
      exportedBy: attribution,
      recordIds: ['r1', 'r2', 'r3'],
      removedRecordIds: ['r0'],
      createdAt: 10,
      revoked: false,
    };
    const revocation = { revokedAt: 20, revokedBy: attribution };

    beforeEach(async () => {
      await ledger.putExport(manifest);
    });

    it('revokes an export once, keeping everything else it lists', async () => {
      const revoked = { ...manifest, revoked: true, revokedAt: 20, revokedBy: attribution };
      expect(await ledger.revokeExport('tenant-a', 'export-1', revocation)).toEqual(revoked);
      expect(await ledger.getExport('tenant-a', 'export-1')).toEqual(revoked);
      expect(
        await ledger.revokeExport('tenant-a', 'export-1', { ...revocation, revokedAt: 30 }),
      ).toBeUndefined();
      expect(await ledger.getExport('tenant-a', 'export-1')).toEqual(revoked);
      expect(await ledger.revokeExport('tenant-a', 'export-9', revocation)).toBeUndefined();
      expect(await ledger.revokeExport('tenant-b', 'export-1', revocation)).toBeUndefined();
    });

    it('scrubs deleted records without touching the revocation', async () => {
      await ledger.revokeExport('tenant-a', 'export-1', revocation);
      await ledger.scrubExport('tenant-a', 'export-1', ['r2', 'r0', 'r9']);
      expect(await ledger.getExport('tenant-a', 'export-1')).toMatchObject({
        revoked: true,
        revokedAt: 20,
        recordIds: ['r1', 'r3'],
        removedRecordIds: ['r0', 'r2'],
      });
      await ledger.scrubExport('tenant-a', 'export-1', ['r2', 'r9']);
      await ledger.scrubExport('tenant-a', 'export-9', ['r1']);
      expect(await ledger.getExport('tenant-a', 'export-1')).toMatchObject({
        recordIds: ['r1', 'r3'],
        removedRecordIds: ['r0', 'r2'],
      });
    });

    it('re-reads and merges when another writer changes the manifest first', async () => {
      let interleaved = false;
      const racing = createMemoryGovernanceLedger(
        new Proxy(storage, {
          get(target, property) {
            if (property === 'conditionalBatch') {
              return async (
                ...batch: Parameters<NonNullable<MemoryStorage['conditionalBatch']>>
              ) => {
                if (!interleaved) {
                  interleaved = true;
                  await ledger.revokeExport('tenant-a', 'export-1', revocation);
                }
                return target.conditionalBatch(...batch);
              };
            }
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      );
      await racing.scrubExport('tenant-a', 'export-1', ['r1']);
      expect(await ledger.getExport('tenant-a', 'export-1')).toMatchObject({
        revoked: true,
        recordIds: ['r2', 'r3'],
        removedRecordIds: ['r0', 'r1'],
      });
    });

    it('surfaces a manifest that keeps changing instead of overwriting it', async () => {
      const contended = createMemoryGovernanceLedger(
        new Proxy(storage, {
          get(target, property) {
            if (property === 'conditionalBatch') return async () => false;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
      );
      expect(
        await throwingRejectionOf(contended.revokeExport('tenant-a', 'export-1', revocation)),
      ).toThrow('Export manifest "export-1" kept changing; gave up after 8 attempts.');
      expect(await ledger.getExport('tenant-a', 'export-1')).toEqual(manifest);
    });
  });

  it('indexes lineage from a source to its derived records', async () => {
    const source = { id: 'r1', namespace: 'private:owner-a:c' };
    await ledger.putLineage({
      tenantId: 'tenant-a',
      source,
      derived: { id: 'r2', namespace: 'shared:c', kind: 'canonical-projection' },
    });
    await ledger.putLineage({
      tenantId: 'tenant-a',
      source,
      derived: { id: 'r3', namespace: 'private:owner-a:c', kind: 'summary' },
    });
    const links = await ledger.listLineage('tenant-a', source);
    const derived = links.map((link) => link.derived.id);
    expect(derived.toSorted()).toEqual(['r2', 'r3']);
    expect(await ledger.listLineage('tenant-b', source)).toEqual([]);
    await ledger.deleteLineage('tenant-a', source);
    expect(await ledger.listLineage('tenant-a', source)).toEqual([]);
  });

  it('tracks pending derivations per tenant until they settle', async () => {
    const shared = { id: 'r2', namespace: 'shared:c' };
    const summary = { id: 'r3', namespace: 'private:owner-a:c' };
    await ledger.putPendingDerivation({ tenantId: 'tenant-a', record: shared, startedAt: 10 });
    await ledger.putPendingDerivation({ tenantId: 'tenant-a', record: summary, startedAt: 20 });
    await ledger.putPendingDerivation({ tenantId: 'tenant-b', record: shared, startedAt: 30 });

    const restarted = createMemoryGovernanceLedger(storage);
    expect(await restarted.listPendingDerivations({ tenantId: 'tenant-a' })).toEqual([
      { tenantId: 'tenant-a', record: summary, startedAt: 20 },
      { tenantId: 'tenant-a', record: shared, startedAt: 10 },
    ]);
    expect(pluck(await restarted.listPendingDerivations({}), 'tenantId')).toEqual([
      'tenant-a',
      'tenant-a',
      'tenant-b',
    ]);
    await restarted.deletePendingDerivation('tenant-a', shared);
    expect(await restarted.listPendingDerivations({ tenantId: 'tenant-a' })).toEqual([
      { tenantId: 'tenant-a', record: summary, startedAt: 20 },
    ]);
    expect(await restarted.listPendingDerivations({ tenantId: 'tenant-b' })).toHaveLength(1);
  });

  it('registers scopes and context evictions per tenant', async () => {
    await ledger.registerScope({ tenantId: 'tenant-a', namespace: 'private:owner-a:c' });
    await ledger.registerScope({ tenantId: 'tenant-a', namespace: 'shared:c' });
    await ledger.registerScope({ tenantId: 'tenant-b', namespace: 'shared:c' });
    expect(await ledger.listScopes('tenant-a')).toEqual([
      { tenantId: 'tenant-a', namespace: 'private:owner-a:c' },
      { tenantId: 'tenant-a', namespace: 'shared:c' },
    ]);

    await ledger.putEviction('tenant-a', 'run-1', 'r1');
    await ledger.putEviction('tenant-a', 'run-1', 'r2');
    await ledger.putEviction('tenant-a', 'run-2', 'r3');
    expect(await ledger.listEvictions('tenant-a', 'run-1')).toEqual(['r1', 'r2']);
    expect(await ledger.listEvictions('tenant-b', 'run-1')).toEqual([]);
  });
});
