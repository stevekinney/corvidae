import type { BatchOperation, ConditionalBatchCondition, Storage } from '@lostgradient/weft';
import { beforeEach, describe, expect, it } from 'bun:test';

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import type { MemoryForgetResult } from '../../src/governance/governed-memory-types';
import {
  createMemoryGovernanceLedger,
  DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX,
} from '../../src/governance/ledger';
import type { MemoryDeletionReceipt } from '../../src/governance/ledger-types';
import {
  collectionNamespace,
  type MemoryRecordSourceReference,
  readRecordGovernance,
} from '../../src/governance/record-governance';
import {
  type MemoryRecordReference,
  MemoryRecordVersionConflictError,
} from '../../src/memory-record-storage';
import {
  createGovernedFixture,
  governancePrincipal,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  principalB,
  receiptOf,
  recordIdOf,
} from './governed-memory-harness';

const SECRET = 'vault-secret-7f3a9c';

function scopeOf(collection: string, visibility: 'private' | 'shared' = 'private') {
  return {
    tenantId: 'tenant-a',
    namespace: collectionNamespace(visibility, 'owner-a', collection),
  };
}

function idsOf(references: readonly MemoryRecordSourceReference[] | undefined): string[] {
  return (references ?? []).map((reference) => reference.id);
}

/** True when `id` is absent (nothing was reported) or listed in `ids`. */
function reportedIn(ids: readonly string[] | undefined, id: string | undefined): boolean {
  return id === undefined || (ids ?? []).includes(id);
}

function statuses(receipt: MemoryDeletionReceipt | undefined): Record<string, string> {
  return Object.fromEntries(
    (receipt?.targets ?? []).map((target) => [target.target, target.status]),
  );
}

const EXPORT_PREFIX = `${DEFAULT_MEMORY_GOVERNANCE_KEY_PREFIX}export:`;

