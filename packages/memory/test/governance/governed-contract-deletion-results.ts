import type { ToolRequestContext } from 'armorer';
import { beforeEach, describe, expect, it } from 'bun:test';

import type {
  GovernedMemory,
  MemoryRecordLocator,
} from '../../src/governance/governed-memory-types';
import { createGovernedMemoryTools } from '../../src/governance/governed-tools';
import type { MemoryDeletionReceipt } from '../../src/governance/ledger-types';
import {
  collectionNamespace,
  type DerivedRecordKind,
} from '../../src/governance/record-governance';
import {
  type MemoryRecordReference,
  MemoryRecordVersionConflictError,
} from '../../src/memory-record-storage';
import {
  createGovernedFixture,
  DAY,
  governancePrincipal,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  recordIdOf,
  retentionService,
} from './governed-memory-harness';

const SECRET = 'lockbox-code-4412';

function statuses(receipt: MemoryDeletionReceipt | undefined): Record<string, string> {
  return Object.fromEntries(
    (receipt?.targets ?? []).map((target) => [target.target, target.status]),
  );
}

/** The rows a receipt reports `completed`: none may name a target that still holds content. */
function completedRows(receipt: MemoryDeletionReceipt | undefined): string[] {
  return (receipt?.targets ?? [])
    .filter((target) => target.status === 'completed')
    .map((target) => target.target);
}

/** A persisted request authority for owner A's model-facing tools, with `memory:delete`. */
const deleterContext: ToolRequestContext = {
  authority: {
    principalId: 'owner-a:principal',
    tenantId: 'tenant-a',
    ownerId: 'owner-a',
    capabilities: ['tools:execute', 'memory:delete'],
    authorizationRevision: 'authorization:1',
  },
};

/**
 * COR-1371: a deletion reports what it did to the record it names. `applied`
 * with `deletion: 'completed'` means the record is gone; a held deletion and a
 * failed synchronous step both leave it stored and say so, and a retry of a
 * failed step closes the receipt the failure opened.
 */
