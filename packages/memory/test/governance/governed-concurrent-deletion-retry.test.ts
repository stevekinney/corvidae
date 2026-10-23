/**
 * COR-1673 — a deletion whose row removing the record failed is retried under its own receipt, by
 * a new request to delete the record (a retention sweep, say) and by every propagation pass over
 * it while it is still open. Several processes sharing one store can find the same failed receipt
 * at once. Every receipt transition is a conditional write on the stored receipt its writer read,
 * so exactly one of them moves the receipt on; a writer that loses decides again from what is
 * stored now, and never overwrites the winner's progress or reopens a receipt that completed.
 * Each test runs two actors over one store and parks one of them at a real await.
 */
import { describe, expect, it } from 'bun:test';

import type {
  MemoryDeletionPropagation,
  MemoryDeletionPropagationRequest,
} from '../../src/governance/governed-memory-types';
import type { MemoryGovernanceLedger } from '../../src/governance/ledger';
import type { MemoryDeletionReceipt } from '../../src/governance/ledger-types';
import { DEFAULT_DELETION_BOUND_MILLISECONDS } from '../../src/governance/policy';
import { collectionNamespace } from '../../src/governance/record-governance';
import { throwingRejectionOf } from '../../src/testing/promise-outcome.test-support.ts';
import { controlledLane, intercept, type Park, park } from './concurrent-deletion-harness';
import {
  createGovernedFixture,
  DAY,
  type GovernedBackend,
  type GovernedFixture,
  principalA,
  recordIdOf,
  retentionService,
} from './governed-memory-harness';

const scope = {
  tenantId: 'tenant-a',
  namespace: collectionNamespace('private', 'owner-a', 'notes'),
};

type FailedState = 'open-failed' | 'closed-failed';

async function receiptsFor(fixture: GovernedFixture, recordId: string) {
  const receipts = await fixture.ledger.listReceipts({ tenantId: 'tenant-a' });
  return receipts.filter((receipt) => receipt.record.id === recordId);
}

function statusOf(receipt: MemoryDeletionReceipt | undefined, target: string) {
  return receipt?.targets.find((row) => row.target === target)?.status;
}

/** How many times the ledger recorded `type` for `deletionId`. */
async function eventCount(fixture: GovernedFixture, type: string, deletionId: string) {
  const events = await fixture.ledger.listEvents({ tenantId: 'tenant-a', type });
  return events.filter((event) => event.details?.['deletionId'] === deletionId).length;
}

/**
 * An expired record whose deletion failed to remove it: its receipt is still open with its
 * bounded-async rows pending (`open-failed`), or closed once those rows passed their deadline
 * (`closed-failed`).
 */
async function failedDeletion(fixture: GovernedFixture, state: FailedState) {
  const recordId = await recordIdOf(
    fixture.memory.write(principalA, 'The gate code is 4471.', {
      collection: 'notes',
      source: 'conversation',
    }),
  );
  await fixture.runtime.advance(91 * DAY);
  const lane = controlledLane(fixture.storage);
  lane.behavior = 'fail';
  const failing = fixture.restart({ storage: lane.storage });
  await failing.sweepRetention(retentionService);
  if (state === 'closed-failed') {
    await fixture.runtime.advance(DEFAULT_DELETION_BOUND_MILLISECONDS);
    await failing.processDeletionPropagation();
  }
  const [failed] = await receiptsFor(fixture, recordId);
  expect(failed?.open).toBe(state === 'open-failed');
  expect(statusOf(failed, 'source-evidence')).toBe('failed');
  return { recordId, failed: failed! };
}

/** A ledger that parks its caller once, just after it reads the receipt stored under `deletionId`. */
function parkedAfterReceiptRead(
  ledger: MemoryGovernanceLedger,
  deletionId: string,
  at: Park,
): MemoryGovernanceLedger {
  let parked = false;
  return intercept(ledger, {
    async readReceipt(...parameters: Parameters<MemoryGovernanceLedger['readReceipt']>) {
      const stored = await ledger.readReceipt(...parameters);
      if (!parked && parameters[0] === deletionId) {
        parked = true;
        await at.wait();
      }
      return stored;
    },
  });
}

/**
 * A real `external-processors` propagator shared by several actors: it records every call, and
 * reports `pending` or `completed` (parking once first, when asked) as `mode` says at the time.
 */
