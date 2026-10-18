import { describe, expect, it } from 'bun:test';

import { createTransitionEngine } from '../src/transition-engine';
import { createTransitionKeys } from '../src/transition-receipt';
import { failFirstBatch, recordBatches, TRANSITION_BACKENDS } from './transition-backends';
import {
  correctionProposal,
  correctionState,
  createHarness,
  createManualClock,
  createRecordingSink,
  expectCommitted,
  seedCorrectionState,
  TENANT,
} from './transition-test-support';

/**
 * A `correct-evidence` proposal is COR-1546's one-batch correction: a successor
 * evidence record, the supersession marker, a projection created from the
 * successor, the revision that supersedes the old projection, and the receipt.
 * Interrupted at each step, it converges to one of exactly two states: nothing
 * applied, or all of it. A retry then lands in the second.
 */

const NOTHING = {
  successor: false,
  marker: false,
  createdProjection: false,
  retiredRevision: 1,
  receipt: null,
};

async function expectAllApplied(
  storage: Parameters<typeof correctionState>[0],
  operationId: string,
): Promise<void> {
  const state = await correctionState(storage, operationId);
  expect({ ...state, receipt: state.receipt !== null }).toEqual({
    successor: true,
    marker: true,
    createdProjection: true,
    retiredRevision: 2,
    receipt: true,
  });
}