export function registerDeletionResultContract(backend: GovernedBackend): void {
  describe(`governed deletion results (${backend})`, () => {
    let fixture: GovernedFixture;
    let recordId: string;
    const locator = (id = recordId): MemoryRecordLocator => ({ id, collection: 'notes' });
    const heldLocator = (id = recordId) => ({ ...locator(id), ownerId: 'owner-a' });
    const scope = {
      tenantId: 'tenant-a',
      namespace: collectionNamespace('private', 'owner-a', 'notes'),
    };

    /** The same durable state behind storage whose synchronous deletion transaction fails. */
    const failing = (): GovernedMemory =>
      fixture.restart({
        storage: {
          ...fixture.storage,
          deleteMany: async () => {
            throw new Error(`disk full while deleting ${SECRET}`);
          },
        },
      });

    const recalled = async (): Promise<string[]> => {
      const bundle = await fixture.memory.recallForModel(principalA, 'lockbox code', {
        collection: 'notes',
      });
      return bundle.evidence.map((evidence) => evidence.id);
    };

    const derive = (content: string, kind: DerivedRecordKind = 'canonical-projection') =>
      recordIdOf(
        fixture.memory.write(principalA, content, {
          collection: 'notes',
          source: 'derived',
          derivedFrom: { kind, sources: [locator()] },
        }),
      );

    /** The same durable state behind storage that cannot delete `id`, throwing `failure(id)` instead. */
    const failingFor = (id: string, failure: (id: string) => Error): GovernedMemory =>
      fixture.restart({
        storage: {
          ...fixture.storage,
          deleteMany: async (references: readonly MemoryRecordReference[]) => {
            if (references.some((reference) => reference.id === id)) throw failure(id);
            return fixture.storage.deleteMany!(references);
          },
        },
      });

    beforeEach(async () => {
      fixture = await createGovernedFixture(backend);
      recordId = await recordIdOf(
        fixture.memory.write(principalA, `Lockbox code: ${SECRET}`, {
          collection: 'notes',
          source: 'conversation',
        }),
      );
    });

    it('reports a completed deletion as applied while bounded-async targets are still pending', async () => {
      fixture = await createGovernedFixture(backend, {
        governed: {
          propagation: {
            caches: 'not-retained',
            'managed-asset-bytes': 'not-retained',
            'durable-snapshots': 'not-retained',
          },
        },
      });
      recordId = await recordIdOf(
        fixture.memory.write(principalA, `Lockbox code: ${SECRET}`, {
          collection: 'notes',
          source: 'conversation',
        }),
      );
      const result = await fixture.memory.delete(principalA, locator());
      expect(result).toMatchObject({
        status: 'applied',
        deletion: 'completed',
        recordIds: [recordId],
      });
      expect(statuses(result.receipt)).toMatchObject({
        'source-evidence': 'completed',
        'external-processors': 'pending',
      });
      expect(result.receipt?.open).toBe(true);
      expect(await fixture.memory.get(principalA, locator())).toBeUndefined();
      expect(await recalled()).toEqual([]);

      const tools = createGovernedMemoryTools(fixture.memory, { collection: 'notes' });
      const other = await recordIdOf(
        fixture.memory.write(principalA, 'Another lockbox note.', {
          collection: 'notes',
          source: 'conversation',
        }),
      );
      expect(await tools.forget.execute({ id: other }, { requestContext: deleterContext })).toEqual(
        { deleted: true },
      );
      expect(await fixture.memory.get(principalA, locator(other))).toBeUndefined();
    });

    it('reports a held deletion as exempt from delete() and every deletion mode, leaving the content in place', async () => {
      expect(await fixture.memory.placeLegalHold(governancePrincipal, heldLocator())).toMatchObject(
        { status: 'applied' },
      );

      const deleted = await fixture.memory.delete(principalA, locator());
      expect(deleted).toMatchObject({ status: 'unchanged', deletion: 'exempt' });
      expect(Object.values(statuses(deleted.receipt)).every((status) => status === 'exempt')).toBe(
        true,
      );
      const forgotten = await fixture.memory.forget(principalA, {
        mode: 'source-deletion',
        locator: locator(),
      });
      expect(forgotten).toMatchObject({
        mode: 'source-deletion',
        status: 'unchanged',
        deletion: 'exempt',
      });
      await fixture.runtime.advance(91 * DAY);
      const expired = await fixture.memory.forget(principalA, {
        mode: 'retention-expiry',
        locator: locator(),
      });
      expect(expired).toMatchObject({
        mode: 'retention-expiry',
        status: 'unchanged',
        deletion: 'exempt',
      });
      // The first request's held receipt owns the record until the hold is
      // released, so every later request reports it instead of opening another.
      expect(expired.receipt?.deletionId).toBe(deleted.receipt?.deletionId);
      expect(forgotten.receipt?.deletionId).toBe(deleted.receipt?.deletionId);
      expect(await fixture.ledger.listReceipts({ tenantId: 'tenant-a' })).toHaveLength(1);

      expect(await fixture.memory.get(principalA, locator())).toMatchObject({
        id: recordId,
        content: `Lockbox code: ${SECRET}`,
      });
      expect(await recalled()).toEqual([recordId]);
    });

    it('tells a model that a held deletion did not happen', async () => {
      await fixture.memory.placeLegalHold(governancePrincipal, heldLocator());
      const tools = createGovernedMemoryTools(fixture.memory, { collection: 'notes' });
      expect(
        await tools.forget.execute({ id: recordId }, { requestContext: deleterContext }),
      ).toEqual({ deleted: false, reason: 'held' });
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });
      expect(await recalled()).toEqual([recordId]);
    });

    it('reports a failed synchronous step without claiming any target, then completes the same receipt on retry', async () => {
      const exported = await fixture.memory.export(principalA, { collection: 'notes' });
      const first = await failing().delete(principalA, locator());
      expect(first).toMatchObject({
        status: 'unchanged',
        deletion: 'failed',
        recordIds: [recordId],
      });
      expect(statuses(first.receipt)).toMatchObject({
        'source-evidence': 'failed',
        'canonical-projections': 'failed',
        'identity-views': 'failed',
        'managed-asset-record': 'failed',
        indexes: 'pending',
        exports: 'pending',
      });
      expect(first.receipt?.targets[0]?.detail).toBe('storage transaction failed');
      // The record is still stored, so no row may claim its target is clean.
      expect(completedRows(first.receipt)).toEqual([]);
      expect(first.receipt?.open).toBe(true);
      expect(JSON.stringify(first)).not.toContain(SECRET);
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });
      expect(await recalled()).toEqual([recordId]);
      const unscrubbed = await fixture.ledger.getExport('tenant-a', exported.exportId!);
      expect(unscrubbed?.recordIds).toEqual([recordId]);

      const retried = await fixture.memory.delete(principalA, locator());
      expect(retried).toMatchObject({ status: 'applied', deletion: 'completed' });
      expect(retried.receipt?.deletionId).toBe(first.receipt!.deletionId);
      expect(
        Object.values(statuses(retried.receipt)).every((status) => status === 'completed'),
      ).toBe(true);
      expect(retried.receipt?.open).toBe(false);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
      expect(await recalled()).toEqual([]);
      expect(await fixture.ledger.listReceipts({ tenantId: 'tenant-a' })).toEqual([
        retried.receipt!,
      ]);
      const scrubbed = await fixture.ledger.getExport('tenant-a', exported.exportId!);
      expect(scrubbed?.removedRecordIds).toEqual([recordId]);
    });

    it('retries a failed synchronous step on the next propagation pass', async () => {
      const first = await failing().delete(principalA, locator());
      const [settled] = await fixture.memory.processDeletionPropagation();
      expect(settled?.deletionId).toBe(first.receipt!.deletionId);
      expect(Object.values(statuses(settled)).every((status) => status === 'completed')).toBe(true);
      expect(settled?.open).toBe(false);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
      expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
    });

    const summaryFailures = [
      ['a storage error', () => new Error(`summary store unavailable for ${SECRET}`)],
      ['a version conflict', (id: string) => new MemoryRecordVersionConflictError([id])],
    ] as const;
    for (const [failure, error] of summaryFailures) {
      it(`keeps every other row waiting while a derived summary survives ${failure}, then completes the same receipt`, async () => {
        const summary = await derive(`Summary: the lockbox code is ${SECRET}.`, 'summary');
        const exported = await fixture.memory.export(principalA, { collection: 'notes' });
        const first = await failingFor(summary, error).delete(principalA, locator());
        // The source itself is gone, so the deletion took effect.
        expect(first).toMatchObject({ status: 'applied', deletion: 'completed' });
        expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
        // The summary is still stored and recallable, so no bounded-async row
        // may claim its target clean: each one waits for the summary's removal.
        expect(
          first
            .receipt!.targets.filter((target) => target.lane === 'bounded-async')
            .map((target) => [target.target, target.status]),
        ).toEqual([
          ['indexes', 'pending'],
          ['caches', 'pending'],
          ['summaries', 'pending'],
          ['managed-asset-bytes', 'pending'],
          ['durable-snapshots', 'pending'],
          ['exports', 'pending'],
          ['external-processors', 'pending'],
        ]);
        expect(first.receipt?.targets.find((target) => target.target === 'summaries')?.detail).toBe(
          'propagation attempt failed',
        );
        expect(first.receipt?.open).toBe(true);
        expect(JSON.stringify(first)).not.toContain(SECRET);
        expect(await fixture.storage.get(summary, scope)).toBeDefined();
        expect(await recalled()).toEqual([summary]);
        // Nor is either record scrubbed from the export that lists them.
        const unscrubbed = await fixture.ledger.getExport('tenant-a', exported.exportId!);
        expect(unscrubbed?.recordIds.toSorted()).toEqual([recordId, summary].toSorted());

        const [settled] = await fixture.memory.processDeletionPropagation();
        expect(settled?.deletionId).toBe(first.receipt!.deletionId);
        expect(Object.values(statuses(settled)).every((status) => status === 'completed')).toBe(
          true,
        );
        expect(settled?.open).toBe(false);
        expect(await fixture.storage.get(summary, scope)).toBeUndefined();
        expect(await recalled()).toEqual([]);
        const scrubbed = await fixture.ledger.getExport('tenant-a', exported.exportId!);
        expect(scrubbed?.recordIds).toEqual([]);
        expect(scrubbed?.removedRecordIds.toSorted()).toEqual([recordId, summary].toSorted());
        expect(await fixture.memory.processDeletionPropagation()).toEqual([]);
      });
    }

    it('reports a summary projection deletion as pending while the summary is stored, and completes it on the next pass', async () => {
      const summary = await derive(`Summary: the lockbox code is ${SECRET}.`, 'summary');
      const first = await failingFor(summary, () => new Error('summary store unavailable')).forget(
        principalA,
        { mode: 'projection-deletion', locator: locator(summary) },
      );
      expect(first).toMatchObject({
        mode: 'projection-deletion',
        status: 'unchanged',
        deletion: 'pending',
      });
      expect(first.receipt?.targets.map((target) => [target.target, target.status])).toEqual([
        ['summaries', 'pending'],
        ['indexes', 'pending'],
        ['caches', 'pending'],
        ['exports', 'pending'],
      ]);
      const stored = await recalled();
      expect(stored.toSorted()).toEqual([recordId, summary].toSorted());

      const [settled] = await fixture.memory.processDeletionPropagation();
      expect(settled?.deletionId).toBe(first.receipt!.deletionId);
      expect(completedRows(settled)).toEqual(['summaries', 'indexes', 'caches', 'exports']);
      expect(settled?.open).toBe(false);
      expect(await fixture.memory.get(principalA, locator(summary))).toBeUndefined();
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });
    });

    it('fails every waiting row at its deadline, and a later retry reopens and completes the same receipt', async () => {
      const broken = failing();
      const first = await broken.delete(principalA, locator());
      await fixture.runtime.advance(DAY);
      const [closed] = await broken.processDeletionPropagation();
      expect(closed?.deletionId).toBe(first.receipt!.deletionId);
      expect(Object.values(statuses(closed)).every((status) => status === 'failed')).toBe(true);
      expect(closed?.targets.find((target) => target.target === 'indexes')?.detail).toBe(
        'deadline passed before propagation completed',
      );
      expect(closed?.open).toBe(false);
      expect(await fixture.storage.get(recordId, scope)).toBeDefined();
      expect(await broken.processDeletionPropagation()).toEqual([]);

      const retried = await fixture.memory.forget(principalA, {
        mode: 'source-deletion',
        locator: locator(),
      });
      expect(retried).toMatchObject({
        mode: 'source-deletion',
        status: 'applied',
        deletion: 'completed',
      });
      expect(retried.receipt?.deletionId).toBe(first.receipt!.deletionId);
      expect(
        Object.values(statuses(retried.receipt)).every((status) => status === 'completed'),
      ).toBe(true);
      expect(retried.receipt?.open).toBe(false);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });

    it('exempts a failed deletion whose record was held before its retry, and finishes it on release', async () => {
      const first = await failing().delete(principalA, locator());
      await fixture.memory.placeLegalHold(governancePrincipal, heldLocator());
      const [held] = await fixture.memory.processDeletionPropagation();
      expect(held?.deletionId).toBe(first.receipt!.deletionId);
      expect(Object.values(statuses(held)).every((status) => status === 'exempt')).toBe(true);
      expect(held).toMatchObject({ awaitingHoldRelease: true, open: false });
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });

      const released = await fixture.memory.releaseLegalHold(governancePrincipal, heldLocator());
      expect(released.requeued).toHaveLength(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });

    it('tells a model that a failed deletion did not happen, and a retry completes it', async () => {
      const broken = createGovernedMemoryTools(failing(), { collection: 'notes' });
      const output = await broken.forget.execute(
        { id: recordId },
        { requestContext: deleterContext },
      );
      expect(output).toEqual({ deleted: false, reason: 'failed' });
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });

      const tools = createGovernedMemoryTools(fixture.memory, { collection: 'notes' });
      expect(
        await tools.forget.execute({ id: recordId }, { requestContext: deleterContext }),
      ).toEqual({ deleted: true });
      const receipts = await fixture.ledger.listReceipts({ tenantId: 'tenant-a' });
      expect(receipts).toHaveLength(1);
      expect(Object.values(statuses(receipts[0])).every((status) => status === 'completed')).toBe(
        true,
      );
      expect(await fixture.memory.get(principalA, locator())).toBeUndefined();
    });

    it('reports projection deletion the same way: held, failed, then retried to completion', async () => {
      const held = await derive('Canonical lockbox record, held.');
      const projection = await derive('Canonical lockbox record.');
      await fixture.memory.placeLegalHold(governancePrincipal, heldLocator(held));
      expect(
        await fixture.memory.forget(principalA, {
          mode: 'projection-deletion',
          locator: locator(held),
        }),
      ).toMatchObject({ mode: 'projection-deletion', status: 'unchanged', deletion: 'exempt' });
      expect(await fixture.memory.get(principalA, locator(held))).toMatchObject({ id: held });

      const first = await failing().forget(principalA, {
        mode: 'projection-deletion',
        locator: locator(projection),
      });
      expect(first).toMatchObject({
        mode: 'projection-deletion',
        status: 'unchanged',
        deletion: 'failed',
      });
      expect(first.receipt?.targets.map((target) => [target.target, target.status])).toEqual([
        ['canonical-projections', 'failed'],
        ['indexes', 'pending'],
        ['caches', 'pending'],
        ['exports', 'pending'],
      ]);
      expect(await fixture.memory.get(principalA, locator(projection))).toMatchObject({
        id: projection,
      });

      const retried = await fixture.memory.forget(principalA, {
        mode: 'projection-deletion',
        locator: locator(projection),
      });
      expect(retried).toMatchObject({ status: 'applied', deletion: 'completed' });
      expect(retried.receipt?.deletionId).toBe(first.receipt!.deletionId);
      expect(completedRows(retried.receipt)).toEqual([
        'canonical-projections',
        'indexes',
        'caches',
        'exports',
      ]);
      expect(await fixture.memory.get(principalA, locator(projection))).toBeUndefined();
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });
    });

    it('reports a failed retention expiry, and a retention sweep retries the same receipt', async () => {
      await fixture.runtime.advance(91 * DAY);
      const first = await failing().forget(principalA, {
        mode: 'retention-expiry',
        locator: locator(),
      });
      expect(first).toMatchObject({
        mode: 'retention-expiry',
        status: 'unchanged',
        deletion: 'failed',
      });
      expect(first.receipt?.trigger).toBe('retention-expiry');
      expect(await fixture.memory.get(principalA, locator())).toMatchObject({ id: recordId });

      const sweep = await fixture.memory.sweepRetention(retentionService);
      expect(sweep.deletionIds).toEqual([first.receipt!.deletionId]);
      const receipt = await fixture.ledger.getReceipt(first.receipt!.deletionId);
      expect(statuses(receipt)['source-evidence']).toBe('completed');
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });
  });
}
