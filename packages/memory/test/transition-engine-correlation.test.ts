import { describe, expect, it } from 'bun:test';

import { EvidenceProjectionCapacityError } from '../src/evidence-projection-storage';
import type { MemoryCorrelation } from '../src/transition-events';
import { TRANSITION_BACKENDS } from './transition-backends';
import {
  appendProposal,
  createHarness,
  expectCommitted,
  makeWriteAuthority,
  storageFailingWith,
} from './transition-test-support';

const runA: MemoryCorrelation = {
  runId: 'run-a',
  sessionId: 'session-1',
  contextEpochId: 'epoch-1',
};
const runB: MemoryCorrelation = { runId: 'run-b', sessionId: 'session-1' };

/**
 * COR-768 — every event of a submission carries the run, session, and
 * context-epoch correlation it was submitted with, whatever the outcome, and
 * correlation never enters the proposal digest.
 */
for (const [backend, makeBackend] of TRANSITION_BACKENDS) {
  describe(`transition event correlation (${backend})`, () => {
    it('carries the correlation on every event of a committed submission', async () => {
      const harness = createHarness(makeBackend);
      expectCommitted(await harness.engine.submit(appendProposal('op-1'), { correlation: runA }));
      expect(harness.recorder.kinds()).toEqual(['requested', 'validation-started', 'committed']);
      expect(harness.recorder.events.map((event) => event.correlation)).toEqual([runA, runA, runA]);
    });

    it('replays a recovering run’s retry under the recovering run’s correlation', async () => {
      const harness = createHarness(makeBackend);
      const first = expectCommitted(
        await harness.engine.submit(appendProposal('op-1'), { correlation: runA }),
      );
      const retry = createHarness(makeBackend, { storage: harness.storage });
      const replayed = expectCommitted(
        await retry.engine.submit(appendProposal('op-1'), { correlation: runB }),
      );
      // Correlation is not in the digest: the same receipt, not an identifier conflict.
      expect(replayed).toMatchObject({ replayed: true, receipt: first.receipt });
      expect(retry.recorder.kinds()).toEqual(['requested', 'recovery-reconciled']);
      expect(retry.recorder.events.map((event) => event.correlation)).toEqual([runB, runB]);
    });

    it('carries it on rejected, canceled, and failed submissions too', async () => {
      const unauthorized = createHarness(makeBackend);
      await unauthorized.engine.submit(
        appendProposal('op-1', ['e1'], makeWriteAuthority({ capabilities: [] })),
        { correlation: runA },
      );
      expect(unauthorized.recorder.kinds().at(-1)).toBe('rejected');

      const canceled = createHarness(makeBackend);
      const controller = new AbortController();
      controller.abort();
      await canceled.engine.submit(appendProposal('op-1'), {
        correlation: runA,
        signal: controller.signal,
      });
      expect(canceled.recorder.kinds().at(-1)).toBe('canceled');

      const base = createHarness(makeBackend);
      const failing = createHarness(makeBackend, {
        storage: storageFailingWith(base.storage, new Error('disk gone')),
      });
      await failing.engine.submit(appendProposal('op-1'), { correlation: runA });
      expect(failing.recorder.kinds().at(-1)).toBe('failed');

      for (const recorder of [unauthorized.recorder, canceled.recorder, failing.recorder]) {
        expect(recorder.events.map((event) => event.correlation)).toEqual(
          recorder.events.map(() => runA),
        );
      }
    });

    it('leaves correlation off when the submission names none', async () => {
      const harness = createHarness(makeBackend);
      expectCommitted(await harness.engine.submit(appendProposal('op-1')));
      expect(harness.recorder.events.every((event) => !('correlation' in event))).toBe(true);
    });

    it('carries it on a conflict, too', async () => {
      const harness = createHarness(makeBackend, {
        storage: storageFailingWith(makeBackend(), new EvidenceProjectionCapacityError('maxEvidence')),
      });
      await harness.engine.submit(appendProposal('op-1'), { correlation: runA });
      expect(harness.recorder.events.map((event) => event.correlation)).toEqual(
        harness.recorder.events.map(() => runA),
      );
    });
  });
}
