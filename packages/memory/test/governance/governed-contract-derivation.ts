import { beforeEach, describe, expect, it } from 'bun:test';

import type { MemoryAuthority } from '../../src/governance/authority';
import type {
  CreateGovernedMemoryOptions,
  MemoryRecordLocator,
} from '../../src/governance/governed-memory-types';
import {
  collectionNamespace,
  readRecordGovernance,
  type RecordGovernance,
} from '../../src/governance/record-governance';
import {
  type MemoryRecord,
  type MemoryRecordReference,
  MemoryRecordVersionConflictError,
} from '../../src/memory-record-storage';
import { throwingRejectionOf } from '../../src/testing/promise-outcome.test-support.ts';
import {
  createGovernedFixture,
  DAY,
  governancePrincipal,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  principalB,
  receiptOf,
  recordIdOf,
  retentionService,
} from './governed-memory-harness';

const SECRET = 'vault-secret-7f3a9c';

const processDied = async (): Promise<never> => {
  throw new Error('process died');
};

function scopeOf(collection: string, visibility: 'private' | 'shared' = 'private') {
  return {
    tenantId: 'tenant-a',
    namespace: collectionNamespace(visibility, 'owner-a', collection),
  };
}

const SHARED = scopeOf('notes', 'shared');
const PRIVATE = scopeOf('notes');

/** What a principal can reach of the notes collection, through every governed read. */
interface Reach {
  readonly got: readonly string[];
  readonly listed: readonly string[];
  readonly searched: readonly string[];
  readonly recalled: readonly string[];
  readonly exported: readonly string[];
  readonly manifest: readonly string[] | undefined;
}

const NOTHING: Reach = {
  got: [],
  listed: [],
  searched: [],
  recalled: [],
  exported: [],
  manifest: [],
};

/**
 * A derived record (a promoted copy, an identity view, a summary) is stored
 * hidden and becomes visible only once its sources are confirmed. A
 * derivation that fails or dies anywhere in between leaves a hidden record and
 * a durable ledger entry, which the next propagation pass resolves: it removes
 * a record whose source is gone, claimed, or no longer active, and activates
 * one whose sources still back it. Each case runs over both record backends.
 */
