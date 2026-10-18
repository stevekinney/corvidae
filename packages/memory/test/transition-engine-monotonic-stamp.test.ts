import { describe, expect, it } from 'bun:test';

import { createTransitionEngine } from '../src/transition-engine';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  CLOCK_START,
  createRecordingSink,
  expectCommitted,
  TENANT,
} from './transition-test-support';

/**
 * A wall clock can step back between the engine's two reads. The commit stamp
 * is persisted on the receipt and on every record, so it must never precede the
 * request stamp.
 */

for (const [label, makeBackend] of TRANSITION_BACKENDS) {
  describe(`a clock that steps back between the two reads (${label})`, () => {
    it('stamps the commit with the request instant, never an earlier one', async () => {
      const storage = makeBackend();
      const readings = [CLOCK_START + 200, CLOCK_START + 100];
      const recorder = createRecordingSink();
      const engine = createTransitionEngine({
        storage,
        sink: recorder.sink,
        now: () => readings.shift() ?? CLOCK_START,
      });

      const { receipt } = expectCommitted(await engine.submit(appendProposal('operation-1')));

      expect(receipt.requestedAt).toBe(CLOCK_START + 200);
      expect(receipt.committedAt).toBeGreaterThanOrEqual(receipt.requestedAt);
      const stored = await storage.getEvidence(TENANT, 'e1');
      expect(stored?.writtenAt).toBe(receipt.committedAt);
      const instants = recorder.events.map((event) => event.at);
      expect(instants).toEqual(instants.toSorted((left, right) => left - right));
    });
  });
}
