import { describe, expect, it } from 'bun:test';

import { createTransitionEngine } from '../src/transition-engine';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  correctionProposal,
  createManualClock,
  createOrderedGates,
  createRecordingSink,
  expectCommitted,
  expectRefused,
  seedCorrectionState,
  TENANT,
} from './transition-test-support';

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`an identical correction under another operation id (${label})`, () => {
    it('conflicts instead of committing and emitting events for a supersession another operation performed', async () => {
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
      const first = engine(0);
      const second = engine(1);
      const a = first.submit(correctionProposal('operation-a'));
      const b = second.submit(correctionProposal('operation-b'));
      await gates.whenAllArrived;
      gates.release(0);
      expectCommitted(await a);
      gates.release(1);
      // The state this one validated against (the old projection and evidence, unsuperseded) is gone.
      const result = expectRefused(await b, 'conflicted');

      expect(result.reason).toBe('revision-conflict');
      expect(sinks[1]!.kinds()).toEqual(['requested', 'validation-started', 'conflicted']);
      expect(await second.getReceipt(TENANT, 'operation-b')).toBeUndefined();
    });
  });
}