function recordingPropagator() {
  const state = {
    calls: [] as MemoryDeletionPropagationRequest[],
    mode: 'pending' as 'pending' | 'completed' | 'park',
    parked: park(),
  };
  const propagation: MemoryDeletionPropagation = {
    caches: 'not-retained',
    'managed-asset-bytes': 'not-retained',
    'durable-snapshots': 'not-retained',
    'external-processors': {
      async propagate(request) {
        state.calls.push(request);
        if (state.mode === 'park') {
          state.mode = 'completed';
          await state.parked.wait();
          return { status: 'completed', detail: 'processor purged (after parking)' };
        }
        return state.mode === 'pending'
          ? { status: 'pending', detail: 'processor purge queued' }
          : { status: 'completed', detail: 'processor purged' };
      },
    },
  };
  return Object.assign(state, { propagation });
}

for (const backend of ['in-memory', 'weft'] as const satisfies readonly GovernedBackend[]) {
  describe(`concurrent retries of a failed deletion on the ${backend} record storage`, () => {
    for (const state of ['open-failed', 'closed-failed'] as const) {
      it(`lets exactly one of two sweepers that read the ${state} receipt retry it`, async () => {
        const fixture = await createGovernedFixture(backend);
        const { recordId, failed } = await failedDeletion(fixture, state);

        // B reads the failed receipt and stalls before it acts on it.
        const read = park();
        const b = fixture.restart({
          ledger: parkedAfterReceiptRead(fixture.ledger, failed.deletionId, read),
        });
        const sweepB = b.sweepRetention(retentionService);
        await read.reached;

        // A wins the retry and is still running its rows.
        const lane = controlledLane(fixture.storage);
        lane.behavior = 'park';
        const sweepA = fixture.restart({ storage: lane.storage }).sweepRetention(retentionService);
        await lane.parked.reached;

        // B finds the retry in progress and skips the record.
        read.release();
        const skipped = await sweepB;
        expect(skipped.deletionIds).toEqual([]);
        expect(await eventCount(fixture, 'memory.deletion.requested', failed.deletionId)).toBe(2);

        lane.behavior = 'succeed';
        lane.parked.release();
        const retried = await sweepA;
        expect(retried.deletionIds).toEqual([failed.deletionId]);
        const receipts = await receiptsFor(fixture, recordId);
        expect(receipts.map((receipt) => receipt.deletionId)).toEqual([failed.deletionId]);
        expect(receipts[0]).toMatchObject({ open: false });
        expect(statusOf(receipts[0], 'source-evidence')).toBe('completed');
        expect(await eventCount(fixture, 'memory.deletion.requested', failed.deletionId)).toBe(2);
        expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
      });

      it(`leaves the ${state} receipt alone for a sweeper that read it before another's retry completed`, async () => {
        const fixture = await createGovernedFixture(backend);
        const { recordId, failed } = await failedDeletion(fixture, state);

        const read = park();
        const b = fixture.restart({
          ledger: parkedAfterReceiptRead(fixture.ledger, failed.deletionId, read),
        });
        const sweepB = b.sweepRetention(retentionService);
        await read.reached;

        // A retries the deletion to completion while B waits.
        const swept = await fixture.restart().sweepRetention(retentionService);
        expect(swept.deletionIds).toEqual([failed.deletionId]);
        const completed = await fixture.ledger.getReceipt(failed.deletionId);
        expect(completed).toMatchObject({ open: false });
        expect(statusOf(completed, 'source-evidence')).toBe('completed');

        // B sees the receipt closed and succeeded, and does nothing.
        read.release();
        const skipped = await sweepB;
        expect(skipped.deletionIds).toEqual([]);
        expect(await fixture.ledger.getReceipt(failed.deletionId)).toEqual(completed);
        expect(await eventCount(fixture, 'memory.deletion.requested', failed.deletionId)).toBe(2);
        expect(await receiptsFor(fixture, recordId)).toHaveLength(1);
      });
    }

    it('lets exactly one propagation pass resume a retry whose runner died, and no sweeper', async () => {
      const fixture = await createGovernedFixture(backend);
      const { recordId, failed } = await failedDeletion(fixture, 'closed-failed');
      const propagatedBefore = await eventCount(
        fixture,
        'memory.deletion.propagated',
        failed.deletionId,
      );

      // A wins the retry, removes the record, and dies before it records the outcome.
      const dying = fixture.restart({
        ledger: {
          ...fixture.ledger,
          deleteLineage: () => Promise.reject(new Error('process died')),
        },
      });
      expect(await throwingRejectionOf(dying.sweepRetention(retentionService))).toThrow(
        'process died',
      );
      const orphaned = await fixture.ledger.getReceipt(failed.deletionId);
      expect(orphaned).toMatchObject({ open: true });
      expect(statusOf(orphaned, 'source-evidence')).toBe('pending');

      // A sweeper does not take the open retry over.
      const swept = await fixture.restart().sweepRetention(retentionService);
      expect(swept.deletionIds).toEqual([]);

      // Two passes find it open; the first stalls in its rows while the second resumes it.
      const lane = controlledLane(fixture.storage);
      lane.behavior = 'park';
      const first = fixture.restart({ storage: lane.storage }).processDeletionPropagation();
      await lane.parked.reached;
      const [resumed] = await fixture.restart().processDeletionPropagation();
      expect(resumed).toMatchObject({ deletionId: failed.deletionId, open: false });

      lane.behavior = 'succeed';
      lane.parked.release();
      const [adopted] = await first;
      expect(adopted).toEqual(resumed);
      expect(await fixture.ledger.getReceipt(failed.deletionId)).toEqual(resumed);
      expect(statusOf(resumed, 'source-evidence')).toBe('completed');
      expect(await eventCount(fixture, 'memory.deletion.propagated', failed.deletionId)).toBe(
        propagatedBefore + 1,
      );
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });

    it('keeps a retry that completed while a propagation pass was rerunning the same open receipt', async () => {
      const fixture = await createGovernedFixture(backend);
      const { recordId, failed } = await failedDeletion(fixture, 'open-failed');
      const propagatedBefore = await eventCount(
        fixture,
        'memory.deletion.propagated',
        failed.deletionId,
      );

      // The pass reruns the receipt's failed synchronous lane, and stalls inside it.
      const lane = controlledLane(fixture.storage);
      lane.behavior = 'park';
      const pass = fixture.restart({ storage: lane.storage }).processDeletionPropagation();
      await lane.parked.reached;

      // A sweeper retries the same receipt and completes it.
      const swept = await fixture.restart().sweepRetention(retentionService);
      expect(swept.deletionIds).toEqual([failed.deletionId]);
      const completed = await fixture.ledger.getReceipt(failed.deletionId);
      expect(completed).toMatchObject({ open: false });
      expect(statusOf(completed, 'source-evidence')).toBe('completed');

      // The pass's lane fails, and its stale outcome does not replace the completed receipt.
      lane.behavior = 'fail';
      lane.parked.release();
      expect(await pass).toEqual([completed!]);
      expect(await fixture.ledger.getReceipt(failed.deletionId)).toEqual(completed);
      expect(await eventCount(fixture, 'memory.deletion.propagated', failed.deletionId)).toBe(
        propagatedBefore + 1,
      );
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });
    it('calls a propagator again when two passes run one open receipt, and closes the receipt once', async () => {
      const fixture = await createGovernedFixture(backend);
      const recorder = recordingPropagator();
      const actor = () => fixture.restart({ propagation: recorder.propagation });
      const recordId = await recordIdOf(
        fixture.memory.write(principalA, 'The gate code is 4471.', {
          collection: 'notes',
          source: 'conversation',
        }),
      );
      await fixture.runtime.advance(91 * DAY);

      // The deletion removes the record; the external processor has only queued its purge.
      const swept = await actor().sweepRetention(retentionService);
      const [deletionId] = swept.deletionIds;
      expect(deletionId).toBeDefined();
      const open = await fixture.ledger.getReceipt(deletionId!);
      expect(open).toMatchObject({ open: true });
      expect(statusOf(open, 'external-processors')).toBe('pending');
      const settledEvents = async () => {
        const events = await fixture.ledger.listEvents({
          tenantId: 'tenant-a',
          type: 'memory.deletion.propagated',
        });
        return events.filter(
          (event) => event.details?.['deletionId'] === deletionId && event.outcome === 'settled',
        ).length;
      };
      expect(await settledEvents()).toBe(0);

      // Two passes run the open receipt: the first stalls inside the propagator, the second completes.
      recorder.mode = 'park';
      const first = actor().processDeletionPropagation();
      await recorder.parked.reached;
      const [closed] = await actor().processDeletionPropagation();
      expect(closed).toMatchObject({ deletionId, open: false });
      expect(statusOf(closed, 'external-processors')).toBe('completed');

      recorder.parked.release();
      expect(await first).toEqual([closed!]);
      const passCalls = recorder.calls.slice(1);
      expect(passCalls.map((call) => [call.deletionId, call.target])).toEqual([
        [deletionId!, 'external-processors'],
        [deletionId!, 'external-processors'],
      ]);
      expect(await fixture.ledger.getReceipt(deletionId!)).toEqual(closed);
      expect(await settledEvents()).toBe(1);
      expect(await fixture.storage.get(recordId, scope)).toBeUndefined();
    });
  });
}
