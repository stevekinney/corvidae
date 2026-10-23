/**
 * COR-1665 — several Bureaus sharing one memory store each run the retention sweep, and each used
 * to open its own deletion receipt for the same expired record. A deletion now claims the record it
 * names by compare-and-swap, with a token and a lease, and opens its receipt only under a winning,
 * unexpired claim. A claimant whose lease ran out builds its receipt under the same deletion id as
 * whoever took the claim over, and the ledger stores a receipt only when none is stored under that
 * id, so a late writer is fenced too. Each test runs two sweepers over one store and parks one of
 * them at a real await to force the interleaving.
 */
import { describe, expect, it } from 'bun:test';

import { DELETION_CLAIM_LEASE_MILLISECONDS } from '../../src/governance/deletion';
import type { MemoryGovernanceLedger } from '../../src/governance/ledger';
import {
  MEMORY_GOVERNANCE_METADATA_KEY,
  collectionNamespace,
  readRecordGovernance,
} from '../../src/governance/record-governance';
import type { MemoryRecordStorage } from '../../src/memory-record-storage';
import { throwingRejectionOf } from '../../src/testing/promise-outcome.test-support.ts';
import {
  DAY,
  type GovernedBackend,
  type GovernedFixture,
  createGovernedFixture,
  governancePrincipal,
  principalA,
  recordIdOf,
  retentionService,
} from './governed-memory-harness';

const scope = {
  tenantId: 'tenant-a',
  namespace: collectionNamespace('private', 'owner-a', 'notes'),
};

/** A point one sweeper parks at: `reached` settles when it arrives, and it waits for `release()`. */
interface Park {
  readonly reached: Promise<void>;
  wait(): Promise<void>;
  release(): void;
}

function park(): Park {
  let arrive!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    async wait() {
      arrive();
      await released;
    },
  };
}

/** `target` with `overrides` in place of some of its methods; the rest stay bound to it. */
function intercept<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(object, property) {
      if (property in overrides) return overrides[property as keyof T];
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === 'function' ? value.bind(object) : value;
    },
  });
}

/** Storage that parks the caller just after it writes a deletion claim. */
function parkedAfterClaim(storage: MemoryRecordStorage, at: Park): MemoryRecordStorage {
  return intercept(storage, {
    async update(...parameters: Parameters<MemoryRecordStorage['update']>) {
      const updated = await storage.update(...parameters);
      const governance = parameters[2].metadata?.[MEMORY_GOVERNANCE_METADATA_KEY] as
        { deletionClaim?: unknown } | undefined;
      if (governance?.deletionClaim !== undefined) await at.wait();
      return updated;
    },
  });
}

async function expiredRecord(fixture: GovernedFixture): Promise<string> {
  const recordId = await recordIdOf(
    fixture.memory.write(principalA, 'The gate code is 4471.', {
      collection: 'notes',
      source: 'conversation',
    }),
  );
  await fixture.runtime.advance(91 * DAY);
  return recordId;
}

async function receiptsFor(fixture: GovernedFixture, recordId: string) {
  const receipts = await fixture.ledger.listReceipts({ tenantId: 'tenant-a' });
  return receipts.filter((receipt) => receipt.record.id === recordId);
}

async function claimOf(fixture: GovernedFixture, recordId: string) {
  const record = await fixture.storage.get(recordId, scope);
  return record === undefined ? undefined : readRecordGovernance(record)?.governance.deletionClaim;
}

