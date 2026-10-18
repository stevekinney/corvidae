import { describe, expect, it } from 'bun:test';

import { createTransitionEngine } from '../src/transition-engine';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  correctionProposal,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  seedCorrectionState,
} from './transition-test-support';

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`the events of an all-duplicate commit (${label})`, () => {
    it('emits no superseded event for a supersession another operation performed', async () => {
      const storage = makeBackend();
      await seedCorrectionState(storage);
      const gates = createOrderedGates(2);
      const sinks = [createRecordingSink(), createRecordingSink()];
      const engine = (index: number) =>
        createTransitionEngine({
          storage,
          sink: sinks[index]!.sink,
          now: createManualClock().now,
          hooks: { beforeBatch: gates.hold(index) },
        });
      const a = engine(0).submit(correctionProposal('operation-a'));
      const b = engine(1).submit(correctionProposal('operation-b'));
      await gates.whenAllArrived;
      gates.release(0);
      expectCommitted(await a);
      gates.release(1);
      const resultB = expectCommitted(await b);
      const outcomes = [
        ...resultB.receipt.evidence.map((entry) => entry.outcome),
        ...resultB.receipt.projections.map((entry) => entry.outcome),
      ];
      expect(outcomes.every((outcome) => outcome === 'duplicate')).toBe(true);
      expect(sinks[1]!.kinds()).toEqual(['requested', 'validation-started', 'committed']);
    });
  });
}
