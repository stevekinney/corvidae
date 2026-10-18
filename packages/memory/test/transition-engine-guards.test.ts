import { describe, expect, it } from 'bun:test';

import type { EvidenceProjectionStorage } from '../src/evidence-projection-storage';
import { createTransitionEngine } from '../src/transition-engine';
import { DEFAULT_TRANSITION_KEY_PREFIX } from '../src/transition-receipt';
import { recordBatches, TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  createHarness,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  makeWriteAuthority,
  NAMESPACE,
  seedCorrectionState,
  TENANT,
} from './transition-test-support';

/**
 * Guards inside the engine that no outcome test reaches by accident: the abort
 * contract before the batch, the receipt read-back, the store's receipt
 * pre-read, and the receipt key prefix.
 */

/** An engine whose sink aborts the controller when it sees `kind`. */
function abortingEngine(
  storage: EvidenceProjectionStorage,
  kind: string,
  controller: AbortController,
) {
  const recorder = createRecordingSink();
  const engine = createTransitionEngine({
    storage,
    now: createManualClock().now,
    sink: (event) => {
      recorder.sink(event);
      if (event.kind === kind) controller.abort();
    },
  });
  return { engine, recorder };
}

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the abort contract before the batch (${label})`, () => {
    it('cancels instead of rejecting when aborted during validation', async () => {
      const controller = new AbortController();
      const { engine, recorder } = abortingEngine(makeBackend(), 'validation-started', controller);
      const result = await engine.submit(
        appendProposal(
          'operation-1',
          ['e1'],
          makeWriteAuthority({ capabilities: ['memory:search'] }),
        ),
        { signal: controller.signal },
      );
      expect(result).toEqual({ outcome: 'canceled' });
      expect(recorder.kinds()).toEqual(['requested', 'validation-started', 'canceled']);
    });

    it('cancels instead of conflicting when aborted during validation', async () => {
      const controller = new AbortController();
      const storage = makeBackend();
      await seedCorrectionState(storage);
      const { engine, recorder } = abortingEngine(storage, 'validation-started', controller);
      const result = await engine.submit(
        {
          kind: 'revise-projection',
          operationId: 'operation-1',
          tenantId: TENANT,
          authority: makeWriteAuthority(),
          revisions: [
            {
              namespace: NAMESPACE,
              id: 'p1',
              expectedRevision: 9,
              change: { kind: 'revoked', reasonCode: 'withdrawn' },
            },
          ],
        },
        { signal: controller.signal },
      );
      expect(result).toEqual({ outcome: 'canceled' });
      expect(recorder.kinds()).toEqual(['requested', 'validation-started', 'canceled']);
    });

    it('still replays an existing receipt for an aborted submission', async () => {
      const harness = createHarness(makeBackend);
      expectCommitted(await harness.engine.submit(appendProposal('operation-1')));
      const controller = new AbortController();
      controller.abort();
      const replay = expectCommitted(
        await harness.engine.submit(appendProposal('operation-1'), { signal: controller.signal }),
      );
      expect(replay.replayed).toBe(true);
    });
  });

  describe(`the receipt read-back (${label})`, () => {
    function readBackReturning(storage: EvidenceProjectionStorage, bytes: Uint8Array | null) {
      let reads = 0;
      return {
        ...storage,
        getReceipt: (key: string) => {
          reads += 1;
          return reads === 1 ? storage.getReceipt(key) : Promise.resolve(bytes);
        },
      } satisfies EvidenceProjectionStorage;
    }

    it('reports unknown when the stored receipt is missing after the commit', async () => {
      const harness = createHarness(makeBackend);
      const guarded = createHarness(makeBackend, {
        storage: readBackReturning(harness.storage, null),
        clock: harness.clock,
        recorder: harness.recorder,
      });
      const result = await guarded.engine.submit(appendProposal('operation-1'));
      expect(result.outcome).toBe('unknown');
      expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'failed']);
    });

    it('reports unknown when the stored receipt differs from the one written', async () => {
      const harness = createHarness(makeBackend);
      const guarded = createHarness(makeBackend, {
        storage: readBackReturning(harness.storage, new TextEncoder().encode('{}')),
        clock: harness.clock,
        recorder: harness.recorder,
      });
      const result = await guarded.engine.submit(appendProposal('operation-1'));
      expect(result.outcome).toBe('unknown');
    });
  });

  describe(`the store's receipt pre-read (${label})`, () => {
    it('settles a lost race on the receipt without handing the loser a batch', async () => {
      const recorder = recordBatches();
      const storage = makeBackend(recorder.wrapApply);
      const gates = createOrderedGates(2);
      const engine = (index: number) =>
        createTransitionEngine({
          storage,
          sink: createRecordingSink().sink,
          now: createManualClock().now,
          hooks: { beforeBatch: gates.hold(index) },
        });
      const winner = engine(0);
      const loser = engine(1);
      const pendingWinner = winner.submit(appendProposal('operation-1'));
      const pendingLoser = loser.submit(appendProposal('operation-1'));
      await gates.whenAllArrived;
      gates.release(0);
      const won = expectCommitted(await pendingWinner);
      gates.release(1);
      const lost = expectCommitted(await pendingLoser);

      expect(lost.replayed).toBe(true);
      expect(lost.receipt).toEqual(won.receipt);
      // The loser planned after the winner's receipt existed, so the store refused it before any
      // batch, instead of the loser burning every attempt on a batch that cannot apply.
      expect(recorder.batches).toHaveLength(1);
    });
  });
}

describe('the receipt key prefix', () => {
  const storage = () => TRANSITION_BACKENDS[0]![1]();
  const create = (receiptKeyPrefix: string) =>
    createTransitionEngine({
      storage: storage(),
      sink: () => undefined,
      now: () => 0,
      receiptKeyPrefix,
    });

  it('accepts the default and a prefix inside the receipt family', () => {
    expect(() => create(DEFAULT_TRANSITION_KEY_PREFIX)).not.toThrow();
    expect(() => create(`${DEFAULT_TRANSITION_KEY_PREFIX}sandbox:`)).not.toThrow();
  });

  it('refuses a prefix outside the receipt family, including the other memory families', () => {
    for (const prefix of [
      '',
      'app:agent-bureau:memory-evidence:v1:',
      'app:agent-bureau:memory-projection:v1:',
      'app:agent-bureau:memory:v1:',
      'app:agent-bureau:memory-transition:',
      'workflow:',
    ]) {
      expect(() => create(prefix), prefix).toThrow(RangeError);
    }
  });
});