/** `storage`, running `hook` once, just before the first write that touches an export manifest. */
function beforeFirstExportWrite(storage: Storage, hook: () => Promise<void>): Storage {
  let fired = false;
  const fire = async (keys: readonly string[]) => {
    if (fired || !keys.some((key) => key.startsWith(EXPORT_PREFIX))) return;
    fired = true;
    await hook();
  };
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'put') {
        return async (key: string, value: Uint8Array) => {
          await fire([key]);
          return target.put(key, value);
        };
      }
      if (property === 'conditionalBatch') {
        return async (conditions: ConditionalBatchCondition[], operations: BatchOperation[]) => {
          await fire(operations.map((operation) => operation.key));
          return target.conditionalBatch!(conditions, operations);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Operations that race each other with no fault injected: a derivation against
 * the deletion or revocation of its source, and export revocation against the
 * deletion that scrubs the same manifest. Each case runs over both record
 * backends.
 */
export function registerRaceContract(backend: GovernedBackend): void {
  describe(`governed memory concurrent operations (${backend})`, () => {
    let fixture: GovernedFixture;
    let recordId: string;
    const notes = (id: string) => ({ id, collection: 'notes' });

    /** Ids in `scope` whose envelope is still active. */
    async function activeIds(scope: ReturnType<typeof scopeOf>): Promise<string[]> {
      const records = await fixture.storage.list(scope);
      return records
        .filter((record) => readRecordGovernance(record)?.governance.state === 'active')
        .map((record) => record.id);
    }

    function deriveIdentityView(sourceId: string, content = 'Identity view: the card holder.') {
      return fixture.memory.write(principalA, content, {
        collection: 'notes',
        source: 'derived',
        memoryClass: 'identity',
        derivedFrom: { kind: 'identity-view', sources: [notes(sourceId)] },
      });
    }

    beforeEach(async () => {
      fixture = await createGovernedFixture(backend);
      recordId = await recordIdOf(
        fixture.memory.write(principalA, `Card vault key: ${SECRET}`, {
          collection: 'notes',
          source: 'conversation',
        }),
      );
    });

    describe('a derivation racing the deletion or revocation of its source', () => {
      it('never publishes a shared copy that outlives a source deleted while it was promoted', async () => {
        const [promoted, deleted] = await Promise.all([
          fixture.memory.promote(principalA, notes(recordId)),
          fixture.memory.delete(principalA, notes(recordId)),
        ]);
        expect(deleted.status).toBe('applied');
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeUndefined();
        expect(await fixture.storage.list(scopeOf('notes', 'shared'))).toEqual([]);
        expect(
          await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
        ).toEqual([]);
        expect(reportedIn(idsOf(deleted.receipt?.plan.projections), promoted.sharedId)).toBe(true);
      });

      it('never leaves a shared copy active after a source revoked while it was promoted', async () => {
        const [promoted, revoked] = await Promise.all([
          fixture.memory.promote(principalA, notes(recordId)),
          fixture.memory.revoke(principalA, notes(recordId), 'retracted'),
        ]);
        expect(revoked.status).toBe('applied');
        expect(await activeIds(scopeOf('notes', 'shared'))).toEqual([]);
        expect(
          await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
        ).toEqual([]);
        expect(reportedIn(revoked.recordIds, promoted.sharedId)).toBe(true);
      });

      it('never keeps an identity view of a source deleted while the view was written', async () => {
        const [written, deleted] = await Promise.all([
          deriveIdentityView(recordId, `Identity view: holder of ${SECRET}.`),
          fixture.memory.delete(principalA, notes(recordId)),
        ]);
        expect(deleted.status).toBe('applied');
        expect(await fixture.storage.list(scopeOf('notes'))).toEqual([]);
        expect(reportedIn(idsOf(deleted.receipt?.plan.identityViews), written.recordId)).toBe(true);
        expect(statuses(deleted.receipt)['identity-views']).toBe('completed');
      });

      it('never keeps a summary of a source deleted while it was consolidated', async () => {
        const companion = await recordIdOf(
          fixture.memory.write(principalA, 'Cards are stored in the vault.', {
            collection: 'notes',
            source: 'conversation',
          }),
        );
        const [consolidated, deleted] = await Promise.all([
          fixture.memory.forget(principalA, {
            mode: 'consolidation',
            locators: [notes(recordId), notes(companion)],
            content: `The vault holds the card key ${SECRET}.`,
            collection: 'digest',
          }),
          fixture.memory.delete(principalA, notes(recordId)),
        ]);
        expect(deleted.status).toBe('applied');
        expect(await fixture.storage.list(scopeOf('digest'))).toEqual([]);
        expect(
          reportedIn(idsOf(deleted.receipt?.plan.summaries), consolidated.write?.recordId),
        ).toBe(true);
        expect(statuses(deleted.receipt)['summaries']).toBe('completed');
      });

      it('withdraws a promotion whose source was deleted before its copy was linked', async () => {
        const promoting = fixture.restart({
          ledger: {
            ...fixture.ledger,
            putLineage: async (link) => {
              await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
              return fixture.ledger.putLineage(link);
            },
          },
        });
        const promoted = await promoting.promote(principalA, notes(recordId));
        expect(promoted).toMatchObject({ status: 'not-found' });
        expect(promoted.sharedId).toBeUndefined();
        expect(await fixture.storage.list(scopeOf('notes', 'shared'))).toEqual([]);
        const [rejection] = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.promotion.rejected',
        });
        expect(rejection).toMatchObject({ outcome: 'rejected', reason: 'not-found' });
      });

      it('withdraws a promotion whose source was revoked before its copy was linked', async () => {
        const promoting = fixture.restart({
          ledger: {
            ...fixture.ledger,
            putLineage: async (link) => {
              await fixture.memory.revoke(principalA, notes(recordId), 'retracted');
              return fixture.ledger.putLineage(link);
            },
          },
        });
        expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
          status: 'rejected',
          reason: 'not-active',
        });
        expect(await fixture.storage.list(scopeOf('notes', 'shared'))).toEqual([]);
      });

      it('withdraws a derived write whose source was deleted before it was linked', async () => {
        const writing = fixture.restart({
          ledger: {
            ...fixture.ledger,
            putLineage: async (link) => {
              await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
              return fixture.ledger.putLineage(link);
            },
          },
        });
        expect(
          await writing.write(principalA, 'Identity view: the card holder.', {
            collection: 'notes',
            source: 'derived',
            memoryClass: 'identity',
            derivedFrom: { kind: 'identity-view', sources: [notes(recordId)] },
          }),
        ).toMatchObject({ status: 'rejected', reason: 'invalid-source' });
        expect(await fixture.storage.list(scopeOf('notes'))).toEqual([]);
      });

      it('refuses a promotion that verified its source after a deletion began planning', async () => {
        let promoted: Awaited<ReturnType<typeof fixture.memory.promote>> | undefined;
        const deleting = fixture.restart({
          ledger: {
            ...fixture.ledger,
            listLineage: async (tenantId, source) => {
              const links = await fixture.ledger.listLineage(tenantId, source);
              if (promoted === undefined) {
                promoted = await fixture.memory.promote(principalA, notes(recordId));
              }
              return links;
            },
          },
        });
        const receipt = await receiptOf(deleting.delete(principalA, notes(recordId)));
        expect(promoted).toMatchObject({ status: 'rejected', reason: 'deletion-pending' });
        expect(statuses(receipt)['source-evidence']).toBe('completed');
        expect(await fixture.storage.list(scopeOf('notes', 'shared'))).toEqual([]);
        expect(
          await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
        ).toEqual([]);
      });

      it('reaches a record derived from a derivation while the deletion was reading its lineage', async () => {
        const view = await recordIdOf(deriveIdentityView(recordId));
        let nested: string | undefined;
        const deleting = fixture.restart({
          ledger: {
            ...fixture.ledger,
            listLineage: async (tenantId, source) => {
              const links = await fixture.ledger.listLineage(tenantId, source);
              if (source.id === view && nested === undefined) {
                nested = await recordIdOf(
                  fixture.memory.write(principalA, 'Canonical card holder record.', {
                    collection: 'notes',
                    source: 'derived',
                    derivedFrom: { kind: 'canonical-projection', sources: [notes(view)] },
                  }),
                );
              }
              return links;
            },
          },
        });
        const receipt = await receiptOf(deleting.delete(principalA, notes(recordId)));
        expect(idsOf(receipt.plan.identityViews)).toEqual([view]);
        expect(idsOf(receipt.plan.projections)).toEqual([nested!]);
        expect(statuses(receipt)).toMatchObject({
          'source-evidence': 'completed',
          'canonical-projections': 'completed',
          'identity-views': 'completed',
        });
        expect(await fixture.storage.list(scopeOf('notes'))).toEqual([]);
      });

      it('reaches a promotion that lands while the revocation is stamping its source', async () => {
        let promoted: Awaited<ReturnType<typeof fixture.memory.promote>> | undefined;
        const revoking = fixture.restart({
          storage: {
            ...fixture.storage,
            update: async (...update: Parameters<typeof fixture.storage.update>) => {
              if (promoted === undefined && update[0] === recordId) {
                promoted = await fixture.memory.promote(principalA, notes(recordId));
              }
              return fixture.storage.update(...update);
            },
          },
        });
        const revoked = await revoking.revoke(principalA, notes(recordId), 'retracted');
        expect(promoted).toMatchObject({ status: 'applied' });
        expect(revoked.recordIds).toEqual([recordId, promoted!.sharedId!]);
        expect(await activeIds(scopeOf('notes', 'shared'))).toEqual([]);
        expect(
          await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
        ).toEqual([]);
      });

      it('keeps a withdrawn copy that a legal hold reached first', async () => {
        let sharedId: string | undefined;
        const promoting = fixture.restart({
          storage: {
            ...fixture.storage,
            put: async (record) => {
              await fixture.storage.put(record);
              sharedId = record.id;
              await fixture.memory.placeLegalHold(governancePrincipal, {
                id: record.id,
                collection: 'notes',
                visibility: 'shared',
              });
              await fixture.memory.revoke(principalA, notes(recordId), 'retracted');
            },
          },
        });
        expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
          status: 'rejected',
          reason: 'not-active',
        });
        const held = await fixture.storage.get(sharedId!, scopeOf('notes', 'shared'));
        expect(readRecordGovernance(held!)?.governance).toMatchObject({
          legalHold: 'held',
          state: 'revoked',
        });
      });

      it('retries withdrawing a copy that changed underneath it', async () => {
        let conflicts = 1;
        const promoting = fixture.restart({
          ledger: {
            ...fixture.ledger,
            putLineage: async (link) => {
              await fixture.memory.revoke(principalA, notes(recordId), 'retracted');
              return fixture.ledger.putLineage(link);
            },
          },
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              if (conflicts-- > 0) {
                throw new MemoryRecordVersionConflictError(references.map(({ id }) => id));
              }
              return fixture.storage.deleteMany!(references);
            },
          },
        });
        expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
          status: 'rejected',
        });
        expect(await fixture.storage.list(scopeOf('notes', 'shared'))).toEqual([]);
      });

      it('surfaces a withdrawal that keeps losing to other writers', async () => {
        const promoting = fixture.restart({
          ledger: {
            ...fixture.ledger,
            putLineage: async (link) => {
              await fixture.memory.revoke(principalA, notes(recordId), 'retracted');
              return fixture.ledger.putLineage(link);
            },
          },
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              throw new MemoryRecordVersionConflictError(references.map(({ id }) => id));
            },
          },
        });
        expect(await rejectionOf(promoting.promote(principalA, notes(recordId)))).toBeInstanceOf(
          MemoryRecordVersionConflictError,
        );
      });
    });

    it('stores one record for concurrent writes sharing an operation key', async () => {
      const [first, second] = await Promise.all(
        ['A replayed fact.', 'The same fact, replayed.'].map((content) =>
          fixture.memory.write(principalA, content, {
            collection: 'chat',
            source: 'conversation',
            dedupeKey: 'run-1:0',
          }),
        ),
      );
      expect(first).toMatchObject({ status: 'admitted' });
      expect(second).toMatchObject({ status: 'duplicate', recordId: first!.recordId });
      expect(await fixture.storage.list(scopeOf('chat'))).toHaveLength(1);
    });

    describe('an export racing the deletion of a record it read', () => {
      /** Governed memory whose export runs `beforeWrite` just before it stores its manifest. */
      function exportingAfter(beforeWrite: () => Promise<void>) {
        return fixture.restart({
          ledger: {
            ...fixture.ledger,
            putExport: async (manifest) => {
              await beforeWrite();
              return fixture.ledger.putExport(manifest);
            },
          },
        });
      }

      it('scrubs a record deleted after it was read and before the manifest was written', async () => {
        let receipt: MemoryDeletionReceipt | undefined;
        const exporting = exportingAfter(async () => {
          receipt = await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
        });
        const exported = await exporting.export(principalA, { collection: 'notes' });
        expect(exported).toMatchObject({ status: 'applied', recordIds: [], records: [] });
        expect(await fixture.ledger.getExport('tenant-a', exported.exportId!)).toMatchObject({
          recordIds: [],
          removedRecordIds: [recordId],
        });
        expect(receipt).toMatchObject({ open: false });
        expect(receipt!.targets.find((target) => target.target === 'exports')).toMatchObject({
          status: 'completed',
          detail: '0 export manifest(s) scrubbed',
        });
        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
      });

      it('scrubs a record a deletion claimed after it was read and before the manifest was written', async () => {
        let enteredTransaction!: () => void;
        const inTransaction = new Promise<void>((resolve) => {
          enteredTransaction = resolve;
        });
        // A deletion that dies inside its storage transaction, after it claimed the record.
        const dying = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: () => {
              enteredTransaction();
              return new Promise<number>(() => {});
            },
          },
        });
        const exporting = exportingAfter(async () => {
          void dying.delete(principalA, notes(recordId));
          await inTransaction;
        });
        const exported = await exporting.export(principalA, { collection: 'notes' });
        expect(exported).toMatchObject({ status: 'applied', recordIds: [], records: [] });
        const manifest = () => fixture.ledger.getExport('tenant-a', exported.exportId!);
        expect(await manifest()).toMatchObject({ recordIds: [], removedRecordIds: [recordId] });

        const [resumed] = await fixture.restart().processDeletionPropagation();
        expect(statuses(resumed)).toMatchObject({
          'source-evidence': 'completed',
          exports: 'completed',
        });
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeUndefined();
        expect(await manifest()).toMatchObject({ recordIds: [], removedRecordIds: [recordId] });
      });

      it('keeps the records no deletion reached', async () => {
        const kept = await recordIdOf(
          fixture.memory.write(principalA, 'Cards are stored in the vault.', {
            collection: 'notes',
            source: 'conversation',
          }),
        );
        const exporting = exportingAfter(async () => {
          await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
        });
        const exported = await exporting.export(principalA, { collection: 'notes' });
        expect(exported.recordIds).toEqual([kept]);
        expect(exported.records.map((record) => record.id)).toEqual([kept]);
        expect(await fixture.ledger.getExport('tenant-a', exported.exportId!)).toMatchObject({
          recordIds: [kept],
          removedRecordIds: [recordId],
        });
      });
    });

    describe('export revocation racing the deletion that scrubs its manifest', () => {
      let exportId: string;

      beforeEach(async () => {
        const exported = await fixture.memory.export(principalA, { collection: 'notes' });
        exportId = exported.exportId!;
      });

      async function manifest() {
        return fixture.ledger.getExport('tenant-a', exportId);
      }

      it('keeps a revocation that lands between the scrub reading the manifest and writing it', async () => {
        let revocation: MemoryForgetResult | undefined;
        const deleting = fixture.restart({
          ledger: createMemoryGovernanceLedger(
            beforeFirstExportWrite(fixture.durable, async () => {
              revocation = await fixture.memory.forget(principalA, {
                mode: 'export-revocation',
                exportId,
              });
            }),
          ),
        });
        const receipt = await receiptOf(deleting.delete(principalA, notes(recordId)));
        expect(revocation).toMatchObject({ status: 'applied' });
        expect(statuses(receipt)['exports']).toBe('completed');
        const stored = await manifest();
        expect(stored).toMatchObject({
          revoked: true,
          recordIds: [],
          removedRecordIds: [recordId],
        });
        expect(stored?.revokedBy?.principal).toEqual(principalA.principal);
        expect(stored?.revokedAt).toBeNumber();
      });

      it('keeps a scrub that lands between the revocation reading the manifest and writing it', async () => {
        let receipt: MemoryDeletionReceipt | undefined;
        const revoking = fixture.restart({
          ledger: createMemoryGovernanceLedger(
            beforeFirstExportWrite(fixture.durable, async () => {
              receipt = await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
            }),
          ),
        });
        const revoked = await revoking.forget(principalA, {
          mode: 'export-revocation',
          exportId,
        });
        expect(revoked.status).toBe('applied');
        expect(statuses(receipt)['exports']).toBe('completed');
        expect(await manifest()).toMatchObject({
          revoked: true,
          recordIds: [],
          removedRecordIds: [recordId],
        });
      });
    });
  });
}
