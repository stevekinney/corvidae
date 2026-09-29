import { beforeEach, describe, expect, it } from 'bun:test';

import type { MemoryDeletionReceipt } from '../../src/governance/ledger-types';
import {
  collectionNamespace,
  readRecordGovernance,
  type RecordGovernance,
} from '../../src/governance/record-governance';
import {
  type MemoryRecordReference,
  MemoryRecordVersionConflictError,
} from '../../src/memory-record-storage';
import {
  rejectionOf,
  throwingRejectionOf,
} from '../../src/testing/promise-outcome.test-support.ts';
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

function statuses(receipt: MemoryDeletionReceipt | undefined): Record<string, string> {
  return Object.fromEntries(
    (receipt?.targets ?? []).map((target) => [target.target, target.status]),
  );
}

function scopeOf(collection: string, visibility: 'private' | 'shared' = 'private') {
  return {
    tenantId: 'tenant-a',
    namespace: collectionNamespace(visibility, 'owner-a', collection),
  };
}

const processDied = async (): Promise<never> => {
  throw new Error('process died');
};

/**
 * Durability of governed memory's bookkeeping, legal holds that land while a
 * deletion is in flight, and envelope transitions that race each other. Each
 * case runs over both record backends.
 */
export function registerDurabilityContract(backend: GovernedBackend): void {
  describe(`governed memory durability and races (${backend})`, () => {
    let fixture: GovernedFixture;
    let recordId: string;
    const notes = (id: string) => ({ id, collection: 'notes' });
    const heldNotes = (id: string) => ({ ...notes(id), ownerId: 'owner-a' });

    async function envelope(id: string): Promise<RecordGovernance> {
      const record = await fixture.storage.get(id, scopeOf('notes'));
      return readRecordGovernance(record!)!.governance;
    }

    /** Consolidates the note and a companion into a summary in `digest`; returns the summary's id. */
    async function summarize(): Promise<string> {
      const companion = await recordIdOf(
        fixture.memory.write(principalA, 'Cards are stored in the vault.', {
          collection: 'notes',
          source: 'conversation',
        }),
      );
      const consolidated = await fixture.memory.forget(principalA, {
        mode: 'consolidation',
        locators: [notes(recordId), notes(companion)],
        content: 'The vault holds the card key.',
        collection: 'digest',
      });
      return consolidated.recordIds![0]!;
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

    describe('ledger bookkeeping is written before the record it describes', () => {
      it('publishes nothing when a promotion dies writing its lineage', async () => {
        const crashing = fixture.restart({
          ledger: { ...fixture.ledger, putLineage: processDied },
        });
        expect(await throwingRejectionOf(crashing.promote(principalA, notes(recordId)))).toThrow(
          'process died',
        );

        expect(await fixture.storage.list(scopeOf('notes', 'shared'))).toEqual([]);
        expect(
          await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
        ).toEqual([]);
        const receipt = await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
        expect(statuses(receipt)['source-evidence']).toBe('completed');
        expect(
          await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
        ).toEqual([]);
      });

      it('leaves no derived record a source deletion cannot reach when its lineage write dies', async () => {
        const crashing = fixture.restart({
          ledger: { ...fixture.ledger, putLineage: processDied },
        });
        expect(
          await throwingRejectionOf(
            crashing.write(principalA, 'Identity view: the card holder.', {
              collection: 'notes',
              source: 'derived',
              memoryClass: 'identity',
              derivedFrom: { kind: 'identity-view', sources: [notes(recordId)] },
            }),
          ),
        ).toThrow('process died');

        await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
        expect(await fixture.storage.list(scopeOf('notes'))).toEqual([]);
      });

      it('leaves no record a retention sweep cannot reach when its scope registration dies', async () => {
        const crashing = fixture.restart({
          ledger: { ...fixture.ledger, registerScope: processDied },
        });
        expect(
          await throwingRejectionOf(
            crashing.write(principalA, 'The first journal entry.', {
              collection: 'journal',
              source: 'conversation',
            }),
          ),
        ).toThrow('process died');

        await fixture.runtime.advance(91 * DAY);
        const sweep = await fixture.memory.sweepRetention(retentionService);
        expect(sweep.expired.map((candidate) => candidate.id)).toEqual([recordId]);
        expect(await fixture.storage.list(scopeOf('journal'))).toEqual([]);
      });

      it('treats bookkeeping for a record that was never stored as harmless', async () => {
        const failing = fixture.restart({
          storage: {
            ...fixture.storage,
            put: async () => {
              throw new Error('disk full');
            },
          },
        });
        expect(await throwingRejectionOf(failing.promote(principalA, notes(recordId)))).toThrow(
          'disk full',
        );

        const receipt = await receiptOf(fixture.memory.delete(principalA, notes(recordId)));
        expect(receipt.plan.projections).toHaveLength(1);
        expect(
          receipt.targets.find((target) => target.target === 'canonical-projections'),
        ).toMatchObject({
          status: 'completed',
          detail: '0 canonical projection(s) removed',
        });
        expect(receipt.open).toBe(false);
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeUndefined();
      });
    });

    describe('a revocation or quarantine that failed partway', () => {
      for (const [operation, state] of [
        ['revoke', 'revoked'],
        ['quarantine', 'quarantined'],
      ] as const) {
        it(`finishes a ${operation} of a promoted source when it is run again`, async () => {
          const promoted = await fixture.memory.promote(principalA, notes(recordId));
          const sharedId = promoted.sharedId!;
          let transient = true;
          const flaky = fixture.restart({
            storage: {
              ...fixture.storage,
              update: async (...update: Parameters<typeof fixture.storage.update>) => {
                if (transient && update[0] === sharedId) {
                  transient = false;
                  throw new Error('storage unavailable');
                }
                return fixture.storage.update(...update);
              },
            },
          });
          expect(
            await throwingRejectionOf(flaky[operation](principalA, notes(recordId), 'retracted')),
          ).toThrow('storage unavailable');
          const shared = async () => {
            const record = await fixture.storage.get(sharedId, scopeOf('notes', 'shared'));
            return readRecordGovernance(record!)!.governance.state;
          };
          expect(await envelope(recordId)).toMatchObject({ state });
          expect(await shared()).toBe('active');

          expect(await flaky[operation](principalA, notes(recordId), 'retracted')).toMatchObject({
            status: 'applied',
            recordIds: [recordId, sharedId],
          });
          expect(await shared()).toBe(state);
          expect(
            await fixture.memory.search(principalB, 'vault key', { collection: 'notes' }),
          ).toEqual([]);
          expect(await flaky[operation](principalA, notes(recordId), 'retracted')).toMatchObject({
            status: 'unchanged',
          });
        });
      }
    });

    describe('a legal hold placed while a deletion is in flight', () => {
      it('stops a resumed deletion when the hold landed after the process died', async () => {
        const crashing = fixture.restart({
          storage: { ...fixture.storage, deleteMany: () => new Promise<number>(() => {}) },
        });
        void crashing.delete(principalA, notes(recordId));
        // Let the crashing process persist its receipt before it "dies" inside the storage transaction.
        for (let tick = 0; tick < 50; tick++) await Promise.resolve();
        const [interrupted] = await fixture.ledger.listReceipts({ open: true });
        expect(statuses(interrupted)['source-evidence']).toBe('pending');

        expect(
          await fixture.memory.placeLegalHold(governancePrincipal, heldNotes(recordId)),
        ).toMatchObject({ status: 'applied' });
        const [resumed] = await fixture.restart().processDeletionPropagation();
        expect(resumed?.deletionId).toBe(interrupted!.deletionId);
        expect(Object.values(statuses(resumed)).every((status) => status === 'exempt')).toBe(true);
        expect(resumed).toMatchObject({ awaitingHoldRelease: true, open: false });
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeDefined();
        expect(await fixture.restart().processDeletionPropagation()).toEqual([]);

        const released = await fixture.memory.releaseLegalHold(
          governancePrincipal,
          heldNotes(recordId),
        );
        expect(released.requeued).toHaveLength(1);
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeUndefined();
      });

      it('keeps a summary held while its deletion target was still pending, and finishes it on release', async () => {
        const summary = await summarize();
        const summaryLocator = { id: summary, collection: 'digest', ownerId: 'owner-a' };
        let transient = true;
        const flaky = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              if (transient && references.some((reference) => reference.id === summary)) {
                transient = false;
                throw new Error('summary store unavailable');
              }
              return fixture.storage.deleteMany!(references);
            },
          },
        });
        const first = await receiptOf(flaky.delete(principalA, notes(recordId)));
        expect(statuses(first)).toMatchObject({
          'source-evidence': 'completed',
          summaries: 'pending',
        });

        expect(
          await fixture.memory.placeLegalHold(governancePrincipal, summaryLocator),
        ).toMatchObject({ status: 'applied' });
        const [held] = await fixture.memory.processDeletionPropagation();
        expect(held?.deletionId).toBe(first.deletionId);
        expect(statuses(held)).toMatchObject({
          'source-evidence': 'completed',
          summaries: 'exempt',
        });
        expect(held).toMatchObject({ awaitingHoldRelease: true, open: false });
        expect(await fixture.storage.get(summary, scopeOf('digest'))).toBeDefined();
        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);

        const released = await fixture.memory.releaseLegalHold(governancePrincipal, summaryLocator);
        expect(released.requeued).toHaveLength(1);
        const resumed = await fixture.ledger.getReceipt(released.requeued![0]!);
        expect(resumed).toMatchObject({ trigger: 'hold-release', open: false });
        expect(statuses(resumed)).toMatchObject({
          'source-evidence': 'completed',
          summaries: 'completed',
        });
        expect(await fixture.storage.get(summary, scopeOf('digest'))).toBeUndefined();
        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
      });

      it('holds a summary whose hold landed inside the step deleting it', async () => {
        const summary = await summarize();
        const summaryLocator = { id: summary, collection: 'digest', ownerId: 'owner-a' };
        let raced = false;
        const racing = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              if (!raced && references.some((reference) => reference.id === summary)) {
                raced = true;
                await fixture.memory.placeLegalHold(governancePrincipal, summaryLocator);
              }
              return fixture.storage.deleteMany!(references);
            },
          },
        });
        const receipt = await receiptOf(racing.delete(principalA, notes(recordId)));
        expect(raced).toBe(true);
        // The hold changed the summary's version, so its conditioned deletion
        // aborted; the next step's hold check then exempted what was left. The
        // summary is still stored, so no row downstream of it claims removal.
        expect(statuses(receipt)).toMatchObject({
          'source-evidence': 'completed',
          indexes: 'exempt',
          summaries: 'exempt',
          exports: 'exempt',
        });
        expect(
          receipt.targets.filter(
            (target) => target.lane === 'bounded-async' && target.status === 'completed',
          ),
        ).toEqual([]);
        expect(receipt).toMatchObject({ awaitingHoldRelease: true, open: false });
        expect(await fixture.storage.get(summary, scopeOf('digest'))).toBeDefined();
        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
      });

      it('fails the synchronous lane while its records keep changing, then finishes it on the next pass', async () => {
        const contended = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              throw new MemoryRecordVersionConflictError(references.map(({ id }) => id));
            },
          },
        });
        const result = await contended.delete(principalA, notes(recordId));
        expect(result).toMatchObject({ status: 'unchanged', deletion: 'failed' });
        const receipt = result.receipt!;
        expect(receipt.targets.find((target) => target.target === 'source-evidence')).toMatchObject(
          {
            status: 'failed',
            detail: 'records changed during deletion',
          },
        );
        // Nothing downstream of the record claims removal while it is still stored.
        expect(receipt.targets.filter((target) => target.status === 'completed')).toEqual([]);
        expect(receipt.open).toBe(true);
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeDefined();

        const [settled] = await fixture.memory.processDeletionPropagation();
        expect(settled?.deletionId).toBe(receipt.deletionId);
        expect(statuses(settled)['source-evidence']).toBe('completed');
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeUndefined();
      });

      it('holds a deletion whose storage transaction raced a hold on its record', async () => {
        let raced = false;
        const racing = fixture.restart({
          storage: {
            ...fixture.storage,
            deleteMany: async (references: readonly MemoryRecordReference[]) => {
              if (!raced) {
                raced = true;
                await fixture.memory.placeLegalHold(governancePrincipal, heldNotes(recordId));
              }
              return fixture.storage.deleteMany!(references);
            },
          },
        });
        const receipt = await receiptOf(racing.delete(principalA, notes(recordId)));
        expect(raced).toBe(true);
        expect(Object.values(statuses(receipt)).every((status) => status === 'exempt')).toBe(true);
        expect(receipt.awaitingHoldRelease).toBe(true);
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeDefined();
        expect(await envelope(recordId)).toMatchObject({ legalHold: 'held' });
      });
    });

    describe('envelope transitions merge onto the current envelope', () => {
      const successor = {
        content: 'The vault key was rotated.',
        collection: 'notes',
        source: 'conversation' as const,
      };

      it('never resurrects a record revoked while it was being superseded', async () => {
        const [superseded, revoked] = await Promise.all([
          fixture.memory.forget(principalA, {
            mode: 'supersession',
            locator: notes(recordId),
            successor,
          }),
          fixture.memory.revoke(principalA, notes(recordId), 'retracted'),
        ]);
        expect(superseded.status).toBe('applied');
        expect(revoked.status).toBe('applied');
        expect(await envelope(recordId)).toMatchObject({
          state: 'revoked',
          supersededBy: superseded.write!.recordId!,
        });
      });

      it('keeps a legal hold placed while the record was being superseded', async () => {
        const [superseded, hold] = await Promise.all([
          fixture.memory.forget(principalA, {
            mode: 'supersession',
            locator: notes(recordId),
            successor,
          }),
          fixture.memory.placeLegalHold(governancePrincipal, heldNotes(recordId)),
        ]);
        expect(superseded.status).toBe('applied');
        expect(hold.status).toBe('applied');
        expect(await envelope(recordId)).toMatchObject({
          legalHold: 'held',
          supersededBy: superseded.write!.recordId!,
        });
      });

      it('keeps a legal hold placed while the record was being demoted', async () => {
        const [demoted, hold] = await Promise.all([
          fixture.memory.forget(principalA, {
            mode: 'retrieval-demotion',
            locator: notes(recordId),
            weight: 0.1,
          }),
          fixture.memory.placeLegalHold(governancePrincipal, heldNotes(recordId)),
        ]);
        expect(demoted.status).toBe('applied');
        expect(hold.status).toBe('applied');
        expect(await envelope(recordId)).toMatchObject({ legalHold: 'held', retrievalWeight: 0.1 });
      });

      it('never downgrades a revocation that raced a quarantine, and reports the quarantine unchanged', async () => {
        // The quarantine read the record as active; the revocation lands before its write.
        let revoked: Awaited<ReturnType<typeof fixture.memory.revoke>> | undefined;
        const quarantining = fixture.restart({
          storage: {
            ...fixture.storage,
            update: async (...update: Parameters<typeof fixture.storage.update>) => {
              revoked ??= await fixture.memory.revoke(principalA, notes(recordId), 'retracted');
              return fixture.storage.update(...update);
            },
          },
        });
        expect(
          await quarantining.quarantine(principalA, notes(recordId), 'reported'),
        ).toMatchObject({ status: 'unchanged' });
        expect(revoked).toMatchObject({ status: 'applied' });
        expect(await envelope(recordId)).toMatchObject({ state: 'revoked' });
        const quarantines = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.quarantined',
        });
        expect(quarantines).toEqual([]);
      });

      it('surfaces a transition that keeps losing to other writers instead of overwriting them', async () => {
        const contended = fixture.restart({
          storage: {
            ...fixture.storage,
            update: async (id: string) => {
              throw new MemoryRecordVersionConflictError([id]);
            },
          },
        });
        expect(
          await rejectionOf(
            contended.forget(principalA, {
              mode: 'retrieval-demotion',
              locator: notes(recordId),
              weight: 0.1,
            }),
          ),
        ).toBeInstanceOf(MemoryRecordVersionConflictError);
        expect(await envelope(recordId)).toMatchObject({ retrievalWeight: 1 });
      });

      it('reports a legal hold on a record deleted while the hold was being placed as not found', async () => {
        const deleting = fixture.restart({
          storage: {
            ...fixture.storage,
            update: async (...update: Parameters<typeof fixture.storage.update>) => {
              await fixture.memory.delete(principalA, notes(recordId));
              return fixture.storage.update(...update);
            },
          },
        });
        expect(
          await deleting.placeLegalHold(governancePrincipal, heldNotes(recordId)),
        ).toMatchObject({ status: 'not-found' });
        expect(await fixture.storage.get(recordId, scopeOf('notes'))).toBeUndefined();
      });

      it('keeps every grantee of concurrent shares', async () => {
        const results = await Promise.all(
          ['owner-b', 'owner-c'].map((grantee) =>
            fixture.memory.share(principalA, notes(recordId), grantee),
          ),
        );
        expect(results.map((result) => result.status)).toEqual(['applied', 'applied']);
        const { sharedWith } = await envelope(recordId);
        expect(sharedWith.toSorted()).toEqual(['owner-b', 'owner-c']);
      });
    });
  });
}