/** A hook that records that the engine reached it and never lets the submission go on. */
function abandonAt() {
  const reached = Promise.withResolvers<void>();
  return {
    reached: reached.promise,
    hook: (): Promise<void> => {
      reached.resolve();
      return new Promise<void>(() => undefined);
    },
  };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`a correction interrupted at each step (${label})`, () => {
    it('hands the receipt put to apply in the same batch as every record', async () => {
      const recorder = recordBatches();
      const harness = createHarness(makeBackend, { wrapApply: recorder.wrapApply });
      await seedCorrectionState(harness.storage);
      recorder.batches.length = 0;
      const { receipt } = expectCommitted(
        await harness.engine.submit(correctionProposal('operation-1')),
      );

      expect(recorder.batches).toHaveLength(1);
      const keys = recorder.batches[0]!.operations.map((operation) => operation.key);
      const receiptKey = createTransitionKeys().receipt(TENANT, 'operation-1');
      expect(keys.filter((key) => key === receiptKey)).toHaveLength(1);
      // The receipt, the successor, its marker, and two revisions each written as a history entry and a current pointer.
      expect(keys).toHaveLength(1 + 1 + 1 + 2 + 2);
      expect(receipt.evidence).toHaveLength(1);
      expect(receipt.projections).toHaveLength(2);
    });

    it('1. abandoned before the batch: nothing applied, and a retry commits it all', async () => {
      const abandoned = abandonAt();
      const harness = createHarness(makeBackend, { hooks: { beforeBatch: abandoned.hook } });
      await seedCorrectionState(harness.storage);
      void harness.engine.submit(correctionProposal('operation-1'));
      await abandoned.reached;
      expect(await correctionState(harness.storage, 'operation-1')).toEqual(NOTHING);

      const retry = createHarness(makeBackend, { storage: harness.storage });
      const result = expectCommitted(await retry.engine.submit(correctionProposal('operation-1')));
      expect(result.replayed).toBe(false);
      await expectAllApplied(harness.storage, 'operation-1');
    });

    it('2. the batch throws before applying: nothing applied, and a retry commits it all', async () => {
      const fault = failFirstBatch('before', { skip: 1 });
      const harness = createHarness(makeBackend, { wrapApply: fault.wrapApply });
      await seedCorrectionState(harness.storage);
      const interrupted = await harness.engine.submit(correctionProposal('operation-1'));
      expect(interrupted.outcome).toBe('unknown');
      expect(await correctionState(harness.storage, 'operation-1')).toEqual(NOTHING);

      const result = expectCommitted(
        await harness.engine.submit(correctionProposal('operation-1')),
      );
      expect(result.replayed).toBe(false);
      await expectAllApplied(harness.storage, 'operation-1');
    });

    it('3. the batch applies, then throws: all applied, and a retry returns the receipt', async () => {
      const fault = failFirstBatch('after', { skip: 1 });
      const harness = createHarness(makeBackend, { wrapApply: fault.wrapApply });
      await seedCorrectionState(harness.storage);
      const first = expectCommitted(await harness.engine.submit(correctionProposal('operation-1')));
      await expectAllApplied(harness.storage, 'operation-1');

      const retry = expectCommitted(await harness.engine.submit(correctionProposal('operation-1')));
      expect(retry.replayed).toBe(true);
      expect(retry.receipt).toEqual(first.receipt);
      expect(fault.batches).toHaveLength(2); // the seed, then the one correction batch
    });

    it('4. abandoned after the batch and before the receipt read-back: all applied, and a retry returns the receipt', async () => {
      const abandoned = abandonAt();
      const harness = createHarness(makeBackend, { hooks: { afterBatch: abandoned.hook } });
      await seedCorrectionState(harness.storage);
      void harness.engine.submit(correctionProposal('operation-1'));
      await abandoned.reached;
      await expectAllApplied(harness.storage, 'operation-1');

      const retry = createHarness(makeBackend, { storage: harness.storage });
      const result = expectCommitted(await retry.engine.submit(correctionProposal('operation-1')));
      expect(result.replayed).toBe(true);
      expect(retry.recorder.kinds()).toEqual(['requested', 'recovery-reconciled']);
      expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toEqual(result.receipt);
    });

    it('5. abandoned after the receipt and before the events: all applied, and a retry returns the receipt', async () => {
      const abandoned = abandonAt();
      const harness = createHarness(makeBackend, { hooks: { beforeEvents: abandoned.hook } });
      await seedCorrectionState(harness.storage);
      void harness.engine.submit(correctionProposal('operation-1'));
      await abandoned.reached;
      await expectAllApplied(harness.storage, 'operation-1');
      // The work was abandoned before any outcome event.
      expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started']);

      const retry = createHarness(makeBackend, { storage: harness.storage });
      const result = expectCommitted(await retry.engine.submit(correctionProposal('operation-1')));
      expect(result.replayed).toBe(true);
      await expectAllApplied(harness.storage, 'operation-1');
    });

    it('treats a hook that throws as a throw from the batch call', async () => {
      const harness = createHarness(makeBackend, {
        hooks: {
          beforeBatch: () => {
            throw new Error('the boundary failed');
          },
        },
      });
      await seedCorrectionState(harness.storage);
      const interrupted = await harness.engine.submit(correctionProposal('operation-1'));
      expect(interrupted.outcome).toBe('unknown');
      expect(await correctionState(harness.storage, 'operation-1')).toEqual(NOTHING);
    });

    it('writes neither the commit nor the receipt when apply fails, so no receipt can outlive its commit', async () => {
      const fault = failFirstBatch('before', { skip: 1 });
      const harness = createHarness(makeBackend, { wrapApply: fault.wrapApply });
      await seedCorrectionState(harness.storage);
      await harness.engine.submit(correctionProposal('operation-1'));
      expect(await harness.engine.getReceipt(TENANT, 'operation-1')).toBeUndefined();
      expect(await harness.storage.getEvidence(TENANT, 'e2')).toBeUndefined();
    });

    it('uses a separate engine instance and clock for a retry without changing the receipt', async () => {
      const first = createHarness(makeBackend);
      await seedCorrectionState(first.storage);
      const committed = expectCommitted(
        await first.engine.submit(correctionProposal('operation-1')),
      );
      const later = createTransitionEngine({
        storage: first.storage,
        sink: createRecordingSink().sink,
        now: createManualClock(first.clock.current + 99_999).now,
      });
      const replay = expectCommitted(await later.submit(correctionProposal('operation-1')));
      expect(replay.receipt).toEqual(committed.receipt);
    });
  });
}