for (const backend of ['in-memory', 'weft'] as const satisfies readonly GovernedBackend[]) {
  describe(`concurrent retention sweeps on the ${backend} record storage`, () => {
    for (const first of ['A', 'B'] as const) {
      it(`opens one receipt when sweeper ${first} claims the record first`, async () => {
        const fixture = await createGovernedFixture(backend);
        const recordId = await expiredRecord(fixture);
        const claimed = park();
        const winner = fixture.restart({ storage: parkedAfterClaim(fixture.storage, claimed) });
        const other = fixture.restart();

        const winning = winner.sweepRetention(retentionService);
        await claimed.reached;
        // The other sweeper finds a live claim with no receipt behind it, and skips the record.
        const skipped = await other.sweepRetention(retentionService);
        expect(skipped.expired.map((candidate) => candidate.id)).toEqual([recordId]);
        expect(skipped.deletionIds).toEqual([]);
        expect(await receiptsFor(fixture, recordId)).toEqual([]);

        claimed.release();
        const won = await winning;
        expect(won.deletionIds).toHaveLength(1);
        const receipts = await receiptsFor(fixture, recordId);
        expect(receipts.map((receipt) => receipt.deletionId)).toEqual([...won.deletionIds]);
        expect(receipts[0]?.trigger).toBe('retention-expiry');
        expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
      });
    }

    it('lets exactly one of two sweepers that read the record together claim it', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await expiredRecord(fixture);
      const [a, b] = await Promise.all([
        fixture.restart().sweepRetention(retentionService),
        fixture.restart().sweepRetention(retentionService),
      ]);
      expect([...a.deletionIds, ...b.deletionIds]).toHaveLength(1);
      expect(await receiptsFor(fixture, recordId)).toHaveLength(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });

    it('opens no receipt for a claimant that died before opening one until its lease expires, then exactly one', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await expiredRecord(fixture);
      const ledger: MemoryGovernanceLedger = {
        ...fixture.ledger,
        openReceipt: () => Promise.reject(new Error('process died')),
      };
      expect(
        await throwingRejectionOf(fixture.restart({ ledger }).sweepRetention(retentionService)),
      ).toThrow('process died');
      const orphaned = await claimOf(fixture, recordId);
      expect(orphaned).toBeDefined();
      expect(await receiptsFor(fixture, recordId)).toEqual([]);

      // While the dead claimant's lease runs, nobody opens a receipt.
      const survivor = fixture.restart();
      const early = await survivor.sweepRetention(retentionService);
      expect(early.deletionIds).toEqual([]);
      expect(await receiptsFor(fixture, recordId)).toEqual([]);
      expect(await fixture.storage.get(recordId, scope)).toBeDefined();

      // Once it expires, the survivor takes the claim over under the same deletion id.
      await fixture.runtime.advance(DELETION_CLAIM_LEASE_MILLISECONDS);
      const recovered = await survivor.sweepRetention(retentionService);
      expect(recovered.deletionIds).toEqual([orphaned!.deletionId]);
      expect(await receiptsFor(fixture, recordId)).toHaveLength(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
      const later = await survivor.sweepRetention(retentionService);
      expect(later.deletionIds).toEqual([]);
    });

    it('fences a slow claimant whose lease expired with the receipt its successor opened', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await expiredRecord(fixture);
      const opening = park();
      // A passes its own claim check, then stalls just before writing its receipt.
      const slow = fixture.restart({
        ledger: {
          ...fixture.ledger,
          openReceipt: async (receipt) => {
            await opening.wait();
            return fixture.ledger.openReceipt(receipt);
          },
        },
      });
      const stalled = slow.sweepRetention(retentionService);
      await opening.reached;

      await fixture.runtime.advance(DELETION_CLAIM_LEASE_MILLISECONDS);
      const successor = await fixture.restart().sweepRetention(retentionService);
      expect(successor.deletionIds).toHaveLength(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();

      opening.release();
      const fenced = await stalled;
      expect(fenced.deletionIds).toEqual([]);
      const receipts = await receiptsFor(fixture, recordId);
      expect(receipts.map((receipt) => receipt.deletionId)).toEqual([...successor.deletionIds]);
      expect(receipts[0]?.open).toBe(false);
    });

    it('stops a slow claimant whose claim was taken over before it built its receipt', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await expiredRecord(fixture);
      const planning = park();
      const opening = park();
      // A stalls while planning, after its claim and before its claim check.
      const slow = fixture.restart({
        ledger: {
          ...fixture.ledger,
          listLineage: async (...parameters) => {
            await planning.wait();
            return fixture.ledger.listLineage(...parameters);
          },
        },
      });
      const stalled = slow.sweepRetention(retentionService);
      await planning.reached;
      const first = await claimOf(fixture, recordId);

      // B takes the expired claim over and stalls before opening its receipt.
      await fixture.runtime.advance(DELETION_CLAIM_LEASE_MILLISECONDS);
      const successor = fixture.restart({
        ledger: {
          ...fixture.ledger,
          openReceipt: async (receipt) => {
            await opening.wait();
            return fixture.ledger.openReceipt(receipt);
          },
        },
      });
      const taking = successor.sweepRetention(retentionService);
      await opening.reached;
      const taken = await claimOf(fixture, recordId);
      expect(taken?.deletionId).toBe(first?.deletionId);
      expect(taken?.token).not.toBe(first?.token);

      // A finds another claimant's token on the record and opens nothing.
      planning.release();
      const stopped = await stalled;
      expect(stopped.deletionIds).toEqual([]);
      expect(await receiptsFor(fixture, recordId)).toEqual([]);

      opening.release();
      const took = await taking;
      expect(took.deletionIds).toEqual([first!.deletionId]);
      expect(await receiptsFor(fixture, recordId)).toHaveLength(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });

    it('renews the lease of a slow claimant that nobody took over, and opens one receipt', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await expiredRecord(fixture);
      const planning = park();
      const slow = fixture.restart({
        ledger: {
          ...fixture.ledger,
          listLineage: async (...parameters) => {
            await planning.wait();
            return fixture.ledger.listLineage(...parameters);
          },
        },
      });
      const stalled = slow.sweepRetention(retentionService);
      await planning.reached;
      const first = await claimOf(fixture, recordId);
      await fixture.runtime.advance(DELETION_CLAIM_LEASE_MILLISECONDS);

      planning.release();
      const swept = await stalled;
      expect(swept.deletionIds).toEqual([first!.deletionId]);
      expect(await receiptsFor(fixture, recordId)).toHaveLength(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });

    it('opens no second receipt for a record claimed before claims carried a lease', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await recordIdOf(
        fixture.memory.write(principalA, 'The gate code is 4471.', {
          collection: 'notes',
          source: 'conversation',
        }),
      );
      const locator = { id: recordId, collection: 'notes' };
      await fixture.memory.placeLegalHold(governancePrincipal, { ...locator, ownerId: 'owner-a' });
      const held = await fixture.memory.delete(principalA, locator);
      // Strip the claim, leaving the record as an earlier version stored it.
      const stored = (await fixture.storage.get(recordId, scope))!;
      const governance = stored.metadata[MEMORY_GOVERNANCE_METADATA_KEY] as Record<string, unknown>;
      const { deletionClaim: _claim, ...legacy } = governance;
      expect(legacy['deletionRequestedAt']).toBeDefined();
      await fixture.storage.update(recordId, scope, {
        metadata: { ...stored.metadata, [MEMORY_GOVERNANCE_METADATA_KEY]: legacy },
      });

      const again = await fixture.restart().delete(principalA, locator);
      expect(again).toMatchObject({ status: 'unchanged', deletion: 'exempt' });
      expect(again.receipt?.deletionId).toBe(held.receipt?.deletionId);
      expect(await receiptsFor(fixture, recordId)).toHaveLength(1);
    });

    it('re-queues a released hold once when two passes resume it together', async () => {
      const fixture = await createGovernedFixture(backend);
      const recordId = await recordIdOf(
        fixture.memory.write(principalA, 'The gate code is 4471.', {
          collection: 'notes',
          source: 'conversation',
        }),
      );
      const locator = { id: recordId, collection: 'notes', ownerId: 'owner-a' };
      await fixture.memory.placeLegalHold(governancePrincipal, locator);
      const held = await fixture.memory.delete(principalA, { id: recordId, collection: 'notes' });
      // The release lands, and the process dies before it re-queues anything.
      const crashing = fixture.restart({
        ledger: {
          ...fixture.ledger,
          listReceipts: () => Promise.reject(new Error('process died')),
        },
      });
      expect(
        await throwingRejectionOf(crashing.releaseLegalHold(governancePrincipal, locator)),
      ).toThrow('process died');

      await Promise.all([
        fixture.restart().processDeletionPropagation(),
        fixture.restart().processDeletionPropagation(),
      ]);
      const receipts = await receiptsFor(fixture, recordId);
      expect(receipts.filter((receipt) => receipt.trigger === 'hold-release')).toHaveLength(1);
      expect(await fixture.ledger.getReceipt(held.receipt!.deletionId)).toMatchObject({
        awaitingHoldRelease: false,
      });
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });
  });
}