export function registerDerivationContract(backend: GovernedBackend): void {
  describe(`governed memory derivations fail closed (${backend})`, () => {
    let fixture: GovernedFixture;
    let recordId: string;
    const notes = (id: string): MemoryRecordLocator => ({ id, collection: 'notes' });
    const sharedNotes = (id: string): MemoryRecordLocator => ({
      id,
      collection: 'notes',
      visibility: 'shared',
    });

    async function storedIds(scope: ReturnType<typeof scopeOf>): Promise<string[]> {
      const records = await fixture.storage.list(scope);
      return records.map((record) => record.id);
    }

    async function envelope(
      id: string,
      scope: ReturnType<typeof scopeOf>,
    ): Promise<RecordGovernance> {
      const record = await fixture.storage.get(id, scope);
      return readRecordGovernance(record!)!.governance;
    }

    async function reachOf(
      principal: MemoryAuthority,
      locators: readonly MemoryRecordLocator[],
    ): Promise<Reach> {
      const ids = (records: readonly { readonly id: string }[]) =>
        records.map((record) => record.id);
      const got: string[] = [];
      for (const locator of locators) {
        const record = await fixture.memory.get(principal, locator);
        if (record !== undefined) got.push(record.id);
      }
      const exported = await fixture.memory.export(principal, { collection: 'notes' });
      const manifest = await fixture.ledger.getExport('tenant-a', exported.exportId!);
      const hits = await fixture.memory.search(principal, 'vault key holder', {
        collection: 'notes',
      });
      const recalled = await fixture.memory.recallForModel(principal, 'vault key holder', {
        collection: 'notes',
      });
      return {
        got,
        listed: ids(await fixture.memory.list(principal, { collection: 'notes' })),
        searched: hits.map((hit) => hit.record.id),
        recalled: ids(recalled.evidence),
        exported: ids(exported.records),
        manifest: manifest?.recordIds,
      };
    }

    function deleteSource() {
      return receiptOf(fixture.memory.delete(principalA, notes(recordId)));
    }

    /**
     * Governed memory whose derivation runs `race` once, just before it links
     * its record to its source, so the race finishes before the link exists.
     */
    function derivingAfter(
      race: () => Promise<unknown>,
      overrides: Partial<CreateGovernedMemoryOptions> = {},
    ) {
      let raced = false;
      return fixture.restart({
        ...overrides,
        ledger: {
          ...fixture.ledger,
          ...overrides.ledger,
          putLineage: async (link) => {
            if (!raced) {
              raced = true;
              await race();
            }
            return fixture.ledger.putLineage(link);
          },
        },
      });
    }

    /** Record storage whose first `deleteMany` fails, as a withdrawal meeting a storage outage would. */
    function withdrawalFailsOnce(): CreateGovernedMemoryOptions['storage'] {
      let failures = 1;
      return {
        ...fixture.storage,
        deleteMany: async (references: readonly MemoryRecordReference[]) => {
          if (failures-- > 0) throw new Error('storage unavailable');
          return fixture.storage.deleteMany!(references);
        },
      };
    }

    function deriveIdentityView(memory: GovernedFixture['memory']) {
      return memory.write(principalA, `Identity view: holder of ${SECRET}.`, {
        collection: 'notes',
        source: 'derived',
        memoryClass: 'identity',
        derivedFrom: { kind: 'identity-view', sources: [notes(recordId)] },
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

    describe('a withdrawal that fails leaves a hidden record the next pass removes', () => {
      it('never publishes a copy of a source deleted while it was promoted', async () => {
        const promoting = derivingAfter(deleteSource, { storage: withdrawalFailsOnce() });
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'storage unavailable',
        );
        const [copyId] = await storedIds(SHARED);
        expect(copyId).toBeDefined();
        expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);
        expect(await fixture.ledger.listPendingDerivations({})).toHaveLength(1);

        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
        expect(await storedIds(SHARED)).toEqual([]);
        expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
        const [withdrawn] = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.derivation.withdrawn',
        });
        expect(withdrawn).toMatchObject({
          outcome: 'withdrawn',
          reason: 'not-found',
          recordIds: [copyId, recordId],
        });
        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
      });

      it('never keeps an identity view of a source deleted while the view was written', async () => {
        const writing = derivingAfter(deleteSource, { storage: withdrawalFailsOnce() });
        expect(await throwingRejectionOf(deriveIdentityView(writing))).toThrow(
          'storage unavailable',
        );
        const [viewId] = await storedIds(PRIVATE);
        expect(viewId).toBeDefined();
        expect(await reachOf(principalA, [notes(viewId!)])).toEqual(NOTHING);

        await fixture.memory.processDeletionPropagation();
        expect(await storedIds(PRIVATE)).toEqual([]);
      });

      it('never keeps a copy active once its source was revoked while it was promoted', async () => {
        let revoked: Awaited<ReturnType<typeof fixture.memory.revoke>> | undefined;
        const promoting = derivingAfter(
          async () => {
            revoked = await fixture.memory.revoke(principalA, notes(recordId), 'retracted');
          },
          { storage: withdrawalFailsOnce() },
        );
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'storage unavailable',
        );
        expect(revoked).toMatchObject({ status: 'applied', recordIds: [recordId] });
        const [copyId] = await storedIds(SHARED);
        expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);
        expect(await fixture.memory.promote(principalA, notes(recordId))).toMatchObject({
          status: 'rejected',
          reason: 'not-active',
        });

        await fixture.memory.processDeletionPropagation();
        expect(await storedIds(SHARED)).toEqual([]);
        const [withdrawn] = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.derivation.withdrawn',
        });
        expect(withdrawn).toMatchObject({ reason: 'not-active' });
      });

      it('keeps the bookkeeping of a copy a propagation pass ran before it was stored', async () => {
        const promoting = derivingAfter(
          async () => {
            await deleteSource();
            expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
          },
          { storage: withdrawalFailsOnce() },
        );
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'storage unavailable',
        );
        expect(await fixture.ledger.listPendingDerivations({})).toHaveLength(1);

        await fixture.memory.processDeletionPropagation();
        expect(await storedIds(SHARED)).toEqual([]);
      });

      it('never lets a copy it cannot withdraw yet hold up the deletions a pass propagates', async () => {
        const promoting = derivingAfter(deleteSource, { storage: withdrawalFailsOnce() });
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'storage unavailable',
        );
        const [copyId] = await storedIds(SHARED);
        const other = await recordIdOf(
          fixture.memory.write(principalA, 'Cards are stored in the vault.', {
            collection: 'notes',
            source: 'conversation',
          }),
        );
        const contended = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              throw new MemoryRecordVersionConflictError(references.map(({ id }) => id));
            },
          },
        });
        const open = await receiptOf(contended.delete(principalA, notes(other)));
        expect(open.open).toBe(true);

        const propagating = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              if (references.some((reference) => reference.id === copyId)) {
                throw new Error('storage unavailable');
              }
              return fixture.storage.deleteMany!(references);
            },
          },
        });
        const [settled] = await propagating.processDeletionPropagation();
        expect(settled).toMatchObject({ deletionId: open.deletionId, open: false });
        expect(await fixture.storage.get(other, PRIVATE)).toBeUndefined();
        expect(await storedIds(SHARED)).toEqual([copyId!]);
        expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);
        const [deferred] = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.derivation.deferred',
        });
        expect(deferred).toMatchObject({ outcome: 'pending', recordIds: [copyId] });

        await fixture.memory.processDeletionPropagation();
        expect(await storedIds(SHARED)).toEqual([]);
        expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
      });
    });

    describe('a derivation that dies after storing its record', () => {
      function dyingAfterPut(overrides: Partial<CreateGovernedMemoryOptions> = {}) {
        return {
          ...overrides,
          storage: {
            ...fixture.storage,
            put: async (record: MemoryRecord) => {
              await fixture.storage.put(record);
              await processDied();
            },
          },
        };
      }

      it('leaves a hidden copy that a restarted instance removes when its source is gone', async () => {
        const promoting = derivingAfter(deleteSource, dyingAfterPut());
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'process died',
        );
        const [copyId] = await storedIds(SHARED);
        expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);

        expect(await fixture.restart().processDeletionPropagation()).toEqual([]);
        expect(await storedIds(SHARED)).toEqual([]);
        expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);
      });

      it('leaves a hidden copy that a restarted instance activates when its source still backs it', async () => {
        const promoting = fixture.restart(dyingAfterPut());
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'process died',
        );
        const [copyId] = await storedIds(SHARED);
        expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);

        expect(await fixture.restart().processDeletionPropagation()).toEqual([]);
        expect(await envelope(copyId!, SHARED)).not.toHaveProperty('pendingDerivation');
        const reach = await reachOf(principalB, [sharedNotes(copyId!)]);
        expect(reach).toMatchObject({ got: [copyId], searched: [copyId], exported: [copyId] });
        const [activated] = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.derivation.activated',
        });
        expect(activated).toMatchObject({ outcome: 'applied', recordIds: [copyId, recordId] });
        expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);

        const receipt = await deleteSource();
        expect(receipt.plan.projections.map((reference) => reference.id)).toEqual([copyId!]);
        expect(await storedIds(SHARED)).toEqual([]);
      });

      it('clears the bookkeeping of a copy activated before the process died', async () => {
        const promoting = fixture.restart({
          ledger: { ...fixture.ledger, deletePendingDerivation: processDied },
        });
        expect(await throwingRejectionOf(promoting.promote(principalA, notes(recordId)))).toThrow(
          'process died',
        );
        const [copyId] = await storedIds(SHARED);
        expect(await fixture.memory.get(principalB, sharedNotes(copyId!))).toMatchObject({
          id: copyId,
        });

        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
        expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
        expect(await storedIds(SHARED)).toEqual([copyId!]);
        expect(
          await fixture.ledger.listEvents({
            tenantId: 'tenant-a',
            type: 'memory.derivation.activated',
          }),
        ).toEqual([]);
      });

      it('keeps the bookkeeping of a derivation that never stored its record until audit retention prunes it', async () => {
        const crashing = fixture.restart({
          ledger: { ...fixture.ledger, putLineage: processDied },
        });
        expect(await throwingRejectionOf(deriveIdentityView(crashing))).toThrow('process died');
        // Nothing tells a record that was never stored from one about to be.
        await fixture.memory.processDeletionPropagation();
        expect(await fixture.ledger.listPendingDerivations({})).toHaveLength(1);

        await fixture.runtime.advance(364 * DAY);
        await fixture.memory.sweepRetention(retentionService);
        expect(await fixture.ledger.listPendingDerivations({ tenantId: 'tenant-a' })).toHaveLength(
          1,
        );
        await fixture.runtime.advance(2 * DAY);
        await fixture.memory.sweepRetention(retentionService);
        expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
      });
    });

    it('shows a copy to no reader while it waits on its source check', async () => {
      let reach: Reach | undefined;
      let copyId: string | undefined;
      const promoting = derivingAfter(deleteSource, {
        storage: {
          ...fixture.storage,
          put: async (record: MemoryRecord) => {
            await fixture.storage.put(record);
            copyId = record.id;
            reach = await reachOf(principalB, [sharedNotes(record.id)]);
          },
        },
      });
      expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
        status: 'not-found',
      });
      expect(copyId).toBeDefined();
      expect(reach).toEqual(NOTHING);
      expect(await storedIds(SHARED)).toEqual([]);
      const manifests = await fixture.ledger.listExports({ tenantId: 'tenant-a' });
      expect(manifests.map((manifest) => manifest.recordIds)).toEqual([[]]);
    });

    it('reports a copy that a deletion reached through its lineage before it settled as withdrawn', async () => {
      let receipt: Awaited<ReturnType<typeof deleteSource>> | undefined;
      let copyId: string | undefined;
      const promoting = fixture.restart({
        storage: {
          ...fixture.storage,
          put: async (record: MemoryRecord) => {
            await fixture.storage.put(record);
            copyId = record.id;
            receipt = await deleteSource();
          },
        },
      });
      expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
        status: 'not-found',
      });
      expect(receipt?.plan.projections.map((reference) => reference.id)).toEqual([copyId!]);
      expect(await storedIds(SHARED)).toEqual([]);
      expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
    });

    it('withdraws a copy a deletion claimed between its source check and its activation', async () => {
      let enteredTransaction!: () => void;
      const inTransaction = new Promise<void>((resolve) => {
        enteredTransaction = resolve;
      });
      // A deletion that dies inside its storage transaction, after it claimed the copy.
      const dying = fixture.restart({
        storage: {
          ...fixture.storage,
          deleteMany: () => {
            enteredTransaction();
            return new Promise<number>(() => {});
          },
        },
      });
      let raced = false;
      const promoting = fixture.restart({
        storage: {
          ...fixture.storage,
          update: async (...update: Parameters<typeof fixture.storage.update>) => {
            if (!raced) {
              raced = true;
              void dying.delete(principalA, notes(recordId));
              await inTransaction;
            }
            return fixture.storage.update(...update);
          },
        },
      });
      expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
        status: 'rejected',
        reason: 'deletion-pending',
      });
      expect(raced).toBe(true);
      expect(await storedIds(SHARED)).toEqual([]);
      expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);

      const [resumed] = await fixture.restart().processDeletionPropagation();
      expect(resumed?.targets.find((target) => target.target === 'source-evidence')).toMatchObject({
        status: 'completed',
      });
      expect(await fixture.storage.get(recordId, PRIVATE)).toBeUndefined();
    });

    it('keeps a withdrawn copy hidden under a legal hold and removes it once the hold is released', async () => {
      let copyId: string | undefined;
      const promoting = derivingAfter(deleteSource, {
        storage: {
          ...fixture.storage,
          put: async (record: MemoryRecord) => {
            await fixture.storage.put(record);
            copyId = record.id;
            await fixture.memory.placeLegalHold(governancePrincipal, sharedNotes(record.id));
          },
        },
      });
      expect(await promoting.promote(principalA, notes(recordId))).toMatchObject({
        status: 'not-found',
      });
      expect(await envelope(copyId!, SHARED)).toMatchObject({
        legalHold: 'held',
        pendingDerivation: true,
      });
      expect(await reachOf(principalB, [sharedNotes(copyId!)])).toEqual(NOTHING);
      expect(await fixture.memory.get(governancePrincipal, sharedNotes(copyId!))).toBeUndefined();

      expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
      expect(await storedIds(SHARED)).toEqual([copyId!]);
      expect(
        await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.derivation.withdrawn',
        }),
      ).toEqual([]);

      expect(
        await fixture.memory.releaseLegalHold(governancePrincipal, sharedNotes(copyId!)),
      ).toMatchObject({ status: 'applied' });
      await fixture.memory.processDeletionPropagation();
      expect(await storedIds(SHARED)).toEqual([]);
      expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
    });

    it('leaves no bookkeeping behind for a derived write that turned out to be a duplicate', async () => {
      const results = await Promise.all(
        ['Identity view: the card holder.', 'Identity view: the holder.'].map((content) =>
          fixture.memory.write(principalA, content, {
            collection: 'notes',
            source: 'derived',
            memoryClass: 'identity',
            dedupeKey: 'view-1',
            derivedFrom: { kind: 'identity-view', sources: [notes(recordId)] },
          }),
        ),
      );
      expect(results.map((result) => result.status).toSorted()).toEqual(['admitted', 'duplicate']);
      expect(await fixture.ledger.listPendingDerivations({})).toEqual([]);
      expect(await storedIds(PRIVATE)).toHaveLength(2);
    });
  });
}
